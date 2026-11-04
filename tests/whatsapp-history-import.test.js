import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { GroupHistoryImporter } from '../src/group-history-import.js';

const JID = '12000001@g.us', OTHER = '12000002@g.us', NUMBER = '5511999990000', SEC = Date.parse('2026-10-05T12:00:00Z') / 1000;
const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;
const tick = () => new Promise(resolve => setImmediate(resolve));
const raw = (id, timestamp = SEC, extra = {}) => ({ key: { remoteJid: JID, id, fromMe: false, participant: '5511988880000@s.whatsapp.net' }, messageTimestamp: timestamp, pushName: 'Pessoa sintética', message: { conversation: id }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'gateway-history-admin', name: 'Admin RAM' }, Buffer.alloc(16, 2), Buffer.alloc(64, 2), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Importação gateway RAM', segment: 'QA' }), sockets = [], requests = [];
  store.mutate(admin, tenant.id, 'Grupo selecionado sintético', state => {
    state.channels = [{ id: 'wa', name: 'WhatsApp RAM', kind: 'whatsapp_qr', transport: 'baileys', expectedNumber: NUMBER, state: 'disconnected', allowedGroups: [JID], groupNames: { [JID]: 'Grupo escolhido' }, whatsappGroupsVersion: 1 }];
    state.contacts = [];
    state.conversations = [{ id: 'group', channelId: 'wa', remoteJid: JID, conversationKind: 'group', version: 1, owner: 'human', assignedUserId: admin.userId, status: 'open', unread: 0, messages: [], updatedAt: new Date(SEC * 1000).toISOString() }];
  });
  const gateway = new WhatsAppGateway(store, { authKey: randomBytes(32), reconnectDelay: 60000, now: () => SEC * 1000, fetchImpl: () => assert.fail('Nenhuma rede externa.'), downloadMediaImpl: () => assert.fail('Não baixar mídia histórica.'), socketFactory: config => {
    const socket = { config, ev: new EventEmitter(), user: { id: NUMBER + ':1@s.whatsapp.net' }, ends: 0, logouts: 0, sends: [], end() { this.ends++; }, async logout() { this.logouts++; },
      groupFetchAllParticipating: async () => ({ [JID]: { id: JID, subject: 'Grupo escolhido' }, [OTHER]: { id: OTHER, subject: 'Grupo não habilitado' } }),
      fetchMessageHistory: async (count, key, timestamp) => { const id = 'NATIVE_REQUEST_' + (requests.length + 1); requests.push({ id, count, key, timestamp }); return id; },
      sendMessage: async (jid, payload, options) => { socket.sends.push({ jid, payload, options }); return { key: { remoteJid: jid, fromMe: true, id: options.messageId }, messageTimestamp: SEC, message: { conversation: payload.text } }; }
    }; sockets.push(socket); return socket;
  } });
  const operations = new Operations(store, auth), hooks = { incoming: 0, route: 0, placeholder: 0, capture: 0 };
  operations.routeIncoming = () => { hooks.route++; }; gateway.operations = operations; gateway.onIncoming = () => { hooks.incoming++; };
  gateway.media = { placeholder() { hooks.placeholder++; assert.fail('Importação não cria placeholder nativo.'); }, capture() { hooks.capture++; assert.fail('Importação não captura bytes.'); } };
  const importer = new GroupHistoryImporter(store, { authorize: (actor, tenantId, conversation) => { store.admin(actor); auth.admin(actor); operations.permission(actor, 'inbox.read', { tenantId, channelId: conversation.channelId, departmentId: 'unassigned' }); return true; },
    resolveConnection: (_actor, _tenantId, channelId) => gateway.entries.get(channelId), resolveCursor: (entry, scope) => entry.historyCursors.get(scope.groupId), onCursor: (entry, groupId, cursor) => entry.historyCursors.set(groupId, cursor), now: () => SEC * 1000 });
  gateway.historyImporter = importer;
  t.after(async () => { importer.close(); await gateway.close(); store.close(); });
  await gateway.start(admin, tenant.id, 'wa'); sockets[0].ev.emit('connection.update', { connection: 'open' }); await tick();
  const entry = gateway.entries.get('wa'), current = () => store.tenant(admin, tenant.id), body = () => ({ version: current().conversations.find(c => c.id === 'group').version, limit: 50, commandId: randomUUID() });
  const notify = async message => { sockets.at(-1).ev.emit('messages.upsert', { type: 'notify', messages: [message] }); await tick(); };
  const start = async () => { await notify(raw('REAL_NOTIFY_ANCHOR', SEC, { key: { remoteJid: JID, id: 'REAL_NOTIFY_ANCHOR', fromMe: true } })); return importer.start(admin, tenant.id, 'group', body()); };
  const history = (messages, extra = {}) => ({ syncType: ON_DEMAND, peerDataRequestSessionId: requests.at(-1)?.id, messages, ...extra });
  const settle = async () => { await tick(); await Promise.all([...gateway.historyTasks]); };
  return { store, auth, admin, tenant, gateway, importer, sockets, requests, entry, hooks, current, body, notify, start, history, settle };
}

test('callback SDK rejeita bootstrap/RECENT/FULL e ON_DEMAND sem job, mantendo notify nativo', async t => {
  const f = await fixture(t), socket = f.sockets[0];
  assert.equal(socket.config.syncFullHistory, false);
  for (const syncType of [proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, proto.HistorySync.HistorySyncType.RECENT, proto.HistorySync.HistorySyncType.FULL, ON_DEMAND]) assert.equal(socket.config.shouldSyncHistoryMessage({ syncType, peerDataRequestSessionId: 'UNKNOWN' }), false);
  assert.equal(socket.config.shouldSyncHistoryMessage(), false);
  // 'append' recente é backlog offline e entra no atendimento; histórico antigo (além de 72 h) nunca entra por upsert.
  socket.ev.emit('messages.upsert', { type: 'append', messages: [raw('APPEND_IGNORED', SEC - 4 * 86400)] }); await f.settle(); assert.equal(f.current().conversations[0].messages.length, 0);
  await f.notify(raw('NORMAL_NOTIFY')); assert.equal(f.current().conversations[0].messages.length, 1); assert.equal(f.hooks.incoming, 1); assert.equal(f.hooks.route, 1);
  assert.equal(f.entry.historyCursors.get(JID).key.id, 'NORMAL_NOTIFY');
  assert.equal(f.importer.status(f.admin, f.tenant.id, 'group').state, 'idle');
});

test('ON_DEMAND correlacionado importa via listener separado sem unread, roteamento, hooks ou download', async t => {
  const f = await fixture(t); await f.start(); const socket = f.sockets[0];
  f.store.mutate(f.admin, f.tenant.id, 'Atendimento fechado preservado', tenant => { tenant.conversations[0].status = 'closed'; tenant.conversations[0].unread = 4; });
  const before = f.current().conversations[0], event = f.history([raw('HISTORICAL', SEC - 100), raw('HISTORICAL_IMAGE', SEC - 200, { message: { imageMessage: { caption: 'Foto histórica indisponível', mimetype: 'image/jpeg', fileLength: 512, url: 'https://private.invalid', mediaKey: Buffer.from('synthetic-private-key') } } })]);
  assert.equal(socket.config.shouldSyncHistoryMessage(event), true);
  assert.equal(socket.config.shouldSyncHistoryMessage({ ...event, peerDataRequestSessionId: 'OTHER' }), false);
  assert.equal(socket.config.shouldSyncHistoryMessage({ ...event, syncType: proto.HistorySync.HistorySyncType.RECENT }), false);
  socket.ev.emit('messaging-history.set', event); await f.settle();
  const after = f.current().conversations[0]; assert.equal(after.messages.length, 3); assert.equal(after.version, before.version + 1);
  assert.deepEqual({ ...after, messages: before.messages, version: before.version }, before); assert.deepEqual(f.hooks, { incoming: 0, route: 0, placeholder: 0, capture: 0 });
  assert.equal(after.messages.find(m => m.externalId === 'HISTORICAL_IMAGE').attachments[0].status, 'unavailable');
  assert.equal(f.importer.status(f.admin, f.tenant.id, 'group').state, 'completed');
  assert.equal(socket.config.shouldSyncHistoryMessage(event), false);
  socket.ev.emit('messaging-history.set', event); await f.settle(); assert.deepEqual(f.current().conversations[0], after);
});

test('somente notify de grupo selecionado com key/timestamp reais gera âncora; mensagens locais não bastam', async t => {
  const f = await fixture(t), socket = f.sockets[0];
  await f.notify(raw('UNKNOWN_GROUP', SEC, { key: { remoteJid: OTHER, id: 'UNKNOWN_GROUP', fromMe: false } }));
  await f.notify(raw('NO_TIMESTAMP', undefined, { messageTimestamp: undefined }));
  await f.notify(raw('NO_FROM_ME', SEC, { key: { remoteJid: JID, id: 'NO_FROM_ME' } }));
  await f.notify(raw('DIRECT', SEC, { key: { remoteJid: '5511988880000@s.whatsapp.net', id: 'DIRECT', fromMe: false } }));
  assert.equal(f.entry.historyCursors.size, 0); assert.equal(f.importer.status(f.admin, f.tenant.id, 'group').state, 'need_anchor');
  await assert.rejects(f.importer.start(f.admin, f.tenant.id, 'group', f.body()), error => error.status === 409); assert.equal(f.requests.length, 0);
  socket.ev.emit('messages.upsert', { type: 'append', messages: [raw('OLD_APPEND', SEC)] }); await tick(); assert.equal(f.entry.historyCursors.size, 0);
  assert.ok(f.current().conversations.find(c => c.id === 'group').messages.some(message => message.externalId === 'OLD_APPEND')); // Registrado como backlog, sem virar âncora.
  await f.notify(raw('REAL_GROUP', SEC)); await f.notify(raw('DELAYED_OLDER', SEC - 100));
  assert.equal(f.entry.historyCursors.size, 1); assert.equal(f.entry.historyCursors.get(JID).key.id, 'REAL_GROUP');
  assert.equal(f.entry.historyCursors.get(JID).timestampSeconds, SEC);
});

test('retorno real de sendMessage gera cursor; key local ou resposta sem timestamp não o reconstrói', async t => {
  const f = await fixture(t), socket = f.sockets[0];
  socket.sendMessage = async (jid, payload, options) => { socket.sends.push({ jid, payload, options }); return { key: { id: 'REAL_SENT_PROVIDER_KEY', remoteJid: jid, fromMe: true }, messageTimestamp: SEC }; };
  await f.gateway.send(f.admin, f.tenant.id, 'group', { version: 1, channelId: 'wa', text: 'Âncora enviada sintética' });
  assert.deepEqual(f.entry.historyCursors.get(JID), { key: { remoteJid: JID, id: 'REAL_SENT_PROVIDER_KEY', fromMe: true }, timestampSeconds: SEC, timestampMs: SEC * 1000 });
  assert.equal(f.current().conversations[0].messages[0].externalId, 'REAL_SENT_PROVIDER_KEY');
  f.entry.historyCursors.clear(); socket.sendMessage = async () => ({ key: { id: 'ONLY_NATIVE_ID' } });
  await f.gateway.send(f.admin, f.tenant.id, 'group', { version: f.body().version, channelId: 'wa', text: 'Sem timestamp real' });
  assert.equal(f.current().conversations[0].messages.at(-1).externalId, 'ONLY_NATIVE_ID'); assert.equal(f.entry.historyCursors.size, 0);
  assert.equal(f.importer.status(f.admin, f.tenant.id, 'group').state, 'need_anchor'); assert.equal(f.requests.length, 0);
});

test('mudança de seleção invalida predicado e âncora, preservando histórico existente', async t => {
  const f = await fixture(t); await f.start(); const event = f.history([raw('UNSELECTED_HISTORY', SEC - 120)]), before = f.current().conversations;
  assert.equal(f.sockets[0].config.shouldSyncHistoryMessage(event), true);
  await f.gateway.setGroups(f.admin, f.tenant.id, 'wa', { version: 1, groupIds: [] });
  assert.equal(f.entry.historyCursors.size, 0); assert.equal(f.sockets[0].config.shouldSyncHistoryMessage(event), false);
  f.sockets[0].ev.emit('messaging-history.set', event); await f.settle(); assert.deepEqual(f.current().conversations, before); assert.equal(f.importer.active.size, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen WHERE message_id=?').get('UNSELECTED_HISTORY').count, 0);
});

test('revogação entre evento e execução da fila impede Store e não expõe erro privado', async t => {
  const f = await fixture(t); await f.start(); const before = f.current().conversations;
  f.sockets[0].ev.emit('messaging-history.set', f.history([raw('LATE_REVOKED', SEC - 100)]));
  f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(SEC * 1000, f.admin.userId);
  await f.settle(); assert.deepEqual(f.current().conversations, before); assert.equal(f.importer.active.size, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM wa_seen WHERE message_id=?').get('LATE_REVOKED').count, 0);
});

test('nova geração conserva auth sintética sem QR, cancela job e ignora callback/listener do socket antigo', async t => {
  const f = await fixture(t); await f.start(); const old = f.sockets[0], event = f.history([raw('STALE_HISTORY', SEC - 150)]), before = f.current().conversations;
  old.config.auth.creds.syntheticPreservedMarker = 'RAM marker'; old.ev.emit('creds.update');
  await f.gateway.openSocket(f.entry); const fresh = f.sockets[1]; fresh.ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(f.entry.historyCursors.size, 0); assert.equal(f.importer.active.size, 0); assert.equal(f.importer.status(f.admin, f.tenant.id, 'group').state, 'cancelled');
  assert.equal(fresh.config.auth.creds.syntheticPreservedMarker, 'RAM marker'); assert.equal(f.gateway.status(f.admin, f.tenant.id, 'wa').qr, null); assert.equal(old.logouts + fresh.logouts, 0);
  assert.equal(old.config.shouldSyncHistoryMessage(event), false); old.ev.emit('messaging-history.set', event); old.ev.emit('messages.upsert', { type: 'notify', messages: [raw('OLD_NOTIFY')] }); await f.settle();
  assert.deepEqual(f.current().conversations, before); assert.equal(f.entry.historyCursors.size, 0);
  await f.notify(raw('NEW_GENERATION_ANCHOR', SEC, { key: { remoteJid: JID, id: 'NEW_GENERATION_ANCHOR', fromMe: true } }));
  assert.equal(f.entry.historyCursors.get(JID).key.id, 'NEW_GENERATION_ANCHOR'); assert.equal(f.sockets.length, 2);
});

test('listener serializa chunks simultâneos e aceita somente a própria sessão, com efeito único', async t => {
  const f = await fixture(t); await f.start(); const socket = f.sockets[0];
  const last = f.history([raw('CHUNK_LAST', SEC - 200)], { chunkOrder: 1, progress: 100 });
  socket.ev.emit('messaging-history.set', last); socket.ev.emit('messaging-history.set', last);
  socket.ev.emit('messaging-history.set', f.history([raw('OTHER_SESSION', SEC - 300)], { peerDataRequestSessionId: 'UNKNOWN' }));
  socket.ev.emit('messaging-history.set', f.history([raw('CHUNK_FIRST', SEC - 100)], { chunkOrder: 0, progress: 50 }));
  await f.settle(); const messages = f.current().conversations[0].messages;
  assert.deepEqual(messages.filter(m => m.imported).map(m => m.externalId), ['CHUNK_LAST', 'CHUNK_FIRST']); assert.equal(messages.length, 3);
  assert.deepEqual(f.importer.status(f.admin, f.tenant.id, 'group').job.counters, { imported: 2, duplicates: 0, excluded: 0, requested: 50 });
  assert.equal(f.gateway.historyTasks.size, 0); assert.equal(f.hooks.incoming + f.hooks.route + f.hooks.capture, 0);
});

test('retorno de socket antigo após troca de geração não instala âncora na conexão nova', async t => {
  const f = await fixture(t), pending = deferred(), old = f.sockets[0]; old.sendMessage = () => pending.promise;
  const send = f.gateway.send(f.admin, f.tenant.id, 'group', { version: 1, channelId: 'wa', text: 'Retorno tardio sintético' }); await tick();
  await f.gateway.openSocket(f.entry); f.sockets[1].ev.emit('connection.update', { connection: 'open' }); await tick();
  pending.resolve({ key: { remoteJid: JID, fromMe: true, id: 'OLD_SOCKET_RESULT' }, messageTimestamp: SEC }); await send;
  assert.equal(f.entry.historyCursors.size, 0); assert.equal(f.importer.status(f.admin, f.tenant.id, 'group').anchor.available, false);
});

test('fechamento limpa mapas privados e drena eventos enfileirados antes de Store.close', async t => {
  const f = await fixture(t); await f.start(); const before = f.current().conversations;
  f.sockets[0].ev.emit('messaging-history.set', f.history([raw('CLOSING', SEC - 100)]));
  f.importer.close(); await f.gateway.close();
  assert.equal(f.entry.historyCursors.size, 0); assert.equal(f.importer.active.size, 0); assert.equal(f.gateway.historyTasks.size, 0); assert.deepEqual(f.current().conversations, before);
  assert.equal(f.sockets[0].config.shouldSyncHistoryMessage(f.history([])), false);
});
