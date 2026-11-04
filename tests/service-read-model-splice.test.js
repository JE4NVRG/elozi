import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { SCOPED_REPLACEMENT_PROOF_ERROR } from '../src/service-read-model.js';

function source() {
  return { privateHeader: { keep: 'synthetic-only' }, channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }], agents: [{ id: 'agent', configured: true }], departments: [],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: 'synthetic', remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1, messages: [] }] };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-strict-proof-')), store = new Store(join(directory, 'synthetic.sqlite')), value = source();
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('strict-tenant', 'mep-demo', JSON.stringify(value));
  store.db.exec('CREATE TABLE synthetic_effects(id TEXT PRIMARY KEY)');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, value, original: JSON.stringify(value) };
}
const raw = db => db.prepare('SELECT data FROM tenants WHERE id=?').get('strict-tenant').data;
const guardCount = db => db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n;
const context = (conversation, strict) => ({ tenantId: 'strict-tenant', workspaceId: 'mep-demo', position: 0, conversationId: conversation.id, data: JSON.stringify(conversation), ...(strict === undefined ? {} : { strict }) });

test('strict proof rejects an arbitrary wrong NEW before it can commit header/metadata/effects and restores the hint savepoint', t => {
  const { store, value, original } = fixture(t), changed = structuredClone(value.conversations[0]), forged = structuredClone(value); changed.version = 2;
  forged.privateHeader.keep = 'forged-lateral-header'; const before = store.serviceTenant('mep-demo', 'strict-tenant'); let updates = 0;
  assert.throws(() => store.serviceReadModel.withConversationWrite(context(changed, true), () => {
    updates++; store.db.prepare('INSERT INTO synthetic_effects VALUES (?)').run('must-rollback');
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(forged), 'strict-tenant');
  }), error => error.code === 'ERR_SQLITE_ERROR' && error.errcode === 1811 && error.message === SCOPED_REPLACEMENT_PROOF_ERROR);
  assert.equal(updates, 1); assert.equal(raw(store.db), original); assert.equal(guardCount(store.db), 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM synthetic_effects').get().n, 0); assert.deepEqual(store.serviceTenant('mep-demo', 'strict-tenant'), before);
});

test('default strict zero retains the legacy lateral-update fallback and does not offer a speculative replacement expression', t => {
  const { store, value } = fixture(t), changed = structuredClone(value.conversations[0]), actual = structuredClone(value); changed.version = 2;
  actual.agents[0].configured = false; actual.conversations[0].owner = 'human';
  store.serviceReadModel.withConversationWrite(context(changed), ({ expectedSql, replacementSql }) => {
    assert.equal(replacementSql, expectedSql);
    assert.equal(store.db.prepare('SELECT strict_write FROM service_conversation_write_guard WHERE tenant_id=?').get('strict-tenant').strict_write, 0);
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(actual), 'strict-tenant');
  });
  assert.deepEqual(JSON.parse(raw(store.db)), actual); assert.equal(guardCount(store.db), 0);
  const current = store.serviceTenant('mep-demo', 'strict-tenant'); assert.equal(current.agents[0].configured, false); assert.equal(current.conversations[0].owner, 'human');
});

test('strict mode validates its type and still rejects stale OLD when NEW matches a document prepared before a lateral change', t => {
  const { store, value, original } = fixture(t), changed = structuredClone(value.conversations[0]); changed.version = 2;
  assert.throws(() => store.serviceReadModel.withConversationWrite(context(changed, 1), () => {}), TypeError);
  const earlierExpected = structuredClone(value); earlierExpected.conversations[0] = changed;
  assert.throws(() => store.serviceReadModel.withConversationWrite(context(changed, true), () => {
    // The normal expression proves this first statement against its real OLD.
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0]',json(?)) WHERE id=?").run(JSON.stringify(changed), 'strict-tenant');
    // A legacy header write runs without speculative strict state; its own full refresh must remain available.
    store.db.prepare('UPDATE service_conversation_write_guard SET strict_write=0 WHERE tenant_id=?').run('strict-tenant');
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false')) WHERE id=?").run('strict-tenant');
    store.db.prepare('UPDATE service_conversation_write_guard SET strict_write=1 WHERE tenant_id=?').run('strict-tenant');
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(earlierExpected), 'strict-tenant');
  }), error => error.message === SCOPED_REPLACEMENT_PROOF_ERROR && error.errcode === 1811);
  assert.equal(raw(store.db), original); assert.equal(guardCount(store.db), 0); assert.equal(store.serviceTenant('mep-demo', 'strict-tenant').agents[0].configured, true);
});

function legacyFixture(t, strictDefinition) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-strict-migration-')), path = join(directory, 'synthetic.sqlite'), db = new DatabaseSync(path), value = source();
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE audit(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),action TEXT NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL);
    CREATE TABLE service_read_model_meta(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
    INSERT INTO service_read_model_meta VALUES ('routing',7);
    CREATE TABLE service_tenant_read(tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,reseller_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE service_conversation_read(tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
    CREATE TABLE service_conversation_write_guard(
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),conversation_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(CASE WHEN json_valid(data) THEN json_type(data) IS 'object' AND json_type(data,'$.id') IS 'text' AND json_extract(data,'$.id') IS conversation_id ELSE 0 END),
      validated INTEGER NOT NULL DEFAULT 0 CHECK(validated IN(0,1))${strictDefinition ? ',strict_write ' + strictDefinition : ''});`);
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('mep-demo', '{}');
  db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('strict-tenant', 'mep-demo', JSON.stringify(value));
  db.prepare('INSERT INTO service_tenant_read VALUES (?,?,?)').run('strict-tenant', 'mep-demo', JSON.stringify({ channels: value.channels, agents: value.agents, departments: value.departments }));
  const { messages: _messages, ...metadata } = value.conversations[0];
  db.prepare('INSERT INTO service_conversation_read VALUES (?,?,?)').run('strict-tenant', 'target', JSON.stringify(metadata));
  const retained = structuredClone(value.conversations[0]); retained.version = 77;
  db.prepare('INSERT INTO service_conversation_write_guard(tenant_id,workspace_id,position,conversation_id,data) VALUES (?,?,?,?,?)').run('strict-tenant', 'mep-demo', 0, 'target', JSON.stringify(retained));
  const resource = { path, value, retained, store: null }; db.close();
  t.after(() => { resource.store?.close(); rmSync(directory, { recursive: true, force: true }); });
  return resource;
}
const hash = value => createHash('sha256').update(value).digest('hex');
function migrationSnapshot(db) {
  const rows = sql => db.prepare(sql).all().map(row => ({ ...row }));
  return { schema: rows('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name'), canonical: raw(db),
    meta: rows('SELECT * FROM service_read_model_meta ORDER BY id'), guard: rows('SELECT * FROM service_conversation_write_guard'),
    header: rows('SELECT * FROM service_tenant_read'), conversation: rows('SELECT * FROM service_conversation_read') };
}

test('real routing-seven guard without strict_write migrates additively with its row, derived metadata and canonical bytes preserved', t => {
  const resource = legacyFixture(t), before = new DatabaseSync(resource.path), initial = migrationSnapshot(before); before.close();
  assert.equal(initial.schema.find(row => row.name === 'service_conversation_write_guard').sql.includes('strict_write'), false);
  const store = resource.store = new Store(resource.path), column = store.db.prepare('PRAGMA table_info(service_conversation_write_guard)').all().find(row => row.name === 'strict_write');
  assert.equal(column.type, 'INTEGER'); assert.equal(column.notnull, 1); assert.equal(column.dflt_value, '0');
  assert.deepEqual({ ...store.db.prepare('SELECT * FROM service_conversation_write_guard').get() }, { ...initial.guard[0], strict_write: 0 });
  assert.equal(hash(raw(store.db)), hash(initial.canonical)); assert.equal(raw(store.db), initial.canonical);
  assert.equal(store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.deepEqual(store.db.prepare('SELECT * FROM service_conversation_read').all().map(row => ({ ...row })), initial.conversation);
  const legacy = new DatabaseSync(resource.path);
  try {
    legacy.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false')) WHERE id=?").run('strict-tenant');
    assert.equal(store.serviceTenant('mep-demo', 'strict-tenant').agents[0].configured, false);
    const retained = legacy.prepare('SELECT data,strict_write,validated FROM service_conversation_write_guard WHERE tenant_id=?').get('strict-tenant');
    assert.equal(retained.data, JSON.stringify(resource.retained)); assert.equal(retained.strict_write, 0); assert.equal(retained.validated, 0);
    // Only the synthetic retained hint is removed; source and derived rows remain in place.
    legacy.prepare('DELETE FROM service_conversation_write_guard WHERE tenant_id=?').run('strict-tenant');
  } finally { legacy.close(); }
  const original = store.serviceReadModel.withConversationWrite.bind(store.serviceReadModel); let strictCalls = 0;
  store.serviceReadModel.withConversationWrite = (options, update) => {
    assert.equal(options.strict, true); strictCalls++;
    return original(options, expressions => { assert.equal(store.db.prepare('SELECT strict_write FROM service_conversation_write_guard WHERE tenant_id=?').get('strict-tenant').strict_write, 1); return update(expressions); });
  };
  store.mutateConversation({ role: 'reseller', resellerId: 'mep-demo', name: 'Synthetic migrated actor' }, 'strict-tenant', 'target', 'Synthetic strict update after migration', conversation => { conversation.version++; });
  assert.equal(strictCalls, 1); assert.equal(guardCount(store.db), 0); assert.equal(store.serviceTenant('mep-demo', 'strict-tenant').conversations[0].version, 2);
});

test('an incompatible existing strict_write type, nullability or default fails with complete preservation and a closed bootstrap handle', t => {
  for (const definition of ['TEXT NOT NULL DEFAULT 0', 'INTEGER DEFAULT 0', 'INTEGER NOT NULL DEFAULT 1']) {
    const resource = legacyFixture(t, definition); let check = new DatabaseSync(resource.path); const before = migrationSnapshot(check); check.close();
    const close = DatabaseSync.prototype.close, closed = [];
    DatabaseSync.prototype.close = function (...args) { closed.push(this); return close.apply(this, args); };
    try { assert.throws(() => new Store(resource.path), /formato da proteção de escrita estrita.*preservado/); }
    finally { DatabaseSync.prototype.close = close; }
    assert.equal(closed.length, 1); assert.throws(() => closed[0].prepare('SELECT 1'), /not open|closed/i);
    check = new DatabaseSync(resource.path);
    try { check.exec('BEGIN EXCLUSIVE'); assert.deepEqual(migrationSnapshot(check), before, definition); check.exec('ROLLBACK'); }
    finally { check.close(); }
  }
});
