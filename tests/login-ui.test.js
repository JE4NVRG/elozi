import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [source, html] = await Promise.all([
  readFile(new URL('../public/login.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/login.html', import.meta.url), 'utf8')
]);
const executable = source.replace(/^import[^\n]*\n/gm, '');
const secret = 'Synthetic-password-4567';
const response = (status, data = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

class Element {
  constructor(id, tag) {
    this.id = id; this.value = ''; this.textContent = ''; this.firstChild = { textContent: '' };
    this.hidden = /\shidden(?:\s|>)/.test(tag); this.disabled = /\sdisabled(?:\s|>)/.test(tag);
    this.type = /\stype="([^"]+)"/.exec(tag)?.[1] || '';
    this.attributes = new Map([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    this.events = new Map(); this.focused = false;
  }
  addEventListener(type, callback) { this.events.set(type, callback); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  reportValidity() { return true; }
  replaceChildren() {}
  insertAdjacentElement() {}
}

async function fixture({ setup = false, href = 'https://ui.example.test/login', steps = [], windowExtra = {}, globals = {} } = {}) {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], new Element(match[1], match[0])]));
  const element = id => { assert.ok(elements.has(id), `Elemento #${id} presente no HTML real`); return elements.get(id); };
  const calls = [], navigation = [], history = [], unexpected = [];
  let currentURL = new URL(href);
  const location = {
    get href() { return currentURL.href; }, get origin() { return currentURL.origin; }, get pathname() { return currentURL.pathname; },
    get search() { return currentURL.search; }, get hash() { return currentURL.hash; },
    replace(target) { navigation.push(target); }
  };
  const window = { location, history: { replaceState(_state, _title, target) { history.push(target); currentURL = new URL(target, currentURL); } }, ...windowExtra };
  const document = {
    querySelector(selector) { assert.match(selector, /^#[\w-]+$/); return element(selector.slice(1)); },
    createElement() { return new Element('', '<p>'); }
  };
  const fetch = async (path, options = {}) => {
    const method = options.method || 'GET'; calls.push({ path, method });
    if (path === '/api/auth/status') return response(200, { setupRequired: setup, registrationEnabled: true, google: { enabled: false } });
    const next = steps.shift();
    if (!next || next.path !== path || (next.method || 'GET') !== method) {
      unexpected.push({ path, method }); throw new Error('Unexpected fixture request');
    }
    if (next.error) throw next.error;
    if (next.pending) return next.pending;
    return response(next.status, next.data);
  };
  const context = vm.createContext({ document, window, location, history: window.history, fetch, URL, AbortSignal,
    t: source => source, getLocale: () => 'pt-BR', setLocale: () => 'pt-BR', translateError: source => source, translateStatic: () => {},
    mountGoogleButton: async () => null, ...globals });
  await new vm.Script(`(async () => {\n${executable}\n})()`, { filename: 'public/login.js' }).runInContext(context);
  await settle();
  const emit = (id, type) => {
    const callback = element(id).events.get(type); assert.equal(typeof callback, 'function');
    return callback({ preventDefault() {} });
  };
  return { element, elements, calls, navigation, history, unexpected,
    get url() { return currentURL; },
    register() { emit('registration-toggle', 'click'); },
    submit() { return emit('access-form', 'submit'); },
    fill() {
      element('name').value = 'Pessoa sintética'; element('company').value = 'Empresa sintética';
      element('email').value = 'ui@example.test'; element('username').value = 'ui-fixture';
      element('password').value = secret; element('password-confirmation').value = secret;
    },
    assertComplete() { assert.deepEqual(unexpected, []); assert.equal(steps.length, 0); }
  };
}

const sequence = ui => ui.calls.map(({ path, method }) => `${method} ${path}`);
const preserved = ui => {
  assert.equal(ui.element('password').value, secret);
  assert.equal(ui.element('password-confirmation').value, secret);
  assert.deepEqual(ui.navigation, []);
};

test('cadastro só limpa as senhas e abre o workspace após confirmar a sessão', async () => {
  let confirm;
  const pending = new Promise(resolve => { confirm = resolve; });
  const ui = await fixture({ steps: [
    { path: '/api/auth/register', method: 'POST', status: 200 },
    { path: '/api/auth/me', pending }
  ] });
  ui.register(); ui.fill(); const submitting = ui.submit(); await settle();
  preserved(ui);
  assert.equal(ui.element('access-success').hidden, true);
  assert.deepEqual(sequence(ui), ['GET /api/auth/status', 'POST /api/auth/register', 'GET /api/auth/me']);
  confirm(response(200, { user: { id: 'fixture-user' } })); await submitting;
  assert.equal(ui.element('password').value, ''); assert.equal(ui.element('password-confirmation').value, '');
  assert.equal(ui.element('access-form').hidden, true); assert.equal(ui.element('registration-toggle').hidden, true);
  assert.equal(ui.element('access-success').hidden, false);
  assert.ok(ui.element('success-message').textContent.trim());
  assert.equal(ui.element('workspace-link').getAttribute('href'), '/');
  assert.deepEqual(ui.navigation, ['/']); ui.assertComplete();
});

test('"Criar conta" do site público (/login?cadastro=1) abre o cadastro, limpa o parâmetro e preserva o link profundo', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login?cadastro=1#inbox/t1/c1' });
  assert.equal(ui.element('registration-toggle').firstChild.textContent, 'Já tenho uma conta. Entrar ');
  assert.equal(ui.url.search, ''); assert.equal(ui.url.hash, '#inbox/t1/c1');
  ui.assertComplete();
});

for (const status of [400, 409]) {
  test(`erro ${status} do cadastro mantém os dados e mostra o motivo sem consultar a sessão`, async () => {
    const message = status === 400 ? 'Informe um e-mail válido.' : 'Este e-mail já está cadastrado.';
    const ui = await fixture({ steps: [{ path: '/api/auth/register', method: 'POST', status, data: { error: message } }] });
    ui.register(); ui.fill(); await ui.submit();
    preserved(ui);
    assert.equal(ui.element('name').value, 'Pessoa sintética'); assert.equal(ui.element('company').value, 'Empresa sintética');
    assert.equal(ui.element('email').value, 'ui@example.test'); assert.equal(ui.element('email').disabled, false);
    assert.equal(ui.element('form-error').hidden, false); assert.equal(ui.element('form-error').textContent, message);
    assert.equal(ui.element('submit-button').disabled, false);
    assert.deepEqual(sequence(ui), ['GET /api/auth/status', 'POST /api/auth/register']); ui.assertComplete();
  });
}

for (const setup of [false, true]) {
  test(`${setup ? 'primeiro acesso' : 'cadastro'} criado com sessão recusada orienta login sem apagar as senhas`, async () => {
    const ui = await fixture({ setup, steps: [
      { path: setup ? '/api/auth/setup' : '/api/auth/register', method: 'POST', status: 200 },
      { path: '/api/auth/me', status: 401, data: { error: 'Sessão inválida ou expirada.' } }
    ] });
    if (!setup) ui.register(); ui.fill(); await ui.submit();
    preserved(ui);
    assert.equal(ui.element('username').disabled, false);
    assert.equal(ui.element('username').value, setup ? 'ui-fixture' : 'ui@example.test');
    assert.equal(ui.element('password-confirmation').disabled, true);
    assert.match(ui.element('submit-button').firstChild.textContent, /Entrar/);
    assert.equal(ui.element('form-error').hidden, false);
    assert.match(ui.element('form-error').textContent, /(?:conta|acesso).*(?:criad|cadastrad)/i);
    assert.deepEqual(sequence(ui), ['GET /api/auth/status', `POST /api/auth/${setup ? 'setup' : 'register'}`, 'GET /api/auth/me']);
    ui.assertComplete();
  });
}

test('falha de rede na confirmação mantém as senhas e impede reenviar cadastro já criado', async () => {
  const ui = await fixture({ steps: [
    { path: '/api/auth/register', method: 'POST', status: 200 },
    { path: '/api/auth/me', error: new TypeError('Synthetic offline fixture') },
    { path: '/api/auth/login', method: 'POST', status: 400, data: { error: 'Tentativa sintética interrompida.' } }
  ] });
  ui.register(); ui.fill(); await ui.submit(); preserved(ui);
  assert.equal(ui.element('form-error').hidden, false);
  assert.match(ui.element('form-error').textContent, /(?:conta|acesso).*(?:criad|cadastrad)/i);
  await ui.submit(); preserved(ui);
  assert.deepEqual(sequence(ui), ['GET /api/auth/status', 'POST /api/auth/register', 'GET /api/auth/me', 'POST /api/auth/login']);
  ui.assertComplete();
});

test('retorno por sessão expirada mostra aviso e remove apenas o motivo da URL', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login?reason=session-expired&other=keep#fixture' });
  const feedback = [...ui.elements.values()].filter(item => !item.hidden && ['alert', 'status'].includes(item.getAttribute('role')))
    .map(item => item.textContent).join(' ');
  assert.match(feedback, /sessão|acesso/i); assert.match(feedback, /expir|novamente|entrar/i);
  assert.equal(ui.url.searchParams.has('reason'), false); assert.equal(ui.url.searchParams.get('other'), 'keep');
  assert.equal(ui.url.hash, '#fixture'); assert.ok(ui.history.length);
  assert.deepEqual(ui.navigation, []); ui.assertComplete();
});

// P2 (FRONTEND-V2 §7.2): /login?return=close re-authenticates an open panel and closes the window.
// The login page never touches storage (onboarding-login.test.js): the panel clears its drafts.
test('return=close: avisa o painel só na própria origem, não navega e fecha a janela', async () => {
  const posted = [], broadcast = [];
  let closed = 0;
  class Channel { constructor(name) { this.name = name; } postMessage(data) { broadcast.push([this.name, data]); } close() {} }
  const ui = await fixture({ href: 'https://ui.example.test/login?return=close&reason=session-expired',
    windowExtra: { opener: { postMessage: (data, origin) => posted.push([data, origin]) }, close: () => { closed++; } },
    globals: { BroadcastChannel: Channel },
    steps: [{ path: '/api/auth/login', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { id: 'fixture-user' } } }] });
  ui.element('username').value = 'ui-fixture'; ui.element('password').value = secret;
  await ui.submit();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(posted), [[{ type: 'elozi:reauth-ok', userId: 'fixture-user' }, 'https://ui.example.test']], 'postMessage restrito à origem');
  assert.deepEqual(plain(broadcast), [['elozi-auth', { type: 'elozi:reauth-ok', userId: 'fixture-user' }]]);
  assert.equal(closed, 1); assert.deepEqual(ui.navigation, [], 'a janela de reautenticação não abre outro painel');
  assert.equal(ui.element('access-success').hidden, false); assert.equal(ui.element('password').value, '');
  ui.assertComplete();
});
