import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { McpManager, mcpHash } from '../src/mcp.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', userId: 'synthetic-mcp-owner', name: 'MCP remoto QA' };
const status = code => error => error.status === code;
const tokenA = 'synthetic-mcp-remote-token-tenant-a';
const tokenB = 'synthetic-mcp-remote-token-tenant-b';
const tool = () => ({ name: 'synthetic_status', title: 'Consultar status sintético', description: 'Consulta uma fixture local.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 16 } }, required: ['query'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] }, workspace: { type: 'string' } }, required: ['status'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false } });

async function fixture(t, options = {}) {
  const store = new Store(':memory:'), vault = encryptedChannelSecrets(store.db, randomBytes(32));
  const requests = [], violations = [], sessions = new Map(), replies = [], state = { tools: [tool()], resultMode: 'valid', streamCalls: false, ...options };
  const reply = (res, id, result, stream = false) => {
    const payload = { jsonrpc: '2.0', id, result }; replies.push(payload);
    if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); return; }
    const wire = JSON.stringify(payload), middle = Math.floor(wire.length / 2);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: message\ndata: ' + wire.slice(0, middle)); res.end(wire.slice(middle) + '\n\n');
  };
  const server = createServer(async (req, res) => {
    let message;
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const authorization = req.headers.authorization, sessionId = req.headers['mcp-session-id'];
      requests.push({ message, authorization, sessionId, protocolVersion: req.headers['mcp-protocol-version'], accept: req.headers.accept });
      const reject = reason => {
        violations.push(reason); res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: reason } }));
      };
      if (req.method !== 'POST' || req.url !== '/mcp' || message.jsonrpc !== '2.0') return reject('Invalid synthetic HTTP/JSON-RPC envelope');
      if (![tokenA, tokenB].some(token => authorization === `Bearer ${token}`)) return reject('Invalid synthetic bearer scope');
      if (!req.headers.accept?.includes('application/json') || !req.headers.accept?.includes('text/event-stream')) return reject('Missing MCP response media types');
      if (message.method === 'initialize') {
        if (sessionId || message.params?.protocolVersion !== '2025-11-25' || message.id === undefined) return reject('Invalid initialize/session/version');
        const id = `synthetic-mcp-session-${sessions.size + 1}`;
        sessions.set(id, authorization); res.setHeader('Mcp-Session-Id', id);
        return reply(res, message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mcp-local-fixture', version: '1.0.0' } });
      }
      if (!sessionId || sessions.get(sessionId) !== authorization || req.headers['mcp-protocol-version'] !== '2025-11-25') return reject('Session not bound to the initialized bearer/version');
      if (message.method === 'notifications/initialized') {
        if (message.id !== undefined) return reject('Initialization notification unexpectedly has an ID');
        res.writeHead(202); res.end(); return;
      }
      if (message.id === undefined) return reject('Synthetic MCP request has no matching response ID');
      if (message.method === 'tools/list') return reply(res, message.id, { tools: state.tools });
      if (message.method === 'tools/call') {
        if (message.params?.name !== 'synthetic_status') return reject('Unexpected synthetic tool name');
        const workspace = authorization === `Bearer ${tokenA}` ? 'tenant-a' : 'tenant-b';
        const structuredContent = state.resultMode === 'invalid' ? { status: 123 } : { status: 'ok', workspace };
        const text = state.resultMode === 'reflect' ? authorization : JSON.stringify(structuredContent);
        return reply(res, message.id, { content: [{ type: 'text', text }], structuredContent, isError: false }, state.streamCalls);
      }
      return reject('Unexpected synthetic MCP method');
    } catch {
      violations.push('Synthetic fixture could not parse a request');
      if (!res.headersSent) res.writeHead(400); res.end();
    }
  });
  t.after(async () => {
    try { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } finally { store.close(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`, origin = new URL(endpoint).origin;
  const manager = new McpManager(store, { vault: () => vault, allowedOrigins: [origin], privateOrigins: [origin] });
  const company = (name, token) => {
    const tenant = store.createTenant(actor, { name, segment: 'QA' });
    const configured = manager.create(actor, tenant.id, { name: 'MCP remoto sintético', kind: 'remote', endpoint, enabled: true, token });
    return { tenant, server: configured };
  };
  const discover = entry => manager.discover(actor, entry.tenant.id, entry.server.id, { version: entry.server.version }, { authorize: () => actor });
  const run = (entry, argumentsValue = { query: 'status' }) => {
    const current = store.tenant(actor, entry.tenant.id).mcpServers.find(item => item.id === entry.server.id), selected = current.tools[0];
    return { id: 'synthetic-remote-run', conversationId: 'synthetic-conversation', toolProposal: {
      serverId: current.id, serverVersion: current.version, toolName: selected.name, toolHash: selected.hash,
      arguments: argumentsValue, argumentsHash: mcpHash(argumentsValue)
    } };
  };
  const call = (entry, execution = run(entry), onDispatch = () => {}) => manager.call(actor, entry.tenant.id, execution, {
    signal: AbortSignal.timeout(3000), authorize: () => {}, onDispatch
  });
  return { store, vault, manager, requests, replies, sessions, violations, state, company, discover, run, call };
}

test('MCP remoto SDK real descobre em JSON e chama em SSE com IDs/sessão e annotations sem autoridade', async t => {
  const c = await fixture(t, { streamCalls: true }), entry = c.company('Remoto protocolo QA', tokenA);
  const discovered = await c.discover(entry);
  assert.equal(discovered.state, 'verified'); assert.equal(discovered.tools[0].readOnly, false); assert.equal(discovered.tools[0].annotations, undefined);
  assert.deepEqual(discovered.tools[0].inputSchema, tool().inputSchema); assert.deepEqual(discovered.tools[0].outputSchema, tool().outputSchema);
  let dispatches = 0; const result = await c.call(entry, c.run(entry), () => dispatches++);
  assert.equal(dispatches, 1); assert.deepEqual(result.structuredContent, { status: 'ok', workspace: 'tenant-a' }); assert.equal(result.isError, false);
  assert.deepEqual(c.violations, []);
  assert.deepEqual(c.requests.map(item => item.message.method), ['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(c.sessions.size, 2);
  assert.deepEqual(c.replies.map(reply => reply.id), c.requests.filter(item => item.message.id !== undefined).map(item => item.message.id));
  const invocation = c.requests.find(item => item.message.method === 'tools/call');
  assert.deepEqual(invocation.message.params, { name: 'synthetic_status', arguments: { query: 'status' } });
  assert.equal(invocation.authorization, `Bearer ${tokenA}`); assert.equal(invocation.protocolVersion, '2025-11-25');
});

test('MCP remoto rejeita schema não suportado, argumentos antes de I/O e outputSchema incompatível', async t => {
  const c = await fixture(t), entry = c.company('Remoto schemas QA', tokenA);
  c.state.tools[0].outputSchema.properties.status.pattern = '^.*$';
  await assert.rejects(c.discover(entry), status(400));
  assert.equal(c.store.tenant(actor, entry.tenant.id).mcpServers[0].state, 'configured');
  c.state.tools = [tool()]; await c.discover(entry);
  const before = c.requests.length; let dispatches = 0;
  await assert.rejects(c.call(entry, c.run(entry, { query: 'status', foreignTenant: 'synthetic-spoof' }), () => dispatches++), status(409));
  assert.equal(c.requests.length, before); assert.equal(dispatches, 0);
  c.state.resultMode = 'invalid';
  await assert.rejects(c.call(entry, c.run(entry), () => dispatches++), status(502));
  assert.equal(dispatches, 1); assert.equal(c.requests.filter(item => item.message.method === 'tools/call').length, 1); assert.deepEqual(c.violations, []);
});

test('MCP remoto bloqueia reflexão do bearer no catálogo/resultado e conserva somente metadata pública', async t => {
  const c = await fixture(t), entry = c.company('Remoto reflexão QA', tokenA);
  c.state.tools[0].description = `Synthetic reflected bearer ${tokenA}`;
  await assert.rejects(c.discover(entry), error => error.status === 502 && !error.message.includes(tokenA));
  assert.deepEqual(c.store.tenant(actor, entry.tenant.id).mcpServers[0].tools, []);
  c.state.tools = [tool()]; await c.discover(entry); c.state.resultMode = 'reflect';
  await assert.rejects(c.call(entry), error => error.status === 502 && !error.message.includes(tokenA));
  assert.equal(JSON.stringify(c.store.tenant(actor, entry.tenant.id)).includes(tokenA), false);
  assert.equal(JSON.stringify(c.manager.list(actor, entry.tenant.id)).includes(tokenA), false);
  const encrypted = c.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get(`mcp:${entry.tenant.id}:${entry.server.id}`);
  assert.equal(Buffer.from(encrypted.payload).includes(Buffer.from(tokenA)), false); assert.deepEqual(c.violations, []);
});

test('MCP remoto isola bearer e sessão de duas empresas mesmo com serverId coincidente', async t => {
  const c = await fixture(t), a = c.company('Remoto empresa A QA', tokenA), b = c.company('Remoto empresa B QA', tokenB);
  const previousB = b.server.id;
  c.store.mutate(actor, b.tenant.id, 'Colisão sintética de identidade MCP entre empresas', tenant => { tenant.mcpServers[0].id = a.server.id; });
  b.server.id = a.server.id; c.vault.set(`mcp:${b.tenant.id}:${b.server.id}`, { token: tokenB });
  assert.notEqual(previousB, a.server.id);
  await Promise.all([c.discover(a), c.discover(b)]);
  const [resultA, resultB] = await Promise.all([c.call(a), c.call(b)]);
  assert.equal(resultA.structuredContent.workspace, 'tenant-a'); assert.equal(resultB.structuredContent.workspace, 'tenant-b');
  assert.equal(c.vault.get(`mcp:${a.tenant.id}:${a.server.id}`).token, tokenA); assert.equal(c.vault.get(`mcp:${b.tenant.id}:${b.server.id}`).token, tokenB);
  assert.equal(c.sessions.size, 4); assert.deepEqual(c.violations, []);
  const invocations = c.requests.filter(item => item.message.method === 'tools/call'); assert.equal(invocations.length, 2);
  assert.deepEqual(new Set(invocations.map(item => item.authorization)), new Set([`Bearer ${tokenA}`, `Bearer ${tokenB}`]));
  assert.equal(new Set(invocations.map(item => item.sessionId)).size, 2);
  for (const entry of [a, b]) {
    const publicData = JSON.stringify(c.store.tenant(actor, entry.tenant.id)); assert.equal(publicData.includes(tokenA), false); assert.equal(publicData.includes(tokenB), false);
  }
});
