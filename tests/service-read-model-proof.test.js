import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const workspace = label => `proof-workspace-${label}`;
const tenantId = label => `proof-tenant-${label}`;
function source(label) {
  return { name: `Empresa sintética ${label}`, privateHeader: `header-secret-${label}`,
    channels: [{ id: `channel-${label}`, kind: 'whatsapp_qr', transport: 'baileys' }],
    agents: [{ id: `agent-${label}`, provider: 'mcp', mode: 'copilot', configured: true, instructions: `agent-secret-${label}` }], departments: [],
    conversations: Array.from({ length: 3 }, (_, index) => ({ id: index === 0 ? 'shared-id' : `conversation-${label}-${index}`, channelId: `channel-${label}`,
      owner: 'agent', agentId: `agent-${label}`, version: 1, status: 'open', privateField: `conversation-secret-${label}-${index}`,
      messages: [{ id: `message-${label}-${index}`, kind: 'customer', text: `private-message-${label}-${index}` }] })) };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-projection-proof-')), path = join(directory, 'synthetic.sqlite'), store = new Store(path);
  for (const label of ['a', 'b']) {
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspace(label), '{}');
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenantId(label), workspace(label), JSON.stringify(source(label)));
  }
  const resource = { store, path };
  t.after(() => { resource.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return resource;
}
const canonical = (db, label = 'a') => db.prepare('SELECT data FROM tenants WHERE id=?').get(tenantId(label)).data;
const projected = (store, label = 'a') => store.serviceTenant(workspace(label), tenantId(label));
const guardCount = db => db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n;
const setSource = (db, value, label = 'a') => db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), tenantId(label));
const setConversation = (db, value, label = 'a', position = 0) => db.prepare('UPDATE tenants SET data=json_set(data,?,json(?)) WHERE id=?').run(`$.conversations[${position}]`, JSON.stringify(value), tenantId(label));
const hint = (store, conversation, update, label = 'a', position = 0) => store.serviceReadModel.withConversationWrite({ tenantId: tenantId(label), workspaceId: workspace(label), position, conversationId: conversation.id, data: JSON.stringify(conversation) }, update);
function assertRebuildEquivalent(store) {
  const before = ['a', 'b'].map(label => projected(store, label));
  store.serviceReadModel.rebuild();
  assert.deepEqual(['a', 'b'].map(label => projected(store, label)), before);
}

test('legacy connection without TEMP triggers cannot use a forged/stale validated flag to retain old authorization', t => {
  const { store, path } = fixture(t), raw = new DatabaseSync(path), target = structuredClone(source('a').conversations[0]); target.version = 99;
  try {
    assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE type='trigger'").get().n, 0);
    raw.prepare('INSERT INTO service_conversation_write_guard (tenant_id,workspace_id,position,conversation_id,data,validated) VALUES (?,?,?,?,?,1)')
      .run(tenantId('a'), workspace('a'), 0, target.id, JSON.stringify(target));
    raw.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false'),'$.channels[0].kind','telegram_user','$.channels[0].transport','telegram-user') WHERE id=?").run(tenantId('a'));
    const current = projected(store);
    assert.equal(current.agents[0].configured, false); assert.equal(current.channels[0].kind, 'telegram_user');
    assert.equal(current.conversations[0].version, 1, 'forged guard data cannot replace canonical conversation metadata');
    assert.equal(raw.prepare('SELECT validated FROM service_conversation_write_guard WHERE tenant_id=?').get(tenantId('a')).validated, 0);
    assert.equal(projected(store, 'b').agents[0].configured, true);
    raw.prepare('DELETE FROM service_conversation_write_guard WHERE tenant_id=?').run(tenantId('a'));
    assertRebuildEquivalent(store);
  } finally { raw.close(); }
});

test('NEW equal to an earlier expected document never proves an update whose OLD document changed laterally', t => {
  const { store } = fixture(t), initial = source('a'); initial.agents[0].configured = false; setSource(store.db, initial);
  const changed = structuredClone(initial.conversations[0]); changed.version = 2;
  const earlierExpected = structuredClone(initial); earlierExpected.conversations[0] = changed;
  hint(store, changed, () => {
    setConversation(store.db, changed);
    assert.equal(projected(store).agents[0].configured, false);
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('true'),'$.conversations[1].owner','human') WHERE id=?").run(tenantId('a'));
    assert.equal(projected(store).agents[0].configured, true);
    // This NEW matches the buffer from hint creation, but its OLD now contains another policy and sibling.
    setSource(store.db, earlierExpected);
    const current = projected(store);
    assert.equal(current.agents[0].configured, false, 'a stale expected buffer must not leave the widened grant in the header');
    assert.equal(current.conversations.find(value => value.id === 'conversation-a-1').owner, 'agent');
    assert.equal(store.db.prepare('SELECT validated FROM service_conversation_write_guard WHERE tenant_id=?').get(tenantId('a')).validated, 0);
  });
  assert.equal(guardCount(store.db), 0); assertRebuildEquivalent(store);
});

test('interleaved and multi-row statements keep proofs isolated by tenant/workspace even when conversation IDs coincide', t => {
  const { store } = fixture(t), changed = structuredClone(source('a').conversations[0]); changed.version = 2;
  hint(store, changed, () => {
    setConversation(store.db, changed);
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false'),'$.conversations[0].owner','human') WHERE id IN (?,?)").run(tenantId('a'), tenantId('b'));
    for (const label of ['a', 'b']) {
      assert.equal(projected(store, label).agents[0].configured, false);
      assert.equal(projected(store, label).conversations.find(value => value.id === 'shared-id').owner, 'human');
      assert.equal(projected(store, label).channels[0].id, `channel-${label}`);
    }
    setConversation(store.db, { ...changed, version: 3 });
    assert.equal(projected(store).conversations.find(value => value.id === 'shared-id').version, 3);
    assert.equal(projected(store, 'b').conversations.find(value => value.id === 'shared-id').version, 1);
    assert.equal(projected(store).agents[0].configured, false);
  });
  assert.equal(guardCount(store.db), 0); assertRebuildEquivalent(store);
});

test('callback failure and outer rollback restore canonical data, public metadata and private histories together', t => {
  const { store } = fixture(t), original = canonical(store.db), before = projected(store), changed = structuredClone(source('a').conversations[0]);
  const actor = { role: 'reseller', resellerId: workspace('a') }; changed.version = 2; changed.messages.push({ id: 'new-private', text: 'must roll back' });
  assert.throws(() => hint(store, changed, () => { setConversation(store.db, changed); throw new Error('synthetic crash before commit'); }), /synthetic crash/);
  assert.equal(canonical(store.db), original); assert.equal(guardCount(store.db), 0); assert.deepEqual(projected(store), before);
  store.db.exec('BEGIN IMMEDIATE'); hint(store, changed, () => setConversation(store.db, changed));
  assert.equal(store.conversationTenant(actor, tenantId('a'), changed.id).conversations[0].messages.length, 2);
  store.db.exec('ROLLBACK');
  assert.equal(canonical(store.db), original); assert.equal(guardCount(store.db), 0); assert.deepEqual(projected(store), before);
  assert.deepEqual(store.conversationTenant(actor, tenantId('a'), changed.id).conversations[0], source('a').conversations[0]);
  assertRebuildEquivalent(store);
});

test('raw legacy writes refresh private headers/histories without adding secrets to public metadata or another tenant', t => {
  const { store, path } = fixture(t), raw = new DatabaseSync(path), actor = { role: 'reseller', resellerId: workspace('a') };
  try {
    const beforeB = projected(store, 'b'), changed = source('a'); changed.privateHeader = 'new-header-secret'; changed.agents[0].instructions = 'new-agent-secret';
    changed.conversations.reverse(); changed.conversations.find(value => value.id === 'shared-id').messages.push({ id: 'new-message', text: 'new-private-history' });
    setSource(raw, changed);
    const privateTenant = store.conversationTenant(actor, tenantId('a'), 'shared-id');
    assert.equal(privateTenant.privateHeader, 'new-header-secret'); assert.equal(privateTenant.agents[0].instructions, 'new-agent-secret');
    assert.deepEqual(privateTenant.conversations[0], changed.conversations.find(value => value.id === 'shared-id'));
    const publicData = JSON.stringify(projected(store));
    for (const secret of ['new-header-secret', 'new-agent-secret', 'new-private-history', 'private-message-a', 'conversation-secret-a', 'messages']) assert.equal(publicData.includes(secret), false, secret);
    assert.deepEqual(projected(store, 'b'), beforeB); assertRebuildEquivalent(store);
    raw.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', tenantId('a'));
    assert.equal(canonical(raw), '{'); assert.deepEqual(projected(store).agents, []); assert.deepEqual(projected(store).conversations, []);
    assert.deepEqual(projected(store, 'b'), beforeB);
  } finally { raw.close(); }
});

test('a projection-version downgrade blocks private reads/CAS and cannot be repaired by promoting metadata alone', t => {
  const resource = fixture(t), store = resource.store, actor = { role: 'reseller', resellerId: workspace('a') }, original = canonical(store.db);
  store.db.prepare("UPDATE service_read_model_meta SET version=4 WHERE id='routing'").run();
  assert.throws(() => store.conversationTenant(actor, tenantId('a'), 'shared-id'), error => error.status === 404);
  let called = false;
  assert.throws(() => store.mutateConversation(actor, tenantId('a'), 'shared-id', 'Version blocked', () => { called = true; }), error => error.status === 404);
  assert.equal(called, false); assert.equal(guardCount(store.db), 0); assert.equal(canonical(store.db), original);
  assert.deepEqual(store.serviceTenant(workspace('a'), tenantId('a'), { conversationId: 'shared-id', includeMessages: true }).conversations, []);
  assert.throws(() => store.serviceReadModel.rebuild());
  assert.equal(store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 4, 'rebuild cannot make stale indexes trusted without reinstalling triggers');
  store.close(); resource.store = new Store(resource.path);
  assert.equal(resource.store.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
  assert.deepEqual(resource.store.conversationTenant(actor, tenantId('a'), 'shared-id').conversations[0], source('a').conversations[0]);
  assert.equal(canonical(resource.store.db), original); assertRebuildEquivalent(resource.store);
});
