import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const peer = '5511988880000@s.whatsapp.net', alias = '123456@lid', external = 'synthetic-provider-shared';
const tenantId = label => `lookup-tenant-${label}`, workspaceId = label => `lookup-workspace-${label}`;
function source(label = 'a') {
  const conversation = (id, remoteJid, remoteAliases = []) => ({ id, channelId: 'wa', remoteJid, remoteAliases,
    owner: 'agent', agentId: 'agent', status: 'open', version: 1, privateField: 'private-conversation',
    messages: [{ id: `message-${id}`, externalId: external, text: 'private-message', kind: 'customer' }] });
  return { name: 'Synthetic lookup fixture', privateHeader: 'private-header', contacts: [{ id: 'contact', secret: 'private-contact' }],
    channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }, { id: 'other', kind: 'whatsapp_qr', transport: 'baileys' }],
    agents: [{ id: 'agent', configured: true, provider: 'mcp', mode: 'copilot', instructions: 'private-agent' }], departments: [],
    conversations: [conversation(`z-${label}`, peer, [alias, alias]), conversation(`m-${label}`, '5511977770000@s.whatsapp.net', [alias]),
      conversation('shared-id', '5511966660000@s.whatsapp.net', [alias]), { ...conversation(`other-${label}`, peer, [alias]), channelId: 'other' }] };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-lookup-proof-')), path = join(directory, 'synthetic.sqlite'), raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);');
  for (const label of ['a', 'b']) {
    raw.prepare('INSERT INTO resellers VALUES (?,?)').run(workspaceId(label), '{}');
    raw.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenantId(label), workspaceId(label), JSON.stringify(source(label)));
  }
  raw.close();
  const resource = { store: new Store(path), path };
  t.after(() => { resource.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return resource;
}
const lookup = (store, kind, values, options = {}) => store.serviceReadModel.lookupConversationIds({ tenantId: tenantId('a'), workspaceId: workspaceId('a'), channelId: 'wa', kind, values, ...options });
const write = (db, value, label = 'a') => db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), tenantId(label));
const canonical = (db, label = 'a') => db.prepare('SELECT data FROM tenants WHERE id=?').get(tenantId(label)).data;
const meta = (db, label = 'a') => db.prepare('SELECT complete FROM service_conversation_lookup_meta WHERE tenant_id=?').get(tenantId(label))?.complete;
const rows = (db, label = 'a') => db.prepare('SELECT id,channel_id,kind,value FROM service_conversation_lookup WHERE tenant_id=? ORDER BY id,kind,value').all(tenantId(label)).map(value => ({ ...value }));
const expected = label => [`z-${label}`, `m-${label}`, 'shared-id'];

test('legacy bootstrap installs version six and an indexed lookup without changing canonical data or repeating backfill', t => {
  const resource = fixture(t), store = resource.store, original = canonical(store.db);
  assert.equal(store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.equal(meta(store.db), 1);
  assert.deepEqual(lookup(store, 'address', [peer, alias]), expected('a'));
  assert.deepEqual(lookup(store, 'external', [external]), expected('a'));
  assert.equal(canonical(store.db), original);
  const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM service_conversation_lookup WHERE tenant_id=? AND channel_id=? AND kind=? AND value IN (SELECT value FROM json_each(?))')
    .all(tenantId('a'), 'wa', 'external', JSON.stringify([external]));
  assert.ok(plan.some(row => /USING (?:COVERING )?INDEX service_conversation_lookup_key/.test(row.detail)), JSON.stringify(plan));
  const indexed = JSON.stringify(rows(store.db));
  for (const secret of ['private-message', 'private-conversation', 'private-header', 'private-contact', 'private-agent']) assert.equal(indexed.includes(secret), false, secret);
  store.close(); resource.store = new Store(resource.path);
  assert.equal(resource.store.db.prepare('SELECT total_changes() AS n').get().n, 0);
  assert.deepEqual(lookup(resource.store, 'external', [external]), expected('a'));
  assert.equal(canonical(resource.store.db), original);
});

test('lookup is complete, deduplicated and ordered by canonical position rather than identifier or requested-value order', t => {
  const { store } = fixture(t), value = source();
  value.conversations[0].messages.push({ id: 'second-provider-copy', externalId: external });
  write(store.db, value);
  assert.deepEqual(lookup(store, 'address', [alias, peer, alias]), expected('a'));
  assert.deepEqual(lookup(store, 'external', ['missing-provider', external, external]), expected('a'));
  assert.deepEqual(lookup(store, 'address', ['missing-address']), []);
  assert.deepEqual(lookup(store, 'external', ['missing-provider']), []);
  assert.deepEqual(lookup(store, 'external', [external], { channelId: 'other' }), ['other-a']);
  value.conversations.reverse(); write(store.db, value);
  assert.deepEqual(lookup(store, 'address', [peer, alias]), ['shared-id', 'm-a', 'z-a']);
  assert.deepEqual(lookup(store, 'external', [external]), ['shared-id', 'm-a', 'z-a']);
  value.conversations = []; write(store.db, value);
  assert.equal(meta(store.db), 1); assert.deepEqual(lookup(store, 'address', [peer]), []); assert.deepEqual(lookup(store, 'external', [external]), []);
});

test('tenant, current workspace and channel scope isolate identical provider values and shared conversation identifiers', t => {
  const { store } = fixture(t);
  assert.deepEqual(lookup(store, 'external', [external]), expected('a'));
  assert.deepEqual(lookup(store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), expected('b'));
  assert.equal(lookup(store, 'external', [external], { tenantId: tenantId('b') }), null);
  assert.equal(lookup(store, 'external', [external], { workspaceId: workspaceId('b') }), null);
  assert.equal(lookup(store, 'external', [external], { tenantId: 'missing-tenant' }), null);
  assert.deepEqual(lookup(store, 'external', [external], { channelId: 'unrelated-channel' }), []);
  assert.equal(lookup(store, 'unsupported', [external]), null);
  for (const values of [null, external, [external, 17], [null]]) assert.equal(lookup(store, 'external', values), null);
  store.db.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run(workspaceId('b'), tenantId('a'));
  assert.equal(lookup(store, 'external', [external]), null, 'old workspace cannot retain indexed authority after a raw move');
  assert.deepEqual(lookup(store, 'external', [external], { workspaceId: workspaceId('b') }), expected('a'));
  assert.deepEqual(lookup(store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), expected('b'));
});

test('a legacy raw writer updates aliases, provider IDs, order and removals without a JS hook or UDF', t => {
  const { store, path } = fixture(t), raw = new DatabaseSync(path), untouched = canonical(store.db, 'b'), value = source();
  try {
    assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE type='trigger'").get().n, 0);
    for (const conversation of value.conversations) { conversation.remoteJid = `new-${conversation.id}`; conversation.remoteAliases = []; conversation.messages = [{ id: `new-${conversation.id}`, externalId: 'new-provider' }]; }
    value.conversations.reverse(); write(raw, value);
    assert.deepEqual(lookup(store, 'address', [peer, alias]), []);
    assert.deepEqual(lookup(store, 'external', [external]), []);
    assert.deepEqual(lookup(store, 'external', ['new-provider']), ['shared-id', 'm-a', 'z-a']);
    assert.deepEqual(lookup(store, 'address', ['new-z-a']), ['z-a']);
    value.conversations = value.conversations.filter(conversation => conversation.id !== 'm-a'); write(raw, value);
    assert.deepEqual(lookup(store, 'external', ['new-provider']), ['shared-id', 'z-a']);
    assert.equal(rows(store.db).some(row => row.id === 'm-a'), false);
    assert.equal(canonical(store.db, 'b'), untouched);
    raw.prepare('DELETE FROM tenants WHERE id=?').run(tenantId('a'));
    assert.equal(lookup(store, 'external', ['new-provider']), null);
    assert.equal(rows(store.db).length, 0); assert.equal(meta(store.db), undefined);
    assert.deepEqual(lookup(store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), expected('b'));
  } finally { raw.close(); }
});

test('duplicate IDs anywhere in the canonical array force fallback instead of hiding a later address or receipt match', t => {
  const { store } = fixture(t);
  for (const duplicateChannel of ['wa', 'other']) {
    const value = source(); value.conversations[3] = { ...value.conversations[3], id: value.conversations[0].id, channelId: duplicateChannel, remoteJid: 'later-only-address', remoteAliases: [], messages: [{ id: 'later-message', externalId: 'later-only-provider' }] };
    write(store.db, value);
    assert.equal(meta(store.db), 0);
    for (const kind of ['address', 'external']) {
      assert.equal(lookup(store, kind, [kind === 'address' ? 'later-only-address' : 'later-only-provider']), null);
      assert.equal(lookup(store, kind, ['missing']), null, 'an empty result is not complete when the first-id projection lost a duplicate');
    }
    assert.deepEqual(lookup(store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), expected('b'));
  }
});

test('unprovable canonical shapes preserve source data and return null until a full valid rewrite repairs coverage', t => {
  const { store } = fixture(t), cases = [
    ['non-array conversations', value => { value.conversations = {}; }],
    ['primitive conversation', value => { value.conversations[1] = false; }],
    ['string conversation', value => { value.conversations[1] = 'not-json'; }],
    ['missing id', value => { delete value.conversations[1].id; }],
    ['empty id', value => { value.conversations[1].id = ''; }],
    ['numeric id', value => { value.conversations[1].id = 17; }],
    ['null id', value => { value.conversations[1].id = null; }],
    ['non-string channel', value => { value.conversations[1].channelId = 17; }],
    ['non-string address', value => { value.conversations[1].remoteJid = 17; }],
    ['object aliases', value => { value.conversations[1].remoteAliases = { first: alias }; }],
    ['non-string alias', value => { value.conversations[1].remoteAliases = [alias, null]; }],
    ['missing messages', value => { delete value.conversations[1].messages; }],
    ['object messages', value => { value.conversations[1].messages = { first: { externalId: external } }; }],
    ['primitive message', value => { value.conversations[1].messages = [false]; }],
    ['string message', value => { value.conversations[1].messages = ['not-json']; }],
    ['non-string provider id', value => { value.conversations[1].messages[0].externalId = 17; }]
  ];
  for (const [name, change] of cases) {
    const value = source(); change(value); write(store.db, value);
    assert.equal(canonical(store.db), JSON.stringify(value), name);
    assert.equal(meta(store.db), 0, name);
    assert.equal(lookup(store, 'address', [peer]), null, name); assert.equal(lookup(store, 'external', [external]), null, name);
    assert.deepEqual(rows(store.db), [], name);
    write(store.db, source()); assert.equal(meta(store.db), 1, name); assert.deepEqual(lookup(store, 'external', [external]), expected('a'), name);
  }
  for (const malformed of ['{', 'null', 'false', '[]']) {
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(malformed, tenantId('a'));
    assert.equal(canonical(store.db), malformed); assert.equal(meta(store.db), 0);
    assert.equal(lookup(store, 'address', [peer]), null); assert.equal(lookup(store, 'external', [external]), null);
  }
  const value = source(); delete value.conversations[0].remoteJid; value.conversations[0].remoteAliases = null;
  value.conversations[0].messages = [{ id: 'without-provider' }, { id: 'null-provider', externalId: null }]; write(store.db, value);
  assert.equal(meta(store.db), 1); assert.deepEqual(lookup(store, 'external', [external]), ['m-a', 'shared-id']);
});

test('scoped conversation writes and outer rollback update provider/address indexes atomically and never promote incomplete coverage', t => {
  const { store } = fixture(t), actor = { role: 'reseller', resellerId: workspaceId('a'), name: 'Synthetic lookup actor' }, original = canonical(store.db), before = rows(store.db);
  const change = conversation => {
    conversation.remoteJid = 'changed-address'; conversation.remoteAliases = [];
    conversation.messages = [{ id: 'changed-message', externalId: 'changed-provider', kind: 'agent' }]; conversation.version++;
  };
  store.mutateConversation(actor, tenantId('a'), 'z-a', 'Synthetic lookup change', change);
  assert.deepEqual(lookup(store, 'address', ['changed-address']), ['z-a']);
  assert.deepEqual(lookup(store, 'external', ['changed-provider']), ['z-a']);
  assert.deepEqual(lookup(store, 'external', [external]), ['m-a', 'shared-id']);
  store.mutateConversation(actor, tenantId('a'), 'z-a', 'Synthetic channel move', conversation => { conversation.channelId = 'other'; });
  assert.deepEqual(lookup(store, 'address', ['changed-address']), []);
  assert.deepEqual(lookup(store, 'external', ['changed-provider']), []);
  assert.deepEqual(lookup(store, 'external', ['changed-provider'], { channelId: 'other' }), ['z-a']);
  write(store.db, source());
  const changed = structuredClone(source().conversations[0]); change(changed);
  store.db.exec('BEGIN IMMEDIATE');
  store.serviceReadModel.withConversationWrite({ tenantId: tenantId('a'), workspaceId: workspaceId('a'), position: 0, conversationId: changed.id, data: JSON.stringify(changed) },
    ({ expectedSql }) => store.db.prepare(`UPDATE tenants SET data=${expectedSql} WHERE id=?`).run(tenantId('a')));
  assert.deepEqual(lookup(store, 'external', ['changed-provider']), ['z-a']);
  store.db.exec('ROLLBACK');
  assert.equal(canonical(store.db), original); assert.deepEqual(rows(store.db), before);
  assert.deepEqual(lookup(store, 'external', ['changed-provider']), []); assert.deepEqual(lookup(store, 'external', [external]), expected('a'));
  const incomplete = source(); incomplete.conversations[1].remoteAliases = 17; write(store.db, incomplete);
  store.mutateConversation(actor, tenantId('a'), 'z-a', 'Synthetic incomplete lookup', conversation => { conversation.version++; });
  assert.equal(meta(store.db), 0); assert.equal(lookup(store, 'external', [external]), null);
  write(store.db, source());
  store.mutateConversation(actor, tenantId('a'), 'z-a', 'Synthetic invalidated lookup', conversation => { conversation.remoteAliases = 'unprovable'; });
  assert.equal(meta(store.db), 0); assert.equal(lookup(store, 'external', [external]), null);
  store.mutateConversation(actor, tenantId('a'), 'z-a', 'Synthetic repaired target', conversation => { conversation.remoteAliases = []; });
  assert.equal(meta(store.db), 0, 'repairing one target cannot prove that the rest of a formerly incomplete tenant is valid');
  assert.equal(lookup(store, 'external', [external]), null);
  write(store.db, JSON.parse(canonical(store.db)));
  store.serviceReadModel.rebuild(); assert.equal(meta(store.db), 1); assert.deepEqual(lookup(store, 'external', [external]), expected('a'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
});

test('coverage and indexed rows share one WAL snapshot when a legacy writer moves or invalidates the tenant between reads', t => {
  for (const kind of ['workspace', 'coverage']) {
    const { store, path } = fixture(t), raw = new DatabaseSync(path), coverage = store.serviceReadModel.lookupCoverage;
    const get = coverage.get.bind(coverage); let injected = false;
    coverage.get = (...args) => {
      const result = get(...args);
      if (!injected) {
        injected = true;
        if (kind === 'workspace') raw.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run(workspaceId('b'), tenantId('a'));
        else { const value = source(); value.conversations[0].id = null; write(raw, value); }
      }
      return result;
    };
    try {
      assert.deepEqual(lookup(store, 'external', [external]), expected('a'), kind);
      assert.equal(injected, true, 'fixture injected a committed legacy write after the coverage read');
      coverage.get = get;
      assert.equal(lookup(store, 'external', [external]), null, kind);
      if (kind === 'workspace') assert.deepEqual(lookup(store, 'external', [external], { workspaceId: workspaceId('b') }), expected('a'));
      assert.deepEqual(lookup(store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), expected('b'));
    } finally { coverage.get = get; raw.close(); }
  }
});

test('older projection versions and missing coverage fail closed until reopening migrates and backfills version six', t => {
  const resource = fixture(t), store = resource.store, original = canonical(store.db);
  store.db.prepare('DELETE FROM service_conversation_lookup_meta WHERE tenant_id=?').run(tenantId('a'));
  assert.equal(lookup(store, 'external', [external]), null);
  store.db.prepare("UPDATE service_read_model_meta SET version=5 WHERE id='routing'").run();
  assert.equal(lookup(store, 'address', [peer, alias]), null);
  assert.equal(lookup(store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), null);
  assert.throws(() => store.serviceReadModel.rebuild());
  store.close(); resource.store = new Store(resource.path);
  assert.equal(resource.store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.deepEqual(lookup(resource.store, 'address', [peer, alias]), expected('a'));
  assert.deepEqual(lookup(resource.store, 'external', [external], { tenantId: tenantId('b'), workspaceId: workspaceId('b') }), expected('b'));
  assert.equal(canonical(resource.store.db), original);
});
