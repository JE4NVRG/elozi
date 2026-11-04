// Versioned asset URLs: the pages point at /v/<version>/<file>, served with a one-year immutable cache, so a browser never
// revalidates a module and still loads the new files after a release (the version is the hash of every asset's ETag).
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { PANEL_ASSETS } from '../src/panel-assets.js';

const canonicalHost = 'elozi.je4ndev.com', canonicalOrigin = `https://${canonicalHost}`;

async function fixture(t) {
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
  return (path, headers = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method: 'GET', headers: { Host: canonicalHost, ...headers } }, response => {
      const chunks = []; response.on('error', reject); response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject); outgoing.end();
  });
}

test('as páginas apontam para /v/<versão>/ e esses arquivos têm cache imutável; o caminho sem versão continua igual', async t => {
  const request = await fixture(t);
  const page = await request('/login');
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store');
  const version = /\/v\/([a-f0-9]{12})\/login\.js/.exec(page.body)?.[1];
  assert.ok(version, 'login.js vem com versão');
  assert.match(page.body, new RegExp(`href="/v/${version}/tokens\\.css"`)); assert.match(page.body, /href="\/brand\.css"/, 'o /brand.css dinâmico fica sem versão');
  assert.doesNotMatch(page.body, /(?:href|src)="\/(?!v\/|brand\.css|login"|")[a-z0-9.-]+\.(?:css|js)"/, 'nenhum asset da lista sem versão');
  const index = await request('/', { Accept: 'application/json' });
  assert.match(index.body, new RegExp(`src="/v/${version}/app-entry\\.js"`), 'a mesma versão nas duas páginas');
  const entry = await request(`/v/${version}/app-entry.js`);
  assert.equal(entry.status, 200); assert.equal(entry.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(entry.bytes, readFileSync(new URL('../public/app-entry.js', import.meta.url)));
  assert.match(entry.body, /import\('\.\/app\.js'\)/, 'o aplicativo é relativo à mesma versão do entrypoint');
  assert.match(index.body, /href="\/manifest\.webmanifest"/, 'o app instalado guarda o endereço do manifesto');
  assert.equal((await request(`/v/${version}/manifest.webmanifest`)).status, 404, 'só CSS e JS têm versão');
  const asset = await request(`/v/${version}/app.js`);
  assert.equal(asset.status, 200); assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(asset.bytes, readFileSync(new URL('../public/app.js', import.meta.url)));
  const plain = await request('/app.js');
  assert.equal(plain.headers['cache-control'], 'no-cache'); assert.deepEqual(plain.bytes, asset.bytes);
  const old = await request('/v/000000000000/app.js');
  assert.equal(old.status, 200); assert.equal(old.headers['cache-control'], 'no-cache', 'versão antiga recebe o arquivo atual sem cache longo');
  assert.equal((await request(`/v/${version}/nao-existe.js`)).status, 404);
  assert.equal((await request(`/v/${version}/../src/server.js`)).status, 404);
  // The same version that scripts/verify.mjs recomputes from the source: SHA-256 of every panel asset's quoted ETag.
  const etag = file => `"${createHash('sha256').update(readFileSync(new URL(`../public/${file}`, import.meta.url))).digest('hex')}"`;
  assert.equal(version, createHash('sha256').update(PANEL_ASSETS.map(etag).join('\n')).digest('hex').slice(0, 12));
});
