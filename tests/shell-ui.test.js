// Shell of the panel (FRONTEND-V2 §2.3, §5.1, §8.2 commit 1e): white label (no "Elozi" in the shell
// of a reseller workspace, title and favicon from the brand), menu from nav-config with unique icons,
// scope selector, topbar with Pendências/Equipe/account menu, mobile bottom bar and drawer, banners,
// and the a11y contract (skip link, aria-current, inert drawer, focus return). The served render()
// of app.js runs here unchanged; the popovers run against the real markup in a minimal DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';
// render() frames each view with the hub of settings-ui.js (P8: Configurações, Plataforma, Clientes, Indicadores).
import { screenFrame } from '../public/settings-ui.js';
import { applyBrandTokens, deriveBrandTokens } from '../public/brand-theme.js';
import { syncThemePrefs } from '../public/theme-prefs.js';
import { OPERATOR_DEFAULT_PERMISSIONS } from '../src/access.js';
import { excerpt } from './helpers/app-source.js';
import { createDocument } from './helpers/mini-dom.js';
import { captureLocaleFormState, restoreLocaleFormState } from '../public/locale-ui.js';
import { cssRules, parseCss } from './helpers/css-tree.js';

const publicFile = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const source = publicFile('app.js');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));
const roleLabel = source.split('\n').find(line => line.startsWith('const roleLabel = '));
const ctxOf = (session, { supportGrantId = null, hasTenant = true, accountKind = 'reseller' } = {}) => nav.navContext({ session, supportGrantId, hasTenant, accountKind });
const ADMIN = { userId: 'admin-qa', role: 'reseller', permissions: null, name: 'Admin QA' };
const OPERATOR = { userId: 'operator-qa', role: 'operator', permissions: [...OPERATOR_DEFAULT_PERMISSIONS], name: 'Atendente QA' };
const OWNER = { userId: 'owner-qa', role: 'reseller', platformOwner: true, permissions: null, name: 'Dono QA' };

// The served render() of app.js (anchor navigation-heading) with the shell, over a reseller workspace.
function served({ brand = { name: 'Acme Atendimento', initials: 'AC', accent: '#e11d48', logo: '' }, kind = 'reseller', session = ADMIN, view = 'overview', support = false, sandbox = false, mobile = false, menuOpen = false, wide = true, xwide = false, tenants = 2, workspaces } = {}) {
  const app = { innerHTML: '' }, document = { title: '', documentElement: { style: { setProperty() {} }, setAttribute() {}, removeAttribute() {} } };
  const units = [{ id: 'store-centro', name: 'Loja Centro', brand: { accent: '#58c8aa' } }, { id: 'store-norte', name: 'Loja Norte' }].slice(0, tenants);
  const state = {
    view, workspaceId: 'acme', supportGrantId: support ? 'grant-qa' : null, conversation: null, sendIntent: null, menuOpen,
    boot: {
      version: '0.47.0', sandbox, csrfToken: 'csrf-qa', tenants: units,
      reseller: { id: 'acme', name: 'Acme Revenda', accountKind: kind, brand },
      workspaces: workspaces || [{ id: 'acme', name: 'Acme Revenda' }, { id: 'client-b', name: 'Cliente B', supportGrantId: 'grant-b', supportExpiresAt: '2026-10-06T18:40:00Z' }],
      session: { resellerId: 'acme', presence: 'busy', supportGrantId: support ? 'grant-qa' : null, supportReason: 'Chamado sintético', supportExpiresAt: '2026-10-06T18:40:00Z', ...session }
    },
    tenant: units[0] ? { ...units[0], conversations: [] } : null,
    account: { google: { enabled: false }, user: { googleLinked: false } }
  };
  const views = Object.fromEntries(nav.LEGACY_KEYS.map(key => [key, () => `<section data-rendered-view="${key}"><h1>Tela legada ${key}</h1></section>`]));
  const queries = { [shell.SHELL_MOBILE_QUERY]: mobile, [shell.SHELL_WIDE_QUERY]: wide, [shell.SHELL_XWIDE_QUERY]: xwide };
  const globals = {
    ...i18n, ...nav, ...shell, screenFrame, state, views, escape, document, applyBrandTokens, deriveBrandTokens, syncThemePrefs,
    $: selector => selector === '#app' ? app : null, matchMedia: query => ({ matches: Boolean(queries[query]) }),
    hasPermission: permission => state.boot.session.role === 'reseller' || state.boot.session.permissions == null || state.boot.session.permissions.includes(permission),
    commercialUsageUI: { syncContext() {} }, memoryUI: { syncContext() {} }, groupsWorkspaceUI: { syncContext() {}, bind: async () => {} }, channelVisitorTestUI: { syncContext() {} },
    consolidatedInbox: { saveDraft: () => true, getDraft: () => '' }, noteDrafts: { key: null }, mediaUI: { syncContext: () => true, draft: '' },
    forwarding: { close() {} }, syncAttendanceTools() {}, repliesUI: { retainConversations() {}, syncContext() {} }, voiceRecorder: { syncContext() {} },
    canSendTo: () => false, supportsVoice: () => false, selectedInboxRef: () => null, inboxIdentity: value => value ? JSON.stringify(value) : '', attendanceContext: () => ({}),
    chatLayout: { sync() {}, collapsed: false }, avatarUI: { bind() {} }, integrationsUI: { bind() {} }, teamChatUI: { bind() {} }, mcpUI: { mountUsage() {} },
    bindAgentAdminProposals() {}, bindSupportAssistant() {}, bindInboxMedia() {}, composerStatus() {}, refreshScopedConversationRuns: async () => false,
    // Post-render hook of the live modules and delegated screens (anchor delegated-screens, P1 commit 1f).
    afterRender() {},
    toast: message => assert.fail('render do shell não deve avisar: ' + message)
  };
  const loaded = runInNewContext(roleLabel + '\n' + excerpt('navigation-heading') + '\n({render,navigationMarkup})', globals);
  loaded.render();
  return { ...loaded, app, document, state, html: app.innerHTML };
}
const shellPart = html => html.replace(/<main id="main-content"[\s\S]*<\/main>/, '<main></main>');

test('nenhum "Elozi" no shell de um workspace de revenda: marca, título e topo vêm da marca do workspace', () => {
  for (const language of ['pt-BR', 'en']) {
    locale(language);
    for (const options of [{}, { view: 'inbox' }, { view: 'team' }, { view: 'accounts' }, { support: true, session: OPERATOR, sandbox: true }, { mobile: true, menuOpen: true }, { session: OWNER, kind: 'platform', brand: { name: 'Acme Atendimento', accent: '#3157d5' } }]) {
      const f = served(options);
      assert.doesNotMatch(f.html, /elozi/i, `${language} ${JSON.stringify(options)}`);
      assert.doesNotMatch(f.document.title, /elozi/i);
      assert.match(f.document.title, / · Acme Atendimento$/, 'o título termina com a marca do workspace');
      assert.match(shellPart(f.html), /<li class="sh-crumbs__item sh-crumbs__item--brand">Acme Atendimento<\/li>/, 'a trilha começa pela marca');
    }
  }
  const platform = served({ session: OWNER, kind: 'platform', brand: { name: 'Elozi', accent: '#3157d5' } });
  assert.match(platform.document.title, / · Elozi$/, 'o workspace da plataforma mostra a própria marca');
  // Static sources of the shell and of the first paint never carry the product name.
  for (const file of ['shell-ui.js', 'shell.css']) assert.doesNotMatch(publicFile(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /elozi/i, file);
  assert.doesNotMatch(excerpt('navigation-heading'), /Elozi/, 'render() sem literal de produto');
  const index = publicFile('index.html');
  assert.doesNotMatch(index, /elozi/i, 'index.html (título e carregamento) neutro');
  assert.doesNotMatch(index, /rel="icon"/, 'o ícone fixo saiu: o favicon é gerado com a marca');
  assert.match(index, /<title data-i18n="Central de atendimento">Central de atendimento<\/title>/);
});

test('título e trilha: "Tela · Marca", aba do hub quando diz algo novo, contador opcional', () => {
  assert.equal(served({ view: 'team' }).document.title, 'Equipe · Acme Atendimento');
  assert.equal(served({ view: 'overview' }).document.title, 'Visão geral · Acme Atendimento');
  assert.equal(served({ view: 'groups' }).document.title, 'Grupos · Acme Atendimento');
  assert.deepEqual(shell.shellCrumbs({ view: 'team', viewLabel: 'Equipe', brandName: 'Acme' }), { brand: 'Acme', section: 'Configurações', tab: 'Equipe', screen: 'Equipe' });
  assert.deepEqual(shell.shellCrumbs({ view: 'agents', viewLabel: 'Agentes', brandName: 'Acme' }), { brand: 'Acme', section: 'Agentes', tab: '', screen: 'Agentes' });
  assert.deepEqual(shell.shellCrumbs({ view: 'team-chat', viewLabel: 'Chat da equipe', brandName: 'Acme' }), { brand: 'Acme', section: 'Chat da equipe', tab: '', screen: 'Chat da equipe' });
  assert.equal(shell.shellTitle({ screen: 'Atendimento', brand: 'Acme', count: 3 }), '(3) Atendimento · Acme');
  assert.equal(shell.shellTitle({ screen: 'Atendimento', brand: 'Acme', count: 0 }), 'Atendimento · Acme');
  assert.equal(shell.shellTitle({ screen: 'Atendimento', brand: 'Acme', count: 120 }), '(99+) Atendimento · Acme');
  const html = served({ view: 'team' }).html;
  assert.match(html, /<li class="sh-crumbs__item">Configurações<\/li><li class="sh-crumbs__item" aria-current="page">Equipe<\/li>/);
});

test('menu: até dez itens com ícones únicos, Grupos sob Atendimento e aria-current no item da tela', () => {
  const keys = (session, options, view = 'overview') => shell.menuEntries(ctxOf(session, options), view).map(entry => entry.key);
  assert.deepEqual(keys(OWNER, { accountKind: 'platform' }), ['overview', 'inbox', 'groups', 'contacts', 'agents', 'automation', 'channels', 'metrics', 'accounts', 'platform', 'settings']);
  assert.deepEqual(keys(ADMIN), ['overview', 'inbox', 'groups', 'contacts', 'agents', 'automation', 'channels', 'metrics', 'accounts', 'settings']);
  assert.deepEqual(keys(ADMIN, { accountKind: 'business' }), ['overview', 'inbox', 'groups', 'contacts', 'agents', 'automation', 'channels', 'metrics', 'settings']);
  // §2.1 table: an attendant with the default permissions gets five items (the "≤4" of §8.2 contradicts the
  // table, as tests/navigation-matrix.test.js records); Grupos is a sub-item of Atendimento, not an item.
  assert.deepEqual(keys(OPERATOR), ['overview', 'inbox', 'groups', 'contacts', 'automation', 'metrics']);
  assert.deepEqual(keys({ ...OPERATOR, permissions: ['inbox.read'] }, { supportGrantId: 'grant-qa' }), ['overview', 'inbox', 'groups', 'automation', 'channels']);
  for (const [session, options] of [[OWNER, { accountKind: 'platform' }], [ADMIN, {}], [OPERATOR, {}]]) {
    const items = shell.menuEntries(ctxOf(session, options), 'overview').filter(entry => !entry.sub);
    assert.ok(items.length <= 10, 'no máximo dez itens');
    assert.equal(new Set(items.map(item => item.icon)).size, items.length, 'ícones únicos');
  }
  const html = served({ view: 'team' }).navigationMarkup();
  assert.match(html, /<a class="sh-nav__item" href="#settings\/companies" data-view="tenants" aria-current="page">/, 'item da área do hub, link canônico e view legada');
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  const groups = served({ view: 'groups' }).navigationMarkup();
  assert.match(groups, /<li class="sh-nav__entry sh-nav__entry--sub"><a class="sh-nav__item" href="#groups" data-view="groups" aria-current="page">/);
  assert.doesNotMatch(groups, /data-view="inbox" aria-current/, 'só a tela aberta recebe aria-current');
  assert.match(html, /<nav class="sh-nav" aria-label="Navegação principal"><div class="sh-nav__section" data-section="operation"><p class="sh-nav__heading" id="sh-nav-operation">Operação<\/p><ul class="sh-nav__list" aria-labelledby="sh-nav-operation">/);
  assert.match(html, /<div class="sh-nav__section" data-section="system"><ul class="sh-nav__list">/, 'Configurações em seção própria, sem título');
});

test('seletor de escopo: logo da marca, workspace › empresa, selos de plataforma e suporte, empresas só quando cabem', () => {
  const model = shell.scopeModel({ view: 'overview', workspace: { id: 'acme', name: 'Acme Revenda', kind: 'reseller' }, workspaces: [{ id: 'acme', name: 'Acme Revenda' }, { id: 'root', name: 'Plataforma', platformWorkspace: true }, { id: 'client-b', name: 'Cliente B', supportGrantId: 'grant-b', supportExpiresAt: '2026-10-06T18:40:00Z' }], tenant: { id: 't1', name: 'Loja Centro' }, tenants: [{ id: 't1', name: 'Loja Centro' }, { id: 't2', name: 'Loja Norte' }] });
  assert.equal(model.company, 'Loja Centro'); assert.equal(model.kind, 'Revenda white label'); assert.equal(model.switchable, true); assert.equal(model.search, false);
  assert.deepEqual(model.workspaces.map(option => [option.id, option.current, option.badge?.tone ?? null]), [['acme', true, null], ['root', false, 'accent'], ['client-b', false, 'warning']]);
  assert.equal(model.workspaces[1].badge.text, 'plataforma');
  assert.match(model.workspaces[2].badge.text, /^suporte até \d{2}:\d{2}$/);
  assert.deepEqual(model.companies.map(company => [company.id, company.current]), [['t1', true], ['t2', false]]);
  const inbox = shell.scopeModel({ view: 'inbox', workspace: { id: 'acme' }, tenant: { id: 't1', name: 'Loja Centro' }, tenants: [{ id: 't1' }, { id: 't2' }] });
  assert.equal(inbox.company, 'Todas as empresas autorizadas'); assert.deepEqual(inbox.companies, [], 'a caixa é consolidada: sem troca de empresa');
  assert.equal(shell.scopeModel({ view: 'platform-users', workspace: {}, tenant: { id: 't1' } }).company, 'Gestão das contas');
  assert.equal(shell.scopeModel({ view: 'overview', workspace: {}, tenant: null }).company, 'Configure sua primeira unidade');
  assert.equal(shell.scopeModel({ view: 'overview', workspace: { id: 'acme' }, workspaces: [{ id: 'acme' }], tenant: { id: 't1', name: 'Única' }, tenants: [{ id: 't1' }] }).switchable, false, 'nada a trocar: bloco estático');
  const many = shell.scopeModel({ view: 'overview', workspace: { id: 'w0' }, workspaces: Array.from({ length: 4 }, (_, index) => ({ id: 'w' + index, name: 'W' + index })), tenant: { id: 't0' }, tenants: Array.from({ length: 3 }, (_, index) => ({ id: 't' + index, name: 'T' + index })) });
  assert.equal(many.search, true, 'busca a partir de sete opções');
  const support = served({ support: true, session: { ...OPERATOR, permissions: ['inbox.read'] }, workspaces: [{ id: 'acme', name: 'Acme Revenda', supportGrantId: 'grant-qa', supportExpiresAt: '2026-10-06T18:40:00Z' }, { id: 'home', name: 'Conta própria' }] });
  assert.match(support.html, /data-action="shell:workspace" data-id="acme" data-grant="grant-qa" data-shell-option data-shell-search="Acme Revenda suporte até \d{2}:\d{2}" aria-current="true"/, 'o contexto de suporte é o atual');
  assert.match(support.html, /data-action="shell:workspace" data-id="home" data-grant="" data-shell-option data-shell-search="Conta própria">/);
  const html = served().html;
  assert.match(html, /<button type="button" class="sh-scope__trigger" data-shell-toggle="scope" aria-expanded="false" aria-controls="sh-scope-panel" aria-haspopup="dialog" title="Acme Atendimento · Acme Revenda › Loja Centro · Revenda white label">/);
  assert.match(html, /<span class="sh-scope__brand">Acme Atendimento<\/span><span class="sh-scope__line">Acme Revenda › Loja Centro<\/span>/);
  assert.match(html, /<span class="ui-avatar ui-avatar--company ui-avatar--32" aria-hidden="true" style="--company-bg:#e11d48;--company-fg:#ffffff;--company-edge:transparent">/, 'monograma com o sólido derivado da marca');
  assert.match(served({ brand: { name: 'Acme Atendimento', accent: '#e11d48', logo: 'data:image/jpeg;base64,QUJD' } }).html, /<img class="ui-avatar__img" src="data:image\/jpeg;base64,QUJD" alt="" decoding="async"\/>/, 'logotipo da marca');
  assert.doesNotMatch(served({ tenants: 1, workspaces: [{ id: 'acme', name: 'Acme Revenda' }] }).html, /data-shell-toggle="scope"|data-action="shell:scope"/);
});

test('topo e menu da conta: Pendências, Equipe, avatar com disponibilidade, idioma, animações, atalhos, ajuda e sair', () => {
  const admin = served().html, operator = served({ session: OPERATOR }).html;
  for (const html of [admin, operator]) {
    assert.match(html, /<button type="button" class="sh-iconbtn sh-topbar__pending" data-action="shell:pending" aria-label="Pendências" title="Pendências">/);
    assert.match(html, /<button type="button" class="sh-iconbtn sh-topbar__team" data-action="shell:team" aria-label="Equipe" title="Equipe">/);
    assert.match(html, /<button type="button" class="sh-search" data-action="navigation-search" aria-label="Buscar no painel" aria-keyshortcuts="Control\+K Meta\+K">/);
    assert.match(html, /<button type="button" class="sh-account__trigger" data-shell-toggle="account" aria-expanded="false" aria-controls="sh-account-panel" aria-haspopup="dialog"><span class="sr-only">Menu da conta<\/span> <span class="ui-avatar ui-avatar--person ui-avatar--32" role="img" aria-label="[^"]+ · Ocupado" data-presence="busy">/);
    for (const [name, values] of [['shell-presence', ['available', 'busy', 'away', 'offline']], ['shell-locale', ['pt-BR', 'en']], ['shell-theme', ['system', 'light', 'dark']], ['shell-motion', ['system', 'reduced']]]) {
      for (const value of values) assert.match(html, new RegExp(`name="${name}" value="${value}"`), `${name} ${value}`);
    }
    assert.match(html, /name="shell-presence" value="busy" checked\/>/);
    assert.match(html, /name="shell-locale" value="pt-BR" checked\/>/);
    // P10: Tema between Idioma and Animações, "Sistema" checked by default.
    assert.match(html, /<p class="sh-menu__legend">Tema<\/p><div class="ui-seg" role="radiogroup" aria-label="Tema do painel"[^>]*>[\s\S]*?name="shell-theme" value="system" checked\/><span class="ui-seg__label">Sistema<\/span>[\s\S]*?<span class="ui-seg__label">Claro<\/span>[\s\S]*?<span class="ui-seg__label">Escuro<\/span>/);
    assert.ok(html.indexOf('name="shell-locale"') < html.indexOf('name="shell-theme"') && html.indexOf('name="shell-theme"') < html.indexOf('name="shell-motion"'));
    assert.match(html, /<a class="sh-menu__link" href="#account" data-view="account">[\s\S]*?<span>Minha conta<\/span><\/a>/);
    assert.match(html, /<a class="sh-menu__link" href="#help" data-view="guide">[\s\S]*?<span>Ajuda e APIs<\/span><\/a>/);
    assert.match(html, /<button type="button" class="sh-menu__link" data-action="shell:shortcuts">[\s\S]*?<span>Atalhos do teclado<\/span><\/button>/);
    assert.match(html, /<button type="button" class="sh-menu__link" data-action="logout">[\s\S]*?<span>Sair<\/span><\/button>/);
    assert.doesNotMatch(html, /data-action="refresh"|id="(?:workspace|tenant|presence|locale)-select"/, 'sem botão Atualizar e sem os selects antigos no topo');
  }
  assert.match(operator, /<small>Atendente<\/small>/); assert.match(admin, /<small>Administrador da revenda<\/small>/);
  assert.doesNotMatch(admin, /data-view="architecture"/, 'a versão aparece só para o dono da plataforma');
  assert.match(served({ session: OWNER, kind: 'platform' }).html, /<a class="sh-menu__link" href="#platform\/health" data-view="architecture">[\s\S]*?<span>Versão 0\.47\.0<\/span><\/a>/);
  const support = served({ support: true, session: { ...OPERATOR, permissions: ['inbox.read'] } }).html;
  assert.doesNotMatch(support, /data-action="shell:team"/, 'suporte temporário sem Equipe');
  assert.match(support, /data-action="shell:pending"/);
  const shortcuts = String(shell.shortcutsMarkup());
  assert.match(shortcuts, /<kbd class="ui-kbd">Ctrl K<\/kbd><\/span><span>Buscar uma área do painel<\/span>/);
  assert.match(shortcuts, /Enviar a resposta ou salvar a nota interna/);
});

test('faixas acima de <main>: suporte temporário com saída e ambiente de teste; sem faixa, região vazia', () => {
  const html = served({ support: true, session: { ...OPERATOR, permissions: ['inbox.read'] }, sandbox: true }).html;
  assert.match(html, /<div class="sh-banners" id="sh-banners" data-shell-slot="banners"><div class="ui-banner ui-banner--warning sh-banner" data-banner="support" data-state="collapsed">/);
  assert.match(html, /<div class="ui-banner__text sh-banner__text" id="sh-banner-support-text"><strong class="ui-banner__title">Suporte temporário<\/strong> <span class="ui-banner__body">Chamado sintético · até \d{2}:\d{2}<\/span><\/div>/);
  assert.match(html, /data-action="support-exit"><span class="ui-btn__label">Sair do suporte<\/span>/);
  assert.match(html, /<div class="ui-banner ui-banner--info sh-banner" data-banner="sandbox" data-state="collapsed">[\s\S]*?Ambiente de teste · dados sintéticos e conexões simuladas\./);
  assert.ok(html.indexOf('id="sh-banners"') < html.indexOf('<main id="main-content"'), 'faixas antes do conteúdo');
  withStorage({ 'elozi:prefs:admin-qa': JSON.stringify({ shellNotice: 'menu-p1' }) }, () => {
    assert.match(served().html, /<div class="sh-banners" id="sh-banners" data-shell-slot="banners"><\/div>/, 'sem faixa, a região fica vazia (e some pelo CSS)');
  });
});

test('faixas compactas abaixo de 600 px (P10): uma linha, botão ⌄ que expande e recolhe com rótulo e aria-expanded', () => {
  const html = served({ support: true, session: { ...OPERATOR, permissions: ['inbox.read'] }, sandbox: true }).html;
  assert.match(html, /<button type="button" class="sh-banner__toggle" data-shell-banner-toggle aria-expanded="false" aria-controls="sh-banner-sandbox-text" aria-label="Mostrar o aviso completo" title="Mostrar o aviso completo">/);
  const doc = createDocument(html);
  shell.installShell(doc);
  const banner = doc.querySelector('[data-banner="support"]'), toggle = banner.querySelector('[data-shell-banner-toggle]');
  toggle.click();
  assert.equal(banner.getAttribute('data-state'), 'expanded'); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Recolher o aviso');
  toggle.click();
  assert.equal(banner.getAttribute('data-state'), 'collapsed'); assert.equal(toggle.getAttribute('aria-label'), 'Mostrar o aviso completo');
  assert.equal(doc.querySelector('[data-banner="sandbox"]').getAttribute('data-state'), 'collapsed', 'cada faixa abre sozinha');
  // shell.css: the toggle only exists below 600 px, where the collapsed banner is one line with an ellipsis.
  const rules = cssRules(parseCss(publicFile('shell.css')));
  const inNarrow = (selector, property, value) => rules.some(rule => rule.context.includes('@media (max-width: 599.98px)') && rule.selector === selector && rule.declarations.some(declaration => declaration.property === property && (!value || declaration.value === value)));
  assert.ok(rules.some(rule => rule.context.length === 1 && rule.selector === '.sh-banner__toggle' && rule.declarations.some(({ property, value }) => property === 'display' && value === 'none')));
  assert.ok(inNarrow('.sh-banner__toggle', 'display', 'inline-grid') && inNarrow('.sh-banner__toggle', 'width', 'var(--target-touch)'), 'alvo de 44 px');
  assert.ok(inNarrow('.sh-banner[data-state="collapsed"] .ui-banner__text', 'text-overflow', 'ellipsis') && inNarrow('.sh-banner[data-state="collapsed"] .ui-banner__text', 'white-space', 'nowrap'));
  assert.ok(inNarrow('#main-content.content', 'padding-top', 'var(--space-6)'));
  // The banner column never grows past the region: a one-line banner would push ⌄ and × off a 375 px screen.
  assert.ok(rules.some(rule => rule.context.length === 1 && rule.selector === '.sh-banners' && rule.declarations.some(({ property, value }) => property === 'grid-template-columns' && value === 'minmax(0, 1fr)')));
  locale('en');
  assert.match(served({ sandbox: true, session: OPERATOR }).html, /aria-label="Show the full notice"/);
});

// Node has no localStorage: the shell reads globalThis.localStorage at call time, so a test can lend one.
function withStorage(entries, run) {
  const values = new Map(Object.entries(entries)), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try { return run(storage); } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
}

test('aviso de transição (§2.2): uma faixa dispensável por pessoa, com o texto do papel, até ser dispensada', () => {
  const admin = served().html, operator = served({ session: OPERATOR }).html;
  assert.match(admin, /<div class="ui-banner ui-banner--info sh-banner" data-banner="menu-notice" data-state="collapsed" data-shell-notice="menu">[\s\S]*?<strong class="ui-banner__title">O menu ficou mais curto\.<\/strong> <span class="ui-banner__body">Conhecimento e Agentes conectados agora ficam em Agentes, Fluxos em Automação e as telas da conta em Configurações\./);
  assert.match(admin, /data-ui-dismiss="banner"/, 'dispensável');
  assert.match(operator, /<span class="ui-banner__body">Grupos agora fica dentro de Atendimento e o chat da equipe abre pelo botão Equipe\./);
  withStorage({ 'elozi:prefs:admin-qa': JSON.stringify({ theme: 'system', density: 'compact', motion: 'reduced' }) }, storage => {
    assert.equal(shell.shellNoticeDismissed('admin-qa'), false);
    const doc = createDocument(served().html);
    let dismissed = 0;
    shell.installShell(doc, { onNoticeDismiss: () => { dismissed++; shell.dismissShellNotice('admin-qa'); } });
    doc.querySelector('.sh-search').click();
    doc.querySelector('[data-shell-notice] [data-ui-dismiss="banner"]').click();
    assert.equal(dismissed, 1, 'só o botão de dispensar do aviso conta');
    assert.equal(shell.shellNoticeDismissed('admin-qa'), true);
    assert.deepEqual(JSON.parse(storage.values.get('elozi:prefs:admin-qa')), { theme: 'system', density: 'compact', motion: 'reduced', shellNotice: 'menu-p1' }, 'as outras preferências ficam');
    assert.doesNotMatch(served().html, /data-banner="menu-notice"/, 'dispensado não volta');
    assert.match(served({ session: OPERATOR }).html, /data-banner="menu-notice"/, 'cada pessoa dispensa o seu');
  });
  assert.equal(shell.dismissShellNotice('admin-qa', null), false, 'sem armazenamento, nada quebra');
  assert.equal(shell.shellNoticeDismissed('admin-qa', { getItem() { throw new Error('bloqueado'); } }), false);
});

test('aviso de transição aparece no máximo uma vez (P10): o primeiro render que o mostra o registra; recarregar não traz de volta', () => {
  withStorage({ 'elozi:prefs:visto-qa': JSON.stringify({ density: 'compact' }) }, storage => {
    const session = { ...OPERATOR, userId: 'visto-qa' };
    assert.match(served({ session }).html, /data-banner="menu-notice"/, 'primeira vez: aparece');
    assert.deepEqual(JSON.parse(storage.values.get('elozi:prefs:visto-qa')), { density: 'compact', shellNotice: 'menu-p1' }, 'registrado já na primeira exibição, sem perder as outras chaves');
    assert.match(served({ session }).html, /data-banner="menu-notice"/, 'continua nesta página até ser dispensado');
  });
  // A new page load of the same person (fresh memory, same record): never again.
  withStorage({ 'elozi:prefs:visto-qa': JSON.stringify({ density: 'compact', shellNotice: 'menu-p1' }) }, () => {
    assert.doesNotMatch(served({ session: { ...OPERATOR, userId: 'visto-qa' } }).html, /data-banner="menu-notice"/, 'não volta no próximo carregamento');
  });
});

test('contrato de compatibilidade: app-shell[data-view], skip link primeiro, main#main-content, legado intacto dentro do shell', () => {
  const inbox = served({ view: 'inbox' }).html;
  assert.match(inbox, /^<div class="app-shell sh-app" data-view="inbox" data-sh-layout="rail">\s*<button type="button" class="sh-skip" data-action="skip-content">Pular para o conteúdo<\/button>/, 'Atendimento abaixo de 1600 px usa o trilho');
  assert.match(inbox, /<main id="main-content" tabindex="-1" class="content inbox-content"><section data-rendered-view="inbox"><h1>Tela legada inbox<\/h1><\/section><\/main>/);
  assert.match(served({ view: 'team-chat' }).html, /<main id="main-content" tabindex="-1" class="content team-chat-content">/);
  const team = served({ view: 'team' }).html;
  assert.match(team, /data-sh-layout="full"/);
  assert.ok(team.includes(screenFrame('team', ctxOf(ADMIN), '<section data-rendered-view="team"><h1>Tela legada team</h1></section>')), 'a view legada entra no hub sem reescrita');
  assert.match(team, /<main id="main-content" tabindex="-1" class="content"><div class="ui-hub" data-hub="settings">/);
});

test('celular: gaveta inerte quando fechada, conteúdo inerte quando aberta, barra inferior por papel', () => {
  const closed = served({ mobile: true }).html;
  assert.match(closed, /<aside class="sh-sidebar" id="sh-sidebar" aria-label="Menu lateral" inert>/);
  assert.match(closed, /<button type="button" class="sh-scrim" data-action="close-menu" aria-label="Fechar menu" hidden><\/button>/);
  assert.match(closed, /<div class="main-shell sh-main">/);
  assert.match(closed, /data-action="menu" aria-label="Abrir menu" aria-controls="sh-sidebar" aria-expanded="false"/);
  const open = served({ mobile: true, menuOpen: true }).html;
  assert.match(open, /<aside class="sh-sidebar" id="sh-sidebar" aria-label="Menu lateral" data-state="open">/);
  assert.match(open, /<div class="main-shell sh-main" inert>/); assert.match(open, /<nav class="sh-bottombar" aria-label="Navegação rápida" inert>/);
  assert.match(open, /data-action="menu" aria-label="Abrir menu" aria-controls="sh-sidebar" aria-expanded="true"/);
  const desktop = served({ menuOpen: true }).html;
  assert.doesNotMatch(desktop, /\binert\b/, 'acima de 900 px nada fica inerte'); assert.match(desktop, /class="sh-scrim"[^>]*hidden/);
  const bar = html => [...html.match(/<nav class="sh-bottombar"[\s\S]*?<\/nav>/)[0].matchAll(/<span class="sh-bottombar__label">([^<]+)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(bar(served({ session: OPERATOR }).html), ['Visão geral', 'Atendimento', 'Pendências', 'Equipe', 'Mais']);
  assert.deepEqual(bar(served().html), ['Visão geral', 'Atendimento', 'Agentes', 'Pendências', 'Mais']);
  assert.deepEqual(bar(served({ support: true, session: { ...OPERATOR, permissions: ['inbox.read'] } }).html), ['Visão geral', 'Atendimento', 'Pendências', 'Mais']);
  const sheet = served().html.match(/<div class="sh-sheet" id="sh-more-panel"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...sheet.matchAll(/<span>([^<]+)<\/span>/g)].map(match => match[1]), ['Grupos', 'Contatos', 'Automação', 'Canais', 'Indicadores', 'Clientes', 'Configurações', 'Equipe'], '"Mais" leva o restante do menu');
});

test('layout do menu: trilho de 900 a 1279 px e em Atendimento abaixo de 1600 px; alternância só onde vale', () => {
  const cases = [
    [{ wide: false, xwide: false, view: 'overview' }, { layout: 'rail', toggleable: false }],
    [{ wide: true, xwide: false, view: 'overview' }, { layout: 'full', toggleable: true }],
    [{ wide: true, xwide: false, view: 'overview', collapsed: true }, { layout: 'rail', toggleable: true }],
    [{ wide: true, xwide: false, view: 'inbox' }, { layout: 'rail', toggleable: false }],
    [{ wide: true, xwide: true, view: 'inbox' }, { layout: 'full', toggleable: true }],
    [{ wide: true, xwide: true, view: 'inbox', collapsed: true }, { layout: 'rail', toggleable: true }]
  ];
  for (const [input, expected] of cases) assert.deepEqual(shell.shellLayout(input), expected, JSON.stringify(input));
  assert.match(served({ wide: false }).html, /data-sh-layout="rail"[\s\S]*data-layout-action="sidebar"[^>]*aria-expanded="false" hidden>/);
  const doc = createDocument(served().html);
  assert.equal(shell.applyShellLayout(doc, { layout: 'rail', toggleable: false }), true);
  assert.equal(doc.querySelector('.sh-app').getAttribute('data-sh-layout'), 'rail'); assert.equal(doc.querySelector('.sh-topbar__rail').hidden, true);
});

test('gaveta, escolha e presença atualizam o DOM existente sem render', () => {
  const doc = createDocument(served({ mobile: true }).html), sidebar = doc.getElementById('sh-sidebar'), menu = doc.querySelector('.sh-topbar__menu');
  assert.equal(shell.setShellDrawer(doc, true, { mobile: true, focus: true }), true);
  assert.equal(sidebar.hasAttribute('inert'), false); assert.equal(sidebar.getAttribute('data-state'), 'open');
  assert.equal(doc.querySelector('.sh-main').hasAttribute('inert'), true); assert.equal(doc.querySelector('.sh-scrim').hidden, false);
  assert.equal(menu.getAttribute('aria-expanded'), 'true'); assert.equal(doc.activeElement, doc.querySelector('.sh-scope__trigger'), 'o foco entra no menu');
  assert.equal(shell.setShellDrawer(doc, false, { mobile: true, focus: true }), false);
  assert.equal(sidebar.hasAttribute('inert'), true); assert.equal(doc.querySelector('.sh-main').hasAttribute('inert'), false);
  assert.equal(doc.querySelector('.sh-scrim').hidden, true); assert.equal(doc.activeElement, menu, 'o foco volta ao botão de menu');
  assert.equal(shell.setShellDrawer(doc, true, { mobile: false }), false, 'acima de 900 px não há gaveta');
  assert.equal(sidebar.hasAttribute('inert'), false);
  assert.equal(shell.setShellChoice(doc, 'shell-locale', 'en'), true);
  assert.equal(doc.querySelector('input[name="shell-locale"][value="en"]').checked, true); assert.equal(doc.querySelector('input[name="shell-locale"][value="pt-BR"]').checked, false);
  assert.equal(doc.querySelector('input[name="shell-locale"][value="en"]').closest('.ui-seg').style.getPropertyValue('--seg-index'), '1');
  assert.equal(shell.setShellPresence(doc, 'away', 'Admin QA'), 'away');
  assert.equal(doc.querySelector('.sh-account__trigger .ui-avatar').getAttribute('aria-label'), 'Admin QA · Ausente');
  assert.deepEqual(doc.querySelectorAll('.sh-account .ui-avatar[data-presence]').map(node => node.getAttribute('data-presence')), ['away', 'away']);
  assert.equal(doc.querySelector('input[name="shell-presence"][value="away"]').checked, true);
});

test('popovers: alternância, Esc devolve o foco, clique e foco fora fecham, busca filtra e setas percorrem', () => {
  const workspaces = Array.from({ length: 5 }, (_, index) => ({ id: 'w' + index, name: ['Acme Revenda', 'Beta Ótica', 'Gama Loja', 'Delta', 'Épsilon'][index] }));
  const doc = createDocument(served({ workspaces: [{ id: 'acme', name: 'Acme Revenda' }, ...workspaces.slice(1)] }).html), ui = shell.installShell(doc);
  assert.equal(shell.installShell(doc).openPanel, null, 'instalar de novo não duplica os ouvintes');
  const trigger = doc.querySelector('[data-shell-toggle="scope"]'), panel = doc.getElementById('sh-scope-panel');
  trigger.click();
  assert.equal(panel.hidden, false); assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(ui.openPanel, 'scope');
  const filter = doc.querySelector('[data-shell-filter]');
  assert.equal(doc.activeElement, filter, 'com sete opções a busca recebe o foco');
  filter.value = 'otica'; doc.dispatch('input', { target: filter });
  const visible = () => doc.querySelectorAll('[data-shell-option]').filter(option => !option.closest('li').hidden).map(option => option.getAttribute('data-shell-search'));
  assert.deepEqual(visible(), ['Beta Ótica'], 'sem acento e sem caixa');
  filter.value = 'zzz'; doc.dispatch('input', { target: filter });
  assert.deepEqual(visible(), []); assert.equal(doc.querySelector('[data-shell-empty]').hidden, false);
  filter.value = ''; doc.dispatch('input', { target: filter });
  assert.equal(doc.querySelector('[data-shell-empty]').hidden, true);
  const down = doc.dispatch('keydown', { key: 'ArrowDown', target: filter });
  assert.equal(down.defaultPrevented, true); assert.equal(doc.activeElement.getAttribute('data-shell-search'), 'Acme Revenda');
  doc.dispatch('keydown', { key: 'ArrowUp', target: doc.activeElement });
  assert.equal(doc.activeElement.getAttribute('data-shell-search'), 'Loja Norte', 'volta ao fim da lista');
  doc.dispatch('keydown', { key: 'Home', target: doc.activeElement });
  assert.equal(doc.activeElement.getAttribute('data-shell-search'), 'Acme Revenda');
  const escape = doc.dispatch('keydown', { key: 'Escape', target: doc.activeElement });
  assert.equal(escape.defaultPrevented, true); assert.equal(panel.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, trigger, 'Esc devolve o foco ao gatilho'); assert.equal(ui.openPanel, null);
  const unrelated = doc.dispatch('keydown', { key: 'Escape', target: trigger });
  assert.equal(unrelated.defaultPrevented, false, 'Esc sem popover aberto segue para a gaveta e o chat');
  const account = doc.querySelector('[data-shell-toggle="account"]'), accountPanel = doc.getElementById('sh-account-panel');
  account.click();
  assert.equal(accountPanel.hidden, false); assert.equal(doc.activeElement, doc.querySelector('input[name="shell-presence"][value="busy"]'), 'foco na disponibilidade marcada');
  trigger.click();
  assert.equal(accountPanel.hidden, true, 'um popover por vez'); assert.equal(panel.hidden, false);
  doc.dispatch('click', { target: doc.querySelector('main') });
  assert.equal(panel.hidden, true, 'clique fora fecha'); assert.notEqual(doc.activeElement, trigger, 'sem mover o foco');
  account.click(); doc.querySelector('.sh-search').focus();
  assert.equal(accountPanel.hidden, true, 'foco fora fecha');
  account.click(); account.click();
  assert.equal(accountPanel.hidden, true, 'o gatilho alterna');
  ui.open('account', { focus: 'input[name="shell-locale"]:checked' });
  assert.equal(doc.activeElement, doc.querySelector('input[name="shell-locale"][value="pt-BR"]'));
  doc.body.innerHTML = served().html;
  assert.equal(ui.openPanel, null, 'render substitui o popover aberto');
  doc.dispatch('click', { target: doc.querySelector('main') });
  assert.equal(doc.getElementById('sh-account-panel').hidden, true);
});

test('favicon da marca em canvas: cor derivada, iniciais, cache e um único link de ícone', () => {
  const calls = [], doc = createDocument('');
  const original = doc.createElement;
  doc.createElement = tag => tag !== 'canvas' ? original(tag) : { width: 0, height: 0,
    getContext: () => ({ set fillStyle(value) { calls.push(['fill', value]); }, set font(value) { calls.push(['font', value]); }, textAlign: '', textBaseline: '',
      beginPath() {}, roundRect(...args) { calls.push(['roundRect', ...args]); }, rect() {}, fill() {}, arc() { calls.push(['arc']); }, fillText(text) { calls.push(['text', text]); } }),
    toDataURL: () => 'data:image/png;base64,' + Buffer.from(JSON.stringify(calls)).toString('base64') };
  const old = doc.createElement('link'); old.setAttribute('rel', 'icon'); old.setAttribute('href', '/mark.svg'); doc.head.append(old);
  const tokens = deriveBrandTokens('#f2a900');
  const href = shell.applyFavicon(doc, { brand: { name: 'Acme Atendimento', initials: 'AC' }, tokens });
  assert.match(href, /^data:image\/png;base64,/);
  assert.deepEqual(calls.filter(([kind]) => kind !== 'font'), [['fill', tokens.light.accent], ['roundRect', 0, 0, 64, 64, 14], ['fill', tokens.light.onAccent], ['text', 'AC']]);
  const links = doc.head.querySelectorAll('link');
  assert.equal(links.length, 1, 'o ícone fixo sai'); assert.equal(links[0].getAttribute('href'), href); assert.equal(links[0].getAttribute('type'), 'image/png');
  const count = calls.length;
  assert.equal(shell.applyFavicon(doc, { brand: { name: 'Acme Atendimento', initials: 'AC' }, tokens }), href); assert.equal(calls.length, count, 'mesma marca não redesenha');
  shell.applyFavicon(doc, { brand: { name: 'Acme Atendimento', initials: 'AC' }, tokens, dot: true, dotColor: 'rgb(181 74 70)' });
  assert.ok(calls.slice(count).some(([kind]) => kind === 'arc'), 'ponto quando há não lidas (P2)');
  assert.equal(shell.applyFavicon(doc, { brand: { name: 'Acme' } }), null, 'sem tokens não toca no ícone');
  assert.equal(shell.applyFavicon({ title: '' }, { brand: { name: 'Acme' }, tokens }), null, 'sem <head> (testes do render) nada acontece');
});

test('EN: o shell inteiro sai traduzido e os nomes vindos de dados ficam como estão', () => {
  locale('en');
  const html = served({ session: OPERATOR, sandbox: true }).html, text = shellPart(html).replace(/<svg[\s\S]*?<\/svg>/g, '');
  for (const copy of ['Skip to content', 'Main navigation', 'Overview', 'Inbox', 'Groups', 'Contacts', 'Automation', 'Metrics', 'Pending', 'Team', 'More', 'Account menu', 'Availability', 'Language', 'Theme', 'System', 'Light', 'Dark', 'Animations', 'My account', 'Help and APIs', 'Keyboard shortcuts', 'Sign out', 'Find a page', 'Quick navigation', 'Sidebar', 'Open menu', 'You are here', 'Operator', 'Not in service', 'Test environment · synthetic data and simulated connections.']) assert.ok(text.includes(copy), copy);
  for (const copy of ['Pular para o conteúdo', 'Navegação principal', 'Pendências', 'Menu da conta', 'Disponibilidade', 'Animações', 'Minha conta', 'Ajuda e APIs', 'Atalhos do teclado', 'Navegação rápida', 'Você está aqui', 'Mais opções']) assert.ok(!text.includes(copy), 'PT restante: ' + copy);
  assert.match(text, /Acme Atendimento/); assert.match(text, /Loja Centro/); assert.match(text, /Atendente QA/, 'nome da pessoa intacto');
  assert.equal(served({ view: 'team' }).document.title, 'Team · Acme Atendimento');
});

test('shell.css: camada shell, só tokens, gaveta e barra abaixo de 900 px, trilho por data-sh-layout', () => {
  const css = publicFile('shell.css'), items = parseCss(css);
  assert.deepEqual(items.map(item => item.prelude), ['@layer shell']);
  const rules = cssRules(items);
  const hides = (selector, media) => rules.some(rule => rule.context.includes(media) && rule.selector.split(',').map(part => part.trim()).includes(selector) && rule.declarations.some(({ property, value }) => property === 'display' && value === 'none'));
  for (const selector of ['.sh-bottombar', '.sh-sheet', '.sh-scrim', '.sh-topbar__menu']) assert.ok(hides(selector, '@media (min-width: 900px)'), `${selector} só abaixo de 900 px`);
  for (const selector of ['.sh-topbar__pending', '.sh-topbar__team', '.sh-topbar__rail']) assert.ok(hides(selector, '@media (max-width: 899.98px)'), `${selector} vai para a barra inferior no celular`);
  assert.ok(rules.some(rule => rule.selector === '.sh-app[data-sh-layout="rail"]' && rule.declarations.some(({ property, value }) => property === '--sh-offset' && value === 'var(--sidebar-rail)')), 'trilho desloca o conteúdo 64 px');
  assert.ok(rules.some(rule => rule.selector === '.sh-sidebar[data-state="open"]'), 'gaveta aberta por data-state');
  assert.ok(rules.some(rule => rule.selector === '.sh-app [hidden]'), '[hidden] continua valendo dentro do shell');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|!important|\.app-shell\[data-view/i);
  const index = publicFile('index.html'), links = [...index.matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map(match => match[1]);
  assert.deepEqual(links.slice(0, 4), ['tokens.css', 'base.css', 'components.css', 'shell.css']);
  // P10: the spacing of main#main-content.content lives here, on the page gutter.
  assert.ok(rules.some(rule => rule.context.length === 1 && rule.selector === '#main-content.content' && rule.declarations.some(({ property, value }) => property === 'padding' && value === 'var(--space-8) var(--gutter) var(--space-12)')));
  // P10: View Transitions of a screen change: fixed names for the frame, a fade for the content, none with reduced motion.
  const named = Object.fromEntries(rules.filter(rule => rule.declarations.some(({ property }) => property === 'view-transition-name')).map(rule => [rule.selector, rule.declarations.find(({ property }) => property === 'view-transition-name').value]));
  assert.deepEqual(named, { '.sh-sidebar': 'sh-sidebar', '.sh-topbar': 'sh-topbar', '.sh-bottombar': 'sh-bottombar', '.sh-main > main': 'sh-content' });
  const still = rule => rule.declarations.some(({ property, value }) => property === 'animation' && value === 'none');
  assert.ok(rules.some(rule => rule.context.includes('@media (prefers-reduced-motion: reduce)') && rule.selector.includes('::view-transition-new(*)') && still(rule)), 'movimento reduzido do sistema: sem animação');
  assert.ok(rules.some(rule => rule.selector.includes(':root[data-motion="reduced"]::view-transition-old(*)') && still(rule)), '"Reduzidas": sem animação');
});

test('Tema do menu da conta (P10): a escolha é salva por pessoa e aplicada na hora, sem render', () => {
  withStorage({ 'elozi:prefs:tema-qa': JSON.stringify({ density: 'compact' }) }, storage => {
    const doc = createDocument(served().html);
    syncThemePrefs(doc.documentElement, 'tema-qa', storage);
    shell.installShell(doc);
    const pick = value => { const input = doc.querySelector(`input[name="shell-theme"][value="${value}"]`); input.checked = true; doc.dispatch('change', { target: input }); };
    pick('dark');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.deepEqual(JSON.parse(storage.values.get('elozi:prefs:tema-qa')), { density: 'compact', theme: 'dark', motion: 'system', privacy: 'off' }, 'merge com as outras preferências');
    pick('light');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'light', 'Claro vence o sistema escuro');
    pick('system');
    assert.equal(doc.documentElement.hasAttribute('data-theme'), false, 'Sistema: segue prefers-color-scheme');
    assert.equal(JSON.parse(storage.values.get('elozi:prefs:tema-qa')).theme, 'system');
  });
});

// Shell actions and account-menu changes of app.js (anchor shell-actions) over the real shell markup;
// real: true wires the real popovers of installShell on the same document instead of recording effects.
function actions({ mobile = true, menuOpen = false, view = 'overview', api: respond, real = false } = {}) {
  const doc = createDocument(served({ mobile, menuOpen, view }).html), calls = [], toasts = [], effects = [];
  const modal = { open: false };
  const state = { view, menuOpen, busy: false, avatarLoading: false, boot: { session: { userId: 'admin-qa', name: 'Admin QA', presence: 'busy', locale: 'pt-BR' } }, account: { user: {} } };
  const shellUI = real ? shell.installShell(doc) : { open: (name, options) => effects.push(['open', name, options?.focus || null]), close: () => effects.push(['close']) };
  const queries = { [shell.SHELL_MOBILE_QUERY]: mobile, [shell.SHELL_WIDE_QUERY]: true, [shell.SHELL_XWIDE_QUERY]: false };
  const globals = {
    ...i18n, ...shell, state, shellUI, document: doc, matchMedia: query => ({ matches: Boolean(queries[query]) }),
    $: selector => selector === '#modal' ? modal : selector === '#app' ? doc.body : doc.querySelector(selector),
    changeWorkspace: async (...args) => effects.push(['workspace', ...args]), changeTenant: async id => effects.push(['tenant', id]),
    navigate: next => { effects.push(['navigate', next]); state.view = next; }, openModal: (title, description, content) => effects.push(['modal', title, description, content]),
    toast: (message, error = false) => toasts.push([message, error]), render: () => effects.push(['render']),
    api: async (path, options) => { calls.push([path, JSON.parse(options.body)]); if (respond) return respond(path, options); throw new Error('sem resposta'); },
    captureLocaleFormState, restoreLocaleFormState, voiceRecorder: { busy: false }, mediaUI: { sending: false },
    updateThemePrefs: (root, userId, patch) => effects.push(['prefs', root === doc.documentElement, userId, { ...patch }]),
    chatLayout: { collapsed: false }
  };
  const api = runInNewContext(excerpt('shell-actions') + '\n({shellAction,shellChange,syncShellLayout})', globals);
  return { ...api, doc, state, calls, toasts, effects, modal, shellUI };
}

test('ações do shell: escopo fecha a gaveta e usa as guardas de troca; sino, Equipe, atalhos e chip do celular', async () => {
  const f = actions({ mobile: true, menuOpen: true }), sidebar = f.doc.getElementById('sh-sidebar');
  assert.equal(sidebar.getAttribute('data-state'), 'open');
  await f.shellAction('shell:workspace', 'client-b', { dataset: { grant: 'grant-b' } });
  assert.equal(f.state.menuOpen, false); assert.equal(sidebar.hasAttribute('inert'), true, 'a gaveta fecha antes de trocar');
  await f.shellAction('shell:workspace', 'acme', { dataset: { grant: '' } });
  await f.shellAction('shell:tenant', 'store-norte');
  await f.shellAction('shell:workspace', '', { dataset: {} }); await f.shellAction('shell:tenant', '');
  assert.deepEqual(f.effects.filter(([kind]) => ['workspace', 'tenant'].includes(kind)), [['workspace', 'client-b', 'grant-b'], ['workspace', 'acme', null], ['tenant', 'store-norte']], 'troca só pelas funções com guarda');
  await f.shellAction('shell:team');
  assert.deepEqual(f.effects.at(-1), ['navigate', 'team-chat']);
  const queue = { tabIndex: 0, focused: null, scrolled: null, focus(options) { this.focused = { ...options }; }, scrollIntoView(options) { this.scrolled = { ...options }; } };
  const bell = actions({ mobile: false }), original = bell.doc.querySelector;
  bell.doc.querySelector = selector => selector === '#overview-queue-title' ? queue : original(selector);
  await bell.shellAction('shell:pending');
  assert.deepEqual(bell.effects.at(-1), ['navigate', 'overview']); assert.equal(queue.tabIndex, -1);
  assert.deepEqual(queue.focused, { preventScroll: true }); assert.deepEqual(queue.scrolled, { block: 'start' }, 'o sino leva à lista de prioridade da Visão geral');
  await bell.shellAction('shell:shortcuts');
  const [, title, description, content] = bell.effects.at(-1);
  assert.deepEqual([title, description], ['Atalhos do teclado', 'Atalhos disponíveis nesta versão.']);
  assert.match(content, /<ul class="sh-shortcuts">/); assert.ok(bell.effects.some(([kind]) => kind === 'close'), 'o menu da conta fecha antes do diálogo');
  const chip = actions({ mobile: true });
  await chip.shellAction('shell:scope');
  assert.equal(chip.state.menuOpen, true); assert.equal(chip.doc.getElementById('sh-sidebar').getAttribute('data-state'), 'open');
  assert.deepEqual(chip.effects.at(-1), ['open', 'scope', null], 'no celular o chip abre a gaveta e o seletor');
  const desktop = actions({ mobile: false });
  await desktop.shellAction('shell:scope');
  assert.equal(desktop.state.menuOpen, false); assert.deepEqual(desktop.effects, [['open', 'scope', null]]);
  desktop.syncShellLayout();
  assert.equal(desktop.doc.querySelector('.sh-app').getAttribute('data-sh-layout'), 'full');
});

test('chip de escopo no celular: o toque que abre a gaveta e o seletor não fecha o seletor ao chegar ao document', async () => {
  const f = actions({ mobile: true, real: true }), doc = f.doc;
  const chip = doc.querySelector('button.sh-scopechip[data-action="shell:scope"]'), toggle = doc.querySelector('[data-shell-toggle="scope"]'), panel = doc.getElementById('sh-scope-panel');
  assert.ok(chip, 'com duas empresas o chip troca o escopo');
  // A real tap: the #app listener resolves its awaits (dispatchAction → shellAction) in the microtask
  // checkpoint between listeners, so the panel is already open when installShell sees the same click.
  await f.shellAction('shell:scope', undefined, chip);
  doc.dispatch('click', { target: chip });
  assert.equal(panel.hidden, false, 'o seletor continua aberto depois do mesmo toque'); assert.equal(f.shellUI.openPanel, 'scope');
  assert.equal(f.state.menuOpen, true); assert.equal(doc.querySelector('.sh-main').hasAttribute('inert'), true, 'a gaveta abre com o topo inerte');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'o estado fica no gatilho da gaveta'); assert.equal(chip.hasAttribute('aria-expanded'), false);
  assert.ok(panel.contains(doc.activeElement), 'o foco fica no seletor visível, não cai no body');
  const escape = doc.dispatch('keydown', { key: 'Escape', target: doc.activeElement });
  assert.equal(escape.defaultPrevented, true, 'Esc fica com o seletor e não fecha a gaveta'); assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, toggle, 'o foco volta ao gatilho dentro da gaveta, não ao chip inerte');
  await f.shellAction('shell:scope', undefined, chip); doc.dispatch('click', { target: chip });
  assert.equal(panel.hidden, false);
  doc.dispatch('click', { target: doc.querySelector('.sh-scrim') });
  assert.equal(panel.hidden, true, 'um toque fora do seletor ainda fecha'); assert.equal(f.shellUI.openPanel, null);
  doc.dispatch('click', { target: chip });
  assert.equal(panel.hidden, true, 'o chip sozinho não reabre nem alterna: só a ação do app abre');
});

test('menu da conta: idioma com as guardas de antes, disponibilidade com reversão e animações por pessoa', async () => {
  const pick = (f, name, value) => { const radio = f.doc.querySelector(`input[name="${name}"][value="${value}"]`); radio.checked = true; return { target: radio }; };
  const checked = (f, name) => f.doc.querySelector(`input[name="${name}"]:checked`).value;
  const refused = actions({ api: () => assert.fail('troca recusada não chama a API') });
  refused.modal.open = true;
  assert.equal(await refused.shellChange(pick(refused, 'shell-locale', 'en')), true);
  assert.equal(checked(refused, 'shell-locale'), 'pt-BR'); assert.deepEqual(refused.toasts.at(-1), ['Finalize ou feche o formulário aberto antes de trocar o idioma.', true]);
  refused.modal.open = false; refused.doc.querySelector('main').innerHTML = '<input type="password" value="segredo">';
  await refused.shellChange(pick(refused, 'shell-locale', 'en'));
  assert.equal(checked(refused, 'shell-locale'), 'pt-BR'); assert.deepEqual(refused.toasts.at(-1), ['Salve ou limpe os campos privados antes de trocar o idioma.', true]);
  refused.doc.querySelector('main').innerHTML = ''; refused.state.busy = true;
  await refused.shellChange(pick(refused, 'shell-locale', 'en'));
  assert.deepEqual(refused.toasts.at(-1), ['Finalize a gravação ou o envio antes de trocar o idioma.', true]); assert.equal(refused.calls.length, 0);
  const saved = actions({ api: () => ({ user: { id: 'admin-qa', locale: 'en' } }) });
  await saved.shellChange(pick(saved, 'shell-locale', 'en'));
  assert.deepEqual(saved.calls, [['/api/auth/me', { locale: 'en' }]]); assert.equal(i18n.getLocale(), 'en'); assert.equal(saved.state.boot.session.locale, 'en');
  assert.deepEqual(saved.effects, [['render'], ['open', 'account', 'input[name="shell-locale"]:checked']], 'redesenha e reabre o menu da conta no idioma novo');
  assert.deepEqual(saved.toasts, [['Language saved.', false]]); assert.equal(saved.state.localeSaving, false);
  locale('pt-BR');
  const failed = actions();
  await failed.shellChange(pick(failed, 'shell-locale', 'en'));
  assert.equal(checked(failed, 'shell-locale'), 'pt-BR'); assert.equal(i18n.getLocale(), 'pt-BR');
  assert.deepEqual(failed.toasts, [['Não foi possível salvar o idioma. Sua preferência anterior foi mantida.', true]]);
  const presence = actions({ api: () => ({ user: { presence: 'away' } }) });
  await presence.shellChange(pick(presence, 'shell-presence', 'away'));
  assert.deepEqual(presence.calls, [['/api/auth/presence', { presence: 'away' }]]); assert.equal(presence.state.boot.session.presence, 'away');
  assert.equal(presence.doc.querySelector('.sh-account__trigger .ui-avatar').getAttribute('data-presence'), 'away'); assert.deepEqual(presence.toasts, [['Disponibilidade atualizada.', false]]);
  const rejected = actions({ api: () => { throw new Error('Disponibilidade recusada.'); } });
  await rejected.shellChange(pick(rejected, 'shell-presence', 'offline'));
  assert.equal(checked(rejected, 'shell-presence'), 'busy', 'volta para a disponibilidade confirmada'); assert.deepEqual(rejected.toasts, [['Disponibilidade recusada.', true]]);
  rejected.state.presenceSaving = true; await rejected.shellChange(pick(rejected, 'shell-presence', 'away'));
  assert.equal(checked(rejected, 'shell-presence'), 'busy'); assert.equal(rejected.calls.length, 1, 'uma troca por vez');
  const motion = actions();
  assert.equal(await motion.shellChange(pick(motion, 'shell-motion', 'reduced')), true);
  assert.deepEqual(motion.effects.at(-1), ['prefs', true, 'admin-qa', { motion: 'reduced' }]);
  assert.equal(await motion.shellChange({ target: { name: 'contacts-archived' } }), false, 'outros campos seguem para os handlers legados');
});
