// Seams of the frontend v2 (FRONTEND-V2 §8.1 and §8.2, P1 commit 1f): the action registry consulted
// by act(), the delegated screens (agents, channels, connect, pending, setup and the Configurações and
// Plataforma tabs), the service seams (live, session guard, drafts store, data source, composer
// bridge), the agent rail split out of mcp-ui.js and the stubs pre-registered for P2–P8. The tests run
// the real modules and the served excerpts of app.js: a package that rewrites its module keeps the
// contract below or changes this file together with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import '../public/locales-operations.js';
import * as actions from '../public/actions.js';
import { createLive, createLiveRegistry, provideLiveContext } from '../public/live.js';
import { sessionExpired } from '../public/session-guard.js';
import { createDraftsStore } from '../public/drafts-store.js';
import { createDataSource } from '../public/data-source.js';
import { createAttention, EMPTY_ATTENTION } from '../public/attention.js';
import { createNotify } from '../public/notify.js';
import { createConnectionStatus } from '../public/connection-status.js';
import { keyboard, createKeyboard } from '../public/keyboard.js';
import { createCommandPalette } from '../public/command-palette.js';
import { inboxListMarkup } from '../public/inbox-list-ui.js';
import { consolidatedListMarkup, createConsolidatedInboxUI } from '../public/consolidated-inbox-ui.js';
import { createComposerBridge } from '../public/composer-ui.js';
import { replaceWithMarkup } from '../public/dom-patch.js';
import { createAgentRail, activeRunStates } from '../public/agent-rail-ui.js';
import * as mcpModule from '../public/mcp-ui.js';
import { createAgentsHub } from '../public/agents-hub-ui.js';
import { createAgentDetail } from '../public/agent-detail-ui.js';
import { createAgentUsage } from '../public/agent-usage-ui.js';
import { createAgentConnectWizard } from '../public/agent-connect-wizard.js';
import { createPending } from '../public/pending-ui.js';
import { MCP_ALWAYS_TOOLS, MCP_CAPABILITY_TOOLS, MCP_CAPABILITIES, REST_ONLY_CAPABILITIES, MCP_DIRECT_ACTIONS, toolsForCapabilities, capabilityOfTool } from '../public/mcp-catalog.js';
import { createChannelsUI } from '../public/channels-ui.js';
import { createChannelVisitorTestUI } from '../public/channel-visitor-test-ui.js';
import { createChannelConnectFlow } from '../public/channel-connect-flow.js';
import { createOnboarding } from '../public/onboarding-ui.js';
import { createSettings } from '../public/settings-ui.js';
import * as nav from '../public/nav-config.js';
import { menuEntries } from '../public/shell-ui.js';
import { parseHash } from '../public/router.js';
import { SERVICE_CAPABILITIES } from '../src/service-principals.js';
import { PANEL_ASSETS } from '../src/panel-assets.js';
import { excerpt, publicSource } from './helpers/app-source.js';
import { createJsonRead } from '../public/json-read.js';

const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const plain = value => JSON.parse(JSON.stringify(value));
const app = publicSource('app.js');
const pageHeading = (eyebrow, title, description, actions = '') => `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
const route = hash => parseHash(hash);
const SHELL_ACTIONS = ['shell:workspace', 'shell:tenant', 'shell:team', 'shell:pending', 'shell:shortcuts', 'shell:scope'];
const SCREEN_CONTRACT = ['view', 'act', 'submit', 'reset'];

// ---------------------------------------------------------------------------------------------
// 1. Action registry (actions.js) and its use by act()

test('registro de ações: só nomes com namespace, o último registro vence e o descarte remove só o próprio', async () => {
  assert.throws(() => actions.registerAction('new-agent', () => {}), /namespace/);
  assert.throws(() => actions.registerAction('Shell:Pending', () => {}), /namespace/);
  assert.throws(() => actions.registerAction('seams:ok', 'nada'), /handler/);
  const calls = [];
  const first = actions.registerAction('seams:open', context => calls.push(['first', context.id]));
  const second = actions.registerAction('seams:open', context => calls.push(['second', context.name, context.id, context.element?.tag ?? null, context.event?.type ?? null]));
  assert.equal(await actions.dispatchAction('seams:open', { tag: 'button', dataset: { id: 'row-1' } }, { type: 'click' }), true);
  first();
  assert.equal(await actions.dispatchAction('seams:open', null, null, 'row-2'), true, 'o descarte antigo não remove o registro mais novo');
  second();
  assert.equal(await actions.dispatchAction('seams:open'), false);
  assert.deepEqual(calls, [['second', 'seams:open', 'row-1', 'button', 'click'], ['second', 'seams:open', 'row-2', null, null]]);
  assert.equal(await actions.dispatchAction('new-agent'), false, 'nomes legados nunca chegam ao registro');
  const many = actions.registerActions({ 'seams:a': () => calls.push('a'), 'seams:b': () => calls.push('b') });
  assert.ok(['seams:a', 'seams:b'].every(name => actions.registryEntries().actions.includes(name)));
  many();
  assert.ok(!actions.registryEntries().actions.some(name => name.startsWith('seams:')));
});

test('telas delegadas respondem pelo namespace e recebem os formulários data-form, com preventDefault antes de qualquer espera', async () => {
  const seen = [];
  const screen = {
    async act(name, id, element) { seen.push(['act', name, id, element?.tag ?? null]); return name !== 'seams-screen:ignored'; },
    async submit(form) { await Promise.resolve(); seen.push(['submit', form.dataset.form]); }
  };
  const remove = actions.registerScreen('seams-screen', screen);
  const own = actions.registerAction('seams-screen:own', () => seen.push(['own']));
  assert.equal(await actions.dispatchAction('seams-screen:save', { tag: 'button', dataset: { id: 'agent-1' } }), true);
  assert.equal(await actions.dispatchAction('seams-screen:ignored'), false, 'a tela pode recusar e devolver ao legado');
  assert.equal(await actions.dispatchAction('seams-screen:own'), true, 'o registro próprio vence a tela');
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  const pending = actions.dispatchSubmit({ dataset: { form: 'seams-screen:instructions' } }, event);
  assert.equal(prevented, 1, 'o envio padrão é cancelado na hora, antes do await');
  assert.equal(await pending, true);
  assert.equal(await actions.dispatchSubmit({ dataset: { dialogForm: 'agent' } }, event), false, 'formulários legados seguem para app.js');
  assert.equal(prevented, 1);
  const orphan = actions.dispatchSubmit({ dataset: { form: 'nobody:form' } }, event);
  assert.equal(prevented, 2, 'namespace sem tela: o envio também é cancelado na hora');
  assert.equal(await orphan, true, 'e o formulário é consumido, nunca enviado ao servidor');
  assert.deepEqual(seen, [['act', 'seams-screen:save', 'agent-1', 'button'], ['act', 'seams-screen:ignored', null, null], ['own'], ['submit', 'seams-screen:instructions']]);
  own(); remove();
  assert.equal(await actions.dispatchAction('seams-screen:save'), false);
  assert.throws(() => actions.registerScreen('Bad NS', screen), /namespace/);
  assert.throws(() => actions.registerScreen('seams-empty', {}), /act or submit/);
});

function actFixture() {
  const effects = [], state = { inboxSelecting: false, boot: { session: { role: 'reseller' } }, tenant: null };
  const idle = { action: async () => false, act: async () => false };
  const sandbox = {
    ...i18n, state, accountSecurityUI: idle, supportUI: idle, billingUI: idle, unitsUI: idle, knowledgeUI: idle, integrationsUI: idle, contactLinksUI: idle, workspaceUI: idle, automationUI: idle,
    memoryUI: { action: async () => false }, attendanceAction: async () => false, canCoordinate: () => true, canManageAttendance: () => true, currentConversation: () => null,
    mcpUI: { act: async name => { effects.push(['mcp', name]); return false; } },
    agentRail: { act: async (name, id) => { effects.push(['rail', name, id]); return name === 'mcp-approve'; } },
    dispatchAction: async (name, element, event, id) => { effects.push(['registry', name, id]); return name.startsWith('shell:'); }
  };
  return { ...runInNewContext(excerpt('act') + '\n({act})', sandbox), state, effects };
}

test('act() consulta o registro antes do código legado, só com nomes com namespace e depois da guarda de seleção', async () => {
  const f = actFixture();
  await f.act('shell:pending', 'bell');
  await f.act('agents:save-instructions', 'agent-1');
  await f.act('mcp-approve', 'run-1');
  await f.act('mcp-discover', 'server-1');
  await f.act('legacy-nothing');
  assert.deepEqual(plain(f.effects), [
    ['registry', 'shell:pending', 'bell'],
    ['registry', 'agents:save-instructions', 'agent-1'], ['mcp', 'agents:save-instructions'],
    ['rail', 'mcp-approve', 'run-1'],
    ['rail', 'mcp-discover', 'server-1'], ['mcp', 'mcp-discover'],
    ['mcp', 'legacy-nothing']
  ], 'registro só para nomes com ":"; ações de execução mcp-* passam primeiro pelo trilho do agente');
  f.effects.length = 0; f.state.inboxSelecting = true;
  await f.act('shell:pending');
  assert.deepEqual(f.effects, [], 'durante a seleção de uma conversa nada roda, como antes');
  const actSource = excerpt('act');
  assert.ok(actSource.indexOf("dispatchAction(") < actSource.indexOf('switch (action)'));
  assert.ok(actSource.indexOf('agentRail.act(') < actSource.indexOf('mcpUI.act('));
  assert.match(actSource, /agentRail\.openRun\(conversation,agent\)/, 'Acionar copiloto abre o formulário do trilho');
});

test('ações padrão do shell estão no registro com o comportamento do 1e e o pacote dono pode substituí-las', async () => {
  const line = app.split('\n').find(text => text.startsWith("for(const name of ['shell:workspace'"));
  assert.ok(line, 'registro das ações shell:* logo depois da âncora shell-actions');
  const calls = [];
  runInNewContext(line, { registerAction: actions.registerAction, shellAction: (...args) => calls.push(args) });
  try {
    assert.ok(SHELL_ACTIONS.every(name => actions.registryEntries().actions.includes(name)));
    await actions.dispatchAction('shell:workspace', { dataset: { id: 'client-b', grant: 'grant-b' } });
    await actions.dispatchAction('shell:team');
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[0][0], calls[0][1], calls[0][2].dataset.grant], ['shell:workspace', 'client-b', 'grant-b']);
    assert.deepEqual([calls[1][0], calls[1][1], calls[1][2]], ['shell:team', null, null]);
    const drawer = [], restore = actions.registerAction('shell:pending', () => drawer.push('drawer'));
    await actions.dispatchAction('shell:pending');
    assert.deepEqual(drawer, ['drawer']); assert.equal(calls.length, 2, 'o registro do pacote dono substitui o padrão do P1');
    restore();
  } finally {
    for (const name of SHELL_ACTIONS) actions.registerAction(name, () => {})();
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Delegated screens (anchor delegated-screens) and the route inside them (anchor route-sync)

function screensFixture({ hash = '#overview' } = {}) {
  const calls = { screens: [], connection: 0, notify: 0, scopes: [], resets: [], visitorResets: 0, reauthPending: false };
  const main = { id: 'main-content' };
  const legacy = Object.fromEntries([...nav.HUBS.settings.tabs, ...nav.HUBS.platform.tabs].map(tab => [tab.view, () => `<section data-legacy="${tab.view}">legado</section>`]));
  const state = { boot: { session: { role: 'reseller', platformOwner: true } }, supportGrantId: null, tenant: { name: 'Empresa QA', agents: [], channels: [] }, workspaceId: 'w-a', view: 'agents' };
  const sandbox = {
    ...i18n, ...nav, parseHash, state, location: { hash }, escape, icon: () => '', badge: text => `<b>${escape(text)}</b>`, button: label => `<button>${escape(label)}</button>`, pageHeading,
    renderAgentAdminProposals: () => '', renderSupportAssistant: () => '',
    mcpUI: { panel: () => '<section id="mcp-settings">painel MCP</section>' },
    channels: () => state.tenant.channels, servicePrincipalsUI: { markup: () => '<section data-principals></section>' },
    brandDraft: () => ({ name: 'Empresa QA', color: '#3157d5' }),
    views: { overview: () => 'visão', ...legacy },
    createAgentsHub, createChannelsUI, createAgentConnectWizard, createPending, createOnboarding, createSettings, createAttention,
    channelVisitorTestUI: null, reauthPending: () => calls.reauthPending,
    createChannelVisitorTestUI: options => {
      calls.visitorOptions = options;
      const controller = createChannelVisitorTestUI({ ...options, document: null, window: null });
      const reset = controller.reset;
      controller.reset = () => { calls.visitorResets++; reset(); };
      return controller;
    },
    createNotify: options => ({ apply: () => calls.notify++, options }), createConnectionStatus: options => ({ apply: () => calls.connection++, options }),
    keyboard: { setScope: scope => calls.scopes.push(scope) }, registerScreen: (namespace, screen) => calls.screens.push([namespace, screen]),
    agentRail: { reset: () => calls.resets.push('rail'), act: async () => false, submit: async () => false }, api: async () => assert.fail('nenhuma requisição ao montar as telas'),
    document: { getElementById: id => id === 'main-content' ? main : null }
  };
  const real = runInNewContext(excerpt('delegated-screens') + '\n({views,screenRoute,resetScreens,afterRender,SCREENS,attention,connection})', sandbox);
  return { ...real, sandbox, calls, state, main };
}

test('views delegadas: agents (e a aba Ferramentas), channels, service-agents, pending, setup e as abas de Configurações e Plataforma passam pelos módulos donos', () => {
  const f = screensFixture();
  // P8 (§8.9): settings-ui.js also draws Clientes (#accounts), Indicadores (#metrics), Ajuda (#help) and Minha conta.
  const delegated = ['agents', 'agent-tools', 'channels', 'service-agents', 'pending', 'setup', ...nav.HUBS.settings.tabs.map(tab => tab.view), ...nav.HUBS.platform.tabs.map(tab => tab.view), 'accounts', 'metrics', 'guide', 'account'];
  assert.deepEqual(Object.keys(f.SCREENS).sort(), [...delegated].sort());
  for (const view of ['accounts', 'metrics', 'guide', 'account', ...nav.HUBS.platform.tabs.map(tab => tab.view)]) assert.equal(f.SCREENS[view], f.SCREENS.team, `${view}: settings-ui.js`);
  // Commit 1g: the Ferramentas tab is a view of the same agents hub, with the MCP panel of mcp-ui.js;
  // every agents-hub tab that is a screen of SCREEN_VIEWS goes there (P5 adds tabs in nav-config only).
  const screenTabs = nav.HUBS.agents.tabs.filter(tab => Object.hasOwn(nav.SCREEN_VIEWS, tab.view)).map(tab => tab.view);
  assert.deepEqual(screenTabs, ['agent-tools']);
  for (const view of screenTabs) assert.equal(f.SCREENS[view], f.SCREENS.agents, view);
  assert.match(f.views['agent-tools'](), /<h1>Ferramentas para os copilotos desta empresa\.<\/h1>[\s\S]*<section id="mcp-settings">painel MCP<\/section>$/);
  // P8 redraws Marca e domínio (light and dark previews) and Saúde e versão; the other tabs keep the markup of their modules.
  const redrawn = ['brand', 'architecture'];
  for (const view of [...nav.HUBS.settings.tabs, ...nav.HUBS.platform.tabs].map(tab => tab.view).filter(view => !redrawn.includes(view))) assert.equal(f.views[view](), `<section data-legacy="${view}">legado</section>`, `${view}: markup legado intacto`);
  assert.match(f.views.brand(), /^<div class="pg-settings pg-settings--brand">[\s\S]*data-brand-previews[\s\S]*data-brand-report/);
  assert.match(f.views.architecture(), /^<div class="pg-settings pg-settings--health">[\s\S]*Consultando a saúde da plataforma…/, 'dono da plataforma: saúde carregando, sem requisição ao desenhar');
  // P5 delivered the Central de Agentes (§5.3.1): the list of agents-hub-ui.js replaces the legacy cards.
  assert.match(f.views.agents(), /<h1 class="pg-agents__h1">Agentes<\/h1>[\s\S]*data-agents-slot="agents-table"/);
  f.state.tenant.agents = [{ id: 'a-1', name: 'Hermes <1>' }];
  assert.match(f.views.agents(), /href="#agents\/a-1">Hermes &lt;1&gt;<\/a>/, 'nome do agente escapado na lista do P5');
  // P7 delivered Canais (§5.5): channels-ui.js draws its own cards (the legacy channelRows left app.js in P10).
  assert.match(f.views.channels(), /<h1 class="pg-channels__title">Canais<\/h1>[\s\S]*Nenhum canal conectado ainda/);
  f.state.tenant.channels = [{ id: 'wa', name: 'WhatsApp <1>', kind: 'whatsapp_qr' }];
  const channelsMarkup = f.views.channels();
  assert.match(channelsMarkup, /data-channel-card="wa"[\s\S]*<h3 class="pg-channels__name">WhatsApp &lt;1&gt;<\/h3>/, 'nome do canal escapado no cartão do P7');
  assert.doesNotMatch(excerpt('delegated-screens'), /channelRows|agentCard/, 'as telas delegadas não recebem os renderizadores legados');
  // Integration after P6: app.js hands state and api to the wizard, so #service-agents draws the P6 wizard (pg-connect).
  assert.match(f.views['service-agents'](), /<section class="pg-connect">/);
  assert.match(f.views.pending(), /<h1>Pendências<\/h1>/); assert.match(f.views.setup(), /<h1>Primeiro uso<\/h1>/);
  assert.equal(f.views.overview(), 'visão', 'views legadas fora das telas delegadas não mudam');
  assert.deepEqual(f.calls.screens.map(([namespace]) => namespace).sort(), ['agents', 'channels', 'connect', 'pending', 'rail', 'settings', 'setup']);
  for (const [, screen] of f.calls.screens) assert.ok(typeof screen.act === 'function' && typeof screen.submit === 'function');
  assert.equal(f.calls.screens.find(([namespace]) => namespace === 'rail')[1], f.sandbox.agentRail);
});

test('rota em tela: o hash quando abre a view (aba, ID, passo), senão a rota canônica; a rota recebida fica registrada', () => {
  const f = screensFixture({ hash: '#agents/usage' });
  assert.deepEqual(plain(f.screenRoute('agents')), { section: 'agents', params: { tab: 'usage' }, query: {}, workspaceId: null, alias: null });
  f.sandbox.location.hash = '#agents/tools';
  assert.deepEqual(plain(f.screenRoute('agent-tools')), { section: 'agents', params: { tab: 'tools' }, query: {}, workspaceId: null, alias: null });
  assert.deepEqual(plain(f.screenRoute('agents')), plain(nav.routeForView('agents')), 'Ferramentas é outra view do hub (commit 1g): a lista recebe a rota canônica');
  f.sandbox.location.hash = '#pending/approval/run-7';
  assert.deepEqual(plain(f.screenRoute('pending').params), { type: 'approval', id: 'run-7' });
  f.sandbox.location.hash = '#overview';
  assert.deepEqual(plain(f.screenRoute('agents')), plain(nav.routeForView('agents')), 'outra tela no hash: rota canônica');
  assert.deepEqual(plain(f.screenRoute('team')), plain(nav.routeForView('team')));
  f.sandbox.location.hash = '#tenants';
  assert.equal(f.screenRoute('tenants').alias, 'tenants', 'hash legado (alias) chega como a rota que ele abre');
  assert.equal(f.state.screenRoutes.agents, JSON.stringify(['agents', {}]));
  assert.equal(f.state.screenRoutes.pending, JSON.stringify(['pending', { type: 'approval', id: 'run-7' }]));
});

test('afterRender: conexão, notificações e escopo do teclado a cada render; a tela monta com <main> e a rota; reset limpa trilho e telas', () => {
  const f = screensFixture({ hash: '#agents/usage' });
  assert.equal(f.calls.visitorOptions.state, f.state, 'o controller recebe a autoridade viva do app');
  assert.deepEqual(plain(f.calls.visitorOptions.getRoute()), plain(route('#agents/usage')));
  assert.equal(f.calls.visitorOptions.canUse(), true);
  f.calls.reauthPending = true;
  assert.equal(f.calls.visitorOptions.canUse(), false, 'renovação pendente revoga o visitante sem recriar o controller');
  f.calls.reauthPending = false;
  f.SCREENS.channels.reset();
  assert.equal(f.calls.visitorResets, 1, 'o reset da tela de canais encerra seu controller visitante');
  f.afterRender('inbox');
  assert.deepEqual([f.calls.connection, f.calls.notify, plain(f.calls.scopes)], [1, 1, ['inbox']]);
  const mounts = [];
  f.SCREENS.agents.mount = (main, mounted) => mounts.push([main, mounted.params]);
  f.afterRender('agents');
  assert.equal(mounts.length, 1); assert.equal(mounts[0][0], f.main); assert.deepEqual(plain(mounts[0][1]), { tab: 'usage' });
  assert.deepEqual(plain(f.calls.scopes), ['inbox', 'agents']);
  const resets = [];
  for (const screen of new Set(Object.values(f.SCREENS))) screen.reset = () => resets.push(screen);
  f.resetScreens();
  assert.deepEqual(plain(f.calls.resets), ['rail']);
  assert.equal(resets.length, new Set(Object.values(f.SCREENS)).size, 'cada tela delegada uma vez (Configurações e Plataforma compartilham settings-ui)');
  assert.deepEqual(plain(f.attention.snapshot()), plain(EMPTY_ATTENTION));
  assert.equal(f.connection.options.live.state().connection, null, 'antes de live.start() o estado é desconhecido, nunca "ao vivo"');
});

function routeFixture(view, screenRoutes) {
  const renders = [], replaced = [], listeners = {};
  const state = { view, screenRoutes, boot: { session: { userId: 'u' } }, workspaceId: 'w', supportGrantId: null, menuOpen: true };
  const sandbox = {
    ...nav, state, views: Object.fromEntries([...nav.LEGACY_KEYS, 'pending', 'setup'].map(key => [key, () => ''])), parseHash,
    render: () => renders.push(state.view), history: { state: null, replaceState: (_s, _t, url) => replaced.push(url) }, location: { hash: '' },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } }, $: () => ({ addEventListener() {} }),
    currentRouteHash: () => '#' + state.view, inboxIdentity: () => '', selectedInboxRef: () => null
  };
  return { ...runInNewContext(excerpt('route-sync') + '\n({applyRoute,screenRouteChanged})', sandbox), renders, replaced, state };
}

test('hash que muda dentro de uma tela delegada redesenha; telas legadas e a mesma rota não redesenham', async () => {
  const agents = routeFixture('agents', { agents: JSON.stringify(['agents', {}]) });
  await agents.applyRoute(route('#agents/usage'));
  assert.deepEqual(agents.renders, ['agents']); assert.equal(agents.state.menuOpen, false);
  await agents.applyRoute(route('#agents'));
  assert.deepEqual(agents.renders, ['agents'], 'a rota que a tela já recebeu não redesenha (navigate + hashchange)');
  const legacy = routeFixture('team', {});
  await legacy.applyRoute(route('#settings/team'));
  assert.deepEqual(legacy.renders, [], 'view legada sem rota registrada: comportamento de antes');
  assert.equal(legacy.screenRouteChanged(route('#settings/team'), 'team'), false);
  const pending = routeFixture('pending', { pending: JSON.stringify(['pending', {}]) });
  await pending.applyRoute(route('#pending/handoff/case-1'));
  assert.deepEqual(pending.renders, ['pending']);
});

// ---------------------------------------------------------------------------------------------
// 3. Service seams: live.js, session-guard.js, drafts-store.js, data-source.js, composer bridge

// Clock of the scheduler of P2 (live.js now plans with setTimeout and its own cadence per screen).
function fakeClock() {
  let now = 0, next = 0; const timers = new Map();
  return { timers, now: () => now, setTimeout(fn, ms) { timers.set(++next, { fn, at: now + ms }); return next; }, clearTimeout(id) { timers.delete(id); },
    advance(ms) { const end = now + ms; for (;;) { const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] || []; if (!timer || timer.at > end) break; timers.delete(id); now = timer.at; timer.fn(); } now = end; } };
}
const quietPage = { visibilityState: 'visible', addEventListener() {} };

test('live.js (P2): contrato {start, stop, kick, state}, start único, intervalo próprio das tarefas sem política e conexão desconhecida antes de medir', () => {
  assert.throws(() => createLive({ tasks: [{ name: 'x', every: 0, run() {} }] }), /interval/);
  assert.throws(() => createLive({ tasks: [{ name: 'x', every: 10, run() {} }, { name: 'x', every: 10, run() {} }] }), /unique/);
  const clock = fakeClock(), runs = [], registry = createLiveRegistry();
  provideLiveContext(() => ({ view: 'overview' }), registry);
  const live = createLive({ timers: clock, now: clock.now, registry, document: quietPage, window: null, navigator: {}, tasks: [{ name: 'a', every: 5000, run: () => runs.push('a') }, { name: 'b', every: 15000, run: () => runs.push('b') }] });
  for (const key of ['start', 'stop', 'kick', 'state']) assert.equal(typeof live[key], 'function', key);
  assert.equal(live.start(), true); assert.equal(live.start(), false, 'um segundo start não duplica timers');
  clock.advance(15000);
  assert.deepEqual(runs, ['a', 'a', 'a', 'b']);
  assert.equal(live.kick('b'), true); assert.equal(live.kick('none'), false);
  assert.deepEqual(plain(live.state().tasks), [{ name: 'a', every: 5000 }, { name: 'b', every: 15000 }]);
  assert.equal(live.state().connection, null, 'nada medido ainda: nunca "ao vivo"');
  assert.equal(live.stop(), true); assert.equal(clock.timers.size, 0); assert.equal(live.stop(), false); assert.equal(live.state().running, false);
});

test('app.js entrega ao live.js os três timers de 5 s de antes; o P2 roda a lista só na caixa e a Equipe só na tela dela (âncora live-tasks)', async () => {
  const clock = fakeClock(), polls = [], toasts = [], registry = createLiveRegistry();
  const state = { view: 'inbox', busy: false };
  provideLiveContext(() => ({ view: state.view }), registry);
  const sandbox = {
    state, pollInbox: () => polls.push('inbox'), contactRefresh: { refresh: () => { polls.push('contacts'); return Promise.resolve(false); } },
    teamChatUI: { poll: () => { polls.push('team'); return Promise.reject(new Error('Equipe indisponível')); } }, toast: (message, error) => toasts.push([message, error]),
    attention: createAttention(), live: null, createLive: options => createLive({ ...options, timers: clock, now: clock.now, registry, document: quietPage, window: null, navigator: {} })
  };
  runInNewContext(excerpt('live-tasks'), sandbox);
  assert.deepEqual(plain(sandbox.live.state().tasks), [{ name: 'inbox', every: 5000 }, { name: 'contacts', every: 5000 }, { name: 'team-chat', every: 5000 }]);
  assert.equal(sandbox.live.state().running, true, 'live.start() já rodou');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  clock.advance(5000); await settle();
  assert.deepEqual(polls, ['inbox', 'contacts'], 'na caixa: lista e contatos; a Equipe espera a própria tela');
  state.view = 'team-chat'; state.busy = true; sandbox.live.touch(); clock.advance(5000); await settle();
  state.busy = false; clock.advance(5000); await settle();
  assert.deepEqual(polls, ['inbox', 'contacts', 'contacts', 'contacts', 'team'], 'a guarda de ocupado do chat da equipe continua em app.js');
  assert.deepEqual(toasts, [['Equipe indisponível', true]]);
  assert.doesNotMatch(app, /\nsetInterval\(/, 'nenhum setInterval solto em app.js');
  sandbox.live.stop();
});

test('sessionExpired: interrompe, descarta e abre o login nesta ordem (comportamento de hoje)', async () => {
  const order = [];
  assert.equal(sessionExpired({ abort: () => order.push('abort'), discard: () => order.push('discard'), location: { assign: url => order.push(url) } }), true);
  assert.deepEqual(order, ['abort', 'discard', '/login?reason=session-expired']);
  const encoded = [];
  sessionExpired({ reason: 'a b&c', location: { assign: url => encoded.push(url) } });
  assert.deepEqual(encoded, ['/login?reason=a%20b%26c']);
  const api = excerpt('api'), media = excerpt('media-ui'),callbacks=[],state={boot:{session:{userId:'own-operator'}},sendIntent:{id:'own-unsent'}};
  let initial;
  const apiGlobals={...i18n,state,Response,fetch:async()=>new Response('{}',{status:401}),
    channelVisitorTestUI:{reset(){callbacks.push('visitor');}},
    contactLinksUI:{reset(){callbacks.push('links');}},contactRefresh:{reset(){callbacks.push('contacts');}},memoryUI:{reset(){callbacks.push('memory');}},mediaUI:{reset(){callbacks.push('media');}},
    sessionExpired(options){initial=Boolean(options.initial);options.abort();options.discard();callbacks.push('login');}
  };
  apiGlobals.readJsonResponse=createJsonRead({fetch:(...args)=>apiGlobals.fetch(...args)});
  const servedApi=runInNewContext(api+'\napi',apiGlobals);
  await assert.rejects(servedApi('/api/auth/me'),error=>error.status===401);
  assert.equal(initial,false);assert.deepEqual(callbacks,['visitor','links','contacts','memory','media','login']);assert.equal(state.sendIntent,null);assert.equal(state.refreshSequence,1);assert.equal(state.scopedRunsEpoch,1);
  assert.doesNotMatch(api + media, /location\.assign/, 'o 401 não navega por conta própria: session-guard.js decide');
});

test('drafts-store: limite, texto vazio remove, retenção só da empresa e limpeza; o inbox cria um por escopo', () => {
  const store = createDraftsStore({ userId: 'u', workspaceId: 'w', limit: 2 });
  assert.equal(store.set({ tenantId: 'a', conversationId: 'c1' }, 'Um'), true);
  assert.equal(store.set({ tenantId: 'b', id: 'c1' }, 'Dois'), true);
  assert.equal(store.set({ tenantId: 'a', conversationId: 'c2' }, 'Três'), false, 'limite de conversas');
  assert.equal(store.set({ tenantId: 'a', conversationId: 'c1' }, 'Um editado'), true, 'editar não conta como nova');
  assert.equal(store.get({ tenantId: 'a', conversationId: 'c1' }), 'Um editado'); assert.equal(store.get({ tenantId: 'b', conversationId: 'c1' }), 'Dois');
  store.retain('a', []); assert.equal(store.get({ tenantId: 'a', conversationId: 'c1' }), ''); assert.equal(store.size, 1);
  store.set({ tenantId: 'b', conversationId: 'c1' }, ''); assert.equal(store.size, 0);
  store.set({ tenantId: 'b', conversationId: 'c9' }, 'Nove'); store.clear(); assert.equal(store.size, 0);
  const created = [];
  let context = { workspaceId: 'w-1', userId: 'u-1', authorityKey: 'k' };
  const inbox = createConsolidatedInboxUI({ context: () => context, request: async () => assert.fail('sem lista'), draftLimit: 7,
    draftsStore: options => { const own = createDraftsStore(options), clear = own.clear; own.clear = () => { created.push(['clear', options.workspaceId]); clear(); }; created.push(['create', options.userId, options.workspaceId, options.limit]); return own; } });
  assert.equal(inbox.getDraft({ workspaceId: 'w-1', tenantId: 't', conversationId: 'c' }), '');
  inbox.saveDraft({ workspaceId: 'w-1', tenantId: 't', conversationId: 'c' }, 'Rascunho');
  assert.equal(inbox.getDraft({ workspaceId: 'w-1', tenantId: 't', conversationId: 'c' }), 'Rascunho');
  assert.equal(inbox.getDraft({ workspaceId: 'w-2', tenantId: 't', conversationId: 'c' }), '', 'outro workspace nunca lê os rascunhos deste');
  context = { ...context, workspaceId: 'w-2' };
  inbox.saveDraft({ workspaceId: 'w-2', tenantId: 't', conversationId: 'c' }, 'Outro');
  assert.deepEqual(created, [['create', 'u-1', 'w-1', 7], ['clear', 'w-1'], ['create', 'u-1', 'w-2', 7]]);
  assert.equal(inbox.draftCount, 1);
});

test('data-source: os três GETs do poll de hoje, com o cabeçalho do workspace e o sinal só quando existe', async () => {
  const calls = [], source = createDataSource({ request: async (path, options) => { calls.push([path, options]); return { ok: path }; } });
  const signal = new AbortController().signal;
  await source.inboxPage('/api/inbox?status=active', { workspaceId: 'w' });
  await source.tenant('t a', { workspaceId: 'w', conversationId: 'c' });
  await source.conversation('t a', 'c/1', { workspaceId: 'w', signal });
  assert.deepEqual(calls[0], ['/api/inbox?status=active', { headers: { 'X-Elozi-Workspace': 'w' } }]);
  assert.deepEqual(calls[1], ['/api/tenants/t%20a', { headers: { 'X-Elozi-Workspace': 'w' } }]);
  assert.equal(calls[2][0], '/api/tenants/t%20a/conversations/c%2F1/runs'); assert.equal(calls[2][1].signal, signal); assert.deepEqual(calls[2][1].headers, { 'X-Elozi-Workspace': 'w' });
  assert.throws(() => createDataSource({}), /request/);
  const pages = [], inbox = createConsolidatedInboxUI({ context: () => ({ workspaceId: 'w', userId: 'u' }), request: async () => assert.fail('a lista usa o dataSource'),
    dataSource: { inboxPage: async (path, options) => { pages.push([path, options]); return { workspaceId: 'w', items: [], total: 0, offset: 0, limit: 50, hasMore: false, countTabs: {}, counts: {} }; } } });
  await inbox.load({ status: 'active' });
  assert.equal(pages.length, 1); assert.match(pages[0][0], /^\/api\/inbox\?/); assert.deepEqual(pages[0][1], { workspaceId: 'w' });
  assert.match(excerpt('poll-inbox'), /dataSource\.tenant\(tenantId,\{workspaceId,conversationId\}\)/);
  assert.match(excerpt('scoped-runs'), /dataSource\.conversation\(context\.tenantId, context\.conversationId, \{ workspaceId: context\.workspaceId, signal: context\.controller\.signal \}\)/);
});

test('composerBridge: lê e escreve #message-text como digitação e recusa campo ausente ou desabilitado', () => {
  const events = [];
  const field = { value: '', disabled: false, focused: 0, focus() { this.focused++; }, dispatchEvent: event => events.push([event.type, event.bubbles]) };
  let mode = 'reply';
  const doc = { querySelector: selector => selector === '#message-text' ? field : null };
  const bridge = createComposerBridge({ doc, getMode: () => mode });
  assert.equal(bridge.getText(), '');
  assert.equal(bridge.setText('Olá, Maria.'), true); assert.equal(field.value, 'Olá, Maria.');
  assert.equal(bridge.setText('Seu pedido saiu hoje.', { mode: 'append' }), true); assert.equal(field.value, 'Olá, Maria.\nSeu pedido saiu hoje.');
  assert.equal(bridge.setText('Substituído', { mode: 'replace' }), true); assert.equal(bridge.getText(), 'Substituído');
  assert.deepEqual(events, [['input', true], ['input', true], ['input', true]], 'app.js atualiza rascunho e contador pelo input');
  assert.equal(bridge.focus(), true); assert.equal(field.focused, 1);
  assert.equal(bridge.flash(), false, 'o lampejo de 400 ms chega com o P3');
  assert.equal(bridge.mode, 'reply'); mode = 'note'; assert.equal(bridge.mode, 'note');
  field.disabled = true; assert.equal(bridge.setText('Não'), false); assert.equal(field.value, 'Substituído');
  const empty = createComposerBridge({ doc: { querySelector: () => null } });
  assert.equal(empty.getText(), ''); assert.equal(empty.setText('x'), false); assert.equal(empty.focus(), false);
});

// ---------------------------------------------------------------------------------------------
// 4. Agent rail split out of mcp-ui.js

function railFixture() {
  const state = { workspaceId: 'w', boot: { session: { role: 'operator', userId: 'p' } }, conversation: 'c', tenant: { id: 't', conversations: [{ id: 'c', version: 3, assignedUserId: 'p' }], agents: [], runs: [] } };
  const rail = createAgentRail({ state, escape, icon: () => '', badge: text => `<b>${escape(text)}</b>`, api: async () => ({}), tenantApi: tail => '/api/tenants/t/' + tail,
    canReplyTo: conversation => conversation?.assignedUserId === 'p', runNames: { draft: 'Rascunho pronto', running: 'Preparando' }, renderRuns() {}, toast() {},
    knowledgeReferences: run => `<k data-run="${run.id}"></k>`, memoryReferences: run => `<m data-run="${run.id}"></m>` });
  return { state, rail };
}

test('trilho do agente: contrato do §8.2; o P4 mostra o rascunho mais recente e a execução ativa, cada um com as suas fontes', () => {
  const { state, rail } = railFixture();
  for (const key of ['render', 'timelineItems', 'contextTab', 'listGlyph', 'act', 'reset']) assert.equal(typeof rail[key], 'function', key);
  assert.deepEqual([...activeRunStates].sort(), ['queued', 'running', 'tool_running', 'waiting_approval']);
  const run = (id, runState, conversationId = 'c') => ({ id, state: runState, conversationId, conversationVersion: 3, draft: runState === 'draft' ? 'Texto ' + id : null, agentName: 'Hermes', actorName: 'Pessoa' });
  state.tenant.runs = [run('old', 'draft'), run('r1', 'failed'), run('r2', 'draft'), run('a1', 'running'), run('other', 'draft', 'c-2')];
  // P4 (§5.2.3, SafeHTML): approval > draft > status; a failure older than the latest draft leaves the rail.
  const markup = String(rail.render(state.tenant.conversations[0]));
  assert.deepEqual([...markup.matchAll(/<section class="[^"]+" data-rail-run="([^"]+)"/g)].map(match => match[1]), ['r2', 'a1']);
  assert.match(markup, /^<div class="pg-rail" data-rail-root data-conversation-id="c"><section class="ui-draft" data-rail-run="r2"[\s\S]*<div class="ui-draft__sources"><k data-run="r2"><\/k><m data-run="r2"><\/m><\/div>/);
  assert.deepEqual(rail.timelineItems(state.tenant.conversations[0]), []);
  assert.match(String(rail.contextTab(state.tenant.conversations[0])), /^<section class="pg-rail-tab" data-rail-tab data-conversation-id="c">/, 'aba Agente do contexto');
  assert.equal(String(rail.listGlyph({})), '');
  assert.match(excerpt('scoped-runs-context'), /<div id="copilot-runs" aria-live="polite">\$\{agentRail\.render\(conversation\)\}<\/div>/, 'app.js mantém só o anfitrião');
});

test('ações e formulário de execução saíram do mcp-ui.js: o trilho responde, o mcp-ui fica com servidores, concessões e uso', async () => {
  const { rail } = railFixture();
  assert.equal(await rail.act('mcp-discover', 'server'), false); assert.equal(await rail.act('rail:anything'), false);
  await assert.rejects(rail.act('mcp-approve', 'missing'), /não corresponde ao atendimento atual/);
  assert.equal(await rail.submit({ dataset: { dialogForm: 'mcp-server' } }), false);
  assert.equal('activeRunStates' in mcpModule, false);
  const mcp = mcpModule.createMcpUI({ state: { boot: { session: { role: 'reseller' } } }, escape, icon: () => '', badge: () => '', api: async () => ({}), tenantApi: tail => tail });
  assert.deepEqual(Object.keys(mcp).sort(), ['act', 'loadUsage', 'mountUsage', 'onUsage', 'panel', 'reset', 'submit', 'summary', 'usagePanel', 'usageSnapshot'], 'P5: o hub lê o consumo em cache (usageSnapshot, onUsage)');
  const mcpSource = publicSource('mcp-ui.js');
  for (const gone of ['runCard', 'openRun', 'mcp-approve', 'mcp-regenerate', "'mcp-run'", 'decisions.', 'runEditor']) assert.ok(!mcpSource.includes(gone), `${gone} pertence ao trilho`);
  const modalSubmit = excerpt('modal-submit');
  assert.ok(modalSubmit.indexOf("form.dataset.dialogForm?.startsWith('mcp-')&&await agentRail.submit(form)") < modalSubmit.indexOf('mcpUI.submit(form)'));
});

// ---------------------------------------------------------------------------------------------
// 5. Stubs pre-registered for P2–P8, with today's behaviour

test('P2: atenção sem fonte nunca é zero falso; notificação, conexão, teclado e paleta com o comportamento de hoje', async () => {
  const attention = createAttention({ request: async () => assert.fail('o P1 não consulta atenção') });
  assert.deepEqual(await attention.refresh(), EMPTY_ATTENTION); assert.equal(attention.snapshot(), EMPTY_ATTENTION);
  for (const [key, value] of Object.entries(EMPTY_ATTENTION)) assert.equal(value, null, `${key} indisponível, não zero`);
  const unsubscribe = attention.subscribe(() => {}); assert.equal(typeof unsubscribe, 'function'); assert.equal(unsubscribe(), true);
  assert.throws(() => attention.subscribe('x'), /function/);
  assert.equal(createNotify({ attention }).apply(), false); assert.equal(createNotify().enabled(), false);
  const slot = { hidden: false }, connection = createConnectionStatus({ live: { state: () => ({ connection: null }) } });
  assert.equal(connection.apply({ querySelector: selector => selector === '[data-shell-slot="connection"]' ? slot : null }), false);
  assert.equal(slot.hidden, true, 'o espaço do indicador continua oculto'); assert.equal(connection.state(), null);
  const keys = createKeyboard();
  assert.equal(keys.scope, 'global'); assert.equal(keys.setScope('inbox'), 'inbox'); assert.equal(keys.scope, 'inbox'); assert.equal(keys.setScope(''), 'global');
  const remove = keys.registerScope('list', { j() {} }); assert.equal(typeof remove, 'function'); remove();
  assert.equal(keys.singleKeyEnabled(), false, 'nenhum atalho de uma tecla no P1'); assert.equal(typeof keyboard.setScope, 'function');
  let opened = 0;
  const palette = createCommandPalette({ getItems: () => [], getAuthority: () => 'a', openModal: () => { opened++; }, getModal: () => ({ open: false, querySelector: () => ({ addEventListener() {}, focus() {} }), addEventListener() {} }), navigate() {}, escape, icon: () => '' });
  const event = { key: 'k', ctrlKey: true, repeat: false, altKey: false, prevented: 0, preventDefault() { this.prevented++; } };
  palette.keydown(event);
  assert.equal(opened, 1); assert.equal(event.prevented, 1, 'Ctrl+K abre o localizador de hoje');
  assert.match(app, /const navigationSearch = createCommandPalette\(\{/);
});

test('P3: a lista nasce no inbox-list-ui (linhas por chave) e o patch troca no lugar o que ainda é redesenhado inteiro', () => {
  const options = { data: { workspaceId: 'w', items: [{ tenantId: 't', id: 'c', conversationId: 'c', contact: 'Maria', tenantName: 'Loja', channelName: 'WhatsApp', updatedAt: '2026-10-06T10:00:00Z', status: 'open', unread: 2 }], total: 1, offset: 0, limit: 50, hasMore: false, tenants: [], channels: [{ tenantId: 't', id: 'ch', state: 'connected' }], departments: [], assignees: [], countTabs: { all: 1 }, counts: {} },
    filters: { inboxCompany: 'all', channel: 'all', department: 'all', assignedUser: 'all', filter: 'all', status: 'active', kind: 'all', sort: 'recent', search: '' },
    workspaceId: 'w', userId: 'u', tenants: [] };
  const markup = String(inboxListMarkup(options));
  assert.match(markup, /role="listbox"/); assert.match(markup, /role="option" id="row-t-c"/); assert.match(markup, /data-inbox-tenant="t"/); assert.match(markup, /data-conversation="c"/);
  assert.ok(consolidatedListMarkup({ ...options, escape, icon: () => '', badge: text => text, avatar: () => '' }).length > 0, 'o renderizador antigo continua disponível até o P10');
  const replaced = [], fresh = { tag: 'section' };
  const element = { isConnected: true, ownerDocument: { createElement: () => ({ set innerHTML(value) { this.html = value; }, content: { get firstElementChild() { return fresh; } } }) }, replaceWith: node => replaced.push(node) };
  assert.equal(replaceWithMarkup(element, '<section></section>'), fresh); assert.deepEqual(replaced, [fresh]);
  assert.equal(replaceWithMarkup({ ...element, isConnected: false }, '<p></p>'), null);
  assert.equal(replaceWithMarkup({ ...element, ownerDocument: { createElement: () => ({ content: {} }) } }, ''), null);
});

test('P5–P8: telas pré-registradas cumprem {view, act, submit, reset} e não têm ações próprias no P1', async () => {
  const screens = {
    agents: createAgentsHub({ state: { boot: { session: { role: 'operator' } }, tenant: { agents: [] } }, escape, icon: () => '', button: () => '', pageHeading, agentCard: () => '', renderAgentAdminProposals: () => '', renderSupportAssistant: () => '' }),
    detail: createAgentDetail(), channels: createChannelsUI({ state: { boot: { session: { role: 'operator' } }, tenant: { name: 'E' } }, escape, icon: () => '', badge: () => '', button: () => '', pageHeading, channels: () => [], channelRows: () => '' }),
    connect: createAgentConnectWizard({ pageHeading, principals: () => '' }), pending: createPending({ pageHeading }), setup: createOnboarding({ pageHeading }),
    settings: createSettings({ legacy: key => `<section>${key}</section>` })
  };
  for (const [name, screen] of Object.entries(screens)) {
    for (const key of SCREEN_CONTRACT) assert.equal(typeof screen[key], 'function', `${name}.${key}`);
    assert.equal(await screen.act(`${name}:anything`, 'id'), false); assert.equal(await screen.submit({ dataset: { form: `${name}:x` } }), false); assert.equal(screen.reset(), undefined);
  }
  assert.deepEqual(screens.pending.drawerSections(EMPTY_ATTENTION), [], 'gaveta sem seções até o P6 ligar as fontes');
  assert.match(screens.detail.view(route('#agents/agent-1/instructions')), /<h1 class="pg-agents__h1">Agente não encontrado<\/h1>/, 'P5: detalhe honesto sem o agente');
  assert.equal(screens.settings.view(route('#settings/team')), '<section>team</section>');
  // P8 delivered Saúde e versão: without the platform owner session the screen is the restricted notice, never the legacy view.
  assert.match(screens.settings.view(route('#platform/health')), /Esta área é exclusiva do dono da plataforma\./);
  assert.equal(screens.settings.view(route('#platform')), '<section>platform</section>', 'hub sem aba abre a primeira');
  assert.match(String(createAgentUsage().view()), /Medição disponível em breve/, 'P5: uso sem fonte é "em breve", nunca zero');
  const opened = [], flow = createChannelConnectFlow({ connectWhatsApp: async id => opened.push(['qr', id]), connectTelegram: async id => opened.push(['bot', id]), configure: async channel => opened.push(['connector', channel.id]) });
  assert.equal(await flow.open({ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }), true);
  assert.equal(await flow.open({ id: 'tg', kind: 'telegram', transport: 'telegram-bot' }), true);
  assert.equal(await flow.open({ id: 'site', kind: 'webchat', transport: 'elozi-webchat' }), true);
  assert.equal(await flow.open({ id: 'x', kind: 'whatsapp_cloud', transport: 'future' }), false); assert.equal(await flow.open(null), false);
  assert.deepEqual(opened, [['qr', 'wa'], ['bot', 'tg'], ['connector', 'site']]);
});

test('#pending e #setup: rotas próprias fora do menu e da busca, com aviso honesto em PT e EN', () => {
  const ctx = (session, { supportGrantId = null, hasTenant = true } = {}) => nav.navContext({ session, supportGrantId, hasTenant, accountKind: 'reseller' });
  const people = [ctx({ role: 'reseller', platformOwner: true }), ctx({ role: 'reseller' }), ctx({ role: 'operator', permissions: [] }), ctx({ role: 'operator', permissions: ['inbox.read'] }, { supportGrantId: 'g' })];
  for (const person of people) {
    assert.equal(nav.legacyRouteAllowed('pending', person), true, 'Pendências é de todos os papéis, inclusive o suporte temporário');
    assert.equal(nav.legacyRouteAllowed('setup', person), true);
    assert.equal(nav.legacyVisible('pending', person) || nav.legacyVisible('setup', person), false, 'fora do menu e da busca de áreas');
    assert.ok(!menuEntries(person, 'pending').some(entry => ['pending', 'setup'].includes(entry.view)));
    assert.equal(nav.resolveView('pending', person), 'pending');
  }
  const noCompany = ctx({ role: 'operator', permissions: [] }, { hasTenant: false });
  assert.equal(nav.resolveView('pending', noCompany), 'account', 'Pendências exige uma empresa, como o sino'); assert.equal(nav.resolveView('setup', noCompany), 'setup');
  assert.equal(nav.LEGACY_KEYS.includes('pending'), false, 'as 25 views legadas e o oráculo não mudam');
  assert.match(app, /\['pending','Pendências','bell'\], \['setup','Primeiro uso','check'\]/, 'o título "Tela · Marca" conhece as telas novas');
  for (const language of ['pt-BR', 'en']) {
    locale(language);
    const pending = createPending({ pageHeading }).view(route('#pending')), setup = createOnboarding({ pageHeading }).view(route('#setup'));
    assert.match(pending, language === 'en' ? /<h1>Pending<\/h1>[\s\S]*The pending list is not available in this version yet\./ : /<h1>Pendências<\/h1>[\s\S]*A lista de pendências ainda não está disponível nesta versão\./);
    assert.match(pending, /<button type="button" class="ui-btn ui-btn--primary ui-btn--md" data-action="shell:pending">/, 'leva à prioridade de atendimento pelo mesmo caminho do sino');
    assert.match(setup, language === 'en' ? /<h1>First steps<\/h1>[\s\S]*The first-steps guide is not available in this version yet\./ : /<h1>Primeiro uso<\/h1>[\s\S]*O guia de primeiro uso ainda não está disponível nesta versão\./);
    assert.match(setup, /data-view="overview"/);
  }
});

test('mcp-catalog: cada ferramenta elozi_* e sua capacidade conferem com src/service-mcp.js, na ordem do servidor', () => {
  const server = readFileSync(new URL('../src/service-mcp.js', import.meta.url), 'utf8');
  const definitions = [...server.matchAll(/\{\s*name:\s*'(elozi_[a-z_]+)'([^}]*?)description:/g)].map(match => [match[1], /capability:\s*'([a-z.]+)'/.exec(match[2])?.[1] || null]);
  assert.ok(definitions.length >= 15, 'definições lidas do servidor');
  const catalog = [...MCP_ALWAYS_TOOLS.map(name => [name, null]), ...MCP_CAPABILITIES.flatMap(capability => MCP_CAPABILITY_TOOLS[capability].map(name => [name, capability]))];
  assert.deepEqual(catalog, definitions, 'mesmos nomes, mesmas capacidades, mesma ordem');
  assert.deepEqual([...MCP_CAPABILITIES,...REST_ONLY_CAPABILITIES].sort(), [...SERVICE_CAPABILITIES].sort(), 'capacidades MCP e REST implementadas em src/service-principals.js');
  assert.deepEqual(toolsForCapabilities(['company.propose', 'conversation.read']), ['elozi_me', 'elozi_get_receipt', 'elozi_read_conversation', 'elozi_read_attachment', 'elozi_list_conversations', 'elozi_search_conversations', 'elozi_read_conversation_history', 'elozi_list_groups', 'elozi_read_group_history', 'elozi_propose_flow', 'elozi_propose_agent']);
  assert.deepEqual(toolsForCapabilities(), ['elozi_me', 'elozi_get_receipt']);
  assert.equal(capabilityOfTool('elozi_send_group_message'), 'reply.send'); assert.equal(capabilityOfTool('elozi_me'), null); assert.equal(capabilityOfTool('outra'), null);
  assert.deepEqual(MCP_DIRECT_ACTIONS, ['reply.send', 'message.schedule']);
});

test('arquivos pré-registrados para P2–P8: servidos, folhas novas no index.html e catálogos que nascem vazios', async () => {
  const files = {
    P2: ['live.js', 'connection-status.js', 'session-guard.js', 'drafts-store.js', 'data-source.js', 'attention.js', 'notify.js', 'keyboard.js', 'command-palette.js', 'live.css', 'locales-live.js'],
    P3: ['inbox-list-ui.js', 'composer-ui.js', 'dom-patch.js', 'screen-inbox.css', 'locales-inbox.js'],
    P4: ['agent-rail-ui.js', 'agent-rail.css', 'locales-agent-rail.js'],
    P5: ['agents-hub-ui.js', 'agent-detail-ui.js', 'agent-usage-ui.js', 'screen-agents.css', 'locales-agents-hub.js'],
    P6: ['agent-connect-wizard.js', 'pending-ui.js', 'mcp-catalog.js', 'agent-connect.css', 'locales-agent-connect.js'],
    P7: ['channels-ui.js', 'channel-connect-flow.js', 'channel-visitor-test-ui.js', 'channel-visitor-test.css', 'onboarding-ui.js', 'screen-home.css', 'screen-channels.css', 'locales-home.js'],
    P8: ['settings-ui.js', 'screen-settings.css', 'locales-settings.js'],
    P1: ['actions.js']
  };
  for (const [owner, list] of Object.entries(files)) for (const file of list) assert.ok(PANEL_ASSETS.includes(file), `${owner}: ${file} na allowlist única`);
  const links = [...publicSource('index.html').matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map(match => match[1]);
  assert.deepEqual(links.slice(0, 13), ['tokens.css', 'base.css', 'components.css', 'shell.css', 'live.css', 'screen-inbox.css', 'agent-rail.css', 'screen-agents.css', 'agent-connect.css', 'screen-home.css', 'screen-channels.css', 'channel-visitor-test.css', 'screen-settings.css']);
  // Delivered sheets (P2 live, P3 inbox, P4 rail, P5 agents, P6 connect, P7 home and channels, P8 settings)
  // are checked below; a stub of a package still to come would keep the empty layer.
  const deliveredSheets = ['screen-inbox.css', 'live.css', 'screen-agents.css', 'agent-rail.css', 'agent-connect.css', 'screen-home.css', 'screen-channels.css', 'channel-visitor-test.css', 'screen-settings.css'];
  for (const sheet of links.slice(4, 13).filter(sheet => !deliveredSheets.includes(sheet))) assert.match(publicSource(sheet), /\n@layer (?:shell|screens) \{\n\}\n$/, `${sheet}: camada nova e vazia`);
  for (const sheet of ['agent-connect.css', 'screen-home.css', 'screen-channels.css', 'screen-settings.css']) assert.match(publicSource(sheet), /\n@layer screens \{\n[\s\S]+\}\n$/, `${sheet}: camada screens entregue`);
  assert.match(publicSource('channel-visitor-test.css'), /^@layer components \{\n[\s\S]+\}\n$/, 'channel-visitor-test.css: componente de teste visitante entregue');
  assert.match(publicSource('agent-rail.css'), /\n@layer components \{\n[\s\S]+\n\}\n\n@layer screens \{\n[\s\S]+\}\n$/, 'agent-rail.css: componentes e tela do P4');
  assert.match(publicSource('screen-agents.css'), /@layer screens \{\n[\s\S]+\}\n$/, 'screen-agents.css: camada screens do P5');
  assert.match(publicSource('live.css'), /\n@layer shell \{\n[\s\S]+\}\n$/, 'live.css: camada shell do P2');
  assert.match(publicSource('screen-inbox.css'), /@layer screens \{\n[\s\S]+\}\n$/, 'screen-inbox.css: camada screens do P3');
  const coverage = readFileSync(new URL('./i18n-coverage.test.js', import.meta.url), 'utf8');
  // Execute the scanner's actual catalog selector. Literal owner names are no
  // longer its contract: every explicit catalog, including a new one, must match.
  const declaration = coverage.match(/const catalogs = ([\s\S]*?);/);
  assert.ok(declaration, 'coverage exposes its actual catalog selection');
  const expression = declaration[1].replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  const candidates = [...readdirSync(new URL('../public/', import.meta.url)), 'locales-seam-regression.js', 'locales-seam-regression.js.map', 'not-a-catalog.js'];
  const selected = await new Function('readdir', 'URL', `return (async()=>(${expression}))();`)(async () => candidates, URL);
  assert.ok(selected.includes('locales-seam-regression.js'), 'a new explicit catalog cannot be silently omitted');
  assert.equal(selected.includes('locales-seam-regression.js.map'), false);
  assert.equal(selected.includes('not-a-catalog.js'), false);
  for (const name of ['live', 'inbox', 'agent-rail', 'agents-hub', 'agent-connect', 'home', 'settings']) {
    const source = publicSource(`locales-${name}.js`);
    if (!['inbox', 'live', 'agents-hub', 'agent-rail', 'agent-connect', 'home', 'settings'].includes(name)) assert.match(source, /\nregisterTranslations\(\{\}\);\n$/, `locales-${name}.js nasce vazio`);
    else assert.doesNotMatch(source, /registerTranslations\(\{\}\)/, `locales-${name}.js: catálogo EN entregue`);
    if (name === 'agent-rail') assert.match(source, /\nregisterTranslations\(agentRailTranslations\);\n$/, 'locales-agent-rail.js: catálogo EN do P4');
    if (name === 'settings') assert.match(source, /\nregisterTranslations\(settingsTranslations\);\n$/, 'locales-settings.js: catálogo EN do P8');
    assert.ok(selected.includes(`locales-${name}.js`), `locales-${name}.js na lista real da cobertura`);
  }
});
