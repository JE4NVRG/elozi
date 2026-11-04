// Inbox list (FRONTEND-V2 §5.2.2, §6). Owned by P3.
//
// - Rows are options of a listbox keyed by row-<tenantId>-<conversationId>. A poll never recreates
//   the list: dom-patch.js updates the rows in place, so the same nodes, their ids and the focus
//   survive every update (a screen reader keeps its place).
// - The order freezes while the pointer is over the list or the focus is inside it: rows that stay
//   keep their place and new conversations wait behind the "↑ N novas conversas" pill (click or
//   Enter applies). A change made by the person (lens, filter, search, more rows) is applied at once.
// - Focus is not opening: j/k and ↓/↑ (Home/End) move the focus between rows (roving tabindex);
//   Enter, o or a click opens the conversation, and only then it is marked as read (app.js).
// - Lenses Todos · Comigo · Fila · Agentes with the server counts (countTabs); filters Empresa, Canal,
//   Não lidas, Grupos (kind=group, the old #groups screen) and Ordenação, plus "Mais filtros".
//   Search, lenses, channel and unread stay visible; the other filters live in the "Filtros"
//   drawer at every width (button with the count of active filters, inbox:filters).
// - Chips only when they ask for action: ✎ own draft, ✦ agent state (agentRail.listGlyph, P4) and the
//   owner=agent alert ("Sem resposta automática" unless the agent answers alone on that channel).
// - New rows enter with grid rows 0fr→1fr, opacity and a soft highlight; a reorder of up to 5 rows
//   slides (FLIP) at most once every 2 s and never under the pointer or the focus; motion only when
//   motionOK() (theme-prefs.js).
import { h, raw, t, getLocale, registerTranslations } from './i18n.js';
import { avatar, companyMark, attributes, emptyState, button } from './ui.js';
import { glyph } from './icons.js';
import { patchKeyed, patchNode } from './dom-patch.js';
import { registerAlias } from './router.js';
import { registerAction } from './actions.js';
import { motionOK } from './theme-prefs.js';
import { inboxIdentity } from './consolidated-inbox-ui.js';
import './locales-inbox.js';

// §2.2: the Grupos screen became a filter of the inbox; #groups (bookmarks, the old menu) opens it.
registerAlias('groups', '#inbox?kind=group');

// EN for the copy that P10 added to the list (the "Filtros" drawer below 900 px); locales-inbox.js may
// take these over with the same wording.
registerTranslations({ 'Filtros': 'Filters', '1 filtro ativo': '1 active filter', '{count} filtros ativos': '{count} active filters', 'Canal e leitura': 'Channel and read status' });

export const LENSES = Object.freeze(['all', 'mine', 'queue', 'agent']);
export const INBOX_PAGE = 50;
export const INBOX_MAX_ROWS = 200;
const lensLabels = () => ({ all: t('Todos'), mine: t('Comigo'), queue: t('Fila'), agent: t('Agentes') });
const statusLabels = () => ({ active: t('Abertas e pendentes'), all: t('Todos os status'), open: t('Abertas'), pending: t('Pendentes'), closed: t('Encerradas') });
const sortLabels = () => ({ recent: t('Mais recentes'), oldest: t('Mais antigas'), unread: t('Não lidas primeiro') });
const attachmentLabels = () => ({ image: t('Foto'), audio: t('Áudio'), video: t('Vídeo') });
const channelKindNames = () => ({ whatsapp_qr: 'WhatsApp', whatsapp_cloud: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram', messenger: 'Messenger', webchat: 'Webchat', email: t('E-mail') });

/** Key and DOM id of a row: row-<tenantId>-<conversationId>. */
export const rowId = item => `row-${item?.tenantId ?? ''}-${item?.conversationId || item?.id || ''}`;

/** The lens a person lands on (§5.2.2): Comigo for an attendant, Todos for an admin (and support). */
export const defaultLens = session => session?.role === 'reseller' ? 'all' : 'mine';

/** True when a filter other than the lens narrows the list (empty state "Nenhum atendimento com estes filtros"). */
export function filtersActive(filters = {}) {
  return Boolean(String(filters.search || '').trim()) || [['inboxCompany', 'all'], ['channel', 'all'], ['department', 'all'], ['assignedUser', 'all'], ['kind', 'all'], ['status', 'active']]
    .some(([name, fallback]) => (filters[name] ?? fallback) !== fallback) || Boolean(filters.unread);
}

/**
 * Whether the agent of an owner=agent conversation answers alone on its channel (agent.autopilot of
 * the backend: enabled, the channel opted in, a configured Hermes copilot). null when unknown: the
 * agents of that company were never loaded in this tab, or the backend does not describe autopilot.
 */
export function autopilotOn(agent, channelId) {
  if (!agent) return null;
  if (!Object.hasOwn(agent, 'autopilot')) return false;
  const config = agent.autopilot;
  return Boolean(config && config.enabled === true && Array.isArray(config.channelIds) && config.channelIds.includes(channelId)
    && agent.provider === 'hermes' && agent.configured === true && (agent.mode === undefined || agent.mode === 'copilot'));
}

function stamp(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time), today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t('Ontem');
  return date.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit' });
}

function preview(item) {
  if (item.preview?.text) return item.preview.text;
  if (item.preview?.attachmentName) return `${attachmentLabels()[item.preview.attachmentKind] || t('Arquivo')} · ${item.preview.attachmentName}`;
  return t('Sem mensagem');
}

/** Agent alert of an owner=agent row (null for other owners). */
function agentChip(item, agents) {
  if (item.owner !== 'agent') return '';
  const list = agents?.(item.tenantId);
  const agent = Array.isArray(list) ? list.find(entry => entry.id === item.agentId) : undefined;
  // A connected agent (MCP) answers through its own product: name it instead of warning that nobody answers.
  if (agent?.provider === 'mcp') return h`<span class="pg-inbox__chip pg-inbox__chip--agent" title="${t('Agente conectado')}">✦ ${agent.name || t('Agente conectado')}</span>`;
  const auto = Array.isArray(list) ? autopilotOn(agent || null, item.channelId) : null;
  if (auto === true) return h`<span class="pg-inbox__chip pg-inbox__chip--agent">✦ Piloto automático</span>`;
  if (auto === false) return h`<span class="pg-inbox__chip pg-inbox__chip--warning">Sem resposta automática</span>`;
  return h`<span class="pg-inbox__chip pg-inbox__chip--agent">✦ Com agente</span>`;
}

/**
 * Queue alert: nobody owns the conversation and the customer spoke last 5 minutes to 24 hours ago (the same rule as the
 * "Na fila sem dono" section of Pendências; older ones are backlog). Empty for any other row.
 */
export function queueChip(item, now = Date.now()) {
  if (item.owner !== 'queue' || item.status === 'closed' || item.preview?.kind !== 'customer') return '';
  const since = Date.parse(item.preview.createdAt), minutes = Math.floor((now - since) / 60000);
  if (!Number.isFinite(since) || minutes < 5 || minutes >= 1440) return '';
  const label = minutes < 60 ? t('Na fila há {n} min', { n: minutes }) : t('Na fila há {n} h', { n: Math.floor(minutes / 60) });
  return h`<span class="pg-inbox__chip pg-inbox__chip--warning" title="${t('Ninguém assumiu e o cliente aguarda resposta.')}">${glyph('clock')}${label}</span>`;
}

/**
 * One row (role=option). options: {selection, workspaceId, userId, tenants, agents(tenantId),
 * listGlyph(item), hasDraft(item), tabbable}. The row keeps data-inbox-tenant and data-conversation:
 * a click goes through the click handler of app.js like before.
 */
export function inboxRowMarkup(item, options = {}) {
  const { selection, workspaceId, userId, tenants = [], agents, listGlyph, hasDraft, tabbable = false, now = Date.now() } = options;
  const selected = Boolean(selection) && inboxIdentity(selection) === inboxIdentity({ workspaceId, ...item, conversationId: item.conversationId || item.id });
  const unread = Math.max(0, Number(item.unread) || 0);
  const group = item.conversationKind === 'group';
  const tenant = tenants.find(entry => entry.id === item.tenantId) || { name: item.tenantName };
  const channel = item.channelName || channelKindNames()[item.channelKind] || t('Canal');
  // Company stays visible in its own mark. Only remove an exact redundant prefix; similar names
  // or another company's name still belong to the channel. Keep the original in its tooltip.
  const prefix = tenant.name ? `${tenant.name} · ` : '';
  const channelName = prefix && channel.startsWith(prefix) && channel.length > prefix.length ? channel.slice(prefix.length) : channel;
  const responsible = item.assignedUserId && item.assignedUserId === userId ? t('Com você') : '';
  // An explicit null means this conversation has no reliable message date. Fall back only for
  // snapshots from a server that predates the separate message/operational clocks.
  const messageAt = Object.hasOwn(item, 'lastMessageAt') ? item.lastMessageAt : item.preview?.createdAt || item.updatedAt;
  let glyphMarkup = '';
  try { glyphMarkup = listGlyph ? listGlyph(item) : ''; } catch { glyphMarkup = ''; }
  const draft = hasDraft?.(item) ? h`<span class="pg-inbox__chip pg-inbox__chip--draft" title="Rascunho seu salvo"><span aria-hidden="true">✎</span><span class="sr-only">Rascunho seu salvo</span></span>` : '';
  const offline = item.channelTransport && item.channelState && !['connected', 'sandbox'].includes(item.channelState) ? h`<span class="pg-inbox__chip pg-inbox__chip--danger">Canal desconectado</span>` : '';
  const team = item.replyExempt === true ? h`<span class="pg-inbox__chip" title="${t('Sem limite por hora para o agente; fica só a trava de 60 por minuto.')}">${t('Equipe/QA')}</span>` : '';
  const closed = item.status === 'closed' ? h`<span class="pg-inbox__chip">Encerrada</span>` : item.status === 'pending' ? h`<span class="pg-inbox__chip pg-inbox__chip--pending" title="${t('Para acompanhar')}">${glyph('clock')}Pendente</span>` : '';
  const state = { role: 'option', id: rowId(item), 'data-inbox-tenant': item.tenantId, 'data-conversation': item.conversationId || item.id,
    'aria-selected': selected ? 'true' : 'false', tabindex: tabbable ? '0' : '-1', 'data-state': unread ? 'unread' : null, 'data-status': item.status || null, 'data-kind': group ? 'group' : null };
  // Provider photos use the authorized binary endpoint, never a remote URL in the inbox DTO.
  // Each row carries its own company; it must not inherit the company of the open chat.
  const photoReference = ['baileys', 'telegram-bot'].includes(item.channelTransport) && item.tenantId && (item.conversationId || item.id)
    ? { 'data-avatar-kind': 'conversations', 'data-avatar-id': item.conversationId || item.id, 'data-avatar-tenant': item.tenantId } : {};
  const rowAvatar = String(avatar({ kind: group ? 'group' : 'person', name: item.contact, channel: item.channelKind || null, size: 40 }))
    .replace(/^<span /, `<span${attributes(photoReference)} `);
  return h`<div class="pg-inbox__row"${attributes(state)}><span class="pg-inbox__row-avatar">${raw(rowAvatar)}</span><span class="pg-inbox__row-main"><span class="pg-inbox__row-top"><span class="pg-inbox__row-name">${item.contact || t('Contato sem nome')}</span><span class="pg-inbox__row-activity"><time class="pg-inbox__row-time"${attributes({ datetime: messageAt || null })}>${stamp(messageAt)}</time>${unread ? h`<span class="pg-inbox__row-unread"><span aria-hidden="true">${unread > 99 ? '99+' : unread}</span><span class="sr-only">${unread === 1 ? t('1 mensagem não lida') : t('{count} mensagens não lidas', { count: unread })}</span></span>` : ''}</span></span><span class="pg-inbox__row-preview">${preview(item)}</span><span class="pg-inbox__row-origin" title="${tenant.name ? `${tenant.name} · ` : ''}${channelName}">${companyMark(tenant, { showName: true })}<span class="pg-inbox__row-origin-separator" aria-hidden="true">·</span><span class="pg-inbox__row-channel" title="${channel}">${channelName}</span></span><span class="pg-inbox__row-meta">${responsible ? h`<span class="pg-inbox__row-owner">${responsible}</span>` : ''}<span class="pg-inbox__row-chips">${closed}${offline}${queueChip(item, now)}${agentChip(item, agents)}${team}${raw(String(glyphMarkup || ''))}${draft}</span></span></span></div>`;
}

/** Index of the row that carries the roving tab stop in markup: the selected row, else the first. */
function tabbableIndex(items, options) {
  const index = items.findIndex(item => Boolean(options.selection) && inboxIdentity(options.selection) === inboxIdentity({ workspaceId: options.workspaceId, ...item, conversationId: item.conversationId || item.id }));
  return index < 0 ? 0 : index;
}

/** Rows of the current page as patch entries [{key, markup}]. */
export function inboxRowEntries(options) {
  const items = options.data?.items || [], tab = tabbableIndex(items, options);
  return items.map((item, index) => ({ key: rowId(item), markup: String(inboxRowMarkup(item, { ...options, tabbable: index === tab })) }));
}

/** Empty states of the list (§5.2.3 table), from the most specific situation. */
export function inboxEmptyMarkup(options) {
  const { data = {}, filters = {}, canManageChannels = false, loading = false, error = '' } = options;
  if (error) return h`<div class="pg-inbox__empty">${emptyState({ icon: 'warning', title: t('Não foi possível atualizar a caixa.'), body: error, action: { label: t('Tentar novamente'), action: 'refresh-attendance' }, level: 2 })}</div>`;
  if (!data.workspaceId && loading) return h`<div class="pg-inbox__empty"><p class="pg-inbox__empty-note">Carregando atendimentos…</p></div>`;
  const channels = Array.isArray(data.channels) ? data.channels : [];
  // Without a connected channel there is nothing to filter: "connect a channel" comes before "no results".
  if (data.workspaceId && !channels.some(channel => ['connected', 'sandbox'].includes(channel.state))) {
    return h`<div class="pg-inbox__empty">${emptyState({ icon: 'plug', title: t('Nenhum canal conectado.'), body: canManageChannels ? t('Conecte o WhatsApp ou o webchat para receber o primeiro atendimento.') : t('Peça ao administrador para conectar um canal.'), secondary: canManageChannels ? { label: t('Conectar canal'), href: '#channels' } : null, level: 2 })}</div>`;
  }
  if (filtersActive(filters)) return h`<div class="pg-inbox__empty">${emptyState({ icon: 'search', title: t('Nenhum atendimento com estes filtros.'), action: { label: t('Limpar filtros'), action: 'clear-inbox-filters' }, level: 2 })}</div>`;
  const lens = filters.filter || 'all';
  if (lens === 'queue') return h`<div class="pg-inbox__empty">${emptyState({ icon: 'check', title: t('Fila zerada.'), body: t('Ninguém esperando agora.'), level: 2 })}</div>`;
  if (lens === 'mine') return h`<div class="pg-inbox__empty">${emptyState({ icon: 'inbox', title: t('Nenhum atendimento com você agora.'), body: t('Assuma uma conversa da fila para começar.'), secondary: { label: t('Ver a fila'), action: 'inbox:lens-queue' }, level: 2 })}</div>`;
  if (lens === 'agent') return h`<div class="pg-inbox__empty">${emptyState({ icon: 'spark', title: t('Nenhum atendimento com agentes agora.'), level: 2 })}</div>`;
  return h`<div class="pg-inbox__empty">${emptyState({ icon: 'inbox', title: t('Tudo pronto.'), body: t('As conversas aparecem aqui assim que um cliente escrever.'), secondary: canManageChannels ? { label: t('Enviar um teste'), href: '#channels' } : null, level: 2 })}</div>`;
}

const option = (value, label, selected) => h`<option${attributes({ value, selected: value === selected })}>${label}</option>`;
const scoped = (values, filters) => (values || []).filter(item => filters.inboxCompany === 'all' || !filters.inboxCompany || item.tenantId === filters.inboxCompany);

/** Exact authorized connections, never a personal/business guess based on names or owners. */
export function inboxChannelsMarkup({ data = {}, filters = {}, tenants = [] }) {
  const companies = tenants.length ? tenants : data.tenants || [];
  const catalog = scoped(data.channels, filters);
  const companyName = item => item.tenantName || companies.find(company => company.id === item.tenantId)?.name || '';
  const fullName = item => {
    const company = companyName(item);
    return !company || filters.inboxCompany === item.tenantId || item.name === company || item.name?.startsWith(`${company} · `) ? item.name : `${company} · ${item.name}`;
  };
  const shortcuts = catalog.filter(item => ['whatsapp_qr', 'whatsapp_cloud'].includes(item.kind)).slice(0, 2);
  const distinguishCompanies = new Set(shortcuts.map(item => item.tenantId)).size > 1;
  return h`<div class="pg-inbox__channel-choices" data-inbox-channel-choices data-shortcuts="${shortcuts.length}" role="group" aria-label="${t('Linhas e canais')}">
    <label class="pg-inbox__select pg-inbox__select--channel"><span class="sr-only">Filtrar por conexão</span>${glyph('plug')}<select id="channel-filter">${option('all', t('Todos os canais'), filters.channel || 'all')}${catalog.map(item => option(JSON.stringify([item.tenantId, item.id]), fullName(item), filters.channel))}</select></label>
    ${shortcuts.map(item => {
      const value = JSON.stringify([item.tenantId, item.id]), company = companyName(item), prefix = `${company} · `;
      const name = company && item.name?.startsWith(prefix) && item.name.length > prefix.length ? item.name.slice(prefix.length) : item.name;
      return h`<button type="button" class="pg-inbox__channel-shortcut" data-action="inbox:channel" data-inbox-channel="${value}" aria-pressed="${filters.channel === value ? 'true' : 'false'}" title="${fullName(item)}"><span>${name}</span>${distinguishCompanies ? h`<small>${company}</small>` : ''}</button>`;
    })}
  </div>`;
}

/**
 * Filters that differ from their default (§5.2.2, P10). Include the visible channel and unread
 * shortcuts so the count continues to describe the complete narrowed list.
 */
export function inboxFilterCount(filters = {}) {
  const changed = [['inboxCompany', 'all'], ['channel', 'all'], ['kind', 'all'], ['sort', 'recent'], ['assignedUser', 'all'], ['status', 'active'], ['department', 'all']]
    .filter(([name, fallback]) => (filters[name] ?? fallback) !== fallback).length;
  return changed + (filters.unread ? 1 : 0);
}

// The drawer stays as the person left it while this page lives (polls and renders keep it open).
let filtersDrawerOpen = false;
const filtersToggle = doc => doc?.querySelector?.('[data-action="inbox:filters"]') || null;

/** Opens or closes the "Filtros" drawer without losing its selections or focus. */
export function setInboxFiltersOpen(open, { doc = globalThis.document, focus = false } = {}) {
  filtersDrawerOpen = Boolean(open);
  const panel = doc?.getElementById?.('inbox-filters-panel'), toggle = filtersToggle(doc);
  panel?.setAttribute('data-state', filtersDrawerOpen ? 'open' : 'closed');
  toggle?.setAttribute('aria-expanded', filtersDrawerOpen ? 'true' : 'false');
  if (focus) (filtersDrawerOpen ? panel?.querySelector?.('select, button') : toggle)?.focus?.({ preventScroll: true });
  return filtersDrawerOpen;
}
registerAction('inbox:filters', ({ element }) => { setInboxFiltersOpen(!filtersDrawerOpen, { doc: element?.ownerDocument || globalThis.document }); });

/**
 * Channel and unread are permanent shortcuts. Company, groups, sort and "Mais filtros"
 * (Atendente, Status, Departamento) are disclosed by the "Filtros" button at every width.
 */
export function inboxFiltersMarkup({ data = {}, filters = {}, tenants = [], moreOpen = false, drawerOpen = filtersDrawerOpen }) {
  const companies = (tenants.length ? tenants : data.tenants || []).map(item => [item.id, item.name]);
  const departments = scoped(data.departments, filters).map(item => [JSON.stringify([item.tenantId, item.id]), `${item.tenantName} · ${item.name}`]);
  const people = [...new Map((data.assignees || []).map(person => [person.id, person])).values()];
  const more = ['assignedUser', 'status', 'department'].filter(name => (filters[name] ?? 'all') !== (name === 'status' ? 'active' : 'all')).length;
  const active = inboxFilterCount(filters);
  const count = active ? h`<span class="pg-inbox__filters-count" aria-hidden="true">${active}</span><span class="sr-only">${active === 1 ? t('1 filtro ativo') : t('{count} filtros ativos', { count: active })}</span>` : '';
  return h`<div class="pg-inbox__filters" data-inbox-filters>
    <button type="button" class="pg-inbox__filters-toggle" data-action="inbox:filters" aria-controls="inbox-filters-panel" aria-expanded="${drawerOpen ? 'true' : 'false'}">${glyph('activity')}<span>${t('Filtros')}</span>${count}</button>
    <div class="pg-inbox__quick-filters" role="group" aria-label="${t('Canal e leitura')}">
      ${inboxChannelsMarkup({ data, filters, tenants })}
      <div class="pg-inbox__state-choices" role="group" aria-label="${t('Leitura e acompanhamento')}">
        <button type="button" class="pg-inbox__toggle pg-inbox__state-toggle" data-action="inbox:toggle-unread" aria-pressed="${filters.unread ? 'true' : 'false'}" title="${t('Mostrar mensagens não lidas')}"><span class="pg-inbox__toggle-dot" aria-hidden="true"></span><span><strong>Não lidas</strong><small>Mensagens novas</small></span></button>
        <button type="button" class="pg-inbox__toggle pg-inbox__state-toggle pg-inbox__state-toggle--pending" data-action="inbox:toggle-pending" aria-pressed="${filters.status === 'pending' ? 'true' : 'false'}" title="${t('Mostrar atendimentos pendentes')}">${glyph('clock')}<span><strong>Pendentes</strong><small>Para acompanhar</small></span></button>
      </div>
    </div>
    <div class="pg-inbox__filters-panel" id="inbox-filters-panel" data-state="${drawerOpen ? 'open' : 'closed'}">
    <label class="pg-inbox__select"><span class="sr-only">Empresas da caixa</span><select id="inbox-company-filter">${option('all', t('Todas as empresas'), filters.inboxCompany || 'all')}${companies.map(([value, label]) => option(value, label, filters.inboxCompany))}</select></label>
    <button type="button" class="pg-inbox__toggle" data-action="inbox:toggle-groups" aria-pressed="${filters.kind === 'group' ? 'true' : 'false'}">${glyph('users')}${t('Grupos')}</button>
    <label class="pg-inbox__select pg-inbox__select--sort"><span class="sr-only">Ordenação</span><select id="sort-filter">${Object.entries(sortLabels()).map(([value, label]) => option(value, label, filters.sort || 'recent'))}</select></label>
    <details class="pg-inbox__more" data-inbox-more${attributes({ open: moreOpen })}><summary class="pg-inbox__more-summary">${glyph('activity')}<span>Mais filtros</span>${more ? h`<span class="pg-inbox__more-count">${more}</span>` : ''}</summary><div class="pg-inbox__more-panel">
      <label class="pg-inbox__field"><span>Atendente</span><select id="assigned-user-filter">${option('all', t('Toda a equipe'), filters.assignedUser || 'all')}${people.map(person => option(person.id, person.name, filters.assignedUser))}</select></label>
      <label class="pg-inbox__field"><span>Status</span><select id="conversation-status-filter">${Object.entries(statusLabels()).map(([value, label]) => option(value, label, filters.status || 'active'))}</select></label>
      <label class="pg-inbox__field"><span>Departamento</span><select id="department-filter">${option('all', t('Todos os departamentos'), filters.department || 'all')}${option('unassigned', t('Sem departamento'), filters.department)}${departments.map(([value, label]) => option(value, label, filters.department))}</select></label>
      <button type="button" class="ui-btn ui-btn--link ui-btn--sm" data-action="clear-inbox-filters"><span class="ui-btn__label">Limpar filtros</span></button>
    </div></details>
    </div>
  </div>`;
}

/** Lens buttons with the server counts (countTabs); the counts are patched in place by data-inbox-count. */
export function inboxLensesMarkup({ data = {}, filters = {} }) {
  const labels = lensLabels(), counts = data.countTabs || {};
  return h`<div class="pg-inbox__lenses" role="group" aria-label="Filtrar responsável">${LENSES.map((key, index) => h`<button type="button" class="pg-inbox__lens" data-filter="${key}" aria-pressed="${(filters.filter || 'all') === key ? 'true' : 'false'}">${labels[key]}<span class="pg-inbox__lens-count" data-inbox-count="${key}">${Number(counts[key]) || 0}</span></button>`)}</div>`;
}

/**
 * Footer: "1–50 de 132", "Carregar mais" (50 at a time, up to 200 loaded), then pages of 200
 * ("Página anterior" | "Próxima página": every conversation stays reachable past 200 rows) and the
 * closed ones.
 */
export function inboxFooterMarkup({ data = {}, loading = false }) {
  const items = data.items || [], total = Number(data.total) || 0, offset = Number(data.offset) || 0, start = total && items.length ? offset + 1 : 0, end = offset + items.length;
  const more = Boolean(data.hasMore), capped = more && items.length >= INBOX_MAX_ROWS;
  const pageButton = (action, label) => h`<button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-action="${action}"${attributes({ disabled: loading })}><span class="ui-btn__label">${label}</span></button>`;
  return h`<footer class="pg-inbox__list-foot" data-inbox-footer><span class="pg-inbox__range" data-list-count>${t('{start}–{end} de {total}', { start, end, total })}</span>${more && !capped ? pageButton('inbox:load-more', t('Carregar mais')) : ''}${offset > 0 ? pageButton('inbox:previous-page', t('Página anterior')) : ''}${capped ? pageButton('inbox:next-page', t('Próxima página')) : ''}<button type="button" class="ui-btn ui-btn--link ui-btn--sm" data-action="show-closed"><span class="ui-btn__label">Encerradas</span><span class="pg-inbox__lens-count" data-attendance-count="closed">${Number(data.counts?.closed) || 0}</span></button></footer>`;
}

/** Section "Atendimento aberto pelo contato" (a conversation opened from Contatos outside this page). */
export function inboxFocusMarkup(options) {
  const { data = {}, focus, selection, workspaceId } = options;
  const present = (data.items || []).some(item => inboxIdentity({ workspaceId, ...item, conversationId: item.conversationId || item.id }) === inboxIdentity(selection));
  if (!focus || inboxIdentity({ workspaceId, ...focus }) !== inboxIdentity(selection) || present) return h`<section class="pg-inbox__focus" data-inbox-focus hidden></section>`;
  return h`<section class="pg-inbox__focus" data-inbox-focus aria-label="Atendimento aberto pelo contato"><div class="pg-inbox__focus-head"><strong>Atendimento aberto pelo contato</strong><span>Fora desta página ou dos filtros atuais.</span><button type="button" class="ui-btn ui-btn--link ui-btn--sm" data-action="clear-contact-inbox-focus"><span class="ui-btn__label">Remover foco do contato</span></button></div><div role="listbox" aria-label="Atendimento aberto pelo contato">${inboxRowMarkup(focus, { ...options, tabbable: false })}</div></section>`;
}

/** Banner of availability (§2.3): outside "Disponível" the person does not receive automatic distribution. */
export function presenceBannerMarkup(presence) {
  if (!presence || presence === 'available') return h`<div class="pg-inbox__presence" data-inbox-presence hidden></div>`;
  const names = { busy: t('Ocupado'), away: t('Ausente'), offline: t('Fora de atendimento') };
  return h`<div class="pg-inbox__presence" data-inbox-presence><span>${t('Você está {presence} e não recebe distribuição automática.', { presence: names[presence] || presence })}</span><button type="button" class="ui-btn ui-btn--link ui-btn--sm" data-action="inbox:available"><span class="ui-btn__label">Ficar disponível</span></button></div>`;
}

/** Availability chip of the list header (§2.3): opens the account menu on the availability choice. */
export function presenceChipMarkup(presence = 'available') {
  const names = { available: t('Disponível'), busy: t('Ocupado'), away: t('Ausente'), offline: t('Fora de atendimento') };
  const value = Object.hasOwn(names, presence) ? presence : 'available';
  return h`<button type="button" class="pg-inbox__presence-chip" data-action="inbox:presence" data-inbox-presence-chip data-presence="${value}" aria-label="${t('Disponibilidade: {presence}. Alterar', { presence: names[value] })}"><span class="pg-inbox__presence-dot" aria-hidden="true"></span><span aria-hidden="true">${names[value]}</span>${glyph('chevron-down')}</button>`;
}

/**
 * The whole list section (first paint, inside render()). options: {data, filters, selection, focus,
 * workspaceId, userId, tenants, loading, error, agents, listGlyph, hasDraft, presence, canCreate,
 * canManageChannels, moreOpen}.
 */
export function inboxListMarkup(options) {
  const { data = {}, filters = {}, presence = 'available', canCreate = false } = options;
  const entries = inboxRowEntries(options);
  return h`<section class="pg-inbox__list" id="inbox-list" aria-labelledby="inbox-title" data-inbox-list>
    <header class="pg-inbox__list-head">
      <div class="pg-inbox__title-row"><h1 class="pg-inbox__title" id="inbox-title">Atendimento</h1>${presenceChipMarkup(presence)}${canCreate ? h`<button type="button" class="ui-iconbtn ui-iconbtn--sm pg-inbox__new" data-action="new-conversation" aria-label="Novo atendimento" title="Novo atendimento">${glyph('plus')}</button>` : ''}</div>
      <label class="pg-inbox__search"><span class="sr-only">Buscar no histórico autorizado</span>${glyph('search')}<input id="conversation-search" type="search" maxlength="200" autocomplete="off" placeholder="Nome, número ou mensagem" value="${filters.search || ''}"/></label>
      ${inboxLensesMarkup(options)}
      ${inboxFiltersMarkup(options)}
    </header>
    ${presenceBannerMarkup(presence)}
    <p class="pg-inbox__list-status" data-inbox-status role="status">${options.error || ''}</p>
    ${inboxFocusMarkup(options)}
    <div class="pg-inbox__rows-wrap">
      <button type="button" class="pg-inbox__pill" data-action="inbox:apply-pending" data-inbox-pill hidden><span aria-hidden="true">↑</span> <span data-inbox-pill-label></span></button>
      <div class="pg-inbox__rows" id="conversation-items" role="listbox" aria-labelledby="inbox-title" aria-describedby="inbox-list-help"${attributes({ hidden: !entries.length, 'data-filters': filtersKey(options) })}>${raw(entries.map(entry => entry.markup).join(''))}</div>
      <div class="pg-inbox__empty-host" data-inbox-empty${attributes({ hidden: Boolean(entries.length) })}>${entries.length ? '' : inboxEmptyMarkup(options)}</div>
      <p class="sr-only" id="inbox-list-help">Use as setas ou J e K para percorrer. Enter abre a conversa.</p>
    </div>
    ${inboxFooterMarkup({ data, loading: options.loading })}
  </section>`;
}

/** Key of what the person chose (lens, filters, search, page size, page): a change is applied at once. */
export const filtersKey = options => JSON.stringify([options.workspaceId, options.filters?.filter, options.filters?.search, options.filters?.inboxCompany, options.filters?.channel, options.filters?.department,
  options.filters?.assignedUser, options.filters?.status, Boolean(options.filters?.unread), options.filters?.kind, options.filters?.sort, options.data?.limit, Number(options.data?.offset) || 0]);

const pillLabel = count => count === 1 ? t('1 nova conversa') : t('{count} novas conversas', { count });
const rowOf = target => target?.closest?.('#conversation-items [role="option"]') || null;
const editable = target => Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""]'));
const durationOf = (doc, name, fallback) => {
  try { const value = doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue(name).trim(); const ms = value.endsWith('ms') ? parseFloat(value) : value.endsWith('s') ? parseFloat(value) * 1000 : NaN; return Number.isFinite(ms) ? ms : fallback; }
  catch { return fallback; }
};

/**
 * Live controller of the list. createInboxList({doc, onOpen, motion, now}) →
 * {patch(options), applyPending(), keydown(event), move(row, delta), frozen(), pending, reset()}.
 * onOpen(tenantId, conversationId, row) opens a conversation (app.js selectInboxConversation + read).
 */
export function createInboxList({ doc = globalThis.document, onOpen = () => {}, motion = () => motionOK(), now = () => Date.now() } = {}) {
  let last = null, pending = [], lastFlip = 0, timers = [];
  const listbox = () => doc?.getElementById?.('conversation-items') || null;
  const section = () => doc?.getElementById?.('inbox-list') || null;
  const rows = box => [...(box?.children || [])].filter(node => node.getAttribute?.('role') === 'option');
  const hovered = node => { try { return Boolean(node?.matches?.(':hover')); } catch { return false; } };
  /** Pointer over the list or focus inside it: nothing moves (§5.2.2). */
  function frozen(box = listbox()) { return Boolean(box && (hovered(box) || box.contains?.(doc.activeElement))); }

  function roving(box) {
    const list = rows(box);
    if (!list.length) return;
    const active = list.find(node => node === doc.activeElement) || list.find(node => node.getAttribute('aria-selected') === 'true') || list.find(node => node.getAttribute('tabindex') === '0') || list[0];
    for (const node of list) { const value = node === active ? '0' : '-1'; if (node.getAttribute('tabindex') !== value) node.setAttribute('tabindex', value); }
  }
  function updatePill() {
    const pill = section()?.querySelector?.('[data-inbox-pill]');
    if (!pill) return;
    const label = pill.querySelector('[data-inbox-pill-label]');
    if (pending.length) {
      const text = pillLabel(pending.length);
      if (label && label.textContent !== text) label.textContent = text;
      if (pill.hidden) { pill.hidden = false; pill.setAttribute('data-enter', ''); timers.push(setTimeout(() => pill.removeAttribute('data-enter'), 400)); }
    } else if (!pill.hidden) pill.hidden = true;
  }
  function animateEnter(nodes) {
    for (const node of nodes) {
      node.setAttribute('data-enter', '');
      timers.push(setTimeout(() => node.removeAttribute?.('data-enter'), 1300));
    }
  }
  function positions(box) {
    const map = new Map();
    if (!box?.getBoundingClientRect) return map;
    for (const node of rows(box)) map.set(node.id, node.getBoundingClientRect().top);
    return map;
  }
  function flip(box, before, moved) {
    if (!moved.length || moved.length > 5 || now() - lastFlip < 2000 || !motion()) return;
    const duration = durationOf(doc, '--dur-base', 200);
    lastFlip = now();
    for (const key of moved) {
      const node = doc.getElementById(key), top = before.get(key);
      if (!node?.animate || top === undefined) continue;
      const delta = top - node.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration, easing: 'cubic-bezier(.2,0,0,1)' });
    }
  }
  function patchRegion(selector, markup) {
    const node = section()?.querySelector?.(selector);
    if (!node || node.contains?.(doc.activeElement)) return false;
    return patchNode(node, String(markup));
  }

  /**
   * Brings the list on screen up to `options` without recreating it. A poll keeps the order while
   * the list is frozen; a change made by the person (lens, filters, search, more rows) applies at
   * once. Returns the patch result (or null when the list is not on screen).
   */
  function patch(options, { force = false } = {}) {
    last = options;
    const box = listbox();
    if (!box) return null;
    // The filters the person chose are recorded once their page arrived (loading=false): the update
    // that brings the result of a new lens or filter is never held behind the pill.
    // The listbox records the filters its rows were drawn with (data-filters): the update that brings
    // the page of a new lens or filter applies at once; it is recorded once the page arrived.
    const key = filtersKey(options), drawn = box.getAttribute('data-filters'), changedByPerson = drawn !== null && drawn !== key;
    if (!options.loading && drawn !== key) box.setAttribute('data-filters', key);
    const freeze = !force && !changedByPerson && rows(box).length > 0 && frozen(box);
    const entries = inboxRowEntries(options);
    let result;
    const emptyHost = section()?.querySelector?.('[data-inbox-empty]');
    if (!entries.length) {
      const hadFocus = Boolean(box.contains?.(doc.activeElement));
      result = patchKeyed(box, [], { keyOf: node => node.id || 'other' });
      pending = [];
      if (!box.hidden) box.hidden = true;
      if (emptyHost) {
        const empty = String(inboxEmptyMarkup(options));
        const current = emptyHost.firstElementChild;
        if (current) patchNode(current, empty); else emptyHost.innerHTML = empty;
        if (emptyHost.hidden) emptyHost.hidden = false;
      }
      // The last row left under the focus: the focus goes to the next step of the empty state, else to
      // the active lens (never to <body>).
      if (hadFocus) (emptyHost?.querySelector?.('button:not([disabled]), a[href]') || section()?.querySelector?.('.pg-inbox__lens[aria-pressed="true"]') || doc.getElementById?.('conversation-search'))?.focus?.({ preventScroll: true });
    } else {
      if (box.hidden) box.hidden = false;
      if (emptyHost && !emptyHost.hidden) { emptyHost.hidden = true; emptyHost.innerHTML = ''; }
      const before = freeze ? new Map() : positions(box);
      const hadRows = rows(box).length > 0;
      // A row that leaves under the focus hands the focus to its neighbour before it goes.
      const focused = rows(box).find(node => node === doc.activeElement);
      if (focused && !entries.some(entry => entry.key === focused.id)) {
        const list = rows(box), index = list.indexOf(focused), neighbour = list.slice(index + 1).concat(list.slice(0, index).reverse()).find(node => entries.some(entry => entry.key === node.id));
        neighbour?.focus?.({ preventScroll: true });
      }
      result = patchKeyed(box, entries, { freeze, keep: ['tabindex', 'data-enter'], keyOf: node => node.getAttribute?.('role') === 'option' ? node.id : '' });
      pending = result.pending;
      if (hadRows && !changedByPerson) animateEnter(result.added);
      if (!freeze && hadRows) flip(box, before, result.moved);
    }
    roving(box);
    updatePill();
    patchRegion('[data-inbox-focus]', inboxFocusMarkup(options));
    patchRegion('[data-inbox-footer]', inboxFooterMarkup({ data: options.data, loading: options.loading }));
    patchRegion('[data-inbox-filters]', inboxFiltersMarkup({ ...options, moreOpen: Boolean(section()?.querySelector?.('[data-inbox-more]')?.open) }));
    // A shortcut can keep focus inside the filter region. Synchronize native values
    // without replacing its controls or touching a select that the person is using.
    for (const [id, value] of [['channel-filter', options.filters?.channel || 'all'], ['inbox-company-filter', options.filters?.inboxCompany || 'all'], ['conversation-status-filter', options.filters?.status || 'active'], ['department-filter', options.filters?.department || 'all']]) {
      const node = doc.getElementById?.(id);
      if (node && node !== doc.activeElement && node.value !== value) node.value = value;
    }
    patchRegion('[data-inbox-presence]', presenceBannerMarkup(options.presence));
    patchRegion('[data-inbox-presence-chip]', presenceChipMarkup(options.presence));
    for (const node of section()?.querySelectorAll?.('[data-inbox-count]') || []) {
      const value = String(Number(options.data?.countTabs?.[node.dataset.inboxCount]) || 0);
      if (node.textContent !== value) node.textContent = value;
    }
    for (const node of section()?.querySelectorAll?.('.pg-inbox__lens') || []) {
      const value = (options.filters?.filter || 'all') === node.dataset.filter ? 'true' : 'false';
      if (node.getAttribute('aria-pressed') !== value) node.setAttribute('aria-pressed', value);
    }
    // The toggles keep their state even while the focus stays on them (the filter row is not redrawn then).
    for (const [action, on] of [['inbox:toggle-unread', Boolean(options.filters?.unread)], ['inbox:toggle-pending', options.filters?.status === 'pending'], ['inbox:toggle-groups', options.filters?.kind === 'group']]) {
      const node = section()?.querySelector?.(`[data-action="${action}"]`), value = on ? 'true' : 'false';
      if (node && node.getAttribute('aria-pressed') !== value) node.setAttribute('aria-pressed', value);
    }
    for (const node of section()?.querySelectorAll?.('[data-inbox-channel]') || []) {
      const pressed = node.dataset.inboxChannel === options.filters?.channel ? 'true' : 'false';
      if (node.getAttribute('aria-pressed') !== pressed) node.setAttribute('aria-pressed', pressed);
    }
    // A search or filter the person changed is still on its way (the server can take seconds on a large inbox): say so
    // and mark the rows on screen as stale, so typing never looks ignored until something else (Enter) happens.
    const busy = Boolean(options.loading && changedByPerson && !options.error);
    if (busy && box.getAttribute('aria-busy') !== 'true') box.setAttribute('aria-busy', 'true');
    else if (!busy && box.getAttribute('aria-busy') !== null) box.removeAttribute('aria-busy');
    const status = section()?.querySelector?.('[data-inbox-status]');
    const search = String(options.filters?.search || '').trim();
    const statusText = options.error || (busy ? (search ? t('Buscando “{query}”…', { query: search.slice(0, 60) }) : t('Atualizando a lista…')) : '');
    if (status && status.textContent !== statusText) status.textContent = statusText;
    if (status && busy && status.getAttribute('data-state') !== 'busy') status.setAttribute('data-state', 'busy');
    else if (status && !busy && status.getAttribute('data-state') !== null) status.removeAttribute('data-state');
    return result;
  }

  /** Applies the conversations held behind the pill and moves the focus to the top of the list. */
  function applyPending() {
    const box = listbox();
    if (!last || !box) return false;
    patch(last, { force: true });
    box.scrollTop = 0;
    rows(box)[0]?.focus?.({ preventScroll: true });
    roving(box);
    return true;
  }

  /** Moves the focus (never the selection) to the row `delta` away from `row`; Home/End with ±Infinity. */
  function move(row, delta) {
    const list = rows(listbox());
    if (!list.length) return null;
    const index = row ? list.indexOf(row) : -1;
    const next = delta === Infinity ? list.length - 1 : delta === -Infinity ? 0 : Math.max(0, Math.min(list.length - 1, (index < 0 ? (delta > 0 ? -1 : list.length) : index) + delta));
    const target = list[next];
    for (const node of list) node.setAttribute('tabindex', node === target ? '0' : '-1');
    target.focus?.({ preventScroll: false });
    target.scrollIntoView?.({ block: 'nearest' });
    return target;
  }

  /**
   * Keys of the list (focus only on a row: WCAG 2.1.4 "active only on focus"): j/↓ next, k/↑
   * previous, Home/End, Enter/o opens. Returns true when the key was handled.
   */
  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
    // Esc inside the open "Filtros" drawer closes it and gives the focus back to its button.
    if (event.key === 'Escape' && filtersDrawerOpen && event.target?.closest?.('#inbox-filters-panel, [data-action="inbox:filters"]')) {
      event.preventDefault();
      setInboxFiltersOpen(false, { doc, focus: true });
      return true;
    }
    const pill = event.target?.closest?.('[data-inbox-pill]');
    if (pill && event.key === 'Enter') { event.preventDefault(); applyPending(); return true; }
    const row = rowOf(event.target);
    if (!row || editable(event.target)) return false;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'j') { event.preventDefault(); move(row, 1); return true; }
    if (key === 'ArrowUp' || key === 'k') { event.preventDefault(); move(row, -1); return true; }
    if (key === 'Home') { event.preventDefault(); move(row, -Infinity); return true; }
    if (key === 'End') { event.preventDefault(); move(row, Infinity); return true; }
    if (key === 'Enter' || key === 'o' || key === ' ') { event.preventDefault(); void onOpen(row.dataset.inboxTenant, row.dataset.conversation, row); return true; }
    return false;
  }

  /** Focuses the list (from outside: "j" with single-key shortcuts on): the open row, else the first. */
  function focusList() {
    const box = listbox(), list = rows(box);
    const target = list.find(node => node.getAttribute('tabindex') === '0') || list[0];
    if (!target) return false;
    target.focus?.();
    return true;
  }

  function reset() { last = null; pending = []; for (const timer of timers) clearTimeout(timer); timers = []; }
  return { patch, applyPending, keydown, move, focusList, frozen, reset, get pending() { return pending.slice(); } };
}
