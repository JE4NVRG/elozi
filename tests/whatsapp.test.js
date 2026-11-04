import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { WhatsAppGateway, brazilianMobileAliases, whatsappNumbersMatch } from '../src/whatsapp.js';
import { encryptedAuthState } from '../src/wa-auth.js';
import { createApp } from '../src/server.js';
import { DisconnectReason, proto } from '@whiskeysockets/baileys';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Teste' };
const expected = '5511999990000';
const direct = '5511988880000@s.whatsapp.net';
test('nono dígito brasileiro preserva DDD/subscritor e rejeita outros números/telefones fixos', () => {
  const legacy = expected.slice(0, 4) + expected.slice(5);
  assert.deepEqual(brazilianMobileAliases(expected), [expected, legacy]);
  assert.equal(whatsappNumbersMatch(expected, legacy), true);
  assert.equal(whatsappNumbersMatch(legacy, expected), true);
  for (const other of ['551299990000', '551197770000', '5511988880000', '', '99990000'])
    assert.equal(whatsappNumbersMatch(expected, other), false);
  assert.equal(whatsappNumbersMatch('5511933330000', '551133330000'), false);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'evento esperado não chegou');
}
function fakeFactory(sockets) {
  return config => {
    const socket = { config, ev: new EventEmitter(), user: { id: expected + ':1@s.whatsapp.net' }, ends: 0, logouts: 0, sent: [] };
    socket.end = () => { socket.ends++; };
    socket.logout = async () => { socket.logouts++; };
    socket.onWhatsApp = async number => [{ exists: true, jid: number + '@s.whatsapp.net' }];
    socket.sendMessage = async (jid, content, options) => {
      socket.sent.push({ jid, content, options });
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: options.messageId, remoteJid: jid, fromMe: true }, message: { conversation: content.text } }] });
      socket.ev.emit('messages.update', [{ key: { id: options.messageId }, update: { status: proto.WebMessageInfo.Status.READ } }]);
      return { key: { id: options.messageId } };
    };
    sockets.push(socket); return socket;
  };
}
function setup(t, options = {}) {
  const store = new Store(':memory:'), sockets = [], key = randomBytes(32);
  const tenant = store.createTenant(admin, { name: 'Teste QR', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Canal de teste', state => state.channels.push({ id: 'qr-test', kind: 'whatsapp_qr', name: 'Teste', expectedNumber: expected, transport: 'baileys', state: 'disconnected', label: 'final 0000' }));
  const gateway = new WhatsAppGateway(store, { socketFactory: fakeFactory(sockets), authKey: key, reconnectDelay: 10, ...options });
  t.after(async () => { await gateway.close(); store.close(); });
  return { store, sockets, gateway, tenant, key };
}
async function connect(context) {
  await context.gateway.start(admin, context.tenant.id, 'qr-test');
  // Como o Baileys após o scan: creds.me fica salvo antes do open e marca a sessão como vinculada.
  context.sockets.at(-1).config.auth.creds.me = { id: expected + ':1@s.whatsapp.net' }; context.sockets.at(-1).ev.emit('creds.update', {});
  context.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  await tick();
}

test('WhatsApp conserva entrada e replay com agenda cheia e vincula na próxima mensagem com vaga', async t => {
  const c = setup(t); await connect(c);
  c.store.mutate(admin, c.tenant.id, 'Fixture: capacidade CRM', state => { state.contacts = Array.from({ length: 10000 }, (_, index) => ({ id: 'capacity-' + index, name: 'Fixture', type: 'person', identities: [], version: 1 })); });
  const entry = c.gateway.entries.get('qr-test');
  const incoming = id => ({ key: { id, remoteJid: direct }, message: { conversation: 'Entrada CRM ' + id } });
  await c.gateway.receive(entry, incoming('capacity-first'));
  let state = c.store.tenant(admin, c.tenant.id), conversation = state.conversations.find(item => item.remoteJid === direct);
  assert.equal(conversation.messages.length, 1); assert.equal(conversation.contactId, undefined); assert.equal(conversation.contactSyncStatus, 'capacity'); assert.equal(state.contacts.length, 10000);
  const beforeReplay = JSON.stringify(conversation);
  await c.gateway.receive(entry, incoming('capacity-first'));
  assert.equal(JSON.stringify(c.store.tenant(admin, c.tenant.id).conversations.find(item => item.id === conversation.id)), beforeReplay);
  c.store.mutate(admin, c.tenant.id, 'Fixture: liberar uma vaga sintética', tenant => { tenant.contacts.pop(); });
  await c.gateway.receive(entry, incoming('capacity-second'));
  state = c.store.tenant(admin, c.tenant.id); conversation = state.conversations.find(item => item.remoteJid === direct);
  assert.equal(conversation.messages.length, 2); assert.equal(conversation.contactSyncStatus, 'linked'); assert.ok(conversation.contactId); assert.equal(state.contacts.length, 10000);
  assert.deepEqual(state.contacts.find(item => item.id === conversation.contactId).identities, [{channelId:'qr-test', kind:'person', externalId:direct}]);
});
function takeOverFixture(context, conversationId) {
  context.store.mutate(admin, context.tenant.id, 'Fixture: assumir atendimento humano', tenant => {
    const conversation = tenant.conversations.find(item => item.id === conversationId);
    assert.equal(conversation.owner, 'queue');
    conversation.owner = 'human'; conversation.agentId = null; conversation.version++;
  });
  return context.store.tenant(admin, context.tenant.id).conversations.find(item => item.id === conversationId);
}

test('grupos QR exigem seleção, preservam autores e respondem ao grupo na conexão original', async t => {
  const c = setup(t); await connect(c);
  const socket = c.sockets.at(-1), groupId = '12000001@g.us';
  socket.groupFetchAllParticipating = async () => ({ [groupId]: { id: groupId, subject: 'Grupo QA', participants: [] } });
  const groupMessage = (id, participant, name) => ({ key: { id, remoteJid: groupId, participant }, pushName: name, message: { conversation: `Mensagem ${id}` } });
  await c.gateway.receive(c.gateway.entries.get('qr-test'), groupMessage('g0', direct, 'Ana'));
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations.length, 0);
  await assert.rejects(c.gateway.setGroups(admin, c.tenant.id, 'qr-test', { version: 0, groupIds: ['outro@g.us'] }), /não pertence/);
  await c.gateway.setGroups(admin, c.tenant.id, 'qr-test', { version: 0, groupIds: [groupId] });
  await c.gateway.receive(c.gateway.entries.get('qr-test'), groupMessage('g1', direct, 'Ana'));
  await c.gateway.receive(c.gateway.entries.get('qr-test'), groupMessage('g2', 'outro@lid', 'Bruno'));
  await c.gateway.receive(c.gateway.entries.get('qr-test'), groupMessage('g1', direct, 'Ana'));
  let tenant = c.store.tenant(admin, c.tenant.id), conversation = tenant.conversations[0];
  assert.equal(tenant.conversations.length, 1); assert.equal(conversation.contact, 'Grupo QA');
  assert.equal(conversation.conversationKind, 'group'); assert.equal(conversation.messages.length, 2);
  assert.deepEqual(conversation.messages.map(item => item.senderName), ['Ana', 'Bruno']);
  socket.ev.emit('groups.update', [{ id: groupId, subject: 'Novo título' }]);
  conversation = c.store.tenant(admin, c.tenant.id).conversations[0]; assert.equal(conversation.contact, 'Novo título');
  conversation = takeOverFixture(c, conversation.id);
  await c.gateway.send(admin, c.tenant.id, conversation.id, { text: 'Resposta QA', channelId: 'qr-test', version: conversation.version });
  assert.equal(socket.sent[0].jid, groupId);
  await c.gateway.setGroups(admin, c.tenant.id, 'qr-test', { version: 1, groupIds: [] });
  conversation = c.store.tenant(admin, c.tenant.id).conversations[0];
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { text: 'Desativado', channelId: 'qr-test', version: conversation.version }), /desativado/);
});

test('auth criptografada persiste buffers, isola canal e rejeita adulteração', async () => {
  const store = new Store(':memory:'), key = randomBytes(32);
  try {
    const auth = encryptedAuthState(store.db, 'a', key);
    auth.state.creds.testSecret = 'segredo-fixture'; auth.saveCreds();
    await auth.state.keys.set({ session: { device: Buffer.from('sessao-fixture') } });
    const restored = encryptedAuthState(store.db, 'a', key);
    assert.equal(restored.state.creds.testSecret, 'segredo-fixture');
    assert.deepEqual((await restored.state.keys.get('session', ['device'])).device, Buffer.from('sessao-fixture'));
    assert.equal(encryptedAuthState(store.db, 'b', key).state.creds.testSecret, undefined);
    const row = store.db.prepare("SELECT payload FROM wa_auth WHERE channel_id='a' AND category='creds'").get();
    assert.equal(Buffer.from(row.payload).includes(Buffer.from('segredo-fixture')), false);
    const corrupted = Buffer.from(row.payload); corrupted[corrupted.length - 1] ^= 1;
    store.db.prepare("UPDATE wa_auth SET payload=? WHERE channel_id='a' AND category='creds'").run(corrupted);
    assert.throws(() => encryptedAuthState(store.db, 'a', key));
  } finally { store.close(); }
});

test('QR renova, restart 515 usa auth preservada e ignora eventos do socket antigo', async t => {
  const c = setup(t);
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  const first = c.sockets[0];
  assert.equal(first.config.syncFullHistory, false);
  assert.equal(first.config.shouldSyncHistoryMessage(), false);
  first.ev.emit('connection.update', { qr: 'qr-fixture-1' });
  await until(() => c.gateway.status(admin, c.tenant.id, 'qr-test').state === 'qr');
  const qr = c.gateway.status(admin, c.tenant.id, 'qr-test').qr;
  assert.match(qr, /^data:image\/png;base64,/);
  first.ev.emit('connection.update', { qr: 'qr-fixture-2' });
  await until(() => c.gateway.status(admin, c.tenant.id, 'qr-test').qr !== qr);
  first.config.auth.creds.testValue = 'persistiu'; first.ev.emit('creds.update', {});
  first.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } } });
  await until(() => c.sockets.length === 2);
  assert.equal(c.sockets[1].config.auth.creds.testValue, 'persistiu');
  first.ev.emit('connection.update', { connection: 'open' });
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').expectedNumberMatched, false);
  c.sockets[1].ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').expectedNumberMatched, true);
  assert.equal(c.gateway.connectedCount(), 1);
});

test('pareamento aceita JID móvel brasileiro legado sem nono dígito', async t => {
  const c = setup(t); await c.gateway.start(admin, c.tenant.id, 'qr-test');
  c.sockets[0].user.id = expected.slice(0, 4) + expected.slice(5) + ':1@s.whatsapp.net';
  c.sockets[0].ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').state, 'connected');
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').expectedNumberMatched, true);
  assert.equal(c.sockets[0].logouts, 0);
});

test('formato legado não reserva o mesmo telefone em outro canal/tenant', t => {
  const c = setup(t), foreign = c.store.createTenant(admin, { name: 'Outra unidade', segment: 'Teste' });
  c.gateway.reserveNumber(c.store.tenant(admin, c.tenant.id).channels[0], c.tenant.id);
  assert.throws(() => c.gateway.reserveNumber({ id: 'foreign-channel', expectedNumber: expected.slice(0, 4) + expected.slice(5) }, foreign.id), { status: 409 });
});

test('número diferente não importa conversa; novo QR após logout descarta somente auth inválida', async t => {
  const c = setup(t);
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  c.sockets[0].user.id = '5511977770000@s.whatsapp.net';
  c.sockets[0].config.auth.creds.testValue = 'antigo'; c.sockets[0].ev.emit('creds.update', {});
  c.sockets[0].ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').state, 'wrong_number');
  assert.equal(c.sockets[0].logouts, 1);
  c.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'indevido', remoteJid: direct }, message: { conversation: 'não importar' } }] });
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations.length, 0);
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  assert.equal(c.sockets[1].config.auth.creds.testValue, undefined);
  c.sockets[1].config.auth.creds.testValue = 'invalidou'; c.sockets[1].ev.emit('creds.update', {});
  c.sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await tick(); assert.equal(c.sockets.length, 2);
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').state, 'logged_out');
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  assert.equal(c.sockets[2].config.auth.creds.testValue, undefined);
});

// 'append' não é sinônimo de histórico: o Baileys usa esse tipo para o que chegou com o socket offline.
// Aqui o append é antigo (2023, além da janela de 72 h) e por isso fica de fora; o append recente tem teste próprio.
test('recebe array notify uma vez; ignora append antigo/grupos; envia na origem e preserva leitura', async t => {
  const c = setup(t); await connect(c);
  const socket = c.sockets[0];
  const message = id => ({ key: { id, remoteJid: direct, fromMe: false }, pushName: 'Contato fixture', message: { conversation: id }, messageTimestamp: 1700000000 });
  socket.ev.emit('messages.upsert', { type: 'append', messages: [message('append-antigo')] });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ ...message('grupo'), key: { id: 'grupo', remoteJid: 'x@g.us' } }, message('a'), message('b')] });
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('a')] });
  await tick();
  let tenant = c.store.tenant(admin, c.tenant.id), conversation = tenant.conversations[0];
  assert.equal(tenant.conversations.length, 1); assert.equal(conversation.messages.length, 2);
  const beforeTakeOverVersion = conversation.version;
  conversation = takeOverFixture(c, conversation.id);
  const input = { version: conversation.version, channelId: 'qr-test', text: 'resposta fixture' };
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { ...input, channelId: 'outro' }), { status: 400 });
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { ...input, version: beforeTakeOverVersion }), { status: 409 });
  const sent = await c.gateway.send(admin, c.tenant.id, conversation.id, input);
  assert.equal(socket.sent[0].jid, direct); assert.equal(sent.messages.length, 3);
  assert.equal(sent.messages.at(-1).delivery, 'read');
  socket.ev.emit('messages.update', [{ key: { id: sent.messages.at(-1).externalId }, update: { status: proto.WebMessageInfo.Status.SERVER_ACK } }]);
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.at(-1).delivery, 'read');
  c.store.mutate(admin, c.tenant.id, 'Agente fixture', state => { state.conversations[0].owner = 'agent'; });
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { ...input, version: sent.version }), { status: 409 });
});

test('rejeição posterior ao envio aparece como falha, sem regredir entrega nem leitura', async t => {
  const c = setup(t); await connect(c);
  const socket = c.sockets[0];
  await c.gateway.receive(c.gateway.entries.get('qr-test'), { key: { id: 'seed-errors', remoteJid: direct }, message: { conversation: 'Fixture' } });
  const conversation = takeOverFixture(c, c.store.tenant(admin, c.tenant.id).conversations[0].id);
  socket.sendMessage = async (jid, content, options) => ({ key: { id: options.messageId } });
  const sent = await c.gateway.send(admin, c.tenant.id, conversation.id, { version: conversation.version, channelId: 'qr-test', text: 'Fixture' });
  const id = sent.messages.at(-1).externalId, current = () => c.store.tenant(admin, c.tenant.id).conversations[0].messages.at(-1).delivery;
  const status = value => socket.ev.emit('messages.update', [{ key: { id }, update: { status: value } }]);
  assert.equal(current(), 'sent');
  socket.ev.emit('messages.update', [{ key: { id }, update: { status: proto.WebMessageInfo.Status.ERROR, messageStubParameters: ['406', 'secret-fixture'] } }]); assert.equal(current(), 'failed');
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.at(-1).deliveryErrorCode, '406');
  socket.ev.emit('messages.update', [{ key: { id }, update: { status: proto.WebMessageInfo.Status.ERROR, messageStubParameters: ['secret-fixture'] } }]);
  assert.equal(JSON.stringify(c.store.tenant(admin, c.tenant.id).conversations).includes('secret-fixture'), false);
  status(proto.WebMessageInfo.Status.SERVER_ACK); assert.equal(current(), 'failed');
  status(proto.WebMessageInfo.Status.PENDING); assert.equal(current(), 'failed');
  status(proto.WebMessageInfo.Status.DELIVERY_ACK); assert.equal(current(), 'delivered');
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.at(-1).deliveryErrorCode, undefined);
  status(proto.WebMessageInfo.Status.ERROR); assert.equal(current(), 'delivered');
  status(proto.WebMessageInfo.Status.READ); assert.equal(current(), 'read');
  status(proto.WebMessageInfo.Status.ERROR); assert.equal(current(), 'read');
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.length, 2);
});

test('rejeição durante relay não vira enviado nem envio incerto ao resolver ou rejeitar', async t => {
  const c = setup(t); await connect(c);
  const socket = c.sockets[0];
  await c.gateway.receive(c.gateway.entries.get('qr-test'), { key: { id: 'seed-relay', remoteJid: direct }, message: { conversation: 'Fixture' } });
  const conversation = takeOverFixture(c, c.store.tenant(admin, c.tenant.id).conversations[0].id);
  let calls = 0;
  for (const rejected of [false, true]) {
    socket.sendMessage = async (jid, content, options) => {
      calls++; socket.ev.emit('messages.update', [{ key: { id: options.messageId }, update: { status: proto.WebMessageInfo.Status.ERROR } }]);
      if (rejected) throw Error('Fixture relay rejected');
      return { key: { id: options.messageId } };
    };
    await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { version: c.store.tenant(admin, c.tenant.id).conversations[0].version, channelId: 'qr-test', text: 'Fixture' }), { status: 502 });
    assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.at(-1).delivery, 'failed');
  }
  assert.equal(calls, 2);
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.length, 3);
});

test('API do QR exige revenda, tenant certo e não expõe número/JID no payload', async t => {
  const sockets = [], app = createApp({ allowDemo: true, databasePath: ':memory:', gatewayOptions: { socketFactory: fakeFactory(sockets), authKey: randomBytes(32) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.gateway.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, cookie = '', body) {
    const res = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const reseller = (await request('/api/demo-session', '', { role: 'reseller' })).cookie;
  const operator = (await request('/api/demo-session', '', { role: 'operator' })).cookie;
  const tenant = (await request('/api/tenants', reseller, { name: 'QR API', segment: 'Teste' })).data;
  const channel = (await request(`/api/tenants/${tenant.id}/channels`, reseller, { name: 'QR', kind: 'whatsapp_qr', real: true, expectedNumber: expected })).data;
  const path = `/api/tenants/${tenant.id}/channels/${channel.id}`;
  assert.equal((await request('/api/tenants/studio-demo/channels', reseller, { name: 'Duplicado', kind: 'whatsapp_qr', real: true, expectedNumber: expected })).status, 409);
  assert.equal(channel.expectedNumber, undefined);
  assert.equal((await request(path + '/connection')).status, 401);
  assert.equal((await request(path + '/connection', operator)).status, 403);
  assert.equal((await request(`/api/tenants/studio-demo/channels/${channel.id}/connection`, reseller)).status, 404);
  assert.equal((await request(path + '/connect', reseller, {})).status, 200);
  sockets[0].ev.emit('connection.update', { connection: 'open' }); await tick();
  sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'api-fixture', remoteJid: direct }, message: { conversation: 'fixture' } }] });
  const payload = (await request('/api/tenants/' + tenant.id, reseller)).data;
  assert.equal(payload.channels[0].expectedNumber, undefined); assert.equal(payload.conversations[0].remoteJid, undefined);
});

test('QR pendente não sobrescreve conexão e restore retoma scan salvo antes do primeiro open', async t => {
  const c = setup(t);
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  c.sockets[0].ev.emit('connection.update', { qr: 'qr-atrasado' });
  c.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').state, 'connected');
  assert.equal(c.gateway.status(admin, c.tenant.id, 'qr-test').qr, null);
  c.sockets[0].config.auth.creds.registered = true; c.sockets[0].ev.emit('creds.update', {});
  await c.gateway.close();
  c.store.mutate(admin, c.tenant.id, 'Scan antes do open', state => { delete state.channels[0].linkedAt; state.channels[0].state = 'reconnecting'; });
  const restored = new WhatsAppGateway(c.store, { socketFactory: fakeFactory(c.sockets), authKey: c.key });
  t.after(() => restored.close());
  await restored.restore();
  assert.equal(c.sockets.length, 2); assert.equal(c.sockets[1].config.auth.creds.registered, true);
});

test('conversa iniciada valida contato/origem, reutiliza registro e recebe resposta LID na mesma conversa', async t => {
  const c = setup(t); await connect(c);
  const input = { channelId: 'qr-test', number: '11988880000', name: 'Contato fixture' };
  const first = await c.gateway.beginConversation(admin, c.tenant.id, input);
  const second = await c.gateway.beginConversation(admin, c.tenant.id, input);
  assert.equal(first.id, second.id); assert.equal(c.sockets[0].sent.length, 0);
  assert.equal(first.owner, 'queue'); assert.equal(first.assignedUserId, null);
  await assert.rejects(c.gateway.beginConversation(admin, 'studio-demo', input), { status: 404 });
  const operator = { ...admin, role: 'operator', tenantId: 'playtech-demo' };
  await assert.rejects(c.gateway.beginConversation(operator, c.tenant.id, input), { status: 403 });
  c.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'resposta-lid', remoteJid: '12345@lid', remoteJidAlt: direct, fromMe: false }, message: { conversation: 'resposta fixture' } }] });
  await tick();
  const conversations = c.store.tenant(admin, c.tenant.id).conversations;
  assert.equal(conversations.length, 1); assert.equal(conversations[0].id, first.id); assert.equal(conversations[0].messages.length, 1);
  assert.ok(conversations[0].remoteAliases.includes('12345@lid'));
  c.sockets[0].signalRepository = { lidMapping: { getPNForLID: async () => direct.replace('@', ':0@') } };
  c.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'resposta-lid-sem-alt', remoteJid: '12345@lid', fromMe: false }, message: { conversation: 'resposta fixture pelo mapping' } }] });
  await tick();
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations.length, 1);
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.length, 2);
  c.sockets[0].onWhatsApp = async () => [{ exists: false, jid: direct }];
  await assert.rejects(c.gateway.beginConversation(admin, c.tenant.id, { ...input, number: '11911110000' }), { status: 400 });
  c.sockets[0].onWhatsApp = async () => { throw new Error('fixture indisponível'); };
  await assert.rejects(c.gateway.beginConversation(admin, c.tenant.id, input), { status: 502 });
});

const closeWith = (socket, statusCode) => socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('append offline recente entra uma vez; atrasado vai à fila sem automação; eco do envio e replay não regravam', async t => {
  const NOW = Date.parse('2026-10-06T12:00:00Z'), groupJid = '12000009@g.us';
  const c = setup(t, { now: () => NOW }); await connect(c);
  const socket = c.sockets[0], hooks = [], routed = [];
  c.store.mutate(admin, c.tenant.id, 'Fixture: grupo habilitado', state => { state.channels[0].allowedGroups = [groupJid]; state.channels[0].groupNames = { [groupJid]: 'Grupo offline' }; });
  c.gateway.onIncoming = (entry, conversationId, messageId) => { hooks.push(messageId); };
  c.gateway.operations = { routeIncoming: (tenantId, conversationId) => { routed.push(conversationId); }, canReply: () => true };
  const at = (id, ageMs, extra = {}) => ({ key: { id, remoteJid: direct, fromMe: false }, pushName: 'Contato offline', message: { conversation: 'offline ' + id }, messageTimestamp: Math.floor((NOW - ageMs) / 1000), ...extra });
  const conversations = () => c.store.tenant(admin, c.tenant.id).conversations, count = () => conversations().reduce((total, item) => total + item.messages.length, 0);
  socket.ev.emit('messages.upsert', { type: 'append', messages: [at('antigo', 73 * 3600_000), at('sem-data', 0, { messageTimestamp: undefined }), at('recente', 60_000), at('atrasado', 2 * 3600_000),
    at('grupo-offline', 30_000, { key: { id: 'grupo-offline', remoteJid: groupJid, participant: direct } }), at('grupo-fora', 30_000, { key: { id: 'grupo-fora', remoteJid: '12000010@g.us', participant: direct } })] });
  await until(() => routed.length === 3); await tick();
  const contact = conversations().find(item => item.remoteJid === direct), group = conversations().find(item => item.remoteJid === groupJid);
  assert.equal(conversations().length, 2); assert.equal(count(), 3);
  assert.deepEqual(contact.messages.map(item => item.text), ['offline recente', 'offline atrasado']);
  assert.equal(contact.messages[0].deliveredLate, undefined); assert.equal(contact.messages[1].deliveredLate, true);
  assert.equal(contact.messages[1].createdAt, new Date(NOW - 2 * 3600_000).toISOString()); assert.equal(contact.unread, 2);
  assert.equal(contact.updatedAt, new Date(NOW - 60_000).toISOString()); // O carimbo antigo do atrasado não faz updatedAt recuar.
  assert.equal(group.messages[0].senderName, 'Contato offline'); assert.equal(c.gateway.entries.get('qr-test').historyCursors.size, 0);
  // Atrasado além de 10 min não dispara fluxo automático, mas segue para a fila/distribuição humana.
  assert.deepEqual(hooks, [contact.messages[0].id, group.messages[0].id]);
  const audits = () => c.store.db.prepare("SELECT count(*) AS n FROM audit WHERE action='WhatsApp: mensagem recebida'").get().n;
  const before = JSON.stringify(conversations()), writes = audits();
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [at('recente', 60_000)] });
  socket.ev.emit('messages.upsert', { type: 'append', messages: [at('atrasado', 2 * 3600_000)] });
  await tick();
  assert.equal(JSON.stringify(conversations()), before); assert.equal(audits(), writes); assert.equal(hooks.length, 2); assert.equal(routed.length, 3);
  const owned = takeOverFixture(c, contact.id);
  const sent = await c.gateway.send(admin, c.tenant.id, owned.id, { version: owned.version, channelId: 'qr-test', text: 'Resposta após reinício' });
  const afterSend = JSON.stringify(conversations()), sendWrites = audits();
  socket.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: sent.messages.at(-1).externalId, remoteJid: direct, fromMe: true }, message: { conversation: 'Resposta após reinício' }, messageTimestamp: Math.floor(NOW / 1000) }] });
  await tick();
  assert.equal(JSON.stringify(conversations()), afterSend); assert.equal(audits(), sendWrites);
  socket.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: 'enviada-no-celular', remoteJid: direct, fromMe: true }, message: { conversation: 'Respondi pelo celular' }, messageTimestamp: Math.floor((NOW - 120_000) / 1000) }] });
  await until(() => conversations().find(item => item.id === owned.id).messages.some(item => item.externalId === 'enviada-no-celular'));
  const phone = conversations().find(item => item.id === owned.id).messages.find(item => item.externalId === 'enviada-no-celular');
  assert.equal(phone.kind, 'human'); assert.equal(phone.delivery, 'sent'); assert.equal(hooks.length, 2);
  // Reabertura e conversa nova por mensagem atrasada não passam pela automação, mas abrem o ciclo de SLA como ela faria.
  const other = '5511977770001@s.whatsapp.net';
  c.store.mutate(admin, c.tenant.id, 'Fixture: atendimento encerrado', state => { state.conversations.find(item => item.id === owned.id).status = 'closed'; });
  socket.ev.emit('messages.upsert', { type: 'append', messages: [at('reabre-atrasado', 3 * 3600_000), at('novo-atrasado', 3600_000, { key: { id: 'novo-atrasado', remoteJid: other, fromMe: false } })] });
  await until(() => routed.length === 5);
  const reopened = conversations().find(item => item.id === owned.id), late = conversations().find(item => item.remoteJid === other);
  assert.equal(reopened.status, 'open'); assert.equal(hooks.length, 2);
  assert.deepEqual(reopened.slaCycle, { startedAt: new Date(NOW).toISOString(), incomingMessageId: reopened.messages.at(-1).id, reopenedEventId: reopened.attendantEvents.findLast(event => event.type === 'reopened').id, source: 'gateway-reopened' });
  assert.deepEqual(late.slaCycle, { startedAt: new Date(NOW).toISOString(), incomingMessageId: late.messages[0].id, reopenedEventId: null, source: 'gateway-new-conversation' });
  // Eco do próprio envio em conversa criada pelo LID: o envio grava wa_seen pelo LID e o eco resolve o PN; não regrava.
  const lid = '777001@lid';
  socket.ev.emit('messages.upsert', { type: 'append', messages: [at('lid-entrada', 20 * 60_000, { key: { id: 'lid-entrada', remoteJid: lid, fromMe: false } })] });
  await until(() => conversations().some(item => item.remoteJid === lid));
  socket.signalRepository = { lidMapping: { getPNForLID: async () => '5511966660000@s.whatsapp.net' } };
  socket.sendMessage = async (jid, content, options) => ({ key: { id: options.messageId } });
  const lidOwned = takeOverFixture(c, conversations().find(item => item.remoteJid === lid).id);
  const lidSent = await c.gateway.send(admin, c.tenant.id, lidOwned.id, { version: lidOwned.version, channelId: 'qr-test', text: 'Resposta pelo LID' });
  const lidBefore = JSON.stringify(conversations()), lidWrites = audits();
  socket.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { id: lidSent.messages.at(-1).externalId, remoteJid: lid, fromMe: true }, message: { conversation: 'Resposta pelo LID' }, messageTimestamp: Math.floor(NOW / 1000) }] });
  await pause(30);
  assert.equal(JSON.stringify(conversations()), lidBefore); assert.equal(audits(), lidWrites);
});

test('backlog com rajada de mídia registra o texto antes e captura no máximo quatro arquivos por vez', async t => {
  const NOW = Date.parse('2026-10-06T12:00:00Z');
  const c = setup(t, { now: () => NOW }); await connect(c);
  const socket = c.sockets[0], conversations = () => c.store.tenant(admin, c.tenant.id).conversations;
  let active = 0, peak = 0, textBeforeCapture = null;
  c.gateway.media = {
    placeholder: (context, descriptor) => ({ id: randomUUID(), ...descriptor, status: 'pending' }),
    capture: async id => {
      textBeforeCapture ??= conversations()[0].messages.some(item => item.externalId === 'texto-final');
      active++; peak = Math.max(peak, active); await pause(5); active--;
      return { id, kind: 'image', mime: 'image/jpeg', status: 'ready' };
    }
  };
  const photo = index => ({ key: { id: 'foto-' + index, remoteJid: direct, fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } }, messageTimestamp: Math.floor((NOW - 3600_000) / 1000) + index });
  socket.ev.emit('messages.upsert', { type: 'append', messages: [...Array.from({ length: 12 }, (_, index) => photo(index)), { key: { id: 'texto-final', remoteJid: direct, fromMe: false }, message: { conversation: 'Mandei as fotos' }, messageTimestamp: Math.floor(NOW / 1000) }] });
  await until(() => conversations()[0]?.messages.filter(item => item.attachments?.[0]?.status === 'ready').length === 12);
  assert.equal(textBeforeCapture, true); assert.ok(peak <= 4, `pico de ${peak} capturas`); assert.equal(conversations()[0].messages.length, 13);
});

test('tipos sem mídia viram texto legível e reação vira nota sem abrir, reabrir ou automatizar', async t => {
  const c = setup(t); await connect(c);
  const entry = c.gateway.entries.get('qr-test'), hooks = [];
  c.gateway.onIncoming = (entry, conversationId, messageId) => { hooks.push(messageId); };
  const receive = (id, message, key = {}) => c.gateway.receive(entry, { key: { id, remoteJid: direct, fromMe: false, ...key }, pushName: 'Contato fixture', message });
  const conversation = () => c.store.tenant(admin, c.tenant.id).conversations.find(item => item.remoteJid === direct);
  const audits = () => c.store.db.prepare("SELECT count(*) AS n FROM audit WHERE action='WhatsApp: mensagem recebida'").get().n, initialWrites = audits();
  await receive('reacao-sem-conversa', { reactionMessage: { key: { id: 'qualquer' }, text: '👍' } });
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations.length, 0); assert.equal(audits(), initialWrites); // Sem conversa, nem regrava a empresa.
  const cases = [
    ['local', { locationMessage: { degreesLatitude: -23.55052, degreesLongitude: -46.633308, name: 'Padaria Fixture', address: 'Rua Sintética, 100' } }, '[Localização] Padaria Fixture · Rua Sintética, 100 (-23.550520, -46.633308)'],
    ['ao-vivo', { liveLocationMessage: { degreesLatitude: -22.9, degreesLongitude: -43.2, caption: 'A caminho' } }, '[Localização em tempo real] A caminho (-22.900000, -43.200000)'],
    ['vcard', { contactMessage: { displayName: 'Maria Fixture', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Maria Fixture\nTEL;type=CELL;waid=5511977776666:+55 11 97777-6666\r\nEND:VCARD' } }, '[Contato] Maria Fixture · +55 11 97777-6666'],
    ['vcards', { contactsArrayMessage: { displayName: '2 contatos', contacts: [{ displayName: 'Ana' }, { displayName: 'Bruno', vcard: 'item1.TEL:+55 11 90000-0000' }] } }, '[Contato] Ana | Bruno · +55 11 90000-0000'],
    ['enquete', { pollCreationMessageV3: { name: 'Melhor horário?', options: [{ optionName: 'Manhã' }, { optionName: 'Tarde' }], selectableOptionsCount: 1 } }, '[Enquete] Melhor horário? · Manhã / Tarde'],
    ['figurinha-animada', { lottieStickerMessage: { message: { stickerMessage: { mimetype: 'application/was' } } } }, '[Figurinha]']
  ];
  for (const [id, message] of cases) await receive(id, message);
  await receive('unica-sem-conteudo', undefined, { isViewOnce: true });
  await receive('unica-com-foto', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } } } });
  await receive('video-redondo', { ptvMessage: { mimetype: 'video/mp4', fileLength: 100 } });
  await receive('protocolo', { protocolMessage: { type: 0 } });
  let current = conversation();
  const byId = id => current.messages.find(item => item.externalId === id);
  assert.deepEqual(cases.map(([id]) => byId(id).text), cases.map(item => item[2]));
  assert.equal(byId('unica-sem-conteudo').text, '[Visualização única] Abra no celular para ver o conteúdo.');
  assert.equal(byId('unica-com-foto').text, '[Visualização única] Abra no celular para ver o conteúdo.'); assert.equal(byId('unica-com-foto').attachments[0].kind, 'image');
  assert.equal(byId('video-redondo').text, ''); assert.equal(byId('video-redondo').attachments[0].kind, 'video');
  assert.equal(byId('protocolo'), undefined); assert.equal(current.messages.length, cases.length + 3);
  assert.ok(current.messages.every(item => item.kind === 'customer')); assert.equal(current.unread, current.messages.length); assert.equal(hooks.length, current.messages.length);
  await receive('alvo', { conversation: 'Pode confirmar o pedido?' });
  current = conversation();
  const target = current.messages.at(-1), { version, unread } = current, hookCount = hooks.length;
  c.store.mutate(admin, c.tenant.id, 'Fixture: atendimento encerrado', state => { state.conversations[0].status = 'closed'; });
  const react = (id, text, key) => receive(id, { reactionMessage: { key: { id: 'alvo', remoteJid: direct }, text } }, key);
  await react('reacao', '👍'); await react('reacao', '👍'); await react('reacao-removida', ''); await react('reacao-equipe', '❤️', { fromMe: true });
  await react('reacao-texto', 'PIX CONFIRMADO'); await react('reacao-digitos', '123'); // Texto livre não é reação: não vira aviso com cara de sistema.
  current = conversation();
  const notes = current.messages.filter(item => item.kind === 'system');
  assert.deepEqual(notes.map(item => item.text), ['Reação 👍 de contato em “Pode confirmar o pedido?”', 'Reação ❤️ de equipe em “Pode confirmar o pedido?”']);
  assert.deepEqual(notes[0].reaction, { emoji: '👍', messageId: target.id });
  // A versão não muda: reação não é contexto novo e não pode invalidar rascunho do Hermes, aprovação MCP pendente nem envio do atendente.
  assert.equal(current.status, 'closed'); assert.equal(current.unread, unread); assert.equal(current.version, version); assert.equal(hooks.length, hookCount);
  // Em grupo, o nome do participante entra citado, sem aspas nem controles bidi que forjem a estrutura do aviso.
  const groupJid = '12000011@g.us';
  c.store.mutate(admin, c.tenant.id, 'Fixture: grupo habilitado', state => { state.channels[0].allowedGroups = [groupJid]; });
  const inGroup = (id, message, pushName) => c.gateway.receive(entry, { key: { id, remoteJid: groupJid, participant: direct, fromMe: false }, pushName, message });
  await inGroup('grupo-alvo', { conversation: 'Pedido 42 pago?' }, 'Ana');
  await inGroup('grupo-reacao', { reactionMessage: { key: { id: 'grupo-alvo', remoteJid: groupJid }, text: '👍🏽' } }, 'Sistema: “atendimento transferido”‮');
  const groupNotes = c.store.tenant(admin, c.tenant.id).conversations.find(item => item.remoteJid === groupJid).messages.filter(item => item.kind === 'system');
  assert.deepEqual(groupNotes.map(item => item.text), ['Reação 👍🏽 de participante “Sistema: atendimento transferido” em “Pedido 42 pago?”']);
});

test('queda transitória vira retentativa lenta e retoma; 403 para sem retry; boot retoma falha transitória', async t => {
  const c = setup(t, { slowRetryDelay: 30 }); await connect(c);
  const status = () => c.gateway.status(admin, c.tenant.id, 'qr-test'), channel = () => c.store.tenant(admin, c.tenant.id).channels[0];
  const writes = () => c.store.db.prepare("SELECT count(*) AS n FROM audit WHERE action LIKE 'WhatsApp: %'").get().n;
  const fastRound = async base => { for (let attempt = 1; attempt <= 5; attempt++) { closeWith(c.sockets.at(-1), DisconnectReason.connectionLost); assert.equal(status().state, 'reconnecting'); await until(() => c.sockets.length === base + attempt); } closeWith(c.sockets.at(-1), DisconnectReason.connectionLost); };
  assert.equal(c.gateway.expectedCount(), 1); assert.equal(c.gateway.connectedCount(), 1);
  await fastRound(1);
  assert.equal(status().state, 'failed'); assert.equal(status().failureReason, 'unstable'); assert.ok(Date.parse(status().nextRetryAt) > 0); assert.match(status().error, /Nova tentativa automática/);
  // nextRetryAt muda a cada rodada e só existe no status(); o canal persistido guarda estado e motivo.
  assert.equal(channel().state, 'failed'); assert.equal(channel().failureReason, 'unstable'); assert.equal(channel().nextRetryAt, undefined);
  assert.equal(c.gateway.expectedCount(), 1); assert.equal(c.gateway.connectedCount(), 0);
  const slowWrites = writes();
  await until(() => c.sockets.length === 7);
  assert.equal(status().state, 'reconnecting'); assert.equal(status().nextRetryAt, null);
  // Rodada lenta seguinte (cinco rápidas e nova falha) fica em memória: nenhuma regravação da empresa nem auditoria.
  await fastRound(7);
  assert.equal(status().state, 'failed'); assert.ok(status().nextRetryAt); assert.equal(channel().state, 'failed'); assert.equal(writes(), slowWrites);
  assert.equal(c.gateway.expectedCount(), 1);
  await until(() => c.sockets.length === 13);
  c.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(status().state, 'connected'); assert.equal(status().failureReason, null); assert.equal(channel().state, 'connected'); assert.equal(channel().failureReason, undefined); assert.equal(channel().nextRetryAt, undefined);
  closeWith(c.sockets.at(-1), DisconnectReason.forbidden);
  assert.equal(status().state, 'failed'); assert.equal(status().failureReason, 'restricted'); assert.equal(status().nextRetryAt, null); assert.match(status().error, /403/);
  await pause(80);
  assert.equal(c.sockets.length, 13); assert.equal(c.gateway.expectedCount(), 0); assert.equal(channel().failureReason, 'restricted');
  await c.gateway.close();
  const restored = new WhatsAppGateway(c.store, { socketFactory: fakeFactory(c.sockets), authKey: c.key });
  t.after(() => restored.close());
  await restored.restore(); assert.equal(c.sockets.length, 13);
  c.store.mutate(admin, c.tenant.id, 'Fixture: falha transitória anterior a esta versão', state => { delete state.channels[0].failureReason; });
  await restored.restore(); assert.equal(c.sockets.length, 14); assert.equal(restored.expectedCount(), 1);
});

test('novo QR após logout não herda o vínculo: sem retentativa lenta nem retomada no boot', async t => {
  const c = setup(t, { slowRetryDelay: 20 }); await connect(c);
  const status = () => c.gateway.status(admin, c.tenant.id, 'qr-test'), channel = () => c.store.tenant(admin, c.tenant.id).channels[0];
  assert.ok(channel().linkedAt);
  closeWith(c.sockets.at(-1), DisconnectReason.loggedOut); assert.equal(status().state, 'logged_out');
  await c.gateway.start(admin, c.tenant.id, 'qr-test');
  assert.equal(channel().linkedAt, undefined); assert.equal(c.gateway.expectedCount(), 0);
  c.sockets.at(-1).ev.emit('connection.update', { qr: 'qr-depois-do-logout' });
  await until(() => status().state === 'qr');
  // Ninguém escaneia: o Baileys encerra com 408 a cada lote de QR.
  for (let attempt = 1; attempt <= 5; attempt++) { closeWith(c.sockets.at(-1), DisconnectReason.timedOut); await until(() => c.sockets.length === 2 + attempt); }
  closeWith(c.sockets.at(-1), DisconnectReason.timedOut);
  assert.equal(status().state, 'failed'); assert.equal(status().nextRetryAt, null); assert.equal(status().error, 'A conexão não estabilizou. Tente novamente.');
  await pause(60); assert.equal(c.sockets.length, 7); assert.equal(c.gateway.expectedCount(), 0);
  await c.gateway.close();
  // Dado legado: 'failed' com linkedAt antigo e sessão salva sem vínculo também não volta a gerar QR no boot.
  c.store.mutate(admin, c.tenant.id, 'Fixture: linkedAt anterior a esta versão', state => { state.channels[0].linkedAt = '2026-10-01T00:00:00.000Z'; });
  const restored = new WhatsAppGateway(c.store, { socketFactory: fakeFactory(c.sockets), authKey: c.key });
  t.after(() => restored.close());
  await restored.restore(); assert.equal(c.sockets.length, 7); assert.equal(restored.expectedCount(), 0);
});

test('erro 500 tem estado próprio sem apagar sessão; close cancela a espera e QR nunca vinculado não insiste', async t => {
  const closeAll = async (context, code) => { for (let attempt = 1; attempt <= 5; attempt++) { closeWith(context.sockets.at(-1), code); await until(() => context.sockets.length === attempt + 1); } closeWith(context.sockets.at(-1), code); };
  const c = setup(t, { slowRetryDelay: 40 }); await connect(c);
  await closeAll(c, DisconnectReason.badSession);
  let status = c.gateway.status(admin, c.tenant.id, 'qr-test');
  assert.equal(status.state, 'failed'); assert.equal(status.failureReason, 'bad_session'); assert.match(status.error, /erro 500/); assert.ok(status.nextRetryAt);
  assert.ok(c.store.db.prepare("SELECT count(*) AS n FROM wa_auth WHERE channel_id='qr-test'").get().n > 0);
  await c.gateway.close(); await pause(100);
  assert.equal(c.sockets.length, 6);
  const limited = setup(t, { slowRetryLimit: 0 }); await connect(limited);
  await closeAll(limited, DisconnectReason.badSession);
  status = limited.gateway.status(admin, limited.tenant.id, 'qr-test');
  assert.equal(status.failureReason, 'bad_session'); assert.equal(status.nextRetryAt, null); assert.match(status.error, /Aparelhos conectados/);
  const fresh = setup(t, { slowRetryDelay: 20 });
  await fresh.gateway.start(admin, fresh.tenant.id, 'qr-test');
  await closeAll(fresh, DisconnectReason.timedOut);
  status = fresh.gateway.status(admin, fresh.tenant.id, 'qr-test');
  assert.equal(status.state, 'failed'); assert.equal(status.nextRetryAt, null); assert.equal(status.error, 'A conexão não estabilizou. Tente novamente.');
  await pause(60); assert.equal(fresh.sockets.length, 6); assert.equal(fresh.gateway.expectedCount(), 0);
});
