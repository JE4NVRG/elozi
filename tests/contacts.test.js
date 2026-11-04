import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { ContactService, normalizeContactPhone, publicContact, syncConversationContact, syncIncomingConversationContact } from '../src/contacts.js';

const status = code => error => error.status === code;
const permissions = ['contacts.read', 'contacts.write', 'inbox.read', 'inbox.reply', 'inbox.transfer'];
const admin = { userId: 'fixture-admin', name: 'Gestor sintético', role: 'reseller', resellerId: 'mep-demo', permissions };
const channelA = { id: 'wa-a', name: 'Canal A', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' };
const channelB = { id: 'wa-b', name: 'Canal B', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' };
const channelT = { id: 'tg', name: 'Telegram', kind: 'telegram', transport: 'telegram-bot', state: 'connected' };

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const tenant = store.createTenant(admin, { name: 'Empresa sintética', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture: canais', state => { state.channels = [channelA, channelB, channelT].map(item => ({ ...item })); });
  const calls = [];
  const auth = { can(actor, permission, scope) {
    calls.push({ permission, scope });
    if (!actor?.userId || !actor.permissions?.includes(permission)) return false;
    if (actor.denied?.includes(permission)) return false;
    if (actor.allowedChannels) {
      if (!actor.allowedChannels.length) return false;
      if (!scope.aggregate && !actor.allowedChannels.includes(scope.channelId)) return false;
    }
    if (actor.allowedDepartments) {
      if (!actor.allowedDepartments.length) return false;
      if (!scope.aggregate && !actor.allowedDepartments.includes(scope.departmentId)) return false;
    }
    return true;
  } };
  return { store, service: new ContactService(store, auth), auth, calls, tenantId: tenant.id };
}
function conversation(id, channelId = channelA.id, extra = {}) {
  return { id, contact: 'Pessoa sintética', channelId, remoteJid: '5511987654321@s.whatsapp.net', conversationKind: 'direct', version: 1, status: 'open', departmentId: 'support', messages: [{ kind: 'customer', text: 'Conteúdo sintético que não deve sair no histórico CRM' }], updatedAt: '2026-10-01T12:00:00.000Z', ...extra };
}
function putConversation(store, tenantId, item, { sync = false } = {}) {
  return store.mutate(admin, tenantId, 'Fixture: conversa', state => {
    state.conversations.push(item);
    return sync ? syncConversationContact(state, item, state.channels.find(channel => channel.id === item.channelId)) : item;
  });
}
const raw = (store, tenantId, id) => store.tenant(admin, tenantId).contacts.find(item => item.id === id);

test('CRUD conserva telefone amigável, normaliza busca/abertura e projeta pelo Store sem schema SQL', t => {
  const { store, service, tenantId } = fixture(t), queued = [];
  store.queuePostgres = id => queued.push(id);
  const created = service.create(admin, tenantId, { name: ' Pessoa de teste ', type: 'company', email: ' CONTATO@EXAMPLE.TEST ', phone: ' (11) 98765-4321 ', notes: ' Nota\nsegunda linha ', tags: ['Cliente', 'Cliente', 'Suporte'] });
  assert.equal(created.name, 'Pessoa de teste');
  assert.equal(created.email, 'contato@example.test');
  assert.equal(created.phone, '(11) 98765-4321');
  assert.deepEqual(created.tags, ['Cliente', 'Suporte']);
  assert.equal(created.version, 1);
  assert.equal(service.list(admin, tenantId, { search: '5511987654321' }).length, 1);
  assert.equal(service.list(admin, tenantId, { search: 'CLIENTE' }).length, 1);
  assert.deepEqual(service.openInput(admin, tenantId, created.id, { channelId: channelA.id }), { name: created.name, number: '5511987654321', channelId: channelA.id });
  const updated = service.update(admin, tenantId, created.id, { version: 1, name: 'Nome atualizado', phone: '+55 11 98765-4321', notes: '', email: '', tags: [] });
  assert.equal(updated.version, 2);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.phone, '+55 11 98765-4321');
  assert.deepEqual(queued, [tenantId, tenantId]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='contacts'").get().n, 0);
});

test('telefone BR aceita DDD com ou sem país e rejeita extensão, JID, scripts e números inválidos', () => {
  for (const phone of ['11 98765-4321', '+55 (11) 98765-4321', '5511987654321']) assert.equal(normalizeContactPhone(phone), '5511987654321');
  assert.equal(normalizeContactPhone(''), '');
  assert.equal(normalizeContactPhone('11 3456-7890'), '551134567890');
  for (const phone of ['123', '1'.repeat(31), '5511987654321@s.whatsapp.net', '11 98765-4321 ramal 5', '+1 212 123 1234', '11\n98765-4321', '++55 11 98765-4321', null, 5511987654321]) assert.throws(() => normalizeContactPhone(phone), status(400));
});

test('whitelist impede forjar identidade, privilégios, CAS e dados arbitrários sem gravação parcial', t => {
  const { store, service, tenantId } = fixture(t);
  const before = JSON.stringify(store.tenant(admin, tenantId));
  for (const key of ['identities', 'externalId', 'remoteJid', 'remoteAliases', 'contactId', 'id', 'tenantId', 'resellerId', 'role', 'version', 'archivedAt', 'createdAt', 'token', '__proto__']) {
    assert.throws(() => service.create(admin, tenantId, JSON.parse(JSON.stringify({ name: 'Pessoa', [key]: 'forjado' }))), status(400));
  }
  for (const input of [null, [], new Date(), Object.assign(Object.create({ role: 'reseller' }), { name: 'Pessoa' }), { name: 'Pessoa', [Symbol('secret')]: 'forjado' }]) assert.throws(() => service.create(admin, tenantId, input), status(400));
  for (const input of [{ name: '' }, { name: 'a'.repeat(81) }, { name: 'x\ny' }, { name: 'Pessoa', notes: 'n'.repeat(2001) }, { name: 'Pessoa', tags: ['x'.repeat(41)] }, { name: 'Pessoa', tags: Array(21).fill('tag') }, { name: 'Pessoa', email: 'bad' }, { name: 'Pessoa', email: '<script>@example.test' }, { name: 'Pessoa', type: 'other' }, { name: 'Grupo', type: 'group', phone: '11 98765-4321' }]) assert.throws(() => service.create(admin, tenantId, input), status(400));
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
});

test('duplicata ativa de telefone é atômica; e-mail não faz merge e empresa distinta permanece isolada', async t => {
  const { store, service, tenantId } = fixture(t);
  const results = await Promise.allSettled(['(11) 98765-4321', '+55 11 98765-4321'].map(phone => Promise.resolve().then(() => service.create(admin, tenantId, { name: 'Pessoa', phone, email: 'shared@example.test' }))));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal(service.list(admin, tenantId).length, 1);
  assert.notEqual(service.create(admin, tenantId, { name: 'Outra pessoa', email: 'shared@example.test' }).id, results.find(item => item.status === 'fulfilled').value.id);
  const other = store.createTenant(admin, { name: 'Outra empresa', segment: 'Teste' });
  assert.equal(service.create(admin, other.id, { name: 'Outra empresa', phone: '11 98765-4321' }).version, 1);
});

test('edições concorrentes com a mesma revisão aceitam uma e preservam o vencedor', async t => {
  const { service, tenantId } = fixture(t);
  const contact = service.create(admin, tenantId, { name: 'Original' });
  const results = await Promise.allSettled(['A', 'B'].map(name => Promise.resolve().then(() => service.update(admin, tenantId, contact.id, { name, version: 1 }))));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal(service.get(admin, tenantId, contact.id).name, 'A');
  assert.equal(service.get(admin, tenantId, contact.id).version, 2);
  for (const input of [{ name: 'Indevido' }, { version: 0, name: 'Indevido' }, { version: 2, identities: [] }]) assert.throws(() => service.update(admin, tenantId, contact.id, input), status(400));
});

test('autorização e isolamento recusam empresa alheia, ator inválido e permissões ausentes', t => {
  const { store, service, tenantId } = fixture(t);
  const contact = service.create(admin, tenantId, { name: 'Pessoa' });
  const operator = { ...admin, role: 'operator', tenantIds: ['playtech-demo'] };
  assert.throws(() => service.list(operator, tenantId), status(403));
  assert.throws(() => service.update(operator, tenantId, contact.id, { name: 'Alterado', version: 1 }), status(403));
  const foreign = { ...admin, resellerId: 'unknown-reseller' };
  assert.throws(() => service.get(foreign, tenantId, contact.id), status(404));
  assert.throws(() => service.list({ ...admin, userId: undefined }, tenantId), status(403));
  assert.throws(() => service.create({ ...admin, denied: ['contacts.write'] }, tenantId, { name: 'Proibido' }), status(403));
  assert.throws(() => service.history({ ...admin, denied: ['contacts.read'] }, tenantId, contact.id), status(403));
  assert.throws(() => service.list(admin, tenantId, { aggregate: true }), status(400));
  assert.throws(() => service.list(admin, tenantId, { includeArchived: 'yes' }), status(400));
  assert.equal(service.get(admin, tenantId, contact.id).name, 'Pessoa');
  assert.equal(store.tenant(admin, tenantId).contacts.length, 1);
});

test('arquivo é reversível, preserva identidade e impede duplicata ao reativar', t => {
  const { store, service, tenantId } = fixture(t);
  const automatic = putConversation(store, tenantId, conversation('original'), { sync: true });
  const archived = service.archive(admin, tenantId, automatic.id, { version: 1 });
  assert.equal(archived.version, 2);
  assert.ok(archived.archivedAt);
  assert.equal(service.list(admin, tenantId).length, 0);
  assert.equal(service.list(admin, tenantId, { includeArchived: true }).length, 1);
  assert.throws(() => service.update(admin, tenantId, automatic.id, { version: 2, notes: 'indevindo' }), status(409));
  assert.equal(service.archive(admin, tenantId, automatic.id, { version: 2 }).version, 2);
  const duplicate = service.create(admin, tenantId, { name: 'Novo cadastro explícito', phone: '11 98765-4321' });
  assert.throws(() => service.reactivate(admin, tenantId, automatic.id, { version: 2 }), status(409));
  service.archive(admin, tenantId, duplicate.id, { version: 1 });
  const restored = service.reactivate(admin, tenantId, automatic.id, { version: 2 });
  assert.equal(restored.version, 3);
  assert.equal(restored.archivedAt, undefined);
  assert.equal(raw(store, tenantId, automatic.id).identities.length, 1);
});

test('sync é idempotente, distingue grupos/pessoas e não infere telefone de grupo ou LID', t => {
  const { store, service, tenantId } = fixture(t);
  const direct = putConversation(store, tenantId, conversation('direct'), { sync: true });
  const group = putConversation(store, tenantId, conversation('group', channelA.id, { remoteJid: '5511987654321@g.us', conversationKind: 'group' }), { sync: true });
  const lid = putConversation(store, tenantId, conversation('lid', channelA.id, { remoteJid: '99887766@lid', remoteAliases: ['5511987654321@s.whatsapp.net'] }), { sync: true });
  assert.notEqual(direct.id, group.id); assert.notEqual(direct.id, lid.id);
  assert.equal(group.type, 'group'); assert.equal(group.phone, ''); assert.equal(lid.phone, '');
  const state = store.tenant(admin, tenantId), before = JSON.stringify(state);
  const same = syncConversationContact(state, state.conversations.find(item => item.id === 'direct'), state.channels[0]);
  assert.equal(same.id, direct.id);
  assert.equal(JSON.stringify(state), before);
  const safe = service.get(admin, tenantId, direct.id);
  assert.deepEqual(safe.identities, [{ channelId: channelA.id, kind: 'person', label: 'WhatsApp · final 4321' }]);
  assert.equal(JSON.stringify(safe.identities).includes('@'), false);
  assert.equal(JSON.stringify(publicContact({ ...direct, token: 'hidden', remoteJid: 'secret' })).includes('hidden'), false);
});

test('sync mantém canais separados mesmo com telefone igual; nomes iguais não fazem merge', t => {
  const { store, service, tenantId } = fixture(t);
  const first = putConversation(store, tenantId, conversation('a', channelA.id), { sync: true });
  const second = putConversation(store, tenantId, conversation('b', channelB.id), { sync: true });
  assert.notEqual(first.id, second.id);
  assert.equal(first.phone, second.phone);
  assert.equal(service.list(admin, tenantId).length, 2);
  assert.throws(() => service.create(admin, tenantId, { name: 'Terceiro', phone: first.phone }), status(409));
  assert.equal(service.update(admin, tenantId, first.id, { version: 1, notes: 'Nota permitida' }).version, 2);
});

test('tópicos Telegram compartilham o contato do grupo e arquivo não é desfeito pelo sync', t => {
  const { store, service, tenantId } = fixture(t);
  const group = putConversation(store, tenantId, conversation('tg-topic-a', channelT.id, { remoteJid: undefined, remoteChatId: '-100123', conversationKind: 'group', threadId: 1 }), { sync: true });
  const second = putConversation(store, tenantId, conversation('tg-topic-b', channelT.id, { remoteJid: undefined, remoteChatId: '-100123', conversationKind: 'group', threadId: 2 }), { sync: true });
  assert.equal(group.id, second.id);
  service.archive(admin, tenantId, group.id, { version: 1 });
  const after = putConversation(store, tenantId, conversation('tg-topic-c', channelT.id, { remoteJid: undefined, remoteChatId: '-100123', conversationKind: 'group', threadId: 3 }), { sync: true });
  assert.equal(after.id, group.id); assert.ok(after.archivedAt); assert.equal(after.version, 2);
  assert.equal(service.history(admin, tenantId, group.id).length, 3);
  assert.equal(JSON.stringify(service.history(admin, tenantId, group.id)).includes('Conteúdo sintético'), false);
});

test('associação explícita usa CAS da conversa, conserva tipo e recusa identidade ocupada', t => {
  const { store, service, tenantId } = fixture(t);
  const contact = service.create(admin, tenantId, { name: 'Cadastro CRM', phone: '11 98765-4321' });
  putConversation(store, tenantId, conversation('legacy'));
  const linked = service.associateConversation(admin, tenantId, 'legacy', { contactId: contact.id, version: 1 });
  assert.equal(linked.version, 2); assert.equal(linked.contact.version, 2);
  assert.equal(store.tenant(admin, tenantId).conversations.find(item => item.id === 'legacy').contactId, contact.id);
  assert.throws(() => service.associateConversation(admin, tenantId, 'legacy', { contactId: contact.id, version: 1 }), status(409));
  assert.equal(service.associateConversation(admin, tenantId, 'legacy', { contactId: contact.id, version: 2 }).version, 2);
  const other = service.create(admin, tenantId, { name: 'Outro contato' });
  assert.throws(() => service.associateConversation(admin, tenantId, 'legacy', { contactId: other.id, version: 2 }), status(409));
  putConversation(store, tenantId, conversation('group', channelA.id, { remoteJid: '120363001@g.us', conversationKind: 'group' }));
  assert.throws(() => service.associateConversation(admin, tenantId, 'group', { contactId: contact.id, version: 1 }), status(409));
  assert.throws(() => service.update(admin, tenantId, contact.id, { version: 2, type: 'group', phone: '' }), status(409));
  assert.throws(() => service.associateConversation({ ...admin, denied: ['inbox.transfer'] }, tenantId, 'legacy', { contactId: contact.id, version: 2 }), status(403));
});

test('contato validado na abertura pode receber identidade pelo sync; vínculo estrangeiro é recusado', t => {
  const { store, service, tenantId } = fixture(t);
  const contact = service.create(admin, tenantId, { name: 'Contato escolhido', phone: '11 98765-4321' });
  const linked = putConversation(store, tenantId, conversation('new', channelA.id, { contactId: contact.id }), { sync: true });
  assert.equal(linked.id, contact.id); assert.equal(linked.identities.length, 1);
  const secondTenant = store.createTenant(admin, { name: 'Outra empresa', segment: 'Teste' });
  const other = service.create(admin, secondTenant.id, { name: 'Outra pessoa' });
  assert.throws(() => putConversation(store, tenantId, conversation('foreign', channelA.id, { contactId: other.id }), { sync: true }), status(404));
  assert.equal(store.tenant(admin, tenantId).conversations.some(item => item.id === 'foreign'), false);
  const state = store.tenant(admin, tenantId);
  assert.throws(() => syncConversationContact(state, conversation('wrong-channel'), { ...channelB }), status(400));
  assert.throws(() => syncConversationContact(state, conversation('remote-group', channelA.id, { remoteJid: '120363001@g.us', conversationKind: 'direct' }), channelA), status(409));
});

test('history e identidades públicas respeitam canal/departamento; editar entidade compartilhada falha fechado', t => {
  const { store, service, tenantId } = fixture(t);
  const contact = service.create(admin, tenantId, { name: 'Multicanal' });
  for (const [id, channelId, departmentId, remoteJid] of [['visible', channelA.id, 'support', '5511987654321@s.whatsapp.net'], ['hidden-channel', channelB.id, 'support', '5511912345678@s.whatsapp.net'], ['hidden-department', channelA.id, 'sales', '5511999988888@s.whatsapp.net']]) {
    putConversation(store, tenantId, conversation(id, channelId, { contactId: contact.id, departmentId, remoteJid }), { sync: true });
  }
  const scoped = { ...admin, role: 'operator', tenantIds: [tenantId], allowedChannels: [channelA.id], allowedDepartments: ['support'] };
  const view = service.list(scoped, tenantId);
  assert.equal(view.length, 1);
  assert.deepEqual(view[0].identities, [{ channelId: channelA.id, kind: 'person', label: 'WhatsApp · final 4321' }]);
  assert.deepEqual(service.history(scoped, tenantId, contact.id).map(item => item.id), ['visible']);
  assert.throws(() => service.update(scoped, tenantId, contact.id, { version: 4, name: 'Indevido' }), status(403));
  assert.throws(() => service.archive(scoped, tenantId, contact.id, { version: 4 }), status(403));
  assert.throws(() => service.create(scoped, tenantId, { name: 'Sem escopo concreto' }), status(403));
  assert.deepEqual(service.history({ ...scoped, denied: ['inbox.read'] }, tenantId, contact.id), []);
});

test('leitura é pura: não faz backfill, não grava auditoria e não usa aggregate em mutações', t => {
  const { store, service, tenantId, calls } = fixture(t);
  putConversation(store, tenantId, conversation('legacy'));
  const before = JSON.stringify(store.tenant(admin, tenantId));
  const events = store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.deepEqual(service.list(admin, tenantId), []);
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, events);
  assert.ok(calls.some(call => call.permission === 'contacts.read' && call.scope.aggregate === true));
  calls.length = 0;
  const contact = service.create(admin, tenantId, { name: 'Pessoa' });
  service.update(admin, tenantId, contact.id, { version: 1, notes: 'Nota' });
  assert.equal(calls.some(call => call.scope.aggregate), false);
});

test('abertura valida permissões, estado/canal e grupo sem envio externo ou alteração de dados', t => {
  const { store, service, tenantId } = fixture(t);
  const person = service.create(admin, tenantId, { name: 'Pessoa', phone: '11 98765-4321' });
  const noPhone = service.create(admin, tenantId, { name: 'Sem telefone' });
  const group = service.create(admin, tenantId, { name: 'Grupo', type: 'group' });
  const before = JSON.stringify(store.tenant(admin, tenantId));
  assert.throws(() => service.openInput(admin, tenantId, group.id, { channelId: channelA.id }), status(400));
  assert.throws(() => service.openInput(admin, tenantId, noPhone.id, { channelId: channelA.id }), status(400));
  assert.throws(() => service.openInput(admin, tenantId, person.id, { channelId: channelT.id }), status(400));
  assert.throws(() => service.openInput(admin, tenantId, person.id, { channelId: 'foreign-channel' }), status(404));
  assert.throws(() => service.openInput(admin, tenantId, person.id, { channelId: channelA.id, externalId: 'forjado' }), status(400));
  assert.throws(() => service.openInput({ ...admin, denied: ['inbox.reply'] }, tenantId, person.id, { channelId: channelA.id }), status(403));
  service.openInput(admin, tenantId, person.id, { channelId: channelA.id });
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
  store.mutate(admin, tenantId, 'Fixture: desconexão', state => { state.channels[0].state = 'disconnected'; });
  assert.throws(() => service.openInput(admin, tenantId, person.id, { channelId: channelA.id }), status(409));
});

test('abertura usa departamento padrão ativo e não exige unassigned de operador autorizado', t => {
  const { store, service, tenantId, calls } = fixture(t);
  store.mutate(admin, tenantId, 'Fixture: departamento padrão', state => {
    state.departments = [{ id: 'support', name: 'Suporte', active: true }];
    state.defaultDepartmentId = 'support';
  });
  const contact = putConversation(store, tenantId, conversation('with-department'), { sync: true });
  const scoped = { ...admin, role: 'operator', tenantIds: [tenantId], allowedChannels: [channelA.id], allowedDepartments: ['support'] };
  const before = JSON.stringify(store.tenant(admin, tenantId));
  assert.equal(service.openInput(scoped, tenantId, contact.id, { channelId: channelA.id }).number, '5511987654321');
  assert.equal(calls.filter(call => call.permission === 'inbox.reply').at(-1).scope.departmentId, 'support');
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
  store.mutate(admin, tenantId, 'Fixture: desativar departamento', state => { state.departments[0].active = false; });
  assert.throws(() => service.openInput(scoped, tenantId, contact.id, { channelId: channelA.id }), status(403));
  assert.equal(calls.filter(call => call.permission === 'inbox.reply').at(-1).scope.departmentId, 'unassigned');
  store.mutate(admin, tenantId, 'Fixture: remover default', state => { delete state.defaultDepartmentId; });
  service.openInput(admin, tenantId, contact.id, { channelId: channelA.id });
  assert.equal(calls.filter(call => call.permission === 'inbox.reply').at(-1).scope.departmentId, 'unassigned');
});

test('histórico e vínculos legados resolvem departamento por nome dentro da empresa sem escrita', t => {
  const { store, service, tenantId, calls } = fixture(t);
  store.mutate(admin, tenantId, 'Fixture: departamentos legados', state => {
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Comercial', active: true }];
  });
  const visible = putConversation(store, tenantId, conversation('legacy-support', channelA.id, { departmentId: undefined, department: 'Suporte' }), { sync: true });
  putConversation(store, tenantId, conversation('legacy-sales', channelA.id, { departmentId: undefined, department: 'Comercial', remoteJid: '5511999988888@s.whatsapp.net' }), { sync: true });
  const scoped = { ...admin, role: 'operator', tenantIds: [tenantId], allowedChannels: [channelA.id], allowedDepartments: ['support'] };
  const before = JSON.stringify(store.tenant(admin, tenantId)), auditCount = store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.deepEqual(service.list(scoped, tenantId).map(item => item.id), [visible.id]);
  assert.deepEqual(service.history(scoped, tenantId, visible.id).map(item => item.id), ['legacy-support']);
  assert.equal(calls.filter(call => call.permission === 'inbox.read').at(-1).scope.departmentId, 'support');
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditCount);
  assert.equal(store.tenant(admin, tenantId).conversations.find(item => item.id === 'legacy-support').departmentId, undefined);
  const linked = service.associateConversation(scoped, tenantId, 'legacy-support', { contactId: visible.id, version: 1 });
  assert.equal(linked.contact.id, visible.id);
  assert.equal(calls.filter(call => call.permission === 'inbox.transfer').at(-1).scope.departmentId, 'support');
});

test('vínculos incoming não telefônicos ficam visíveis no CRM/histórico somente no canal e departamento autorizados', t => {
  const { store, service, tenantId } = fixture(t);
  const web = { id: 'web-incoming', kind: 'webchat', transport: 'elozi-webchat' }, mail = { id: 'mail-incoming', kind: 'email', transport: 'mepmail-channel' };
  store.mutate(admin, tenantId, 'Fixture: canais incoming CRM', state => { state.channels.push(web, mail); });
  const receive = (id, channelId, departmentId, extra = {}) => store.mutate(admin, tenantId, 'Fixture: entrada com CRM', state => {
    const item = conversation(id, channelId, { remoteJid: undefined, departmentId, ...extra });
    state.conversations.push(item);
    return syncIncomingConversationContact(state, item, state.channels.find(channel => channel.id === channelId));
  });
  const visible = receive('web-visible', web.id, 'support', { remoteSessionId: 'server-session-visible' });
  const hiddenDepartment = receive('web-hidden', web.id, 'sales', { remoteSessionId: 'server-session-hidden' });
  const hiddenChannel = receive('mail-hidden', mail.id, 'support', { remoteEmail: 'same@example.test' });
  const scoped = { ...admin, role: 'operator', tenantIds: [tenantId], allowedChannels: [web.id], allowedDepartments: ['support'] };
  const before = JSON.stringify(store.tenant(admin, tenantId)), auditBefore = store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const view = service.list(scoped, tenantId);
  assert.deepEqual(view.map(contact => contact.id), [visible.id]);
  assert.equal(view[0].phone, ''); assert.equal(view[0].email, '');
  assert.deepEqual(view[0].identities, [{ channelId: web.id, kind: 'person', label: 'Contato vinculado' }]);
  assert.deepEqual(service.history(scoped, tenantId, visible.id).map(item => item.id), ['web-visible']);
  assert.throws(() => service.get(scoped, tenantId, hiddenDepartment.id), status(403));
  assert.throws(() => service.get(scoped, tenantId, hiddenChannel.id), status(403));
  assert.equal(JSON.stringify(view).includes('conversation:'), false); assert.equal(JSON.stringify(view).includes('server-session-visible'), false);
  assert.equal(JSON.stringify(service.history(scoped, tenantId, visible.id)).includes('Conteúdo sintético'), false);
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditBefore);
});

test('associação manual limpa capacity na conversa original com CAS/ACL e um único bump por alteração', t => {
  const { store, service, tenantId } = fixture(t), web = { id: 'manual-web', kind: 'webchat', transport: 'elozi-webchat' };
  store.mutate(admin, tenantId, 'Fixture: webchat manual', state => { state.channels.push(web); });
  const contact = service.create(admin, tenantId, { name: 'Cadastro revisado', email: 'edited@example.test', notes: 'Nota preservada', tags: ['Revisado'] });
  putConversation(store, tenantId, conversation('manual-pending', web.id, { remoteJid: undefined, remoteSessionId: 'manual-server-session', contactSyncStatus: 'capacity' }));
  const before = JSON.stringify(store.tenant(admin, tenantId));
  assert.throws(() => service.associateConversation({ ...admin, denied: ['inbox.transfer'] }, tenantId, 'manual-pending', { contactId: contact.id, version: 1 }), status(403));
  assert.equal(JSON.stringify(store.tenant(admin, tenantId)), before);
  const linked = service.associateConversation(admin, tenantId, 'manual-pending', { contactId: contact.id, version: 1 });
  assert.equal(linked.version, 2); assert.equal(linked.contact.version, 2);
  const current = () => store.tenant(admin, tenantId).conversations.find(item => item.id === 'manual-pending');
  assert.equal(current().contactId, contact.id); assert.equal(current().contactSyncStatus, 'linked');
  assert.notEqual(current().updatedAt, '2026-10-01T12:00:00.000Z');
  assert.deepEqual({ name: linked.contact.name, email: linked.contact.email, notes: linked.contact.notes, tags: linked.contact.tags },
    { name: contact.name, email: contact.email, notes: contact.notes, tags: contact.tags });
  store.mutate(admin, tenantId, 'Fixture: pendência antiga do contato já vinculado', state => {
    const item = state.conversations.find(item => item.id === 'manual-pending'); item.contactSyncStatus = 'capacity'; item.updatedAt = '2026-10-01T12:00:00.000Z';
  });
  const scoped = { ...admin, role: 'operator', tenantIds: [tenantId], allowedChannels: [web.id], allowedDepartments: ['support'] };
  const repaired = service.associateConversation(scoped, tenantId, 'manual-pending', { contactId: contact.id, version: 2 });
  assert.equal(repaired.version, 3); assert.equal(repaired.contact.version, 2); assert.equal(current().contactSyncStatus, 'linked');
  const contactBeforeReplay = JSON.stringify(raw(store, tenantId, contact.id)), conversationBeforeReplay = JSON.stringify(current());
  const replay = service.associateConversation(scoped, tenantId, 'manual-pending', { contactId: contact.id, version: 3 });
  assert.equal(replay.version, 3); assert.equal(replay.contact.version, 2);
  assert.equal(JSON.stringify(raw(store, tenantId, contact.id)), contactBeforeReplay); assert.equal(JSON.stringify(current()), conversationBeforeReplay);
  assert.throws(() => service.associateConversation(scoped, tenantId, 'manual-pending', { contactId: contact.id, version: 2 }), status(409));
  assert.throws(() => service.associateConversation({ ...scoped, allowedDepartments: ['sales'] }, tenantId, 'manual-pending', { contactId: contact.id, version: 3 }), status(403));
  assert.equal(JSON.stringify(current()), conversationBeforeReplay);
});
