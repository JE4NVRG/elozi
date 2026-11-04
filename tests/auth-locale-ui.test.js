import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHash, formatHash } from '../public/router.js';

const [login, markup, engine, catalog, google] = await Promise.all(['login.js', 'login.html', 'i18n.js', 'locales-auth.js', 'google-ui.js'].map(file => readFile(new URL('../public/' + file, import.meta.url), 'utf8')));
const executable = source => source.replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=(?:async )?function|const)/g, '');
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const password = 'Synthetic-password-4567';
async function fixture({ locale = 'pt-BR', href = 'https://synthetic.invalid/login', steps = [], statusError } = {}) {
  let document;
  class Element {
    constructor(tag) {
      this.attributes = new Map([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]])); this.id = this.attributes.get('id');
      this.dataset = { i18n: this.attributes.get('data-i18n') }; this.value = ''; this.textContent = ''; this.firstChild = { textContent: '' }; this.events = new Map();
      this.hidden = /\shidden(?:\s|>)/.test(tag); this.disabled = /\sdisabled(?:\s|>)/.test(tag); this.type = this.attributes.get('type') || ''; this.focused = false;
    }
    addEventListener(type, callback) { this.events.set(type, callback); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    focus() { this.focused = true; document.activeElement = this; }
    reportValidity() { return true; }
    replaceChildren() {}
    insertAdjacentElement(_where, element) { nodes.push(element); elements.set(element.id, element); }
    closest() { return null; }
  }
  const nodes = [...markup.matchAll(/<[^>]+>/g)].map(match => new Element(match[0])), elements = new Map(nodes.filter(node => node.id).map(node => [node.id, node])), el = id => { assert.ok(elements.has(id), id); return elements.get(id); };
  const stored = new Map([['elozi:locale', locale]]), listeners = new Map(), calls = [], navigation = [], mounts = [], pendingSteps = [...steps], unexpected = [];
  let currentURL = new URL(href);
  const window = { location: { get href() { return currentURL.href; }, get pathname() { return currentURL.pathname; }, replace(target) { navigation.push(target); } }, history: { replaceState(_state, _title, target) { currentURL = new URL(target, currentURL); } }, addEventListener(type, callback) { listeners.set(type, callback); }, dispatchEvent(event) { listeners.get(event.type)?.(event); } };
  document = { title: 'Entrar · Elozi', documentElement: { lang: '', style: { setProperty() {} } }, activeElement: null, querySelector(selector) { if (selector === '.wordmark-symbol img') return new Element('<img>'); return el(selector.slice(1)); }, createElement(tag) { return new Element(`<${tag}>`); }, querySelectorAll(selector) { const key = selector.slice(1, -1); return nodes.filter(node => node.attributes.has(key)); } };
  const fetch = async (path, options = {}) => {
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, method, payload });
    if (path === '/api/auth/status') { if (statusError) throw statusError; return { ok: true, status: 200, json: async () => ({ setupRequired: false, registrationEnabled: true, productName: 'Marca Nome Usuário', google: { enabled: false } }) }; }
    const next = pendingSteps.shift();
    if (!next || next.path !== path || (next.method || 'GET') !== method) { unexpected.push({ path, method }); throw new Error('Unexpected synthetic request'); }
    if (next.error) throw next.error;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.data || {} };
  };
  const context = vm.createContext({ window, document, URL, URLSearchParams, AbortSignal, fetch, parseHash, formatHash, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) }, mountGoogleButton: async () => { const mount = { renderLocale() { mounts.push('locale'); }, destroy() {} }; return mount; } });
  await new vm.Script(`(async()=>{\n${executable(engine)}\n${executable(catalog)}\n${executable(login)}\n})()`).runInContext(context); await settle();
  const emit = async (id, type) => { await el(id).events.get(type)?.({ target: el(id), preventDefault() {} }); await settle(); };
  return { el, nodes, calls, navigation, stored, document, unexpected,
    async language(value) { el('login-locale').value = value; await emit('login-locale', 'change'); },
    fill() { el('username').value = 'Usuário.literal@example.test'; el('name').value = 'Nome Criar minha conta'; el('company').value = 'Empresa Português'; el('email').value = 'Literal@example.test'; el('password').value = password; el('password-confirmation').value = password; },
    submit: () => emit('access-form', 'submit'), emit, done() { assert.deepEqual(unexpected, []); assert.equal(pendingSteps.length, 0); }
  };
}

test('login troca PT/EN com engine real sem alterar conteúdo digitado, foco ou autenticação', async () => {
  const f = await fixture(); f.fill(); f.el('password').focus(); const focused = f.document.activeElement;
  await f.language('en');
  assert.equal(f.document.documentElement.lang, 'en'); assert.equal(f.el('form-heading').textContent, 'Good to have you here.'); assert.equal(f.el('username-field').firstChild.textContent, 'Username or email');
  assert.equal(f.el('password').value, password); assert.equal(f.el('name').value, 'Nome Criar minha conta'); assert.equal(f.el('username').value, 'Usuário.literal@example.test'); assert.equal(f.document.activeElement, focused); assert.equal(f.calls.length, 1); assert.deepEqual(f.navigation, []);
  assert.ok(f.nodes.some(node => node.dataset.i18n === 'Equipes que resolvem.' && node.textContent === 'Teams that get things done.'));
  await f.language('pt-BR'); assert.equal(f.el('form-heading').textContent, 'Que bom ter você por aqui.'); assert.equal(f.el('password').value, password); assert.equal(f.stored.get('elozi:locale'), 'pt-BR'); f.done();
});

test('preferência escolhida só é persistida depois da sessão confirmada e não repete senha', async () => {
  const f = await fixture({ steps: [{ path: '/api/auth/login', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { locale: 'pt-BR' } } }, { path: '/api/auth/me', method: 'PATCH', status: 200, data: { user: { locale: 'en' } } }] });
  f.fill(); await f.language('en'); await f.submit();
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`), ['GET /api/auth/status', 'POST /api/auth/login', 'GET /api/auth/me', 'PATCH /api/auth/me']);
  assert.equal(f.calls[1].payload.password, password); assert.deepEqual(f.calls[3].payload, { locale: 'en' }); assert.deepEqual(f.navigation, ['/']); f.done();
});

test('conta mantém preferência EN sem PATCH automático e falha de locale não pede senha novamente', async () => {
  const existing = await fixture({ steps: [{ path: '/api/auth/login', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { locale: 'en' } } }] });
  existing.fill(); await existing.submit(); assert.equal(existing.document.documentElement.lang, 'en'); assert.equal(existing.calls.length, 3); existing.done();
  const failed = await fixture({ steps: [{ path: '/api/auth/login', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { locale: 'pt-BR' } } }, { path: '/api/auth/me', method: 'PATCH', error: new TypeError('Synthetic offline') }] });
  failed.fill(); await failed.language('en'); await failed.submit(); assert.equal(failed.calls.filter(call => call.path === '/api/auth/login').length, 1); assert.equal(failed.el('access-form').hidden, true);
  assert.match(failed.el('success-message').textContent, /language could not be saved/); assert.equal(failed.el('workspace-link').getAttribute('href'), '/'); assert.deepEqual(failed.navigation, []); failed.done();
});

test('login confirmado retorna somente para hash interno reconhecido e elimina pesquisa, token e parâmetros privados',async()=>{
  for(const [next,expected]of [['/#inbox/company-a/conversation-a?w=workspace-a&q=SyntheticPrivateSearch&token=SyntheticPrivateToken','/#inbox/company-a/conversation-a?w=workspace-a'],['https://outside.example/','/'],['//outside.example/','/'],['/api/auth/me','/'],['/login?return=close','/'],['/#unknown/SyntheticPrivateToken','/'],['/#/inbox/company-a/conversation-a','/']]){
    const f=await fixture({href:'https://synthetic.invalid/login?next='+encodeURIComponent(next),steps:[{path:'/api/auth/login',method:'POST',status:200},{path:'/api/auth/me',status:200,data:{user:{id:'human-a',locale:'pt-BR'}}}]});f.fill();await f.submit();assert.deepEqual(f.navigation,[expected]);assert.equal(f.calls.filter(call=>call.path==='/api/auth/login').length,1);assert.ok(!f.navigation[0].includes('SyntheticPrivate'));f.done();
  }
});

test('login EN mantém erro traduzido conhecido e credenciais literais na mesma tentativa', async () => {
  const f = await fixture({ locale: 'en', steps: [{ path: '/api/auth/login', method: 'POST', status: 401, data: { error: 'Usuário ou senha inválidos.' } }] });
  f.fill(); await f.submit(); assert.equal(f.el('form-error').textContent, 'Invalid username or password.'); assert.equal(f.el('password').value, password); assert.equal(f.calls[1].payload.username, 'Usuário.literal@example.test');
  await f.language('pt-BR'); assert.equal(f.el('form-error').textContent, 'Usuário ou senha inválidos.'); assert.deepEqual(f.navigation, []); f.done();
});

test('convite EN traduz somente produto e preserva nomes, destinatário e token fora da URL', async () => {
  const f = await fixture({ locale: 'en', href: 'https://synthetic.invalid/accept-invite#token=SyntheticInvitation12345', steps: [{ path: '/api/auth/invitations/preview', method: 'POST', status: 200, data: { name: 'Nome Português', email: 'Literal@example.test', workspaceName: 'Empresa Atendimento', tenantNames: ['Nome Equipe'], role: 'operator', expiresAt: '2026-10-06T12:00:00Z' } }] });
  assert.equal(f.el('form-heading').textContent, 'You already have a place on the team.'); assert.equal(f.el('name').value, 'Nome Português'); assert.equal(f.el('email').value, 'Literal@example.test'); assert.equal(f.el('invitation-workspace').textContent, 'Empresa Atendimento'); assert.equal(f.el('invitation-role').textContent, 'Support representative');
  f.el('password').value = password; await f.language('pt-BR'); assert.equal(f.el('password').value, password); assert.equal(f.el('name').value, 'Nome Português'); assert.equal(f.el('invitation-role').textContent, 'Atendente'); f.done();
});

test('estados de conexão, link inválido e confirmação de e-mail acompanham idioma sem repetir pedidos', async () => {
  const offline = await fixture({ statusError: new TypeError('Synthetic offline') });
  await offline.language('en'); assert.equal(offline.el('form-heading').textContent, 'Let’s restore the connection.'); assert.match(offline.el('status-error').textContent, /connection/); assert.equal(offline.calls.length, 1); offline.done();
  const invalid = await fixture({ href: 'https://synthetic.invalid/accept-invite#token=SyntheticInvitation12345', steps: [{ path: '/api/auth/invitations/preview', method: 'POST', status: 410, data: { error: 'Convite inválido ou expirado.' } }] });
  await invalid.language('en'); assert.equal(invalid.el('form-heading').textContent, 'Let’s restore your access.'); assert.equal(invalid.el('form-intro').textContent, 'This link could not be confirmed.'); assert.equal(invalid.el('access-form').hidden, true); assert.equal(invalid.calls.length, 1); invalid.done();
  const verified = await fixture({ href: 'https://synthetic.invalid/verify-email?token=SyntheticVerification12345', steps: [{ path: '/api/auth/verify-email', method: 'POST', status: 200 }] });
  await verified.language('en'); assert.equal(verified.el('verification-status').textContent, 'Email confirmed. You can now continue with your account.');
  await verified.language('pt-BR'); assert.equal(verified.el('verification-status').textContent, 'E-mail confirmado. Você já pode continuar com sua conta.'); assert.equal(verified.calls.filter(call => call.path === '/api/auth/verify-email').length, 1); verified.done();
});

test('Google rerender locale não renova nonce nem repete callback de identidade', async () => {
  const renders = [], initializations = [], credentials = [], sdk = { initialize(options) { initializations.push(options); }, renderButton(_element, options) { renders.push(options); } };
  const context = vm.createContext({ window: { google: { accounts: { id: sdk } } } });
  new vm.Script(`${executable(engine)}\n${executable(catalog)}\n${executable(google)}\nthis.mount=mountGoogleButton;this.language=setLocale;`).runInContext(context);
  const element = { hidden: false, isConnected: true, replaceChildren() {}, getBoundingClientRect: () => ({ width: 350 }) }, config = { enabled: true, clientId: 'synthetic-locale.apps.googleusercontent.com', nonce: 'Synthetic_nonce_12345' };
  const mount = await context.mount(element, config, credential => credentials.push(credential)); assert.equal(renders.at(-1).locale, 'pt-BR');
  context.language('en'); mount.renderLocale(); assert.equal(renders.at(-1).locale, 'en'); assert.equal(initializations.length, 1); assert.equal(initializations[0].nonce, config.nonce); assert.deepEqual(credentials, []);
  initializations[0].callback({ credential: 'LiteralSyntheticIDToken' }); assert.deepEqual(credentials, ['LiteralSyntheticIDToken']); mount.destroy();
});
