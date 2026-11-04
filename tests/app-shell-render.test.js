// Persistent shell and screen transitions of public/app.js (FRONTEND-V2 §6, §7.5, §8.11, P10-B).
//
// The served render() (anchor navigation-heading) runs over a real parse of the markup (helpers/inbox-dom.js):
// the frame (sidebar, topbar, bottom bar) is drawn once per signature and keeps its nodes across routes,
// <main> is a new node per render, and the prologue keeps the composer draft, the internal note and the
// attachment of the conversation across navigation and re-renders. The served navigate() and applyRoute()
// (anchors navigate and route-sync) draw a new screen inside document.startViewTransition only when the
// browser has it and motion is allowed; polls and re-renders of the same screen never go through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';
import { screenFrame } from '../public/settings-ui.js';
import { applyBrandTokens, deriveBrandTokens } from '../public/brand-theme.js';
import { syncThemePrefs } from '../public/theme-prefs.js';
import { createMediaUI } from '../public/media-ui.js';
import { createInternalNoteDrafts } from '../public/attendance-ui.js';
import { createConsolidatedInboxUI, inboxIdentity } from '../public/consolidated-inbox-ui.js';
import { excerpt } from './helpers/app-source.js';
import { createDocument } from './helpers/inbox-dom.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const roleLabel = source.split('\n').find(line => line.startsWith('const roleLabel = '));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));

const ADMIN = { userId: 'admin-qa', role: 'reseller', permissions: null, name: 'Admin QA', presence: 'available' };

// The served render() over a parsed document. `views` draw small screens; the inbox one has the composer,
// the internal note and the attachment of the conversation, as conversationPane() does.
function served({ view = 'overview', mobile = false, wide = true, xwide = false } = {}) {
  const document = createDocument('<div id="app"></div>');
  document.title = '';
  const units = [{ id: 'store-centro', name: 'Loja Centro' }, { id: 'store-norte', name: 'Loja Norte' }];
  const conversations = [{ id: 'case-a', contact: 'Cliente A', channelId: 'tg-a', status: 'open', messages: [] }];
  const state = {
    view, workspaceId: 'acme', supportGrantId: null, conversation: 'case-a', sendIntent: null, menuOpen: false,
    boot: { version: '0.48.0', csrfToken: 'csrf-qa', tenants: units, reseller: { id: 'acme', name: 'Acme Revenda', accountKind: 'reseller', brand: { name: 'Acme Atendimento', initials: 'AC', accent: '#e11d48', logo: '' } },
      workspaces: [{ id: 'acme', name: 'Acme Revenda' }, { id: 'client-b', name: 'Cliente B' }], session: { resellerId: 'acme', ...ADMIN } },
    tenant: { ...units[0], conversations, channels: [{ id: 'tg-a', transport: 'telegram-bot', state: 'connected' }] },
    account: { google: { enabled: false }, user: { googleLinked: false } }
  };
  const attendanceContext = () => ({ workspaceId: state.workspaceId, tenantId: state.tenant?.id, userId: state.boot.session.userId, conversationId: state.conversation, active: state.view === 'inbox', canReply: true, channels: state.tenant?.channels || [], authorityKey: 'authority-qa' });
  const mediaUI = createMediaUI({ escape, icon: () => '', download: async () => assert.fail('nenhum download'), getPendingSend: () => Boolean(state.sendIntent) });
  const noteDrafts = createInternalNoteDrafts();
  const consolidatedInbox = createConsolidatedInboxUI({ request: async () => assert.fail('render não consulta a caixa'), context: () => ({ workspaceId: state.workspaceId, userId: state.boot.session.userId, authorityKey: 'authority-qa' }) });
  // Twelve lines next to the screen's section give <main> something to scroll (inbox-dom: 100 px per child);
  // the screen's own data-view link must not confuse the menu's aria-current.
  const screen = name => () => `<section data-rendered-view="${name}"><h1>Tela ${name}</h1><a href="#inbox" data-view="inbox">Abrir atendimento</a></section>${Array.from({ length: 12 }, (_, index) => `<p>linha ${index}</p>`).join('')}`;
  const views = Object.fromEntries(nav.LEGACY_KEYS.map(key => [key, screen(key)]));
  views.inbox = () => `<section data-rendered-view="inbox"><h1>Atendimento</h1><form id="message-form"><textarea id="message-text"></textarea><p data-attachment>${escape(mediaUI.selected?.file.name || '')}</p></form><form id="internal-note-form"><textarea id="internal-note-text">${escape(noteDrafts.value)}</textarea></form></section>`;
  const queries = { [shell.SHELL_MOBILE_QUERY]: mobile, [shell.SHELL_WIDE_QUERY]: wide, [shell.SHELL_XWIDE_QUERY]: xwide };
  const calls = { closes: 0, sheets: 0, afterRender: [], visitorSync: [] };
  const globals = {
    ...i18n, ...nav, ...shell, screenFrame, state, views, escape, document, applyBrandTokens, deriveBrandTokens, syncThemePrefs, inboxIdentity,
    $: selector => document.querySelector(selector), matchMedia: query => ({ matches: Boolean(queries[query]) }), location: { hash: '#overview' },
    hasPermission: () => true, attendanceContext, mediaUI, noteDrafts, consolidatedInbox,
    channelVisitorTestUI: { syncContext() { calls.visitorSync.push(state.view); }, reset() {} },
    syncAttendanceTools: () => noteDrafts.sync({ ...attendanceContext(), allowedIds: state.tenant.conversations.map(c => c.id) }),
    commercialUsageUI: { syncContext() {} }, memoryUI: { syncContext() {} }, groupsWorkspaceUI: { syncContext() {}, bind: async () => {} }, telegramAccountUI: { sync() {} },
    forwarding: { close() {} }, repliesUI: { retainConversations() {}, syncContext() {} }, voiceRecorder: { syncContext() {} }, canSendTo: () => true, supportsVoice: () => false,
    chatLayout: { sync() {}, collapsed: false }, avatarUI: { bind() {} }, integrationsUI: { bind() {} }, teamChatUI: { bind() {} }, mcpUI: { mountUsage() {} },
    bindAgentAdminProposals() {}, bindSupportAssistant() {}, bindInboxMedia() {}, composerStatus() {}, refreshScopedConversationRuns: async () => false,
    shellUI: { close: () => { calls.closes++; } }, syncContextSheet: () => { calls.sheets++; }, afterRender: view => calls.afterRender.push(view),
    toast: message => assert.fail('render não deve avisar: ' + message)
  };
  const loaded = runInNewContext([roleLabel, excerpt('inbox-selection-state'), excerpt('navigation-heading'), '({render})'].join('\n'), globals);
  const go = (next, hash = nav.hashForView(next)) => { state.view = next; globals.location.hash = hash; loaded.render(); };
  const frame = () => ({ app: document.querySelector('.sh-app'), sidebar: document.getElementById('sh-sidebar'), topbar: document.querySelector('.sh-topbar'), bottombar: document.querySelector('.sh-bottombar'), banners: document.getElementById('sh-banners') });
  globals.location.hash = nav.hashForView(view); loaded.render();
  return { ...loaded, document, state, globals, calls, mediaUI, noteDrafts, consolidatedInbox, go, frame, main: () => document.getElementById('main-content') };
}

test('o shell persiste entre rotas: mesmos nós de sidebar, topo, barra inferior e faixas; <main> novo a cada tela', () => {
  const f = served();
  const before = f.frame(), firstMain = f.main();
  assert.deepEqual(f.calls.visitorSync, ['overview'], 'render sincroniza o visitante antes de desenhar a tela');
  assert.ok(before.app && before.sidebar && before.topbar && before.bottombar && before.banners);
  assert.equal(before.app.getAttribute('data-view'), 'overview');
  // The live modules patch counters in place; a route change keeps them.
  const counter = before.sidebar.querySelector('[data-shell-count="inbox"]'); counter.textContent = '3'; counter.hidden = false;
  for (const [view, title, crumb, item] of [['contacts', 'Contatos · Acme Atendimento', 'Contatos', 'contacts'], ['team', 'Equipe · Acme Atendimento', 'Equipe', 'tenants'], ['inbox', 'Atendimento · Acme Atendimento', 'Atendimento', 'inbox'], ['overview', 'Visão geral · Acme Atendimento', 'Visão geral', 'overview']]) {
    f.go(view);
    const after = f.frame();
    for (const part of ['app', 'sidebar', 'topbar', 'bottombar', 'banners']) assert.equal(after[part], before[part], `${part} mantém o nó em ${view}`);
    assert.equal(after.app.getAttribute('data-view'), view);
    assert.notEqual(f.main(), firstMain, '<main> é um nó novo');
    assert.equal(f.main().getAttribute('tabindex'), '-1');
    assert.match(f.main().innerHTML, new RegExp(`data-rendered-view="${view}"`));
    assert.equal(f.document.title, title);
    assert.match(f.document.querySelector('.sh-crumbs').textContent, new RegExp(crumb));
    const current = f.document.querySelectorAll('.sh-nav a[aria-current="page"]');
    assert.equal(current.length, 1, `um item atual no menu em ${view}`);
    assert.equal(current[0].getAttribute('data-view'), item, `o item da tela ${view} é o atual`);
    assert.equal(f.main().querySelector('a[data-view]')?.getAttribute('aria-current') ?? null, null, 'links da tela não entram na conta do menu');
    assert.equal(counter.textContent, '3', 'contador patcheado continua');
    assert.equal(f.calls.visitorSync.at(-1), view, 'cada render reconcilia a autoridade e a rota do visitante');
  }
  assert.equal(f.main().className, 'content');
  f.go('inbox');
  assert.equal(f.main().className, 'content inbox-content', 'a classe de <main> segue a tela');
  assert.equal(f.document.querySelector('.sh-scopechip__label').textContent, 'Todas as empresas autorizadas', 'Atendimento é consolidado: o chip do escopo segue a tela');
  assert.equal(f.frame().app.getAttribute('data-sh-layout'), 'rail', 'Atendimento abaixo de 1600 px usa o trilho');
  f.go('overview');
  assert.equal(f.document.querySelector('.sh-scopechip__label').textContent, 'Loja Centro');
  assert.equal(f.frame().app.getAttribute('data-sh-layout'), 'full');
  assert.equal(f.frame().app, before.app);
  assert.ok(f.calls.sheets > 0, 'o estado modal da folha de contexto é refeito sobre o <main> novo');
});

test('assinatura do shell: idioma, marca e menu redesenham o quadro; empresa e tela só atualizam o escopo', () => {
  const f = served();
  const first = f.frame().app;
  f.state.tenant = { id: 'store-norte', name: 'Loja Norte', conversations: [], channels: [] };
  f.go('overview');
  assert.equal(f.frame().app, first, 'trocar de empresa não refaz o quadro');
  assert.match(f.document.querySelector('.sh-scope__line').textContent, /Loja Norte/);
  assert.match(f.document.querySelector('.sh-scopechip__label').textContent, /Loja Norte/);
  f.state.boot.reseller.brand = { name: 'Nova Marca', initials: 'NM', accent: '#0c7370', logo: '' };
  f.go('overview');
  const branded = f.frame().app;
  assert.notEqual(branded, first, 'marca nova: quadro novo'); assert.equal(f.document.querySelector('.sh-scope__brand').textContent, 'Nova Marca');
  assert.equal(f.document.title, 'Visão geral · Nova Marca');
  locale('en'); f.go('overview');
  const english = f.frame().app;
  assert.notEqual(english, branded, 'idioma novo: quadro novo'); assert.match(english.querySelector('.sh-nav').textContent, /Overview/);
  f.state.boot.session = { ...f.state.boot.session, role: 'operator', permissions: ['inbox.read'] };
  f.go('overview');
  assert.notEqual(f.frame().app, english, 'papel e menu novos: quadro novo');
  assert.equal(f.document.querySelector('.sh-nav a[data-view="tenants"]'), null, 'o menu segue o papel');
});

test('popovers, gaveta, presença e rolagem: a tela nova fecha o que era da anterior; a mesma tela preserva', () => {
  const f = served({ mobile: true });
  const sidebar = f.document.getElementById('sh-sidebar');
  f.state.menuOpen = true; f.go('overview');
  assert.equal(sidebar.getAttribute('data-state'), 'open', 'redesenho da mesma tela mantém a gaveta aberta');
  assert.equal(f.calls.closes, 0, 'mesma tela não fecha popover');
  f.state.menuOpen = false; f.go('contacts');
  assert.equal(sidebar.hasAttribute('inert'), true, 'navegar fecha a gaveta (celular: menu inerte)'); assert.equal(sidebar.getAttribute('data-state'), null);
  assert.equal(f.calls.closes, 1, 'tela nova fecha o popover do shell');
  f.state.boot.session.presence = 'away'; f.go('contacts');
  assert.equal(f.document.querySelector('.sh-account__trigger .ui-avatar').getAttribute('data-presence'), 'away', 'presença patcheada sem redesenhar o quadro');
  assert.equal(f.document.getElementById('sh-sidebar'), sidebar);
  const main = f.main(); main.scrollTop = 250;
  f.go('contacts');
  assert.equal(f.main().scrollTop, 250, 'redesenho da mesma tela mantém a rolagem');
  f.main().scrollTop = 120; f.go('contacts', '#contacts/store-centro/contact-1');
  assert.equal(f.main().scrollTop, 0, 'outra rota da mesma view começa do topo');
  f.main().scrollTop = 200; f.go('overview');
  assert.equal(f.main().scrollTop, 0, 'tela nova começa do topo');
});

test('rascunho, nota interna e anexo sobrevivem à navegação e ao redesenho com o shell persistente', () => {
  const f = served({ view: 'inbox' });
  const shellNode = f.frame().app, ref = { workspaceId: 'acme', tenantId: 'store-centro', conversationId: 'case-a' };
  const file = new File(['arquivo sintético'], 'contrato.pdf', { type: 'application/pdf' });
  f.document.getElementById('message-text').value = 'Rascunho para o cliente';
  f.document.getElementById('internal-note-text').value = 'Nota só da equipe';
  f.mediaUI.choose(file, 'Rascunho para o cliente');
  assert.equal(f.mediaUI.selected?.file, file);
  f.go('contacts');
  assert.equal(f.document.getElementById('message-text'), null, 'a caixa saiu da tela');
  assert.equal(f.consolidatedInbox.getDraft(ref), 'Rascunho para o cliente', 'o prólogo guardou o rascunho antes de redesenhar');
  f.go('overview'); f.go('inbox');
  assert.equal(f.document.getElementById('message-text').value, 'Rascunho para o cliente');
  // The note comes back as the content of its <textarea> (the browser's initial value).
  assert.equal(f.document.getElementById('internal-note-text').textContent, 'Nota só da equipe');
  assert.equal(f.mediaUI.selected?.file, file, 'o anexo continua em memória');
  assert.equal(f.document.querySelector('[data-attachment]').textContent, 'contrato.pdf');
  f.document.getElementById('message-text').value = 'Rascunho editado';
  f.document.getElementById('internal-note-text').value = 'Nota editada';
  f.go('inbox');
  assert.equal(f.document.getElementById('message-text').value, 'Rascunho editado', 'redesenho da mesma tela');
  assert.equal(f.document.getElementById('internal-note-text').textContent, 'Nota editada');
  assert.equal(f.mediaUI.selected?.file, file);
  assert.equal(f.frame().app, shellNode, 'o quadro nunca foi refeito');
});

test('render() continua desenhando o quadro inteiro quando não há shell na página (inicialização, troca de workspace)', () => {
  const f = served();
  const first = f.frame().app;
  f.document.getElementById('app').innerHTML = '<div class="loading" role="status">Abrindo o workspace escolhido…</div>';
  f.go('overview');
  assert.ok(f.frame().app && f.frame().app !== first, 'sem .sh-app o quadro é desenhado de novo');
  assert.match(f.main().innerHTML, /data-rendered-view="overview"/);
});

// ---------------------------------------------------------------------------------------------
// Screen transitions (FRONTEND-V2 §6 "Troca de tela"): served navigate() and applyRoute().

function navigation({ startViewTransition = null, motion = true, visibility = 'visible', view = 'overview' } = {}) {
  const effects = [], pending = [], replaced = [];
  const state = { view, workspaceId: 'acme', supportGrantId: null, boot: { session: { userId: 'u' }, tenants: [] }, menuOpen: true, conversation: null, tenant: null };
  const document = { visibilityState: visibility, ...(startViewTransition ? { startViewTransition: update => { const transition = startViewTransition(update, pending); effects.push('transition'); return transition; } } : {}) };
  const idle = { reset() {} };
  const globals = {
    ...nav, state, document, location: { hash: '#overview' }, window: { scrollTo() {}, addEventListener() {} }, history: { state: null, replaceState: (_s, _t, url) => replaced.push(url) },
    motionOK: () => motion, mediaUI: { sending: false }, voiceRecorder: { busy: false }, blockPendingSend: () => false,
    contactLinksUI: idle, platformUsersUI: idle, commercialUsageUI: idle, groupsWorkspaceUI: idle, contactRefresh: { reset() {}, refresh: () => effects.push('contacts-refresh') }, memoryUI: idle, teamChatUI: idle,
    render: () => effects.push('render:' + state.view), focusViewContent: () => effects.push('focus'), loadNavigatedPanels: view => effects.push('panels:' + view),
    refreshInboxList: async () => effects.push('inbox-list'), $: () => ({ addEventListener() {}, scrollTo() {} }), toast: message => effects.push('toast:' + message),
    views: Object.fromEntries([...nav.LEGACY_KEYS, 'pending', 'setup'].map(key => [key, () => ''])), inboxIdentity: () => '', selectedInboxRef: () => null
  };
  const loaded = runInNewContext(excerpt('navigate') + '\n' + excerpt('route-sync') + '\n({navigate,applyRoute,swapScreen})', globals);
  return { ...loaded, state, effects, pending, replaced, globals, flush: () => { while (pending.length) pending.shift()(); } };
}
const deferred = (update, pending) => { pending.push(update); return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() }; };

test('troca de tela por navegação explícita usa startViewTransition só com o recurso e movimento permitido', () => {
  const animated = navigation({ startViewTransition: deferred });
  animated.navigate('contacts');
  assert.equal(animated.globals.location.hash, '#contacts', 'o hash muda na hora');
  assert.deepEqual(animated.effects, ['transition'], 'a tela nova espera o retrato da antiga');
  animated.flush();
  assert.deepEqual(animated.effects, ['transition', 'render:contacts', 'contacts-refresh', 'focus'], 'desenho, dados e foco dentro da transição');
  for (const options of [{}, { startViewTransition: deferred, motion: false }, { startViewTransition: deferred, visibility: 'hidden' }]) {
    const instant = navigation(options);
    instant.navigate('contacts');
    assert.deepEqual(instant.effects, ['render:contacts', 'contacts-refresh', 'focus'], `instantâneo ${JSON.stringify(Object.keys(options))}`);
  }
  const same = navigation({ startViewTransition: deferred, view: 'contacts' });
  same.navigate('contacts');
  assert.deepEqual(same.effects, ['render:contacts', 'contacts-refresh'], 'a mesma tela nunca anima');
});

test('uma navegação mais nova substitui a que ainda não desenhou; falha dentro da transição vira aviso', () => {
  const f = navigation({ startViewTransition: deferred });
  f.navigate('contacts'); f.navigate('channels');
  f.flush();
  assert.deepEqual(f.effects.filter(effect => effect.startsWith('render:')), ['render:channels'], 'só a última tela é desenhada');
  const broken = navigation({ startViewTransition: deferred });
  broken.globals.render = () => { throw new Error('falha sintética'); };
  broken.navigate('contacts'); broken.flush();
  assert.ok(broken.effects.includes('toast:falha sintética'));
  const refused = navigation({ startViewTransition: () => { throw new Error('InvalidStateError'); } });
  refused.navigate('contacts');
  assert.deepEqual(refused.effects, ['render:contacts', 'contacts-refresh', 'focus'], 'sem transição possível, a tela troca na hora');
});

test('rota de outra view (hash) anima a troca e o hash segue a guarda depois do desenho; rota da mesma tela não anima', async () => {
  const f = navigation({ startViewTransition: deferred });
  await f.applyRoute({ section: 'contacts', params: {}, query: {}, workspaceId: null, alias: null });
  assert.deepEqual(f.effects, ['transition']); assert.deepEqual(f.replaced, []);
  f.globals.render = () => { f.effects.push('render:' + f.state.view); f.state.view = 'overview'; };
  f.flush();
  assert.deepEqual(f.replaced, ['#overview'], 'a guarda mandou para Visão geral: o hash acompanha depois do desenho');
  const sync = navigation();
  sync.globals.render = () => { sync.effects.push('render:' + sync.state.view); sync.state.view = 'overview'; };
  await sync.applyRoute({ section: 'contacts', params: {}, query: {}, workspaceId: null, alias: null });
  assert.deepEqual(sync.replaced, ['#overview'], 'sem transição: o hash acompanha uma vez, como antes');
  const inside = navigation({ startViewTransition: deferred, view: 'agents' });
  inside.state.screenRoutes = { agents: JSON.stringify(['agents', {}]) };
  await inside.applyRoute({ section: 'agents', params: { agentId: 'a-1' }, query: {}, workspaceId: null, alias: null });
  assert.deepEqual(inside.effects, ['render:agents'], 'rota dentro da mesma tela redesenha sem transição');
});

test('poll, patches da lista e redesenhos nunca passam pela transição de tela', () => {
  for (const name of ['poll-inbox', 'refresh-inbox-list', 'select-inbox-conversation', 'navigation-heading', 'live-tasks']) assert.doesNotMatch(excerpt(name), /swapScreen|startViewTransition/, name);
  const calls = [...source.matchAll(/\bswapScreen\(/g)].length;
  assert.equal(calls, 3, 'definição, navigate() e a troca de view de applyRoute()');
  assert.match(excerpt('navigate'), /typeof doc\?\.startViewTransition!=='function'\|\|typeof motionOK!=='function'\|\|!motionOK\(\)/, 'consulta motionOK() antes de animar (§3.7)');
});
