// Expired session (FRONTEND-V2 §7.2, §8.3 P2): a 401 never leaves the page, the dialog opens once,
// /login?return=close runs in a new window and reauth-ok resumes the panel with the drafts kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionExpired, resetSessionGuard, reauthPending, REAUTH_URL } from '../public/session-guard.js';
import { createDraftsStore } from '../public/drafts-store.js';
import { createLiveRegistry, provideLiveContext } from '../public/live.js';

function memoryStorage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
// A node that answers the selectors session-guard.js uses on its dialog.
function node(marker) {
  return { marker, hidden: marker === 'error' || marker === 'here', textContent: '', focused: 0, focus() { this.focused++; }, closest(selector) { return selector === `[data-reauth-${marker}]` ? this : null; } };
}
function environment({ popup = true } = {}) {
  const events = [], opened = [], assigned = [], listeners = {};
  const nodes = { open: node('open'), here: node('here'), error: node('error') };
  const dialog = {
    open: false, isConnected: true, attributes: {}, listeners: {}, innerHTML: '', className: '',
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; },
    showModal() { this.open = true; this.shown = (this.shown || 0) + 1; }, close() { this.open = false; }, remove() { this.isConnected = false; },
    querySelector(selector) { return { '[data-reauth-open]': nodes.open, '[data-reauth-error]': nodes.error, '[data-reauth-here]': nodes.here }[selector] || null; }
  };
  const doc = { body: { appended: [], append(element) { this.appended.push(element); } }, createElement: tag => { assert.equal(tag, 'dialog'); return dialog; } };
  const win = {
    location: { origin: 'https://painel.example.test' },
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    dispatchEvent(event) { events.push(event.type); for (const fn of listeners[event.type] || []) fn(event); return true; },
    open(url, name, features) { opened.push([url, name, features]); return popup ? { focus() {} } : null; },
    message(data, origin = 'https://painel.example.test') { for (const fn of listeners.message || []) fn({ data, origin }); }
  };
  const location = { assign: url => assigned.push(url) };
  return { doc, win, location, dialog, nodes, events, opened, assigned };
}

test.afterEach(() => resetSessionGuard());

test('sem página para o diálogo, mantém o comportamento anterior: interrompe, descarta e abre o login', () => {
  const order = [];
  assert.equal(sessionExpired({ abort: () => order.push('abort'), discard: () => order.push('discard'), location: { assign: url => order.push(url) } }), true);
  assert.deepEqual(order, ['abort', 'discard', '/login?reason=session-expired']);
  assert.equal(reauthPending(), false);
});

test('401 não navega: pausa (elozi:reauth), mostra um único diálogo e preserva compositor e anexos', () => {
  const env = environment(), calls = [];
  const options = { abort: () => calls.push('abort'), discard: () => calls.push('discard'), location: env.location, document: env.doc, window: env.win };
  sessionExpired(options);
  sessionExpired(options);
  sessionExpired(options);
  assert.deepEqual(calls, ['abort', 'abort', 'abort'], 'os carregadores da sessão antiga param; nada privado é descartado');
  assert.deepEqual(env.assigned, [], 'nenhuma navegação');
  assert.deepEqual(env.events, ['elozi:reauth'], 'um único evento, por mais 401 que cheguem');
  assert.equal(env.doc.body.appended.length, 1); assert.equal(env.dialog.open, true);
  assert.match(env.dialog.innerHTML, /Sua sessão expirou\./); assert.match(env.dialog.innerHTML, /Entrar novamente/);
  assert.equal(env.dialog.attributes['aria-labelledby'], 'lv-reauth-title');
  const cancel = { prevented: false, preventDefault() { this.prevented = true; } };
  env.dialog.listeners.cancel(cancel);
  assert.equal(cancel.prevented, true, 'Esc não fecha o diálogo e deixa a página inerte');
  assert.equal(reauthPending(), true);
});

test('Entrar novamente abre /login?return=close em nova janela; janela bloqueada oferece entrar nesta aba', () => {
  const env = environment({ popup: false });
  sessionExpired({ location: env.location, document: env.doc, window: env.win });
  env.dialog.listeners.click({ target: env.nodes.open, preventDefault() {} });
  assert.deepEqual(env.opened[0].slice(0, 2), [REAUTH_URL, 'elozi-reauth']);
  assert.equal(REAUTH_URL, '/login?return=close&reason=session-expired');
  assert.equal(env.nodes.error.hidden, false); assert.match(env.nodes.error.textContent, /bloqueou/);
  assert.equal(env.nodes.here.hidden, false);
  env.dialog.listeners.click({ target: env.nodes.here, preventDefault() {} });
  assert.deepEqual(env.assigned, ['/login?reason=session-expired'], 'só quando a pessoa escolhe entrar nesta aba');
});

test('reauth-ok da mesma origem e da mesma pessoa retoma, fecha o diálogo e libera os rascunhos', () => {
  const env = environment(), storage = memoryStorage(), registry = createLiveRegistry();
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1' }), registry);
  sessionExpired({ location: env.location, document: env.doc, window: env.win, registry });
  const store = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage });
  store.set({ tenantId: 't', conversationId: 'c' }, 'Texto digitado antes do 401');
  assert.equal(store.clear(), false, 'o 401 da lista não apaga os rascunhos enquanto a reautenticação está pendente');
  assert.equal(createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage }).get({ tenantId: 't', conversationId: 'c' }), 'Texto digitado antes do 401');
  env.win.message({ type: 'elozi:reauth-ok', userId: 'u1' }, 'https://outro.example.test');
  assert.equal(reauthPending(), true, 'mensagem de outra origem é ignorada');
  env.win.message({ type: 'outra-coisa' });
  assert.equal(reauthPending(), true);
  env.win.message({ type: 'elozi:reauth-ok', userId: 'u1' });
  assert.equal(reauthPending(), false);
  assert.deepEqual(env.events, ['elozi:reauth', 'elozi:reauth-ok']);
  assert.equal(env.dialog.open, false); assert.equal(env.dialog.isConnected, false);
  assert.deepEqual(env.assigned, []);
  env.win.message({ type: 'elozi:reauth-ok', userId: 'u1' });
  assert.deepEqual(env.events, ['elozi:reauth', 'elozi:reauth-ok'], 'a segunda confirmação (opener e canal) não repete');
  assert.equal(store.clear(), true, 'depois da reautenticação o clear volta a valer');
});

test('outra pessoa entrou na janela: os rascunhos da anterior somem e o painel recarrega', () => {
  const env = environment(), registry = createLiveRegistry();
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1' }), registry);
  const original = globalThis.sessionStorage, storage = memoryStorage();
  globalThis.sessionStorage = storage;
  try {
    storage.setItem('elozi:draft:v1:u1:w1:t:c', JSON.stringify({ text: 'privado', mode: 'reply', updatedAt: Date.now() }));
    storage.setItem('outra-chave', 'mantida');
    sessionExpired({ location: env.location, document: env.doc, window: env.win, registry });
    env.win.message({ type: 'elozi:reauth-ok', userId: 'u2' });
    assert.deepEqual(env.assigned, ['/']);
    assert.equal(storage.getItem('elozi:draft:v1:u1:w1:t:c'), null);
    assert.equal(storage.getItem('outra-chave'), 'mantida');
  } finally { if (original === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = original; }
});

test('login.js com return=close avisa o painel só na própria origem e fecha a janela', () => {
  const source = readFileSync(new URL('../public/login.js', import.meta.url), 'utf8');
  assert.match(source, /postMessage\?\.\(message, window\.location\.origin\)/, 'postMessage restrito à origem do painel');
  assert.match(source, /new BroadcastChannel\('elozi-auth'\)/);
  assert.match(source, /if \(returnClose\) \{[\s\S]*window\.close\(\)/);
  assert.doesNotMatch(source, /postMessage\([^)]*'\*'\)/, 'nunca para qualquer origem');
});
