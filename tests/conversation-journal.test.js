import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createEventBus } from '../src/events.js';
import { effectiveTenantDataSql, materializeForLegacy } from '../src/conversation-journal.js';

const actor = { role: 'reseller', resellerId: 'journal-workspace-a', name: 'Synthetic journal actor' };
const hash = value => createHash('sha256').update(value).digest('hex');
function source(label = 'a') {
  return { privateHeader: { keep: `synthetic-header-${label}` }, contacts: [], channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: `synthetic-${label}`, remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1,
      messages: [{ id: `old-${label}`, externalId: `old-provider-${label}`, kind: 'customer', text: `synthetic-history-${label}` }] },
    { id: 'sibling', channelId: 'wa', remoteJid: `synthetic-sibling-${label}`, remoteAliases: [], owner: 'queue', status: 'open', version: 1,
      messages: [{ id: `sibling-${label}`, kind: 'customer', text: 'synthetic-preserved-sibling' }] }] };
}
const rows = db => db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n;
const guards = db => db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n;
const base = (db, tenantId = 'journal-tenant-a') => db.prepare('SELECT data FROM tenants WHERE id=?').get(tenantId).data;
const effective = db => db.prepare(`SELECT ${effectiveTenantDataSql(db, 't')} AS data FROM tenants t WHERE t.id=? AND t.reseller_id=?`).get('journal-tenant-a', actor.resellerId).data;
const audits = db => db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get('journal-tenant-a').n;
const active = db => db.prepare('SELECT active FROM conversation_journal_meta WHERE id=1').get().active;
function fixture(t, rawSource = JSON.stringify(source())) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-journal-fixture-')), path = join(directory, 'synthetic.sqlite'), store = new Store(path, { conversationJournal: true });
  for (const label of ['a', 'b']) {
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(`journal-workspace-${label}`, '{}');
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`journal-tenant-${label}`, `journal-workspace-${label}`, label === 'a' ? rawSource : JSON.stringify(source(label)));
  }
  store.db.exec(`CREATE TABLE wa_seen(channel_id TEXT NOT NULL,remote_jid TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_jid,message_id));
    CREATE TABLE synthetic_journal_base_updates(id TEXT NOT NULL);
    CREATE TRIGGER synthetic_journal_base_update AFTER UPDATE OF data ON tenants WHEN OLD.id IN('journal-tenant-a','journal-tenant-b')
      BEGIN INSERT INTO synthetic_journal_base_updates VALUES (NEW.id); END;`);
  const f = { store, path, rawSource, baselineB: base(store.db, 'journal-tenant-b'), callbacks: 0, events: [], closed: false };
  store.events = createEventBus(); store.events.subscribe(event => f.events.push(event));
  f.mutate = (mutator, action = 'Synthetic journal update') => store.mutateConversation(actor, 'journal-tenant-a', 'target', action, conversation => {
    f.callbacks++; store.db.prepare('INSERT INTO wa_seen VALUES (?,?,?)').run('wa', 'synthetic-jid', `seen-${f.callbacks}`);
    if (mutator) return mutator(conversation);
    conversation.version++; conversation.messages.push({ id: `new-${f.callbacks}`, externalId: `new-provider-${f.callbacks}`, kind: 'agent', text: 'synthetic-journal-only-message' });
  });
  t.after(() => { if (!f.closed) { store.events.close(); store.close(); } rmSync(directory, { recursive: true, force: true }); });
  return f;
}
const current = f => f.store.readonlyConversationTenant(actor, 'journal-tenant-a', 'target').conversations[0];
function assertHealthy(db) {
  assert.equal(db.prepare('PRAGMA main.synchronous').get().synchronous, 2); assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(guards(db), 0);
}

test('two writes of the same conversation remain journal-only while current reads, metadata, lookup, audit, wa_seen and events advance atomically', t => {
  const f = fixture(t), initialHash = hash(f.rawSource);
  assert.equal(rows(f.store.db), 0); assert.equal(active(f.store.db), 1);
  assert.throws(() => new Store(f.path), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_ACTIVE', 'active mode alone rejects an unsupported runtime even before the first dirty row');
  f.mutate(); f.mutate();
  assert.equal(hash(base(f.store.db)), initialHash); assert.equal(base(f.store.db), f.rawSource); assert.equal(base(f.store.db, 'journal-tenant-b'), f.baselineB);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM synthetic_journal_base_updates').get().n, 0);
  assert.equal(rows(f.store.db), 1); assert.equal(active(f.store.db), 1); assert.equal(f.callbacks, 2); assert.equal(audits(f.store.db), 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen').get().n, 2); assert.equal(current(f).version, 3); assert.equal(current(f).messages.length, 3);
  assert.deepEqual(f.store.tenant(actor, 'journal-tenant-a').conversations[0], current(f));
  assert.deepEqual(JSON.parse(effective(f.store.db)).conversations[0], current(f));
  assert.equal(f.store.serviceTenant(actor.resellerId, 'journal-tenant-a', { conversationId: 'target' }).conversations[0].version, 3);
  assert.deepEqual(f.store.serviceReadModel.lookupConversationIds({ tenantId: 'journal-tenant-a', workspaceId: actor.resellerId, channelId: 'wa', kind: 'external', values: ['new-provider-1', 'new-provider-2'] }), ['target']);
  for (const id of ['new-1', 'new-2']) assert.equal(f.events.filter(event => event.type === 'conversation.message' && event.messageId === id).length, 1);
  assert.ok(f.events.every(event => !event.tenantId || event.tenantId === 'journal-tenant-a')); assertHealthy(f.store.db);
});

test('callback, audit and bridge failures roll back journal rows, derived reads and transactional side effects without publishing events', t => {
  for (const phase of ['callback', 'audit', 'bridge', 'identity', 'cas']) {
    const f = fixture(t), failure = new Error(`synthetic-${phase}-failure`);
    if (phase === 'bridge') f.store.queuePostgres = () => { throw failure; };
    assert.throws(() => f.mutate(conversation => {
      conversation.version++; conversation.messages.push({ id: 'must-rollback', externalId: 'must-rollback', kind: 'agent' });
      if (phase === 'callback') throw failure;
      if (phase === 'identity') conversation.id = 'changed-id';
      if (phase === 'cas') f.store.db.prepare("UPDATE service_conversation_private SET data=json_set(data,'$.version',99) WHERE tenant_id=? AND id=?").run('journal-tenant-a', 'target');
    }, phase === 'audit' ? () => { throw failure; } : 'Synthetic failed journal update'), error => ['identity', 'cas'].includes(phase) ? error.status === 409 : error === failure);
    assert.equal(rows(f.store.db), 0); assert.equal(base(f.store.db), f.rawSource); assert.deepEqual(current(f), source().conversations[0]);
    assert.equal(f.callbacks, 1); assert.equal(audits(f.store.db), 0); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen').get().n, 0);
    assert.deepEqual(f.events, []); assertHealthy(f.store.db);
  }
});

test('raw writers with foreign_keys and recursive_triggers disabled cannot overwrite, replace or discard dirty state', t => {
  const f = fixture(t); f.mutate(); const logical = effective(f.store.db), overlay = f.store.db.prepare('SELECT * FROM conversation_journal').all();
  const legacy = new DatabaseSync(f.path);
  try {
    legacy.exec('PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=OFF;');
    const attempts = [
      () => legacy.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(source()), 'journal-tenant-a'),
      () => legacy.prepare('DELETE FROM tenants WHERE id=?').run('journal-tenant-a'),
      () => legacy.prepare('INSERT OR REPLACE INTO tenants(id,reseller_id,data) VALUES (?,?,?)').run('journal-tenant-a', actor.resellerId, JSON.stringify(source())),
      () => legacy.prepare('DELETE FROM conversation_journal WHERE tenant_id=?').run('journal-tenant-a'),
      () => legacy.prepare('UPDATE conversation_journal SET data=? WHERE tenant_id=?').run(JSON.stringify(source().conversations[0]), 'journal-tenant-a'),
      () => legacy.prepare('INSERT OR REPLACE INTO conversation_journal(tenant_id,reseller_id,position,conversation_id,data) VALUES (?,?,?,?,?)').run('journal-tenant-a', actor.resellerId, 0, 'target', JSON.stringify(source().conversations[0])),
      () => legacy.prepare('UPDATE conversation_journal_meta SET active=0 WHERE id=1').run(),
      () => legacy.prepare('DELETE FROM conversation_journal_meta WHERE id=1').run()
    ];
    for (const attempt of attempts) {
      assert.throws(attempt, /ELOZI_CONVERSATION_JOURNAL_PENDING/);
      assert.equal(base(legacy), f.rawSource, 'the raw base is explicitly the old snapshot, never current journal state');
      assert.equal(effective(f.store.db), logical); assert.deepEqual(f.store.db.prepare('SELECT * FROM conversation_journal').all(), overlay);
      assert.equal(active(f.store.db), 1);
    }
    assert.equal(base(legacy, 'journal-tenant-b'), f.baselineB); assert.equal(audits(legacy), 1); assertHealthy(legacy);
  } finally { legacy.close(); }
});

test('materialization merges only selected conversations in SQL, preserves large header/sibling numbers and disables mode for old readers', t => {
  const value = source(); value.privateHeader.large = '__BIG_HEADER__'; value.conversations[1].large = '__BIG_SIBLING__';
  const text = JSON.stringify(value).replace('"__BIG_HEADER__"', '9007199254740993').replace('"__BIG_SIBLING__"', '9223372036854775806');
  const f = fixture(t, text); f.mutate(); const logicalBefore = effective(f.store.db);
  assert.ok(logicalBefore.includes('9007199254740993')); assert.ok(logicalBefore.includes('9223372036854775806'));
  const receipt = materializeForLegacy(f.store.db);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.materialized, true); assert.equal(receipt.active, false); assert.equal(receipt.remainingRows, 0);
  assert.equal(receipt.before.logicalHash, receipt.after.logicalHash); assert.deepEqual(receipt.before.sideEffects, receipt.after.sideEffects);
  for (const check of ['logicalHashPreserved', 'countsPreserved', 'foreignKeys', 'quickCheck', 'synchronousFull', 'sideEffectsPreserved']) assert.equal(receipt.checks[check], true, check);
  assert.equal(base(f.store.db), logicalBefore); assert.equal(rows(f.store.db), 0); assert.equal(active(f.store.db), 0);
  assert.equal(base(f.store.db, 'journal-tenant-b'), f.baselineB); assert.equal(audits(f.store.db), 1); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen').get().n, 1);
  assert.equal(f.store.db.prepare("SELECT CAST(json_extract(data,'$.privateHeader.large') AS TEXT) AS n FROM tenants WHERE id=?").get('journal-tenant-a').n, '9007199254740993');
  assert.equal(f.store.db.prepare("SELECT CAST(json_extract(data,'$.conversations[1].large') AS TEXT) AS n FROM tenants WHERE id=?").get('journal-tenant-a').n, '9223372036854775806');
  assert.equal(JSON.stringify(receipt).includes('synthetic-journal-only-message'), false); assertHealthy(f.store.db);
  assert.throws(() => new Store(f.path, { conversationJournal: true }), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_ACTIVATION_REQUIRED');
  assert.equal(active(f.store.db), 0, 'the legacy fence is persistent and opt-in alone cannot reactivate it');
  const legacy = new DatabaseSync(f.path); let oldStore;
  try {
    assert.equal(base(legacy), logicalBefore); oldStore = new Store(f.path);
    assert.equal(oldStore.tenant(actor, 'journal-tenant-a').conversations[0].messages.filter(message => message.id === 'new-1').length, 1);
    assert.equal(oldStore.readonlyConversationTenant(actor, 'journal-tenant-a', 'target').conversations[0].messages.length, 2); assert.equal(audits(oldStore.db), 1);
  } finally { oldStore?.close(); legacy.close(); }
});

test('a failed materialization before COMMIT preserves the overlay and its old base, while full mutation materializes before its callback', t => {
  const f = fixture(t); f.mutate(); const logical = effective(f.store.db), exec = f.store.db.exec.bind(f.store.db), failure = new Error('synthetic materialization commit failure');
  f.store.db.exec = sql => { if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) throw failure; return exec(sql); };
  try { assert.throws(() => materializeForLegacy(f.store.db), error => error === failure); }
  finally { f.store.db.exec = exec; }
  assert.equal(base(f.store.db), f.rawSource); assert.equal(effective(f.store.db), logical); assert.equal(rows(f.store.db), 1); assert.equal(active(f.store.db), 1); assert.equal(audits(f.store.db), 1);
  f.events.length = 0;
  f.store.mutate(actor, 'journal-tenant-a', 'Synthetic full mutation after journal', state => {
    assert.equal(rows(f.store.db), 0); assert.equal(state.conversations[0].messages.filter(message => message.id === 'new-1').length, 1);
    assert.equal(JSON.parse(base(f.store.db)).conversations[0].messages.length, 2);
    state.conversations.push({ id: 'new-context', channelId: 'wa', messages: [], version: 1 }); state.conversations.reverse();
  });
  assert.equal(rows(f.store.db), 0); assert.equal(active(f.store.db), 1); assert.equal(audits(f.store.db), 2);
  assert.deepEqual(JSON.parse(base(f.store.db)).conversations.map(conversation => conversation.id), ['new-context', 'sibling', 'target']);
  assert.equal(f.events.filter(event => event.type === 'conversation.message' && event.messageId === 'new-1').length, 0); assertHealthy(f.store.db);
});

test('unproven lookup shapes and duplicate IDs use the canonical fallback and preserve source order and later duplicates', t => {
  for (const mode of ['shape', 'duplicate']) {
    const value = source(); if (mode === 'shape') value.conversations[1].remoteAliases = 17; else value.conversations[1].id = 'target';
    const f = fixture(t, JSON.stringify(value)); f.mutate();
    const saved = JSON.parse(base(f.store.db)); assert.equal(rows(f.store.db), 0); assert.equal(saved.conversations[0].version, 2); assert.deepEqual(saved.conversations[1], value.conversations[1]);
    assert.equal(f.store.serviceReadModel.lookupConversationIds({ tenantId: 'journal-tenant-a', workspaceId: actor.resellerId, channelId: 'wa', kind: 'external', values: ['new-provider-1'] }), null);
    assert.equal(audits(f.store.db), 1); assertHealthy(f.store.db);
  }
});

test('dirty projections cannot be rebuilt or backfilled from the stale base and default Store mode fails closed with a released handle', t => {
  const f = fixture(t); f.mutate(); const logical = effective(f.store.db), pending = error => /ELOZI_CONVERSATION_JOURNAL_(?:PENDING|ACTIVE)/.test(error.message) || ['ELOZI_CONVERSATION_JOURNAL_PENDING', 'ELOZI_CONVERSATION_JOURNAL_ACTIVE'].includes(error.code);
  assert.throws(() => f.store.serviceReadModel.rebuild(), pending);
  f.store.db.exec('BEGIN IMMEDIATE'); try { assert.throws(() => f.store.serviceReadModel.backfill(), pending); } finally { f.store.db.exec('ROLLBACK'); }
  const close = DatabaseSync.prototype.close, closed = [];
  DatabaseSync.prototype.close = function (...args) { closed.push(this); return close.apply(this, args); };
  try { assert.throws(() => new Store(f.path), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_ACTIVE'); }
  finally { DatabaseSync.prototype.close = close; }
  assert.equal(closed.length, 1); assert.throws(() => closed[0].prepare('SELECT 1'), /not open|closed/i);
  assert.equal(effective(f.store.db), logical); assert.equal(base(f.store.db), f.rawSource); assert.equal(rows(f.store.db), 1); assertHealthy(f.store.db);
});

test('unknown journal/private guard columns and nonempty transient guards are preserved on bootstrap failure with the DB closed', t => {
  for (const mode of ['column', 'private-column', 'guard']) {
    const f = fixture(t); f.store.events.close(); f.store.close(); f.closed = true; let rawDb = new DatabaseSync(f.path);
    if (mode === 'column') rawDb.exec('ALTER TABLE conversation_journal_write_guard ADD COLUMN synthetic_unknown TEXT');
    else if (mode === 'private-column') rawDb.exec('ALTER TABLE conversation_journal ADD COLUMN synthetic_unknown TEXT');
    else {
      const old = JSON.stringify(source().conversations[0]), next = structuredClone(source().conversations[0]); next.version = 99;
      rawDb.prepare('INSERT INTO conversation_journal_write_guard(tenant_id,reseller_id,position,conversation_id,old_data,data) VALUES (?,?,?,?,?,?)').run('journal-tenant-a', actor.resellerId, 0, 'target', old, JSON.stringify(next));
    }
    const snapshot = db => ({ schema: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(), guard: db.prepare('SELECT * FROM conversation_journal_write_guard').all(),
      meta: db.prepare('SELECT * FROM conversation_journal_meta').all(), source: db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all() });
    const before = snapshot(rawDb); rawDb.close();
    const close = DatabaseSync.prototype.close, closed = []; DatabaseSync.prototype.close = function (...args) { closed.push(this); return close.apply(this, args); };
    try { assert.throws(() => new Store(f.path, { conversationJournal: true }), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_SCHEMA'); }
    finally { DatabaseSync.prototype.close = close; }
    assert.equal(closed.length, 1); assert.throws(() => closed[0].prepare('SELECT 1'), /not open|closed/i);
    rawDb = new DatabaseSync(f.path);
    try { rawDb.exec('BEGIN EXCLUSIVE'); assert.deepEqual(snapshot(rawDb), before); rawDb.exec('ROLLBACK'); }
    finally { rawDb.close(); }
  }
});
