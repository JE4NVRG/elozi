import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ContactService, syncConversationContact } from '../src/contacts.js';

const denied = code => error => error.status === code;
const revision = value => assert.match(value, /^[a-f0-9]{64}$/);

function fixture(t, { empty = false } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let sequence = 0;
  const user = ({ role = 'operator', tenantIds = [], resellerId = 'mep-demo', permissions = ['contacts.read'], scopeRules = null } = {}) => {
    const n = ++sequence, row = auth.insertUser({ username: 'contact.snapshot.synthetic.' + n, name: 'Pessoa sintética ' + n }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, resellerId);
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const admin = user({ role: 'reseller' }), tenant = store.createTenant(admin, { name: 'Snapshot RAM A', segment: 'QA' });
  const otherTenant = store.createTenant(admin, { name: 'Snapshot RAM B', segment: 'QA' });
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('snapshot-other-workspace', JSON.stringify({ name: 'Workspace sintético separado', brand: { name: 'QA' } }));
  const foreignAdmin = user({ role: 'reseller', resellerId: 'snapshot-other-workspace' });
  const foreignTenant = store.createTenant(foreignAdmin, { name: 'Snapshot RAM C', segment: 'QA' });
  const seed = (actor, id) => store.mutate(actor, id, 'Fixture: escopos de snapshot', state => {
    state.channels = [{ id: 'webchat-a', kind: 'webchat', name: 'Canal A' }, { id: 'webchat-b', kind: 'webchat', name: 'Canal B' }];
    state.departments = [{ id: 'department-a', name: 'Departamento A' }, { id: 'department-b', name: 'Departamento B' }];
    state.contacts = []; state.conversations = [];
  });
  seed(admin, tenant.id); seed(admin, otherTenant.id); seed(foreignAdmin, foreignTenant.id);
  const rules = { [tenant.id]: { channelIds: ['webchat-a'], departmentIds: ['department-a'] } };
  const operator = user({ tenantIds: [tenant.id], scopeRules: rules }), peer = user({ tenantIds: [tenant.id], scopeRules: rules });
  const service = new ContactService(store, auth);
  const add = (name, channelId, departmentId, id) => store.mutate(admin, tenant.id, 'Fixture: contato ligado', state => {
    const conversation = { id, channelId, departmentId, contact: name, conversationKind: 'direct', status: 'open', owner: 'queue', version: 1,
      messages: [{ id: 'message-' + id, kind: 'customer', text: 'Conteúdo privado sintético excluído do snapshot' }] };
    state.conversations.push(conversation); return syncConversationContact(state, conversation, state.channels.find(channel => channel.id === channelId));
  });
  const visible = empty ? null : add('Pessoa visível', 'webchat-a', 'department-a', 'conversation-visible');
  const hidden = empty ? null : add('Pessoa restrita', 'webchat-b', 'department-b', 'conversation-hidden');
  const state = () => store.tenant(admin, tenant.id);
  const edit = fn => store.mutate(admin, tenant.id, 'Fixture: alteração seletiva', fn);
  const permissions = input => store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(input), operator.userId);
  const snapshot = (options = {}, since = '') => service.snapshot(operator, tenant.id, options, since);
  return { store, auth, service, admin, operator, peer, tenantId: tenant.id, otherTenantId: otherTenant.id, foreignAdmin, foreignTenantId: foreignTenant.id, visible, hidden, state, edit, permissions, snapshot };
}

test('snapshot returns the current filtered public DTO with a stable SHA256 revision and does not write data/schema', t => {
  const f = fixture(t), before = JSON.stringify(f.state()), audits = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const schema = f.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const initial = f.snapshot();
  assert.equal(initial.unchanged, false); revision(initial.revision); assert.deepEqual(initial.contacts, f.service.list(f.operator, f.tenantId));
  assert.deepEqual(initial.contacts.map(item => item.id), [f.visible.id]);
  assert.equal(JSON.stringify(initial).includes('conversation-visible'), false); assert.equal(JSON.stringify(initial).includes('Conteúdo privado'), false);
  assert.deepEqual(f.snapshot(), initial); assert.equal(JSON.stringify(f.state()), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits); assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), schema);
});

test('equal revision omits contacts; an unrelated valid SHA or empty since returns a fresh DTO', t => {
  const f = fixture(t), initial = f.snapshot();
  assert.deepEqual(f.snapshot({}, initial.revision), { revision: initial.revision, unchanged: true });
  assert.deepEqual(f.snapshot({}, '0'.repeat(64)), initial); assert.deepEqual(f.snapshot({}, ''), initial);
  const clientCopy = structuredClone(initial); clientCopy.contacts[0].name = 'Mudança somente no cliente';
  assert.deepEqual(f.snapshot({}, initial.revision), { revision: initial.revision, unchanged: true });
});

test('snapshot rejects invalid since and preserves list options validation', t => {
  const f = fixture(t);
  for (const since of [null, 0, false, [], {}, ' ', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'a'.repeat(64) + '\n']) assert.throws(() => f.snapshot({}, since), denied(400));
  for (const options of [{ search: [] }, { includeArchived: 'true' }, { aggregate: true }, { since: '' }]) assert.throws(() => f.snapshot(options), denied(400));
});

test('search and includeArchived keep legacy list filtering and unchanged reuses the same query context', t => {
  const f = fixture(t), original = f.service.snapshot(f.admin, f.tenantId, { search: 'visível' });
  assert.deepEqual(original.contacts, f.service.list(f.admin, f.tenantId, { search: 'visível' }));
  f.service.archive(f.admin, f.tenantId, f.visible.id, { version: 1 });
  const active = f.service.snapshot(f.admin, f.tenantId, { search: 'visível' }, original.revision);
  assert.equal(active.unchanged, false); assert.deepEqual(active.contacts, []); assert.notEqual(active.revision, original.revision);
  const archived = f.service.snapshot(f.admin, f.tenantId, { search: 'visível', includeArchived: true });
  assert.deepEqual(archived.contacts, f.service.list(f.admin, f.tenantId, { search: 'visível', includeArchived: true })); assert.ok(archived.contacts[0].archivedAt);
  const noMatch = f.service.snapshot(f.admin, f.tenantId, { search: 'não existe' });
  assert.deepEqual(noMatch.contacts, []); assert.deepEqual(f.service.snapshot(f.admin, f.tenantId, { search: 'não existe' }, noMatch.revision), { revision: noMatch.revision, unchanged: true });
  const noMatchArchived = f.service.snapshot(f.admin, f.tenantId, { search: 'não existe', includeArchived: true });
  assert.deepEqual(noMatchArchived.contacts, []); assert.deepEqual(f.service.snapshot(f.admin, f.tenantId, { search: 'não existe', includeArchived: true }, noMatchArchived.revision), { revision: noMatchArchived.revision, unchanged: true });
});

test('a visible CRM edit invalidates the old revision and returns current fields', t => {
  const f = fixture(t), initial = f.snapshot();
  f.service.update(f.admin, f.tenantId, f.visible.id, { version: 1, name: 'Pessoa visível editada', notes: 'Nota nova', tags: ['Atualizado'] });
  const changed = f.snapshot({}, initial.revision);
  assert.equal(changed.unchanged, false); assert.notEqual(changed.revision, initial.revision);
  assert.deepEqual(changed.contacts, f.service.list(f.operator, f.tenantId)); assert.equal(changed.contacts[0].name, 'Pessoa visível editada'); assert.equal(changed.contacts[0].version, 2);
});

test('an inaccessible contact edit leaves the filtered revision unchanged without exposing the other scope', t => {
  const f = fixture(t), initial = f.snapshot();
  f.service.update(f.admin, f.tenantId, f.hidden.id, { version: 1, name: 'Contato privado atualizado', notes: 'Nota que não pode vazar', tags: ['Etiqueta privada'] });
  assert.deepEqual(f.snapshot({}, initial.revision), { revision: initial.revision, unchanged: true });
  assert.deepEqual(f.snapshot().contacts, initial.contacts); assert.equal(JSON.stringify(f.snapshot()).includes('Nota que não pode vazar'), false);
});

test('private persisted fields and conversation messages do not affect a DTO-only revision', t => {
  const f = fixture(t), initial = f.snapshot();
  f.edit(state => {
    state.contacts.find(item => item.id === f.visible.id).privateDebug = 'Metadata privada sintética';
    const conversation = state.conversations.find(item => item.id === 'conversation-visible');
    conversation.messages.push({ id: 'private-new-message', kind: 'customer', text: 'Mensagem privada nova' }); conversation.version++;
  });
  assert.deepEqual(f.snapshot({}, initial.revision), { revision: initial.revision, unchanged: true });
  assert.equal(JSON.stringify(f.snapshot()).includes('Metadata privada'), false); assert.equal(JSON.stringify(f.snapshot()).includes('Mensagem privada'), false);
});

test('fresh channel/department ACL changes replace the filtered DTO even when the actor object is stale', t => {
  const f = fixture(t), initial = f.snapshot();
  f.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [f.tenantId]: { channelIds: ['webchat-b'], departmentIds: ['department-b'] } }), f.operator.userId);
  const changed = f.snapshot({}, initial.revision);
  assert.equal(changed.unchanged, false); assert.notEqual(changed.revision, initial.revision); assert.deepEqual(changed.contacts.map(item => item.id), [f.hidden.id]);
  assert.equal(JSON.stringify(changed).includes(f.visible.id), false);
});

for (const change of ['channel', 'department', 'conversation-department']) {
  test(`current ${change} visibility is re-evaluated before accepting a known revision`, t => {
    const f = fixture(t), initial = f.snapshot();
    f.edit(state => {
      if (change === 'channel') state.channels = state.channels.filter(item => item.id !== 'webchat-a');
      if (change === 'department') state.departments = state.departments.filter(item => item.id !== 'department-a');
      if (change === 'conversation-department') state.conversations.find(item => item.id === 'conversation-visible').departmentId = 'department-b';
    });
    const changed = f.snapshot({}, initial.revision);
    assert.equal(changed.unchanged, false); assert.notEqual(changed.revision, initial.revision); assert.deepEqual(changed.contacts, []);
  });
}

for (const change of ['permission', 'disabled', 'membership']) {
  test(`fresh ${change} revocation returns403 before unchanged for a previously valid revision`, t => {
    const f = fixture(t), initial = f.snapshot();
    if (change === 'permission') f.permissions([]);
    if (change === 'disabled') f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.operator.userId);
    if (change === 'membership') f.store.db.prepare('UPDATE auth_users SET tenant_ids=?,scope_rules=NULL WHERE id=?').run('[]', f.operator.userId);
    assert.throws(() => f.snapshot({}, initial.revision), denied(403));
  });
}

test('identical empty DTOs are bound to actor, company and workspace; hashes do not grant cross-scope access', t => {
  const f = fixture(t, { empty: true });
  const first = f.service.snapshot(f.admin, f.tenantId), peer = f.service.snapshot(f.peer, f.tenantId);
  const otherCompany = f.service.snapshot(f.admin, f.otherTenantId), foreign = f.service.snapshot(f.foreignAdmin, f.foreignTenantId);
  for (const snapshot of [first, peer, otherCompany, foreign]) { assert.deepEqual(snapshot.contacts, []); revision(snapshot.revision); }
  assert.equal(new Set([first, peer, otherCompany, foreign].map(item => item.revision)).size, 4);
  const wrongActor = f.service.snapshot(f.peer, f.tenantId, {}, first.revision);
  assert.equal(wrongActor.unchanged, false); assert.deepEqual(wrongActor.contacts, []); assert.equal(wrongActor.revision, peer.revision);
  assert.throws(() => f.service.snapshot(f.operator, f.otherTenantId, {}, first.revision), denied(403));
  assert.throws(() => f.service.snapshot(f.operator, f.foreignTenantId, {}, foreign.revision), denied(403));
  assert.throws(() => f.service.snapshot({ ...f.operator, resellerId: 'snapshot-other-workspace' }, f.foreignTenantId, {}, foreign.revision), denied(403));
});
