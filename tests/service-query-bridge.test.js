import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { Operations } from '../src/operations.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { createServiceMcpHandler } from '../src/service-mcp.js';
import { createAgentQueryBridge, createAgentQueryMcpServer, loadAgentQueryConfig, validateAgentQueryConfig } from '../src/agent-query-bridge.js';

const status = code => error => error.status === code;
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const configuration = count => ({ connections: Array.from({ length: count }, (_, index) => ({ id: `company-${index}`, name: `Empresa ${index}`, endpoint: `https://company-${index}.invalid/api/agent/mcp`, tokenEnv: `ELOZI_SYNTHETIC_${index}` })) });
const environment = config => Object.fromEntries(config.connections.map((connection, index) => [connection.tokenEnv, 'elozi_svc_' + String(index).repeat(43)]));
const cursor = 'syntheticPage.' + 'a'.repeat(43);
const wrapper = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
function mockFixture(t, count = 2, { onCall, timeoutMs = 15000 } = {}) {
  const config = configuration(count), env = environment(config), calls = [], factories = [], closed = [], ids = new Map(); let active = 0, maxActive = 0;
  const clientFactory = async connection => {
    factories.push(connection.id);
    return { async callTool({ name, arguments: args }, _, options) {
      active++; maxActive = Math.max(active, maxActive); calls.push({ connectionId: connection.id, name, args });
      try {
        await pause();
        const custom = await onCall?.({ connection, name, args, options, env }); if (custom) return custom;
        const tenantId = 'tenant-' + connection.id;
        if (name === 'elozi_me') return wrapper({ principal: { id: 'principal-' + connection.id, workspaceId: 'workspace-' + connection.id, agentId: 'external', tenantId, name: 'Agente ' + connection.id, capabilities: ['conversation.read'], endpoint: connection.endpoint, token: env[connection.tokenEnv], privateField: 'do-not-export' } });
        const key = connection.id + ':' + args.requestId, prior = ids.get(key), payload = JSON.stringify({ name, args });
        if (prior && prior !== payload) return { isError: true, structuredContent: { error: { status: 409, message: 'raw-error-secret-' + env[connection.tokenEnv] } } };
        ids.set(key, payload);
        if (name === 'elozi_search_conversations') return wrapper({ tenantId, conversations: [{ conversationId: 'attendance', contact: 'Cliente público', channelId: 'wa', departmentId: 'support', status: 'open', version: 1, updatedAt: '2026-10-05T12:00:00Z', snippets: [{ messageId: 'public-message', kind: 'customer', text: 'Texto público https://public.example', createdAt: '2026-10-05T12:00:00Z' }], privateField: 'do-not-export' }], coverage: { includedCount: 1, hasMore: true, truncated: false }, nextCursor: cursor, receipt: 'receipt-' + connection.id, token: env[connection.tokenEnv] });
        assert.equal(name, 'elozi_read_conversation_history');
        return wrapper({ tenantId, conversationId: args.conversationId, channelId: 'wa', version: 1, messages: [{ id: 'public-message', kind: 'customer', text: 'Texto público https://public.example ' + env[connection.tokenEnv], senderName: 'Pessoa', createdAt: '2026-10-05T12:00:00Z', attachments: [{ id: 'safe-file', kind: 'image', mime: 'image/png', name: 'imagem.png', size: 4, url: 'https://private-media.invalid', bytes: 'private-media-data' }], note: 'private-note' }], coverage: { includedCount: 1, hasMore: false, from: '2026-09-28T12:00:00Z', to: '2026-10-05T12:00:00Z', availableCount: 1 }, nextCursor: null, receipt: 'receipt-' + connection.id, privateField: 'do-not-export' });
      } finally { active--; }
    }, async close() { closed.push(connection.id); } };
  };
  const bridge = createAgentQueryBridge(config, { env, clientFactory, timeoutMs }); t.after(() => bridge.close());
  return { bridge, config, env, calls, factories, closed, ids, maxActive: () => maxActive };
}

test('config privada aceita só aliases únicos, referência env e endpoint HTTPS exato', () => {
  const config = configuration(2); assert.equal(validateAgentQueryConfig(config).connections.length, 2);
  const bad = [null, {}, { connections: [] }, configuration(9), { ...config, token: 'literal-secret' }, { connections: [config.connections[0], config.connections[0]] }];
  for (const input of bad) assert.throws(() => validateAgentQueryConfig(input), status(400));
  for (const patch of [{ id: 'invalid alias' }, { id: 'a'.repeat(41) }, { name: '' }, { name: 'nome\nsecret' }, { token: 'literal' }, { tokenEnv: 'INVALID-ENV' }, { endpoint: 'http://127.0.0.1:1234/api/agent/mcp' }, { endpoint: 'https://user:password@example.invalid/api/agent/mcp' }, { endpoint: 'https://example.invalid/api/agent/mcp?token=x' }, { endpoint: 'https://example.invalid/api/agent/mcp#fragment' }, { endpoint: 'https://example.invalid/api/agent/mcp/' }, { endpoint: 'https://example.invalid/%61pi/agent/mcp' }]) assert.throws(() => validateAgentQueryConfig({ connections: [{ ...config.connections[0], ...patch }] }), status(400));
  const loopback = { connections: [{ ...config.connections[0], endpoint: 'http://127.0.0.1:1234/api/agent/mcp' }] };
  assert.equal(validateAgentQueryConfig(loopback, { allowHttpLoopback: true }).connections.length, 1);
  assert.throws(() => validateAgentQueryConfig({ connections: [{ ...config.connections[0], endpoint: 'http://remote.invalid/api/agent/mcp' }] }, { allowHttpLoopback: true }), status(400));
});

test('fanout mantém duas empresas separadas e expõe erros parciais sem segredos', async t => {
  const f = mockFixture(t), metadata = await f.bridge.invoke('elozi_connections', {});
  assert.equal(metadata.connections.length, 2); assert.equal(metadata.partial, false);
  const result = await f.bridge.invoke('elozi_search_all', { requestId: 'synthetic-search-1', query: 'público' });
  assert.deepEqual(result.connections.map(value => [value.connectionId, value.tenantId]), [['company-0', 'tenant-company-0'], ['company-1', 'tenant-company-1']]);
  assert.notEqual(f.calls.find(value => value.name === 'elozi_search_conversations').args.requestId, f.calls.filter(value => value.name === 'elozi_search_conversations')[1].args.requestId);
  const history = await f.bridge.invoke('elozi_read_context', { requestId: 'synthetic-history-1', connectionId: 'company-0', conversationId: 'attendance' });
  assert.match(history.messages[0].text, /https:\/\/public\.example/); assert.equal(history.messages[0].attachments[0].url, undefined);
  const serialized = JSON.stringify([metadata, result, history, f.bridge]);
  for (const value of [...Object.values(f.env), ...f.config.connections.map(connection => connection.endpoint), 'do-not-export', 'private-media', 'private-note']) assert.equal(serialized.includes(value), false, value);
  const bad = mockFixture(t, 2, { onCall: ({ connection, name, env }) => connection.id === 'company-1' && name === 'elozi_me' ? { isError: true, structuredContent: { error: { status: 401, message: env[connection.tokenEnv] + ' https://private-error.invalid' } } } : null });
  const partial = await bad.bridge.invoke('elozi_search_all', { requestId: 'synthetic-partial-1', query: 'público' });
  assert.equal(partial.partial, true); assert.equal(partial.connections[0].conversations.length, 1); assert.equal(partial.connections[1].error.status, 401);
  assert.equal(JSON.stringify(partial).includes('private-error'), false); assert.equal(JSON.stringify(partial).includes(bad.env.ELOZI_SYNTHETIC_1), false);
});

test('aliases não podem mudar empresa/endpoint/tool e seleção parcial consulta só conexão escolhida', async t => {
  const f = mockFixture(t);
  for (const [name, args] of [
    ['elozi_search_all', { requestId: 'synthetic-forged-1', query: 'público', connections: ['forged-company'] }],
    ['elozi_search_all', { requestId: 'synthetic-forged-2', query: 'público', connections: ['company-0', 'company-0'] }],
    ['elozi_read_context', { requestId: 'synthetic-forged-3', conversationId: 'attendance', connectionId: 'forged-company' }],
    ['elozi_read_context', { requestId: 'synthetic-forged-4', conversationId: 'attendance', connectionId: 'company-0', tenantId: 'other-tenant' }],
    ['elozi_search_all', { requestId: 'synthetic-forged-5', query: 'público', endpoint: 'https://attacker.invalid' }],
    ['elozi_send_group_message', { requestId: 'synthetic-forged-6', text: 'Não enviar' }]
  ]) await assert.rejects(f.bridge.invoke(name, args), status(400));
  assert.equal(f.factories.length, 0);
  const subset = await f.bridge.invoke('elozi_search_all', { requestId: 'synthetic-subset-1', query: 'público', connections: ['company-1'] });
  assert.equal(subset.connections.length, 1); assert.equal(subset.connections[0].connectionId, 'company-1'); assert.deepEqual(f.factories, ['company-1']);
  const mismatch = mockFixture(t, 1, { onCall: ({ name }) => name === 'elozi_search_conversations' ? wrapper({ tenantId: 'wrong-company', conversations: [], coverage: { includedCount: 0, hasMore: false }, nextCursor: null, receipt: 'safe-receipt' }) : null });
  const invalid = await mismatch.bridge.invoke('elozi_search_all', { requestId: 'synthetic-mismatch-1', query: 'público' }); assert.equal(invalid.connections[0].error.status, 502); assert.equal(JSON.stringify(invalid).includes('wrong-company'), false);
});

test('concorrência global limitada a quatro e clientes privados são reutilizados/fechados', async t => {
  const f = mockFixture(t, 8);
  await Promise.all([f.bridge.invoke('elozi_search_all', { requestId: 'synthetic-concurrent-1', query: 'público' }), f.bridge.invoke('elozi_search_all', { requestId: 'synthetic-concurrent-2', query: 'público' })]);
  assert.ok(f.maxActive() <= 4); assert.equal(f.factories.length, 8); assert.equal(new Set(f.factories).size, 8);
  await f.bridge.close(); assert.equal(f.closed.length, 8); await f.bridge.close(); assert.equal(f.closed.length, 8);
  await assert.rejects(f.bridge.invoke('elozi_connections', {}), status(503));
});

test('requestIds determinísticos separam aliases/operações/páginas e replay não cobra de novo', async t => {
  const f = mockFixture(t), input = { requestId: 'synthetic-stable-1', query: 'público' };
  await f.bridge.invoke('elozi_search_all', input); assert.equal(f.ids.size, 2);
  await f.bridge.invoke('elozi_search_all', input); assert.equal(f.ids.size, 2);
  const changed = await f.bridge.invoke('elozi_search_all', { ...input, query: 'outro assunto' }); assert.equal(changed.partial, true); assert.ok(changed.connections.every(value => value.error.status === 409)); assert.equal(f.ids.size, 2);
  const history = { requestId: input.requestId, connectionId: 'company-0', conversationId: 'attendance' };
  await f.bridge.invoke('elozi_read_context', history); await f.bridge.invoke('elozi_read_context', history); assert.equal(f.ids.size, 3);
  await f.bridge.invoke('elozi_read_context', { ...history, cursor }); await f.bridge.invoke('elozi_read_context', { ...history, cursor }); assert.equal(f.ids.size, 4);
  const page = { ...input, connections: ['company-0'], cursors: [{ connectionId: 'company-0', cursor }] };
  await f.bridge.invoke('elozi_search_all', page); await f.bridge.invoke('elozi_search_all', page); assert.equal(f.ids.size, 5);
  for (const cursors of [[{ connectionId: 'unknown', cursor }], [{ connectionId: 'company-1', cursor }], [{ connectionId: 'company-0', cursor }, { connectionId: 'company-0', cursor }]]) await assert.rejects(f.bridge.invoke('elozi_search_all', { ...input, connections: ['company-0'], cursors }), status(400));
  const calls = f.calls.filter(value => value.name === 'elozi_search_conversations'); assert.equal(calls[0].args.requestId, calls[2].args.requestId); assert.ok(calls.every(value => /^[A-Za-z0-9_-]{8,120}$/.test(value.args.requestId)));
});

test('limites locais recusam antes de transporte e timeout descarta/fecha cliente', async t => {
  const f = mockFixture(t);
  for (const extra of [{ query: 'x' }, { query: 'x'.repeat(201) }, { query: {} }, { query: 'público', limit: 11 }, { query: 'público', limit: 0 }, { query: 'público', status: 'invalid' }, { query: 'público', before: '2026-02-30T00:00:00Z' }, { query: 'público', token: 'secret' }]) await assert.rejects(f.bridge.invoke('elozi_search_all', { requestId: 'synthetic-invalid-1', ...extra }), status(400));
  for (const extra of [{ limit: 101 }, { cursor: 'x'.repeat(2401) }, { after: '2026-08-01T00:00:00Z', before: '2026-10-01T00:00:00Z' }]) await assert.rejects(f.bridge.invoke('elozi_read_context', { requestId: 'synthetic-invalid-2', connectionId: 'company-0', conversationId: 'attendance', ...extra }), status(400));
  assert.equal(f.factories.length, 0);
  const timeout = mockFixture(t, 1, { timeoutMs: 50, onCall: ({ name, options }) => name === 'elozi_search_conversations' ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('private-abort-detail'), { status: 504 })), { once: true })) : null });
  const result = await timeout.bridge.invoke('elozi_search_all', { requestId: 'synthetic-timeout-1', query: 'público' });
  assert.equal(result.connections[0].error.status, 504); assert.equal(JSON.stringify(result).includes('private-abort-detail'), false); assert.ok(timeout.closed.includes('company-0'));
});

test('upstream malformado não amplia capabilities nem orçamento Unicode do contexto', async t => {
  const f = mockFixture(t, 1, { onCall: ({ name, args }) => {
    if (name === 'elozi_me') return wrapper({ principal: { tenantId: 'tenant-company-0', name: 'Agente sintético', capabilities: ['conversation.read', 'a'.repeat(1_000_000) + '.b', 'reply.send'] } });
    if (name === 'elozi_read_conversation_history') return wrapper({ tenantId: 'tenant-company-0', conversationId: args.conversationId, channelId: 'wa', version: 1, messages: [{ id: 'long-public', kind: 'customer', text: '界'.repeat(12000), senderName: 'Pessoa', createdAt: '2026-10-05T12:00:00Z', attachments: [] }], coverage: { includedCount: 1, hasMore: false, availableCount: 1, from: '2026-09-28T12:00:00Z', to: '2026-10-05T12:00:00Z' }, nextCursor: null, receipt: 'safe-receipt' });
    return null;
  } });
  const metadata = await f.bridge.invoke('elozi_connections', {}); assert.deepEqual(metadata.connections[0].capabilities, ['conversation.read', 'reply.send']); assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 2048);
  const result = await f.bridge.invoke('elozi_read_context', { requestId: 'synthetic-long-context', connectionId: 'company-0', conversationId: 'attendance' });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24576); assert.equal(result.coverage.truncated, true); assert.ok(result.messages[0].text.length > 0);
});

test('página só com anexos perto24KiB reduz labels e preserva IDs/cursor com alias Unicode', async t => {
  const id = 'a'.repeat(40), config = { connections: [{ id, name: '界'.repeat(80), endpoint: 'https://synthetic-attachments.invalid/api/agent/mcp', tokenEnv: 'ELOZI_SYNTHETIC_ATTACHMENTS' }] };
  const upstream = { tenantId: 'tenant-attachments', channelId: 'wa', conversationId: 'attendance', version: 1,
    messages: Array.from({ length: 5 }, (_, index) => ({ id: `message-${index}`, kind: 'customer', text: '', senderName: 'Pessoa', createdAt: '2026-10-05T12:00:00Z',
      attachments: Array.from({ length: 10 }, (_, attachmentIndex) => ({ id: `attachment-${index}-${attachmentIndex}-` + 'x'.repeat(100), kind: 'image', name: '', mime: 'image/png', size: 4 })) })),
    coverage: { includedCount: 5, hasMore: true, truncated: false, from: '2026-09-28T12:00:00Z', to: '2026-10-05T12:00:00Z', availableCount: 6, historySource: 'elozi', attachmentsAnalyzed: false }, nextCursor: cursor, receipt: 'safe-receipt' };
  let remaining = 24419 - Buffer.byteLength(JSON.stringify(upstream));
  for (const attachment of upstream.messages.flatMap(message => message.attachments)) {
    const unicode = Math.min(160, Math.floor(remaining / 3)); attachment.name = '界'.repeat(unicode); remaining -= unicode * 3;
    const ascii = Math.min(160 - unicode, remaining); attachment.name += 'x'.repeat(ascii); remaining -= ascii;
  }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(upstream)), 24419);
  const original = JSON.stringify(upstream), bridge = createAgentQueryBridge(config, { env: { ELOZI_SYNTHETIC_ATTACHMENTS: 'elozi_svc_' + 's'.repeat(43) }, clientFactory: async () => ({
    async callTool({ name }) { return name === 'elozi_me' ? wrapper({ principal: { tenantId: upstream.tenantId, name: 'Leitor', capabilities: ['conversation.read'] } }) : wrapper(upstream); }, async close() {}
  }) }); t.after(() => bridge.close());
  const result = await bridge.invoke('elozi_read_context', { requestId: 'synthetic-attachment-budget', connectionId: id, conversationId: 'attendance' });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24576); assert.equal(result.coverage.truncated, true); assert.equal(result.connectionId, id); assert.equal(result.nextCursor, cursor);
  assert.deepEqual(result.messages.map(message => message.id), upstream.messages.map(message => message.id));
  assert.deepEqual(result.messages.flatMap(message => message.attachments.map(attachment => attachment.id)), upstream.messages.flatMap(message => message.attachments.map(attachment => attachment.id)));
  assert.ok(result.messages.every(message => message.text === '' && message.attachments.length === 10)); assert.equal(result.coverage.includedCount, 5); assert.equal(result.coverage.availableCount, 6);
  assert.notDeepEqual(result.messages.flatMap(message => message.attachments.map(attachment => attachment.name)), upstream.messages.flatMap(message => message.attachments.map(attachment => attachment.name)));
  assert.equal(JSON.stringify(upstream), original);
});

test('SDK bridge preserva três consultas e oferece somente operações explícitas sem administração', async t => {
  const f = mockFixture(t, 1), server = createAgentQueryMcpServer(f.bridge), client = new Client({ name: 'synthetic-bridge-sdk', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools(); assert.deepEqual(tools.tools.slice(0, 3).map(tool => tool.name), ['elozi_connections', 'elozi_search_all', 'elozi_read_context']);
  assert.equal(tools.tools.length, 14); assert.ok(tools.tools.slice(0, 3).every(tool => tool.annotations.readOnlyHint));
  for (const tool of tools.tools.slice(3)) {
    assert.ok(tool.inputSchema.required.includes('connectionId')); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, ['elozi_get_receipt', 'elozi_wait_for_events'].includes(tool.name));
    assert.ok(!['token', 'bearer', 'endpoint', 'tenantId', 'tool'].some(key => Object.hasOwn(tool.inputSchema.properties, key)));
  }
  assert.equal(f.calls.length, 0, 'catálogo local não pressupõe autorização nem chama a rede');
  const result = await client.callTool({ name: 'elozi_search_all', arguments: { requestId: 'synthetic-sdk-read-1', query: 'público' } }); assert.equal(result.structuredContent.connections.length, 1);
  await assert.rejects(client.callTool({ name: 'elozi_read_context', arguments: { requestId: 'synthetic-sdk-invalid', connectionId: 'unknown', conversationId: 'attendance' } }), /campos e limites/);
});

test('SDK HTTP loopback real preserva identidade/cota e consulta registrado sem envio ou IA', async t => {
  const fixtureNow = Date.parse('2026-10-08T12:00:00Z'), messageAt = new Date(fixtureNow - 1000).toISOString();
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  const admin = auth.actor(auth.insertUser({ username: 'bridge.synthetic.owner', name: 'Admin sintético' }, Buffer.alloc(16, 8), Buffer.alloc(64, 8), 'reseller', [], 'mep-demo'));
  const principals = new ServicePrincipals(store, auth, { now: () => fixtureNow }), api = new ServiceApi(store, principals, { start() { assert.fail('Bridge não chama IA'); } });
  const companies = ['Alpha', 'Beta'].map((name, index) => {
    const tenant = store.createTenant(admin, { name, segment: 'QA' });
    store.mutate(admin, tenant.id, 'Fixture bridge local', state => {
      state.channels = [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }]; state.departments = [{ id: 'support', name: 'Suporte', active: true }];
      state.agents = [{ id: 'external', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }];
      state.conversations = [{ id: `conversation-${index}`, contact: 'Cliente ' + name, channelId: 'wa', departmentId: 'support', status: 'open', version: 1, messages: [{ id: `message-${index}`, kind: 'customer', text: 'Assunto registrado ' + name, createdAt: messageAt }, { id: `note-${index}`, kind: 'internal', text: 'NOTA_PRIVADA_NAO_EXPORTAR', createdAt: messageAt }] }];
    });
    return { tenant, ...principals.create(admin, tenant.id, { name: 'Leitor ' + name, agentId: 'external', capabilities: ['conversation.read'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 20, dailyBudgetMicros: 0, estimatedRequestMicros: 0, maxConcurrent: 4, ttlHours: 24 }) };
  });
  const handler = createServiceMcpHandler(api), server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = { connections: companies.map((company, index) => ({ id: `company-${index}`, name: company.tenant.name, endpoint: `http://127.0.0.1:${server.address().port}/api/agent/mcp`, tokenEnv: `ELOZI_LOOPBACK_${index}` })) }, env = Object.fromEntries(companies.map((company, index) => [`ELOZI_LOOPBACK_${index}`, company.token]));
  const bridge = createAgentQueryBridge(config, { env, allowHttpLoopback: true });
  t.after(async () => { await bridge.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const input = { requestId: 'synthetic-loopback-search', query: 'Assunto registrado', limit: 2 }, first = await bridge.invoke('elozi_search_all', input), replay = await bridge.invoke('elozi_search_all', input);
  assert.equal(first.partial, false); assert.deepEqual(first.connections.map(value => value.tenantId), companies.map(value => value.tenant.id)); assert.deepEqual(replay.connections.map(value => value.receipt), first.connections.map(value => value.receipt));
  for (const company of companies) assert.equal(principals.list(admin, company.tenant.id).principals[0].usage.requests, 1);
  const context = await bridge.invoke('elozi_read_context', { requestId: 'synthetic-loopback-history', connectionId: 'company-1', conversationId: 'conversation-1' }); assert.equal(context.tenantId, companies[1].tenant.id); assert.equal(context.messages.length, 1);
  await assert.rejects(bridge.invoke('elozi_read_context', { requestId: 'synthetic-loopback-negative', connectionId: 'company-0', conversationId: 'conversation-1' }), status(404));
  assert.equal(JSON.stringify([first, context]).includes('NOTA_PRIVADA'), false); assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
});

test('executável stdio real lista ferramentas sem rede nem dados da configuração privada', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-bridge-synthetic-')), path = join(directory, 'config.json'), config = configuration(1);
  await writeFile(path, JSON.stringify(config), 'utf8');
  await assert.rejects(loadAgentQueryConfig({ env: { ELOZI_MCP_CONFIG_PATH: 'relative-config.json' } }), status(400));
  assert.equal((await loadAgentQueryConfig({ env: { ELOZI_MCP_CONFIG_PATH: path } })).connections.length, 1);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('scripts/elozi-agent-mcp.mjs')], env: { ...process.env, ...environment(config), ELOZI_MCP_CONFIG_PATH: path }, stderr: 'pipe' }), client = new Client({ name: 'synthetic-stdio-client', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('elozi-bridge-synthetic-')); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport); const tools = await client.listTools(); assert.equal(tools.tools.length, 14); assert.equal(JSON.stringify(tools).includes(config.connections[0].endpoint), false);
});

const actionCapabilities = {
  elozi_submit_draft: 'reply.submit', elozi_claim_conversation: 'conversation.manage', elozi_send_reply: 'reply.send', elozi_transfer_to_human: 'conversation.manage',
  elozi_set_tags: 'conversation.manage', elozi_close_conversation: 'conversation.manage', elozi_request_human_support: 'handoff.request', elozi_send_group_message: 'reply.send', elozi_schedule_group_message: 'message.schedule'
};
function actionFixture(t, { onCall, timeoutMs = 15000 } = {}) {
  const receipts = new Map(), effects = [], grants = new Map([['company-0', Object.values(actionCapabilities).concat('events.read')], ['company-1', ['conversation.read']]]);
  const f = mockFixture(t, 2, { timeoutMs, onCall: async data => {
    const { connection, name, args, env } = data;
    const custom = await onCall?.({ ...data, receipts, effects }); if (custom) return custom;
    const tenantId = 'tenant-' + connection.id, principalId = 'principal-' + connection.id, workspaceId = 'workspace-' + connection.id;
    if (name === 'elozi_me') return wrapper({ principal: { id: principalId, workspaceId, tenantId, agentId: 'external', name: 'Agente sintético', capabilities: grants.get(connection.id) } });
    const key = connection.id + ':' + args.requestId;
    if (name === 'elozi_get_receipt') return receipts.has(key) ? wrapper({ tenantId, receipt: receipts.get(key) }) : { isError: true, structuredContent: { error: { status: 404 } } };
    if (name === 'elozi_wait_for_events') return wrapper({ events: [{ type: 'conversation.message', at: '2026-10-08T12:00:00Z', conversationId: 'attendance', channelId: 'wa', departmentId: 'support', status: 'open', owner: 'agent', assignedToMe: true, version: 2, messageId: 'message-safe', kind: 'customer', text: env[connection.tokenEnv], bytes: 'private-message' }], cursor: '123456abcdef-1.' + 'a'.repeat(32), resync: false, timedOut: false, ...(args.requestId ? { requestId: args.requestId } : {}) });
    if (!actionCapabilities[name]) return null;
    if (receipts.has(key)) return wrapper({ receipt: receipts.get(key), result: receipts.get(key).result });
    const group = ['elozi_send_group_message', 'elozi_schedule_group_message'].includes(name);
    const result = name === 'elozi_submit_draft' ? { run: { id: 'run-safe', state: 'waiting_approval', draft: null, conversationId: args.conversationId, conversationVersion: args.version, agentId: 'external', serviceId: principalId, updatedAt: '2026-10-08T12:00:00Z', humanApprovalRequired: true } }
      : name === 'elozi_request_human_support' ? { request: { id: 'support-safe', serviceId: principalId, conversationId: args.conversationId, conversationVersion: args.version, reason: args.reason, state: 'pending', version: 1, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z' } }
      : { conversationId: args.conversationId, channelId: 'wa', state: 'confirmed', messageId: 'message-safe', version: args.version + 1,
      ...(group ? { groupId: '123456@g.us' } : {}), ...(name === 'elozi_schedule_group_message' ? { scheduledId: 'schedule-safe', dueAt: args.dueAt } : {}),
      privateField: env[connection.tokenEnv], url: connection.endpoint };
    const receipt = { id: 'receipt-' + args.requestId, principalId, requestId: args.requestId, workspaceId, tenantId, agentId: 'external', capability: actionCapabilities[name], revision: 1, keyRevision: 1,
      adapterHash: 'a'.repeat(64), context: { workspaceId, tenantId, agentId: 'external', conversationId: args.conversationId, conversationVersion: args.version, channelId: 'wa', departmentId: 'support',
        ...(group ? { conversationKind: 'group', groupId: '123456@g.us', channelTransport: 'baileys' } : {}) }, units: 1, reservedCostMicros: 0, chargedCostMicros: 0, budgetKind: 'estimated',
      state: 'confirmed', stale: false, result, reason: null, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z', expiresAt: '2026-10-08T12:05:00Z', token: env[connection.tokenEnv] };
    receipts.set(key, receipt); effects.push({ connectionId: connection.id, name, args });
    return wrapper(name === 'elozi_submit_draft' ? { receipt, run: { ...result.run, draft: args.text, privateField: env[connection.tokenEnv] }, humanApprovalRequired: true }
      : name === 'elozi_request_human_support' ? { receipt, request: result.request } : { receipt, result });
  } });
  return { ...f, receipts, effects, grants };
}

test('ações roteiam uma identidade explícita e preservam requestId/versão/origem/recibo sem segredos', async t => {
  const f = actionFixture(t), input = { connectionId: 'company-0', requestId: 'synthetic-action-1', conversationId: 'attendance', version: 7, text: 'Resposta autorizada' };
  const sent = await f.bridge.invoke('elozi_send_reply', input);
  assert.equal(sent.connectionId, 'company-0'); assert.equal(sent.tenantId, 'tenant-company-0'); assert.equal(sent.workspaceId, 'workspace-company-0'); assert.equal(sent.principalId, 'principal-company-0');
  assert.equal(sent.requestId, input.requestId); assert.equal(sent.version, 7); assert.equal(sent.receipt.requestId, input.requestId); assert.equal(sent.receipt.context.conversationVersion, 7);
  assert.equal(sent.state, 'confirmed'); assert.equal(sent.reconciliationRequired, false); assert.equal(sent.result.messageId, 'message-safe');
  assert.deepEqual(f.effects, [{ connectionId: 'company-0', name: 'elozi_send_reply', args: { requestId: input.requestId, conversationId: 'attendance', version: 7, text: 'Resposta autorizada' } }]);
  assert.ok(f.calls.every(call => call.connectionId === 'company-0')); assert.deepEqual(f.calls.map(call => call.name), ['elozi_me', 'elozi_send_reply']);
  const replay = await f.bridge.invoke('elozi_send_reply', { text: input.text, version: input.version, conversationId: input.conversationId, requestId: input.requestId, connectionId: input.connectionId });
  assert.equal(replay.receipt.id, sent.receipt.id); assert.equal(f.effects.length, 1);
  await assert.rejects(f.bridge.invoke('elozi_send_reply', { ...input, text: 'Outro pedido' }), status(409)); assert.equal(f.effects.length, 1);
  const receipt = await f.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId }); assert.equal(receipt.receipt.id, sent.receipt.id); assert.equal(f.effects.length, 1);
  for (const secret of [...Object.values(f.env), ...f.config.connections.map(item => item.endpoint), 'privateField']) assert.equal(JSON.stringify([sent, replay, receipt]).includes(secret), false);
});

test('todos os schemas de ação limitam argumentos antes da rede e nunca fazem fan-out de escrita', async t => {
  const f = actionFixture(t), base = { connectionId: 'company-0', requestId: 'synthetic-operation-1', conversationId: 'attendance', version: 1 };
  for (const extra of [{ connectionId: undefined }, { connectionId: 'unknown' }, { connections: ['company-0', 'company-1'] }, { tenantId: 'tenant-company-1' }, { bearer: f.env.ELOZI_SYNTHETIC_0 }, { endpoint: f.config.connections[0].endpoint }, { version: 0 }, { text: 'x'.repeat(4001) }, { text: 'private\u0000text' }, { text: f.env.ELOZI_SYNTHETIC_0 }]) await assert.rejects(f.bridge.invoke('elozi_send_reply', { ...base, text: 'Texto', ...extra }), status(400));
  await assert.rejects(f.bridge.invoke('elozi_schedule_group_message', { ...base, text: 'Texto', dueAt: '2026-02-30T00:00:00Z' }), status(400));
  await assert.rejects(f.bridge.invoke('elozi_propose_agent', { ...base, name: 'Admin' }), status(400)); assert.equal(f.factories.length, 0);
  for (const [index, name] of Object.keys(actionCapabilities).entries()) {
    const extra = ['elozi_submit_draft', 'elozi_send_reply', 'elozi_send_group_message', 'elozi_schedule_group_message'].includes(name) ? { text: 'Texto' } : ['elozi_transfer_to_human', 'elozi_request_human_support'].includes(name) ? { reason: 'Preciso da equipe' } : name === 'elozi_set_tags' ? { tags: ['Prioridade'] } : {};
    if (name === 'elozi_schedule_group_message') extra.dueAt = '2026-10-09T12:00:00Z';
    const result = await f.bridge.invoke(name, { ...base, requestId: 'synthetic-operation-' + index, ...extra }); assert.equal(result.receipt.capability, actionCapabilities[name]);
    if (name === 'elozi_submit_draft') { assert.equal(result.run.draft, 'Texto'); assert.equal(result.humanApprovalRequired, true); assert.equal(result.receipt.result.run.draft, null); assert.equal(result.run.privateField, undefined); }
    if (name === 'elozi_request_human_support') { assert.equal(result.request.state, 'pending'); assert.equal(result.request.conversationVersion, base.version); }
  }
  assert.equal(f.effects.length, 9); assert.ok(f.effects.every(effect => effect.connectionId === 'company-0'));
});

test('capacidades frescas e recusas remotas bloqueiam ação; revogação impede replay/recibo', async t => {
  const f = actionFixture(t), input = { connectionId: 'company-1', requestId: 'synthetic-denied-1', conversationId: 'attendance', version: 1, text: 'Texto' };
  await assert.rejects(f.bridge.invoke('elozi_send_reply', input), status(403)); assert.equal(f.effects.length, 0); assert.deepEqual(f.calls.map(call => call.name), ['elozi_me']);
  input.connectionId = 'company-0'; await f.bridge.invoke('elozi_send_reply', input); f.grants.set('company-0', ['conversation.read']);
  await assert.rejects(f.bridge.invoke('elozi_send_reply', input), status(403)); assert.equal(f.effects.length, 1);
  const revoked = actionFixture(t, { onCall: ({ name, args }) => name === 'elozi_me' && revoked.effects.length ? { isError: true, structuredContent: { error: { status: 401, message: 'raw-private-credential' } } } : name === 'elozi_send_reply' && args.conversationId === 'outside-scope' ? { isError: true, structuredContent: { error: { status: 403 } } } : null });
  await assert.rejects(revoked.bridge.invoke('elozi_send_reply', { ...input, requestId: 'synthetic-outside-scope', conversationId: 'outside-scope' }), status(403)); assert.equal(revoked.effects.length, 0);
  await revoked.bridge.invoke('elozi_send_reply', input);
  await assert.rejects(revoked.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId }), status(401)); assert.equal(revoked.effects.length, 1);
});

test('ação simultânea ou incerta não repete despacho e recibo confirma resposta perdida', async t => {
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = actionFixture(t, { onCall: ({ name, args, receipts }) => {
    if (name === 'elozi_send_reply' && args.requestId === 'synthetic-pending-1') { entered(); return new Promise(resolve => { unblock = () => resolve(null); }); }
    return null;
  } });
  const input = { connectionId: 'company-0', requestId: 'synthetic-pending-1', conversationId: 'attendance', version: 1, text: 'Texto' };
  const first = f.bridge.invoke('elozi_send_reply', input); await started;
  await assert.rejects(f.bridge.invoke('elozi_send_reply', input), error => error.status === 409 && error.code === 'ACTION_IN_PROGRESS'); unblock(); await first;
  assert.equal(f.calls.filter(call => call.name === 'elozi_send_reply').length, 1); assert.equal(f.effects.length, 1);
  let uncertain;
  // The action still waits for a deliberate abort; leave enough budget for the receipt RPC under full-suite load.
  const lost = actionFixture(t, { timeoutMs: 500, onCall: ({ name, args, receipts, options }) => {
    if (name !== 'elozi_send_reply') return null;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('private-lost-response'), { status: 504 })), { once: true }));
  } });
  try { await lost.bridge.invoke('elozi_send_reply', { ...input, requestId: 'synthetic-lost-1' }); } catch (error) { uncertain = error; }
  assert.equal(uncertain.status, 504); assert.equal(uncertain.code, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(uncertain.recovery.requestId, 'synthetic-lost-1'); assert.equal(uncertain.recovery.automaticRetry, false);
  await assert.rejects(lost.bridge.invoke('elozi_send_reply', { ...input, requestId: 'synthetic-lost-1' }), error => error.code === 'ACTION_RECONCILIATION_REQUIRED'); assert.equal(lost.calls.filter(call => call.name === 'elozi_send_reply').length, 1);
  const confirmed = await f.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId });
  lost.receipts.set('company-0:synthetic-lost-1', { ...confirmed.receipt, id: 'receipt-lost', requestId: 'synthetic-lost-1' });
  const reconciled = await lost.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: 'synthetic-lost-1' });
  assert.equal(reconciled.state, 'confirmed'); assert.equal(reconciled.reconciliationRequired, false); assert.equal(lost.calls.filter(call => call.name === 'elozi_send_reply').length, 1);
  assert.equal(JSON.stringify(uncertain.recovery).includes('private-lost'), false);
});

test('SDK expõe erro incerto recuperável e eventos sem conteúdo com prazo próprio', async t => {
  let eventBudget;
  const f = actionFixture(t, { onCall: ({ name, options }) => { if (name === 'elozi_wait_for_events') eventBudget = options.timeout; return name === 'elozi_send_reply' ? { isError: true, structuredContent: { error: { status: 502, message: 'raw-private-error' } } } : null; } });
  const server = createAgentQueryMcpServer(f.bridge), client = new Client({ name: 'synthetic-action-sdk', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(left); await client.connect(right); t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'elozi_send_reply', arguments: { connectionId: 'company-0', requestId: 'synthetic-sdk-action', conversationId: 'attendance', version: 1, text: 'Texto' } });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(result.structuredContent.recovery.reconcileWith, 'elozi_get_receipt'); assert.equal(JSON.stringify(result).includes('raw-private'), false);
  const events = await f.bridge.invoke('elozi_wait_for_events', { connectionId: 'company-0', requestId: 'synthetic-event-1', timeoutMs: 25000, types: ['conversation.message'] });
  assert.equal(eventBudget, 40000, 'espera de 25 s tem margem de transporte sem corte aos 15 s');
  assert.equal(events.tenantId, 'tenant-company-0'); assert.equal(events.events.length, 1); assert.equal(events.events[0].text, undefined); assert.equal(events.events[0].bytes, undefined);
  const denied = f.calls.length; await assert.rejects(f.bridge.invoke('elozi_wait_for_events', { connectionId: 'company-1', timeoutMs: 0 }), status(403)); assert.equal(f.calls.length, denied + 1);
  const old = actionFixture(t, { onCall: ({ name }) => name === 'elozi_get_receipt' ? Promise.reject(new Error('server antigo sem ferramenta raw-secret')) : null });
  await assert.rejects(old.bridge.invoke('elozi_get_receipt', { connectionId: 'company-0', requestId: 'synthetic-old-receipt' }), error => error.code === 'RECEIPT_UNAVAILABLE' && error.recovery.automaticRetry === false && error.recovery.reconcileWith === 'authorized-rest-or-admin');
});

test('recibo unknown mantém bloqueio e recibo cruzado/malformado nunca confirma a ação', async t => {
  const f = actionFixture(t), input = { connectionId: 'company-0', requestId: 'synthetic-unknown-state', conversationId: 'attendance', version: 1, text: 'Texto' };
  await f.bridge.invoke('elozi_send_reply', input);
  const receipt = f.receipts.get('company-0:' + input.requestId); receipt.state = 'unknown'; receipt.result.state = 'unknown';
  const unknown = await f.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId });
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.reconciliationRequired, true); assert.equal(unknown.receipt.id, receipt.id);
  await assert.rejects(f.bridge.invoke('elozi_send_reply', input), error => error.code === 'ACTION_RECONCILIATION_REQUIRED' && error.recovery.receiptId === receipt.id); assert.equal(f.effects.length, 1);
  receipt.tenantId = 'tenant-company-1';
  await assert.rejects(f.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId }), status(502)); assert.equal(f.effects.length, 1);
  receipt.tenantId = 'tenant-company-0'; receipt.principalId = 'principal-other';
  await assert.rejects(f.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId }), status(502)); assert.equal(f.effects.length, 1);
  const malformed = actionFixture(t, { onCall: ({ name }) => name === 'elozi_send_reply' ? wrapper({ receipt: { state: 'confirmed' }, result: { state: 'confirmed' } }) : null });
  await assert.rejects(malformed.bridge.invoke('elozi_send_reply', input), error => error.code === 'ACTION_OUTCOME_UNKNOWN');
  await assert.rejects(malformed.bridge.invoke('elozi_send_reply', input), error => error.code === 'ACTION_RECONCILIATION_REQUIRED'); assert.equal(malformed.calls.filter(call => call.name === 'elozi_send_reply').length, 1);
});

test('recibo invalidated é terminal factual e nunca libera replay da mesma requestId', async t => {
  const f = actionFixture(t), input = { connectionId: 'company-0', requestId: 'synthetic-invalidated-1', conversationId: 'attendance', version: 1, text: 'Texto' };
  await f.bridge.invoke('elozi_send_reply', input);
  const receipt = f.receipts.get('company-0:' + input.requestId);
  Object.assign(receipt, { state: 'invalidated', stale: true, chargedCostMicros: 0, result: null, reason: 'Reserva perdeu validade antes do despacho.' });
  const writes = () => f.calls.filter(call => call.name === 'elozi_send_reply').length;
  const before = writes(), result = await f.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId });
  assert.equal(result.state, 'invalidated'); assert.equal(result.receipt.stale, true); assert.equal(result.receipt.result, null); assert.equal(result.reconciliationRequired, false);
  for (const replay of [input, { ...input, text: 'Mudou texto', version: 2 }]) await assert.rejects(f.bridge.invoke('elozi_send_reply', replay), error => error.status === 409 && error.code === 'ACTION_INVALIDATED' && error.recovery.state === 'invalidated' && error.recovery.automaticRetry === false && error.recovery.reconciliationRequired === false);
  assert.equal(writes(), before, 'reconciliação terminal não despacha de novo');
  const restored = actionFixture(t); restored.receipts.set('company-0:' + input.requestId, receipt);
  const restoredResult = await restored.bridge.invoke('elozi_get_receipt', { connectionId: input.connectionId, requestId: input.requestId }); assert.equal(restoredResult.state, 'invalidated');
  await assert.rejects(restored.bridge.invoke('elozi_send_reply', input), error => error.code === 'ACTION_INVALIDATED'); assert.equal(restored.calls.filter(call => call.name === 'elozi_send_reply').length, 0, 'recibo consultado sem memória prévia também bloqueia ação');
});

test('SDK HTTP servido aplica gestão/resposta com ACL, idempotência e recibo sem novo despacho', async t => {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }); new Outbox(store);
  const admin = auth.actor(auth.insertUser({ username: 'bridge.synthetic.actions', name: 'Admin sintético' }, Buffer.alloc(16, 9), Buffer.alloc(64, 9), 'reseller', [], 'mep-demo'));
  const principals = new ServicePrincipals(store, auth), operations = new Operations(store, auth), effects = [];
  const api = new ServiceApi(store, principals, { start() { assert.fail('Não chamar IA'); } }, { operations, sendPrivate(actor, { input, reauthorize, internalActor }) {
    reauthorize(); effects.push({ tenantId: actor.tenantId, requestId: input.requestId });
    const messageId = 'sent-' + input.requestId;
    store.mutate(internalActor, actor.tenantId, 'Resposta sintética', state => { const c = store.getConversation(state, input.conversationId, input.version); c.messages.push({ id: messageId, kind: 'agent', text: input.text, authorServiceId: actor.principalId, createdAt: new Date().toISOString() }); c.version++; });
    return { state: 'confirmed', messageId };
  } });
  const companies = ['Alpha', 'Beta'].map((name, index) => {
    const tenant = store.createTenant(admin, { name, segment: 'QA' });
    store.mutate(admin, tenant.id, 'Fixture local de ações', state => {
      state.channels = [{ id: 'site', kind: 'webchat', transport: 'webchat' }, { id: 'outside', kind: 'webchat' }]; state.departments = [{ id: 'support', name: 'Suporte', active: true }];
      state.agents = [{ id: 'external', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }];
      state.conversations = [{ id: 'attendance', contact: 'Cliente ' + name, channelId: 'site', departmentId: 'support', owner: 'queue', status: 'open', version: 1, messages: [{ id: 'question-' + index, kind: 'customer', text: 'Qual o prazo?', createdAt: new Date().toISOString() }] },
        { id: 'outside-scope', contact: 'Fora do escopo', channelId: 'outside', departmentId: 'support', owner: 'queue', status: 'open', version: 1, messages: [] }];
    });
    return { tenant, ...principals.create(admin, tenant.id, { name: 'Atendente ' + name, agentId: 'external', capabilities: ['conversation.read', 'reply.send', 'conversation.manage'], channelIds: ['site'], departmentIds: ['support'], dailyRequests: 20, maxConcurrent: 4, ttlHours: 24 }) };
  });
  const handler = createServiceMcpHandler(api), server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/api/agent/mcp`, config = { connections: companies.map((company, index) => ({ id: 'company-' + index, name: company.tenant.name, endpoint, tokenEnv: 'ELOZI_ACTION_' + index })) }, env = Object.fromEntries(companies.map((company, index) => ['ELOZI_ACTION_' + index, company.token]));
  const bridge = createAgentQueryBridge(config, { env, allowHttpLoopback: true }), native = new Client({ name: 'synthetic-action-contract', version: '1.0.0' });
  t.after(async () => { await native.close(); await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  await native.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: 'Bearer ' + companies[0].token } } }));
  const catalog = (await native.listTools()).tools;
  for (const tool of bridge.tools().filter(tool => Object.hasOwn(actionCapabilities, tool.name) || tool.name === 'elozi_get_receipt')) {
    const served = catalog.find(item => item.name === tool.name); if (!served) continue;
    const { connectionId, ...properties } = tool.inputSchema.properties; assert.deepEqual(properties, served.inputSchema.properties); assert.deepEqual(tool.inputSchema.required.filter(key => key !== 'connectionId').sort(), served.inputSchema.required.slice().sort());
  }
  const context = () => store.getConversation(store.tenant(admin, companies[0].tenant.id), 'attendance');
  const base = { connectionId: 'company-0', conversationId: 'attendance', version: 1 };
  await assert.rejects(bridge.invoke('elozi_claim_conversation', { ...base, requestId: 'synthetic-native-outside', conversationId: 'outside-scope' }), status(403));
  const claimed = await bridge.invoke('elozi_claim_conversation', { ...base, requestId: 'synthetic-native-claim' }); assert.equal(claimed.result.owner, 'agent'); assert.equal(context().owner, 'agent');
  const input = { ...base, version: context().version, requestId: 'synthetic-native-reply', text: 'Em dois dias úteis.' }, sent = await bridge.invoke('elozi_send_reply', input);
  assert.equal(sent.state, 'confirmed'); assert.equal(sent.receipt.requestId, input.requestId); assert.equal(effects.length, 1);
  const replay = await bridge.invoke('elozi_send_reply', input); assert.equal(replay.receipt.id, sent.receipt.id); assert.equal(effects.length, 1);
  const before = principals.list(admin, companies[0].tenant.id).principals[0].usage.requests;
  const receipt = await bridge.invoke('elozi_get_receipt', { connectionId: 'company-0', requestId: input.requestId }); assert.equal(receipt.receipt.id, sent.receipt.id); assert.equal(principals.list(admin, companies[0].tenant.id).principals[0].usage.requests, before); assert.equal(effects.length, 1);
  await assert.rejects(bridge.invoke('elozi_get_receipt', { connectionId: 'company-1', requestId: input.requestId }), status(404));
  await bridge.invoke('elozi_set_tags', { ...base, version: context().version, requestId: 'synthetic-native-tags', tags: ['Prioridade'] }); assert.deepEqual(context().tags, ['Prioridade']);
  await bridge.invoke('elozi_transfer_to_human', { ...base, version: context().version, requestId: 'synthetic-native-transfer', reason: 'Equipe especializada' }); assert.equal(context().owner, 'queue');
  assert.equal(store.getConversation(store.tenant(admin, companies[1].tenant.id), 'attendance').version, 1, 'outra empresa intacta');
  principals.revoke(admin, companies[0].tenant.id, companies[0].principal.id, { revision: companies[0].principal.revision });
  await assert.rejects(bridge.invoke('elozi_get_receipt', { connectionId: 'company-0', requestId: input.requestId }), status(401)); assert.equal(effects.length, 1);
});
