import { h, raw, t, getLocale } from './i18n.js';
import './locales-shell.js';
import './locales-management.js';
import './locales-settings.js';
import { tabs, tabPanel, button, badge, banner, emptyState, skeleton, brandReportLines, avatar } from './ui.js';
import { glyph } from './icons.js';
import { hubOf, legacyVisible, viewForRoute, routeForView, hashForView, hubFrame, conversationHash, navContext } from './nav-config.js';
import { parseHash, formatHash } from './router.js';
import { deriveBrandTokens, contrast, SURFACES, INK, WHITE } from './brand-theme.js';
import { shellTitle } from './shell-ui.js';
import { createAgentUsage } from './agent-usage-ui.js';

// Configurações, Revenda › Clientes, Plataforma, Indicadores, Ajuda e Minha conta (FRONTEND-V2 §2.1,
// §2.2, §8.9). Owned by P8.
//
// Hubs. Every hub keeps one internal view per tab (nav-config.js), so each tab keeps its own route
// rule (resolveView in render()). screenFrame() draws the tab strip around the markup of the view:
// - Configurações (#settings/<tab>) and Plataforma (#platform/<tab>): the tabs of nav-config's HUBS
//   plus the tabs that live only in the route grammar, Registro de atividades (#settings/activity)
//   and Visão (#platform/overview). They render under the first tab's view (viewForRoute), so they
//   never open wider than that view's rule; their content checks its own audience again.
// - Clientes (#accounts, view accounts): Contas, Planos (#accounts/plans) and Financeiro
//   (#accounts/billing). 'plans' and 'billing' are reserved words in the accountId position;
//   #accounts/<accountId> opens the detail of that account over Contas.
// - Indicadores (#metrics[/attendance|sla|agents], view metrics): Atendimentos, SLA and Agentes
//   (the AI usage of agent-usage-ui.js, P5, read-only: no "Ajustar cota" here).
// Other views (Agentes, Automação…) keep nav-config's hubFrame.
//
// Contract (§8.2): createSettings(deps) → {view(route), act, submit, reset, mount(main, route),
// paintBrand}. act answers the 'settings:*' actions of the registry (actions.js). deps (app.js), all
// read lazily: legacy(key, route) → markup of the module that owns view `key` (units-ui, workspace-ui,
// support-ui, billing-ui, accounts-ui, platform-users-ui, integrations-ui, guide-ui), state, request,
// render, refresh, toast, brandDraft(), account() (Minha conta), plans() (catalog page), plansAction and
// plansSubmit (its settings:plan-* actions and filter form), clients(tab) (loads of the Clientes tabs),
// openAccount(id), platformSummary() and reloadPlatform() (accounts-ui), mcp() (usage of mcp-ui.js).
// Visão and Saúde e versão are for the platform owner only (§9, decision 6): anybody else gets an
// honest notice and the panel never asks /api/health for them.

const CLIENT_TABS = Object.freeze(['plans', 'billing']);
const METRIC_TABS = Object.freeze(['attendance', 'sla', 'agents']);
const owner = ctx => Boolean(ctx.platformOwner) && !ctx.supportGrantId;
const admin = ctx => ctx.role === 'reseller' && !ctx.supportGrantId;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const number = value => integer(value) ? new Intl.NumberFormat(getLocale()).format(value) : '—';
const when = value => instant(value) ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const clock = value => instant(value) ? new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const ratioText = (value, passes) => new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((passes ? Math.round : Math.floor)(value * 10) / 10);
const hashOf = (section, params = {}) => { try { return formatHash({ section, params, query: {} }); } catch { return '#' + section; } };

/** Page header of every screen of this package: h1, one sentence and the actions of the page. */
export function pageHeader({ title, lead = '', actions = '', eyebrow = '', id = '' } = {}) {
  const anchor = String(id).replace(/[^a-z0-9-]/gi, '');
  return h`<header class="pg-settings__header"><div class="pg-settings__heading">${eyebrow ? h`<p class="pg-settings__eyebrow">${eyebrow}</p>` : ''}<h1 class="pg-settings__title"${raw(anchor ? ` id="${anchor}"` : '')}>${title}</h1>${lead ? h`<p class="pg-settings__lead">${lead}</p>` : ''}</div>${actions ? h`<div class="pg-settings__actions">${actions}</div>` : ''}</header>`;
}

/** The route a render of `view` shows: the hash when it opens this view, else the view's canonical route. */
export function routeOf(view, hash = globalThis.location?.hash) {
  const parsed = parseHash(hash || '');
  return parsed && viewForRoute(parsed) === view ? parsed : routeForView(view);
}

/** Tab of the hub that a route opens over `view` (null outside the hubs of this package). */
export function activeTab(view, route) {
  const params = route?.params || {};
  if (view === 'tenants' && params.tab === 'activity') return 'activity';
  if (view === 'platform' && params.tab === 'overview') return 'overview';
  const place = hubOf(view);
  if (place && ['settings', 'platform'].includes(place.hub.id)) return place.tab.id;
  if (view === 'accounts') return CLIENT_TABS.includes(params.accountId) ? params.accountId : 'accounts';
  if (view === 'metrics') return METRIC_TABS.includes(params.tab) ? params.tab : 'attendance';
  return null;
}

// Extra tabs of the route grammar (router.js SETTINGS_TABS / PLATFORM_TABS) shown next to nav-config's.
const extraTabs = {
  settings: [{ id: 'activity', href: '#settings/activity', label: () => t('Registro de atividades'), visible: ctx => legacyVisible('tenants', ctx) && ctx.hasTenant }],
  platform: [{ id: 'overview', href: '#platform/overview', label: () => t('Visão'), visible: ctx => legacyVisible('platform', ctx), first: true }]
};

/** {id, label, active, items:[{id,label,href}]} of the hub of `view`, or null when it has none here. */
export function hubModel(view, ctx, route) {
  const active = activeTab(view, route);
  if (!active) return null;
  const place = hubOf(view);
  if (place && ['settings', 'platform'].includes(place.hub.id)) {
    const hub = place.hub;
    const base = hub.tabs.filter(entry => entry.view === view && entry.id === active || legacyVisible(entry.view, ctx)).map(entry => ({ id: entry.id, label: entry.label, href: hashForView(entry.view) }));
    const extras = extraTabs[hub.id].filter(extra => extra.id === active || extra.visible(ctx)).map(extra => ({ id: extra.id, label: extra.label(), href: extra.href, first: Boolean(extra.first) }));
    const items = [...extras.filter(item => item.first), ...base, ...extras.filter(item => !item.first)].map(({ id, label, href }) => ({ id, label, href }));
    return { id: hub.id, label: hub.label, active, items };
  }
  if (view === 'accounts') {
    const plans = admin(ctx) && ['platform', 'reseller'].includes(ctx.accountKind), billing = admin(ctx) && ctx.accountKind === 'reseller';
    const items = [{ id: 'accounts', label: t('Contas'), href: '#accounts' }];
    if (plans || active === 'plans') items.push({ id: 'plans', label: t('Planos'), href: hashOf('accounts', { accountId: 'plans' }) });
    if (billing || active === 'billing') items.push({ id: 'billing', label: t('Financeiro'), href: hashOf('accounts', { accountId: 'billing' }) });
    return { id: 'accounts', label: t('Clientes'), active, items };
  }
  if (view === 'metrics') {
    const items = [{ id: 'attendance', label: t('Atendimentos'), href: '#metrics' }];
    if (ctx.can('inbox.read') || active === 'sla') items.push({ id: 'sla', label: t('SLA'), href: '#metrics/sla' });
    items.push({ id: 'agents', label: t('Agentes'), href: '#metrics/agents' });
    return { id: 'metrics', label: t('Indicadores'), active, items };
  }
  return null;
}

/**
 * Markup of `view` inside its hub: the tab strip of this package's hubs (with the extra tabs), or
 * nav-config's hubFrame for the other hubs. Fewer than two tabs leave the markup unchanged.
 */
export function screenFrame(view, ctx, content, route = routeOf(view)) {
  const model = hubModel(view, ctx, route);
  if (!model) return hubFrame(view, ctx, content);
  if (model.items.length < 2) return String(content);
  const id = 'hub-' + model.id;
  return String(h`<div class="ui-hub" data-hub="${model.id}">${tabs({ id, label: model.label, active: model.active, items: model.items })}${tabPanel({ tabsId: id, id: model.active, active: true, focusable: false, content: raw(content) })}</div>`);
}

/** Label of the open tab for the breadcrumb of these hubs (null when the shell already says it). */
export function tabCrumb(view, ctx, route) {
  const model = hubModel(view, ctx, route);
  if (!model || model.items.length < 2) return null;
  return model.items.find(item => item.id === model.active)?.label || null;
}

// ---------- Marca: prévias clara e escura e relatório de contraste (brand-theme.js) ----------

/** Contrast of the tokens derived from `hex` in both themes (text ≥4,5; focus and solid ≥3 or edge). */
export function brandContrast(hex) {
  const tokens = deriveBrandTokens(hex), rows = [];
  for (const theme of ['light', 'dark']) {
    const set = tokens[theme], surface = SURFACES[theme].s1;
    rows.push({ theme, kind: 'button-text', ratio: contrast(set.onAccent, set.accent), min: 4.5, edge: false });
    rows.push({ theme, kind: 'links', ratio: contrast(set.accentText, surface), min: 4.5, edge: false });
    rows.push({ theme, kind: 'focus', ratio: contrast(set.focus, surface), min: 3, edge: false });
    rows.push({ theme, kind: 'solid', ratio: contrast(set.accent, surface), min: 3, edge: set.edge !== 'transparent' });
  }
  return { tokens, rows: rows.map(row => ({ ...row, passes: row.ratio >= row.min || row.edge })) };
}

/** Custom properties of one preview window: the derived accent of the theme over its neutral surfaces. */
export function previewStyle(tokens, theme) {
  const set = tokens[theme], surface = SURFACES[theme];
  return [['--pv-bg', surface.bg], ['--pv-surface', surface.s1], ['--pv-ink', theme === 'dark' ? WHITE : INK], ['--pv-accent', set.accent], ['--pv-on-accent', set.onAccent],
    ['--pv-accent-text', set.accentText], ['--pv-accent-soft', set.accentSoft], ['--pv-accent-soft-border', set.accentSoftBorder], ['--pv-accent-soft-text', set.accentSoftText],
    ['--pv-focus', set.focus], ['--pv-edge', set.edge]].map(([name, value]) => `${name}:${value}`).join(';');
}

const safeLogo = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : '';
const brandInitials = draft => String(draft?.initials || draft?.name || '?').trim().slice(0, 3).toLocaleUpperCase(getLocale()) || '?';

/** Logo of the brand form: the prepared image or the initials. */
export function brandLogo(draft) {
  const logo = safeLogo(draft?.logo);
  return logo ? h`<img class="pg-settings__logo-img" src="${logo}" alt="" decoding="async"/>` : h`<span class="pg-settings__monogram" aria-hidden="true">${brandInitials(draft)}</span>`;
}

/** Light and dark previews side by side, painted with the tokens derived from the draft's color. */
export function brandPreviews(draft, { entity = '' } = {}) {
  const tokens = deriveBrandTokens(draft?.accent), name = String(draft?.name || '').trim() || t('Sua marca'), logo = safeLogo(draft?.logo);
  const mark = logo ? h`<img src="${logo}" alt="" decoding="async"/>` : brandInitials(draft);
  const greeting = entity ? t('Olá! Aqui é a equipe {name}.', { name: entity }) : t('Olá! Conte com a nossa equipe.');
  return ['light', 'dark'].map(theme => h`<figure class="pg-settings__preview" data-preview-theme="${theme}"><figcaption class="pg-settings__preview-label">${theme === 'dark' ? t('Tema escuro') : t('Tema claro')}</figcaption><div class="pg-settings__preview-window" style="${previewStyle(tokens, theme)}" aria-hidden="true"><div class="pg-settings__preview-bar"><span class="pg-settings__preview-mark">${mark}</span><span class="pg-settings__preview-name">${name}</span></div><div class="pg-settings__preview-body"><span class="pg-settings__preview-chip">${t('Atendimento da sua empresa')}</span><p class="pg-settings__preview-title">${t('Como podemos ajudar hoje?')}</p><p class="pg-settings__preview-text">${t('Seu cliente reconhece a marca em cada conversa.')} <span class="pg-settings__preview-link">${t('Ver detalhes')}</span></p><p class="pg-settings__preview-message">${greeting}</p><div class="pg-settings__preview-actions"><span class="pg-settings__preview-button">${t('Enviar mensagem')}</span><span class="pg-settings__preview-focus">${t('Campo em foco')}</span></div></div></div></figure>`);
}

const contrastLabels = () => ({ 'button-text': t('Texto dos botões'), links: t('Links e ícones'), focus: t('Anel de foco'), solid: t('Botão sobre o fundo') });

/** Contrast report of the Brand screen: the copy of brand-theme.js's report and the measured ratios. */
export function brandReport(hex) {
  const { tokens, rows } = brandContrast(hex), labels = contrastLabels();
  const lines = brandReportLines(tokens.report);
  if (tokens.report.fallback) lines.unshift(t('Cor inválida: usamos a cor padrão até você escolher outra.'));
  const verdict = row => row.ratio >= row.min ? badge(row.min === 3 ? t('Mínimo 3:1 ✓') : t('AA ✓'), 'success') : row.edge ? badge(t('Contorno ativado'), 'info') : badge(t('Abaixo do mínimo'), 'danger');
  const table = ['light', 'dark'].map(theme => h`<li class="pg-settings__contrast-row"><strong class="pg-settings__strong">${theme === 'dark' ? t('Tema escuro') : t('Tema claro')}</strong></li>${rows.filter(row => row.theme === theme).map(row => h`<li class="pg-settings__contrast-row" data-contrast="${row.kind}" data-contrast-theme="${theme}"><span>${labels[row.kind]}</span><span class="pg-settings__cluster"><span class="pg-settings__num">${ratioText(row.ratio, row.ratio >= row.min)}:1</span>${verdict(row)}</span></li>`)}`);
  return h`<ul class="pg-settings__report" aria-label="${t('Resumo do contraste')}">${lines.map(line => h`<li>${glyph('check')}<span>${line}</span></li>`)}</ul><ul class="pg-settings__contrast" aria-label="${t('Contraste medido')}">${table}</ul>`;
}

// ---------- Saúde e versão (GET /api/health: level, checks) ----------

const LEVELS = ['ok', 'degraded', 'down'];
/** The public health report as plain values; unknown shapes → null (the screen says it could not read it). */
export function healthModel(report) {
  if (!report || typeof report !== 'object' || !LEVELS.includes(report.level) || !report.checks || typeof report.checks !== 'object') return null;
  const pair = value => value && typeof value === 'object' ? { expected: integer(value.expected) ? value.expected : null, connected: integer(value.connected) ? value.connected : null } : { expected: null, connected: null };
  const storage = report.checks.storage && typeof report.checks.storage === 'object' ? report.checks.storage : {};
  const scheduler = report.checks.scheduler && typeof report.checks.scheduler === 'object' ? report.checks.scheduler : {};
  return {
    level: report.level, version: typeof report.version === 'string' ? report.version : null, mode: typeof report.mode === 'string' ? report.mode : null,
    whatsapp: pair(report.checks.whatsapp), telegram: pair(report.checks.telegram),
    storage: { state: typeof storage.state === 'string' ? storage.state : null, pending: integer(storage.pending) ? storage.pending : null, syncedAt: instant(storage.syncedAt) ? storage.syncedAt : null, local: storage.local === 'ok' ? 'ok' : storage.local ? 'unavailable' : null },
    scheduler: { state: ['running', 'stale', 'stopped'].includes(scheduler.state) ? scheduler.state : null, lastTickAt: instant(scheduler.lastTickAt) ? scheduler.lastTickAt : null }
  };
}

// ---------- Registro de atividades (tenant.audit, só para a administração) ----------

/** Audit events grouped by local day, newest first: [{key, label, events}]. */
export function activityDays(audit, { now = Date.now() } = {}) {
  const events = (Array.isArray(audit) ? audit : []).filter(event => event && typeof event.action === 'string' && instant(event.createdAt)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const dayKey = value => { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };
  const today = dayKey(now), yesterday = dayKey(now - 86400000), groups = [];
  for (const event of events) {
    const key = dayKey(event.createdAt);
    let group = groups.at(-1);
    if (!group || group.key !== key) groups.push(group = { key, label: key === today ? t('Hoje') : key === yesterday ? t('Ontem') : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long' }).format(new Date(event.createdAt)), events: [] });
    group.events.push({ action: event.action, actor: typeof event.actor === 'string' ? event.actor : '', createdAt: event.createdAt });
  }
  return groups;
}

// ---------- SLA (GET /api/tenants/:id/sla, metrics.read + inbox.read) ----------

const SLA_STATES = ['met', 'breached', 'pending', 'insufficient-data'];
/** The SLA report of the company as plain values, or null for an unknown shape. */
export function slaModel(report) {
  if (!report || typeof report !== 'object' || !report.policy || typeof report.policy !== 'object' || !report.totals || typeof report.totals !== 'object' || !Array.isArray(report.conversations)) return null;
  const timer = value => ({ state: SLA_STATES.includes(value?.state) ? value.state : 'insufficient-data', dueAt: instant(value?.dueAt) ? value.dueAt : null, completedAt: instant(value?.completedAt) ? value.completedAt : null });
  const totals = Object.fromEntries(['tracked', 'insufficient', 'firstReplyPending', 'firstReplyBreached', 'resolutionPending', 'resolutionBreached'].map(key => [key, integer(report.totals[key]) ? report.totals[key] : 0]));
  return {
    asOf: instant(report.asOf) ? report.asOf : null, enabled: report.policy.enabled === true,
    firstReplyMinutes: integer(report.policy.firstReplyMinutes) ? report.policy.firstReplyMinutes : null, resolutionMinutes: integer(report.policy.resolutionMinutes) ? report.policy.resolutionMinutes : null,
    totals, conversations: report.conversations.filter(row => row && typeof row.conversationId === 'string').map(row => ({ id: row.conversationId, contact: typeof row.contact === 'string' ? row.contact : '', channelId: typeof row.channelId === 'string' ? row.channelId : null, firstReply: timer(row.firstReply), resolution: timer(row.resolution) }))
  };
}

const minutesText = value => value === null ? '—' : value < 60 ? t('{count} min', { count: number(value) }) : t('{count} h', { count: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value / 60) });

export function createSettings(deps = {}) {
  const legacy = (key, route) => typeof deps.legacy === 'function' ? deps.legacy(key, route) : '';
  const appState = () => deps.state || {};
  const context = () => {
    const state = appState();
    return navContext({ session: state.boot?.session, supportGrantId: state.supportGrantId || null, hasTenant: Boolean(state.tenant), accountKind: state.boot?.reseller?.accountKind || null });
  };
  const scope = () => { const state = appState(); return JSON.stringify([state.workspaceId || null, state.supportGrantId || null, state.boot?.session?.userId || null]); };
  const request = (...args) => deps.request(...args);
  const repaint = views => { if (views.includes(appState().view)) deps.render?.(); };

  // ---- data only these screens read (health, SLA): one load at a time and a short-lived cache ----
  const records = { health: null, sla: null };
  async function load(name, key, fetcher, views, { force = false, ttl = 30000 } = {}) {
    const current = records[name];
    if (!force && current?.key === key && (current.loading || Date.now() - current.at < ttl)) return current;
    const record = records[name] = { key, data: current?.key === key ? current.data : null, error: '', loading: true, at: 0 };
    try { const data = await fetcher(); if (records[name] === record) record.data = data; }
    catch (error) { if (records[name] === record) record.error = error?.message || t('Não foi possível carregar estes dados agora.'); }
    finally { if (records[name] === record) { record.loading = false; record.at = Date.now(); repaint(views); } }
    return record;
  }
  const loadHealth = options => owner(context()) ? load('health', scope(), async () => { const report = healthModel(await request('/api/health')); if (!report) throw new Error(t('A resposta de saúde não veio no formato esperado.')); return report; }, ['architecture', 'platform'], options) : null;
  const slaKey = () => JSON.stringify([scope(), appState().tenant?.id || null]);
  const loadSla = options => {
    const tenant = appState().tenant, ctx = context();
    if (!tenant || !ctx.can('metrics.read') || !ctx.can('inbox.read')) return null;
    return load('sla', slaKey(), async () => { const report = slaModel(await request(`/api/tenants/${encodeURIComponent(tenant.id)}/sla`)); if (!report) throw new Error(t('O relatório de SLA não veio no formato esperado.')); return report; }, ['metrics'], options);
  };

  // ---- Indicadores › Agentes: the usage report cached by mcp-ui.js, read-only ----
  const usage = createAgentUsage({ source: {
    snapshot() { const mcp = deps.mcp?.(); if (!admin(context()) || !appState().tenant || typeof mcp?.usageSnapshot !== 'function') return null; return mcp.usageSnapshot() || { data: null, error: null, loading: true }; },
    load(options) { return admin(context()) ? deps.mcp?.()?.loadUsage?.(options) : undefined; },
    canEdit: () => false
  } });
  let usageListener = null;

  // ---------- Configurações › Marca e domínio ----------
  function brandPage() {
    const state = appState(), session = state.boot?.session || {}, kind = state.boot?.reseller?.accountKind;
    const draft = deps.brandDraft?.() || {}, workspaceScope = state.brandScope === 'reseller', canEdit = session.role === 'reseller';
    const entity = workspaceScope ? state.boot?.reseller?.name || '' : state.tenant?.name || '';
    const scopeName = workspaceScope ? kind === 'reseller' ? t('Painel da revenda') : kind === 'platform' ? t('Painel da plataforma') : t('Painel da conta') : t('Empresa {name}', { name: state.tenant?.name || '' });
    const scopeHint = workspaceScope ? t('Muda o painel de quem usa esta conta.') : t('Fica na empresa: monograma, webchat e mensagens.');
    const scopeButton = (value, text, pressed) => button({ label: text, variant: pressed ? 'primary' : 'secondary', size: 'sm', attrs: { 'data-brand-scope': value, 'aria-pressed': pressed ? 'true' : 'false' } });
    const domain = workspaceScope && canEdit ? button({ label: t('Domínio e HTTPS'), action: 'workspace-domain', icon: 'globe' }) : '';
    return h`<div class="pg-settings pg-settings--brand">
      ${pageHeader({ title: t('Marca e domínio'), lead: t('Personalize a identidade e confira a leitura nos temas claro e escuro antes de salvar.') })}
      <div class="pg-settings__cluster" role="group" aria-label="${t('Identidade a personalizar')}">${scopeButton('tenant', t('Empresa selecionada'), !workspaceScope)}${scopeButton('reseller', kind === 'reseller' ? t('Sua revenda') : kind === 'platform' ? t('Plataforma') : t('Sua conta'), workspaceScope)}</div>
      <div class="pg-settings__brand">
        <section class="pg-settings__section" aria-labelledby="brand-form-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="brand-form-title">${t('Identidade')}</h2><p class="pg-settings__muted">${scopeName}</p><p class="pg-settings__muted">${scopeHint}</p></div></div>
          <form id="brand-form" class="pg-settings__form">
            <div class="pg-settings__logo"><div id="brand-logo-preview" class="pg-settings__logo-preview">${brandLogo(draft)}</div><div class="pg-settings__stack"><strong class="pg-settings__strong">${t('Logotipo')}</strong><div class="pg-settings__cluster"><label class="ui-btn ui-btn--secondary ui-btn--sm pg-settings__file">${glyph('paperclip', 'ui-btn__icon')}<span class="ui-btn__label">${t('Escolher imagem')}</span><input id="brand-logo-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="${t('Escolher imagem do logotipo')}"${raw(canEdit ? '' : ' disabled')}/></label>${button({ label: t('Remover'), action: 'remove-brand-logo', variant: 'ghost', size: 'sm', disabled: !draft.logo || !canEdit })}</div><p id="brand-logo-status" class="pg-settings__hint" role="status">${t('PNG, JPEG ou WebP · a imagem é preparada neste dispositivo.')}</p></div></div>
            <div class="pg-settings__form-grid">
              <label class="pg-settings__field pg-settings__field--wide">${t('Nome do produto')}<input class="pg-settings__input" name="name" value="${draft.name || ''}" maxlength="48" required autocomplete="off"/></label>
              <label class="pg-settings__field">${t('Sigla')}<input class="pg-settings__input" name="initials" value="${draft.initials || ''}" maxlength="3" required autocomplete="off"/></label>
              <label class="pg-settings__field">${t('Cor principal')}<span class="pg-settings__color"><input class="pg-settings__input pg-settings__input--color" type="color" name="accent" value="${draft.accent || '#3157d5'}"/><span class="pg-settings__muted pg-settings__num" data-brand-hex>${String(draft.accent || '').toLowerCase()}</span></span></label>
              <label class="pg-settings__field pg-settings__field--wide">${t('Domínio desejado')}<input class="pg-settings__input" name="domain" value="${draft.domain || ''}" placeholder="chat.suaempresa.com.br" maxlength="100" autocomplete="off"/><span class="pg-settings__hint">${t('Preferência de marca. O endereço é vinculado em Domínio e HTTPS.')}</span></label>
            </div>
            <p class="form-error pg-settings__error" role="alert"></p>
            <div class="pg-settings__form-actions">${button({ label: t('Salvar identidade'), type: 'submit', variant: 'primary', icon: 'check', disabled: !canEdit })}${domain}</div>
          </form>
        </section>
        <section class="pg-settings__section" aria-labelledby="brand-preview-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="brand-preview-title">${t('Prévia e contraste')}</h2><p class="pg-settings__muted">${t('Os tons dos botões, links e foco são derivados da sua cor para manter a leitura nos dois temas.')}</p></div></div>
          <div class="pg-settings__previews" data-brand-previews>${brandPreviews(draft, { entity })}</div>
          <div class="pg-settings__stack" data-brand-report>${brandReport(draft.accent)}</div>
        </section>
      </div>
      ${banner({ tone: 'info', title: t('Cada identidade fica no seu lugar.'), body: t('A marca do painel vale para quem usa esta conta; a marca da empresa aparece no monograma, no webchat e nas mensagens. Uma não muda a outra.') })}
    </div>`;
  }

  /** Repaints logo, previews and report from the draft (live, while the person types or picks a color). */
  function paintBrand() {
    const doc = globalThis.document, form = doc?.getElementById?.('brand-form');
    if (!form) return false;
    const state = appState(), draft = deps.brandDraft?.() || {}, entity = state.brandScope === 'reseller' ? state.boot?.reseller?.name || '' : state.tenant?.name || '';
    const logo = doc.getElementById('brand-logo-preview'), previews = doc.querySelector('[data-brand-previews]'), report = doc.querySelector('[data-brand-report]'), hex = doc.querySelector('[data-brand-hex]');
    if (logo) logo.innerHTML = String(brandLogo(draft));
    if (previews) previews.innerHTML = brandPreviews(draft, { entity }).join('');
    if (report) report.innerHTML = String(brandReport(draft.accent));
    if (hex) hex.textContent = String(draft.accent || '').toLowerCase();
    return true;
  }

  // ---------- Configurações › Registro de atividades ----------
  function activityPage() {
    const state = appState(), tenant = state.tenant;
    const refresh = button({ label: t('Atualizar'), action: 'settings:activity-refresh', icon: 'refresh', size: 'sm' });
    const header = pageHeader({ title: t('Registro de atividades'), lead: tenant ? t('As alterações mais recentes registradas em {company}, com autor e horário.', { company: tenant.name || '' }) : t('Alterações registradas por empresa, com autor e horário.'), actions: tenant ? refresh : '' });
    if (!tenant) return h`<div class="pg-settings pg-settings--activity">${header}${emptyState({ icon: 'building', title: t('Escolha uma empresa para ver as alterações.'), body: t('Use o seletor de escopo no topo do menu.') })}</div>`;
    const days = activityDays(tenant.audit);
    const body = days.length ? days.map(day => h`<section class="pg-settings__section" aria-label="${day.label}"><h2 class="pg-settings__section-title">${day.label}</h2><ol class="pg-settings__timeline">${day.events.map(event => h`<li class="pg-settings__event"><span class="pg-settings__event-icon" aria-hidden="true">${glyph('activity')}</span><div class="pg-settings__event-body"><p class="pg-settings__event-title">${event.action}</p><p class="pg-settings__muted">${event.actor || t('Sistema')} · <time datetime="${event.createdAt}">${clock(event.createdAt)}</time></p></div></li>`)}</ol></section>`)
      : emptyState({ icon: 'activity', title: t('Nenhuma alteração registrada ainda.'), body: t('As alterações feitas pela equipe nesta empresa aparecem aqui, com autor, data e hora.') });
    return h`<div class="pg-settings pg-settings--activity">${header}${body}<p class="pg-settings__muted">${t('Mostra as alterações mais recentes desta empresa. Mensagens de clientes não entram neste registro.')}</p></div>`;
  }

  // ---------- Plataforma › Visão ----------
  const levelText = level => ({ ok: t('Tudo funcionando'), degraded: t('Operação com atenção'), down: t('Operação fora do ar') })[level];
  const levelHint = level => ({ ok: t('Conexões, armazenamento e agendador responderam como esperado.'), degraded: t('Parte das conexões ou do armazenamento não está como deveria. Confira as verificações.'), down: t('O servidor não confirmou o armazenamento local ou está encerrando. Confira antes de atender.') })[level];
  function healthSummary(record) {
    if (!record || record.loading && !record.data) return skeleton({ lines: 2, label: t('Consultando a saúde da plataforma…') });
    if (!record.data) return banner({ tone: 'warning', title: t('Não foi possível consultar a saúde da plataforma.'), body: record.error || '', action: { label: t('Tentar novamente'), action: 'settings:health-refresh' } });
    const data = record.data;
    return h`<div class="pg-settings__health" data-level="${data.level}" role="group" aria-label="${t('Saúde da plataforma')}"><span class="pg-settings__health-icon" aria-hidden="true">${glyph(data.level === 'ok' ? 'check' : 'warning')}</span><div class="pg-settings__health-text"><strong class="pg-settings__strong">${levelText(data.level)}</strong><p class="pg-settings__muted">${levelHint(data.level)}</p></div><a class="ui-btn ui-btn--secondary ui-btn--sm" href="#platform/health"><span class="ui-btn__label">${t('Ver saúde e versão')}</span></a></div>`;
  }
  function restricted(title) {
    return h`<div class="pg-settings">${pageHeader({ title })}${emptyState({ icon: 'shield', title: t('Esta área é exclusiva do dono da plataforma.'), body: t('Contas de clientes e revendas não veem a saúde nem a versão da plataforma.') })}</div>`;
  }
  function overviewPage() {
    if (!owner(context())) return restricted(t('Visão da plataforma'));
    const accounts = deps.platformSummary?.() || null, health = records.health?.key === scope() ? records.health : null, summary = accounts?.summary || null;
    const tiles = [[t('Revendas'), summary?.reseller], [t('Empresas'), summary?.business], [t('Pessoas ativas'), summary?.activeUsers], [t('Canais conectados'), summary?.connectedChannels], [t('Agentes ativos'), summary?.activeAgents]];
    const stats = summary ? h`<dl class="pg-settings__stats">${tiles.map(([label, value]) => h`<div class="pg-settings__stat"><dt class="pg-settings__stat-label">${label}</dt><dd class="pg-settings__stat-value">${number(value)}</dd></div>`)}</dl>`
      : accounts?.error ? banner({ tone: 'warning', title: t('Não foi possível carregar as contas.'), body: accounts.error }) : skeleton({ lines: 3, label: t('Carregando as contas da plataforma…') });
    const shortcuts = [['#platform/accounts', 'briefcase', t('Contas'), t('Revendas e empresas, com cada operação independente.')], ['#platform/users', 'users', t('Usuários'), t('Pessoas cadastradas em todas as contas.')], ['#platform/billing', 'document', t('Cobrança'), t('Contratos, faturas e baixas da plataforma.')], ['#platform/integrations', 'plug', t('Integrações'), t('Login, e-mail e modelo dos copilotos.')]];
    return h`<div class="pg-settings pg-settings--platform">
      ${pageHeader({ title: t('Visão da plataforma'), lead: t('Contas, pessoas e saúde da operação em um só lugar. Visível só para o dono da plataforma.'), actions: button({ label: t('Atualizar'), action: 'settings:overview-refresh', icon: 'refresh', size: 'sm' }) })}
      ${stats}
      ${healthSummary(health)}
      <ul class="pg-settings__cards">${shortcuts.map(([href, icon, label, text]) => h`<li class="pg-settings__card"><a class="pg-settings__link" href="${href}">${glyph(icon)} ${label}</a><p class="pg-settings__muted">${text}</p></li>`)}</ul>
    </div>`;
  }

  // ---------- Plataforma › Saúde e versão ----------
  function healthPage() {
    const state = appState();
    if (!owner(context())) return restricted(t('Saúde e versão'));
    const record = records.health?.key === scope() ? records.health : null, data = record?.data;
    const header = pageHeader({ title: t('Saúde e versão'), lead: t('Leitura do servidor, sem nomes de empresas. Visível só para o dono da plataforma.'), actions: button({ label: t('Atualizar'), action: 'settings:health-refresh', icon: 'refresh', size: 'sm', busy: Boolean(record?.loading) }) });
    const panel = state.boot?.version || null, server = data?.version || null;
    const mode = data?.mode === 'hosted-pilot' ? t('Implantação hospedada') : data?.mode === 'local-pilot' ? t('Execução local') : data?.mode || '—';
    const versions = h`<section class="pg-settings__section" aria-labelledby="health-version-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="health-version-title">${glyph('code')}${t('Versão')}</h2><p class="pg-settings__muted">${t('A versão do painel aberto e a do servidor que respondeu.')}</p></div></div><dl class="pg-settings__facts"><div><dt>${t('Painel aberto')}</dt><dd class="pg-settings__num">${panel || '—'}</dd></div><div><dt>${t('Servidor')}</dt><dd class="pg-settings__num">${server || '—'}</dd></div><div><dt>${t('Modo')}</dt><dd>${mode}</dd></div></dl>${panel && server && panel !== server ? banner({ tone: 'warning', title: t('Há uma versão nova no servidor.'), body: t('Atualize a página para carregar a versão {version} do painel.', { version: server }) }) : ''}</section>`;
    if (!data) return h`<div class="pg-settings pg-settings--health">${header}${healthSummary(record)}${versions}</div>`;
    const pairState = pair => pair.expected === null || pair.connected === null ? 'neutral' : pair.connected < pair.expected ? 'warning' : 'success';
    const checks = [
      { title: t('WhatsApp'), state: pairState(data.whatsapp), value: t('{connected} de {expected} conectados', { connected: number(data.whatsapp.connected), expected: number(data.whatsapp.expected) }), hint: t('Números com sessão que deveriam estar ativos.') },
      { title: t('Telegram'), state: pairState(data.telegram), value: t('{connected} de {expected} conectados', { connected: number(data.telegram.connected), expected: number(data.telegram.expected) }), hint: t('Bots que deveriam estar recebendo mensagens.') },
      { title: t('Armazenamento'), state: data.storage.local === 'unavailable' || data.storage.state === 'closed' ? 'danger' : ['offline', 'starting'].includes(data.storage.state) ? 'warning' : data.storage.state ? 'success' : 'neutral', value: data.storage.local === 'unavailable' ? t('Banco local indisponível') : data.storage.state ? t('Estado: {state}', { state: data.storage.state }) : '—', hint: data.storage.pending !== null ? t('{count} alterações aguardando sincronização · última em {time}', { count: number(data.storage.pending), time: when(data.storage.syncedAt) }) : t('Sem pendências de sincronização informadas.') },
      { title: t('Agendador'), state: data.scheduler.state === 'running' ? 'success' : data.scheduler.state === 'stale' ? 'warning' : 'neutral', value: { running: t('Em execução'), stale: t('Atrasado'), stopped: t('Parado') }[data.scheduler.state] || '—', hint: data.scheduler.lastTickAt ? t('Último ciclo às {time}', { time: clock(data.scheduler.lastTickAt) }) : t('Nenhum ciclo informado ainda.') }
    ];
    const verdict = state => state === 'success' ? badge(t('Normal'), 'success') : state === 'warning' ? badge(t('Atenção'), 'warning') : state === 'danger' ? badge(t('Falha'), 'danger') : badge(t('Sem dados'), 'neutral');
    return h`<div class="pg-settings pg-settings--health">
      ${header}
      ${healthSummary(record)}
      <section class="pg-settings__section" aria-labelledby="health-checks-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="health-checks-title">${glyph('activity')}${t('Verificações')}</h2><p class="pg-settings__muted">${t('Consultado às {time}.', { time: clock(record.at ? new Date(record.at).toISOString() : null) })}</p></div></div><ul class="pg-settings__checks">${checks.map(check => h`<li class="pg-settings__check-card" data-state="${check.state}"><div class="pg-settings__card-head"><strong class="pg-settings__strong">${check.title}</strong>${verdict(check.state)}</div><p class="pg-settings__text pg-settings__num">${check.value}</p><p class="pg-settings__muted">${check.hint}</p></li>`)}</ul></section>
      ${versions}
    </div>`;
  }

  // ---------- Indicadores › SLA e Agentes ----------
  const slaBadge = timer => timer.state === 'breached' ? badge(t('Vencido'), 'danger') : timer.state === 'met' ? badge(t('Cumprido'), 'success') : timer.state === 'pending' ? badge(t('No prazo'), 'info') : badge(t('Sem dados'), 'neutral');
  const slaDetail = timer => timer.dueAt ? t('Até {time}', { time: when(timer.dueAt) }) : timer.completedAt ? when(timer.completedAt) : '—';
  const metricsHeader = (lead, actions = '') => pageHeader({ title: t('Indicadores'), lead, actions });
  function slaPage() {
    const state = appState(), ctx = context(), tenant = state.tenant;
    if (!tenant || !ctx.can('metrics.read') || !ctx.can('inbox.read')) return h`<div class="pg-settings pg-settings--metrics">${metricsHeader(t('Prazos de primeira resposta e de resolução.'))}${emptyState({ icon: 'clock', title: t('Os prazos dependem de ver os atendimentos.'), body: t('Peça à administração as permissões Ver indicadores e Ver atendimentos.') })}</div>`;
    const record = records.sla?.key === slaKey() ? records.sla : null, data = record?.data;
    const head = metricsHeader(t('Prazos de primeira resposta e de resolução em {company}.', { company: tenant.name || '' }), button({ label: t('Atualizar'), action: 'settings:sla-refresh', icon: 'refresh', size: 'sm', busy: Boolean(record?.loading) }));
    if (!data) return h`<div class="pg-settings pg-settings--metrics">${head}${record?.error ? banner({ tone: 'warning', title: t('Não foi possível carregar o SLA.'), body: record.error, action: { label: t('Tentar novamente'), action: 'settings:sla-refresh' } }) : skeleton({ lines: 4, label: t('Carregando os prazos…') })}</div>`;
    if (!data.enabled) return h`<div class="pg-settings pg-settings--metrics">${head}${emptyState({ icon: 'clock', title: t('O SLA está desligado nesta empresa.'), body: t('Ative as metas em Automação › Regras e SLA para acompanhar os prazos aqui.'), secondary: admin(ctx) ? { label: t('Abrir Regras e SLA'), href: '#automation' } : null })}</div>`;
    const tiles = [[t('Acompanhados'), data.totals.tracked, ''], [t('Primeira resposta vencida'), data.totals.firstReplyBreached, data.totals.firstReplyBreached ? 'warning' : ''], [t('Resolução vencida'), data.totals.resolutionBreached, data.totals.resolutionBreached ? 'warning' : ''], [t('Em andamento no prazo'), data.totals.firstReplyPending + data.totals.resolutionPending, '']];
    const channel = id => (tenant.channels || []).find(item => item.id === id)?.name || t('Canal');
    const rows = data.conversations.slice(0, 50);
    const table = rows.length ? h`<div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><caption class="sr-only">${t('Prazos por atendimento')}</caption><thead><tr><th scope="col">${t('Atendimento')}</th><th scope="col">${t('Primeira resposta')}</th><th scope="col">${t('Resolução')}</th></tr></thead><tbody>${rows.map(row => h`<tr${raw(row.firstReply.state === 'breached' || row.resolution.state === 'breached' ? ' data-tone="warning"' : '')}><th scope="row"><a class="pg-settings__link" href="${conversationHash({ tenantId: tenant.id, conversationId: row.id })}">${row.contact || t('Contato sem nome')}</a><span class="pg-settings__sub">${channel(row.channelId)}</span></th><td data-label="${t('Primeira resposta')}">${slaBadge(row.firstReply)}<span class="pg-settings__sub">${slaDetail(row.firstReply)}</span></td><td data-label="${t('Resolução')}">${slaBadge(row.resolution)}<span class="pg-settings__sub">${slaDetail(row.resolution)}</span></td></tr>`)}</tbody></table></div>`
      : h`<div class="pg-settings__empty-cell">${emptyState({ icon: 'check', title: t('Nenhum atendimento acompanhado agora.'), body: t('Os prazos aparecem quando um cliente envia mensagem com o SLA ligado.'), level: 3 })}</div>`;
    return h`<div class="pg-settings pg-settings--metrics">
      ${head}
      <dl class="pg-settings__stats">${tiles.map(([label, value, tone]) => h`<div class="pg-settings__stat"${raw(tone ? ` data-tone="${tone}"` : '')}><dt class="pg-settings__stat-label">${label}</dt><dd class="pg-settings__stat-value">${number(value)}</dd></div>`)}</dl>
      <section class="pg-settings__section pg-settings__section--flush" aria-labelledby="sla-table-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="sla-table-title">${t('Atendimentos acompanhados')}</h2><p class="pg-settings__muted">${t('Meta de primeira resposta: {first} · meta de resolução: {resolution}, no horário da política atual.', { first: minutesText(data.firstReplyMinutes), resolution: minutesText(data.resolutionMinutes) })}</p></div></div>${table}${data.conversations.length > rows.length ? h`<p class="pg-settings__pager">${t('Mostrando {shown} de {total} atendimentos.', { shown: number(rows.length), total: number(data.conversations.length) })}</p>` : ''}</section>
      <p class="pg-settings__muted">${t('Conta só os atendimentos que você pode ver. Atualizado às {time}.', { time: clock(data.asOf) })}</p>
    </div>`;
  }

  function agentsUsagePage() {
    const ctx = context();
    const head = metricsHeader(t('Consumo de IA dos copilotos desta empresa, por dia e por agente.'), admin(ctx) ? button({ label: t('Atualizar'), action: 'settings:usage-refresh', icon: 'refresh', size: 'sm' }) : '');
    if (!admin(ctx)) return h`<div class="pg-settings pg-settings--metrics">${head}${emptyState({ icon: 'chart', title: t('O consumo de IA é visível para a administração do workspace.'), body: t('Os atendimentos de cada agente aparecem em Atendimentos, junto com os da equipe.') })}</div>`;
    return h`<div class="pg-settings pg-settings--metrics">${head}${usage.view()}<p class="pg-settings__muted">${t('Somente leitura. A cota diária é ajustada em Agentes › Uso.')}</p></div>`;
  }

  // ---------- Minha conta (#account) ----------
  function accountPage() {
    const data = deps.account?.();
    if (!data?.user) return h`<div class="pg-settings">${pageHeader({ title: t('Minha conta') })}${skeleton({ lines: 3 })}</div>`;
    const { user, draft = {}, role = '', loading = false, google = {}, emailConfigured = false, security = '' } = data;
    const photoStatus = loading ? t('Preparando a foto…') : draft.avatarChanged ? t('Foto alterada. Salve o perfil para confirmar.') : draft.avatar ? t('Sua foto aparece na equipe e nas conversas internas.') : t('Adicione sua foto para a equipe reconhecer você nas conversas.');
    const confirmation = user.emailVerified ? badge(t('E-mail confirmado'), 'success') : user.email ? badge(t('Confirmação pendente'), 'warning') : badge(t('Sem e-mail'), 'neutral');
    const googleBody = user.googleLinked ? badge(t('Google vinculado'), 'success') : h`<div id="account-google"></div><p id="account-google-status" class="pg-settings__status" role="status"></p>`;
    const googleText = user.googleLinked ? t('Sua conta Google já está vinculada a este acesso.') : google.enabled ? t('Vincule sua conta Google para entrar com ela neste acesso.') : t('O login com Google fica disponível depois da configuração da plataforma.');
    return h`<div class="pg-settings pg-settings--account">
      ${pageHeader({ title: t('Minha conta'), lead: t('Seu perfil, seus acessos e a segurança das suas sessões.') })}
      <div class="pg-settings__grid pg-settings__grid--2">
        <section class="pg-settings__section" aria-labelledby="account-profile-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="account-profile-title">${user.name || ''}</h2><p class="pg-settings__muted">${role}</p></div></div>
          <form id="profile-form" class="pg-settings__form">
            <div class="pg-settings__logo"><div id="profile-avatar-preview" class="pg-settings__logo-preview">${avatar({ kind: 'person', name: draft.name || user.name, src: draft.avatar, size: 56 })}</div><div class="pg-settings__stack"><div class="pg-settings__cluster">${button({ label: t('Escolher foto'), action: 'choose-profile-photo', size: 'sm', disabled: loading })}${button({ label: t('Remover foto'), action: 'remove-profile-photo', variant: 'ghost', size: 'sm', disabled: !draft.avatar || loading })}</div><input type="file" id="profile-photo" accept="image/png,image/jpeg,image/webp" hidden/><p class="pg-settings__hint">${t('PNG, JPEG ou WebP · até 5 MB.')}</p><p id="profile-photo-status" class="pg-settings__status" role="status">${photoStatus}</p></div></div>
            <label class="pg-settings__field">${t('Nome')}<input class="pg-settings__input" name="name" value="${draft.name || ''}" maxlength="80" autocomplete="name" required/></label>
            <label class="pg-settings__field">${t('Telefone')}<input class="pg-settings__input" type="tel" name="phone" value="${draft.phone || ''}" maxlength="25" autocomplete="tel" inputmode="tel"/></label>
            <label class="pg-settings__field">${t('Bio')}<textarea class="pg-settings__input" name="bio" maxlength="180" rows="3" placeholder="${t('Como você participa da operação?')}">${draft.bio || ''}</textarea><span class="pg-settings__hint">${t('Até 180 caracteres.')}</span></label>
            <p class="form-error pg-settings__error" role="alert"></p>
            <div class="pg-settings__form-actions">${button({ label: t('Salvar perfil'), type: 'submit', variant: 'primary', icon: 'check', disabled: loading })}</div>
          </form>
        </section>
        <div class="pg-settings__stack">
          <section class="pg-settings__section" aria-labelledby="account-identity-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="account-identity-title">${t('Identidade de acesso')}</h2></div>${confirmation}</div>
            <dl class="pg-settings__facts"><div><dt>${t('Usuário')}</dt><dd>${user.username || '—'}</dd></div><div><dt>${t('E-mail')}</dt><dd>${user.email || t('Não informado')}</dd></div></dl>
            ${user.email && !user.emailVerified ? button({ label: t('Enviar confirmação'), action: 'verify-email', icon: 'arrow', size: 'sm' }) : ''}
            <p class="pg-settings__muted">${emailConfigured ? t('A confirmação é enviada pelo provedor de e-mail da plataforma.') : t('O administrador da plataforma ainda precisa ativar o provedor de e-mail.')}</p>
          </section>
          <section class="pg-settings__section" aria-labelledby="account-google-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="account-google-title">${t('Login com Google')}</h2><p class="pg-settings__muted">${googleText}</p></div></div>${google.enabled || user.googleLinked ? googleBody : ''}</section>
        </div>
      </div>
      ${raw(security)}
    </div>`;
  }

  // ---------- view, mount, act ----------
  /** Markup of the open tab (the frame comes from screenFrame in render()). */
  function view(route) {
    const key = route ? viewForRoute(route) : null;
    if (!key) return '';
    const tab = activeTab(key, route);
    if (key === 'brand') return String(brandPage());
    if (key === 'architecture') return String(healthPage());
    if (key === 'tenants' && tab === 'activity') return String(activityPage());
    if (key === 'platform' && tab === 'overview') return String(overviewPage());
    if (key === 'accounts' && tab === 'plans') return String(deps.plans?.() ?? '');
    if (key === 'accounts' && tab === 'billing') return legacy('billing', route);
    if (key === 'metrics' && tab === 'sla') return String(slaPage());
    if (key === 'metrics' && tab === 'agents') return String(agentsUsagePage());
    if (key === 'account') return String(accountPage());
    return legacy(key, route);
  }

  // Deep links that act once per arrival (#accounts/<id> opens the detail, #help/<topic> scrolls to
  // the topic): a hashchange or the first load marks the arrival; re-renders never repeat it.
  let arrival = globalThis.location?.hash ?? null;
  globalThis.addEventListener?.('hashchange', () => { arrival = globalThis.location?.hash ?? null; });

  /** The shell writes the hub's own tabs; the extra tabs and Clientes/Indicadores get theirs here. */
  function syncCrumbs(viewKey, route) {
    const doc = globalThis.document, label = tabCrumb(viewKey, context(), route), list = doc?.querySelector?.('.sh-crumbs__list');
    if (!label || !list) return;
    const items = [...list.children], section = items[1];
    if (!section) return;
    let tab = items[2];
    if (!tab) { tab = doc.createElement('li'); tab.className = 'sh-crumbs__item'; list.append(tab); }
    if (tab.textContent !== label) tab.textContent = label;
    tab.setAttribute('aria-current', 'page'); section.removeAttribute('aria-current');
    const brand = appState().boot?.reseller?.brand?.name || '', prefix = (String(doc.title || '').match(/^\(\d+\+?\) /) || [''])[0];
    const title = prefix + shellTitle({ screen: label, brand });
    if (doc.title !== title) doc.title = title;
  }

  /** After each render of one of these views: breadcrumb, the data the tab waits for and the one-time deep links. */
  function mount(main, route) {
    const key = route ? viewForRoute(route) : null;
    if (!key) return;
    const tab = activeTab(key, route), hash = globalThis.location?.hash ?? null, arrived = arrival !== null && arrival === hash;
    if (arrived) arrival = null;
    syncCrumbs(key, route);
    if (key === 'architecture' || key === 'platform' && tab === 'overview') void loadHealth();
    if (key === 'metrics' && tab === 'sla') void loadSla();
    if (key === 'metrics' && tab === 'agents' && admin(context())) {
      const mcp = deps.mcp?.();
      if (typeof mcp?.onUsage === 'function' && usageListener?.mcp !== mcp) { usageListener?.(); usageListener = Object.assign(mcp.onUsage(() => repaint(['metrics'])), { mcp }); }
      Promise.resolve(usage.load?.()).catch(() => {});
    }
    if (key === 'accounts') {
      deps.clients?.(tab);
      const id = route?.params?.accountId;
      if (arrived && id && !CLIENT_TABS.includes(id)) Promise.resolve(deps.openAccount?.(id)).catch(error => deps.toast?.(error?.message || t('Não foi possível abrir a conta.'), true));
    }
    if (key === 'guide' && arrived && route?.params?.topic) {
      const target = globalThis.document?.getElementById?.('guide-' + route.params.topic);
      if (target) { target.scrollIntoView?.({ block: 'start' }); target.focus?.({ preventScroll: true }); }
    }
  }

  async function act(name, id) {
    if (/^settings:plans?-/.test(name)) return Boolean(await deps.plansAction?.(name, id));
    switch (name) {
      case 'settings:health-refresh': await loadHealth({ force: true }); return true;
      case 'settings:overview-refresh': await Promise.all([loadHealth({ force: true }), deps.reloadPlatform?.()]); return true;
      case 'settings:sla-refresh': await loadSla({ force: true }); return true;
      case 'settings:usage-refresh': await usage.load?.({ force: true }); return true;
      case 'settings:activity-refresh': await deps.refresh?.(); return true;
      default: return false;
    }
  }

  function reset() { records.health = null; records.sla = null; usageListener?.(); usageListener = null; }

  /** data-form="settings:…": the filter of the Planos page (plans-ui.js). */
  async function submit(form) {
    if (form?.dataset?.form === 'settings:plans-filter') return Boolean(await deps.plansSubmit?.(form));
    return false;
  }

  return { view, act, submit, reset, mount, paintBrand, loadHealth, loadSla };
}
