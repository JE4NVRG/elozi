import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KnowledgeBase } from '../src/knowledge.js';
import { AgentRuntime, AI_QUOTA_REASON } from '../src/agent-runtime.js';
import { Operations } from '../src/operations.js';
import { createEventBus, diffTenantConversations, indexTenantConversations } from '../src/events.js';
import { AgentAutopilot, AUTOPILOT_HANDOFF_TOKEN, customerFrustrated, customerWantsHuman, inQuietHours, normalizeAutopilotConfig, untrustedContact } from '../src/agent-autopilot.js';

const status = expected => error => error.status === expected;
const settle = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
/** Resolves with `promise` or fails when it takes longer than `ms` (proves an abort is immediate, not a timeout). */
async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Excedeu ${ms} ms: ${message}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condição não atingida a tempo.'); await sleep(10); }
}
const QUESTION = 'Qual é o prazo de entrega para as capitais?';
const ANSWER = 'Os pedidos são entregues em até cinco dias úteis nas capitais.';

/** Test double of the planned Store.mutate integration: light index before fn, diff + publish after commit. */
function instrument(store, bus) {
  const mutate = store.mutate.bind(store);
  store.mutate = (session, id, action, fn) => {
    let before, after;
    const result = mutate(session, id, action, state => { before = indexTenantConversations(state); const value = fn(state); after = state; return value; });
    for (const event of diffTenantConversations(before, after, { tenantId: id })) bus.publish(event);
    return result;
  };
}

function workspace(store, knowledge, { tenantId, resellerId, admin, autopilot = {}, agentId = 'hermes-1' }) {
  store.mutate(admin, tenantId, 'Fixture sintética do piloto automático', state => {
    state.channels = [{ id: 'wa-1', kind: 'whatsapp_qr', name: 'WhatsApp principal', state: 'connected' }, { id: 'wa-2', kind: 'whatsapp_qr', name: 'Sem opt-in', state: 'connected' }];
    state.departments = [{ id: 'dep-sac', name: 'SAC', active: true, memberIds: [], distribution: 'manual', cursor: 0, version: 1 }];
    state.agents = [{ id: agentId, name: 'Hermes Atendente', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Atenda clientes da loja.', tools: [],
      autopilot: { enabled: true, channelIds: ['wa-1'], maxRepliesPerHour: 6, requireKnowledge: true, handoffDepartmentId: 'dep-sac', ...autopilot } }];
    state.conversations = [];
  });
  let source = knowledge.create(admin, tenantId, { title: 'Entregas e trocas', content: 'Prazo de entrega: os pedidos são entregues em até cinco dias úteis nas capitais. Trocas podem ser solicitadas em até sete dias após o recebimento.' });
  source = knowledge.publish(admin, tenantId, source.id, { version: source.version });
  knowledge.setGrants(admin, tenantId, agentId, { version: 1, grants: [{ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }] });
  return { tenantId, resellerId, admin, agentId, source };
}

function fixture(t, options = {}) {
  const store = new Store(':memory:'), bus = createEventBus();
  instrument(store, bus);
  const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'owner-1', name: 'Administração sintética' };
  const created = store.createTenant(admin, { name: 'Loja Sintética', segment: 'Varejo' });
  const knowledge = new KnowledgeBase(store);
  const main = workspace(store, knowledge, { tenantId: created.id, resellerId: 'mep-demo', admin, autopilot: options.autopilot });
  let clock = options.clock ?? Date.parse('2026-10-06T15:00:00Z'), providerCalls = 0, autopilot;
  const sent = [], inputs = [], providerContexts = [], operations = new Operations(store, { can: () => true, assignees: () => [] });
  const makeRuntime = (provider = options.providerCall) => new AgentRuntime(store, { knowledge, timeoutMs: 5000,
    validateInitiator: run => run.id.startsWith('autopilot_') ? autopilot.runCurrent(run) : true,
    providerCall: async context => { providerCalls++; providerContexts.push(context); return provider ? provider(context) : ANSWER; } });
  const deliver = async input => {
    input.reauthorize();
    const messageId = `out_${randomUUID()}`;
    store.mutate(input.actor, input.tenantId, 'Envio sintético do piloto automático', state => {
      input.reauthorize();
      const conversation = store.getConversation(state, input.conversationId, input.version);
      conversation.messages.push({ id: messageId, kind: 'agent', text: input.text, agentId: input.agentId, replyToMessageId: input.replyToMessageId, delivery: 'sent', createdAt: new Date(clock).toISOString() });
      conversation.version++;
    });
    sent.push({ tenantId: input.tenantId, conversationId: input.conversationId, text: input.text, idempotencyKey: input.idempotencyKey });
    return { confirmed: true, messageId };
  };
  const send = options.send || deliver;
  const make = (runtime = makeRuntime(), extra = {}) => {
    const instance = new AgentAutopilot(store, { runtime, knowledge, operations, now: () => clock, timeoutMs: 5000, sendTimeoutMs: 2000, leaseGraceMs: 1000, authorize: () => true,
      autoDrain: false, send: async input => { inputs.push(input); return send(input, deliver); }, ...options.settings, ...extra });
    instance.detach = instance.attach(bus);
    return instance;
  };
  autopilot = make();
  const instances = [autopilot];
  const conversation = (extra = {}, scope = main) => {
    const id = `conv_${randomUUID()}`;
    store.mutate(scope.admin, scope.tenantId, 'Conversa sintética', state => {
      state.conversations.push({ id, contact: 'Cliente Sintético', channelId: 'wa-1', departmentId: null, owner: 'agent', agentId: scope.agentId, assignedUserId: null,
        status: 'open', version: 1, conversationKind: 'direct', messages: [], ...extra });
    });
    return id;
  };
  const customer = (conversationId, text = QUESTION, extra = {}, scope = main) => {
    const id = `msg_${randomUUID()}`;
    store.mutate(scope.admin, scope.tenantId, 'Mensagem sintética do cliente', state => {
      const item = store.getConversation(state, conversationId);
      item.messages.push({ id, kind: 'customer', text, createdAt: new Date(clock).toISOString(), ...extra }); item.version++;
    });
    return id;
  };
  const state = (scope = main) => store.tenant(scope.admin, scope.tenantId);
  const jobs = (scope = main) => state(scope).agentAutopilotJobs || [];
  const find = (conversationId, scope = main) => state(scope).conversations.find(item => item.id === conversationId);
  const run = async (instance = autopilot) => { instance.flush(); for (let round = 0; round < 10; round++) { const results = await instance.drain(); if (!results.length) break; } };
  t.after(async () => { for (const instance of instances) await instance.close(); bus.close(); store.close(); });
  return { store, bus, knowledge, main, operations, sent, inputs, deliver, providerContexts, conversation, customer, state, jobs, find, run, makeRuntime,
    get autopilot() { return autopilot; }, calls: () => providerCalls, time: ms => { clock += ms; }, now: () => clock,
    replace(runtime, extra) { autopilot = make(runtime, extra); instances.push(autopilot); return autopilot; },
    addWorkspace() {
      const resellerId = `reseller_${randomUUID()}`, tenantId = `tenant_${randomUUID()}`;
      store.provisionReseller({ resellerId, tenantId, name: 'Outra Empresa Sintética' });
      return workspace(store, knowledge, { tenantId, resellerId, admin: { role: 'reseller', resellerId, userId: 'owner-2', name: 'Outra administração' }, agentId: 'hermes-b' });
    } };
}

const assertHandoff = (c, conversationId, reason) => {
  const job = c.jobs().find(item => item.conversationId === conversationId), current = c.find(conversationId);
  assert.equal(job.state, 'handoff', `job ${job.state}/${job.reason}`); assert.equal(job.reason, reason); assert.equal(job.handoffApplied, true);
  assert.equal(current.owner, 'queue'); assert.equal(current.agentId, null); assert.equal(current.departmentId, 'dep-sac');
  const note = current.messages.find(message => message.kind === 'internal' && message.autopilotJobId === job.id);
  assert.ok(note?.text.startsWith('Piloto automático pausado nesta conversa.'), 'internal note explains the handoff');
  assert.ok(current.attendantEvents.some(event => event.type === 'assignment' && event.origin === 'agent-autopilot' && event.to.owner === 'queue'));
  assert.equal(c.sent.length, 0, 'a handoff never sends to the customer');
};

test('caminho feliz: mensagem do cliente vira tarefa durável, resposta fundamentada e envio idempotente', async t => {
  const c = fixture(t), conversationId = c.conversation(), messageId = c.customer(conversationId);
  await settle();
  assert.equal(c.jobs().length, 1, 'the bus event committed the job after the publisher returned');
  assert.equal(c.calls(), 0, 'intake never calls the provider');
  await c.run();
  const [job] = c.jobs(), current = c.find(conversationId);
  assert.equal(job.state, 'sent'); assert.equal(job.messageId, messageId); assert.equal(job.attempts, 1); assert.ok(job.sentMessageId);
  assert.deepEqual(c.sent, [{ tenantId: c.main.tenantId, conversationId, text: ANSWER, idempotencyKey: job.id }]);
  assert.equal(current.owner, 'agent'); assert.equal(current.messages.at(-1).kind, 'agent');
  const prompt = JSON.stringify(c.providerContexts[0].messages);
  assert.ok(prompt.includes('Trechos das fontes publicadas')); assert.ok(prompt.includes(AUTOPILOT_HANDOFF_TOKEN));
  const persisted = c.state().runs.find(item => item.id === job.runId);
  assert.equal(persisted.knowledgeState, 'matched'); assert.equal(persisted.actorUserId, null); assert.equal(persisted.serviceId, undefined);
  // Jobs keep ids and hashes only: no customer text and no draft.
  assert.equal(JSON.stringify(c.jobs()).includes('prazo'), false); assert.equal(JSON.stringify(c.jobs()).includes('cinco dias'), false);
  // Replays of the same message never create another job or send.
  assert.equal(c.autopilot.receive(c.main.tenantId, conversationId, messageId).state, 'sent');
  c.bus.publish({ type: 'conversation.message', tenantId: c.main.tenantId, conversationId, messageId, kind: 'customer', owner: 'agent', agentId: 'hermes-1' });
  await c.run();
  assert.equal(c.calls(), 1); assert.equal(c.sent.length, 1); assert.equal(c.jobs().length, 1);
  assert.equal(c.autopilot.list(c.main.admin, c.main.tenantId, { conversationId })[0].state, 'sent');
});

test('elegibilidade exige conversa atribuída ao agente, canal com opt-in, atendimento direto e configuração ativa', async t => {
  const c = fixture(t);
  const ineligible = [
    c.conversation({ channelId: 'wa-2' }), c.conversation({ owner: 'queue', agentId: null }), c.conversation({ owner: 'human', agentId: null, assignedUserId: 'user-1' }),
    c.conversation({ conversationKind: 'group' }), c.conversation({ agentId: 'outro-agente' }), c.conversation({ status: 'closed' })
  ];
  for (const id of ineligible) c.customer(id);
  await c.run();
  assert.equal(c.jobs().length, 0); assert.equal(c.calls(), 0);
  c.store.mutate(c.main.admin, c.main.tenantId, 'Canal da central própria', state => { state.channels[0].centralSupportScope = { productIds: ['elozi'], origins: [] }; });
  const central = c.conversation(); c.customer(central);
  await c.run();
  assert.equal(c.jobs().length, 0, 'the own central support channel stays with SupportAssistant');
  c.store.mutate(c.main.admin, c.main.tenantId, 'Piloto desligado', state => { delete state.channels[0].centralSupportScope; state.agents[0].autopilot.enabled = false; });
  const disabled = c.conversation(); c.customer(disabled);
  await c.run();
  assert.equal(c.jobs().length, 0); assert.equal(c.sent.length, 0);
  assert.equal(c.autopilot.receive(c.main.tenantId, disabled, 'mensagem-inexistente'), null);
});

test('pedido explícito de pessoa em português, inglês e espanhol transfere sem chamar o agente', async t => {
  const c = fixture(t);
  const texts = ['Quero falar com um atendente, por favor.', 'Can I talk to a real person?', 'Quiero hablar con un asesor, por favor.'];
  const ids = texts.map(text => { const id = c.conversation(); c.customer(id, text); return id; });
  await c.run();
  for (const id of ids) assertHandoff(c, id, 'customer_requested_human');
  assert.equal(c.calls(), 0);
});

test('frustração, mídia, horário silencioso e falta de conhecimento transferem para pessoas', async t => {
  const c = fixture(t, { autopilot: { quietHours: { timezone: 'America/Sao_Paulo', start: '22:00', end: '07:00' } } });
  const frustrated = c.conversation(); c.customer(frustrated, 'Isso é um absurdo, ninguém resolve nada!');
  const media = c.conversation(); c.customer(media, '', { attachments: [{ id: 'att-1', kind: 'image', name: 'Arquivo', status: 'pending' }] });
  const unknown = c.conversation(); c.customer(unknown, 'Vocês têm bicicletas elétricas em estoque?');
  await c.run();
  assertHandoff(c, frustrated, 'customer_frustrated'); assertHandoff(c, media, 'media_needs_human'); assertHandoff(c, unknown, 'knowledge_unavailable');
  c.time(Date.parse('2026-10-07T02:30:00Z') - c.now()); // 23:30 in São Paulo.
  const night = c.conversation(); c.customer(night);
  await c.run();
  assertHandoff(c, night, 'quiet_hours');
  assert.equal(c.calls(), 0);
});

test('mensagem antiga não recebe resposta automática', async t => {
  const c = fixture(t), id = c.conversation(); c.customer(id);
  c.autopilot.flush(); c.time(16 * 60000);
  await c.run();
  assertHandoff(c, id, 'stale_message');
});

test('rascunho com link fora das fontes, caractere de controle ou pedido de transferência não é enviado', async t => {
  const drafts = ['Veja a promoção em https://golpe.example/oferta', 'Entrega em cinco dias\u0007', `${AUTOPILOT_HANDOFF_TOKEN}`];
  for (const [index, draft] of drafts.entries()) {
    await t.test(`rascunho ${index + 1}`, async t => {
      const c = fixture(t, { providerCall: () => draft }), id = c.conversation(); c.customer(id);
      await c.run();
      assertHandoff(c, id, index === 2 ? 'agent_requested_human' : 'invalid_draft');
      assert.equal(c.calls(), 1);
    });
  }
});

test('limite por hora conta envios tentados por conversa e libera após uma hora', async t => {
  const c = fixture(t, { autopilot: { maxRepliesPerHour: 2 } }), id = c.conversation();
  for (let index = 0; index < 2; index++) { c.customer(id, `${QUESTION} Pergunta ${index + 1}.`); await c.run(); c.time(60000); }
  assert.equal(c.sent.length, 2);
  c.customer(id, `${QUESTION} Terceira pergunta.`); await c.run();
  assertHandoff2(c, id);
  const other = fixture(t, { autopilot: { maxRepliesPerHour: 2 } }), again = other.conversation();
  for (let index = 0; index < 2; index++) { other.customer(again, `${QUESTION} Pergunta ${index + 1}.`); await other.run(); }
  other.time(61 * 60000);
  other.customer(again, `${QUESTION} Depois de uma hora.`); await other.run();
  assert.equal(other.sent.length, 3); assert.deepEqual(other.jobs().map(job => job.state), ['sent', 'sent', 'sent']);
});
function assertHandoff2(c, conversationId) {
  const job = c.jobs().filter(item => item.conversationId === conversationId).at(-1), current = c.find(conversationId);
  assert.equal(job.state, 'handoff'); assert.equal(job.reason, 'rate_limited'); assert.equal(current.owner, 'queue'); assert.equal(current.agentId, null);
  assert.equal(c.sent.length, 2); assert.equal(c.calls(), 2);
}

test('pessoa que assume durante a preparação cancela a tarefa e nunca recebe envio atrasado', async t => {
  const gate = deferred(), started = deferred();
  const c = fixture(t, { providerCall: async () => { started.resolve(); await gate.promise; return ANSWER; } }), id = c.conversation(); c.customer(id);
  c.autopilot.flush();
  const draining = c.autopilot.drain();
  await started.promise;
  assert.equal(c.jobs()[0].state, 'running');
  c.store.mutate(c.main.admin, c.main.tenantId, 'Atendente assumiu', state => {
    const item = c.store.getConversation(state, id);
    Object.assign(item, { owner: 'human', agentId: null, assignedUserId: 'user-1', assignedUserName: 'Joana' }); item.version++;
  });
  await draining;
  gate.resolve(); await settle(); await settle();
  const [job] = c.jobs(), run = c.state().runs.find(item => item.id === job.runId);
  assert.equal(job.state, 'cancelled'); assert.equal(job.reason, 'human_took_over'); assert.equal(job.handoffApplied, undefined);
  assert.equal(c.sent.length, 0); assert.equal(c.find(id).owner, 'human');
  assert.ok(['cancelled', 'invalidated'].includes(run.state)); assert.equal(run.draft, null);
  await c.run(); assert.equal(c.sent.length, 0);
});

test('mudança de configuração durante a preparação invalida a execução e não envia', async t => {
  const gate = deferred(), started = deferred();
  const c = fixture(t, { providerCall: async () => { started.resolve(); await gate.promise; return ANSWER; } }), id = c.conversation(); c.customer(id);
  c.autopilot.flush();
  const draining = c.autopilot.drain();
  await started.promise;
  c.store.mutate(c.main.admin, c.main.tenantId, 'Canal retirado do piloto', state => { state.agents[0].autopilot.channelIds = ['wa-2']; });
  gate.resolve(); await draining;
  const [job] = c.jobs();
  assert.equal(job.state, 'cancelled'); assert.equal(job.reason, 'configuration_changed'); assert.equal(c.sent.length, 0);
  assert.equal(c.find(id).owner, 'agent', 'a configuration change leaves the existing copilot assignment untouched');
  assert.equal(job.noticeApplied, true, 'the team learns that the message was not answered');
  assert.ok(c.find(id).messages.some(message => message.kind === 'internal' && message.autopilotJobId === job.id && message.text.includes('não respondeu')));
  // An explicit invalidation (access or agent edit) aborts in-flight work immediately: well before the 5 s runtime timeout.
  const second = deferred(), began = deferred();
  const d = fixture(t, { providerCall: async () => { began.resolve(); await second.promise; return ANSWER; } }), other = d.conversation(); d.customer(other);
  d.autopilot.flush(); const pending = d.autopilot.drain(); await began.promise;
  d.store.mutate(d.main.admin, d.main.tenantId, 'Acesso revisto', state => { state.agents[0].autopilot.maxRepliesPerHour = 1; });
  assert.equal(d.autopilot.invalidate({ tenantId: d.main.tenantId, agentId: 'hermes-1' }), 1);
  await within(pending, 1000, 'invalidate() interrupts the preparation at once');
  second.resolve();
  assert.equal(d.jobs()[0].state, 'cancelled'); assert.equal(d.jobs()[0].reason, 'configuration_changed'); assert.equal(d.sent.length, 0);
});

test('invalidação sem mudança visível refaz a preparação e falha transitória de leitura adia sem descartar a mensagem', async t => {
  const gate = deferred(), started = deferred();
  let blocked = true;
  const c = fixture(t, { providerCall: async () => { if (blocked) { started.resolve(); await gate.promise; } return ANSWER; } }), id = c.conversation(); c.customer(id);
  c.autopilot.flush(); const pending = c.autopilot.drain(); await started.promise;
  assert.equal(c.autopilot.invalidate({ tenantId: c.main.tenantId }), 1);
  await within(pending, 1000, 'the invalidated preparation stops at once');
  blocked = false; gate.resolve();
  let [job] = c.jobs();
  assert.equal(job.state, 'pending'); assert.equal(job.reason, 'invalidated'); assert.equal(job.deferrals, 1);
  await c.run();
  [job] = c.jobs();
  assert.equal(job.state, 'sent'); assert.equal(job.attempts, 2); assert.equal(job.runId, `${job.id}_r2`); assert.equal(c.sent.length, 1);
  assert.equal(c.find(id).messages.some(message => message.kind === 'internal'), false);
  // A transient read failure after the provider (SQLite busy) defers with backoff instead of cancelling silently.
  const d = fixture(t, { settings: { retryDelayMs: 2000 } }), other = d.conversation(); d.customer(other);
  const read = d.store.tenant.bind(d.store), start = d.autopilot.runtime.start.bind(d.autopilot.runtime);
  let failNext = false, once = true;
  d.store.tenant = (...args) => { if (failNext) { failNext = false; throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }); } return read(...args); };
  d.autopilot.runtime.start = async (...args) => { const result = await start(...args); if (once) { once = false; failNext = true; } return result; };
  await d.run();
  [job] = d.jobs();
  assert.equal(job.state, 'pending'); assert.equal(job.reason, 'store_unavailable'); assert.equal(job.notBefore, d.now() + 2000);
  await d.run();
  assert.equal(d.jobs()[0].state, 'pending', 'a deferred job waits for its backoff');
  d.time(2000); await d.run();
  assert.equal(d.jobs()[0].state, 'sent'); assert.equal(d.sent.length, 1); assert.equal(d.find(other).owner, 'agent');
});

test('nova mensagem do cliente substitui a preparação anterior e gera uma única resposta', async t => {
  const c = fixture(t), id = c.conversation();
  c.customer(id, 'Olá'); c.autopilot.flush();
  c.customer(id, QUESTION);
  await c.run();
  const [first, second] = c.jobs();
  assert.equal(first.state, 'cancelled'); assert.equal(first.reason, 'superseded');
  assert.equal(second.state, 'sent'); assert.equal(c.calls(), 1); assert.equal(c.sent.length, 1);
});

test('resultado de envio incerto fica unknown, transfere para pessoas e nunca é repetido', async t => {
  let attempts = 0;
  const c = fixture(t, { send: async input => { input.reauthorize(); attempts++; throw new Error('timeout do provedor depois do envio'); } }), id = c.conversation(), messageId = c.customer(id);
  await c.run();
  const [job] = c.jobs();
  assert.equal(job.state, 'unknown'); assert.equal(job.reason, 'send_unconfirmed'); assert.equal(job.handoffApplied, true);
  assert.equal(c.find(id).owner, 'queue');
  assert.ok(c.find(id).messages.some(message => message.kind === 'internal' && message.text.includes('Confira o canal antes de responder')));
  assert.equal(c.autopilot.receive(c.main.tenantId, id, messageId).state, 'unknown');
  await c.run();
  const restarted = c.replace(c.makeRuntime()); restarted.recover(); await c.run(restarted);
  assert.equal(attempts, 1); assert.equal(c.calls(), 1);
  // A refusal (nothing dispatched) is final too, and hands the conversation over.
  const refused = fixture(t, { send: async () => { throw Object.assign(new Error('canal desconectado'), { status: 503 }); } }), other = refused.conversation(); refused.customer(other);
  await refused.run();
  assert.equal(refused.jobs()[0].state, 'failed'); assert.equal(refused.jobs()[0].reason, 'send_refused'); assert.equal(refused.find(other).owner, 'queue');
});

test('envio interrompido por queda do processo vira unknown após a lease, sem reenvio', async t => {
  const c = fixture(t), id = c.conversation(), messageId = c.customer(id);
  c.autopilot.flush();
  const jobId = c.jobs()[0].id;
  c.store.mutate(c.main.admin, c.main.tenantId, 'Simulação de queda durante o envio', state => {
    Object.assign(state.agentAutopilotJobs[0], { state: 'sending', attempts: 1, runId: jobId, executionId: 'execucao-perdida', runVersion: c.find(id).version, sendStartedAt: c.now(), leaseUntil: c.now() + 1000 });
  });
  await c.run();
  assert.equal(c.jobs()[0].state, 'sending', 'a live lease is never taken over');
  c.time(1001);
  await c.run();
  assert.equal(c.jobs()[0].state, 'unknown'); assert.equal(c.jobs()[0].reason, 'send_unconfirmed'); assert.equal(c.sent.length, 0); assert.equal(c.calls(), 0);
  assert.equal(c.find(id).owner, 'queue');
  assert.equal(c.autopilot.receive(c.main.tenantId, id, messageId).state, 'unknown');
});

test('reinício recupera a lease de uma preparação sem envio, com execução idempotente e sem resultado atrasado', async t => {
  const gate = deferred(), started = deferred();
  const c = fixture(t, { providerCall: async () => { started.resolve(); await gate.promise; return `${ANSWER} (resposta atrasada)`; } }), id = c.conversation(); c.customer(id);
  const crashed = c.autopilot;
  crashed.flush();
  const stuck = crashed.drain();
  await started.promise;
  const first = c.jobs()[0];
  assert.equal(first.state, 'running'); assert.equal(first.attempts, 1);
  // A new process: new runtime and worker over the same tenant data, while the old one is still "frozen".
  let freshCalls = 0;
  const runtime = new AgentRuntime(c.store, { knowledge: c.knowledge, timeoutMs: 5000, validateInitiator: run => run.id.startsWith('autopilot_') ? c.autopilot.runCurrent(run) : true,
    providerCall: async () => { freshCalls++; return ANSWER; } });
  const recovered = c.replace(runtime);
  assert.equal(recovered.recover(), 0, 'startup recovery tracks the tenant without duplicating the known message');
  await c.run(recovered);
  assert.equal(c.jobs()[0].state, 'running', 'the lease of the frozen worker is still valid');
  c.time(5000 + 1000 + 1);
  await c.run(recovered);
  const [job] = c.jobs();
  assert.equal(job.state, 'sent'); assert.equal(job.attempts, 2); assert.equal(job.runId, `${job.id}_r2`);
  assert.equal(freshCalls, 1); assert.deepEqual(c.sent.map(item => item.text), [ANSWER]);
  assert.equal(c.state().runs.find(run => run.id === first.id).state, 'invalidated');
  gate.resolve(); await stuck; await settle();
  assert.deepEqual(c.sent.map(item => item.text), [ANSWER], 'the frozen execution never sends its late result');
  assert.equal(c.jobs()[0].state, 'sent');
});

test('tarefas, execuções e envios ficam isolados por empresa', async t => {
  const c = fixture(t), other = c.addWorkspace();
  const mine = c.conversation(), theirs = c.conversation({}, other);
  const mineMessage = c.customer(mine), theirMessage = c.customer(theirs, QUESTION, {}, other);
  await c.run();
  assert.equal(c.jobs().length, 1); assert.equal(c.jobs(other).length, 1);
  assert.equal(c.jobs()[0].conversationId, mine); assert.equal(c.jobs(other)[0].conversationId, theirs);
  assert.deepEqual(c.sent.map(item => [item.tenantId, item.conversationId]).sort(), [[c.main.tenantId, mine], [other.tenantId, theirs]].sort());
  // Pointers that mix one tenant with another tenant's conversation never create work.
  assert.equal(c.autopilot.receive(c.main.tenantId, theirs, theirMessage), null);
  assert.equal(c.autopilot.receive(other.tenantId, mine, mineMessage), null);
  c.bus.publish({ type: 'conversation.message', tenantId: c.main.tenantId, conversationId: theirs, messageId: theirMessage, kind: 'customer', owner: 'agent', agentId: 'hermes-b' });
  await c.run();
  assert.equal(c.jobs().length, 1); assert.equal(c.jobs(other).length, 1); assert.equal(c.sent.length, 2);
  const otherRun = c.state(other).runs[0];
  assert.equal(c.autopilot.runCurrent({ ...otherRun, tenantId: c.main.tenantId }), false);
  assert.throws(() => c.autopilot.authorizeSend({ actor: { kind: 'service', role: 'operator', resellerId: other.resellerId, tenantIds: [other.tenantId], supportAssistantId: otherRun.id },
    tenantId: other.tenantId, jobId: c.jobs(other)[0].id, runId: otherRun.id }), status(403));
  assert.throws(() => c.autopilot.list({ role: 'reseller', resellerId: other.resellerId, name: 'Outra' }, c.main.tenantId), status(404));
});

test('atribuição ao agente depois da mensagem responde a pergunta recente e não devolve conversa antiga', async t => {
  const c = fixture(t);
  const assign = id => c.store.mutate(c.main.admin, c.main.tenantId, 'Fluxo atribuiu ao agente', state => {
    c.operations.applyAssignment(c.store.getConversation(state, id), c.main.admin, { owner: 'agent', agent: state.agents[0], reason: 'Fluxo de entrada.' });
  });
  const recent = c.conversation({ owner: 'queue', agentId: null }); c.customer(recent);
  await settle(); await c.run();
  assert.equal(c.jobs().length, 0, 'a queued conversation is not the agent’s');
  assign(recent); await settle(); await c.run();
  assert.equal(c.jobs()[0].state, 'sent'); assert.equal(c.sent.length, 1);
  const old = c.conversation({ owner: 'queue', agentId: null }); c.customer(old);
  c.time(16 * 60000); assign(old); await settle(); await c.run();
  assert.equal(c.jobs().some(job => job.conversationId === old), false);
  assert.equal(c.find(old).owner, 'agent', 'an old question waits for the next customer message instead of bouncing to the queue');
});

test('recover cria tarefa para mensagem recente perdida antes da entrega do evento', async t => {
  const c = fixture(t), id = c.conversation();
  c.autopilot.detach();
  c.customer(id); await settle();
  assert.equal(c.jobs().length, 0);
  assert.equal(c.autopilot.recover(), 1);
  await c.run();
  assert.equal(c.jobs()[0].state, 'sent'); assert.equal(c.sent.length, 1);
  assert.equal(c.autopilot.recover(), 0);
});

test('ator legítimo de uma empresa não autoriza o envio em curso de outra empresa', async t => {
  const gate = deferred(), held = deferred();
  let c;
  c = fixture(t, { send: async (input, deliver) => { if (input.tenantId !== c.main.tenantId) { held.resolve(input); await gate.promise; } return deliver(input); } });
  const other = c.addWorkspace(), mine = c.conversation(), theirs = c.conversation({}, other);
  c.customer(mine); c.customer(theirs, QUESTION, {}, other);
  c.autopilot.flush();
  const draining = c.autopilot.drain();
  const inputB = await held.promise;
  await until(() => c.jobs().some(job => job.state === 'sent'));
  const inputA = c.inputs.find(input => input.tenantId === c.main.tenantId);
  assert.equal(c.jobs(other)[0].state, 'sending');
  assert.equal(c.autopilot.authorizeSend(inputB), true, 'the live execution of the other company is valid for its own input only');
  for (const forged of [{ ...inputB, actor: inputA.actor }, { ...inputA, tenantId: other.tenantId, jobId: inputB.jobId },
    { ...inputA, jobId: inputB.jobId, runId: inputB.runId }, { ...inputA, jobId: inputB.jobId }]) assert.throws(() => c.autopilot.authorizeSend(forged), status(403));
  assert.throws(() => c.autopilot.authorizeSend(inputA), status(403), 'a finished send is never authorized again');
  gate.resolve(); await draining;
  assert.equal(c.sent.length, 2); assert.equal(c.jobs(other)[0].state, 'sent');
});

test('o prazo da preparação não corta um envio válido; o envio tem prazo e sinal próprios', async t => {
  const c = fixture(t, { settings: { timeoutMs: 200 }, providerCall: async () => { await sleep(120); return ANSWER; },
    send: async (input, deliver) => { await sleep(150); return deliver(input); } }), id = c.conversation(); c.customer(id);
  await c.run();
  assert.equal(c.jobs()[0].state, 'sent', 'preparation 120 ms + send 150 ms exceed timeoutMs without cutting the send');
  assert.equal(c.sent.length, 1); assert.equal(c.inputs[0].signal.aborted, false);
  // A send that never answers is cut by sendTimeoutMs: unknown, gateway signal aborted, people warned, never retried.
  const hung = fixture(t, { settings: { sendTimeoutMs: 60 }, send: async input => { input.reauthorize(); return new Promise(() => {}); } }), other = hung.conversation(); hung.customer(other);
  await hung.run();
  const [job] = hung.jobs();
  assert.equal(job.state, 'unknown'); assert.equal(job.reason, 'send_unconfirmed'); assert.equal(job.handoffApplied, true);
  assert.equal(hung.inputs[0].signal.aborted, true, 'the gateway is told to stop');
  assert.throws(() => hung.autopilot.authorizeSend(hung.inputs[0]), status(409));
  assert.ok(hung.find(other).messages.some(message => message.kind === 'internal' && message.text.includes('Confira o canal')));
  await hung.run(); assert.equal(hung.inputs.length, 1);
  // The preparation keeps its own limit.
  const slow = fixture(t, { settings: { timeoutMs: 60 }, providerCall: async () => { await sleep(400); return ANSWER; } }), third = slow.conversation(); slow.customer(third);
  await slow.run();
  assertHandoff(slow, third, 'agent_failed');
});

test('confirmação negativa do canal: recusa declarada transfere; resposta sem estado fica incerta e não repete', async t => {
  const refused = fixture(t, { send: async input => { input.reauthorize(); return { confirmed: false, state: 'failed' }; } }), id = refused.conversation(); refused.customer(id);
  await refused.run();
  assert.equal(refused.jobs()[0].state, 'failed'); assert.equal(refused.jobs()[0].reason, 'send_refused'); assert.equal(refused.find(id).owner, 'queue');
  const vague = fixture(t, { send: async input => { input.reauthorize(); return { confirmed: false }; } }), other = vague.conversation(); vague.customer(other);
  await vague.run();
  assert.equal(vague.jobs()[0].state, 'unknown'); assert.equal(vague.jobs()[0].handoffApplied, true); assert.equal(vague.find(other).owner, 'queue');
  await vague.run(); assert.equal(vague.inputs.length, 1, 'never resent');
});

test('pessoa que assume durante o envio recebe nota para conferir o canal antes de responder', async t => {
  const inGateway = deferred(), release = deferred();
  const c = fixture(t, { send: async input => { input.reauthorize(); inGateway.resolve(); await release.promise; throw new Error('timeout do provedor após despacho'); } });
  const id = c.conversation(); c.customer(id);
  c.autopilot.flush(); const draining = c.autopilot.drain(); await inGateway.promise;
  c.store.mutate(c.main.admin, c.main.tenantId, 'Atendente assumiu', state => {
    const item = c.store.getConversation(state, id);
    Object.assign(item, { owner: 'human', agentId: null, assignedUserId: 'user-1', assignedUserName: 'Joana' }); item.version++;
  });
  assert.equal(c.inputs[0].signal.aborted, true, 'the takeover aborts the send signal');
  release.resolve(); await draining;
  const [job] = c.jobs(), current = c.find(id);
  assert.equal(job.state, 'unknown'); assert.equal(job.handoffApplied, false); assert.equal(job.noticeApplied, true);
  assert.equal(current.owner, 'human'); assert.equal(current.assignedUserId, 'user-1');
  const note = current.messages.find(message => message.kind === 'internal' && message.autopilotJobId === job.id);
  assert.ok(note.text.includes('Confira o canal antes de responder')); assert.equal(current.messages.at(-1).id, note.id);
});

test('mudanças só de versão e runtime ocupado adiam a tarefa; orçamento esgotado transfere com o motivo correto', async t => {
  let calls = 0, c;
  c = fixture(t, { providerCall: async () => {
    calls++;
    if (calls <= 2) c.store.mutate(c.main.admin, c.main.tenantId, 'Etiqueta alterada', state => { const item = state.conversations[0]; item.tags = [`etiqueta-${calls}`]; item.version++; });
    return ANSWER;
  } });
  const id = c.conversation(); c.customer(id);
  await c.run();
  const [job] = c.jobs();
  assert.equal(job.state, 'sent'); assert.equal(job.deferrals, 2); assert.equal(job.attempts, 3); assert.equal(c.sent.length, 1); assert.equal(c.find(id).owner, 'agent');
  // Another run of this conversation (409) defers with backoff instead of handing over as a failure.
  const busy = fixture(t, { settings: { retryDelayMs: 1000 } }), other = busy.conversation(); busy.customer(other);
  const start = busy.autopilot.runtime.start.bind(busy.autopilot.runtime);
  const refusals = [Object.assign(new Error('Este atendimento já tem uma preparação ou aprovação em andamento.'), { status: 409 })];
  busy.autopilot.runtime.start = async (...args) => { const refusal = refusals.shift(); if (refusal) throw refusal; return start(...args); };
  await busy.run();
  assert.equal(busy.jobs()[0].state, 'pending'); assert.equal(busy.jobs()[0].reason, 'agent_busy'); assert.equal(busy.calls(), 0);
  busy.time(1000); await busy.run();
  assert.equal(busy.jobs()[0].state, 'sent'); assert.equal(busy.sent.length, 1);
  // The concurrency cap (429) keeps deferring until the budget ends; then people take over with the real reason.
  const capped = fixture(t, { settings: { retryDelayMs: 10, maxDeferrals: 1 } }), third = capped.conversation(); capped.customer(third);
  capped.autopilot.runtime.start = async () => { throw Object.assign(new Error('Limite de execuções simultâneas atingido.'), { status: 429 }); };
  await capped.run(); assert.equal(capped.jobs()[0].state, 'pending');
  capped.time(10); await capped.run();
  assertHandoff(capped, third, 'agent_busy');
  // The daily AI quota is final.
  const quota = fixture(t), fourth = quota.conversation(); quota.customer(fourth);
  quota.autopilot.runtime.start = async () => { throw Object.assign(new Error(AI_QUOTA_REASON), { status: 429 }); };
  await quota.run();
  assertHandoff(quota, fourth, 'ai_unavailable');
});

test('rascunho com domínio sem esquema, e-mail, telefone, documento ou chave PIX fora das fontes não é enviado', async t => {
  const trusted = 'Site oficial: https://www.lojasintetica.com.br/trocas. SAC: (11) 4002-8922 ou sac@lojasintetica.com.br. Chave PIX: 123e4567-e89b-12d3-a456-426614174000.';
  for (const draft of ['Pague em golpe-pagamentos.com.br/pix', 'Acesse www.golpe.example', 'Veja golpe.com', 'Escreva para fraude@golpe.example', 'Ligue (21) 98888-7777',
    'Use a chave 9f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b', 'CPF 123.456.789-00', 'Carteira bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'Veja lojasintetica.com.br.golpe.io',
    'Acesse naolojasintetica.com.br', 'Confira lojasintetica.com', 'https://www.lojasintetica.com.br/trocas-falsas', 'Boleto 23793.38128 60000.000003 00000.000400 1 84340000010000'])
    assert.notEqual(untrustedContact(draft, trusted), null, draft);
  for (const draft of [ANSWER, 'Trocas em https://www.lojasintetica.com.br/trocas.', 'Fale com o SAC: +55 11 4002-8922.', 'Ou ligue 4002-8922.', 'E-mail: SAC@lojasintetica.com.br',
    'Site: lojasintetica.com.br', 'Chave PIX 123E4567-E89B-12D3-A456-426614174000', 'Entrega em 06/10/2026 até as 15:00, R$ 1.299,90.', 'Ex.: pedidos às 9h.', 'Valor: R$ 12.345,67'])
    assert.equal(untrustedContact(draft, trusted), null, draft);
  // End to end: the scheme-less scam link of the review is handed over; a phone from the administrator's instructions is sent.
  const c = fixture(t, { providerCall: () => `${ANSWER} Pague o frete em golpe-pagamentos.com.br/pix ou www.golpe.example` }), id = c.conversation(); c.customer(id);
  await c.run();
  assertHandoff(c, id, 'invalid_draft');
  const blocked = c.state().runs.find(run => run.id === c.jobs()[0].runId);
  assert.equal(blocked.state, 'cancelled'); assert.equal(blocked.draft, null, 'the blocked draft is not left behind for reuse');
  const d = fixture(t, { providerCall: () => `${ANSWER} Dúvidas: (11) 4002-8922.` });
  d.store.mutate(d.main.admin, d.main.tenantId, 'Instruções com telefone do SAC', state => { state.agents[0].instructions = 'Telefone do SAC: (11) 4002-8922.'; });
  const other = d.conversation(); d.customer(other);
  await d.run();
  assert.equal(d.jobs()[0].state, 'sent'); assert.equal(d.sent.length, 1);
});

test('autorização nega por padrão, nunca aceita Promise e sua perda cancela com aviso à equipe', async t => {
  let allowed = true;
  const phases = [], c = fixture(t, { settings: { authorize: input => { phases.push(input.phase); return allowed; } } });
  c.autopilot.detach();
  const id = c.conversation(), messageId = c.customer(id);
  const options = { runtime: c.makeRuntime(), knowledge: c.knowledge, operations: c.operations, send: async () => ({ confirmed: true }), autoDrain: false, now: c.now };
  const strict = new AgentAutopilot(c.store, options), promised = new AgentAutopilot(c.store, { ...options, authorize: async () => true });
  t.after(async () => { await strict.close(); await promised.close(); });
  assert.equal(strict.receive(c.main.tenantId, id, messageId), null, 'without authorize nothing is queued');
  assert.equal(promised.receive(c.main.tenantId, id, messageId), null, 'an asynchronous answer is never trusted');
  assert.equal(c.jobs().length, 0);
  assert.equal(c.autopilot.receive(c.main.tenantId, id, messageId).state, 'pending');
  allowed = false;
  await c.run();
  const [job] = c.jobs();
  assert.equal(job.state, 'cancelled'); assert.equal(job.reason, 'authorization_changed'); assert.equal(job.noticeApplied, true);
  assert.equal(c.find(id).owner, 'agent'); assert.equal(c.sent.length, 0); assert.equal(c.calls(), 0);
  assert.ok(c.find(id).messages.some(message => message.kind === 'internal' && message.text.includes('O acesso do piloto automático mudou')));
  assert.deepEqual([...new Set(phases)], ['intake', 'claim']);
});

test('recibos formam um anel por empresa: no limite, os mais antigos já encerrados dão lugar e a mensagem é respondida', async t => {
  const c = fixture(t, { settings: { maxJobsPerTenant: 10 } });
  c.store.mutate(c.main.admin, c.main.tenantId, 'Recibos sintéticos antigos', state => {
    state.agentAutopilotJobs = Array.from({ length: 10 }, (_, index) => ({ id: `autopilot_antigo_${index}`, conversationId: 'conv-antiga', messageId: `m-${index}`, agentId: 'hermes-1',
      state: 'sent', reason: null, attempts: 1, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' }));
  });
  const id = c.conversation(); c.customer(id);
  await c.run();
  const jobs = c.jobs();
  assert.equal(jobs.length, 10, 'the ring keeps the per-company cap');
  assert.deepEqual(jobs.slice(0, 9).map(job => job.id), Array.from({ length: 9 }, (_, index) => `autopilot_antigo_${index + 1}`), 'only the oldest finished receipt gave way');
  assert.equal(jobs.at(-1).conversationId, id); assert.equal(jobs.at(-1).state, 'sent');
  assert.equal(c.sent.length, 1); assert.equal(c.find(id).owner, 'agent');
  // Weeks later the autopilot still answers: the cap never stops it for good.
  for (let round = 0; round < 3; round++) { c.time(2 * 3600000); const next = c.conversation(); c.customer(next); await c.run(); assert.equal(c.find(next).messages.at(-1).kind, 'agent'); }
  assert.equal(c.jobs().length, 10); assert.equal(c.sent.length, 4);
});

test('limite de recibos: recibos vivos ou recentes nunca saem do anel e a nova mensagem vai para pessoas', async t => {
  const c = fixture(t, { settings: { maxJobsPerTenant: 10 } }), recent = new Date(c.now() - 30 * 60000).toISOString();
  c.store.mutate(c.main.admin, c.main.tenantId, 'Recibos sintéticos protegidos', state => {
    // Finished within the protection window: the hourly limits still count them and their messages may still arrive.
    state.agentAutopilotJobs = Array.from({ length: 10 }, (_, index) => ({ id: `autopilot_recente_${index}`, conversationId: 'conv-antiga', messageId: `m-${index}`, agentId: 'hermes-1',
      state: ['sent', 'handoff', 'cancelled'][index % 3], reason: null, attempts: 1, createdAt: recent, updatedAt: recent, ...(index % 3 === 0 ? { sendStartedAt: c.now() - 30 * 60000 } : {}) }));
  });
  const before = JSON.stringify(c.jobs()), id = c.conversation(); c.customer(id);
  await c.run();
  assert.equal(JSON.stringify(c.jobs()), before, 'no protected receipt is removed or rewritten');
  const current = c.find(id);
  assert.equal(current.owner, 'queue'); assert.equal(current.agentId, null); assert.equal(current.departmentId, 'dep-sac');
  assert.ok(current.messages.some(message => message.kind === 'internal' && message.text.includes('limite de recibos')));
  assert.equal(c.calls(), 0); assert.equal(c.sent.length, 0);
  // Live receipts never give way, whatever their age.
  const old = '2026-09-01T12:00:00.000Z', live = ['pending', 'running', 'sending'].map((state, index) => ({ id: `vivo_${index}`, state, createdAt: old, updatedAt: old }));
  const ring = [...live, { id: 'antigo', state: 'failed', createdAt: old, updatedAt: old }];
  assert.equal(c.autopilot._retire(ring, 2), false); assert.equal(ring.length, 4, 'nothing is removed when the cap cannot be honoured');
  assert.equal(c.autopilot._retire(ring, 1), true); assert.deepEqual(ring.map(job => job.id), ['vivo_0', 'vivo_1', 'vivo_2']);
});

test('rajada de mensagens: preparações reiniciadas também têm limite por hora e a conversa vai para pessoas', async t => {
  const c = fixture(t, { autopilot: { maxRepliesPerHour: 2 } }), first = c.conversation();
  c.customer(first); await c.run();
  assert.equal(typeof c.jobs()[0].preparedAt, 'number', 'each claim stamps when its preparation started');
  const id = c.conversation(), stamp = new Date(c.now() - 50 * 60000).toISOString();
  // Six earlier preparations of this conversation within the hour, none sent: each newer message superseded the previous one.
  c.store.mutate(c.main.admin, c.main.tenantId, 'Preparações sintéticas interrompidas', state => {
    state.agentAutopilotJobs.push(...Array.from({ length: 6 }, (_, index) => ({ id: `autopilot_rajada_${index}`, conversationId: id, messageId: `m-${index}`, agentId: 'hermes-1',
      state: 'cancelled', reason: 'superseded', attempts: 1, preparedAt: c.now() - (50 - index) * 60000, createdAt: stamp, updatedAt: stamp })));
  });
  const calls = c.calls();
  c.customer(id); await c.run();
  const job = c.jobs().at(-1), current = c.find(id);
  assert.equal(job.state, 'handoff'); assert.equal(job.reason, 'burst_limited'); assert.equal(job.handoffApplied, true);
  assert.equal(c.calls(), calls, 'no provider call after the preparation budget'); assert.equal(c.sent.length, 1);
  assert.equal(current.owner, 'queue'); assert.ok(current.messages.some(message => message.kind === 'internal' && message.text.includes('Muitas mensagens seguidas')));
});

test('transferência do piloto aciona a distribuição circular depois do commit, com autor neutro para revendas', async t => {
  const c = fixture(t), routed = [];
  c.operations.routeIncoming = (tenantId, conversationId) => { routed.push([tenantId, conversationId, c.find(conversationId).owner]); return null; };
  const id = c.conversation(); c.customer(id, 'Quero falar com um atendente, por favor.');
  await c.run();
  assert.deepEqual(routed, [[c.main.tenantId, id, 'queue']], 'routing runs once, over the committed handoff');
  const current = c.find(id), note = current.messages.find(message => message.kind === 'internal' && message.autopilotJobId);
  assert.equal(note.authorName, 'Piloto automático'); assert.equal(JSON.stringify(current).includes('Elozi'), false, 'white label never sees the engine brand');
  // A reply without handoff routes nothing; a failed distribution keeps the committed handoff.
  const answered = c.conversation(); c.customer(answered); await c.run();
  assert.equal(routed.length, 1); assert.equal(c.find(answered).messages.at(-1).kind, 'agent');
  c.operations.routeIncoming = () => { throw new Error('distribuição indisponível'); };
  const failing = c.conversation(); c.customer(failing, 'Quero falar com um atendente.'); await c.run();
  assert.equal(c.find(failing).owner, 'queue'); assert.equal(c.jobs().at(-1).state, 'handoff');
});

test('falha persistente ao iniciar a tarefa espera entre tentativas e termina com a equipe avisada', async t => {
  const c = fixture(t, { settings: { retryDelayMs: 60, maxClaimFailures: 3 } }), id = c.conversation(); c.customer(id);
  const mutate = c.store.mutate.bind(c.store);
  let claims = 0;
  c.store.mutate = (session, tenantId, action, fn) => {
    if (action === 'Piloto automático: preparação iniciada') { claims++; throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' }); }
    return mutate(session, tenantId, action, fn);
  };
  c.autopilot.flush();
  for (let round = 0; round < 3; round++) await c.autopilot.drain();
  assert.equal(claims, 1, 'a failed claim waits for its backoff instead of spinning');
  assert.equal(c.jobs()[0].state, 'pending');
  await sleep(100); await c.autopilot.drain(); assert.equal(claims, 2);
  await sleep(180); await c.autopilot.drain(); assert.equal(claims, 3);
  const [job] = c.jobs();
  assert.equal(job.state, 'failed'); assert.equal(job.reason, 'claim_failed'); assert.equal(job.handoffApplied, true);
  assert.equal(c.find(id).owner, 'queue'); assert.equal(c.calls(), 0);
  // A handoff that keeps failing never blocks the queue: the job closes and the team gets an internal note instead.
  let handoffCalls = 0;
  const d = fixture(t, { settings: { handoff: () => { handoffCalls++; throw new Error('transferência indisponível'); } } }), other = d.conversation();
  d.customer(other, 'Quero falar com um atendente');
  await d.run();
  const [closed] = d.jobs();
  assert.equal(closed.state, 'handoff'); assert.equal(closed.reason, 'customer_requested_human'); assert.equal(closed.handoffApplied, false); assert.equal(closed.noticeApplied, true);
  assert.equal(handoffCalls, 1); assert.equal(d.find(other).owner, 'agent');
  assert.ok(d.find(other).messages.some(message => message.kind === 'internal' && message.text.includes('O cliente pediu atendimento humano')));
});

test('falha transitória ao registrar a mensagem é repetida com espera, sem depender de reinício', async t => {
  const c = fixture(t, { settings: { retryDelayMs: 20 } }), id = c.conversation();
  const mutate = c.store.mutate.bind(c.store);
  let failures = 1;
  c.store.mutate = (session, tenantId, action, fn) => {
    if (action === 'Piloto automático: mensagem registrada na fila' && failures-- > 0) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    return mutate(session, tenantId, action, fn);
  };
  c.customer(id); await settle();
  assert.equal(c.jobs().length, 0);
  await until(() => c.jobs().length === 1, 10000);
  await c.run();
  assert.equal(c.jobs()[0].state, 'sent'); assert.equal(c.sent.length, 1);
});

test('um despertar que chega antes da nova tentativa rearma o timer e a mensagem não fica parada', async t => {
  // Regression (CI): Node timers run on the loop's cached clock and may fire before performance.now() reaches retryAt.
  // The early wake used to skip the not-yet-due retry without re-arming, leaving the message stuck until another event.
  const c = fixture(t, { settings: { retryDelayMs: 200 } }), id = c.conversation();
  const mutate = c.store.mutate.bind(c.store);
  let failures = 1;
  c.store.mutate = (session, tenantId, action, fn) => {
    if (action === 'Piloto automático: mensagem registrada na fila' && failures-- > 0) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    return mutate(session, tenantId, action, fn);
  };
  c.customer(id); await settle();
  assert.equal(c.jobs().length, 0);
  const pilot = c.autopilot;
  // Simulate the wake firing early: the timer is gone and flush() runs while the retry is still 200 ms away.
  clearTimeout(pilot.wakeTimer); pilot.wakeTimer = null; pilot.wakeAt = Infinity;
  pilot.flush();
  assert.equal(c.jobs().length, 0, 'ainda não venceu');
  assert.ok(pilot.wakeTimer, 'o timer foi rearmado para a próxima tentativa');
  await until(() => c.jobs().length === 1, 10000);
  await c.run();
  assert.equal(c.jobs()[0].state, 'sent'); assert.equal(c.sent.length, 1);
});

test('close interrompe a preparação em curso, devolve a tarefa à fila e cancela a assinatura do barramento', async t => {
  const gate = deferred(), started = deferred();
  const c = fixture(t, { providerCall: async () => { started.resolve(); await gate.promise; return ANSWER; } }), id = c.conversation(); c.customer(id);
  c.autopilot.flush(); c.autopilot.drain(); await started.promise;
  assert.equal(c.bus.stats().subscribers, 1);
  await within(c.autopilot.close(), 1000, 'close() does not wait for the provider');
  gate.resolve();
  assert.equal(c.bus.stats().subscribers, 0, 'close() unsubscribes from the bus');
  const [job] = c.jobs();
  assert.equal(job.state, 'pending'); assert.equal(job.reason, 'interrupted'); assert.equal(c.sent.length, 0);
  assert.notEqual(c.state().runs.find(run => run.id === job.runId).state, 'running');
  // The next process recovers the job and answers once.
  const next = c.replace(c.makeRuntime());
  assert.equal(next.recover(), 0);
  await c.run(next);
  assert.equal(c.jobs()[0].state, 'sent'); assert.equal(c.jobs()[0].attempts, 2); assert.equal(c.sent.length, 1);
});

test('start recupera mensagem perdida e drena periodicamente', async t => {
  const c = fixture(t), id = c.conversation();
  c.autopilot.detach(); c.customer(id); await settle();
  assert.equal(c.jobs().length, 0);
  assert.throws(() => c.autopilot.start({ intervalMs: 10 }), TypeError);
  c.autopilot.start({ intervalMs: 250 }); c.autopilot.start({ intervalMs: 250 });
  assert.equal(c.jobs().length, 1, 'startup recovery queued the lost message');
  await until(() => c.jobs()[0].state === 'sent');
  assert.equal(c.sent.length, 1);
});

test('backlog atrasado do WhatsApp vai para pessoas e nunca é reaproveitado por atribuição ou recuperação', async t => {
  const c = fixture(t), id = c.conversation(); c.customer(id, QUESTION, { deliveredLate: true });
  await c.run();
  assertHandoff(c, id, 'stale_message');
  assert.equal(c.calls(), 0);
  c.autopilot.detach();
  const later = c.conversation(); c.customer(later, QUESTION, { deliveredLate: true });
  assert.equal(c.autopilot.receiveLatest(c.main.tenantId, later), null);
  assert.equal(c.autopilot.recover(), 0);
  assert.equal(c.find(later).owner, 'agent');
});

test('histórico reescrito sem evento de mensagem ainda registra a pergunta recente', async t => {
  const c = fixture(t), id = c.conversation(); c.customer(id);
  await c.run();
  assert.equal(c.sent.length, 1);
  const merged = `msg_${randomUUID()}`;
  c.store.mutate(c.main.admin, c.main.tenantId, 'Histórico mesclado', state => {
    const item = c.store.getConversation(state, id);
    item.messages = [{ id: merged, kind: 'customer', text: `${QUESTION} Vale para o interior?`, createdAt: new Date(c.now()).toISOString() }]; item.version++;
  });
  await settle(); await c.run();
  assert.equal(c.jobs().find(job => job.messageId === merged)?.state, 'sent'); assert.equal(c.sent.length, 2);
});

test('configuração do piloto valida opt-in, limites, horário e departamento com mensagens em português', () => {
  const tenant = { channels: [{ id: 'wa-1' }], departments: [{ id: 'dep-1', active: true }, { id: 'dep-off', active: false }] };
  assert.deepEqual(normalizeAutopilotConfig({ enabled: true, channelIds: ['wa-1', 'wa-1'] }, { tenant }),
    { enabled: true, channelIds: ['wa-1'], maxRepliesPerHour: 6, requireKnowledge: true, quietHours: null, handoffDepartmentId: null });
  const invalid = [
    [{ enabled: true, channelIds: [] }, 'Escolha ao menos um canal'], [{ enabled: 'sim', channelIds: ['wa-1'] }, 'Informe se o piloto'],
    [{ enabled: true, channelIds: ['wa-9'] }, 'Escolha canais desta empresa'], [{ enabled: true, channelIds: ['wa-1'], maxRepliesPerHour: 0 }, 'Use de 1 a 30'],
    [{ enabled: true, channelIds: ['wa-1'], quietHours: { timezone: 'Lua/Base', start: '22:00', end: '07:00' } }, 'fuso horário'],
    [{ enabled: true, channelIds: ['wa-1'], quietHours: { timezone: 'America/Sao_Paulo', start: '22:00', end: '22:00' } }, 'início e fim diferentes'],
    [{ enabled: true, channelIds: ['wa-1'], handoffDepartmentId: 'dep-off' }, 'departamento ativo'], [{ enabled: true, channelIds: ['wa-1'], send: true }, 'somente os campos']
  ];
  for (const [input, message] of invalid) assert.throws(() => normalizeAutopilotConfig(input, { tenant }), error => error.status === 400 && error.message.includes(message), message);
  const quiet = { timezone: 'America/Sao_Paulo', start: '22:00', end: '07:00' };
  assert.equal(inQuietHours(quiet, Date.parse('2026-10-07T02:30:00Z')), true);
  assert.equal(inQuietHours(quiet, Date.parse('2026-10-06T15:00:00Z')), false);
  assert.equal(inQuietHours({ timezone: 'UTC', start: '09:00', end: '12:00' }, Date.parse('2026-10-06T10:00:00Z')), true);
  assert.equal(inQuietHours(null), false);
});

test('sinais do cliente reconhecem pedidos de pessoa e frustração sem confundir perguntas comuns', () => {
  for (const text of ['Quero falar com um atendente', 'Posso falar com alguém da equipe?', 'I want to speak to a manager', 'Connect me to a human please',
    'Quiero hablar con una persona', 'Pásame con un asesor', 'Necesito atención humana']) assert.equal(customerWantsHuman(text), true, text);
  for (const text of ['Qual o prazo de entrega?', 'What is the delivery time?', '¿Cuál es el plazo de entrega?', 'Preciso processar meu pedido']) {
    assert.equal(customerWantsHuman(text), false, text); assert.equal(customerFrustrated(text), false, text);
  }
  for (const text of ['Que absurdo, ninguém resolve!', 'Vou reclamar no Reclame Aqui', 'This is ridiculous and useless', 'Esto no sirve, estoy harto']) assert.equal(customerFrustrated(text), true, text);
});

test('linha própria: o piloto não responde quando a outra linha da operação já está com agente', async t => {
  let blocked = true;
  const recorded = [], ownLines = {
    agentOnOtherSide: () => blocked,
    blocksAgent: (tenantId, conversation, options) => { if (blocked) recorded.push({ tenantId, conversationId: conversation.id, action: options.action }); return blocked; }
  };
  const c = fixture(t, { settings: { ownLines } });
  const blockedConversation = c.conversation();
  c.customer(blockedConversation);
  await settle(); await c.run();
  assert.equal(c.jobs().length, 0, 'no job while the other side is with an agent');
  assert.equal(c.calls(), 0); assert.equal(c.sent.length, 0);
  assert.deepEqual(recorded, [{ tenantId: c.main.tenantId, conversationId: blockedConversation, action: 'autopilot' }]);
  // Free: a job is created; if the other side takes an agent before the run, the job is cancelled without a send.
  blocked = false;
  const later = c.conversation();
  c.customer(later);
  await settle();
  assert.equal(c.jobs().length, 1);
  blocked = true;
  await c.run();
  assert.equal(c.jobs()[0].state, 'cancelled'); assert.equal(c.jobs()[0].reason, 'own_line_pair');
  assert.equal(c.sent.length, 0);
});
