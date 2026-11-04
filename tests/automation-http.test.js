import { syntheticFiscalDocument } from './helpers/fiscal-document.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const secret = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denied = async () => { throw new Error('External access forbidden in automation fixture'); };
const initialTime = Date.parse('2026-10-01T13:00:00.000Z');
const graph = (department = 'Comercial', tag = 'Rota automática') => ({ nodes: [
  { id: 'start', type: 'start', config: {} }, { id: 'tag', type: 'tag', config: { tag } },
  { id: 'route', type: 'department', config: { department } }, { id: 'handoff', type: 'handoff', config: { owner: 'human' } },
  { id: 'end', type: 'end', config: {} }
], edges: [{ from: 'start', to: 'tag' }, { from: 'tag', to: 'route' }, { from: 'route', to: 'handoff' }, { from: 'handoff', to: 'end' }] });

async function fixture(t) {
  const key = randomBytes(32), deliveries = []; let now = initialTime, providers = 0;
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin: '', automationOptions: { now: () => now },
    providerCall: async () => { providers++; throw new Error('Automations must never dispatch a provider'); },
    mediaOptions: { directory: null, authKey: key }, gatewayOptions: { authKey: key, socketFactory: denied, downloadMediaImpl: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied }, googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, cookie = '', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()), cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Gestor automações QA', username: 'automation.owner', password: secret() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length))); owner.id = actor.userId;
  const created = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Automações sintéticas', segment: 'QA' } }); assert.equal(created.status, 201);
  const tenantId = created.data.id, path = `/api/tenants/${tenantId}`, wa = 'automation-wa', tg = 'automation-tg', support = 'automation-support', sales = 'automation-sales';
  app.store.mutate(actor, tenantId, 'Fixture de canais e departamentos sintéticos', tenant => {
    tenant.channels = [{ id: wa, kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }, { id: tg, kind: 'telegram', transport: 'telegram-bot', state: 'connected' }];
    tenant.departments = [{ id: support, name: 'Suporte', active: true, distribution: 'manual', memberIds: [], version: 1 }, { id: sales, name: 'Comercial', active: true, distribution: 'manual', memberIds: [], version: 1 }]; tenant.defaultDepartmentId = support;
  });
  const gatewayActor = { role: 'reseller', resellerId: actor.resellerId, name: 'Gateway sintético' };
  const waEntry = { actor: gatewayActor, tenantId, channelId: wa, state: 'connected', matched: true, generation: 1,
    socket: { user: { id: '5511999990000@s.whatsapp.net' }, end() {}, sendMessage: async (...args) => { deliveries.push(args); throw new Error('Automatic send forbidden'); } } };
  const tgEntry = { actor: gatewayActor, tenantId, channelId: tg, state: 'connected', token: '12345:synthetic_token_only', abort: new AbortController() };
  app.gateway.entries.set(wa, waEntry); app.telegram.entries.set(tg, tgEntry);
  let memberSequence = 0, receivedSequence = 0;
  const member = async (overrides = {}) => {
    const username = 'automation.member.' + ++memberSequence, password = secret();
    const result = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Pessoa sintética ' + memberSequence, username, password, role: 'operator', tenantIds: [tenantId], ...overrides } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const signed = await request('/api/auth/login', { method: 'POST', body: { username, password } }); assert.equal(signed.status, 200);
    return { ...result.data, cookie: signed.cookie };
  };
  const state = () => app.store.tenant(actor, tenantId);
  const flow = async (inputGraph = graph(), user = owner) => {
    const created = await request(path + '/flows', { method: 'POST', cookie: user.cookie, body: { name: 'Fluxo sintético', graph: inputGraph } }); assert.equal(created.status, 201);
    const published = await request(`${path}/flows/${created.data.id}/publish`, { method: 'POST', cookie: user.cookie, body: { version: created.data.version } }); assert.equal(published.status, 200); return published.data;
  };
  const binding = (flow, overrides = {}) => ({ name: 'Entrada sintética', enabled: true, channelId: wa, flowId: flow.id, flowVersion: flow.publishedVersion, trigger: 'incoming', ...overrides });
  const configure = async (bindings, sla = { enabled: true, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, user = owner, overrides = {}) => {
    const previous = await request(path + '/automation', { cookie: user.cookie }); assert.equal(previous.status, 200);
    return request(path + '/automation', { method: 'PUT', cookie: user.cookie, body: { version: previous.data.version, bindings, sla, ...overrides } });
  };
  const receiveWa = async ({ jid, externalId, text = 'Pedido sintético', fromMe = false } = {}) => {
    const sequence = ++receivedSequence, key = { id: externalId || 'automation-wa-message-' + sequence, remoteJid: jid || '551190000' + String(sequence).padStart(4, '0') + '@s.whatsapp.net', fromMe };
    const message = { key, pushName: 'Contato sintético', message: { conversation: text } }; await app.gateway.receive(waEntry, message);
    return { message, conversation: state().conversations.find(item => item.messages.some(entry => entry.externalId === key.id)) };
  };
  const receiveTg = (text = '/ajuda', chatId = 789123, threadId = null) => {
    const sequence = ++receivedSequence, update = { update_id: sequence, message: { message_id: sequence, date: Math.floor(now / 1000), text, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private', first_name: 'Contato sintético', title: 'Grupo sintético' }, from: { id: 99123, first_name: 'Pessoa sintética' }, ...(threadId ? { message_thread_id: threadId } : {}) } };
    app.telegram.receive(tgEntry, update); return { update, conversation: state().conversations.find(item => item.messages.some(entry => entry.externalId === `${chatId}:${sequence}`)) };
  };
  const web = 'automation-webchat', visitorOrigin = 'https://automation-visitor.example.test', publicWebchat = `/api/public/webchat/${tenantId}/${web}`;
  const connectWebchat = async () => {
    app.store.mutate(actor, tenantId, 'Fixture: cadastro Webchat sintético', tenant => { tenant.channels.push({ id: web, kind: 'webchat', state: 'planned', name: 'Webchat sintético' }); });
    const connected = await request(`${path}/channels/${web}/configuration`, { method: 'POST', cookie: owner.cookie, body: { version: 0, enabled: true, origins: [visitorOrigin] } });
    assert.equal(connected.status, 200, connected.data.error); assert.equal(connected.data.state, 'connected');
  };
  const openWebchat = async () => {
    const headers = { Origin: visitorOrigin };
    const challenge = await request(publicWebchat + '/challenge', { method: 'POST', headers, body: {} }); assert.equal(challenge.status, 200, challenge.data.error);
    const opened = await request(publicWebchat + '/session', { method: 'POST', headers, body: { challenge: challenge.data.challenge, name: 'Visitante sintético' } }); assert.equal(opened.status, 200, opened.data.error);
    return opened.data;
  };
  const receiveWebchat = async (visitor, text = '/qa_elozi_95', input = {}) => {
    const body = { token: visitor.token, text, clientMessageId: 'automation_webchat_' + ++receivedSequence, ...input };
    const response = await request(publicWebchat + '/messages', { method: 'POST', headers: { Origin: visitorOrigin }, body });
    return { ...response, body, conversation: state().conversations.find(item => item.messages.some(message => message.externalId === body.clientMessageId)) };
  };
  return { app, request, owner, actor, tenantId, path, wa, tg, web, visitorOrigin, publicWebchat, support, sales, member, state, flow, binding, configure, receiveWa, receiveTg, connectWebchat, openWebchat, receiveWebchat, deliveries, providers: () => providers, clock: value => { now = typeof value === 'number' ? value : Date.parse(value); } };
}

test('HTTP Webchat real aplica comando no horário e publicação fixada, com SLA e recibo sem envio', async t => {
  const c = await fixture(t); await c.connectWebchat();
  const published = await c.flow(), calendar = { timezone: 'America/Sao_Paulo', days: [4], start: '09:00', end: '18:00' };
  const saved = await c.configure([c.binding(published, { channelId: c.web, trigger: 'command', command: '/QA_ELOZI_95', calendar })]);
  assert.equal(saved.status, 200, saved.data.error); assert.equal(saved.data.bindings[0].command, '/qa_elozi_95');
  const edited = await c.request(`${c.path}/flows/${published.id}`, { method: 'PUT', cookie: c.owner.cookie, body: { version: published.version, graph: graph('Suporte', 'Publicação posterior') } }); assert.equal(edited.status, 200);
  const latest = await c.request(`${c.path}/flows/${published.id}/publish`, { method: 'POST', cookie: c.owner.cookie, body: { version: edited.data.version } }); assert.equal(latest.status, 200);
  c.clock('2026-10-01T23:00:00Z');
  const outside = await c.receiveWebchat(await c.openWebchat()); assert.equal(outside.status, 200, outside.data.error);
  assert.equal(outside.conversation.messages[0].automationReceipt.outcome, 'no-match'); assert.equal(outside.conversation.departmentId, c.support); assert.deepEqual(outside.conversation.tags, ['Webchat']);
  c.clock(initialTime);
  const visitor = await c.openWebchat(), received = await c.receiveWebchat(visitor, ' /QA_ELOZI_95 pedido sintético');
  assert.equal(received.status, 200, received.data.error); const current = received.conversation, incoming = current.messages.find(message => message.externalId === received.body.clientMessageId);
  assert.equal(current.channelId, c.web); assert.equal(current.departmentId, c.sales); assert.equal(current.owner, 'queue'); assert.equal(current.assignedUserId, null); assert.equal(current.agentId, null);
  assert.ok(current.tags.includes('Rota automática')); assert.ok(!current.tags.includes('Publicação posterior'));
  assert.equal(incoming.automationReceipt.outcome, 'applied'); assert.equal(incoming.automationReceipt.flowVersion, 1); assert.equal(incoming.automationReceipt.configurationVersion, saved.data.version);
  assert.equal(current.messages.filter(message => ['human', 'agent'].includes(message.kind)).length, 0);
  assert.equal(current.slaCycle.incomingMessageId, incoming.id); assert.equal(current.slaCycle.startedAt, new Date(initialTime).toISOString());
  const stable = c.state(), replay = await c.receiveWebchat(visitor, received.body.text, received.body);
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.deepEqual(c.state(), stable);
  c.clock(initialTime + 16 * 60_000);
  const sla = await c.request(c.path + '/sla', { cookie: c.owner.cookie }); assert.equal(sla.status, 200);
  const tracked = sla.data.conversations.find(conversation => conversation.conversationId === current.id); assert.equal(tracked.firstReply.state, 'breached'); assert.equal(tracked.firstReply.elapsedMinutes, 16);
  const claimed = await c.request(`${c.path}/conversations/${current.id}/owner`, { method: 'POST', cookie: c.owner.cookie, body: { version: current.version, owner: 'human' } }); assert.equal(claimed.status, 200, claimed.data.error);
  const preserved = await c.receiveWebchat(visitor); assert.equal(preserved.status, 200); assert.equal(preserved.conversation.assignedUserId, c.owner.id); assert.equal(preserved.conversation.owner, 'human');
  const nextMessage = preserved.conversation.messages.find(message => message.externalId === preserved.body.clientMessageId); assert.equal(nextMessage.automationReceipt.outcome, 'not-in-queue');
  const ordinary = await c.receiveWebchat(await c.openWebchat(), 'Olá'); assert.equal(ordinary.status, 200); assert.equal(ordinary.conversation.departmentId, c.support); assert.deepEqual(ordinary.conversation.tags, ['Webchat']);
  assert.equal(c.providers(), 0); assert.equal(c.deliveries.length, 0);
});

test('HTTP binding exige adaptador correspondente vivo; offline existente só permanece desativado', async t => {
  const c = await fixture(t), published = await c.flow(), original = c.app.gateway.entries.get(c.wa);
  for (const [reason, override] of [
    ['outro tenant', { tenantId: 'foreign' }], ['outro canal', { channelId: 'foreign' }], ['desconectado', { state: 'disconnected' }], ['pareamento incompleto', { matched: false }], ['parado', { stopped: true }]
  ]) {
    c.app.gateway.entries.set(c.wa, { ...original, ...override });
    const rejected = await c.configure([c.binding(published)]); assert.equal(rejected.status, 400, reason);
  }
  c.app.gateway.entries.set(c.wa, original); assert.equal((await c.configure([c.binding(published)])).status, 200);
  await c.connectWebchat(); const configured = await c.configure([c.binding(published, { channelId: c.web })]); assert.equal(configured.status, 200);
  const wire = c.binding(published, { id: configured.data.bindings[0].id, channelId: c.web });
  c.app.webchat.closed = true;
  assert.equal((await c.configure([wire])).status, 400); assert.equal((await c.configure([c.binding(published, { channelId: c.web, enabled: false })])).status, 400);
  const disabled = await c.configure([{ ...wire, enabled: false }]); assert.equal(disabled.status, 200); assert.equal(disabled.data.bindings[0].enabled, false);
  assert.equal((await c.request(c.publicWebchat + '/challenge', { method: 'POST', headers: { Origin: c.visitorOrigin }, body: {} })).status, 503);
  c.app.webchat.closed = false;
  const received = await c.receiveWebchat(await c.openWebchat()); assert.equal(received.status, 200); assert.equal(received.conversation.messages[0].automationReceipt.outcome, 'no-match'); assert.deepEqual(received.conversation.tags, ['Webchat']);
  assert.equal(c.providers(), 0); assert.equal(c.deliveries.length, 0);
});

test('HTTP Webchat revalida adaptador no hook após entrada comprometida sem aplicar rota', async t => {
  const c = await fixture(t); await c.connectWebchat(); const published = await c.flow();
  assert.equal((await c.configure([c.binding(published, { channelId: c.web })])).status, 200);
  const visitor = await c.openWebchat(), onIncoming = c.app.webchat.onIncoming;
  c.app.webchat.onIncoming = (...args) => { c.app.webchat.closed = true; return onIncoming(...args); };
  const received = await c.receiveWebchat(visitor); assert.equal(received.status, 503);
  assert.ok(received.conversation, 'The visitor message remains committed'); assert.equal(received.conversation.messages[0].automationReceipt.outcome, 'no-match');
  assert.deepEqual(received.conversation.tags, ['Webchat']); assert.equal(received.conversation.departmentId, c.support); assert.equal(received.conversation.owner, 'queue');
  c.app.webchat.closed = false;
  const history = await c.request(c.publicWebchat + '/history', { method: 'POST', headers: { Origin: c.visitorOrigin }, body: { token: visitor.token } });
  assert.equal(history.status, 200); assert.equal(history.data.messages.length, 1); assert.equal(history.data.messages[0].kind, 'customer');
  assert.equal(c.providers(), 0); assert.equal(c.deliveries.length, 0);
});

test('HTTP automação é administrativa, CAS, origem e autoridade são definidas pelo servidor', async t => {
  const c = await fixture(t), operator = await c.member(), published = await c.flow();
  assert.equal((await c.request(c.path + '/automation')).status, 401);
  assert.equal((await c.request(c.path + '/automation', { cookie: operator.cookie })).status, 403);
  assert.equal((await c.request(c.path + '/automation', { method: 'PUT', cookie: operator.cookie, body: { version: 1, bindings: [] } })).status, 403);
  const saved = await c.configure([c.binding(published)]); assert.equal(saved.status, 200); assert.equal(saved.data.version, 2); assert.equal(saved.data.bindings[0].authorizedBy, c.owner.id);
  const operationalView = await c.request(c.path, { cookie: operator.cookie }); assert.equal(operationalView.status, 200);
  assert.equal(operationalView.data.automation, undefined, 'Operational tenant payload must not expose administrative automation bindings');
  const original = c.state().automation;
  assert.equal((await c.configure([], undefined, c.owner, { version: 1 })).status, 409);
  assert.equal((await c.configure([c.binding(published, { authorizedBy: operator.id })])).status, 400);
  assert.equal((await c.configure([], undefined, c.owner, { authorizedBy: operator.id })).status, 400);
  assert.equal((await c.configure([c.binding(published, { channelId: 'foreign-channel' })])).status, 400);
  assert.equal((await c.configure([c.binding(published, { flowId: 'foreign-flow' })])).status, 400);
  assert.equal((await c.configure([c.binding(published, { flowVersion: 100 })])).status, 400);
  assert.equal((await c.request(c.path + '/automation', { method: 'PUT', cookie: c.owner.cookie, headers: { Origin: 'https://foreign.example.test' }, body: { version: 2, bindings: [] } })).status, 403);
  assert.deepEqual(c.state().automation, original);
  const foreign = await c.request('/api/auth/register', { method: 'POST', body: { fiscalDocument: syntheticFiscalDocument(), name: 'Outra revenda sintética', email: 'automation-other@example.test', password: secret(), company: 'Outra revenda QA' } }); assert.equal(foreign.status, 200);
  assert.equal((await c.request(c.path + '/automation', { cookie: foreign.cookie })).status, 404);
  assert.equal((await c.request(c.path + '/sla', { cookie: foreign.cookie })).status, 403);
  assert.equal((await c.request(c.path + '/automation', { cookie: c.owner.cookie, headers: { 'X-Elozi-Workspace': 'ungranted-workspace' } })).status, 403);
  assert.equal(c.deliveries.length, 0); assert.equal(c.providers(), 0);
});

test('HTTP configuração publicada é aplicada antes da distribuição, deduplica e nunca responde automaticamente', async t => {
  const c = await fixture(t), supportPerson = await c.member(), salesPerson = await c.member(), published = await c.flow();
  c.app.store.mutate(c.actor, c.tenantId, 'Fixture: distribuição de departamentos', tenant => {
    for (const department of tenant.departments) { department.distribution = 'round_robin'; department.memberIds = [department.id === c.support ? supportPerson.id : salesPerson.id]; }
  });
  const configured = await c.configure([c.binding(published)]); assert.equal(configured.status, 200);
  const received = await c.receiveWa();
  const conversation = received.conversation, incoming = conversation.messages.find(message => message.kind === 'customer');
  assert.equal(conversation.departmentId, c.sales); assert.equal(conversation.assignedUserId, salesPerson.id); assert.equal(conversation.owner, 'human');
  assert.ok(conversation.tags.includes('Rota automática')); assert.equal(incoming.automationReceipt.outcome, 'applied'); assert.equal(incoming.automationReceipt.flowVersion, 1);
  assert.equal(conversation.attendantEvents.find(event => event.origin === 'automation').actorId, c.owner.id);
  assert.equal(conversation.messages.filter(message => message.kind === 'human').length, 0);
  const stable = c.state(); await c.app.gateway.receive(c.app.gateway.entries.get(c.wa), received.message); assert.deepEqual(c.state(), stable);
  const fetched = await c.request(c.path, { cookie: c.owner.cookie }); assert.equal(fetched.status, 200);
  assert.equal(fetched.data.conversations.find(value => value.id === conversation.id).assignedUserId, salesPerson.id);
  assert.equal(c.deliveries.length, 0); assert.equal(c.providers(), 0);
});

test('HTTP Telegram usa comando, calendário e versão fixada, preservando contexto de grupo e tópico', async t => {
  const c = await fixture(t), published = await c.flow(), calendar = { timezone: 'America/Sao_Paulo', days: [4], start: '09:00', end: '18:00' };
  const saved = await c.configure([c.binding(published, { channelId: c.tg, trigger: 'command', command: '/ajuda', calendar })]); assert.equal(saved.status, 200);
  const edited = await c.request(`${c.path}/flows/${published.id}`, { method: 'PUT', cookie: c.owner.cookie, body: { version: published.version, graph: graph('Suporte', 'Versão posterior') } }); assert.equal(edited.status, 200);
  assert.equal((await c.request(`${c.path}/flows/${published.id}/publish`, { method: 'POST', cookie: c.owner.cookie, body: { version: edited.data.version } })).status, 200);
  const routed = c.receiveTg('/ajuda@BotSintetico detalhes', -789123, 66).conversation;
  assert.equal(routed.departmentId, c.sales); assert.equal(routed.owner, 'queue'); assert.equal(routed.threadId, 66);
  const message = routed.messages.find(item => item.kind === 'customer'); assert.equal(message.automationReceipt.flowVersion, 1); assert.ok(routed.tags.includes('Rota automática')); assert.ok(!routed.tags.includes('Versão posterior'));
  const first = c.state(), replay = { update_id: 1, message: { message_id: 1, text: '/ajuda', chat: { id: -789123, type: 'supergroup' } } };
  c.app.telegram.receive(c.app.telegram.entries.get(c.tg), replay); assert.deepEqual(c.state(), first);
  const wrongCommand = c.receiveTg('/outro', 789124).conversation; assert.equal(wrongCommand.departmentId, c.support); assert.equal(wrongCommand.messages[0].automationReceipt.outcome, 'no-match');
  c.clock('2026-10-02T13:00:00.000Z'); const outside = c.receiveTg('/ajuda', 789125).conversation;
  assert.equal(outside.departmentId, c.support); assert.equal(outside.messages[0].automationReceipt.outcome, 'no-match');
  const fetched = await c.request(c.path, { cookie: c.owner.cookie }); assert.doesNotMatch(JSON.stringify(fetched.data), /synthetic_token_only|remoteChatId|senderId/);
  assert.equal(c.deliveries.length, 0); assert.equal(c.providers(), 0);
});

test('HTTP gatilho invalida rascunho anterior mas não altera responsável humano nem mensagens de saída', async t => {
  const c = await fixture(t), published = await c.flow(); assert.equal((await c.configure([c.binding(published)])).status, 200);
  const received = await c.receiveWa({ externalId: 'draft-seed' });
  const id = received.conversation.id;
  c.app.store.mutate(c.actor, c.tenantId, 'Fixture: rascunho anterior e retorno à fila', tenant => {
    const current = tenant.conversations.find(item => item.id === id); current.owner = 'queue'; current.assignedUserId = null;
    tenant.runs = [{ id: 'draft-before-incoming', conversationId: id, state: 'draft', draft: 'Texto sintético não enviado' }];
  });
  await c.receiveWa({ jid: received.message.key.remoteJid, externalId: 'draft-invalidated' });
  assert.equal(c.state().runs[0].state, 'invalidated'); assert.equal(c.state().runs[0].draft, null);
  const current = c.state().conversations.find(item => item.id === id);
  const claimed = await c.request(`${c.path}/conversations/${id}/owner`, { method: 'POST', cookie: c.owner.cookie, body: { version: current.version, owner: 'human' } }); assert.equal(claimed.status, 200);
  const preserved = await c.receiveWa({ jid: received.message.key.remoteJid, externalId: 'human-preserved' });
  assert.equal(preserved.conversation.assignedUserId, c.owner.id); assert.equal(preserved.conversation.messages.find(item => item.externalId === 'human-preserved').automationReceipt.outcome, 'not-in-queue');
  const outgoing = await c.receiveWa({ jid: received.message.key.remoteJid, externalId: 'own-message', fromMe: true });
  assert.equal(outgoing.conversation.messages.find(item => item.externalId === 'own-message').automationReceipt, undefined);
  assert.equal(c.providers(), 0); assert.equal(c.deliveries.length, 0);
});

test('HTTP autoridade desativada bloqueia a rota seguinte sem efeitos parciais ou disparo', async t => {
  const c = await fixture(t), manager = await c.member({ role: 'reseller', tenantIds: [] }), published = await c.flow(graph(), manager);
  assert.equal((await c.configure([c.binding(published)], undefined, manager)).status, 200);
  assert.equal((await c.request(`/api/users/${manager.id}/disable`, { method: 'POST', cookie: c.owner.cookie, body: {} })).status, 200);
  const incoming = await c.receiveWa(), current = incoming.conversation, receipt = current.messages.find(item => item.kind === 'customer').automationReceipt;
  assert.equal(receipt.outcome, 'blocked'); assert.equal(receipt.errorStatus, 403); assert.equal(current.departmentId, c.support); assert.equal(current.owner, 'queue');
  assert.ok(!current.tags.includes('Rota automática')); assert.equal(current.attendantEvents, undefined);
  const stable = c.state(); await c.app.gateway.receive(c.app.gateway.entries.get(c.wa), incoming.message); assert.deepEqual(c.state(), stable);
  assert.equal(c.deliveries.length, 0); assert.equal(c.providers(), 0);
});

test('HTTP SLA mostra tempos registrados e filtra canais e departamentos com acesso atual', async t => {
  const c = await fixture(t); assert.equal((await c.configure([])).status, 200);
  const start = '2026-10-01T12:30:00.000Z', response = '2026-10-01T12:40:00.000Z', closure = '2026-10-01T12:50:00.000Z';
  c.app.store.mutate(c.actor, c.tenantId, 'Fixture: ciclos com evidência temporal', tenant => {
    tenant.conversations = [
      { id: 'sla-visible', contact: 'Contato visível', channelId: c.wa, departmentId: c.support, department: 'Suporte', owner: 'queue', status: 'open', version: 1, tags: [], messages: [{ id: 'sla-customer', kind: 'customer', text: 'Pedido sintético', createdAt: start, delivery: 'received' }] },
      { id: 'sla-hidden-channel', contact: 'Contato canal oculto', channelId: c.tg, departmentId: c.support, department: 'Suporte', owner: 'human', status: 'open', version: 1, tags: [], messages: [{ id: 'sla-tg-customer', kind: 'customer', text: 'Pedido sintético', createdAt: start, delivery: 'received' }] },
      { id: 'sla-hidden-department', contact: 'Contato departamento oculto', channelId: c.wa, departmentId: c.sales, department: 'Comercial', owner: 'human', status: 'closed', version: 1, tags: [], messages: [{ id: 'sla-sales-customer', kind: 'customer', text: 'Pedido sintético', createdAt: start }, { id: 'sla-human', kind: 'human', text: 'Resposta sintética', createdAt: response, delivery: 'sent', authorUserId: c.owner.id }], attendantEvents: [{ id: 'sla-closure', type: 'closed', from: { status: 'open' }, to: { status: 'closed' }, createdAt: closure }] }
    ];
  });
  const scoped = await c.member({ permissions: ['inbox.read', 'metrics.read'], scopeRules: { [c.tenantId]: { channelIds: [c.wa], departmentIds: [c.support] } } });
  const view = await c.request(c.path + '/sla', { cookie: scoped.cookie }); assert.equal(view.status, 200); assert.equal(view.data.totals.tracked, 1);
  assert.deepEqual(view.data.conversations.map(item => item.conversationId), ['sla-visible']); assert.equal(view.data.conversations[0].firstReply.state, 'breached'); assert.equal(view.data.conversations[0].firstReply.elapsedMinutes, 30);
  assert.equal(view.data.conversations[0].resolution.state, 'pending'); assert.doesNotMatch(JSON.stringify(view.data), /Contato canal oculto|Contato departamento oculto/);
  const all = await c.request(c.path + '/sla', { cookie: c.owner.cookie }); assert.equal(all.status, 200); assert.equal(all.data.totals.tracked, 3);
  const done = all.data.conversations.find(item => item.conversationId === 'sla-hidden-department'); assert.equal(done.firstReply.state, 'met'); assert.equal(done.resolution.state, 'met'); assert.equal(done.resolution.completedAt, closure);
  const noMetrics = await c.member({ permissions: ['inbox.read'] }); assert.equal((await c.request(c.path + '/sla', { cookie: noMetrics.cookie })).status, 403);
  assert.equal((await c.request(`/api/users/${scoped.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { permissions: ['inbox.read'] } })).status, 200);
  assert.equal((await c.request(c.path + '/sla', { cookie: scoped.cookie })).status, 401);
  assert.equal(c.deliveries.length, 0); assert.equal(c.providers(), 0);
});
