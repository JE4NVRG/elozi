import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarUI, rasterAvatar } from '../public/avatar-ui.js';

const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const response = () => new Response(Buffer.from(photo.split(',')[1], 'base64'), { headers: { 'content-type': 'image/png' } });

function setup(t, fetcher = response) {
  const old = { document: globalThis.document, window: globalThis.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const actor = { userId: 'synthetic-user', workspaceId: 'workspace-a', tenantId: 'tenant-a', accessVersion: 'auth-a' }, elements = [], requests = [], urls = [], revoked = [];
  function image() {
    const events = new Map();
    return { complete: false, naturalWidth: 0, dataset: {}, addEventListener(name, listener) { if (!events.has(name)) events.set(name, []); events.get(name).push(listener); },
      emit(name) { for (const listener of events.get(name) || []) listener(); }, closest() { return this.parent; }, remove() { this.parent.images = this.parent.images.filter(item => item !== this); } };
  }
  function element(id = 'same', kind = 'contacts', { tenantId, modern = false } = {}) {
    const classes = new Set(modern ? ['ui-avatar'] : ['avatar']), value = { dataset: { avatarId: id, avatarKind: kind, ...(tenantId ? { avatarTenant: tenantId } : {}) }, images: [], isConnected: true,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      querySelector: selector => selector === 'img' ? value.images[0] || null : null, append(img) { img.parent = value; value.images.push(img); } };
    elements.push(value); return value;
  }
  globalThis.document = { createElement: kind => { assert.equal(kind, 'img'); return image(); }, querySelectorAll: selector => {
    if (selector === '.avatar img,.ui-avatar img') return elements.flatMap(item => item.images);
    if (selector === '[data-avatar-provider]') return elements.flatMap(item => item.images).filter(img => img.dataset.avatarProvider);
    return elements.filter(item => item.dataset.avatarKind && !item.images.length);
  } };
  globalThis.window = {};
  URL.createObjectURL = blob => { assert.match(blob.type, /^image\/(png|jpeg|webp)$/); const url = 'blob:synthetic-' + (urls.length + 1); urls.push(url); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  const ui = createAvatarUI({ escape, context: () => actor, fetchImpl: (...args) => { requests.push(args); return fetcher(...args); } });
  t.after(() => { ui.reset(); globalThis.document = old.document; globalThis.window = old.window; URL.createObjectURL = old.create; URL.revokeObjectURL = old.revoke; });
  return { ui, actor, elements, element, image, requests, urls, revoked };
}

test('perfil raster é preservado e URLs ativas/remotas, payload inválido e atributos são rejeitados/escapados', t => {
  const c = setup(t); assert.equal(rasterAvatar(photo, 24 * 1024), true);
  const html = c.ui.markup('<Jean "QA">', photo, 'small'); assert.match(html, /<img src="data:image\/png;base64,/); assert.doesNotMatch(html, /<Jean/);
  for (const unsafe of ['https://other.test/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,', 'data:image/png;base64,====', photo + '" onerror="boom', 'data:image/png;base64,' + 'A'.repeat(800 * 1024)]) {
    assert.equal(rasterAvatar(unsafe), false); assert.doesNotMatch(c.ui.markup('Pessoa sem foto', unsafe), /<img/);
  }
  assert.match(c.ui.markup('Pessoa sem foto', null), /avatar-initials/);
});

test('foto já em cache do navegador fica visível e erro mantém iniciais', t => {
  const c = setup(t), node = c.element(); delete node.dataset.avatarKind; const img = c.image(); img.complete = true; img.naturalWidth = 1; node.append(img);
  c.ui.bind(); assert.equal(node.classList.contains('has-photo'), true); assert.equal(c.requests.length, 0);
  img.emit('error'); assert.equal(node.images.length, 0); assert.equal(node.classList.contains('has-photo'), false);
});

test('fetch autenticado coalesce, bind repetido não duplica imagem e cache permanece no mesmo acesso', async t => {
  const gate = deferred(), c = setup(t, () => gate.promise), first = c.element(), second = c.element();
  c.ui.bind(); c.ui.bind(); await tick(); assert.equal(c.requests.length, 1);
  const [path, options] = c.requests[0]; assert.equal(path, '/api/tenants/tenant-a/contacts/same/avatar'); assert.equal(options.headers['X-Elozi-Workspace'], 'workspace-a'); assert.equal(options.credentials, 'same-origin');
  gate.resolve(response()); await tick(); assert.equal(first.images.length, 1); assert.equal(second.images.length, 1); assert.equal(c.urls.length, 1);
  first.images[0].emit('load'); assert.equal(first.classList.contains('has-photo'), true);
  const third = c.element(); c.ui.bind(); await tick(); assert.equal(c.requests.length, 1); assert.equal(third.images[0].src, first.images[0].src);
});

test('resultado tardio nunca entra se empresa/workspace/usuário/autoridade mudar mesmo antes do próximo bind', async t => {
  const c = setup(t);
  for (const field of ['tenantId', 'workspaceId', 'userId', 'accessVersion']) {
    const gate = deferred(); c.ui.reset(); c.elements.length = 0; const node = c.element();
    // Return body only after the authorization context has changed.
    const previous = c.actor[field], fetcher = createAvatarUI({ escape, context: () => c.actor, fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: () => gate.promise }) });
    fetcher.bind(); await tick(); c.actor[field] = 'other-' + field; gate.resolve(Buffer.from(photo.split(',')[1], 'base64')); await tick();
    assert.equal(node.images.length, 0); assert.equal(c.urls.length, 0); c.actor[field] = previous; fetcher.reset();
  }
});

test('mudança de acesso aborta requests e descarta cache anterior, ainda que identidade do contato seja igual', async t => {
  const c = setup(t), first = c.element(); c.ui.bind(); await tick(); const original = first.images[0].src;
  c.elements.length = 0; const second = c.element(); c.actor.tenantId = 'tenant-b'; c.actor.workspaceId = 'workspace-b'; c.ui.bind(); await tick();
  assert.equal(c.requests.length, 2); assert.match(c.requests[1][0], /\/tenant-b\//); assert.equal(c.requests[1][1].headers['X-Elozi-Workspace'], 'workspace-b'); assert.ok(c.revoked.includes(original)); assert.notEqual(second.images[0].src, original);
  const gate = deferred(), pending = createAvatarUI({ escape, context: () => c.actor, fetchImpl: (_path, options) => { c.requests.push(['pending', options]); return gate.promise; } }); c.elements.length = 0; const late = c.element(); pending.bind(); await tick(); pending.reset(); assert.equal(c.requests.at(-1)[1].signal.aborted, true); gate.resolve(response()); await tick(); assert.equal(late.images.length, 0);
});

test('resposta negada/ativa/excessiva falha para iniciais sem retry contínuo e contexto vazio não consulta API', async t => {
  const c = setup(t, () => new Response('No access', { status: 403 })); const node = c.element(); c.ui.bind(); await tick(); c.ui.bind(); await tick(); assert.equal(c.requests.length, 1); assert.equal(node.images.length, 0);
  for (const invalid of [new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(512 * 1024 + 1) } }), new Response(Buffer.alloc(512 * 1024 + 1), { headers: { 'content-type': 'image/png' } })]) {
    const ui = createAvatarUI({ escape, context: () => c.actor, fetchImpl: () => invalid }); ui.bind(); await tick(); assert.equal(node.images.length, 0); ui.reset();
  }
  c.actor.userId = ''; c.ui.bind(); await tick(); assert.equal(c.requests.length, 1);
});

test('lista consolidada sem empresa selecionada separa fotos com o mesmo id em empresas autorizadas', async t => {
  const c = setup(t); c.actor.tenantId = null; c.actor.tenantIds = ['tenant-a', 'tenant-b'];
  const first = c.element('same', 'conversations', { tenantId: 'tenant-a', modern: true });
  const second = c.element('same', 'conversations', { tenantId: 'tenant-b', modern: true });
  const duplicate = c.element('same', 'conversations', { tenantId: 'tenant-a', modern: true });
  c.ui.bind(); await tick();
  assert.deepEqual(c.requests.map(([path]) => path).sort(), ['/api/tenants/tenant-a/conversations/same/avatar', '/api/tenants/tenant-b/conversations/same/avatar']);
  assert.equal(first.images[0].src, duplicate.images[0].src, 'mesma referência coalesce');
  assert.notEqual(first.images[0].src, second.images[0].src, 'empresas não compartilham a foto');
  assert.equal(first.images[0].className, 'ui-avatar__img');
  first.images[0].emit('load'); assert.equal(first.classList.contains('has-photo'), true);
  c.actor.tenantId = 'tenant-b'; c.ui.bind(); await tick();
  assert.equal(c.requests.length, 2, 'abrir uma empresa preserva o cache autorizado da lista');
  assert.equal(c.revoked.length, 0);
});

test('empresa fora do catálogo e referência sem empresa não consultam; 204 mantém o monograma sem retries', async t => {
  const c = setup(t, () => new Response(null, { status: 204 })); c.actor.tenantId = null; c.actor.tenantIds = ['tenant-a'];
  const denied = c.element('same', 'conversations', { tenantId: 'tenant-denied', modern: true });
  const missing = c.element('missing', 'conversations', { modern: true });
  const allowed = c.element('same', 'conversations', { tenantId: 'tenant-a', modern: true });
  c.ui.bind(); await tick(); c.ui.bind(); await tick();
  assert.equal(c.requests.length, 1); assert.match(c.requests[0][0], /\/tenant-a\//);
  assert.equal(denied.images.length, 0); assert.equal(missing.images.length, 0); assert.equal(allowed.images.length, 0);
  assert.equal(c.urls.length, 0); assert.equal(allowed.classList.contains('has-photo'), false);
});

test('remoção de empresa invalida fotos já exibidas e rejeita bytes tardios antes do próximo bind', async t => {
  const gate = deferred(), c = setup(t, path => path.includes('/late/') ? gate.promise : response());
  c.actor.tenantId = null; c.actor.tenantIds = ['tenant-a', 'tenant-b'];
  const shown = c.element('shown', 'conversations', { tenantId: 'tenant-a', modern: true });
  const late = c.element('late', 'conversations', { tenantId: 'tenant-b', modern: true });
  c.ui.bind(); await tick(); shown.images[0].emit('load');
  c.actor.tenantIds = ['tenant-a']; gate.resolve(response()); await tick();
  assert.equal(late.images.length, 0); assert.equal(c.urls.length, 1);
  const old = shown.images[0].src; c.ui.bind(); await tick();
  assert.ok(c.revoked.includes(old)); assert.equal(shown.classList.contains('has-photo'), false);
  assert.notEqual(shown.images[0].src, old); assert.equal(late.images.length, 0);
});

test('resultado pendente não substitui uma referência de linha que mudou e markup legado guarda sua empresa', async t => {
  const gate = deferred(), c = setup(t, () => gate.promise);
  c.actor.tenantIds = ['tenant-a', 'tenant-b'];
  const node = c.element('same', 'conversations', { tenantId: 'tenant-a', modern: true });
  c.ui.bind(); await tick(); node.dataset.avatarTenant = 'tenant-b'; gate.resolve(response()); await tick();
  assert.equal(node.images.length, 0);
  assert.match(c.ui.markup('Cliente', null, '', { kind: 'contacts', id: 'contact' }), /data-avatar-tenant="tenant-a"/);
  assert.match(c.ui.markup('Cliente', null, '', { kind: 'contacts', id: 'contact', tenantId: 'tenant-b' }), /data-avatar-tenant="tenant-b"/);
});

test('callback de visibilidade atrasado não reapresenta foto em cache após mudar a autoridade', async t => {
  const c = setup(t); c.actor.tenantIds = ['tenant-a'];
  c.element('same', 'conversations', { tenantId: 'tenant-a', modern: true }); c.ui.bind(); await tick();
  const next = c.element('same', 'conversations', { tenantId: 'tenant-a', modern: true });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver'); let callback;
  const observer = class { constructor(listener) { callback = listener; } observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: observer }); globalThis.window.IntersectionObserver = observer;
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'IntersectionObserver', previous); else delete globalThis.IntersectionObserver; });
  c.ui.bind(); c.actor.accessVersion = 'revoked-access'; callback([{ target: next, isIntersecting: true }]); await tick();
  assert.equal(next.images.length, 0); assert.equal(c.requests.length, 1);
});
