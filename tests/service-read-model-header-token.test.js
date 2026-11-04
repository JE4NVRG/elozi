import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ReadonlyHeaderCache } from '../src/readonly-header-cache.js';

// Real routing-eight private header schema: there is no token column yet.
const headerV8 = `CREATE TABLE service_tenant_private (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,reseller_id TEXT NOT NULL,data TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),source_type TEXT)`;
const actor = { role: 'reseller', resellerId: 'migration-workspace', name: 'Synthetic token migration actor' };
const source = label => JSON.stringify({ name: label, privateUnknown: { nested: ['é🌙', { keep: true }] }, contacts: [{ id: 'contact', identities: [{ externalId: 'synthetic@lid' }] }],
  channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }], agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [],
  conversations: [{ id: 'target', channelId: 'wa', remoteJid: 'synthetic@lid', remoteAliases: [], version: 1,
    messages: [{ id: 'message', externalId: 'synthetic-provider', kind: 'customer', text: 'Synthetic preserved history' }] }] });
function legacy(t, alter = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-token-migration-')), path = join(directory, 'synthetic.sqlite'), db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE audit(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),action TEXT NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL);
    CREATE TABLE service_read_model_meta(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
    INSERT INTO service_read_model_meta VALUES('routing',8);
    CREATE TABLE synthetic_unique_data(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO synthetic_unique_data VALUES('retained','synthetic-unique-value');
    ${headerV8};`);
  db.prepare('INSERT INTO resellers VALUES (?,?)').run(actor.resellerId, '{}');
  for (const id of ['tenant-a', 'tenant-b']) {
    db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, actor.resellerId, source(id));
    db.prepare("INSERT INTO service_tenant_private SELECT id,reseller_id,json_remove(data,'$.conversations'),1,'object' FROM tenants WHERE id=?").run(id);
  }
  alter(db); db.close();
  const resource = { path, store: null };
  t.after(() => { resource.store?.close(); rmSync(directory, { recursive: true, force: true }); });
  return resource;
}
const plain = rows => rows.map(row => ({ ...row }));
const canonical = db => plain(db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all());
const token = (db, id = 'tenant-a') => db.prepare('SELECT header_token FROM service_tenant_private WHERE tenant_id=?').get(id).header_token;
const read = store => store.readonlyConversationTenant(actor, 'tenant-a', 'target');
function snapshot(db) {
  const journal = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversation_journal'").get()
    ? { rows: plain(db.prepare('SELECT * FROM conversation_journal ORDER BY tenant_id,position').all()),
      meta: plain(db.prepare('SELECT * FROM conversation_journal_meta').all()), guard: plain(db.prepare('SELECT * FROM conversation_journal_write_guard').all()) } : null;
  return { schema: plain(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()), source: canonical(db),
    headers: plain(db.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all()), meta: plain(db.prepare('SELECT * FROM service_read_model_meta').all()),
    retained: plain(db.prepare('SELECT * FROM synthetic_unique_data').all()), journal };
}
function assertPreservedFailure(resource, options) {
  const raw = new DatabaseSync(resource.path), before = snapshot(raw); raw.close();
  const close = DatabaseSync.prototype.close, closed = [];
  DatabaseSync.prototype.close = function (...args) { closed.push(this); return close.apply(this, args); };
  try { assert.throws(() => new Store(resource.path, options), error => error.code === 'ELOZI_READONLY_HEADER_SCHEMA'); }
  finally { DatabaseSync.prototype.close = close; }
  assert.equal(closed.length, 1); assert.throws(() => closed[0].prepare('SELECT 1'), /not open|closed/i);
  const after = new DatabaseSync(resource.path);
  try { after.exec('BEGIN EXCLUSIVE'); assert.deepEqual(snapshot(after), before); after.exec('ROLLBACK'); assert.equal(after.prepare('PRAGMA quick_check').get().quick_check, 'ok'); }
  finally { after.close(); }
}

test('real routing-eight headers migrate additively to valid tokens without rewriting canonical data, and reopen is a no-op', t => {
  const resource = legacy(t), old = new DatabaseSync(resource.path), original = canonical(old);
  assert.equal(old.prepare('PRAGMA table_info(service_tenant_private)').all().some(column => column.name === 'header_token'), false);
  old.close(); const store = resource.store = new Store(resource.path);
  assert.equal(store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.deepEqual(canonical(store.db), original);
  const first = token(store.db), other = token(store.db, 'tenant-b'); assert.match(first, /^[a-f0-9]{32}$/); assert.match(other, /^[a-f0-9]{32}$/); assert.notEqual(first, other);
  assert.deepEqual(read(store).privateUnknown, { nested: ['é🌙', { keep: true }] });
  store.close(); resource.store = null; resource.store = new Store(resource.path);
  assert.equal(resource.store.db.prepare('SELECT total_changes() AS n').get().n, 0);
  assert.equal(token(resource.store.db), first); assert.deepEqual(canonical(resource.store.db), original);
  const raw = new DatabaseSync(resource.path);
  try { raw.prepare("UPDATE tenants SET data=json_set(data,'$.name','Raw old writer after migration') WHERE id='tenant-a'").run(); }
  finally { raw.close(); }
  assert.notEqual(token(resource.store.db), first); assert.equal(read(resource.store).name, 'Raw old writer after migration');
});

test('an active dirty routing-eight database without the token column recovers before routing-nine rebuild and keeps journal writes working', t => {
  const resource = legacy(t), current = resource.store = new Store(resource.path, { conversationJournal: true });
  current.mutateConversation(actor, 'tenant-a', 'target', 'Synthetic committed old journal', conversation => {
    conversation.version++; conversation.messages.push({ id: 'old-journal', externalId: 'old-journal-provider', kind: 'agent', text: 'Committed overlay before upgrade' });
  });
  assert.equal(current.db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, 1);
  current.close(); resource.store = null;
  const raw = new DatabaseSync(resource.path);
  try {
    raw.exec(`DROP TRIGGER service_private_header_token_insert; DROP TRIGGER service_private_header_token_update;
      DROP TRIGGER service_private_header_token_tenant_insert; ALTER TABLE service_tenant_private DROP COLUMN header_token;`);
    for (const name of ['conversation_journal_insert', 'conversation_journal_update', 'service_read_before_update_v1']) {
      const { sql } = raw.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
      assert.ok(sql.includes('version=9')); raw.exec(`DROP TRIGGER ${name};`); raw.exec(sql.replaceAll('version=9', 'version=8'));
    }
    raw.exec("UPDATE service_read_model_meta SET version=8 WHERE id='routing';");
    assert.equal(raw.prepare('PRAGMA table_info(service_tenant_private)').all().some(column => column.name === 'header_token'), false, 'genuine old layout, not just a version downgrade');
    assert.equal(JSON.parse(raw.prepare("SELECT data FROM tenants WHERE id='tenant-a'").get().data).conversations[0].version, 1, 'legacy base is still the pre-overlay snapshot');
    assert.equal(raw.prepare('SELECT active FROM conversation_journal_meta').get().active, 1);
  } finally { raw.close(); }
  const upgraded = resource.store = new Store(resource.path, { conversationJournal: true });
  assert.equal(upgraded.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.equal(upgraded.db.prepare('SELECT active FROM conversation_journal_meta').get().active, 1);
  assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, 0);
  assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n, 0);
  assert.match(token(upgraded.db), /^[a-f0-9]{32}$/);
  const recovered = read(upgraded).conversations[0]; assert.equal(recovered.version, 2);
  assert.deepEqual(recovered.messages.map(message => message.id), ['message', 'old-journal']);
  assert.equal(JSON.parse(upgraded.db.prepare("SELECT data FROM tenants WHERE id='tenant-a'").get().data).conversations[0].version, 2);
  for (const name of ['conversation_journal_insert', 'conversation_journal_update', 'service_read_before_update_v1']) {
    const { sql } = upgraded.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
    assert.ok(sql.includes('version=9')); assert.ok(!sql.includes('version=8'), 'old routing cannot authorize a normal new journal write');
  }
  upgraded.mutateConversation(actor, 'tenant-a', 'target', 'Synthetic journal after upgrade', conversation => { conversation.version++; });
  assert.equal(read(upgraded).conversations[0].version, 3); assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, 1);
  assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM audit').get().n, 2); assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('unknown private-header columns, token definitions or owned triggers fail explicitly and preserve schema, rows and closed handles', t => {
  for (const alter of [
    db => db.exec('ALTER TABLE service_tenant_private ADD COLUMN synthetic_unknown TEXT;'),
    db => db.exec("ALTER TABLE service_tenant_private ADD COLUMN header_token INTEGER NOT NULL DEFAULT 0;"),
    db => db.exec("ALTER TABLE service_tenant_private ADD COLUMN header_token TEXT NOT NULL DEFAULT 'forged';"),
    db => db.exec('CREATE TRIGGER service_private_header_token_insert AFTER INSERT ON service_tenant_private BEGIN SELECT 1; END;')
  ]) {
    assertPreservedFailure(legacy(t, alter));
  }
});

test('unknown header schema is rejected before journal recovery can materialize a committed overlay', t => {
  const resource = legacy(t), store = resource.store = new Store(resource.path, { conversationJournal: true });
  store.mutateConversation(actor, 'tenant-a', 'target', 'Synthetic dirty journal before unknown header', conversation => {
    conversation.version++; conversation.messages.push({ id: 'journal-only', externalId: 'journal-provider', kind: 'agent', text: 'Synthetic journal-only history' });
  });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, 1);
  assert.equal(JSON.parse(store.db.prepare("SELECT data FROM tenants WHERE id='tenant-a'").get().data).conversations[0].version, 1);
  store.close(); resource.store = null; const raw = new DatabaseSync(resource.path);
  try { raw.exec('ALTER TABLE service_tenant_private ADD COLUMN synthetic_unknown TEXT;'); }
  finally { raw.close(); }
  assertPreservedFailure(resource, { conversationJournal: true });
});

test('SQL tokens never suffer ABA across A-to-B-to-A, DELETE/INSERT, REPLACE with FK/recursive triggers off or rebuild', t => {
  const resource = legacy(t), store = resource.store = new Store(resource.path), original = store.db.prepare("SELECT data FROM tenants WHERE id='tenant-a'").get().data;
  const raw = new DatabaseSync(resource.path), seen = new Set([token(store.db)]), warm = read(store);
  const rotated = () => { const next = token(store.db); assert.match(next, /^[a-f0-9]{32}$/); assert.equal(seen.has(next), false, 'a retired authority token cannot reappear'); seen.add(next); };
  try {
    raw.prepare("UPDATE tenants SET data=json_set(data,'$.name','Intermediate header') WHERE id='tenant-a'").run(); rotated();
    raw.prepare("UPDATE tenants SET data=? WHERE id='tenant-a'").run(original); rotated();
    const prepare = store.db.prepare.bind(store.db), headers = [];
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes(' AS header')) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => { const row = get(...args); headers.push(row?.header); return row; };
      }
      return statement;
    };
    try { assert.deepEqual(read(store).contacts, warm.contacts); assert.ok(headers.some(value => typeof value === 'string'), 'ABA must fetch and verify current raw header even when the final bytes match'); }
    finally { store.db.prepare = prepare; }
    raw.exec('BEGIN IMMEDIATE');
    raw.prepare("DELETE FROM tenants WHERE id='tenant-a'").run(); raw.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-a', actor.resellerId, original); raw.exec('COMMIT'); rotated();
    raw.exec('PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=OFF;');
    raw.prepare('INSERT OR REPLACE INTO tenants VALUES (?,?,?)').run('tenant-a', actor.resellerId, original); rotated();
    store.serviceReadModel.rebuild(); rotated();
    assert.equal(store.db.prepare("SELECT data FROM tenants WHERE id='tenant-a'").get().data, original);
    assert.equal(read(store).conversations[0].messages[0].text, 'Synthetic preserved history');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { raw.close(); }
});

test('an invalid live token cannot serve a previously warm header or execute a mutation callback', t => {
  const resource = legacy(t), store = resource.store = new Store(resource.path); read(store);
  store.db.prepare("UPDATE service_tenant_private SET header_token='' WHERE tenant_id='tenant-a'").run();
  assert.throws(() => read(store), error => error.code === 'ELOZI_READONLY_HEADER_TOKEN');
  let called = false;
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'target', 'Invalid synthetic token', () => { called = true; }), error => error.code === 'ELOZI_READONLY_HEADER_TOKEN');
  assert.equal(called, false); assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
});

test('token lookup is an immutable bounded scope hint and raw cache compatibility never grants a stale token', () => {
  const cache = new ReadonlyHeaderCache({ maxEntries: 2, maxBytes: 128, maxHeaderBytes: 64 }), a = '1'.repeat(32), b = '2'.repeat(32), c = '3'.repeat(32);
  const value = cache.read('a:b', 'c', '{"nested":{"items":["é🌙"]}}', a);
  assert.equal(cache.token('a:b', 'c'), a); assert.strictEqual(cache.readToken('a:b', 'c', a).value, value);
  assert.equal(cache.readToken('a', 'b:c', a), undefined); assert.equal(cache.readToken('a:b', 'c', b), undefined);
  assert.throws(() => value.nested.items.push('poison'), TypeError);
  cache.read('a:b', 'c', '{"nested":{"items":["é🌙"]}}', a);
  const other = cache.read('a', 'b:c', '{"other":true}', b); assert.notStrictEqual(other, value);
  cache.readToken('a:b', 'c', a); cache.read('workspace', 'third', '{}', c);
  assert.equal(cache.token('a', 'b:c'), null); assert.equal(cache.size, 2); assert.ok(cache.bytes <= 128);
  cache.read('a:b', 'c', JSON.stringify({ padding: 'synthetic'.repeat(20) }), b);
  assert.equal(cache.token('a:b', 'c'), null); assert.equal(cache.readToken('a:b', 'c', a), undefined);
  assert.throws(() => cache.read('workspace', 'third', '{', a), SyntaxError); assert.equal(cache.token('workspace', 'third'), null);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
  assert.equal(cache.read('old', 'api', '{}').constructor, Object); assert.equal(cache.token('old', 'api'), null, 'legacy raw-only cache reads do not invent a SQL token');
});
