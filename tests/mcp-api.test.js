import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denied = async () => { throw new Error('External transport forbidden in MCP HTTP fixture'); };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function proposal(context, args = {}) {
  const alias = context.tools[0]?.function.name;
  assert.ok(alias, 'O provedor deve receber somente a ferramenta concedida.');
  return { toolCall: { id: 'call_one', name: alias, arguments: args }, assistant: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_one', type: 'function', function: { name: alias, arguments: JSON.stringify(args) } }] } };
}

// Existing approval journeys use approve_all; tests of the default auto_readonly policy pass policy: null.
async function fixture(t, { providerCall, holdToolResponse = false, policy = 'approve_all' } = {}) {
  const key = randomBytes(32), providerCalls = [], toolCalls = [], toolGate = deferred();
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', serviceKey: key,
    providerCall: context => {
      providerCalls.push(context);
      return providerCall ? providerCall(context) : context.messages.at(-1)?.role === 'tool' ? { text: 'Canal consultado.' } : proposal(context);
    },
    gatewayOptions: { authKey: key, socketFactory: denied },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denied },
    googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: denied } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    toolGate.resolve();
    for (const controller of app.runtime.controllers.values()) controller.abort();
    for (let attempt = 0; attempt < 30 && app.runtime.controllers.size; attempt++) await settle();
    await Promise.all([app.gateway.close(), app.telegram.close(), app.email.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });

  const mcp = app.mcp || app.runtime.mcp;
  assert.ok(mcp, 'A aplicação deve conectar o gerenciador MCP ao runtime.');
  const withClient = mcp.withClient.bind(mcp);
  // Count the SDK tools/call itself while retaining the real internal MCP transport.
  mcp.withClient = (actor, tenantId, server, options, action) => withClient(actor, tenantId, server, options, client => {
    const callTool = client.callTool.bind(client);
    client.callTool = async (...args) => {
      toolCalls.push({ tenantId, serverId: server.id, params: structuredClone(args[0]) });
      const result = await callTool(...args);
      if (holdToolResponse) await toolGate.promise;
      return result;
    };
    return action(client);
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', cookie = '', body, workspace } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie,
      ...(workspace === undefined ? {} : { 'X-Elozi-Workspace': workspace }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()),
          cookie: (response.headers['set-cookie'] || []).join(', ').split(';')[0] }); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('MCP HTTP fixture request timed out')));
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Admin MCP QA', username: 'mcp.owner', password: password() } });
  assert.equal(owner.status, 200);
  const actor = app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const created = await request('/api/tenants', { method: 'POST', cookie: owner.cookie, body: { name: 'Empresa MCP QA', segment: 'QA' } });
  assert.equal(created.status, 201);
  const tenantId = created.data.id, path = `/api/tenants/${tenantId}`, channelId = 'mcp-channel', hiddenChannelId = 'mcp-hidden-channel', agentId = 'mcp-hermes';
  const seed = id => app.store.mutate(actor, id, 'Fixture MCP com canais e agente sintéticos', tenant => {
    tenant.channels = [{ id: channelId, kind: 'telegram', name: 'Canal sintético MCP', state: 'planned' },
      { id: hiddenChannelId, kind: 'telegram', name: 'Canal restrito MCP', state: 'planned' }];
    tenant.agents = [{ id: agentId, name: 'Hermes MCP QA', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Consulta canais para preparar rascunhos.', ...(policy ? { toolPolicy: policy } : {}) }];
  });
  seed(tenantId);
  let memberSequence = 0, conversationSequence = 0;
  const member = async (extra = {}) => {
    const username = 'mcp.member.' + ++memberSequence, secret = password();
    const result = await request('/api/users', { method: 'POST', cookie: owner.cookie, body: { name: 'Atendente MCP QA ' + memberSequence,
      username, password: secret, role: 'operator', tenantIds: [tenantId], permissions: ['inbox.read', 'inbox.reply', 'inbox.transfer'], ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const logged = await request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
    assert.equal(logged.status, 200); return { ...result.data, cookie: logged.cookie };
  };
  const state = (id = tenantId) => app.store.tenant(actor, id);
  const conversation = (extra = {}) => app.store.mutate(actor, tenantId, 'Fixture de atendimento MCP', tenant => {
    const sequence = ++conversationSequence, now = new Date().toISOString();
    const current = { id: 'mcp-conversation-' + sequence, channelId, contact: 'Contato sintético MCP', owner: 'queue', assignedUserId: null,
      assignedUserName: null, agentId: null, departmentId: null, department: '', status: 'open', version: 1, tags: [], unread: 1,
      messages: [{ id: 'mcp-message-' + sequence, kind: 'customer', text: 'Como está este canal?', createdAt: now }], updatedAt: now, ...extra };
    tenant.conversations.push(current); return current;
  });
  const claim = async (current, user) => {
    const result = await request(`${path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie, body: { owner: 'human', version: current.version } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  };
  const createInternal = async (id = tenantId) => {
    const result = await request(`/api/tenants/${id}/mcp/servers`, { method: 'POST', cookie: owner.cookie, body: { name: 'Elozi interna QA', kind: 'internal', enabled: true } });
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.server || result.data;
  };
  const discover = async (server, id = tenantId) => {
    const result = await request(`/api/tenants/${id}/mcp/servers/${server.id}/discover`, { method: 'POST', cookie: owner.cookie, body: { version: server.version } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.server || result.data;
  };
  const grantBody = server => ({ serverId: server.id, toolName: server.tools[0].name, toolHash: server.tools[0].hash, serverVersion: server.version });
  const configure = async (names = null) => {
    const server = await discover(await createInternal());
    const current = await request(`${path}/agents/${agentId}/mcp-grants`, { cookie: owner.cookie });
    assert.equal(current.status, 200);
    const grants = names ? names.map(name => { const tool = server.tools.find(item => item.name === name); return { serverId: server.id, toolName: tool.name, toolHash: tool.hash, serverVersion: server.version }; }) : [grantBody(server)];
    const result = await request(`${path}/agents/${agentId}/mcp-grants`, { method: 'PUT', cookie: owner.cookie, body: { version: current.data.version, grants } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return server;
  };
  const queue = (current, user, extra = {}) => request(`${path}/conversations/${current.id}/run`, { method: 'POST', cookie: user.cookie,
    body: { version: current.version, agentId, ...extra } });
  const runs = (id, user = owner) => request(`${path}/conversations/${id}/runs`, { cookie: user.cookie });
  const waitRun = async (id, runId, user = owner, expected = run => !['running', 'tool_running'].includes(run.state)) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await runs(id, user); assert.equal(result.status, 200, JSON.stringify(result.data));
      const run = result.data.runs.find(item => item.id === runId); if (run && expected(run)) return run;
      await settle();
    }
    assert.fail('Execução MCP sintética não alcançou o estado esperado.');
  };
  const waiting = async (current, user, extra = {}) => {
    const accepted = await queue(current, user, extra); assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
    const run = await waitRun(current.id, accepted.data.id, user); assert.equal(run.state, 'waiting_approval'); return run;
  };
  const decision = (run, user, verb = 'approve', extra = {}) => request(`${path}/runs/${run.id}/tool/${verb}`, { method: 'POST', cookie: user.cookie,
    body: { version: run.version, proposalId: run.toolProposal.id, ...extra } });
  return { app, request, owner, actor, tenantId, path, channelId, hiddenChannelId, agentId, providerCalls, toolCalls, toolGate,
    seed, member, state, conversation, claim, createInternal, discover, grantBody, configure, queue, runs, waitRun, waiting, decision };
}

test('MCP HTTP ativa servidor interno explicitamente e descobre catálogo pelo SDK sem executar ferramenta', async t => {
  const c = await fixture(t);
  const initial = await c.request(`${c.path}/mcp/servers`, { cookie: c.owner.cookie });
  assert.equal(initial.status, 200); assert.deepEqual(initial.data.servers, []); assert.equal(initial.data.supportedProtocol, '2025-11-25');
  const saved = await c.createInternal(); assert.equal(saved.id, 'elozi-internal'); assert.equal(saved.kind, 'internal'); assert.equal(saved.version, 1); assert.deepEqual(saved.tools, []);
  const checked = await c.discover(saved); assert.equal(checked.state, 'verified'); assert.ok(checked.checkedAt); assert.equal(checked.tools.length, 5);
  assert.deepEqual(new Set(checked.tools.map(tool => tool.name)), new Set(['elozi_channel_status', 'elozi_attendance_status', 'elozi_knowledge_search', 'elozi_contact_profile', 'elozi_conversation_history']));
  for (const tool of checked.tools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.match(tool.hash, /^[a-f0-9]{64}$/); assert.equal(tool.readOnly, true); }
  const repeated = await c.discover(checked); assert.equal(repeated.version, checked.version); assert.deepEqual(repeated.tools, checked.tools);
  assert.equal((await c.request(`${c.path}/mcp/servers`, { method: 'POST', cookie: c.owner.cookie, body: { name: 'Duplicado', kind: 'internal', enabled: true } })).status, 409);
  assert.equal((await c.request(`${c.path}/mcp/servers`, { method: 'POST', cookie: c.owner.cookie, body: { name: 'Interno com credencial indevida', kind: 'internal', enabled: true, token: 'synthetic-forbidden-internal-token' } })).status, 400);
  assert.equal(c.providerCalls.length, 0); assert.equal(c.toolCalls.length, 0);
});

test('MCP HTTP aplica RBAC ao catálogo e concessões e isola servidores com ID interno coincidente por empresa', async t => {
  const c = await fixture(t), server = await c.configure(), user = await c.member();
  const serverRoute = `${c.path}/mcp/servers`, grantsRoute = `${c.path}/agents/${c.agentId}/mcp-grants`;
  assert.equal((await c.request(serverRoute)).status, 401);
  for (const [route, method, body] of [[serverRoute, 'GET'], [serverRoute, 'POST', { name: 'Negado', kind: 'internal', enabled: true }],
    [`${serverRoute}/${server.id}`, 'PATCH', { version: server.version, enabled: false }], [`${serverRoute}/${server.id}/discover`, 'POST', { version: server.version }],
    [grantsRoute, 'GET'], [grantsRoute, 'PUT', { version: 2, grants: [] }]]) {
    assert.equal((await c.request(route, { method, cookie: user.cookie, body })).status, 403, `${method} ${route}`);
  }
  const operatorTenant = await c.request(c.path, { cookie: user.cookie }); assert.equal(operatorTenant.status, 200);
  assert.equal(Object.hasOwn(operatorTenant.data, 'mcpServers'), false, 'O painel do operador não recebe configuração de servidores.');
  assert.equal((await c.request(serverRoute, { cookie: c.owner.cookie, workspace: 'foreign-workspace' })).status, 403);
  const another = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Empresa MCP isolada', segment: 'QA' } });
  assert.equal(another.status, 201); c.seed(another.data.id);
  const otherPath = `/api/tenants/${another.data.id}`;
  const empty = await c.request(`${otherPath}/mcp/servers`, { cookie: c.owner.cookie }); assert.deepEqual(empty.data.servers, []);
  assert.equal((await c.request(`${otherPath}/mcp/servers/${server.id}/discover`, { method: 'POST', cookie: c.owner.cookie, body: { version: server.version } })).status, 404);
  assert.equal((await c.request(`${otherPath}/agents/${c.agentId}/mcp-grants`, { method: 'PUT', cookie: c.owner.cookie, body: { version: 1, grants: [c.grantBody(server)] } })).status, 409);
  assert.equal((await c.request(`${otherPath}/mcp/servers`, { cookie: user.cookie })).status, 403);
  const otherServer = await c.createInternal(another.data.id); assert.equal(otherServer.id, server.id); assert.deepEqual(otherServer.tools, []);
  assert.equal(c.state().mcpServers[0].tools.length, 5); assert.deepEqual(c.state(another.data.id).mcpServers[0].tools, []);
  assert.equal(c.toolCalls.length, 0);
});

test('MCP HTTP exige snapshot atual para concessões e invalida proposta quando o servidor muda', async t => {
  const c = await fixture(t), server = await c.configure(), route = `${c.path}/agents/${c.agentId}/mcp-grants`;
  const granted = await c.request(route, { cookie: c.owner.cookie }); assert.equal(granted.data.version, 2); assert.deepEqual(granted.data.grants, [c.grantBody(server)]);
  for (const invalid of [{ ...c.grantBody(server), toolHash: '0'.repeat(64) }, { ...c.grantBody(server), serverVersion: server.version + 1 },
    { ...c.grantBody(server), toolName: 'tool_not_discovered' }]) {
    assert.equal((await c.request(route, { method: 'PUT', cookie: c.owner.cookie, body: { version: 2, grants: [invalid] } })).status, 409);
  }
  assert.equal((await c.request(route, { method: 'PUT', cookie: c.owner.cookie, body: { version: 1, grants: [] } })).status, 409);
  assert.equal((await c.request(route, { method: 'PUT', cookie: c.owner.cookie, body: { version: 2, grants: [{ ...c.grantBody(server), approved: true }] } })).status, 400);
  assert.equal(c.state().agents[0].version, 2); assert.deepEqual(c.state().agents[0].mcpGrants, granted.data.grants);
  const user = await c.member(), current = await c.claim(c.conversation(), user), run = await c.waiting(current, user);
  const snapshot = c.state().runs.find(item => item.id === run.id).toolSnapshot;
  assert.equal(snapshot.length, 1); assert.equal(snapshot[0].toolHash, server.tools[0].hash); assert.equal(snapshot[0].serverVersion, server.version);
  const changed = await c.request(`${c.path}/mcp/servers/${server.id}`, { method: 'PATCH', cookie: c.owner.cookie, body: { version: server.version, name: 'Servidor revisado QA' } });
  assert.equal(changed.status, 200);
  const invalidated = await c.waitRun(current.id, run.id, user); assert.equal(invalidated.state, 'invalidated'); assert.equal(invalidated.draft, null);
  assert.equal((await c.decision(run, user)).status, 409); assert.equal(c.toolCalls.length, 0);
  assert.equal((await c.queue(current, user)).status, 409, 'Concessões antigas não podem iniciar outra execução.');
});

test('MCP HTTP mantém proposta sem execução e approve CAS idempotente faz uma única tools/call e produz rascunho', async t => {
  const c = await fixture(t, { holdToolResponse: true }), server = await c.configure(), user = await c.member();
  c.app.store.mutate(c.actor,c.tenantId,'Conexão Telegram sintética ativa',state=>{state.channels.find(item=>item.id===c.channelId).transport='telegram-bot';});
  c.app.telegram.entries.set(c.channelId,{tenantId:c.tenantId,state:'connected',abort:new AbortController()});
  const current = await c.claim(c.conversation(), user), run = await c.waiting(current, user, { instruction: 'Consulte o canal desta conversa.' });
  assert.equal(c.providerCalls.length, 1); assert.equal(c.toolCalls.length, 0); assert.equal(run.draft, null); assert.equal(run.version, 2);
  assert.equal(run.toolProposal.toolName, server.tools[0].name); assert.deepEqual(run.toolProposal.arguments, {}); assert.equal(run.toolProposal.readOnly, true);
  assert.equal(c.providerCalls[0].tools.length, 1); assert.deepEqual(c.providerCalls[0].tools[0].function.parameters, server.tools[0].inputSchema);
  assert.equal((await c.queue(current, user)).status, 409, 'Outra execução não pode atravessar a aprovação pendente.');
  assert.equal((await c.decision(run, user, 'approve', { version: run.version - 1 })).status, 409);
  assert.equal((await c.decision(run, user, 'approve', { proposalId: 'different-proposal' })).status, 409);
  assert.equal((await c.decision(run, user, 'approve', { arguments: { channelId: c.hiddenChannelId } })).status, 400);
  assert.equal(c.toolCalls.length, 0);
  const approved = await c.decision(run, user); assert.equal(approved.status, 202); assert.equal(approved.data.id, run.id);
  const inFlight = await c.waitRun(current.id, run.id, user, value => value.state === 'tool_running' && value.toolReceipt?.state === 'in_flight');
  assert.equal(inFlight.toolReceipt.approvedUserId, user.id);
  const repeated = await c.decision(run, user); assert.equal(repeated.status, 202); assert.equal(repeated.data.id, run.id); assert.equal(repeated.data.state, 'tool_running');
  assert.equal((await c.queue(current, user)).status, 409, 'Outra execução não pode atravessar a ferramenta em execução.');
  c.toolGate.resolve();
  const draft = await c.waitRun(current.id, run.id, user, value => value.state === 'draft');
  assert.equal(draft.draft, 'Canal consultado.'); assert.equal(draft.toolReceipt.state, 'completed'); assert.equal(c.toolCalls.length, 1);
  assert.equal(draft.toolReceipt.result.structuredContent.state,'connected','O operador responsável pode consultar a conexão viva sem acesso administrativo ao gateway.');
  assert.deepEqual(c.toolCalls[0], { tenantId: c.tenantId, serverId: server.id, params: { name: server.tools[0].name, arguments: {} } });
  assert.match(JSON.stringify(draft.toolReceipt.result), /Canal sintético MCP/); assert.doesNotMatch(JSON.stringify(draft.toolReceipt.result), /Canal restrito MCP/);
  assert.equal(c.providerCalls.length, 2); assert.equal(c.providerCalls[1].tools.length, 0);
  const toolMessage = c.providerCalls[1].messages.at(-1); assert.equal(toolMessage.role, 'tool'); assert.equal(toolMessage.tool_call_id, 'call_one');
  assert.deepEqual(JSON.parse(toolMessage.content), draft.toolReceipt.result);
  const afterDraft = await c.decision(run, user); assert.equal(afterDraft.status, 202); assert.equal(afterDraft.data.state, 'draft'); assert.equal(c.toolCalls.length, 1);
  const saved = c.state().conversations.find(item => item.id === current.id);
  assert.equal(saved.version, current.version); assert.equal(saved.assignedUserId, user.id); assert.deepEqual(saved.messages, current.messages);
});

test('MCP HTTP recusa ferramenta sem executar nem continuar o provedor e permite repetir a mesma recusa', async t => {
  const c = await fixture(t); await c.configure(); const user = await c.member(), current = await c.claim(c.conversation(), user), run = await c.waiting(current, user);
  const rejected = await c.decision(run, user, 'reject'); assert.equal(rejected.status, 200); assert.equal(rejected.data.state, 'rejected'); assert.equal(rejected.data.draft, null);
  assert.equal(rejected.data.toolReceipt.rejectedUserId, user.id);
  const repeated = await c.decision(run, user, 'reject'); assert.equal(repeated.status, 200); assert.equal(repeated.data.state, 'rejected');
  assert.equal((await c.decision(run, user)).status, 409); assert.equal(c.toolCalls.length, 0); assert.equal(c.providerCalls.length, 1);
});

test('MCP HTTP rejeita argumentos do provedor fora do schema e configuração de ferramenta enviada pelo cliente', async t => {
  const c = await fixture(t, { providerCall: context => proposal(context, { channelId: 'channel-from-another-company' }) });
  await c.configure(); const user = await c.member(), current = await c.claim(c.conversation(), user);
  const forged = await c.queue(current, user, { toolProposal: { toolName: 'elozi_channel_status', arguments: {} }, approved: true });
  assert.equal(forged.status, 400); assert.equal(c.providerCalls.length, 0);
  const accepted = await c.queue(current, user); assert.equal(accepted.status, 202);
  const failed = await c.waitRun(current.id, accepted.data.id, user); assert.equal(failed.state, 'failed'); assert.equal(failed.draft, null); assert.equal(failed.toolProposal, undefined);
  assert.equal(c.toolCalls.length, 0); assert.deepEqual(c.state().conversations.find(item => item.id === current.id).messages, current.messages);
});

test('MCP HTTP exige cookie vigente, responsável e escopo antes de aprovar; handoff bloqueia proposta anterior', async t => {
  const c = await fixture(t); await c.configure();
  const user = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.channelId] } } }), other = await c.member();
  const hidden = c.conversation({ channelId: c.hiddenChannelId, owner: 'human', assignedUserId: user.id });
  assert.equal((await c.queue(hidden, user)).status, 403); assert.equal(c.providerCalls.length, 0);
  const current = await c.claim(c.conversation(), user), run = await c.waiting(current, user);
  const route = `${c.path}/runs/${run.id}/tool/approve`, input = { version: run.version, proposalId: run.toolProposal.id };
  assert.equal((await c.request(route, { method: 'POST', body: input })).status, 401);
  assert.equal((await c.decision(run, other)).status, 409); assert.equal((await c.decision(run, c.owner)).status, 409);
  assert.equal((await c.request(route, { method: 'POST', cookie: user.cookie, workspace: 'foreign-workspace', body: input })).status, 403);
  const another = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Empresa de outro run MCP', segment: 'QA' } });
  assert.equal((await c.request(`/api/tenants/${another.data.id}/runs/${run.id}/tool/approve`, { method: 'POST', cookie: c.owner.cookie, body: input })).status, 404);
  const handoff = await c.request(`${c.path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie, body: { version: current.version, owner: 'queue', reason: 'Handoff sintético MCP' } });
  assert.equal(handoff.status, 200);
  const invalidated = await c.waitRun(current.id, run.id); assert.equal(invalidated.state, 'invalidated'); assert.equal(invalidated.draft, null);
  assert.equal((await c.decision(run, user)).status, 409); assert.equal((await c.decision(run, user, 'reject')).status, 409);
  await c.claim(handoff.data, other); assert.equal((await c.decision(run, other)).status, 409);
  const second = await c.claim(c.conversation(), user), loggedRun = await c.waiting(second, user);
  assert.equal((await c.request('/api/auth/logout', { method: 'POST', cookie: user.cookie, body: {} })).status, 200);
  assert.equal((await c.decision(loggedRun, user)).status, 401); assert.equal(c.toolCalls.length, 0);
});

test('MCP HTTP handoff durante tools/call preserva recibo desconhecido e descarta conclusão tardia sem repetir', async t => {
  const c = await fixture(t, { holdToolResponse: true }); await c.configure();
  const user = await c.member(), current = await c.claim(c.conversation(), user), run = await c.waiting(current, user);
  assert.equal((await c.decision(run, user)).status, 202);
  await c.waitRun(current.id, run.id, user, value => value.state === 'tool_running' && value.toolReceipt?.state === 'in_flight');
  const handoff = await c.request(`${c.path}/conversations/${current.id}/owner`, { method: 'POST', cookie: user.cookie, body: { version: current.version, owner: 'queue', reason: 'Handoff com consulta em voo' } });
  assert.equal(handoff.status, 200);
  c.toolGate.resolve();
  const unknown = await c.waitRun(current.id, run.id); assert.equal(unknown.state, 'tool_unknown'); assert.equal(unknown.toolReceipt.state, 'unknown'); assert.equal(unknown.draft, null);
  assert.match(unknown.reason, /não repita automaticamente/i); assert.equal(c.toolCalls.length, 1); assert.equal(c.providerCalls.length, 1);
  assert.equal((await c.decision(run, user)).status, 409);
  await settle(); assert.equal(c.toolCalls.length, 1);
  const messages = c.state().conversations.find(item => item.id === current.id).messages;
  assert.equal(messages.filter(message => message.kind === 'customer').length, 1);
  assert.equal(messages.filter(message => ['human', 'agent'].includes(message.kind)).length, 0);
});

const toolTitles = { elozi_channel_status: 'Status do canal', elozi_knowledge_search: 'Busca no conhecimento', elozi_contact_profile: 'Perfil do contato', elozi_conversation_history: 'Histórico anterior do atendimento' };
function lookup(context, name, args = {}, id = 'call_lookup') {
  const alias = context.tools.find(tool => tool.function.description.startsWith(toolTitles[name] + '.'))?.function.name;
  assert.ok(alias, 'A ferramenta concedida deve estar no catálogo desta rodada: ' + name);
  return { toolCall: { id, name: alias, arguments: args }, assistant: { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name: alias, arguments: JSON.stringify(args) } }] } };
}
const observed = message => JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
const lookedUp = context => String(context.messages.at(-1)?.content).startsWith('Resultados de consultas');

test('MCP HTTP consultas internas automáticas devolvem só conhecimento, contato e histórico desta empresa', async t => {
  const steps = [['elozi_knowledge_search', { query: 'garantia' }], ['elozi_contact_profile', {}], ['elozi_conversation_history', { limit: 40 }]];
  let step = 0;
  const c = await fixture(t, { policy: null, providerCall: context => context.tools.length && step < steps.length
    ? lookup(context, steps[step][0], steps[step][1], 'call_scope_' + step++) : { text: 'Rascunho com contexto consultado.' } });
  const date = new Date().toISOString();
  const foreign = await c.request('/api/tenants', { method: 'POST', cookie: c.owner.cookie, body: { name: 'Empresa vizinha MCP', segment: 'QA' } });
  assert.equal(foreign.status, 201); c.seed(foreign.data.id);
  c.app.store.mutate(c.actor, foreign.data.id, 'Fixture vizinha com identificadores coincidentes', tenant => {
    tenant.contacts = [{ id: 'contact-shared', name: 'Contato vizinho', phone: '5511988887777', email: 'vizinho@cliente.invalid', notes: 'nota-da-outra-empresa', tags: ['vizinho'], identities: [], version: 1, createdAt: date, updatedAt: date }];
    tenant.conversations.push({ id: 'foreign-conversation', channelId: c.channelId, contact: 'Contato vizinho', contactId: 'contact-shared', owner: 'queue', status: 'open', version: 1, tags: [],
      messages: [{ id: 'foreign-message', kind: 'customer', text: 'mensagem-da-outra-empresa', createdAt: date }], updatedAt: date });
  });
  const foreignSource = c.app.knowledge.create(c.actor, foreign.data.id, { title: 'Garantia vizinha', category: 'Suporte', content: 'segredo-da-outra-empresa sobre garantia.' });
  c.app.knowledge.publish(c.actor, foreign.data.id, foreignSource.id, { version: foreignSource.version });
  const source = c.app.knowledge.create(c.actor, c.tenantId, { title: 'Política de garantia', category: 'Suporte', content: 'A garantia cobre defeitos de fabricação por 12 meses.' });
  const published = c.app.knowledge.publish(c.actor, c.tenantId, source.id, { version: source.version });
  c.app.knowledge.setGrants(c.actor, c.tenantId, c.agentId, { version: 1, grants: [{ sourceId: source.id, publicationVersion: published.published.version, publicationHash: published.published.hash }] });
  await c.configure(steps.map(([name]) => name));
  c.app.store.mutate(c.actor, c.tenantId, 'Contato sintético vinculado', tenant => {
    tenant.contacts = [{ id: 'contact-shared', name: 'Cadastro sintético', phone: '5511999990000', email: 'privado@cliente.invalid', notes: 'anotação privada', tags: ['vip'], identities: [], version: 1, createdAt: date, updatedAt: date }];
  });
  const history = Array.from({ length: 25 }, (_, index) => ({ id: 'scope-message-' + index, kind: index % 2 ? 'human' : 'customer', text: 'Mensagem sintética ' + index, createdAt: date }));
  history.splice(2, 0, { id: 'scope-note', kind: 'internal', text: 'nota-interna-secreta', createdAt: date });
  const user = await c.member({ scopeRules: { [c.tenantId]: { channelIds: [c.channelId] } } });
  c.conversation({ contactId: 'contact-shared' }); c.conversation({ channelId: c.hiddenChannelId, contactId: 'contact-shared' });
  const current = await c.claim(c.conversation({ contactId: 'contact-shared', tags: ['retorno'], messages: history }), user);
  const accepted = await c.queue(current, user); assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
  const run = await c.waitRun(current.id, accepted.data.id, user);
  assert.equal(run.state, 'draft', run.reason); assert.equal(run.draft, 'Rascunho com contexto consultado.');
  assert.deepEqual(run.toolSteps.map(item => [item.toolName, item.autoApproved]), steps.map(([name]) => [name, true]));
  assert.equal(run.toolReceipt.autoApproved, true); assert.equal(run.toolReceipt.approvedUserId, null); assert.equal(c.toolCalls.length, 3);
  assert.deepEqual(c.providerCalls.map(context => context.tools.length), [3, 3, 3, 0]);
  const knowledge = observed(c.providerCalls[1].messages.at(-1))[0].data;
  assert.equal(knowledge.state, 'matched'); assert.deepEqual(knowledge.results.map(item => item.title), ['Política de garantia']);
  assert.match(knowledge.results[0].excerpt, /12 meses/);
  const contact = observed(c.providerCalls[2].messages.at(-1))[1].data;
  assert.equal(contact.displayName, 'Contato sintético MCP'); assert.equal(contact.channelKind, 'telegram'); assert.equal(contact.linkedContact, true);
  assert.deepEqual(contact.tags, ['retorno'], 'Sem contacts.read, as etiquetas do cadastro não aparecem.');
  assert.equal(contact.previousConversations, 1, 'Conta só atendimentos legíveis da mesma empresa.');
  const final = c.providerCalls[3], older = JSON.parse(final.messages.at(-1).content).structuredContent;
  assert.equal(final.messages.at(-1).role, 'tool'); assert.equal(final.messages.at(-2).tool_calls[0].id, 'call_scope_2');
  assert.deepEqual(older.messages.map(item => item.id), ['scope-message-0', 'scope-message-1', 'scope-message-2', 'scope-message-3', 'scope-message-4']);
  assert.equal(older.hasMore, false);
  const exposed = JSON.stringify({ calls: c.providerCalls.map(context => context.messages), runs: (await c.runs(current.id, user)).data });
  for (const marker of ['segredo-da-outra-empresa', 'mensagem-da-outra-empresa', 'nota-da-outra-empresa', '5511988887777', '5511999990000', 'privado@cliente.invalid', 'anotação privada', 'nota-interna-secreta', '"vip"', 'Cadastro sintético']) {
    assert.equal(exposed.includes(marker), false, marker);
  }
  const saved = c.state().conversations.find(item => item.id === current.id);
  assert.equal(saved.version, current.version); assert.equal(saved.assignedUserId, user.id);
  assert.equal(saved.messages.filter(item => item.kind === 'human').length, 12); assert.equal(saved.messages.filter(item => item.kind === 'agent').length, 0);
});

test('MCP HTTP consulta automática com referência alheia falha fechada e permite nova tentativa', async t => {
  let attempt = 0;
  const c = await fixture(t, { policy: null, providerCall: context => attempt++ === 0 ? lookup(context, 'elozi_conversation_history', { before: 'foreign-message' }, 'call_foreign') : { text: 'Rascunho após nova tentativa.' } });
  await c.configure(['elozi_conversation_history']);
  const user = await c.member(), current = await c.claim(c.conversation(), user);
  const accepted = await c.queue(current, user); assert.equal(accepted.status, 202);
  const failed = await c.waitRun(current.id, accepted.data.id, user);
  assert.equal(failed.state, 'failed'); assert.equal(failed.draft, null); assert.equal(failed.toolReceipt.autoApproved, true);
  assert.equal(failed.toolReceipt.state, 'failed'); assert.match(failed.reason, /consulta automática não foi concluída/);
  assert.equal(c.toolCalls.length, 1); assert.equal(c.providerCalls.length, 1);
  const retry = await c.queue(current, user); assert.equal(retry.status, 202, 'Uma consulta somente leitura que falhou não bloqueia nova tentativa.');
  const draft = await c.waitRun(current.id, retry.data.id, user); assert.equal(draft.state, 'draft'); assert.equal(draft.draft, 'Rascunho após nova tentativa.');
});

test('MCP HTTP rascunho pedido por serviço executa consulta automática com a leitura do próprio serviço', async t => {
  const c = await fixture(t, { policy: null, providerCall: context => lookedUp(context) ? { text: 'Rascunho do serviço com consulta.' } : proposal(context) });
  await c.configure();
  const created = c.app.servicePrincipals.create(c.actor, c.tenantId, { name: 'Hermes serviço QA', agentId: c.agentId, capabilities: ['conversation.read', 'reply.draft'], channelIds: [c.channelId], ttlHours: 1 });
  const serviceActor = c.app.servicePrincipals.authenticate('Bearer ' + created.token), current = c.conversation();
  const result = await c.app.serviceApi.draft(serviceActor, { requestId: 'service_auto_lookup_001', conversationId: current.id, version: current.version });
  assert.equal(result.run.state, 'draft'); assert.equal(result.run.draft, 'Rascunho do serviço com consulta.');
  assert.equal(result.receipt.state, 'confirmed'); assert.equal(result.humanApprovalRequired, true);
  const persisted = c.state().runs.find(run => run.id === result.run.id);
  assert.equal(persisted.serviceId, created.principal.id); assert.equal(persisted.toolReceipt.autoApproved, true); assert.equal(persisted.toolReceipt.state, 'completed');
  assert.equal(persisted.toolReceipt.result.structuredContent.id, c.channelId); assert.equal(c.toolCalls.length, 1);
  const saved = c.state().conversations.find(item => item.id === current.id);
  assert.equal(saved.owner, 'queue', 'O serviço consulta sem assumir o atendimento.'); assert.equal(saved.version, current.version);
  const replay = await c.app.serviceApi.draft(serviceActor, { requestId: 'service_auto_lookup_001', conversationId: current.id, version: current.version });
  assert.equal(replay.run.id, result.run.id); assert.equal(c.toolCalls.length, 1); assert.equal(c.providerCalls.length, 2);
});

test('MCP HTTP concessões gravam política de ferramentas validada somente pelo administrador', async t => {
  const c = await fixture(t, { policy: null }), server = await c.configure(), route = `${c.path}/agents/${c.agentId}/mcp-grants`, user = await c.member();
  const before = await c.request(route, { cookie: c.owner.cookie }); assert.equal(before.status, 200); assert.equal(before.data.toolPolicy, 'auto_readonly');
  const body = toolPolicy => ({ version: before.data.version, grants: [c.grantBody(server)], toolPolicy });
  assert.equal((await c.request(route, { method: 'PUT', cookie: c.owner.cookie, body: body('always') })).status, 400);
  assert.equal((await c.request(route, { method: 'PUT', cookie: user.cookie, body: body('approve_all') })).status, 403);
  assert.equal(c.state().agents[0].toolPolicy, undefined); assert.equal(c.state().agents[0].version, before.data.version);
  const saved = await c.request(route, { method: 'PUT', cookie: c.owner.cookie, body: body('approve_all') });
  assert.equal(saved.status, 200); assert.equal(saved.data.toolPolicy, 'approve_all'); assert.equal(saved.data.version, before.data.version + 1);
  assert.equal(c.state().agents[0].toolPolicy, 'approve_all');
  const current = await c.claim(c.conversation(), user), run = await c.waiting(current, user);
  assert.equal(run.toolPolicy, 'approve_all'); assert.equal(run.toolProposal.readOnly, true); assert.equal(c.toolCalls.length, 0);
});
