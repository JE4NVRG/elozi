import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ContactService } from '../src/contacts.js';

const denied = error => error.status === 403;
const identity = (channelId, externalId) => ({ channelId, kind: 'person', externalId });
const contact = (id, identities, extra = {}) => ({ id, name: 'Pessoa sintética ' + id, type: 'person', phone: '', email: '', notes: '', tags: [],
  identities, version: 1, createdAt: '2026-10-02T12:00:00Z', updatedAt: '2026-10-02T12:00:00Z', ...extra });

function fixture(t, { count = 7501, scoped = false } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const originalHeader = store.readonlyTenantHeader.bind(store);
  let tenantReads = 0, actorReads = 0;
  store.tenant = () => { throw Error('A agenda não deve abrir todos os históricos da empresa'); };
  store.readonlyTenantHeader = (actor, id) => { tenantReads++; return originalHeader(actor, id); };
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.readonlyTenantHeader(actor, id) });
  const originalActor = auth.currentActor.bind(auth);
  auth.currentActor = actor => { actorReads++; return originalActor(actor); };
  const tenantId = 'crm-scale-fixture';
  const contacts = Array.from({ length: count }, (_, index) => contact('person-' + index, [identity(index % 2 ? 'wa-hidden' : 'wa-visible', `55119${String(10000000 + index)}@s.whatsapp.net`)]));
  const conversations = scoped ? contacts.map((item, index) => ({ id: 'conversation-' + index, contactId: item.id, channelId: item.identities[0].channelId,
    conversationKind: 'direct', remoteJid: item.identities[0].externalId, departmentId: index % 4 ? 'private' : 'support', messages: [] })) : [];
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenantId, 'mep-demo', JSON.stringify({ name: 'CRM sintético de escala', contacts, conversations,
    channels: [{ id: 'wa-visible', kind: 'whatsapp_qr' }, { id: 'wa-hidden', kind: 'whatsapp_qr' }],
    departments: [{ id: 'support', name: 'Suporte' }, { id: 'private', name: 'Privado' }] }));
  let sequence = 0;
  const addUser = ({ role = 'operator', tenantIds = [tenantId], resellerId = 'mep-demo', rules = null, permissions = ['contacts.read', 'contacts.write'] } = {}) => {
    const row = auth.insertUser({ name: 'Pessoa autorizada sintética', username: 'scale.user.' + ++sequence }, Buffer.alloc(16, sequence), Buffer.alloc(64, sequence), role, tenantIds, resellerId);
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(JSON.stringify(permissions), rules === null ? null : JSON.stringify(rules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const actor = addUser({ rules: scoped ? { [tenantId]: { channelIds: ['wa-visible'], departmentIds: ['support'] } } : null });
  const service = new ContactService(store, auth);
  const resetReads = () => { tenantReads = 0; actorReads = 0; };
  const readings = () => ({ tenant: tenantReads, actor: actorReads });
  const updateState = fn => { const row = store.db.prepare('SELECT data FROM tenants WHERE id=?').get(tenantId), state = JSON.parse(row.data); fn(state); store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(state), tenantId); };
  return { store, auth, service, actor, tenantId, addUser, updateState, resetReads, readings };
}

test('7501 contatos usam uma leitura atual de autoridade/tenant por lista sem Auth.can por contato', t => {
  const c = fixture(t); c.resetReads();
  c.auth.can = () => { throw Error('A lista não deve reler autoridade através de Auth.can por contato'); };
  const listed = c.service.list(c.actor, c.tenantId);
  assert.equal(listed.length, 7501); assert.deepEqual(c.readings(), { tenant: 1, actor: 1 });
  assert.equal(listed.every(item => item.identities.length === 1 && !Object.hasOwn(item.identities[0], 'externalId')), true);
  assert.deepEqual(listed.slice(0, 2).map(item => item.id), ['person-0', 'person-1']);
  assert.equal(JSON.stringify(listed).includes('@s.whatsapp.net'), false);
});

test('7501 contatos/conversas respeitam canal+departamento com autoridade e relação indexadas', t => {
  const c = fixture(t, { scoped: true }); c.resetReads();
  c.service.related = () => { throw Error('Relações da lista precisam de índice por operação'); };
  const result = c.service.list(c.actor, c.tenantId);
  const expected = Array.from({ length: 7501 }, (_, index) => index).filter(index => index % 4 === 0).map(index => 'person-' + index);
  assert.deepEqual(result.map(item => item.id), expected); assert.deepEqual(c.readings(), { tenant: 1, actor: 1 });
  assert.equal(result.every(item => item.identities.length === 1 && item.identities[0].channelId === 'wa-visible'), true);
  assert.deepEqual(c.service.list(c.actor, c.tenantId, { search: 'person-1' }).map(item => item.id), expected.filter(id => id.includes('person-1')));
});

test('DTO omite canais removidos e identidades/contatos fora de departamento; vínculo alheio não concede leitura', t => {
  const c = fixture(t, { count: 0, scoped: true });
  c.updateState(state => {
    state.contacts = [contact('allowed', [identity('wa-visible', '5511987654321@s.whatsapp.net'), identity('wa-hidden', '5511987654322@s.whatsapp.net'), identity('removed-channel', '5511987654323@s.whatsapp.net')]),
      contact('private', [identity('wa-visible', '5511987654324@s.whatsapp.net')]), contact('stolen-link', [identity('wa-visible', '5511987654325@s.whatsapp.net')])];
    state.conversations = [{ id: 'allowed-conversation', contactId: 'allowed', channelId: 'wa-visible', remoteJid: '5511987654321@s.whatsapp.net', conversationKind: 'direct', departmentId: 'support' },
      { id: 'private-conversation', contactId: 'private', channelId: 'wa-visible', remoteJid: '5511987654324@s.whatsapp.net', conversationKind: 'direct', departmentId: 'private' },
      { id: 'wrong-link', contactId: 'other-contact', channelId: 'wa-visible', remoteJid: '5511987654325@s.whatsapp.net', conversationKind: 'direct', departmentId: 'support' }];
  });
  const result = c.service.list(c.actor, c.tenantId); assert.deepEqual(result.map(item => item.id), ['allowed']);
  assert.deepEqual(result[0].identities.map(item => item.channelId), ['wa-visible']);
  assert.deepEqual(c.service.list(c.actor, c.tenantId, { search: 'private' }), []);
  const manager = c.addUser({ role: 'reseller', tenantIds: [] });
  assert.equal(c.service.list(manager, c.tenantId).find(item => item.id === 'allowed').identities.some(item => item.channelId === 'removed-channel'), false);
  c.updateState(state => { state.conversations.push({ id: 'unlinked-match', channelId: 'wa-visible', remoteJid: '5511987654325@s.whatsapp.net', conversationKind: 'direct', departmentId: 'support' }); });
  assert.deepEqual(c.service.list(c.actor, c.tenantId).map(item => item.id), ['allowed', 'stolen-link']);
});

test('nenhum checker sobrevive entre listas: escopo, permissão, vínculo e disable atuais vencem ator antigo', t => {
  const c = fixture(t, { count: 3 }); assert.equal(c.service.list(c.actor, c.tenantId).length, 3);
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenantId]: { channelIds: ['wa-visible'] } }), c.actor.userId);
  assert.deepEqual(c.service.list(c.actor, c.tenantId).map(item => item.id), ['person-0', 'person-2']);
  c.updateState(state => { state.channels = state.channels.filter(channel => channel.id !== 'wa-visible'); });
  assert.deepEqual(c.service.list(c.actor, c.tenantId), []);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.actor.userId);
  assert.throws(() => c.service.list(c.actor, c.tenantId), denied);
  c.store.db.prepare('UPDATE auth_users SET permissions=?,tenant_ids=?,scope_rules=NULL WHERE id=?').run(JSON.stringify(['contacts.read']), JSON.stringify([]), c.actor.userId);
  assert.throws(() => c.service.list(c.actor, c.tenantId), denied);
  c.store.db.prepare('UPDATE auth_users SET tenant_ids=?,disabled_at=? WHERE id=?').run(JSON.stringify([c.tenantId]), Date.now(), c.actor.userId);
  assert.throws(() => c.service.list(c.actor, c.tenantId), denied);
});

test('checker preserva validContext/aggregate e grants atuais de workspace sem ampliação implícita', t => {
  const c = fixture(t, { count: 2, scoped: true });
  const checker = c.auth.createTenantPermissionChecker(c.actor, 'contacts.read', c.tenantId);
  for (const context of [{ tenantId: c.tenantId, aggregate: true }, { tenantId: c.tenantId }, { tenantId: c.tenantId, channelId: 'wa-visible', departmentId: 'support' },
    { tenantId: c.tenantId, channelId: 'wa-visible', departmentId: 'private' }, { tenantId: c.tenantId, channelId: 'removed', departmentId: 'support' },
    { tenantId: c.tenantId, channelId: 'wa-visible', departmentId: 'missing' }]) assert.equal(checker.can(context), c.auth.can(c.actor, 'contacts.read', context));
  assert.equal(checker.can({ tenantId: 'foreign' }), false); assert.equal(checker.can({}), false);
  const owner = c.addUser({ role: 'reseller', tenantIds: [] });
  c.store.db.prepare('UPDATE auth_users SET platform_admin=1 WHERE id=?').run(owner.userId);
  c.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('other-workspace', JSON.stringify({ name: 'Outro espaço sintético' }));
  c.store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('other-tenant', 'other-workspace', JSON.stringify({ name: 'Empresa separada', channels: [], conversations: [], contacts: [] }));
  c.store.db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(owner.userId, 'other-workspace', Date.now());
  const switched = { ...owner, resellerId: 'other-workspace' };
  assert.deepEqual(c.service.list(switched, 'other-tenant'), []);
  c.store.db.prepare('DELETE FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').run(owner.userId, 'other-workspace');
  assert.throws(() => c.service.list(switched, 'other-tenant'), denied);
});
