import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { AgentRuntime } from '../src/agent-runtime.js';

// Real runtime + in-memory Store; deterministic injected clock and offline provider/tool adapters.
// These regressions are not measurements of a deployed provider or production latency/p95.
const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'diagnostics-admin', name: 'Diagnósticos QA' };
const startAt = '2026-10-24T12:00:00.000Z';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(t, providerCall, options = {}) {
  let instant = new Date(startAt);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const tenant = store.createTenant(admin, { name: 'Diagnósticos sintéticos', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture sintética de diagnósticos', state => {
    state.agents.push({ id: 'hermes', name: 'Hermes QA', provider: 'hermes', configured: true, mode: 'copilot', toolPolicy: 'approve_all', description: 'Instrução privada de fixture.', tools: [] });
    state.conversations.push({ id: 'conv', channelId: 'tg', departmentId: 'support', owner: 'human', assignedUserId: 'qa-operator', agentId: null, status: 'open', version: 1,
      messages: [{ id: 'm1', kind: 'customer', text: 'Texto privado de fixture.' }] });
  });
  const operator = { ...admin, role: 'operator', userId: 'qa-operator', tenantId: tenant.id };
  const runtime = new AgentRuntime(store, { providerCall, ...options, clock: () => new Date(instant) });
  return { store, tenant, operator, runtime,
    at: value => { instant = new Date(value); },
    edit: change => store.mutate(admin, tenant.id, 'Alteração sintética legítima', change),
    history: () => runtime.history(admin, tenant.id).items[0],
    start: (extra = {}, runOptions) => runtime.start(operator, tenant.id, 'conv', { agentId: 'hermes', version: 1, runId: 'run-diagnostics', ...extra }, runOptions) };
}

test('completedAt preserva a duração de draft após edição e invalidação tardia', async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; c.at('2026-10-24T12:00:02.500Z'); return 'Rascunho privado de fixture.'; });
  const draft = await c.start();
  assert.equal(draft.completedAt, '2026-10-24T12:00:02.500Z');
  assert.equal(c.history().latencyMs, 2500);
  c.at('2026-10-25T13:00:00.000Z');
  c.edit(state => { state.conversations[0].version++; state.conversations[0].messages[0].text = 'Edição legítima privada.'; });
  const run = c.runtime.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null);
  assert.equal(run.updatedAt, '2026-10-25T13:00:00.000Z');
  assert.equal(run.completedAt, draft.completedAt);
  assert.deepEqual(run.invalidation, { code: 'conversation_version_changed', at: run.updatedAt });
  assert.equal(c.history().latencyMs, 2500);
  c.at('2026-10-29T12:00:00.000Z');
  assert.deepEqual(c.runtime.invalidateConversation(c.operator, c.tenant.id, 'conv'), []);
  assert.equal((await c.start()).completedAt, draft.completedAt);
  assert.equal(c.history().latencyMs, 2500); assert.equal(calls, 1);
  const metadata = JSON.stringify(c.history());
  for (const privateText of ['Texto privado', 'Rascunho privado', 'Instrução privada', 'Edição legítima']) assert.equal(metadata.includes(privateText), false);
});

test('draft stale conserva completedAt e cancelamento posterior não aumenta duração', async t => {
  const c = setup(t, async () => { c.at('2026-10-24T12:00:01.000Z'); return 'Rascunho'; });
  const draft = await c.start();
  c.at('2026-10-24T14:00:00.000Z');
  c.edit(state => { state.conversations[0].version++; state.conversations[0].messages.push({ id: 'm2', kind: 'customer', text: 'Nova pergunta' }); });
  const stale = c.runtime.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(stale.state, 'draft'); assert.equal(stale.stale, true);
  assert.equal(stale.completedAt, draft.completedAt); assert.equal(c.history().latencyMs, 1000);
  const cancelled = c.runtime.cancel(c.operator, c.tenant.id, draft.id);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.completedAt, draft.completedAt);
  assert.equal(c.history().latencyMs, 1000);
});

test('running não tem duração final; invalidação encerra no instante da decisão e ignora resposta tardia', async t => {
  const provider = deferred(); let calls = 0, signal;
  const c = setup(t, context => { calls++; signal = context.signal; return provider.promise; });
  const pending = c.start(); await tick();
  assert.equal(c.history().state, 'running'); assert.equal(c.history().completedAt, null); assert.equal(c.history().latencyMs, null);
  c.at('2026-10-24T12:00:07.000Z');
  c.edit(state => { state.conversations[0].version++; });
  c.runtime.invalidateConversation(c.operator, c.tenant.id, 'conv');
  const invalidated = await pending;
  assert.equal(signal.aborted, true); assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.completedAt, '2026-10-24T12:00:07.000Z'); assert.equal(c.history().latencyMs, 7000);
  c.at('2026-10-26T12:00:00.000Z'); provider.resolve('Resposta antiga privada'); await tick();
  assert.equal(c.history().latencyMs, 7000); assert.equal(c.runtime.list(c.operator, c.tenant.id)[0].draft, null);
  assert.equal((await c.start()).state, 'invalidated'); assert.equal(calls, 1);
});

test('resultado obsoleto sem invalidação explícita termina quando o runtime o rejeita', async t => {
  const provider = deferred();
  const c = setup(t, () => provider.promise);
  const pending = c.start(); await tick();
  c.at('2026-10-24T12:00:03.000Z'); c.edit(state => { state.conversations[0].version++; });
  c.at('2026-10-24T12:00:05.000Z'); provider.resolve('Não usar');
  const run = await pending;
  assert.equal(run.state, 'invalidated'); assert.equal(run.completedAt, '2026-10-24T12:00:05.000Z'); assert.equal(c.history().latencyMs, 5000);
});

test('falha registra o término sem persistir o erro privado do provider', async t => {
  const c = setup(t, async () => { c.at('2026-10-24T12:00:04.000Z'); throw Error('segredo privado do provider'); });
  const run = await c.start();
  assert.equal(run.state, 'failed'); assert.equal(run.completedAt, '2026-10-24T12:00:04.000Z'); assert.equal(c.history().latencyMs, 4000);
  assert.equal(JSON.stringify(c.history()).includes('segredo privado'), false);
});

test('legado terminal sem completedAt permanece desconhecido em vez de usar updatedAt', async t => {
  const c = setup(t, async () => 'Rascunho');
  await c.start();
  c.edit(state => { delete state.runs[0].completedAt; state.runs[0].updatedAt = '2026-11-20T12:00:00.000Z'; });
  assert.equal(c.history().completedAt, null); assert.equal(c.history().latencyMs, null);
  c.at('2026-11-21T12:00:00.000Z'); c.runtime.invalidateConversation(c.operator, c.tenant.id, 'conv');
  assert.equal(c.history().completedAt, null); assert.equal(c.history().latencyMs, null);
});

const guardCases = [
  ['conversation_version_changed', state => { state.conversations[0].version++; }],
  ['conversation_owner_changed', state => { state.conversations[0].owner = 'agent'; }],
  ['assigned_agent_changed', state => { state.conversations[0].agentId = 'other-agent'; }],
  ['assigned_user_changed', state => { state.conversations[0].assignedUserId = 'other-user'; }],
  ['conversation_channel_changed', state => { state.conversations[0].channelId = 'other-channel'; }],
  ['conversation_department_changed', state => { state.conversations[0].departmentId = 'other-department'; }],
  ['conversation_closed', state => { state.conversations[0].status = 'closed'; }],
  ['agent_configuration_changed', state => { state.agents[0].description = 'Outra instrução privada.'; }]
];
for (const [code, change] of guardCases) test(`diagnóstico ${code} não relaxa authority`, async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; c.at('2026-10-24T12:00:01.000Z'); return 'Rascunho'; });
  const draft = await c.start();
  c.at('2026-10-24T15:00:00.000Z'); c.edit(change);
  const run = c.runtime.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null); assert.equal(run.invalidation.code, code);
  assert.equal(run.completedAt, draft.completedAt); assert.equal(c.history().latencyMs, 1000); assert.equal(calls, 1);
});

for (const guard of ['mcp', 'knowledge', 'memory', 'initiator']) test(`diagnóstico mantém o guard ${guard}`, async t => {
  let allowed = true, calls = 0;
  const options = { validateInitiator: () => guard !== 'initiator' || allowed };
  if (guard === 'mcp') options.mcp = { snapshot: () => [], definitions: () => [], current: () => allowed, clearReplay: () => {} };
  if (guard === 'knowledge') options.knowledge = { snapshot: () => ({}), search: () => ({ state: 'ready', references: [] }), current: () => allowed };
  if (guard === 'memory') options.memory = { snapshot: () => null, current: () => allowed, visible: () => true };
  const c = setup(t, async () => { calls++; return 'Rascunho'; }, options);
  await c.start(); allowed = false;
  const run = c.runtime.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(run.state, 'invalidated'); assert.equal(run.draft, null);
  assert.equal(run.invalidation.code, guard === 'initiator' ? 'initiator_access_changed' : `${guard}_binding_changed`);
  assert.equal(calls, 1);
});

test('reconciliação de running órfão registra o instante da falha local sem nova chamada', async t => {
  const provider = deferred(); let calls = 0;
  const c = setup(t, () => { calls++; return provider.promise; });
  const pending = c.start(); await tick();
  const controller = c.runtime.controllers.get(`${c.tenant.id}:run-diagnostics`);
  c.runtime.controllers.delete(`${c.tenant.id}:run-diagnostics`);
  c.at('2026-10-24T12:00:11.000Z');
  const run = c.runtime.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(run.state, 'failed'); assert.equal(run.completedAt, '2026-10-24T12:00:11.000Z');
  assert.equal(c.history().latencyMs, 11000); assert.match(run.reason, /reinicialização/);
  controller.abort(); await pending;
  provider.resolve('Resposta tardia'); await tick();
  assert.equal(c.history().latencyMs, 11000); assert.equal(calls, 1);
});

test('negação de autorização estruturada não despacha nem reexecuta o provider', async t => {
  let calls = 0;
  const c = setup(t, async () => { calls++; return 'Não deve ocorrer'; });
  const run = await c.start({}, { authorize: () => false });
  assert.equal(run.state, 'invalidated'); assert.equal(run.invalidation.code, 'authorization_changed');
  assert.equal(run.providerCalled, false); assert.equal(calls, 0); assert.equal(c.history().latencyMs, 0);
});

test('ação humana em voo invalidada conserva recibo unknown e nunca repete modelo/ferramenta', async t => {
  const tool = deferred(); let modelCalls = 0, toolCalls = 0;
  const mcp = {
    snapshot: () => [{ alias: 'offline_action', readOnly: false }], definitions: () => [{ type: 'function', function: { name: 'offline_action' } }], current: () => true, clearReplay: () => {},
    propose: (_tenant, run) => {
      run.state = 'waiting_approval'; run.version++;
      run.toolProposal = { id: 'proposal', serverId: 'offline-server', toolName: 'offline_action', title: 'Ação de fixture', expiresAt: '2026-10-24T13:00:00.000Z' };
    },
    call: (_actor, _tenantId, _run, { onDispatch }) => { toolCalls++; onDispatch(); return tool.promise; }
  };
  const c = setup(t, async () => { modelCalls++; return { toolCall: { id: 'call', name: 'offline_action', arguments: {} } }; }, { mcp });
  const proposed = await c.start();
  assert.equal(proposed.state, 'waiting_approval'); assert.equal(c.history().completedAt, null); assert.equal(c.history().latencyMs, null);
  c.runtime.approveTool(c.operator, c.tenant.id, proposed.id, { proposalId: 'proposal', version: proposed.version }); await tick();
  assert.equal(c.history().state, 'tool_running'); assert.equal(c.history().completedAt, null);
  c.at('2026-10-24T12:00:09.000Z'); c.edit(state => { state.conversations[0].version++; });
  c.runtime.invalidateConversation(c.operator, c.tenant.id, 'conv'); await tick();
  const run = c.runtime.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(run.state, 'tool_unknown'); assert.equal(run.toolReceipt.state, 'unknown'); assert.equal(run.toolReceipt.approvedBy, c.operator.name);
  assert.equal(run.completedAt, '2026-10-24T12:00:09.000Z'); assert.equal(c.history().latencyMs, 9000); assert.equal(c.history().outcome, 'failed');
  assert.match(run.reason, /não repita automaticamente/i);
  c.at('2026-10-28T12:00:00.000Z'); tool.resolve({ content: [] }); await tick();
  const repeated = c.runtime.approveTool(c.operator, c.tenant.id, run.id, { proposalId: 'proposal', version: proposed.version });
  assert.equal(repeated.state, 'tool_unknown'); assert.equal(c.history().latencyMs, 9000);
  assert.equal(modelCalls, 1); assert.equal(toolCalls, 1);
});
