// Navigation non-regression (FRONTEND-V2 §2.1, §8.2 P1d). public/nav-config.js now holds the access
// rules of the legacy views; this oracle is a LITERAL copy of the code it replaced in public/app.js
// at c0d1e00: hasPermission (lines 100-103), allowedNavigation (line 601) and the guard at the top
// of render() (lines 625-628). For every platformOwner × role × supportGrantId × hasTenant ×
// permissions, the legacy keys must keep exactly the same menu visibility and the same landing view.
// Never edit the oracle to make a change pass: a different access rule is a product decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import * as nav from '../public/nav-config.js';
import { parseHash } from '../public/router.js';
import { ICON_NAMES } from '../public/icons.js';
import { OPERATOR_DEFAULT_PERMISSIONS } from '../src/access.js';
import { excerpt } from './helpers/app-source.js';

const ORACLE_PERMISSION = `const hasPermission = permission => {
  const session = state.boot?.session;
  return Boolean(session && (session.role === 'reseller' || session.permissions == null || session.permissions.includes(permission)));
};`;
const ORACLE_NAVIGATION = `function allowedNavigation(key) { return (!['platform','platform-users','platform-billing','integrations'].includes(key)||state.boot.session.platformOwner&&!state.supportGrantId) && (!['accounts','team','knowledge','tenants','brand','service-agents','billing'].includes(key)||state.boot.session.role==='reseller'&&!state.supportGrantId) && (Boolean(state.tenant)||['platform','platform-users','accounts','tenants','team','support','billing','platform-billing','integrations','guide'].includes(key)) && (key!=='team-chat'||!state.supportGrantId) && (key!=='groups'||hasPermission('inbox.read')) && (key!=='contacts'||hasPermission('contacts.read')) && (key!=='metrics'||hasPermission('metrics.read')) && (key!=='flows'||hasPermission('flows.read')); }`;
const ORACLE_RENDER_GUARD = `  if(!state.tenant&&!['platform','platform-users','accounts','tenants','team','support','billing','platform-billing','account','integrations','guide'].includes(state.view))state.view=state.boot.session.platformOwner?'platform':state.boot.session.role==='reseller'?'accounts':'account';
  if(['platform','platform-users','platform-billing','integrations'].includes(state.view)&&(!state.boot.session.platformOwner||state.supportGrantId))state.view=state.tenant?'overview':'account';
  if(state.view==='accounts'&&(state.boot.session.role!=='reseller'||state.supportGrantId))state.view=state.tenant?'overview':'account';
  if((state.view==='team-chat'&&state.supportGrantId)||(state.view==='groups'&&!hasPermission('inbox.read'))||(state.view==='contacts'&&!hasPermission('contacts.read'))||(state.view==='flows'&&!hasPermission('flows.read'))||(state.view==='metrics'&&!hasPermission('metrics.read'))||(['team','knowledge','service-agents','billing','tenants','brand'].includes(state.view)&&state.boot.session.role!=='reseller')||(state.view==='platform-billing'&&!state.boot.session.platformOwner))state.view=state.tenant?'overview':'account';`;
const oracle = state => runInNewContext(`${ORACLE_PERMISSION}\n${ORACLE_NAVIGATION}\nfunction guard(view){state.view=view;\n${ORACLE_RENDER_GUARD}\nreturn state.view;}\n({allowedNavigation,guard,hasPermission})`, { state });

// The 25 keys of `views` in public/app.js (unchanged by the new navigation).
const LEGACY = ['platform-users', 'guide', 'platform', 'accounts', 'team-chat', 'groups', 'knowledge', 'overview', 'inbox', 'channels', 'agents', 'flows', 'tenants',
  'brand', 'account', 'integrations', 'architecture', 'team', 'contacts', 'metrics', 'support', 'service-agents', 'billing', 'platform-billing', 'automation'];
const RELEVANT = ['inbox.read', 'contacts.read', 'metrics.read', 'flows.read'];
const subsets = RELEVANT.reduce((all, permission) => all.concat(all.map(set => [...set, permission])), [[]]);
const PERMISSIONS = [null, undefined, ...subsets, ['inbox.reply', 'contacts.write']];
const ACCOUNT_KINDS = ['business', 'reseller', 'platform'];
function* combinations() {
  for (const platformOwner of [false, true]) for (const role of ['reseller', 'operator', undefined]) for (const supportGrantId of [null, 'grant-qa'])
    for (const hasTenant of [false, true]) for (const permissions of PERMISSIONS) for (const accountKind of ACCOUNT_KINDS) {
      const session = { userId: 'person-qa', role, platformOwner, permissions, supportGrantId };
      const state = { view: 'overview', supportGrantId, tenant: hasTenant ? { id: 'tenant-qa' } : null, boot: { session, reseller: { accountKind } } };
      yield { state, session, label: JSON.stringify({ platformOwner, role, supportGrantId, hasTenant, permissions, accountKind }) };
    }
}
const contextOf = ({ state, session }) => nav.navContext({ session, supportGrantId: state.supportGrantId, hasTenant: Boolean(state.tenant), accountKind: state.boot.reseller.accountKind });

test('as chaves legadas de nav-config.js são exatamente as 25 views de app.js', () => {
  assert.equal(LEGACY.length, 25);
  assert.deepEqual([...nav.LEGACY_KEYS].sort(), [...LEGACY].sort());
});

test('matriz: visibilidade, rota permitida e destino do guard iguais ao oráculo literal em toda combinação', () => {
  let checks = 0, combos = 0;
  for (const combination of combinations()) {
    const { allowedNavigation, guard, hasPermission } = oracle(combination.state), ctx = contextOf(combination);
    combos++;
    for (const permission of [...RELEVANT, 'inbox.reply']) assert.equal(ctx.can(permission), hasPermission(permission), combination.label + ' can ' + permission);
    for (const key of LEGACY) {
      const landing = guard(key);
      assert.equal(nav.legacyVisible(key, ctx), Boolean(allowedNavigation(key)), `visible ${key} ${combination.label}`);
      assert.equal(nav.resolveView(key, ctx), landing, `resolveView ${key} ${combination.label}`);
      assert.equal(nav.legacyRouteAllowed(key, ctx), landing === key, `routeAllowed ${key} ${combination.label}`);
      if (nav.legacyVisible(key, ctx)) assert.ok(nav.legacyRouteAllowed(key, ctx), `${key} aparece no menu (e nas abas dos hubs) mas a rota redirecionaria ${combination.label}`);
      checks += 3;
    }
  }
  assert.equal(combos, 2 * 3 * 2 * 2 * PERMISSIONS.length * ACCOUNT_KINDS.length, 'todas as combinações foram geradas');
  assert.equal(checks, combos * LEGACY.length * 3);
});

test('o app servido usa nav-config: allowedNavigation e o guard de render() seguem o oráculo', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const guardLine = source.split('\n').find(line => line.trim() === 'state.view=resolveView(state.view,navigationContext());');
  assert.ok(guardLine, 'render() aplica resolveView');
  assert.equal(source.includes("state.view=state.tenant?'overview':'account'"), false, 'o guard antigo saiu de render()');
  assert.equal(source.includes('function allowedNavigation(key) { return legacyVisible(key, navigationContext()); }'), true);
  for (const combination of combinations()) {
    const state = structuredClone(combination.state);
    const served = runInNewContext(excerpt('permissions') + '\n' + excerpt('navigation-render') + `\n({allowedNavigation,guard(view){state.view=view;${guardLine.trim()}return state.view;}})`,
      { ...i18n, ...nav, state, icon: () => '', escape: String, consolidatedInbox: { data: { counts: {} } }, activeConversations: () => [] });
    const reference = oracle(structuredClone(combination.state));
    for (const key of LEGACY) {
      assert.equal(served.allowedNavigation(key), Boolean(reference.allowedNavigation(key)), `served visible ${key} ${combination.label}`);
      assert.equal(served.guard(key), reference.guard(key), `served guard ${key} ${combination.label}`);
    }
  }
});

test('cada view legada tem rota canônica própria e todo hash legado continua abrindo a mesma view', () => {
  const canonical = new Map();
  for (const key of LEGACY) {
    const hash = nav.hashForView(key);
    assert.equal(nav.viewForRoute(parseHash(hash)), key, `ida e volta ${key} → ${hash}`);
    assert.equal(nav.viewForRoute(parseHash('#' + key)), key, `hash legado #${key}`);
    assert.ok(!canonical.has(hash), `${hash} repetido`); canonical.set(hash, key);
  }
  assert.equal(nav.hashForView('knowledge'), '#agents/knowledge'); assert.equal(nav.hashForView('service-agents'), '#agents/connect');
  assert.equal(nav.hashForView('team-chat'), '#team-chat'); assert.equal(nav.hashForView('groups'), '#groups'); assert.equal(nav.hashForView('guide'), '#help');
  assert.equal(nav.viewForRoute(parseHash('#settings')), 'tenants'); assert.equal(nav.viewForRoute(parseHash('#settings/activity')), 'tenants', 'aba anunciada para o P8 abre a primeira');
  assert.equal(nav.viewForRoute(parseHash('#platform')), 'platform');
  // #automation/replies is the Respostas rápidas tab of the hub (P10): its own screen view and canonical hash.
  assert.equal(nav.viewForRoute(parseHash('#automation/replies')), 'quick-replies'); assert.equal(nav.hashForView('quick-replies'), '#automation/replies');
  assert.equal(nav.viewForRoute(parseHash('#automation/replies/reply-1')), 'quick-replies'); assert.equal(nav.navItemOf('quick-replies')?.key, 'automation');
  assert.equal(nav.viewForRoute(parseHash('#agents/usage')), 'agents', 'aba anunciada para o P5 abre a primeira'); assert.equal(nav.viewForRoute(parseHash('#agents/connect/verify')), 'service-agents');
  // #agents/tools is the Ferramentas tab (P1 commit 1g): its own screen view, with its own canonical hash.
  assert.equal(nav.viewForRoute(parseHash('#agents/tools')), 'agent-tools'); assert.equal(nav.hashForView('agent-tools'), '#agents/tools');
  // #pending and #setup open the stubs of pending-ui.js and onboarding-ui.js (P1 commit 1f), outside the menu.
  assert.equal(nav.viewForRoute(parseHash('#pending')), 'pending'); assert.equal(nav.viewForRoute(parseHash('#pending/approval/run-1')), 'pending');
  assert.equal(nav.viewForRoute(parseHash('#setup')), 'setup'); assert.equal(nav.viewForRoute(null), null);
  assert.equal(nav.hashForView('pending'), '#pending'); assert.equal(nav.hashForView('setup'), '#setup');
  assert.equal(nav.conversationHash({ tenantId: 'tenant-a', conversationId: 'case-a', workspaceId: 'workspace-a' }), '#inbox/tenant-a/case-a?w=workspace-a');
  assert.equal(nav.conversationHash({ tenantId: 'tenant a', conversationId: 'case-a', workspaceId: 'workspace-a' }), '#inbox?w=workspace-a', 'ID fora da gramática não gera link quebrado');
});

test('menu novo: dez itens com ícones únicos existentes; visível implica rota permitida; papéis do §2.1', () => {
  const items = nav.NAV_ITEMS;
  assert.equal(items.length, 10);
  assert.deepEqual(items.map(item => item.key), ['overview', 'inbox', 'contacts', 'agents', 'automation', 'channels', 'metrics', 'accounts', 'platform', 'settings']);
  assert.deepEqual(items.map(item => item.icon), ['home', 'inbox', 'contacts', 'spark-bot', 'workflow', 'plug', 'chart', 'briefcase', 'server', 'gear']);
  assert.equal(new Set(items.map(item => item.icon)).size, items.length); for (const item of items) assert.ok(ICON_NAMES.includes(item.icon), item.icon);
  for (const item of items) { assert.ok(item.views.includes(nav.viewForRoute(parseHash(item.route))), item.key); assert.ok(nav.NAV_SECTIONS.some(section => section.id === item.section)); }
  for (const key of LEGACY.filter(key => !['team-chat', 'account', 'guide'].includes(key))) assert.ok(nav.navItemOf(key), key + ' pertence a um item do menu');
  for (const combination of combinations()) {
    const ctx = contextOf(combination);
    for (const item of items) if (item.visible(ctx)) assert.ok(item.routeAllowed(ctx), `${item.key} visível sem rota ${combination.label}`);
  }
  const visible = (session, { supportGrantId = null, hasTenant = true, accountKind = 'business' } = {}) => items.filter(item => item.visible(nav.navContext({ session, supportGrantId, hasTenant, accountKind }))).map(item => item.key);
  assert.deepEqual(visible({ role: 'reseller', platformOwner: true }, { accountKind: 'platform' }), items.map(item => item.key), 'dono: dez itens');
  assert.deepEqual(visible({ role: 'reseller' }, { accountKind: 'reseller' }), ['overview', 'inbox', 'contacts', 'agents', 'automation', 'channels', 'metrics', 'accounts', 'settings'], 'revenda');
  assert.deepEqual(visible({ role: 'reseller' }), ['overview', 'inbox', 'contacts', 'agents', 'automation', 'channels', 'metrics', 'settings'], 'admin de conta direta');
  assert.deepEqual(visible({ role: 'operator', permissions: [...OPERATOR_DEFAULT_PERMISSIONS] }), ['overview', 'inbox', 'contacts', 'automation', 'metrics'], 'atendente com as permissões padrão (tabela do §2.1)');
  assert.deepEqual(visible({ role: 'operator', permissions: [] }), ['overview'], 'atendente sem permissões');
  assert.deepEqual(visible({ role: 'operator', permissions: ['inbox.read'] }, { supportGrantId: 'grant-qa' }), ['overview', 'inbox', 'automation', 'channels'], 'suporte temporário: leitura de automação e canais');
  assert.deepEqual(visible({ role: 'reseller', platformOwner: true }, { hasTenant: false, accountKind: 'platform' }), ['accounts', 'platform', 'settings'], 'dono sem empresa');
  i18n.setLocale('en', { persist: false, notify: false });
  try { assert.deepEqual(items.map(item => item.label), ['Overview', 'Inbox', 'Contacts', 'Agents', 'Automation', 'Channels', 'Metrics', 'Clients', 'Platform', 'Settings']); }
  finally { i18n.setLocale('pt-BR', { persist: false, notify: false }); }
  assert.deepEqual(items.map(item => item.label), ['Visão geral', 'Atendimento', 'Contatos', 'Agentes', 'Automação', 'Canais', 'Indicadores', 'Clientes', 'Plataforma', 'Configurações']);
});

test('hubs envolvem a view legada sem reescrevê-la: abas pelo menu, aba aberta sempre presente, links canônicos', () => {
  const ctx = (session, extra = {}) => nav.navContext({ session, hasTenant: true, ...extra });
  const legacy = '<div class="page-heading"><h1>Equipe</h1></div><section>conteúdo legado intacto</section>';
  const admin = nav.hubFrame('team', ctx({ role: 'reseller' }), legacy);
  assert.ok(admin.includes(legacy), 'markup legado intacto dentro do painel');
  assert.match(admin, /^<div class="ui-hub" data-hub="settings"><div class="ui-tabs" role="tablist" id="hub-settings" aria-label="Configurações">/);
  assert.deepEqual([...admin.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['#settings/companies', '#settings/team', '#settings/brand', '#settings/support', '#settings/billing']);
  assert.match(admin, /<a class="ui-tabs__tab" role="tab" id="hub-settings-tab-team" aria-selected="true" aria-controls="hub-settings-panel-team" tabindex="0" data-tab="team" href="#settings\/team" aria-current="page">Equipe<\/a>/);
  assert.match(admin, /<div class="ui-tabpanel" role="tabpanel" id="hub-settings-panel-team" aria-labelledby="hub-settings-tab-team">/, 'painel sem tabindex extra');
  assert.equal(nav.hubFrame('support', ctx({ role: 'operator', permissions: [] }), legacy), legacy, 'atendente: uma aba só, sem faixa');
  assert.equal(nav.hubFrame('architecture', ctx({ role: 'reseller' }), legacy), legacy, 'Saúde e versão sem as abas da plataforma para quem não é dono');
  const owner = nav.hubFrame('platform-users', ctx({ role: 'reseller', platformOwner: true }), legacy);
  assert.deepEqual([...owner.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['#platform/accounts', '#platform/products', '#platform/users', '#platform/billing', '#platform/integrations', '#platform/health']);
  const support = nav.hubFrame('team', ctx({ role: 'reseller', supportGrantId: 'grant-qa' }, { supportGrantId: 'grant-qa' }), legacy);
  assert.deepEqual([...support.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]), ['team', 'support'], 'suporte: a aba aberta e as que o menu mostraria');
  const operator = nav.hubFrame('automation', ctx({ role: 'operator', permissions: ['flows.read'] }), legacy);
  assert.deepEqual([...operator.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['#automation', '#automation/flows']);
  assert.equal(nav.hubFrame('automation', ctx({ role: 'operator', permissions: [] }), legacy), legacy, 'sem flows.read não há aba Fluxos');
  assert.equal(nav.hubFrame('inbox', ctx({ role: 'reseller' }), legacy), legacy, 'telas fora de hub não mudam');
  assert.match(nav.hubFrame('knowledge', ctx({ role: 'reseller' }), legacy), /href="#agents\/connect"/);
  i18n.setLocale('en', { persist: false, notify: false });
  try {
    const english = nav.hubFrame('flows', ctx({ role: 'reseller' }), legacy);
    assert.match(english, /aria-label="Automation"/); assert.match(english, />Rules and SLA</); assert.match(english, />Flows</); assert.ok(english.includes(legacy));
    assert.match(nav.hubFrame('architecture', ctx({ role: 'reseller', platformOwner: true }), legacy), />Health and version</);
  } finally { i18n.setLocale('pt-BR', { persist: false, notify: false }); }
});

// Before P10 #automation/replies opened the 'automation' view and automation-ui.js added the Respostas
// rápidas tab to the strip for role reseller (temporary support included). The native tab of the hub
// ('quick-replies', SCREEN_VIEWS) keeps exactly that audience and never opens the route to anyone else.
test('Respostas rápidas é aba nativa da Automação só para quem já gerenciava o catálogo; nenhuma rota nova', () => {
  for (const combination of combinations()) {
    const ctx = contextOf(combination), before = nav.legacyRouteAllowed('automation', ctx) && combination.session.role === 'reseller';
    assert.equal(nav.legacyRouteAllowed('quick-replies', ctx), before, `rota ${combination.label}`);
    assert.equal(nav.legacyVisible('quick-replies', ctx), before, `aba ${combination.label}`);
    assert.equal(nav.resolveView('quick-replies', ctx), before ? 'quick-replies' : nav.resolveView(ctx.hasTenant ? 'overview' : 'automation', ctx), `destino ${combination.label}`);
  }
  const ctx = (session, extra = {}) => nav.navContext({ session, hasTenant: true, ...extra }), legacy = '<section>respostas</section>';
  const admin = nav.hubFrame('quick-replies', ctx({ role: 'reseller' }), legacy);
  assert.deepEqual([...admin.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['#automation', '#automation/flows', '#automation/replies']);
  assert.match(admin, /id="hub-automation-tab-replies" aria-selected="true" aria-controls="hub-automation-panel-replies" tabindex="0" data-tab="replies" href="#automation\/replies" aria-current="page">Respostas rápidas<\/a>/);
  assert.ok(admin.includes(legacy));
  const support = nav.hubFrame('automation', ctx({ role: 'reseller', supportGrantId: 'grant-qa' }, { supportGrantId: 'grant-qa' }), legacy);
  assert.deepEqual([...support.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]), ['rules', 'flows', 'replies'], 'suporte temporário de papel reseller: como antes');
  assert.deepEqual(nav.HUBS.automation.tabs.map(tab => [tab.id, tab.view, nav.hashForView(tab.view)]), [['rules', 'automation', '#automation'], ['flows', 'flows', '#automation/flows'], ['replies', 'quick-replies', '#automation/replies']]);
  assert.deepEqual(nav.SCREEN_VIEWS['quick-replies'] && [nav.SCREEN_VIEWS['quick-replies'].tenant], [true]);
  i18n.setLocale('en', { persist: false, notify: false });
  try { assert.match(nav.hubFrame('quick-replies', ctx({ role: 'reseller' }), legacy), />Quick replies<\/a>/); }
  finally { i18n.setLocale('pt-BR', { persist: false, notify: false }); }
});
