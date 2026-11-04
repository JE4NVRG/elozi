import { createHash } from 'node:crypto';
import { fail } from '../../src/store.js';
import { conversationDepartmentId, departmentNames } from '../../src/events.js';

const publicKinds = new Set(['customer', 'human', 'agent']);
const normalized = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
const stamp = value => Date.parse(value) || 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Connection states that need a person (same set as the channel journey of the panel). */
const CHANNEL_PROBLEMS = new Set(['failed', 'error', 'wrong_number', 'logged_out']);
/** A live transport that should be connected (persisted as connected) but is not. */
const LIVE_EXPECTED = new Set(['connected', 'reconnecting', 'starting']);
const RUNNING = new Set(['queued', 'running', 'tool_running']);

function parameter(params, key, max = 120) {
  const values = params.getAll(key);
  if (values.length > 1) fail(400, 'Informe cada filtro uma única vez.');
  const value = values[0]?.trim() || '';
  if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'Informe filtros válidos para o atendimento.');
  return value === 'all' ? '' : value;
}

function option(params, key, values, fallback) {
  const value = parameter(params, key) || fallback;
  if (!values.includes(value)) fail(400, 'Escolha filtros válidos para o atendimento.');
  return value;
}

function integer(params, key, fallback, min, max) {
  if (!params.has(key)) return fallback;
  const value = parameter(params, key);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail(400, 'Informe uma página válida para o atendimento.');
  return Number(value);
}

function query(params) {
  const status = params.has('status') && params.get('status') === 'all' ? 'all' : option(params, 'status', ['active', 'open', 'pending', 'closed'], 'active');
  return {
    tenantId: parameter(params, 'tenantId'), channelId: parameter(params, 'channelId'), departmentId: parameter(params, 'departmentId'),
    assignedUserId: parameter(params, 'assignedUserId'), tag: parameter(params, 'tag', 40), q: normalized(parameter(params, 'q', 200)),
    status, owner: option(params, 'owner', ['', 'human', 'queue', 'agent'], ''), tab: option(params, 'tab', ['all', 'mine', 'queue', 'agent'], 'all'),
    unread: option(params, 'unread', ['', 'true', 'false', '1', '0'], ''), kind: option(params, 'kind', ['', 'direct', 'group'], ''),
    sort: option(params, 'sort', ['recent', 'oldest', 'unread'], 'recent'), offset: integer(params, 'offset', 0, 0, 100000), limit: integer(params, 'limit', 100, 1, 200)
  };
}

const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function preview(conversation) {
  // Reading, notes and delivery receipts change updatedAt, but only a public message moves the
  // conversation in the list. A delayed provider backlog may be appended after a newer message.
  let message = null, latest = null;
  for (const candidate of conversation.messages || []) {
    if (!publicKinds.has(candidate.kind)) continue;
    const time = dated(candidate.createdAt);
    if (!message || time !== null && (latest === null || Date.parse(time) >= Date.parse(latest)) || time === null && latest === null) {
      message = candidate; latest = time;
    }
  }
  if (!message) return null;
  const attachment = message.attachments?.[0];
  return {
    text: typeof message.text === 'string' ? message.text.slice(0, 280) : '', kind: message.kind, createdAt: latest,
    attachmentKind: typeof attachment?.kind === 'string' ? attachment.kind : null,
    attachmentName: typeof attachment?.name === 'string' ? attachment.name.slice(0, 160) : null
  };
}

function inTab(item, tab, userId) {
  if (tab === 'mine') return Boolean(userId) && item.owner === 'human' && item.assignedUserId === userId;
  if (tab === 'queue') return item.owner === 'queue';
  if (tab === 'agent') return item.owner === 'agent';
  return true;
}

/**
 * Agent state of each conversation for the list glyph, from the persisted runs only (no draft, tool or receipt data):
 * a pending approval first, then a preparation in progress, then the newest draft (stale when the conversation moved on).
 */
function agentStates(tenant, now) {
  const states = new Map(), runs = Array.isArray(tenant.runs) ? tenant.runs : [];
  if (!runs.length) return states;
  const versions = new Map((tenant.conversations || []).map(conversation => [conversation.id, conversation.version]));
  const rank = { waiting_approval: 4, running: 3, draft: 2, stale: 2 };
  for (const run of runs) {
    if (!run || typeof run.conversationId !== 'string') continue;
    let state = null;
    if (run.state === 'waiting_approval') state = Date.parse(run.toolProposal?.expiresAt) <= now ? null : 'waiting_approval';
    else if (RUNNING.has(run.state)) state = 'running';
    else if (run.state === 'draft' && run.draft) state = run.stale === true || run.conversationVersion !== versions.get(run.conversationId) ? 'stale' : 'draft';
    if (!state) continue;
    const previous = states.get(run.conversationId);
    // Among drafts the newest run wins (runs are kept in creation order).
    if (!previous || rank[state] > rank[previous] || rank[state] === rank[previous] && rank[state] === 2) states.set(run.conversationId, state);
  }
  return states;
}

/** Synchronous snapshot: authority is evaluated before content search, totals or paging. */
export function createConsolidatedInbox(store, { can, channelState, permissions, now = Date.now, deltaCacheSize = 256 } = {}) {
  if (typeof can !== 'function' || typeof channelState !== 'function' || permissions !== undefined && typeof permissions !== 'function') throw new TypeError('A caixa única precisa de autorização e estado de canal síncronos.');
  if (typeof now !== 'function' || !Number.isSafeInteger(deltaCacheSize) || deltaCacheSize < 0 || deltaCacheSize > 10000) throw new TypeError('Configuração da caixa única inválida.');
  // revision → row marks of a page served with delta=1, so the next request can carry only the rows that changed.
  const deltas = new Map();

  function synchronous(result) {
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new TypeError('A autorização da caixa única precisa ser síncrona.');
    }
    return result;
  }
  function allowed(actor, permission, context) { return synchronous(can(actor, permission, context)) === true; }
  // permissions(actor, permission, tenantId) returns a synchronous context checker built once for this listing, so
  // the person and the company are read once per company instead of once per conversation. Same decisions as can().
  function checker(actor, permission, tenantId) {
    if (!permissions) return context => allowed(actor, permission, context);
    const check = synchronous(permissions(actor, permission, tenantId));
    if (typeof check !== 'function') throw new TypeError('A autorização da caixa única precisa ser síncrona.');
    return context => synchronous(check(context)) === true;
  }

  /**
   * Fresh authorization snapshot of one person: the companies of the workspace in their access and, per company, the
   * inbox.read checker built once. It is the single predicate of the inbox list, the attention summary and the event
   * stream. Never keep it across requests or awaits: callers build a new one for each decision round.
   */
  function scope(actor) {
    const tenantIds = store.db.prepare('SELECT id FROM tenants WHERE reseller_id=? ORDER BY id').all(actor.resellerId)
      .filter(row => actor.role !== 'operator' || (actor.tenantIds || [actor.tenantId]).includes(row.id)).map(row => row.id);
    const visible = new Set(tenantIds), checkers = new Map();
    const readable = tenantId => {
      if (!visible.has(tenantId)) return null;
      if (!checkers.has(tenantId)) { const check = checker(actor, 'inbox.read', tenantId); checkers.set(tenantId, check({ tenantId, aggregate: true }) ? check : null); }
      return checkers.get(tenantId);
    };
    return {
      tenantIds,
      /** The company is in this person's inbox. */
      tenant: tenantId => Boolean(readable(tenantId)),
      /** The channel appears in this person's filters (aggregate read of the channel). */
      channel: (tenantId, channelId) => { const check = readable(tenantId); return Boolean(check) && check({ tenantId, channelId, aggregate: true }); },
      /** The department appears in this person's filters (aggregate read of the department). */
      department: (tenantId, departmentId) => { const check = readable(tenantId); return Boolean(check) && check({ tenantId, departmentId, aggregate: true }); },
      /** A conversation at this location ({channelId, departmentId: effective id or null}) is listed for this person. */
      conversation: (tenantId, location) => { const check = readable(tenantId); return Boolean(check) && check({ tenantId, channelId: location?.channelId, departmentId: location?.departmentId || 'unassigned' }); }
    };
  }

  function page(actor, filters) {
    const view = scope(actor), tenantIds = view.tenantIds;
    if (filters.tenantId && !tenantIds.includes(filters.tenantId)) fail(403, 'Esta empresa não está na sua caixa de atendimento.');
    const items = [], tenants = [], channels = [], departments = [], assignees = new Map(), at = now();
    for (const tenantId of tenantIds) {
      if (filters.tenantId && tenantId !== filters.tenantId) continue;
      if (!view.tenant(tenantId)) continue;
      const tenant = store.tenant(actor, tenantId);
      // The demo company stays a choice of the company filter; its fictitious rows appear only when it is the selected one.
      if (tenant.demo && filters.tenantId !== tenantId) { tenants.push({ id: tenantId, tenantId, name: tenant.name, demo: true }); continue; }
      let contactsReadable, states;
      const channelMap = new Map((tenant.channels || []).map(channel => [channel.id, channel]));
      const departmentMap = new Map((tenant.departments || []).map(department => [department.id, department])), names = departmentNames(tenant);
      tenants.push({ id: tenantId, tenantId, name: tenant.name, ...(tenant.demo ? { demo: true } : {}) });
      for (const channel of channelMap.values()) if (view.channel(tenantId, channel.id)) {
        channels.push({ tenantId, tenantName: tenant.name, id: channel.id, name: channel.name, kind: channel.kind, state: channelState(tenantId, channel), transport: channel.transport || null });
      }
      for (const department of departmentMap.values()) if (view.department(tenantId, department.id)) {
        departments.push({ tenantId, tenantName: tenant.name, id: department.id, name: department.name, active: department.active !== false });
      }
      for (const conversation of tenant.conversations || []) {
        const departmentId = conversationDepartmentId(conversation, names) || 'unassigned';
        if (!view.conversation(tenantId, { channelId: conversation.channelId, departmentId })) continue;
        const context = { tenantId, channelId: conversation.channelId, departmentId };
        const channel = channelMap.get(conversation.channelId);
        states ||= agentStates(tenant, at);
        const lastPublic = preview(conversation);
        const item = {
          tenantId, tenantName: tenant.name, id: conversation.id, conversationId: conversation.id,
          channelId: conversation.channelId, channelName: channel?.name || '', channelKind: channel?.kind || null,
          channelState: channel ? channelState(tenantId, channel) : 'disconnected', channelTransport: channel?.transport || null,
          contact: conversation.contact || '', contactId: conversation.contactId || null, initials: conversation.initials || '',
          conversationKind: conversation.conversationKind === 'group' ? 'group' : 'direct',
          owner: conversation.owner, assignedUserId: conversation.assignedUserId || null, assignedUserName: conversation.assignedUserName || null,
          responsible: conversation.assignedUserName || null, status: conversation.status, unread: Math.max(0, Number(conversation.unread) || 0),
          version: conversation.version, departmentId, department: departmentMap.get(departmentId)?.name || conversation.department || '',
          tags: Array.isArray(conversation.tags) ? conversation.tags.filter(tag => typeof tag === 'string') : [], agentId: conversation.agentId || null, ...(conversation.replyExempt === true ? { replyExempt: true } : {}),
          agentState: states.get(conversation.id) || null, updatedAt: conversation.updatedAt || null,
          lastMessageAt: lastPublic?.createdAt || dated(conversation.createdAt), preview: lastPublic
        };
        if (item.assignedUserId) assignees.set(JSON.stringify([tenantId, item.assignedUserId]), { tenantId, id: item.assignedUserId, name: item.assignedUserName || 'Atendente' });
        if (filters.channelId && item.channelId !== filters.channelId || filters.departmentId && item.departmentId !== filters.departmentId || filters.assignedUserId && item.assignedUserId !== filters.assignedUserId || filters.kind && item.conversationKind !== filters.kind || filters.tag && !item.tags.some(tag => normalized(tag) === normalized(filters.tag))) continue;
        if (filters.q) {
          const contact = conversation.contactId && (contactsReadable ||= checker(actor, 'contacts.read', tenantId))(context) ? (tenant.contacts || []).find(contact => contact.id === conversation.contactId) : null;
          const searchable = [item.contact, item.tenantName, item.channelName, item.department, item.assignedUserName, ...item.tags,
            contact?.name, contact?.phone, contact?.email, ...(contact?.tags || []),
            ...(conversation.messages || []).filter(message => publicKinds.has(message.kind)).flatMap(message => [message.text, ...(message.attachments || []).map(attachment => attachment.name)])];
          if (!searchable.some(value => normalized(value).includes(filters.q))) continue;
        }
        items.push(item);
      }
    }
    const counts = { active: 0, open: 0, pending: 0, closed: 0, unread: 0 };
    for (const item of items) {
      if (Object.hasOwn(counts, item.status)) counts[item.status]++;
      if (item.status !== 'closed') counts.active++;
      if (item.unread) counts.unread++;
    }
    const base = items.filter(item => (filters.status === 'all' || filters.status === 'active' && item.status !== 'closed' || item.status === filters.status)
      && (!filters.unread || (['true', '1'].includes(filters.unread) ? item.unread > 0 : item.unread === 0)));
    const countTabs = Object.fromEntries(['all', 'mine', 'queue', 'agent'].map(tab => [tab, base.filter(item => inTab(item, tab, actor.userId)).length]));
    const selected = base.filter(item => inTab(item, filters.tab, actor.userId) && (!filters.owner || item.owner === filters.owner));
    selected.sort((a, b) => (filters.sort === 'unread' ? Number(Boolean(b.unread)) - Number(Boolean(a.unread)) : 0)
      || (filters.sort === 'oldest' ? stamp(a.lastMessageAt) - stamp(b.lastMessageAt) : stamp(b.lastMessageAt) - stamp(a.lastMessageAt))
      || a.tenantId.localeCompare(b.tenantId) || a.id.localeCompare(b.id));
    return { workspaceId: actor.resellerId, items: selected.slice(filters.offset, filters.offset + filters.limit), total: selected.length,
      offset: filters.offset, limit: filters.limit, hasMore: filters.offset + filters.limit < selected.length,
      counts, countTabs, tenants, channels, departments, assignees: [...assignees.values()] };
  }
  /**
   * GET /api/inbox. `revision` identifies this exact page for this person and these filters (FRONTEND-V2 §7.4): with
   * since=<revision> an identical page answers {unchanged:true, revision}; any other since (an older revision or an
   * event cursor) gets the full page. delta=1 additionally lets a page carry only the rows that changed since a
   * revision served to the same person and filters with delta=1 (`removed` and the full `order` complete it).
   * Authorization, filters and paging always run first: a revision never grants or skips access.
   */
  function list(actor, params = new URLSearchParams()) {
    const since = parameter(params, 'since'), delta = option(params, 'delta', ['', '1', '0'], '0') === '1';
    const filters = query(params), result = page(actor, filters);
    const owner = [actor.userId ?? null, actor.resellerId, actor.supportGrantId ?? null, actor.role ?? null];
    const { offset, limit, ...rest } = filters, key = digest([owner, rest, offset, limit]);
    const revision = 'r_' + digest([key, result]).slice(0, 32);
    if (since && since === revision) return { workspaceId: actor.resellerId, unchanged: true, revision };
    if (!delta || !deltaCacheSize) return { ...result, revision };
    const rowKey = item => [item.tenantId, item.id], mark = item => digest(item).slice(0, 24);
    const rows = new Map(result.items.map(item => [JSON.stringify(rowKey(item)), mark(item)]));
    const previous = since ? deltas.get(since) : null;
    deltas.delete(revision); deltas.set(revision, { key, rows });
    while (deltas.size > deltaCacheSize) deltas.delete(deltas.keys().next().value);
    if (!previous || previous.key !== key) return { ...result, revision, delta: false };
    const changed = result.items.filter(item => previous.rows.get(JSON.stringify(rowKey(item))) !== rows.get(JSON.stringify(rowKey(item))));
    const removed = [...previous.rows.keys()].filter(item => !rows.has(item)).map(item => JSON.parse(item));
    return { ...result, items: changed, revision, delta: true, removed, order: result.items.map(rowKey) };
  }

  /**
   * GET /api/me/attention: what asks for this person now, each section only from what they may see. Sections that do
   * not apply to the person (proposals and AI quota outside administration) are null, never a false zero.
   * hooks: { admin: boolean, canDecide(tenantId, conversation): boolean (the responsible person may approve),
   * handoffs(tenantId): Map<conversationId, pending count>, quota(tenantId, tenant): {used, limit}|null,
   * automatic(tenantId, tenant, conversation): true only while the autopilot can answer that conversation now
   * (default: never, so a conversation of an agent waits for a person), autopilotStallMs,
   * queueWaitMs/queueWaitMaxMs (a queue conversation whose customer spoke last counts as waiting from 5 min up to 24 h; older
   * ones are backlog, still in the queue lens and the overview, not an alert that would stay on the bell for days),
   * queueAgent(tenantId, tenant, conversation): {name, lastSeenAt}|null, the connected agent that may take that queue }.
   */
  function attention(actor, { admin = false, canDecide = () => false, handoffs = () => new Map(), quota = () => null, automatic = () => false, autopilotStallMs = 600000, queueWaitMs = 300000, queueWaitMaxMs = 86400000, queueAgent = () => null, since = '' } = {}) {
    if (typeof since !== 'string' || since.length > 120 || /[\x00-\x1f\x7f]/.test(since)) fail(400, 'Informe uma revisão válida das pendências.');
    const view = scope(actor), at = now();
    const unreadForMe = { total: 0, byTenant: {} }, handoffTotals = { total: 0, byTenant: {} }, approvals = [], parked = [], waiting = [], channelsDown = [];
    const proposals = admin ? { total: 0, byTenant: {} } : null, aiQuota = admin ? [] : null;
    const add = (bucket, tenantId, amount = 1) => { bucket.total += amount; bucket.byTenant[tenantId] = (bucket.byTenant[tenantId] || 0) + amount; };
    for (const tenantId of view.tenantIds) {
      if (!view.tenant(tenantId)) continue;
      const tenant = store.tenant(actor, tenantId), names = departmentNames(tenant), visible = new Map();
      if (tenant.demo) continue; // Fictitious conversations never ring the bell of the real operation.
      for (const conversation of tenant.conversations || []) {
        if (!view.conversation(tenantId, { channelId: conversation.channelId, departmentId: conversationDepartmentId(conversation, names) })) continue;
        visible.set(conversation.id, conversation);
        const open = conversation.status !== 'closed', unread = Math.max(0, Number(conversation.unread) || 0) > 0;
        // "Não lidas para mim": the lens counts of /api/inbox?unread=1 (mine + queue among active conversations).
        if (open && unread && (inTab(conversation, 'mine', actor.userId) || inTab(conversation, 'queue', actor.userId))) add(unreadForMe, tenantId);
        if (open && conversation.owner === 'agent') {
          const last = (conversation.messages || []).findLast(message => publicKinds.has(message.kind));
          if (last?.kind === 'customer') {
            const since = last.createdAt || conversation.updatedAt || null;
            // Without automatic replies (off, not configured, not runnable or commercially blocked) the conversation waits
            // for a person at once; with them only a stalled reply counts.
            if (automatic(tenantId, tenant, conversation) !== true || at - stamp(since) >= autopilotStallMs) parked.push({ tenantId, conversationId: conversation.id, since });
          }
        }
        // Nobody owns it and the customer spoke last: after queueWaitMs it waits for a person (or a connected agent that
        // polls the queue, whose last call says whether it is still alive).
        if (open && conversation.owner === 'queue') {
          const last = (conversation.messages || []).findLast(message => publicKinds.has(message.kind));
          const since = last?.kind === 'customer' ? last.createdAt || conversation.updatedAt || null : null;
          if (since && at - stamp(since) >= queueWaitMs && at - stamp(since) < queueWaitMaxMs) {
            const agent = queueAgent(tenantId, tenant, conversation);
            waiting.push({ tenantId, conversationId: conversation.id, since, ...(agent ? { agent } : {}) });
          }
        }
      }
      for (const run of tenant.runs || []) {
        if (run?.state !== 'waiting_approval' || !(Date.parse(run.toolProposal?.expiresAt) > at)) continue;
        const conversation = visible.get(run.conversationId);
        if (!conversation || conversation.owner !== 'human' || !actor.userId || conversation.assignedUserId !== actor.userId || !canDecide(tenantId, conversation)) continue;
        approvals.push({ tenantId, conversationId: conversation.id, runId: run.id, agentName: run.agentName || null, toolTitle: run.toolProposal.title || run.toolProposal.toolName || null,
          external: run.toolProposal.readOnly !== true, expiresAt: run.toolProposal.expiresAt });
      }
      for (const [conversationId, count] of handoffs(tenantId)) if (visible.has(conversationId) && count > 0) add(handoffTotals, tenantId, count);
      for (const channel of tenant.channels || []) {
        if (!view.channel(tenantId, channel.id) || !channel.transport) continue;
        const state = channelState(tenantId, channel);
        if (CHANNEL_PROBLEMS.has(state) || ['disconnected', 'reconnecting'].includes(state) && LIVE_EXPECTED.has(channel.state)) channelsDown.push({ tenantId, channelId: channel.id, state });
      }
      if (proposals) { const pending = (tenant.agentAdminProposals || []).filter(proposal => proposal?.state === 'pending').length; if (pending) add(proposals, tenantId, pending); }
      if (aiQuota) {
        const usage = quota(tenantId, tenant);
        if (usage && Number.isSafeInteger(usage.limit) && Number.isFinite(usage.used)) {
          const usedPct = usage.limit <= 0 ? 100 : Math.min(999, Math.floor(usage.used * 100 / usage.limit));
          if (usedPct >= 80) aiQuota.push({ tenantId, usedPct });
        }
      }
    }
    parked.sort((a, b) => stamp(a.since) - stamp(b.since) || a.tenantId.localeCompare(b.tenantId) || a.conversationId.localeCompare(b.conversationId));
    waiting.sort((a, b) => stamp(a.since) - stamp(b.since) || a.tenantId.localeCompare(b.tenantId) || a.conversationId.localeCompare(b.conversationId));
    approvals.sort((a, b) => stamp(a.expiresAt) - stamp(b.expiresAt) || a.runId.localeCompare(b.runId));
    const body = { unreadForMe, approvals, handoffs: handoffTotals, parked: parked.slice(0, 50), parkedTotal: parked.length, waiting: waiting.slice(0, 50), waitingTotal: waiting.length, proposals, channelsDown, aiQuota };
    const revision = 'a_' + digest([actor.userId ?? null, actor.resellerId, actor.supportGrantId ?? null, body]).slice(0, 32);
    if (since && since === revision) return { workspaceId: actor.resellerId, unchanged: true, revision };
    return { workspaceId: actor.resellerId, revision, generatedAt: new Date(at).toISOString(), ...body };
  }
  return { list, scope, attention };
}
