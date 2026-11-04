import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { proto, processSyncAction } from '@whiskeysockets/baileys';
import { createAttendanceService } from '../src/attendance.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'device-read-owner', name: 'Pessoa sintética' };
const PN = '5511988880000@s.whatsapp.net', LID = '12345@lid', OTHER = '5511977770000@s.whatsapp.net';
const OWN = '5511999990000', GROUP = '12000001@g.us', NOW = Date.parse('2026-10-09T18:00:00Z'), SEC = NOW / 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const store = new Store(':memory:'), sockets = [], hooks = []; let clock = NOW;
  const tenant = store.createTenant(admin, { name: 'Sincronização própria RAM', segment: 'Teste' });
  const addChannel = (tenantId, channelId, number = OWN) => store.mutate(admin, tenantId, 'Conexão sintética de leitura', state => {
    state.channels.push({ id: channelId, name: 'Canal sintético', kind: 'whatsapp_qr', transport: 'baileys', expectedNumber: number, state: 'disconnected', allowedGroups: [GROUP] });
  });
  addChannel(tenant.id, 'wa');
  const gateway = new WhatsAppGateway(store, { authKey: Buffer.alloc(32, 29), now: () => clock,
    socketFactory: config => {
      const socket = { config, ev: new EventEmitter(), user: { id: OWN + ':1@s.whatsapp.net' }, sent: [], nativeReads: [], chatChanges: [], ends: 0,
        async readMessages(keys) { this.nativeReads.push(structuredClone(keys)); }, async chatModify(change, jid) { this.chatChanges.push({ change: structuredClone(change), jid }); },
        end() { this.ends++; }, async logout() {}, async sendMessage(jid, content, options) { this.sent.push({ jid, content, options }); return { key: { id: options.messageId } }; } };
      sockets.push(socket); return socket;
    } });
  gateway.onIncoming = (_entry, cid, mid) => hooks.push({ cid, mid });
  const connect = async (tenantId = tenant.id, channelId = 'wa', number = OWN) => {
    await gateway.start(admin, tenantId, channelId); const socket = sockets.at(-1);
    socket.user.id = number + ':1@s.whatsapp.net'; socket.config.auth.creds.me = { id: socket.user.id };
    socket.ev.emit('creds.update', {}); socket.ev.emit('connection.update', { connection: 'open' }); await tick(); return socket;
  };
  const socket = await connect();
  const raw = (id, stamp = SEC - 20, { fromMe = false, jid = PN, participant, alt } = {}) => ({ key: { id, remoteJid: jid, fromMe,
    ...(participant ? { participant } : {}), ...(alt ? { remoteJidAlt: alt } : {}) }, messageTimestamp: stamp,
    pushName: 'Contato sintético', message: { conversation: fromMe ? 'Resposta própria sintética.' : 'Pergunta sintética.' } });
  const incoming = (id, stamp, options, entry = gateway.entries.get('wa')) => gateway.receive(entry, raw(id, stamp, options));
  const notify = async (...args) => { socket.ev.emit('messages.upsert', { type: 'notify', messages: [raw(...args)] }); await tick(); };
  const append = async (...args) => { socket.ev.emit('messages.upsert', { type: 'append', messages: [raw(...args)] }); await tick(); };
  const conversations = (tenantId = tenant.id) => store.tenant(admin, tenantId).conversations;
  const conversation = (jid = PN) => conversations().find(item => item.channelId === 'wa' && [item.remoteJid, ...(item.remoteAliases || [])].includes(jid));
  const receipt = (id, { jid = PN, fromMe = false, status = proto.WebMessageInfo.Status.READ, participant, target = socket, readTs = SEC } = {}) =>
    target.ev.emit('messages.update', [{ key: { id, remoteJid: jid, fromMe, ...(participant ? { participant } : {}) }, update: { status, messageTimestamp: readTs } }]);
  const readAction = (id, stamp, { jid = PN, keyJid = jid, participant, fromMe = false, readAt = clock, initial = false, target = socket, read = true } = {}) => {
    const syncAction = proto.SyncActionData.decode(proto.SyncActionData.encode(proto.SyncActionData.fromObject({ value: { timestamp: readAt,
      markChatAsReadAction: { read, messageRange: { lastMessageTimestamp: stamp, messages: [{ key: { id, remoteJid: keyJid, fromMe, ...(participant ? { participant } : {}) }, timestamp: stamp }] } } } })).finish());
    processSyncAction({ index: ['markChatAsRead', jid], syncAction }, target.ev, { id: OWN + '@s.whatsapp.net' }, initial ? { accountSettings: {} } : undefined, target.config.logger);
  };
  const markUnread = () => { const current = conversation(); return createAttendanceService(store, { authorize: () => true, now: () => clock }).readState(admin, tenant.id, current.id, { version: current.version, unread: true }); };
  const responsible = () => store.mutate(admin, tenant.id, 'Responsável sintético da leitura', tenant => { const current = tenant.conversations.find(item => item.channelId === 'wa'); current.owner = 'human'; current.assignedUserId = admin.userId; });
  const nativeRead = options => { const current = conversation(); return gateway.syncReadToDevice(admin, tenant.id, current.id, { version: current.version, channelId: 'wa' }, options); };
  t.after(async () => { await gateway.close(); store.close(); });
  return { store, tenant, gateway, socket, sockets, hooks, addChannel, connect, raw, incoming, notify, append, conversations, conversation, receipt, readAction, markUnread, responsible, nativeRead, setNow: value => { clock = value; } };
}

test('read-self inbound direto limpa somente prefixo confirmado e não altera fila, versão ou ordenação', async t => {
  const c = await fixture(t); await c.incoming('old', SEC - 30); await c.incoming('read-through', SEC - 20); await c.incoming('new', SEC - 10);
  c.store.mutate(admin, c.tenant.id, 'Responsabilidade sintética preservada', state => { const conversation = state.conversations[0];
    conversation.owner = 'human'; conversation.status = 'pending'; conversation.assignedUserId = 'actual-human'; conversation.participants = [{ userId: 'collaborator' }]; });
  const before = structuredClone(c.conversation()); c.receipt('read-through'); const current = c.conversation();
  assert.equal(current.unread, 1); assert.equal(current.whatsappDeviceRead.providerTs, SEC - 20);
  for (const field of ['owner', 'status', 'assignedUserId', 'participants', 'version', 'updatedAt']) assert.deepEqual(current[field], before[field]);
  assert.equal(current.messages.find(message => message.externalId === 'read-through').delivery, 'read');
  assert.equal(current.messages.find(message => message.externalId === 'new').delivery, 'received'); assert.equal(c.socket.sent.length, 0);
});

test('resposta própria viva reconcilia não lidas sem assumir ou encerrar atendimento', async t => {
  const c = await fixture(t); await c.notify('question', SEC - 20); await c.notify('phone-reply', SEC - 10, { fromMe: true });
  assert.equal(c.conversation().unread, 0); assert.equal(c.conversation().owner, 'queue'); assert.equal(c.conversation().status, 'open');
  assert.equal(c.conversation().assignedUserId, null); assert.equal(c.conversation().whatsappDeviceRead.source, 'own-reply');
  assert.equal(c.hooks.length, 1); assert.equal(c.conversation().messages.at(-1).kind, 'human');
  await c.notify('later-question', SEC - 5); assert.equal(c.conversation().unread, 1);
});

test('READ de resposta pelo cliente atualiza entrega, sem fingir leitura do próprio aparelho', async t => {
  const c = await fixture(t); await c.incoming('question');
  c.store.mutate(admin, c.tenant.id, 'Responsável humano sintético', state => { state.conversations[0].owner = 'human'; state.conversations[0].assignedUserId = admin.userId; });
  const current = c.conversation(); await c.gateway.send(admin, c.tenant.id, current.id, { version: current.version, channelId: 'wa', text: 'Resposta RAM.' });
  const message = c.conversation().messages.at(-1); c.receipt(message.externalId, { fromMe: true });
  assert.equal(c.conversation().messages.at(-1).delivery, 'read'); assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead, undefined);
});

test('evento READ sem direção própria comprovada não limpa inbound', async t => {
  const c = await fixture(t); await c.incoming('question');
  c.socket.ev.emit('messages.update', [{ key: { id: 'question', remoteJid: PN }, update: { status: proto.WebMessageInfo.Status.READ } }]);
  c.receipt('question', { fromMe: true }); c.receipt('question', { status: proto.WebMessageInfo.Status.DELIVERY_ACK });
  assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead, undefined);
});

test('corte monotônico preserva inbound posterior e mesmo segundo após a âncora', async t => {
  const c = await fixture(t); await c.incoming('first', SEC - 20); c.receipt('first');
  await c.incoming('same-second-later', SEC - 20); await c.incoming('later', SEC - 10); assert.equal(c.conversation().unread, 2);
  const mark = structuredClone(c.conversation().whatsappDeviceRead); c.receipt('first'); assert.deepEqual(c.conversation().whatsappDeviceRead, mark); assert.equal(c.conversation().unread, 2);
  c.receipt('same-second-later'); assert.equal(c.conversation().unread, 1);
  c.receipt('later'); assert.equal(c.conversation().unread, 0); const latest = structuredClone(c.conversation());
  c.receipt('first'); assert.deepEqual(c.conversation(), latest);
});

test('resposta antiga, append próprio e história não limpam a pergunta atual', async t => {
  const c = await fixture(t); await c.incoming('question', SEC - 10);
  await c.notify('older-own-reply', SEC - 30, { fromMe: true }); assert.equal(c.conversation().unread, 1);
  const mark = structuredClone(c.conversation().whatsappDeviceRead);
  await c.append('old-append-own', SEC - 5, { fromMe: true });
  c.socket.ev.emit('messaging-history.set', { chats: [{ id: PN, unreadCount: 0 }], messages: [c.raw('history-own', SEC - 1, { fromMe: true })], isLatest: true }); await tick();
  assert.equal(c.conversation().unread, 1); assert.deepEqual(c.conversation().whatsappDeviceRead, mark);
  c.socket.ev.emit('chats.update', [{ id: PN, unreadCount: 0 }, { id: PN, unreadCount: -1 }]); assert.equal(c.conversation().unread, 1);
});

test('backlog inbound mais antigo que leitura comprovada não recria não lidas', async t => {
  const c = await fixture(t); await c.incoming('read-anchor', SEC - 10); c.receipt('read-anchor');
  await c.append('late-older', SEC - 60); assert.equal(c.conversation().unread, 0);
  await c.append('late-newer', SEC - 5); assert.equal(c.conversation().unread, 1);
});

test('identidade PN/LID comprovada mantém leitura na mesma conversa', async t => {
  const c = await fixture(t); await c.incoming('aliased', SEC - 10, { jid: LID, alt: PN });
  c.receipt('aliased', { jid: LID }); assert.equal(c.conversation().unread, 0); assert.equal(c.conversations().length, 1);
  await c.incoming('new-pn', SEC - 5); c.receipt('new-pn', { jid: LID }); assert.equal(c.conversation().unread, 0);
});

test('externalId coincidente não autoriza outra conversa, canal ou empresa', async t => {
  const c = await fixture(t); await c.incoming('same-id', SEC - 10); await c.incoming('same-id', SEC - 10, { jid: OTHER });
  c.addChannel(c.tenant.id, 'second-wa', '5511999990001'); const second = await c.connect(c.tenant.id, 'second-wa', '5511999990001');
  await c.incoming('same-id', SEC - 10, { jid: PN }, c.gateway.entries.get('second-wa'));
  const other = c.store.createTenant(admin, { name: 'Outra empresa RAM', segment: 'Teste' }); c.addChannel(other.id, 'foreign-wa', '5511999990002');
  await c.connect(other.id, 'foreign-wa', '5511999990002'); await c.incoming('same-id', SEC - 10, { jid: PN }, c.gateway.entries.get('foreign-wa'));
  c.receipt('same-id');
  assert.equal(c.conversation().unread, 0); assert.equal(c.conversation(OTHER).unread, 1);
  assert.equal(c.conversations().find(item => item.channelId === 'second-wa').unread, 1); assert.equal(c.conversations(other.id)[0].unread, 1);
  second.ev.emit('messages.update', [{ key: { id: 'same-id', remoteJid: OTHER, fromMe: false }, update: { status: proto.WebMessageInfo.Status.READ } }]);
  assert.equal(c.conversations().find(item => item.channelId === 'second-wa').unread, 1);
});

test('recibo sem JID exato, id desconhecido ou remetente incompatível não avança leitura', async t => {
  const c = await fixture(t); await c.incoming('question');
  for (const key of [{ id: 'question', fromMe: false }, { id: 'unknown', remoteJid: PN, fromMe: false },
    { id: 'question', remoteJid: OTHER, fromMe: false }, { id: 'question', remoteJid: PN, fromMe: false, participant: OTHER }]) {
    c.socket.ev.emit('messages.update', [{ key, update: { status: proto.WebMessageInfo.Status.READ } }]);
  }
  assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead, undefined);
});

test('leitura de grupo por outro participante ou sem prova de leitor próprio não limpa contador', async t => {
  const c = await fixture(t); await c.incoming('group-question', SEC - 10, { jid: GROUP, participant: PN });
  c.socket.ev.emit('message-receipt.update', [{ key: { id: 'group-question', remoteJid: GROUP, fromMe: false, participant: PN }, receipt: { userJid: OTHER, readTimestamp: SEC } }]);
  c.receipt('group-question', { jid: GROUP, participant: OTHER }); c.receipt('group-question', { jid: GROUP, participant: PN });
  assert.equal(c.conversation(GROUP).unread, 1); assert.equal(c.conversation(GROUP).whatsappDeviceRead, undefined);
});

test('resposta própria viva no grupo selecionado confirma prefixo, sem limpar outro chat', async t => {
  const c = await fixture(t); await c.incoming('direct-question', SEC - 20); await c.incoming('group-question', SEC - 20, { jid: GROUP, participant: PN });
  await c.notify('group-own-reply', SEC - 10, { jid: GROUP, participant: OWN + '@s.whatsapp.net', fromMe: true });
  assert.equal(c.conversation(GROUP).unread, 0); assert.equal(c.conversation().unread, 1);
  assert.equal(c.conversation(GROUP).owner, 'queue'); assert.equal(c.conversation(GROUP).assignedUserId, null);
});

test('eco notify de envio do Elozi não vira resposta celular e não avança leitura', async t => {
  const c = await fixture(t); await c.incoming('question', SEC - 20);
  c.store.mutate(admin, c.tenant.id, 'Responsável humano sintético', state => { state.conversations[0].owner = 'human'; state.conversations[0].assignedUserId = admin.userId; });
  const conversation = c.conversation(); await c.gateway.send(admin, c.tenant.id, conversation.id, { version: conversation.version, channelId: 'wa', text: 'Resposta no Elozi RAM.' });
  const own = c.conversation().messages.at(-1), before = structuredClone(c.conversation());
  await c.notify(own.externalId, SEC - 10, { fromMe: true }); assert.deepEqual(c.conversation(), before);
  assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead, undefined);
});

test('histórico importado e timestamp desconhecido ou inválido ficam conservadores', async t => {
  const c = await fixture(t); await c.incoming('no-provider-time', 0); c.receipt('no-provider-time');
  await c.incoming('future', SEC + 600); c.receipt('future');
  c.store.mutate(admin, c.tenant.id, 'Mensagem histórica sintética', state => { state.conversations[0].messages.push({ id: 'historical', externalId: 'history-id',
    kind: 'customer', transport: 'whatsapp', imported: true, providerTs: SEC, createdAt: new Date(NOW).toISOString(), delivery: 'received', text: 'Histórico RAM.' }); });
  c.receipt('history-id'); assert.equal(c.conversation().unread, 2); assert.equal(c.conversation().whatsappDeviceRead, undefined);
  await c.notify('own-no-provider-time', 0, { fromMe: true }); assert.equal(c.conversation().unread, 2);
});

test('painel já lido não ganha contador ao receber um recibo próprio', async t => {
  const c = await fixture(t); await c.incoming('first', SEC - 20); await c.incoming('later', SEC - 10);
  c.store.mutate(admin, c.tenant.id, 'Leitura interna explícita sintética', state => { state.conversations[0].unread = 0; });
  c.receipt('first'); assert.equal(c.conversation().unread, 0);
});

test('socket substituído, canal desativado e evento duplicado não alteram leitura atual', async t => {
  const c = await fixture(t); await c.incoming('question'); c.receipt('question'); const before = structuredClone(c.conversation());
  c.receipt('question'); assert.deepEqual(c.conversation(), before);
  await c.incoming('new', SEC - 5); await c.gateway.openSocket(c.gateway.entries.get('wa'));
  c.receipt('new'); assert.equal(c.conversation().unread, 1, 'socket antigo sem autoridade');
  const current = c.sockets.at(-1); current.config.auth.creds.me = { id: OWN + ':1@s.whatsapp.net' }; current.ev.emit('connection.update', { connection: 'open' }); await tick();
  c.store.mutate(admin, c.tenant.id, 'Conexão desativada sintética', state => { state.channels.find(item => item.id === 'wa').enabled = false; });
  c.receipt('new', { target: current }); assert.equal(c.conversation().unread, 1);
});

test('ação SDK de leitura com range limpa somente o prefixo provado e conserva mensagens, fila e ordenação', async t => {
  const c = await fixture(t); await c.incoming('first', SEC - 30); await c.incoming('anchor', SEC - 20); await c.incoming('later', SEC - 10);
  const before = structuredClone(c.conversation()); c.readAction('anchor', SEC - 20);
  assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead.source, 'app-state-read');
  for (const key of ['messages','owner','status','assignedUserId','version','updatedAt']) assert.deepEqual(c.conversation()[key], before[key]);
  assert.equal(c.socket.nativeReads.length, 0); assert.equal(c.socket.chatChanges.length, 0);
});

test('snapshot com range explícito ajuda conversa sem watermark sem ressuscitar não lidas', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); await c.incoming('newer', SEC - 10);
  c.readAction('known', SEC - 20, { initial: true }); assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead.source, 'app-state-snapshot');
  c.readAction('newer', SEC - 10); assert.equal(c.conversation().unread, 0);
  c.readAction('known', SEC - 20, { initial: true }); await c.append('old-backlog', SEC - 60); assert.equal(c.conversation().unread, 0);
});

test('ação app-state usa aliases comprovados e não cruza chat, canal ou tenant', async t => {
  const c = await fixture(t); await c.incoming('same', SEC - 20, { jid: LID, alt: PN }); await c.incoming('same', SEC - 20, { jid: OTHER });
  c.addChannel(c.tenant.id, 'second-wa', '5511999990001'); await c.connect(c.tenant.id, 'second-wa', '5511999990001');
  await c.incoming('same', SEC - 20, { jid: PN }, c.gateway.entries.get('second-wa'));
  const other = c.store.createTenant(admin, { name: 'Outro tenant RAM', segment: 'Teste' }); c.addChannel(other.id, 'foreign-wa', '5511999990002'); await c.connect(other.id, 'foreign-wa', '5511999990002');
  await c.incoming('same', SEC - 20, { jid: PN }, c.gateway.entries.get('foreign-wa'));
  c.readAction('same', SEC - 20, { jid: LID, keyJid: PN });
  assert.equal(c.conversation().unread, 0); assert.equal(c.conversation(OTHER).unread, 1);
  assert.equal(c.conversations().find(item => item.channelId === 'second-wa').unread, 1); assert.equal(c.conversations(other.id)[0].unread, 1);
});

test('grupo exige âncora e participante reais e não usa recibo de outro participante', async t => {
  const c = await fixture(t); await c.incoming('group-first', SEC - 20, { jid: GROUP, participant: PN }); await c.incoming('group-new', SEC - 10, { jid: GROUP, participant: OTHER });
  c.readAction('group-first', SEC - 20, { jid: GROUP, participant: OTHER }); assert.equal(c.conversation(GROUP).unread, 2);
  c.readAction('group-first', SEC - 20, { jid: GROUP, participant: PN }); assert.equal(c.conversation(GROUP).unread, 1);
});

test('range desconhecido, timestamp incompatível e ação de não lida não alteram contador', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); const before = structuredClone(c.conversation());
  c.readAction('unknown', SEC - 20); c.readAction('known', SEC - 19); c.readAction('known', SEC - 20, { fromMe: true }); c.readAction('known', SEC - 20, { read: false });
  assert.deepEqual(c.conversation(), before);
});

test('marcação manual protege contra recibo atrasado ou sem hora e aceita leitura posterior comprovada', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); c.setNow(NOW + 1000); c.markUnread();
  c.receipt('known', { readTs: SEC }); c.receipt('known', { readTs: null }); assert.equal(c.conversation().unread, 1); assert.equal(c.conversation().whatsappDeviceRead, undefined);
  c.setNow(NOW + 3000); c.receipt('known', { readTs: SEC + 2 }); assert.equal(c.conversation().unread, 0);
  c.markUnread(); c.readAction('known', SEC - 20, { readAt: NOW + 2000 }); assert.equal(c.conversation().unread, 1);
  c.setNow(NOW + 5000); c.readAction('known', SEC - 20, { readAt: NOW + 4000 }); assert.equal(c.conversation().unread, 0, 'mesma âncora com prova fresca pode liberar a marca manual');
});

test('logger de socket substituído, canal desativado ou ainda sem vínculo não aplica ação', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); await c.gateway.openSocket(c.gateway.entries.get('wa'));
  c.readAction('known', SEC - 20); assert.equal(c.conversation().unread, 1);
  const target = c.sockets.at(-1); c.readAction('known', SEC - 20, { target }); assert.equal(c.conversation().unread, 1);
  target.config.auth.creds.me = { id: OWN + ':1@s.whatsapp.net' }; target.ev.emit('connection.update', { connection: 'open' }); await tick();
  c.store.mutate(admin, c.tenant.id, 'Canal suspenso sintético', tenant => { tenant.channels.find(channel => channel.id === 'wa').enabled = false; });
  c.readAction('known', SEC - 20, { target }); assert.equal(c.conversation().unread, 1);
});

test('leitura nativa explícita usa somente keys e range capturados e preserva o estado local', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20, { jid: LID, alt: PN }); c.responsible();
  const before = structuredClone(c.conversation()); assert.deepEqual(await c.nativeRead(), { state: 'synced' });
  assert.deepEqual(c.conversation(), before); assert.equal(c.socket.sent.length, 0); assert.equal(c.socket.nativeReads.length, 1); assert.equal(c.socket.chatChanges.length, 1);
  assert.deepEqual(c.socket.nativeReads[0], [{ id: 'known', remoteJid: LID, fromMe: false }]);
  assert.equal(c.socket.chatChanges[0].change.markRead, true); assert.equal(c.socket.chatChanges[0].change.lastMessages[0].timestamp, SEC - 20); assert.equal(c.socket.chatChanges[0].change.lastMessages[0].messageTimestamp, SEC - 20);
});

test('novo inbound entre etapas impede chatModify e mantém a nova mensagem não lida', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); c.responsible();
  c.socket.readMessages = async keys => { c.socket.nativeReads.push(keys); await c.incoming('newer', SEC - 10); };
  assert.deepEqual(await c.nativeRead(), { state: 'pending', reason: 'unconfirmed' }); assert.equal(c.socket.nativeReads.length, 1); assert.equal(c.socket.chatChanges.length, 0); assert.equal(c.conversation().unread, 2);
  assert.ok(c.socket.nativeReads[0].every(key => key.id !== 'newer'));
});

for (const change of ['owner','manual-unread','socket']) test(`mudança de ${change} entre etapas bloqueia a segunda chamada nativa`, async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); c.responsible();
  c.socket.readMessages = async () => {
    if (change === 'owner') c.store.mutate(admin, c.tenant.id, 'Repasse sintético', tenant => { tenant.conversations[0].assignedUserId = 'other-owner'; });
    if (change === 'manual-unread') c.markUnread();
    if (change === 'socket') await c.gateway.openSocket(c.gateway.entries.get('wa'));
  };
  assert.deepEqual(await c.nativeRead(), { state: 'pending', reason: 'unconfirmed' }); assert.equal(c.socket.chatChanges.length, 0);
});

test('timeout nativo retorna pendente sem retry ou chatModify tardio', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); c.responsible(); let resolve, expire, cleared = 0, calls = 0;
  c.socket.readMessages = () => { calls++; return new Promise(done => { resolve = done; }); };
  const pending = c.nativeRead({ setTimeoutImpl: callback => { expire = callback; return 1; }, clearTimeoutImpl: () => { cleared++; } });
  expire(); assert.deepEqual(await pending, { state: 'pending', reason: 'timeout' }); resolve(); await tick();
  assert.equal(calls, 1); assert.equal(c.socket.chatChanges.length, 0); assert.equal(cleared, 1);
});

test('timeout conserva single-flight até a operação SDK liquidar e só então admite nova ação explícita', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20); c.responsible(); let resolveFirst, expire, calls = 0;
  c.socket.readMessages = () => { calls++; if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; }); };
  const first = c.nativeRead({ setTimeoutImpl: callback => { expire = callback; return 1; }, clearTimeoutImpl() {} });
  expire(); assert.deepEqual(await first, { state: 'pending', reason: 'timeout' });
  assert.deepEqual(await c.nativeRead(), { state: 'pending', reason: 'unconfirmed' });
  assert.equal(calls, 1); assert.equal(c.socket.chatChanges.length, 0, 'não repete readMessages nem despacha chatModify em paralelo');
  resolveFirst(); await tick(); assert.equal(c.socket.chatChanges.length, 0, 'o primeiro trabalho expirado não continua o dispatch');
  assert.deepEqual(await c.nativeRead(), { state: 'synced' }); assert.equal(calls, 2); assert.equal(c.socket.chatChanges.length, 1);
});

test('observador, suporte e reautorização negada não disparam leitura nativa', async t => {
  const c = await fixture(t); await c.incoming('known', SEC - 20);
  await assert.rejects(c.nativeRead(), error => error.status === 403); c.responsible();
  await assert.rejects(c.gateway.syncReadToDevice({ ...admin, supportGrantId: 'temporary-support' }, c.tenant.id, c.conversation().id, { version: c.conversation().version, channelId: 'wa' }), error => error.status === 403);
  await assert.rejects(c.nativeRead({ reauthorize() { throw Object.assign(new Error('Revoked'), { status: 403 }); } }), error => error.status === 403);
  assert.equal(c.socket.nativeReads.length, 0); assert.equal(c.socket.chatChanges.length, 0);
});
