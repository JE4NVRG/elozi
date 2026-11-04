// Navigation as data (FRONTEND-V2 §2.1–§2.2). Three layers, all pure except hubFrame (markup):
//
// 1. LEGACY_VIEWS: the 25 legacy views (internal keys of `views` in app.js, unchanged) with the
//    access rules of today's panel. legacyVisible(key, ctx) is the old allowedNavigation (menu and
//    command palette) and resolveView(key, ctx) is the old guard at the top of render() (where a
//    route the person cannot open lands). tests/navigation-matrix.test.js compares both, for every
//    platformOwner × role × supportGrantId × hasTenant × permissions, with literal copies of the
//    code they replaced. Changing who sees a legacy view is a product decision, not a refactor.
// 2. Routes: every legacy view has one canonical hash (router.js grammar). Legacy hashes that are
//    not sections of the new grammar ('#knowledge', '#tenants', …) are registered as aliases here.
// 3. NAV_ITEMS: the ten items of the new menu with visible(ctx)/routeAllowed(ctx), and HUBS, the
//    tabbed pages (Configurações, Plataforma, Automação, Agentes) that wrap legacy views without
//    rewriting them. The shell (shell-ui.js, P1e) renders NAV_ITEMS.
//
// ctx = navContext({session, supportGrantId, hasTenant, hasPermission, accountKind}).
import { labels, h, raw } from './i18n.js';
import './locales-shell.js';
// EN of the area descriptions of the command palette (navigationDescriptions below).
import './locales-product-review.js';
import { tabs, tabPanel } from './ui.js';
import { formatHash, registerAlias, ROUTE_SECTIONS } from './router.js';

/** Same rule as app.js hasPermission: admins and sessions without a permission list read everything. */
export const sessionPermission = session => permission => Boolean(session && (session.role === 'reseller' || session.permissions == null || session.permissions.includes(permission)));

export function navContext({ session, supportGrantId = null, hasTenant = false, hasPermission, accountKind = null } = {}) {
  return Object.freeze({
    platformOwner: Boolean(session?.platformOwner), role: session?.role ?? null, supportGrantId: supportGrantId || null,
    hasTenant: Boolean(hasTenant), accountKind, can: hasPermission || sessionPermission(session)
  });
}

const always = () => true;
const never = () => false;
const can = permission => ctx => ctx.can(permission);
const resellerRole = ctx => ctx.role === 'reseller';
const outsideSupport = ctx => !ctx.supportGrantId;
const admin = ctx => ctx.role === 'reseller' && !ctx.supportGrantId;
const owner = ctx => ctx.platformOwner && !ctx.supportGrantId;

// tenant: the route needs a selected company (else it lands on the no-company page);
// route: the rule that keeps the route open; nav: the rule that shows it in menu and palette.
// navTenant defaults to tenant (only Minha conta differs: it opens without a company, but the
// old menu listed it only with one).
const legacy = (tenant, route = always, nav = route, navTenant = tenant) => Object.freeze({ tenant, route, nav, navTenant });
export const LEGACY_VIEWS = Object.freeze({
  overview: legacy(true), inbox: legacy(true), groups: legacy(true, can('inbox.read')), 'team-chat': legacy(true, outsideSupport),
  contacts: legacy(true, can('contacts.read')), metrics: legacy(true, can('metrics.read')), channels: legacy(true),
  agents: legacy(true), 'service-agents': legacy(true, resellerRole, admin), knowledge: legacy(true, resellerRole, admin),
  flows: legacy(true, can('flows.read')), automation: legacy(true), architecture: legacy(true), brand: legacy(true, resellerRole, admin),
  accounts: legacy(false, admin), tenants: legacy(false, resellerRole, admin), team: legacy(false, resellerRole, admin),
  support: legacy(false), billing: legacy(false, resellerRole, admin), platform: legacy(false, owner),
  'platform-users': legacy(false, owner), 'platform-billing': legacy(false, owner), integrations: legacy(false, owner),
  account: legacy(false, always, always, true), guide: legacy(false)
});
export const LEGACY_KEYS = Object.freeze(Object.keys(LEGACY_VIEWS));
// Screens without a legacy view (§2.4), routed by P1 (commit 1f) to their stubs: #pending
// (pending-ui.js, P6; needs a company, open to every role as the bell is) and #setup (onboarding-ui.js,
// P7). Both stay out of the menu and of the finder until their packages fill them.
// 'agent-tools' (commit 1g, §5.3.1) is the Ferramentas tab of the agents hub (#agents/tools), drawn by
// agents-hub-ui.js with the MCP panel of mcp-ui.js: servers, catalog and tool grants of the company.
// It belongs to the workspace admin (role reseller, outside temporary support), the same rule the
// server applies to /mcp/servers and /mcp-grants, so the admin of a reseller reaches it without being
// the platform owner (before 1g the tools lived only in Integrações, a platform-owner page).
// 'quick-replies' (P10) is the Respostas rápidas tab of the Automação hub (#automation/replies), drawn
// by automation-ui.js: the catalog of the company is managed by role reseller (temporary support
// included), the same people who saw the tab before P10 moved it from the strip into the hub.
// 'connected-products' is the Produtos conectados tab of the Plataforma hub (#platform/products), drawn by
// connected-products-ui.js: the products of the operation, their lines, agents and the protection between own lines.
export const SCREEN_VIEWS = Object.freeze({ pending: legacy(true, always, never), setup: legacy(false, always, never), 'agent-tools': legacy(true, admin, admin), 'quick-replies': legacy(true, resellerRole, resellerRole),
  'connected-products': legacy(false, owner, owner) });
const VIEW_RULES = Object.freeze({ ...LEGACY_VIEWS, ...SCREEN_VIEWS });
const known = key => Object.hasOwn(VIEW_RULES, key);

/** Old allowedNavigation: the legacy view appears in the menu and in the command palette. */
export function legacyVisible(key, ctx) {
  const view = VIEW_RULES[key];
  return Boolean(view) && (!view.navTenant || ctx.hasTenant) && Boolean(view.nav(ctx));
}
/** The legacy route stays open (the render() guard keeps it). */
export function legacyRouteAllowed(key, ctx) {
  const view = VIEW_RULES[key];
  return Boolean(view) && (!view.tenant || ctx.hasTenant) && Boolean(view.route(ctx));
}
/** Where render() lands for a legacy view: the view itself when allowed, else the old fallbacks. */
export function resolveView(key, ctx) {
  if (!known(key)) return key;
  let view = key;
  if (VIEW_RULES[view].tenant && !ctx.hasTenant) view = ctx.platformOwner ? 'platform' : ctx.role === 'reseller' ? 'accounts' : 'account';
  if (!VIEW_RULES[view].route(ctx)) view = ctx.hasTenant ? 'overview' : 'account';
  return view;
}

const names = labels({
  overview: 'Visão geral', inbox: 'Atendimento', contacts: 'Contatos', agents: 'Agentes', automation: 'Automação', channels: 'Canais',
  metrics: 'Indicadores', accounts: 'Clientes', platform: 'Plataforma', settings: 'Configurações',
  operation: 'Operação', agentsAndAutomation: 'Agentes e automação', reseller: 'Revenda',
  companies: 'Empresas e filiais', team: 'Equipe', brand: 'Marca e domínio', support: 'Suporte com prazo', billing: 'Financeiro',
  platformAccounts: 'Contas', products: 'Produtos conectados', users: 'Usuários', platformBilling: 'Cobrança', integrations: 'Integrações', health: 'Saúde e versão',
  rules: 'Regras e SLA', flows: 'Fluxos', replies: 'Respostas rápidas', knowledge: 'Conhecimento', connect: 'Agentes conectados', tools: 'Ferramentas'
});

// What each area is for, in the command palette (FRONTEND-V2 §2.5): plain PT keys translated where they
// are shown (t()); their EN lives in locales-product-review.js and locales-shell.js.
export const navigationDescriptions = Object.freeze({
  overview: 'Acompanhar a operação', metrics: 'Acompanhar a operação',
  inbox: 'Atender clientes e revisar respostas', groups: 'Consultar grupos, resumos e agendamentos',
  'team-chat': 'Conversar com a equipe', contacts: 'Buscar clientes, agendas e etiquetas',
  channels: 'Conectar WhatsApp, Telegram, site, Instagram e Facebook',
  agents: 'Configurar seu copiloto e o suporte interno', 'service-agents': 'Conectar Hermes, Claude e Codex por MCP',
  knowledge: 'Organizar fontes e respostas do assistente', 'agent-tools': 'Servidores MCP e ferramentas dos copilotos', flows: 'Criar triagens e encaminhamentos',
  automation: 'Distribuir a fila e acompanhar prazos', 'quick-replies': 'Criar e revisar os textos prontos da equipe', team: 'Convidar pessoas e definir acessos',
  tenants: 'Administrar matriz e filiais', platform: 'Gerenciar clientes e revendas', accounts: 'Gerenciar clientes e revendas',
  'platform-users': 'Ver pessoas de todas as contas', integrations: 'Configurar provedores e canais',
  brand: 'Personalizar logo, cores e domínio', guide: 'Entender o produto e as APIs', account: 'Editar perfil, foto e idioma',
  billing: 'Ver contratos e faturas', 'platform-billing': 'Ver contratos e faturas', support: 'Prestar suporte com acesso temporário'
});

// Hubs: one tab per view (a legacy view, or a screen of SCREEN_VIEWS such as agent-tools), so each
// tab keeps its own canonical hash and access rule. The default tab (first) of agents/automation has
// no path segment.
const tab = (id, view, label, params) => Object.freeze({ id, view, get label() { return names[label]; }, params: Object.freeze(params) });
export const HUBS = Object.freeze({
  settings: Object.freeze({ id: 'settings', section: 'settings', get label() { return names.settings; }, tabs: Object.freeze([
    tab('companies', 'tenants', 'companies', { tab: 'companies' }), tab('team', 'team', 'team', { tab: 'team' }),
    tab('brand', 'brand', 'brand', { tab: 'brand' }), tab('support', 'support', 'support', { tab: 'support' }),
    tab('billing', 'billing', 'billing', { tab: 'billing' })
  ]) }),
  platform: Object.freeze({ id: 'platform', section: 'platform', get label() { return names.platform; }, tabs: Object.freeze([
    tab('accounts', 'platform', 'platformAccounts', { tab: 'accounts' }), tab('products', 'connected-products', 'products', { tab: 'products' }),
    tab('users', 'platform-users', 'users', { tab: 'users' }),
    tab('billing', 'platform-billing', 'platformBilling', { tab: 'billing' }), tab('integrations', 'integrations', 'integrations', { tab: 'integrations' }),
    tab('health', 'architecture', 'health', { tab: 'health' })
  ]) }),
  automation: Object.freeze({ id: 'automation', section: 'automation', get label() { return names.automation; }, tabs: Object.freeze([
    tab('rules', 'automation', 'rules', {}), tab('flows', 'flows', 'flows', { tab: 'flows' }), tab('replies', 'quick-replies', 'replies', { tab: 'replies' })
  ]) }),
  agents: Object.freeze({ id: 'agents', section: 'agents', get label() { return names.agents; }, tabs: Object.freeze([
    tab('agents', 'agents', 'agents', {}), tab('knowledge', 'knowledge', 'knowledge', { tab: 'knowledge' }),
    tab('tools', 'agent-tools', 'tools', { tab: 'tools' }), tab('connect', 'service-agents', 'connect', { tab: 'connect' })
  ]) })
});
const hubTabOf = new Map(Object.values(HUBS).flatMap(hub => hub.tabs.map(item => [item.view, { hub, tab: item }])));
/** { hub, tab } of a legacy view that lives in a hub, else null. */
export const hubOf = key => hubTabOf.get(key) || null;

// Canonical route of each legacy view (§2.2). Views that are not hub tabs keep their own section.
const OWN_SECTION = { overview: 'overview', inbox: 'inbox', groups: 'groups', 'team-chat': 'team-chat', contacts: 'contacts', metrics: 'metrics', channels: 'channels', accounts: 'accounts', account: 'account', guide: 'help', pending: 'pending', setup: 'setup' };
export function routeForView(key) {
  const place = hubOf(key);
  if (place) return { section: place.hub.section, params: { ...place.tab.params }, query: {}, workspaceId: null, alias: null };
  if (Object.hasOwn(OWN_SECTION, key)) return { section: OWN_SECTION[key], params: {}, query: {}, workspaceId: null, alias: null };
  return null;
}
export const hashForView = key => { const route = routeForView(key); return route ? formatHash(route) : '#overview'; };

/**
 * Deep link of an open conversation: #inbox/<tenantId>/<conversationId>[?w=<workspaceId>].
 * IDs outside the route grammar fall back to '#inbox' (never an unparseable hash).
 */
export function conversationHash({ tenantId, conversationId, workspaceId = null }) {
  for (const params of [{ tenantId, conversationId }, {}]) for (const workspace of [workspaceId, null]) {
    try { return formatHash({ section: 'inbox', params, query: {}, workspaceId: workspace }); } catch { /* next candidate */ }
  }
  return '#inbox';
}

// Every legacy hash keeps working: views whose key is not a section of the new grammar become
// aliases of their canonical route ('#tenants' → '#settings/companies', '#guide' → '#help').
for (const key of LEGACY_KEYS) if (!ROUTE_SECTIONS.includes(key)) registerAlias(key, hashForView(key));

/**
 * View that renders a route (a legacy view, or a screen of SCREEN_VIEWS: 'pending', 'setup',
 * 'agent-tools', 'quick-replies'), or null when nothing does. A hub route without a tab, or with a tab
 * the hub does not list (settings/activity, platform/overview, agents/activity|usage…), opens the
 * hub's first tab; render() then applies the guard (resolveView) as for any other view.
 */
export function viewForRoute(route) {
  if (!route) return null;
  const { section, params = {} } = route;
  if (section === 'help') return 'guide';
  const hub = Object.values(HUBS).find(entry => entry.section === section);
  if (hub) return (hub.tabs.find(entry => (entry.params.tab || null) === (params.tab || null)) || hub.tabs[0]).view;
  return Object.entries(OWN_SECTION).find(([, name]) => name === section)?.[0] || null;
}

// The ten items of the new menu (§2.1), each with its own icon. routeAllowed: at least one of its
// views opens; visible follows the role table of §2.1 and always implies routeAllowed.
const navItem = (key, section, icon, views, visible) => Object.freeze({
  key, section, icon, views: Object.freeze(views), route: hashForView(views[0]), get label() { return names[key]; },
  visible: ctx => Boolean(visible(ctx)) && views.some(view => legacyRouteAllowed(view, ctx)),
  routeAllowed: ctx => views.some(view => legacyRouteAllowed(view, ctx))
});
const hubViews = id => HUBS[id].tabs.map(entry => entry.view);
export const NAV_SECTIONS = Object.freeze([
  Object.freeze({ id: 'operation', get label() { return names.operation; } }),
  Object.freeze({ id: 'automation', get label() { return names.agentsAndAutomation; } }),
  Object.freeze({ id: 'reseller', get label() { return names.reseller; } }),
  Object.freeze({ id: 'platform', get label() { return names.platform; } }),
  Object.freeze({ id: 'system', label: null })
]);
export const NAV_ITEMS = Object.freeze([
  navItem('overview', 'operation', 'home', ['overview'], ctx => ctx.hasTenant),
  navItem('inbox', 'operation', 'inbox', ['inbox', 'groups'], ctx => ctx.hasTenant && ctx.can('inbox.read')),
  navItem('contacts', 'operation', 'contacts', ['contacts'], ctx => ctx.hasTenant && ctx.can('contacts.read')),
  navItem('agents', 'automation', 'spark-bot', hubViews('agents'), ctx => ctx.hasTenant && admin(ctx)),
  navItem('automation', 'automation', 'workflow', hubViews('automation'), ctx => ctx.hasTenant && (ctx.role === 'reseller' || Boolean(ctx.supportGrantId) || ctx.can('flows.read'))),
  navItem('channels', 'automation', 'plug', ['channels'], ctx => ctx.hasTenant && (ctx.role === 'reseller' || Boolean(ctx.supportGrantId))),
  navItem('metrics', 'automation', 'chart', ['metrics'], ctx => ctx.hasTenant && !ctx.supportGrantId && ctx.can('metrics.read')),
  navItem('accounts', 'reseller', 'briefcase', ['accounts'], ctx => admin(ctx) && (ctx.accountKind === 'reseller' || ctx.platformOwner)),
  navItem('platform', 'platform', 'server', hubViews('platform'), owner),
  navItem('settings', 'system', 'gear', hubViews('settings'), admin)
]);
/** The menu item that owns a legacy view (for aria-current and breadcrumbs). */
export const navItemOf = key => NAV_ITEMS.find(entry => entry.views.includes(key)) || null;

/**
 * Tabs of the hub that owns `key` around the legacy markup `content`. Tabs follow the menu rule
 * (legacyVisible) and the open tab is always kept. With fewer than two tabs the legacy markup is
 * returned unchanged. Tabs are links to canonical hashes; hashchange runs the usual guards.
 */
export function hubFrame(key, ctx, content) {
  const place = hubOf(key);
  if (!place) return content;
  const { hub } = place, items = hub.tabs.filter(entry => entry.view === key || legacyVisible(entry.view, ctx));
  if (items.length < 2) return content;
  const id = 'hub-' + hub.id;
  return String(h`<div class="ui-hub" data-hub="${hub.id}">${tabs({ id, label: hub.label, active: place.tab.id, items: items.map(entry => ({ id: entry.id, label: entry.label, href: hashForView(entry.view) })) })}${tabPanel({ tabsId: id, id: place.tab.id, active: true, focusable: false, content: raw(content) })}</div>`);
}
