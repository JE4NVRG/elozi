import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/google-ui.js', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*\n/gm, '')
  .replace('export async function mountGoogleButton', 'async function mountGoogleButton');
const config = { enabled: true, clientId: 'synthetic-test.apps.googleusercontent.com', nonce: 'synthetic_nonce_12345' };

function fixture({ resizeAvailable = true } = {}) {
  const renders = [], initializes = [], observers = [], credentials = [];
  const sdk = { initialize(options) { initializes.push(options); }, renderButton(element, options) { renders.push({ element, ...options }); } };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
  }
  const window = { google: { accounts: { id: sdk } }, ...(resizeAvailable ? { ResizeObserver } : {}) };
  const context = vm.createContext({ window, getLocale: () => 'pt-BR' });
  new vm.Script(source + '\nthis.mount = mountGoogleButton;').runInContext(context);
  const element = (width = 380) => ({ width, isConnected: true, hidden: false, clears: 0,
    getBoundingClientRect() { return { width: this.width }; }, replaceChildren() { this.clears++; } });
  return { renders, initializes, observers, credentials, element,
    mount: el => context.mount(el, config, credential => credentials.push(credential)) };
}

test('Google acompanha desktop/celular sem renovar desafio nem reenviar identidade', async () => {
  const f = fixture(), el = f.element();
  await f.mount(el);
  assert.equal(f.renders.at(-1).width, '380');
  el.width = 323; f.observers[0].callback();
  assert.equal(f.renders.at(-1).width, '323');
  el.width = 380; f.observers[0].callback();
  assert.equal(f.renders.at(-1).width, '380');
  assert.equal(f.initializes.length, 1);
  assert.equal(f.initializes[0].nonce, config.nonce);
  assert.deepEqual(f.credentials, []);
  f.initializes[0].callback({ credential: 'synthetic-id-token' });
  assert.deepEqual(f.credentials, ['synthetic-id-token']);
});

test('notificações de tamanho iguais ou botão oculto não recriam iframe Google', async () => {
  const f = fixture(), el = f.element(); await f.mount(el);
  const initial = f.renders.length;
  f.observers[0].callback(); el.width = 0; f.observers[0].callback();
  assert.equal(f.renders.length, initial);
  el.width = 323; f.observers[0].callback(); f.observers[0].callback();
  assert.equal(f.renders.length, initial + 1);
});

test('destruir Google desconecta observer e recusa callbacks tardios de resize e login', async () => {
  const f = fixture(), el = f.element(), mount = await f.mount(el);
  mount.destroy(); assert.equal(f.observers[0].disconnected, true);
  const initial = f.renders.length; el.width = 323; f.observers[0].callback();
  f.initializes[0].callback({ credential: 'synthetic-stale-token' });
  assert.equal(f.renders.length, initial); assert.deepEqual(f.credentials, []);
});

test('trocar de modo Google mantém só novo botão e novo retorno ativos', async () => {
  const f = fixture(), old = f.element(); await f.mount(old);
  const current = f.element(323); await f.mount(current);
  assert.equal(f.observers[0].disconnected, true);
  const initial = f.renders.length; old.width = 250; f.observers[0].callback();
  f.initializes[0].callback({ credential: 'synthetic-stale-token' });
  assert.equal(f.renders.length, initial); assert.deepEqual(f.credentials, []);
  current.width = 280; f.observers[1].callback();
  assert.equal(f.renders.at(-1).element, current);
  assert.equal(f.renders.at(-1).width, '280');
  f.initializes[1].callback({ credential: 'synthetic-current-token' });
  assert.deepEqual(f.credentials, ['synthetic-current-token']);
});

test('Google sem ResizeObserver continua disponível e botão desconectado não recria iframe', async () => {
  const f = fixture({ resizeAvailable: false }), el = f.element(323); await f.mount(el);
  assert.equal(f.renders[0].width, '323'); assert.equal(f.observers.length, 0);
  const g = fixture(), gone = g.element(); await g.mount(gone);
  gone.isConnected = false; gone.width = 323; g.observers[0].callback();
  g.initializes[0].callback({ credential: 'synthetic-detached-token' });
  assert.equal(g.renders.length, 1); assert.deepEqual(g.credentials, []);
});
