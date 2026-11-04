import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals, serviceGroupContext } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { AgentAutopilot, autopilotCovers, normalizeAutopilotConfig } from '../src/agent-autopilot.js';
import { KnowledgeBase } from '../src/knowledge.js';
import { GroupSummaries } from '../src/group-summaries.js';
import { isTelegramAccountChannel, telegramAccountAiAllowed, assertTelegramAccountAiAllowed, TELEGRAM_ACCOUNT_HUMAN_ONLY_REASON } from '../src/telegram-account-policy.js';

const denied = error => error.status === 403 && error.message === TELEGRAM_ACCOUNT_HUMAN_ONLY_REASON;
const settle = () => new Promise(resolve => setImmediate(resolve));
const marker = 'personal-content-must-not-reach-ai';
function fixture(t, { provider = async () => 'Rascunho sintético', events = null } = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  const admin = auth.actor(auth.insertUser({ username: 'telegram.policy.qa', name: 'Admin QA' }, Buffer.alloc(16, 7), Buffer.alloc(64, 7), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Telegram policy QA', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture sintética', state => {
    state.channels = [{ id: 'personal', name: 'Conta pessoal', kind: 'telegram_user', transport: 'telegram-user', state: 'connected' }, { id: 'bot', name: 'Bot existente', kind: 'telegram', transport: 'telegram-bot', state: 'connected', selectedGroupIds: ['-123'] }];
    state.agents = ['hermes', 'external'].map(id => ({ id, name: id, provider: id === 'hermes' ? 'hermes' : 'mcp', mode: 'copilot', configured: true, version: 1, description: 'Fixture', tools: [], knowledgeGrants: [] }));
    state.departments = [{ id: 'support', name: 'Suporte', active: true }];
    const direct = (id, channelId, text) => ({ id, channelId, departmentId: 'support', contact: id, version: 1, status: 'open', owner: 'human', assignedUserId: admin.userId, participants: [], conversationKind: 'direct', messages: [{ id: 'm_' + id, kind: 'customer', text, createdAt: new Date().toISOString() }] });
    state.conversations = [direct('private', 'personal', marker), direct('allowed', 'bot', 'Texto público sintético'), { ...direct('private_group', 'personal', marker), conversationKind: 'group', remoteChatId: '-456' }, { ...direct('allowed_group', 'bot', 'Texto público sintético'), conversationKind: 'group', remoteChatId: '-123' }];
  });
  const calls = [], knowledge = new KnowledgeBase(store), principals = new ServicePrincipals(store, auth);
  const runtime = new AgentRuntime(store, { knowledge, validateInitiator: run => !run.serviceId || principals.runCurrent(run), providerCall: context => { calls.push(context); return provider(context); } });
  const api = new ServiceApi(store, principals, runtime, { events });
  const service = (agentId = 'hermes') => {
    const capabilities = ['conversation.read', 'company.read', 'company.propose', 'events.read', 'handoff.request', agentId === 'external' ? 'reply.submit' : 'reply.draft'];
    const created = principals.create(admin, tenant.id, { name: 'Serviço QA ' + agentId, agentId, capabilities, channelIds: null, departmentIds: null, dailyRequests: 100, maxConcurrent: 3, ttlHours: 24 });
    return principals.authenticate('Bearer ' + created.token);
  };
  t.after(() => store.close());
  return { store, auth, admin, tenant, principals, runtime, api, knowledge, calls, service, current: () => store.tenant(admin, tenant.id), makePersonal: () => store.mutate(admin, tenant.id, 'Mudança sintética de transporte', state => { state.channels.find(channel => channel.id === 'bot').transport = 'telegram-user'; }) };
}

test('política usa canal persistido, ambos discriminantes e nunca aceita consentimento artificial', () => {
  const tenant = { channels: [{ id: 'p', kind: 'telegram_user' }, { id: 't', kind: 'telegram', transport: 'telegram-user' }, { id: 'b', kind: 'telegram', transport: 'telegram-bot' }], conversations: [{ id: 'c', channelId: 'p' }] };
  assert.equal(isTelegramAccountChannel(tenant.channels[0]), true);
  assert.equal(isTelegramAccountChannel(tenant.channels[1]), true);
  assert.equal(isTelegramAccountChannel(tenant.channels[2]), false);
  assert.equal(telegramAccountAiAllowed(tenant, { conversationId: 'c', channelId: 'b', consent: true }), false);
  assert.equal(telegramAccountAiAllowed(tenant, { conversationId: 'removed', channelIdAtStart: 'p' }), false);
  assert.throws(() => assertTelegramAccountAiAllowed(tenant, 'c'), denied);
  assert.equal(telegramAccountAiAllowed(tenant, { channelId: 'b' }), true);
});

test('MCP com channel_ids=null omite conteúdo pessoal nas listagens e nega leitura, busca, histórico e rascunho', async t => {
  const f = fixture(t), actor = f.service();
  assert.equal(f.principals.list(f.admin, f.tenant.id).principals[0].channelIds, null);
  assert.deepEqual(f.api.inbox(actor, { requestId: 'inbox_policy_001' }).conversations.map(item => item.id).sort(), ['allowed', 'allowed_group']);
  assert.deepEqual(f.api.listGroups(actor, { requestId: 'groups_policy_001' }).groups.map(item => item.conversationId), ['allowed_group']);
  assert.equal(f.api.searchConversations(actor, { requestId: 'search_policy_001', query: marker }).conversations.length, 0);
  assert.equal(f.api.readCompany(actor, 'company_policy_001').channels.some(channel => channel.id === 'personal'), true);
  assert.throws(() => f.api.read(actor, 'private', 'read_policy_001'), denied);
  assert.throws(() => f.api.readConversationHistory(actor, { requestId: 'history_policy_001', conversationId: 'private' }), denied);
  assert.throws(() => f.api.readGroupHistory(actor, { requestId: 'group_history_policy_001', conversationId: 'private_group' }), denied);
  assert.throws(() => f.api.searchConversations(actor, { requestId: 'search_policy_002', query: marker, channelId: 'personal' }), denied);
  await assert.rejects(f.api.draft(actor, { requestId: 'draft_policy_001', conversationId: 'private', version: 1 }), denied);
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.read(actor, 'allowed', 'read_policy_002').conversation.messages[0].text, 'Texto público sintético');
  // Human core access and recorded messages remain intact.
  assert.equal(f.store.getConversation(f.current(), 'private').messages[0].text, marker);
});

test('MCP não recebe nem reapresenta rascunho externo pessoal', t => {
  const f = fixture(t), actor = f.service('external');
  assert.throws(() => f.api.submitDraft(actor, { requestId: 'submit_policy_001', conversationId: 'private', version: 1, text: marker }), denied);
  const first = f.api.submitDraft(actor, { requestId: 'submit_policy_002', conversationId: 'allowed', version: 1, text: 'Rascunho permitido' });
  assert.equal(first.run.draft, 'Rascunho permitido'); f.makePersonal();
  assert.throws(() => f.api.submitDraft(actor, { requestId: 'submit_policy_002', conversationId: 'allowed', version: 1, text: 'Rascunho permitido' }), denied);
  assert.equal(f.runtime.list(f.admin, f.tenant.id).find(run => run.id === first.run.id).draft, null);
});

test('copiloto, enqueue, prévia e conhecimento negam pessoais antes de chamar provedor', async t => {
  const f = fixture(t), input = { agentId: 'hermes', version: 1 };
  await assert.rejects(f.runtime.start(f.admin, f.tenant.id, 'private', input), denied);
  assert.throws(() => f.runtime.enqueue(f.admin, f.tenant.id, 'private', input), denied);
  await assert.rejects(f.runtime.preview(f.admin, f.tenant.id, 'hermes', { conversationId: 'private', conversationVersion: 1 }), denied);
  const current = f.current(), agent = current.agents[0];
  assert.throws(() => f.knowledge.snapshot(current, agent, 'private'), denied);
  assert.throws(() => f.knowledge.search(current, agent, marker, {}, 'private'), denied);
  assert.equal(f.knowledge.current(current, { conversationId: 'private' }), false);
  assert.equal(f.knowledge.current(current, { conversationId: 'allowed' }), true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.start(f.admin, f.tenant.id, 'allowed', input)).state, 'draft');
});

test('conversão em canal pessoal antes do despacho invalida run sem chamada ao provedor', async t => {
  const f = fixture(t), pending = f.runtime.start(f.admin, f.tenant.id, 'allowed', { agentId: 'hermes', version: 1 });
  f.makePersonal(); const result = await pending;
  assert.equal(result.state, 'invalidated'); assert.equal(result.draft, null); assert.equal(result.humanOnly, true); assert.equal(f.calls.length, 0);
});

test('conversão durante chamada oculta retorno tardio, histórico e replay do copiloto', async t => {
  let finish; const f = fixture(t, { provider: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.runtime.start(f.admin, f.tenant.id, 'allowed', { agentId: 'hermes', version: 1, runId: 'run_policy_001' });
  await settle(); assert.equal(f.calls.length, 1); f.makePersonal(); finish(marker);
  const result = await pending;
  assert.equal(result.state, 'invalidated'); assert.equal(result.draft, null); assert.equal(JSON.stringify(result).includes(marker), false);
  f.store.mutate(f.admin, f.tenant.id, 'Histórico sintético', state => { const run = state.runs[0]; run.toolProposal = { title: marker }; run.toolSteps = [{ title: marker, toolName: marker }]; run.knowledgeReferences = [{ excerpt: marker }]; });
  assert.equal(JSON.stringify(f.runtime.list(f.admin, f.tenant.id)).includes(marker), false);
  assert.equal(JSON.stringify(f.runtime.history(f.admin, f.tenant.id)).includes(marker), false);
  await assert.rejects(f.runtime.start(f.admin, f.tenant.id, 'allowed', { agentId: 'hermes', version: 1, runId: 'run_policy_001' }), denied);
});

test('prévia não revela resposta se o transporte muda durante a chamada', async t => {
  let finish; const f = fixture(t, { provider: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.runtime.preview(f.admin, f.tenant.id, 'hermes', { conversationId: 'allowed', conversationVersion: 1 });
  f.makePersonal(); finish(marker); await assert.rejects(pending, denied); assert.equal(f.calls.length, 1);
});

test('resumo pessoal nega primeira chamada e cache/replay após mudança do transporte', async t => {
  const f = fixture(t); let calls = 0;
  const summaries = new GroupSummaries(f.store, { authorize: () => true, providerCall: async () => { calls++; return { text: marker }; } });
  const input = { version: 1, agentId: 'hermes', commandId: 'summary_policy_001' };
  await assert.rejects(summaries.summarize(f.admin, f.tenant.id, 'private_group', input), denied); assert.equal(calls, 0);
  assert.throws(() => serviceGroupContext(f.current(), f.current().conversations.find(item => item.id === 'private_group')), denied);
  assert.equal((await summaries.summarize(f.admin, f.tenant.id, 'allowed_group', input)).state, 'ready'); f.makePersonal();
  await assert.rejects(summaries.summarize(f.admin, f.tenant.id, 'allowed_group', input), denied); assert.equal(calls, 1); summaries.close();
});

test('resumo não devolve conteúdo quando o transporte muda durante a chamada', async t => {
  const f = fixture(t); let finish;
  const summaries = new GroupSummaries(f.store, { authorize: () => true, providerCall: () => new Promise(resolve => { finish = resolve; }) });
  const pending = summaries.summarize(f.admin, f.tenant.id, 'allowed_group', { version: 1, agentId: 'hermes', commandId: 'summary_policy_late' });
  f.makePersonal(); finish({ text: marker }); await assert.rejects(pending, denied); summaries.close();
});

test('autopilot não configura, admite nem continua job pessoal, preservando bot existente', t => {
  const f = fixture(t), current = f.current(), config = { enabled: true, channelIds: ['personal', 'bot'], requireKnowledge: false };
  assert.throws(() => normalizeAutopilotConfig(config, { tenant: current }), denied);
  assert.equal(normalizeAutopilotConfig({ ...config, enabled: false }, { tenant: current }).enabled, false);
  current.agents[0].autopilot = config;
  for (const conversation of current.conversations) { conversation.owner = 'agent'; conversation.agentId = 'hermes'; conversation.assignedUserId = null; }
  const privateConversation = current.conversations[0], allowed = current.conversations[1];
  assert.equal(autopilotCovers(current, privateConversation), false); assert.equal(autopilotCovers(current, allowed), true);
  const autopilot = new AgentAutopilot(f.store, { runtime: f.runtime, knowledge: f.knowledge, send: () => assert.fail('Envio não autorizado pelo teste'), handoff: () => {}, authorize: () => true, autoDrain: false });
  assert.equal(autopilot._eligible(current, privateConversation.id, privateConversation.messages[0].id), null);
  f.store.mutate(f.admin, f.tenant.id, 'Autopilot sintético legado', state => { state.agents[0].autopilot = config; for (const conversation of state.conversations) { conversation.owner = 'agent'; conversation.agentId = 'hermes'; conversation.assignedUserId = null; } });
  assert.equal(autopilot.receive(f.tenant.id, privateConversation.id, privateConversation.messages[0].id), null);
  const accepted = autopilot.receive(f.tenant.id, allowed.id, allowed.messages[0].id);
  const botJob = f.current().agentAutopilotJobs.find(job => job.id === accepted.id);
  assert.equal(autopilot._route(f.current(), botJob).ok, true);
  f.makePersonal(); const route = autopilot._route(f.current(), botJob);
  assert.equal(route.ok, false); assert.equal(route.reason, 'channel_unavailable'); autopilot.close();
});

test('escopo de eventos MCP exclui pessoais e revalida conversão durante espera', async t => {
  let finish;
  const f = fixture(t, { events: { waitFor: () => new Promise(resolve => { finish = resolve; }) } }), actor = f.service();
  const principal = f.api.me(actor).principal; assert.deepEqual(f.api.eventScope(actor, principal).channelIds, ['bot']);
  const pending = f.api.waitForEvents(actor, { timeoutMs: 0 });
  f.makePersonal(); finish({ events: [{ type: 'conversation.message', tenantId: f.tenant.id, conversationId: 'allowed', channelId: 'bot', departmentId: 'support', owner: 'human', version: 1, kind: 'customer', messageId: 'm_allowed' }], cursor: 'synthetic-cursor', timedOut: false });
  assert.deepEqual((await pending).events, []);
});
