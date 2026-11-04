import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { McpManager, mcpHash, internalConversationHistory, internalContactProfile } from '../src/mcp.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { PostgresBridge } from '../src/postgres-bridge.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'qa-mcp-admin', name: 'QA runtime MCP' };
const status = code => error => error.status === code;
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = extra => ({ agentId: 'hermes', version: 1, ...extra });
const privateReasoning = 'synthetic-model-private-reasoning';
const privateInstruction = 'synthetic-attendant-private-orientation';

async function flush() { for (let index = 0; index < 3; index++) await settle(); }
function proposal(context, id = 'call_fixture_1', name = context.tools[0]?.function.name || 'elozi_mcp_unlisted', args = {}) {
  return { toolCall: { id, name, arguments: args }, assistant: { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }], reasoning_content: privateReasoning } };
}
// Hermes validates one proposal/result pair, as the last messages, and no catalog after it (Hermes adapter).
function assertHermesShape(request) {
  const pairs = request.messages.filter(message => message.tool_calls).length, results = request.messages.filter(message => message.role === 'tool');
  assert.ok(pairs <= 1 && results.length === pairs, 'No máximo um par proposta/resultado por chamada.');
  if (pairs) { assert.equal(request.messages.at(-1).role, 'tool'); assert.equal(request.messages.at(-2).tool_calls.length, 1); assert.deepEqual(request.tools, []); }
}
const observations = message => JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));

// Approval mechanics are exercised with approve_all; the default auto_readonly policy has its own tests below.
async function setup(t, { holdResult = false, secondProposal = false, policy = 'approve_all', tools = ['elozi_channel_status'], provider = null, context = null } = {}) {
  const store = new Store(':memory:'), vault = encryptedChannelSecrets(store.db, randomBytes(32));
  // Exercise the real projection payload builder; no PostgreSQL connection or external transport.
  const bridge = new PostgresBridge(store, { transport: { async sync() {}, async close() {} } });
  const tenant = store.createTenant(admin, { name: 'MCP runtime RAM', segment: 'QA' });
  const operator = { ...admin, role: 'operator', userId: 'qa-mcp-operator', tenantId: tenant.id };
  store.mutate(admin, tenant.id, 'Fixture MCP runtime', state => {
    state.agents.push({ id: 'hermes', name: 'Hermes QA', provider: 'hermes', configured: true, mode: 'copilot', version: 1, tools: [], ...(policy ? { toolPolicy: policy } : {}) });
    state.channels.push({ id: 'tg', name: 'Canal sintético', kind: 'telegram', enabled: true });
    state.conversations.push({ id: 'conv', channelId: 'tg', owner: 'human', assignedUserId: operator.userId,
      agentId: null, status: 'open', version: 1, messages: [{ id: 'customer-1', kind: 'customer', text: 'O canal está disponível?' }] });
  });
  const counters = { clients: 0, callTools: 0, internalQueries: 0 }, toolReturned = deferred(), releaseResult = deferred(), secondProvider = deferred(), queries = [];
  const mcp = new McpManager(store, { vault: () => vault, internalContext(actor, tenantId, conversationId, request) {
    assert.equal(actor.userId, operator.userId); assert.equal(tenantId, tenant.id); assert.equal(conversationId, 'conv');
    counters.internalQueries++; queries.push(structuredClone(request));
    if (context) return context(request);
    return { channel: { id: 'tg', connected: true }, attendance: { status: 'open', responsible: operator.userId } };
  } });
  const originalWithClient = mcp.withClient.bind(mcp);
  mcp.withClient = (actor, tenantId, server, options, action) => {
    counters.clients++;
    return originalWithClient(actor, tenantId, server, options, client => action(new Proxy(client, { get(target, name) {
      if (name === 'callTool') return async (...args) => {
        counters.callTools++;
        const result = await target.callTool(...args); // Actual MCP SDK request and internal handler.
        toolReturned.resolve();
        if (holdResult) await releaseResult.promise;
        return result;
      };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } })));
  };
  const server = mcp.create(admin, tenant.id, { name: 'Elozi interna QA', kind: 'internal', enabled: true });
  const discovered = await mcp.discover(admin, tenant.id, server.id, { version: server.version });
  mcp.setGrants(admin, tenant.id, 'hermes', { version: 1, grants: tools.map(name => discovered.tools.find(item => item.name === name))
    .map(tool => ({ serverId: discovered.id, serverVersion: discovered.version, toolName: tool.name, toolHash: tool.hash })) });
  const aliases = Object.fromEntries(mcp.snapshot(store.tenant(admin, tenant.id), store.tenant(admin, tenant.id).agents[0]).map(item => [item.toolName, item.alias]));
  counters.clients = 0;
  const providerRequests = [];
  const providerCall = async context => {
    providerRequests.push({ messages: structuredClone(context.messages), tools: structuredClone(context.tools), runId: context.runId });
    if (provider) return provider(context, providerRequests.length, aliases);
    if (providerRequests.length === 1) return proposal(context);
    secondProvider.resolve();
    return secondProposal ? proposal(context, 'call_fixture_2') : { text: 'O canal está disponível. Revise antes de enviar.' };
  };
  const runtime = new AgentRuntime(store, { providerCall, mcp });
  t.after(async () => {
    for (const controller of runtime.controllers.values()) controller.abort();
    releaseResult.resolve(); await flush(); await bridge.close(); store.close();
  });
  const c = { store, vault, bridge, tenant, operator, mcp, runtime, server: discovered, counters, providerRequests,
    providerCall, toolReturned, releaseResult, secondProvider, queries, aliases };
  c.current = () => runtime.list(operator, tenant.id, 'conv')[0];
  c.waiting = extra => runtime.start(operator, tenant.id, 'conv', input(extra));
  c.approve = (run, options) => runtime.approveTool(operator, tenant.id, run.id,
    { version: run.version, proposalId: run.toolProposal.id }, options);
  return c;
}

test('MCP cancelado após aprovação e antes da microtask faz zero chamadas SDK', async t => {
  const c = await setup(t), run = await c.waiting({ runId: 'cancel-before-dispatch' });
  assert.equal(run.state, 'waiting_approval');
  const accepted = c.approve(run); assert.equal(accepted.state, 'tool_running');
  const cancelled = c.runtime.cancel(c.operator, c.tenant.id, run.id); assert.equal(cancelled.state, 'cancelled');
  await flush();
  assert.deepEqual(c.counters, { clients: 0, callTools: 0, internalQueries: 0 });
  assert.equal(c.current().state, 'cancelled'); assert.equal(c.current().draft, null);
  assert.equal(c.providerRequests.length, 1); assert.equal(c.runtime.controllers.size, 0);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('MCP em voo vira unknown ao cancelar e resultado tardio não reativa a execução', async t => {
  const c = await setup(t, { holdResult: true }), run = await c.waiting({ runId: 'cancel-in-flight' });
  c.approve(run); await c.toolReturned.promise;
  assert.equal(c.current().toolReceipt.state, 'in_flight');
  assert.equal(c.counters.callTools, 1); assert.equal(c.counters.internalQueries, 1);
  const cancelled = c.runtime.cancel(c.operator, c.tenant.id, run.id);
  assert.equal(cancelled.state, 'tool_unknown'); assert.equal(cancelled.toolReceipt.state, 'unknown');
  c.releaseResult.resolve(); await flush();
  assert.equal(c.current().state, 'tool_unknown'); assert.equal(c.current().draft, null);
  assert.equal(c.providerRequests.length, 1); assert.equal(c.counters.callTools, 1);
  assert.equal(c.approve(run).state, 'tool_unknown'); await flush();
  assert.equal(c.counters.callTools, 1); assert.equal(c.runtime.controllers.size, 0);
});

test('restart reconcilia MCP órfão in-flight para unknown sem retry nem continuação', async t => {
  const c = await setup(t, { holdResult: true }), run = await c.waiting({ runId: 'restart-in-flight' });
  c.approve(run); await c.toolReturned.promise;
  const restarted = new AgentRuntime(c.store, { providerCall: c.providerCall, mcp: c.mcp });
  const restored = restarted.list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(restored.state, 'tool_unknown'); assert.equal(restored.toolReceipt.state, 'unknown');
  const repeated = restarted.approveTool(c.operator, c.tenant.id, run.id, { version: run.version, proposalId: run.toolProposal.id });
  assert.equal(repeated.state, 'tool_unknown');
  c.releaseResult.resolve(); await flush();
  assert.equal(c.current().state, 'tool_unknown'); assert.equal(c.current().draft, null);
  assert.equal(c.counters.callTools, 1); assert.equal(c.providerRequests.length, 1);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('revogação antes de aprovar ou após aceite bloqueia MCP antes do transporte', async t => {
  const c = await setup(t), run = await c.waiting({ runId: 'authority-before-dispatch' });
  assert.throws(() => c.approve(run, { authorize: () => false }), status(403));
  assert.equal(c.current().state, 'waiting_approval');
  let allowed = true; const phases = [];
  const accepted = c.approve(run, { authorize({ phase }) { phases.push(phase); return allowed; } });
  assert.equal(accepted.state, 'tool_running'); allowed = false; await flush();
  const current = c.current();
  assert.deepEqual(phases, ['approve', 'tool-dispatch']);
  assert.equal(current.state, 'failed'); assert.equal(current.toolReceipt.state, 'not_dispatched');
  assert.deepEqual(c.counters, { clients: 0, callTools: 0, internalQueries: 0 });
  assert.equal(c.providerRequests.length, 1); assert.equal(current.draft, null);
});

test('revogação com resultado MCP pendente impede que o contexto volte ao modelo', async t => {
  const c = await setup(t, { holdResult: true }), run = await c.waiting({ runId: 'authority-after-dispatch' });
  let allowed = true;
  c.approve(run, { authorize: () => allowed }); await c.toolReturned.promise;
  allowed = false; c.releaseResult.resolve(); await flush();
  assert.equal(c.current().state, 'tool_unknown'); assert.equal(c.current().toolReceipt.state, 'unknown');
  assert.equal(c.current().draft, null); assert.equal(c.providerRequests.length, 1);
  assert.equal(c.counters.callTools, 1); assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('catálogo alterado invalida proposta antiga antes de abrir cliente MCP', async t => {
  const c = await setup(t), run = await c.waiting({ runId: 'stale-catalog' });
  c.mcp.update(admin, c.tenant.id, c.server.id, { version: c.server.version, name: 'Novo catálogo QA' });
  const stale = c.approve(run);
  assert.equal(stale.state, 'invalidated'); assert.equal(stale.draft, null);
  await flush();
  assert.deepEqual(c.counters, { clients: 0, callTools: 0, internalQueries: 0 });
  assert.equal(c.providerRequests.length, 1); assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('replay com reasoning e orientação fica cifrado e ausente do tenant e spool PostgreSQL', async t => {
  const c = await setup(t), run = await c.waiting({ runId: 'private-replay', instruction: privateInstruction });
  const sidecarId = `mcp-run:${c.tenant.id}:${run.id}`, replay = c.vault.get(sidecarId);
  assert.equal(replay.assistant.reasoning_content, privateReasoning);
  assert.ok(replay.messages.some(message => message.content.includes(privateInstruction)));
  const blob = Buffer.from(c.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get(sidecarId).payload);
  for (const marker of [privateReasoning, privateInstruction, 'tool_calls', 'reasoning_content']) assert.equal(blob.includes(Buffer.from(marker)), false);
  assert.equal(c.vault.get(`mcp-run:other-tenant:${run.id}`), null);
  const tenant = JSON.stringify(c.store.tenant(admin, c.tenant.id)), publicRuns = JSON.stringify(c.runtime.list(c.operator, c.tenant.id));
  const projected = c.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(c.tenant.id).payload;
  for (const document of [tenant, publicRuns, projected]) for (const marker of [privateReasoning, privateInstruction, 'tool_calls', 'reasoning_content']) assert.equal(document.includes(marker), false);
  c.runtime.rejectTool(c.operator, c.tenant.id, run.id, { version: run.version, proposalId: run.toolProposal.id });
  assert.deepEqual(c.vault.get(sidecarId), {});
});

test('consulta aprovada usa SDK interno uma vez e continuação termina no par assistant/tool sem catálogo', async t => {
  const c = await setup(t), run = await c.waiting({ runId: 'approved-continuation' });
  c.approve(run); await c.secondProvider.promise; await flush();
  assert.equal(c.counters.clients, 1);
  assert.equal(c.counters.callTools, 1); assert.equal(c.counters.internalQueries, 1);
  assert.equal(c.providerRequests.length, 2);
  const continuation = c.providerRequests[1], assistant = continuation.messages.at(-2), result = continuation.messages.at(-1);
  assert.deepEqual(continuation.tools, []); assert.equal(assistant.role, 'assistant'); assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, assistant.tool_calls[0].id); assert.equal(assistant.reasoning_content, privateReasoning);
  assert.equal(JSON.parse(result.content).structuredContent.connected, true);
  const current = c.current(); assert.equal(current.state, 'draft'); assert.equal(current.toolReceipt.state, 'completed');
  assert.match(current.draft, /Revise antes de enviar/); assert.equal(c.runtime.controllers.size, 0);
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.length, 1);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
  assert.equal(c.approve(run).state, 'draft'); await flush();
  assert.equal(c.counters.callTools, 1); assert.equal(c.providerRequests.length, 2);
});

test('nova proposta na continuação sem catálogo é recusada sem segunda execução MCP', async t => {
  const c = await setup(t, { secondProposal: true }), run = await c.waiting({ runId: 'reject-second-proposal' });
  c.approve(run); await c.secondProvider.promise; await flush();
  assert.equal(c.providerRequests.length, 2); assert.deepEqual(c.providerRequests[1].tools, []);
  assert.equal(c.current().state, 'failed'); assert.equal(c.current().draft, null);
  assert.equal(c.current().toolReceipt.state, 'completed');
  assert.equal(c.counters.callTools, 1); assert.equal(c.counters.internalQueries, 1);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('orçamentos MCP preservam o par íntegro e limitam definição/continuação ao contrato Python', t => {
  const store=new Store(':memory:');t.after(()=>store.close());const sidecars=new Map(),vault={get:id=>sidecars.get(id),set:(id,value)=>sidecars.set(id,value)};
  const mcp=new McpManager(store,{vault:()=>vault});
  const defs=mcp.definitions([{alias:'elozi_tool',title:'T'.repeat(100),description:'D'.repeat(1600),inputSchema:{type:'object'}}]);assert.equal(defs[0].function.description.length,1600);
  const assistant={role:'assistant',content:null,tool_calls:[{id:'call_budget',type:'function',function:{name:'elozi_tool',arguments:'{}'}}],reasoning_content:'R'.repeat(32000)};
  const history=[{role:'system',content:'Contexto autorizado.'},{role:'user',content:'Histórico antigo '+ 'Á'.repeat(9000)},{role:'user',content:'Orientação recente '+ 'N'.repeat(2000)}];
  vault.set('mcp-run:t:r',{messages:history,assistant});const result={content:[{type:'text',text:'Dados '+ 'J'.repeat(18000)}],isError:false};
  const messages=mcp.continuation('t',{id:'r'},result);
  assert.equal(messages[0].role,'system');assert.ok(!messages.some(item=>item.content?.startsWith('Histórico antigo')));assert.ok(messages.some(item=>item.content?.startsWith('Orientação recente')));
  assert.deepEqual(messages.at(-2),assistant);assert.equal(messages.at(-1).tool_call_id,'call_budget');assert.deepEqual(JSON.parse(messages.at(-1).content),result);
  assert.ok(messages.reduce((total,item)=>total+Buffer.byteLength(item.content||'')+(item.tool_calls||[]).reduce((sum,call)=>sum+Buffer.byteLength(call.function.arguments),0),0)<=24*1024);
  assert.throws(()=>mcp.continuation('t',{id:'r'},{content:[{type:'text',text:'J'.repeat(26000)}]}),status(502));
  assert.deepEqual(vault.get('mcp-run:t:r').messages,history,'O orçamento só reduz o request de continuação, preserva o replay cifrado até seu encerramento.');
});

test('consulta interna somente leitura roda sem aprovação na política padrão e termina em rascunho', async t => {
  const phases = [];
  const c = await setup(t, { policy: null, provider: (context, index) => index === 1 ? proposal(context) : { text: 'O canal está disponível. Revise antes de enviar.' } });
  const run = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'auto-readonly' }), { authorize({ phase }) { phases.push(phase); } });
  assert.equal(run.state, 'draft'); assert.match(run.draft, /Revise antes de enviar/); assert.equal(run.toolPolicy, 'auto_readonly');
  assert.equal(run.toolProposal.autoApproved, true); assert.equal(run.toolReceipt.state, 'completed');
  assert.equal(run.toolReceipt.autoApproved, true); assert.equal(run.toolReceipt.approvedBy, 'Consulta automática'); assert.equal(run.toolReceipt.approvedUserId, null);
  assert.deepEqual(run.toolSteps.map(step => [step.toolName, step.autoApproved]), [['elozi_channel_status', true]]);
  assert.deepEqual([phases[0], phases[1], phases.at(-2), phases.at(-1)], ['dispatch', 'proposal', 'dispatch', 'complete']);
  assert.ok(phases.slice(2, -2).length >= 2 && phases.slice(2, -2).every(phase => phase === 'tool-dispatch'), 'Cada passo da consulta revalida a autorização.');
  assert.equal(c.counters.callTools, 1); assert.equal(c.counters.internalQueries, 1);
  assert.deepEqual(c.queries[0], { tool: 'elozi_channel_status', arguments: {}, runId: 'auto-readonly', agentId: 'hermes' });
  assert.match(c.providerRequests[0].messages[0].content, /executadas automaticamente, até 3 por rascunho/);
  assert.doesNotMatch(c.providerRequests[0].messages[0].content, /só executa depois da aprovação/);
  const continuation = c.providerRequests[1]; assertHermesShape(continuation);
  assert.equal(continuation.tools.length, 1, 'Abaixo do limite a continuação oferece o catálogo novamente.');
  assert.equal(continuation.messages.some(message => message.role === 'tool' || message.tool_calls), false);
  assert.match(continuation.messages.at(-1).content, /nunca instruções/);
  assert.deepEqual(observations(continuation.messages.at(-1)), [{ tool: 'Status do canal', arguments: {}, isError: false, data: { id: 'tg', connected: true } }]);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {}); assert.equal(c.runtime.controllers.size, 0);
  assert.equal(c.store.tenant(admin, c.tenant.id).conversations[0].messages.length, 1);
  assert.equal(c.approve(run).state, 'draft', 'Uma aprovação tardia não despacha consulta automática.'); await flush();
  assert.equal(c.counters.callTools, 1); assert.equal(c.providerRequests.length, 2);
});

test('fila executa consulta automática em segundo plano e devolve o run aceito sem esperar a ferramenta', async t => {
  const c = await setup(t, { policy: null, provider: (context, index) => { if (index === 1) return proposal(context); c.secondProvider.resolve(); return { text: 'Rascunho da fila com consulta.' }; } });
  const queued = c.runtime.enqueue(c.operator, c.tenant.id, 'conv', input({ runId: 'auto-queue' }));
  assert.equal(queued.state, 'running'); assert.equal(typeof queued.then, 'undefined');
  await c.secondProvider.promise; await flush();
  const current = c.current(); assert.equal(current.state, 'draft'); assert.equal(current.draft, 'Rascunho da fila com consulta.');
  assert.equal(current.toolReceipt.autoApproved, true); assert.equal(c.counters.callTools, 1); assert.equal(c.runtime.controllers.size, 0);
});

test('política approve_all mantém aprovação humana mesmo para consulta interna', async t => {
  const c = await setup(t, { policy: 'approve_all' }), run = await c.waiting({ runId: 'approve-all' });
  assert.equal(run.state, 'waiting_approval'); assert.equal(run.toolPolicy, 'approve_all'); assert.equal(run.toolProposal.readOnly, true);
  assert.equal(run.toolProposal.autoApproved, undefined); assert.equal(run.toolReceipt, undefined);
  assert.match(c.providerRequests[0].messages[0].content, /Cada ferramenta só executa depois da aprovação/);
  await flush(); assert.equal(c.counters.callTools, 0); assert.equal(c.current().state, 'waiting_approval');
  c.approve(run); await c.secondProvider.promise; await flush();
  const done = c.current(); assert.equal(done.state, 'draft'); assert.equal(done.toolReceipt.approvedUserId, c.operator.userId);
  assert.equal(done.toolReceipt.autoApproved, undefined); assert.deepEqual(c.providerRequests[1].tools, []);
  assert.equal(done.toolReceipt.summarized, undefined, 'O status do canal é metadado do atendimento e fica inteiro no recibo.');
  const audit = c.store.db.prepare('SELECT action FROM audit WHERE tenant_id=?').all(c.tenant.id).map(row => row.action);
  for (const action of ['Ferramenta proposta para aprovação', 'Ferramenta aprovada pelo responsável', 'Consulta MCP encaminhada', 'Resultado da ferramenta MCP recebido']) assert.ok(audit.includes(action), action);
  assert.equal(audit.some(action => action.startsWith('Consulta automática')), false);
});

test('ferramenta remota sempre espera aprovação, mesmo quando o catálogo declara somente leitura', async t => {
  const c = await setup(t, { policy: null, provider: (context, index, aliases) => proposal(context, 'call_remote', aliases.lookup_order) });
  const remoteTool = { name: 'lookup_order', title: 'Pedido externo', description: 'Consulta um pedido no sistema externo.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true };
  remoteTool.hash = mcpHash(remoteTool);
  c.store.mutate(admin, c.tenant.id, 'Servidor remoto sintético verificado', state => {
    state.mcpServers.push({ id: 'remote-qa', name: 'Remoto QA', kind: 'remote', endpoint: 'https://mcp.remote.invalid/mcp', enabled: true, version: 1, state: 'verified', tools: [remoteTool], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const internal = c.server.tools.find(tool => tool.name === 'elozi_channel_status');
  c.mcp.setGrants(admin, c.tenant.id, 'hermes', { version: 2, grants: [{ serverId: c.server.id, serverVersion: c.server.version, toolName: internal.name, toolHash: internal.hash },
    { serverId: 'remote-qa', serverVersion: 1, toolName: 'lookup_order', toolHash: remoteTool.hash }] });
  Object.assign(c.aliases, Object.fromEntries(c.mcp.snapshot(c.store.tenant(admin, c.tenant.id), c.store.tenant(admin, c.tenant.id).agents[0]).map(item => [item.toolName, item.alias])));
  const run = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'remote-waits' }));
  assert.equal(run.state, 'waiting_approval'); assert.equal(run.toolProposal.serverId, 'remote-qa'); assert.equal(run.toolProposal.readOnly, false);
  assert.equal(run.toolProposal.autoApproved, undefined); assert.equal(run.toolReceipt, undefined); assert.equal(c.counters.clients, 0);
  assert.match(c.providerRequests[0].messages[0].content, /As demais ferramentas só executa depois da aprovação/);
  const forged = { toolProposal: { ...run.toolProposal, readOnly: true }, toolSnapshot: [{ serverId: 'remote-qa', toolName: 'lookup_order', toolHash: remoteTool.hash, serverVersion: 1, readOnly: true }] };
  assert.equal(c.mcp.autoApprovable(c.store.tenant(admin, c.tenant.id), forged), false, 'Servidor remoto não se autodeclara somente leitura.');
  assert.equal(c.runtime.rejectTool(c.operator, c.tenant.id, run.id, { version: run.version, proposalId: run.toolProposal.id }).state, 'rejected');
  await flush(); assert.equal(c.counters.callTools, 0); assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('até três consultas automáticas por rascunho; a continuação final segue sem catálogo e com um único par', async t => {
  const c = await setup(t, { policy: null, tools: ['elozi_channel_status', 'elozi_attendance_status'],
    provider: (context, index, aliases) => context.tools.length ? proposal(context, 'call_step_' + index, aliases[index % 2 ? 'elozi_channel_status' : 'elozi_attendance_status']) : { text: 'Rascunho após três consultas.' } });
  const run = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'three-steps' }));
  assert.equal(run.state, 'draft'); assert.equal(run.draft, 'Rascunho após três consultas.');
  assert.deepEqual(run.toolSteps.map(step => [step.toolName, step.autoApproved]), [['elozi_channel_status', true], ['elozi_attendance_status', true], ['elozi_channel_status', true]]);
  assert.deepEqual(c.providerRequests.map(request => request.tools.length), [2, 2, 2, 0]);
  assert.equal(c.counters.callTools, 3); assert.deepEqual(c.queries.map(query => query.tool), ['elozi_channel_status', 'elozi_attendance_status', 'elozi_channel_status']);
  for (const request of c.providerRequests) assertHermesShape(request);
  assert.deepEqual(observations(c.providerRequests[2].messages.at(-1)).map(item => item.tool), ['Status do canal', 'Status do atendimento']);
  // White label: what the model reads names the company, never the platform (elozi_* tool names are protocol, not copy).
  for (const request of c.providerRequests) for (const message of request.messages) assert.doesNotMatch(String(message.content ?? ''), /Elozi/, message.role);
  const final = c.providerRequests[3];
  assert.equal(final.messages.at(-2).tool_calls[0].id, 'call_step_3'); assert.equal(final.messages.at(-1).tool_call_id, 'call_step_3');
  assert.equal(JSON.parse(final.messages.at(-1).content).structuredContent.connected, true);
  assert.deepEqual(observations(final.messages.at(-3)).map(item => item.tool), ['Status do canal', 'Status do atendimento']);
  assert.equal(final.messages[0].role, 'system'); assert.equal(final.messages.filter(message => message.role === 'system').length, 1);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {}); assert.equal(c.runtime.controllers.size, 0);
});

test('proposta após o limite de consultas automáticas é recusada sem quarta execução', async t => {
  const c = await setup(t, { policy: null, provider: (context, index) => proposal(context, 'call_over_' + index, context.tools[0]?.function.name || 'elozi_mcp_forbidden') });
  const run = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'over-limit' }));
  assert.equal(run.state, 'failed'); assert.equal(run.draft, null); assert.equal(run.toolSteps.length, 3);
  assert.equal(c.counters.callTools, 3); assert.deepEqual(c.providerRequests.map(request => request.tools.length), [1, 1, 1, 0]);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:${run.id}`), {});
});

test('falha de consulta automática encerra failed, sem tool_unknown, e permite nova tentativa', async t => {
  let broken = true;
  const c = await setup(t, { policy: null,
    context: () => { if (broken) throw Object.assign(new Error('falha-sintetica-privada'), { status: 503 }); return { channel: { id: 'tg', connected: true } }; },
    provider: context => String(context.messages.at(-1).content).startsWith('Resultados de consultas') ? { text: 'Rascunho depois da nova tentativa.' } : proposal(context) });
  const failed = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'auto-failure' }));
  assert.equal(failed.state, 'failed'); assert.equal(failed.draft, null); assert.equal(failed.toolReceipt.autoApproved, true);
  assert.equal(failed.toolReceipt.state, 'failed'); assert.match(failed.reason, /consulta automática não foi concluída/);
  assert.equal(JSON.stringify(c.store.tenant(admin, c.tenant.id)).includes('falha-sintetica-privada'), false);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:auto-failure`), {}); assert.equal(c.runtime.controllers.size, 0);
  broken = false;
  const retried = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'auto-retry' }));
  assert.equal(retried.state, 'draft'); assert.equal(retried.draft, 'Rascunho depois da nova tentativa.'); assert.equal(c.counters.callTools, 2);
});

test('cancelar ou reiniciar durante consulta automática não deixa recibo incerto', async t => {
  const c = await setup(t, { policy: null, holdResult: true, provider: (context, index) => index === 1 ? proposal(context) : { text: 'Não deve aparecer.' } });
  const pending = c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'auto-restart' }));
  await c.toolReturned.promise;
  assert.equal(c.current().state, 'tool_running'); assert.equal(c.current().toolReceipt.state, 'in_flight');
  const restored = new AgentRuntime(c.store, { providerCall: c.providerCall, mcp: c.mcp }).list(c.operator, c.tenant.id, 'conv')[0];
  assert.equal(restored.state, 'failed'); assert.equal(restored.toolReceipt.state, 'interrupted'); assert.match(restored.reason, /consulta automática foi interrompida/);
  c.releaseResult.resolve(); const result = await pending;
  assert.equal(result.state, 'failed'); assert.equal(c.providerRequests.length, 1); assert.equal(c.runtime.controllers.size, 0);
  assert.deepEqual(c.vault.get(`mcp-run:${c.tenant.id}:auto-restart`), {});
  const second = await setup(t, { policy: null, holdResult: true, provider: (context, index) => index === 1 ? proposal(context) : { text: 'Não deve aparecer.' } });
  const running = second.runtime.start(second.operator, second.tenant.id, 'conv', input({ runId: 'auto-cancel' }));
  await second.toolReturned.promise;
  const cancelled = second.runtime.cancel(second.operator, second.tenant.id, 'auto-cancel');
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.toolReceipt.state, 'interrupted');
  second.releaseResult.resolve(); assert.equal((await running).state, 'cancelled'); assert.equal(second.providerRequests.length, 1);
  assert.equal(second.runtime.controllers.size, 0);
});

test('histórico e perfil internos devolvem só dados mínimos do atendimento', () => {
  const date = index => new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString();
  const messages = Array.from({ length: 26 }, (_, index) => ({ id: 'm' + index, kind: index % 2 ? 'human' : 'customer', text: index === 0 ? 'Á'.repeat(900) : 'Mensagem ' + index, createdAt: date(index) }));
  messages.splice(3, 0, { id: 'note', kind: 'internal', text: 'nota-interna-privada', createdAt: date(3) });
  const conversation = { id: 'conv', channelId: 'tg', contact: 'Cliente QA', contactId: 'contact-a', tags: ['urgente'], conversationKind: 'direct', messages, updatedAt: date(30) };
  const history = internalConversationHistory(conversation, {});
  assert.deepEqual(history.messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']); assert.equal(history.hasMore, false); assert.equal(history.recentWindow, 20);
  assert.equal(Array.from(history.messages[0].text).length, 501); assert.equal(JSON.stringify(history).includes('nota-interna-privada'), false);
  assert.deepEqual(internalConversationHistory(conversation, { before: 'm4', limit: 2 }).messages.map(item => item.id), ['m2', 'm3']);
  assert.equal(internalConversationHistory(conversation, { before: 'm4', limit: 2 }).nextBefore, 'm2');
  assert.throws(() => internalConversationHistory(conversation, { before: 'message-from-another-company' }), status(400));
  const tenant = { channels: [{ id: 'tg', kind: 'telegram' }, { id: 'hidden', kind: 'whatsapp_qr' }], contacts: [{ id: 'contact-a', name: 'Nome do cadastro', phone: '5511999990000', email: 'privado@cliente.invalid', notes: 'anotação privada', tags: ['vip'], createdAt: date(0), updatedAt: date(1) }],
    conversations: [conversation, { id: 'old-1', channelId: 'tg', contactId: 'contact-a' }, { id: 'old-hidden', channelId: 'hidden', contactId: 'contact-a' }, { id: 'other', channelId: 'tg', contactId: 'contact-b' }] };
  const profile = internalContactProfile(tenant, conversation, { readable: item => item.channelId === 'tg', contactVisible: true });
  assert.deepEqual(profile, { displayName: 'Cliente QA', conversationKind: 'direct', channelKind: 'telegram', tags: ['urgente', 'vip'], linkedContact: true, previousConversations: 1, createdAt: date(0), updatedAt: date(1) });
  const limited = internalContactProfile(tenant, conversation, { readable: () => true });
  assert.deepEqual(limited.tags, ['urgente']); assert.equal(limited.previousConversations, 2); assert.equal(limited.createdAt, date(0));
  for (const value of [profile, limited]) for (const marker of ['5511999990000', 'privado@cliente.invalid', 'anotação privada']) assert.equal(JSON.stringify(value).includes(marker), false);
});

test('uso do Hermes soma rodadas de consulta automática e aprovada na mesma execução, fora da projeção PostgreSQL', async t => {
  const usage = (prompt, completion) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });
  const auto = await setup(t, { policy: null, provider: (context, index) => index === 1 ? { ...proposal(context), usage: usage(300, 12) } : { text: 'O canal está disponível.', usage: usage(410, 25) } });
  const run = await auto.runtime.start(auto.operator, auto.tenant.id, 'conv', input({ runId: 'auto-usage' }));
  assert.equal(run.state, 'draft'); assert.deepEqual(run.usage, usage(710, 37));
  assert.deepEqual(auto.store.db.prepare('SELECT runs,prompt_tokens,completion_tokens FROM ai_usage WHERE tenant_id=? AND agent_id=?').all(auto.tenant.id, 'hermes').map(row => ({ ...row })), [{ runs: 1, prompt_tokens: 710, completion_tokens: 37 }]);
  const projected = auto.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(auto.tenant.id).payload;
  const payload = JSON.parse(projected); assert.equal(projected.includes('"usage":{"prompt_tokens":710'), true, 'A execução leva só o próprio total.');
  assert.equal(JSON.stringify({ ...payload, runs: [] }).includes('prompt_tokens'), false, 'O agregado diário fica só na tabela SQLite ai_usage, fora da projeção.');
  const approved = await setup(t, { provider: (context, index) => index === 1 ? { ...proposal(context), usage: usage(200, 5) } : { text: 'Canal confirmado pela equipe.', usage: usage(260, 9) } });
  const waiting = await approved.waiting({ runId: 'approved-usage' });
  assert.equal(waiting.state, 'waiting_approval'); assert.deepEqual(waiting.usage, usage(200, 5));
  approved.approve(waiting);
  for (let attempt = 0; attempt < 50 && approved.current().state !== 'draft'; attempt++) await settle();
  const done = approved.current(); assert.equal(done.state, 'draft'); assert.deepEqual(done.usage, usage(460, 14));
  assert.equal(approved.runtime.usage(admin, approved.tenant.id).today.totalTokens, 474);
});

test('consulta automática entrega conhecimento e perfil ao modelo e grava só o resumo, fora do tenant, da leitura e do spool PostgreSQL', async t => {
  const excerpt = 'TEXTO-PRIVADO-DA-BASE: a garantia cobre 12 meses.', tag = 'vip-do-cadastro';
  const c = await setup(t, { policy: null, tools: ['elozi_contact_profile', 'elozi_knowledge_search'],
    context: request => request.tool === 'elozi_knowledge_search' ? { knowledge: { state: 'matched', results: [{ title: 'Política de garantia', excerpt }] } }
      : { contact: { displayName: 'Cliente QA', conversationKind: 'direct', channelKind: 'telegram', tags: [tag], linkedContact: true, previousConversations: 2, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z' } },
    provider: (context, index, aliases) => index === 1 ? proposal(context, 'call_contact', aliases.elozi_contact_profile)
      : index === 2 ? proposal(context, 'call_knowledge', aliases.elozi_knowledge_search, { query: 'garantia' }) : { text: 'A garantia cobre 12 meses.' } });
  const run = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'auto-summary' }));
  assert.equal(run.state, 'draft', run.reason); assert.deepEqual(run.toolSteps.map(step => step.toolName), ['elozi_contact_profile', 'elozi_knowledge_search']);
  // The knowledge search is the last step, so its receipt is the one the run keeps.
  assert.equal(run.toolReceipt.state, 'completed'); assert.equal(run.toolReceipt.summarized, true);
  assert.deepEqual(run.toolReceipt.result.structuredContent, { state: 'matched', results: [{ title: 'Política de garantia' }] });
  assert.deepEqual(JSON.parse(run.toolReceipt.result.content[0].text), run.toolReceipt.result.structuredContent);
  const delivered = observations(c.providerRequests[2].messages.at(-1));
  assert.deepEqual(delivered.map(item => item.tool), ['Perfil do contato', 'Busca no conhecimento']);
  assert.deepEqual(delivered[0].data.tags, [tag]); assert.equal(delivered[1].data.results[0].excerpt, excerpt, 'O modelo recebe o resultado completo.');
  const tenant = JSON.stringify(c.store.tenant(admin, c.tenant.id)), visible = JSON.stringify(c.runtime.list(c.operator, c.tenant.id, 'conv'));
  const projected = c.store.db.prepare('SELECT payload FROM postgres_spool WHERE tenant_id=?').get(c.tenant.id).payload;
  for (const [label, document] of Object.entries({ tenant, visible, projected })) for (const marker of ['TEXTO-PRIVADO-DA-BASE', tag]) assert.equal(document.includes(marker), false, label + ': ' + marker);
  assert.equal(JSON.parse(projected).runs[0].toolReceipt.result.structuredContent.results[0].title, 'Política de garantia', 'A projeção leva só o título publicado.');
  const audit = c.store.db.prepare('SELECT action FROM audit WHERE tenant_id=?').all(c.tenant.id).map(row => row.action), count = action => audit.filter(item => item === action).length;
  assert.equal(count('Consulta automática aprovada pela política do agente'), 2); assert.equal(count('Consulta automática encaminhada'), 2);
  assert.equal(count('Resultado da consulta automática recebido'), 2); assert.equal(count('Ferramenta proposta para aprovação'), 0, 'A auditoria distingue a consulta automática de uma proposta em espera.');
  assert.equal(count('Consulta MCP encaminhada'), 0);
});

test('continuação com consultas grandes preserva a pergunta atual do cliente e a orientação do atendente', async t => {
  const question = 'PERGUNTA-ATUAL-DO-CLIENTE: a garantia cobre a tela?', note = 'ORIENTACAO-DO-ATENDENTE-SINTETICA';
  const results = Array.from({ length: 5 }, (_, index) => ({ title: 'Fonte ' + index, excerpt: String(index).repeat(1500) }));
  const c = await setup(t, { policy: null, tools: ['elozi_knowledge_search'], context: () => ({ knowledge: { state: 'matched', results } }),
    provider: (context, index, aliases) => context.tools.length ? proposal(context, 'call_large_' + index, aliases.elozi_knowledge_search, { query: 'garantia ' + index }) : { text: 'A garantia cobre a tela.' } });
  c.store.mutate(admin, c.tenant.id, 'Histórico longo sintético', state => {
    state.conversations[0].messages = [...Array.from({ length: 19 }, (_, index) => ({ id: 'old-' + index, kind: index % 2 ? 'human' : 'customer', text: 'Mensagem antiga ' + index + ' ' + 'h'.repeat(600) })),
      { id: 'current', kind: 'customer', text: question }];
  });
  const run = await c.runtime.start(c.operator, c.tenant.id, 'conv', input({ runId: 'large-lookups', instruction: note }));
  assert.equal(run.state, 'draft', run.reason); assert.equal(run.toolSteps.length, 3);
  assert.deepEqual(c.providerRequests.map(request => request.tools.length), [1, 1, 1, 0]);
  const bytes = request => request.messages.reduce((total, message) => total + Buffer.byteLength(message.content || '') + (message.tool_calls || []).reduce((sum, call) => sum + Buffer.byteLength(call.function.arguments), 0), 0);
  for (const [index, request] of c.providerRequests.entries()) {
    assertHermesShape(request); assert.ok(bytes(request) <= 24 * 1024 - 128, 'Dentro do orçamento da continuação: ' + index);
    const text = JSON.stringify(request.messages);
    assert.ok(text.includes(question), 'Pergunta atual na chamada ' + index); assert.ok(text.includes(note), 'Orientação do atendente na chamada ' + index);
    assert.equal(request.messages[0].role, 'system');
  }
  const final = c.providerRequests[3];
  assert.deepEqual(JSON.parse(final.messages.at(-1).content), { isError: false, structuredContent: { state: 'matched', results } }, 'O texto duplicado do resultado estruturado cede espaço primeiro.');
  assert.equal(JSON.stringify(final.messages).includes('Mensagem antiga 0 '), false, 'Mensagens antigas cedem espaço antes da pergunta atual.');
  assert.equal(final.messages.filter(message => message.role === 'system').length, 1);
});

test('orçamento da continuação recorta a pergunta atual só como último recurso e falha fechado abaixo de 1 KiB', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const sidecars = new Map(), vault = { get: id => sidecars.get(id), set: (id, value) => sidecars.set(id, value) };
  const mcp = new McpManager(store, { vault: () => vault });
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'call_clip', type: 'function', function: { name: 'elozi_tool', arguments: '{}' } }] };
  const history = [{ role: 'system', content: 'Regras.' }, { role: 'assistant', content: 'Resposta anterior.' }, { role: 'user', content: 'Início da pergunta ' + 'Q'.repeat(12000) },
    { role: 'user', content: 'Orientação do atendente para este rascunho: revisar garantia.' }];
  vault.set('mcp-run:t:clip', { messages: history, assistant });
  const messages = mcp.continuation('t', { id: 'clip' }, { content: [{ type: 'text', text: 'R'.repeat(14000) }], isError: false });
  assert.ok(messages.some(message => message.content?.startsWith('Início da pergunta')), 'A pergunta atual continua, recortada.');
  assert.ok(messages.some(message => message.content?.startsWith('Orientação do atendente')));
  assert.equal(messages.some(message => message.content === 'Resposta anterior.'), false, 'A resposta anterior cede antes do recorte.');
  assert.equal(vault.get('mcp-run:t:clip').messages[2].content.length, 'Início da pergunta '.length + 12000, 'O replay cifrado não é alterado.');
  assert.throws(() => mcp.continuation('t', { id: 'clip' }, { content: [{ type: 'text', text: 'R'.repeat(23600) }], isError: false }), status(502));
});
