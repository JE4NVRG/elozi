import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

// Exact retired v6 DDL. A similarly named table or generated expression is not disposable.
const proofV6 = `CREATE TABLE service_conversation_write_proof (
  tenant_id TEXT NOT NULL PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),conversation_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(CASE WHEN json_valid(data) THEN json_type(data) IS 'object' AND json_type(data,'$.id') IS 'text' AND json_extract(data,'$.id') IS conversation_id ELSE 0 END),
  old_data TEXT NOT NULL,
  expected_data TEXT NOT NULL GENERATED ALWAYS AS(json_set(old_data,'$.conversations['||position||']',json(data))) STORED)`;
const actor = { role: 'reseller', resellerId: 'payload-workspace-a', name: 'Synthetic retained-migration actor' };
function source(label) {
  return { privateHeader: { keep: `synthetic-header-${label}` }, contacts: [], channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: `synthetic-${label}`, remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1,
      privateField: `synthetic-conversation-${label}`, messages: [{ id: `message-${label}`, externalId: `provider-${label}`, kind: 'customer', text: `synthetic-history-${label}` }] }] };
}
function fixture(t, prepare = db => db.exec(proofV6)) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-retained-proof-')), path = join(directory, 'synthetic.sqlite'), db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);
    CREATE TABLE audit(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),action TEXT NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL);
    CREATE TABLE service_read_model_meta(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
    INSERT INTO service_read_model_meta VALUES ('routing',6);
    CREATE TABLE synthetic_retained_data(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO synthetic_retained_data VALUES ('keep','synthetic-unique-data');`);
  for (const label of ['a', 'b']) {
    db.prepare('INSERT INTO resellers VALUES (?,?)').run(`payload-workspace-${label}`, '{}');
    db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`payload-tenant-${label}`, `payload-workspace-${label}`, JSON.stringify(source(label)));
  }
  prepare(db); db.close();
  const resource = { path, store: null };
  t.after(() => { resource.store?.close(); rmSync(directory, { recursive: true, force: true }); });
  return resource;
}
const plain = rows => rows.map(row => ({ ...row }));
const canonical = db => plain(db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all());
function snapshot(db) {
  return { schema: plain(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()), source: canonical(db),
    meta: plain(db.prepare('SELECT * FROM service_read_model_meta ORDER BY id').all()), retained: plain(db.prepare('SELECT * FROM synthetic_retained_data').all()),
    proof: plain(db.prepare('SELECT * FROM service_conversation_write_proof').all()) };
}
function assertPreservedFailure(path) {
  let raw = new DatabaseSync(path); const before = snapshot(raw); raw.close();
  const close = DatabaseSync.prototype.close, closed = [];
  DatabaseSync.prototype.close = function (...args) { closed.push(this); return close.apply(this, args); };
  try { assert.throws(() => new Store(path), error => error.code === 'ELOZI_EXPERIMENTAL_WRITE_PROOF_PRESERVED' && /preservado/.test(error.message)); }
  finally { DatabaseSync.prototype.close = close; }
  assert.equal(closed.length, 1, 'a failed Store constructor closes its own SQLite connection');
  assert.throws(() => closed[0].prepare('SELECT 1'), /not open|closed/i);
  raw = new DatabaseSync(path);
  try {
    raw.exec('BEGIN EXCLUSIVE'); assert.deepEqual(snapshot(raw), before, 'failed migration preserves source, rows, version, schema and dependencies'); raw.exec('ROLLBACK');
    assert.equal(raw.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { raw.close(); }
}

test('known empty v6 payload is retired transactionally, canonical data remains intact and raw legacy writes work after routing eight', t => {
  const resource = fixture(t, db => {
    db.exec(proofV6);
    db.exec('CREATE TRIGGER service_read_before_update_v1 BEFORE UPDATE OF data ON tenants BEGIN SELECT expected_data FROM service_conversation_write_proof WHERE tenant_id=OLD.id; END;');
  });
  const before = new DatabaseSync(resource.path), original = canonical(before); before.close();
  const store = resource.store = new Store(resource.path);
  assert.equal(store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_conversation_write_proof'").get().n, 0);
  assert.deepEqual(canonical(store.db), original);
  const raw = new DatabaseSync(resource.path);
  try {
    raw.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false'),'$.conversations[0].messages[0].externalId','legacy-provider','$.conversations[0].version',2) WHERE id=?").run('payload-tenant-a');
    const current = store.readonlyConversationTenant(actor, 'payload-tenant-a', 'target');
    assert.equal(current.agents[0].configured, false); assert.equal(current.conversations[0].version, 2); assert.equal(current.conversations[0].messages[0].externalId, 'legacy-provider');
    assert.deepEqual(store.serviceReadModel.lookupConversationIds({ tenantId: 'payload-tenant-a', workspaceId: actor.resellerId, channelId: 'wa', kind: 'external', values: ['legacy-provider'] }), ['target']);
    assert.equal(raw.prepare('SELECT data FROM tenants WHERE id=?').get('payload-tenant-b').data, original.find(row => row.id === 'payload-tenant-b').data);
  } finally { raw.close(); }
  store.mutateConversation(actor, 'payload-tenant-a', 'target', 'Synthetic write after retained migration', conversation => { conversation.version++; });
  assert.equal(store.readonlyConversationTenant(actor, 'payload-tenant-a', 'target').conversations[0].version, 3);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('reopening routing seven does not recreate the experimental payload or rewrite canonical data', t => {
  const resource = fixture(t), first = new Store(resource.path), original = canonical(first.db); first.close();
  const store = resource.store = new Store(resource.path);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_conversation_write_proof'").get().n, 0);
  assert.deepEqual(canonical(store.db), original); assert.deepEqual(store.readonlyConversationTenant(actor, 'payload-tenant-a', 'target').conversations[0], source('a').conversations[0]);
});

test('a known payload containing a row is preserved with an explicit migration failure and a released DB handle', t => {
  const resource = fixture(t, db => {
    db.exec(proofV6); const value = source('a'), conversation = structuredClone(value.conversations[0]); conversation.version = 99;
    db.prepare('INSERT INTO service_conversation_write_proof (tenant_id,workspace_id,position,conversation_id,data,old_data) VALUES (?,?,?,?,?,?)')
      .run('payload-tenant-a', actor.resellerId, 0, conversation.id, JSON.stringify(conversation), JSON.stringify(value));
  });
  assertPreservedFailure(resource.path);
});

test('an empty table with the same columns but another generated expression is unknown and must survive', t => {
  const resource = fixture(t, db => db.exec(proofV6.replace("AS(json_set(old_data,'$.conversations['||position||']',json(data))) STORED", 'AS(old_data) STORED')));
  assertPreservedFailure(resource.path);
});

test('unknown indexes, views and triggers depending on an empty known payload are preserved rather than dropped', t => {
  for (const dependency of [
    'CREATE INDEX synthetic_retained_proof_index ON service_conversation_write_proof(workspace_id)',
    'CREATE VIEW synthetic_retained_proof_view AS SELECT old_data FROM service_conversation_write_proof',
    'CREATE TRIGGER synthetic_retained_proof_trigger AFTER INSERT ON service_conversation_write_proof BEGIN INSERT OR REPLACE INTO synthetic_retained_data VALUES (NEW.tenant_id,NEW.data); END'
  ]) {
    const resource = fixture(t, db => { db.exec(proofV6); db.exec(dependency); }); assertPreservedFailure(resource.path);
  }
});

test('an unknown ordinary table or a view using the experimental name is retained with schema and source unchanged', t => {
  for (const sql of [
    'CREATE TABLE service_conversation_write_proof (tenant_id TEXT PRIMARY KEY,data TEXT NOT NULL,unknown_private_column TEXT)',
    "CREATE VIEW service_conversation_write_proof AS SELECT 'synthetic-private-value' AS retained"
  ]) {
    const resource = fixture(t, db => db.exec(sql)); assertPreservedFailure(resource.path);
  }
});
