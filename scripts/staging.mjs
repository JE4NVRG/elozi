import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_ASSETS } from '../src/panel-assets.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const aliases = { '/': 'index.html', '/login': 'login.html', '/verify-email': 'login.html', '/accept-invite': 'login.html', '/reset-password': 'login.html' };
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function invalid(message) { throw new Error(message); }
function upstreamURL(value) {
  let url; try { url = new URL(value); } catch { invalid('Defina uma API HTTP explícita pelo túnel em 127.0.0.1.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid('A API de staging precisa usar HTTP em 127.0.0.1 com porta explícita, sem credenciais ou caminho.');
  return url;
}
function publicURL(value) {
  let url; try { url = new URL(value); } catch { invalid('Defina a origem pública HTTPS do backend existente.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value) invalid('A origem pública do backend deve ser HTTPS, sem credenciais ou caminho.');
  return url;
}
function filteredHeaders(headers, { request = false } = {}) {
  const blocked = new Set([...hopHeaders, ...String(headers.connection || '').split(',').map(name => name.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()) && !(request && /^(?:forwarded|x-forwarded-.*|x-real-ip)$/i.test(name))));
}
function requestPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\x00-\x20\x7f\\#]/.test(target)) return null;
  const rawPath = target.split('?')[0]; let path;
  try { path = decodeURIComponent(rawPath); } catch { return null; }
  if (/[\x00-\x1f\x7f\\:%]/.test(path) || /%2f/i.test(rawPath) || path.startsWith('//') || path.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  return path;
}
function localRequest(req, server) {
  const port = server.address()?.port, host = req.headers.host;
  if (!port || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return null;
  const origin = `http://${host}`;
  if (req.headers.origin !== undefined && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return null;
  if (req.headers.referer !== undefined) {
    try { const referer = new URL(req.headers.referer); if (referer.origin !== origin || referer.username || referer.password) return null; }
    catch { return null; }
  }
  return origin;
}
function errorResponse(req, res, status, message) {
  req.resume();
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}
function etagMatches(value, etag) {
  return typeof value === 'string' && value.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
}

/** Local assets plus a streaming proxy. It never imports the application, opens a database or starts a gateway. */
export function createStagingServer({ upstream, backendOrigin = 'https://elozi.je4ndev.com', publicDirectory = resolve(root, 'public'), timeoutMs = 60000 } = {}) {
  const destination = upstreamURL(upstream), backend = publicURL(backendOrigin), publicRoot = realpathSync(resolve(publicDirectory));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) invalid('Prazo do proxy inválido.');
  const versionedFiles = new Set(PANEL_ASSETS.filter(file => /^[a-z0-9][a-z0-9.-]*\.(?:css|js)$/.test(file)));
  let versionPending = null;
  async function localAsset(file) {
    const resolved = await realpath(resolve(publicRoot, file)), inside = relative(publicRoot, resolved);
    if (inside === '..' || inside.startsWith('..' + sep) || resolve(publicRoot, inside) !== resolved || !inside || !(await stat(resolved)).isFile()) {
      const error = new Error('Arquivo local não encontrado.'); error.code = 'ENOENT'; throw error;
    }
    const content = await readFile(resolved);
    return { content, etag: `"${createHash('sha256').update(content).digest('hex')}"` };
  }
  // Same asset order and quoted hashes as production/verify. A supplied test publicRoot may be partial.
  // Only simultaneous calculations are shared: editing local source must change the page version immediately.
  function assetVersion() {
    if (!versionPending) versionPending = Promise.all(PANEL_ASSETS.map(async file => {
      try { return (await localAsset(file)).etag; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    })).then(etags => createHash('sha256').update(etags.filter(etag => etag !== null).join('\n')).digest('hex').slice(0, 12))
      .finally(() => { versionPending = null; });
    return versionPending;
  }
  const versionedPage = (content, version) => Buffer.from(content.toString('utf8').replace(/(\b(?:href|src)=")\/([a-z0-9][a-z0-9.-]*\.(?:css|js))"/g,
    (match, attribute, file) => versionedFiles.has(file) ? `${attribute}/v/${version}/${file}"` : match));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
  const server = http.createServer(async (req, res) => {
    const localOrigin = localRequest(req, server);
    if (!localOrigin) return errorResponse(req, res, 403, 'Host ou origem local não autorizados.');
    const path = requestPath(req.url);
    if (path === null) return errorResponse(req, res, 400, 'Caminho inválido.');
    // /brand.css comes from the API too: the existing server derives it from the brand of the host.
    if (path === '/api' || path.startsWith('/api/') || path === '/brand.css') {
      const headers = filteredHeaders(req.headers, { request: true });
      headers.host = backend.host;
      if (headers.origin !== undefined) headers.origin = backend.origin;
      if (headers.referer !== undefined) { const referer = new URL(headers.referer); headers.referer = backend.origin + referer.pathname + referer.search; }
      // No redirects or retries: mutations retain exactly one streamed request.
      const proxy = http.request({ hostname: destination.hostname, port: destination.port, method: req.method, path: req.url, headers, agent }, upstreamResponse => {
        const responseHeaders = filteredHeaders(upstreamResponse.headers);
        if (typeof responseHeaders.location === 'string') {
          try { const location = new URL(responseHeaders.location, backend); if (location.origin === backend.origin) responseHeaders.location = localOrigin + location.pathname + location.search + location.hash; } catch { /* Preserve backend response without following it. */ }
        }
        // Upstream headers replace the local defaults case-insensitively (no duplicated Cache-Control or CSP).
        const defaults = Object.fromEntries(Object.entries(securityHeaders).filter(([name]) => !Object.hasOwn(responseHeaders, name.toLowerCase())));
        res.writeHead(upstreamResponse.statusCode, { ...defaults, ...responseHeaders });
        // Server-sent events (GET /api/events): headers go out at once and every frame is forwarded as it arrives. The
        // backend heartbeat (20 s) keeps the stream below timeoutMs; closing the tab closes the upstream request below.
        if (/^text\/event-stream\b/i.test(String(upstreamResponse.headers['content-type'] || ''))) { res.flushHeaders(); res.socket?.setNoDelay(true); }
        upstreamResponse.on('error', () => res.destroy());
        upstreamResponse.on('aborted', () => res.destroy());
        upstreamResponse.pipe(res);
      });
      proxy.setTimeout(timeoutMs, () => { proxy.destroy(); errorResponse(req, res, 504, 'A API existente não respondeu dentro do prazo.'); });
      proxy.on('error', () => { if (!res.writableEnded && !res.destroyed) errorResponse(req, res, 502, 'A API existente está indisponível. Confira o túnel local.'); });
      req.on('aborted', () => proxy.destroy());
      req.on('error', () => proxy.destroy());
      res.on('close', () => { if (!res.writableEnded) proxy.destroy(); });
      req.pipe(proxy);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return errorResponse(req, res, 405, 'Use GET ou HEAD para os arquivos locais.'); }
    const versioned = /^\/v\/([a-f0-9]{12})\/([a-z0-9][a-z0-9.-]*)$/.exec(path);
    if (path.startsWith('/v/') && (!versioned || !versionedFiles.has(versioned[2]))) return errorResponse(req, res, 404, 'Arquivo local não encontrado.');
    const file = versioned ? versioned[2] : aliases[path] || path.slice(1), type = types[extname(file).toLowerCase()];
    if (!type) return errorResponse(req, res, 404, 'Arquivo local não encontrado.');
    try {
      const asset = await localAsset(file);
      if (versioned) {
        const current = versioned[1] === await assetVersion();
        const headers = { ...securityHeaders, 'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: asset.etag };
        if (etagMatches(req.headers['if-none-match'], asset.etag)) { res.writeHead(304, headers); return res.end(); }
        res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': asset.content.length });
        return res.end(req.method === 'HEAD' ? undefined : asset.content);
      }
      const content = ['index.html', 'login.html'].includes(file) ? versionedPage(asset.content, await assetVersion()) : asset.content;
      res.writeHead(200, { ...securityHeaders, 'Content-Type': type, 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { errorResponse(req, res, 404, 'Arquivo local não encontrado.'); }
  });
  // This backend has no WebSocket routes. Never forward an unchecked upgrade.
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('close', () => agent.destroy());
  server.requestTimeout = timeoutMs + 1000;
  const listen = server.listen.bind(server);
  server.listen = (port = 49554, hostOrCallback, callback) => {
    const host = typeof hostOrCallback === 'string' ? hostOrCallback : '127.0.0.1';
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || host !== '127.0.0.1') invalid('Staging só pode ouvir em 127.0.0.1 com uma porta TCP válida.');
    return listen(port, '127.0.0.1', typeof hostOrCallback === 'function' ? hostOrCallback : callback);
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const upstream = process.env.ELOZI_STAGING_UPSTREAM;
    if (upstream !== 'http://127.0.0.1:49555') invalid('Defina ELOZI_STAGING_UPSTREAM=http://127.0.0.1:49555 para o túnel existente.');
    const port = Number(process.env.ELOZI_STAGING_PORT || 49554);
    if (port !== 49554) invalid('A porta permanente do staging local é 49554.');
    const server = createStagingServer({ upstream, backendOrigin: process.env.ELOZI_STAGING_BACKEND_ORIGIN || 'https://elozi.je4ndev.com' });
    server.on('error', () => { console.error('Não foi possível abrir o staging local. Confira a porta 49554.'); process.exitCode = 1; });
    server.listen(port, () => console.log('Staging local: http://127.0.0.1:49554 · fonte local e API pelo túnel existente.'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
