import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const [source, html, css] = await Promise.all(['login.js', 'login.html', 'login.css'].map(file => readFile(new URL('../public/' + file, import.meta.url), 'utf8')));
const executable = source.replace(/^import[^\n]*\n/gm, '');
const token = 'Synthetic-invitation-opaque';
const password = 'Synthetic-password-4567';
const response = (status, data = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const preview = { name: 'Pessoa convidada', email: 'synthetic@example.test', workspaceName: 'Revenda de teste', tenantNames: ['Playtech de teste', 'Loja de teste'], role: 'operator', expiresAt: '2026-10-04T12:00:00Z' };

class Element {
  constructor(id, tag) {
    this.id = id; this.value = ''; this.textContent = ''; this.firstChild = { textContent: '' };
    this.tagName = /^<([a-z0-9-]+)/i.exec(tag)?.[1].toUpperCase(); this.parentElement = null;
    this.hidden = /\shidden(?:\s|>)/.test(tag); this.disabled = /\sdisabled(?:\s|>)/.test(tag);
    this.type = /\stype="([^"]+)"/.exec(tag)?.[1] || '';
    this.attributes = new Map([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    this.events = new Map(); this.focused = false;
  }
  addEventListener(type, callback) { this.events.set(type, callback); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) { for (let element = this; element; element = element.parentElement) if (element.tagName?.toLowerCase() === selector) return element; return null; }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  get alt() { return this.getAttribute('alt') || ''; }
  set alt(value) { this.setAttribute('alt', value); }
  focus() { this.focused = true; }
  reportValidity() { return true; }
  replaceChildren() {}
  insertAdjacentElement() {}
}

async function fixture({ href = 'https://ui.example.test/accept-invite#token=' + token, steps = [], status = {} } = {}) {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], new Element(match[1], match[0])]));
  const el = id => { assert.ok(elements.has(id), '#' + id + ' presente no HTML real'); return elements.get(id); };
  const calls = [], navigation = [], history = [], unexpected = [];
  let currentURL = new URL(href);
  const location = {
    get href() { return currentURL.href; }, get pathname() { return currentURL.pathname; },
    get search() { return currentURL.search; }, get hash() { return currentURL.hash; },
    replace(target) { navigation.push(target); }
  };
  const window = { location, history: { replaceState(_state, _title, target) { history.push(target); currentURL = new URL(target, currentURL); } } };
  const wordmark = new Element('', /<a\b[^>]*\bclass="wordmark"[^>]*>/.exec(html)[0]), logo = new Element('', /<span\b[^>]*\bclass="wordmark-symbol"[^>]*>(<img\b[^>]*>)/.exec(html)[1]);
  el('product-name').parentElement = wordmark; logo.parentElement = wordmark;
  const customProperties = new Map(), document = {
    title: /<title[^>]*>([^<]*)<\/title>/.exec(html)[1],
    documentElement: { style: { setProperty(name, value) { customProperties.set(name, String(value)); }, getPropertyValue(name) { return customProperties.get(name) || ''; } } },
    querySelector(selector) { if (selector === '.wordmark-symbol img') return logo; assert.match(selector, /^#[\w-]+$/); return el(selector.slice(1)); }, createElement(tag = 'p') { return new Element('', `<${tag}>`); }
  };
  const fetch = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, payload: options.body ? JSON.parse(options.body) : undefined, urlAtRequest: currentURL.href });
    if (path === '/api/auth/status') return response(200, { setupRequired: false, registrationEnabled: true, google: { enabled: false }, ...status });
    const next = steps.shift();
    if (!next || next.path !== path || (next.method || 'GET') !== method) { unexpected.push({ path, method }); throw new Error('Unexpected synthetic fixture request'); }
    if (next.error) throw next.error;
    if (next.pending) return next.pending;
    return response(next.status, next.data);
  };
  let googleSubmit;
  const context = vm.createContext({ document, window, location, history: window.history, fetch, URL, URLSearchParams, AbortSignal,
    t: source => source, getLocale: () => 'pt-BR', setLocale: () => 'pt-BR', translateError: source => source, translateStatic: () => {},
    mountGoogleButton: async (_element, _config, submit) => { googleSubmit = submit; return { destroy() {} }; } });
  await new vm.Script(`(async () => {\n${executable}\n})()`, { filename: 'public/login.js' }).runInContext(context);
  await settle();
  const emit = (id, type = 'click') => { const callback = el(id).events.get(type); assert.equal(typeof callback, 'function'); return callback({ preventDefault() {} }); };
  return { el, calls, navigation, history, document, wordmark, logo, get url() { return currentURL; }, emit, submit: () => emit('access-form', 'submit'), google: credential => googleSubmit(credential),
    fill() { el('name').value = 'Pessoa convidada'; el('username').value = 'synthetic.person'; el('password').value = password; el('password-confirmation').value = password; },
    done() { assert.deepEqual(unexpected, []); assert.equal(steps.length, 0); }
  };
}

const previewStep = data => ({ path: '/api/auth/invitations/preview', method: 'POST', status: 200, data: data || preview });
const preserving = ui => { assert.equal(ui.el('password').value, password); assert.equal(ui.el('password-confirmation').value, password); assert.deepEqual(ui.navigation, []); };

const trialStatus = { publicTrial: { days: 7, documentRequired: true } };
test('cadastro de teste pede documento antes de Google e envia CPF completo sem alterar campos em erro', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login', status: trialStatus, steps: [{ path: '/api/auth/register', method: 'POST', status: 409, data: { error: 'CPF ou CNPJ já utilizado para um período de teste.' } }] });
  assert.equal(ui.el('registration-context').hidden, true); assert.equal(ui.el('fiscal-document').disabled, true);
  await ui.emit('registration-toggle'); ui.fill(); ui.el('email').value = 'synthetic@example.test'; ui.el('company').value = 'Empresa sintética'; ui.el('account-kind').value = 'business';
  assert.equal(ui.el('registration-context').hidden, false); assert.equal(ui.el('fiscal-document').required, true);
  assert.equal(ui.el('fiscal-document').getAttribute('form'), 'access-form');
  assert.ok(html.indexOf('id="fiscal-document"') < html.indexOf('id="google-login"'));
  ui.el('fiscal-document').value = '111.444.777-35'; await ui.submit();
  assert.equal(ui.calls.find(call => call.path === '/api/auth/register').payload.fiscalDocument, '111.444.777-35');
  assert.equal(ui.el('fiscal-document').value, '111.444.777-35'); assert.equal(ui.el('fiscal-document').getAttribute('aria-invalid'), 'true');
  assert.match(ui.el('fiscal-document-error').textContent, /já utilizado/); preserving(ui); ui.done();
});

test('documento incompleto impede cadastro e Google sem apagar senha nem prender foco no blur', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login', status: { ...trialStatus, google: { enabled: true } } });
  await ui.emit('registration-toggle'); await settle(); ui.fill(); ui.el('fiscal-document').value = '123';
  await ui.emit('fiscal-document', 'blur'); assert.equal(ui.el('fiscal-document').focused, false);
  await ui.submit(); await ui.google('Synthetic-google-credential');
  assert.equal(ui.calls.some(call => call.method === 'POST'), false); assert.equal(ui.el('fiscal-document').focused, true);
  assert.match(ui.el('fiscal-document-error').textContent, /completo/); preserving(ui); ui.done();
});

test('cadastro Google aceita CNPJ com letras e conserva documento quando o servidor recusa', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login', status: { ...trialStatus, google: { enabled: true } }, steps: [{ path: '/api/auth/google', method: 'POST', status: 400, data: { error: 'CNPJ inválido. Confira o documento completo.' } }] });
  await ui.emit('registration-toggle'); await settle(); ui.el('account-kind').value = 'reseller'; ui.el('fiscal-document').value = '12.ABC.345/01DE-35';
  await ui.google('Synthetic-google-credential');
  assert.deepEqual(ui.calls.find(call => call.path === '/api/auth/google').payload, { credential: 'Synthetic-google-credential', accountKind: 'reseller', locale: 'pt-BR', fiscalDocument: '12.ABC.345/01DE-35' });
  assert.equal(ui.el('fiscal-document').value, '12.ABC.345/01DE-35'); assert.match(ui.el('fiscal-document-error').textContent, /CNPJ inválido/); assert.deepEqual(ui.navigation, []); ui.done();
});

test('novo usuário Google vindo de Entrar recebe orientação sem iniciar cadastro automaticamente', async () => {
  const message = 'Para começar o teste, escolha Criar minha conta e informe o CPF ou CNPJ.';
  const ui = await fixture({ href: 'https://ui.example.test/login', status: { ...trialStatus, google: { enabled: true } }, steps: [{ path: '/api/auth/google', method: 'POST', status: 400, data: { error: message } }] });
  await ui.google('Synthetic-google-credential');
  assert.deepEqual(ui.calls.find(call => call.path === '/api/auth/google').payload, { credential: 'Synthetic-google-credential' });
  assert.equal(ui.el('registration-context').hidden, true); assert.equal(ui.el('fiscal-document').disabled, true); assert.equal(ui.el('registration-toggle').hidden, false);
  assert.equal(ui.el('form-error').textContent, message); assert.equal(ui.el('company').disabled, true); assert.deepEqual(ui.navigation, []); ui.done();
});

test('contrato legado e convite não exigem documento nem anunciam um teste inferido', async () => {
  const legacy = await fixture({ href: 'https://ui.example.test/login', status: { publicTrial: null } });
  await legacy.emit('registration-toggle'); assert.equal(legacy.el('registration-context').hidden, true); assert.equal(legacy.el('fiscal-document').disabled, true); assert.equal(legacy.el('fiscal-document').required, false); legacy.done();
  const invite = await fixture({ status: trialStatus, steps: [previewStep()] });
  assert.equal(invite.el('registration-context').hidden, true); assert.equal(invite.el('fiscal-document').required, false); assert.equal(invite.el('fiscal-document').disabled, true); invite.done();
});

test('convite limpa o segredo da URL antes de enviar a prévia e mostra o acesso confirmado', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/accept-invite?keep=yes#token=' + token + '&campaign=team', steps: [previewStep()] });
  assert.equal(ui.url.hash, '#campaign=team'); assert.equal(ui.url.search, '?keep=yes');
  assert.equal(ui.calls[0].urlAtRequest.includes(token), false); assert.deepEqual(ui.calls[0].payload, { token });
  assert.equal(ui.el('invitation-context').hidden, false);
  assert.equal(ui.el('invitation-workspace').textContent, preview.workspaceName);
  assert.equal(ui.el('invitation-tenants').textContent, preview.tenantNames.join(', '));
  assert.equal(ui.el('invitation-role').textContent, 'Atendente');
  assert.equal(ui.el('email').value, preview.email); assert.equal(ui.el('email').readOnly, true);
  assert.equal(ui.el('company').disabled, true); assert.equal(ui.el('google-access').hidden, true);
  assert.equal(ui.el('registration-toggle').hidden, true); assert.equal(ui.el('forgot-password').hidden, true);
  assert.ok(ui.el('invitation-expiry').textContent); ui.done();
});

test('convite aceita formato original do backend e mantém e-mail opcional sem inventar endereço', async () => {
  const ui = await fixture({ steps: [previewStep({ workspace: { name: 'Workspace sintético' }, tenants: [{ name: 'Empresa sintética' }], email: null, role: 'reseller', expiresAt: preview.expiresAt })] });
  assert.equal(ui.el('invitation-workspace').textContent, 'Workspace sintético');
  assert.equal(ui.el('invitation-tenants').textContent, 'Empresa sintética');
  assert.equal(ui.el('invitation-role').textContent, 'Administrador do workspace');
  assert.equal(ui.el('email-field').hidden, false); assert.equal(ui.el('email').value, ''); assert.equal(ui.el('email').readOnly, false); assert.equal(ui.el('email').required, false); ui.done();
});

test('convite por link deixa destinatário informar e-mail próprio opcional no aceite', async () => {
  const ui = await fixture({ steps: [previewStep({ ...preview, email: null }), { path: '/api/auth/invitations/accept', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { id: 'synthetic' } } }] });
  assert.equal(ui.el('email-field').hidden, false); assert.equal(ui.el('email').disabled, false); assert.equal(ui.el('email').readOnly, false); assert.equal(ui.el('email').required, false);
  assert.match(ui.el('email-field').firstChild.textContent, /opcional/);
  ui.fill(); ui.el('email').value = '  own@example.test  '; await ui.submit();
  assert.deepEqual(ui.calls[1].payload, { token, name: 'Pessoa convidada', username: 'synthetic.person', password, email: 'own@example.test' });
  assert.deepEqual(ui.navigation, ['/']); assert.equal(ui.calls.some(call => call.path.includes('google') || call.path.includes('verify-email')), false); ui.done();
});

test('e-mail opcional vazio continua ausente do payload e convite fixo não aceita alteração pelo formulário', async () => {
  for (const fixed of [false, true]) {
    const ui = await fixture({ steps: [previewStep({ ...preview, email: fixed ? preview.email : null }), { path: '/api/auth/invitations/accept', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { id: 'synthetic' } } }] });
    ui.fill(); ui.el('email').value = fixed ? 'different@example.test' : '  '; await ui.submit();
    assert.equal(ui.el('email').readOnly, fixed); assert.equal('email' in ui.calls[1].payload, false); assert.deepEqual(ui.navigation, ['/']); ui.done();
  }
});

test('conflito de e-mail próprio preserva convite e permite corrigir endereço sem novo preview', async () => {
  const ui = await fixture({ steps: [previewStep({ ...preview, email: null }),
    { path: '/api/auth/invitations/accept', method: 'POST', status: 409, data: { error: 'Este e-mail já está cadastrado.' } },
    { path: '/api/auth/invitations/accept', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 200, data: { user: { id: 'synthetic' } } }] });
  ui.fill(); ui.el('email').value = 'taken@example.test'; await ui.submit(); preserving(ui);
  assert.equal(ui.el('email').value, 'taken@example.test'); assert.equal(ui.el('access-form').hidden, false); assert.match(ui.el('form-error').textContent, /e-mail já/);
  ui.el('email').value = 'own@example.test'; await ui.submit(); assert.equal(ui.calls[2].payload.email, 'own@example.test'); assert.equal(ui.calls[2].payload.token, token);
  assert.equal(ui.calls.filter(call => call.path.endsWith('/invitations/preview')).length, 1); assert.deepEqual(ui.navigation, ['/']); ui.done();
});

test('prévia pendente impede aceite e cadastro enquanto confirma o convite', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const ui = await fixture({ steps: [{ path: '/api/auth/invitations/preview', method: 'POST', pending }] });
  ui.fill(); await ui.submit(); assert.equal(ui.el('access-form').hidden, true); assert.equal(ui.calls.length, 1);
  release(response(200, preview)); await settle(); assert.equal(ui.el('access-form').hidden, false); ui.done();
});

test('convite expirado ou revogado bloqueia formulário e oferece retorno sem repetir segredo', async () => {
  const ui = await fixture({ steps: [{ path: '/api/auth/invitations/preview', method: 'POST', status: 410, data: { error: 'Convite expirado ou revogado.' } }] });
  assert.equal(ui.el('access-form').hidden, true); assert.equal(ui.el('status-error').hidden, false);
  assert.match(ui.el('status-error').textContent, /expirado|revogado/); assert.equal(ui.el('retry-status').hidden, true);
  assert.equal(ui.el('return-login').hidden, false); ui.fill(); await ui.submit(); assert.equal(ui.calls.length, 1); ui.done();
});

test('falha de rede na prévia permite retry usando somente o token em memória', async () => {
  const ui = await fixture({ steps: [
    { path: '/api/auth/invitations/preview', method: 'POST', error: new TypeError('Synthetic offline') }, previewStep()
  ] });
  assert.equal(ui.el('retry-status').hidden, false); assert.equal(ui.el('access-form').hidden, true);
  await ui.emit('retry-status'); assert.equal(ui.el('access-form').hidden, false);
  assert.equal(ui.calls.every(call => !call.urlAtRequest.includes(token)), true); assert.deepEqual(ui.calls[1].payload, { token }); ui.done();
});

for (const suffix of ['', '#token=one&token=two', '?token=' + token]) {
  test('link incompleto, duplicado ou query não autoriza aceite: ' + (suffix || 'sem token'), async () => {
    const ui = await fixture({ href: 'https://ui.example.test/accept-invite' + suffix });
    assert.equal(ui.calls.length, 0); assert.equal(ui.el('access-form').hidden, true); assert.equal(ui.el('status-error').hidden, false);
    assert.equal(ui.url.href.includes(token), false); ui.fill(); await ui.submit(); ui.done();
  });
}

test('aceite envia só dados pessoais e abre workspace somente depois de confirmar cookie', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const ui = await fixture({ steps: [previewStep(), { path: '/api/auth/invitations/accept', method: 'POST', status: 200, data: { user: { id: 'synthetic' } } }, { path: '/api/auth/me', pending }] });
  ui.fill(); const submitting = ui.submit(); await settle(); preserving(ui);
  assert.deepEqual(ui.calls[1].payload, { token, name: 'Pessoa convidada', username: 'synthetic.person', password });
  assert.equal(ui.el('submit-button').disabled, true);
  release(response(200, { user: { id: 'synthetic' } })); await submitting;
  assert.equal(ui.el('password').value, ''); assert.deepEqual(ui.navigation, ['/']);
  assert.equal(ui.el('invitation-context').hidden, true); assert.equal(ui.el('access-success').hidden, false); ui.done();
});

test('erro de conflito no aceite preserva nome, usuário e senhas para correção', async () => {
  const ui = await fixture({ steps: [previewStep(), { path: '/api/auth/invitations/accept', method: 'POST', status: 409, data: { error: 'Escolha outro usuário.' } }] });
  ui.fill(); await ui.submit(); preserving(ui); assert.equal(ui.el('username').value, 'synthetic.person');
  assert.equal(ui.el('name').value, 'Pessoa convidada'); assert.match(ui.el('form-error').textContent, /outro usuário/);
  assert.equal(ui.el('access-form').hidden, false); ui.done();
});

test('convite aceito com cookie recusado vira login e conserva as credenciais sem reenviar convite', async () => {
  const ui = await fixture({ steps: [previewStep(), { path: '/api/auth/invitations/accept', method: 'POST', status: 200 }, { path: '/api/auth/me', status: 401 }, { path: '/api/auth/login', method: 'POST', status: 400, data: { error: 'Synthetic interruption' } }] });
  ui.fill(); await ui.submit(); preserving(ui);
  assert.match(ui.el('form-error').textContent, /conta foi criada/); assert.equal(ui.el('company').disabled, true);
  assert.equal(ui.el('confirmation-field').hidden, true); await ui.submit();
  assert.equal(ui.calls.filter(call => call.path.endsWith('/invitations/accept')).length, 1); ui.done();
});

test('revogação entre preview e aceite impede novo envio mantendo erro visível', async () => {
  const ui = await fixture({ steps: [previewStep(), { path: '/api/auth/invitations/accept', method: 'POST', status: 410, data: { error: 'Convite revogado.' } }] });
  ui.fill(); await ui.submit(); preserving(ui); assert.equal(ui.el('access-form').hidden, true);
  assert.match(ui.el('status-error').textContent, /novo link/); await ui.submit(); assert.equal(ui.calls.length, 2); ui.done();
});

for (const [mode, message] of [
  ['invite', 'Convite inválido, expirado ou sem acesso disponível.'],
  ['invite', 'Convite inválido ou expirado.'],
  ['reset', 'Recuperação inválida ou expirada. Solicite um novo link.']
]) {
  test('token HTTP400 bloqueia ' + mode + ' sem limpar dados nem permitir retry: ' + message, async () => {
    const invite = mode === 'invite', path = '/api/auth/' + (invite ? 'invitations/accept' : 'password/reset');
    const ui = await fixture({ href: 'https://ui.example.test/' + (invite ? 'accept-invite' : 'reset-password') + '#token=' + token,
      steps: [...(invite ? [previewStep()] : []), { path, method: 'POST', status: 400, data: { error: message } }] });
    ui.fill(); await ui.submit(); preserving(ui);
    assert.equal(ui.el('name').value, 'Pessoa convidada'); assert.equal(ui.el('username').value, 'synthetic.person');
    assert.equal(ui.el('access-form').hidden, true); assert.equal(ui.el('status-error').hidden, false);
    assert.match(ui.el('status-error').textContent, /novo link/); assert.equal(ui.el('status-error').textContent.includes(token), false);
    assert.equal(ui.el('retry-status').hidden, true); assert.equal(ui.el('return-login').focused, true);
    const sent = ui.calls.length; await ui.submit(); assert.equal(ui.calls.length, sent); ui.done();
  });
}

for (const [mode, message] of [
  ['invite', 'Informe um usuário de 3 a 64 caracteres.'],
  ['invite', 'Use o e-mail definido no convite.'],
  ['reset', 'Use de 8 a 128 caracteres, uma letra maiúscula e um caractere especial.']
]) {
  test('validação HTTP400 de dados permite corrigir ' + mode + ': ' + message, async () => {
    const invite = mode === 'invite', path = '/api/auth/' + (invite ? 'invitations/accept' : 'password/reset');
    const ui = await fixture({ href: 'https://ui.example.test/' + (invite ? 'accept-invite' : 'reset-password') + '#token=' + token,
      steps: [...(invite ? [previewStep()] : []), { path, method: 'POST', status: 400, data: { error: message } },
        { path, method: 'POST', status: 400, data: { error: message } }] });
    ui.fill(); await ui.submit(); preserving(ui);
    assert.equal(ui.el('access-form').hidden, false); assert.equal(ui.el('status-error').hidden, true);
    assert.equal(ui.el('form-error').textContent, message); assert.equal(ui.el('submit-button').disabled, false);
    await ui.submit(); assert.equal(ui.calls.filter(call => call.path === path).length, 2);
    assert.equal(ui.calls.at(-1).payload.token, token); ui.done();
  });
}

for (const [field, value, message] of [['username', 'no', /usuário/], ['password', 'weak', /8 a 128/], ['password-confirmation', 'different', /iguais/]]) {
  test('aceite rejeita ' + field + ' inválido antes de chamar API', async () => {
    const ui = await fixture({ steps: [previewStep()] }); ui.fill(); ui.el(field).value = value; await ui.submit();
    assert.match(ui.el('form-error').textContent, message); assert.equal(ui.calls.length, 1); ui.done();
  });
}

test('redefinição envia token e senha, encerra ciclo com sucesso e retorno ao login', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/reset-password#token=' + token, steps: [{ path: '/api/auth/password/reset', method: 'POST', status: 200, data: { reset: true } }] });
  assert.equal(ui.calls.length, 0); assert.equal(ui.url.hash, ''); assert.equal(ui.el('username').disabled, true);
  assert.equal(ui.el('company').disabled, true); assert.equal(ui.el('name').disabled, true); assert.equal(ui.el('password-label').firstChild.textContent, 'Nova senha');
  ui.fill(); await ui.submit(); assert.deepEqual(ui.calls[0].payload, { token, password });
  assert.equal(ui.el('password').value, ''); assert.equal(ui.el('password-confirmation').value, '');
  assert.equal(ui.el('access-success').hidden, false); assert.match(ui.el('success-message').textContent, /sessões anteriores/);
  assert.equal(ui.el('workspace-link').getAttribute('href'), '/login'); assert.deepEqual(ui.navigation, []); ui.done();
});

test('erro de rede ao redefinir preserva ambas as senhas e permite tentar novamente', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/reset-password#token=' + token, steps: [
    { path: '/api/auth/password/reset', method: 'POST', error: new TypeError('Synthetic offline') },
    { path: '/api/auth/password/reset', method: 'POST', status: 200, data: { reset: true } }
  ] });
  ui.fill(); await ui.submit(); preserving(ui); assert.equal(ui.el('form-error').hidden, false);
  assert.match(ui.el('form-error').textContent, /Tente entrar com a nova senha/);
  await ui.submit(); assert.deepEqual(ui.calls[0].payload, ui.calls[1].payload); ui.done();
});

test('aceite com resposta perdida orienta login antes de repetir uma criação possivelmente concluída', async () => {
  const ui = await fixture({ steps: [previewStep(), { path: '/api/auth/invitations/accept', method: 'POST', error: new TypeError('Synthetic response lost') }] });
  ui.fill(); await ui.submit(); preserving(ui);
  assert.match(ui.el('form-error').textContent, /acesso pode ter sido criado.*Tente entrar/); assert.equal(ui.el('return-login').hidden, false); ui.done();
});

test('falha no Google conserva comportamento existente e libera formulário para novo login', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login', status: { google: { enabled: true } }, steps: [{ path: '/api/auth/google', method: 'POST', error: new TypeError('Synthetic offline') }] });
  await ui.google('Synthetic-google-credential');
  assert.match(ui.el('form-error').textContent, /confirmar a conexão/); assert.equal(ui.el('submit-button').disabled, false);
  assert.equal(ui.el('access-form').hidden, false); assert.deepEqual(ui.navigation, []); ui.done();
});

test('link expirado de redefinição mostra orientação sem expor o token nem apagar senha por falha', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/reset-password#token=' + token, steps: [{ path: '/api/auth/password/reset', method: 'POST', status: 410, data: { error: 'Link expirado.' } }] });
  ui.fill(); await ui.submit(); preserving(ui); assert.equal(ui.el('access-form').hidden, true);
  assert.match(ui.el('status-error').textContent, /novo link/); assert.equal(ui.el('status-error').textContent.includes(token), false); ui.done();
});

for (const configured of [true, false]) {
  test('recuperação com provedor ' + (configured ? 'habilitado' : 'indisponível') + ' informa resultado sem enumerar conta', async () => {
    const ui = await fixture({ href: 'https://ui.example.test/login', steps: [{ path: '/api/auth/password/forgot', method: 'POST', status: 200, data: { requested: true, configured } }] });
    ui.el('username').value = 'synthetic@example.test'; ui.el('password').value = password; ui.emit('forgot-password');
    assert.equal(ui.el('email').value, 'synthetic@example.test'); assert.equal(ui.el('password').disabled, true);
    assert.equal(ui.el('username').disabled, true); assert.equal(ui.el('google-access').hidden, true);
    await ui.submit(); assert.deepEqual(ui.calls[1].payload, { email: 'synthetic@example.test' });
    if (configured) { assert.equal(ui.el('access-success').hidden, false); assert.match(ui.el('success-message').textContent, /Se houver uma conta habilitada/); }
    else { assert.equal(ui.el('access-success').hidden, true); assert.match(ui.el('form-error').textContent, /não está disponível.*administrador/); assert.equal(ui.el('access-form').hidden, false); }
    assert.deepEqual(ui.navigation, []); ui.done();
  });
}

test('falha na recuperação conserva e-mail e mostra erro sem limpar formulário', async () => {
  const ui = await fixture({ href: 'https://ui.example.test/login', steps: [{ path: '/api/auth/password/forgot', method: 'POST', status: 429, data: { error: 'Aguarde antes de tentar novamente.' } }] });
  ui.emit('forgot-password'); ui.el('email').value = 'synthetic@example.test'; await ui.submit();
  assert.equal(ui.el('email').value, 'synthetic@example.test'); assert.match(ui.el('form-error').textContent, /Aguarde/);
  assert.equal(ui.el('submit-button').disabled, false); ui.done();
});

test('submissão dupla não envia duas solicitações de recuperação', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const ui = await fixture({ href: 'https://ui.example.test/login', steps: [{ path: '/api/auth/password/forgot', method: 'POST', pending }] });
  ui.emit('forgot-password'); ui.el('email').value = 'synthetic@example.test'; const submitting = ui.submit(); await settle(); await ui.submit();
  assert.equal(ui.calls.filter(call => call.path.endsWith('/password/forgot')).length, 1);
  release(response(200, { requested: true, configured: true })); await submitting; ui.done();
});

test('contexto de convite usa texto seguro e ações públicas preservam altura acessível', async () => {
  const ui = await fixture({ steps: [previewStep({ ...preview, workspaceName: '<img src=x onerror=alert(1)>', tenantNames: ['<script>secret</script>'] })] });
  assert.equal(ui.el('invitation-workspace').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(ui.el('invitation-tenants').textContent, '<script>secret</script>');
  assert.match(css, /\.return-login\s*\{[^}]*min-height:\s*var\(--target-touch\)/); assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|console\.(?:log|info|debug))\b/); ui.done();
});

// P10: the colors of the address's brand come from GET /brand.css (derived on the server for both themes);
// the page keeps the name and the logo of the response and never writes a color from it.
test('login de domínio próprio usa nome literal seguro, título/aria e logo data restrito; cores só pelo /brand.css', async () => {
  const name = '<img src=x onerror=alert(1)>', logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xK/8AAAAASUVORK5CYII=';
  const ui = await fixture({ href: 'https://revenda-teste.je4ndev.com/login', status: { productName: name, brand: { name, accent: '#A1b2C3', logo }, registrationEnabled: false } });
  assert.equal(ui.el('product-name').textContent, name); assert.equal(ui.el('product-signature').textContent, name); assert.equal(ui.document.title, name + ' · Acessar'); assert.equal(ui.wordmark.getAttribute('aria-label'), name);
  assert.equal(ui.document.documentElement.style.getPropertyValue('--accent'), ''); assert.equal(ui.logo.src, logo); assert.equal(ui.logo.alt, ''); assert.equal(ui.el('registration-toggle').hidden, true);
  assert.match(html, /<link rel="stylesheet" href="\/tokens\.css">\s*<link rel="stylesheet" href="\/brand\.css">\s*<link rel="stylesheet" href="\/login\.css">/, 'tokens, marca do endereço e login, nesta ordem');
  assert.doesNotMatch(source, /setProperty|\.style\b/, 'nenhuma cor escrita pelo script');
  assert.deepEqual(ui.calls.map(call => [call.path, call.method]), [['/api/auth/status', 'GET']]); assert.deepEqual(ui.navigation, []); ui.done();
});

test('marca do convite vem da própria prévia, sem GET adicional e sem alterar jornada/token/credenciais', async () => {
  const name = 'Marca do convite QA', ui = await fixture({ href: 'https://revenda-teste.je4ndev.com/accept-invite#token=' + token, steps: [previewStep({ ...preview, productBrand: { name, accent: '#123abc' } })] });
  assert.equal(ui.el('product-name').textContent, name); assert.equal(ui.el('product-signature').textContent, name); assert.equal(ui.document.title, name + ' · Acessar'); assert.equal(ui.wordmark.getAttribute('aria-label'), name); assert.equal(ui.document.documentElement.style.getPropertyValue('--accent'), '');
  assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].path, '/api/auth/invitations/preview'); assert.deepEqual(ui.calls[0].payload, { token }); assert.equal(ui.calls[0].urlAtRequest.includes(token), false);
  assert.equal(ui.el('invitation-workspace').textContent, preview.workspaceName); assert.equal(ui.el('company').disabled, true); assert.equal(ui.el('google-access').hidden, true); ui.fill(); preserving(ui); ui.done();
});

test('brand rejeita CSS não hex e logos externos/SVG/HTML sem alterar logo padrão ou fazer requisições', async t => {
  for (const logo of ['https://private.example.test/logo.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,AAAA\nAAAA', 'data:image/png;base64,<img onerror=alert(1)>', 'data:image/gif;base64,R0lGODlh']) await t.test(logo.split(',')[0], async () => {
    const ui = await fixture({ href: 'https://revenda-teste.je4ndev.com/login', status: { productName: 'Marca QA', brand: { name: 'Marca QA', accent: '#123abc; background:url(https://private.example.test)', logo } } });
    assert.equal(ui.logo.getAttribute('src'), '/mark.svg'); assert.equal(ui.document.documentElement.style.getPropertyValue('--accent'), ''); assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].path, '/api/auth/status'); ui.done();
  });
});
