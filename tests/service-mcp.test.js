import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { createServiceMcpHandler } from '../src/service-mcp.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const object = result => result.structuredContent;
const invalidParams = error => error.code === ErrorCode.InvalidParams;
async function fixture(t, { provider = async () => 'Rascunho sintético para revisão humana', capabilities, principal = {}, adapter = {}, options = {} } = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  const admin = auth.actor(auth.insertUser({ username: 'service.mcp.owner', name: 'Administrador sintético MCP' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Empresa MCP sintética', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture MCP', state => {
    state.agents = [{ id: 'hermes', name: 'Hermes sintético', provider: 'hermes', mode: 'copilot', configured: true, version: 1, description: 'Prepare uma resposta para revisão humana.', tools: [], endpoint: 'http://never-call-provider.invalid', ...adapter }];
    state.channels = [{ id: 'wa', name: 'Canal permitido', kind: 'whatsapp_qr', state: 'planned' }, { id: 'other', name: 'Canal negado', kind: 'telegram', state: 'planned' }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Vendas', active: true }];
    state.conversations = [{ id: 'conversation', contact: 'Cliente sintético', channelId: 'wa', departmentId: 'support', version: 1, status: 'open', owner: 'human', assignedUserId: admin.userId, participants: [], messages: [
      { id: 'customer', kind: 'customer', text: 'Mensagem pública sintética', attachments: [{ id: 'media', kind: 'image', name: 'qa.png', mime: 'image/png', size: 4, url: 'http://never-call-media.invalid', preview: 'private-preview' }] },
      { id: 'note', kind: 'internal', text: 'private-internal-note' }
    ] }, { id: 'forbidden', contact: 'Outro cliente', channelId: 'other', departmentId: 'sales', version: 1, status: 'open', owner: 'queue', messages: [] }];
  });
  let runtime; const calls = [];
  const principals = new ServicePrincipals(store, auth, { onChange: id => runtime?.invalidateInitiator(admin, tenant.id, { serviceId: id }) });
  runtime = new AgentRuntime(store, { validateInitiator: run => !run.serviceId || principals.runCurrent(run), providerCall: async context => { calls.push(context); return provider(context); } });
  const api = new ServiceApi(store, principals, runtime), created = principals.create(admin, tenant.id, {
    name: 'Agente externo QA', agentId: 'hermes', capabilities: capabilities || ['conversation.read', 'reply.draft', 'handoff.request'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 20, dailyBudgetMicros: 4000, estimatedRequestMicros: 400, maxConcurrent: 2, ttlHours: 24, ...principal
  });
  const handler = createServiceMcpHandler(api, options), errors = [], clients = [], responses = [];
  const server = createServer((req, res) => { handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(error => { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, url = new URL(options.path || '/api/agent/mcp', base);
  async function connect(token = created.token) {
    const client = new Client({ name: 'elozi-synthetic-client', version: '1.0.0' }); clients.push(client);
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: async (target, init) => {
      assert.equal(new URL(target).origin, base, 'O teste não autoriza transporte fora do HTTP sintético');
      const response = await fetch(target, init); responses.push({ method: init?.method || 'GET', status: response.status, type: response.headers.get('content-type'), session: response.headers.get('mcp-session-id') }); return response;
    } });
    await client.connect(transport); return { client, transport };
  }
  t.after(async () => { await Promise.all(clients.map(client => client.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); assert.deepEqual(errors, []); });
  const connected = await connect();
  const raw = (body, { method = 'POST', headers = {}, token = created.token, suffix = '' } = {}) => fetch(url.href + suffix, { method, headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const input = extra => ({ requestId: 'synthetic_request_001', conversationId: 'conversation', version: 1, ...extra });
  const assertNoSend = () => { assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(store.tenant(admin, tenant.id).conversations[0].messages.length, 2); };
  return { ...connected, connect, raw, url, input, store, auth, admin, tenant, principals, api, runtime, created, calls, responses, assertNoSend,
    quota: () => principals.list(admin, tenant.id).principals[0].usage,
    receipts: () => principals.receipts(admin, tenant.id, created.principal.id).receipts };
}

test('cliente SDK real inicializa MCP stateless e lista somente ferramentas concedidas', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), ['elozi_me', 'elozi_get_receipt', 'elozi_read_conversation', 'elozi_list_conversations', 'elozi_search_conversations', 'elozi_read_conversation_history', 'elozi_list_groups', 'elozi_read_group_history']);
  assert.deepEqual(f.client.getServerCapabilities(), { tools: {} });
  const result = object(await f.client.callTool({ name: 'elozi_me', arguments: {} }));
  assert.equal(result.principal.tenantId, f.tenant.id); assert.equal(result.principal.id, f.created.principal.id); assert.equal(result.humanApprovalRequired, false);
  assert.equal(result.apiVersion, 2); assert.equal(result.agent.mode, 'read-only'); assert.equal(result.agent.adapterMode, 'copilot');
  assert.equal(JSON.stringify(result).includes(f.created.token), false); assert.equal(result.principal.userId, undefined); assert.equal(result.principal.role, undefined);
  assert.ok(f.responses.filter(response => response.method === 'POST' && response.status === 200).every(response => response.type.includes('application/json') && response.session === null));
  assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('recibo MCP reconcilia a requestId original sem reexecutar nem consumir cota', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  const requestId = 'receipt_reconciliation_001';
  const first = object(await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId, conversationId: 'conversation' } }));
  const result = object(await f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId } }));
  assert.equal(result.tenantId, f.tenant.id);
  assert.equal(result.receipt.id, first.receipt);
  assert.equal(result.receipt.requestId, requestId);
  assert.equal(result.receipt.state, 'confirmed');
  assert.equal(f.quota().requests, 1);
  for (const value of [f.created.token, 'private-internal-note', 'private-preview']) assert.equal(JSON.stringify(result).includes(value), false);
  f.store.db.prepare("UPDATE service_principal_receipts SET state='unknown',stale=1 WHERE id=?").run(first.receipt);
  const unknown = object(await f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId } }));
  assert.equal(unknown.receipt.state, 'unknown');
  assert.equal(unknown.receipt.stale, true);
  assert.equal(f.quota().requests, 1);
  assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('recibo MCP recusa outra identidade, requestId inválida e acesso revogado', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  const requestId = 'receipt_private_owner_001';
  await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId, conversationId: 'conversation' } });
  const other = f.principals.create(f.admin, f.tenant.id, { name: 'Outro acesso QA', agentId: 'hermes', capabilities: ['conversation.read'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 20, maxConcurrent: 2, ttlHours: 24 });
  const otherClient = (await f.connect(other.token)).client;
  const denied = object(await otherClient.callTool({ name: 'elozi_get_receipt', arguments: { requestId } }));
  assert.equal(denied.error.status, 404);
  await assert.rejects(f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId: 'short' } }), invalidParams);
  await assert.rejects(f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId, principalId: other.principal.id } }), invalidParams);
  const missing = object(await f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId: 'receipt_missing_001' } }));
  assert.equal(missing.error.status, 404);
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  await assert.rejects(f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId } }), error => error.code === 401);
  f.assertNoSend();
});

test('recibo MCP revalida canal atual antes de retornar o resultado', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  const requestId = 'receipt_scope_removed_001';
  await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId, conversationId: 'conversation' } });
  f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, channelIds: ['other'] });
  const denied = object(await f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId } }));
  assert.ok([403, 409].includes(denied.error.status));
  assert.equal(denied.receipt, undefined); f.assertNoSend();
});

test('leitura pelo MCP conserva privacidade, escopo de canal/departamento e recibo idempotente', async t => {
  const f = await fixture(t), args = { requestId: 'synthetic_read_001', conversationId: 'conversation' };
  const first = object(await f.client.callTool({ name: 'elozi_read_conversation', arguments: args })), repeated = object(await f.client.callTool({ name: 'elozi_read_conversation', arguments: args }));
  assert.equal(first.receipt, repeated.receipt); assert.equal(f.quota().requests, 1); assert.equal(first.conversation.messages.length, 1);
  for (const privateValue of ['private-internal-note', 'private-preview', 'never-call-media']) assert.equal(JSON.stringify(first).includes(privateValue), false);
  const denied = await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_read_002', conversationId: 'forbidden' } });
  assert.equal(denied.isError, true); assert.equal(object(denied).error.status, 403); assert.equal(f.quota().requests, 1); f.assertNoSend();
});

test('MCP não aceita senha admin, sessão humana, token na URL ou cookies como autenticação', async t => {
  const f = await fixture(t), body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const config of [{ token: null }, { token: 'human-session-synthetic' }, { token: 'senhaAdmin' }, { token: null, headers: { Cookie: 'mepchat_session=synthetic' } }, { token: null, suffix: '?token=synthetic' }]) {
    const response = await f.raw(body, config); assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /^Bearer/);
  }
  assert.equal((await f.raw(body, { headers: { Cookie: 'mepchat_session=synthetic' } })).status, 200);
  assert.equal((await f.raw(body, { suffix: '?tenantId=forged' })).status, 400); assert.equal(f.quota().requests, 0); f.assertNoSend();
});

test('transporte recusa GET/DELETE, sessões, eventos retomáveis e origens não autorizadas', async t => {
  const f = await fixture(t, { options: { allowedOrigins: ['https://elozi.example'] } }), body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const method of ['GET', 'DELETE']) { const response = await f.raw(null, { method }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST'); }
  for (const headers of [{ 'mcp-session-id': 'synthetic' }, { 'last-event-id': 'synthetic' }]) assert.equal((await f.raw(body, { headers })).status, 400);
  assert.equal((await f.raw(body, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.raw(body, { headers: { Origin: 'https://elozi.example' } })).status, 200);
  assert.equal((await f.raw(body, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.raw(body, { headers: { 'Content-Encoding': 'gzip' } })).status, 415); f.assertNoSend();
});

test('JSON limitado e validação estrita recusam batch, campos desconhecidos e argumentos inválidos', async t => {
  const f = await fixture(t, { options: { maxBodyBytes: 2048 } });
  assert.equal((await f.raw('{')).status, 400);
  assert.equal((await f.raw([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).status, 400);
  assert.equal((await f.raw({ jsonrpc: '2.0', id: 1, method: 'tools/list', tenantId: 'forged' })).status, 400);
  assert.equal((await f.raw({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'elozi_me', tenantId: 'forged' } })).status, 400);
  assert.equal((await f.raw('x'.repeat(2049))).status, 413);
  const chunked = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('x'.repeat(1500))); controller.enqueue(Buffer.from('x'.repeat(1500))); controller.close(); } });
  const overflow = await fetch(f.url, { method: 'POST', headers: { Authorization: `Bearer ${f.created.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: chunked, duplex: 'half' });
  assert.equal(overflow.status, 413, 'O limite é aplicado também sem Content-Length');
  for (const extra of [{ tenantId: 'forged' }, { workspaceId: 'forged' }, { channelId: 'other' }, { userId: f.admin.userId }, { endpoint: 'https://attacker.invalid' }, { version: '1' }, { version: 0 }, { instruction: 'x'.repeat(1001) }, { requestId: 'short' }, { conversationId: '../conversation' }]) {
    await assert.rejects(f.client.callTool({ name: 'elozi_request_draft', arguments: f.input(extra) }), invalidParams);
  }
  await assert.rejects(f.client.callTool({ name: 'elozi_me', arguments: { admin: true } }), invalidParams);
  await assert.rejects(f.client.callTool({ name: 'elozi_send_message', arguments: {} }), invalidParams);
  assert.equal(f.quota().requests, 0); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('capacidade não concedida permanece recusada mesmo quando caller sabe o nome da ferramenta', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  for (const [name, input] of [['elozi_request_draft', f.input()], ['elozi_request_human_support', f.input({ reason: 'Apoio' })]]) {
    const result = await f.client.callTool({ name, arguments: input }); assert.equal(result.isError, true); assert.equal(object(result).error.status, 403);
  }
  assert.equal(f.quota().requests, 0); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('isolamento por empresa não confia nos identificadores do caller nem permite ler outra empresa', async t => {
  const f = await fixture(t), otherTenant = f.store.createTenant(f.admin, { name: 'Outra empresa sintética', segment: 'QA' });
  f.store.mutate(f.admin, otherTenant.id, 'Fixture de isolamento', state => { state.conversations = [{ id: 'only_in_other_company', contact: 'Segredo da outra empresa', messages: [], channelId: 'wa', version: 1, status: 'open' }]; });
  const result = await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_other_001', conversationId: 'only_in_other_company' } });
  assert.equal(result.isError, true); assert.equal(object(result).error.status, 404); assert.equal(JSON.stringify(result).includes('Segredo da outra empresa'), false);
  await assert.rejects(f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_other_002', conversationId: 'only_in_other_company', tenantId: otherTenant.id } }), invalidParams);
  assert.equal(f.quota().requests, 0); f.assertNoSend();
});

test('rascunho Hermes pelo MCP chama runtime real uma vez e mantém a revisão humana sem envio', async t => {
  const f = await fixture(t), first = object(await f.client.callTool({ name: 'elozi_request_draft', arguments: f.input() }));
  const replay = object(await f.client.callTool({ name: 'elozi_request_draft', arguments: f.input() }));
  assert.equal(first.run.state, 'draft'); assert.equal(first.run.draft, 'Rascunho sintético para revisão humana'); assert.equal(first.humanApprovalRequired, true);
  assert.equal(first.run.id, replay.run.id); assert.equal(first.receipt.id, replay.receipt.id); assert.equal(f.calls.length, 1); assert.equal(f.quota().requests, 1);
  assert.equal(f.receipts()[0].result.run.draft, null);
  const conflict = await f.client.callTool({ name: 'elozi_request_draft', arguments: f.input({ instruction: 'Outra instrução' }) }); assert.equal(object(conflict).error.status, 409);
  f.assertNoSend();
});

test('apoio humano pelo MCP gera pedido pendente único, auditado e sem alterar responsável', async t => {
  const f = await fixture(t), args = f.input({ reason: 'Preciso de revisão humana.' });
  const first = object(await f.client.callTool({ name: 'elozi_request_human_support', arguments: args })), replay = object(await f.client.callTool({ name: 'elozi_request_human_support', arguments: args }));
  assert.equal(first.request.state, 'pending'); assert.equal(first.request.id, replay.request.id); assert.equal(first.request.serviceId, f.created.principal.id);
  assert.equal(f.store.tenant(f.admin, f.tenant.id).conversations[0].assignedUserId, f.admin.userId); assert.equal(f.quota().requests, 1); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('revogação e rotação são conferidas em cada POST do cliente SDK já conectado', async t => {
  const f = await fixture(t), rotated = f.principals.rotate(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  await assert.rejects(f.client.listTools(), error => error.code === 401);
  const fresh = await f.connect(rotated.token); assert.equal(object(await fresh.client.callTool({ name: 'elozi_me', arguments: {} })).principal.keyRevision, 2);
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: rotated.principal.revision });
  await assert.rejects(fresh.client.callTool({ name: 'elozi_me', arguments: {} }), error => error.code === 401); assert.equal(f.quota().requests, 0); f.assertNoSend();
});

test('tools/list reflete redução de concessões sem manter sessão ou catálogo antigo', async t => {
  const f = await fixture(t); assert.ok((await f.client.listTools()).tools.some(tool => tool.name === 'elozi_request_draft'));
  f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, capabilities: ['conversation.read'] });
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), ['elozi_me', 'elozi_get_receipt', 'elozi_read_conversation', 'elozi_list_conversations', 'elozi_search_conversations', 'elozi_read_conversation_history', 'elozi_list_groups', 'elozi_read_group_history']);
  const result = await f.client.callTool({ name: 'elozi_request_draft', arguments: f.input() }); assert.equal(object(result).error.status, 403); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('replay concorrente pelo MCP não duplica despacho e respeita limite de simultaneidade', async t => {
  let finish; const f = await fixture(t, { provider: () => new Promise(resolve => { finish = resolve; }), principal: { maxConcurrent: 1 } });
  const pending = f.client.callTool({ name: 'elozi_request_draft', arguments: f.input() });
  while (!finish) await settle();
  const replay = object(await f.client.callTool({ name: 'elozi_request_draft', arguments: f.input() }));
  assert.equal(replay.receipt.state, 'dispatched'); assert.equal(replay.run?.draft ?? null, null);
  const blocked = await f.client.callTool({ name: 'elozi_request_draft', arguments: f.input({ requestId: 'synthetic_concurrent_002' }) });
  assert.equal(object(blocked).error.status, 429); assert.equal(f.quota().requests, 1); assert.equal(f.calls.length, 1);
  finish('Resultado sintético único'); assert.equal(object(await pending).run.draft, 'Resultado sintético único'); f.assertNoSend();
});

test('revogação durante preparação preserva recibo e oculta resultado ao bearer em voo', async t => {
  let finish; const f = await fixture(t, { provider: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.client.callTool({ name: 'elozi_request_draft', arguments: f.input() }); while (!finish) await settle();
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 }); finish('private-revoked-draft');
  const result = await pending; assert.equal(result.isError, true); assert.ok([401, 409].includes(object(result).error.status)); assert.equal(JSON.stringify(result).includes('private-revoked-draft'), false);
  assert.equal(f.calls.length, 1); assert.equal(f.receipts()[0].stale, true); assert.equal(f.receipts()[0].result?.run?.draft ?? null, null); f.assertNoSend();
});

test('cota diária e versão atual são gates da API usados pelo MCP', async t => {
  const f = await fixture(t, { principal: { dailyRequests: 1 } });
  const stale = await f.client.callTool({ name: 'elozi_request_human_support', arguments: f.input({ version: 2, reason: 'Apoio' }) }); assert.equal(object(stale).error.status, 409);
  await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_read_001', conversationId: 'conversation' } });
  const blocked = await f.client.callTool({ name: 'elozi_request_human_support', arguments: f.input({ reason: 'Apoio' }) }); assert.equal(object(blocked).error.status, 429);
  assert.equal(f.quota().requests, 1); assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_handoff_requests').get().n, 0); f.assertNoSend();
});

test('redução de escopo ou mudança do adaptador durante leitura não devolve resultado preparado com prova antiga', async t => {
  for (const change of ['scope', 'adapter']) {
    const f = await fixture(t), read = f.api.read.bind(f.api); let finish;
    f.api.read = async (...args) => { const result = read(...args); await new Promise(resolve => { finish = resolve; }); return result; };
    const pending = f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_read_001', conversationId: 'conversation' } }); while (!finish) await settle();
    if (change === 'scope') f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, channelIds: ['other'] });
    else f.store.mutate(f.admin, f.tenant.id, 'Mudança sintética de adaptador', state => { state.agents[0].version = 2; });
    finish(); const result = await pending;
    assert.equal(result.isError, true); assert.equal(object(result).error.status, 409); assert.equal(JSON.stringify(result).includes('Mensagem pública sintética'), false); f.assertNoSend();
  }
});

test('erros internos do serviço não vazam detalhes no resultado MCP', async t => {
  const f = await fixture(t); f.api.handoff = () => { throw new Error('private-backend-detail'); };
  const result = await f.client.callTool({ name: 'elozi_request_human_support', arguments: f.input({ reason: 'Apoio' }) });
  assert.equal(result.isError, true); assert.equal(object(result).error.status, 500); assert.equal(JSON.stringify(result).includes('private-backend-detail'), false); f.assertNoSend();
});

test('recibo MCP revalida a prova original após espera sem devolver resultado de escopo ou adaptador antigo', async t => {
  for (const change of ['scope', 'adapter', 'revoke']) {
    const f = await fixture(t);
    await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_receipt_race_001', conversationId: 'conversation' } });
    const read = f.api.readReceipt.bind(f.api); let finish;
    f.api.readReceipt = async (...args) => { const result = read(...args); result.receipt.reason = 'private-old-receipt'; await new Promise(resolve => { finish = resolve; }); return result; };
    const pending = f.client.callTool({ name: 'elozi_get_receipt', arguments: { requestId: 'synthetic_receipt_race_001' } }); while (!finish) await settle();
    if (change === 'scope') f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, channelIds: ['other'] });
    else if (change === 'adapter') f.store.mutate(f.admin, f.tenant.id, 'Mudança sintética de adaptador', state => { state.agents[0].version = 2; });
    else f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
    finish(); const result = await pending;
    assert.equal(result.isError, true); assert.ok([401, 409].includes(object(result).error.status)); assert.equal(JSON.stringify(result).includes('private-old-receipt'), false);
    assert.equal(f.quota().requests, 1); f.assertNoSend();
  }
});

test('autorização do domínio é revalidada antes e depois da ferramenta, sem aceitar outro workspace', async t => {
  let allowed = true, checks = 0;
  const f = await fixture(t, { options: { authorizeRequest: (actor, req) => { checks++; assert.equal(actor.kind, 'service'); assert.match(req.url, /^\/api\/agent\/mcp/); return allowed; } } });
  allowed = false; const denied = await f.raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.equal(denied.status, 403); assert.equal(f.quota().requests, 0);
  allowed = true; const before = checks;
  await f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_read_001', conversationId: 'conversation' } }); assert.ok(checks >= before + 3);
  const read = f.api.read.bind(f.api); let finish;
  f.api.read = async (...args) => { const result = read(...args); await new Promise(resolve => { finish = resolve; }); return result; };
  const pending = f.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'synthetic_read_002', conversationId: 'conversation' } }); while (!finish) await settle();
  allowed = false; finish(); const result = await pending;
  assert.equal(result.isError, true); assert.equal(object(result).error.status, 403); assert.equal(JSON.stringify(result).includes('Mensagem pública sintética'), false); f.assertNoSend();
});

test('agente MCP externo apresenta rascunho persistido para revisão humana pelo cliente SDK sem provider ou envio', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read', 'reply.submit'], adapter: { provider: 'mcp' } });
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), ['elozi_me', 'elozi_get_receipt', 'elozi_read_conversation', 'elozi_list_conversations', 'elozi_search_conversations', 'elozi_read_conversation_history', 'elozi_list_groups', 'elozi_read_group_history', 'elozi_submit_draft']);
  const args = f.input({ text: 'Resposta externa sintética para revisão.' });
  const first = object(await f.client.callTool({ name: 'elozi_submit_draft', arguments: args })), replay = object(await f.client.callTool({ name: 'elozi_submit_draft', arguments: args }));
  assert.equal(first.humanApprovalRequired, true); assert.equal(first.run.state, 'draft'); assert.equal(first.run.draft, args.text); assert.equal(first.run.id, replay.run.id); assert.equal(first.receipt.id, replay.receipt.id);
  const run = f.store.tenant(f.admin, f.tenant.id).runs.find(item => item.id === first.run.id);
  assert.equal(run.provider, 'mcp'); assert.equal(run.providerCalled, false); assert.equal(run.actorUserId, null); assert.equal(run.serviceId, f.created.principal.id); assert.equal(run.externalDraft, true);
  assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 0); assert.equal(f.receipts()[0].result.run.draft, null); assert.equal(f.calls.length, 0); f.assertNoSend();
  const conflict = await f.client.callTool({ name: 'elozi_submit_draft', arguments: f.input({ text: 'Outro rascunho' }) }); assert.equal(object(conflict).error.status, 409); assert.equal(f.quota().requests, 1);
});

test('submissão externa revalida versão, escopo, campos e limites antes de persistir qualquer rascunho', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read', 'reply.submit'], adapter: { provider: 'mcp' } });
  for (const extra of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(8001) }, { tenantId: 'forged' }, { agentId: 'other' }, { userId: f.admin.userId }, { send: true }]) {
    await assert.rejects(f.client.callTool({ name: 'elozi_submit_draft', arguments: f.input({ text: 'Rascunho permitido', ...extra }) }), invalidParams);
  }
  for (const [extra, expected] of [[{ version: 2 }, 409], [{ conversationId: 'forbidden' }, 403], [{ text: 'controle\u0000recusado' }, 400]]) {
    const result = await f.client.callTool({ name: 'elozi_submit_draft', arguments: f.input({ text: 'Rascunho permitido', ...extra }) }); assert.equal(result.isError, true); assert.equal(object(result).error.status, expected);
  }
  assert.equal(f.quota().requests, 0); assert.equal(f.receipts().length, 0); assert.equal((f.store.tenant(f.admin, f.tenant.id).runs || []).length, 0); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('submissão pelo MCP exige adaptador externo e revogação em voo oculta rascunho já recebido', async t => {
  const incompatible = await fixture(t, { capabilities: ['conversation.read', 'reply.submit'], adapter: { provider: 'mcp' } });
  incompatible.store.mutate(incompatible.admin, incompatible.tenant.id, 'Mudança de adaptador sintética', state => { state.agents[0].provider = 'hermes'; state.agents[0].version = 2; });
  const rejected = await incompatible.client.callTool({ name: 'elozi_submit_draft', arguments: incompatible.input({ text: 'Rascunho externo' }) }); assert.equal(object(rejected).error.status, 409); assert.equal(incompatible.quota().requests, 0); incompatible.assertNoSend();
  const f = await fixture(t, { capabilities: ['conversation.read', 'reply.submit'], adapter: { provider: 'mcp' } }), submit = f.api.submitDraft.bind(f.api); let finish;
  f.api.submitDraft = async (...args) => { const result = submit(...args); await new Promise(resolve => { finish = resolve; }); return result; };
  const pending = f.client.callTool({ name: 'elozi_submit_draft', arguments: f.input({ text: 'private-revoked-external-draft' }) }); while (!finish) await settle();
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 }); finish(); const result = await pending;
  assert.equal(result.isError, true); assert.equal(object(result).error.status, 401); assert.equal(JSON.stringify(result).includes('private-revoked-external-draft'), false);
  assert.equal(f.receipts()[0].state, 'confirmed'); assert.equal(f.receipts()[0].result.run.draft, null); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('cliente SDK company-only lê estrutura sanitizada e propõe fluxo/agente sem administrar ou ler clientes', async t => {
  const f = await fixture(t, { capabilities: ['company.read', 'company.propose'], adapter: { provider: 'mcp' } });
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), ['elozi_me', 'elozi_get_receipt', 'elozi_read_company', 'elozi_propose_flow', 'elozi_propose_agent']);
  const company = object(await f.client.callTool({ name: 'elozi_read_company', arguments: { requestId: 'synthetic_company_001' } }));
  assert.equal(company.company.id, f.tenant.id); assert.deepEqual(company.channels.map(channel => channel.id), ['wa']); assert.deepEqual(company.departments.map(department => department.id), ['support']);
  for (const secret of ['Mensagem pública sintética', 'private-internal-note', 'never-call-provider', 'Outro cliente']) assert.equal(JSON.stringify(company).includes(secret), false);
  const args = { requestId: 'synthetic_flow_001', name: 'Fluxo novo', description: 'Proposta para revisão humana.' };
  const first = object(await f.client.callTool({ name: 'elozi_propose_flow', arguments: args })), replay = object(await f.client.callTool({ name: 'elozi_propose_flow', arguments: args }));
  assert.equal(first.proposal.id, replay.proposal.id); assert.equal(first.proposal.state, 'pending'); assert.equal(first.humanApprovalRequired, true);
  const agent = object(await f.client.callTool({ name: 'elozi_propose_agent', arguments: { requestId: 'synthetic_agent_001', name: 'Agente novo', description: 'Agente externo para revisão.' } }));
  assert.equal(agent.proposal.state, 'pending'); assert.equal(f.store.tenant(f.admin, f.tenant.id).agents.length, 1); assert.equal((f.store.tenant(f.admin, f.tenant.id).flows || []).length, 0);
  assert.equal(f.api.adminProposals.list(f.admin, f.tenant.id).proposals[0].canApprove, true);
  const approved = f.api.adminProposals.decide(f.admin, f.tenant.id, first.proposal.id, { version: 1, action: 'approve' }); assert.equal(approved.entity.state, 'draft');
  const afterApproval = object(await f.client.callTool({ name: 'elozi_propose_flow', arguments: args })); assert.equal(afterApproval.proposal.state, 'approved'); assert.equal((f.store.tenant(f.admin, f.tenant.id).flows || []).length, 1);
  assert.equal(f.quota().requests, 3); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('schemas MCP das propostas recusam publicação, identidade humana, provider e referências fora do escopo', async t => {
  const f = await fixture(t, { capabilities: ['company.read', 'company.propose'], adapter: { provider: 'mcp' } });
  const args = { requestId: 'synthetic_proposal_001', name: 'Proposta' };
  for (const extra of [{ tenantId: 'forged' }, { userId: f.admin.userId }, { publish: true }, { provider: 'hermes' }, { type: 'agent' }, { mode: 'automatic' }]) await assert.rejects(f.client.callTool({ name: 'elozi_propose_flow', arguments: { ...args, ...extra } }), invalidParams);
  await assert.rejects(f.client.callTool({ name: 'elozi_propose_agent', arguments: { ...args, description: 'Proposta', graph: {} } }), invalidParams);
  await assert.rejects(f.client.callTool({ name: 'elozi_approve_proposal', arguments: {} }), invalidParams);
  const forbiddenGraph = { departmentReferenceFormat: 'id-v1', nodes: [{ id: 'start', type: 'start' }, { id: 'route', type: 'department', config: { department: 'sales' } }, { id: 'end', type: 'end' }], edges: [{ from: 'start', to: 'route' }, { from: 'route', to: 'end' }] };
  const denied = await f.client.callTool({ name: 'elozi_propose_flow', arguments: { ...args, graph: forbiddenGraph } }); assert.equal(object(denied).error.status, 400);
  const malformed = structuredClone(forbiddenGraph); malformed.nodes[1].config.token = 'forged';
  await assert.rejects(f.client.callTool({ name: 'elozi_propose_flow', arguments: { ...args, graph: malformed } }), invalidParams);
  assert.equal(f.quota().requests, 0); assert.equal(f.store.tenant(f.admin, f.tenant.id).agentAdminProposals, undefined); f.assertNoSend();
});

test('company.read não concede proposta e revogação bloqueia aprovação humana e replay pelo cliente SDK', async t => {
  const readonly = await fixture(t, { capabilities: ['company.read'], adapter: { provider: 'mcp' } });
  assert.deepEqual((await readonly.client.listTools()).tools.map(tool => tool.name), ['elozi_me', 'elozi_get_receipt', 'elozi_read_company']);
  const denied = await readonly.client.callTool({ name: 'elozi_propose_flow', arguments: { requestId: 'synthetic_flow_001', name: 'Sem concessão' } }); assert.equal(object(denied).error.status, 403);
  const f = await fixture(t, { capabilities: ['company.read', 'company.propose'], adapter: { provider: 'mcp' } }), args = { requestId: 'synthetic_flow_001', name: 'Fluxo proposto' };
  const result = object(await f.client.callTool({ name: 'elozi_propose_flow', arguments: args }));
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  await assert.rejects(f.client.callTool({ name: 'elozi_propose_flow', arguments: args }), error => error.code === 401);
  assert.equal(f.api.adminProposals.list(f.admin, f.tenant.id).proposals[0].canApprove, false);
  assert.throws(() => f.api.adminProposals.decide(f.admin, f.tenant.id, result.proposal.id, { version: 1, action: 'approve' }), error => error.status === 409);
  assert.equal((f.store.tenant(f.admin, f.tenant.id).flows || []).length, 0); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('cliente SDK descobre somente atendimentos dos canais e departamentos concedidos, com filtro, limite e replay', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  f.store.mutate(f.admin, f.tenant.id, 'Fixture de inventário autorizado', state => {
    state.conversations[0].updatedAt = '2026-10-04T10:00:00Z';
    state.conversations.push({ id: 'closed_allowed', contact: 'Atendimento encerrado QA', channelId: 'wa', departmentId: 'support', version: 1, status: 'closed', owner: 'human', updatedAt: '2026-10-04T11:00:00Z', messages: [] },
      { id: 'forbidden_department', contact: 'private-department-customer', channelId: 'wa', departmentId: 'sales', version: 1, status: 'open', owner: 'human', messages: [] },
      { id: 'forbidden_channel', contact: 'private-channel-customer', channelId: 'other', departmentId: 'support', version: 1, status: 'open', owner: 'human', messages: [] });
  });
  const args = { requestId: 'synthetic_inventory_001' }, first = object(await f.client.callTool({ name: 'elozi_list_conversations', arguments: args })), replay = object(await f.client.callTool({ name: 'elozi_list_conversations', arguments: args }));
  assert.deepEqual(first.conversations.map(conversation => conversation.id), ['closed_allowed', 'conversation']); assert.equal(first.receipt, replay.receipt); assert.equal(f.quota().requests, 1);
  const open = object(await f.client.callTool({ name: 'elozi_list_conversations', arguments: { requestId: 'synthetic_inventory_002', status: 'open', limit: 1 } })); assert.deepEqual(open.conversations.map(conversation => conversation.id), ['conversation']);
  const closed = object(await f.client.callTool({ name: 'elozi_list_conversations', arguments: { requestId: 'synthetic_inventory_003', status: 'closed' } })); assert.deepEqual(closed.conversations.map(conversation => conversation.id), ['closed_allowed']);
  for (const secret of ['Mensagem pública sintética', 'private-internal-note', 'private-department-customer', 'private-channel-customer', 'never-call-media']) assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(first.conversations[0].messages, undefined); assert.equal(f.calls.length, 0); f.assertNoSend();
});

test('SDK conclui inventário paginado além de50 sem mensagem, modelo ou campo privado', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  f.store.mutate(f.admin, f.tenant.id, 'Inventário sintético de121 contextos', state => {
    state.conversations = Array.from({ length: 121 }, (_, i) => ({ id: `inventory_${String(i).padStart(3, '0')}`, contact: `Contexto ${i}`, channelId: 'wa', departmentId: 'support', status: 'open', owner: 'human', version: 1, updatedAt: '2026-10-01T00:00:00Z', messages: [{ id: `secret_${i}`, kind: 'internal', text: 'Não publicar no inventário' }] }));
  });
  const all = []; let cursor, snapshot, page = 0;
  do {
    const result = object(await f.client.callTool({ name: 'elozi_list_conversations', arguments: { requestId: `sdk_page_000${++page}`, limit: 50, ...(cursor ? { cursor } : {}) } }));
    snapshot ??= result.snapshot; assert.equal(result.snapshot, snapshot);
    all.push(...result.conversations); cursor = result.nextCursor;
  } while (cursor);
  assert.equal(page, 3); assert.equal(all.length, 121); assert.equal(new Set(all.map(c => c.id)).size, 121);
  assert.equal(JSON.stringify(all).includes('Não publicar'), false); assert.equal(f.calls.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
});

test('inventário pelo SDK recusa campos, concessão ausente e transferência de atendimento durante resposta', async t => {
  const f = await fixture(t, { capabilities: ['conversation.read'] });
  for (const extra of [{ tenantId: 'forged' }, { channelId: 'other' }, { status: false }, { status: '' }, { status: 'deleted' }, { limit: 0 }, { limit: 51 }, { limit: '20' }]) await assert.rejects(f.client.callTool({ name: 'elozi_list_conversations', arguments: { requestId: 'synthetic_inventory_001', ...extra } }), invalidParams);
  assert.equal(f.quota().requests, 0);
  const readonlyCompany = await fixture(t, { capabilities: ['company.read'], adapter: { provider: 'mcp' } });
  const denied = await readonlyCompany.client.callTool({ name: 'elozi_list_conversations', arguments: { requestId: 'synthetic_inventory_001' } }); assert.equal(object(denied).error.status, 403); assert.equal(readonlyCompany.quota().requests, 0);
  const inbox = f.api.inbox.bind(f.api); let finish;
  f.api.inbox = async (...args) => { const result = inbox(...args); await new Promise(resolve => { finish = resolve; }); return result; };
  const pending = f.client.callTool({ name: 'elozi_list_conversations', arguments: { requestId: 'synthetic_inventory_002' } }); while (!finish) await settle();
  f.store.mutate(f.admin, f.tenant.id, 'Transferência sintética em voo', state => { state.conversations[0].channelId = 'other'; state.conversations[0].version++; });
  finish(); const result = await pending;
  assert.equal(result.isError, true); assert.ok([403, 409].includes(object(result).error.status)); assert.equal(JSON.stringify(result).includes('Cliente sintético'), false); f.assertNoSend();
});

test('erro 429 de ferramenta MCP leva o retryAfter no corpo, porque o MCP não tem cabeçalho por chamada', async () => {
  const { businessError } = await import('../src/service-mcp.js');
  const limited = businessError(Object.assign(new Error('Aguarde antes de esperar eventos de novo.'), { status: 429, retryAfter: 25 }));
  assert.equal(limited.isError, true);
  assert.deepEqual(limited.structuredContent.error, { status: 429, message: 'Aguarde antes de esperar eventos de novo.', retryAfter: 25 });
  assert.match(limited.content[0].text, /Tente novamente em 25 s\.$/);
  const plain = businessError(Object.assign(new Error('Conversa fora do escopo.'), { status: 403, retryAfter: 25 }));
  assert.equal(Object.hasOwn(plain.structuredContent.error, 'retryAfter'), false, 'só o 429 informa a espera');
  const internal = businessError(new Error('detalhe interno'));
  assert.equal(internal.structuredContent.error.status, 500); assert.doesNotMatch(internal.content[0].text, /detalhe interno/);
});
