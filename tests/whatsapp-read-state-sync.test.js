import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { proto, processSyncAction } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { createAttendanceService } from '../src/attendance.js';

const NOW = Date.parse('2026-10-20T14:00:00Z'), SEC = NOW / 1000, OWN = '5511999990000', PEER = '5511988880000@s.whatsapp.net';
const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'read-sync-admin', name: 'Admin sintético' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(t) {
  const store = new Store(':memory:'), sockets = [], keySets = [], resyncs = [], nativeReads = [], modifications = []; let clock = NOW;
  const tenant = store.createTenant(admin, { name: 'Leituras RAM', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Canal RAM', value => value.channels.push({ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', name: 'WhatsApp RAM', expectedNumber: OWN, state: 'disconnected', allowedGroups: [] }));
  const gateway = new WhatsAppGateway(store, { authKey: Buffer.alloc(32, 61), now: () => clock, socketFactory: config => {
    const socket = { config, ev: new EventEmitter(), user: { id: OWN + ':1@s.whatsapp.net' }, end() {}, async logout() {},
      authState: { creds: config.auth.creds, keys: { get: config.auth.keys.get, async set(value) { keySets.push(structuredClone(value)); return config.auth.keys.set(value); } } },
      async resyncAppState(collections, initial) { resyncs.push({ collections, initial }); await config.auth.keys.set({ 'app-state-sync-version': { regular_low: { version: 7, hash: Buffer.alloc(128), indexValueMap: {} } } }); },
      async readMessages(keys) { nativeReads.push(keys); }, async chatModify(change, jid) { modifications.push({ change, jid }); } };
    sockets.push(socket); return socket;
  } });
  await gateway.start(admin, tenant.id, 'wa'); const socket = sockets.at(-1);
  socket.config.auth.creds.me = { id: socket.user.id }; socket.ev.emit('creds.update', {}); socket.ev.emit('connection.update', { connection: 'open' }); await tick();
  const incoming = async (id = 'known', stamp = SEC - 10) => gateway.receive(gateway.entries.get('wa'), { key: { id, remoteJid: PEER, fromMe: false }, messageTimestamp: stamp, message: { conversation: 'Mensagem sintética em RAM.' } });
  const conversation = () => store.tenant(admin, tenant.id).conversations[0];
  const readAction = ({ id = 'known', stamp = SEC - 10, readAt = clock } = {}) => {
    const syncAction = proto.SyncActionData.decode(proto.SyncActionData.encode(proto.SyncActionData.fromObject({ value: { timestamp: readAt, markChatAsReadAction: { read: true,
      messageRange: { lastMessageTimestamp: stamp, messages: [{ key: { id, remoteJid: PEER, fromMe: false }, timestamp: stamp }] } } } })).finish());
    processSyncAction({ index: ['markChatAsRead', PEER], syncAction }, socket.ev, { id: OWN + '@s.whatsapp.net' }, { accountSettings: {} }, socket.config.logger);
  };
  const sync = options => gateway.syncDeviceReadState(admin, tenant.id, 'wa', options);
  const regenerate = (version = 7) => socket.config.auth.keys.set({ 'app-state-sync-version': { regular_low: { version, hash: Buffer.alloc(128), indexValueMap: {} } } });
  const responsible = () => store.mutate(admin, tenant.id, 'Responsável RAM', value => { value.conversations[0].owner = 'human'; value.conversations[0].assignedUserId = admin.userId; });
  const native = options => gateway.syncReadToDevice(admin, tenant.id, conversation().id, { version: conversation().version, channelId: 'wa' }, options);
  t.after(async () => { await gateway.close(); store.close(); });
  return { store, tenant, gateway, socket, sockets, keySets, resyncs, nativeReads, modifications, incoming, conversation, readAction, sync, regenerate, responsible, native, setNow: value => { clock = value; } };
}

test('consulta administrativa força somente regular_low e conta conversas com cursor validado, sem tocar QR ou mensagens', async t => {
  const c = await fixture(t); await c.incoming(); const before = structuredClone(c.conversation()), credentialsHash = hash(c.socket.config.auth.creds);
  c.socket.resyncAppState = async (collections, initial) => { c.resyncs.push({ collections, initial }); c.readAction(); c.readAction(); await c.regenerate(); };
  assert.deepEqual(await c.sync(), { channelId: 'wa', state: 'synced', updatedConversations: 1 });
  assert.deepEqual(c.keySets, [{ 'app-state-sync-version': { regular_low: null } }]); assert.deepEqual(c.resyncs, [{ collections: ['regular_low'], initial: true }]);
  assert.equal(c.conversation().unread, 0); assert.equal(c.conversation().whatsappDeviceRead.source, 'app-state-snapshot');
  for (const field of ['messages','status','owner','assignedUserId','version','updatedAt']) assert.deepEqual(c.conversation()[field], before[field]);
  assert.equal(hash(c.socket.config.auth.creds), credentialsHash); assert.equal(c.nativeReads.length, 0); assert.equal(c.modifications.length, 0);
  assert.equal(c.gateway.entries.get('wa').deviceReadStateSync, undefined);
});

test('snapshot sem âncora local ou anterior à marcação manual não conta atualização nem limpa não lida', async t => {
  const c = await fixture(t); await c.incoming(); c.setNow(NOW + 1000);
  createAttendanceService(c.store, { authorize: () => true, now: () => NOW + 1000 }).readState(admin, c.tenant.id, c.conversation().id, { version: c.conversation().version, unread: true });
  c.socket.resyncAppState = async () => { c.readAction({ id: 'unknown' }); c.readAction({ readAt: NOW }); await c.regenerate(); };
  assert.deepEqual(await c.sync(), { channelId: 'wa', state: 'synced', updatedConversations: 0 }); assert.equal(c.conversation().unread, 1);
});

test('operador, suporte, tenant errado, número alterado e canal desativado não limpam cache', async t => {
  const c = await fixture(t); await c.incoming();
  await assert.rejects(c.gateway.syncDeviceReadState({ ...admin, role: 'operator', tenantIds: [c.tenant.id] }, c.tenant.id, 'wa'), error => error.status === 403);
  await assert.rejects(c.gateway.syncDeviceReadState({ ...admin, supportGrantId: 'temporary' }, c.tenant.id, 'wa'), error => error.status === 403);
  const other = c.store.createTenant(admin, { name: 'Outro tenant RAM', segment: 'Teste' });
  await assert.rejects(c.gateway.syncDeviceReadState(admin, other.id, 'wa'), error => [404,409].includes(error.status));
  c.socket.user.id = '5511999990001:1@s.whatsapp.net'; await assert.rejects(c.sync(), error => error.status === 409); c.socket.user.id = OWN + ':1@s.whatsapp.net';
  c.store.mutate(admin, c.tenant.id, 'Canal RAM suspenso', tenant => { tenant.channels.find(channel => channel.id === 'wa').enabled = false; });
  await assert.rejects(c.sync(), error => error.status === 409); assert.equal(c.keySets.length, 0); assert.equal(c.resyncs.length, 0);
});

test('reautorização void é aceita e revogação após reset impede o segundo dispatch', async t => {
  const c = await fixture(t); let revoked = false;
  const original = c.socket.authState.keys.set;
  c.socket.authState.keys.set = async value => { await original(value); revoked = true; };
  assert.deepEqual(await c.sync({ reauthorize() { if (revoked) throw Object.assign(new Error('Denied'), { status: 403 }); } }), { channelId: 'wa', state: 'pending', updatedConversations: 0 });
  assert.equal(c.keySets.length, 1); assert.equal(c.resyncs.length, 0); assert.equal(c.gateway.entries.get('wa').deviceReadStateSync, undefined);
});

test('socket substituído entre etapas impede resync e exige novo vínculo confirmado', async t => {
  const c = await fixture(t), original = c.socket.authState.keys.set;
  c.socket.authState.keys.set = async value => { await original(value); await c.gateway.openSocket(c.gateway.entries.get('wa')); };
  assert.deepEqual(await c.sync(), { channelId: 'wa', state: 'pending', updatedConversations: 0 }); assert.equal(c.resyncs.length, 0); assert.equal(c.gateway.entries.get('wa').matched, false);
});

test('timeout mantém single-flight real e bloqueia resync e leitura nativa até SDK liquidar', async t => {
  const c = await fixture(t); await c.incoming(); c.responsible(); const waiting = deferred(); let expire;
  c.socket.resyncAppState = async (collections, initial) => { c.resyncs.push({ collections, initial }); await waiting.promise; await c.regenerate(); };
  const first = c.sync({ setTimeoutImpl: callback => { expire = callback; return 1; }, clearTimeoutImpl() {} }); await tick(); expire();
  assert.deepEqual(await first, { channelId: 'wa', state: 'pending', updatedConversations: 0 });
  await assert.rejects(c.sync(), error => error.status === 409); await assert.rejects(c.native(), error => error.status === 409);
  assert.equal(c.keySets.length, 1); assert.equal(c.resyncs.length, 1); assert.equal(c.nativeReads.length, 0);
  waiting.resolve(); await tick(); assert.equal(c.gateway.entries.get('wa').deviceReadStateSync, undefined);
  assert.deepEqual(await c.sync(), { channelId: 'wa', state: 'synced', updatedConversations: 0 }); assert.equal(c.resyncs.length, 2);
});

test('leitura nativa pendente impede reset da coleção e não emite resync concorrente', async t => {
  const c = await fixture(t); await c.incoming(); c.responsible(); const waiting = deferred();
  c.socket.readMessages = async keys => { c.nativeReads.push(keys); await waiting.promise; };
  const first = c.native(); await tick(); await assert.rejects(c.sync(), error => error.status === 409);
  assert.equal(c.keySets.length, 0); assert.equal(c.resyncs.length, 0); waiting.resolve(); assert.deepEqual(await first, { state: 'synced' });
});

test('prazo administrativo é limitado e falha de provider não expõe conteúdo privado nem repete', async t => {
  const c = await fixture(t); await assert.rejects(c.sync({ timeoutMs: 60001 }), error => error.status === 400);
  c.socket.resyncAppState = async () => { c.resyncs.push({}); throw new Error('Synthetic-private-provider-payload'); };
  const result = await c.sync(); assert.deepEqual(result, { channelId: 'wa', state: 'pending', updatedConversations: 0 });
  assert.doesNotMatch(JSON.stringify(result), /Synthetic-private|jid|key|message|token/); assert.equal(c.resyncs.length, 1);
});

test('SDK resolver sem reconstruir a versão regular_low não confirma a consulta', async t => {
  const c = await fixture(t); c.socket.resyncAppState = async (collections, initial) => { c.resyncs.push({ collections, initial }); };
  assert.deepEqual(await c.sync(), { channelId: 'wa', state: 'pending', updatedConversations: 0 });
  assert.equal(c.resyncs.length, 1); assert.deepEqual(await c.socket.authState.keys.get('app-state-sync-version', ['regular_low']), { regular_low: null });
});

test('reautoriza depois da leitura da versão privada e não confirma acesso revogado nesse await', async t => {
  const c = await fixture(t), original = c.socket.authState.keys.get; let revoked = false;
  c.socket.authState.keys.get = async (type, ids) => { const result = await original(type, ids); revoked = true; return result; };
  assert.deepEqual(await c.sync({ reauthorize() { if (revoked) throw Object.assign(new Error('Revoked'), { status: 403 }); } }), { channelId: 'wa', state: 'pending', updatedConversations: 0 });
});

for (const version of [0, -1, '7', null, 1.5]) test(`versão reconstruída inválida ${String(version)} mantém a consulta pendente`, async t => {
  const c = await fixture(t); c.socket.resyncAppState = async () => { await c.regenerate(version); };
  assert.deepEqual(await c.sync(), { channelId: 'wa', state: 'pending', updatedConversations: 0 });
});
