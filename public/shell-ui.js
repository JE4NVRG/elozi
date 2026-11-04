// Shell of the panel (FRONTEND-V2 §2.3, §5.1 and §8.2 commit 1e): skip link, scope selector, sidebar
// with the menu of nav-config.js, topbar (breadcrumb, search, Pendências, Equipe and the account
// menu), banners region, mobile bottom bar with the "Mais" sheet, the document title and the favicon.
//
// - render() in app.js still regenerates #app on every pass (P1) and calls shellMarkup(model). P2
//   patches badges, the connection indicator and the title in place through the data-shell-count and
//   data-shell-slot hooks, without a full render.
// - Compatibility contract with the legacy CSS and code until P10: <div class="app-shell" data-view>,
//   <main id="main-content" tabindex="-1" class="content …">, #modal and the toast regions of
//   index.html, the skip link and the focus on the page h1 after a route change (app.js).
// - White label: this file never writes a product name. Everything the person reads about the
//   product comes from the workspace brand (boot.reseller.brand), so a reseller workspace never shows
//   the platform's name; the platform workspace shows it only because it is its own brand.
// - installShell(document) owns the behaviour of the three popovers (scope, account, "Mais"):
//   toggle, Esc, click or focus outside, filter and arrow keys. Actions that change the app state
//   keep data-action / data-view and go through act() and navigate() in app.js.
import { h, t, getLocale, registerTranslations } from './i18n.js';
import './locales-shell.js';
import { glyph } from './icons.js';
import { attributes, avatar, badge, button, companyMark, iconButton, initials, kbd, segmented } from './ui.js';
import { NAV_ITEMS, NAV_SECTIONS, hashForView, hubOf, legacyRouteAllowed, legacyVisible, navItemOf } from './nav-config.js';
import { prefsKey, updateCurrentThemePrefs } from './theme-prefs.js';

// EN for the copy that P10 added to the shell (theme choice and compact banners). Claro/Escuro/Sistema
// already come from the shared catalogs; locales-shell.js may take these over (same wording).
registerTranslations({ 'Tema': 'Theme', 'Tema do painel': 'Panel theme', 'Claro': 'Light', 'Escuro': 'Dark', 'Mostrar o aviso completo': 'Show the full notice', 'Recolher o aviso': 'Collapse the notice' });

/** Viewport queries of the shell (§3.6 breakpoints): drawer and bottom bar below 900 px. */
export const SHELL_MOBILE_QUERY = '(max-width: 899.98px)';
export const SHELL_WIDE_QUERY = '(min-width: 1280px)';
export const SHELL_XWIDE_QUERY = '(min-width: 1600px)';

const PRESENCE = ['available', 'busy', 'away', 'offline'];
const presenceLabel = presence => ({ available: t('Disponível'), busy: t('Ocupado'), away: t('Ausente'), offline: t('Fora de atendimento') })[presence] || t('Disponível');
const ACCOUNT_VIEWS = ['platform', 'platform-users', 'accounts', 'platform-billing'];
const kindLabel = kind => kind === 'platform' ? t('Administração principal') : kind === 'business' ? t('Empresa e filiais') : t('Revenda white label');
const time = value => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '';
};

/**
 * Sidebar mode at 900 px and above (§2.3, §3.6): a 64 px rail from 900 to 1279 px and, in
 * Atendimento, below 1600 px; otherwise the person's choice (chat-layout.js keeps it). The toggle is
 * offered only where the choice has an effect. Below 900 px CSS turns the sidebar into a drawer.
 */
export function shellLayout({ wide = false, xwide = false, view, collapsed = false } = {}) {
  const toggleable = Boolean(xwide || wide && view !== 'inbox');
  return { layout: toggleable && !collapsed ? 'full' : 'rail', toggleable };
}

/** First view of a menu item that the person can open (its route and its data-view). */
const targetView = (item, ctx) => item.views.find(view => legacyRouteAllowed(view, ctx)) || item.views[0];

/**
 * Entries of the menu for this person: NAV_ITEMS that are visible (§2.1) plus "Grupos" under
 * Atendimento while groups is still its own screen (P3 turns it into a filter of the inbox).
 */
export function menuEntries(ctx, view) {
  const owner = navItemOf(view), entries = [];
  for (const item of NAV_ITEMS) {
    if (!item.visible(ctx)) continue;
    const target = targetView(item, ctx);
    entries.push({ key: item.key, section: item.section, icon: item.icon, label: item.label, view: target, href: hashForView(target), current: owner?.key === item.key && view !== 'groups' });
    if (item.key === 'inbox' && legacyVisible('groups', ctx)) entries.push({ key: 'groups', section: item.section, icon: 'users', label: t('Grupos'), view: 'groups', href: hashForView('groups'), current: view === 'groups', sub: true });
  }
  return entries;
}

/** Equipe (team chat) opens for whoever can open its route: everyone with a company, except temporary support. */
const teamAllowed = ctx => legacyRouteAllowed('team-chat', ctx);
const isAdmin = ctx => ctx.role === 'reseller' && !ctx.supportGrantId;

/**
 * Breadcrumb "Marca › Seção › Aba" (§2.3). The section is the menu item that owns the view (or the
 * legacy name of the views outside the menu: Chat da equipe, Minha conta, Guia e APIs); the tab is
 * the hub tab when it says something the section does not. `screen` names the tab title.
 */
export function shellCrumbs({ view, viewLabel = '', brandName = '' } = {}) {
  const section = navItemOf(view)?.label || viewLabel;
  const place = hubOf(view), tab = view === 'groups' ? t('Grupos') : place ? place.tab.label : '';
  const extra = tab && tab !== section ? tab : '';
  return { brand: brandName, section, tab: extra, screen: extra || section };
}

/** Title of the browser tab (§5.1): "(n) Tela · Marca", n = não lidas para mim (P2 passes the count). */
export function shellTitle({ screen = '', brand = '', count = null } = {}) {
  const prefix = Number.isSafeInteger(count) && count > 0 ? `(${count > 99 ? '99+' : count}) ` : '';
  return prefix + [screen, brand].filter(Boolean).join(' · ');
}

/**
 * What the scope selector shows and offers (§2.3): the workspaces with their badges ("plataforma",
 * "suporte até 15:40") and the companies. Atendimento shows every authorized company (the inbox is
 * consolidated), account management needs no company and a workspace without companies says so.
 */
export function scopeModel({ view, workspace = {}, workspaces = [], supportGrantId = null, tenant = null, tenants = [] } = {}) {
  const grant = supportGrantId || null;
  const options = (Array.isArray(workspaces) ? workspaces : []).map(item => {
    const until = item.supportGrantId ? time(item.supportExpiresAt) : '';
    return {
      id: item.id, grant: item.supportGrantId || null, name: item.name,
      badge: item.platformWorkspace ? { text: t('plataforma'), tone: 'accent' } : item.supportGrantId ? { text: until ? t('suporte até {time}', { time: until }) : t('suporte temporário'), tone: 'warning' } : null,
      current: item.id === workspace.id && (item.supportGrantId || null) === grant
    };
  });
  const mode = ACCOUNT_VIEWS.includes(view) ? 'accounts' : !tenant ? 'none' : view === 'inbox' ? 'all' : 'tenant';
  const company = mode === 'accounts' ? t('Gestão das contas') : mode === 'none' ? t('Configure sua primeira unidade') : mode === 'all' ? t('Todas as empresas autorizadas') : tenant.name;
  const companies = mode === 'tenant' ? (Array.isArray(tenants) ? tenants : []).map(item => ({ id: item.id, name: item.name, brand: item.brand || (item.id === tenant.id ? tenant.brand : null), current: item.id === tenant.id })) : [];
  const shownWorkspaces = options.length > 1 ? options : [], shownCompanies = companies.length > 1 ? companies : [];
  return {
    workspaceName: workspace.name || '', kind: kindLabel(workspace.kind), company, mode, workspaces: shownWorkspaces, companies: shownCompanies,
    switchable: shownWorkspaces.length + shownCompanies.length > 0, search: shownWorkspaces.length + shownCompanies.length > 6
  };
}

const brandMark = brand => avatar({ kind: 'company', name: brand?.name || '', src: brand?.logo, accent: brand?.accent, size: 32 });
const check = current => current ? glyph('check', 'sh-option__check') : '';

// data-shell-search holds what the scope search matches: the name (and the workspace badge, so
// "suporte" finds the support workspaces), never the decorative monogram letter.
function workspaceOption(option) {
  const search = [option.name, option.badge?.text].filter(Boolean).join(' ');
  return h`<li><button type="button" class="sh-option" data-action="shell:workspace" data-id="${option.id}" data-grant="${option.grant || ''}" data-shell-option data-shell-search="${search}"${attributes({ 'aria-current': option.current ? 'true' : null })}><span class="sh-option__name">${option.name}</span>${option.badge ? badge(option.badge.text, option.badge.tone) : ''}${check(option.current)}</button></li>`;
}

function companyOption(company) {
  return h`<li><button type="button" class="sh-option" data-action="shell:tenant" data-id="${company.id}" data-shell-option data-shell-search="${company.name}"${attributes({ 'aria-current': company.current ? 'true' : null })}>${companyMark({ name: company.name, brand: company.brand || {} })}${check(company.current)}</button></li>`;
}

function scopePanel(scope) {
  const search = scope.search ? h`<div class="sh-scope__search"><label class="sr-only" for="sh-scope-filter">Buscar workspace ou empresa</label>${glyph('search', 'sh-scope__search-icon')}<input id="sh-scope-filter" class="sh-scope__filter" type="search" autocomplete="off" spellcheck="false" placeholder="Buscar workspace ou empresa" data-shell-filter/></div>` : '';
  const workspaces = scope.workspaces.length ? h`<div class="sh-scope__group" role="group" aria-labelledby="sh-scope-workspaces"><p class="sh-scope__heading" id="sh-scope-workspaces">Workspaces</p><ul class="sh-scope__list">${scope.workspaces.map(workspaceOption)}</ul></div>` : '';
  const companies = scope.companies.length ? h`<div class="sh-scope__group" role="group" aria-labelledby="sh-scope-companies"><p class="sh-scope__heading" id="sh-scope-companies">Empresas</p><ul class="sh-scope__list">${scope.companies.map(companyOption)}</ul></div>` : h`<p class="sh-scope__note">${scope.company}</p>`;
  return h`<div class="sh-popover sh-scope__panel" id="sh-scope-panel" role="dialog" aria-label="Trocar workspace ou empresa" data-shell-panel="scope" hidden>${search}${workspaces}${companies}<p class="sh-scope__empty" data-shell-empty hidden>Nada encontrado.</p></div>`;
}

function scopeBlock(model, scope) {
  const brand = model.brand || {}, line = scope.workspaceName && scope.workspaceName !== brand.name ? `${scope.workspaceName} › ${scope.company}` : scope.company;
  const inner = h`${brandMark(brand)}<span class="sh-scope__text"><span class="sh-scope__brand">${brand.name || scope.workspaceName}</span><span class="sh-scope__line">${line}</span></span>`;
  // The title doubles as the accessible name in the 64 px rail, where only the logo stays visible.
  const title = [brand.name || scope.workspaceName, line, scope.kind].filter(Boolean).join(' · ');
  if (!scope.switchable) return h`<div class="sh-scope"><div class="sh-scope__static"${attributes({ title })}>${inner}</div></div>`;
  return h`<div class="sh-scope"><button type="button" class="sh-scope__trigger" data-shell-toggle="scope" aria-expanded="false" aria-controls="sh-scope-panel" aria-haspopup="dialog"${attributes({ title })}>${inner}${glyph('chevron-down', 'sh-scope__chevron')}</button>${scopePanel(scope)}</div>`;
}

const countSlot = key => h`<span class="sh-count" data-shell-count="${key}" hidden></span>`;

function navLink(entry) {
  return h`<li class="sh-nav__entry${entry.sub ? ' sh-nav__entry--sub' : ''}"><a class="sh-nav__item" href="${entry.href}" data-view="${entry.view}"${attributes({ 'aria-current': entry.current ? 'page' : null })}>${glyph(entry.icon, 'sh-nav__icon')}<span class="sh-nav__label">${entry.label}</span>${countSlot(entry.key)}</a></li>`;
}

/** The menu: sections of NAV_SECTIONS with their visible items; data-view keeps the legacy navigate() path. */
export function sidebarNav(entries) {
  return h`<nav class="sh-nav" aria-label="Navegação principal">${NAV_SECTIONS.map(section => {
    const items = entries.filter(entry => entry.section === section.id);
    if (!items.length) return '';
    const heading = section.label ? `sh-nav-${section.id}` : null;
    return h`<div class="sh-nav__section" data-section="${section.id}">${heading ? h`<p class="sh-nav__heading" id="${heading}">${section.label}</p>` : ''}<ul class="sh-nav__list"${attributes({ 'aria-labelledby': heading })}>${items.map(navLink)}</ul></div>`;
  })}</nav>`;
}

function crumbsMarkup(crumbs) {
  const tab = crumbs.tab ? h`<li class="sh-crumbs__item" aria-current="page">${crumbs.tab}</li>` : '';
  return h`<nav class="sh-crumbs" aria-label="Você está aqui"><ol class="sh-crumbs__list"><li class="sh-crumbs__item sh-crumbs__item--brand">${crumbs.brand}</li><li class="sh-crumbs__item"${attributes({ 'aria-current': crumbs.tab ? null : 'page' })}>${crumbs.section}</li>${tab}</ol></nav>`;
}

function presenceOf(user) { return PRESENCE.includes(user?.presence) ? user.presence : 'available'; }

function accountPanel(model) {
  const user = model.user || {}, presence = presenceOf(user), prefs = model.prefs || {};
  const choices = PRESENCE.map(id => h`<label class="sh-radio"><input type="radio" class="sh-radio__input" name="shell-presence" value="${id}"${attributes({ checked: id === presence })}/><span class="sh-presence" data-presence="${id}" aria-hidden="true"></span><span>${presenceLabel(id)}</span></label>`);
  const locale = segmented({ name: 'shell-locale', label: t('Idioma do painel'), value: model.locale === 'en' ? 'en' : 'pt-BR', items: [{ value: 'pt-BR', label: t('Português (Brasil)') }, { value: 'en', label: t('English') }] });
  // Tema (§2.3, P10): Sistema follows the system setting; installShell saves and applies the choice.
  const theme = segmented({ name: 'shell-theme', label: t('Tema do painel'), value: ['light', 'dark'].includes(prefs.theme) ? prefs.theme : 'system', items: [{ value: 'system', label: t('Sistema') }, { value: 'light', label: t('Claro') }, { value: 'dark', label: t('Escuro') }] });
  const motion = segmented({ name: 'shell-motion', label: t('Animações'), value: prefs.motion === 'reduced' ? 'reduced' : 'system', items: [{ value: 'system', label: t('Sistema') }, { value: 'reduced', label: t('Reduzidas') }] });
  const privacy = segmented({ name: 'shell-privacy', label: t('Modo privacidade'), value: prefs.privacy === 'on' ? 'on' : 'off', items: [{ value: 'off', label: t('Desligado') }, { value: 'on', label: t('Ligado') }] });
  const version = model.version ? h`<li><a class="sh-menu__link" href="${hashForView('architecture')}" data-view="architecture">${glyph('server')}<span>${t('Versão {version}', { version: model.version })}</span></a></li>` : '';
  return h`<div class="sh-popover sh-account__panel" id="sh-account-panel" role="dialog" aria-labelledby="sh-account-name" data-shell-panel="account" hidden>
    <div class="sh-account__head">${avatar({ kind: 'person', name: user.name, src: user.avatar, presence, size: 40 })}<p class="sh-account__who"><strong id="sh-account-name">${user.name}</strong><small>${user.role}</small></p></div>
    <fieldset class="sh-menu__group"><legend class="sh-menu__legend">Disponibilidade</legend>${choices}</fieldset>
    <div class="sh-menu__group"><p class="sh-menu__legend">Idioma</p>${locale}</div>
    <div class="sh-menu__group"><p class="sh-menu__legend">${t('Tema')}</p>${theme}</div>
    <div class="sh-menu__group"><p class="sh-menu__legend">Animações</p>${motion}</div>
    <div class="sh-menu__group"><p class="sh-menu__legend">${t('Modo privacidade')}</p>${privacy}<small class="sh-menu__hint">${t('Esconde nomes, telefones, fotos e prévias de clientes para apresentar ou compartilhar a tela.')}</small></div>
    <ul class="sh-menu__links">
      <li><a class="sh-menu__link" href="${hashForView('account')}" data-view="account">${glyph('user')}<span>Minha conta</span></a></li>
      <li><a class="sh-menu__link" href="${hashForView('guide')}" data-view="guide">${glyph('help')}<span>Ajuda e APIs</span></a></li>
      <li><button type="button" class="sh-menu__link" data-action="shell:shortcuts">${glyph('keyboard')}<span>Atalhos do teclado</span></button></li>
      ${version}
      <li><button type="button" class="sh-menu__link" data-action="logout">${glyph('logout')}<span>Sair</span></button></li>
    </ul>
  </div>`;
}

function accountTrigger(model) {
  const user = model.user || {};
  return h`<div class="sh-account"><button type="button" class="sh-account__trigger" data-shell-toggle="account" aria-expanded="false" aria-controls="sh-account-panel" aria-haspopup="dialog"><span class="sr-only">Menu da conta</span> ${avatar({ kind: 'person', name: user.name, src: user.avatar, presence: presenceOf(user), size: 32, label: true })}</button>${accountPanel(model)}</div>`;
}

// One-time transition notice of §2.2 ("O menu ficou mais curto"), per person: shown in at most one page
// load. The first render that shows it records it in the person's preferences record
// (elozi:prefs:<userId>, shared with theme-prefs.js; writes merge so each owner keeps the other keys),
// so it stays on this page until dismissed and never comes back on the next ones; dismissing records
// the same value. The page-load memory is kept per storage object (blocked storage: shown each load).
const NOTICE_KEY = 'shellNotice', NOTICE_VALUE = 'menu-p1';
const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
const noticePages = new Map();
const noticePage = storage => {
  const key = storage && typeof storage === 'object' ? storage : null;
  if (!noticePages.has(key)) noticePages.set(key, { showing: new Set(), dismissed: new Set() });
  return noticePages.get(key);
};
function prefsRecord(userId, storage) {
  try {
    const value = JSON.parse(storage?.getItem(prefsKey(userId)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function recordNotice(userId, storage) {
  try { storage.setItem(prefsKey(userId), JSON.stringify({ ...prefsRecord(userId, storage), [NOTICE_KEY]: NOTICE_VALUE })); return true; } catch { return false; }
}
/**
 * Whether the "menu ficou mais curto" notice stays hidden for this person: dismissed, or already shown in
 * an earlier page load. The first call that answers "show" records the notice as seen.
 */
export function shellNoticeDismissed(userId, storage = defaultStorage()) {
  const page = noticePage(storage), id = String(userId || 'anonymous');
  if (page.dismissed.has(id)) return true;
  if (page.showing.has(id)) return false;
  if (prefsRecord(userId, storage)[NOTICE_KEY] === NOTICE_VALUE) return true;
  page.showing.add(id);
  recordNotice(userId, storage);
  return false;
}
/** Records the dismissal without touching the other preference keys; false when storage is blocked. */
export function dismissShellNotice(userId, storage = defaultStorage()) {
  const page = noticePage(storage), id = String(userId || 'anonymous');
  page.showing.delete(id); page.dismissed.add(id);
  return recordNotice(userId, storage);
}

const BANNER_GLYPHS = { info: 'info', warning: 'warning', danger: 'warning', offline: 'offline', success: 'check' };
/**
 * Banner of the shell: the .ui-banner of ui.js plus a toggle that only shows below 600 px, where the
 * banner collapses to one line (data-state="collapsed") and expands on demand (installShell).
 */
function shellBanner({ key, tone = 'info', title = '', body = '', action = null, dismissible = false, attrs = {} }) {
  const textId = `sh-banner-${key}-text`, label = t('Mostrar o aviso completo');
  const close = dismissible ? iconButton({ label: t('Dispensar aviso'), icon: 'close', attrs: { 'data-ui-dismiss': 'banner' } }) : '';
  return h`<div class="ui-banner ui-banner--${tone} sh-banner" data-banner="${key}" data-state="collapsed"${attributes(attrs)}><span class="ui-banner__icon" aria-hidden="true">${glyph(BANNER_GLYPHS[tone] || 'info')}</span><div class="ui-banner__text sh-banner__text" id="${textId}">${title ? h`<strong class="ui-banner__title">${title}</strong>` : ''}${title && body ? ' ' : ''}${body ? h`<span class="ui-banner__body">${body}</span>` : ''}</div><button type="button" class="sh-banner__toggle" data-shell-banner-toggle aria-expanded="false" aria-controls="${textId}" aria-label="${label}" title="${label}">${glyph('chevron-down')}</button>${action ? button({ size: 'sm', variant: 'secondary', ...action }) : ''}${close}</div>`;
}

function bannersMarkup(model) {
  const items = [];
  if (model.support) {
    const until = time(model.support.expiresAt);
    items.push(shellBanner({ key: 'support', tone: 'warning', title: t('Suporte temporário'), body: [model.support.reason, until ? t('até {time}', { time: until }) : ''].filter(Boolean).join(' · '), action: { label: t('Sair do suporte'), action: 'support-exit' } }));
  }
  if (model.sandbox) items.push(shellBanner({ key: 'sandbox', tone: 'info', body: t('Ambiente de teste · dados sintéticos e conexões simuladas.') }));
  if (model.notice) {
    const body = model.notice === 'admin'
      ? t('Conhecimento e Agentes conectados agora ficam em Agentes, Fluxos em Automação e as telas da conta em Configurações. O chat da equipe abre pelo botão Equipe; Minha conta e Ajuda ficam no menu do seu avatar.')
      : t('Grupos agora fica dentro de Atendimento e o chat da equipe abre pelo botão Equipe. Minha conta e Ajuda ficam no menu do seu avatar.');
    items.push(shellBanner({ key: 'menu-notice', tone: 'info', title: t('O menu ficou mais curto.'), body, dismissible: true, attrs: { 'data-shell-notice': 'menu' } }));
  }
  return h`<div class="sh-banners" id="sh-banners" data-shell-slot="banners">${items}</div>`;
}

/** Expands or collapses a shell banner (below 600 px it shows one line until expanded). */
export function toggleShellBanner(toggle, expanded) {
  const banner = toggle?.closest?.('.sh-banner');
  if (!banner) return false;
  const open = typeof expanded === 'boolean' ? expanded : toggle.getAttribute('aria-expanded') !== 'true';
  banner.setAttribute('data-state', open ? 'expanded' : 'collapsed');
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  const label = open ? t('Recolher o aviso') : t('Mostrar o aviso completo');
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
  return open;
}

/**
 * Bottom bar below 900 px (§2.3): attendant Visão geral · Atendimento · Pendências · Equipe · Mais;
 * admin Visão geral · Atendimento · Agentes · Pendências · Mais. "Mais" holds the rest of the menu.
 */
export function bottomBarModel(ctx, entries) {
  const admin = isAdmin(ctx), pick = key => entries.find(entry => entry.key === key && !entry.sub);
  const bar = (admin ? ['overview', 'inbox', 'agents'] : ['overview', 'inbox']).map(pick).filter(Boolean);
  const team = teamAllowed(ctx);
  return { bar, pending: Boolean(ctx.hasTenant), team: team && !admin, more: entries.filter(entry => !bar.includes(entry)), moreTeam: team && admin };
}

function bottomBar(model, bottom) {
  const link = entry => h`<a class="sh-bottombar__item" href="${entry.href}" data-view="${entry.view}"${attributes({ 'aria-current': entry.current ? 'page' : null })}>${glyph(entry.icon)}<span class="sh-bottombar__label">${entry.label}</span>${countSlot(entry.key)}</a>`;
  const more = bottom.more.length > 0 || bottom.moreTeam;
  const pending = bottom.pending ? h`<button type="button" class="sh-bottombar__item" data-action="shell:pending">${glyph('bell')}<span class="sh-bottombar__label">Pendências</span>${countSlot('pending')}</button>` : '';
  const team = bottom.team ? h`<button type="button" class="sh-bottombar__item" data-action="shell:team">${glyph('users')}<span class="sh-bottombar__label">Equipe</span>${countSlot('team')}</button>` : '';
  const toggle = more ? h`<button type="button" class="sh-bottombar__item" data-shell-toggle="more" aria-expanded="false" aria-controls="sh-more-panel" aria-haspopup="dialog">${glyph('more')}<span class="sh-bottombar__label">Mais</span></button>` : '';
  const sheet = more ? h`<div class="sh-sheet" id="sh-more-panel" role="dialog" aria-label="Mais opções" data-shell-panel="more" hidden><ul class="sh-sheet__list">${bottom.more.map(entry => h`<li><a class="sh-sheet__item" href="${entry.href}" data-view="${entry.view}"${attributes({ 'aria-current': entry.current ? 'page' : null })}>${glyph(entry.icon)}<span>${entry.label}</span></a></li>`)}${bottom.moreTeam ? h`<li><button type="button" class="sh-sheet__item" data-action="shell:team">${glyph('users')}<span>Equipe</span></button></li>` : ''}</ul></div>` : '';
  return h`<nav class="sh-bottombar" aria-label="Navegação rápida"${attributes({ inert: Boolean(model.mobile && model.menuOpen) })}>${bottom.bar.map(link)}${pending}${team}${toggle}</nav>${sheet}`;
}

/**
 * The whole frame around the legacy view. `model` is plain data assembled by render() in app.js:
 * view, viewLabel, ctx (navContext), brand, workspace {id, name, kind}, workspaces, supportGrantId,
 * support {reason, expiresAt}, tenant, tenants, user {name, avatar, role, presence}, locale, prefs,
 * version (platform owner only), sandbox, notice ('admin'|'operator' until dismissed, else null),
 * layout/toggleable (shellLayout), mobile, menuOpen, mainClass and content (SafeHTML of the legacy
 * view, inserted unchanged in <main>).
 */
export function shellMarkup(model) {
  const ctx = model.ctx, entries = menuEntries(ctx, model.view), brand = model.brand || {};
  const scope = scopeModel(model), crumbs = shellCrumbs({ view: model.view, viewLabel: model.viewLabel, brandName: brand.name });
  const drawer = Boolean(model.mobile), open = drawer && Boolean(model.menuOpen), full = model.layout === 'full';
  // chat-layout.js keeps this label in sync after a toggle; the first paint already says the right thing.
  const railLabel = full ? t('Recolher menu lateral') : t('Expandir menu lateral');
  const chip = scope.switchable
    ? h`<button type="button" class="sh-scopechip" data-action="shell:scope" aria-label="${t('Trocar workspace ou empresa (atual: {company})', { company: scope.company })}"><span class="sh-scopechip__label">${scope.company}</span>${glyph('chevron-down')}</button>`
    : h`<span class="sh-scopechip sh-scopechip--static"><span class="sh-scopechip__label">${scope.company}</span></span>`;
  const pending = ctx.hasTenant ? h`<button type="button" class="sh-iconbtn sh-topbar__pending" data-action="shell:pending" aria-label="Pendências" title="Pendências">${glyph('bell')}${countSlot('pending')}</button>` : '';
  const team = teamAllowed(ctx) ? h`<button type="button" class="sh-iconbtn sh-topbar__team" data-action="shell:team" aria-label="Equipe" title="Equipe">${glyph('users')}${countSlot('team')}</button>` : '';
  return h`<div class="app-shell sh-app" data-view="${model.view}" data-sh-layout="${full ? 'full' : 'rail'}">
    <button type="button" class="sh-skip" data-action="skip-content">Pular para o conteúdo</button>
    <button type="button" class="sh-scrim" data-action="close-menu" aria-label="Fechar menu"${attributes({ hidden: !open })}></button>
    <aside class="sh-sidebar" id="sh-sidebar" aria-label="Menu lateral"${attributes({ 'data-state': open ? 'open' : null, inert: drawer && !open })}>${scopeBlock(model, scope)}${sidebarNav(entries)}</aside>
    <div class="main-shell sh-main"${attributes({ inert: open })}>
      <header class="sh-topbar">
        <button type="button" class="sh-iconbtn sh-topbar__menu" data-action="menu" aria-label="Abrir menu" aria-controls="sh-sidebar" aria-expanded="${open ? 'true' : 'false'}">${glyph('menu')}</button>
        <button type="button" class="sh-iconbtn sh-topbar__rail" data-layout-action="sidebar" aria-controls="sh-sidebar"${attributes({ 'aria-label': railLabel, title: railLabel, 'aria-expanded': full ? 'true' : 'false', hidden: !model.toggleable })}>${glyph(full ? 'sidebar-close' : 'sidebar-open')}</button>
        ${crumbsMarkup(crumbs)}
        ${chip}
        <div class="sh-topbar__actions">
          <button type="button" class="sh-search" data-action="navigation-search" aria-label="Buscar no painel" aria-keyshortcuts="Control+K Meta+K">${glyph('search')}<span class="sh-search__label" aria-hidden="true">Buscar no painel</span>${kbd('mod+k')}</button>
          <span class="sh-conn" data-shell-slot="connection" hidden></span>
          ${pending}${team}${accountTrigger(model)}
        </div>
      </header>
      ${bannersMarkup(model)}
      <main id="main-content" tabindex="-1" class="content${model.mainClass ? ' ' + model.mainClass : ''}">${model.content}</main>
    </div>
    ${bottomBar(model, bottomBarModel(ctx, entries))}
  </div>`;
}

/** Keyboard shortcuts that exist in this version (the full map arrives with P2's keyboard.js). */
export function shortcutsMarkup() {
  const row = (keys, label) => h`<li class="sh-shortcuts__row"><span class="sh-shortcuts__keys">${keys}</span><span>${label}</span></li>`;
  return h`<ul class="sh-shortcuts">${[
    row(kbd('mod+k'), t('Buscar uma área do painel')),
    row(kbd('mod+enter'), t('Enviar a resposta ou salvar a nota interna')),
    row(kbd('enter'), t('Enviar no chat da equipe (Shift + Enter quebra a linha)')),
    row(kbd('escape'), t('Fechar a janela, o menu aberto ou o chat expandido')),
    row([kbd('←'), kbd('→')], t('Ajustar a largura da lista ou do contexto no divisor de painéis'))
  ]}</ul>`;
}

/**
 * Mobile drawer (below 900 px): the sidebar opens over a scrim; the rest of the page is inert while
 * it is open and the sidebar is inert while it is closed (§2.3). From 900 px on nothing is inert.
 * With focus, the menu receives the focus on open and the menu button gets it back on close.
 */
export function setShellDrawer(doc, open, { mobile = true, focus = false } = {}) {
  const sidebar = doc?.getElementById?.('sh-sidebar');
  if (!sidebar) return false;
  const opened = Boolean(open && mobile);
  sidebar.toggleAttribute('inert', Boolean(mobile && !opened));
  if (opened) sidebar.setAttribute('data-state', 'open'); else sidebar.removeAttribute('data-state');
  const scrim = doc.querySelector('.sh-scrim');
  if (scrim) scrim.hidden = !opened;
  doc.querySelector('.sh-main')?.toggleAttribute('inert', opened);
  doc.querySelector('.sh-bottombar')?.toggleAttribute('inert', opened);
  const button = doc.querySelector('.sh-topbar__menu');
  button?.setAttribute('aria-expanded', String(opened));
  if (focus) (opened ? sidebar.querySelector('.sh-scope__trigger, .sh-nav__item') : button)?.focus?.({ preventScroll: true });
  return opened;
}

/** Applies a new sidebar mode without a render (viewport change, rail toggle). */
export function applyShellLayout(doc, { layout, toggleable }) {
  const root = doc?.querySelector?.('.sh-app');
  if (!root) return false;
  root.setAttribute('data-sh-layout', layout === 'full' ? 'full' : 'rail');
  const toggle = root.querySelector('.sh-topbar__rail');
  if (toggle) toggle.hidden = !toggleable;
  return true;
}

/** Checks the radio `value` of a group again (segmented indicator included) after a refused change. */
export function setShellChoice(doc, name, value) {
  const inputs = [...(doc?.querySelectorAll?.(`input[name="${name}"]`) || [])];
  const index = inputs.findIndex(input => input.value === value);
  if (index < 0) return false;
  inputs[index].checked = true;
  inputs[index].closest?.('.ui-seg')?.style?.setProperty('--seg-index', String(index));
  return true;
}

/** Presence ring of the account avatars and its accessible label, after PATCH /api/auth/presence. */
export function setShellPresence(doc, presence, name = '') {
  const value = PRESENCE.includes(presence) ? presence : 'available';
  for (const node of doc?.querySelectorAll?.('.sh-account .ui-avatar[data-presence]') || []) {
    node.setAttribute('data-presence', value);
    if (node.getAttribute('role') === 'img') node.setAttribute('aria-label', `${name} · ${presenceLabel(value)}`);
  }
  setShellChoice(doc, 'shell-presence', value);
  return value;
}

const faviconCache = new Map();
/**
 * Favicon of the brand drawn on a canvas (§5.1): rounded square in the brand's derived solid, the
 * initials in its on color and a dot when `dot` (P2: não lidas para mim > 0). Served as a data: URL,
 * which the CSP already allows; the fixed /mark.svg is no longer the panel's icon.
 */
export function faviconHref({ accent, onAccent, letters, dot = false, dotColor = '' } = {}, doc = globalThis.document) {
  const key = JSON.stringify([accent, onAccent, letters, Boolean(dot && dotColor), dotColor]);
  if (faviconCache.has(key)) return faviconCache.get(key);
  const canvas = doc?.createElement?.('canvas'), context = canvas?.getContext?.('2d');
  if (!context || typeof canvas.toDataURL !== 'function') return null;
  canvas.width = 64; canvas.height = 64;
  context.fillStyle = accent;
  context.beginPath();
  if (typeof context.roundRect === 'function') context.roundRect(0, 0, 64, 64, 14); else context.rect(0, 0, 64, 64);
  context.fill();
  context.fillStyle = onAccent;
  context.font = `700 ${letters.length > 1 ? 28 : 34}px Manrope, "Segoe UI", system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(letters, 32, 34);
  if (dot && dotColor) {
    context.beginPath();
    context.arc(52, 12, 11, 0, Math.PI * 2);
    context.fillStyle = dotColor;
    context.fill();
  }
  const href = canvas.toDataURL('image/png');
  faviconCache.set(key, href);
  return href;
}

/** Points <link rel="icon"> at the brand favicon (one link owned by the shell; other icon links leave). */
export function applyFavicon(doc, { brand = {}, tokens, dot = false, dotColor = '' } = {}) {
  if (!doc?.head?.querySelector || !tokens?.light) return null;
  const letters = (String(brand.initials || '').trim() || initials(brand.name || '', 2)).slice(0, 2);
  const href = faviconHref({ accent: tokens.light.accent, onAccent: tokens.light.onAccent, letters, dot, dotColor }, doc);
  if (!href) return null;
  let link = doc.head.querySelector('link[data-shell-favicon]');
  for (const other of doc.head.querySelectorAll('link[rel~="icon"]')) if (other !== link) other.remove();
  if (!link) {
    link = doc.createElement('link');
    link.setAttribute('rel', 'icon');
    link.setAttribute('data-shell-favicon', '');
    doc.head.append(link);
  }
  link.setAttribute('type', 'image/png');
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  return href;
}

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const installed = new WeakSet();

/**
 * Behaviour of the shell popovers, delegated once per document: [data-shell-toggle="<name>"] opens
 * or closes #sh-<name>-panel (scope, account, more). One panel is open at a time; Esc closes it and
 * returns the focus to its trigger; a click or focus outside closes it without moving the focus. The
 * scope panel filters its options as the person types; ArrowUp/ArrowDown/Home/End walk the options.
 * render() replaces #app, so an open panel simply goes away with it; open() can reopen one after.
 * onNoticeDismiss runs when the person dismisses the transition notice (ui.js removes the banner).
 * An opener elsewhere on the page, data-action="shell:<name>" (the scope chip of the phone top bar),
 * is not "outside": app.js opens the panel from #app while the same tap is still bubbling, and the
 * focus and Esc stay with the toggle inside the drawer, because the top bar is inert behind it.
 * P10: the banner toggles expand or collapse their banner below 600 px, and the Tema choice of the
 * account menu is saved and applied at once (theme-prefs.js updateCurrentThemePrefs), without a render.
 */
export function installShell(doc = globalThis.document, { onNoticeDismiss } = {}) {
  let current = null;
  const alive = () => Boolean(current?.panel.isConnected && !current.panel.hidden);
  const outside = target => !current.panel.contains(target) && !current.trigger?.contains?.(target)
    && !target?.closest?.(`[data-action="shell:${current.name}"]`);

  function close({ restoreFocus = false } = {}) {
    if (!current) return false;
    const { panel, trigger } = current;
    current = null;
    if (panel.isConnected) panel.hidden = true;
    if (trigger?.isConnected) {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }
    return true;
  }

  function open(name, { trigger, focus = true } = {}) {
    const panel = doc.getElementById(`sh-${name}-panel`);
    if (!panel) return false;
    close();
    const opener = trigger?.isConnected ? trigger : doc.querySelector(`[data-shell-toggle="${name}"]`);
    panel.hidden = false;
    opener?.setAttribute('aria-expanded', 'true');
    current = { name, panel, trigger: opener };
    if (focus) {
      // The search, else the current option, else the checked choice, else the first control.
      const target = typeof focus === 'string' ? panel.querySelector(focus)
        : panel.querySelector('[data-shell-filter]') || panel.querySelector('[data-shell-option][aria-current="true"]') || panel.querySelector('input:checked') || panel.querySelector('a[href], button:not([disabled]), input:not([disabled])');
      target?.focus({ preventScroll: true });
    }
    return true;
  }

  function filter(input) {
    const panel = input.closest('[data-shell-panel]');
    if (!panel) return;
    const terms = normalize(input.value).trim().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const option of panel.querySelectorAll('[data-shell-option]')) {
      const text = normalize(option.getAttribute('data-shell-search') ?? option.textContent);
      const item = option.closest('li') || option, match = terms.every(term => text.includes(term));
      item.hidden = !match;
      if (match) shown++;
    }
    for (const group of panel.querySelectorAll('.sh-scope__group')) group.hidden = ![...group.querySelectorAll('li')].some(item => !item.hidden);
    const empty = panel.querySelector('[data-shell-empty]');
    if (empty) empty.hidden = shown > 0;
  }

  function walk(event) {
    const panel = event.target?.closest?.('[data-shell-panel="scope"]');
    if (!panel || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.target.matches?.('[data-shell-filter]')) return false;
    const options = [...panel.querySelectorAll('[data-shell-option]')].filter(option => !option.closest('li')?.hidden);
    if (!options.length) return false;
    const index = options.indexOf(event.target.closest('[data-shell-option]'));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    event.preventDefault();
    options[next].focus({ preventScroll: true });
    return true;
  }

  if (doc?.addEventListener && !installed.has(doc)) {
    installed.add(doc);
    doc.addEventListener('click', event => {
      if (event.target?.closest?.('[data-ui-dismiss="banner"]')?.closest?.('[data-shell-notice]')) onNoticeDismiss?.();
      const bannerToggle = event.target?.closest?.('[data-shell-banner-toggle]');
      if (bannerToggle) toggleShellBanner(bannerToggle);
      const toggle = event.target?.closest?.('[data-shell-toggle]');
      if (toggle) {
        const name = toggle.getAttribute('data-shell-toggle');
        if (alive() && current.name === name) close(); else open(name, { trigger: toggle });
        return;
      }
      if (!alive()) { current = null; return; }
      if (outside(event.target)) close();
    });
    doc.addEventListener('focusin', event => { if (alive() && outside(event.target)) close(); });
    doc.addEventListener('keydown', event => {
      if (!alive()) return;
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); close({ restoreFocus: true }); return; }
      walk(event);
    });
    doc.addEventListener('input', event => { if (event.target?.matches?.('[data-shell-filter]')) filter(event.target); });
    doc.addEventListener('change', event => {
      const input = event.target;
      if (input?.name === 'shell-theme' && input.checked !== false) updateCurrentThemePrefs({ theme: input.value });
      if (input?.name === 'shell-privacy' && input.checked !== false) updateCurrentThemePrefs({ privacy: input.value });
    });
  }
  return { open, close, get openPanel() { return alive() ? current.name : null; } };
}
