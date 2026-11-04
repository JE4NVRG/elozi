import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStagingServer } from '../scripts/staging.mjs';
import { PANEL_ASSETS } from '../src/panel-assets.js';

const etag = content => `"${createHash('sha256').update(content).digest('hex')}"`;
const sourceVersion = files => createHash('sha256').update(PANEL_ASSETS.filter(file => Object.hasOwn(files, file)).map(file => etag(files[file])).join('\n')).digest('hex').slice(0, 12);

async function fixture(t, handler = (_req, res) => res.end('synthetic upstream'), extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-staging-test-')), publicDirectory = join(directory, 'public');
  await mkdir(publicDirectory); await writeFile(join(publicDirectory, 'index.html'), '<p>LOCAL_SYNTHETIC_INDEX</p>'); await writeFile(join(publicDirectory, 'login.html'), '<p>LOCAL_SYNTHETIC_LOGIN</p>'); await writeFile(join(publicDirectory, 'app.js'), 'LOCAL_SYNTHETIC_JS');
  const seen = [], backend = http.createServer((req, res) => { seen.push(req); handler(req, res); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const upstream = `http://127.0.0.1:${backend.address().port}`, server = createStagingServer({ upstream, publicDirectory, ...extra });
  server.listen(0); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]); await rm(directory, { recursive: true, force: true }); });
  return { directory, publicDirectory, server, backend, base, seen, request(path, { method = 'GET', headers = {}, bytes, chunks } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(base + path, { method, headers }, res => { const parts = []; res.on('data', part => parts.push(part)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(parts) })); });
      req.on('error', reject); if (chunks) for (const chunk of chunks) req.write(chunk); req.end(bytes);
    });
  } };
}

test('local source serves index/login/modules without reaching production and remains uncached', async t => {
  const f = await fixture(t);
  for (const [path, marker] of [['/', 'INDEX'], ['/login', 'LOGIN'], ['/verify-email?token=synthetic', 'LOGIN'], ['/app.js', 'JS']]) {
    const result = await f.request(path); assert.equal(result.status, 200); assert.match(result.bytes.toString(), new RegExp('LOCAL_SYNTHETIC_' + marker)); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers.etag, undefined);
    assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(result.headers['x-content-type-options'], 'nosniff');
  }
  const head = await f.request('/app.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers['content-length']), 18);
  await writeFile(join(f.publicDirectory, 'app.js'), 'LOCAL_SYNTHETIC_CHANGED'); assert.equal((await f.request('/app.js')).bytes.toString(), 'LOCAL_SYNTHETIC_CHANGED');
  assert.equal((await f.request('/app.js', { method: 'POST', bytes: 'synthetic' })).status, 405); assert.equal((await f.request('/missing.js')).status, 404); assert.equal(f.seen.length, 0);
});

test('local pages and relative modules use the source version with immutable cache and ETags', async t => {
  const f = await fixture(t), files = {
    'app.js': 'import "./session-guard.js"; // LOCAL_SYNTHETIC_JS',
    'login.js': 'LOCAL_SYNTHETIC_LOGIN_JS',
    'session-guard.js': 'export const synthetic = true;',
    'tokens.css': ':root{--synthetic:1}'
  };
  await Promise.all(Object.entries(files).map(([file, content]) => writeFile(join(f.publicDirectory, file), content)));
  await writeFile(join(f.publicDirectory, 'index.html'), '<link href="/tokens.css"><link href="/brand.css"><link href="/manifest.webmanifest"><script src="https://example.invalid/external.js"></script><script src="/app.js"></script>');
  await writeFile(join(f.publicDirectory, 'login.html'), '<link href="/tokens.css"><script src="/login.js"></script>');
  const version = sourceVersion(files), index = await f.request('/');
  assert.equal(index.status, 200); assert.equal(index.headers['cache-control'], 'no-store');
  assert.match(index.bytes.toString(), new RegExp(`src="/v/${version}/app\\.js"`));
  assert.match(index.bytes.toString(), new RegExp(`href="/v/${version}/tokens\\.css"`));
  assert.match(index.bytes.toString(), /href="\/brand\.css"/); assert.match(index.bytes.toString(), /href="\/manifest\.webmanifest"/);
  assert.match(index.bytes.toString(), /src="https:\/\/example\.invalid\/external\.js"/);
  for (const path of ['/login', '/verify-email?token=synthetic', '/accept-invite', '/reset-password']) {
    const login = await f.request(path); assert.equal(login.status, 200); assert.equal(login.headers['cache-control'], 'no-store');
    assert.match(login.bytes.toString(), new RegExp(`src="/v/${version}/login\\.js"`));
  }
  const route = `/v/${version}/app.js`, app = await f.request(route);
  assert.equal(app.status, 200); assert.equal(app.bytes.toString(), files['app.js']);
  assert.equal(app.headers['cache-control'], 'public, max-age=31536000, immutable'); assert.equal(app.headers.etag, etag(files['app.js']));
  assert.match(app.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(app.headers['x-content-type-options'], 'nosniff');
  const imported = await f.request(`/v/${version}/session-guard.js`); assert.equal(imported.status, 200); assert.equal(imported.bytes.toString(), files['session-guard.js']);
  assert.equal(imported.headers['cache-control'], app.headers['cache-control']);
  const cached = await f.request(route, { headers: { 'If-None-Match': `"other", W/${app.headers.etag}` } }); assert.equal(cached.status, 304); assert.equal(cached.bytes.length, 0);
  const head = await f.request(route, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(files['app.js']));
  const plain = await f.request('/app.js'); assert.deepEqual(plain.bytes, app.bytes); assert.equal(plain.headers['cache-control'], 'no-store');
  const old = await f.request('/v/000000000000/app.js'); assert.equal(old.status, 200); assert.deepEqual(old.bytes, app.bytes); assert.equal(old.headers['cache-control'], 'no-cache');
  for (const path of [`/v/${version}/missing.js`, `/v/${version}/manifest.webmanifest`, '/v/not-a-version/app.js']) assert.equal((await f.request(path)).status, 404);
  assert.equal(f.seen.length, 0, 'all source bytes come from the supplied local publicRoot');
});

test('editing local source immediately changes the page version and removes immutable from the old prefix', async t => {
  const f = await fixture(t); await writeFile(join(f.publicDirectory, 'index.html'), '<script src="/app.js"></script>');
  const initial = 'LOCAL_SYNTHETIC_JS', firstVersion = sourceVersion({ 'app.js': initial });
  assert.match((await f.request('/')).bytes.toString(), new RegExp(`/v/${firstVersion}/app\\.js`));
  const changed = 'LOCAL_SYNTHETIC_JS_CHANGED'; await writeFile(join(f.publicDirectory, 'app.js'), changed);
  const nextVersion = sourceVersion({ 'app.js': changed }); assert.notEqual(nextVersion, firstVersion);
  const pages = await Promise.all([f.request('/'), f.request('/')]);
  for (const page of pages) assert.match(page.bytes.toString(), new RegExp(`/v/${nextVersion}/app\\.js`));
  const stale = await f.request(`/v/${firstVersion}/app.js`, { headers: { 'If-None-Match': etag(initial) } });
  assert.equal(stale.status, 200); assert.equal(stale.bytes.toString(), changed); assert.equal(stale.headers['cache-control'], 'no-cache');
  const fresh = await f.request(`/v/${nextVersion}/app.js`); assert.equal(fresh.bytes.toString(), changed); assert.match(fresh.headers['cache-control'], /immutable/);
  assert.equal(f.seen.length, 0);
});

test('streaming proxy preserves method/query/JSON/workspace/cookies and translates only validated local origin', async t => {
  let captured;
  const cookies = ['mep_session=SYNTHETIC; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600; Secure', 'mep_google=SYNTHETIC_GOOGLE; HttpOnly; SameSite=Strict; Path=/; Secure'];
  const f = await fixture(t, async (req, res) => { const parts = []; for await (const part of req) parts.push(part); captured = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() }; res.writeHead(201, { 'Set-Cookie': cookies, 'Content-Type': 'application/json', 'X-Backend-Test': 'synthetic' }); res.end('{"accepted":true}'); });
  const result = await f.request('/api/auth/login?synthetic=1', { method: 'POST', headers: { Origin: f.base, Referer: f.base + '/login', Cookie: 'mep_session=SYNTHETIC_OLD', 'X-Elozi-Workspace': 'synthetic-workspace', 'Content-Type': 'application/json', Forwarded: 'host=evil.invalid', 'X-Forwarded-Host': 'evil.invalid', Connection: 'keep-alive, x-drop-test', 'X-Drop-Test': 'must-not-pass' }, chunks: ['{"username":', '"synthetic"}'] });
  assert.equal(result.status, 201); assert.deepEqual(result.headers['set-cookie'], cookies); assert.deepEqual(JSON.parse(result.bytes.toString()), { accepted: true });
  assert.equal(captured.method, 'POST'); assert.equal(captured.url, '/api/auth/login?synthetic=1'); assert.equal(captured.body, '{"username":"synthetic"}');
  assert.equal(captured.headers.host, 'elozi.je4ndev.com'); assert.equal(captured.headers.origin, 'https://elozi.je4ndev.com'); assert.equal(captured.headers.referer, 'https://elozi.je4ndev.com/login');
  assert.equal(captured.headers.cookie, 'mep_session=SYNTHETIC_OLD'); assert.equal(captured.headers['x-elozi-workspace'], 'synthetic-workspace');
  for (const header of ['forwarded', 'x-forwarded-host', 'x-drop-test']) assert.equal(captured.headers[header], undefined);
});

test('binary media and logout use the same API without buffering or cookie attribute rewrites', async t => {
  const media = Buffer.from([0, 255, 13, 10, 128, 42]); let uploaded;
  const f = await fixture(t, async (req, res) => { if (req.method === 'PUT') { const parts = []; for await (const part of req) parts.push(part); uploaded = Buffer.concat(parts); } if (req.url.endsWith('/logout')) { res.setHeader('Set-Cookie', 'mep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure'); res.end('{}'); } else { res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-5/6', 'Content-Length': media.length }); res.end(media); } });
  const result = await f.request('/api/tenants/synthetic/conversations/c/attachments/a', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': media.length, Range: 'bytes=0-5' }, bytes: media });
  assert.equal(result.status, 206); assert.deepEqual(uploaded, media); assert.deepEqual(result.bytes, media); assert.equal(result.headers['content-range'], 'bytes 0-5/6'); assert.equal(f.seen[0].headers.range, 'bytes=0-5');
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers: { Origin: f.base }, bytes: '{}' }); assert.deepEqual(logout.headers['set-cookie'], ['mep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure']);
});

test('host/origin/referrer and URL containment reject before proxying', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'evil.invalid' }, { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Referer: 'https://evil.invalid/login' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers, bytes: '{}' })).status, 403);
  for (const path of ['//evil.invalid/api', '/%2e%2e/app.js', '/api/../auth', '/api%2fauth', '/%5c..%5csecret.js', '/bad%00.js', '/.hidden.js']) {
    // http.request URL construction normalizes dot segments; send the target verbatim.
    const result = await new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port: f.server.address().port, path }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); }); assert.equal(result, 400, path);
  }
  assert.equal(f.seen.length, 0); assert.throws(() => f.server.listen(0, '0.0.0.0'), /127\.0\.0\.1/);
});

test('symlink or junction cannot serve a file outside public', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.js'), 'OUTSIDE_SYNTHETIC');
  try { await symlink(outside, join(f.publicDirectory, 'leak'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host não permite criar link de teste.'); return; } throw error; }
  assert.equal((await f.request('/leak/private.js')).status, 404); assert.equal(f.seen.length, 0);
});

test('version hashing never reads an allowlisted file reached through a junction outside publicRoot', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside-fonts'); await mkdir(outside);
  await writeFile(join(outside, 'manrope-latin-wght-normal.woff2'), 'OUTSIDE_SYNTHETIC_FONT');
  await writeFile(join(f.publicDirectory, 'index.html'), '<script src="/app.js"></script>');
  try { await symlink(outside, join(f.publicDirectory, 'fonts'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host não permite criar link de teste.'); return; } throw error; }
  const version = sourceVersion({ 'app.js': 'LOCAL_SYNTHETIC_JS' }), page = await f.request('/');
  assert.equal(page.status, 200); assert.match(page.bytes.toString(), new RegExp(`/v/${version}/app\\.js`), 'outside bytes do not enter the local version hash');
  assert.equal((await f.request('/fonts/manrope-latin-wght-normal.woff2')).status, 404);
  const app = await f.request(`/v/${version}/app.js`); assert.equal(app.status, 200); assert.match(app.headers['cache-control'], /immutable/);
  assert.equal(f.seen.length, 0);
});

test('upstream config cannot carry credentials, remote hosts or a path', () => {
  for (const upstream of [undefined, 'https://127.0.0.1:49555', 'http://localhost:49555', 'http://evil.invalid:49555', 'http://127.0.0.1', 'http://synthetic:synthetic@127.0.0.1:49555', 'http://127.0.0.1:49555/api', 'http://127.0.0.1:49555/?x=1']) assert.throws(() => createStagingServer({ upstream }));
  for (const backendOrigin of ['http://elozi.je4ndev.com', 'https://synthetic:synthetic@elozi.je4ndev.com', 'https://elozi.je4ndev.com/login']) assert.throws(() => createStagingServer({ upstream: 'http://127.0.0.1:49555', backendOrigin }));
});

test('proxy never follows redirects and maps backend links back to local source', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: 'https://elozi.je4ndev.com/login?reason=synthetic' }); res.end(); });
  const result = await f.request('/api/redirect'); assert.equal(result.status, 302); assert.equal(result.headers.location, f.base + '/login?reason=synthetic'); assert.equal(f.seen.length, 1);
});

test('WebSocket upgrade is rejected without reaching the existing API', async t => {
  const f = await fixture(t), socket = net.connect(f.server.address().port, '127.0.0.1'); await once(socket, 'connect');
  const response = new Promise((resolve, reject) => { let text = ''; socket.on('data', part => text += part); socket.on('end', () => resolve(text)); socket.on('error', reject); });
  socket.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${f.server.address().port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  assert.match(await response, /^HTTP\/1\.1 426/); socket.destroy(); assert.equal(f.seen.length, 0);
});

test('upstream failure is generic and a timed out POST is never retried', async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 25 }); const result = await f.request('/api/auth/login', { method: 'POST', bytes: '{"synthetic":true}' });
  assert.equal(result.status, 504); assert.equal(f.seen.length, 1); assert.doesNotMatch(result.bytes.toString(), /synthetic|ECONN|49555/);
});

test('event stream is forwarded frame by frame, outlives the idle timeout with heartbeats and closes upstream with the tab', async t => {
  let upstreamClosed = false, heartbeat;
  // Wide margins: under a loaded test runner a heartbeat may be late, so the idle timeout is 1 s and heartbeats every 50 ms.
  // Elapsed time is monotonic (performance.now): the Docker VM of linux-tests steps the wall clock back about 1 s.
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\nid: a-1\nevent: ready\ndata: {"cursor":"a-1"}\n\n');
    heartbeat = setInterval(() => res.write(': hb\n\n'), 50);
    setTimeout(() => res.write('id: a-2\nevent: inbox.changed\ndata: {"tenantId":"t","conversationId":"c"}\n\n'), 1300);
    req.on('close', () => { upstreamClosed = true; clearInterval(heartbeat); });
  }, { timeoutMs: 1000 });
  t.after(() => clearInterval(heartbeat));
  const received = await new Promise((resolve, reject) => {
    let done = false;
    const req = http.request(f.base + '/api/events?workspace=w', { headers: { Accept: 'text/event-stream' } }, res => {
      let text = '', firstAt = null; const started = performance.now();
      assert.equal(res.statusCode, 200); assert.match(res.headers['content-type'], /^text\/event-stream/);
      assert.equal(res.headers['x-accel-buffering'], 'no'); assert.equal(res.headers['cache-control'], 'no-store');
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (firstAt === null && text.includes('event: ready')) firstAt = performance.now() - started; if (!done && text.includes('event: inbox.changed')) { done = true; req.destroy(); resolve({ text, firstAt, total: performance.now() - started }); } });
      res.on('error', () => {});
      res.on('close', () => { if (!done) { done = true; reject(new Error('Fluxo encerrado antes do segundo evento: ' + text)); } });
    });
    req.on('error', error => { if (!done) { done = true; reject(error); } }); req.end();
  });
  assert.ok(received.firstAt < 1300, 'the first frame arrives before the next one is even written');
  assert.ok(received.total >= 1000, 'heartbeats kept the stream open past the 1 s idle timeout');
  assert.match(received.text, /^retry: 3000\n\nid: a-1\nevent: ready/);
  for (let index = 0; index < 50 && !upstreamClosed; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(upstreamClosed, true, 'closing the tab closes the upstream stream');
  assert.equal(f.seen[0].url, '/api/events?workspace=w');
});

test('the PWA manifest is served locally and /brand.css comes from the existing API', async t => {
  const f = await fixture(t, (req, res) => { res.setHeader('Content-Type', 'text/css; charset=utf-8'); res.end(':root{--synthetic-brand:1}'); });
  await writeFile(join(f.publicDirectory, 'manifest.webmanifest'), '{"name":"LOCAL_SYNTHETIC_MANIFEST"}');
  const manifest = await f.request('/manifest.webmanifest'); assert.equal(manifest.status, 200); assert.equal(manifest.headers['content-type'], 'application/manifest+json'); assert.equal(f.seen.length, 0);
  const brand = await f.request('/brand.css'); assert.equal(brand.status, 200); assert.equal(brand.bytes.toString(), ':root{--synthetic-brand:1}');
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].url, '/brand.css');
});
