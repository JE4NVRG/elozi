import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { GroupHistoryImporter, storedHistoryCursor } from '../src/group-history-import.js';

const PN = '5511988880000@s.whatsapp.net', LID = '123456789012345@lid', NUMBER = '5511999990000', SEC = Date.parse('2026-10-05T12:00:00Z') / 1000;
const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;
const tick = () => new Promise(resolve => setImmediate(resolve));
const raw = (id, timestamp, { jid = PN, fromMe = false, text = id } = {}) => ({ key: { remoteJid: jid, id, fromMe }, messageTimestamp: timestamp, pushName: 'Ana', message: { conversation: text } });

async function fixture(t, { messages = [] } = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'direct-history-admin', name: 'Admin RAM' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Histórico direto RAM', segment: 'QA' }), sockets = [], requests = [];
  store.mutate(admin, tenant.id, 'Conversa direta sintética', state => {
    state.channels = [{ id: 'wa', name: 'WhatsApp RAM', kind: 'whatsapp_qr', transport: 'baileys', expectedNumber: NUMBER, state: 'disconnected' }];
    state.contacts = [];
    state.conversations = [{ id: 'direct', channelId: 'wa', remoteJid: PN, remoteAliases: [PN, LID], conversationKind: 'direct', contact: 'Ana', version: 1, owner: 'human', assignedUserId: admin.userId, status: 'open', unread: 0, messages, updatedAt: new Date(SEC * 1000).toISOString() }];
  });
  const gateway = new WhatsAppGateway(store, { authKey: randomBytes(32), reconnectDelay: 60000, now: () => SEC * 1000, fetchImpl: () => assert.fail('Nenhuma rede externa.'), socketFactory: config => {
    const socket = { config, ev: new EventEmitter(), user: { id: NUMBER + ':1@s.whatsapp.net' }, end() {}, async logout() {},
      fetchMessageHistory: async (count, key, timestamp) => { const id = 'REQUEST_' + (requests.length + 1); requests.push({ id, count, key, timestamp }); return id; } };
    sockets.push(socket); return socket;
  } });
  const operations = new Operations(store, auth), hooks = { incoming: 0 };
  operations.routeIncoming = () => {}; gateway.operations = operations; gateway.onIncoming = () => { hooks.incoming++; };
  const importer = new GroupHistoryImporter(store, { authorize: (actor) => { store.admin(actor); auth.admin(actor); return true; },
    resolveConnection: (_actor, _tenantId, channelId) => gateway.entries.get(channelId),
    resolveCursor: (entry, scope) => storedHistoryCursor(scope.conversation) || entry.historyCursors?.get(scope.groupId), onCursor: (entry, groupId, cursor) => entry.historyCursors?.set(groupId, cursor) });
  gateway.historyImporter = importer;
  t.after(async () => { importer.close(); await gateway.close(); store.close(); });
  await gateway.start(admin, tenant.id, 'wa'); sockets[0].ev.emit('connection.update', { connection: 'open' }); await tick();
  const current = () => store.tenant(admin, tenant.id).conversations.find(item => item.id === 'direct');
  const body = (limit = 50) => ({ version: current().version, limit, commandId: randomUUID() });
  const history = items => ({ syncType: ON_DEMAND, peerDataRequestSessionId: requests.at(-1)?.id, messages: items });
  const settle = async () => { await tick(); await Promise.all([...gateway.historyTasks]); };
  return { store, admin, tenant, gateway, importer, sockets, requests, hooks, current, body, history, settle };
}

test('conversa direta: busca mensagens anteriores a partir da chave do WhatsApp guardada, aceita o LID e marca como histórico', async t => {
  const f = await fixture(t);
  assert.equal(f.importer.status(f.admin, f.tenant.id, 'direct').state, 'need_anchor', 'sem mensagem com chave do provedor não há ponto de partida');
  f.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [raw('LIVE_1', SEC)] }); await tick();
  let conversation = f.current();
  assert.equal(conversation.messages.at(-1).providerJid, PN); assert.equal(conversation.messages.at(-1).providerTs, SEC);
  const unread = conversation.unread, updatedAt = conversation.updatedAt;
  assert.equal(f.importer.status(f.admin, f.tenant.id, 'direct').state, 'idle');
  await f.importer.start(f.admin, f.tenant.id, 'direct', f.body());
  assert.deepEqual(f.requests[0].key, { remoteJid: PN, id: 'LIVE_1', fromMe: false }); assert.equal(f.requests[0].timestamp, SEC);
  f.sockets[0].ev.emit('messaging-history.set', f.history([raw('OLD_2', SEC - 200, { jid: LID }), raw('OLD_1', SEC - 300, { jid: LID, fromMe: true }), raw('OTHER', SEC - 250, { jid: '5511900000000@s.whatsapp.net' })]));
  await f.settle();
  conversation = f.current();
  assert.deepEqual(conversation.messages.map(message => message.externalId), ['OLD_1', 'OLD_2', 'LIVE_1'], 'em ordem, sem a mensagem de outra conversa');
  const [first, second] = conversation.messages;
  assert.equal(first.kind, 'human'); assert.equal(second.kind, 'customer'); assert.equal(first.imported, true); assert.equal(first.historySource, 'whatsapp-on-demand');
  assert.equal(first.providerJid, LID); assert.equal(first.providerTs, SEC - 300);
  assert.equal(conversation.unread, unread, 'histórico não vira não lida'); assert.equal(conversation.updatedAt, updatedAt, 'histórico não reordena a caixa');
  assert.equal(f.hooks.incoming, 1, 'histórico não dispara automações de entrada');
  assert.equal(storedHistoryCursor(conversation).key.id, 'OLD_1', 'a próxima busca começa na mais antiga');
  await f.importer.start(f.admin, f.tenant.id, 'direct', f.body());
  assert.deepEqual(f.requests.at(-1).key, { remoteJid: LID, id: 'OLD_1', fromMe: true });
});

test('conversa direta: mensagens antigas sem chave guardada nunca viram ponto de partida', async t => {
  const f = await fixture(t, { messages: [{ id: 'local', externalId: 'SEM_CHAVE', kind: 'customer', text: 'antes da versão', createdAt: new Date((SEC - 50) * 1000).toISOString() }] });
  assert.equal(storedHistoryCursor(f.current()), null);
  assert.equal(f.importer.status(f.admin, f.tenant.id, 'direct').state, 'need_anchor');
});
