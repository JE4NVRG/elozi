// Attention of the person: "não lidas para mim" and the Pendências sources (FRONTEND-V2 §5.3.4,
// §7.1, §7.4, §8.3 P2), plus the Pendências drawer of the bell.
//
// Sources, from the richest to the MVP:
// - feature "attention" (GET /api/bootstrap lists it): GET /api/me/attention, the snapshot of §7.4;
// - otherwise the pulse GET /api/inbox?status=active&unread=1&limit=1 → countTabs.mine + countTabs.queue
//   ("não lidas para mim", every authorized company), and what the context of app.js already holds
//   for the open company when it passes it (runs → approvals, channels → channels with problems,
//   admin + tenantId → pending configuration proposals, read at most once a minute).
// A section without a source stays null and the drawer says "Indisponível nesta versão": never a false
// zero. live.js runs refresh() in the leader tab and hands the snapshot to the others (receive()).
// The pulse is the only request of most screens: its outcome feeds the connection indicator and the
// backoff of live.js (reportLive), like the requests of data-source.js.
//
// The drawer sections come from pending-ui.js (P6, drawerSections(snapshot)); while it returns none,
// the drawer renders the snapshot itself, section by section, with the same honesty rules.
import { h, t } from './i18n.js';
import './locales-live.js';
import { glyph } from './icons.js';
import { badge, progress } from './ui.js';
import { registerAction } from './actions.js';
import { conversationHash, hashForView } from './nav-config.js';
import { countsAsFailure, liveDrawer, liveFeatures, liveFeaturesKnown, liveRegistry, provideLiveContext, reportLive, setLiveFeatures } from './live.js';

/** Snapshot with no source: the shape of §7.4 (GET /api/me/attention) with every section null. */
export const EMPTY_ATTENTION = Object.freeze({
  revision: null, generatedAt: null, unreadForMe: null, approvals: null, handoffs: null,
  parked: null, waiting: null, proposals: null, channelsDown: null, aiQuota: null
});
export const PULSE_PATH = '/api/inbox?status=active&unread=1&limit=1';
const PROPOSALS_EVERY = 60000, FEATURES_RETRY = 600000;

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
const byTenant = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([key, n]) => key && count(n) !== null).slice(0, 500)) : null;
const totalOf = value => { const total = count(value?.total); return total === null ? null : { total, byTenant: byTenant(value.byTenant) }; };
const listOf = (value, item) => Array.isArray(value) ? value.slice(0, 50).map(item).filter(Boolean) : null;

/** "não lidas para mim" from the pulse page: unread conversations with me plus the queue I may take. */
export function unreadFromPulse(page, workspaceId) {
  if (!page || typeof page !== 'object' || workspaceId && page.workspaceId && page.workspaceId !== workspaceId) return null;
  const mine = count(page.countTabs?.mine), queue = count(page.countTabs?.queue);
  return mine === null || queue === null ? null : { total: mine + queue, byTenant: null };
}

/** Normalizes GET /api/me/attention (§7.4); fields the server omits stay null (unavailable or not for this role). */
export function normalizeAttention(dto, workspaceId) {
  if (!dto || typeof dto !== 'object' || workspaceId && dto.workspaceId && dto.workspaceId !== workspaceId) return null;
  return {
    ...EMPTY_ATTENTION, source: 'attention', workspaceId: workspaceId || text(dto.workspaceId) || null,
    revision: text(dto.revision, 80) || null, generatedAt: text(dto.generatedAt, 40) || null,
    unreadForMe: totalOf(dto.unreadForMe),
    approvals: listOf(dto.approvals, item => item?.tenantId && item?.conversationId ? { tenantId: text(item.tenantId, 120), conversationId: text(item.conversationId, 120), runId: text(item.runId, 120), agentName: text(item.agentName, 80), toolTitle: text(item.toolTitle, 120), external: item.external === true, expiresAt: text(item.expiresAt, 40) || null } : null),
    handoffs: totalOf(dto.handoffs),
    parked: listOf(dto.parked, item => item?.tenantId && item?.conversationId ? { tenantId: text(item.tenantId, 120), conversationId: text(item.conversationId, 120), since: text(item.since, 40) || null } : null),
    // Older servers omit it: the section stays unavailable, never a false zero.
    waiting: listOf(dto.waiting, item => item?.tenantId && item?.conversationId ? { tenantId: text(item.tenantId, 120), conversationId: text(item.conversationId, 120), since: text(item.since, 40) || null,
      agent: item.agent && typeof item.agent === 'object' ? { name: text(item.agent.name, 80), lastSeenAt: text(item.agent.lastSeenAt, 40) || null } : null } : null),
    waitingTotal: count(dto.waitingTotal),
    proposals: totalOf(dto.proposals),
    channelsDown: listOf(dto.channelsDown, item => item?.tenantId && item?.channelId ? { tenantId: text(item.tenantId, 120), channelId: text(item.channelId, 120), state: text(item.state, 40), name: text(item.name, 80) } : null),
    aiQuota: listOf(dto.aiQuota, item => item?.tenantId && Number.isFinite(item.usedPct) ? { tenantId: text(item.tenantId, 120), usedPct: Math.max(0, Math.min(100, Math.round(item.usedPct))), name: text(item.name, 80) } : null)
  };
}

/**
 * Health line of the connected agent that may take a queue conversation: its last authenticated call. An agent that polls
 * the queue (no webhook) answers only on its next round; without a recent call the queue waits for a person.
 */
export function waitingAgent(agent, now = Date.now()) {
  if (!agent?.name) return '';
  const seen = Date.parse(agent.lastSeenAt);
  if (!Number.isFinite(seen)) return t('{agent}: nenhuma chamada registrada', { agent: agent.name });
  const minutes = Math.max(0, Math.round((now - seen) / 60000));
  return minutes < 1 ? t('{agent}: ativo agora', { agent: agent.name }) : t('{agent}: última chamada há {n} min', { agent: agent.name, n: minutes });
}

/** Bell count: the sum of the sections that have a source (null when none has). Unread conversations are not pending items. */
export function pendingTotal(snapshot) {
  const parts = [snapshot?.approvals?.length, snapshot?.handoffs?.total, snapshot?.parked?.length, snapshot?.waiting ? snapshot.waitingTotal ?? snapshot.waiting.length : null, snapshot?.proposals?.total, snapshot?.channelsDown?.length];
  const known = parts.filter(value => Number.isSafeInteger(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** Sections of the drawer, in the order of §5.3.4; admin marks the ones only the workspace admin sees. */
export const PENDING_SECTIONS = Object.freeze([
  { key: 'approvals', title: 'Aprovações dos agentes' },
  { key: 'handoffs', title: 'Pedidos de apoio de agentes' },
  { key: 'parked', title: 'Conversas paradas com agente' },
  { key: 'waiting', title: 'Na fila sem dono' },
  { key: 'proposals', title: 'Propostas de configuração', admin: true },
  { key: 'channelsDown', title: 'Canais com problema' },
  { key: 'aiQuota', title: 'Cota de IA', admin: true }
]);

// What the context of app.js may hold for the open company (the drawer works without it).
function approvalsFromRuns(context) {
  if (!Array.isArray(context.runs) || !context.tenantId) return null;
  return context.runs.filter(run => run?.state === 'waiting_approval' && run.conversationId).slice(0, 50).map(run => ({
    tenantId: text(context.tenantId, 120), conversationId: text(run.conversationId, 120), runId: text(run.id, 120), agentName: text(run.agentName, 80),
    toolTitle: text(run.pendingTool?.title || run.approval?.toolTitle || run.toolTitle, 120), external: run.pendingTool?.external === true, expiresAt: text(run.approvalExpiresAt || run.expiresAt, 40) || null
  }));
}
function channelsFromContext(context) {
  if (!Array.isArray(context.channels) || !context.tenantId) return null;
  return context.channels.filter(channel => channel?.id && channel.transport && channel.state && channel.state !== 'connected').slice(0, 50)
    .map(channel => ({ tenantId: text(context.tenantId, 120), channelId: text(channel.id, 120), state: text(channel.state, 40), name: text(channel.name, 80) }));
}

/**
 * createAttention({request, context, pending}) → {refresh, snapshot, subscribe, receive, stale,
 * context, unreadForMe, pendingCount, openDrawer, closeDrawer, drawerMarkup}.
 * context() is the getter of app.js ({workspaceId, userId, supportGrantId, view}; tenantId, tenantName,
 * admin, runs, channels and features are used when present). pending is pending-ui.js (P6).
 */
export function createAttention({ request, context, pending, registry = liveRegistry, now = () => Date.now(), document: doc = globalThis.document } = {}) {
  let current = EMPTY_ATTENTION, scope = '', probing = null, proposals = { key: '', at: 0, value: null };
  const listeners = new Set(), probed = new Map();
  const read = () => { try { const value = typeof context === 'function' ? context() : null; return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  const scopeOf = c => c.workspaceId && c.userId ? JSON.stringify([c.userId, c.workspaceId, c.supportGrantId || null]) : '';
  const headers = c => ({ headers: { 'X-Elozi-Workspace': c.workspaceId } });
  // A request of the pulse reports to live.js: success, or a failure that says something about the connection.
  const tracked = (path, c) => Promise.resolve().then(() => request(path, headers(c))).then(value => { reportLive('success', registry, now()); return value; }, error => {
    if (countsAsFailure(error)) reportLive('failure', registry, now());
    throw error;
  });
  if (typeof context === 'function') provideLiveContext(read, registry);

  function set(next) {
    if (next === current) return;
    current = next;
    for (const listener of listeners) try { listener(current); } catch {}
    drawerRefresh();
  }

  async function ensureFeatures(c) {
    if (Array.isArray(c.features) || liveFeaturesKnown(registry)) return;
    const last = probed.get(c.workspaceId);
    if (probing || last && now() - last < FEATURES_RETRY) return;
    probed.set(c.workspaceId, now());
    probing = Promise.resolve().then(() => request('/api/bootstrap', headers(c))).then(boot => {
      if (scopeOf(read()) === scopeOf(c)) setLiveFeatures(c.workspaceId, Array.isArray(boot?.features) ? boot.features : [], registry);
    }, () => {}).finally(() => { probing = null; });
    await probing;
  }

  async function readProposals(c) {
    if (c.admin !== true || !c.tenantId) return null;
    const key = JSON.stringify([scopeOf(c), c.tenantId]);
    if (proposals.key === key && now() - proposals.at < PROPOSALS_EVERY) return proposals.value;
    proposals = { key, at: now(), value: proposals.key === key ? proposals.value : null };
    try {
      const result = await request(`/api/tenants/${encodeURIComponent(c.tenantId)}/agent-admin-proposals`, headers(c));
      const list = Array.isArray(result?.proposals) ? result.proposals.filter(item => item?.state === 'pending' && item.canApprove !== false) : null;
      proposals.value = list ? { total: list.length, byTenant: { [c.tenantId]: list.length } } : null;
    } catch { proposals.value = null; }
    return proposals.value;
  }

  /** Fetches a fresh snapshot (nothing without a request function or before the boot) and resolves it. */
  async function refresh() {
    const c = read(), key = scopeOf(c);
    if (typeof request !== 'function' || !key) return current;
    if (key !== scope) { scope = key; set(EMPTY_ATTENTION); }
    await ensureFeatures(c);
    if (scopeOf(read()) !== key) return current;
    if (liveFeatures(registry).has('attention')) {
      // since=<revision> lets the server answer {unchanged:true} when nothing moved.
      const since = current.source === 'attention' && current.revision ? `?since=${encodeURIComponent(current.revision)}` : '';
      const dto = await tracked(`/api/me/attention${since}`, c);
      if (scopeOf(read()) !== key) return current;
      if (dto?.unchanged === true && since) return current;
      const next = normalizeAttention(dto, c.workspaceId);
      if (next) set(next);
      return current;
    }
    const [page, proposalsValue] = await Promise.all([tracked(PULSE_PATH, c), readProposals(c)]);
    if (scopeOf(read()) !== key) return current;
    set({ ...EMPTY_ATTENTION, source: 'pulse', workspaceId: c.workspaceId, revision: `p_${now().toString(36)}`, generatedAt: new Date(now()).toISOString(),
      unreadForMe: unreadFromPulse(page, c.workspaceId), approvals: approvalsFromRuns(c), proposals: proposalsValue, channelsDown: channelsFromContext(c), tenantId: c.tenantId || null });
    return current;
  }

  /** Snapshot broadcast by the leader tab (live.js); a snapshot of another workspace is ignored. */
  function receive(snapshot) {
    const c = read();
    if (!snapshot || typeof snapshot !== 'object' || !scopeOf(c) || snapshot.workspaceId && snapshot.workspaceId !== c.workspaceId) return false;
    scope = scopeOf(c);
    set(Object.freeze({ ...EMPTY_ATTENTION, ...snapshot }));
    return true;
  }

  // ---- Pendências drawer (bell of the shell, §2.3 and §5.3.4) ----
  const drawer = () => doc ? liveDrawer('pending', { doc }) : null;
  const companyName = (snapshot, tenantId) => tenantId && tenantId === read().tenantId ? read().tenantName || '' : '';
  function itemMarkup(key, item, snapshot) {
    const company = companyName(snapshot, item.tenantId);
    if (key === 'approvals') return h`<li class="lv-pending__item"><span class="lv-pending__glyph" aria-hidden="true">✦</span><span class="lv-pending__copy"><strong>${item.agentName || t('Agente')}</strong> ${item.toolTitle ? t('quer usar {tool}', { tool: item.toolTitle }) : t('aguarda uma aprovação')}${company ? h`<small>${company}</small>` : ''}</span><a class="ui-btn ui-btn--secondary ui-btn--sm" href="${conversationHash(item)}" data-live-drawer-dismiss data-focus-key="${`approval:${item.tenantId}:${item.conversationId}:${item.runId}`}"><span class="ui-btn__label">${t('Abrir conversa')}</span></a></li>`;
    if (key === 'parked') return h`<li class="lv-pending__item"><span class="lv-pending__copy"><strong>${company || t('Conversa com agente')}</strong><small>${t('Sem resposta da equipe')}</small></span><a class="ui-btn ui-btn--secondary ui-btn--sm" href="${conversationHash(item)}" data-live-drawer-dismiss data-focus-key="${`parked:${item.tenantId}:${item.conversationId}`}"><span class="ui-btn__label">${t('Abrir')}</span></a></li>`;
    if (key === 'waiting') return h`<li class="lv-pending__item"><span class="lv-pending__copy"><strong>${company || t('Conversa na fila')}</strong><small>${[waited(item.since), waitingAgent(item.agent, now())].filter(Boolean).join(' · ')}</small></span><a class="ui-btn ui-btn--secondary ui-btn--sm" href="${conversationHash(item)}" data-live-drawer-dismiss data-focus-key="${`waiting:${item.tenantId}:${item.conversationId}`}"><span class="ui-btn__label">${t('Abrir')}</span></a></li>`;
    if (key === 'channelsDown') return h`<li class="lv-pending__item"><span class="lv-pending__copy"><strong>${item.name || t('Canal')}</strong><small>${[company, item.state === 'logged_out' ? t('sessão encerrada') : item.state === 'reconnecting' ? t('reconectando') : t('desconectado')].filter(Boolean).join(' · ')}</small></span><a class="ui-btn ui-btn--secondary ui-btn--sm" href="${hashForView('channels')}" data-live-drawer-dismiss data-focus-key="${`channel:${item.tenantId}:${item.channelId}`}"><span class="ui-btn__label">${t('Ver canais')}</span></a></li>`;
    if (key === 'aiQuota') return h`<li class="lv-pending__item lv-pending__item--quota"><span class="lv-pending__copy"><strong>${company || t('Empresa')}</strong><small>${t('{pct}% da cota diária', { pct: item.usedPct })}</small>${progress({ value: item.usedPct, max: 100, label: t('Uso da cota diária de IA') })}</span></li>`;
    return '';
  }
  const waited = value => { const time = Date.parse(value); if (!Number.isFinite(time)) return ''; const minutes = Math.max(0, Math.round((now() - time) / 60000)); return minutes < 60 ? t('na fila há {n} min', { n: minutes }) : t('na fila há {n} h', { n: Math.round(minutes / 60) }); };
  function sectionMarkup(section, snapshot, c) {
    const value = snapshot[section.key];
    if (section.admin && c.admin !== true && !(snapshot.source === 'attention' && value)) return '';
    const heading = id => h`<h3 class="lv-pending__heading" id="${id}">${t(section.title)}${Number.isSafeInteger(value?.length ?? value?.total) ? h` <span class="lv-pending__count">(${value?.length ?? value?.total})</span>` : ''}</h3>`;
    const id = `lv-pending-${section.key}`;
    if (value === null || value === undefined) return h`<section class="lv-pending__section" aria-labelledby="${id}">${heading(id)}<p class="lv-pending__unavailable">${t('Indisponível nesta versão')}</p></section>`;
    if (Array.isArray(value)) return h`<section class="lv-pending__section" aria-labelledby="${id}">${heading(id)}${value.length ? h`<ul class="lv-pending__list">${value.map(item => itemMarkup(section.key, item, snapshot))}</ul>` : h`<p class="lv-pending__empty">${t('Nada pendente agora.')}</p>`}</section>`;
    const link = section.key === 'proposals' ? hashForView('agents') : hashForView('inbox');
    return h`<section class="lv-pending__section" aria-labelledby="${id}">${heading(id)}${value.total ? h`<p class="lv-pending__line"><a class="ui-btn ui-btn--link ui-btn--sm" href="${link}" data-live-drawer-dismiss data-focus-key="${`section:${section.key}`}"><span class="ui-btn__label">${section.key === 'proposals' ? t('Revisar propostas') : t('Abrir Atendimento')}</span></a></p>` : h`<p class="lv-pending__empty">${t('Nada pendente agora.')}</p>`}</section>`;
  }
  /** Body of the drawer for a snapshot: P6's drawerSections when it returns some, else the honest sections of P2. */
  function drawerMarkup(snapshot = current) {
    const c = read();
    let sections = [];
    try { sections = typeof pending?.drawerSections === 'function' ? pending.drawerSections(snapshot) || [] : []; } catch { sections = []; }
    const unread = snapshot.unreadForMe;
    const top = h`<section class="lv-pending__section lv-pending__section--unread" aria-labelledby="lv-pending-unread"><h3 class="lv-pending__heading" id="lv-pending-unread">${t('Não lidas para você')}${unread ? h` <span class="lv-pending__count">(${unread.total})</span>` : ''}</h3>${unread ? h`<p class="lv-pending__line"><span>${unread.total ? t('Conversas com você ou na fila que você pode assumir, em todas as empresas autorizadas.') : t('Nenhuma conversa não lida com você ou na fila.')}</span>${unread.total ? h`<a class="ui-btn ui-btn--link ui-btn--sm" href="${hashForView('inbox')}" data-live-drawer-dismiss data-focus-key="unread"><span class="ui-btn__label">${t('Abrir Atendimento')}</span></a>` : ''}</p>` : h`<p class="lv-pending__unavailable">${snapshot === EMPTY_ATTENTION && scopeOf(c) ? t('Consultando…') : t('Indisponível nesta versão')}</p>`}</section>`;
    const body = Array.isArray(sections) && sections.length ? sections : PENDING_SECTIONS.map(section => sectionMarkup(section, snapshot, c));
    const scopeNote = snapshot.source === 'pulse' ? h`<p class="lv-pending__note">${t('Aprovações, canais e propostas mostram só a empresa aberta. Pedidos de apoio e conversas paradas chegam com a próxima versão do servidor.')}</p>` : '';
    return h`<div class="lv-pending" data-pending-drawer>${top}${body}${scopeNote}<p class="lv-pending__footer"><a class="ui-btn ui-btn--secondary ui-btn--sm" href="${hashForView('pending')}" data-live-drawer-dismiss data-focus-key="all"><span class="ui-btn__label">${t('Ver todas')}</span>${glyph('arrow', 'ui-btn__icon')}</a></p></div>`;
  }
  function drawerRefresh() { const panel = drawer(); if (panel?.isOpen) panel.update(drawerMarkup()); }
  function openDrawer(trigger) {
    const panel = drawer();
    if (!panel) return false;
    if (panel.isOpen) { panel.close(); return true; }
    const c = read(), scopeLabel = c.view === 'inbox' || !c.tenantName ? t('Todas as empresas autorizadas') : c.tenantName;
    panel.open({ title: t('Pendências'), actions: badge(scopeLabel, 'neutral'), body: drawerMarkup(), trigger });
    if (scopeOf(c) && (current === EMPTY_ATTENTION || stale())) void refresh().catch(() => {});
    return true;
  }
  function closeDrawer() { return drawer()?.close() || false; }

  /** True when the snapshot does not belong to the scope on screen (boot, workspace change). */
  function stale() { const key = scopeOf(read()); return Boolean(key) && key !== scope; }

  // P1 registers its shell:* defaults after this module is created: ours goes in afterwards (last wins)
  // and again from notify.apply() after the first render, in case the order ever changes.
  const bell = ({ element }) => { openDrawer(element); };
  function register() { registerAction('shell:pending', bell); return true; }
  if (doc) queueMicrotask(register);

  return {
    refresh, receive, stale, register,
    snapshot() { return current; },
    /** listener(snapshot) after each change; returns the function that unsubscribes it. */
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe needs a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    context: read,
    unreadForMe() { return current.unreadForMe?.total ?? null; },
    pendingCount() { return pendingTotal(current); },
    openDrawer, closeDrawer, drawerMarkup
  };
}
