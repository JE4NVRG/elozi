// GET /brand.css (FRONTEND-V2 §8.11, P10): the login page of each address gets the tokens of its brand,
// derived on the server by brand-theme.js for both themes. Public route with no session, tenant or
// secret; the brand only comes from the active custom domain of the Host (never from the request);
// the canonical host and unknown brands get the default brand. Also the static types of the manifest
// and of its icons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { brandStylesheet, brandTokenEntries, deriveBrandTokens, DEFAULT_BRAND } from '../public/brand-theme.js';
import { BRAND_STYLESHEET_PATH } from '../src/panel-assets.js';

const canonicalHost = 'elozi.je4ndev.com', canonicalOrigin = `https://${canonicalHost}`;

async function routeFixture(t) {
  const key = randomBytes(32), deny = async () => assert.fail('Nenhum transporte externo neste teste.');
  const app = createApp({ databasePath: ':memory:', publicOrigin: canonicalOrigin, allowRegistration: false, serviceKey: key,
    googleOptions: { clientId: '' }, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: deny },
    domainOptions: { canonicalHost, resolver: { resolveTxt: deny, resolveCname: deny }, inspectDeployment: null } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.email.close(), app.gateway.close(), app.telegram.close(), app.meta.close(), app.webchat.close(), app.bridge.close()]); app.store.close();
  });
  const request = (path, { method = 'GET', host = canonicalHost, headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method, headers: { Host: host, ...headers } }, response => {
      const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject); outgoing.end();
  });
  /** A workspace with an active custom domain, written as domains.resolve reads it (see agent-skill.test.js). */
  const bindDomain = (id, host, brand, { active = true } = {}) => {
    const now = Date.now(), at = offset => new Date(now + offset).toISOString();
    app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(id, JSON.stringify({ name: 'Revenda sintética QA', brand, version: 1, workspaceDomain: active
      ? { host, state: 'active', challenge: 'a'.repeat(64), configuredAt: at(-7200000), verifiedAt: at(-3600000), lastCheck: null,
        deployment: { host, httpsOrigin: `https://${host}`, canonicalHost, tlsValid: true, proxyVerified: true, observedAt: at(-1800000), certificateExpiresAt: at(86400000) } }
      : { host, state: 'pending', challenge: 'b'.repeat(64), configuredAt: at(-7200000), verifiedAt: null, lastCheck: null, deployment: null } }));
  };
  return { app, request, bindDomain };
}

test('brandStylesheet escreve só os tokens derivados (hex normalizados) e cai na marca padrão com entrada inválida', () => {
  const css = brandStylesheet('#E11D48');
  for (const [name, value] of brandTokenEntries(deriveBrandTokens('#e11d48'))) assert.ok(css.includes(`  ${name}: ${value};`), name);
  assert.match(css, /^\/\* Marca deste endereço[^\n]*\*\/\n:root \{\n/); assert.match(css, /\n\}\n$/);
  assert.equal(brandStylesheet('#123abc; background:url(https://private.example.test)'), brandStylesheet(DEFAULT_BRAND), 'CSS injetado vira a marca padrão');
  assert.equal(brandStylesheet(undefined), brandStylesheet(DEFAULT_BRAND));
  assert.doesNotMatch(brandStylesheet('#123abc;}body{display:none'), /display|url\(|;}/);
});

test('GET /brand.css: marca padrão no host canônico, no-cache com ETag forte e 304, sem sessão', async t => {
  const f = await routeFixture(t), expected = brandStylesheet(DEFAULT_BRAND);
  assert.equal(BRAND_STYLESHEET_PATH, '/brand.css');
  const got = await f.request('/brand.css');
  assert.equal(got.status, 200); assert.equal(got.body, expected);
  assert.equal(got.headers['content-type'], 'text/css; charset=utf-8'); assert.equal(got.headers['cache-control'], 'no-cache');
  assert.equal(got.headers['x-content-type-options'], 'nosniff'); assert.equal(Number(got.headers['content-length']), Buffer.byteLength(expected));
  assert.equal(got.headers.etag, `"${createHash('sha256').update(expected).digest('hex')}"`); assert.equal(got.headers['set-cookie'], undefined);
  for (const tag of [got.headers.etag, `W/${got.headers.etag}`]) assert.equal((await f.request('/brand.css', { headers: { 'If-None-Match': tag } })).status, 304, tag);
  assert.equal((await f.request('/brand.css', { headers: { 'If-None-Match': '"outro"' } })).status, 200);
  // The brand never comes from the request: query strings, forwarded headers and cookies change nothing.
  for (const variant of [{ path: '/brand.css?accent=%23ff0000' }, { headers: { 'X-Forwarded-Host': 'painel.acme.com.br', Cookie: 'mep_session=synthetic' } }]) {
    const other = await f.request(variant.path || '/brand.css', { headers: variant.headers || {} });
    assert.equal(other.status, 200); assert.equal(other.body, expected);
  }
  assert.equal((await f.request('/brand.css', { host: 'nao-vinculado.example.com' })).status, 403, 'host desconhecido continua recusado');
  assert.equal((await f.request('/brand.css', { method: 'POST', headers: { Origin: canonicalOrigin } })).status, 404, 'só GET');
});

test('GET /brand.css no domínio próprio ativo: tokens da marca da revenda; domínio pendente ou sem cor: padrão', async t => {
  const f = await routeFixture(t);
  f.bindDomain('workspace-acme', 'painel.acme.com.br', { name: 'Acme Atendimento', accent: '#e11d48', credential: 'synthetic-private-brand' });
  f.bindDomain('workspace-sem-cor', 'atendimento.semcor.com.br', { name: 'Sem Cor' });
  f.bindDomain('workspace-pendente', 'pendente.acme.com.br', { name: 'Pendente', accent: '#f2a900' }, { active: false });
  const acme = await f.request('/brand.css', { host: 'painel.acme.com.br' });
  assert.equal(acme.status, 200); assert.equal(acme.body, brandStylesheet('#e11d48'));
  assert.match(acme.body, /--b-accent-l: #e11d48;/);
  for (const value of ['synthetic-private-brand', 'workspace-acme', 'Acme Atendimento']) assert.equal(acme.body.includes(value), false, value);
  const neutral = await f.request('/brand.css', { host: 'atendimento.semcor.com.br' });
  assert.equal(neutral.body, brandStylesheet(DEFAULT_BRAND)); assert.notEqual(neutral.headers.etag, acme.headers.etag);
  assert.equal((await f.request('/brand.css', { host: 'pendente.acme.com.br' })).status, 403, 'domínio ainda não ativo');
});

test('manifest e ícones do app instalável saem com o tipo certo e os bytes da fonte', async t => {
  const f = await routeFixture(t);
  for (const [path, type] of [['/manifest.webmanifest', 'application/manifest+json'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/icon-maskable-512.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const got = await f.request(path);
    assert.equal(got.status, 200, path); assert.equal(got.headers['content-type'], type, path); assert.equal(got.headers['cache-control'], 'no-cache', path);
    assert.deepEqual(got.bytes, readFileSync(new URL(`../public${path}`, import.meta.url)), path);
  }
  const png = readFileSync(new URL('../public/icon-512.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); assert.equal(png.readUInt32BE(16), 512); assert.equal(png.readUInt32BE(20), 512);
  assert.equal(readFileSync(new URL('../public/apple-touch-icon.png', import.meta.url)).readUInt32BE(16), 180);
});
