import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelConnectorsUI } from '../public/channel-connectors-ui.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attr = (markup, name) => decode(new RegExp(`${name}="([^"]*)"`).exec(markup)?.[1] || '');

function fixture(t, kind = 'messenger', { intercept, onUpdate, queuedClose = false } = {}) {
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.values = form.values; } get(name) { const field = this.values.find(field => field.name === name && (field.type !== 'radio' || field.checked)); return !field || field.type === 'checkbox' && !field.checked ? null : field.value; } };
  t.after(() => { globalThis.FormData = originalFormData; });
  const channel = { id: 'channel-a', kind }, state = { view: 'channels', workspaceId: 'workspace-a', supportGrantId: null,
    tenant: { id: 'company-a', resellerId: 'workspace-a', name: 'Empresa QA', channels: [channel] },
    boot: { publicOrigin: 'https://elozi.example', session: { userId: 'person-a', resellerId: 'workspace-a', role: 'reseller', permissions: null, scopeRules: null, supportGrantId: null },
      workspaces: [{ id: 'workspace-a' }], tenants: [{ id: 'company-a' }] } };
  let source = { kind, channelId: channel.id, tenantId: state.tenant.id, version: 1, state: kind === 'webchat' ? 'connected' : 'configured', enabled: true, mediaSupported: false,
    ...(kind === 'webchat' ? { origins: ['https://site.example'], install: { scriptUrl: 'https://elozi.example/widget.js', embedSnippet: '<script type="module" src="https://elozi.example/widget.js" data-tenant-id="company-a" data-channel-id="channel-a"></script>' } }
      : kind === 'email' ? { address: 'atendimento@example.com', ingressConfigured: true, mailboxConnected: false, webhookUrl: 'https://elozi.example/api/webhooks/email/company-a/channel-a' }
        : { resourceId: '123456789', apiVersion: 'v23.0', configured: true, webhookUrl: 'https://elozi.example/api/webhooks/meta/company-a/channel-a' }) };
  const widgetSource = { tenantId: state.tenant.id, channelId: channel.id, version: 2, widget: { displayName: 'Marca QA', openButtonLabel: 'Abrir conversa', theme: 'light', radius: 16,
    avatarUrl: '', logoUrl: '', colors: {}, lightColors: {}, credit: { visible: true, text: 'Elozi' }, greeting: { 'pt-BR': 'Olá', en: 'Hello' },
    verifiedGreeting: { 'pt-BR': 'Olá {firstName}', en: 'Hi {firstName}' }, handoffMessage: { 'pt-BR': 'A equipe continua aqui', en: 'The team continues here' },
    emailPrompt: true, attachmentsEnabled: false, voiceEnabled: false, feedbackEnabled: true, handoffNotificationEmail: 'qa@example.test', assistantInstructions: 'Orientação privada sintética.' } };
  const calls = [], opened = [], messages = [], updates = [], listeners = new Map(), closeEvents = [];
  const modal = { open: false, markup: '', panel: null, form: null,
    addEventListener(name, handler) { listeners.set(name, handler); }, close() { this.open = false; if (queuedClose) closeEvents.push(() => listeners.get('close')?.()); else listeners.get('close')?.(); },
    querySelector(selector) { return selector === '[data-connector-panel]' ? this.panel : null; } };
  const parse = markup => {
    const values = [...markup.matchAll(/<input\b([^>]*)>/g)].filter(match => attr(match[1], 'name')).map(match => ({ name: attr(match[1], 'name'), type: attr(match[1], 'type') || 'text', value: attr(match[1], 'value'), checked: /\bchecked\b/.test(match[1]) }));
    for (const match of markup.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) if (attr(match[1], 'name')) values.push({ name: attr(match[1], 'name'), type: 'textarea', value: decode(match[2]) });
    const token = attr(markup, 'data-connector-token'), feedback = { textContent: '' }, current = { innerHTML: '' }, submit = { disabled: false };
    modal.panel = { dataset: { connectorToken: token }, querySelector: selector => selector === '.form-error' ? feedback : selector === '[data-connector-server-current]' ? current : selector === 'form[data-connector-form]' ? modal.form : null,
      querySelectorAll: selector => selector === 'input[type="password"]' ? values.filter(field => field.type === 'password') : selector === '[type="submit"]' ? [submit] : [] };
    modal.form = { dataset: { connectorForm: attr(markup, 'data-connector-form') || 'configuration', connectorToken: token }, values, elements: values, feedback, current, submit,
      set(name, value) { const field = this.values.find(field => field.name === name); if (!field) throw new Error(`Unknown fixture input ${name}`); if (field.type === 'checkbox') field.checked = value; else field.value = value; },
      get(name) { return this.values.find(field => field.name === name)?.value; } };
  };
  const fallback = (path, init) => {
    if (path.endsWith('/widget-configuration') && init.method === 'GET') return structuredClone(widgetSource);
    if (init.method === 'GET') return structuredClone(source);
    const body = JSON.parse(init.body);
    if (body.version !== source.version) throw Object.assign(new Error('Synthetic CAS conflict'), { status: 409 });
    source = { ...source, version: source.version + 1, enabled: body.enabled, state: body.enabled ? kind === 'webchat' ? 'connected' : 'configured' : 'disconnected',
      ...Object.fromEntries(Object.entries(body).filter(([name]) => ['origins', 'address', 'resourceId', 'apiVersion'].includes(name))) };
    return structuredClone(source);
  };
  const api = async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, () => fallback(path, init)) : fallback(path, init); };
  const ui = createChannelConnectorsUI({ state, api, getModal: () => modal, openModal: (title, subtitle, markup) => { modal.open = true; modal.markup = markup; parse(markup); opened.push({ title, subtitle, markup }); },
    toast: (message, error = false) => messages.push({ message, error }), onUpdate: async value => { updates.push(value); await onUpdate?.(value); } });
  const action = name => ui.action({ dataset: { connectorAction: name, connectorToken: modal.panel?.dataset.connectorToken } });
  return { ui, state, channel, modal, calls, opened, messages, updates, action, flushClose: () => { while (closeEvents.length) closeEvents.shift()(); },
    source: () => source, setSource: update => { source = { ...source, ...update }; }, writes: () => calls.filter(call => call.init.method === 'POST') };
}

test('Meta carrega configuração autenticada sem refletir qualquer segredo do GET', async t => {
  const f = fixture(t); f.setSource({ accessToken: 'SHOULD-NOT-REFLECT', appSecret: 'SHOULD-NOT-REFLECT', verifyToken: 'SHOULD-NOT-REFLECT', secrets: { token: 'SHOULD-NOT-REFLECT' } });
  f.state.boot.csrfToken = 'csrf-fixture';
  assert.equal(await f.ui.open(f.channel), true);
  assert.equal(f.calls[0].path, '/api/tenants/company-a/channels/channel-a/configuration');
  assert.equal(f.calls[0].init.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.equal(f.calls[0].init.headers['X-CSRF-Token'], 'csrf-fixture');
  assert.equal(f.modal.markup.includes('SHOULD-NOT-REFLECT'), false);
  for (const name of ['accessToken', 'appSecret', 'verifyToken']) assert.equal(f.modal.form.get(name), '');
  assert.match(f.modal.markup, /últimas 24 horas/);
  assert.match(f.modal.markup, /Salvar estes campos não comprova/);
  assert.match(f.modal.markup, /pages_messaging/);
  assert.match(f.modal.markup, /api\/webhooks\/meta\/company-a\/channel-a/);
});

test('Instagram tem texto profissional e versão API explícita; valores privados vazios são omitidos', async t => {
  const f = fixture(t, 'instagram'); await f.ui.open(f.channel);
  assert.match(f.modal.markup, /instagram_business_manage_messages/);
  await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 1, enabled: true, resourceId: '123456789', apiVersion: 'v23.0' });
  assert.equal(f.messages.at(-1).message, 'Configuração salva.');
  assert.equal(f.modal.open, false);
  assert.equal(f.updates[0].accessToken, undefined);
});

test('Meta novo exige os três valores privados e não inventa versão ou recurso', async t => {
  const f = fixture(t); f.setSource({ version: 0, configured: false, enabled: false, resourceId: null, apiVersion: null, state: 'disconnected' }); await f.ui.open(f.channel);
  await assert.rejects(f.ui.submit(f.modal.form), /ID numérico/);
  f.modal.form.set('resourceId', '123456789'); f.modal.form.set('apiVersion', 'latest');
  await assert.rejects(f.ui.submit(f.modal.form), /versão explícita/);
  f.modal.form.set('apiVersion', 'v23.0');
  await assert.rejects(f.ui.submit(f.modal.form), /três valores privados/);
  for (const name of ['accessToken', 'appSecret', 'verifyToken']) f.modal.form.set(name, `synthetic-${name}`);
  const form = f.modal.form;
  await f.ui.submit(form);
  assert.equal(JSON.parse(f.writes()[0].init.body).appSecret, 'synthetic-appSecret');
  assert.equal(form.get('appSecret'), '');
  assert.equal(f.opened.some(item => item.markup.includes('synthetic-appSecret')), false);
});

test('e-mail usa MepMail separado da conta, pede relay e preserva segredo vazio', async t => {
  const f = fixture(t, 'email'); await f.ui.open(f.channel);
  assert.match(f.modal.markup, /MepMail/);
  assert.match(f.modal.markup, /separado dos convites/);
  assert.match(f.modal.markup, /não conecta uma caixa IMAP/);
  f.modal.form.set('address', 'Novo@Example.com'); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 1, enabled: true, address: 'novo@example.com' });
  assert.equal(f.updates[0].ingressSecret, undefined);
});

test('e-mail inicial habilitado precisa de segredo relay e rejeita endereço ou segredo inválidos', async t => {
  const f = fixture(t, 'email'); f.setSource({ version: 0, ingressConfigured: false }); await f.ui.open(f.channel);
  await assert.rejects(f.ui.submit(f.modal.form), /segredo do relay/);
  f.modal.form.set('ingressSecret', 'short'); await assert.rejects(f.ui.submit(f.modal.form), /32 a 512/);
  f.modal.form.set('ingressSecret', 'a'.repeat(32)); f.modal.form.set('address', 'bad\r\n@example.com'); await assert.rejects(f.ui.submit(f.modal.form), /endereço/);
  assert.equal(f.writes().length, 0);
});

test('webchat salva origens exatas, mantém o designer no guia e mostra o snippet canônico escapado na instalação', async t => {
  const f = fixture(t, 'webchat'); await f.ui.open(f.channel);
  assert.match(f.modal.markup, /data-webchat-install-step="authorize"/);
  assert.equal(f.modal.markup.includes('&lt;script'), false);
  f.modal.form.set('origins', 'https://site.example\nhttps://outro.example\nhttps://site.example'); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 1, enabled: true, origins: ['https://site.example', 'https://outro.example'] });
  assert.deepEqual(f.calls.map(call => [call.init.method, call.path.split('/').at(-1)]), [['GET','configuration'], ['POST','configuration'], ['GET','widget-configuration']]);
  assert.equal(f.modal.open, true);
  assert.match(f.modal.markup, /data-webchat-install-step="appearance"/);
  assert.equal(f.modal.form.dataset.connectorForm, 'widget-settings');
  assert.equal(f.modal.form.get('assistantInstructions'), 'Orientação privada sintética.');
  await f.action('webchat-step-install');
  assert.match(f.modal.markup, /&lt;script type=&quot;module&quot;/);
  assert.match(f.modal.markup, /data-tenant-id=&quot;company-a&quot;/);
  assert.equal(f.modal.markup.includes('<script '), false);
  assert.equal(f.modal.markup.includes('Orientação privada sintética.'), false);
  assert.match(f.modal.markup, /data-connector-action="copy-webchat-code"/);
  assert.match(f.modal.markup, /Copiar o código não confirma a instalação/);
});

test('domínio personalizado usa a origem canônica explícita do bootstrap para consultar e salvar o widget', async t => {
  const f = fixture(t, 'webchat');
  f.state.boot.publicOrigin = 'https://revenda.example'; f.state.boot.canonicalPublicOrigin = 'https://elozi.example';
  assert.equal(await f.ui.open(f.channel), true);
  await f.action('webchat-step-install');
  assert.match(f.modal.markup, /src=&quot;https:\/\/elozi\.example\/widget\.js&quot;/);
  assert.match(f.modal.markup, /data-tenant-id=&quot;company-a&quot; data-channel-id=&quot;channel-a&quot;/);
  assert.equal(f.modal.markup.includes('<script '), false);
  assert.equal(f.modal.form.feedback.textContent, '');
  await f.action('webchat-step-authorize');
  f.modal.form.set('origins', 'https://site.example'); await f.ui.submit(f.modal.form);
  assert.deepEqual(f.calls.map(call => call.init.method), ['GET', 'POST', 'GET']);
  assert.equal(f.calls.at(-1).path, '/api/tenants/company-a/channels/channel-a/widget-configuration');
  assert.equal(f.modal.open, true);
  assert.match(f.modal.markup, /data-webchat-install-step="appearance"/);
  assert.deepEqual(f.writes()[0].init.headers, { 'X-Elozi-Workspace': 'workspace-a' });
  assert.equal(f.updates[0].install.scriptUrl, 'https://elozi.example/widget.js');
  assert.equal(f.messages.at(-1).message, 'Configuração salva.');
});

test('URLs de relay e Meta continuam canônicas ao configurar pelo domínio personalizado', async t => {
  for (const kind of ['email', 'instagram', 'messenger']) {
    const f = fixture(t, kind);
    f.state.boot.publicOrigin = 'https://revenda.example'; f.state.boot.canonicalPublicOrigin = 'https://elozi.example';
    assert.equal(await f.ui.open(f.channel), true, kind);
    assert.match(f.modal.markup, /value="https:\/\/elozi\.example\/api\/webhooks\//);
    await f.ui.submit(f.modal.form);
    assert.equal(f.updates.length, 1); assert.equal(f.messages.at(-1).message, 'Configuração salva.');
  }
});

test('domínio personalizado não autoriza webhook em outra origem, caminho ou empresa', async t => {
  for (const kind of ['email', 'instagram', 'messenger']) {
    const path = `/api/webhooks/${kind === 'email' ? 'email' : 'meta'}/company-a/channel-a`;
    for (const webhookUrl of [`https://evil.example${path}`, `https://revenda.example${path}`, `https://elozi.example${path}?query=1`,
      `https://elozi.example${path}#fragment`, `https://user:pass@elozi.example${path}`, `https://elozi.example${path.replace('company-a', 'other-company')}`,
      `https://elozi.example${path.replace('channel-a', 'other-channel')}`]) {
      const f = fixture(t, kind); f.state.boot.publicOrigin = 'https://revenda.example'; f.state.boot.canonicalPublicOrigin = 'https://elozi.example'; f.setSource({ webhookUrl });
      assert.equal(await f.ui.open(f.channel), false); assert.equal(f.modal.markup.includes('data-connector-form="configuration"'), false); assert.equal(f.writes().length, 0);
    }
  }
});

test('origem canônica explícita inválida não recua para publicOrigin nem permite instalar ou editar', async t => {
  for (const value of [null, '', 123, 'javascript:alert(1)', 'http://elozi.example', 'https://elozi.example/', 'https://elozi.example/path',
    'https://user:pass@elozi.example', 'https://elozi.example?query=1', 'https://elozi.example#fragment', 'https://*.example']) {
    const f = fixture(t, 'webchat'); f.state.boot.canonicalPublicOrigin = value;
    assert.equal(await f.ui.open(f.channel), false, String(value));
    assert.equal(f.modal.markup.includes('data-connector-form="configuration"'), false); assert.equal(f.writes().length, 0);
  }
  const missing = fixture(t, 'webchat'); delete missing.state.boot.publicOrigin;
  assert.equal(await missing.ui.open(missing.channel), false);
  assert.equal(missing.modal.markup.includes('data-connector-form="configuration"'), false);
});

test('origem canônica explícita preserva URL segura, caminho do widget e atributos exatos do canal', async t => {
  const snippet = (url, attributes = 'data-tenant-id="company-a" data-channel-id="channel-a"') => `<script type="module" src="${url}" ${attributes}></script>`;
  const installs = ['https://evil.example/widget.js', 'https://revenda.example/widget.js', 'https://elozi.example/other.js',
    'https://elozi.example/widget.js?query=1', 'https://elozi.example/widget.js#fragment', 'https://user:pass@elozi.example/widget.js', 'http://elozi.example/widget.js']
    .map(scriptUrl => ({ scriptUrl, embedSnippet: snippet(scriptUrl) }));
  for (const attributes of ['data-tenant-id="other-company" data-channel-id="channel-a"', 'data-tenant-id="company-a" data-channel-id="other-channel"',
    'data-tenant-id="company-a" data-channel-id="channel-a" onload="bad()"', 'data-tenant-id="company-a" data-channel-id="channel-a" data-channel-id="channel-a"'])
    installs.push({ scriptUrl: 'https://elozi.example/widget.js', embedSnippet: snippet('https://elozi.example/widget.js', attributes) });
  for (const install of installs) {
    const f = fixture(t, 'webchat'); f.state.boot.publicOrigin = 'https://revenda.example'; f.state.boot.canonicalPublicOrigin = 'https://elozi.example'; f.setSource({ install });
    assert.equal(await f.ui.open(f.channel), false); assert.equal(f.modal.markup.includes('data-connector-form="configuration"'), false); assert.equal(f.writes().length, 0);
  }
  const legacy = fixture(t, 'webchat'); assert.equal(await legacy.ui.open(legacy.channel), true);
  const local = fixture(t, 'webchat'); local.state.boot.canonicalPublicOrigin = 'http://127.0.0.1:49554';
  local.setSource({ install: { scriptUrl: 'http://127.0.0.1:49554/widget.js', embedSnippet: snippet('http://127.0.0.1:49554/widget.js') } });
  assert.equal(await local.ui.open(local.channel), true);
});

test('trocar origem de bootstrap invalida consulta atrasada, formulário e confirmação de POST anteriores', async t => {
  for (const name of ['publicOrigin', 'canonicalPublicOrigin', 'removeCanonical', 'addInvalidCanonical']) {
    const prepare = f => { if (name !== 'addInvalidCanonical') f.state.boot.canonicalPublicOrigin = 'https://elozi.example'; };
    const change = f => {
      if (name === 'removeCanonical') delete f.state.boot.canonicalPublicOrigin;
      else if (name === 'addInvalidCanonical') f.state.boot.canonicalPublicOrigin = null;
      else f.state.boot[name] = 'https://other.example';
    };
    const response = deferred(), reading = fixture(t, 'webchat', { intercept: () => response.promise });
    prepare(reading); const opening = reading.ui.open(reading.channel);
    change(reading); response.resolve(reading.source());
    assert.equal(await opening, false); assert.equal(reading.modal.open, false);
    assert.equal(reading.opened.some(item => item.markup.includes('data-connector-form="configuration"')), false);

    const editing = fixture(t, 'webchat'); prepare(editing);
    assert.equal(await editing.ui.open(editing.channel), true); const old = editing.modal.form;
    change(editing);
    await assert.rejects(editing.ui.submit(old), /Abra a configuração/); assert.equal(editing.writes().length, 0);

    const confirmation = deferred(), writing = fixture(t, 'webchat', { intercept: (path, init, fallback) => init.method === 'POST' ? confirmation.promise : fallback() });
    prepare(writing); assert.equal(await writing.ui.open(writing.channel), true);
    const saving = writing.ui.submit(writing.modal.form); change(writing);
    confirmation.resolve({ ...writing.source(), version: 2 }); await saving;
    assert.equal(writing.updates.length, 0); assert.equal(writing.messages.length, 0); assert.equal(writing.modal.open, false);
  }
});

test('bootstrap sem CSRF mantém draft após CAS e salva webchat com workspace explícito sem fechar o guia', async t => {
  const f = fixture(t, 'webchat'); f.state.workspaceId = null;
  assert.equal(Object.hasOwn(f.state.boot, 'csrfToken'), false);
  assert.equal(Object.hasOwn(f.state.boot.session, 'csrfToken'), false);
  assert.equal(await f.ui.open(f.channel), true);
  const form = f.modal.form; form.set('origins', 'http://127.0.0.1:49554');
  f.setSource({version: 4, origins: ['https://current.example']});
  await f.ui.submit(form);
  assert.equal(f.modal.form, form); assert.equal(form.get('origins'), 'http://127.0.0.1:49554'); assert.equal(form.submit.disabled, true);
  assert.equal(f.modal.open, true); assert.match(f.modal.markup, /data-webchat-install-step="authorize"/);
  await assert.rejects(f.ui.submit(form), /Consulte a configuração/);
  await f.action('refresh');
  assert.equal(f.modal.form, form); assert.equal(form.get('origins'), 'http://127.0.0.1:49554'); assert.match(form.current.innerHTML, /https:\/\/current.example/);
  await f.ui.submit(form);
  assert.deepEqual(f.calls.map(call => call.init.method), ['GET', 'POST', 'GET', 'POST', 'GET']);
  for (const call of f.calls) assert.deepEqual(call.init.headers, { 'X-Elozi-Workspace': 'workspace-a' });
  assert.deepEqual(JSON.parse(f.writes().at(-1).init.body), { version: 4, enabled: true, origins: ['http://127.0.0.1:49554'] });
  assert.equal(f.source().version, 5); assert.equal(f.updates[0].channelId, f.channel.id);
  assert.equal(f.updates.length, 1); assert.equal(f.modal.open, true); assert.match(f.modal.markup, /data-webchat-install-step="appearance"/);
  assert.equal(f.messages.at(-1).message, 'Configuração salva.');
});

test('token opcional da sessão ou boot segue no header e mudar ou remover invalida o formulário antigo', async t => {
  for (const source of ['boot', 'session']) for (const change of ['replace', 'remove']) {
    const f = fixture(t, 'webchat'), holder = source === 'boot' ? f.state.boot : f.state.boot.session;
    holder.csrfToken = 'optional-csrf'; await f.ui.open(f.channel); const old = f.modal.form;
    assert.equal(f.calls[0].init.headers['X-CSRF-Token'], 'optional-csrf');
    if (change === 'replace') holder.csrfToken = 'changed-csrf'; else delete holder.csrfToken;
    await assert.rejects(f.ui.submit(old), /Abra a configuração/); assert.equal(f.writes().length, 0);
    assert.equal(await f.ui.open(f.channel), true); await f.ui.submit(f.modal.form);
    for (const call of f.calls.slice(1)) {
      if (change === 'replace') assert.equal(call.init.headers['X-CSRF-Token'], 'changed-csrf');
      else assert.equal(Object.hasOwn(call.init.headers, 'X-CSRF-Token'), false);
    }
  }
});

test('GET sem CSRF não abre edição quando a identidade ou o contexto muda durante a consulta', async t => {
  for (const change of ['workspace', 'operator', 'support', 'service', 'tenant', 'token']) {
    const response = deferred(), f = fixture(t, 'webchat', { intercept: () => response.promise });
    const opening = f.ui.open(f.channel);
    if (change === 'workspace') f.state.workspaceId = 'other-workspace';
    if (change === 'operator') f.state.boot.session.role = 'operator';
    if (change === 'support') f.state.boot.session.supportGrantId = 'support-grant';
    if (change === 'service') f.state.boot.session.kind = 'service';
    if (change === 'tenant') f.state.tenant.id = 'other-company';
    if (change === 'token') f.state.boot.csrfToken = 'new-optional-token';
    response.resolve(f.source()); assert.equal(await opening, false);
    assert.equal(f.opened.some(item => item.markup.includes('data-connector-form="configuration"')), false);
    assert.equal(f.writes().length, 0);
  }
});

test('close enfileirado de modal anterior não apaga credencial nem impede salvar o canal reaberto', async t => {
  const f = fixture(t, 'email', { queuedClose: true }); f.state.boot.csrfToken = 'optional-csrf'; await f.ui.open(f.channel);
  await f.ui.submit(f.modal.form); assert.equal(f.modal.open, false);
  await f.ui.open(f.channel); const active = f.modal.form, signal = f.calls.at(-1).init.signal;
  active.set('ingressSecret', 'synthetic-relay-' + 'x'.repeat(32));
  f.flushClose();
  assert.equal(f.modal.open, true); assert.equal(signal.aborted, false);
  assert.equal(active.get('ingressSecret'), 'synthetic-relay-' + 'x'.repeat(32));
  await f.ui.submit(active); assert.equal(f.writes().length, 2); assert.equal(f.updates.length, 2);
  assert.equal(active.get('ingressSecret'), '');
});

test('origens rejeitam curingas, caminhos, credenciais, HTTP externo e excesso; loopback é permitido', async t => {
  const f = fixture(t, 'webchat'); await f.ui.open(f.channel);
  for (const value of ['', 'https://site.example/path', 'https://*.site.example', 'https://user:pass@site.example', 'http://site.example', 'https://site.example/', Array.from({ length: 9 }, (_, i) => `https://site${i}.example`).join('\n')]) {
    f.modal.form.set('origins', value); await assert.rejects(f.ui.submit(f.modal.form));
  }
  assert.equal(f.writes().length, 0);
  f.modal.form.set('origins', 'http://127.0.0.1:49554'); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body).origins, ['http://127.0.0.1:49554']);
});

test('DTO de outro tenant/kind/revisão e instalação externa ou forjada não habilitam edição', async t => {
  for (const wrong of [{ tenantId: 'other-company' }, { channelId: 'other-channel' }, { kind: 'email' }, { version: -1 }, { enabled: 'true' },
    { install: { scriptUrl: 'https://evil.example/widget.js' } }, { install: { scriptUrl: 'javascript:alert(1)' } },
    { install: { scriptUrl: 'https://elozi.example/widget.js', embedSnippet: '<script src="https://elozi.example/widget.js" onload="bad()"></script>' } }]) {
    const f = fixture(t, 'webchat'); f.setSource(wrong); assert.equal(await f.ui.open(f.channel), false); assert.equal(f.writes().length, 0);
    assert.equal(f.modal.markup.includes('data-connector-form="configuration"'), false);
  }
});

test('operador, suporte, serviço e canal fora da empresa não consultam nem salvam mesmo sem CSRF no boot', async t => {
  for (const mode of ['operator', 'support', 'service', 'tenant-owner', 'channel']) {
    const f = fixture(t);
    if (mode === 'operator') f.state.boot.session.role = 'operator';
    if (mode === 'support') f.state.boot.session.supportGrantId = 'grant-a';
    if (mode === 'service') f.state.boot.session.kind = 'service';
    if (mode === 'tenant-owner') f.state.tenant.resellerId = 'other-workspace';
    if (mode === 'channel') f.state.tenant.channels = [];
    assert.equal(await f.ui.open(f.channel), false);
    assert.equal(f.calls.length, 0);
  }
});

test('mudança de workspace/company/user/CSRF/grant/permissões/modal impede formulário anterior', async t => {
  for (const mode of ['workspace', 'company', 'user', 'csrf', 'grant', 'permissions', 'scope', 'workspaceAccess', 'tenantAccess', 'modal']) {
    const f = fixture(t); await f.ui.open(f.channel); const old = f.modal.form;
    if (mode === 'workspace') f.state.workspaceId = 'other-workspace';
    if (mode === 'company') f.state.tenant.id = 'other-company';
    if (mode === 'user') f.state.boot.session.userId = 'other-user';
    if (mode === 'csrf') f.state.boot.csrfToken = 'other-csrf';
    if (mode === 'grant') f.state.supportGrantId = 'grant-a';
    if (mode === 'permissions') f.state.boot.session.permissions = [];
    if (mode === 'scope') f.state.boot.session.scopeRules = [{ tenants: [] }];
    if (mode === 'workspaceAccess') f.state.boot.workspaces = [{ id: 'other-workspace' }];
    if (mode === 'tenantAccess') f.state.boot.tenants = [{ id: 'other-company' }];
    if (mode === 'modal') await f.ui.open(f.channel);
    await assert.rejects(f.ui.submit(old), /Abra a configuração/);
    assert.equal(f.writes().length, 0);
  }
});

test('GET atrasado é abortado por outra abertura e não sobrepõe o modal novo', async t => {
  const first = deferred(); let reads = 0;
  const f = fixture(t, 'email', { intercept: (path, init, fallback) => init.method === 'GET' && ++reads === 1 ? first.promise : fallback() });
  const opening = f.ui.open(f.channel), signal = f.calls[0].init.signal;
  await f.ui.open(f.channel);
  const token = f.modal.panel.dataset.connectorToken;
  first.resolve({ ...f.source(), address: 'old@example.com' }); await opening;
  assert.equal(signal.aborted, true);
  assert.equal(f.modal.panel.dataset.connectorToken, token);
  assert.equal(f.modal.form.get('address'), 'atendimento@example.com');
});

test('POST atrasado após troca de identidade não fecha outro modal, mostra sucesso ou atualiza estado', async t => {
  const response = deferred();
  const f = fixture(t, 'email', { intercept: (path, init, fallback) => init.method === 'POST' ? response.promise : fallback() }); await f.ui.open(f.channel);
  f.modal.form.set('ingressSecret', 'a'.repeat(32));
  const saving = f.ui.submit(f.modal.form); f.state.boot.session.userId = 'other-user';
  response.resolve({ ...f.source(), version: 2 }); await saving;
  assert.equal(f.updates.length, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.modal.open, false);
});

test('409 preserva formulário e chave digitada, bloqueia POST até GET fresco e mantém revisão atual visível', async t => {
  let fail = true;
  const f = fixture(t, 'email', { intercept: (path, init, fallback) => { if (init.method === 'POST' && fail) { fail = false; throw Object.assign(new Error('secret-must-not-reflect'), { status: 409 }); } return fallback(); } });
  await f.ui.open(f.channel); const form = f.modal.form;
  form.set('address', 'edited@example.com'); form.set('ingressSecret', 'a'.repeat(32)); await f.ui.submit(form);
  assert.equal(form.get('address'), 'edited@example.com');
  assert.equal(form.get('ingressSecret'), 'a'.repeat(32));
  assert.equal(form.submit.disabled, true);
  assert.equal(form.feedback.textContent.includes('secret-must-not-reflect'), false);
  await assert.rejects(f.ui.submit(form), /Consulte a configuração/);
  f.setSource({ version: 4, address: 'server@example.com' }); await f.action('refresh');
  assert.equal(f.modal.form, form);
  assert.match(form.current.innerHTML, /server@example.com/);
  assert.equal(form.get('address'), 'edited@example.com');
  await f.ui.submit(form);
  assert.equal(JSON.parse(f.writes().at(-1).init.body).version, 4);
});

test('resposta incerta limpa chave e verifica somente GET; segredos não podem ser comprovados por DTO', async t => {
  const f = fixture(t, 'email', { intercept: (path, init, fallback) => { const result = fallback(); if (init.method === 'POST') throw new Error('synthetic-ingress-secret-provider-error'); return result; } });
  await f.ui.open(f.channel); const form = f.modal.form;
  form.set('ingressSecret', 'a'.repeat(32)); await f.ui.submit(form);
  assert.equal(form.get('ingressSecret'), '');
  assert.match(f.modal.markup, /não envia as credenciais novamente/);
  assert.equal(f.modal.markup.includes('synthetic-ingress-secret-provider-error'), false);
  await f.action('verify');
  assert.equal(f.writes().length, 1);
  assert.equal(f.calls.at(-1).init.method, 'GET');
  assert.match(f.modal.markup, /Valores privados não são devolvidos/);
  assert.equal(f.modal.form.get('ingressSecret'), '');
  assert.equal(f.updates.length, 1);
});

test('incerteza sem aplicação ou com outra revisão apresenta configuração fresca sem repetir POST', async t => {
  for (const applied of [false, true]) {
    const f = fixture(t, 'webchat', { intercept: (path, init, fallback) => { if (init.method === 'POST') { if (applied) { fallback(); f.setSource({ version: 5, origins: ['https://changed.example'] }); } throw new Error('Synthetic missing response'); } return fallback(); } });
    await f.ui.open(f.channel); f.modal.form.set('origins', 'https://edited.example'); await f.ui.submit(f.modal.form); await f.action('verify');
    assert.equal(f.writes().length, 1);
    assert.match(f.modal.markup, applied ? /outra revisão/ : /revisão anterior/);
    assert.equal(f.modal.form.get('origins'), applied ? 'https://changed.example' : 'https://site.example');
  }
});

test('busy não duplica gravação e callback de atualização falho não transforma aceite em incerteza', async t => {
  const response = deferred();
  const f = fixture(t, 'email', { intercept: (path, init, fallback) => init.method === 'POST' ? response.promise : fallback(), onUpdate: async () => { throw new Error('Refresh failed'); } });
  await f.ui.open(f.channel); const form = f.modal.form, saving = f.ui.submit(form);
  await f.ui.submit(form); await f.action('refresh');
  assert.equal(f.writes().length, 1);
  response.resolve({ ...f.source(), version: 2 }); await saving;
  assert.equal(f.modal.open, false);
  assert.match(f.messages.at(-1).message, /Configuração salva/);
  assert.equal(f.opened.some(item => item.markup.includes('confirmação da gravação não chegou')), false);
});

test('403 não reflete mensagem do provedor e reset apaga valores privados/aborta leitura', async t => {
  const f = fixture(t, 'email', { intercept: (path, init, fallback) => { if (init.method === 'POST') throw Object.assign(new Error('provider-secret-exposure'), { status: 403 }); return fallback(); } });
  await f.ui.open(f.channel); const form = f.modal.form; form.set('ingressSecret', 'a'.repeat(32)); await f.ui.submit(form);
  assert.equal(form.get('ingressSecret'), '');
  assert.equal(f.modal.open, false);
  assert.equal(f.messages.some(item => item.message.includes('provider-secret-exposure')), false);
  await f.ui.open(f.channel); f.modal.form.set('ingressSecret', 'b'.repeat(32)); const active = f.modal.form;
  f.ui.reset(); assert.equal(active.get('ingressSecret'), ''); assert.equal(f.calls.at(-1).init.signal.aborted, true);
  assert.equal(await f.ui.action({ dataset: { connectorAction: 'other' } }), false);
  assert.equal(await f.ui.submit({ dataset: {} }), false);
});
