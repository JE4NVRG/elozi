// Agent as attendant end to end through createApp: change bus → AgentAutopilot → AgentRuntime (synthetic provider) →
// outbox → webchat transport (synthetic: no network), with the real authorization hooks of server.js. No external
// transport, provider, port or database is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const origin = 'https://loja.example.test';
const QUESTION = 'Qual é o prazo de entrega para as capitais?';
const ANSWER = 'Os pedidos são entregues em até cinco dias úteis nas capitais.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, ms = 5000, label = 'condição') {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Tempo esgotado: ${label}`); await sleep(10); }
}

function fixture(t, { providerCall, autopilot = {} } = {}) {
  const key = Buffer.alloc(32, 23), external = [], contexts = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio do piloto automático'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin: 'https://elozi.example.test', mcpFetchImpl: deny,
    providerCall: async context => { contexts.push(context); return providerCall ? providerCall(context) : ANSWER; },
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny },
    autopilotOptions: { retryDelayMs: 10 } });
  const { store, auth, knowledge, webchat, operations } = app;
  let sequence = 0;
  const member = (role, tenantIds = []) => {
    const row = auth.insertUser({ username: 'autopilot.e2e.' + ++sequence, name: 'Pessoa sintética ' + sequence }, Buffer.alloc(16, sequence), Buffer.alloc(64, sequence), role, tenantIds, 'mep-demo');
    return auth.session(row).actor;
  };
  const admin = member('reseller'), tenant = store.createTenant(admin, { name: 'Loja sintética', segment: 'Varejo' });
  store.mutate(admin, tenant.id, 'Fixture sintética do piloto automático', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }];
    state.departments = [{ id: 'sac', name: 'SAC', active: true, memberIds: [], distribution: 'manual', cursor: 0, version: 1 }];
    state.agents = [{ id: 'hermes-1', name: 'Hermes Atendente', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Atenda clientes da loja.', tools: [],
      autopilot: { enabled: true, channelIds: ['site'], maxRepliesPerHour: 6, requireKnowledge: true, handoffDepartmentId: 'sac', ...autopilot } }];
  });
  webchat.configure(admin, tenant.id, 'site', { version: 0, origins: [origin] });
  let source = knowledge.create(admin, tenant.id, { title: 'Entregas', content: 'Prazo de entrega: os pedidos são entregues em até cinco dias úteis nas capitais. Trocas em até sete dias.' });
  source = knowledge.publish(admin, tenant.id, source.id, { version: source.version });
  knowledge.setGrants(admin, tenant.id, 'hermes-1', { version: 1, grants: [{ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }] });
  const operator = member('operator', [tenant.id]);
  const state = () => store.tenant(admin, tenant.id), conversation = () => state().conversations[0], jobs = () => state().agentAutopilotJobs || [];
  const visitor = () => { const challenge = webchat.challenge({ tenantId: tenant.id, channelId: 'site', origin }); return webchat.openSession({ tenantId: tenant.id, channelId: 'site', origin, challenge: challenge.challenge, name: 'Visitante sintético' }); };
  let messageKey = 0;
  const say = (session, text = QUESTION) => webchat.receive({ token: session.token, text, clientMessageId: `autopilot-e2e-${String(++messageKey).padStart(4, '0')}`, origin });
  const assign = (owner = 'agent', extra = {}) => operations.assign(admin, tenant.id, conversation().id, { version: conversation().version, owner, ...(owner === 'agent' ? { agentId: 'hermes-1' } : {}), ...extra });
  const commands = () => store.db.prepare('SELECT idempotency_key AS key,state,payload FROM outbound_commands WHERE tenant_id=?').all(tenant.id);
  const agentMessages = () => conversation().messages.filter(message => message.kind === 'agent');
  t.after(async () => {
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.events.close(); assert.equal(external.length, 0, 'nenhuma rede externa'); store.close();
  });
  return { app, store, admin, operator, tenant, state, conversation, jobs, visitor, say, assign, commands, agentMessages, contexts };
}

test('mensagem do cliente em conversa do agente vira uma única resposta automática pelo outbox e pelo transporte real', async t => {
  const f = fixture(t), session = f.visitor();
  await f.say(session); f.assign();
  await until(() => f.jobs()[0]?.state === 'sent', 5000, 'resposta enviada');
  const [job] = f.jobs(), sent = f.agentMessages();
  assert.equal(sent.length, 1); assert.equal(sent[0].text, ANSWER); assert.equal(sent[0].agentId, 'hermes-1');
  assert.equal(sent[0].autopilotJobId, job.id); assert.equal(sent[0].authorUserId, null); assert.equal(sent[0].delivery, 'sent'); assert.equal(sent[0].sourceRunId, job.runId);
  assert.equal(job.sentMessageId, sent[0].id); assert.equal(f.conversation().owner, 'agent');
  const commands = f.commands();
  assert.equal(commands.length, 1); assert.equal(commands[0].key, job.id); assert.equal(commands[0].state, 'confirmed'); assert.equal(JSON.parse(commands[0].payload).autopilot, true);
  const run = f.state().runs.find(item => item.id === job.runId);
  assert.equal(run.outcome, 'used'); assert.equal(run.promptMode, 'autopilot');
  const system = f.contexts[0].messages[0].content;
  assert.equal(system.includes('revisão humana'), false); assert.match(system, /enviada automaticamente/); assert.match(system, /espanhol/);
  // The visitor sees the reply; the panel DTO never carries the receipt link.
  assert.equal(f.app.webchat.history({ token: session.token, origin }).messages.filter(message => message.kind === 'agent').length, 1);
  // Idempotency: the same message never becomes a second job or a second send.
  assert.equal(f.app.autopilot.receive(f.tenant.id, f.conversation().id, job.messageId).id, job.id);
  await f.app.autopilot.drain(); await sleep(30);
  assert.equal(f.agentMessages().length, 1); assert.equal(f.commands().length, 1); assert.equal(f.contexts.length, 1);
});

test('pessoa que assume durante a preparação cancela a tarefa sem envio atrasado', async t => {
  const gate = deferred(), started = deferred();
  const f = fixture(t, { providerCall: async () => { started.resolve(); await gate.promise; return ANSWER; } }), session = f.visitor();
  await f.say(session); f.assign();
  await started.promise;
  f.app.operations.assign(f.admin, f.tenant.id, f.conversation().id, { version: f.conversation().version, owner: 'human', assignedUserId: f.admin.userId });
  gate.resolve();
  await until(() => ['cancelled', 'handoff', 'failed', 'sent', 'unknown'].includes(f.jobs()[0]?.state), 5000, 'tarefa encerrada');
  const [job] = f.jobs();
  assert.equal(job.state, 'cancelled'); assert.equal(job.reason, 'human_took_over');
  assert.equal(f.agentMessages().length, 0); assert.equal(f.commands().length, 0);
  assert.equal(f.conversation().owner, 'human'); assert.equal(f.conversation().assignedUserId, f.admin.userId);
});

test('resultado incerto do transporte vira unknown, passa para a equipe com nota e nunca é reenviado', async t => {
  const f = fixture(t), session = f.visitor(), send = f.app.webchat.send.bind(f.app.webchat);
  let attempts = 0;
  f.app.webchat.send = async (...args) => { attempts++; await send(...args); throw Object.assign(new Error('Conexão perdida após o envio'), { status: 502 }); };
  await f.say(session); f.assign();
  await until(() => ['sent', 'unknown', 'handoff', 'failed', 'cancelled'].includes(f.jobs()[0]?.state), 5000, 'tarefa encerrada');
  const [job] = f.jobs();
  assert.equal(job.state, 'unknown'); assert.equal(job.handoffApplied, true);
  assert.equal(f.conversation().owner, 'queue'); assert.equal(f.conversation().agentId, null); assert.equal(f.conversation().departmentId, 'sac');
  assert.ok(f.conversation().messages.some(message => message.kind === 'internal' && /Confira o canal/.test(message.text)));
  assert.equal(f.commands()[0].state, 'unknown');
  // Later drains, intake of the same message and a restart-like recovery never resend it.
  await f.app.autopilot.drain(); f.app.autopilot.recover(); await sleep(50);
  assert.equal(attempts, 1); assert.equal(f.agentMessages().length, 1); assert.equal(f.commands().length, 1);
});

test('recusa do transporte antes do despacho falha fechado: equipe recebe a conversa e nada sai', async t => {
  const f = fixture(t), session = f.visitor();
  await f.say(session);
  // The visitor session expires before the reply: the webchat transport refuses before recording anything.
  f.store.db.prepare('UPDATE webchat_sessions SET expires_at=?').run(Date.now() - 1000);
  f.assign();
  await until(() => ['sent', 'unknown', 'handoff', 'failed', 'cancelled'].includes(f.jobs()[0]?.state), 5000, 'tarefa encerrada');
  const [job] = f.jobs();
  assert.equal(job.state, 'failed'); assert.equal(job.reason, 'send_refused'); assert.equal(job.handoffApplied, true);
  assert.equal(f.agentMessages().length, 0); assert.equal(f.conversation().owner, 'queue');
  assert.ok(f.commands().every(command => command.state === 'failed'));
});

test('identidade do piloto copiada, pessoa ou serviço não respondem conversa do agente pelo caminho automático', async t => {
  const f = fixture(t), session = f.visitor();
  await f.say(session);
  f.app.autopilot.close();
  f.assign();
  const forged = Object.freeze({ kind: 'service', role: 'operator', resellerId: 'mep-demo', tenantIds: [f.tenant.id], name: 'Piloto forjado', supportAssistantId: 'autopilot_forjado', autopilot: true });
  const message = { channelId: 'site', version: f.conversation().version, text: 'Texto forjado', idempotencyKey: 'autopilot_forjado_0001' };
  await assert.rejects(f.app.outbox.dispatch(forged, f.tenant.id, f.conversation().id, message, () => f.app.webchat.send(forged, f.tenant.id, f.conversation().id, message, { attribution: { agentId: 'hermes-1', autopilotJobId: 'autopilot_forjado' } })), error => error.status === 403);
  await assert.rejects(f.app.webchat.send(forged, f.tenant.id, f.conversation().id, message, { attribution: { agentId: 'hermes-1', autopilotJobId: 'autopilot_forjado' } }), error => error.status === 403);
  assert.throws(() => f.app.operations.canReply(forged, f.tenant.id, f.conversation()), error => error.status === 403);
  // A person never answers a conversation owned by the agent through the send gateway either.
  await assert.rejects(f.app.outbox.dispatch(f.operator, f.tenant.id, f.conversation().id, { ...message, idempotencyKey: 'pessoa_conversa_agente_01' }, async () => assert.fail('nunca despacha')), error => error.status === 409 || error.status === 403);
  assert.equal(f.agentMessages().length, 0); assert.equal(f.commands().length, 0);
});

test('prompt de envio sem revisão pertence só à identidade do piloto; espanhol entra na regra de idioma interna', async t => {
  const f = fixture(t), session = f.visitor();
  await f.say(session, '¿Cuál es el plazo de entrega para las capitales?');
  f.app.autopilot.close();
  const input = runId => ({ agentId: 'hermes-1', version: f.conversation().version, runId, idempotencyKey: runId });
  const support = { kind: 'service', role: 'operator', resellerId: 'mep-demo', tenantIds: [f.tenant.id], name: 'Suporte sintético', supportAssistantId: 'support_prompt_mode_01' };
  await assert.rejects(f.app.runtime.start(support, f.tenant.id, f.conversation().id, input('support_prompt_mode_01'), { authorize: () => true, promptMode: 'autopilot' }), error => error.status === 403);
  await assert.rejects(f.app.runtime.start(f.operator, f.tenant.id, f.conversation().id, input('human_prompt_mode_01'), { promptMode: 'autopilot' }), error => error.status === 403);
  await assert.rejects(f.app.runtime.start(f.operator, f.tenant.id, f.conversation().id, input('human_prompt_mode_02'), { promptMode: 'review' }), TypeError);
  assert.equal(f.contexts.length, 0, 'nenhuma chamada ao provedor');
  assert.equal((f.state().runs || []).length, 0);
});
