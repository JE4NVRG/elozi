import { createHmac, randomBytes } from 'node:crypto';

/**
 * In-process tenant change bus. Events are POINTERS: ids, owner/route metadata and versions only. Message text,
 * contact data, notes, drafts and credentials never enter the bus, so an event can be fanned out after a scope check
 * and the consumer re-reads the authoritative state through its own authorization.
 *
 * Cursors are opaque strings bound to this process (boot id) and to a monotonic sequence shared by every tenant. The
 * sequence leaves the bus through a keyed permutation (per boot), so ids and cursors reveal neither the order nor the
 * volume of other companies' changes; `order(id)` gives the position back inside the process.
 * A cursor from another boot, one that fell out of the tenant ring or a missing cursor answers `resync: true`:
 * the consumer must re-read the state it cares about and continue from the returned cursor.
 */

const error = (status, message) => Object.assign(new Error(message), { status });
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const shortText = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const TYPE = /^[a-z][a-z_]{0,40}(?:\.[a-z][a-z_]{0,40}){1,3}$/;
const CURSOR = /^([0-9a-f]{12})-([0-9a-z]{1,11})$/;
/** Route fields an `updated` event may carry in `previous`. */
const TRACKED = Object.freeze(['status', 'owner', 'agentId', 'assignedUserId', 'departmentId', 'channelId', 'version']);
// runId/state describe run.changed (run state) and channel.state (connection state); roomId describes teamchat.message;
// audience ('admin') limits an attention.changed pointer without a conversation to the company's administrators.
// entry ('poll_vote') marks a customer message that is a vote in a native WhatsApp poll (whatsapp-polls.js).
const STRING_FIELDS = Object.freeze(['tenantId', 'conversationId', 'channelId', 'departmentId', 'owner', 'agentId', 'assignedUserId', 'status', 'conversationKind', 'messageId', 'kind', 'entry', 'runId', 'state', 'roomId', 'audience']);
/** Sequence numbers per boot: the cursor permutation works on 48 bits (two halves of 24). */
const HALF = 2 ** 24, DOMAIN = HALF * HALF;
/** Keyed 4-round Feistel permutation of [0, 2^48) with HMAC-SHA256 rounds: a bijection, so order survives inside the bus. */
function permutation(key) {
  const round = (index, value) => createHmac('sha256', key).update(Buffer.from([index, value >>> 16 & 255, value >>> 8 & 255, value & 255])).digest().readUIntBE(0, 3);
  return Object.freeze({
    encrypt(value) {
      let left = Math.floor(value / HALF), right = value % HALF;
      for (let index = 0; index < 4; index++) [left, right] = [right, (left ^ round(index, right)) >>> 0];
      return left * HALF + right;
    },
    decrypt(value) {
      let left = Math.floor(value / HALF), right = value % HALF;
      for (let index = 3; index >= 0; index--) [left, right] = [(right ^ round(index, left)) >>> 0, left];
      return left * HALF + right;
    }
  });
}
const LOCATION = Object.freeze(['channelId', 'departmentId', 'owner', 'agentId', 'conversationKind']);

/** Keeps only pointer fields; anything else (text, contact, attachments, drafts) is dropped, never forwarded. */
function pointerPayload(input) {
  if (!plain(input) || !TYPE.test(input.type) || !shortText(input.tenantId)) throw error(400, 'Evento inválido: informe tipo e empresa.');
  const event = { type: input.type, tenantId: input.tenantId };
  for (const key of STRING_FIELDS) if (key !== 'tenantId' && Object.hasOwn(input, key)) {
    const value = input[key];
    if (value === null || shortText(value)) event[key] = value;
  }
  if (Number.isSafeInteger(input.version) && input.version >= 0) event.version = input.version;
  if (Array.isArray(input.changes)) event.changes = [...new Set(input.changes.filter(item => typeof item === 'string' && /^[a-zA-Z]{1,40}$/.test(item)))].slice(0, 16);
  if (input.truncated === true) event.truncated = true;
  if (input.left === true) event.left = true;
  if (plain(input.previous)) {
    const previous = {};
    for (const key of TRACKED) if (Object.hasOwn(input.previous, key)) {
      const value = input.previous[key];
      if (key === 'version' ? Number.isSafeInteger(value) && value >= 0 : value === null || shortText(value)) previous[key] = value;
    }
    if (Object.keys(previous).length) event.previous = previous;
  }
  return event;
}

/**
 * Department names of a company → id of the first department with that name. Conversations written before department ids
 * existed only carry `department` (a name); they resolve exactly like the consolidated inbox and the request context do,
 * so a pointer is authorized against the same department the inbox would show.
 */
export function departmentNames(tenant) {
  const names = new Map();
  for (const department of Array.isArray(tenant?.departments) ? tenant.departments : []) {
    if (department && typeof department.name === 'string' && !names.has(department.name)) names.set(department.name, department.id);
  }
  return names;
}
/** Effective department id of a conversation (null when it has none): the explicit id, else the legacy name. */
export function conversationDepartmentId(conversation, names) {
  if (shortText(conversation?.departmentId)) return conversation.departmentId;
  const legacy = typeof conversation?.department === 'string' ? names?.get(conversation.department) : undefined;
  return shortText(legacy) ? legacy : null;
}
const pointer = (tenantId, conversation, names) => ({
  tenantId, conversationId: conversation.id, channelId: shortText(conversation.channelId) ? conversation.channelId : null,
  departmentId: conversationDepartmentId(conversation, names),
  owner: shortText(conversation.owner) ? conversation.owner : 'queue', agentId: shortText(conversation.agentId) ? conversation.agentId : null,
  assignedUserId: shortText(conversation.assignedUserId) ? conversation.assignedUserId : null,
  status: shortText(conversation.status) ? conversation.status : 'open', version: Number.isSafeInteger(conversation.version) ? conversation.version : 1,
  conversationKind: conversation.conversationKind === 'group' ? 'group' : 'direct'
});
/**
 * attention.changed pointer of one conversation (support requests kept outside the tenant JSON): the route of the
 * conversation only, so the event stream delivers it exactly to the people who may see that conversation.
 */
export function attentionPointer(tenant, conversation) {
  const tenantId = typeof tenant?.id === 'string' ? tenant.id : null;
  if (!shortText(tenantId) || !conversation || !shortText(conversation.id)) throw new TypeError('Informe a empresa e a conversa do aviso de pendências.');
  return { type: 'attention.changed', ...pointer(tenantId, conversation, departmentNames(tenant)) };
}
const INDEX = Symbol.for('elozi.conversationIndex');
/** Message ids kept per conversation to re-anchor appended messages after the last known one was removed or merged. */
const TAIL = 8;

/**
 * Light snapshot of the conversations before a mutation: route fields plus message count and the ids of the last
 * TAIL messages per conversation. Store.mutate computes it inside the transaction before running `fn`
 * (O(conversations), no message copy).
 */
export function indexTenantConversations(state) {
  const tenantId = typeof state?.id === 'string' ? state.id : null, conversations = new Map(), names = departmentNames(state);
  for (const conversation of Array.isArray(state?.conversations) ? state.conversations : []) {
    if (!conversation || !shortText(conversation.id) || conversations.has(conversation.id)) continue;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    conversations.set(conversation.id, { ...pointer(tenantId, conversation, names), count: messages.length, lastId: messages.at(-1)?.id ?? null,
      tail: messages.slice(-TAIL).map(message => message?.id).filter(shortText) });
  }
  return { [INDEX]: true, tenantId, conversations };
}

/**
 * Pure diff of two tenant states (as store.mutate sees them) into pointer events, in a deterministic order:
 * `conversation.created` (+ one `conversation.message` per message of the new conversation), one `conversation.message`
 * per appended message ({ messageId, kind }), `conversation.updated` with `changes`/`previous` for status, owner,
 * agentId, assignedUserId, departmentId, channelId or version, and `conversation.removed`.
 * A version step caused only by appended messages is carried by the message events, not by a separate update.
 * `before` may be a full state or the result of indexTenantConversations(state).
 */
export function diffTenantConversations(before, after, { tenantId, messageLimit = 100 } = {}) {
  if (!Number.isSafeInteger(messageLimit) || messageLimit < 1 || messageLimit > 10000) throw new TypeError('Limite de mensagens por evento inválido.');
  const previous = before?.[INDEX] ? before : indexTenantConversations(before);
  const id = tenantId ?? (typeof after?.id === 'string' ? after.id : previous.tenantId);
  if (!shortText(id)) throw new TypeError('Informe a empresa do diff de eventos.');
  const events = [], seen = new Set(), names = departmentNames(after);
  const messageEvents = (current, messages) => {
    const valid = messages.filter(message => shortText(message?.id));
    for (const message of valid.slice(-messageLimit)) events.push({ type: 'conversation.message', ...current, messageId: message.id, kind: shortText(message.kind) ? message.kind : 'unknown', ...(message.kind === 'customer' && message.pollVote ? { entry: 'poll_vote' } : {}) });
    return valid.length > messageLimit;
  };
  for (const conversation of Array.isArray(after?.conversations) ? after.conversations : []) {
    if (!conversation || !shortText(conversation.id) || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    const current = pointer(id, conversation, names), old = previous.conversations.get(conversation.id);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!old) {
      events.push({ type: 'conversation.created', ...current });
      if (messageEvents(current, messages)) events.push({ type: 'conversation.updated', ...current, changes: ['messages'], truncated: true });
      continue;
    }
    let appended = [], rewritten = false;
    if (old.count === 0) appended = messages;
    else if (messages[old.count - 1]?.id === old.lastId) appended = messages.slice(old.count);
    else {
      // Messages were removed, merged or reordered: only messages after the newest surviving id of the old tail count
      // as appended. Without any surviving anchor the update carries `messages` and consumers re-read the conversation.
      const known = new Set(old.tail || (old.lastId === null ? [] : [old.lastId]));
      const index = messages.findLastIndex(message => known.has(message?.id));
      if (index >= 0) appended = messages.slice(index + 1);
      rewritten = true;
    }
    const truncated = messageEvents(current, appended);
    const changes = TRACKED.filter(key => old[key] !== current[key]);
    const significant = changes.some(key => key !== 'version') || changes.includes('version') && !appended.length || rewritten || truncated;
    if (significant) events.push({ type: 'conversation.updated', ...current, changes: [...changes, ...(rewritten || truncated ? ['messages'] : [])],
      previous: Object.fromEntries(changes.map(key => [key, old[key]])), ...(truncated ? { truncated: true } : {}) });
  }
  for (const [conversationId, old] of previous.conversations) if (!seen.has(conversationId)) {
    const { count, lastId, tail, tenantId: ignored, ...route } = old;
    events.push({ type: 'conversation.removed', ...route, tenantId: id, conversationId });
  }
  return events;
}

const RUNS = Symbol.for('elozi.runIndex'), CHANNELS = Symbol.for('elozi.channelIndex'), SNAPSHOT = Symbol.for('elozi.tenantSnapshot');
// What a reader of a run can observe changing: state, revision, stale mark and the last touch (tool dispatch, outcome).
const runMark = run => `${shortText(run.state) ? run.state : ''}|${Number.isSafeInteger(run.version) ? run.version : 0}|${run.stale === true ? 1 : 0}|${typeof run.updatedAt === 'string' ? run.updatedAt : ''}`;
/** Light index of the agent runs of a company: id → change mark (no draft, receipt or tool data). */
export function indexTenantRuns(state) {
  const runs = new Map();
  for (const run of Array.isArray(state?.runs) ? state.runs : []) if (run && shortText(run.id) && !runs.has(run.id)) runs.set(run.id, runMark(run));
  return { [RUNS]: true, runs };
}
/**
 * One `run.changed` pointer per new or changed run: { runId, state } plus the route of its conversation (current version,
 * channel, effective department, owner, responsible), so a consumer authorizes it exactly like the conversation itself.
 * A run whose conversation no longer exists has no route to authorize and is not announced.
 */
export function diffTenantRuns(before, after, { tenantId } = {}) {
  const previous = before?.[RUNS] ? before : indexTenantRuns(before);
  const id = tenantId ?? (typeof after?.id === 'string' ? after.id : null);
  if (!shortText(id)) throw new TypeError('Informe a empresa do diff de eventos.');
  const events = [], seen = new Set();
  let conversations = null, names = null;
  for (const run of Array.isArray(after?.runs) ? after.runs : []) {
    if (!run || !shortText(run.id) || seen.has(run.id)) continue;
    seen.add(run.id);
    if (previous.runs.get(run.id) === runMark(run)) continue;
    if (!conversations) {
      conversations = new Map(); names = departmentNames(after);
      for (const conversation of Array.isArray(after?.conversations) ? after.conversations : []) if (conversation && shortText(conversation.id) && !conversations.has(conversation.id)) conversations.set(conversation.id, conversation);
    }
    const conversation = conversations.get(run.conversationId);
    if (!conversation) continue;
    events.push({ type: 'run.changed', ...pointer(id, conversation, names), runId: run.id, state: shortText(run.state) ? run.state : 'unknown' });
  }
  return events;
}
/** Connection state of each channel of a company: id → state. */
export function indexTenantChannels(state) {
  const channels = new Map();
  for (const channel of Array.isArray(state?.channels) ? state.channels : []) if (channel && shortText(channel.id) && !channels.has(channel.id)) channels.set(channel.id, shortText(channel.state) ? channel.state : null);
  return { [CHANNELS]: true, channels };
}
/** `channel.state` for every new channel or persisted state transition: { channelId, state } only. */
export function diffTenantChannels(before, after, { tenantId } = {}) {
  const previous = before?.[CHANNELS] ? before : indexTenantChannels(before), current = indexTenantChannels(after);
  const id = tenantId ?? (typeof after?.id === 'string' ? after.id : null);
  if (!shortText(id)) throw new TypeError('Informe a empresa do diff de eventos.');
  const events = [];
  for (const [channelId, state] of current.channels) {
    if (previous.channels.has(channelId) && previous.channels.get(channelId) === state) continue;
    events.push({ type: 'channel.state', tenantId: id, channelId, state: state ?? 'unknown' });
  }
  return events;
}

/** What only administrators' attention counts: ids and states of the administrative proposals and the daily AI limit. */
const proposalsMark = state => `${Number.isSafeInteger(state?.aiDailyTokenLimit) ? state.aiDailyTokenLimit : ''}#`
  + (Array.isArray(state?.agentAdminProposals) ? state.agentAdminProposals : []).map(item => `${item?.id ?? ''}:${item?.state ?? ''}`).join('|');
/** What Store.mutate keeps from the state read inside the transaction, before `fn` runs. */
export function snapshotTenant(state) {
  return { [SNAPSHOT]: true, conversations: indexTenantConversations(state), runs: indexTenantRuns(state), channels: indexTenantChannels(state), proposals: proposalsMark(state) };
}
/**
 * Every pointer event between a snapshot and the committed state: conversations, then runs, then channels, then one
 * attention.changed { audience: 'admin' } when the administrative proposals or the daily AI limit changed (no id, title,
 * content or value).
 */
export function diffTenant(snapshot, after, { tenantId, messageLimit } = {}) {
  if (!snapshot?.[SNAPSHOT]) throw new TypeError('Informe o retrato anterior da empresa.');
  const events = [...diffTenantConversations(snapshot.conversations, after, { tenantId, ...(messageLimit === undefined ? {} : { messageLimit }) }),
    ...diffTenantRuns(snapshot.runs, after, { tenantId }), ...diffTenantChannels(snapshot.channels, after, { tenantId })];
  const id = tenantId ?? (typeof after?.id === 'string' ? after.id : null);
  if (typeof snapshot.proposals === 'string' && shortText(id) && snapshot.proposals !== proposalsMark(after)) events.push({ type: 'attention.changed', tenantId: id, audience: 'admin' });
  return events;
}
/**
 * Publishes the pointers of a committed mutation. It runs after COMMIT, so nothing here may throw back into the caller:
 * a failed diff or a rejected publication is reported and the committed change stands. Returns how many were published.
 */
export function publishTenantChanges(bus, snapshot, after, { tenantId, onError = null } = {}) {
  const report = failure => { try { onError?.(failure); } catch { /* A reporter never breaks the committed caller. */ } };
  if (!bus || bus.closed) return 0;
  let events;
  try { events = diffTenant(snapshot, after, { tenantId }); } catch (failure) { report(failure); return 0; }
  let published = 0;
  for (const event of events) { try { if (bus.publish(event)) published += 1; } catch (failure) { report(failure); } }
  return published;
}

const listed = (list, value) => list === null || list === undefined || Array.isArray(list) && list.includes(value);
function locationVisible(location, scope) {
  if (location.conversationKind === 'group' && scope.includeGroups !== true) return false;
  if (!listed(scope.channelIds, location.channelId)) return false;
  if (!listed(scope.departmentIds, location.departmentId || 'unassigned')) return false;
  if (scope.agentId && location.owner === 'agent' && location.agentId !== scope.agentId) return false;
  if (scope.assignedOnly === true && !(location.owner === 'agent' && location.agentId === scope.agentId)) return false;
  return true;
}
const locations = event => {
  const current = Object.fromEntries(LOCATION.map(key => [key, event[key] ?? null]));
  const previous = event.previous && LOCATION.some(key => Object.hasOwn(event.previous, key)) ? { ...current, ...Object.fromEntries(LOCATION.filter(key => Object.hasOwn(event.previous, key)).map(key => [key, event.previous[key]])) } : null;
  return { current, previous };
};
function validScope(scope) {
  if (!plain(scope)) return false;
  for (const key of ['channelIds', 'departmentIds']) if (scope[key] !== null && scope[key] !== undefined && !Array.isArray(scope[key])) return false;
  return true;
}

/**
 * Scope predicate as used by service principals: { tenantId?, channelIds: string[]|null, departmentIds: string[]|null
 * ('unassigned' for none), agentId?, assignedOnly?, includeGroups? }. null means every channel/department.
 * With agentId, conversations owned by another agent are hidden; assignedOnly keeps only this agent's conversations.
 * Groups stay hidden unless includeGroups (the server must still check the channel's group selection).
 * An update stays visible when the conversation was in scope before it moved (the consumer learns it left).
 */
export function visibleTo(event, scope) {
  if (!plain(event) || !validScope(scope) || !shortText(event.tenantId)) return false;
  if (scope.tenantId !== undefined && scope.tenantId !== event.tenantId) return false;
  const { current, previous } = locations(event);
  return locationVisible(current, scope) || Boolean(previous) && locationVisible(previous, scope);
}

/** Projection for one scope: the full pointer when it is in scope now, a minimal `left` pointer when it only was. */
export function scopeEvent(event, scope) {
  if (!visibleTo(event, scope)) return null;
  const { current, previous } = locations(event);
  if (locationVisible(current, scope)) {
    if (!event.previous || !previous || locationVisible(previous, scope)) return event;
    // The out-of-scope origin (channel, department, other agent) is not disclosed; status/version history stays.
    const kept = Object.fromEntries(Object.entries(event.previous).filter(([key]) => !LOCATION.includes(key)));
    const { previous: ignored, ...rest } = event;
    return Object.freeze({ ...rest, ...(Object.keys(kept).length ? { previous: Object.freeze(kept) } : {}) });
  }
  return Object.freeze({ id: event.id, at: event.at, type: event.type, tenantId: event.tenantId, conversationId: event.conversationId,
    ...(Number.isSafeInteger(event.version) ? { version: event.version } : {}), ...(event.changes ? { changes: event.changes } : {}), left: true });
}

const matcher = filter => {
  if (filter === undefined || filter === null) return () => true;
  if (typeof filter === 'function') return filter;
  if (!plain(filter)) throw new TypeError('Filtro de eventos inválido.');
  const types = filter.types === undefined ? null : new Set(filter.types);
  if (filter.types !== undefined && (!Array.isArray(filter.types) || filter.types.some(type => typeof type !== 'string'))) throw new TypeError('Filtro de eventos inválido.');
  if (filter.scope !== undefined && !validScope(filter.scope)) throw new TypeError('Escopo de eventos inválido.');
  return event => (filter.tenantId === undefined || event.tenantId === filter.tenantId) && (!types || types.has(event.type))
    && (filter.conversationId === undefined || event.conversationId === filter.conversationId) && (!filter.scope || visibleTo(event, filter.scope));
};
/**
 * Compiled filter: `match` decides delivery and `project` shapes what is delivered. An object filter with `scope`
 * always delivers scopeEvent(event, scope), so a conversation that left the scope never discloses its new route.
 * A function filter delivers the raw event: the caller owns that projection.
 */
const compile = filter => {
  const match = matcher(filter), scope = plain(filter) && filter.scope ? filter.scope : null;
  return { match, project: scope ? event => scopeEvent(event, scope) : event => event };
};
const safeMatch = (match, event) => { try { return match(event) === true; } catch { return false; } };
const deepFreeze = event => { if (event.previous) Object.freeze(event.previous); if (event.changes) Object.freeze(event.changes); return Object.freeze(event); };

/**
 * subscribe/since/waitFor accept a filter { tenantId?, types?, conversationId?, scope? } or a predicate. With `scope`,
 * delivered events are scopeEvent projections. After close() every cursor behind the head answers resync with `closed`.
 */
export function createEventBus({ ringSize = 512, maxTenants = 10000, maxWaiters = 2000, maxWaitersPerTenant = 200, maxWaitMs = 30000,
  maxBatch = 500, now = Date.now, bootId = randomBytes(6).toString('hex'), cursorKey = randomBytes(32), onError = null } = {}) {
  const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!bounded(ringSize, 1, 100000) || !bounded(maxTenants, 1, 1000000) || !bounded(maxWaiters, 1, 100000) || !bounded(maxWaitersPerTenant, 1, 100000)
    || !bounded(maxWaitMs, 1, 300000) || !bounded(maxBatch, 1, 10000) || typeof now !== 'function' || !/^[0-9a-f]{12}$/.test(bootId)
    || !Buffer.isBuffer(cursorKey) || cursorKey.length < 16 || onError !== null && typeof onError !== 'function') throw new TypeError('Configuração do barramento de eventos inválida.');
  let seq = 0, droppedFloor = 0, closed = false;
  const rings = new Map(), subscribers = new Set(), waiters = new Map(), cipher = permutation(Buffer.from(cursorKey));
  let waiterCount = 0, memo = { value: -1, cursor: '' };
  const encode = value => {
    if (memo.value !== value) memo = { value, cursor: `${bootId}-${cipher.encrypt(value).toString(36)}` };
    return memo.cursor;
  };
  const report = failure => { try { onError?.(failure); } catch { /* A reporter never breaks the publisher. */ } };
  const decode = cursor => {
    if (typeof cursor !== 'string' || cursor.length > 40) throw error(400, 'Cursor de eventos inválido.');
    const match = CURSOR.exec(cursor);
    if (!match) throw error(400, 'Cursor de eventos inválido.');
    const value = parseInt(match[2], 36);
    if (!Number.isSafeInteger(value)) throw error(400, 'Cursor de eventos inválido.');
    // A value outside the permutation was never issued: it resyncs like a cursor from the future.
    return { boot: match[1], seq: value < DOMAIN ? cipher.decrypt(value) : Infinity };
  };
  const tenantKey = tenantId => { if (!shortText(tenantId)) throw error(400, 'Informe a empresa dos eventos.'); return tenantId; };
  const ringOf = tenantId => {
    let ring = rings.get(tenantId);
    if (ring) { rings.delete(tenantId); rings.set(tenantId, ring); return ring; }
    ring = { items: [], floor: droppedFloor, last: droppedFloor };
    rings.set(tenantId, ring);
    while (rings.size > maxTenants) {
      // A forgotten tenant may have had events: every tenant without a ring conservatively resyncs below this mark.
      const [oldest, dropped] = rings.entries().next().value;
      droppedFloor = Math.max(droppedFloor, dropped.last); rings.delete(oldest);
    }
    return ring;
  };

  /** Reads one tenant ring after `position` with a compiled filter (see `compile`). */
  function read(tenantId, position, limit, compiled) {
    const head = encode(seq), done = closed ? { closed: true } : {};
    const ring = rings.get(tenantId), floor = ring ? ring.floor : droppedFloor;
    if (position.seq < floor) return { events: [], cursor: head, resync: true, ...done };
    const events = [];
    for (const record of ring?.items || []) {
      if (record.seq <= position.seq || !safeMatch(compiled.match, record.event)) continue;
      const projected = compiled.project(record.event);
      if (!projected) continue;
      events.push(projected);
      if (events.length === limit) return { events, cursor: encode(record.seq), resync: false, more: record.seq < (ring.items.at(-1)?.seq ?? 0), ...done };
    }
    return { events, cursor: head, resync: false, ...done };
  }
  /** Decoded position of a cursor of this boot, or null when the consumer must resync (missing, other boot, future). */
  function position(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return null;
    const value = decode(cursor);
    return value.boot !== bootId || value.seq > seq ? null : value;
  }

  function since(tenantId, cursor, { limit = 100, filter } = {}) {
    tenantKey(tenantId);
    if (!bounded(limit, 1, maxBatch)) throw error(400, 'Limite de eventos inválido.');
    const from = position(cursor);
    if (!from) return { events: [], cursor: encode(seq), resync: true, ...(closed ? { closed: true } : {}) };
    return read(tenantId, from, limit, compile(filter));
  }

  /**
   * Waiters are woken by the event just published: anything older that matched would already have woken them.
   * Only a waiter whose cursor fell below the ring floor (resync) or whose filter matches the new event re-reads the ring.
   */
  function wake(tenantId, event) {
    const list = waiters.get(tenantId);
    if (!list) return;
    const ring = rings.get(tenantId), floor = ring ? ring.floor : droppedFloor;
    for (const waiter of [...list]) {
      if (waiter.position.seq >= floor && !safeMatch(waiter.compiled.match, event)) continue;
      let result;
      try { result = read(tenantId, waiter.position, waiter.limit, waiter.compiled); }
      catch (failure) { waiter.finish(null, failure); continue; }
      if (result.resync || result.events.length) waiter.finish(result);
    }
  }

  function publish(input) {
    if (closed) return null;
    const payload = pointerPayload(input);
    if (seq + 1 >= DOMAIN) throw error(503, 'Sequência de eventos esgotada neste processo; reinicie o serviço.');
    seq += 1;
    const event = deepFreeze({ id: encode(seq), at: new Date(now()).toISOString(), ...payload });
    const ring = ringOf(payload.tenantId);
    ring.items.push({ seq, event }); ring.last = seq;
    while (ring.items.length > ringSize) ring.floor = ring.items.shift().seq;
    for (const subscriber of [...subscribers]) {
      if (!safeMatch(subscriber.compiled.match, event)) continue;
      try {
        const projected = subscriber.compiled.project(event);
        if (projected) subscriber.fn(projected);
      } catch (failure) { report(failure); }
    }
    wake(payload.tenantId, event);
    return event;
  }

  function subscribe(filter, fn) {
    if (typeof filter === 'function' && fn === undefined) { fn = filter; filter = null; }
    if (typeof fn !== 'function') throw new TypeError('Informe a função do assinante de eventos.');
    const subscriber = { compiled: compile(filter), fn };
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }

  function waitFor({ tenantId, cursor, timeoutMs = maxWaitMs, signal, filter, limit = 100 } = {}) {
    try {
      tenantKey(tenantId);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw error(400, 'Tempo de espera inválido.');
      if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) throw new TypeError('Sinal de cancelamento inválido.');
      const first = since(tenantId, cursor, { limit, filter });
      if (first.resync || first.events.length || timeoutMs === 0 || closed) return Promise.resolve(closed ? { ...first, closed: true } : first);
      if (signal?.aborted) return Promise.reject(signal.reason ?? error(499, 'Espera de eventos cancelada.'));
      const list = waiters.get(tenantId) || new Set();
      if (waiterCount >= maxWaiters || list.size >= maxWaitersPerTenant) throw error(429, 'Muitas esperas de eventos simultâneas. Tente novamente em instantes.');
      const compiled = compile(filter);
      return new Promise((resolve, reject) => {
        let timer, onAbort, done = false;
        const waiter = { cursor: first.cursor, position: decode(first.cursor), limit, compiled, finish(result, failure) {
          if (done) return; done = true;
          clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
          list.delete(waiter); waiterCount -= 1; if (!list.size) waiters.delete(tenantId);
          if (failure) reject(failure); else resolve(result);
        } };
        onAbort = () => waiter.finish(null, signal.reason ?? error(499, 'Espera de eventos cancelada.'));
        list.add(waiter); waiters.set(tenantId, list); waiterCount += 1;
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          let result;
          try { result = read(tenantId, waiter.position, limit, compiled); } catch (failure) { return waiter.finish(null, failure); }
          waiter.finish({ ...result, timedOut: !result.events.length && !result.resync });
        }, Math.min(timeoutMs, maxWaitMs));
        timer.unref?.();
      });
    } catch (failure) { return Promise.reject(failure); }
  }

  function close() {
    if (closed) return;
    closed = true; subscribers.clear();
    for (const list of [...waiters.values()]) for (const waiter of [...list]) waiter.finish({ events: [], cursor: waiter.cursor, resync: false, closed: true });
    // The rings are released, so every cursor behind the head must resync instead of reading an empty history.
    droppedFloor = seq; waiters.clear(); rings.clear();
  }

  /** Position of an id or cursor of this boot inside the process (-1 when it is not one), for ordering only. */
  function order(id) {
    try { const value = decode(id); return value.boot === bootId && value.seq <= seq ? value.seq : -1; } catch { return -1; }
  }

  return Object.freeze({ publish, subscribe, since, waitFor, close, bootId, order,
    head: () => encode(seq), get closed() { return closed; },
    stats: () => ({ bootId, sequence: seq, tenants: rings.size, subscribers: subscribers.size, waiters: waiterCount }) });
}

const sequenceOf = id => { const match = typeof id === 'string' ? CURSOR.exec(id) : null; return match ? parseInt(match[2], 36) : -1; };
const streamKey = event => event.type === 'attention.changed' ? `a\u0000${event.tenantId}` : event.type === 'run.changed' ? `r\u0000${event.tenantId}\u0000${event.runId}`
  : event.type === 'channel.state' ? `c\u0000${event.tenantId}\u0000${event.channelId}`
    : event.type === 'teamchat.message' ? `t\u0000${event.tenantId}\u0000${event.roomId}` : `i\u0000${event.tenantId}\u0000${event.conversationId}`;

/**
 * Server-sent events of authenticated panel sessions (FRONTEND-V2 §7.4). The stream carries invalidation pointers only:
 * inbox.changed {tenantId, conversationId, revision[, left]}, run.changed {tenantId, conversationId, runId, state},
 * channel.state {tenantId, channelId, state}, teamchat.message {tenantId, roomId}, attention.changed {revision},
 * ready {cursor, resumed} and reset {}; the client re-reads content through the authorized REST routes. An
 * attention.changed bus pointer (support request of a conversation, administrative proposals) has no frame of its own:
 * when visible it only triggers the attention.changed frame of the round.
 *
 * - Every queued event is decided again at delivery with a fresh authorization snapshot: `principal.resolve()`
 *   re-authenticates the session (a revoked session ends the stream) and `visibility(actor)` returns the predicate of
 *   /api/inbox for that person: event → 'current' | 'previous' (the conversation just left the scope) | null.
 * - All due streams flush together in one tick wrapped by `runTick`, so the caller can share company reads inside a
 *   synchronous tick while each person keeps their own decision.
 * - Last-Event-ID (or ?cursor) replays the bus rings of the workspace; a gap beyond the rings, another process or an
 *   overflowing queue answers `reset` and the client reloads what it shows.
 * - Heartbeat comments keep proxies open and also move the client cursor past events it was not allowed to see.
 */
export function createEventStreamHub({ bus, visibility, workspaceOf, tenantsOf, runTick = work => work(), heartbeatMs = 20000, flushMs = 200, retryMs = 3000,
  maxPerSession = 6, maxPerUser = 12, maxConnections = 2000, maxQueue = 2000, maxBufferedBytes = 1048576, now = Date.now, onError = null } = {}) {
  const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!bus || typeof bus.subscribe !== 'function' || typeof bus.since !== 'function' || typeof visibility !== 'function' || typeof workspaceOf !== 'function'
    || typeof tenantsOf !== 'function' || typeof runTick !== 'function' || !bounded(heartbeatMs, 10, 300000) || !bounded(flushMs, 0, 10000) || !bounded(retryMs, 100, 60000)
    || !bounded(maxPerSession, 1, 100) || !bounded(maxPerUser, 1, 1000) || !bounded(maxConnections, 1, 100000) || !bounded(maxQueue, 1, 100000)
    || !bounded(maxBufferedBytes, 1024, 64 * 1048576) || typeof now !== 'function' || onError !== null && typeof onError !== 'function') throw new TypeError('Configuração do fluxo de eventos inválida.');
  const report = failure => { try { onError?.(failure); } catch { /* Reporting never breaks a stream. */ } };
  const orderOf = typeof bus.order === 'function' ? id => bus.order(id) : sequenceOf;
  const connections = new Set(), bySession = new Map(), byUser = new Map(), pending = new Set(), workspaces = new Map();
  let closed = false, tick = null;
  // Companies never move between workspaces; unknown ids are not cached, so a new company is found on its first event.
  const workspaceFor = tenantId => {
    if (workspaces.has(tenantId)) return workspaces.get(tenantId);
    let value = null; try { value = workspaceOf(tenantId) ?? null; } catch (failure) { report(failure); }
    if (value !== null) { if (workspaces.size >= 50000) workspaces.delete(workspaces.keys().next().value); workspaces.set(tenantId, value); }
    return value;
  };
  const count = (map, key, delta) => { const value = (map.get(key) || 0) + delta; if (value > 0) map.set(key, value); else map.delete(key); };
  const frame = (event, data, id) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function write(connection, text) {
    if (connection.ended) return false;
    try {
      connection.res.write(text);
      if (connection.res.writableLength > maxBufferedBytes) { finish(connection, true); return false; }
      return true;
    } catch { finish(connection, true); return false; }
  }
  function finish(connection, destroy = false) {
    if (connection.ended) return;
    connection.ended = true; connections.delete(connection); pending.delete(connection);
    clearInterval(connection.heartbeat); connection.unsubscribe?.();
    count(bySession, connection.principal.sessionKey, -1); count(byUser, connection.principal.userKey, -1);
    try { if (destroy) connection.res.destroy(); else connection.res.end(); } catch { /* The socket is already gone. */ }
  }
  function schedule(connection) {
    pending.add(connection);
    if (tick || closed) return;
    tick = setTimeout(flushAll, flushMs); tick.unref?.();
  }
  function enqueue(connection, event) {
    if (connection.ended) return;
    if (connection.queue.length >= maxQueue) { connection.queue = []; connection.reset = true; connection.resetId = event.id; }
    else connection.queue.push(event);
    schedule(connection);
  }
  function flushAll() {
    tick = null;
    const due = [...pending]; pending.clear();
    if (!due.length) return;
    try { runTick(() => { for (const connection of due) { try { flush(connection); } catch (failure) { report(failure); finish(connection, true); } } }); }
    catch (failure) { report(failure); for (const connection of due) if (!connection.ended) finish(connection, true); }
  }
  function flush(connection) {
    if (connection.ended) return;
    let actor;
    try { actor = connection.principal.resolve(); } catch { return finish(connection); }
    const events = connection.queue; connection.queue = [];
    let text = '';
    if (connection.reset) {
      const id = connection.resetId || (events.length ? null : bus.head());
      text += frame('reset', {}, id); if (id) connection.lastSentId = id;
      connection.reset = false; connection.resetId = null;
    }
    let decide;
    try { decide = visibility(actor); } catch (failure) { report(failure); decide = () => null; }
    const decisions = events.map(event => { try { const value = decide(event); return value === 'current' || value === 'previous' ? value : null; } catch { return null; } });
    const last = new Map();
    events.forEach((event, index) => { if (decisions[index]) last.set(streamKey(event), index); });
    let delivered = null;
    for (let index = 0; index < events.length; index++) {
      const event = events[index], decision = decisions[index];
      if (!decision || last.get(streamKey(event)) !== index) continue;
      if (event.type === 'attention.changed') { if (decision !== 'current') continue; }
      else if (event.type === 'run.changed') { if (decision !== 'current') continue; text += frame('run.changed', { tenantId: event.tenantId, conversationId: event.conversationId, runId: event.runId, state: event.state }, event.id); }
      else if (event.type === 'channel.state') text += frame('channel.state', { tenantId: event.tenantId, channelId: event.channelId, state: event.state }, event.id);
      else if (event.type === 'teamchat.message') text += frame('teamchat.message', { tenantId: event.tenantId, roomId: event.roomId }, event.id);
      else if (event.conversationId) text += frame('inbox.changed', { tenantId: event.tenantId, conversationId: event.conversationId, revision: event.id,
        ...(decision === 'previous' || event.type === 'conversation.removed' ? { left: true } : {}) }, event.id);
      else continue;
      delivered = event.id;
    }
    if (delivered) { text += frame('attention.changed', { revision: delivered }, delivered); connection.lastSentId = delivered; }
    if (events.length) connection.lastSeenId = events.at(-1).id;
    if (text) write(connection, text);
  }

  /**
   * Opens a stream on an HTTP response. principal: { workspaceId, sessionKey, userKey, resolve() → current actor (throws
   * when the session or workspace access ended) }. Caps are checked before any byte is written (429).
   */
  function open(res, principal, { cursor = null } = {}) {
    if (closed) throw error(503, 'O tempo real está indisponível no momento.');
    if (!principal || typeof principal.resolve !== 'function' || !shortText(principal.workspaceId) || !shortText(principal.sessionKey) || !shortText(principal.userKey)) throw new TypeError('Sessão do fluxo de eventos inválida.');
    if (connections.size >= maxConnections) throw Object.assign(error(429, 'Muitas conexões em tempo real no servidor. O painel continua atualizando sozinho.'), { retryAfter: 30 });
    if ((bySession.get(principal.sessionKey) || 0) >= maxPerSession) throw Object.assign(error(429, 'Muitas conexões em tempo real abertas nesta sessão.'), { retryAfter: 30 });
    if ((byUser.get(principal.userKey) || 0) >= maxPerUser) throw Object.assign(error(429, 'Muitas conexões em tempo real abertas para esta pessoa.'), { retryAfter: 30 });
    const connection = { res, principal, queue: [], reset: false, resetId: null, lastSentId: null, lastSeenId: null, ended: false, heartbeat: null, unsubscribe: null };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.socket?.setNoDelay?.(true);
    connections.add(connection); count(bySession, principal.sessionKey, 1); count(byUser, principal.userKey, 1);
    res.on('close', () => finish(connection));
    // Subscribe and read the rings in the same synchronous block: nothing can be published in between.
    connection.unsubscribe = bus.subscribe(event => { if (workspaceFor(event.tenantId) === principal.workspaceId) enqueue(connection, event); });
    const head = bus.head();
    let text = `retry: ${retryMs}\n\n`, resumed = false;
    if (typeof cursor === 'string' && cursor) {
      const replay = [];
      let resync = false;
      try {
        for (const tenantId of tenantsOf(principal.workspaceId)) {
          let position = cursor;
          for (let page = 0; page < 1000; page++) {
            const read = bus.since(tenantId, position, { limit: 500 });
            if (read.resync) { resync = true; break; }
            replay.push(...read.events);
            if (!read.more) break;
            position = read.cursor;
          }
          if (resync) break;
        }
      } catch { resync = true; }
      if (resync) { connection.reset = true; connection.resetId = head; schedule(connection); }
      else if (replay.length) {
        // One decode per event (ids are a keyed permutation), then a plain numeric sort.
        const positions = new Map(replay.map(event => [event, orderOf(event.id)]));
        replay.sort((left, right) => positions.get(left) - positions.get(right));
        connection.queue.unshift(...replay.slice(-maxQueue)); if (replay.length > maxQueue) { connection.reset = true; connection.resetId = replay.at(-1).id; }
        connection.lastSeenId = cursor; schedule(connection);
      }
      resumed = !resync;
      // Without missed events the cursor moves to the head at once; with a replay, the replayed events carry the ids.
      text += frame('ready', { cursor: head, resumed }, resync || replay.length ? null : head);
    } else text += frame('ready', { cursor: head, resumed }, head);
    if (!connection.queue.length && !connection.reset) connection.lastSentId = head;
    write(connection, text);
    connection.heartbeat = setInterval(() => {
      if (connection.ended) return;
      try { connection.principal.resolve(); } catch { return finish(connection); }
      // An id-only block moves the client cursor past events it may not see, so a reconnect does not replay them again.
      const advance = !connection.queue.length && !pending.has(connection) && connection.lastSeenId && connection.lastSeenId !== connection.lastSentId ? connection.lastSeenId : null;
      if (write(connection, `${advance ? `id: ${advance}\n` : ''}: hb\n\n`) && advance) connection.lastSentId = advance;
    }, heartbeatMs);
    connection.heartbeat.unref?.();
    return { close: () => finish(connection) };
  }

  function close() {
    if (closed) return;
    closed = true; clearTimeout(tick); tick = null; pending.clear();
    for (const connection of [...connections]) finish(connection);
  }
  return Object.freeze({ open, close, get closed() { return closed; },
    stats: () => ({ connections: connections.size, sessions: bySession.size, users: byUser.size, pending: pending.size }) });
}
