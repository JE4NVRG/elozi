import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateVersionedPanel } from '../scripts/verify.mjs';

const origin = 'https://synthetic.example.test', assetVersion = '123456abcdef';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const entryPath = `/v/${assetVersion}/app-entry.js`, applicationPath = `/v/${assetVersion}/app.js`;
function fixture({ oldIndex = false, entryBody, applicationMissing = false, entrySource = "import('./app.js').catch(() => {});", immutable = true } = {}) {
  const appSource = 'export const ready = true;', calls = [];
  const served = [{ path: '/app-entry.js', sha256: hash(entrySource) }, { path: '/app.js', sha256: hash(appSource) }];
  const request = async (url, options) => {
    calls.push(url);
    if (url === origin + '/') {
      assert.equal(options?.headers?.Accept, 'application/json', 'panel verification must not request the anonymous marketing representation');
      return new Response(`<script type="module" src="${oldIndex ? applicationPath : entryPath}"></script>`);
    }
    if (url === origin + entryPath) return new Response(entryBody ?? entrySource, { headers: { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } });
    if (url === origin + applicationPath && !applicationMissing) return new Response(appSource, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
    return new Response('not found', { status: 404 });
  };
  return { run: () => validateVersionedPanel({ origin, assetVersion, served, request }), calls };
}

test('versioned panel verifies the entrypoint and its relative application bytes under one immutable version', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { assetVersion, entryPath, applicationPath });
  assert.deepEqual(f.calls, [origin + '/', origin + entryPath, new URL('./app.js', origin + entryPath).href]);
});

test('an old index pointing straight to app.js is refused even if the application source exists', async () => {
  const f = fixture({ oldIndex: true });
  await assert.rejects(f.run(), /Página sem a versão.*ponto de entrada/);
  assert.deepEqual(f.calls, [origin + '/']);
});

test('changed entrypoint bytes or a non-immutable entrypoint are refused', async () => {
  await assert.rejects(fixture({ entryBody: "import('/app.js');" }).run(), /diferente da fonte: app-entry\.js/);
  await assert.rejects(fixture({ immutable: false }).run(), /sem cache imutável: app-entry\.js/);
});

test('a missing relative application or an import escaping its version is refused', async () => {
  await assert.rejects(fixture({ applicationMissing: true }).run(), /Arquivo versionado indisponível.*app\.js/);
  await assert.rejects(fixture({ entrySource: "import('/app.js');" }).run(), /mesma versão relativa/);
});
