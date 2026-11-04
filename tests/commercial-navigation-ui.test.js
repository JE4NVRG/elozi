import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import { createAccountsUI } from '../public/accounts-ui.js';
import { createCommercialUsageUI } from '../public/commercial-usage-ui.js';
import { createUnitsUI } from '../public/units-ui.js';
import { createMediaUI } from '../public/media-ui.js';
import { createPlatformUsersUI } from '../public/platform-users-ui.js';
import { applyBrandTokens, brandTokenEntries, deriveBrandTokens, INK } from '../public/brand-theme.js';
import { syncThemePrefs } from '../public/theme-prefs.js';
import { excerpt } from './helpers/app-source.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';
// render() frames each view with the hub of settings-ui.js (P8: Configurações, Plataforma, Clientes, Indicadores).
import { screenFrame } from '../public/settings-ui.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const navigationAndRender = excerpt('navigation-heading');
const roleLabel = source.split('\n').find(line => line.startsWith('const roleLabel = '));
const attendanceContext = source.split('\n').find(line => line.startsWith('const attendanceContext='));
const commercialViews = [
  source.split('\n').find(line => line.trim().startsWith('platform: () => accountsUI.markup(')),
  source.split('\n').find(line => line.trim().startsWith('accounts: () => accountsUI.markup(')),
  source.split('\n').find(line => line.trim().startsWith("'platform-users': () => platformUsersUI.view()")),
  source.split('\n').find(line => line.trim().startsWith('tenants() { return unitsUI.markup();'))
];
assert.ok(roleLabel && attendanceContext && commercialViews.every(Boolean), 'Views comerciais reais continuam ligadas às factories.');

function fixture({ kind = 'business', role = 'reseller', owner = false, tenant = true, support = false, view = 'overview', permissions = null } = {}) {
  const app = { innerHTML: '' }, styles = [], attributes = [], effects = [], calls = [];
  const brand = { name: 'Elozi QA', initials: 'EQ', accent: '#58c8aa', logo: '' };
  const workspaceId = kind === 'platform' ? 'mep-demo' : kind + '-qa';
  const units = tenant ? [
    { id: 'matrix-qa', name: 'Matriz <QA>', parentTenantId: null, segment: 'Teste', channels: 2, conversations: 3 },
    { id: 'branch-qa', name: 'Filial & QA', parentTenantId: 'matrix-qa', segment: 'Teste', channels: 1, conversations: 1 }
  ] : [];
  const state = {
    view, workspaceId, supportGrantId: support ? 'grant-qa' : null, conversation: null, sendIntent: null,
    boot: {
      version: '0.20.0', sandbox: true, csrfToken: 'csrf-qa', tenants: units,
      reseller: { id: workspaceId, name: 'Conta <QA>', accountKind: kind, brand },
      workspaces: [{ id: workspaceId, name: 'Conta <QA>', platformWorkspace: kind === 'platform', supportGrantId: support ? 'grant-qa' : null }],
      session: { userId: 'person-qa', resellerId: workspaceId, name: 'Pessoa <QA>', role, platformOwner: owner, platformAdmin: owner, permissions, presence: 'available', supportGrantId: support ? 'grant-qa' : null, supportReason: 'Caso sintético', supportExpiresAt: '2026-10-04T12:00:00Z' }
    },
    tenant: tenant ? { ...units[0], brand, conversations: [] } : null,
    account: { google: { enabled: false }, user: { googleLinked: false } }
  };
  const api = async (path, options) => { calls.push({ path, options }); assert.fail('Render e navegação não devem criar contas ou buscar dados por efeito colateral.'); };
  const dependencies = { state, api, escape, icon: () => '', openModal: () => assert.fail('Render não deve abrir um modal.'), render: () => {}, toast: () => {}, getModal: () => null };
  const accountsUI = createAccountsUI(dependencies);
  const unitsUI = createUnitsUI({ ...dependencies, formModal: () => assert.fail('Render não deve criar uma unidade.'), refresh: async () => {} });
  const mediaUI = createMediaUI({ escape, icon: () => '', download: api, getPendingSend: () => Boolean(state.sendIntent) });
  const operationalView = name => () => { assert.ok(state.tenant, `${name} requer uma empresa selecionada`); return `<section data-rendered-view="${name}">Operação QA</section>`; };
  const globals = {
    ...i18n,
    state, escape, icon: () => '', accountsUI, unitsUI, commercialUsageUI: createCommercialUsageUI(dependencies),
    channelVisitorTestUI: { syncContext() { effects.push('visitor-sync'); }, reset() {} },
    platformUsersUI: createPlatformUsersUI({ ...dependencies, request: api, getContext: () => ({ workspaceId: state.workspaceId, userId: state.boot.session.userId, platformOwner: state.boot.session.platformOwner, supportGrantId: state.supportGrantId, active: state.view === 'platform-users' }) }),
    $: selector => selector === '#app' ? app : null,
    document: { title: '', documentElement: { style: { setProperty: (...args) => styles.push(args) }, setAttribute: (...args) => attributes.push(['set', ...args]), removeAttribute: name => attributes.push(['remove', name]) } },
    applyBrandTokens, deriveBrandTokens, syncThemePrefs, ...nav, ...shell, screenFrame,
    matchMedia: () => ({ matches: false }),
    avatarMarkup: name => `<span class="avatar">${escape(name)}</span>`,
    presenceNames: { available: 'Disponível' },
    hasPermission: permission => !permissions || permissions.includes(permission),
    activeConversations: () => [], selectedInboxRef: () => null, inboxIdentity: value => value ? JSON.stringify(value) : '',
    consolidatedInbox: { data: { counts: {} }, saveDraft: () => true, getDraft: () => '' },
    noteDrafts: { key: null }, mediaUI,
    forwarding: { close: () => effects.push('forwarding.close') }, syncAttendanceTools: () => effects.push('attendance.sync'),
    repliesUI: { retainConversations() {}, syncContext() {} }, voiceRecorder: { syncContext() {} },
    canReplyTo: () => false, isRealConversation: () => false,
    currentConversation: () => state.tenant?.conversations.find(item => item.id === state.conversation),
    chatLayout: { sync: () => effects.push('layout.sync') }, avatarUI: { bind: () => effects.push('avatar.bind') },
    integrationsUI: { bind() {} }, teamChatUI: { bind() {} }, groupsWorkspaceUI: { bind() {},syncContext() {},reset() {} }, memoryUI: { syncContext() {} }, telegramAccountUI: { sync() {} }, refreshScopedConversationRuns: async () => false, bindInboxMedia() {}, composerStatus() {},
    afterRender: view => effects.push('after-render:' + view),
    toast: () => assert.fail('Navegação comercial não deve perder rascunhos.'),
    operation: operationalView,
    accountView: () => '<section data-rendered-view="account">Minha conta QA</section>'
  };
  const views = `const views = {${commercialViews.join('\n')} overview: operation('overview'), inbox: operation('inbox'), team: operation('team'), billing: operation('billing'), account: accountView};`;
  const loaded = runInNewContext(roleLabel + '\n' + attendanceContext + '\n' + views + '\n' + navigationAndRender + '\n({render,navigationMarkup,allowedNavigation,roleLabel,attendanceContext})', globals);
  return { ...loaded, state, app, styles, attributes, effects, calls, globals };
}

function assertMissingNavigation(html, keys) {
  for (const key of keys) assert.equal(html.includes(`data-view="${key}"`), false, `Não expor navegação ${key}`);
}

test('administrador principal sem empresa abre o painel global real, com gestão comercial e sem operação fictícia', () => {
  const f = fixture({ kind: 'platform', owner: true, tenant: false });
  assert.doesNotThrow(() => f.render());
  assert.equal(f.state.view, 'platform');
  assert.match(f.app.innerHTML, /Contas da plataforma/);
  assert.match(f.app.innerHTML, /Administração principal/);
  assert.match(f.app.innerHTML, /Administrador da plataforma/);
  assert.match(f.app.innerHTML, /Gestão das contas/);
  // Usuários globais is a tab of the Plataforma hub (§2.2); the menu keeps one item per area (§2.1).
  assert.match(f.app.innerHTML, /href="#platform\/users"/);
  assert.match(f.app.innerHTML, /data-accounts-action="create"/);
  assertMissingNavigation(f.navigationMarkup(), ['overview', 'inbox', 'team-chat', 'contacts', 'channels', 'agents', 'service-agents']);
  assert.match(f.navigationMarkup(), /data-view="platform"/);
  // Scope selector of the shell (§2.3): no company list in account management.
  assert.equal(f.app.innerHTML.includes('data-action="shell:tenant"'), false);
  assert.equal(f.allowedNavigation('platform-users'), true, 'A página global usa a mesma autorização da navegação servida.');
  assert.equal(f.calls.length, 0);
  assert.equal(f.effects[0], 'visitor-sync', 'a reconciliação do visitante precede o render global sem empresa');
  // render() applies the tokens derived from the reseller brand (FRONTEND-V2 §3.3) instead of writing
  // --accent on <html>: the frozen alias --accent resolves to --b-accent-l, so legacy screens keep the
  // brand solid, and #58c8aa (1,9:1 with white) gets ink text on primary buttons.
  assert.deepEqual(f.styles, brandTokenEntries(deriveBrandTokens('#58c8aa')));
  assert.equal(f.styles.some(([name]) => name === '--accent'), false, 'o alias congelado --accent não é sobrescrito no elemento');
  assert.deepEqual(f.styles.find(([name]) => name === '--b-accent-l'), ['--b-accent-l', '#58c8aa']);
  assert.deepEqual(f.styles.find(([name]) => name === '--b-on-accent-l'), ['--b-on-accent-l', INK]);
  assert.ok(f.attributes.some(([kind, name]) => kind === 'remove' && name === 'data-agent-hue'), 'matiz da marca longe do violeta mantém a cor de agente padrão');
  assert.equal(f.attributes.some(([kind, name]) => kind === 'set' && name === 'data-theme'), false, 'tema escuro travado até o P10');
  assert.ok(f.effects.includes('layout.sync'));
  f.state.view = 'platform-users'; f.render();
  assert.equal(f.state.view, 'platform-users');
  assert.match(f.app.innerHTML, /data-platform-users-panel/);
  assert.match(f.app.innerHTML, /Usuários globais/);
  assert.match(f.app.innerHTML, /Consultar este diretório não concede acesso/);
  assert.equal(f.calls.length, 0, 'Renderizar a página não deve criar uma consulta ou mutação implícita.');
});

for (const [kind, accountTitle, contextLabel, profile, canCreate] of [
  ['reseller', 'Sua conta e seus clientes', 'Revenda white label', 'Administrador da revenda', true],
  ['business', 'Sua empresa', 'Empresa e filiais', 'Administrador da empresa', false]
]) {
  test(`${kind} sem empresa abre sua conta comercial real e preserva a distinção do administrador principal`, () => {
    const f = fixture({ kind, tenant: false });
    assert.doesNotThrow(() => f.render());
    assert.equal(f.state.view, 'accounts');
    for (const label of [accountTitle, contextLabel, profile]) assert.ok(f.app.innerHTML.includes(label), label);
    assert.equal(f.app.innerHTML.includes('data-accounts-action="create"'), canCreate);
    assertMissingNavigation(f.navigationMarkup(), ['platform', 'platform-billing', 'integrations', 'overview', 'inbox']);
    assert.equal(f.app.innerHTML.includes('href="#platform/users"'), false);
    assert.equal(f.allowedNavigation('platform-users'), false);
    assert.equal(f.app.innerHTML.includes('data-action="shell:tenant"'), false);
    assert.equal(f.calls.length, 0);
  });
}

test('empresa com matriz e filial usa o módulo real de unidades, nomes escapados e acesso comercial próprio', () => {
  const f = fixture({ kind: 'business', view: 'tenants' });
  f.render();
  assert.equal(f.state.view, 'tenants');
  assert.match(f.app.innerHTML, /Matriz &lt;QA&gt;/);
  assert.match(f.app.innerHTML, /Filial &amp; QA/);
  assert.match(f.app.innerHTML, /O vínculo com a matriz organiza o painel; ele não amplia as permissões/);
  assert.match(f.app.innerHTML, /data-action="new-tenant"/);
  // The scope selector lists the two units of the account (§2.3) through the guarded shell:tenant action (changeTenant).
  assert.match(f.app.innerHTML, /data-action="shell:tenant" data-id="matrix-qa" data-shell-option data-shell-search="Matriz &lt;QA&gt;" aria-current="true"/);
  assert.match(f.app.innerHTML, /data-action="shell:tenant" data-id="branch-qa"/);
  // §2.1: Clientes is the reseller's (and the owner's) item; a direct account keeps its commercial page as a route.
  assert.match(f.navigationMarkup(), /data-view="tenants" aria-current="page"/);
  assertMissingNavigation(f.navigationMarkup(), ['accounts', 'platform', 'platform-billing', 'integrations']);
  assert.equal(nav.legacyRouteAllowed('accounts', nav.navContext({ session: f.state.boot.session, hasTenant: true, accountKind: 'business' })), true);
  assert.equal(f.calls.length, 0);
});

test('atendente comum não recebe gestão comercial ou global e route proibida volta para uma empresa válida', () => {
  const f = fixture({ role: 'operator', view: 'accounts', permissions: ['inbox.read'] });
  f.render();
  assert.equal(f.state.view, 'overview');
  assert.match(f.app.innerHTML, /data-rendered-view="overview"/);
  assert.match(f.app.innerHTML, /<small>Atendente<\/small>/);
  assertMissingNavigation(f.navigationMarkup(), ['platform', 'platform-billing', 'accounts', 'team', 'tenants', 'brand', 'service-agents', 'billing', 'contacts', 'metrics', 'flows']);
  assert.equal(f.app.innerHTML.includes('href="#platform/users"'), false);
  assert.equal(f.allowedNavigation('platform-users'), false);
});

test('suporte temporário permanece no atendimento, sem chat interno ou painéis de administração', () => {
  const f = fixture({ role: 'operator', support: true, view: 'platform', permissions: ['inbox.read'] });
  f.render();
  assert.equal(f.state.view, 'overview');
  assert.match(f.app.innerHTML, /Suporte temporário/);
  assert.match(f.app.innerHTML, /data-action="support-exit"/);
  assertMissingNavigation(f.navigationMarkup(), ['platform', 'platform-billing', 'integrations', 'accounts', 'team-chat', 'team', 'tenants', 'brand', 'service-agents', 'billing']);
  assert.match(f.navigationMarkup(), /data-view="inbox"/);
  assert.equal(f.app.innerHTML.includes('data-action="shell:team"'), false, 'suporte temporário não recebe a Equipe (§2.1)');
});

for (const view of ['team', 'tenants', 'billing']) {
  test(`atendente sem empresa não abre a operação ao pedir a página administrativa ${view}`, () => {
    const f = fixture({ role: 'operator', tenant: false, view, permissions: ['inbox.read'] });
    assert.doesNotThrow(() => f.render());
    assert.equal(f.state.view, 'account');
    assert.match(f.app.innerHTML, /data-rendered-view="account"/);
    assert.equal(f.calls.length, 0);
  });
}
