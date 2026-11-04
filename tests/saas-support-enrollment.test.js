import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createApp } from '../src/server.js';
import { SUPPORT_PRODUCTS } from '../src/central-support.js';
import { renderSupportAssistant, supportCatalogMarkup, bindSupportAssistant } from '../public/support-assistant-ui.js';
import { setLocale, t as translated } from '../public/i18n.js';

const publicOrigin = 'https://elozi.example.test';
const status = expected => error => error.status === expected;
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attribute = (html, name) => decode(new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(html)?.[1] || '');

function fixture(t) {
  const external = [], providerCalls = [], key = Buffer.alloc(32, 37);
  const deny = async () => { external.push(true); throw Error('External transport forbidden in SaaS enrollment fixture'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, publicOrigin,
    providerCall: async input => { providerCalls.push(input); return 'Abra Configurações e escolha o canal de webchat para configurar o acesso.'; }, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  const { store, auth, webchat, knowledge, centralSupport: central } = app;
  let sequence = 0;
  const member = (workspace, role = 'reseller', tenantIds = [], platformAdmin = false) => {
    const row = auth.insertUser({ username: 'saas.fixture.' + ++sequence, name: 'Pessoa sintética ' + sequence }, Buffer.alloc(16, sequence), Buffer.alloc(64, sequence), role, tenantIds, workspace, { platformAdmin });
    const session = auth.session(row); return { actor: session.actor, cookie: 'mep_session=' + session.token };
  };
  const root = member('mep-demo', 'reseller', [], true);
  const install = label => {
    const workspace = 'saas-' + label.toLowerCase();
    store.db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspace, JSON.stringify({ name: label, accountKind: 'business' }));
    const admin = member(workspace), tenant = store.createTenant(admin.actor, { name: label, segment: 'SaaS' });
    const origin = 'https://' + label.toLowerCase() + '.example.test';
    store.mutate(admin.actor, tenant.id, 'Fixture SaaS isolada', state => {
      state.channels = [{ id: 'webchat', name: 'Suporte ' + label, kind: 'webchat' }, { id: 'not-enrolled', kind: 'webchat', name: 'Ainda desligado' }, { id: 'wa', kind: 'whatsapp_qr' }];
      state.agents = [
        { id: 'hermes', name: 'Hermes ' + label, provider: 'hermes', mode: 'copilot', configured: true, version: 1, tools: [], description: 'Suporte ' + label,
          instructions: 'Mantenha a persona ' + label, profile: { persona: label, memory: 'Memória existente ' + label }, model: 'existing-model-' + label },
        { id: 'unconfigured', provider: 'hermes', mode: 'copilot', configured: false },
        { id: 'mcp', provider: 'mcp', mode: 'copilot', configured: true },
        { id: 'wrong-mode', provider: 'hermes', mode: 'automatic', configured: true }
      ];
    });
    webchat.configure(admin.actor, tenant.id, 'webchat', { version: 0, origins: [origin] });
    let source = knowledge.create(admin.actor, tenant.id, { title: 'Acesso ' + label, category: 'Suporte', content: 'Abra Configurações e escolha o canal de webchat para configurar o acesso. Conhecimento privado ' + label + '.' });
    source = knowledge.publish(admin.actor, tenant.id, source.id, { version: source.version });
    knowledge.setGrants(admin.actor, tenant.id, 'hermes', { version: 1, grants: [{ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash }] });
    const operator = member(workspace, 'operator', [tenant.id]);
    const input = more => ({ version: 0, enabled: true, autoReply: false, agentId: 'hermes', productNames: [label + ' SaaS'], ...more });
    const state = () => store.tenant(admin.actor, tenant.id);
    const configure = more => central.configure(admin.actor, tenant.id, 'webchat', input(more));
    const open = () => { const challenge = webchat.challenge({ tenantId: tenant.id, channelId: 'webchat', origin }); return webchat.openSession({ tenantId: tenant.id, channelId: 'webchat', origin, challenge: challenge.challenge, name: 'Visitante ' + label }); };
    return { workspace, admin, tenant, operator, origin, source, input, state, configure, open };
  };
  const alpha = install('Alpha'), beta = install('Beta');
  const request = (path, { method = 'GET', cookie, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method,
      headers: { 'Content-Type': 'application/json', Host: 'elozi.example.test', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(5000, () => req.destroy(Error('Loopback deadline'))); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  t.after(async () => {
    await central.close(); await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma chamada real de IA, e-mail ou transporte'); store.close();
  });
  return { app, store, auth, webchat, knowledge, central, root, alpha, beta, providerCalls, request };
}

function uiFixture(t, { source, api, refresh = async () => {} }) {
  const original = globalThis.document;
  const element = () => { const listeners = new Map(); return { hidden: true, disabled: false, textContent: '', setAttribute() {}, removeAttribute() {}, addEventListener(name, fn) { listeners.set(name, fn); }, click() { return listeners.get('click')?.(); } }; };
  globalThis.document = { createElement: () => element() };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; setLocale('pt-BR', { persist: false, notify: false }); });
  const calls = [], messages = [], forms = [], reload = element(), discard = element(), notice = element();
  let catalog = source, body = '';
  const selected = (html, name) => {
    const options = new RegExp('<select\\b[^>]*name="' + name + '"[^>]*>([\\s\\S]*?)<\\/select>').exec(html)?.[1] || '';
    const entries = [...options.matchAll(/<option\b([^>]*)>/g)]; return attribute((entries.find(entry => /\bselected\b/.test(entry[1])) || entries[0])?.[1] || '', 'value');
  };
  const content = { get innerHTML() { return body; }, set innerHTML(value) {
    body = value; for (const form of forms) form.isConnected = false; forms.splice(0);
    for (const match of value.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
      const listeners = new Map(), error = { hidden: true, textContent: '', focusCount: 0, focus() { this.focusCount++; } }, submit = element(), statusElement = element(), retry = element();
      const elements = Object.fromEntries(['agentId', 'mode', 'productSource', 'handoffMode'].map(name => [name, { value: selected(match[2], name) }]));
      elements.productNames = { value: decode(/<textarea\b[^>]*name="productNames"[^>]*>([\s\S]*?)<\/textarea>/.exec(match[2])?.[1] || '') };
      const checkboxIds = [...match[2].matchAll(/<input\b([^>]*name="productIds"[^>]*)>/g)].map(item => ({ value: attribute(item[1], 'value'), checked: /\bchecked\b/.test(item[1]) }));
      const groups = { custom: element(), registry: element() };
      const form = { isConnected: true, dataset: { supportChannel: attribute(match[1], 'data-support-channel'), version: attribute(match[1], 'data-version') }, elements, error, submit, status: statusElement, retry, groups, checkboxIds,
        querySelector(selector) { return selector === '[data-support-error]' ? error : selector === '[data-support-status]' ? statusElement : selector === '[data-support-catalog-retry]' ? retry : selector === 'button[type="submit"]' ? submit : selector === '[data-support-products-custom]' ? groups.custom : selector === '[data-support-products-registry]' ? groups.registry : null; },
        querySelectorAll(selector) { return selector === 'input[name="productIds"]:checked' ? checkboxIds.filter(item => item.checked) : selector === 'input[name="productIds"]' ? checkboxIds : []; },
        addEventListener(name, fn) { listeners.set(name, fn); }, change() { return listeners.get('change')?.(); }, send() { return listeners.get('submit')?.({ preventDefault() {} }); }
      };
      forms.push(form);
    }
  }, querySelectorAll: () => forms, contains: form => forms.includes(form), replaceChildren() { body = ''; }, append() {} };
  const state = { workspaceId: 'saas-alpha', tenant: { id: 'tenant-a' }, view: 'agents', boot: { canonicalPublicOrigin: publicOrigin, session: { role: 'reseller', userId: 'admin-alpha', platformOwner: false } } };
  const markup = renderSupportAssistant(state);
  const panel = { isConnected: true, dataset: { supportTenant: 'tenant-a', supportOrigin: publicOrigin, supportContext: attribute(/<section\b([^>]*)>/.exec(markup)[1], 'data-support-context') },
    querySelector(selector) { return selector === '[data-support-central-content]' ? content : selector === '[data-support-reload]' ? reload : selector === '[data-support-discard-drafts]' ? discard : selector === '[data-support-central-notice]' ? notice : null; } };
  const root = { contains: candidate => candidate === panel, querySelector: () => panel };
  const fallback = (path, init) => { if (init.method !== 'PATCH') return structuredClone(catalog); const input = JSON.parse(init.body), channel = catalog.channels.find(item => item.id === decodeURIComponent(path.split('/').at(-2))); return { channelId: channel.id, ...input, version: input.version + 1, products: input.productNames || input.productIds.map(id => catalog.products.find(item => item.id === id).name), origins: channel.origins }; };
  const request = async (path, init = {}) => { calls.push({ path, init }); return api ? api(path, init, () => fallback(path, init)) : fallback(path, init); };
  const bind = more => bindSupportAssistant({ root, tenantId: 'tenant-a', admin: true, api: request, toast: message => messages.push(message), refresh, ...more });
  return { bind, state, panel, content, forms, calls, messages, reload, discard, notice, root, source: value => { catalog = value; } };
}
const uiCatalog = () => ({ productInputMode: 'custom', products: SUPPORT_PRODUCTS, agents: [{ id: 'hermes', name: 'Hermes Alpha', knowledgeCount: 1 }],
  channels: [{ id: 'webchat', name: 'Meu SaaS & Portal', configured: true, origins: ['https://alpha.example.test'], productIds: [], productNames: ['Alpha SaaS'],
    assistant: { version: 3, enabled: true, autoReply: false, agentId: 'hermes', handoffMode: 'pause', jobs: [] }, integration: { source: publicOrigin + '/widget.js', tenantId: 'tenant-a', channelId: 'webchat' } }] });

test('admin externo inscreve nomes explícitos só no canal escolhido e preserva perfil, modelo, memória e fontes', t => {
  const f = fixture(t), before = structuredClone(f.alpha.state()), other = f.beta.state();
  const result = f.alpha.configure({ productNames: ['Portal & APIs', 'Alpha SaaS'], handoffMode: 'continue' });
  assert.deepEqual(result.products, ['Alpha SaaS', 'Portal & APIs']); assert.deepEqual(result.origins, [f.alpha.origin]); assert.equal(result.handoffMode, 'continue');
  const saved = f.alpha.state(); assert.deepEqual(saved.agents, before.agents); assert.deepEqual(saved.channels[1], before.channels[1]); assert.deepEqual(f.beta.state(), other);
  assert.deepEqual(saved.channels[0].centralSupportScope.productNames, ['Alpha SaaS', 'Portal & APIs']); assert.equal(saved.channels[0].centralSupportScope.productIds, undefined);
  assert.equal(saved.channels[0].centralSupportScope.configuredBy, f.alpha.admin.actor.userId); assert.equal(saved.channels[0].supportAssistant.autoReply, false); assert.equal(f.providerCalls.length, 0);
});

test('catálogo de cada tenant contém apenas Hermes próprio configurado, sem agentes MCP, credenciais ou fontes de outro tenant', t => {
  const f = fixture(t); f.alpha.configure(); f.beta.configure();
  for (const [own, other] of [[f.alpha, f.beta], [f.beta, f.alpha]]) {
    const result = f.central.catalog(own.admin.actor, own.tenant.id);
    assert.equal(result.productInputMode, 'custom'); assert.deepEqual(result.agents, [{ id: 'hermes', name: 'Hermes ' + own.state().name, knowledgeCount: 1 }]);
    assert.deepEqual(result.channels[0].productNames, [own.state().name + ' SaaS']); assert.equal(result.channels[1].assistant.enabled, false);
    assert.equal(JSON.stringify(result).includes('Hermes ' + other.state().name), false); assert.equal(JSON.stringify(result).includes(other.source.id), false);
    for (const privateField of ['endpoint', 'token', 'instructions', 'memory', 'profile', 'knowledgeGrants', 'model']) assert.equal(Object.hasOwn(result.agents[0], privateField), false);
  }
});

test('operador, sessão de serviço, concessão de suporte e plataforma sem grant explícito não ganham administração cruzada', t => {
  const f = fixture(t);
  const denied = [f.alpha.operator.actor, { ...f.alpha.operator.actor, role: 'reseller', platformAdmin: true }, { ...f.alpha.admin.actor, supportGrantId: 'delegated' },
    { ...f.alpha.admin.actor, kind: 'service' }, { ...f.root.actor, resellerId: f.alpha.workspace }, { ...f.beta.admin.actor, resellerId: f.alpha.workspace }];
  for (const actor of denied) {
    assert.throws(() => f.central.catalog(actor, f.alpha.tenant.id), status(403));
    assert.throws(() => f.central.configure(actor, f.alpha.tenant.id, 'webchat', f.alpha.input()), status(403));
  }
  assert.throws(() => f.central.catalog(f.root.actor, f.alpha.tenant.id), status(404));
  assert.throws(() => f.central.configure(f.beta.admin.actor, f.alpha.tenant.id, 'webchat', f.alpha.input()), status(404));
  assert.equal(f.alpha.state().channels[0].centralSupportScope, undefined);
});

test('revogação e revisão CAS antigas rejeitam escrita sem alterar registro nem configuração', t => {
  const f = fixture(t); f.alpha.configure(); const before = f.alpha.state().channels[0];
  assert.throws(() => f.alpha.configure({ productNames: ['Outro SaaS'], handoffMode: 'continue' }), status(409)); assert.deepEqual(f.alpha.state().channels[0], before);
  f.store.db.prepare("UPDATE auth_users SET role='operator' WHERE id=?").run(f.alpha.admin.actor.userId);
  assert.throws(() => f.alpha.configure({ version: 1 }), status(403)); assert.throws(() => f.central.catalog(f.alpha.admin.actor, f.alpha.tenant.id), status(403)); assert.deepEqual(f.alpha.state().channels[0], before);
});

test('perda de autorização entre inscrição e configuração restaura apenas o registro desta tentativa', t => {
  const f = fixture(t), before = f.alpha.state().channels[0]; let checks = 0;
  assert.throws(() => f.central.configure(f.alpha.admin.actor, f.alpha.tenant.id, 'webchat', f.alpha.input(), { reauthorize: () => ++checks < 3 }), status(403));
  assert.ok(checks >= 3); assert.deepEqual(f.alpha.state().channels[0], before); assert.equal(f.central.scopes().length, 0);
});

test('agente existente só em outro tenant não pode ser selecionado nem gravado desligado', t => {
  const f = fixture(t);
  f.store.mutate(f.beta.admin.actor, f.beta.tenant.id, 'Identidade exclusiva do outro tenant', tenant => { tenant.agents[0].id = 'beta-only'; });
  const before = f.alpha.state();
  for (const enabled of [true, false]) assert.throws(() => f.alpha.configure({ enabled, agentId: 'beta-only' }), status(409));
  assert.deepEqual(f.alpha.state(), before);
});

test('edição rejeitada após inscrição preserva rascunho real existente e revisão do registro anterior', async t => {
  const f = fixture(t); f.alpha.configure(); const visitor = f.alpha.open();
  await f.webchat.receive({ token: visitor.token, origin: f.alpha.origin, text: 'Como configurar acesso ao painel?', clientMessageId: 'retained-draft-message-01' }); await f.central.drain();
  const before = f.alpha.state(); assert.equal(before.supportAssistantJobs[0].state, 'draft'); let checks = 0;
  assert.throws(() => f.central.configure(f.alpha.admin.actor, f.alpha.tenant.id, 'webchat', f.alpha.input({ version: 1, productNames: ['Nome não autorizado'] }), { reauthorize: () => ++checks < 3 }), status(403));
  const after = f.alpha.state(); assert.deepEqual(after.supportAssistantJobs, before.supportAssistantJobs); assert.deepEqual(after.channels[0], before.channels[0]);
  assert.deepEqual(f.central.catalog(f.alpha.admin.actor, f.alpha.tenant.id).channels[0].assistant.products, ['Alpha SaaS']);
});

test('restauração de tentativa rejeitada não sobrescreve registro e revisão mais novos', t => {
  const f = fixture(t); f.alpha.configure(); let checks = 0;
  assert.throws(() => f.central.configure(f.alpha.admin.actor, f.alpha.tenant.id, 'webchat', f.alpha.input({ version: 1, productNames: ['Tentativa antiga'] }), { reauthorize: () => {
    if (++checks !== 3) return true;
    f.store.mutate(f.alpha.admin.actor, f.alpha.tenant.id, 'Save mais novo autorizado', tenant => {
      tenant.channels[0].centralSupportScope.productNames = ['Produto mais novo']; tenant.channels[0].supportAssistant.version = 2;
    }); return false;
  } }), status(403));
  const saved = f.alpha.state().channels[0]; assert.deepEqual(saved.centralSupportScope.productNames, ['Produto mais novo']); assert.equal(saved.supportAssistant.version, 2);
});

const invalidNames = [undefined, null, 'Alpha', [], [''], [' Alpha'], ['Alpha '], ['Alpha', 'alpha'], ['Á', 'A\u0301'], ['<script>'], ['Alpha\nBeta'], ['Alpha\u0000'], ['Alpha\u200b'], ['---'], ['x'.repeat(81)], Array.from({ length: 9 }, (_, index) => 'Produto ' + index), [1], [{}], [false], ['\ud800'], Array(1)];
for (const [index, productNames] of invalidNames.entries()) test('productNames inválido ' + index + ' não deixa inscrição parcial', t => {
  const f = fixture(t), before = f.alpha.state().channels[0];
  assert.throws(() => f.alpha.configure({ productNames }), status(400)); assert.deepEqual(f.alpha.state().channels[0], before);
});

test('schema mantém productIds legado, aceita Unicode seguro, rejeita os dois registros e handoff inválido', t => {
  const f = fixture(t);
  for (const fields of [{ productIds: ['elozi'], productNames: ['Alpha'] }, { productNames: ['Alpha'], handoffMode: 'automatic' }, { productNames: ['Alpha'], handoffMode: null }, { origins: ['https://evil.example.test'] }, { workspaceId: f.beta.workspace }]) {
    assert.throws(() => f.alpha.configure(fields), status(400)); assert.equal(f.alpha.state().channels[0].centralSupportScope, undefined);
  }
  const first = f.alpha.configure({ productNames: ['Área do cliente', 'API / SDK v2'] }); assert.deepEqual(first.products, ['API / SDK v2', 'Área do cliente']); assert.equal(first.handoffMode, 'pause');
  const input = { version: 1, agentId: 'hermes', enabled: true, autoReply: false, productIds: ['urlpivot', 'elozi'] };
  const result = f.central.configure(f.alpha.admin.actor, f.alpha.tenant.id, 'webchat', input); assert.deepEqual(result.products, ['Elozi', 'URLPivot']);
  assert.deepEqual(f.alpha.state().channels[0].centralSupportScope.productIds, ['elozi', 'urlpivot']); assert.equal(f.alpha.state().channels[0].centralSupportScope.productNames, undefined);
});

test('origens exatas e canal habilitado são pré-requisitos; remover origem revoga escopo sem reescrever legado', t => {
  const f = fixture(t);
  assert.throws(() => f.central.configure(f.alpha.admin.actor, f.alpha.tenant.id, 'not-enrolled', f.alpha.input()), status(409));
  assert.throws(() => f.central.configure(f.alpha.admin.actor, f.alpha.tenant.id, 'wa', f.alpha.input()), status(409));
  f.alpha.configure(); const beforeRegistry = f.alpha.state().channels[0].centralSupportScope;
  f.store.mutate(f.alpha.admin.actor, f.alpha.tenant.id, 'Revogação explícita da origem', tenant => { tenant.channels[0].webchat.origins = ['https://new.example.test']; });
  f.central.reload(); assert.equal(f.central.scopes().length, 0); assert.equal(f.central.catalog(f.alpha.admin.actor, f.alpha.tenant.id).channels[0].assistant.enabled, false);
  assert.deepEqual(f.alpha.state().channels[0].centralSupportScope, beforeRegistry);
});

test('leituras e reload não migram registros productIds legados nem ativam novas conexões por inferência', t => {
  const f = fixture(t);
  f.store.mutate(f.alpha.admin.actor, f.alpha.tenant.id, 'Registro legado sintético', tenant => {
    tenant.channels[0].centralSupportScope = { productIds: ['mepmail'], origins: [f.alpha.origin], configuredBy: f.alpha.admin.actor.userId };
    tenant.channels[0].supportAssistant = { version: 7, agentId: 'hermes', enabled: false, autoReply: false };
  });
  const before = f.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.alpha.tenant.id).data;
  f.central.reload(); const result = f.central.catalog(f.alpha.admin.actor, f.alpha.tenant.id);
  assert.deepEqual(result.channels[0].productIds, ['mepmail']); assert.deepEqual(result.channels[0].productNames, []); assert.equal(result.channels[0].assistant.enabled, false);
  assert.equal(f.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.alpha.tenant.id).data, before); assert.equal(f.beta.state().channels[0].centralSupportScope, undefined);
});

test('runtime e gateway reais atendem dois SaaS com o mesmo id de agente sem compartilhar conhecimento ou conversa', async t => {
  const f = fixture(t); f.alpha.configure({ autoReply: true }); f.beta.configure({ autoReply: true });
  for (const own of [f.alpha, f.beta]) {
    const visitor = own.open(); await f.webchat.receive({ token: visitor.token, origin: own.origin, text: 'Como configurar o acesso ao painel?', clientMessageId: 'message-' + own.workspace }); await f.central.drain();
    const conversation = own.state().conversations[0]; assert.equal(conversation.messages.filter(message => message.kind === 'agent').length, 1); assert.equal(own.state().supportAssistantJobs[0].state, 'completed');
    assert.throws(() => f.webchat.history({ token: visitor.token, origin: own === f.alpha ? f.beta.origin : f.alpha.origin }), status(403));
  }
  assert.equal(f.providerCalls.length, 2);
  const first = JSON.stringify(f.providerCalls[0]), second = JSON.stringify(f.providerCalls[1]);
  assert.match(first, /Conhecimento privado Alpha/); assert.doesNotMatch(first, /Conhecimento privado Beta/); assert.match(second, /Conhecimento privado Beta/); assert.doesNotMatch(second, /Conhecimento privado Alpha/);
});

test('HTTP real permite admin externo, nega outro workspace e operador, e readback confirma nomes e handoffMode', async t => {
  const f = fixture(t); await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const base = `/api/tenants/${f.alpha.tenant.id}`, config = base + '/channels/webchat/support-assistant';
  assert.equal((await f.request(base + '/support-assistant/catalog', { cookie: f.alpha.admin.cookie })).status, 200);
  assert.equal((await f.request(base + '/support-assistant/catalog', { cookie: f.beta.admin.cookie })).status, 404);
  assert.equal((await f.request(config, { method: 'PATCH', cookie: f.alpha.operator.cookie, body: f.alpha.input() })).status, 403);
  const saved = await f.request(config, { method: 'PATCH', cookie: f.alpha.admin.cookie, body: f.alpha.input({ handoffMode: 'continue' }) }); assert.equal(saved.status, 200, saved.data.error);
  const readback = await f.request(base + '/support-assistant/catalog', { cookie: f.alpha.admin.cookie }); assert.deepEqual(readback.data.channels[0].productNames, ['Alpha SaaS']); assert.equal(readback.data.channels[0].assistant.handoffMode, 'continue');
  const stale = await f.request(config, { method: 'PATCH', cookie: f.alpha.admin.cookie, body: f.alpha.input({ productNames: ['Troca indevida'] }) }); assert.equal(stale.status, 409);
});

test('UX de admin externo em PT/EN explica Hermes próprio, Canais, nomes, destinatário e dois modos sem traduzir dados', () => {
  const state = { workspaceId: 'saas-alpha', tenant: { id: 'tenant-a' }, boot: { session: { role: 'reseller', platformOwner: false }, canonicalPublicOrigin: publicOrigin } };
  try {
    for (const locale of ['pt-BR', 'en']) {
      setLocale(locale, { persist: false, notify: false }); const shell = renderSupportAssistant(state), markup = supportCatalogMarkup(uiCatalog(), { tenantId: 'tenant-a', publicOrigin });
      for (const word of locale === 'en' ? ['Support for your products', 'existing endpoint, model and credential', 'exact HTTPS origins', 'recipient for support notifications'] : ['Suporte dos seus produtos', 'endpoint, modelo e credencial existentes', 'origens HTTPS exatas', 'destinatário das notificações de suporte']) assert.ok(shell.includes(word), word);
      for (const word of locale === 'en' ? ['Product identification', 'Product names', 'Pause for human support', 'Continue with the support ticket', 'One name per line'] : ['Identificação dos produtos', 'Nomes dos produtos', 'Pausar para atendimento humano', 'Continuar com o ticket de suporte', 'Um nome por linha']) assert.ok(markup.includes(word), word);
      assert.match(markup, /Meu SaaS &amp; Portal/); assert.match(markup, />Alpha SaaS<\/textarea>/); assert.match(markup, /name="handoffMode"/); assert.match(markup, /value="pause" selected/);
      assert.doesNotMatch(markup, /name="token"|name="endpoint"|name="model"|<script/);
      for (const [pt, en] of [['Motivo do chamado', 'Support ticket reason'], ['Assistente continua atendendo', 'Assistant continues providing support'], ['Notificação por e-mail', 'Email notification'], ['Aceita pelo provedor', 'Accepted by the provider'], ['Confirmação indisponível', 'Confirmation unavailable']]) assert.equal(translated(pt), locale === 'en' ? en : pt);
    }
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
  for (const change of [{ role: 'operator', platformOwner: true }, { role: 'reseller', supportGrantId: 'g1' }, { role: 'reseller', kind: 'service' }, { role: 'operator', platformAdmin: true }]) assert.equal(renderSupportAssistant({ ...state, boot: { ...state.boot, session: change } }), '');
});

test('seams reais de app renderizam e ligam suporte externo só na lista e fora do suporte delegado', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const binding = source.split('\n').find(line => line.includes("if(state.view==='agents'") && line.includes('bindSupportAssistant('));
  const renderSeam = source.slice(source.indexOf('const supportAgentsView='), source.indexOf('channelVisitorTestUI=createChannelVisitorTestUI'));
  const state = { view: 'agents', tenant: { id: 'tenant-a' }, boot: { session: { role: 'reseller', platformOwner: false } } }, calls = [], root = { querySelector: () => ({}) };
  const sandbox = { state, agentsHub: { view: () => 'agents-list' }, renderSupportAssistant, bindSupportAssistant: value => calls.push(value), $: () => root, api() {}, toast() {}, refresh: async () => {}, render() {} };
  runInNewContext(renderSeam, sandbox); assert.match(sandbox.agentsHub.view({ params: {} }), /data-support-assistant-root/);
  assert.equal(sandbox.agentsHub.view({ params: { agentId: 'hermes' } }), 'agents-list'); assert.equal(sandbox.agentsHub.view({ params: { tab: 'usage' } }), 'agents-list');
  runInNewContext(binding, sandbox); assert.equal(calls.length, 1); assert.equal(calls[0].admin, true); assert.equal(calls[0].platformAdmin, false);
  state.boot.session.supportGrantId = 'delegated'; runInNewContext(binding, sandbox); assert.equal(calls.length, 1); assert.equal(sandbox.agentsHub.view({ params: {} }), 'agents-list');
});

test('formulário envia nomes e continue explícitos, confirma recibo, preserva CAS e não repete submit', async t => {
  const f = uiFixture(t, { source: uiCatalog() }); f.bind(); await settle(); const form = f.forms[0];
  form.elements.productNames.value = 'Alpha SaaS\nPortal & API'; form.elements.handoffMode.value = 'continue'; form.elements.mode.value = 'automatic'; await form.send(); await form.send();
  const writes = f.calls.filter(call => call.init.method === 'PATCH'); assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].init.body), { version: 3, agentId: 'hermes', enabled: true, autoReply: true, productNames: ['Alpha SaaS', 'Portal & API'], handoffMode: 'continue' });
  assert.equal(form.dataset.version, '4'); assert.equal(form.error.hidden, true); assert.deepEqual(f.messages, ['Suporte configurado.']);
});

test('GET preserva nomes brutos, modo do produto e ticket durante edição; CAS conflitante só descarta explicitamente', async t => {
  const waiting = deferred(); let reads = 0;
  const f = uiFixture(t, { source: uiCatalog(), api: (_path, init, fallback) => !init.method && ++reads === 2 ? waiting.promise : fallback() }); f.bind(); await settle();
  const form = f.forms[0]; form.elements.productNames.value = '  Meu produto\nPortal '; form.elements.handoffMode.value = 'continue';
  const loading = f.reload.click(); form.elements.mode.value = 'automatic'; waiting.resolve(uiCatalog()); await loading;
  const restored = f.forms[0]; assert.notEqual(restored, form); assert.equal(restored.elements.productNames.value, '  Meu produto\nPortal '); assert.equal(restored.elements.productSource.value, 'custom'); assert.equal(restored.elements.handoffMode.value, 'continue'); assert.equal(restored.elements.mode.value, 'automatic');
  const changed = uiCatalog(); changed.channels[0].assistant.version = 4; f.source(changed); await f.reload.click(); assert.equal(f.forms[0], restored); assert.equal(f.discard.hidden, false);
  await f.discard.click(); assert.equal(f.forms[0].dataset.version, '4'); assert.equal(f.forms[0].elements.productNames.value, 'Alpha SaaS'); assert.equal(f.forms[0].elements.handoffMode.value, 'pause'); assert.equal(f.calls.every(call => !call.init.method), true);
});

test('desligar preserva nomes salvos mesmo após apagar campos; inicial off não ativa nada', async t => {
  const f = uiFixture(t, { source: uiCatalog() }); f.bind(); await settle(); const form = f.forms[0];
  form.elements.productNames.value = ''; form.elements.agentId.value = ''; form.elements.mode.value = 'off'; form.change(); await form.send();
  const input = JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body); assert.deepEqual(input.productNames, ['Alpha SaaS']); assert.equal(input.agentId, 'hermes'); assert.equal(input.enabled, false); assert.equal(input.autoReply, false);
  const fresh = uiCatalog(); fresh.channels[0].productNames = []; fresh.channels[0].assistant = { version: 0, enabled: false, autoReply: false, agentId: null, jobs: [] };
  f.source(fresh); await f.reload.click(); await f.discard.click(); assert.equal(f.forms[0].submit.disabled, true); const writes = f.calls.filter(call => call.init.method === 'PATCH').length; await f.forms[0].send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, writes);
});

test('validação local recusa nomes repetidos, markup e excesso sem PATCH e preserva texto para correção', async t => {
  const f = uiFixture(t, { source: uiCatalog() }); f.bind(); await settle(); const form = f.forms[0];
  for (const text of ['Alpha\nalpha', '<img onerror="bad">', 'a'.repeat(81), Array.from({ length: 9 }, (_, index) => 'P' + index).join('\n')]) {
    form.elements.productNames.value = text; await form.send(); assert.equal(form.error.hidden, false); assert.equal(form.elements.productNames.value, text);
  }
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 0); assert.equal(form.error.focusCount, 4);
});

test('recibo com handoffMode divergente bloqueia repetição sem anunciar save nem perder rascunho', async t => {
  const f = uiFixture(t, { source: uiCatalog(), api: (_path, init, fallback) => init.method === 'PATCH' ? { ...fallback(), handoffMode: 'pause' } : fallback() }); f.bind(); await settle(); const form = f.forms[0];
  form.elements.handoffMode.value = 'continue'; await form.send(); assert.equal(form.dataset.version, '3'); assert.equal(form.submit.disabled, true); assert.equal(form.retry.hidden, false); assert.equal(form.elements.handoffMode.value, 'continue'); assert.equal(f.messages.length, 0); await form.send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
});

test('409 conserva campos e CAS; GET conflitante trava escrita até descarte explícito do rascunho', async t => {
  const f = uiFixture(t, { source: uiCatalog(), api: (_path, init, fallback) => { if (init.method === 'PATCH') throw Object.assign(Error('A configuração do suporte mudou.'), { status: 409 }); return fallback(); } }); f.bind(); await settle();
  const form = f.forms[0]; form.elements.productNames.value = 'Meu SaaS\nPortal'; form.elements.handoffMode.value = 'continue'; await form.send();
  assert.equal(form.elements.productNames.value, 'Meu SaaS\nPortal'); assert.equal(form.elements.productSource.value, 'custom'); assert.equal(form.elements.handoffMode.value, 'continue'); assert.equal(form.dataset.version, '3'); assert.equal(form.submit.disabled, false); assert.equal(f.discard.hidden, false);
  const fresh = uiCatalog(); fresh.channels[0].assistant.version = 4; f.source(fresh); await f.reload.click(); assert.equal(f.forms[0], form); assert.equal(form.submit.disabled, true);
  await form.send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
  await f.discard.click(); assert.equal(f.forms[0].dataset.version, '4'); assert.equal(f.forms[0].elements.handoffMode.value, 'pause'); assert.equal(f.forms[0].elements.productNames.value, 'Alpha SaaS'); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
});

test('alternar catálogo e nomes restaura escolhas sem enviar o registro inativo', async t => {
  const f = uiFixture(t, { source: uiCatalog() }); f.bind(); await settle(); const form = f.forms[0];
  form.elements.productSource.value = 'registry'; form.checkboxIds.find(item => item.value === 'elozi').checked = true; form.elements.productNames.value = 'Rascunho de nomes'; form.change();
  assert.equal(form.groups.custom.hidden, true); assert.equal(form.groups.registry.hidden, false); await form.send();
  const input = JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body); assert.deepEqual(input.productIds, ['elozi']); assert.equal(Object.hasOwn(input, 'productNames'), false);
  const current = f.forms[0]; current.elements.productSource.value = 'custom'; current.change(); assert.equal(current.elements.productNames.value, 'Rascunho de nomes'); assert.equal(current.groups.custom.hidden, false);
});

test('mudança de tenant ou suporte delegado descarta GET e PATCH tardios de admin externo', async t => {
  for (const phase of ['read', 'write']) await t.test(phase, async child => {
    const waiting = deferred(), f = uiFixture(child, { source: uiCatalog(), api: (_path, init, fallback) => phase === 'read' || init.method === 'PATCH' ? waiting.promise : fallback() }); f.bind();
    if (phase === 'read') { f.state.tenant.id = 'tenant-other'; waiting.resolve(uiCatalog()); await settle(); assert.equal(f.forms.length, 0); }
    else { await settle(); const form = f.forms[0], writing = form.send(); f.state.boot.session.supportGrantId = 'delegated'; waiting.resolve({ channelId: 'webchat', version: 4, agentId: 'hermes', enabled: true, autoReply: false, handoffMode: 'pause', products: ['Alpha SaaS'], origins: ['https://alpha.example.test'] }); await writing; assert.equal(form.dataset.version, '3'); assert.equal(f.messages.length, 0); }
  });
});
