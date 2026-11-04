import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mcpEndpoint, pinnedMcpFetch, publicAddress } from '../src/mcp-transport.js';

const status = code => error => error.status === code;
const loopback = { address: '127.0.0.1', family: 4 };
async function fixture(t, handle) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host });
    handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  // This hostname is never resolved externally. The injected lookup is pinned
  // to the synthetic loopback fixture and the private-origin exception is exact.
  const endpoint = new URL(`http://mcp-fixture.example.test:${server.address().port}/mcp`);
  const fetch = options => pinnedMcpFetch(endpoint, { privateOrigins: [endpoint.origin], lookupImpl: async () => [loopback], ...options });
  return { endpoint, requests, fetch };
}

test('MCP endpoint exige origem exata, HTTPS externo e exceção privada explícita', () => {
  const origin = 'https://mcp.example.test';
  assert.equal(mcpEndpoint(origin + '/mcp', [origin]).href, origin + '/mcp');
  for (const value of ['https://other.example.test/mcp', origin + '/mcp?token=synthetic', origin + '/mcp#fragment',
    'https://synthetic:credential@mcp.example.test/mcp', 'ftp://mcp.example.test/mcp']) assert.throws(() => mcpEndpoint(value, [origin]), status(400));
  assert.throws(() => mcpEndpoint('http://mcp.example.test/mcp', ['http://mcp.example.test']), status(400));
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '[::1]', '[fc00::1]']) {
    const url = new URL(`https://${address}/mcp`);
    assert.throws(() => mcpEndpoint(url.href, [url.origin]), status(400));
    assert.equal(mcpEndpoint(url.href, [url.origin], [url.origin]).href, url.href);
  }
  const privateOrigin = 'http://127.0.0.1:54321';
  assert.equal(mcpEndpoint(privateOrigin + '/mcp', [privateOrigin], [privateOrigin]).href, privateOrigin + '/mcp');
});

test('MCP classificação de IP bloqueia loopback, privada, metadata e endereços reservados', () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'not-an-ip']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(publicAddress(address), true, address);
});

test('MCP resolve, verifica e fixa o registro sem uma segunda consulta DNS no socket', async t => {
  const c = await fixture(t, (_req, res) => res.end('fixture'));
  const calls = [], phases = [];
  const fetch = c.fetch({ lookupImpl: async (hostname, options) => { calls.push({ hostname, options }); phases.push('dns'); return [loopback]; }, authorize: () => phases.push('authorize') });
  const result = await fetch(c.endpoint, { method: 'POST', body: '{}' });
  assert.equal(await result.text(), 'fixture'); assert.equal(c.requests.length, 1);
  assert.deepEqual(calls, [{ hostname: 'mcp-fixture.example.test', options: { all: true, verbatim: true } }]);
  assert.equal(c.requests[0].host, c.endpoint.host); assert.deepEqual(phases, ['dns', 'authorize']);
});

test('MCP DNS misto público/privado e alteração de endpoint são recusados antes do socket', async () => {
  const endpoint = new URL('https://mcp.example.test/mcp'); let lookups = 0, authorizationChecks = 0;
  const fetch = pinnedMcpFetch(endpoint, { lookupImpl: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }, loopback]; }, authorize: () => authorizationChecks++ });
  await assert.rejects(fetch(endpoint, { method: 'POST', body: '{}' }), status(502));
  assert.equal(lookups, 1); assert.equal(authorizationChecks, 0);
  for (const value of ['https://mcp.example.test/other', 'https://other.example.test/mcp']) await assert.rejects(fetch(value, { method: 'POST', body: '{}' }), status(502));
  assert.equal(lookups, 1);
});

test('MCP revalida autoridade depois do DNS assíncrono e impede I/O após revogação', async t => {
  const c = await fixture(t, (_req, res) => res.end('should-not-run'));
  let finishLookup, allowed = true, authorizationChecks = 0;
  const lookupResult = new Promise(resolve => { finishLookup = resolve; });
  const fetch = c.fetch({ lookupImpl: async () => lookupResult, authorize: () => {
    authorizationChecks++; if (!allowed) throw Object.assign(new Error('Synthetic authority revoked'), { status: 403 });
  } });
  const pending = fetch(c.endpoint, { method: 'POST', body: '{}' });
  allowed = false; finishLookup([loopback]); await assert.rejects(pending, status(403));
  assert.equal(authorizationChecks, 1); assert.equal(c.requests.length, 0);
});

test('MCP não segue redirects mesmo quando o caller pede follow', async t => {
  const c = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/private-target' }); res.end(); });
  await assert.rejects(c.fetch()(c.endpoint, { method: 'POST', body: '{}', redirect: 'follow' }));
  assert.deepEqual(c.requests.map(request => request.url), ['/mcp']);
});

test('MCP status HTTP inválido é erro controlado e não lança fora da Promise', async t => {
  const c = await fixture(t, (_req, res) => { res.writeHead(600); res.end('invalid status fixture'); });
  await assert.rejects(c.fetch()(c.endpoint, { method: 'POST', body: '{}' }));
  assert.equal(c.requests.length, 1);
});

test('MCP limita bytes declarados e streaming chunked; UTF8 no limite é aceito', async t => {
  await t.test('Content-Length excessivo é rejeitado antes de ler conteúdo', async t => {
    const c = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.end('x'); });
    await assert.rejects(c.fetch({ maxBytes: 8 })(c.endpoint, { method: 'POST', body: '{}' }));
  });
  await t.test('limite real recusa body sem Content-Length', async t => {
    const c = await fixture(t, (_req, res) => { res.write('1234'); res.end('56789'); });
    const result = await c.fetch({ maxBytes: 8 })(c.endpoint, { method: 'POST', body: '{}' });
    await assert.rejects(result.text());
  });
  await t.test('limite mede bytes UTF8 em vez de caracteres', async t => {
    const c = await fixture(t, (_req, res) => res.end('éé'));
    const result = await c.fetch({ maxBytes: 4 })(c.endpoint, { method: 'POST', body: '{}' }); assert.equal(await result.text(), 'éé');
  });
});

test('MCP GET retorna 405 sem DNS ou I/O; método e body fora do subset falham', async t => {
  const c = await fixture(t, (_req, res) => res.end('should-not-run')); let lookups = 0;
  const fetch = c.fetch({ lookupImpl: async () => { lookups++; return [loopback]; } });
  const result = await fetch(c.endpoint, { method: 'GET' }); assert.equal(result.status, 405); assert.equal(lookups, 0);
  await assert.rejects(fetch(c.endpoint, { method: 'PUT' }), status(502)); assert.equal(lookups, 0);
  await assert.rejects(fetch(c.endpoint, { method: 'POST', body: 'x'.repeat(128 * 1024 + 1) }), status(400));
  await assert.rejects(fetch(c.endpoint, { method: 'POST', body: Buffer.from('{}') }), status(400));
  assert.equal(c.requests.length, 0);
});

test('MCP sessão remota grande ou fora de ASCII visível é recusada', async t => {
  for (const sessionId of ['s'.repeat(257), 'session with space']) await t.test(`sessão ${sessionId.length} bytes`, async t => {
    const c = await fixture(t, (_req, res) => { res.setHeader('Mcp-Session-Id', sessionId); res.end('{}'); });
    await assert.rejects(c.fetch()(c.endpoint, { method: 'POST', body: '{}' }));
  });
});

test('MCP abort interrompe socket/body e timeout impede espera sem limite', async t => {
  const c = await fixture(t, (_req, _res) => {});
  await assert.rejects(c.fetch({ timeoutMs: 30 })(c.endpoint, { method: 'POST', body: '{}' }));
  const controller = new AbortController(); controller.abort();
  const before = c.requests.length;
  await assert.rejects(c.fetch({ signal: controller.signal })(c.endpoint, { method: 'POST', body: '{}' }));
  assert.equal(c.requests.length, before);
});
