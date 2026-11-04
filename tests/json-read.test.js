import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonRead } from '../public/json-read.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  const timers = new Map(); let id = 0;
  return { setTimeoutImpl(fn) { timers.set(++id, fn); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    expire() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn(); }, count: () => timers.size };
}

for (const phase of ['fetch', 'body']) test(`GET deadline includes stalled ${phase}, limits recovery and clears timers`, async () => {
  const time = clock(), signals = [], stalled = deferred(); let calls = 0;
  const read = createJsonRead({ ...time, fetch: async (_, options) => {
    calls++; signals.push(options.signal);
    return phase === 'fetch' ? stalled.promise : { ok: true, status: 200, json: () => stalled.promise };
  } });
  const outcome = read('/api/bootstrap').then(value => ({ value }), error => ({ error }));
  await tick(); time.expire(); await tick(); assert.equal(calls, 2); assert.equal(signals[0].aborted, true);
  time.expire(); const { error } = await outcome; assert.equal(error.code, 'READ_TIMEOUT');
  assert.equal(signals[1].aborted, true); assert.equal(time.count(), 0);
  stalled.resolve({ late: true }); await tick(); assert.equal(calls, 2);
});

test('an interrupted successful GET body is retried once with the same scoped headers', async () => {
  const time = clock(), seen = [];
  const read = createJsonRead({ ...time, fetch: async (path, options) => {
    seen.push({ path, options });
    if (seen.length === 1) return { ok: true, status: 200, json: async () => { throw new TypeError('QUIC interrupted'); } };
    return new Response('{"ready":true}');
  } });
  assert.deepEqual((await read('/api/tenants/a', { headers: { 'X-Elozi-Workspace': 'a' } })).result, { ready: true });
  assert.equal(seen.length, 2); assert.deepEqual(seen[0].options.headers, seen[1].options.headers);
  assert.notEqual(seen[0].options.signal, seen[1].options.signal); assert.equal(time.count(), 0);
});

for (const method of ['POST', 'PATCH', 'DELETE']) test(`${method} is never automatically replayed or timed out`, async () => {
  const time = clock(); let calls = 0;
  const read = createJsonRead({ ...time, fetch: async () => { calls++; throw new TypeError('unconfirmed command'); } });
  await assert.rejects(read('/api/command', { method }), /unconfirmed command/);
  assert.equal(calls, 1); assert.equal(time.count(), 0);
});

for (const status of [401, 403, 429, 503]) test(`HTTP ${status} remains authoritative with a stalled body`, async () => {
  const time = clock(); let calls = 0;
  const read = createJsonRead({ ...time, fetch: async () => { calls++; return { ok: false, status, json: () => new Promise(() => {}) }; } });
  const pending = read('/api/bootstrap'); await tick(); time.expire(); const result = await pending;
  assert.equal(result.response.status, status); assert.equal(result.parsed, false); assert.equal(calls, 1); assert.equal(time.count(), 0);
});

test('an external abort ends a stalled read immediately without retry even when fetch ignores it', async () => {
  const time = clock(), external = new AbortController(); let calls = 0;
  const read = createJsonRead({ ...time, fetch: () => { calls++; return new Promise(() => {}); } });
  const pending = read('/api/bootstrap', { signal: external.signal }); external.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1); assert.equal(time.count(), 0);
  await assert.rejects(read('/api/bootstrap', { signal: external.signal }), { name: 'AbortError' }); assert.equal(calls, 1);
});

test('invalid JSON is reported without retrying a server payload', async () => {
  let calls = 0; const read = createJsonRead({ fetch: async () => { calls++; return new Response('<html>proxy</html>'); } });
  assert.equal((await read('/api/bootstrap')).parsed, false); assert.equal(calls, 1);
});
