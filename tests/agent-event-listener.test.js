import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { serviceResponsePolicy } from '../src/service-response-policy.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentEventListener, validateAgentEventConfig, loadAgentEventConfig, stableWakeupKey, createSignedActivation, createAgentEventService } from '../src/agent-event-listener.js';

const TOKEN = 'elozi_svc_' + 'T'.repeat(43), SECRET = 'synthetic_hmac_secret_'.repeat(3);
const cursor = index => 'abcdef012345-' + index.toString(36) + '.' + 'A'.repeat(32);
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const code = expected => error => error.code === expected;
const own = (extra = {}) => ({ id: 'c1', channelId: 'site', departmentId: null, owner: 'agent', agentId: 'a1', status: 'open', version: 1,
  messages: [{ id: 'm1', kind: 'customer', text: 'CANARY_CUSTOMER_TEXT', createdAt: new Date().toISOString() }], ...extra });
const event = (extra = {}) => ({ type: 'conversation.message', conversationId: 'c1', assignedToMe: true, owner: 'agent', kind: 'customer', ...extra });

async function fixture(t, conversations = [own()]) {
  const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'elozi-listener-'));
  const requests = [], activations = [], accepted = new Set(), receipts = new Map(), listeners = [];
  const f = { root, requests, activations, accepted, conversations, events: [], resync: false, waitStatus: 0, waitRetry: null,
    readStatus: 0, activationStatus: 200, activationRetry: null, dropActivation: 0, onRead: null, onMe: null, onInbox: null, inboxCount: 0, waitCount: 0, receiptCount: 0,
    now: Date.now(), principal: { id: 'p1', workspaceId: 'w1', tenantId: 't1', agentId: 'a1', revision: 1, keyRevision: 1,
      active: true, state: 'active', capabilities: ['conversation.read', 'events.read', 'company.read'], channelIds: ['site'], departmentIds: ['unassigned'] },
    agent: { id: 'a1', provider: 'mcp', mode: 'copilot', configured: true, version: 1 } };
  const json = (response, status, value, headers = {}) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json', ...headers }); response.end(JSON.stringify(value)); } };
  const service = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, body: body ? JSON.parse(body) : undefined, headers: request.headers });
    assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
    const route = request.url.replace('/api/service/v1', '');
    if (route === '/me') { f.onMe?.(); return json(response, 200, { principal: f.principal, ...(f.legacyMe ? {} : {agent:f.agent}), ...f.meExtra }); }
    if (route === '/company') return json(response, 200, { company: { id: f.principal.tenantId }, agents: [f.agent], receipt: 'r_company' });
    if (route === '/events/wait') {
      assert.equal(request.method, 'POST'); const input = JSON.parse(body);
      assert.equal(input.timeoutMs, 20000); assert.deepEqual(Object.keys(input).sort(), f.waitCount ? ['cursor', 'timeoutMs'] : ['timeoutMs']);
      if (f.waitStatus) return json(response, f.waitStatus, { error: TOKEN + SECRET }, f.waitRetry ? { 'Retry-After': f.waitRetry } : {});
      const resync = f.waitCount++ === 0 || f.resync; f.resync = false;
      const events = f.events.splice(0);
      return json(response, 200, { events, cursor: cursor(f.waitCount), resync, timedOut: !events.length && !resync });
    }
    if (route === '/inbox') {
      assert.equal(request.method, 'POST'); const input = JSON.parse(body);
      assert.deepEqual(Object.keys(input).sort(), input.cursor === undefined ? ['limit', 'requestId', 'status'] : ['cursor', 'limit', 'requestId', 'status']); assert.equal(input.limit, 50); assert.equal(input.status, 'all');
      const page = await f.onInbox?.(input, f.inboxCount++);
      if (page?.httpStatus) return json(response, page.httpStatus, { error: TOKEN + SECRET });
      if (page) return json(response, 200, page);
      return json(response, 200, { conversations: f.conversations.map(c => ({ id: c.id, owner: c.owner, status: c.status, version: c.version })), receipt: 'r_inbox' });
    }
    if (route.startsWith('/conversations/')) {
      if (f.readStatus) return json(response, f.readStatus, { error: TOKEN });
      const cid = route.split('/').at(-1), conversation = f.conversations.find(c => c.id === cid);
      if (!conversation) return json(response, 404, {});
      const receiptId = 'r_' + ++f.receiptCount;
      receipts.set(receiptId, { id: receiptId, capability: 'conversation.read', state: 'confirmed', stale: false, principalId: f.principal.id,
        workspaceId: f.principal.workspaceId, tenantId: f.principal.tenantId, agentId: f.principal.agentId, revision: f.principal.revision, keyRevision: f.principal.keyRevision,
        context: { conversationId: cid, conversationVersion: conversation.version, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' } });
      const snapshot = structuredClone(conversation); await f.onRead?.(f.receiptCount);
      return json(response, 200, { conversation: snapshot, receipt: receiptId });
    }
    if (route.startsWith('/receipts/')) {
      if (f.receiptConflict > 0) { f.receiptConflict--; f.conversations[0].version++; return json(response, 409, { error: TOKEN }); }
      return json(response, 200, { receipt: receipts.get(route.split('/').at(-1)) });
    }
    assert.fail('Unexpected service route: ' + route);
  });
  // The same receiver verifier serves HTTP transport tests and the deterministic
  // resync unit. Receiver acceptance is not proof that a 100ms network ACK arrived.
  f.recordActivation = (headers, body) => {
    const key = headers['idempotency-key'], timestamp = headers['x-elozi-timestamp'];
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-elozi-signature'], 'sha256=' + createHmac('sha256', SECRET).update(timestamp + '.' + key + '.' + body).digest('hex'));
    assert.equal(headers['x-hub-signature-256'], 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'));
    assert.equal(headers['x-webhook-id'], key);
    assert.equal(headers['x-webhook-event'], 'elozi.agent.wakeup');
    activations.push({ key, body, metadata: JSON.parse(body), at: Date.now() });
    assert.equal(body.includes('CANARY'), false); assert.equal(body.includes(TOKEN), false); assert.equal(body.includes(SECRET), false);
    return key;
  };
  const activation = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(request.url, '/wake'); assert.equal(request.method, 'POST');
    const key = f.recordActivation(request.headers, body);
    if (f.redirect) { response.writeHead(302, { Location: f.redirect }); response.end(); return; }
    if (f.activationStatus !== 200) return json(response, f.activationStatus, { error: TOKEN + SECRET }, f.activationRetry ? { 'Retry-After': f.activationRetry } : {});
    accepted.add(key); // Durable receiver model: acceptance precedes ack, timeout must replay the same key.
    f.onActivation?.();
    if (f.dropActivation-- > 0) return;
    json(response, 200, { accepted: true, idempotencyKey: f.wrongAck ? 'wrong' : key });
  });
  await Promise.all([new Promise(r => service.listen(0, '127.0.0.1', r)), new Promise(r => activation.listen(0, '127.0.0.1', r))]);
  f.config = { endpoint: `http://127.0.0.1:${service.address().port}/api/service/v1`, tokenEnv: 'TEST_ELOZI_TOKEN', checkpointPath: join(root, 'checkpoint.json'),
    allowLoopback: true, activation: { url: `http://127.0.0.1:${activation.address().port}/wake`, secretEnv: 'TEST_ELOZI_HMAC', allowLoopback: true, timeoutMs: 100 } };
  f.env = { TEST_ELOZI_TOKEN: TOKEN, TEST_ELOZI_HMAC: SECRET };
  f.listener = (options = {}) => { const listener = new AgentEventListener(f.config, { env: f.env, now: () => f.now, minPollMs: 0, ...options }); listeners.push(listener); return listener; };
  f.checkpoint = async () => JSON.parse(await readFile(f.config.checkpointPath, 'utf8'));
  f.child = async (extra = []) => {
    const configPath = join(root, 'private-config.json'); await writeFile(configPath, JSON.stringify(f.config), { mode: 0o600 });
    const cli = fileURLToPath(new URL('../scripts/elozi-agent-listen.mjs', import.meta.url));
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, '--config', configPath, '--max-cycles', '1', ...extra], { env: { ...process.env, ...f.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      f.activeChild = child;
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI child timeout')); }, 10000);
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject);
      child.on('close', exitCode => { clearTimeout(timer); resolvePromise({ exitCode, stdout, stderr }); });
    });
  };
  t.after(async () => {
    await Promise.all(listeners.map(listener => listener.close()));
    service.closeAllConnections(); activation.closeAllConnections();
    await Promise.all([new Promise(r => service.close(r)), new Promise(r => activation.close(r))]);
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

 test('v2 validates scoped policy and explicit copilot adapter, never the autonomous label as a grant', async t => {
  for (const tamper of [
    f => { delete f.agent.adapterMode; },
    f => { f.agent.adapterMode = 'autopilot'; },
    f => { f.agent.configured = false; },
    f => { f.principal.capabilities = f.principal.capabilities.filter(cap => cap !== 'reply.send'); },
    f => { f.meExtra.responsePolicy.requiresServerConversationAuthorization = false; },
    f => { f.meExtra.responsePolicy.groups.sendCapable = true; },
    f => { f.meExtra.responsePolicy.conversationPolicy.excludedChannelIds = []; },
    f => { f.meExtra.humanApprovalRequired = true; },
    f => { f.meExtra.apiVersion = 3; },
    f => { f.agent.mode = 'copilot'; }
  ]) {
    const f = await fixture(t, []);
    f.principal.capabilities.push('reply.send');
    f.principal.conversationPolicy = { customerMessagesAfter: '2020-01-01T00:00:00.000Z', excludedChannelIds: ['private'], allowGroups: false };
    const responsePolicy = serviceResponsePolicy(f.principal, f.agent);
    f.agent = { ...f.agent, adapterMode: 'copilot', mode: 'autonomous' };
    f.meExtra = { apiVersion: 2, responsePolicy, humanApprovalRequired: false };
    tamper(f);
    await assert.rejects(f.listener().cycle(), code('IDENTITY_UNAUTHORIZED'));
    assert.equal(f.activations.length, 0);
    assert.equal(f.requests.some(r => /claims|replies|draft|run/.test(r.url)), false);
  }
});

test('explicit v1 copilot metadata remains supported without promoting its legacy human flag', async t => {
  const f = await fixture(t, []); f.meExtra = { apiVersion: 1, humanApprovalRequired: true };
  await f.listener().cycle(); assert.equal(f.activations.length, 0);
});

test('idle inicial e ciclos vazios: zero ativações, só REST read-only e long-poll autenticado de 20s', async t => {
  const f = await fixture(t, []), listener = f.listener();
  for (let i = 0; i < 3; i++) await listener.cycle();
  assert.equal(f.activations.length, 0); assert.equal(f.waitCount, 3); assert.equal((await f.checkpoint()).coverage.complete, true);
  assert.equal(f.requests.some(r => /claims|replies|draft|run/.test(r.url)), false);
  assert.equal(f.requests.filter(r => r.url.endsWith('/inbox')).length, 1);
});

test('ciclos ociosos não gastam a cota de company.read; revogação continua sendo recusada no wait', async t => {
  const f = await fixture(t, []), listener = f.listener();
  await listener.cycle();
  const companyReads = f.requests.filter(r => r.url.endsWith('/company')).length;
  await listener.cycle(); await listener.cycle();
  assert.equal(f.requests.filter(r => r.url.endsWith('/company')).length, companyReads);
  assert.equal(f.activations.length, 0);
  f.waitStatus = 401;
  await assert.rejects(listener.cycle(), code('SERVICE_HTTP_401'));
  assert.equal((await f.checkpoint()).stopped, 'IDENTITY_REVOKED_OR_CHANGED');
});

// Logical reconciliation/batching tests need a confirmed sender ACK, not merely
// receiver acceptance before a 100ms loopback deadline. Keep service/receipt HTTP
// real and run the same HMAC verifier; dedicated transport tests keep real /wake.
function confirmedActivationListener(f) {
  return f.listener({ fetchImpl: async (url, init) => {
    if (String(url) !== f.config.activation.url) return fetch(url, init);
    assert.equal(init.method, 'POST');
    const key = f.recordActivation(Object.fromEntries(new Headers(init.headers)), init.body);
    f.accepted.add(key);
    return Response.json({ accepted: true, idempotencyKey: key });
  } });
}

test('resync inicial reconcilia toda conversa própria recuperável; webhook assinado só metadata e recibos read-only', async t => {
  const f = await fixture(t, [own(), own({ id: 'c2', status: 'pending', messages: [{ id: 'm2', kind: 'customer', text: 'CANARY_TWO' }] })]);
  const listener = confirmedActivationListener(f);
  await listener.cycle();
  assert.equal(f.activations.length, 2); assert.equal(f.accepted.size, 2);
  assert.deepEqual(Object.keys(f.activations[0].metadata).sort(), ['agentId','channelId','conversationId','customerMessageId','departmentId','principalId','schemaVersion','tenantId','type','version','workspaceId']);
  assert.equal(Object.keys((await f.checkpoint()).pending).length, 0);
  assert.ok(f.requests.some(r => r.url.includes('/receipts/')));
  const stateText = await readFile(f.config.checkpointPath, 'utf8'); assert.equal(stateText.includes('CANARY'), false); assert.equal(stateText.includes(TOKEN), false);
});

test('duplicatas e coalescência: uma chave por última mensagem pública do cliente, não por evento/versão', async t => {
  const f = await fixture(t), listener = f.listener(); await listener.cycle();
  f.events.push(event(), event()); await listener.cycle(); assert.equal(f.activations.length, 1);
  f.conversations[0].messages.push({ id: 'm2', kind: 'customer', text: 'CANARY_2' }, { id: 'm3', kind: 'customer', text: 'CANARY_3' }); f.conversations[0].version++;
  f.events.push(event({ messageId: 'm2' }), event({ messageId: 'm3' })); await listener.cycle();
  assert.equal(f.activations.length, 2); assert.equal(f.activations[1].metadata.customerMessageId, 'm3'); assert.notEqual(f.activations[0].key, f.activations[1].key);
});

test('voto na enquete do agente (kind poll_vote) é entrada do contato e acorda a ativação', async t => {
  const f = await fixture(t), listener = f.listener(); await listener.cycle();
  f.conversations[0].messages.push({ id: 'poll1', kind: 'agent', text: '[Enquete] Confirmar? · Sim / Não' }, { id: 'vote1', kind: 'poll_vote', text: 'Sim', pollMessageId: 'poll1', selectedOptions: ['Sim'] }); f.conversations[0].version++;
  f.events.push(event({ messageId: 'vote1', kind: 'poll_vote' })); await listener.cycle();
  assert.equal(f.activations.length, 2); assert.equal(f.activations[1].metadata.customerMessageId, 'vote1');
});

test('resync por evento perdido recupera pendência, sem reativar mensagem já confirmada', async t => {
  const f = await fixture(t), listener = f.listener(); await listener.cycle();
  f.conversations.push(own({ id: 'missed', messages: [{ id: 'missed_m', kind: 'customer' }] })); f.resync = true;
  await listener.cycle(); assert.equal(f.activations.length, 2); assert.equal(f.activations[1].metadata.conversationId, 'missed');
});

for (const [label, extra] of [['fila', { owner: 'queue', agentId: null }], ['humano', { owner: 'human' }], ['outro agente', { agentId: 'other' }],
  ['encerrado', { status: 'closed' }], ['canal alheio', { channelId: 'other' }], ['departamento alheio', { departmentId: 'vip' }],
  ['cliente já respondido', { messages: [{ id: 'm1', kind: 'customer' }, { id: 'reply1', kind: 'agent' }] }]]) {
  test('nunca ativa: ' + label, async t => { const f = await fixture(t, [own(extra)]); await f.listener().cycle(); assert.equal(f.activations.length, 0); });
}

for (const pointer of [event({ left: true }), event({ type: 'conversation.removed' }), event({ owner: 'human' }), event({ status: 'closed' }), event({ assignedToMe: false })]) {
  test('ponteiro cancela pendência durable: ' + JSON.stringify(pointer), async t => {
    const f = await fixture(t), listener = f.listener(); f.dropActivation = 1; await listener.cycle();
    assert.equal(Object.keys((await f.checkpoint()).pending).length, 1);
    // A background wait may already hold an older empty response. Fresh read authority must still cancel the real change.
    if (pointer.left || pointer.type === 'conversation.removed') f.readStatus = 403;
    // The event factory also supplies owner:'agent': it must not mask status/assignment changes in the authoritative DTO.
    if (pointer.owner) f.conversations[0].owner = pointer.owner;
    if (pointer.status) f.conversations[0].status = pointer.status;
    if (pointer.assignedToMe === false) f.conversations[0].agentId = 'other';
    f.conversations[0].version++;
    if (pointer.status === 'closed') assert.equal(f.conversations[0].status, 'closed');
    if (pointer.assignedToMe === false) assert.equal(f.conversations[0].agentId, 'other');
    f.events.push(pointer); f.now += 5000; await listener.cycle();
    assert.equal(f.activations.length, 1); assert.equal(Object.keys((await f.checkpoint()).pending).length, 0);
  });
}

test('takeover humano durante awaits de recibo/identidade é capturado pela releitura final', async t => {
  const f = await fixture(t); let armed = false;
  f.onRead = count => { if (count === 3) armed = true; };
  f.onMe = () => { if (armed) f.conversations[0].owner = 'human'; };
  await f.listener().cycle(); assert.equal(f.activations.length, 0); assert.equal(Object.keys((await f.checkpoint()).pending).length, 0);
});

test('identidade muda durante leitura aguardada: bloqueia, cancela pending e não avança cursor', async t => {
  const f = await fixture(t), listener = f.listener();
  f.onRead = async () => { await sleep(5); f.principal.revision++; f.onRead = null; };
  await assert.rejects(listener.cycle(), code('IDENTITY_CHANGED')); assert.equal(f.activations.length, 0);
  const state = await f.checkpoint(); assert.equal(state.cursor, null); assert.deepEqual(state.pending, {}); assert.equal(state.stopped, 'IDENTITY_REVOKED_OR_CHANGED');
});

test('revogação na espera encerra sem retry nem modelo', async t => {
  const f = await fixture(t), listener = f.listener(); await listener.cycle();
  f.waitStatus = 401; await assert.rejects(listener.run({ maxCycles: 1 }), code('SERVICE_HTTP_401'));
  assert.equal(f.activations.length, 1); assert.deepEqual((await f.checkpoint()).pending, {});
});

test('troca de identidade no restart não herda checkpoint/pending de outra identidade', async t => {
  const f = await fixture(t), first = f.listener(); f.dropActivation = 1; await first.cycle(); await first.close();
  f.principal.id = 'p_other'; await assert.rejects(f.listener().initialize(), code('IDENTITY_CHANGED')); assert.equal(f.activations.length, 1);
});

test('timeout aceito no receptor + restart: retry com mesma chave, uma aceitação lógica', async t => {
  const f = await fixture(t), first = f.listener(); f.dropActivation = 1; await first.cycle();
  const saved = await f.checkpoint(); assert.equal(saved.pending.c1.attempts, 1); assert.equal(saved.cursor, cursor(1)); assert.equal(f.accepted.size, 1);
  assert.equal(f.activations.length, 1);
  assert.equal(saved.pending.c1.key, f.activations[0].key);
  assert.deepEqual(saved.completed, {}, 'receiver acceptance without sender ACK must not complete the durable ledger');
  await first.close(); f.now += 5000; const second = f.listener(); await second.cycle();
  assert.equal(f.activations.length, 2); assert.equal(f.activations[0].key, f.activations[1].key); assert.equal(f.accepted.size, 1);
  const confirmed = await f.checkpoint();
  assert.deepEqual(confirmed.pending, {});
  assert.equal(confirmed.completed.c1.key, saved.pending.c1.key, 'only the matching sender ACK completes the replayed key');
  await second.close(); await f.listener().cycle(); assert.equal(f.activations.length, 2, 'confirmed restart never repeats');
});

test('retry bound durable: três tentativas, mesma chave, falha explícita sem quarta nem reset no restart', async t => {
  const f = await fixture(t), listener = f.listener(); f.activationStatus = 503;
  await listener.cycle(); f.now += 5000; await listener.cycle(); f.now += 5000;
  await assert.rejects(listener.cycle(), code('ACTIVATION_RETRIES_EXHAUSTED')); assert.equal(f.activations.length, 3); assert.equal(new Set(f.activations.map(a => a.key)).size, 1);
  await listener.close(); f.now += 5000; await assert.rejects(f.listener().cycle(), code('ACTIVATION_RETRIES_EXHAUSTED')); assert.equal(f.activations.length, 3);
});

test('Retry-After do webhook respeitado; backoff sem LLM ou corpo bruto no erro', async t => {
  const f = await fixture(t), listener = f.listener(); f.activationStatus = 429; f.activationRetry = '5';
  await listener.cycle(); f.now += 4999; await listener.cycle(); assert.equal(f.activations.length, 1);
  f.now += 1; f.activationStatus = 200; await listener.cycle(); assert.equal(f.activations.length, 2);
});

test('serviço indisponível usa retry-after/backoff e no máximo três falhas, sem cursor/modelo', async t => {
  const f = await fixture(t, []), delays = []; f.waitStatus = 429; f.waitRetry = '2';
  const listener = new AgentEventListener(f.config, { env: f.env, minPollMs: 0, sleep: async ms => delays.push(ms) });
  try { await assert.rejects(listener.run({ maxCycles: 1 }), code('SERVICE_HTTP_429')); } finally { await listener.close(); }
  assert.deepEqual(delays, [2000, 2000]); assert.equal(f.activations.length, 0); assert.equal((await f.checkpoint()).cursor, null);
});

test('limite inbox sem paginação: 50 ou mais não finge cobertura completa e não avança cursor', async t => {
  const f = await fixture(t, Array.from({ length: 50 }, (_, i) => own({ id: 'c' + i }))), listener = f.listener();
  await assert.rejects(listener.cycle(), code('INBOX_COVERAGE_UNPROVEN_50')); assert.equal(f.activations.length, 0); assert.equal((await f.checkpoint()).cursor, null);
});

const inboxRow = (cid, extra = {}) => ({ id: cid, owner: 'human', status: 'closed', version: 1, ...extra });
const inventorySnapshot = 'a'.repeat(64);
const inventoryPage = (conversations, nextCursor = null, snapshot = inventorySnapshot) => ({ conversations, snapshot, nextCursor, receipt: 'r_inbox' });

test('inbox paginado aceita EOF exato em 50 e só lê conversas depois de validar todas as páginas', async t => {
  const conversations = Array.from({ length: 125 }, (_, index) => own({ id: 'c' + index, owner: index === 0 || index === 124 ? 'agent' : 'human' }));
  const f = await fixture(t, conversations), listener = f.listener();
  f.onInbox = (input, index) => {
    assert.equal(input.cursor, index === 0 ? undefined : 'page_' + index);
    return inventoryPage(conversations.slice(index * 50, (index + 1) * 50).map(c => inboxRow(c.id, { owner: c.owner, status: c.status })), index < 2 ? 'page_' + (index + 1) : null);
  };
  f.onRead = () => assert.equal(f.inboxCount, 3, 'no reads or pending materialization before complete pagination');
  await listener.cycle();
  assert.equal(f.activations.length, 2); assert.equal(f.inboxCount, 3);
  assert.equal((await f.checkpoint()).coverage.visibleCount, 125);
  assert.equal((await f.checkpoint()).coverage.snapshot, inventorySnapshot);
  assert.equal(Object.keys((await f.checkpoint()).readQueue).length, 0);
  const exact = await fixture(t, []);
  exact.onInbox = () => inventoryPage(Array.from({ length: 50 }, (_, index) => inboxRow('exact_' + index)));
  await exact.listener().cycle(); assert.equal((await exact.checkpoint()).coverage.visibleCount, 50);
});

for (const [label, second] of [
  ['snapshot trocado', () => inventoryPage([inboxRow('last')], null, 'b'.repeat(64))],
  ['snapshot inválido', () => inventoryPage([inboxRow('last')], null, 'short')],
  ['snapshot ausente', () => ({ conversations: [inboxRow('last')], nextCursor: null })],
  ['nextCursor ausente', () => ({ conversations: [inboxRow('last')], snapshot: inventorySnapshot })],
  ['cursor repetido', () => inventoryPage([inboxRow('last')], 'page_1')],
  ['cursor vazio', () => inventoryPage([inboxRow('last')], '')],
  ['cursor não string', () => inventoryPage([inboxRow('last')], 1)],
  ['ID repetido', () => inventoryPage([inboxRow('first_0')])],
  ['página grande', () => inventoryPage(Array.from({ length: 51 }, (_, index) => inboxRow('extra_' + index)))],
  ['continuação vazia', () => inventoryPage([], 'page_2')],
  ['DTO inválido tardio', () => inventoryPage([inboxRow('last', { version: 0 })])],
]) {
  test('inbox incompleto falha fechado sem trabalho/cursor: ' + label, async t => {
    const f = await fixture(t), listener = f.listener();
    f.onInbox = (_, index) => index === 0
      ? inventoryPage(Array.from({ length: 50 }, (_, item) => inboxRow('first_' + item, { owner: 'agent', status: 'open' })), 'page_1') : second();
    await assert.rejects(listener.cycle(), code('RESPONSE_INVALID'));
    const state = await f.checkpoint();
    assert.equal(f.activations.length, 0); assert.equal(f.receiptCount, 0); assert.equal(state.cursor, null);
    assert.deepEqual(state.pending, {}); assert.deepEqual(state.readQueue, {}); assert.equal(state.coverage, null);
    assert.equal(listener.snapshot.cursor, null); assert.deepEqual(listener.snapshot.readQueue, {});
  });
}

test('inbox expira em 120s inclusive durante a autorização final, sem ativar nem persistir cobertura', async t => {
  for (const phase of ['page', 'final']) {
    const f = await fixture(t), listener = f.listener(); let returned = false, postPageAuthorizations = 0;
    f.onInbox = () => { returned = true; if (phase === 'page') f.now += 120000; return inventoryPage([inboxRow('c1', { owner: 'agent', status: 'open' })]); };
    f.onMe = () => { if (phase === 'final' && returned && ++postPageAuthorizations === 2) f.now += 120000; };
    await assert.rejects(listener.cycle(), code('INBOX_SNAPSHOT_EXPIRED'));
    assert.equal(f.activations.length, 0); assert.equal(f.receiptCount, 0); assert.equal((await f.checkpoint()).coverage, null);
    assert.deepEqual(listener.snapshot.readQueue, {});
  }
});

test('409 no snapshot após reinício reautoriza e reinicia na página 1, sem revogar identidade nem repetir trabalho parcial', async t => {
  const f = await fixture(t, []), listener = f.listener(); let failPage = true;
  f.onInbox = input => {
    if (!input.cursor) return inventoryPage([inboxRow('first')], 'page_1');
    if (failPage) { failPage = false; return { httpStatus: 409 }; }
    return inventoryPage([inboxRow('last')]);
  };
  await assert.rejects(listener.cycle(), code('INBOX_SNAPSHOT_EXPIRED'));
  assert.equal((await f.checkpoint()).stopped, undefined); assert.equal((await f.checkpoint()).cursor, null);
  await listener.cycle();
  assert.equal(f.requests.filter(r => r.url.endsWith('/inbox') && r.body.cursor === undefined).length, 2);
  assert.equal((await f.checkpoint()).coverage.visibleCount, 2); assert.equal(f.activations.length, 0);
});

test('mudança de escopo na segunda página bloqueia antes de qualquer leitura ou wakeup', async t => {
  const f = await fixture(t), listener = f.listener();
  f.onInbox = (_, index) => {
    if (index === 0) return inventoryPage([inboxRow('first', { owner: 'agent', status: 'open' })], 'page_1');
    f.principal.revision++; return inventoryPage([inboxRow('last')]);
  };
  await assert.rejects(listener.cycle(), code('IDENTITY_CHANGED'));
  assert.equal(f.receiptCount, 0); assert.equal(f.activations.length, 0); assert.equal((await f.checkpoint()).cursor, null);
  assert.deepEqual((await f.checkpoint()).readQueue, {});
});

test('fila de 125 contextos fica durável e consome no máximo 50 wakeups por ciclo', async t => {
  const conversations = Array.from({ length: 125 }, (_, index) => own({ id: 'queued_' + index }));
  const f = await fixture(t, conversations), listener = confirmedActivationListener(f);
  f.onInbox = input => {
    const page = input.cursor ? Number(input.cursor.slice(5)) : 0;
    return inventoryPage(conversations.slice(page * 50, (page + 1) * 50).map(c => inboxRow(c.id, { owner: c.owner, status: c.status })), page < 2 ? 'page_' + (page + 1) : null);
  };
  await listener.cycle(); assert.equal(f.activations.length, 50); assert.equal(Object.keys((await f.checkpoint()).readQueue).length, 75);
  assert.equal(Object.keys((await f.checkpoint()).completed).length, 50);
  assert.deepEqual((await f.checkpoint()).pending, {});
  await listener.cycle(); assert.equal(f.activations.length, 100); assert.equal(Object.keys((await f.checkpoint()).readQueue).length, 25);
  assert.equal(Object.keys((await f.checkpoint()).completed).length, 100);
  assert.deepEqual((await f.checkpoint()).pending, {});
  await listener.cycle(); assert.equal(f.activations.length, 125); assert.equal(Object.keys((await f.checkpoint()).readQueue).length, 0);
  assert.equal(Object.keys((await f.checkpoint()).completed).length, 125);
  assert.deepEqual((await f.checkpoint()).pending, {});
  assert.equal(f.inboxCount, 3); assert.equal(f.accepted.size, 125);
});

test('fila de leitura sobrevive ao restart com o ledger concluído e as mesmas chaves', async t => {
  const conversations = Array.from({ length: 51 }, (_, index) => own({ id: 'restart_' + index }));
  const f = await fixture(t, conversations), first = f.listener();
  f.onInbox = input => inventoryPage(conversations.slice(input.cursor ? 50 : 0, input.cursor ? 100 : 50)
    .map(c => inboxRow(c.id, { owner: c.owner, status: c.status })), input.cursor ? null : 'page_1');
  await first.cycle(); const keys = f.activations.map(a => a.key); await first.close();
  assert.equal(Object.keys((await f.checkpoint()).readQueue).length, 1);
  await f.listener().cycle(); assert.equal(f.activations.length, 51); assert.equal(f.accepted.size, 51);
  assert.deepEqual(f.activations.slice(0, 50).map(a => a.key), keys);
});

async function controlledWaitFixture(t, count = 125) {
  const conversations = Array.from({ length: count }, (_, index) => own({ id: 'controlled_' + index })), f = await fixture(t, conversations);
  const waits = [], calls = [], receipts = new Map(), delays = [];
  let active = 0, maximum = 0, aborted = 0, started;
  const waitStarted = new Promise(resolvePromise => { started = resolvePromise; });
  const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const listener = f.listener({ minPollMs: 7, sleep: async ms => { delays.push(ms); f.now += ms; }, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/me')) return response({ principal: f.principal, agent: f.agent });
    if (path.endsWith('/events/wait')) {
      const input = JSON.parse(init.body); assert.equal(input.timeoutMs, 20000); calls.push(input);
      const index = calls.length;
      if (index === 1) return response({ events: [], cursor: cursor(index), resync: true, timedOut: false });
      active++; maximum = Math.max(maximum, active); assert.equal(active, 1, 'at most one outstanding long poll');
      return new Promise((resolvePromise, reject) => {
        let settled = false;
        const finish = (value, error) => {
          if (settled) return; settled = true; active--; init.signal.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolvePromise(response({ events: value, cursor: cursor(index), resync: false, timedOut: false }));
        };
        const onAbort = () => { aborted++; finish(null, new DOMException('synthetic stop', 'AbortError')); };
        waits.push({ resolve: events => finish(events), signal: init.signal });
        if (init.signal.aborted) onAbort(); else init.signal.addEventListener('abort', onAbort, { once: true });
        started();
      });
    }
    if (path.endsWith('/inbox')) {
      const input = JSON.parse(init.body), page = input.cursor ? Number(input.cursor.slice(5)) : 0;
      return response(inventoryPage(conversations.slice(page * 50, (page + 1) * 50)
        .map(c => inboxRow(c.id, { owner: c.owner, status: c.status })), (page + 1) * 50 < count ? 'page_' + (page + 1) : null));
    }
    if (path.includes('/conversations/')) {
      const cid = path.split('/').at(-1), conversation = conversations.find(c => c.id === cid), receiptId = 'controlled_read_' + ++f.receiptCount;
      assert.ok(conversation); const snapshot = structuredClone(conversation);
      receipts.set(receiptId, { state: 'confirmed', stale: false, capability: 'conversation.read', principalId: f.principal.id,
        workspaceId: f.principal.workspaceId, tenantId: f.principal.tenantId, agentId: f.principal.agentId, revision: f.principal.revision, keyRevision: f.principal.keyRevision,
        context: { conversationId: cid, conversationVersion: snapshot.version, channelId: snapshot.channelId, departmentId: snapshot.departmentId ?? 'unassigned' } });
      await f.onRead?.(f.receiptCount, cid);
      return response({ conversation: snapshot, receipt: receiptId });
    }
    if (path.includes('/receipts/')) return response({ receipt: receipts.get(path.split('/').at(-1)) });
    assert.equal(path, '/wake');
    const key = init.headers['Idempotency-Key']; f.activations.push({ key, metadata: JSON.parse(init.body) }); f.accepted.add(key);
    return response({ accepted: true, idempotencyKey: key });
  } });
  return { f, listener, waits, calls, delays, waitStarted, get active() { return active; }, get maximum() { return maximum; }, get aborted() { return aborted; } };
}

test('um long poll pendente de 20s não bloqueia 125 contextos em três ciclos de lotes50 com pacing', { timeout: 10000 }, async t => {
  const c = await controlledWaitFixture(t);
  c.f.onRead = count => { if (count <= 100) assert.equal(c.listener.snapshot.cursor, null, 'uncommitted event cursor stays private'); };
  for (let index = 0; index < 3; index++) {
    await c.listener.cycle(); assert.equal(c.f.activations.length, Math.min(125, (index + 1) * 50));
    assert.equal(c.calls.length, 2, 'the same unresolved wait remains in flight across batches');
  }
  assert.deepEqual(c.delays, [7, 7, 7]); assert.equal(c.active, 1); assert.equal(c.maximum, 1);
  assert.equal(c.listener.snapshot.cursor, cursor(1)); assert.equal((await c.f.checkpoint()).cursor, cursor(1));
  await c.listener.close(); assert.equal(c.active, 0); assert.equal(c.aborted, 1);
});

test('evento pronto durante leituras locais é persistido antes do drain seguinte, sem novo wait antes do commit', { timeout: 10000 }, async t => {
  const c = await controlledWaitFixture(t); await c.listener.cycle(); let resolved = false;
  c.f.onRead = (_, cid) => {
    if (!resolved && cid === 'controlled_50') {
      resolved = true; c.waits[0].resolve([event({ conversationId: 'controlled_55', left: true })]);
      assert.equal(c.listener.snapshot.cursor, cursor(1)); assert.equal(c.calls.length, 2);
    }
  };
  await c.listener.cycle();
  assert.equal(c.f.activations.length, 99); assert.equal(c.f.activations.some(a => a.metadata.conversationId === 'controlled_55'), false);
  assert.equal((await c.f.checkpoint()).cursor, cursor(2)); assert.equal(c.calls.length, 3);
  assert.equal(c.calls[2].cursor, cursor(2)); assert.equal(c.active, 1); assert.equal(c.maximum, 1);
});

test('resultado pronto reautoriza antes de qualquer drain de fila local', { timeout: 10000 }, async t => {
  const c = await controlledWaitFixture(t); await c.listener.cycle(); c.f.principal.revision++;
  c.waits[0].resolve([event({ conversationId: 'controlled_50' })]);
  await assert.rejects(c.listener.cycle(), code('IDENTITY_CHANGED'));
  assert.equal(c.f.activations.length, 50); assert.equal(c.calls.length, 2);
  assert.deepEqual((await c.f.checkpoint()).readQueue, {}); assert.equal((await c.f.checkpoint()).cursor, cursor(1));
});

test('close cancela a espera normal sem fila e liquida a rejeição antes de liberar o checkpoint', { timeout: 10000 }, async t => {
  const c = await controlledWaitFixture(t, 0); await c.listener.cycle();
  const cycling = c.listener.cycle(), rejected = assert.rejects(cycling, code('STOPPED'));
  await c.waitStarted; await c.listener.close(); await rejected;
  assert.equal(c.active, 0); assert.equal(c.aborted, 1); assert.equal(c.maximum, 1); assert.equal(c.calls.length, 2);
  await assert.rejects(lstat(c.f.config.checkpointPath + '.lock'), error => error.code === 'ENOENT');
});

test('masterAbort cancela o único waiter em background e impede novos wakeups', { timeout: 10000 }, async t => {
  const c = await controlledWaitFixture(t), controller = new AbortController();
  await c.listener.cycle({ signal: controller.signal }); controller.abort();
  await assert.rejects(c.listener.cycle({ signal: controller.signal }), code('STOPPED'));
  await c.listener.close(); assert.equal(c.active, 0); assert.equal(c.aborted, 1); assert.equal(c.calls.length, 2);
  assert.equal(c.f.activations.length, 50); assert.equal((await c.f.checkpoint()).cursor, cursor(1));
});

test('checkpoint antigo sem fila continua compatível; fila inválida falha fechada', async t => {
  const f = await fixture(t, []), first = f.listener(); await first.cycle(); await first.close();
  const stored = await f.checkpoint(); delete stored.readQueue;
  await writeFile(f.config.checkpointPath, JSON.stringify(stored), { mode: 0o600 });
  const compatible = f.listener(); await compatible.cycle(); await compatible.close();
  stored.readQueue = { c1: 'not-metadata' };
  await writeFile(f.config.checkpointPath, JSON.stringify(stored), { mode: 0o600 });
  await assert.rejects(f.listener().initialize(), code('CHECKPOINT_INVALID'));
});

test('inventário aceita EOF em 100 mil IDs/2000 páginas, mas recusa continuação e mais de 10 mil candidatos', async t => {
  for (const [count, eligible, expected] of [[100000, false, null], [100001, false, 'INBOX_COVERAGE_EXCEEDED'], [10001, true, 'PENDING_COVERAGE_EXCEEDED']]) {
    const f = await fixture(t, []); let pages = 0;
    const listener = new AgentEventListener(f.config, { env: f.env, now: () => f.now, minPollMs: 0,
      fetchImpl: async (url, init) => {
        const route = new URL(url).pathname;
        const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        if (route.endsWith('/me')) return response({ principal: f.principal, agent: f.agent });
        if (route.endsWith('/events/wait')) return response({ events: [], cursor: cursor(1), resync: true, timedOut: false });
        assert.ok(route.endsWith('/inbox'), 'bounded inventory must not read or activate any conversation');
        const input = JSON.parse(init.body), page = input.cursor === undefined ? 0 : Number(input.cursor.slice(5)), offset = page * 50;
        pages++;
        return response(inventoryPage(Array.from({ length: Math.min(50, count - offset) }, (_, index) => inboxRow('bounded_' + (offset + index),
          eligible ? { owner: 'agent', status: 'open' } : {})), offset + 50 < count ? 'page_' + (page + 1) : null));
      } });
    try {
      if (expected) {
        await assert.rejects(listener.cycle(), code(expected));
        assert.equal(listener.snapshot.cursor, null); assert.equal(listener.snapshot.coverage, null);
        assert.deepEqual(listener.snapshot.pending, {}); assert.deepEqual(listener.snapshot.readQueue, {});
      } else {
        await listener.cycle(); assert.equal(listener.snapshot.coverage.visibleCount, 100000); assert.equal(listener.snapshot.coverage.pages, 2000);
      }
      assert.ok(pages <= 2000); assert.equal(f.activations.length, 0);
    } finally { await listener.close(); }
  }
});

test('checkpoint corrompido e destino trocado falham fechado; um consumidor por checkpoint', async t => {
  const f = await fixture(t, []), listener = f.listener(); await listener.initialize();
  await assert.rejects(f.listener().initialize(), code('CHECKPOINT_LOCKED')); await listener.close();
  await writeFile(f.config.checkpointPath, '{invalid', { mode: 0o600 }); await assert.rejects(f.listener().initialize(), code('PRIVATE_FILE_INVALID'));
  await rm(f.config.checkpointPath); const valid = f.listener(); await valid.cycle(); await valid.close();
  const modified = new AgentEventListener({ ...f.config, activation: { ...f.config.activation, url: f.config.activation.url + '/other' } }, { env: f.env });
  await assert.rejects(modified.initialize(), code('CHECKPOINT_INVALID'));
});

test('config privada: chaves/segredos literais, paths, localhost implícito e endpoints inválidos recusados', async t => {
  const f = await fixture(t, []);
  for (const config of [{ ...f.config, token: TOKEN }, { ...f.config, checkpointPath: 'relative.json' }, { ...f.config, endpoint: f.config.endpoint + '?q=secret' },
    { ...f.config, allowLoopback: false }, { ...f.config, activation: { ...f.config.activation, url: 'http://localhost:123/wake' } },
    { ...f.config, activation: { ...f.config.activation, secret: SECRET } }, { ...f.config, activation: { ...f.config.activation, url: 'https://operator.example/wake#secret' } }]) {
    assert.throws(() => validateAgentEventConfig(config));
  }
  const path = join(f.root, 'oversize.json'); await writeFile(path, ' '.repeat(16385), { mode: 0o600 }); await assert.rejects(loadAgentEventConfig(path), code('PRIVATE_FILE_INVALID'));
  assert.throws(() => createAgentEventService(f.config, { env: { TEST_ELOZI_TOKEN: 'literal-invalid' } }), code('CREDENTIAL_UNAVAILABLE'));
});

test('adapter isolado permite somente URL privada exata, redirect:error, timeout, metadata whitelist e ack da mesma chave', async t => {
  const f = await fixture(t, []), captured = [];
  const activation = createSignedActivation(f.config, { env: f.env, fetchImpl: async (target, init) => { captured.push({ target, init }); return new Response(JSON.stringify({ accepted: true, idempotencyKey: init.headers['Idempotency-Key'] })); } });
  const metadata = { schemaVersion: 1, type: 'elozi.agent.wakeup', principalId: 'p1', workspaceId: 'w1', tenantId: 't1', agentId: 'a1',
    conversationId: 'c1', customerMessageId: 'm1', version: 1, channelId: 'site', departmentId: null }, key = 'wake_' + 'a'.repeat(64);
  await activation(metadata, key); assert.equal(captured[0].target, f.config.activation.url); assert.equal(captured[0].init.redirect, 'error'); assert.ok(captured[0].init.signal);
  await assert.rejects(activation({ ...metadata, text: 'CANARY' }, key), code('ACTIVATION_METADATA_INVALID'));
  f.redirect = f.config.endpoint + '/replies'; const real = createSignedActivation(f.config, { env: f.env });
  await assert.rejects(real(metadata, key), code('ACTIVATION_UNCONFIRMED')); assert.equal(f.requests.length, 0, 'redirect never followed');
});

test('recibo 409 por versão concorrente relê até três vezes, sem confundir com revogação nem duplicar ativação', async t => {
  const f = await fixture(t); f.receiptConflict = 1; await f.listener().cycle();
  assert.equal(f.activations.length, 1); assert.equal(f.activations[0].metadata.version, 2); assert.equal((await f.checkpoint()).stopped, undefined);
});

test('troca de identidade DURANTE a última releitura também cancela antes do webhook', async t => {
  const f = await fixture(t), listener = f.listener();
  f.onRead = count => { if (count === 2) f.principal.revision++; };
  await assert.rejects(listener.cycle(), code('IDENTITY_CHANGED')); assert.equal(f.activations.length, 0); assert.equal((await f.checkpoint()).cursor, null);
});

test('chave estável vincula identidade+tenant+conversa+cliente, não relógio/versão do atendimento', () => {
  const identity = { principalId: 'p', workspaceId: 'w', tenantId: 't', agentId: 'a', revision: 1, keyRevision: 1 };
  const key = stableWakeupKey(identity, 'c', 'm'); assert.equal(key, stableWakeupKey({ ...identity }, 'c', 'm'));
  for (const changed of [{ ...identity, tenantId: 'other' }, { ...identity, principalId: 'other' }, { ...identity, keyRevision: 2 }]) assert.notEqual(key, stableWakeupKey(changed, 'c', 'm'));
  assert.notEqual(key, stableWakeupKey(identity, 'c', 'm2'));
});

test('CLI child real: resync ativa com assinatura, persistência e restart idle não duplica; logs sem segredos', async t => {
  const f = await fixture(t); const first = await f.child(); assert.equal(first.exitCode, 0, first.stderr); assert.equal(JSON.parse(first.stdout).cycles, 1); assert.equal(f.activations.length, 1);
  const second = await f.child(); assert.equal(second.exitCode, 0, second.stderr); assert.equal(f.activations.length, 1);
  assert.equal((first.stdout + first.stderr + second.stdout + second.stderr).includes(TOKEN), false);
  assert.equal((first.stdout + second.stdout).includes('CANARY'), false);
  await assert.rejects(lstat(f.config.checkpointPath + '.lock'), error => error.code === 'ENOENT');
});

test('CLI child real: timeout/restart preserva chave e retry, receptor aceita uma vez', async t => {
  const f = await fixture(t); f.dropActivation = 1; const first = await f.child(); assert.equal(first.exitCode, 0, first.stderr);
  assert.equal((await f.checkpoint()).pending.c1.attempts, 1); await sleep(1100);
  const second = await f.child(); assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(f.activations.length, 2); assert.equal(f.accepted.size, 1); assert.equal(f.activations[0].key, f.activations[1].key);
});

test('CLI child real: idle zero wakeups e revogação/erro hostil saem sem credencial/corpo bruto', async t => {
  const f = await fixture(t, []); const idle = await f.child(); assert.equal(idle.exitCode, 0, idle.stderr); assert.equal(f.activations.length, 0);
  f.waitStatus = 401; const revoked = await f.child(); assert.equal(revoked.exitCode, 1); assert.equal(JSON.parse(revoked.stderr).code, 'SERVICE_HTTP_401');
  assert.equal(revoked.stderr.includes(TOKEN), false); assert.equal(revoked.stderr.includes(SECRET), false);
});

test('CLI SIGKILL após aceitação recupera lock/cursor/pending duráveis e repete mesma chave, sem novo efeito lógico', async t => {
  const f = await fixture(t); f.dropActivation = 1;
  f.onActivation = () => { f.onActivation = null; f.activeChild.kill('SIGKILL'); };
  const killed = await f.child(); assert.notEqual(killed.exitCode, 0);
  const saved = await f.checkpoint(); assert.equal(saved.cursor, cursor(1)); assert.equal(saved.pending.c1.attempts, 1);
  assert.equal((await lstat(f.config.checkpointPath + '.lock')).isFile(), true);
  const replayed = await f.child(); assert.equal(replayed.exitCode, 0, replayed.stderr);
  assert.equal(f.activations.length, 2); assert.equal(f.accepted.size, 1); assert.equal(f.activations[0].key, f.activations[1].key);
});

test('IDs legais __proto__/constructor são persistidos como propriedades próprias e não poluem ou perdem dedupe', async t => {
  const f = await fixture(t, [own({ id: '__proto__' }), own({ id: 'constructor' })]), first = f.listener(); await first.cycle();
  const saved = await f.checkpoint(); assert.equal(Object.hasOwn(saved.completed, '__proto__'), true); assert.equal(Object.hasOwn(saved.completed, 'constructor'), true);
  await first.close(); await f.listener().cycle(); assert.equal(f.activations.length, 2);
  assert.equal(Object.prototype.key, undefined);
});

for (const [label, change] of [['key revision', f => { f.principal.keyRevision++; }], ['agent version', f => { f.agent.version++; }]]) {
  test('mudança explícita encerra: ' + label, async t => {
    const f = await fixture(t), listener = f.listener(); await listener.cycle(); change(f);
    await assert.rejects(listener.cycle(), code('IDENTITY_CHANGED')); assert.equal(f.activations.length, 1);
  });
}

test('concessões comuns do wizard bastam: me próprio dispensa company.read e não amplia acesso', async t => {
  const f = await fixture(t); f.principal.capabilities = ['conversation.read','events.read'];
  await f.listener().cycle(); assert.equal(f.activations.length,1);
  assert.equal(f.requests.some(r=>r.url.endsWith('/company')),false);
});

test('servidor antigo preserva fallback explícito ou pede atualização sem ampliar grants', async t => {
  const allowed = await fixture(t); allowed.legacyMe = true;
  await allowed.listener().cycle(); assert.equal(allowed.activations.length,1);assert.ok(allowed.requests.some(r=>r.url.endsWith('/company')));
  const denied = await fixture(t); denied.legacyMe=true;denied.principal.capabilities=['conversation.read','events.read'];
  await assert.rejects(denied.listener().cycle(),code('AGENT_METADATA_UPGRADE_REQUIRED'));
  assert.equal(denied.requests.some(r=>r.url.endsWith('/company')),false);assert.equal(denied.activations.length,0);
});

test('provider Hermes não é agente próprio MCP; capability ausente não é ampliada', async t => {
  const f = await fixture(t); f.agent.provider = 'hermes'; await assert.rejects(f.listener().cycle(), code('IDENTITY_UNAUTHORIZED')); assert.equal(f.activations.length, 0);
  f.agent.provider = 'mcp'; f.principal.capabilities = ['conversation.read', 'company.read']; await assert.rejects(f.listener().cycle(), code('IDENTITY_UNAUTHORIZED'));
});

test('integração HTTP com ServiceApi real, banco :memory: e receiver sintético: DTOs/recibos reais sem modelo, claims ou replies', async t => {
  const f = await fixture(t, []), external = [], key = Buffer.alloc(32, 42);
  const deny = async () => { external.push(true); throw new Error('External access forbidden in listener QA'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); app.store.close(); assert.equal(external.length, 0);
  });
  const row = app.auth.insertUser({ username: 'listener.synthetic.owner', name: 'Listener QA' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'reseller', [], 'mep-demo');
  const admin = app.auth.session(row).actor, tenant = app.store.createTenant(admin, { name: 'Listener QA', segment: 'Test' });
  app.store.mutate(admin, tenant.id, 'Listener synthetic fixture', state => {
    state.channels = [{ id: 'site', kind: 'webchat', name: 'Site', state: 'planned' }];
    state.agents = [{ id: 'a1', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.conversations = [own({ conversationKind: 'direct' })];
  });
  const issued = app.servicePrincipals.create(admin, tenant.id, { name: 'Listener QA', agentId: 'a1', capabilities: ['conversation.read','events.read','reply.send'],
    channelIds: ['site'], departmentIds: ['unassigned'], dailyRequests: 200, maxConcurrent: 3, ttlHours: 24,
    conversationPolicy: { customerMessagesAfter: '2020-01-01T00:00:00.000Z', excludedChannelIds: [], allowGroups: false } });
  const config = { ...f.config, endpoint: `http://127.0.0.1:${app.server.address().port}/api/service/v1` };
  const headers = { Authorization: 'Bearer ' + issued.token };
  const rest = await (await fetch(config.endpoint + '/me', { headers })).json();
  const beforeAgent = structuredClone(app.store.tenant(admin, tenant.id).agents[0]);
  const client = new Client({ name: 'synthetic-policy-v2', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/agent/mcp', config.endpoint), { requestInit: { headers } }));
    const mcp = (await client.callTool({ name: 'elozi_me', arguments: {} })).structuredContent;
    for (const field of ['apiVersion', 'principal', 'agent', 'responsePolicy', 'humanApprovalRequired', 'groupActions', 'replyRateLimits']) assert.deepEqual(mcp[field], rest[field]);
    assert.equal(rest.apiVersion, 2); assert.equal(rest.agent.mode, 'autonomous'); assert.equal(rest.agent.adapterMode, 'copilot');
    assert.equal(rest.humanApprovalRequired, false); assert.equal(rest.responsePolicy.requiresConversationAuthorization, false);
    assert.equal(rest.responsePolicy.requiresServerConversationAuthorization, true); assert.equal(rest.groupActions.send, false);
    assert.deepEqual(rest.responsePolicy.conversationPolicy, issued.principal.conversationPolicy);
    const after = await (await fetch(config.endpoint + '/me', { headers })).json();
    assert.deepEqual(after.principal, rest.principal); assert.deepEqual(app.store.tenant(admin, tenant.id).agents[0], beforeAgent);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM service_principal_receipts').get().n, 0);
  } finally { await client.close(); }
  const listener = new AgentEventListener(config, { env: { ...f.env, TEST_ELOZI_TOKEN: issued.token }, minPollMs: 0 });
  try { await listener.run({ maxCycles: 1 }); } finally { await listener.close(); }
  assert.equal(f.activations.length, 1); assert.equal(f.activations[0].metadata.tenantId, tenant.id); assert.equal(f.activations[0].metadata.principalId, issued.principal.id);
  const conversation = app.store.getConversation(app.store.tenant(admin, tenant.id), 'c1'); assert.equal(conversation.version, 1); assert.equal(conversation.messages.length, 1); assert.equal(conversation.owner, 'agent');
});
