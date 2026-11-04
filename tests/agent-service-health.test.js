import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkAgentServiceHealth } from '../src/agent-service-health.js';
import { createHermesProvider } from '../src/agent-runtime.js';

const MODEL = 'fixture-native-model';
const API_KEY = 'fixture-health-key-not-a-real-credential';
const CANARY = 'fixture-private-response-canary';
const FAILURE = 'O serviço não respondeu com o modelo configurado.';
const LEGACY = { status: 'ok', model: MODEL, private: CANARY };
const NATIVE = { status: 'ok', platform: 'hermes-agent', version: '0.21.5', private: CANARY };
const CATALOG = { object: 'list', data: [
  { object: 'model', id: 'fixture-other-model', created: 0, owned_by: 'hermes' },
  { object: 'model', id: MODEL, created: 0, owned_by: 'hermes' },
], private: CANARY };

function safeError(error) {
  assert.equal(error.message, FAILURE);
  assert.equal(error.cause, undefined);
  assert.deepEqual(Object.keys(error), []);
  for (const forbidden of [API_KEY, CANARY, MODEL, 'http://']) assert.equal(error.stack.includes(forbidden), false);
  return true;
}
function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function padded(value, bytes) {
  const base = { ...value, padding: '' };
  return JSON.stringify({ ...base, padding: ' '.repeat(bytes - Buffer.byteLength(JSON.stringify(base))) });
}
async function localService(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const entry = { method: req.method, path: req.url, authorization: req.headers.authorization, body: '' };
    requests.push(entry);
    try {
      for await (const chunk of req) entry.body += chunk;
      if (req.method !== 'GET' || !['/health', '/v1/models'].includes(req.url)) { res.writeHead(405); res.end(CANARY); return; }
      if (req.headers.authorization !== `Bearer ${API_KEY}`) { json(res, { error: CANARY }, 401); return; }
      await handler(req, res);
    } catch { res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const req of requests) {
      assert.equal(req.method, 'GET', 'No inference POST (or any other method).');
      assert.ok(['/health', '/v1/models'].includes(req.path));
      assert.equal(req.body, '', 'No inference body.');
    }
  });
  return { requests, origin, config: { endpoint: `${origin}/v1/chat/completions`, allowedOrigins: [origin], apiKey: API_KEY, model: MODEL } };
}
async function fixture(t, health = LEGACY, catalog = CATALOG) {
  return localService(t, (req, res) => json(res, req.url === '/health' ? health : catalog));
}
function trackTimers(t, accelerate = false) {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, timers = [], cleared = new Set();
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = set(callback, accelerate && ms === 5000 ? 200 : ms, ...args);
    if (ms === 5000) timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { cleared.add(timer); return clear(timer); });
  return expected => {
    assert.equal(timers.length, expected, 'Exactly one deadline per GET.');
    for (const timer of timers) assert.ok(cleared.has(timer), 'Every deadline is cleared, including failures.');
  };
}
function observe(config) {
  const calls = [];
  const fetchImpl = (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(options.body, undefined);
    assert.equal(new URL(url).origin, new URL(config.endpoint).origin);
    calls.push({ url, signal: options.signal });
    return fetch(url, options);
  };
  return { calls, fetchImpl };
}

test('legacy positive: exact model, whitelist metadata, single GET, cleared live timer', async t => {
  const c = await fixture(t), cleared = trackTimers(t), { calls, fetchImpl } = observe(c.config);
  assert.deepEqual(await checkAgentServiceHealth({ ...c.config, fetchImpl }), { reachable: true, model: MODEL, source: 'health' });
  assert.deepEqual(c.requests.map(req => req.path), ['/health']);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false); cleared(1);
});

test('native positive: only authenticated same-origin health + catalog GET, no inference claim', async t => {
  const c = await fixture(t, NATIVE), cleared = trackTimers(t), { calls, fetchImpl } = observe(c.config);
  assert.deepEqual(await checkAgentServiceHealth({ ...c.config, fetchImpl }), { reachable: true, model: MODEL, source: 'catalog' });
  assert.deepEqual(c.requests.map(req => req.path), ['/health', '/v1/models']);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !call.signal.aborted)); cleared(2);
});

test('exact 4096-byte health and 16384-byte catalog are accepted', async t => {
  const legacy = await localService(t, (_, res) => res.end(padded(LEGACY, 4096)));
  assert.equal((await checkAgentServiceHealth(legacy.config)).source, 'health');
  const native = await localService(t, (req, res) => res.end(padded(req.url === '/health' ? NATIVE : CATALOG, req.url === '/health' ? 4096 : 16384)));
  assert.equal((await checkAgentServiceHealth(native.config)).source, 'catalog');
});

for (const [name, health] of [
  ['divergent legacy model', { ...LEGACY, model: 'other' }],
  ['native explicit null model', { ...NATIVE, model: null }],
  ['native empty model', { ...NATIVE, model: '' }],
  ['native non-string model', { ...NATIVE, model: 42 }],
  ['generic status ok without model', { status: 'ok' }],
  ['unrecognized platform', { status: 'ok', platform: 'other' }],
  ['native non-ok status', { ...NATIVE, status: 'starting' }],
  ['null health', null], ['array health', []], ['string health', 'ok'],
]) test(`${name}: reject without catalog fallback`, async t => {
  const c = await fixture(t, health), cleared = trackTimers(t);
  await assert.rejects(checkAgentServiceHealth(c.config), safeError);
  assert.deepEqual(c.requests.map(req => req.path), ['/health']); cleared(1);
});

for (const [name, catalog] of [
  ['configured model absent', { object: 'list', data: [{ object: 'model', id: 'other' }] }],
  ['substring model is not exact', { object: 'list', data: [{ object: 'model', id: `${MODEL}-suffix` }] }],
  ['whitespace model is not exact', { object: 'list', data: [{ object: 'model', id: ` ${MODEL} ` }] }],
  ['empty catalog', { object: 'list', data: [] }],
  ['missing data', { object: 'list' }], ['non-array data', { object: 'list', data: { id: MODEL } }],
  ['missing list discriminator', { data: [{ object: 'model', id: MODEL }] }],
  ['non-string id', { object: 'list', data: [{ object: 'model', id: 42 }] }],
  ['invalid model discriminator', { object: 'list', data: [{ object: 'other', id: MODEL }] }],
  ['matching model mixed with malformed entry', { object: 'list', data: [{ object: 'model', id: MODEL }, null] }],
  ['null catalog', null], ['array catalog', []],
]) test(`native catalog ${name}: reject safely`, async t => {
  const c = await fixture(t, NATIVE, catalog), cleared = trackTimers(t);
  await assert.rejects(checkAgentServiceHealth(c.config), safeError);
  assert.deepEqual(c.requests.map(req => req.path), ['/health', '/v1/models']); cleared(2);
});

test('production createHermesProvider guard rejects URL/origin/credential/model before any IO', async t => {
  const c = await fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error(`${CANARY} ${API_KEY}`); };
  const invalid = [
    { endpoint: 'not-a-url' }, { endpoint: `ftp://127.0.0.1/v1/chat/completions` },
    { endpoint: `${c.origin}/health` }, { endpoint: `${c.config.endpoint}?key=${API_KEY}` },
    { endpoint: `${c.config.endpoint}#fragment` }, { endpoint: c.config.endpoint.replace('http://', 'http://user:password@') },
    { allowedOrigins: [] }, { allowedOrigins: ['http://127.0.0.1:1'] }, { allowedOrigins: [`${c.origin}.evil.invalid`] },
    { allowedOrigins: c.origin }, { apiKey: '' }, { apiKey: ' \t ' }, { apiKey: `${API_KEY}\r\ninjected: yes` },
    { model: '' }, { model: null }, { fetchImpl: null },
  ];
  for (const patch of invalid) {
    const config = { ...c.config, fetchImpl, ...patch };
    assert.throws(() => createHermesProvider(config), TypeError);
    await assert.rejects(checkAgentServiceHealth(config), safeError);
  }
  assert.equal(calls, 0); assert.equal(c.requests.length, 0);
});

for (const stage of ['/health', '/v1/models']) {
  test(`${stage} cross-origin and same-origin redirects are not followed; no credential forwarded`, async t => {
    const target = await fixture(t);
    for (const cross of [true, false]) {
      const c = await localService(t, (req, res) => {
        if (req.url !== stage) return json(res, NATIVE);
        res.writeHead(302, { location: cross ? `${target.origin}/health` : '/v1/chat/completions' }); res.end(CANARY);
      });
      const cleared = trackTimers(t);
      await assert.rejects(checkAgentServiceHealth(c.config), safeError);
      assert.deepEqual(c.requests.map(req => req.path), stage === '/health' ? ['/health'] : ['/health', '/v1/models']);
      cleared(stage === '/health' ? 1 : 2); t.mock.restoreAll();
    }
    assert.equal(target.requests.length, 0);
  });
  test(`${stage} malformed JSON and invalid UTF-8 reject without exposing body`, async t => {
    for (const body of [`${CANARY} ${API_KEY}`, Buffer.from([0xff, 0xfe])]) {
      const c = await localService(t, (req, res) => req.url === stage ? res.end(body) : json(res, NATIVE));
      const cleared = trackTimers(t);
      await assert.rejects(checkAgentServiceHealth(c.config), safeError);
      cleared(stage === '/health' ? 1 : 2); t.mock.restoreAll();
    }
  });
  test(`${stage} authentication and other HTTP failures reject without retry or error-body read`, async t => {
    for (const status of [401, 403, 429, 500]) {
      const c = await localService(t, (req, res) => req.url === stage ? json(res, { error: `${CANARY} ${API_KEY}` }, status) : json(res, NATIVE));
      const cleared = trackTimers(t);
      await assert.rejects(checkAgentServiceHealth(c.config), safeError);
      assert.equal(c.requests.length, stage === '/health' ? 1 : 2);
      cleared(stage === '/health' ? 1 : 2); t.mock.restoreAll();
    }
  });
  test(`${stage} oversized declared and chunked decoded bodies reject at byte limit`, async t => {
    const max = stage === '/health' ? 4096 : 16384;
    for (const declared of [true, false]) {
      const body = padded(stage === '/health' ? LEGACY : CATALOG, max + 1);
      const c = await localService(t, (req, res) => {
        if (req.url !== stage) return json(res, NATIVE);
        res.writeHead(200, { 'content-type': 'application/json', ...(declared ? { 'content-length': Buffer.byteLength(body) } : {}) });
        res.write(body.slice(0, max)); res.end(body.slice(max));
      });
      const cleared = trackTimers(t);
      await assert.rejects(checkAgentServiceHealth(c.config), safeError);
      cleared(stage === '/health' ? 1 : 2); t.mock.restoreAll();
    }
  });
  test(`${stage} real chunked endless body is cancelled before server completion`, async t => {
    let resolveClosed, writes = 0;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const c = await localService(t, (req, res) => {
      if (req.url !== stage) return json(res, NATIVE);
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('x'.repeat(1024)); writes++;
      const interval = setInterval(() => { writes++; res.write('x'.repeat(1024)); }, 5);
      res.once('close', () => { clearInterval(interval); resolveClosed(); });
      t.after(() => clearInterval(interval));
    });
    const cleared = trackTimers(t);
    await assert.rejects(checkAgentServiceHealth(c.config), safeError);
    let watchdog;
    try { await Promise.race([closed, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Stream was not cancelled.')), 1000); })]); }
    finally { clearTimeout(watchdog); }
    assert.ok(writes < 100, 'Did not buffer or wait for the endless response.');
    cleared(stage === '/health' ? 1 : 2);
  });
  for (const streamBody of [false, true]) test(`${stage} real ${streamBody ? 'streaming body' : 'headers'} timeout aborts and clears timer`, async t => {
    const c = await localService(t, (req, res) => {
      if (req.url !== stage) return json(res, NATIVE);
      if (streamBody) { res.writeHead(200); res.write('{"private":"'); }
      // Deliberately never finish headers/body. Owned sockets are closed in teardown.
    });
    const cleared = trackTimers(t, true), { calls, fetchImpl } = observe(c.config);
    await assert.rejects(checkAgentServiceHealth({ ...c.config, fetchImpl }), safeError);
    assert.equal(calls.at(-1).signal.aborted, true);
    assert.equal(c.requests.length, stage === '/health' ? 1 : 2);
    cleared(stage === '/health' ? 1 : 2);
  });
}

test('multibyte size is bytes, not characters', async t => {
  const body = JSON.stringify({ ...LEGACY, padding: 'é'.repeat(2500) });
  assert.ok(body.length < 4096); assert.ok(Buffer.byteLength(body) > 4096);
  const c = await localService(t, (_, res) => { res.writeHead(200); res.end(body); });
  await assert.rejects(checkAgentServiceHealth(c.config), safeError);
});

test('bounded reader cancels oversized unknown-length stream and releases its lock', async t => {
  let pulls = 0, cancelled = 0;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled++; },
  });
  const cleared = trackTimers(t); let calls = 0;
  await assert.rejects(checkAgentServiceHealth({ endpoint: 'http://127.0.0.1:1/v1/chat/completions', allowedOrigins: ['http://127.0.0.1:1'], apiKey: API_KEY, model: MODEL,
    fetchImpl: async (_, options) => { calls++; assert.equal(options.method, 'GET'); return new Response(stream); },
  }), safeError);
  assert.equal(calls, 1); assert.equal(cancelled, 1); assert.ok(pulls <= 7); assert.equal(stream.locked, false); cleared(1);
});

test('transport exception is sanitized and its timer is cleared', async t => {
  const cleared = trackTimers(t); let calls = 0;
  await assert.rejects(checkAgentServiceHealth({ endpoint: 'http://127.0.0.1:1/v1/chat/completions', allowedOrigins: ['http://127.0.0.1:1'], apiKey: API_KEY, model: MODEL,
    fetchImpl: async () => { calls++; throw Object.assign(new Error(`${API_KEY} ${CANARY}`), { status: 401, body: CANARY }); },
  }), safeError);
  assert.equal(calls, 1); cleared(1);
});

test('uncooperative injected fetch is still deadline bounded; timer cleared', async t => {
  const cleared = trackTimers(t, true); let signal;
  await assert.rejects(checkAgentServiceHealth({ endpoint: 'http://127.0.0.1:1/v1/chat/completions', allowedOrigins: ['http://127.0.0.1:1'], apiKey: API_KEY, model: MODEL,
    fetchImpl: (_, options) => { signal = options.signal; return new Promise(() => {}); },
  }), safeError);
  assert.equal(signal.aborted, true); cleared(1);
});

test('no unbounded text fallback for non-streaming responses', async t => {
  let textCalls = 0;
  const cleared = trackTimers(t);
  await assert.rejects(checkAgentServiceHealth({ endpoint: 'http://127.0.0.1:1/v1/chat/completions', allowedOrigins: ['http://127.0.0.1:1'], apiKey: API_KEY, model: MODEL,
    fetchImpl: async () => ({ ok: true, headers: new Headers(), text: async () => { textCalls++; return JSON.stringify(LEGACY); } }),
  }), safeError);
  assert.equal(textCalls, 0); cleared(1);
});
