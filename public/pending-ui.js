import { h, raw, t, labels, getLocale, translateError, SafeHTML } from './i18n.js';
import './locales-shell.js';
import './locales-agent-connect.js';
import { emptyState, button, progress, attributes, toasts } from './ui.js';
import { glyph } from './icons.js';
import { formatHash, PENDING_TYPES } from './router.js';
import { pendingProposalItems } from './agent-admin-proposals-ui.js';
import { mcpServerLabel } from './mcp-catalog.js';
import { waitingAgent } from './attention.js';

// Pendências (#pending[/<type>/<id>] and the sections of the bell drawer, FRONTEND-V2 §5.3.4, §8.7).
// Owned by P6.
//
// Contract (§8.2): createPending(deps) → {view(route), act, submit, reset, mount, drawerSections(snapshot)}.
// act answers the 'pending:*' actions through actions.js; drawerSections(snapshot) feeds the drawer of
// P2 with the same sections the page shows (structured data plus ready `html`).
//
// Rules: approving happens in the conversation (this screen only leads there); "Marcar como visto"
// never transfers and is a different action from "Assumir"; a section without a source says
// "Indisponível nesta versão", never a false zero.
//
// Sources, best first:
// 1. attention snapshot (GET /api/me/attention through attention.js, P2/P9): every authorized company;
// 2. MVP sources of the open company: state.tenant runs (approvals), conversations owned by an agent
//    (parked, with the rule of the server: the customer spoke last and, when the agent's autopilot answers
//    on that channel, no reply for 10 minutes), channels; GET …/agent-admin-proposals (admin),
//    GET …/agents/usage?days=1 (admin quota, limit 0 = AI off = 100%);
//    GET /api/inbox?unread=1&limit=1 → countTabs.mine + countTabs.queue ("não lidas para você").
//    Agent handoff requests have no company-wide source yet: they stay "Indisponível" here and are
//    handled in each conversation (service-handoffs-ui.js).
//
// deps: pageHeading (legacy helper). state (app state) or context() → see pendingContextFromState,
// request (api() of app.js), attention (the module of attention.js or a function returning it),
// toast(message, error), navigate(hash). Without state/context the P1 placeholder stays.

const TITLES = labels({
  approvals: 'Aprovações dos agentes', handoffs: 'Pedidos de apoio de agentes', parked: 'Conversas paradas com agente', waiting: 'Na fila sem dono',
  proposals: 'Propostas de configuração', channels: 'Canais com problema', quota: 'Cota de IA'
});
// Route type (#pending/<type>/<id>) of the items of each section.
const TYPES = Object.freeze({ approvals: 'approval', handoffs: 'handoff', parked: 'parked', waiting: 'waiting', proposals: 'proposal', channels: 'channel', quota: 'quota' });
const CHANNEL_PROBLEMS = labels({ logged_out: 'Sessão encerrada', failed: 'Falha de conexão', wrong_number: 'Número diferente', reconnecting: 'Reconectando' });
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const REFRESH_AFTER_MS = 60 * 1000;
const QUOTA_WARNING = 80;
// Same constants as GET /api/me/attention (src/consolidated-inbox.js).
const PUBLIC_KINDS = new Set(['customer', 'human', 'agent']);
const AUTOPILOT_STALL_MS = 10 * 60 * 1000;
const QUEUE_WAIT_MS = 5 * 60 * 1000, QUEUE_WAIT_MAX_MS = 24 * 3600 * 1000;

const minutes = ms => Math.max(0, Math.round(ms / 60000));
function ago(value, now) {
  const time = Date.parse(value); if (!Number.isFinite(time)) return '';
  const passed = minutes(now - time);
  return passed < 1 ? t('agora') : passed < 60 ? t('há {n} min', { n: passed }) : passed < 1440 ? t('há {n} h', { n: Math.round(passed / 60) }) : new Date(time).toLocaleDateString(getLocale(), { day: '2-digit', month: 'short' });
}
function expiresIn(value, now) {
  const time = Date.parse(value); if (!Number.isFinite(time)) return '';
  const left = minutes(time - now);
  return time <= now ? t('expirada') : left < 1 ? t('expira em menos de 1 min') : t('expira em {n} min', { n: left });
}
const conversationHash = (tenantId, conversationId, query = {}) => { try { return formatHash({ section: 'inbox', params: { tenantId, conversationId }, query }); } catch { return '#inbox'; } };
const pendingHash = (type, id) => { try { return formatHash({ section: 'pending', params: { type, id } }); } catch { return '#pending'; } };
const channelHash = channelId => { try { return formatHash({ section: 'channels', params: { channelId } }); } catch { return '#channels'; } };
/**
 * Last public message (customer, person or agent) of a conversation, from messages[] or, in the summary
 * DTO, from lastMessage. undefined when unknown: the summary's last message is a note or a system message.
 */
function lastPublic(conversation) {
  if (Array.isArray(conversation?.messages)) return conversation.messages.findLast(message => PUBLIC_KINDS.has(message?.kind)) || null;
  const last = conversation?.lastMessage;
  return last ? (PUBLIC_KINDS.has(last.kind) ? last : undefined) : null;
}

/** Context of the screen read from the app state (fields app.js already holds). */
export function pendingContextFromState(state) {
  const boot = state?.boot, session = boot?.session || {}, tenant = state?.tenant;
  return {
    workspaceId: state?.workspaceId || null, userId: session.userId || null, role: session.role || null, platformOwner: Boolean(session.platformOwner),
    supportGrantId: state?.supportGrantId || session.supportGrantId || null, permissions: session.permissions ?? null,
    tenant: tenant ? { id: tenant.id, name: tenant.name, brand: tenant.brand, runs: tenant.runs || [], conversations: tenant.conversations || [], channels: tenant.channels || [], agents: tenant.agents || [] } : null,
    tenants: Array.isArray(boot?.tenants) ? boot.tenants : [], features: Array.isArray(boot?.features) ? boot.features : []
  };
}

export function createPending({ pageHeading, state = null, context = null, request = null, attention = null, toast = null, navigate = null, timers = globalThis, location = globalThis.location } = {}) {
  const wired = Boolean(state) || typeof context === 'function';
  let remote = { scope: '', loadedAt: 0, loading: false, unread: undefined, proposals: undefined, quota: undefined }, mounted = null, busy = new Set(), sequence = 0;

  const now = () => typeof timers.now === 'function' ? timers.now() : Date.now();
  const ctx = () => { try { return (typeof context === 'function' ? context() : pendingContextFromState(state)) || {}; } catch { return {}; } };
  const scopeOf = c => [c.workspaceId || '', c.tenant?.id || '', c.userId || '', c.supportGrantId || ''].join(':');
  const isAdmin = c => c.role === 'reseller' && !c.supportGrantId;
  const can = (c, permission) => c.role === 'reseller' || c.permissions == null || (Array.isArray(c.permissions) && c.permissions.includes(permission));
  const say = (message, failure = false) => { if (!message) return; if (typeof toast === 'function') toast(message, failure); else toasts.show({ message, tone: failure ? 'error' : 'success' }); };
  const go = hash => { if (typeof navigate === 'function') navigate(hash); else if (location) location.hash = hash; };
  const options = c => ({ headers: { 'X-Elozi-Workspace': c.workspaceId, ...(c.supportGrantId ? { 'X-Elozi-Support-Grant': c.supportGrantId } : {}) } });
  const tenantName = (c, id) => c.tenants.find(item => item.id === id)?.name || (c.tenant?.id === id ? c.tenant.name : '') || t('Empresa');
  function snapshotOf(given) {
    if (given && typeof given === 'object') return given;
    try { const source = typeof attention === 'function' ? attention() : attention; return source?.snapshot?.() || null; } catch { return null; }
  }

  // ---- sections -----------------------------------------------------------------------------------
  // A snapshot from GET /api/me/attention (source 'attention') covers every authorized company; the pulse
  // snapshot of P2 only mirrors the open company, which this module reads richer from the app state.
  const crossCompany = snapshot => snapshot?.source === 'attention';
  function approvals(c, snapshot) {
    const time = now();
    if (Array.isArray(snapshot?.approvals) && (crossCompany(snapshot) || !c.tenant)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', items: snapshot.approvals.filter(item => ID.test(item?.tenantId || '') && ID.test(item?.conversationId || '')).map(item => ({
      id: String(item.runId || item.conversationId), tenantId: item.tenantId, title: t('{agent} quer usar {tool}', { agent: item.agentName || t('Agente'), tool: item.toolTitle || t('uma ferramenta') }),
      meta: [tenantName(c, item.tenantId), item.external ? t('ferramenta externa') : '', expiresIn(item.expiresAt, time)].filter(Boolean).join(' · '),
      href: conversationHash(item.tenantId, item.conversationId, ID.test(item.runId || '') ? { run: item.runId } : {}), urgent: true })) };
    if (!c.tenant) return null;
    const conversations = new Map(c.tenant.conversations.map(item => [item.id, item])), agents = new Map(c.tenant.agents.map(item => [item.id, item]));
    return { scope: 'tenant', items: c.tenant.runs.filter(run => run?.state === 'waiting_approval' && run.toolProposal && run.toolProposal.autoApproved !== true && ID.test(run.conversationId || '') && (!run.toolProposal.expiresAt || Date.parse(run.toolProposal.expiresAt) > time)).map(run => {
      const conversation = conversations.get(run.conversationId), proposal = run.toolProposal;
      const tool = [mcpServerLabel(proposal.serverName), proposal.title || proposal.toolName].filter(Boolean).join(' › ');
      return { id: String(run.id), tenantId: c.tenant.id, title: t('{agent} quer usar {tool}', { agent: agents.get(run.agentId)?.name || t('Agente'), tool: tool || t('uma ferramenta') }),
        meta: [c.tenant.name, conversation?.contact, expiresIn(proposal.expiresAt, time)].filter(Boolean).join(' · '),
        href: conversationHash(c.tenant.id, run.conversationId, ID.test(String(run.id)) ? { run: String(run.id) } : {}), urgent: true };
    }) };
  }
  function handoffs(c, snapshot) {
    const source = snapshot?.handoffs;
    if (Array.isArray(source?.items)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', items: source.items.filter(item => ID.test(item?.tenantId || '') && ID.test(item?.conversationId || '')).map(item => ({
      id: String(item.requestId || item.conversationId), tenantId: item.tenantId, title: item.reason ? t('{service}: "{reason}"', { service: item.serviceName || t('Agente conectado'), reason: String(item.reason).slice(0, 140) }) : item.serviceName || t('Pedido de apoio'),
      meta: [tenantName(c, item.tenantId), ago(item.createdAt, now())].filter(Boolean).join(' · '), href: conversationHash(item.tenantId, item.conversationId) })) };
    if (source && Number.isFinite(source.total)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', total: source.total, items: Object.entries(source.byTenant || {}).filter(([id, count]) => ID.test(id) && Number(count) > 0).map(([id, count]) => ({
      id, tenantId: id, title: t('{n} pedido(s) em {company}', { n: Number(count), company: tenantName(c, id) }), meta: t('Abra as conversas para assumir ou marcar como visto.'), href: formatHash({ section: 'inbox', params: {}, query: { tenant: id } }) })) };
    return null;
  }
  function parked(c, snapshot) {
    const time = now();
    // The server lists at most 50 (oldest first) and counts all of them in parkedTotal.
    if (Array.isArray(snapshot?.parked) && (crossCompany(snapshot) || !c.tenant)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', ...(Number.isSafeInteger(snapshot.parkedTotal) && snapshot.parkedTotal >= snapshot.parked.length ? { total: snapshot.parkedTotal } : {}),
      items: snapshot.parked.filter(item => ID.test(item?.tenantId || '') && ID.test(item?.conversationId || '')).map(item => ({
        id: item.conversationId, tenantId: item.tenantId, title: t('Sem resposta automática · assuma'), meta: [tenantName(c, item.tenantId), item.since ? t('{time} sem resposta', { time: ago(item.since, time) }) : ''].filter(Boolean).join(' · '),
        href: conversationHash(item.tenantId, item.conversationId) })) };
    if (!c.tenant) return null;
    const replier = can(c, 'inbox.reply'), agents = new Map(c.tenant.agents.map(item => [item?.id, item])), items = [];
    for (const item of c.tenant.conversations) {
      if (item?.owner !== 'agent' || item.status === 'closed' || !ID.test(item.id || '')) continue;
      // Same rule as GET /api/me/attention: the customer spoke last (unknown → not counted); while the
      // agent's autopilot answers on that channel, only a reply stalled for 10 minutes counts.
      const last = lastPublic(item);
      if (last?.kind !== 'customer') continue;
      const since = last.createdAt || item.updatedAt || null, autopilot = agents.get(item.agentId)?.autopilot;
      const automatic = autopilot?.enabled === true && (!Array.isArray(autopilot.channelIds) || autopilot.channelIds.includes(item.channelId));
      if (automatic && !(time - Date.parse(since) >= AUTOPILOT_STALL_MS)) continue;
      const other = item.assignedUserId && item.assignedUserId !== c.userId;
      items.push({ id: item.id, tenantId: c.tenant.id, title: item.contact || t('Conversa'), meta: [c.tenant.name, since ? t('{time} sem resposta', { time: ago(since, time) }) : ''].filter(Boolean).join(' · '), since,
        href: conversationHash(c.tenant.id, item.id), take: replier && !other && Number.isSafeInteger(item.version) ? { conversationId: item.id, version: item.version } : null });
    }
    items.sort((a, b) => (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0));
    return { scope: 'tenant', items };
  }
  /** Queue conversations nobody took, the customer speaking last from 5 minutes to 24 hours ago (same rule as GET /api/me/attention). */
  function waiting(c, snapshot) {
    const time = now(), replier = can(c, 'inbox.reply');
    const conversation = (tenantId, id) => c.tenant?.id === tenantId ? c.tenant.conversations.find(item => item?.id === id) : null;
    const take = (tenantId, id) => { const item = conversation(tenantId, id); return replier && item?.owner === 'queue' && Number.isSafeInteger(item.version) ? { conversationId: id, version: item.version } : null; };
    if (Array.isArray(snapshot?.waiting) && (crossCompany(snapshot) || !c.tenant)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', ...(Number.isSafeInteger(snapshot.waitingTotal) && snapshot.waitingTotal >= snapshot.waiting.length ? { total: snapshot.waitingTotal } : {}),
      items: snapshot.waiting.filter(item => ID.test(item?.tenantId || '') && ID.test(item?.conversationId || '')).map(item => ({
        id: item.conversationId, tenantId: item.tenantId, title: conversation(item.tenantId, item.conversationId)?.contact || t('Conversa na fila'),
        meta: [tenantName(c, item.tenantId), item.since ? t('{time} sem dono', { time: ago(item.since, time) }) : '', waitingAgent(item.agent, time)].filter(Boolean).join(' · '),
        href: conversationHash(item.tenantId, item.conversationId), take: take(item.tenantId, item.conversationId) })) };
    if (!c.tenant || crossCompany(snapshot)) return null;
    const items = [];
    for (const item of c.tenant.conversations) {
      if (item?.owner !== 'queue' || item.status === 'closed' || !ID.test(item.id || '')) continue;
      const last = lastPublic(item), since = last?.kind === 'customer' ? last.createdAt || item.updatedAt || null : null;
      if (!since || !(time - Date.parse(since) >= QUEUE_WAIT_MS && time - Date.parse(since) < QUEUE_WAIT_MAX_MS)) continue;
      items.push({ id: item.id, tenantId: c.tenant.id, title: item.contact || t('Conversa na fila'), meta: [c.tenant.name, t('{time} sem dono', { time: ago(since, time) })].join(' · '), since,
        href: conversationHash(c.tenant.id, item.id), take: take(c.tenant.id, item.id) });
    }
    items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    return { scope: 'tenant', items };
  }
  function proposals(c, snapshot) {
    if (!isAdmin(c)) return undefined;
    const counted = snapshot?.proposals && Number.isFinite(snapshot.proposals.total) ? { scope: crossCompany(snapshot) ? 'all' : 'tenant', total: snapshot.proposals.total, items: snapshot.proposals.total > 0 ? [{ id: 'all', title: t('{n} proposta(s) aguardando a sua decisão', { n: snapshot.proposals.total }), meta: t('Confira em Agentes, em Propostas para a operação.'), href: '#agents' }] : [] } : null;
    if (counted && crossCompany(snapshot) || !c.tenant) return counted;
    if (remote.scope !== scopeOf(c) || remote.proposals === undefined) return counted || (typeof request === 'function' ? { loading: true } : null);
    if (remote.proposals === null) return counted || { failed: true };
    return { scope: 'tenant', items: remote.proposals.map(item => ({ id: item.id, tenantId: c.tenant?.id, title: item.title, meta: [c.tenant?.name, item.serviceName ? t('proposto por {name}', { name: item.serviceName }) : ''].filter(Boolean).join(' · '), href: '#agents' })) };
  }
  function channels(c, snapshot) {
    const admin = isAdmin(c);
    if (Array.isArray(snapshot?.channelsDown) && (crossCompany(snapshot) || !c.tenant)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', items: snapshot.channelsDown.filter(item => ID.test(item?.tenantId || '') && ID.test(item?.channelId || '')).map(item => ({
      id: item.channelId, tenantId: item.tenantId, title: t('{channel} · {state}', { channel: item.name || t('Canal'), state: CHANNEL_PROBLEMS[item.state] || t('Canal com problema') }), meta: tenantName(c, item.tenantId), href: admin && item.tenantId === c.tenant?.id ? channelHash(item.channelId) : null, hrefLabel: t('Reconectar') })) };
    if (!c.tenant) return null;
    return { scope: 'tenant', items: c.tenant.channels.filter(item => Object.hasOwn(CHANNEL_PROBLEMS, item?.state) && ID.test(item.id || '')).map(item => ({
      id: item.id, tenantId: c.tenant.id, title: t('{channel} · {state}', { channel: item.name || t('Canal'), state: CHANNEL_PROBLEMS[item.state] }), meta: admin ? c.tenant.name : t('Avise a administração da empresa.'),
      href: admin ? channelHash(item.id) : null, hrefLabel: t('Reconectar') })) };
  }
  function quota(c, snapshot) {
    if (!isAdmin(c)) return undefined;
    if (Array.isArray(snapshot?.aiQuota) && (crossCompany(snapshot) || !c.tenant)) return { scope: crossCompany(snapshot) ? 'all' : 'tenant', items: snapshot.aiQuota.filter(item => ID.test(item?.tenantId || '') && Number.isFinite(item.usedPct)).map(item => ({ id: item.tenantId, tenantId: item.tenantId, title: item.name || tenantName(c, item.tenantId), pct: Math.max(0, Math.round(item.usedPct)), href: null })) };
    if (!c.tenant) return null;
    if (remote.scope !== scopeOf(c) || remote.quota === undefined) return typeof request === 'function' ? { loading: true } : null;
    if (remote.quota === null) return { failed: true };
    if (remote.quota.limit === null) return { scope: 'tenant', items: [], note: t('Sem limite diário de tokens configurado nesta empresa.') };
    return { scope: 'tenant', items: [{ id: c.tenant?.id || 'tenant', tenantId: c.tenant?.id, title: c.tenant?.name || '', pct: remote.quota.pct, href: null,
      detail: remote.quota.limit === 0 ? t('Limite diário de 0 tokens: a IA está desligada nesta empresa.') : '' }] };
  }

  /** Every section in the order of §5.3.4: {id, title, available, loading, scope, count, items, note}. */
  function sections(c, snapshot) {
    const list = [];
    for (const [id, build] of [['approvals', approvals], ['handoffs', handoffs], ['parked', parked], ['waiting', waiting], ['proposals', proposals], ['channels', channels], ['quota', quota]]) {
      const data = build(c, snapshot);
      if (data === undefined) continue; // admin-only section for someone else
      const available = Boolean(data && !data.loading && !data.failed);
      const count = !available ? null : id === 'quota' ? data.items.filter(item => item.pct >= QUOTA_WARNING).length : Number.isFinite(data.total) ? data.total : data.items.length;
      list.push({ id, type: TYPES[id], title: TITLES[id], available, loading: Boolean(data?.loading), failed: Boolean(data?.failed), scope: data?.scope || null, count, items: available ? data.items : [], note: data?.note || '' });
    }
    return list;
  }

  // ---- markup -------------------------------------------------------------------------------------
  function itemMarkup(section, item, focused, drawer = false) {
    const elementId = `pending-${drawer ? 'drawer-' : ''}${section.type}-${item.id}`;
    const actions = [];
    if (section.id === 'quota') {
      return h`<li class="pg-pending__item" id="${elementId}"${attributes({ 'data-state': focused ? 'focused' : item.pct >= QUOTA_WARNING ? 'warning' : null })}><div class="pg-pending__text"><strong>${item.title}</strong><span class="pg-pending__meta">${t('{pct}% da cota de hoje', { pct: item.pct })}</span>${item.detail ? h`<span class="pg-pending__meta">${item.detail}</span>` : ''}${progress({ value: Math.min(100, item.pct), max: 100, label: t('Cota de IA de {company}', { company: item.title }), valueText: t('{pct}% usados', { pct: item.pct }) })}</div></li>`;
    }
    if (item.href) actions.push(h`<a class="ui-btn ui-btn--secondary ui-btn--sm" href="${item.href}"><span class="ui-btn__label">${section.id === 'channels' ? item.hrefLabel : section.id === 'proposals' ? t('Revisar') : t('Abrir conversa')}</span></a>`);
    if (item.take && !drawer) actions.push(button({ label: t('Assumir'), action: 'pending:take', size: 'sm', variant: 'primary', busy: busy.has(item.take.conversationId), attrs: { 'data-id': item.take.conversationId, 'data-version': String(item.take.version), 'data-tenant': item.tenantId } }));
    return h`<li class="pg-pending__item" id="${elementId}"${attributes({ 'data-state': focused ? 'focused' : item.urgent ? 'urgent' : null, tabindex: focused ? '-1' : null })}>${section.id === 'approvals' || section.id === 'handoffs' ? avatarMark() : ''}<div class="pg-pending__text"><strong${attributes({ 'data-pii': ['parked', 'waiting'].includes(section.id) })}>${item.title}</strong>${item.meta ? h`<span class="pg-pending__meta">${item.meta}</span>` : ''}</div>${actions.length ? h`<div class="pg-pending__actions">${actions}</div>` : ''}</li>`;
  }
  const avatarMark = () => h`<span class="pg-pending__agent" aria-hidden="true">✦</span>`;
  function sectionMarkup(section, focus, { level = 2 } = {}) {
    const scopeNote = section.scope === 'tenant' ? t('nesta empresa') : section.scope === 'all' ? t('todas as empresas') : '';
    const body = section.loading ? (level === 3 ? h`<p class="pg-pending__empty">${t('Abra Pendências para ver.')}</p>` : h`<p class="pg-pending__empty" role="status">${t('Carregando…')}</p>`)
      : section.failed ? h`<p class="pg-pending__empty">${t('Não foi possível carregar agora.')} ${level === 3 ? '' : button({ label: t('Tentar de novo'), action: 'pending:refresh', size: 'sm', variant: 'link' })}</p>`
        : !section.available ? h`<p class="pg-pending__empty">${t('Indisponível nesta versão')}${section.id === 'handoffs' ? h` · ${t('os pedidos aparecem em cada conversa, em Pedidos dos agentes.')}` : ''}</p>`
          : section.items.length ? h`<ul class="pg-pending__items">${section.items.map(item => itemMarkup(section, item, focus?.type === section.type && focus.id === item.id, level === 3))}</ul>`
            : h`<p class="pg-pending__empty">${section.note || t('Nada pendente.')}</p>`;
    const note = section.id === 'handoffs' ? h`<p class="pg-pending__note">${t('Marcar como visto não transfere a conversa. Para atender, use Assumir na conversa.')}</p>`
      : section.id === 'approvals' ? h`<p class="pg-pending__note">${t('A aprovação acontece na conversa. Aqui você só chega até ela.')}</p>` : '';
    const tag = raw(level === 3 ? 'h3' : 'h2'), titleId = `pending-title-${level === 3 ? 'drawer-' : ''}${section.id}`;
    return h`<section class="pg-pending__section" aria-labelledby="${titleId}" data-section="${section.id}"><${tag} class="pg-pending__title" id="${titleId}">${section.title}${section.count === null ? '' : h` <span class="pg-pending__count">(${section.count})</span>`}${scopeNote ? h` <small class="pg-pending__scope">${scopeNote}</small>` : ''}</${tag}>${note}${body}</section>`;
  }
  function unreadLine(c, snapshot) {
    const total = Number.isFinite(snapshot?.unreadForMe?.total) ? snapshot.unreadForMe.total : remote.scope === scopeOf(c) && Number.isFinite(remote.unread) ? remote.unread : null;
    if (total === null) return '';
    return h`<p class="pg-pending__unread">${total === 1 ? t('1 conversa não lida para você.') : t('{n} conversas não lidas para você.', { n: total })} <a href="#inbox">${t('Abrir Atendimento')}</a></p>`;
  }
  function legacyView() {
    return String(h`${raw(pageHeading(t('PENDÊNCIAS'), t('Pendências'), t('O que espera por você ou pela equipe nas empresas autorizadas.')))}${emptyState({
      icon: 'bell', title: t('A lista de pendências ainda não está disponível nesta versão.'),
      body: t('Por enquanto, as conversas na fila e as não lidas ficam na prioridade de atendimento da Visão geral.'),
      action: { label: t('Abrir a prioridade de atendimento'), action: 'shell:pending' }
    })}`);
  }

  /** The page for #pending[/<type>/<id>]. */
  function view(route) {
    if (!wired) return legacyView();
    const c = ctx(), snapshot = snapshotOf(), list = sections(c, snapshot);
    const focus = route?.section === 'pending' && PENDING_TYPES.includes(route.params?.type) && ID.test(route.params?.id || '') ? { type: route.params.type, id: route.params.id } : null;
    const crossCompany = list.some(section => section.scope === 'all');
    const scope = crossCompany ? t('Todas as empresas autorizadas') : c.tenant ? c.tenant.name : t('Nenhuma empresa aberta');
    const updated = remote.scope === scopeOf(c) && remote.loadedAt ? t('Atualizado às {time}', { time: new Date(remote.loadedAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) }) : '';
    return String(h`<section class="pg-pending" data-pending-root><header class="pg-pending__head"><div><h1>Pendências</h1><p>O que espera por você ou pela equipe. A decisão acontece na conversa ou na tela de cada item.</p></div>
      <div class="pg-pending__status"><span class="pg-pending__scope-chip">${glyph('building')} ${t('Escopo: {scope}', { scope })}</span>${updated ? h`<small>${updated}</small>` : ''}${button({ label: t('Atualizar'), action: 'pending:refresh', icon: 'refresh', size: 'sm', busy: remote.loading })}</div></header>
      ${crossCompany || !c.tenant ? '' : h`<p class="pg-pending__partial">${t('Sem a fonte consolidada, as seções marcadas "nesta empresa" cobrem só a empresa aberta.')}</p>`}
      ${unreadLine(c, snapshot)}<div class="pg-pending__sections">${list.map(section => sectionMarkup(section, focus))}</div></section>`);
  }

  /**
   * Sections of the Pendências drawer (P2, attention.js) for an attention snapshot, in the order of §5.3.4.
   * Each one is SafeHTML (the drawer interpolates it in h``) that also carries its data: id, type, title,
   * available, loading, failed, scope ('all' | 'tenant' | null), count and items. Without the panel context
   * there is nothing to show and the list is empty, so the drawer keeps its own fallback sections.
   */
  function drawerSections(snapshot) {
    if (!wired) return [];
    const c = ctx();
    void loadRemote(c);
    return sections(c, snapshotOf(snapshot)).map(section => Object.assign(new SafeHTML(String(sectionMarkup(section, null, { level: 3 }))), section, { items: section.items.map(item => ({ ...item })) }));
  }

  // ---- data ---------------------------------------------------------------------------------------
  async function loadRemote(c, { force = false } = {}) {
    if (typeof request !== 'function') return;
    const scope = scopeOf(c);
    if (!force && remote.scope === scope && (remote.loading || now() - remote.loadedAt < REFRESH_AFTER_MS)) return;
    const ticket = ++sequence;
    remote = { ...(remote.scope === scope ? remote : { unread: undefined, proposals: undefined, quota: undefined }), scope, loading: true, loadedAt: remote.scope === scope ? remote.loadedAt : 0 };
    paint();
    const tenant = c.tenant?.id ? `/api/tenants/${encodeURIComponent(c.tenant.id)}` : '';
    const settle = async promise => { try { return await promise; } catch { return null; } };
    const [unread, proposalList, usage] = await Promise.all([
      settle(request('/api/inbox?unread=1&limit=1', options(c))),
      isAdmin(c) && tenant ? settle(request(`${tenant}/agent-admin-proposals`, options(c))) : null,
      isAdmin(c) && tenant ? settle(request(`${tenant}/agents/usage?days=1`, options(c))) : null
    ]);
    if (ticket !== sequence || scopeOf(ctx()) !== scope) return;
    const tabs = unread?.countTabs;
    remote = { scope, loading: false, loadedAt: now(),
      unread: Number.isFinite(tabs?.mine) && Number.isFinite(tabs?.queue) ? tabs.mine + tabs.queue : null,
      proposals: Array.isArray(proposalList?.proposals) ? pendingProposalItems(proposalList.proposals) : isAdmin(c) && tenant ? null : undefined,
      quota: usage && typeof usage === 'object' ? quotaOf(usage) : isAdmin(c) && tenant ? null : undefined };
    paint();
  }
  /** Usage of today against the daily limit, as the server computes it: limit 0 (AI off) is 100%. */
  function quotaOf(usage) {
    if (usage.limit === null) return { limit: null, pct: 0 };
    if (!Number.isSafeInteger(usage.limit) || usage.limit < 0) return null;
    const used = Math.max(0, Number(usage.today?.totalTokens) || 0);
    return { limit: usage.limit, pct: usage.limit === 0 ? 100 : Math.min(999, Math.floor(used * 100 / usage.limit)) };
  }
  /** Re-renders only the page (never the whole app) and puts the focus back on the same control. */
  function paint() {
    const root = mounted?.main?.querySelector?.('[data-pending-root]');
    if (!root?.isConnected || !root.ownerDocument?.createElement) return false;
    const active = root.ownerDocument.activeElement, action = active && root.contains?.(active) ? active.closest?.('[data-action]') : null;
    const selector = action ? `[data-action="${action.dataset.action}"]${action.dataset.id ? `[data-id="${action.dataset.id}"]` : ''}` : '';
    const template = root.ownerDocument.createElement('template');
    template.innerHTML = view(mounted.route);
    const fresh = template.content.firstElementChild;
    if (!fresh) return false;
    root.replaceWith(fresh);
    if (selector) fresh.querySelector?.(selector)?.focus?.({ preventScroll: true });
    return true;
  }

  /** After each render of #pending: loads the remote sources once a minute and focuses #pending/<type>/<id>. */
  function mount(main, route) {
    if (!wired) return;
    mounted = { main, route };
    void loadRemote(ctx());
    const type = route?.params?.type, id = route?.params?.id;
    if (PENDING_TYPES.includes(type) && ID.test(id || '')) main?.querySelector?.(`[id="pending-${type}-${id}"]`)?.focus?.({ preventScroll: false });
  }

  async function act(name, id, element) {
    if (!wired || typeof name !== 'string' || !name.startsWith('pending:')) return false;
    const verb = name.slice('pending:'.length), c = ctx();
    if (verb === 'refresh') { await loadRemote(c, { force: true }); return true; }
    if (verb === 'take') {
      const conversationId = element?.dataset?.id || id, version = Number(element?.dataset?.version), tenantId = element?.dataset?.tenant;
      const item = c.tenant?.id === tenantId ? c.tenant.conversations.find(entry => entry.id === conversationId) : null;
      if (!item || !['agent', 'queue'].includes(item.owner) || !Number.isSafeInteger(version) || !can(c, 'inbox.reply') || item.assignedUserId && item.assignedUserId !== c.userId || typeof request !== 'function') { say(t('Abra a conversa para assumir.'), true); return true; }
      if (busy.has(conversationId)) return true;
      busy.add(conversationId); paint();
      try {
        await request(`/api/tenants/${encodeURIComponent(tenantId)}/conversations/${encodeURIComponent(conversationId)}/owner`, { ...options(c), method: 'POST', body: JSON.stringify({ owner: 'human', version }) });
        say(t('Você assumiu a conversa.'));
        go(conversationHash(tenantId, conversationId));
      } catch (failure) {
        say(failure?.status === 409 ? t('A conversa mudou. Abra para conferir antes de assumir.') : translateError(failure?.message) || t('Não foi possível assumir agora.'), true);
      } finally { busy.delete(conversationId); paint(); }
      return true;
    }
    return false;
  }

  function reset() { sequence++; remote = { scope: '', loadedAt: 0, loading: false, unread: undefined, proposals: undefined, quota: undefined }; mounted = null; busy = new Set(); }

  return { view, drawerSections, mount, act, submit: async () => false, reset };
}
