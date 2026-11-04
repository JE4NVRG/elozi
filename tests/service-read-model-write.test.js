import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-scoped-projection-')), path = join(directory, 'fixture.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const data = { channels: [{ id: 'channel', kind: 'webchat' }], agents: [{ id: 'agent', configured: true }], departments: [], secret: 'private-header',
    conversations: Array.from({ length: 40 }, (_, index) => ({ id: `conversation-${index}`, channelId: 'channel', owner: 'agent', version: 1,
      messages: [{ id: `private-${index}`, text: 'Preserve this synthetic history.' }] })) };
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('scope-tenant', 'mep-demo', JSON.stringify(data));
  return { store, path, data };
}
const canonical = store => store.db.prepare('SELECT data FROM tenants WHERE id=?').get('scope-tenant').data;
const guards = store => store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n;
function scoped(store, data, position = 0, action) {
  return store.serviceReadModel.withConversationWrite({ tenantId: 'scope-tenant', workspaceId: 'mep-demo', position, conversationId: data.id, data: JSON.stringify(data) },
    action || (() => store.db.prepare("UPDATE tenants SET data=json_set(data,?,json(?)) WHERE id=?").run(`$.conversations[${position}]`, JSON.stringify(data), 'scope-tenant')));
}

test('incremental projection validates canonical equality once, preserves every other history and matches a rebuild', t => {
  const { store, data } = fixture(t), changed = structuredClone(data.conversations[25]);
  changed.version++; changed.messages.push({ id: 'new-private', text: 'private additional message' });
  const expected = structuredClone(data); expected.conversations[25] = changed;
  const validated = [];
  store.db.function('json_valid', value => { validated.push(value.length); JSON.parse(value); return 1; });
  scoped(store, changed, 25);
  assert.equal(guards(store), 0);
  assert.deepEqual(JSON.parse(canonical(store)), expected);
  assert.equal(validated.filter(length => length > 5000).length, 0, 'the independent OLD/NEW equality proof uses the indexed private validity/position; skipped full projection never validates the large document again');
  const before = store.serviceTenant('mep-demo', 'scope-tenant');
  assert.equal(before.conversations.find(value => value.id === changed.id).version, 2);
  assert.equal(JSON.stringify(before).includes('private'), false);
  store.serviceReadModel.rebuild();
  assert.deepEqual(store.serviceTenant('mep-demo', 'scope-tenant'), before);
});

test('a hint cannot hide a lateral conversation or header update, tenant move or id replacement', t => {
  const { store, data } = fixture(t);
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('other-workspace', '{}');
  for (const kind of ['header', 'sibling', 'replacement', 'workspace']) {
    store.db.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run('mep-demo', JSON.stringify(data), 'scope-tenant');
    const target = structuredClone(data.conversations[0]); target.version = 2;
    const actual = structuredClone(data); actual.conversations[0] = target;
    if (kind === 'header') actual.agents[0].configured = false;
    if (kind === 'sibling') actual.conversations[1].owner = 'human';
    if (kind === 'replacement') actual.conversations[0].id = 'replacement';
    const workspace = kind === 'workspace' ? 'other-workspace' : 'mep-demo';
    scoped(store, target, 0, () => store.db.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run(workspace, JSON.stringify(actual), 'scope-tenant'));
    assert.equal(guards(store), 0);
    const projected = store.serviceTenant(workspace, 'scope-tenant');
    store.serviceReadModel.rebuild();
    assert.deepEqual(store.serviceTenant(workspace, 'scope-tenant'), projected, kind);
    assert.deepEqual(JSON.parse(canonical(store)), actual, kind);
  }
});

test('a later duplicate cannot replace the first-id projection even with an otherwise exact scoped hint', t => {
  const { store, data } = fixture(t);
  data.conversations[1].id = data.conversations[0].id;
  store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(data), 'scope-tenant');
  const changed = structuredClone(data.conversations[1]); changed.owner = 'human'; changed.version = 99;
  scoped(store, changed, 1);
  const projected = store.serviceTenant('mep-demo', 'scope-tenant', { conversationId: changed.id }).conversations[0];
  assert.equal(projected.version, 1); assert.equal(projected.owner, 'agent');
  assert.equal(JSON.parse(canonical(store)).conversations[1].version, 99);
  assert.equal(guards(store), 0);
});

test('hint and canonical write roll back together on callback failure or outer rollback; legacy SQL remains supported', t => {
  const { store, path, data } = fixture(t), original = canonical(store), projectedBefore = store.serviceTenant('mep-demo', 'scope-tenant'), changed = structuredClone(data.conversations[0]);
  changed.version = 2;
  assert.throws(() => scoped(store, changed, 0, () => {
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0]',json(?)) WHERE id=?").run(JSON.stringify(changed), 'scope-tenant');
    throw new Error('synthetic interruption');
  }), /synthetic interruption/);
  assert.equal(canonical(store), original); assert.equal(guards(store), 0);
  store.db.exec('BEGIN IMMEDIATE'); scoped(store, changed);
  assert.equal(store.serviceTenant('mep-demo', 'scope-tenant').conversations[0].version, 2);
  store.db.exec('ROLLBACK');
  assert.equal(canonical(store), original); assert.equal(guards(store), 0);
  assert.deepEqual(store.serviceTenant('mep-demo', 'scope-tenant'), projectedBefore);
  const raw = new DatabaseSync(path);
  try {
    data.conversations[39].owner = 'human';
    raw.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(data), 'scope-tenant');
    assert.equal(store.serviceTenant('mep-demo', 'scope-tenant').conversations.find(value => value.id === 'conversation-39').owner, 'human');
    raw.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', 'scope-tenant');
    assert.deepEqual(store.serviceTenant('mep-demo', 'scope-tenant').conversations, []);
    assert.equal(canonical(store), '{');
  } finally { raw.close(); }
});

test('each SQL statement revalidates its hint after a lateral write and after an earlier verified write', t => {
  const { store, data } = fixture(t), changed = structuredClone(data.conversations[0]); changed.version = 2;
  const validated = () => store.db.prepare('SELECT validated FROM service_conversation_write_guard').get().validated;
  scoped(store, changed, 0, () => {
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.agents[0].configured',json('false')) WHERE id=?").run('scope-tenant');
    assert.equal(validated(), 0);
    assert.equal(store.serviceTenant('mep-demo', 'scope-tenant').agents[0].configured, false);
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0]',json(?)) WHERE id=?").run(JSON.stringify(changed), 'scope-tenant');
    assert.equal(validated(), 0, 'every completed SQL statement disarms its proof before another statement can run');
    store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[1].owner','human') WHERE id=?").run('scope-tenant');
    assert.equal(validated(), 0, 'a validated hint from the previous statement cannot conceal a lateral update');
    const projected = store.serviceTenant('mep-demo', 'scope-tenant');
    assert.equal(projected.conversations.find(value => value.id === 'conversation-1').owner, 'human');
    assert.equal(projected.conversations.find(value => value.id === 'conversation-0').version, 2);
  });
  const projected = store.serviceTenant('mep-demo', 'scope-tenant');
  assert.equal(guards(store), 0); store.serviceReadModel.rebuild();
  assert.deepEqual(store.serviceTenant('mep-demo', 'scope-tenant'), projected);
});

test('invalid path/data or nested hints fail without committing guard rows or canonical changes', t => {
  const { store, data } = fixture(t), original = canonical(store);
  for (const position of [-1, '0', 0.5, Infinity]) assert.throws(() => scoped(store, data.conversations[0], position));
  for (const invalid of ['{}', '{"id":null}', '{"id":1}', '{"id":"other"}', '{', 'null', '[]']) {
    assert.throws(() => store.serviceReadModel.withConversationWrite({ tenantId: 'scope-tenant', workspaceId: 'mep-demo', position: 0, conversationId: 'conversation-0', data: invalid },
      () => store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0]',json(?)) WHERE id=?").run(invalid, 'scope-tenant')));
    assert.equal(canonical(store), original); assert.equal(guards(store), 0);
  }
  assert.throws(() => scoped(store, { id: 'conversation-0' }, 0, () => scoped(store, data.conversations[0])), /UNIQUE/);
  assert.throws(() => scoped(store, data.conversations[0], 0, () => Promise.resolve()), /síncrona/);
  assert.equal(canonical(store), original); assert.equal(guards(store), 0);
});
