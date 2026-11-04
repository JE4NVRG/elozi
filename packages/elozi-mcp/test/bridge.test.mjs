import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBridge, readBridgeConfig, DEFAULT_BASE_URL } from '../src/bridge.mjs';
import { startFakeElozi, INSTRUCTIONS, TOOLS } from './fake-elozi-server.mjs';

const BIN = fileURLToPath(new URL('../bin/elozi-mcp.mjs', import.meta.url));
const newToken = () => 'elozi_svc_' + randomBytes(32).toString('base64url');

async function connectThroughBridge(config) {
  const bridge = await createBridge(config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  return { bridge, client, close: async () => { await client.close(); await bridge.close(); } };
}

function runCli(env, args = [], stdin = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

test('config: default endpoint is the hosted Elozi MCP over HTTPS', () => {
  const token = newToken();
  const config = readBridgeConfig({ ELOZI_API_TOKEN: token });
  assert.equal(config.endpoint.href, DEFAULT_BASE_URL + '/api/agent/mcp');
  assert.equal(config.token, token);
  assert.equal(readBridgeConfig({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: 'https://atendimento.acme.com.br/' }).endpoint.href, 'https://atendimento.acme.com.br/api/agent/mcp');
  assert.equal(readBridgeConfig({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: 'http://localhost:8080' }).endpoint.href, 'http://localhost:8080/api/agent/mcp');
});

test('config: missing or malformed token is rejected without echoing the value', () => {
  assert.throws(() => readBridgeConfig({}), /^Error: Set ELOZI_API_TOKEN/);
  const bad = 'elozi_svc_SECRET-but-short';
  assert.throws(() => readBridgeConfig({ ELOZI_API_TOKEN: bad }), (error) => /^Set ELOZI_API_TOKEN/.test(error.message) && !error.message.includes(bad) && !error.message.includes('SECRET'));
});

test('config: non-HTTPS, credentials, paths, queries and fragments are rejected', () => {
  const token = newToken();
  for (const base of ['http://elozi.je4ndev.com', 'http://192.168.0.10', 'ftp://elozi.je4ndev.com', 'not a url', 'https://user:pass@elozi.je4ndev.com', 'https://elozi.je4ndev.com/api/agent/mcp', 'https://elozi.je4ndev.com/?a=1', 'https://elozi.je4ndev.com/#x']) {
    assert.throws(() => readBridgeConfig({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: base }), (error) => /^ELOZI_BASE_URL/.test(error.message) && !error.message.includes(token), base);
  }
});

test('bridge: initialize instructions, tools/list and tools/call pass through with the Bearer header', async () => {
  const token = newToken();
  const fake = await startFakeElozi({ token });
  const session = await connectThroughBridge(readBridgeConfig({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: fake.baseUrl }));
  try {
    assert.equal(session.client.getInstructions(), INSTRUCTIONS);
    assert.deepEqual(session.client.getServerCapabilities()?.tools, {});
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
    const me = await session.client.callTool({ name: 'elozi_me', arguments: {} });
    assert.equal(me.structuredContent.principal.id, 'svc-test');
    const denied = await session.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'r1', conversationId: 'forbidden' } });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.status, 403);
    await assert.rejects(session.client.callTool({ name: 'elozi_read_conversation', arguments: { requestId: 'r2', conversationId: 'x' } }),
      (error) => error.code === -32602 && !error.message.includes(token));
    assert.ok(fake.requests.length >= 4);
    for (const request of fake.requests.filter((r) => r.method === 'POST')) {
      assert.equal(request.authorization, 'Bearer ' + token);
      assert.equal(request.url, '/api/agent/mcp');
      assert.equal(request.sessionId, undefined);
    }
  } finally { await session.close(); await fake.close(); }
});

test('bridge: a rejected token fails startup with a 401 hint and no token echo', async () => {
  const fake = await startFakeElozi({ token: newToken() });
  const wrong = newToken();
  try {
    await assert.rejects(createBridge(readBridgeConfig({ ELOZI_API_TOKEN: wrong, ELOZI_BASE_URL: fake.baseUrl })),
      (error) => /^Cannot connect to Elozi/.test(error.message) && /401/.test(error.message) && !error.message.includes(wrong));
  } finally { await fake.close(); }
});

test('bridge: endpoint redirects are rejected and the target is never contacted', async () => {
  const token = newToken();
  const target = await startFakeElozi({ token });
  const redirecting = await startFakeElozi({ token, redirectTo: target.baseUrl + '/api/agent/mcp' });
  try {
    await assert.rejects(createBridge(readBridgeConfig({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: redirecting.baseUrl })),
      (error) => /^Cannot connect to Elozi/.test(error.message) && !error.message.includes(token));
    assert.ok(redirecting.requests.length >= 1);
    assert.equal(target.requests.length, 0);
  } finally { await redirecting.close(); await target.close(); }
});

test('cli: stdio end-to-end against the fake endpoint, token never printed', async () => {
  const token = newToken();
  const fake = await startFakeElozi({ token });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ELOZI_API_TOKEN: token, ELOZI_BASE_URL: fake.baseUrl }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr += d; });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'elozi_me'));
    const me = await client.callTool({ name: 'elozi_me', arguments: {} });
    assert.ok(!JSON.stringify(me).includes(token));
  } finally { await client.close(); await fake.close(); }
  assert.ok(!stderr.includes(token));
});

test('cli: invalid base URL, wrong token and token-as-argument exit 1 without echoing the token', async () => {
  const token = newToken();
  const insecure = await runCli({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: 'http://elozi.je4ndev.com' });
  assert.equal(insecure.code, 1);
  assert.match(insecure.stderr, /ELOZI_BASE_URL must use HTTPS/);
  const missing = await runCli({});
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Set ELOZI_API_TOKEN/);
  const fake = await startFakeElozi({ token: newToken() });
  try {
    const rejected = await runCli({ ELOZI_API_TOKEN: token, ELOZI_BASE_URL: fake.baseUrl });
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /Cannot connect to Elozi.*401/);
    for (const output of [insecure, missing, rejected]) assert.ok(!(output.stderr + output.stdout).includes(token));
  } finally { await fake.close(); }
  const asArg = await runCli({}, [token]);
  assert.equal(asArg.code, 1);
  assert.ok(!(asArg.stderr + asArg.stdout).includes(token));
  const version = await runCli({}, ['--version']);
  assert.equal(version.stdout.trim(), '0.1.0');
});
