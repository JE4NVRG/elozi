import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import '../public/locales-home.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';
import { parseHash } from '../public/router.js';
import { screenFrame } from '../public/settings-ui.js';
import { deriveBrandTokens, applyBrandTokens } from '../public/brand-theme.js';
import { syncThemePrefs } from '../public/theme-prefs.js';
import { inboxIdentity } from '../public/consolidated-inbox-ui.js';
import { createChannelConnectorsUI } from '../public/channel-connectors-ui.js';
import { createChannelsUI } from '../public/channels-ui.js';
import { createTelegramAccountUI } from '../public/telegram-account-ui.js';
import { createServicePrincipalsUI } from '../public/service-principals-ui.js';
import { createModalRouteLifecycle, modalRouteContext, modalScopeContext } from '../public/modal-route-lifecycle.js';
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';
import { excerpt, publicSource } from './helpers/app-source.js';

const source = publicSource('app.js');
const initialization = source.match(/const modalRouteLifecycle = createModalRouteLifecycle\([\s\S]*?\}\);/)?.[0];
assert.ok(initialization, 'a factory está ligada ao contexto real da aplicação');
const roleLabel = source.split('\n').find(line => line.startsWith('const roleLabel = '));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
test.afterEach(() => i18n.setLocale('pt-BR', { persist: false, notify: false }));

// Run the served openModal, navigation/hash handlers and render over a parsed DOM. API calls and
// workspace refreshes are synthetic; no channel, account, message or production data is changed.
function fixture({ hash = '#channels', discard = false, queuedClose = false } = {}) {
  const document = createDocument('<div id="app"></div><dialog id="modal"></dialog>');
  const createElement = document.createElement;
  document.createElement = tag => { const element = createElement(tag); element.scrollTo = () => {}; return element; };
  const modal = document.querySelector('#modal'), events = [], prompts = [], replacements = [], calls = [], closeEvents = [];
  const modalListeners = new Map();
  modal.addEventListener = (name, listener, capture = false) => { const list = modalListeners.get(name) || []; list.push({ listener, capture }); modalListeners.set(name, list); };
  modal.dispatchEvent = event => { event.target ||= modal; const listeners = modalListeners.get(event.type) || [];
    for (const capture of [true, false]) for (const entry of listeners) if (entry.capture === capture) entry.listener.call(modal, event);
    return !event.defaultPrevented; };
  const channel = { id: 'widget-a', kind: 'webchat', name: 'Widget QA' };
  const state = { view: 'channels', workspaceId: 'workspace-a', supportGrantId: null, conversation: null, sendIntent: null, busy: false,
    tenant: { id: 'company-a', name: 'Empresa QA', resellerId: 'workspace-a', conversations: [], channels: [channel] },
    boot: { publicOrigin: 'https://elozi.example', csrfToken: 'synthetic-csrf', tenants: [{ id: 'company-a' }],
      workspaces: [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Conta B' }],
      reseller: { id: 'workspace-a', name: 'Conta A', accountKind: 'business', brand: { name: 'QA', initials: 'QA', accent: '#58c8aa', logo: '' } },
      session: { userId: 'person-a', resellerId: 'workspace-a', name: 'Pessoa QA', role: 'reseller', permissions: null, scopeRules: null } } };
  const location = { hash }, handlers = {};
  modal.showModal = () => {
    // Browser initial values omitted by the small DOM parser.
    for (const field of modal.querySelectorAll('textarea')) field.value = field.textContent;
    for (const field of modal.querySelectorAll('select')) field.value = field.querySelector('[selected]')?.getAttribute('value') || field.querySelector('option')?.getAttribute('value') || '';
    modal.open = true; events.push('open');
  };
  modal.close = () => { if (!modal.open) return; modal.open = false; events.push('close'); const emit = () => modal.dispatchEvent(new FakeEvent('close')); if (queuedClose) closeEvents.push(emit); else emit(); };
  const idle = { reset() {}, syncContext() {}, bind() {} };
  const views = Object.fromEntries(nav.LEGACY_KEYS.map(view => [view, () => {
    const route = parseHash(location.hash), admitted = route && nav.viewForRoute(route) === view ? route : nav.routeForView(view);
    (state.screenRoutes ||= {})[view] = JSON.stringify([admitted.section || null, admitted.params || {}]);
    return `<section data-rendered-view="${view}"><h1>${view}</h1></section>`;
  }]));
  const globals = { ...i18n, ...nav, ...shell, state, document, location, parseHash, views, screenFrame, escape, icon: () => '',
    createModalRouteLifecycle, modalRouteContext, modalScopeContext, api: async () => assert.fail('render não chama a API'), confirm: message => { prompts.push(message); return typeof discard === 'function' ? discard() : discard; },
    $: selector => document.querySelector(selector), matchMedia: () => ({ matches: false }),
    history: { state: null, replaceState(_state, _title, route) { replacements.push(route); location.hash = route; } },
    window: { addEventListener(name, callback) { handlers[name] = callback; }, scrollTo() {} },
    applyBrandTokens, deriveBrandTokens, syncThemePrefs, inboxIdentity, hasPermission: () => true,
    commercialUsageUI: idle, memoryUI: idle, groupsWorkspaceUI: idle, contactLinksUI: idle, platformUsersUI: idle, channelVisitorTestUI: idle,
    contactRefresh: { ...idle, refresh() {} }, teamChatUI: idle, chatLayout: { sync() {}, collapsed: false },
    mediaUI: { sending: false, draft: '', syncContext: () => true }, voiceRecorder: { busy: false, syncContext() {} },
    consolidatedInbox: { saveDraft: () => true, getDraft: () => '', data: { counts: {} } }, noteDrafts: { key: null },
    selectedInboxRef: () => null, attendanceContext: () => ({ active: false }), syncAttendanceTools() {},
    forwarding: { close() {} }, repliesUI: { retainConversations() {}, syncContext() {} },
    avatarUI: { bind() {} }, integrationsUI: idle, mcpUI: { mountUsage() {} }, canSendTo: () => false, supportsVoice: () => false,
    shellUI: { close() {} }, syncContextSheet() {}, bindAgentAdminProposals() {}, bindSupportAssistant() {},
    afterRender: view => { document.querySelector('#main-content').scrollTo = () => {}; events.push('render:' + view); }, bindInboxMedia() {}, composerStatus() {}, refreshScopedConversationRuns: async () => false,
    loadNavigatedPanels() {}, focusViewContent() {}, refreshInboxList: async () => {}, changeInboxFilter() {},
    toast: (...args) => events.push(['toast', ...args]), canReplyTo: () => false, currentConversation: () => null,
    flowDraftGuard: { confirm: async () => false }, resetWorkspaceSelection: () => events.push('reset-workspace'),
    refresh: async tenantId => { state.tenant = { name: 'Empresa QA', conversations: [], channels: [channel], ...state.tenant, id: tenantId || 'company-a', resellerId: state.workspaceId }; },
    motionOK: () => false };
  const app = runInNewContext([initialization, roleLabel, excerpt('inbox-selection-state'), excerpt('navigation-heading'),
    excerpt('navigate'), excerpt('open-modal'), excerpt('attendance-context'), excerpt('change-workspace'), excerpt('route-sync'), excerpt('modal-click'),
    '({render,navigate,routeChanged,applyRoute,openModal,changeTenant,changeWorkspace,switchRouteWorkspace,modalRouteLifecycle})'].join('\n'), globals);
  app.render();
  const dto = { kind: 'webchat', channelId: channel.id, tenantId: 'company-a', version: 1, state: 'connected', enabled: true,
    origins: ['https://site.example'], install: { scriptUrl: 'https://elozi.example/widget.js' } };
  function connector({ read, kind = 'webchat' } = {}) {
    channel.kind = kind;
    const value = kind === 'webchat' ? dto : { kind, channelId: channel.id, tenantId: 'company-a', version: 1, state: 'configured', enabled: true, configured: true, resourceId: '123456789', apiVersion: 'v23.0' };
    const ui = createChannelConnectorsUI({ state, getModal: () => modal, openModal: app.openModal,
      api: async (path, init) => { calls.push({ path, init });
        if (kind === 'webchat' && init.method === 'GET' && path.endsWith('/widget-configuration')) return { tenantId:'company-a',channelId:channel.id,version:0,widget:{displayName:'Marca QA',theme:'light',radius:16} };
        if (init.method === 'GET' && read) return read;
        return init.method === 'POST' ? { ...value, ...JSON.parse(init.body), version: value.version + 1 } : structuredClone(value); },
      toast: (...args) => events.push(['toast', ...args]), onUpdate: () => events.push('updated') });
    return ui;
  }
  return { ...app, state, document, modal, channel, globals, location, events, prompts, replacements, calls, connector,
    field: name => modal.querySelector(`[name="${name}"]`),
    edit(name, value) { const field = modal.querySelector(`[name="${name}"]`); field.dispatchEvent(new FakeEvent('focusin', { bubbles: true })); field.value = value; field.dispatchEvent(new FakeEvent('input', { bubbles: true })); return field; },
    flushClose: () => { while (closeEvents.length) closeEvents.shift()(); } };
}

test('modal webchat permanece na mesma rota e fecha ao navegar de Canais para Agentes pelo handler servido', async () => {
  const f = fixture(), ui = f.connector(); await ui.open(f.channel);
  const form = f.modal.querySelector('form');
  f.navigate('channels'); assert.equal(f.modal.open, true); assert.equal(f.modal.querySelector('form'), form);
  f.navigate('agents');
  assert.equal(f.state.view, 'agents'); assert.ok(f.document.querySelector('[data-rendered-view="agents"]'));
  assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 0); assert.equal(f.events.filter(event => event === 'close').length, 1);
  assert.equal(f.calls[0].init.signal.aborted, true, 'o fechamento executa o cleanup do conector');
});

test('hashchange aceito encerra o modal; render da mesma rota não o encerra', async () => {
  const f = fixture(); await f.connector().open(f.channel);
  f.render(); await f.routeChanged(); assert.equal(f.modal.open, true);
  f.location.hash = '#agents'; await f.routeChanged();
  assert.equal(f.state.view, 'agents'); assert.equal(f.modal.open, false);
});

test('criação e deep link pessoais abrem após a rota estabilizar e o modal real conserva o formulário', async t => {
  for (const mode of ['criação', 'deep link']) await t.test(mode, async t => {
    const f = fixture({ hash: mode === 'criação' ? '#channels/new/telegram_user' : '#channels/personal-a/connect', discard: true });
    const previousDocument = globalThis.document, previousLocation = globalThis.location;
    globalThis.document = f.document; globalThis.location = f.location;
    t.after(() => {
      if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
      if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
    });
    const channel = { id: 'personal-a', name: 'Pessoal QA', kind: 'telegram_user', transport: 'telegram-user', state: 'disconnected' };
    const opened = []; let opening;
    const personal = createTelegramAccountUI({ state: f.state, document: f.document, getModal: () => f.modal, openModal: f.openModal,
      api: async (path, options) => {
        f.calls.push({ path, options });
        assert.equal(options.method, 'GET');
        return { tenantId: f.state.tenant.id, channelId: channel.id, version: 0, configured: false, state: 'disconnected', authState: 'idle', selectedCount: 0 };
      } });
    t.after(() => personal.destroy());
    const channels = createChannelsUI({ state: f.state, api: async (path, options) => {
      f.calls.push({ path, options }); assert.equal(options.method, 'POST'); return channel;
    }, refresh: async () => {}, toast: () => {}, openTelegramAccount: value => {
      opened.push(value.id); opening = personal.open(value); return opening;
    } });
    const previousAfterRender = f.globals.afterRender;
    f.globals.views.channels = () => {
      const route = parseHash(f.location.hash);
      (f.state.screenRoutes ||= {}).channels = JSON.stringify([route.section, route.params]);
      return channels.view(route);
    };
    f.globals.afterRender = view => {
      previousAfterRender(view);
      if (view === 'channels') channels.mount(f.document.querySelector('#main-content'), parseHash(f.location.hash));
    };
    if (mode === 'deep link') f.state.tenant.channels.push(channel);
    f.render();
    if (mode === 'criação') {
      const body = f.document.querySelector('[data-flow-body]');
      body.replaceChildren = function (...nodes) { this.innerHTML = ''; this.append(...nodes); };
      await channels.submit({ dataset: { form: 'channels:create' }, elements: { namedItem: name => ({ value: { kind: 'telegram_user', name: 'Pessoal QA' }[name] || '' }) } });
    }
    assert.deepEqual(opened, []); assert.equal(Boolean(f.modal.open), false); assert.equal(f.location.hash, '#channels');
    await f.routeChanged(); await opening;
    assert.deepEqual(opened, [channel.id]); assert.equal(f.modal.open, true);
    const form = f.modal.querySelector('form'), privateField = f.edit('apiHash', 'synthetic-draft');
    f.render(); await f.routeChanged();
    assert.equal(f.modal.open, true); assert.equal(f.modal.querySelector('form'), form); assert.equal(privateField.value, 'synthetic-draft');
    assert.deepEqual(opened, [channel.id]); assert.equal(f.events.filter(event => event === 'close').length, 0);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, mode === 'criação' ? 1 : 0);
    assert.equal(f.calls.filter(call => call.options.method === 'GET').length, 1);
    f.navigate('agents'); assert.equal(f.modal.open, false); assert.equal(privateField.value, '', 'a navegação real continua limpando o campo privado');
  });
});

test('loader que adiciona formulário e popula campos sem input/change não inventa rascunho alterado', () => {
  const f = fixture(); f.openModal('Carregando', '', '<p>Carregando…</p>');
  f.modal.innerHTML = '<form><input name="resource" value="original"/><textarea name="notes"></textarea></form>';
  f.field('resource').value = 'resultado do servidor'; f.field('notes').value = 'descrição do servidor';
  f.navigate('agents'); assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 0);
});

test('primeira edição usa o valor populado como baseline e desfazer todas as alterações admite saída sem perguntar', () => {
  const f = fixture(); f.openModal('Formulário', '', '<input name="draft" value="original"/>');
  f.field('draft').value = 'valor carregado'; f.edit('draft', 'alterado');
  assert.equal(f.modalRouteLifecycle.canLeave(), false); assert.equal(f.prompts.length, 1);
  f.edit('draft', 'valor carregado'); f.navigate('agents');
  assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 1);
});

test('ação explícita que substitui controles sem input/change protege escolhas e admite desfazer', async () => {
  const f = fixture(); f.openModal('Formulário', '', '<form><input name="draft" value="original"/><button type="button" data-suggest>Sugestão</button></form>');
  f.modal.addEventListener('click', event => { if (event.target.closest('[data-suggest]')) f.modal.querySelector('form').innerHTML = '<input name="draft" value="sugerido"/><button type="button" data-undo>Desfazer</button>'; });
  f.modal.addEventListener('click', event => { if (event.target.closest('[data-undo]')) f.modal.querySelector('form').innerHTML = '<input name="draft" value="original"/>'; });
  f.modal.querySelector('[data-suggest]').click(); await Promise.resolve(); f.navigate('agents');
  assert.equal(f.modal.open, true); assert.equal(f.field('draft').value, 'sugerido'); assert.equal(f.prompts.length, 1);
  f.modal.querySelector('[data-undo]').click(); await Promise.resolve(); f.navigate('agents');
  assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 1);
});

test('Usar permissões sugeridas do módulo real protege o formulário sem criar nem alterar grant', async t => {
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.fields = [...form.querySelectorAll('input, select, textarea')]; }
    getAll(name) { return this.fields.filter(field => field.name === name && !field.disabled && (!['checkbox', 'radio'].includes(field.type) || field.checked)).map(field => field.value || (field.type === 'checkbox' ? 'on' : '')); }
    get(name) { return this.getAll(name)[0] ?? null; }
    has(name) { return this.getAll(name).length > 0; }
  };
  t.after(() => { globalThis.FormData = originalFormData; });
  const f = fixture(), requests = [];
  const principal = { id: 'service-a', name: 'QA', agentId: 'hermes', capabilities: ['reply.draft'], channelIds: [], departmentIds: [],
    dailyRequests: 100, maxConcurrent: 1, active: true, state: 'active', revision: 3, keyRevision: 2, expiresAt: '2027-01-01T12:00:00Z', usage: { requests: 0 } };
  const ui = createServicePrincipalsUI({ getContext: () => ({ workspaceId: f.state.workspaceId, tenantId: f.state.tenant.id, userId: 'person-a', authorityKey: 'synthetic-csrf', isAdmin: true,
    agents: [{ id: 'hermes', name: 'Hermes QA', provider: 'hermes', mode: 'copilot', configured: true }], channels: [], departments: [] }),
    request: async (_path, init) => { requests.push(init); assert.equal(init?.method, undefined, 'somente leitura sintética da fixture'); return { principals: [principal] }; },
    getModal: () => f.modal, openModal: f.openModal, onError: message => assert.fail(message) });
  f.globals.servicePrincipalsUI = ui; await ui.load(); await ui.action('edit', principal.id);
  const selected = () => [...f.modal.querySelectorAll('[name="capabilities"]')].filter(field => field.checked).map(field => field.value);
  assert.deepEqual(selected(), ['reply.draft']);
  f.modal.querySelector('[data-service-principal-action="apply-objective"]').click(); await Promise.resolve();
  const suggested = selected(); assert.ok(suggested.includes('conversation.read'));
  f.navigate('agents'); assert.equal(f.modal.open, true); assert.equal(f.prompts.length, 1); assert.deepEqual(selected(), suggested);
  assert.equal(requests.length, 1); assert.equal(f.state.view, 'channels');
});

test('hashchange antes de render de ViewTransition não confirma o mesmo descarte duas vezes', async () => {
  const f = fixture({ discard: true }), updates = [];
  f.state.screenRoutes.agents = JSON.stringify(['agents', { tab: 'usage' }]);
  f.openModal('Formulário', '', '<input name="draft" value="original"/>'); f.edit('draft', 'alterado');
  f.globals.motionOK = () => true;
  f.document.startViewTransition = update => { updates.push(update); return { ready: Promise.resolve(), finished: Promise.resolve() }; };
  f.navigate('agents'); assert.equal(updates.length, 1); assert.equal(f.prompts.length, 1); assert.equal(f.modal.open, true);
  await f.routeChanged(); while (updates.length) updates.shift()();
  assert.equal(f.state.view, 'agents'); assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 1);
  assert.equal(f.events.filter(event => event === 'close').length, 1);
});

test('voltar de detalhe de agente para #agents confirma descarte uma vez e limpa o contexto da rota', async () => {
  const f = fixture({ discard: true }); f.state.view = 'agents'; f.location.hash = '#agents/agent-a'; f.render();
  f.openModal('Formulário', '', '<input name="draft" value="original"/>'); f.edit('draft', 'alterado');
  f.navigate('agents'); await f.routeChanged();
  assert.equal(f.location.hash, '#agents'); assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 1);
});

for (const navigation of ['âncora', 'hash']) test(`rascunho webchat recusa ${navigation}, conserva campos e restaura a rota completa`, async () => {
  const origin = '#channels/widget-a/connect', f = fixture({ hash: origin }); await f.connector().open(f.channel);
  const field = f.edit('origins', 'https://new.example');
  if (navigation === 'âncora') f.navigate('agents'); else { f.location.hash = '#agents'; await f.routeChanged(); }
  assert.equal(f.state.view, 'channels'); assert.equal(f.location.hash, origin); assert.equal(f.modal.open, true);
  assert.equal(f.field('origins'), field); assert.equal(field.value, 'https://new.example');
  assert.equal(f.prompts.length, 1); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0);
});

test('voltar de rota delegada para Canais também protege o formulário alterado', async () => {
  const f = fixture({ hash: '#channels/widget-a/connect' }); await f.connector().open(f.channel);
  f.edit('origins', 'https://draft.example'); f.navigate('channels');
  assert.equal(f.location.hash, '#channels/widget-a/connect'); assert.equal(f.modal.open, true); assert.equal(f.prompts.length, 1);
});

test('aceitar descarte admite a rota, fecha uma vez e não salva nem reenvia', async () => {
  const f = fixture({ discard: true }); await f.connector().open(f.channel);
  f.edit('origins', 'https://draft.example'); f.navigate('agents');
  assert.equal(f.state.view, 'agents'); assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 1);
  assert.equal(f.events.filter(event => event === 'close').length, 1); assert.equal(f.calls.length, 1);
});

for (const reason of ['sending', 'voice', 'pending']) test(`bloqueio existente ${reason} preserva modal e rascunho sem confirmação adicional`, async () => {
  const f = fixture({ hash: '#channels/widget-a/connect' }); await f.connector().open(f.channel);
  f.edit('origins', 'https://draft.example');
  if (reason === 'sending') f.globals.mediaUI.sending = true;
  if (reason === 'voice') f.globals.voiceRecorder.busy = true;
  if (reason === 'pending') f.state.sendIntent = { synthetic: true };
  f.navigate('agents'); assert.equal(f.state.view, 'channels');
  f.location.hash = '#agents'; await f.routeChanged();
  assert.equal(f.state.view, 'channels'); assert.equal(f.location.hash, '#channels/widget-a/connect'); assert.equal(f.modal.open, true);
  assert.equal(f.field('origins').value, 'https://draft.example'); assert.equal(f.prompts.length, 0);
});

test('render recusado pelo limite de rascunhos conserva o modal do contexto anterior', async () => {
  const f = fixture(); await f.connector().open(f.channel);
  f.state.renderedInboxContext = { view: 'channels', conversation: null };
  f.globals.mediaUI.syncContext = () => false;
  f.location.hash = '#agents'; await f.routeChanged();
  assert.equal(f.state.view, 'channels'); assert.equal(f.modal.open, true); assert.equal(f.events.filter(event => event === 'close').length, 0);
});

test('autoridade já alterada encerra formulário antigo mesmo se render posterior recusar mudança de rota', async () => {
  const f = fixture(); await f.connector({ kind: 'messenger' }).open(f.channel);
  const field = f.edit('accessToken', 'synthetic-test-value'); f.state.boot.session.permissions = ['inbox.read'];
  f.state.renderedInboxContext = { view: 'channels', conversation: null }; f.globals.mediaUI.syncContext = () => false;
  f.location.hash = '#agents'; await f.routeChanged();
  assert.equal(f.modal.open, false); assert.equal(field.value, ''); assert.equal(f.prompts.length, 0);
});

for (const scope of ['empresa', 'workspace', 'autoridade']) test(`contexto admitido de ${scope} fecha modal antigo, mesmo na mesma tela`, async () => {
  const f = fixture(); await f.connector().open(f.channel);
  if (scope === 'empresa') f.state.tenant.id = 'company-b';
  if (scope === 'workspace') f.state.workspaceId = 'workspace-b';
  if (scope === 'autoridade') { f.edit('origins', 'https://draft.example'); f.state.boot.session.permissions = ['inbox.read']; }
  f.render(); assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 0, 'autoridade já alterada não pode manter formulário antigo acionável');
});

for (const scope of ['empresa', 'workspace']) test(`troca explícita de ${scope} recusada conserva rascunho; troca admitida fecha modal`, async () => {
  let discard = false;
  const f = fixture({ discard: () => discard }); await f.connector().open(f.channel);
  f.edit('origins', 'https://draft.example');
  const change = () => scope === 'empresa' ? f.changeTenant('company-b') : f.changeWorkspace('workspace-b');
  await change(); assert.equal(f.state.tenant.id, 'company-a'); assert.equal(f.state.workspaceId, 'workspace-a'); assert.equal(f.modal.open, true);
  discard = true; await change();
  assert.equal(scope === 'empresa' ? f.state.tenant.id : f.state.workspaceId, scope === 'empresa' ? 'company-b' : 'workspace-b');
  assert.equal(f.modal.open, false); assert.equal(f.prompts.length, 2);
});

test('confirmação de link de outro workspace respeita rascunho e conserva routeIntent até Trocar', async () => {
  let discard = false;
  const f = fixture({ discard: () => discard }); await f.connector().open(f.channel);
  f.edit('origins', 'https://draft.example');
  f.location.hash = '#agents?w=workspace-b'; await f.routeChanged();
  assert.equal(f.state.routeIntent, undefined); assert.equal(f.location.hash, '#channels'); assert.equal(f.modal.open, true);
  discard = true; f.location.hash = '#agents?w=workspace-b'; await f.routeChanged();
  assert.equal(f.state.workspaceId, 'workspace-a'); assert.equal(f.state.routeIntent.workspaceId, 'workspace-b');
  const intent = f.state.routeIntent; f.navigate('agents');
  assert.equal(f.state.routeIntent, intent); assert.equal(f.state.view, 'channels');
  await f.switchRouteWorkspace();
  assert.equal(f.state.routeIntent, null); assert.equal(f.state.workspaceId, 'workspace-b'); assert.equal(f.state.view, 'agents'); assert.equal(f.modal.open, false);
});

test('confirmação de rascunho de fluxo continua dona do fechamento e recusa navegação', () => {
  const f = fixture(); f.openModal('Fluxo', '', '<div data-flow-draft-guard><button data-close-modal>Voltar</button></div>');
  f.navigate('agents'); assert.equal(f.state.view, 'channels'); assert.equal(f.modal.open, true); assert.equal(f.prompts.length, 0);
  let closed = 0; f.modal.addEventListener('close', () => closed++); f.modal.close(); assert.equal(closed, 1);
});

test('GET webchat tardio depois da troca não reabre nem substitui um novo modal de Agentes', async () => {
  const pending = deferred(), f = fixture(), ui = f.connector({ read: pending.promise });
  const opening = ui.open(f.channel); assert.equal(f.modal.open, true);
  f.navigate('agents'); f.openModal('Agente QA', '', '<p data-new-dialog>Contexto atual</p>');
  const currentMarkup = f.modal.innerHTML;
  pending.resolve({ kind: 'webchat', channelId: 'widget-a', tenantId: 'company-a', version: 1, state: 'connected', enabled: true, origins: ['https://site.example'] });
  assert.equal(await opening, false); assert.equal(f.modal.open, true); assert.equal(f.modal.innerHTML, currentMarkup);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal.aborted, true);
});

test('fechamento de conector limpa campos privados e evento close enfileirado não apaga contexto de novo modal', async () => {
  const f = fixture({ discard: true, queuedClose: true }); await f.connector({ kind: 'messenger' }).open(f.channel);
  const privateField = f.edit('accessToken', 'synthetic-test-value');
  f.navigate('agents'); assert.equal(privateField.value, ''); f.flushClose();
  f.openModal('Novo', '', '<input name="draft" value="original"/>');
  f.modal.close(); f.openModal('Atual', '', '<input name="draft" value="atual"/>'); f.flushClose();
  f.edit('draft', 'editado'); assert.equal(f.modalRouteLifecycle.canLeave(), true); assert.equal(f.prompts.length, 2);
});

test('botão e Escape protegem drafts; salvar origens continua no designer e outros conectores fecham sem confirmação', async t => {
  let discard = false;
  const f = fixture({ discard: () => discard }), ui = f.connector(); await ui.open(f.channel);
  f.edit('origins', 'https://draft.example');
  f.modal.querySelector('[data-close-modal]').click(); assert.equal(f.modal.open, true);
  const cancel = new FakeEvent('cancel'); f.modal.dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true); assert.equal(f.modal.open, true);
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.form = form; } get(name) { const field = this.form.querySelector(`[name="${name}"]`); return !field || field.type === 'checkbox' && !field.checked ? null : field.value; } };
  t.after(() => { globalThis.FormData = originalFormData; });
  await ui.submit(f.modal.querySelector('form'));
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(f.modal.open, true); assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.calls.map(call => [call.init.method,call.path.split('/').at(-1)]), [['GET','configuration'],['POST','configuration'],['GET','widget-configuration']]);
  assert.ok(f.modal.querySelector('[data-webchat-install-step="appearance"]'));assert.ok(f.modal.querySelector('[data-widget-designer]'));assert.equal(f.field('displayName').value,'Marca QA');
  assert.equal(f.events.filter(event=>event==='close').length,0,'o avanço interno não confirma descarte nem fecha o guia');
  assert.ok(f.events.some(event => Array.isArray(event) && event[1] === 'Configuração salva.'));
  f.edit('displayName','Aparência em rascunho');f.modal.querySelector('[data-close-modal]').click();assert.equal(f.modal.open,true);assert.equal(f.prompts.length,3);assert.equal(f.field('displayName').value,'Aparência em rascunho');
  discard = true; f.modal.querySelector('[data-close-modal]').click(); assert.equal(f.modal.open, false);assert.equal(f.prompts.length,4);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
  const other=fixture(),otherUI=other.connector({kind:'messenger'});await otherUI.open(other.channel);other.edit('resourceId','987654321');await otherUI.submit(other.modal.querySelector('form'));
  assert.equal(other.modal.open,false);assert.equal(other.prompts.length,0);assert.equal(other.calls.filter(call=>call.init.method==='POST').length,1);assert.ok(other.events.some(event=>Array.isArray(event)&&event[1]==='Configuração salva.'));
});

test('confirmação usa traduções PT/EN existentes', async () => {
  i18n.setLocale('en', { persist: false, notify: false });
  const f = fixture(); await f.connector().open(f.channel); f.edit('origins', 'https://draft.example'); f.navigate('agents');
  assert.equal(f.prompts[0], 'Discard changes?\n\nWhat you entered in this form has not been saved yet.'); assert.equal(f.modal.open, true);
});
