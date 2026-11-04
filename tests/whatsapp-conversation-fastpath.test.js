// The real WhatsApp handler, createApp authorization, Outbox and ACK handlers with an in-memory database and socket.
// No provider/model/network is used, except the loopback REST request that exercises a real service principal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { createApp } from '../src/server.js';
import { syncIncomingConversationContact } from '../src/contacts.js';

const ownNumber = '5511999990000', jid = '5511988880000@s.whatsapp.net';
const tick = () => new Promise(resolve => setImmediate(resolve));
const status = expected => error => error.status === expected;

async function fixture(t) {
  const key = Buffer.alloc(32, 53), external = [], sockets = [];
  const deny = async () => { external.push(true); throw new Error('External I/O is forbidden in this fixture'); };
  const socketFactory = config => {
    const socket = { config, ev: new EventEmitter(), user: { id: ownNumber + ':1@s.whatsapp.net' }, sent: [], uncertain: false,
      end() {}, async logout() {} };
    socket.sendMessage = async (remoteJid, content, options) => {
      socket.sent.push({ remoteJid, content, options });
      if (socket.uncertain) throw new Error('Synthetic connection loss after dispatch');
      // A real socket may emit its own echo and receipt before sendMessage resolves.
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: options.messageId, remoteJid, fromMe: true }, message: { conversation: content.text } }] });
      socket.ev.emit('messages.update', [{ key: { id: options.messageId, remoteJid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } }]);
      return { key: { id: options.messageId, remoteJid, fromMe: true } };
    };
    sockets.push(socket); return socket;
  };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory, fetchImpl: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    telegramUserOptions: { authKey: key }, googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny },
    emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { store, auth } = app;
  const user = auth.insertUser({ username: 'conversation.fastpath', name: 'Synthetic administrator' }, Buffer.alloc(16, 9), Buffer.alloc(64, 9), 'reseller', [], 'mep-demo');
  const admin = auth.session(user).actor, tenant = store.createTenant(admin, { name: 'Scoped WhatsApp fixture', segment: 'Synthetic' });
  store.mutate(admin, tenant.id, 'Scoped WhatsApp fixture', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', name: 'Synthetic WhatsApp', expectedNumber: ownNumber, state: 'disconnected', defaultAgentId: 'ext' }];
    state.departments = [{ id: 'support', name: 'Support', active: true, distribution: 'manual', memberIds: [], cursor: 0, version: 1 }];
    state.defaultDepartmentId = 'support';
    state.agents = [{ id: 'ext', name: 'Synthetic external agent', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [{ id: 'target', channelId: 'wa', remoteJid: jid, contact: 'Synthetic contact', conversationKind: 'direct', department: 'Support', departmentId: 'support',
      owner: 'agent', agentId: 'ext', assignedUserId: null, status: 'open', version: 1, unread: 0, tags: [],
      messages: [{ id: 'seed', externalId: 'seed-provider', kind: 'customer', text: 'Qual o prazo?', createdAt: new Date().toISOString(), delivery: 'received', transport: 'whatsapp' }] },
    { id: 'untouched', channelId: 'wa', remoteJid: '5511977770000@s.whatsapp.net', contact: 'Other synthetic contact', conversationKind: 'direct', departmentId: 'support', owner: 'queue', status: 'open', version: 7, messages: [{ id: 'other-message', kind: 'customer', text: 'Outro atendimento', createdAt: new Date().toISOString() }] }];
    syncIncomingConversationContact(state, state.conversations[0], state.channels[0]);
  });
  await app.gateway.start(admin, tenant.id, 'wa');
  const socket = sockets[0];
  socket.config.auth.creds.me = { id: ownNumber + ':1@s.whatsapp.net' };
  socket.ev.emit('creds.update', {}); socket.ev.emit('connection.update', { connection: 'open' });
  await tick();
  const principal = app.servicePrincipals.create(admin, tenant.id, { name: 'Synthetic principal', agentId: 'ext', capabilities: ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'],
    channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 200, maxConcurrent: 3, ttlHours: 24 });
  const actor = app.servicePrincipals.authenticate('Bearer ' + principal.token);
  const original = { tenant: store.tenant.bind(store), mutate: store.mutate.bind(store), mutateConversation: store.mutateConversation.bind(store) };
  const calls = { reads: [], full: [], scoped: [], events: [] };
  store.tenant = (...args) => { calls.reads.push({ tenantId: args[1], stack: new Error('Full tenant read').stack.split('\n').slice(2, 10) }); return original.tenant(...args); };
  store.mutate = (...args) => { calls.full.push(args[2]); return original.mutate(...args); };
  store.mutateConversation = (...args) => { calls.scoped.push(args[3]); return original.mutateConversation(...args); };
  const unsubscribe = app.events.subscribe({ tenantId: tenant.id }, event => calls.events.push(event));
  const reset = () => { for (const list of Object.values(calls)) list.length = 0; };
  const state = () => original.tenant(admin, tenant.id);
  const conversation = () => store.getConversation(state(), 'target');
  const change = fn => original.mutate(admin, tenant.id, 'Fixture change', fn);
  const incoming = (id, remoteJid = jid) => ({ key: { id, remoteJid, fromMe: false }, message: { conversation: 'Qual o prazo?' }, messageTimestamp: Math.floor(Date.now() / 1000) });
  const receive = (id, remoteJid) => app.gateway.receive(app.gateway.entries.get('wa'), incoming(id, remoteJid));
  const reply = async input => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/service/v1/replies`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + principal.token }, body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    unsubscribe();
    store.tenant = original.tenant; store.mutate = original.mutate; store.mutateConversation = original.mutateConversation;
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.telegramUser.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'no external provider/model/network'); store.close();
  });
  reset();
  return { app, store, admin, tenant, principal, actor, socket, calls, reset, state, conversation, change, receive, incoming, reply, original };
}

test('existing WhatsApp input uses scoped transactions, audited pointers and wa_seen once; other conversations stay intact', async t => {
  const f = await fixture(t), before = f.state(), other = structuredClone(before.conversations[1]), contacts = structuredClone(before.contacts);
  await f.receive('incoming-scoped');
  const current = f.conversation(), message = current.messages.at(-1);
  assert.equal(current.version, 2); assert.equal(current.unread, 1);
  assert.equal(message.externalId, 'incoming-scoped'); assert.equal(message.automationReceipt.outcome, 'no-match');
  assert.deepEqual(f.state().contacts, contacts); assert.deepEqual(f.state().conversations[1], other);
  assert.deepEqual(f.calls.full, []); assert.deepEqual(f.calls.reads, []);
  assert.deepEqual(f.calls.scoped, ['WhatsApp: mensagem recebida', 'Entrada avaliada pela automação']);
  assert.equal(f.calls.events.filter(event => event.type === 'conversation.message' && event.messageId === message.id).length, 1);
  assert.ok(f.calls.events.every(event => !event.conversationId || event.conversationId === 'target'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE channel_id=? AND message_id=?').get('wa', 'incoming-scoped').n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=? AND action=?').get(f.tenant.id, 'WhatsApp: mensagem recebida').n, 1);
  const audits = f.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(f.tenant.id).n;
  f.reset(); await f.receive('incoming-scoped');
  assert.equal(f.conversation().messages.length, current.messages.length); assert.deepEqual(f.calls.scoped, []); assert.deepEqual(f.calls.full, []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(f.tenant.id).n, audits);
});

test('authenticated reply goes through API, real Outbox, WhatsApp and ACK once with scoped state', async t => {
  const f = await fixture(t), other = structuredClone(f.state().conversations[1]);
  await f.receive('before-api-reply'); f.reset();
  const input = { requestId: 'scoped_reply_0001', conversationId: 'target', version: f.conversation().version, text: 'Prazo sintético.' };
  const sent = await f.reply(input); await tick();
  assert.equal(sent.status, 200, sent.data.error); assert.equal(sent.data.receipt.state, 'confirmed');
  const current = f.conversation(), message = current.messages.at(-1);
  assert.equal(current.version, input.version + 1); assert.equal(message.delivery, 'read'); assert.equal(message.authorServiceId, f.principal.principal.id);
  assert.equal(f.socket.sent.length, 1); assert.equal(f.socket.sent[0].remoteJid, jid);
  assert.equal(message.serviceCommandId, 'service_' + sent.data.receipt.id);
  assert.deepEqual(f.state().conversations[1], other); assert.deepEqual(f.calls.full, []); assert.deepEqual(f.calls.reads, []);
  for (const action of ['WhatsApp: envio solicitado', 'WhatsApp: recibo de mensagem', 'WhatsApp: envio aceito']) assert.ok(f.calls.scoped.includes(action), action);
  const command = f.store.db.prepare('SELECT state,attempts FROM outbound_commands WHERE tenant_id=?').get(f.tenant.id);
  assert.equal(command.state, 'confirmed'); assert.equal(command.attempts, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE channel_id=? AND message_id=?').get('wa', message.externalId).n, 1);
  f.socket.ev.emit('messages.update', [{ key: { id: message.externalId, remoteJid: jid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.SERVER_ACK } }]);
  assert.equal(f.conversation().messages.at(-1).delivery, 'read', 'an older ACK cannot regress read');
  const replay = await f.reply(input);
  assert.equal(replay.status, 200); assert.equal(replay.data.receipt.id, sent.data.receipt.id); assert.equal(f.socket.sent.length, 1);
});

test('uncertain provider result keeps the same durable receipt/command and never repeats the send', async t => {
  const f = await fixture(t); f.socket.uncertain = true;
  const input = { requestId: 'scoped_uncertain_0001', conversationId: 'target', version: f.conversation().version, text: 'Resposta sintética.' };
  await assert.rejects(f.app.serviceApi.sendReply(f.actor, input), status(502));
  const receipt = f.app.serviceApi.readReceipt(f.actor, input.requestId).receipt;
  assert.equal(receipt.state, 'unknown'); assert.equal(f.conversation().messages.at(-1).delivery, 'unconfirmed');
  const command = f.store.db.prepare('SELECT id,idempotency_key,state,attempts FROM outbound_commands WHERE tenant_id=?').get(f.tenant.id);
  assert.equal(command.state, 'unknown'); assert.equal(command.attempts, 1); assert.equal(f.socket.sent.length, 1);
  await f.app.serviceApi.sendReply(f.actor, input).catch(() => {});
  assert.equal(f.app.serviceApi.readReceipt(f.actor, input.requestId).receipt.id, receipt.id);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbound_commands WHERE tenant_id=?').get(f.tenant.id).n, 1);
  assert.equal(f.socket.sent.length, 1); assert.deepEqual(f.calls.full, []);
});

test('the service authority is revalidated after an async boundary before the provider effect', async t => {
  const f = await fixture(t), before = f.conversation(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.app.outbox.beforeSend = async () => { entered(); await gate; };
  const sending = f.app.serviceApi.sendReply(f.actor, { requestId: 'scoped_revoke_0001', conversationId: 'target', version: before.version, text: 'Resposta sintética.' });
  await ready;
  f.app.servicePrincipals.revoke(f.admin, f.tenant.id, f.principal.principal.id, { revision: f.principal.principal.revision });
  release(); await assert.rejects(sending, error => [401, 403, 409].includes(error.status));
  assert.equal(f.socket.sent.length, 0); assert.equal(f.conversation().messages.length, before.messages.length);
});

test('a scoped input failure rolls back wa_seen, audit and events so the same provider message can be registered once', async t => {
  const f = await fixture(t), before = f.conversation(), audit = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const mutate = f.store.mutateConversation;
  f.store.mutateConversation = (...args) => {
    if (args[3] === 'WhatsApp: mensagem recebida') {
      const callback = args[4]; args[4] = (conversation, metadata) => { callback(conversation, metadata); throw new Error('Synthetic transaction failure'); };
    }
    return mutate(...args);
  };
  await assert.rejects(f.receive('rollback-input'), /Synthetic transaction failure/);
  assert.equal(f.conversation().messages.length, before.messages.length);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE message_id=?').get('rollback-input').n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audit); assert.deepEqual(f.calls.events, []);
  f.store.mutateConversation = mutate; await f.receive('rollback-input'); await f.receive('rollback-input');
  assert.equal(f.conversation().messages.filter(message => message.externalId === 'rollback-input').length, 1);
});

test('legacy duplicate conversation IDs keep the ACK of the second occurrence through the full fallback', async t => {
  const f = await fixture(t), remoteJid = '5511955550000@s.whatsapp.net';
  f.change(state => state.conversations.push({ ...structuredClone(state.conversations[0]), remoteJid, remoteAliases: [],
    messages: [{ id: 'legacy-outgoing', externalId: 'legacy-provider', kind: 'agent', transport: 'whatsapp', delivery: 'pending', text: 'Synthetic legacy reply', createdAt: new Date().toISOString() }] }));
  const first = structuredClone(f.state().conversations[0]); f.reset();
  f.socket.ev.emit('messages.update', [{ key: { id: 'legacy-provider', remoteJid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } }]);
  const duplicates = f.state().conversations.filter(conversation => conversation.id === 'target');
  assert.equal(duplicates.length, 2); assert.deepEqual(duplicates[0], first); assert.equal(duplicates[1].messages[0].delivery, 'read');
  assert.deepEqual(f.calls.full, ['WhatsApp: recibo de mensagem']); assert.deepEqual(f.calls.scoped, []);
});

for (const invalidId of [null, 7]) test(`a legacy non-string conversation ID (${invalidId}) keeps receipt reconciliation on the full path`, async t => {
  const f = await fixture(t);
  f.change(state => { const conversation = state.conversations[0]; conversation.id = invalidId; conversation.messages = [{ id: 'legacy-no-id', externalId: 'provider-no-id', kind: 'agent', transport: 'whatsapp', delivery: 'pending', text: 'Synthetic legacy reply', createdAt: new Date().toISOString() }]; });
  f.reset();
  assert.doesNotThrow(() => f.socket.ev.emit('messages.update', [{ key: { id: 'provider-no-id', remoteJid: jid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } }]));
  assert.equal(f.state().conversations[0].messages[0].delivery, 'read'); assert.deepEqual(f.calls.full, ['WhatsApp: recibo de mensagem']); assert.deepEqual(f.calls.scoped, []);
  assert.equal(f.socket.sent.length, 0);
});

for (const invalidId of [null, 0, 7, undefined, '']) test(`incoming input and reactions preserve a legacy ID (${String(invalidId)}) through the full handler exactly once`, async t => {
  const f = await fixture(t);
  f.change(state => { if (invalidId === undefined) delete state.conversations[0].id; else state.conversations[0].id = invalidId; });
  f.reset();
  const current = () => f.state().conversations.find(conversation => conversation.remoteJid === jid);
  const before = current(), other = structuredClone(f.state().conversations.find(conversation => conversation.id === 'untouched'));
  await f.receive('legacy-invalid-input'); await f.receive('legacy-invalid-input');
  const incoming = current().messages.find(message => message.externalId === 'legacy-invalid-input');
  assert.ok(incoming); assert.equal(current().messages.length, before.messages.length + 1);
  assert.equal(current().version, before.version + 1); assert.equal(current().unread, before.unread + 1);
  assert.equal(current().id, invalidId); assert.equal(f.state().conversations.length, 2);
  const reaction = { key: { id: 'legacy-invalid-reaction', remoteJid: jid, fromMe: false },
    message: { reactionMessage: { text: '👍', key: { id: 'legacy-invalid-input', remoteJid: jid, fromMe: false } } } };
  const entry = f.app.gateway.entries.get('wa');
  await f.app.gateway.receive(entry, reaction); await f.app.gateway.receive(entry, reaction);
  const note = current().messages.find(message => message.externalId === 'legacy-invalid-reaction');
  assert.ok(note); assert.equal(note.kind, 'system'); assert.equal(note.reaction.messageId, incoming.id);
  assert.equal(current().messages.length, before.messages.length + 2); assert.equal(current().version, before.version + 1); assert.equal(current().unread, before.unread + 1);
  assert.deepEqual(f.state().conversations.find(conversation => conversation.id === 'untouched'), other);
  assert.deepEqual(f.calls.scoped, []); assert.equal(f.calls.full.filter(action => action === 'WhatsApp: mensagem recebida').length, 2);
  for (const messageId of ['legacy-invalid-input', 'legacy-invalid-reaction']) assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE channel_id=? AND message_id=?').get('wa', messageId).n, 1);
  assert.equal(f.socket.sent.length, 0);
});

for (const replacement of [false, true]) test(`a conversation removed after ACK discovery reconciles current state once (replacement=${replacement})`, async t => {
  const f = await fixture(t);
  f.change(state => { state.conversations[0].messages = [{ id: 'removed-outgoing', externalId: 'removed-provider', kind: 'agent', transport: 'whatsapp', delivery: 'pending', text: 'Synthetic receipt', createdAt: new Date().toISOString() }]; });
  const method = typeof f.store.readonlyConversationTenant === 'function' ? 'readonlyConversationTenant' : 'conversationTenant';
  const originalRead = f.store[method], read = originalRead.bind(f.store); let removed = false;
  f.store[method] = (...args) => {
    if (!removed && args[2] === 'target') {
      removed = true;
      f.change(state => { const old = state.conversations.find(conversation => conversation.id === 'target'); state.conversations = state.conversations.filter(conversation => conversation.id !== 'target'); if (replacement) state.conversations.push({ ...old, id: 'replacement' }); });
    }
    return read(...args);
  };
  f.reset();
  try {
    assert.doesNotThrow(() => f.socket.ev.emit('messages.update', [{ key: { id: 'removed-provider', remoteJid: jid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } }]));
  } finally { f.store[method] = originalRead; }
  assert.equal(removed, true); assert.equal(f.state().conversations.some(conversation => conversation.id === 'target'), false);
  assert.deepEqual(f.calls.full, replacement ? ['WhatsApp: recibo de mensagem'] : []);
  if (replacement) assert.equal(f.state().conversations.find(conversation => conversation.id === 'replacement').messages[0].delivery, 'read');
  assert.equal(f.socket.sent.length, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbound_commands WHERE tenant_id=?').get(f.tenant.id).n, 0);
});

test('removal between incoming lookup and BEGIN revalidates the full tenant and creates the attendance without losing the input', async t => {
  const f = await fixture(t), mutate = f.store.mutateConversation; let removed = false;
  f.store.mutateConversation = (...args) => {
    if (!removed && args[3] === 'WhatsApp: mensagem recebida') { removed = true; f.change(state => { state.conversations = state.conversations.filter(conversation => conversation.id !== 'target'); }); }
    return mutate(...args);
  };
  await f.receive('input-after-removal'); await f.receive('input-after-removal');
  const current = f.state().conversations.find(conversation => conversation.remoteJid === jid);
  assert.notEqual(current.id, 'target'); assert.equal(current.messages.filter(message => message.externalId === 'input-after-removal').length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wa_seen WHERE message_id=?').get('input-after-removal').n, 1);
  assert.ok(f.calls.full.includes('WhatsApp: mensagem recebida'));
});

for (const crm of ['unlinked', 'identity-changed']) test(`CRM ${crm} falls back to the complete transaction and links before the next scoped input`, async t => {
  const f = await fixture(t);
  f.change(state => {
    const conversation = state.conversations[0];
    if (crm === 'unlinked') { delete conversation.contactId; delete conversation.contactSyncStatus; state.contacts = []; }
    else state.contacts[0].identities = [];
  }); f.reset();
  await f.receive('crm-fallback');
  assert.ok(f.calls.full.includes('WhatsApp: mensagem recebida')); assert.equal(f.conversation().contactSyncStatus, 'linked');
  const contact = f.state().contacts.find(contact => contact.id === f.conversation().contactId);
  assert.ok(contact.identities.some(identity => identity.externalId === jid));
  f.reset(); await f.receive('crm-now-linked');
  assert.deepEqual(f.calls.full, []); assert.equal(f.conversation().messages.filter(message => message.externalId === 'crm-fallback').length, 1);
});

test('new and reopened conversations retain CRM, global default-agent checks and SLA fallback', async t => {
  const f = await fixture(t), blocked = f.app.gateway.ownLines.blocksAgent.bind(f.app.gateway.ownLines); let checks = 0;
  f.app.gateway.ownLines.blocksAgent = (...args) => { checks++; return blocked(...args); };
  f.change(state => { state.conversations[0].status = 'closed'; }); f.reset();
  await f.receive('reopen-fallback');
  assert.ok(f.calls.full.includes('WhatsApp: mensagem recebida')); assert.ok(f.calls.full.includes('Entrada avaliada pela automação'));
  assert.equal(f.conversation().status, 'open'); assert.equal(f.conversation().owner, 'agent'); assert.equal(f.conversation().agentId, 'ext');
  assert.equal(f.conversation().slaCycle.source, 'gateway-reopened'); assert.equal(checks, 1);
  f.reset(); await f.receive('new-fallback', '5511966660000@s.whatsapp.net');
  const created = f.state().conversations.find(conversation => conversation.remoteJid === '5511966660000@s.whatsapp.net');
  assert.ok(created.contactId); assert.equal(created.contactSyncStatus, 'linked'); assert.equal(created.owner, 'agent');
  assert.equal(created.slaCycle.source, 'gateway-new-conversation'); assert.equal(checks, 2);
  assert.ok(f.calls.full.includes('WhatsApp: mensagem recebida'));
});

test('an incoming workflow still executes against the complete tenant while the committed input remains scoped', async t => {
  const f = await fixture(t);
  f.change(state => { state.conversations[0].owner = 'queue'; state.conversations[0].agentId = null; });
  const flow = f.app.flows.create(f.admin, f.tenant.id, { name: 'Scoped fallback flow', graph: { nodes: [
    { id: 'start', type: 'start', config: {} }, { id: 'tag', type: 'tag', config: { tag: 'flow-ran' } }, { id: 'end', type: 'end', config: {} }
  ], edges: [{ from: 'start', to: 'tag' }, { from: 'tag', to: 'end' }] } });
  f.app.flows.publish(f.admin, f.tenant.id, flow.id, { version: 1 });
  f.app.automation.configure(f.admin, f.tenant.id, { version: 1, bindings: [{ name: 'Incoming fixture', enabled: true, channelId: 'wa', flowId: flow.id, flowVersion: 1, trigger: 'incoming' }] });
  f.reset(); await f.receive('workflow-fallback');
  assert.ok(f.calls.scoped.includes('WhatsApp: mensagem recebida')); assert.ok(f.calls.full.includes('Entrada avaliada pela automação'));
  const receipt = f.conversation().messages.find(message => message.externalId === 'workflow-fallback').automationReceipt;
  assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt)); assert.ok(f.conversation().tags.includes('flow-ran'));
});

test('round-robin routing keeps its global department cursor and current human assignment', async t => {
  const f = await fixture(t);
  f.app.auth.updatePresence(f.admin, 'available');
  f.change(state => { state.conversations[0].owner = 'queue'; state.conversations[0].agentId = null; state.departments[0].distribution = 'round_robin'; state.departments[0].memberIds = [f.admin.userId]; });
  f.reset(); await f.receive('routing-fallback');
  assert.ok(f.calls.full.includes('Atendimento distribuído automaticamente')); assert.ok(f.calls.scoped.includes('WhatsApp: mensagem recebida'));
  assert.equal(f.conversation().owner, 'human'); assert.equal(f.conversation().assignedUserId, f.admin.userId); assert.equal(f.state().departments[0].version, 2);
});

test('MCP autopilot preflight preserves an existing unknown receipt, including receiveLatest, without full tenant reads', async t => {
  const f = await fixture(t), id = 'autopilot_' + createHash('sha256').update(JSON.stringify([f.tenant.id, 'target', 'seed'])).digest('hex').slice(0, 48);
  f.change(state => { state.agentAutopilotJobs = [{ id, tenantId: f.tenant.id, conversationId: 'target', messageId: 'seed', agentId: 'ext', state: 'unknown', attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]; });
  f.reset(); const jobs = structuredClone(f.state().agentAutopilotJobs);
  assert.equal(f.app.autopilot.receive(f.tenant.id, 'target', 'seed').id, id);
  assert.equal(f.app.autopilot.receiveLatest(f.tenant.id, 'target').state, 'unknown');
  assert.deepEqual(f.state().agentAutopilotJobs, jobs); assert.deepEqual(f.calls.reads, []); assert.deepEqual(f.calls.full, []); assert.equal(f.socket.sent.length, 0);
});

test('a real Hermes autopilot retains full intake, durable global jobs and own-lines checks before any model execution', async t => {
  const f = await fixture(t); f.app.autopilot.autoDrain = false; // Intake-only: no inference or send may run in this test.
  f.change(state => { state.agents[0].provider = 'hermes'; state.agents[0].autopilot = { enabled: true, channelIds: ['wa'], requireKnowledge: false }; });
  const blocks = f.app.gateway.ownLines.blocksAgent.bind(f.app.gateway.ownLines), snapshots = [];
  f.app.gateway.ownLines.blocksAgent = (tenantId, conversation, options) => { snapshots.push(options.state.conversations.length); return blocks(tenantId, conversation, options); };
  f.reset(); const job = f.app.autopilot.receiveLatest(f.tenant.id, 'target');
  assert.ok(job); assert.equal(job.state, 'pending');
  assert.ok(f.calls.reads.length > 0); assert.ok(f.calls.full.includes('Piloto automático: mensagem registrada na fila'));
  assert.deepEqual(snapshots, [2]); assert.equal(f.state().agentAutopilotJobs.length, 1); assert.equal(f.socket.sent.length, 0);
});
