import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prepareSelectedGroupConversations } from '../src/group-conversations.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';

const status = code => error => error.status === code;
const state = conversations => ({ defaultDepartmentId: 'support', departments: [{ id: 'support', name: 'Suporte', active: true }], conversations: conversations || [], contacts: [{ id: 'preserved-contact', name: 'Contato anterior' }] });
const whatsapp = extra => ({ id: 'wa', transport: 'baileys', allowedGroups: ['123-456@g.us'], groupNames: { '123-456@g.us': 'Grupo selecionado' }, ...extra });
const telegram = config => ({ id: 'tg', transport: 'telegram-bot', telegramGroups: { mode: 'selected', version: 1, groupIds: ['-10012'], known: [{ id: '-10012', name: 'Supergrupo selecionado', aliases: ['-12'], joined: true }], ...config } });
const existing = extra => ({ id: 'preserved-conversation', channelId: 'wa', conversationKind: 'group', remoteJid: '123-456@g.us', contact: 'Título anterior', version: 8, owner: 'human', status: 'closed', assignedUserId: 'previous-human', assignedSupportGrantId: 'previous-grant', participants: [{ userId: 'participant' }], agentId: 'previous-agent', unread: 4,
  messages: [{ id: 'preserved-message', kind: 'customer', text: 'Histórico anterior', attachments: [{ id: 'preserved-attachment', status: 'ready' }] }, { id: 'preserved-note', kind: 'internal', text: 'Nota anterior' }], ...extra });

test('WhatsApp selecionado ganha conversa vazia, sem contato ou histórico importado, e repetições conservam ID', () => {
  const tenant = state(), channel = whatsapp({ allowedGroups: ['123-456@g.us', '123-456@g.us', '999@g.us', '111@s.whatsapp.net'], groupNames: { '123-456@g.us': 'Grupo\u0000 selecionado', '999@g.us': 'x'.repeat(100) } }), originalChannel = structuredClone(channel), originalContacts = structuredClone(tenant.contacts);
  assert.equal(prepareSelectedGroupConversations(tenant, channel), 2);
  assert.deepEqual(tenant.conversations.map(c => c.remoteJid).sort(), ['123-456@g.us', '999@g.us']);
  for (const conversation of tenant.conversations) {
    assert.match(conversation.id, /^[0-9a-f-]{36}$/); assert.equal(conversation.channelId, channel.id); assert.equal(conversation.conversationKind, 'group');
    assert.equal(conversation.owner, 'queue'); assert.equal(conversation.assignedUserId, null); assert.equal(conversation.agentId, null); assert.equal(conversation.version, 1);
    assert.equal(conversation.unread, 0); assert.equal(conversation.status, 'open'); assert.equal(conversation.departmentId, 'support'); assert.equal(conversation.department, 'Suporte'); assert.deepEqual(conversation.messages, []);
  }
  assert.equal(tenant.conversations.find(c => c.remoteJid === '123-456@g.us').contact, 'Grupo selecionado');
  assert.equal(tenant.conversations.find(c => c.remoteJid === '999@g.us').contact.length, 80);
  const once = structuredClone(tenant.conversations);
  assert.equal(prepareSelectedGroupConversations(tenant, channel), 0); assert.deepEqual(tenant.conversations, once);
  assert.deepEqual(channel, originalChannel); assert.deepEqual(tenant.contacts, originalContacts);
});

test('Telegram cria somente conhecidos selecionados; não ganha IDs desconhecidos, diretos, left ou conflitos', () => {
  const channel = telegram({ groupIds: ['-10012', '-13', '-14', '-15', '-16', '-404', '77'], known: [
    { id: '-10012', name: 'Permitido', aliases: ['-12'], joined: true }, { id: '-13', joined: false }, { id: '-14', joined: true }, { id: '-15', joined: true }, { id: '-16', joined: true }, { id: '-17', joined: true }, { id: '77', joined: true }
  ], migrationConflicts: [{ fromGroupId: '-14', toGroupId: '-15' }, { fromGroupId: '-16', toGroupId: '-10016' }] });
  const tenant = state(), originalChannel = structuredClone(channel);
  assert.equal(prepareSelectedGroupConversations(tenant, channel), 1);
  assert.equal(tenant.conversations[0].remoteChatId, '-10012'); assert.deepEqual(tenant.conversations[0].chatAliases, ['-12']);
  assert.deepEqual(tenant.conversations[0].messages, []); assert.equal(tenant.conversations[0].contact, 'Permitido');
  assert.deepEqual(channel, originalChannel); assert.equal(prepareSelectedGroupConversations(tenant, channel), 0);
});

test('histórico, autoria, atribuição, versão e conversa fechada existentes são preservados por seleção', () => {
  for (const transport of ['baileys', 'telegram-bot']) {
    const channel = transport === 'baileys' ? whatsapp() : telegram(), conversation = existing(transport === 'telegram-bot' ? { channelId: 'tg', remoteJid: undefined, remoteChatId: '-12', chatAliases: [] } : {}), tenant = state([conversation]);
    const before = structuredClone(tenant);
    assert.equal(prepareSelectedGroupConversations(tenant, channel), 0); assert.deepEqual(tenant, before);
  }
});

test('aliases antigos ou novos apontam ao histórico existente sem remapear/mesclar as conversas', () => {
  for (const peer of [{ remoteChatId: '-12' }, { remoteChatId: '-10012', chatAliases: ['-12'] }, { remoteChatId: '-999', chatAliases: ['-12'] }]) {
    const conversation = existing({ channelId: 'tg', remoteJid: undefined, ...peer }), tenant = state([conversation]), before = structuredClone(tenant);
    assert.equal(prepareSelectedGroupConversations(tenant, telegram()), 0); assert.deepEqual(tenant, before);
  }
  const old = existing({ id: 'old-group', channelId: 'tg', remoteJid: undefined, remoteChatId: '-12' }), migrated = existing({ id: 'new-group', channelId: 'tg', remoteJid: undefined, remoteChatId: '-10012', messages: [{ id: 'other-message', kind: 'customer', text: 'Outro histórico' }] });
  const tenant = state([old, migrated]), before = structuredClone(tenant), channel = telegram({ migrationConflicts: [{ fromGroupId: '-12', toGroupId: '-10012' }] });
  assert.equal(prepareSelectedGroupConversations(tenant, channel), 0); assert.deepEqual(tenant, before);
});

test('mesmo ID de grupo em outra conexão não impede a conversa da conexão selecionada', () => {
  for (const channel of [whatsapp(), telegram()]) {
    const peer = channel.transport === 'baileys' ? { remoteJid: '123-456@g.us' } : { remoteJid: undefined, remoteChatId: '-10012' };
    const previous = existing({ ...peer, channelId: 'other-channel' }), tenant = state([previous]), before = structuredClone(previous);
    assert.equal(prepareSelectedGroupConversations(tenant, channel), 1); assert.deepEqual(tenant.conversations.find(c => c.id === previous.id), before);
    assert.equal(tenant.conversations.find(c => c.id !== previous.id).channelId, channel.id);
  }
});

test('desseleção preserva conversa/histórico e reativação reaproveita a mesma identidade nos dois transportes', () => {
  for (const channel of [whatsapp(), telegram()]) {
    const tenant = state(); assert.equal(prepareSelectedGroupConversations(tenant, channel), 1);
    tenant.conversations[0].messages.push({ id: 'after-selection', kind: 'customer', text: 'Mensagem posterior' }); tenant.conversations[0].version++;
    const before = structuredClone(tenant), ids = channel.transport === 'baileys' ? channel.allowedGroups : channel.telegramGroups.groupIds;
    if (channel.transport === 'baileys') channel.allowedGroups = []; else channel.telegramGroups.groupIds = [];
    assert.equal(prepareSelectedGroupConversations(tenant, channel), 0); assert.deepEqual(tenant, before);
    if (channel.transport === 'baileys') channel.allowedGroups = ids; else channel.telegramGroups.groupIds = ids;
    assert.equal(prepareSelectedGroupConversations(tenant, channel), 0); assert.deepEqual(tenant, before);
  }
});

test('modo all explícito Telegram usa conhecidos disponíveis, sem fabricar catálogo ou seleção', () => {
  const tenant = state(), channel = telegram({ mode: 'all', groupIds: [], known: [{ id: '-10', joined: true }, { id: '-11', joined: false }, { id: '-12' }] }), original = structuredClone(channel);
  assert.equal(prepareSelectedGroupConversations(tenant, channel), 2); assert.deepEqual(tenant.conversations.map(c => c.remoteChatId).sort(), ['-10', '-12']); assert.deepEqual(channel, original);
  const empty = state(); assert.equal(prepareSelectedGroupConversations(empty, telegram({ mode: 'all', known: [] })), 0); assert.deepEqual(empty.conversations, []);
});

test('departamento padrão desativado não é atribuído e transportes alheios não criam conversa', () => {
  const tenant = state(); tenant.departments[0].active = false;
  assert.equal(prepareSelectedGroupConversations(tenant, whatsapp()), 1); assert.equal(tenant.conversations[0].departmentId, null);
  const before = structuredClone(tenant);
  assert.equal(prepareSelectedGroupConversations(tenant, { id: 'external', transport: 'email', allowedGroups: ['123-456@g.us'] }), 0); assert.deepEqual(tenant, before);
});

for (const transport of ['whatsapp', 'telegram']) {
  test(`${transport}: salvar seleção real materializa grupo sem entrada/envio e CAS/IDs desconhecidos não alteram dados`, async t => {
    const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
    const admin = auth.actor(auth.insertUser({ username: 'selected-group-admin', name: 'Admin sintético' }, Buffer.alloc(16, 4), Buffer.alloc(64, 4), 'reseller', [], 'mep-demo'));
    const tenant = store.createTenant(admin, { name: 'Seleção RAM', segment: 'QA' }), channelId = transport === 'whatsapp' ? 'wa' : 'tg';
    const groupId = transport === 'whatsapp' ? '123-456@g.us' : '-10012';
    store.mutate(admin, tenant.id, 'Fixture seleção vazia', current => {
      current.conversations = []; current.contacts = []; current.defaultDepartmentId = 'support'; current.departments = [{ id: 'support', name: 'Suporte', active: true }];
      current.channels = [transport === 'whatsapp' ? { ...whatsapp({ allowedGroups: [] }), kind: 'whatsapp_qr', expectedNumber: '5511999900000', state: 'connected' } : { ...telegram({ version: 0, groupIds: [] }), kind: 'telegram', state: 'connected' }];
    });
    const operations = new Operations(store, auth); let deliveries = 0, incoming = 0, media = 0, gateway;
    if (transport === 'whatsapp') {
      gateway = new WhatsAppGateway(store, { authKey: randomBytes(32), socketFactory: () => assert.fail('Não iniciar socket real.'), fetchImpl: () => assert.fail('Sem rede externa.') });
      gateway.entries.set(channelId, { tenantId: tenant.id, channelId, expectedNumber: '5511999900000', actor: gateway.actor(admin.resellerId), generation: 1, matched: true, state: 'connected', groupCache: new Map(), socket: { groupFetchAllParticipating: async () => ({ [groupId]: { id: groupId, subject: 'Selecionado por administrador', participants: [] } }), sendMessage() { deliveries++; assert.fail('Selecionar grupo não envia.'); }, end() {} } });
    } else {
      gateway = new TelegramGateway(store, { authKey: randomBytes(32), polling: false, fetchImpl: () => assert.fail('Sem rede externa.') });
      gateway.entries.set(channelId, { tenantId: tenant.id, channelId, state: 'connected', stopped: false, abort: new AbortController() });
      gateway.call = () => { deliveries++; assert.fail('Selecionar Telegram conhecido não consulta nem envia.'); };
    }
    gateway.operations = operations; gateway.onIncoming = () => { incoming++; }; gateway.media = { placeholder() { media++; assert.fail('Seleção não cria mídia.'); } };
    t.after(async () => { await gateway.close(); store.close(); });
    const current = () => store.tenant(admin, tenant.id), body = version => ({ version, groupIds: [groupId], ...(transport === 'telegram' ? { mode: 'selected' } : {}) });
    await gateway.setGroups(admin, tenant.id, channelId, body(0));
    assert.equal(current().conversations.length, 1); const empty = structuredClone(current().conversations[0]);
    assert.deepEqual(empty.messages, []); assert.equal(empty.owner, 'queue'); assert.equal(empty.version, 1); assert.equal(empty.departmentId, 'support'); assert.deepEqual(current().contacts, []);
    await gateway.setGroups(admin, tenant.id, channelId, body(1)); assert.deepEqual(current().conversations, [empty]);
    const before = structuredClone(current());
    await assert.rejects(async () => gateway.setGroups(admin, tenant.id, channelId, body(1)), status(409));
    await assert.rejects(async () => gateway.setGroups(admin, tenant.id, channelId, { ...body(2), groupIds: [transport === 'whatsapp' ? '999@g.us' : '-404'] }), status(400));
    await assert.rejects(async () => gateway.setGroups({ ...admin, kind: 'service' }, tenant.id, channelId, body(2)), status(403));
    assert.deepEqual(current(), before); assert.equal(deliveries, 0); assert.equal(incoming, 0); assert.equal(media, 0);
    await gateway.setGroups(admin, tenant.id, channelId, { ...body(2), groupIds: [] }); assert.deepEqual(current().conversations, [empty]);
    await gateway.setGroups(admin, tenant.id, channelId, body(3)); assert.deepEqual(current().conversations, [empty]);
  });
}
