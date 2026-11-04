import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ReadonlyHeaderCache } from '../src/readonly-header-cache.js';

const actor = { role: 'reseller', resellerId: 'token-workspace-a', name: 'Synthetic header token actor' };
const otherActor = { ...actor, resellerId: 'token-workspace-b' };
const tenantId = 'token-tenant-a';
const status = code => error => error.status === code;
function source(extra = {}) {
  return { name: 'Synthetic token fixture', privateHeader: { unknown: [{ text: 'é🌙', allow: true }] },
    contacts: [{ id: 'contact', identities: [{ channelId: 'wa', kind: 'person', externalId: 'synthetic@lid', extra: { labels: ['preserve'] } }] }],
    channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', allowedGroups: ['123@g.us'], unknown: { flags: ['private'] } },
      { id: 'other', kind: 'telegram', transport: 'telegram-bot', telegramGroups: { mode: 'selected', groupIds: ['-123'] } }],
    departments: [{ id: 'support', memberIds: ['operator'], unknown: { enabled: true } }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true, tools: ['conversation.read'], instructions: 'Synthetic private instruction' }],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: 'synthetic@lid', remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1,
      messages: [{ id: 'old-message', externalId: 'old-provider', kind: 'customer', text: 'Synthetic original history' }] },
    { id: 'sibling', channelId: 'wa', remoteJid: 'synthetic-sibling@lid', remoteAliases: [], version: 1, messages: [] }], ...extra };
}
function fixture(t, value = source()) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-header-token-')), path = join(directory, 'synthetic.sqlite'), db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);`);
  for (const label of ['a', 'b']) {
    db.prepare('INSERT INTO resellers VALUES (?,?)').run(`token-workspace-${label}`, '{}');
    db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`token-tenant-${label}`, `token-workspace-${label}`, JSON.stringify(label === 'a' ? value : source()));
  }
  db.close();
  const resource = { store: null, path, closed: false };
  t.after(() => { if (!resource.closed) resource.store?.close(); rmSync(directory, { recursive: true, force: true }); });
  resource.store = new Store(path);
  return resource;
}
const read = (store, session = actor, id = tenantId, conversation = 'target') => store.readonlyConversationTenant(session, id, conversation);
const privateHeader = store => store.db.prepare('SELECT data FROM service_tenant_private WHERE tenant_id=?').get(tenantId).data;
const canonical = store => store.db.prepare('SELECT data FROM tenants WHERE id=?').get(tenantId).data;
const write = (db, value, workspace = actor.resellerId) => db.prepare('UPDATE tenants SET data=?,reseller_id=? WHERE id=?').run(JSON.stringify(value), workspace, tenantId);

// Observe actual values returned through node:sqlite, rather than inferring a
// transport saving merely from JSON.parse counts or a reused object identity.
function observeReads(store, afterRead = () => {}, beforeRead = () => {}) {
  const prepare = store.db.prepare.bind(store.db), rows = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (/^\s*SELECT\b/i.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        beforeRead({ sql, args, number: rows.length + 1 });
        const row = get(...args); rows.push({ sql, row, args }); afterRead({ sql, row, args, number: rows.length }); return row;
      };
    }
    return statement;
  };
  return { rows, restore() { store.db.prepare = prepare; } };
}
const strings = row => Object.values(row || {}).filter(value => typeof value === 'string');

test('a validated warm token omits the large header from SQLite results and still returns fresh mutable conversation data', t => {
  const resource = fixture(t, source({ syntheticPadding: 'é🌙'.repeat(160_000) })), store = resource.store, raw = privateHeader(store), seen = observeReads(store);
  let cold, warm;
  store.tenant = () => { throw new Error('A readonly token read must never parse the complete tenant'); };
  try {
    cold = read(store);
    assert.equal(seen.rows.filter(item => strings(item.row).includes(raw)).length, 1, 'one header fetch on a cache miss');
    seen.rows.length = 0; warm = read(store);
    assert.ok(seen.rows.length > 0, 'warm reads still consult live SQLite authority');
    assert.equal(seen.rows.some(item => strings(item.row).includes(raw)), false, 'no full header crosses node:sqlite on a hit');
    assert.ok(seen.rows.every(item => strings(item.row).every(value => Buffer.byteLength(value) < 8192)), 'only small authority/token/conversation fields return on this hit');
  } finally { seen.restore(); }
  assert.strictEqual(warm.contacts, cold.contacts); assert.strictEqual(warm.channels, cold.channels);
  assert.ok(Object.isFrozen(warm.contacts[0].identities[0].extra.labels)); assert.ok(Object.isFrozen(warm.privateHeader.unknown[0]));
  assert.throws(() => warm.channels[0].unknown.flags.push('poison'), TypeError);
  assert.throws(() => warm.channels[1].telegramGroups.groupIds.pop(), TypeError);
  assert.throws(() => warm.departments[0].memberIds.push('poison'), TypeError);
  warm.conversations[0].messages.push({ id: 'local-only', text: 'Must not persist' });
  assert.equal(read(store).conversations[0].messages.length, 1);
  const rawDb = new DatabaseSync(resource.path);
  try { rawDb.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].version',2,'$.conversations[0].messages[0].text','Fresh legacy history') WHERE id=?").run(tenantId); }
  finally { rawDb.close(); }
  const fresh = read(store); assert.strictEqual(fresh.contacts, cold.contacts); assert.equal(fresh.conversations[0].version, 2);
  assert.equal(fresh.conversations[0].messages[0].text, 'Fresh legacy history');
});

test('warm tokens never bypass current operator, workspace, target or routing authority', t => {
  const { store } = fixture(t), operator = { ...actor, role: 'operator', tenantIds: [tenantId] }, raw = privateHeader(store);
  read(store, operator); operator.tenantIds = [];
  const seen = observeReads(store);
  try {
    assert.throws(() => read(store, operator), status(403)); assert.equal(seen.rows.length, 0, 'operator restriction precedes cache and SQL');
    assert.throws(() => read(store, otherActor), status(404)); assert.throws(() => read(store, actor, tenantId, 'missing'), status(404));
    store.db.prepare("UPDATE service_read_model_meta SET version=8 WHERE id='routing'").run();
    assert.throws(() => read(store), status(404));
    store.db.prepare("DELETE FROM service_read_model_meta WHERE id='routing'").run(); assert.throws(() => read(store), status(404));
    assert.ok(seen.rows.every(item => !strings(item.row).includes(raw)), 'denied reads do not load a cached header');
  } finally { seen.restore(); }
});

test('legacy raw header changes revoke old metadata and current conversation routing survives a token hit', t => {
  const resource = fixture(t), store = resource.store, rawDb = new DatabaseSync(resource.path), warm = read(store);
  try {
    rawDb.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false'),'$.channels[0].allowedGroups',json('[]'),'$.contacts[0].identities[0].extra.labels',json('[\"changed\"]')) WHERE id=?").run(tenantId);
    const revoked = read(store); assert.equal(revoked.agents[0].configured, false); assert.deepEqual(revoked.channels[0].allowedGroups, []);
    assert.deepEqual(revoked.contacts[0].identities[0].extra.labels, ['changed']); assert.notStrictEqual(revoked.contacts, warm.contacts);
    assert.equal(warm.agents[0].configured, true); assert.deepEqual(warm.channels[0].allowedGroups, ['123@g.us']);
    rawDb.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].channelId','other','$.conversations[0].agentId','another-agent') WHERE id=?").run(tenantId);
    const reassigned = read(store); assert.strictEqual(reassigned.channels, revoked.channels);
    assert.equal(reassigned.conversations[0].channelId, 'other'); assert.equal(reassigned.conversations[0].agentId, 'another-agent');
    rawDb.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run(otherActor.resellerId, tenantId);
    assert.throws(() => read(store), status(404)); const moved = read(store, otherActor);
    assert.equal(moved.resellerId, otherActor.resellerId); assert.notStrictEqual(moved.channels, reassigned.channels);
  } finally { rawDb.close(); }
});

test('token cache misses caused by UTF-8 byte, entry or individual-header limits retain the existing bounds and immutability', t => {
  const resource = fixture(t), store = resource.store, raw = privateHeader(store), bytes = Buffer.byteLength(raw);
  assert.ok(bytes > raw.length, 'the fixture exercises UTF-8 byte accounting');
  const add = id => store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, actor.resellerId, JSON.stringify(source()));
  for (const id of ['extra-a', 'extra-b', 'extra-c']) add(id);
  store.readonlyHeaderCache = new ReadonlyHeaderCache({ maxEntries: 3, maxBytes: bytes * 2, maxHeaderBytes: bytes });
  const a = read(store), b = read(store, actor, 'extra-a');
  assert.equal(store.readonlyHeaderCache.bytes, bytes * 2); assert.equal(store.readonlyHeaderCache.size, 2);
  assert.strictEqual(read(store).contacts, a.contacts); read(store, actor, 'extra-b');
  assert.strictEqual(read(store).contacts, a.contacts); assert.notStrictEqual(read(store, actor, 'extra-a').contacts, b.contacts);
  assert.ok(store.readonlyHeaderCache.bytes <= bytes * 2);
  store.readonlyHeaderCache = new ReadonlyHeaderCache({ maxEntries: 2, maxBytes: bytes * 4, maxHeaderBytes: bytes });
  const first = read(store); read(store, actor, 'extra-a'); read(store, actor, 'extra-b');
  assert.equal(store.readonlyHeaderCache.size, 2); assert.notStrictEqual(read(store).contacts, first.contacts);
  store.readonlyHeaderCache = new ReadonlyHeaderCache({ maxHeaderBytes: bytes - 1 });
  const oversized = read(store), again = read(store);
  assert.deepEqual(oversized, again); assert.notStrictEqual(oversized.contacts, again.contacts); assert.ok(Object.isFrozen(again.contacts[0].identities));
  assert.equal(store.readonlyHeaderCache.size, 0); assert.equal(store.readonlyHeaderCache.bytes, 0);
  store.readonlyHeaderCache = new ReadonlyHeaderCache(); const initial = read(store);
  for (let index = 0; index < 32; index++) { const id = `default-limit-${index}`; add(id); read(store, actor, id); }
  assert.equal(store.readonlyHeaderCache.size, 32); assert.ok(store.readonlyHeaderCache.bytes <= 32 * 1024 ** 2);
  assert.notStrictEqual(read(store).contacts, initial.contacts);
  const cache = store.readonlyHeaderCache; store.close(); resource.closed = true;
  assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
});

test('every authority, conversation and late-header boundary uses a coherent WAL snapshot even when scope moves', t => {
  for (const boundary of ['before-authority', 'after-authority', 'after-conversation', 'before-late-header']) for (const move of [false, true]) {
    const resource = fixture(t), store = resource.store, rawDb = new DatabaseSync(resource.path), old = read(store), next = source();
    next.contacts[0].identities[0].extra.labels = ['new-snapshot']; next.agents[0].configured = false;
    next.conversations[0].channelId = 'other'; next.conversations[0].version = 2; next.conversations[0].messages[0].text = 'New snapshot history';
    let changed = false;
    const change = () => { assert.equal(changed, false); changed = true; write(rawDb, next, move ? otherActor.resellerId : actor.resellerId); };
    const observed = observeReads(store, ({ number }) => {
      if (number === 1 && ['after-conversation', 'before-late-header'].includes(boundary)) store.readonlyHeaderCache.clear();
      if (boundary === 'after-authority' && number === 1 || boundary === 'after-conversation' && number === 2) change();
    }, ({ number }) => {
      if (boundary === 'before-authority' && number === 1 || boundary === 'before-late-header' && number === 3) change();
    });
    try {
      if (boundary === 'before-authority' && move) assert.throws(() => read(store), status(404));
      else {
        const current = read(store), fresh = boundary === 'before-authority';
        assert.deepEqual(current.contacts[0].identities[0].extra.labels, fresh ? ['new-snapshot'] : ['preserve']);
        assert.equal(current.agents[0].configured, !fresh); assert.equal(current.conversations[0].channelId, fresh ? 'other' : 'wa');
        assert.equal(current.conversations[0].version, fresh ? 2 : 1);
        assert.equal(current.conversations[0].messages[0].text, fresh ? 'New snapshot history' : 'Synthetic original history');
        if (boundary === 'after-authority') assert.strictEqual(current.contacts, old.contacts);
      }
      assert.equal(changed, true, `WAL interleaving exercised at ${boundary}`);
      if (boundary === 'before-late-header') assert.ok(observed.rows.length >= 3, 'late cache eviction requires an actual header fetch inside the snapshot');
    } finally { observed.restore(); rawDb.close(); }
    if (move) assert.throws(() => read(store), status(404));
    const current = read(store, move ? otherActor : actor);
    assert.deepEqual(current.contacts[0].identities[0].extra.labels, ['new-snapshot']); assert.equal(current.agents[0].configured, false);
    assert.equal(current.conversations[0].channelId, 'other'); assert.equal(current.conversations[0].version, 2);
  }
});

test('a header A-to-B-to-A write inside the callback fails strong CAS and rolls back DB effects and audit', t => {
  const { store } = fixture(t), original = canonical(store), old = read(store), rawHeader = privateHeader(store);
  store.db.exec('CREATE TABLE synthetic_token_effects(id TEXT PRIMARY KEY);');
  let callbacks = 0;
  assert.throws(() => store.mutateConversation(actor, tenantId, 'target', 'Synthetic token ABA must roll back', conversation => {
    callbacks++; store.db.prepare('INSERT INTO synthetic_token_effects VALUES (?)').run('effect');
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.name','Changed within callback') WHERE id=?").run(tenantId);
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(original, tenantId);
    assert.equal(privateHeader(store), rawHeader, 'the final raw header bytes alone cannot detect this ABA');
    conversation.version++;
  }), status(409));
  assert.equal(callbacks, 1); assert.equal(canonical(store), original);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM synthetic_token_effects').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
  assert.strictEqual(read(store).contacts, old.contacts, 'rolled-back token changes cannot poison the old committed cache');
  assert.equal(read(store).conversations[0].version, 1);
});
