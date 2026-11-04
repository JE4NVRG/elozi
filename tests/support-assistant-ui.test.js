import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import { supportIntegrationMarkup, renderSupportAssistant, supportCatalogMarkup, bindSupportAssistant } from '../public/support-assistant-ui.js';

const canonical = 'https://elozi.example.test';
const expected = { publicOrigin: canonical, tenantId: 'tenant-a', channelId: 'webchat-a' };
const integration = (more = {}) => ({ source: canonical + '/widget.js', tenantId: 'tenant-a', channelId: 'webchat-a', ...more });
const receipt = (more = {}) => ({ channelId: 'webchat-a', version: 4, agentId: 'hermes-a', enabled: true, autoReply: false, products: ['Elozi'], origins: ['https://produto.example.test'], ...more });
const catalog = (more = {}) => ({ agents: [{ id: 'hermes-a', name: 'Hermes de suporte', knowledgeCount: 2 }], products: [{ id: 'elozi', name: 'Elozi' }, { id: 'mepmail', name: 'MepMail' }],
  channels: [{ id: 'webchat-a', name: 'Chat de suporte', configured: true, origins: ['https://produto.example.test'], productIds: ['elozi'], integration: integration(), assistant: { version: 3, agentId: 'hermes-a', enabled: true, autoReply: false, jobs: [] } }], ...more });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attribute = (source, name) => decode(new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(source)?.[1] || '');

function fixture(t, { intercept, onRefresh } = {}) {
  const originalDocument = globalThis.document;
  const element = tag => { const listeners = new Map(); return { tag, attributes: {}, textContent: '', hidden: true, disabled: false, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, addEventListener(name, listener) { listeners.set(name, listener); }, click: () => listeners.get('click')?.() }; };
  globalThis.document = { createElement: element };
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const calls = [], messages = [], appended = [], forms = [], controllers = [], reload = element('button'), notice = element('p'), discard = element('button');
  let body = '', refreshes = 0, prevented = 0, member = true, source = catalog();
  const option = (html, name) => {
    const options = new RegExp('<select\\b[^>]*name="' + name + '"[^>]*>([\\s\\S]*?)<\\/select>').exec(html)?.[1] || '';
    const entries = [...options.matchAll(/<option\b([^>]*)>/g)]; return attribute((entries.find(entry => /\bselected\b/.test(entry[1])) || entries[0])?.[1] || '', 'value');
  };
  const content = { get innerHTML() { return body; }, set innerHTML(value) {
    body = value; for (const form of forms) form.isConnected = false; forms.splice(0);
    for (const match of value.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
      const listeners = new Map(), error = { textContent: '', hidden: true, focused: 0, focus() { this.focused++; } };
      const buttonMarkup = /<button\b([^>]*)>Salvar suporte<\/button>/.exec(match[2]);
      const submit = { textContent: 'Salvar suporte', disabled: /\bdisabled\b/.test(buttonMarkup?.[1] || '') };
      const products = [...match[2].matchAll(/<input\b([^>]*name="productIds"[^>]*)>/g)].filter(entry => /\bchecked\b/.test(entry[1])).map(entry => attribute(entry[1], 'value'));
      const checkboxIds = [...match[2].matchAll(/<input\b([^>]*name="productIds"[^>]*)>/g)].map(entry => attribute(entry[1], 'value'));
      const status = element('p'), retry = element('button');
      const form = { isConnected: true, dataset: { supportChannel: attribute(match[1], 'data-support-channel'), version: attribute(match[1], 'data-version') },
        elements: { agentId: { value: option(match[2], 'agentId') }, mode: { value: option(match[2], 'mode') } }, error, submit, products, status, retry,
        querySelector(selector) { return selector === '[data-support-error]' ? error : selector === '[data-support-status]' ? status : selector === '[data-support-catalog-retry]' ? retry : selector === 'button[type="submit"]' ? submit : null; },
        querySelectorAll(selector) { if (selector === 'input[name="productIds"]:checked') return this.products.map(value => ({ value })); assert.equal(selector, 'input[name="productIds"]'); const target = this; return checkboxIds.map(value => ({ value, get checked() { return target.products.includes(value); }, set checked(active) { target.products = target.products.filter(id => id !== value); if (active) target.products.push(value); } })); },
        addEventListener(name, listener) { listeners.set(name, listener); },
        change() { return listeners.get('change')?.(); },
        async send() { const listener = listeners.get('submit'); assert.ok(listener, 'o binding precisa instalar o evento real'); return listener({ preventDefault() { prevented++; } }); }
      };
      forms.push(form);
    }
  }, querySelectorAll(selector) { assert.equal(selector, 'form[data-support-channel]'); return forms; }, contains: form => forms.includes(form), replaceChildren() { body = ''; for (const form of forms) form.isConnected = false; forms.splice(0); appended.splice(0); }, append(value) { appended.push(value); } };
  const panel = { isConnected: true, dataset: { supportOrigin: canonical, supportTenant: 'tenant-a' }, querySelector: selector => selector === '[data-support-central-content]' ? content : selector === '[data-support-reload]' ? reload : selector === '[data-support-central-notice]' ? notice : selector === '[data-support-discard-drafts]' ? discard : null };
  const root = { contains: candidate => member && candidate === panel, querySelector: selector => selector === '[data-support-assistant-root]' ? panel : null };
  const fallback = (path, init) => { if (init.method !== 'PATCH') return structuredClone(source); const input = JSON.parse(init.body), channelId = decodeURIComponent(path.split('/').at(-2)), origins = source.channels.find(channel => channel.id === channelId)?.origins || []; return receipt({ channelId, ...input, version: input.version + 1, products: input.productIds.map(id => source.products.find(product => product.id === id)?.name).sort(), origins }); };
  const api = async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, () => fallback(path, init)) : fallback(path, init); };
  const refresh = async () => { refreshes++; await onRefresh?.(); };
  const bind = (more = {}) => { const controller = bindSupportAssistant({ root, tenantId: 'tenant-a', api, toast: message => messages.push(message), refresh, platformAdmin: true, ...more }); controllers.push(controller); return controller; };
  return { bind, root, panel, content, calls, messages, appended, forms, api, refresh, controllers, reload, notice, discard,
    detach: () => { panel.isConnected = false; }, remove: () => { member = false; }, source: value => { source = value; }, refreshes: () => refreshes, prevented: () => prevented };
}

test('snippet é módulo executável e monta o widget real com dataset tenantId/channelId uma única vez', () => {
  const snippet = supportIntegrationMarkup(integration(), expected);
  assert.match(snippet, /^<script type="module"/); assert.match(snippet, /data-tenant-id="tenant-a"/); assert.match(snippet, /data-channel-id="webchat-a"/);
  assert.doesNotMatch(snippet, /data-elozi-tenant|data-elozi-channel|Bearer|token/);
  const script = { src: attribute(snippet, 'src'), dataset: {} };
  for (const match of snippet.matchAll(/data-([a-z-]+)="([^"]*)"/g)) script.dataset[match[1].replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = decode(match[2]);
  const source = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8'), beginning = source.indexOf("if (typeof document !== 'undefined')");
  assert.ok(beginning >= 0); const bootstrap = source.slice(beginning).replaceAll('import.meta.url', 'widgetModuleURL'), calls = [];
  const sandbox = { URL, widgetModuleURL: canonical + '/widget.js', mounted: new Map(), createWebchatWidget: options => { calls.push({ ...options }); return {}; },
    document: { baseURI: 'https://produto.example.test/', querySelectorAll(selector) { assert.equal(selector, 'script[data-tenant-id][data-channel-id]'); return script.dataset.tenantId && script.dataset.channelId ? [script] : []; } } };
  runInNewContext(bootstrap, sandbox); runInNewContext(bootstrap, sandbox);
  assert.deepEqual(calls, [{ apiOrigin: canonical, tenantId: 'tenant-a', channelId: 'webchat-a', nonce: '' }]); assert.equal(script.dataset.eloziMounted, 'true');
});

test('snippet exige origem canônica HTTPS e identidade exata, sem refletir credenciais ou URL forjada', () => {
  assert.equal(supportIntegrationMarkup(integration()), '');
  for (const source of ['http://elozi.example.test/widget.js', 'javascript:alert(1)', canonical + '/other.js', canonical + '/widget.js?secret=hidden', canonical + '/widget.js#fragment', 'https://user:password@elozi.example.test/widget.js', 'https://evil.example.test/widget.js']) assert.equal(supportIntegrationMarkup(integration({ source }), expected), '', source);
  for (const more of [{ tenantId: 'another-tenant' }, { channelId: 'another-channel' }, { tenantId: '<injection>' }, { channelId: 'x" onload="bad' }]) assert.equal(supportIntegrationMarkup(integration(more), expected), '');
  assert.equal(supportIntegrationMarkup(integration(), { ...expected, publicOrigin: 'https://revenda.example.test' }), '');
});

test('shell mantém labels e live region, escapa origem e exige proprietário booleano fora do suporte delegado', () => {
  for (const platformOwner of [undefined, false, 'true', 1]) assert.equal(renderSupportAssistant({ boot: { session: { platformOwner } } }), '');
  assert.equal(renderSupportAssistant({ boot: { session: { platformOwner: true } }, supportGrantId: 'delegated' }), '');
  const html = renderSupportAssistant({ boot: { canonicalPublicOrigin: 'https://elozi.example.test/" onload="bad', publicOrigin: 'https://revenda.example.test', session: { platformOwner: true } } });
  assert.match(html, /aria-label="Central de suporte/); assert.match(html, /aria-live="polite"/); assert.match(html, /Carregando/);
  assert.match(html, /data-support-origin="https:\/\/elozi\.example\.test\/&quot; onload=&quot;bad"/); assert.doesNotMatch(html, / onload="bad/); assert.doesNotMatch(html, /revenda\.example/);
});

test('catálogo escapa nomes, origens e campos privados e limita contagem ao número seguro', () => {
  const value = catalog(); value.channels[0].name = '<img onerror="bad()">'; value.channels[0].origins = ['https://site.example.test/<script>'];
  value.agents = [{ id: 'a" data-unsafe="true', name: '<Agente>', knowledgeCount: '<img onerror="bad()">' }]; value.products = [{ id: 'p" onclick="bad', name: '<Produto>' }];
  value.channels[0].assistant.jobs = [{ state: '<script>', updatedAt: '2026-10-04T12:00:00Z', draft: 'do-not-render', token: 'do-not-render' }];
  const html = supportCatalogMarkup(value, expected);
  for (const escaped of ['&lt;img onerror=&quot;bad()&quot;&gt;', '&lt;Agente&gt;', '&lt;Produto&gt;', '0 fonte(s)', 'Estado indisponível']) assert.ok(html.includes(escaped), escaped);
  assert.doesNotMatch(html, /<img|<script|do-not-render|onclick="bad|data-unsafe="true/);
  for (const knowledgeCount of [-1, 17, Infinity, '2', null]) { value.agents[0].knowledgeCount = knowledgeCount; assert.match(supportCatalogMarkup(value, expected), /0 fonte\(s\)/); }
  value.agents[0].knowledgeCount = 16; assert.match(supportCatalogMarkup(value, expected), /16 fonte\(s\)/);
});

test('catálogo oferece snippet apenas da conexão configurada com origem tenant e canal atuais', () => {
  const value = catalog(); const html = supportCatalogMarkup(value, expected);
  assert.match(html, /Código do chat de suporte/); assert.match(html, /&lt;script type=&quot;module&quot;/); assert.match(html, /data-tenant-id=&quot;tenant-a&quot;/);
  for (const changes of [{ configured: false }, { integration: integration({ tenantId: 'other' }) }, { integration: integration({ channelId: 'other' }) }, { integration: integration({ source: 'https://evil.example.test/widget.js' }) }]) {
    const altered = { ...value, channels: [{ ...value.channels[0], ...changes }] }; assert.doesNotMatch(supportCatalogMarkup(altered, expected), /Código do chat de suporte/);
  }
  assert.doesNotMatch(supportCatalogMarkup(value), /Código do chat de suporte/);
  assert.match(supportCatalogMarkup({ channels: [] }), /href="#channels"/);
});

test('modos e atividade recente têm rótulos legíveis e ações de formulário acessíveis', () => {
  const value = catalog(); value.channels[0].assistant.jobs = Array.from({ length: 12 }, (_unused, index) => ({ state: index % 2 ? 'handoff' : 'completed', updatedAt: '2026-10-04T12:00:00Z' }));
  for (const [enabled, autoReply, label] of [[false, false, 'Assistente desligado'], [true, false, 'Rascunhos para revisão'], [true, true, 'Respostas automáticas']]) {
    value.channels[0].assistant = { ...value.channels[0].assistant, enabled, autoReply };
    const html = supportCatalogMarkup(value, expected); assert.ok(html.includes(label)); assert.match(html, /<label>Agente de suporte<select/); assert.match(html, /<fieldset><legend>Produtos atendidos/);
    assert.match(html, /<label>Como atender<select/); assert.match(html, /data-support-error role="alert" tabindex="-1" hidden/);
    const jobs = /<ul class="support-central-jobs">([\s\S]*?)<\/ul>/.exec(html)[1]; assert.equal([...jobs.matchAll(/<li>/g)].length, 10);
  }
  value.channels[0].configured = false; assert.match(supportCatalogMarkup(value, expected), /type="submit" disabled/);
});

test('binding sem privilégio estrito ou alvo válido não consulta catálogo nem instala ação', async t => {
  const f = fixture(t);
  for (const platformAdmin of [undefined, false, 'true', 1]) f.bind({ platformAdmin });
  f.bind({ root: null }); f.bind({ tenantId: '' }); f.bind({ root: { querySelector: () => null } });
  await settle(); assert.equal(f.calls.length, 0); assert.equal(f.forms.length, 0);
});

test('carga usa empresa correta e origem canônica do shell, renderizando controles sem chamar provedor', async t => {
  const f = fixture(t); f.bind(); await settle();
  assert.deepEqual(f.calls.map(call => call.path), ['/api/tenants/tenant-a/support-assistant/catalog']); assert.equal(f.calls[0].init.method, undefined);
  assert.match(f.content.innerHTML, /Chat de suporte/); assert.match(f.content.innerHTML, /Código do chat de suporte/);
  assert.equal(f.forms.length, 1); assert.equal(f.forms[0].elements.agentId.value, 'hermes-a'); assert.equal(f.forms[0].elements.mode.value, 'draft'); assert.deepEqual(f.forms[0].products, ['elozi']);
  assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
});

test('origem divergente no shell retém configuração e oculta código de integração', async t => {
  const f = fixture(t); f.panel.dataset.supportOrigin = 'https://revenda.example.test'; f.bind(); await settle();
  assert.match(f.content.innerHTML, /Salvar suporte/); assert.doesNotMatch(f.content.innerHTML, /Código do chat de suporte/);
});

test('falha de carga exibe texto seguro em alerta local sem inserir HTML da exceção', async t => {
  const f = fixture(t, { intercept: async () => { throw new Error('<img onerror="bad()">'); } }); f.bind(); await settle();
  assert.equal(f.content.innerHTML, ''); assert.equal(f.appended.length, 2); assert.equal(f.appended[0].tag, 'p'); assert.equal(f.appended[0].attributes.role, 'alert');
  assert.equal(f.appended[0].textContent, '<img onerror="bad()">'); assert.equal(f.forms.length, 0);
});

test('resposta ou erro atrasados não atualizam painel removido ou desconectado', async t => {
  for (const [action, failure] of [['detach', false], ['remove', false], ['detach', true], ['remove', true]]) {
    await t.test(action + (failure ? ' erro' : ' resposta'), async child => {
      const d = deferred(), f = fixture(child, { intercept: () => d.promise }); f.bind(); f[action]();
      if (failure) d.reject(new Error('Resultado antigo')); else d.resolve(catalog()); await settle();
      assert.equal(f.content.innerHTML, ''); assert.equal(f.appended.length, 0); assert.equal(f.forms.length, 0);
    });
  }
});

test('salvar publica estados explícitos revisão e produtos sem enviar segredo ou identidade humana', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0]; form.elements.mode.value = 'automatic'; form.products = ['elozi', 'mepmail'];
  await form.send(); const write = f.calls.find(call => call.init.method === 'PATCH');
  assert.equal(write.path, '/api/tenants/tenant-a/channels/webchat-a/support-assistant');
  assert.deepEqual(JSON.parse(write.init.body), { version: 3, agentId: 'hermes-a', enabled: true, autoReply: true, productIds: ['elozi', 'mepmail'] });
  assert.deepEqual(f.messages, ['Suporte configurado.']); assert.equal(f.refreshes(), 1); assert.equal(form.dataset.busy, undefined); assert.equal(form.submit.disabled, false); assert.equal(form.submit.textContent, 'Salvar suporte');
  assert.equal(form.dataset.version, '4');
  assert.equal(f.calls.some(call => /chat\/completions|messages|drafts/.test(call.path)), false);
});

test('desativar com configuração selecionada envia os dois estados false', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0]; form.elements.mode.value = 'off'; await form.send();
  const input = JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body); assert.equal(input.enabled, false); assert.equal(input.autoReply, false); assert.equal(input.agentId, 'hermes-a');
});

test('agente anterior removido continua selecionado para permitir desligar preservando produtos da conexão', async t => {
  const f = fixture(t), value = catalog({ agents: [] }); value.channels[0].assistant.agentId = 'deleted-hermes';
  f.source(value); f.bind(); await settle();
  const form = f.forms[0]; assert.match(f.content.innerHTML, /Agente anterior indisponível · desative ou escolha outro/); assert.equal(form.elements.agentId.value, 'deleted-hermes'); assert.deepEqual(form.products, ['elozi']);
  form.elements.mode.value = 'off'; await form.send();
  const write = f.calls.find(call => call.init.method === 'PATCH');
  assert.deepEqual(JSON.parse(write.init.body), { version: 3, agentId: 'deleted-hermes', enabled: false, autoReply: false, productIds: ['elozi'] });
  assert.deepEqual(f.messages, ['Suporte configurado.']); assert.equal(f.refreshes(), 1); assert.equal(form.error.hidden, true); assert.equal(form.dataset.version, '4');
});

test('segunda edição usa revisão confirmada do recibo e não reutiliza CAS antigo', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0]; await form.send();
  assert.equal(form.dataset.version, '4'); form.elements.mode.value = 'off'; await form.send();
  const writes = f.calls.filter(call => call.init.method === 'PATCH').map(call => JSON.parse(call.init.body));
  assert.deepEqual(writes.map(input => input.version), [3, 4]); assert.equal(writes[1].enabled, false); assert.equal(writes[1].autoReply, false); assert.equal(form.dataset.version, '5'); assert.equal(f.refreshes(), 2);
});

test('PATCH vazio ou recibo divergente não anuncia sucesso nem avança revisão local', async t => {
  const valid = receipt();
  const cases = [['corpo vazio', {}], ['corpo ausente', undefined], ['outro canal', { ...valid, channelId: 'webchat-other' }], ['revisão antiga', { ...valid, version: 3 }], ['revisão salta', { ...valid, version: 5 }], ['outro agente', { ...valid, agentId: 'other-hermes' }], ['estado errado', { ...valid, enabled: false }], ['automação errada', { ...valid, autoReply: true }], ['produto ausente', { ...valid, products: undefined }], ['produto errado', { ...valid, products: ['MepMail'] }], ['origem errada', { ...valid, origins: ['https://other.example.test'] }]];
  for (const [name, result] of cases) await t.test(name, async child => {
    const f = fixture(child, { intercept: (_path, init, fallback) => init.method === 'PATCH' ? result : fallback() }); f.bind(); await settle(); const form = f.forms[0]; await form.send();
    assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0); assert.equal(form.dataset.version, '3'); assert.equal(form.error.hidden, false); assert.equal(form.error.focused, 1);
    assert.match(form.error.textContent, /Não foi possível confirmar a configuração/); assert.equal(form.elements.agentId.value, 'hermes-a'); assert.deepEqual(form.products, ['elozi']); assert.equal(form.submit.disabled, true); assert.equal(form.retry.hidden, false);
    assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
  });
});

test('campos indispensáveis vazios impedem PATCH e anunciam erro no próprio formulário com foco', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0];
  form.elements.agentId.value = ''; await form.send(); assert.equal(form.error.hidden, false); assert.match(form.error.textContent, /Escolha o agente/); assert.equal(form.error.focused, 1);
  form.elements.agentId.value = 'hermes-a'; form.products = []; await form.send(); assert.equal(form.error.focused, 2); assert.equal(f.calls.length, 1); assert.equal(form.submit.disabled, false);
});

test('duplo submit enquanto salva não duplica PATCH nem confirma antes da resposta', async t => {
  const d = deferred(), f = fixture(t, { intercept: (path, init, fallback) => init.method === 'PATCH' ? d.promise : fallback() }); f.bind(); await settle();
  const form = f.forms[0], first = form.send(); assert.equal(form.submit.disabled, true); assert.equal(form.submit.textContent, 'Salvando…'); await form.send();
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1); assert.equal(f.messages.length, 0);
  d.resolve(receipt()); await first;
  assert.equal(f.messages.length, 1); assert.equal(f.refreshes(), 1); assert.equal(f.prevented(), 2);
});

test('erro ao salvar mantém escolhas e usa alerta local sem anunciar configuração aceita', async t => {
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'PATCH') throw Object.assign(new Error('Revisão mudou. Atualize a configuração.'), { status: 409 }); return fallback(); } });
  f.bind(); await settle(); const form = f.forms[0]; form.elements.mode.value = 'automatic'; form.products = ['mepmail']; await form.send();
  assert.match(form.error.textContent, /Revisão mudou/); assert.equal(form.error.hidden, false); assert.equal(form.error.focused, 1); assert.equal(form.elements.mode.value, 'automatic'); assert.deepEqual(form.products, ['mepmail']);
  assert.equal(form.submit.disabled, false); assert.equal(form.submit.textContent, 'Salvar suporte'); assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
});

test('sucesso ou falha de PATCH atrasado não confirma nem atualiza painel abandonado', async t => {
  for (const failure of [false, true]) await t.test(failure ? 'erro' : 'sucesso', async child => {
    const d = deferred(), f = fixture(child, { intercept: (path, init, fallback) => init.method === 'PATCH' ? d.promise : fallback() }); f.bind(); await settle();
    const form = f.forms[0], waiting = form.send(); f.detach();
    if (failure) d.reject(new Error('Falha antiga')); else d.resolve(receipt()); await waiting;
    assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0); assert.equal(form.error.hidden, true); assert.equal(form.error.focused, 0);
  });
});

test('hook real atualiza estado e redesenha formulário após salvar para usar revisão fresca na próxima edição', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), binding = source.split('\n').find(line => line.includes("if(state.view==='agents'") && line.includes('bindSupportAssistant('));
  assert.ok(binding, 'a interface principal precisa ligar o módulo de suporte');
  const effects = [], root = {}; let options;
  runInNewContext(binding, { ...i18n, state: { view: 'agents', boot: { session: { platformOwner: true } }, supportGrantId: null, tenant: { id: 'tenant-a' } },
    $: () => root, api: () => {}, toast: () => {}, bindSupportAssistant: value => { options = value; },
    refresh: async () => { effects.push('state-updated'); }, render: () => { effects.push('form-rendered'); } });
  assert.equal(options.root, root); assert.equal(options.tenantId, 'tenant-a'); assert.equal(options.platformAdmin, true);
  await options.refresh(); assert.deepEqual(effects, ['state-updated', 'form-rendered']);
});

test('recepção configurada com assistente off sem atividade mantém integração como etapa a validar', () => {
  const value = catalog(); Object.assign(value.channels[0], { name: 'FullCommerce360', origins: ['https://fullcommerce360.com'], productIds: [], assistant: { version: 0, enabled: false, autoReply: false, agentId: null, jobs: [] } });
  const html = supportCatalogMarkup(value, expected);
  for (const copy of ['Recepção habilitada no painel', 'Assistente desligado', 'Nenhum agente escolhido', 'Nenhum produto escolhido', 'Nenhuma atividade do assistente registrada', 'este painel não detecta a instalação', 'Instale ou confira o chat no produto']) assert.ok(html.includes(copy), copy);
  assert.match(html, /https:\/\/fullcommerce360\.com/); assert.match(html, /type="submit" disabled/);
  assert.doesNotMatch(html, /name="agentId" required|integração concluída|chat instalado|Respondido/);
});

test('registros explicam handoff e resposta registrada sem afirmar entrega; data inválida tem fallback', () => {
  const value = catalog(); value.channels[0].assistant.jobs = [{ state: 'handoff', reason: 'visitor_requested_human', updatedAt: 'invalid' }, { state: 'completed', updatedAt: '2026-10-08T12:00:00Z' }, { state: 'handoff', reason: '<private-token>', updatedAt: '2026-10-08T12:00:00Z' }];
  const html = supportCatalogMarkup(value, expected);
  for (const copy of ['O visitante pediu uma pessoa.', 'Resposta registrada', 'Horário indisponível', 'Motivo não detalhado.', 'não comprovam instalação no site nem entrega ao visitante']) assert.ok(html.includes(copy), copy);
  assert.match(html, /href="#inbox"/); assert.match(html, /href="#agents\/hermes-a\/knowledge"/);
  assert.doesNotMatch(html, /private-token|Invalid Date/);
});

test('central e catálogo têm estados, fontes, próximas ações e limites em inglês preservando nomes e origens', () => {
  i18n.setLocale('en', { persist: false, notify: false });
  try {
    const shell = renderSupportAssistant({ tenant: { id: 'tenant-a' }, boot: { canonicalPublicOrigin: canonical, session: { platformOwner: true } } }), value = catalog();
    value.channels[0].assistant.jobs = [{ state: 'handoff', reason: 'knowledge_unavailable', updatedAt: 'invalid' }];
    const html = supportCatalogMarkup(value, expected);
    for (const copy of ['Support for our products', 'Refresh catalog', 'Enabled reception does not prove']) assert.ok(shell.includes(copy), copy);
    for (const copy of ['Reception enabled in the panel', 'Drafts for review', 'Next action', 'Authorized origin', 'Agent sources', '2 registered grant(s)', 'Review authorized publications', 'Not enough published knowledge.', 'Time unavailable', 'Recorded activity']) assert.ok(html.includes(copy), copy);
    assert.match(html, /Chat de suporte|Hermes de suporte/); assert.match(html, /https:\/\/produto\.example\.test/);
    assert.doesNotMatch(html, /Recepção|Próxima ação|Fontes do agente|concessão|Atividade registrada/);
  } finally { i18n.setLocale('pt-BR', { persist: false, notify: false }); }
});

test('off preserva configuração anterior quando escolhas do formulário foram apagadas', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0];
  form.elements.agentId.value = ''; form.products = []; form.elements.mode.value = 'off'; form.change();
  assert.equal(form.elements.agentId.required, false); await form.send();
  const write = f.calls.find(call => call.init.method === 'PATCH');
  assert.deepEqual(JSON.parse(write.init.body), { version: 3, agentId: 'hermes-a', enabled: false, autoReply: false, productIds: ['elozi'] });
  assert.equal(form.error.hidden, true);
});

test('off inicial não inventa agente ou produtos; modo draft habilita a seleção obrigatória', async t => {
  const value = catalog(); Object.assign(value.channels[0], { productIds: [], assistant: { version: 0, enabled: false, autoReply: false, agentId: null, jobs: [] } });
  const f = fixture(t); f.source(value); f.bind(); await settle(); const form = f.forms[0];
  assert.equal(form.submit.disabled, true); assert.equal(form.elements.agentId.required, false); await form.send();
  assert.equal(f.calls.length, 1); assert.match(form.error.textContent, /já está desligado/);
  form.elements.mode.value = 'draft'; form.change(); assert.equal(form.submit.disabled, false); assert.equal(form.elements.agentId.required, true);
  form.elements.agentId.value = 'hermes-a'; form.products = ['elozi']; await form.send();
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
});

test('PATCH confirmado com refresh falho conserva sucesso e revisão, bloqueia repetição e recupera só por GET', async t => {
  const f = fixture(t, { onRefresh: async () => { throw new Error('Refresh failed after save'); } }); f.bind(); await settle(); const form = f.forms[0];
  await form.send();
  assert.deepEqual(f.messages, ['Suporte configurado.']); assert.equal(form.dataset.version, '4'); assert.equal(form.error.hidden, true);
  assert.match(form.status.textContent, /Configuração salva.*atualização da tela falhou/); assert.equal(form.status.hidden, false);
  assert.equal(form.submit.disabled, true); assert.equal(form.retry.hidden, false); await form.send();
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
  const value = catalog(); value.channels[0].assistant.version = 4; f.source(value); await form.retry.click();
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1); assert.equal(f.calls.filter(call => !call.init.method).length, 2);
  assert.equal(f.forms[0].dataset.version, '4'); assert.equal(f.forms[0].submit.disabled, false);
  await form.send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1, 'formulário antigo não escreve após reload');
});

test('mesmo formulário confirmado não repete PATCH; nova escolha mantém CAS confirmado', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0];
  await form.send(); await form.send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
  form.elements.mode.value = 'automatic'; await form.send();
  const writes = f.calls.filter(call => call.init.method === 'PATCH'); assert.equal(writes.length, 2); assert.equal(JSON.parse(writes[1].init.body).version, 4);
});

test('retry do catálogo depois de erro é somente leitura e não duplica consulta enquanto pendente', async t => {
  let failed = false; const waiting = deferred(), f = fixture(t, { intercept: (path, init, fallback) => { if (!failed) { failed = true; throw new Error('Catalog unavailable'); } return waiting.promise; } });
  f.bind(); await settle(); const retry = f.appended[1]; assert.equal(retry.tag, 'button');
  const loading = retry.click(); await f.reload.click(); assert.equal(f.calls.length, 2); assert.equal(f.calls.every(call => !call.init.method), true);
  waiting.resolve(catalog()); await loading; assert.equal(f.forms.length, 1); assert.equal(f.notice.hidden, true);
});

test('rebind no mesmo painel ignora catálogo tardio do binding anterior', async t => {
  const waiting = deferred(); let first = true; const f = fixture(t, { intercept: (path, init, fallback) => { if (first) { first = false; return waiting.promise; } return fallback(); } });
  f.bind(); f.bind(); await settle(); const previous = f.content.innerHTML;
  const old = catalog(); old.channels[0].name = 'Catálogo antigo'; waiting.resolve(old); await settle();
  assert.equal(f.content.innerHTML, previous); assert.doesNotMatch(f.content.innerHTML, /Catálogo antigo/);
});

test('GET conserva agente, produtos e modo não salvos e inclui edição feita enquanto aguardava', async t => {
  const waiting = deferred(); let reads = 0; const f = fixture(t, { intercept: (path, init, fallback) => ++reads === 2 ? waiting.promise : fallback() });
  f.bind(); await settle(); const form = f.forms[0]; form.elements.agentId.value = ''; form.products = ['mepmail'];
  const loading = f.reload.click(); form.elements.mode.value = 'automatic';
  waiting.resolve(catalog()); await loading;
  const restored = f.forms[0]; assert.notEqual(restored, form); assert.equal(restored.elements.agentId.value, ''); assert.equal(restored.elements.mode.value, 'automatic'); assert.deepEqual(restored.products, ['mepmail']);
  assert.equal(restored.dataset.version, '3'); assert.equal(f.calls.every(call => !call.init.method), true);
});

test('GET com revisão diferente conserva rascunho e só descarta pelo botão explícito', async t => {
  const f = fixture(t); f.bind(); await settle(); const form = f.forms[0]; form.elements.mode.value = 'automatic'; form.products = ['mepmail'];
  const value = catalog(); value.channels[0].assistant.version = 4; f.source(value); await f.reload.click();
  assert.equal(f.forms[0], form); assert.equal(form.elements.mode.value, 'automatic'); assert.deepEqual(form.products, ['mepmail']);
  assert.equal(f.discard.hidden, false); assert.match(f.notice.textContent, /Suas escolhas foram preservadas/);
  await f.discard.click(); assert.notEqual(f.forms[0], form); assert.equal(f.forms[0].dataset.version, '4'); assert.equal(f.forms[0].elements.mode.value, 'draft');
  assert.deepEqual(f.forms[0].products, ['elozi']); assert.equal(f.calls.every(call => !call.init.method), true);
});

test('salvar um card preserva o rascunho do outro com refresh somente do catálogo', async t => {
  const value = catalog(); value.channels.push({ ...structuredClone(value.channels[0]), id: 'webchat-b', name: 'Outro produto', integration: null });
  const f = fixture(t, { intercept: (path, init, fallback) => { const result = fallback(); if (init.method === 'PATCH') { value.channels[0].assistant.version = 4; f.source(value); } return result; } });
  f.source(value); f.bind(); await settle(); const [first, second] = f.forms;
  second.elements.mode.value = 'automatic'; second.products = ['mepmail']; await first.send();
  assert.equal(f.refreshes(), 0, 'não redesenha todo o app por cima do outro rascunho');
  assert.equal(f.forms[0].dataset.version, '4'); assert.equal(f.forms[1].dataset.version, '3'); assert.equal(f.forms[1].elements.mode.value, 'automatic'); assert.deepEqual(f.forms[1].products, ['mepmail']);
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1); assert.equal(f.calls.filter(call => !call.init.method).length, 2);
});

test('consulta explícita não substitui formulário enquanto o PATCH está pendente', async t => {
  const waiting = deferred(), f = fixture(t, { intercept: (_path, init, fallback) => init.method === 'PATCH' ? waiting.promise : fallback() });
  f.bind(); await settle(); const form = f.forms[0], saving = form.send();
  assert.equal(f.reload.disabled, true); await f.reload.click(); assert.equal(f.calls.length, 2); assert.equal(f.forms[0], form);
  waiting.resolve(receipt()); await saving;
  assert.deepEqual(f.messages, ['Suporte configurado.']); assert.equal(form.dataset.version, '4'); assert.equal(f.reload.disabled, false);
});

test('consulta pendente protege o formulário de escrita até reconciliar o catálogo', async t => {
  const waiting = deferred(); let reads = 0;
  const f = fixture(t, { intercept: (_path, init, fallback) => !init.method && ++reads === 2 ? waiting.promise : fallback() });
  f.bind(); await settle(); const form = f.forms[0], reading = f.reload.click();
  assert.equal(form.submit.disabled, true); await form.send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 0);
  waiting.resolve(catalog()); await reading; assert.equal(f.forms[0].submit.disabled, false);
  await f.forms[0].send(); assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
});

test('rebind no mesmo painel ignora confirmação tardia da escrita anterior', async t => {
  const waiting = deferred(), f = fixture(t, { intercept: (_path, init, fallback) => init.method === 'PATCH' ? waiting.promise : fallback() });
  f.bind(); await settle(); const form = f.forms[0], saving = form.send();
  f.bind(); await settle(); assert.notEqual(f.forms[0], form);
  waiting.resolve(receipt()); await saving;
  assert.equal(f.forms[0].dataset.version, '3'); assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
});

function scopedFixture(t, options) {
  const f = fixture(t, options), state = { workspaceId: 'workspace-a', view: 'overview', tenant: { id: 'tenant-a' }, boot: { canonicalPublicOrigin: canonical, session: { platformOwner: true, role: 'reseller', userId: 'user-a' } } };
  const shell = renderSupportAssistant(state); f.panel.dataset.supportContext = attribute(/<section\b([^>]*)>/.exec(shell)[1], 'data-support-context');
  return { f, state };
}

for (const [boundary, change] of [
  ['empresa', state => { state.tenant.id = 'tenant-b'; }],
  ['workspace', state => { state.workspaceId = 'workspace-b'; }],
  ['usuário', state => { state.boot.session.userId = 'user-b'; }],
  ['ownership', state => { state.boot.session.platformOwner = false; }],
  ['suporte delegado', state => { state.supportGrantId = 'delegated'; }],
  ['origem', state => { state.boot.canonicalPublicOrigin = 'https://other.example.test'; }],
  ['rota', state => { state.view = 'channels'; }]
]) test(`catálogo, submit e PATCH tardio respeitam mudança de ${boundary}`, async t => {
  await t.test('catálogo tardio', async child => {
    const waiting = deferred(), { f, state } = scopedFixture(child, { intercept: () => waiting.promise });
    f.bind(); change(state); waiting.resolve(catalog()); await settle(); assert.equal(f.forms.length, 0); assert.equal(f.messages.length, 0);
  });
  await t.test('submit e consulta após mudança', async child => {
    const { f, state } = scopedFixture(child); f.bind(); await settle(); const form = f.forms[0]; change(state);
    await form.send(); await f.reload.click(); assert.equal(f.calls.length, 1); assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
  });
  for (const failed of [false, true]) await t.test(failed ? 'erro de PATCH tardio' : 'sucesso de PATCH tardio', async child => {
    const waiting = deferred(), { f, state } = scopedFixture(child, { intercept: (_path, init, fallback) => init.method === 'PATCH' ? waiting.promise : fallback() });
    f.bind(); await settle(); const form = f.forms[0], saving = form.send(); change(state);
    if (failed) waiting.reject(new Error('Resposta tardia')); else waiting.resolve(receipt()); await saving;
    assert.equal(form.dataset.version, '3'); assert.equal(form.error.hidden, true); assert.equal(f.messages.length, 0); assert.equal(f.refreshes(), 0);
  });
});
