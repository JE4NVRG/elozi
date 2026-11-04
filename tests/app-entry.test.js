import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createDocument } from './helpers/inbox-dom.js';

const source = readFileSync(new URL('../public/app-entry.js', import.meta.url), 'utf8').replace("import('./app.js')", 'loadApp()');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(loadApp) {
  const document = createDocument('<div id="app"><div class="loading">Preparando seu workspace…</div></div>');
  let expire, cleared = 0, reloaded = 0;
  runInNewContext(source, { document, loadApp, location: { reload() { reloaded++; } },
    setTimeout(fn, ms) { assert.equal(ms, 30000); expire = fn; return 1; }, clearTimeout() { cleared++; } });
  return { document, expire: () => expire(), cleared: () => cleared, reloaded: () => reloaded };
}
test('a failed module graph replaces the spinner with accessible recovery and keeps the current URL/session', async () => {
  const f = fixture(() => Promise.reject(new TypeError('module transport failure'))); await tick();
  assert.equal(f.document.querySelector('.startup-error').getAttribute('role'), 'alert');
  assert.match(f.document.querySelector('#app').textContent, /Tentar novamente/);
  f.document.querySelector('button').click(); assert.equal(f.reloaded(), 1); assert.equal(f.cleared(), 1);
});
test('a stalled module graph times out, while a loaded application owns its UI', async () => {
  const f = fixture(() => new Promise(() => {})); f.expire();
  assert.ok(f.document.querySelector('.startup-error'));
  const loaded = fixture(() => Promise.resolve()); await tick();
  loaded.document.querySelector('#app').innerHTML = '<main>Workspace carregado</main>';
  loaded.expire(); assert.equal(loaded.document.querySelector('.startup-error'), null); assert.equal(loaded.cleared(), 1);
});
