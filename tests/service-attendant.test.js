// Agent as attendant for external agents (REST + MCP): events.read waits, private reply.send, conversation.manage tools.
// createApp with the webchat transport as the synthetic channel; no external network, provider or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { ServiceApi } from '../src/service-api.js';
import { createEventBus } from '../src/events.js';
import { ServiceReplyRateLimitError, loadPrivateServiceReplyLimits } from '../src/service-reply-limits.js';
import { businessError } from '../src/service-mcp.js';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://loja.example.test';
const status = expected => error => error.status === expected;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ATTENDANT = ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'];

async function fixture(t) {
  const key = Buffer.alloc(32, 41), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio do agente atendente'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, clients = [];
  const { store, auth, webchat, servicePrincipals: principals, serviceApi: api } = app;
  const row = auth.insertUser({ username: 'attendant.owner', name: 'Administração sintética' }, Buffer.alloc(16, 5), Buffer.alloc(64, 5), 'reseller', [], 'mep-demo');
  const admin = auth.session(row).actor, tenant = store.createTenant(admin, { name: 'Loja do agente', segment: 'Varejo' });
  store.mutate(admin, tenant.id, 'Fixture do agente atendente', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }, { id: 'wa', kind: 'whatsapp_qr', name: 'WhatsApp', state: 'planned' }];
    state.departments = [{ id: 'sac', name: 'SAC', active: true, memberIds: [], distribution: 'manual', cursor: 0, version: 1 }, { id: 'vip', name: 'VIP', active: true, memberIds: [], distribution: 'manual', cursor: 0, version: 1 },
      { id: 'old', name: 'Antigo', active: false, memberIds: [], distribution: 'manual', cursor: 0, version: 1 }];
    state.agents = [{ id: 'ext', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'ext-2', name: 'Outro agente', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] },
      { id: 'hermes-1', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [
      { id: 'wa-queue', contact: 'Cliente WhatsApp', channelId: 'wa', departmentId: null, owner: 'queue', status: 'open', version: 1, conversationKind: 'direct', messages: [{ id: 'wa-1', kind: 'customer', text: 'Oi', createdAt: new Date().toISOString() }] },
      { id: 'vip-queue', contact: 'Cliente VIP', channelId: 'site', departmentId: 'vip', owner: 'queue', status: 'open', version: 1, conversationKind: 'direct', messages: [] },
      { id: 'other-agent', contact: 'Cliente do outro agente', channelId: 'site', departmentId: 'sac', owner: 'agent', agentId: 'ext-2', status: 'open', version: 1, conversationKind: 'direct', messages: [] },
      { id: 'human-owned', contact: 'Cliente da equipe', channelId: 'site', departmentId: 'sac', owner: 'human', assignedUserId: admin.userId, assignedUserName: 'Administração sintética', status: 'open', version: 1, conversationKind: 'direct', messages: [] }];
  });
  webchat.configure(admin, tenant.id, 'site', { version: 0, origins: [origin] });
  const principal = (agentId, capabilities = ATTENDANT, extra = {}) => {
    const created = principals.create(admin, tenant.id, { name: `Serviço ${agentId}`, agentId, capabilities, channelIds: ['site'], departmentIds: ['sac', 'unassigned'], dailyRequests: 200, maxConcurrent: 3, ttlHours: 24, ...extra });
    return { ...created, actor: principals.authenticate('Bearer ' + created.token) };
  };
  let messages = 0;
  const visitor = () => { const challenge = webchat.challenge({ tenantId: tenant.id, channelId: 'site', origin }); return webchat.openSession({ tenantId: tenant.id, channelId: 'site', origin, challenge: challenge.challenge, name: 'Visitante' }); };
  const say = async (session, text = 'Qual o prazo de entrega?') => (await webchat.receive({ token: session.token, text, clientMessageId: `attendant-msg-${String(++messages).padStart(4, '0')}`, origin })).conversationId
    ?? store.tenant(admin, tenant.id).conversations.find(item => item.remoteSessionId)?.id;
  const conversation = id => store.getConversation(store.tenant(admin, tenant.id), id);
  const siteConversation = () => store.tenant(admin, tenant.id).conversations.find(item => item.channelId === 'site' && item.remoteSessionId);
  const rest = (path, body, token, { signal } = {}) => fetch(base + path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    .then(async response => ({ status: response.status, data: await response.json().catch(() => null) }));
  const mcp = async token => {
    const client = new Client({ name: 'attendant-synthetic-client', version: '1.0.0' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/agent/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const commands = () => store.db.prepare('SELECT idempotency_key AS key,state FROM outbound_commands WHERE tenant_id=?').all(tenant.id).map(row => ({ ...row }));
  t.after(async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); store.close();
  });
  return { app, store, api, principals, admin, tenant, principal, visitor, say, conversation, siteConversation, rest, mcp, commands };
}
/** A webchat conversation of the visitor, claimed by `owner` (a principal of agent ext). */
async function ownedConversation(f, owner, text) {
  const session = f.visitor(); await f.say(session, text);
  const id = f.siteConversation().id;
  f.api.claimConversation(owner.actor, { requestId: `claim_${id}`.slice(0, 120), conversationId: id, version: f.conversation(id).version });
  return { id, session };
}

test('catálogo MCP e capacidades: ferramentas do atendente só com concessão explícita e leitura', async t => {
  const f = await fixture(t), attendant = f.principal('ext'), reader = f.principal('ext', ['conversation.read']);
  const tools = (await (await f.mcp(attendant.token)).listTools()).tools.map(tool => tool.name);
  for (const name of ['elozi_wait_for_events', 'elozi_send_reply', 'elozi_claim_conversation', 'elozi_transfer_to_human', 'elozi_set_tags', 'elozi_close_conversation']) assert.ok(tools.includes(name), name);
  const readerTools = (await (await f.mcp(reader.token)).listTools()).tools.map(tool => tool.name);
  for (const name of ['elozi_wait_for_events', 'elozi_send_reply', 'elozi_claim_conversation', 'elozi_close_conversation']) assert.equal(readerTools.includes(name), false, name);
  assert.throws(() => f.principals.create(f.admin, f.tenant.id, { name: 'Sem leitura', agentId: 'ext', capabilities: ['events.read'] }), status(400));
  assert.throws(() => f.principals.create(f.admin, f.tenant.id, { name: 'Sem leitura', agentId: 'ext', capabilities: ['conversation.manage'] }), status(400));
  const denied = await (await f.mcp(reader.token)).callTool({ name: 'elozi_claim_conversation', arguments: { requestId: 'denied_claim_001', conversationId: 'vip-queue', version: 1 } });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.status, 403);
});

test('assumir: só fila sem responsável no escopo; grupo, pessoa, outro agente, fora do escopo e outra empresa são recusados', async t => {
  const f = await fixture(t), p = f.principal('ext'), session = f.visitor();
  await f.say(session); const id = f.siteConversation().id, version = f.conversation(id).version;
  const claimed = f.api.claimConversation(p.actor, { requestId: 'claim_site_0001', conversationId: id, version });
  assert.equal(claimed.receipt.state, 'confirmed'); assert.equal(claimed.result.owner, 'agent');
  assert.equal(f.conversation(id).owner, 'agent'); assert.equal(f.conversation(id).agentId, 'ext');
  assert.match(f.conversation(id).messages.at(-1).text, /Conversa atribuída ao agente conectado Agente externo\. Ele responde sozinho somente com envio autorizado/);
  // Replay: same receipt, no second assignment; a new request on the owned conversation conflicts.
  assert.equal(f.api.claimConversation(p.actor, { requestId: 'claim_site_0001', conversationId: id, version }).receipt.id, claimed.receipt.id);
  assert.throws(() => f.api.claimConversation(p.actor, { requestId: 'claim_site_0002', conversationId: id, version: f.conversation(id).version }), status(409));
  assert.throws(() => f.api.claimConversation(p.actor, { requestId: 'claim_human_001', conversationId: 'human-owned', version: 1 }), status(409));
  assert.throws(() => f.api.claimConversation(p.actor, { requestId: 'claim_other_001', conversationId: 'other-agent', version: 1 }), status(409));
  assert.throws(() => f.api.claimConversation(p.actor, { requestId: 'claim_wa_00001', conversationId: 'wa-queue', version: 1 }), status(403), 'canal fora do escopo');
  assert.throws(() => f.api.claimConversation(p.actor, { requestId: 'claim_vip_0001', conversationId: 'vip-queue', version: 1 }), status(403), 'departamento fora do escopo');
  assert.throws(() => f.api.claimConversation(p.actor, { requestId: 'claim_none_001', conversationId: 'nao-existe', version: 1 }), status(404));
  assert.equal(f.conversation('vip-queue').owner, 'queue'); assert.equal(f.conversation('wa-queue').owner, 'queue');
  // Another company never resolves this conversation.
  f.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('ws-other', JSON.stringify({ name: 'Outro workspace' }));
  const otherAdmin = f.app.auth.session(f.app.auth.insertUser({ username: 'attendant.other', name: 'Outra administração' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'reseller', [], 'ws-other')).actor;
  const otherTenant = f.store.createTenant(otherAdmin, { name: 'Outra loja', segment: 'Varejo' });
  f.store.mutate(otherAdmin, otherTenant.id, 'Agente de outra empresa', state => { state.agents = [{ id: 'ext', name: 'Agente alheio', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }]; state.channels = [{ id: 'site', kind: 'webchat', name: 'Site alheio' }]; });
  const foreign = f.principals.create(otherAdmin, otherTenant.id, { name: 'Alheio', agentId: 'ext', capabilities: ATTENDANT, ttlHours: 24 });
  assert.throws(() => f.api.claimConversation(f.principals.authenticate('Bearer ' + foreign.token), { requestId: 'claim_foreign_1', conversationId: 'vip-queue', version: 1 }), status(404));
});

test('responder: só conversa própria de agente MCP, com recibo, outbox e transporte; replay não reenvia', async t => {
  const f = await fixture(t), p = f.principal('ext'), q = f.principal('ext-2'), hermes = f.principal('hermes-1', ['conversation.read', 'reply.send']);
  const { id, session } = await ownedConversation(f, p);
  const input = { requestId: 'reply_site_0001', conversationId: id, version: f.conversation(id).version, text: 'Entregamos em até cinco dias úteis.' };
  const sent = await f.api.sendReply(p.actor, input);
  assert.equal(sent.receipt.state, 'confirmed'); assert.equal(sent.result.state, 'confirmed');
  const message = f.conversation(id).messages.find(item => item.id === sent.result.messageId);
  assert.equal(message.kind, 'agent'); assert.equal(message.authorServiceId, p.principal.id); assert.equal(message.agentId, 'ext'); assert.equal(message.authorUserId, null);
  assert.equal(message.serviceCommandId, `service_${sent.receipt.id}`); assert.equal(message.delivery, 'sent');
  assert.deepEqual(f.commands(), [{ key: `service_${sent.receipt.id}`, state: 'confirmed' }]);
  assert.equal(f.app.webchat.history({ token: session.token, origin }).messages.filter(item => item.kind === 'agent').length, 1);
  assert.equal((await f.api.sendReply(p.actor, input)).receipt.id, sent.receipt.id, 'replay');
  assert.equal(f.commands().length, 1);
  await assert.rejects(f.api.sendReply(p.actor, { ...input, requestId: 'reply_site_0002' }), status(409), 'versão antiga');
  await assert.rejects(f.api.sendReply(q.actor, { ...input, requestId: 'reply_other_001', version: f.conversation(id).version }), status(403), 'outro agente');
  await assert.rejects(f.api.sendReply(hermes.actor, { ...input, requestId: 'reply_hermes_01', version: f.conversation(id).version }), status(403), 'Hermes responde pelo piloto');
  await assert.rejects(f.api.sendReply(p.actor, { ...input, requestId: 'reply_queue_001', conversationId: 'vip-queue', version: 1 }), status(403));
  await assert.rejects(f.api.sendReply(p.actor, { ...input, requestId: 'reply_human_001', conversationId: 'human-owned', version: 1 }), status(403));
  assert.equal(f.commands().length, 1);
  // The scheduled-group capability stays group-only.
  await assert.rejects(f.api.scheduleGroup(p.actor, { ...input, requestId: 'schedule_priv_01', version: f.conversation(id).version, dueAt: new Date(Date.now() + 3600000).toISOString() }), error => [403, 503].includes(error.status));
});

test('responder: pedido de pessoa, insatisfação e mídia recusam com orientação de transferir; limite por hora', async t => {
  const f = await fixture(t), p = f.principal('ext');
  const { id, session } = await ownedConversation(f, p);
  const attempt = (requestId, text = 'Resposta do agente.') => f.api.sendReply(p.actor, { requestId, conversationId: id, version: f.conversation(id).version, text });
  for (const [text, label] of [['Quero falar com um atendente agora', 'pedido de pessoa'], ['Isso é um absurdo, ninguém resolve', 'insatisfação'], ['Quiero hablar con una persona', 'pedido em espanhol']]) {
    await f.say(session, text);
    await assert.rejects(attempt(`guard_${label.replace(/\W+/g, '_')}`), error => error.status === 409 && /elozi_transfer_to_human/.test(error.message), label);
  }
  f.store.mutate(f.admin, f.tenant.id, 'Mídia sintética do cliente', state => { const c = f.store.getConversation(state, id); c.messages.push({ id: 'media-1', kind: 'customer', text: '', attachments: [{ id: 'a1', kind: 'image' }], createdAt: new Date().toISOString() }); c.version++; });
  await assert.rejects(attempt('guard_media_0001'), error => error.status === 409 && /mídia/.test(error.message));
  await f.say(session, 'Obrigado, qual o horário?');
  for (let index = 0; index < 6; index++) assert.equal((await attempt(`hourly_reply_${index}0`)).result.state, 'confirmed');
  await assert.rejects(attempt('hourly_reply_70'), status(429));
  assert.equal(f.commands().length, 6);
});

test('transferir: só conversa própria, fila ou departamento ativo do escopo, nota interna e piloto/runtime invalidados', async t => {
  const f = await fixture(t), p = f.principal('ext'), q = f.principal('ext-2');
  const { id } = await ownedConversation(f, p);
  const base = { conversationId: id, reason: 'Cliente quer negociar prazo especial.' };
  assert.throws(() => f.api.transferToHuman(q.actor, { ...base, requestId: 'transfer_other1', version: f.conversation(id).version }), status(409));
  assert.throws(() => f.api.transferToHuman(p.actor, { ...base, requestId: 'transfer_vip_01', version: f.conversation(id).version, departmentId: 'vip' }), status(403));
  assert.throws(() => f.api.transferToHuman(p.actor, { ...base, requestId: 'transfer_old_01', version: f.conversation(id).version, departmentId: 'old' }), status(409));
  assert.throws(() => f.api.transferToHuman(p.actor, { ...base, requestId: 'transfer_bad_01', version: f.conversation(id).version, reason: '   ' }), status(400));
  assert.equal(f.conversation(id).owner, 'agent');
  const invalidated = [], autopilot = f.app.autopilot.invalidate.bind(f.app.autopilot), runtime = f.app.runtime.invalidateConversation.bind(f.app.runtime);
  f.app.autopilot.invalidate = (scope, ...rest) => { invalidated.push(['autopilot', scope.conversationId]); return autopilot(scope, ...rest); };
  f.app.runtime.invalidateConversation = (actor, tenantId, cid) => { invalidated.push(['runtime', cid]); return runtime(actor, tenantId, cid); };
  const done = f.api.transferToHuman(p.actor, { ...base, requestId: 'transfer_sac_01', version: f.conversation(id).version, departmentId: 'sac' });
  assert.deepEqual(invalidated, [['runtime', id], ['autopilot', id]]);
  assert.equal(done.receipt.state, 'confirmed'); assert.deepEqual([done.result.owner, done.result.departmentId], ['queue', 'sac']);
  const current = f.conversation(id);
  assert.equal(current.owner, 'queue'); assert.equal(current.agentId, null); assert.equal(current.departmentId, 'sac');
  const note = current.messages.find(item => item.kind === 'internal');
  assert.match(note.text, /Motivo: Cliente quer negociar prazo especial\./); assert.equal(note.authorServiceId, p.principal.id);
  assert.equal(current.attendantEvents.at(-1).origin, 'service');
  // After the transfer the agent no longer answers nor closes it.
  await assert.rejects(f.api.sendReply(p.actor, { requestId: 'reply_after_tr1', conversationId: id, version: current.version, text: 'Ainda aqui.' }), status(403));
  assert.throws(() => f.api.closeConversation(p.actor, { requestId: 'close_after_tr1', conversationId: id, version: current.version }), status(409));
});

test('etiquetas: conversa própria ou fila sem responsável, com versão e limites; nunca conversa de pessoa', async t => {
  const f = await fixture(t), p = f.principal('ext');
  const { id } = await ownedConversation(f, p);
  const tags = f.api.setTags(p.actor, { requestId: 'tags_own_00001', conversationId: id, version: f.conversation(id).version, tags: ['entrega', 'entrega', ' prazo '] });
  assert.deepEqual(tags.result.tags, ['entrega', 'prazo']); assert.deepEqual(f.conversation(id).tags, ['entrega', 'prazo']);
  // The read shows the current tags (set_tags replaces the whole list) and which agent owns the conversation.
  const read = f.api.read(p.actor, id, 'read_tags_000001');
  assert.deepEqual(read.conversation.tags, ['entrega', 'prazo']); assert.equal(read.conversation.agentId, f.conversation(id).agentId || null);
  const other = f.visitor(); await f.say(other, 'Outra pergunta');
  const queueId = f.store.tenant(f.admin, f.tenant.id).conversations.find(item => item.remoteSessionId && item.owner === 'queue').id;
  const queue = f.api.setTags(p.actor, { requestId: 'tags_queue_0001', conversationId: queueId, version: f.conversation(queueId).version, tags: ['triagem'] });
  assert.equal(queue.receipt.state, 'confirmed'); assert.deepEqual(f.conversation(queueId).tags, ['triagem']); assert.equal(f.conversation(queueId).owner, 'queue');
  assert.throws(() => f.api.setTags(p.actor, { requestId: 'tags_human_0001', conversationId: 'human-owned', version: 1, tags: ['x'] }), status(409));
  assert.throws(() => f.api.setTags(p.actor, { requestId: 'tags_long_00001', conversationId: id, version: f.conversation(id).version, tags: ['x'.repeat(49)] }), status(400));
  assert.throws(() => f.api.setTags(p.actor, { requestId: 'tags_many_00001', conversationId: id, version: f.conversation(id).version, tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }), status(400));
  assert.throws(() => f.api.setTags(p.actor, { requestId: 'tags_stale_0001', conversationId: id, version: 1, tags: ['y'] }), status(409));
  const client = await f.mcp(p.token), invalid = await client.callTool({ name: 'elozi_set_tags', arguments: { requestId: 'tags_mcp_00001', conversationId: id, version: 1, tags: ['x'], extra: true } }).catch(error => error);
  assert.ok(invalid instanceof Error || invalid.isError, 'campos extras recusados');
});

test('encerrar: só conversa própria e nunca com mensagem do cliente sem resposta; o recibo confirma o encerramento', async t => {
  const f = await fixture(t), p = f.principal('ext');
  const { id } = await ownedConversation(f, p);
  assert.throws(() => f.api.closeConversation(p.actor, { requestId: 'close_unans_001', conversationId: id, version: f.conversation(id).version }), error => error.status === 409 && /não foi respondida/.test(error.message));
  await f.api.sendReply(p.actor, { requestId: 'reply_before_cl', conversationId: id, version: f.conversation(id).version, text: 'Pedido confirmado.' });
  assert.throws(() => f.api.closeConversation(p.actor, { requestId: 'close_other_001', conversationId: 'other-agent', version: 1 }), status(409));
  const closed = f.api.closeConversation(p.actor, { requestId: 'close_done_0001', conversationId: id, version: f.conversation(id).version, reason: 'Dúvida resolvida.' });
  assert.equal(closed.receipt.state, 'confirmed'); assert.equal(closed.receipt.stale, false); assert.equal(f.conversation(id).status, 'closed');
  assert.equal(f.conversation(id).attendantEvents.at(-1).type, 'closed');
  assert.equal(f.api.closeConversation(p.actor, { requestId: 'close_done_0001', conversationId: id, version: closed.result.version - 1, reason: 'Dúvida resolvida.' }).receipt.id, closed.receipt.id, 'replay depois do encerramento');
  assert.equal(f.principals.getReceipt(p.actor, closed.receipt.id).state, 'confirmed');
});

test('eventos: resync inicial, espera acorda com mensagem do escopo, oculta fora do escopo, notas e cursor alheio', async t => {
  const f = await fixture(t), p = f.principal('ext'), q = f.principal('ext-2');
  const { id, session } = await ownedConversation(f, p);
  const first = await f.api.waitForEvents(p.actor, {});
  assert.equal(first.resync, true); assert.deepEqual(first.events, []); assert.match(first.cursor, /^[0-9a-f]{12}-[0-9a-z]+\.[A-Za-z0-9_-]{32}$/);
  const idle = await f.api.waitForEvents(p.actor, { cursor: first.cursor, timeoutMs: 30 });
  assert.equal(idle.timedOut, true); assert.deepEqual(idle.events, []);
  // Out of scope: another channel, another department, another agent's conversation and an internal note.
  f.store.mutate(f.admin, f.tenant.id, 'Mudanças fora do escopo', state => {
    for (const cid of ['wa-queue', 'vip-queue', 'other-agent']) { const c = f.store.getConversation(state, cid); c.messages.push({ id: `${cid}-new`, kind: 'customer', text: 'Nova', createdAt: new Date().toISOString() }); c.version++; }
    const own = f.store.getConversation(state, id); own.messages.push({ id: 'note-x', kind: 'internal', text: 'Nota privada', createdAt: new Date().toISOString() }); own.version++;
  });
  const hidden = await f.api.waitForEvents(p.actor, { cursor: idle.cursor, timeoutMs: 30 });
  assert.deepEqual(hidden.events.filter(event => event.type === 'conversation.message'), [], JSON.stringify(hidden.events));
  assert.equal(JSON.stringify(hidden).includes('Nota privada'), false); assert.equal(JSON.stringify(hidden).includes('assignedUserId'), false);
  const waiting = f.api.waitForEvents(p.actor, { cursor: hidden.cursor, timeoutMs: 5000, types: ['conversation.message'] });
  await sleep(20); await f.say(session, 'Tem troca?');
  const woke = await waiting;
  assert.equal(woke.timedOut, false); assert.equal(woke.events.length, 1);
  assert.deepEqual([woke.events[0].type, woke.events[0].conversationId, woke.events[0].kind, woke.events[0].assignedToMe], ['conversation.message', id, 'customer', true]);
  assert.equal(JSON.stringify(woke).includes('Tem troca?'), false, 'nunca conteúdo');
  // A cursor of another identity starts over: resync, never the other identity's events.
  const foreign = await f.api.waitForEvents(q.actor, { cursor: hidden.cursor, timeoutMs: 30 });
  assert.equal(foreign.resync, true); assert.deepEqual(foreign.events, []);
  await assert.rejects(f.api.waitForEvents(p.actor, { cursor: 'nao-e-um-cursor' }), status(400));
  await assert.rejects(f.api.waitForEvents(p.actor, { timeoutMs: 25001 }), status(400));
  await assert.rejects(f.api.waitForEvents(p.actor, { types: ['run.changed'] }), status(400));
});

test('eventos: uma espera por vez, revalidação ao acordar e desconexão do cliente libera a espera (REST e MCP)', async t => {
  const f = await fixture(t), p = f.principal('ext');
  const { cursor } = await f.api.waitForEvents(p.actor, {});
  const pending = f.api.waitForEvents(p.actor, { cursor, timeoutMs: 2000 });
  await assert.rejects(f.api.waitForEvents(p.actor, { cursor, timeoutMs: 10 }), status(429));
  // Revoked while waiting: the wake answers the revocation, never the events.
  f.principals.revoke(f.admin, f.tenant.id, p.principal.id, { revision: p.principal.revision });
  f.store.mutate(f.admin, f.tenant.id, 'Mudança no escopo durante a espera', state => { const c = f.store.getConversation(state, 'human-owned'); c.tags = ['x']; c.version++; });
  await assert.rejects(pending, error => [401, 409].includes(error.status));
  const r = f.principal('ext');
  const start = await f.rest('/api/service/v1/events/wait', {}, r.token);
  assert.equal(start.status, 200, JSON.stringify(start.data)); assert.equal(start.data.resync, true);
  const controller = new AbortController();
  const aborted = f.rest('/api/service/v1/events/wait', { cursor: start.data.cursor, timeoutMs: 20000 }, r.token, { signal: controller.signal }).catch(error => error);
  await sleep(50); assert.equal(f.api.activeWaits.has(r.principal.id), true);
  controller.abort(); await aborted; await sleep(50);
  assert.equal(f.api.activeWaits.has(r.principal.id), false, 'a desconexão libera a espera');
  const client = await f.mcp(r.token), viaMcp = await client.callTool({ name: 'elozi_wait_for_events', arguments: { cursor: start.data.cursor, timeoutMs: 20 } });
  assert.equal(viaMcp.isError, undefined, JSON.stringify(viaMcp)); assert.equal(viaMcp.structuredContent.timedOut, true);
  // REST routes of the attendant tools answer like MCP.
  const claim = await f.rest('/api/service/v1/conversation-claims', { requestId: 'rest_claim_0001', conversationId: 'vip-queue', version: 1 }, r.token);
  assert.equal(claim.status, 403);
  const quota = f.principals.list(f.admin, f.tenant.id).principals.find(item => item.id === r.principal.id).usage.requests;
  assert.equal(quota, 0, 'esperas e uma ação recusada antes da reserva não consomem a cota diária');
});

test('jornada MCP do atendente: esperar, assumir, ler, responder, etiquetar e encerrar; REST transfere com os mesmos limites', async t => {
  const f = await fixture(t), p = f.principal('ext'), client = await f.mcp(p.token);
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`); return result.structuredContent; };
  const start = await call('elozi_wait_for_events', {});
  assert.equal(start.resync, true);
  const session = f.visitor(); await f.say(session, 'Qual o horário de atendimento?');
  const created = await call('elozi_wait_for_events', { cursor: start.cursor, timeoutMs: 2000 });
  const event = created.events.find(item => item.type === 'conversation.created' || item.type === 'conversation.message');
  assert.ok(event, JSON.stringify(created)); assert.equal(event.assignedToMe, false);
  const id = event.conversationId;
  const claim = await call('elozi_claim_conversation', { requestId: 'mcp_claim_00001', conversationId: id, version: f.conversation(id).version });
  assert.equal(claim.result.owner, 'agent');
  const read = await call('elozi_read_conversation', { requestId: 'mcp_read_000001', conversationId: id });
  assert.equal(read.conversation.owner, 'agent');
  const reply = await call('elozi_send_reply', { requestId: 'mcp_reply_00001', conversationId: id, version: read.conversation.version, text: 'Atendemos das 8h às 18h.' });
  assert.equal(reply.receipt.state, 'confirmed');
  const again = await call('elozi_send_reply', { requestId: 'mcp_reply_00001', conversationId: id, version: read.conversation.version, text: 'Atendemos das 8h às 18h.' });
  assert.equal(again.receipt.id, reply.receipt.id); assert.equal(f.commands().length, 1);
  const tags = await call('elozi_set_tags', { requestId: 'mcp_tags_000001', conversationId: id, version: f.conversation(id).version, tags: ['horario'] });
  assert.deepEqual(tags.result.tags, ['horario']);
  const closed = await call('elozi_close_conversation', { requestId: 'mcp_close_00001', conversationId: id, version: f.conversation(id).version });
  assert.equal(closed.result.status, 'closed'); assert.equal(f.conversation(id).status, 'closed');
  // REST: another conversation, transferred with a reason; replies refused once it belongs to people.
  const other = f.visitor(); await f.say(other, 'Preciso trocar um produto');
  const second = f.store.tenant(f.admin, f.tenant.id).conversations.find(item => item.remoteSessionId && item.owner === 'queue').id;
  const claimed = await f.rest('/api/service/v1/conversation-claims', { requestId: 'rest_claim_0002', conversationId: second, version: f.conversation(second).version }, p.token);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  const transfer = await f.rest('/api/service/v1/human-transfers', { requestId: 'rest_transfer_01', conversationId: second, version: f.conversation(second).version, reason: 'Troca precisa de aprovação.' }, p.token);
  assert.equal(transfer.status, 200, JSON.stringify(transfer.data)); assert.equal(f.conversation(second).owner, 'queue');
  const refused = await f.rest('/api/service/v1/replies', { requestId: 'rest_reply_00001', conversationId: second, version: f.conversation(second).version, text: 'Olá' }, p.token);
  assert.equal(refused.status, 403);
  const tagsRest = await f.rest('/api/service/v1/conversation-tags', { requestId: 'rest_tags_00001', conversationId: second, version: f.conversation(second).version, tags: ['troca'] }, p.token);
  assert.equal(tagsRest.status, 200, JSON.stringify(tagsRest.data));
  const closeRest = await f.rest('/api/service/v1/conversation-closures', { requestId: 'rest_close_00001', conversationId: second, version: f.conversation(second).version }, p.token);
  assert.equal(closeRest.status, 409, 'conversa da equipe não é encerrada pelo agente');
});

test('eventos: esperas longas ou com eventos são livres; só voltas vazias rápidas gastam saldo, com Retry-After curto', async t => {
  const store = new Store(':memory:'), bus = createEventBus();
  const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'wait-policy-qa', name: 'Limitador QA' };
  const tenant = store.createTenant(admin, { name: 'Limitador de eventos QA', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Canal sintético para escopo dos eventos', state => { state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }]; });
  t.after(() => { bus.close(); store.close(); });
  let clock = Date.parse('2026-10-06T12:00:00Z');
  const principals = { now: () => clock, auth: { admin() {}, resolveActor() {} }, revalidate: () => ({ principal: { channelIds: null, departmentIds: null } }) };
  const api = new ServiceApi(store, principals, {}, { events: bus, waitHoldMs: 40 });
  api.inventoryContext = () => ({});
  const actor = { principalId: 'p1', workspaceId: 'mep-demo', tenantId: tenant.id, agentId: 'a1', revision: 1, keyRevision: 1 };
  let { cursor } = await api.waitForEvents(actor, {});
  // Long polls without traffic (the documented 20 s cycle, shortened here) never exhaust the identity.
  for (let index = 0; index < 25; index++) { const idle = await api.waitForEvents(actor, { cursor, timeoutMs: 60 }); assert.equal(idle.timedOut, true); cursor = idle.cursor; }
  // Waits that return at once with events are free too, however many there are.
  for (let index = 0; index < 40; index++) {
    bus.publish({ type: 'conversation.message', tenantId: tenant.id, conversationId: 'c1', channelId: 'site', owner: 'queue', messageId: `m${index}`, kind: 'customer', version: index + 2 });
    const busy = await api.waitForEvents(actor, { cursor, timeoutMs: 20000 }); assert.equal(busy.events.length, 1); cursor = busy.cursor;
  }
  // Quick empty returns draw from the bucket (20, the resync above took one) and get a short Retry-After when it is empty.
  for (let index = 0; index < 19; index++) await api.waitForEvents(actor, { cursor, timeoutMs: 0 });
  await assert.rejects(api.waitForEvents(actor, { cursor, timeoutMs: 0 }), error => error.status === 429 && error.retryAfter >= 1 && error.retryAfter <= 30);
  assert.equal(api.activeWaits.has('p1'), false, 'a refused wait holds nothing');
  clock += 30000;
  await api.waitForEvents(actor, { cursor, timeoutMs: 0 });
  await assert.rejects(api.waitForEvents(actor, { cursor, timeoutMs: 0 }), status(429));
  // The paced identity still receives what happens: a wait that delivers events needs no balance.
  clock += 30000;
  bus.publish({ type: 'conversation.message', tenantId: tenant.id, conversationId: 'c1', channelId: 'site', owner: 'queue', messageId: 'm-final', kind: 'customer', version: 99 });
  assert.equal((await api.waitForEvents(actor, { cursor, timeoutMs: 20000 })).events.length, 1);
  assert.throws(() => new ServiceApi(store, principals, {}, { events: bus, waitHoldMs: -1 }), TypeError);
});

test('pedido de apoio do agente e a decisão da equipe avisam as pendências de quem vê a conversa, sem o motivo', async t => {
  const f = await fixture(t), p = f.principal('ext', ['conversation.read', 'handoff.request']);
  const session = f.visitor(); await f.say(session, 'Preciso de ajuda com meu pedido.');
  const id = f.siteConversation().id, start = f.app.events.head();
  const { request } = f.api.handoff(p.actor, { requestId: 'apoio_sintetico_01', conversationId: id, version: f.conversation(id).version, reason: 'Motivo sintético reservado.' });
  const pulses = () => f.app.events.since(f.tenant.id, start, { limit: 500 }).events.filter(event => event.type === 'attention.changed');
  assert.equal(pulses().length, 1);
  assert.deepEqual([pulses()[0].conversationId, pulses()[0].channelId], [id, 'site']);
  assert.equal(JSON.stringify(pulses()).includes('Motivo sintético'), false);
  f.api.decide(f.admin, f.tenant.id, id, request.id, { version: request.version, action: 'acknowledge', reason: 'Assumido pela equipe.' });
  assert.equal(pulses().length, 2, 'the decision also changes the attention of the team');
});

test('limite privado só altera a tupla exata; recusa antes de recibo/outbox e replay não reenvia', async t => {
  const f = await fixture(t), p = f.principal('ext', ATTENDANT, { channelIds: ['site', 'wa'] });
  const other = f.principal('ext');
  const policy = { tenantId: f.tenant.id, principalId: p.principal.id, channelId: 'site', replyLimitPerHour: 60 };
  const api = new ServiceApi(f.store, f.principals, f.app.runtime, { ...f.api.attendant, privateReplyLimits: [policy] });
  const { id } = await ownedConversation(f, p);
  const clock = Date.parse('2026-10-15T12:00:00.000Z');
  f.principals.now = () => clock;
  const history = (principalId, count, prefix) => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, kind: 'agent', text: 'Resposta sintética', authorServiceId: principalId,
    createdAt: new Date(clock - 1000).toISOString()
  }));
  f.store.mutate(f.admin, f.tenant.id, 'Histórico sintético do limite privado', state => {
    state.conversations.find(c => c.id === id).messages.push(...history(p.principal.id, 59, 'own'), ...history(other.principal.id, 6, 'other'));
    const wa = state.conversations.find(c => c.id === 'wa-queue');
    wa.owner = 'agent'; wa.agentId = 'ext'; wa.messages.push(...history(p.principal.id, 6, 'wa'));
  });
  const input = { requestId: 'private_limit_reply_60', conversationId: id, version: f.conversation(id).version, text: 'Resposta autorizada 60.' };
  const sent = await api.sendReply(p.actor, input);
  assert.equal(sent.result.state, 'confirmed');
  assert.equal((await api.sendReply(p.actor, input)).receipt.id, sent.receipt.id, 'known receipt bypasses guardrail without another send');
  const usage = api.me(p.actor).principal.usage.requests;
  const refused = { ...input, requestId: 'private_limit_reply_61', version: f.conversation(id).version };
  await assert.rejects(api.sendReply(p.actor, refused), error => error instanceof ServiceReplyRateLimitError && error.code === 'SERVICE_REPLY_RATE_LIMIT' && error.admissionRejected === true && error.retryAfter >= 1 && error.retryAfter <= 3600);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_principal_receipts WHERE request_id=?').get(refused.requestId).n, 0);
  assert.equal(f.commands().length, 1, 'the refused action never reaches the outbox');
  assert.equal(api.me(p.actor).principal.usage.requests, usage, 'rejection consumes no quota');
  await assert.rejects(api.sendReply(other.actor, { ...refused, requestId: 'private_other_principal' }), error => error instanceof ServiceReplyRateLimitError && /6 respostas/.test(error.message));
  await assert.rejects(api.sendReply(p.actor, { ...refused, requestId: 'private_other_channel', conversationId: 'wa-queue', version: f.conversation('wa-queue').version }), error => error instanceof ServiceReplyRateLimitError && /6 respostas/.test(error.message));
  assert.deepEqual(api.me(p.actor).replyRateLimits, { defaultPerHour: 6, overrides: [{ channelId: 'site', replyLimitPerHour: 60 }], channelPolicies: [], teamLoopGuardPerMinute: 60 });
  assert.deepEqual(api.me(other.actor).replyRateLimits, { defaultPerHour: 6, overrides: [], channelPolicies: [], teamLoopGuardPerMinute: 60 });
});

test('override privado de 12/h/conversa mantém isolamento, contrato autônomo v2 e restrições protegidas', async t => {
  const f = await fixture(t);
  f.store.mutate(f.admin, f.tenant.id, 'Canal pessoal sintético excluído', state => {
    state.channels.push({ id: 'personal', kind: 'webchat', name: 'Pessoal sintético', state: 'planned' });
  });
  const conversationPolicy = { customerMessagesAfter: '2026-10-24T14:58:00.000Z', excludedChannelIds: ['personal'], allowGroups: false };
  const p = f.principal('ext', ATTENDANT, { channelIds: ['site', 'wa'], dailyRequests: 500, maxConcurrent: 2, conversationPolicy });
  const other = f.principal('ext');
  const { id } = await ownedConversation(f, p);
  const protectedRow = () => ({ ...f.store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(p.principal.id) });
  const beforeRow = protectedRow(), before = f.api.me(p.actor);
  const api = new ServiceApi(f.store, f.principals, f.app.runtime, { ...f.api.attendant,
    privateReplyLimits: [{ tenantId: f.tenant.id, principalId: p.principal.id, channelId: 'site', replyLimitPerHour: 12 }] });
  const clock = Date.now(); f.principals.now = () => clock;
  const history = (principalId, count, prefix) => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, kind: 'agent', text: 'Resposta sintética', authorServiceId: principalId,
    createdAt: new Date(clock - 1000).toISOString()
  }));
  f.store.mutate(f.admin, f.tenant.id, 'Histórico sintético de 11 respostas e controles de isolamento', state => {
    state.conversations.find(c => c.id === id).messages.push(...history(p.principal.id, 11, 'twelve-own'), ...history(other.principal.id, 6, 'twelve-other'));
    const wa = state.conversations.find(c => c.id === 'wa-queue');
    wa.owner = 'agent'; wa.agentId = 'ext';
    wa.messages.push({ id: 'twelve-wa-customer', kind: 'customer', text: 'Qual o horário?', createdAt: new Date(clock).toISOString() }, ...history(p.principal.id, 6, 'twelve-wa'));
    for (const [cid, channelId, kind, createdAt] of [
      ['twelve-cutoff', 'site', 'direct', '2026-10-24T14:57:59.000Z'],
      ['twelve-excluded', 'personal', 'direct', new Date(clock).toISOString()],
      ['twelve-group', 'site', 'group', new Date(clock).toISOString()]
    ]) state.conversations.push({ id: cid, contact: 'Controle sintético', channelId, departmentId: 'sac', owner: 'agent', agentId: 'ext', status: 'open', version: 1, conversationKind: kind,
      messages: [{ id: `${cid}-customer`, kind: 'customer', text: 'Qual o horário?', createdAt }] });
  });
  const input = { requestId: 'quota12_reply_twelfth', conversationId: id, version: f.conversation(id).version, text: 'Décima segunda resposta autorizada.' };
  const sent = await api.sendReply(p.actor, input);
  assert.equal(sent.receipt.state, 'confirmed'); assert.equal(sent.result.state, 'confirmed');
  assert.equal(f.conversation(id).messages.filter(m => m.kind === 'agent' && m.authorServiceId === p.principal.id).length, 12);
  assert.equal((await api.sendReply(p.actor, input)).receipt.id, sent.receipt.id, 'replay não envia novamente');
  const rejectWithoutAdmission = async (actor, requestId, conversationId, check) => {
    const usage = api.me(actor).principal.usage.requests, commands = f.commands();
    await assert.rejects(api.sendReply(actor, { requestId, conversationId, version: f.conversation(conversationId).version, text: 'Resposta não admitida.' }), check);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_principal_receipts WHERE request_id=?').get(requestId).n, 0);
    assert.deepEqual(f.commands(), commands, 'recusa anterior ao outbox');
    assert.equal(api.me(actor).principal.usage.requests, usage, 'recusa não consome cota diária');
  };
  const rate = max => error => error instanceof ServiceReplyRateLimitError && error.status === 429
    && error.code === 'SERVICE_REPLY_RATE_LIMIT' && error.admissionRejected === true
    && error.rateLimit.window === 'hour' && error.rateLimit.max === max && error.retryAfter >= 1 && error.retryAfter <= 3600;
  await rejectWithoutAdmission(p.actor, 'quota12_reply_thirteenth', id, rate(12));
  await rejectWithoutAdmission(other.actor, 'quota12_other_principal', id, rate(6));
  await rejectWithoutAdmission(p.actor, 'quota12_other_channel', 'wa-queue', rate(6));
  for (const cid of ['twelve-cutoff', 'twelve-excluded', 'twelve-group']) await rejectWithoutAdmission(p.actor, `quota12_deny_${cid}`, cid, status(403));
  assert.equal(f.commands().length, 1);
  // The same principal/channel retains a separate hourly counter for another conversation.
  const session = f.visitor(); await f.say(session, 'Qual o horário?');
  const fresh = f.store.tenant(f.admin, f.tenant.id).conversations.find(c => c.remoteSessionId && c.owner === 'queue');
  api.claimConversation(p.actor, { requestId: 'quota12_claim_fresh', conversationId: fresh.id, version: fresh.version });
  assert.equal((await api.sendReply(p.actor, { requestId: 'quota12_reply_fresh', conversationId: fresh.id, version: f.conversation(fresh.id).version, text: 'Outra conversa autorizada.' })).result.state, 'confirmed');
  assert.equal(f.commands().length, 2);
  const me = api.me(p.actor);
  assert.deepEqual(me.replyRateLimits, { defaultPerHour: 6, overrides: [{ channelId: 'site', replyLimitPerHour: 12 }], channelPolicies: [], teamLoopGuardPerMinute: 60 });
  assert.deepEqual(api.me(other.actor).replyRateLimits.overrides, []);
  assert.equal(me.apiVersion, 2); assert.equal(me.responsePolicy.version, 2);
  assert.equal(me.agent.mode, 'autonomous'); assert.equal(me.agent.adapterMode, 'copilot');
  assert.equal(me.responsePolicy.effectiveMode, 'autonomous');
  assert.equal(me.humanApprovalRequired, false); assert.equal(me.responsePolicy.humanApprovalRequired, false);
  assert.equal(me.responsePolicy.requiresHumanConversationAuthorization, false);
  assert.equal(me.responsePolicy.requiresConversationAuthorization, false);
  assert.equal(me.responsePolicy.requiresServerConversationAuthorization, true);
  assert.equal(me.responsePolicy.privateReplies.requiresAgentAssignment, true);
  assert.equal(me.responsePolicy.privateReplies.requiresPerMessageApproval, false);
  assert.deepEqual(me.groupActions, { send: false, schedule: false, scope: 'selected-groups', requiresPerMessageApproval: false });
  assert.deepEqual(me.principal.conversationPolicy, conversationPolicy);
  assert.deepEqual(me.responsePolicy.conversationPolicy, conversationPolicy);
  const stableMetadata = ({ usage, lastSeenAt, ...protectedMetadata }) => protectedMetadata;
  assert.deepEqual(stableMetadata(me.principal), stableMetadata(before.principal));
  assert.deepEqual(protectedRow(), beforeRow, 'grants, escopos, cota 500, concorrência 2, revisões e credencial persistidos intactos');
  assert.deepEqual(me.responsePolicy, before.responsePolicy, 'override de taxa não altera autorização');
  assert.equal(f.store.tenant(f.admin, f.tenant.id).agents.find(a => a.id === 'ext').mode, 'copilot');
});

test('limite privado exige configuração exata e autorizada no startup, sem wildcard ou novo grant', async t => {
  const f = await fixture(t), p = f.principal('ext');
  const valid = { tenantId: f.tenant.id, principalId: p.principal.id, channelId: 'site', replyLimitPerHour: 60 };
  const api = value => new ServiceApi(f.store, f.principals, f.app.runtime, { ...f.api.attendant, privateReplyLimits: value });
  assert.equal(api(JSON.stringify([valid])).privateReplyLimits[0].replyLimitPerHour, 60);
  for (const value of ['{', null, {}, [null], [{ ...valid, replyLimitPerHour: 5 }], [{ ...valid, replyLimitPerHour: 301 }],
    [{ ...valid, replyLimitPerHour: 6.5 }], [{ ...valid, channelId: '*' }], [{ ...valid, channelId: 'wa' }],
    [{ ...valid, tenantId: 'wrong-tenant' }], [{ ...valid, principalId: 'unknown-principal' }],
    [{ ...valid, extra: true }], [valid, valid]]) assert.throws(() => api(value), TypeError);
  assert.equal(f.principals.list(f.admin, f.tenant.id).principals[0].revision, 1);
  assert.equal(f.commands().length, 0);
});

test('429 de adapter depois de reserve continua desconhecido e não ganha sinal de recusa', async t => {
  const f = await fixture(t), p = f.principal('ext'), { id } = await ownedConversation(f, p);
  const error = Object.assign(new Error('Fornecedor limitou o envio.'), { status: 429, code: 'SERVICE_REPLY_RATE_LIMIT', admissionRejected: true, retryAfter: 20 });
  const api = new ServiceApi(f.store, f.principals, f.app.runtime, { ...f.api.attendant, sendPrivate: async () => { throw error; } });
  const input = { requestId: 'adapter_429_after_admit', conversationId: id, version: f.conversation(id).version, text: 'Resposta sintética.' };
  await assert.rejects(api.sendReply(p.actor, input), caught => caught === error);
  assert.equal(api.readReceipt(p.actor, input.requestId).receipt.state, 'unknown');
  const wrapped = businessError(error).structuredContent.error;
  assert.equal(wrapped.status, 429);
  assert.equal(Object.hasOwn(wrapped, 'code'), false);
  assert.equal(Object.hasOwn(wrapped, 'admissionRejected'), false);
});

test('MCP anuncia recusa somente do guardrail anterior à admissão', async t => {
  const f = await fixture(t), p = f.principal('ext'), { id } = await ownedConversation(f, p);
  f.store.mutate(f.admin, f.tenant.id, 'Seis respostas sintéticas para MCP', state => {
    state.conversations.find(c => c.id === id).messages.push(...Array.from({ length: 6 }, (_, index) => ({
      id: `mcp-limit-${index}`, kind: 'agent', text: 'Resposta sintética', authorServiceId: p.principal.id, createdAt: new Date().toISOString()
    })));
  });
  const client = await f.mcp(p.token), requestId = 'mcp_reply_rate_limited';
  const result = await client.callTool({ name: 'elozi_send_reply', arguments: { requestId, conversationId: id, version: f.conversation(id).version, text: 'Não admitida.' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.status, 429);
  assert.equal(result.structuredContent.error.code, 'SERVICE_REPLY_RATE_LIMIT');
  assert.equal(result.structuredContent.error.admissionRejected, true);
  assert.ok(result.structuredContent.error.retryAfter >= 1 && result.structuredContent.error.retryAfter <= 3600);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_principal_receipts WHERE request_id=?').get(requestId).n, 0);
  assert.equal(f.commands().length, 0);
});

test('configuração privada fixa: ausente ou memória mantém padrão; arquivo inválido não é aplicado', async t => {
  const f = await fixture(t), p = f.principal('ext');
  const directory = mkdtempSync(join(tmpdir(), 'elozi-private-reply-limits-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const database = join(directory, 'sandbox.sqlite'), path = join(directory, 'private-service-reply-limits.json');
  const policy = [{ tenantId: f.tenant.id, principalId: p.principal.id, channelId: 'site', replyLimitPerHour: 60 }];
  const startup = environment => new ServiceApi(f.store, f.principals, f.app.runtime, { ...f.api.attendant, privateReplyLimits: loadPrivateServiceReplyLimits(database, environment) });
  assert.deepEqual(loadPrivateServiceReplyLimits(':memory:', {}), []);
  assert.deepEqual(loadPrivateServiceReplyLimits(database, {}), []);
  assert.deepEqual(startup({}).me(p.actor).replyRateLimits.overrides, []);
  writeFileSync(path, JSON.stringify(policy), { mode: 0o600 });
  assert.deepEqual(startup({}).me(p.actor).replyRateLimits.overrides, [{ channelId: 'site', replyLimitPerHour: 60 }]);
  assert.deepEqual(startup({ MEPCHAT_PRIVATE_REPLY_LIMITS: '[]' }).me(p.actor).replyRateLimits.overrides, [], 'explicit environment wins over the file');
  for (const bytes of ['{', JSON.stringify([{ ...policy[0], replyLimitPerHour: 301 }]), Buffer.alloc(65537, 32), Buffer.from([255])]) {
    writeFileSync(path, bytes);
    assert.throws(() => startup({}), TypeError);
  }
  unlinkSync(path); mkdirSync(path);
  assert.throws(() => startup({}), TypeError, 'a directory is not configuration');
  rmdirSync(path);
  if (process.platform !== 'win32') {
    const target = join(directory, 'owned-target.json'); writeFileSync(target, JSON.stringify(policy), { mode: 0o600 });
    symlinkSync(target, path);
    assert.throws(() => startup({}), TypeError, 'even a symlink to an owned regular file is rejected');
  }
  assert.equal(f.commands().length, 0);
});
