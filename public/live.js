// Client scheduler of the panel (FRONTEND-V2 §7.1, §8.3 P2). One scheduler per page:
//
// - Leader tab per person and workspace: navigator.locks.request('elozi-live:<userId>:<workspaceId>')
//   plus BroadcastChannel('elozi-live'). The leader runs the attention pulse (and opens the event
//   stream when the backend lists "events"); the other tabs receive its snapshot by message, and a
//   beat after its successful requests keeps their connection indicator fresh. The tab the person
//   looks at leads: the leader tells the others whether it is visible, and a visible tab takes the
//   lock (steal) from a hidden leader, so the pulse keeps the 15 s of a visible page (no throttling of
//   hidden pages) and the sound plays at once; the tab it took the lock from follows and queues again.
//   Without locks or BroadcastChannel every tab is its own leader (the behaviour before P2).
// - Each visible tab polls its own open conversation (the app.js tasks keep their bodies), while the
//   inbox page goes through shared(): the leader fetches each distinct page once and broadcasts it,
//   so N visible tabs on the same filters make one list request per cycle. Only the polls reuse a
//   shared copy: a page asked outside them (after an action of the person) is always fetched now.
// - Cadence by screen and visibility: inbox 5 s, pulse 15 s visible / 30 s hidden (leader only) /
//   120 s outside "Disponível", team chat 5 s open / 30 s closed, 60 s resync while the event stream
//   is open. Errors back off 5→10→20→40→60 s with ±20% jitter; the online event resumes at once.
// - Paused while the session is expired (session-guard.js events) and measured for the connection
//   indicator: last success, consecutive failures and navigator.onLine.
//
// Module registry (one per page): app.js creates the modules at different points, so the pieces meet
// here. attention.js provides the context getter, data-source.js reports successes and failures and
// registers what the leader may fetch for the others, team-chat-ui.js registers its badge task and
// every module reads the features listed by GET /api/bootstrap through liveFeatures().
import { h, t } from './i18n.js';
import './locales-live.js';
import { glyph } from './icons.js';
import { dispatchAction, isNamespacedName } from './actions.js';

export const CADENCE = Object.freeze({ inbox: 5000, contacts: 5000, pulse: 15000, hidden: 30000, away: 120000, teamOpen: 5000, teamClosed: 30000, resync: 60000 });
export const BACKOFF_STEPS = Object.freeze([5000, 10000, 20000, 40000, 60000]);
export const LATE_AFTER = 15000;
export const LIVE_CHANNEL = 'elozi-live';
const JITTER = 0.2, MAX_SLEEP = 5000, SHARE_WAIT = 2500, CACHE_LIMIT = 24, BEAT_EVERY = 5000;

/** Delay after `failures` consecutive failures: 5→10→20→40→60 s with ±20% jitter (0 without failures). */
export function backoffDelay(failures, random = Math.random) {
  if (!(failures > 0)) return 0;
  const base = BACKOFF_STEPS[Math.min(failures, BACKOFF_STEPS.length) - 1];
  return Math.round(base * (1 - JITTER + 2 * JITTER * Math.min(1, Math.max(0, Number(random()) || 0))));
}

/** Name of the leader lock: one leader per person, workspace and support grant ('' before the boot). */
export function lockName({ userId, workspaceId, supportGrantId } = {}) {
  if (!userId || !workspaceId) return '';
  return `elozi-live:${userId}:${workspaceId}${supportGrantId ? ':' + supportGrantId : ''}`;
}

/** Shared state of one page (tests create one registry per simulated tab). */
export function createLiveRegistry() {
  return { context: null, features: new Map(), tasks: new Map(), handlers: new Map(), counts: new Map(), countListeners: new Set(), live: null,
    health: { lastSuccess: 0, failures: 0, lastFailure: 0 } };
}
export const liveRegistry = createLiveRegistry();

// A failure of the scheduler never reaches the caller (a request that succeeded stays a success).
const nudge = (registry, method, ...args) => { try { registry.live?.[method]?.(...args); } catch {} };
/** attention.js hands over the context getter of app.js ({workspaceId, userId, supportGrantId, view, …}). */
export function provideLiveContext(getter, registry = liveRegistry) { registry.context = typeof getter === 'function' ? getter : null; nudge(registry, 'touch'); }
/** Current context of the panel ({} before the boot or without a provider). */
export function liveContext(registry = liveRegistry) {
  try { const value = registry.context?.(); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
/** Features listed by GET /api/bootstrap for a workspace (attention.js reads them once per workspace). */
export function setLiveFeatures(workspaceId, features, registry = liveRegistry) {
  if (!workspaceId) return;
  registry.features.set(String(workspaceId), new Set((Array.isArray(features) ? features : []).filter(item => typeof item === 'string')));
  nudge(registry, 'touch');
}
/** Features of the current workspace: context().features when app.js passes them, else the probe. */
export function liveFeatures(registry = liveRegistry) {
  const context = liveContext(registry);
  if (Array.isArray(context.features)) return new Set(context.features.filter(item => typeof item === 'string'));
  return registry.features.get(String(context.workspaceId || '')) || new Set();
}
/** Whether the features of the current workspace are known (passed by app.js or already probed). */
export function liveFeaturesKnown(registry = liveRegistry) {
  const context = liveContext(registry);
  return Array.isArray(context.features) || registry.features.has(String(context.workspaceId || ''));
}

/** Extra task of another module ({name, run, cadence(env) → ms|null, network, events}); returns the remover. */
export function registerLiveTask(task, registry = liveRegistry) {
  if (!task || typeof task.name !== 'string' || !task.name || typeof task.run !== 'function' || typeof task.cadence !== 'function') throw new TypeError('registerLiveTask needs name, run() and cadence()');
  registry.tasks.set(task.name, task);
  nudge(registry, 'touch');
  return () => { if (registry.tasks.get(task.name) === task) { registry.tasks.delete(task.name); nudge(registry, 'touch'); } };
}

/** What the leader may fetch for another tab: kind → {accept(params), fetch(params)}; returns the remover. */
export function registerLiveHandler(kind, handler, registry = liveRegistry) {
  if (typeof handler?.accept !== 'function' || typeof handler?.fetch !== 'function') throw new TypeError('registerLiveHandler needs accept() and fetch()');
  registry.handlers.set(kind, handler);
  return () => { if (registry.handlers.get(kind) === handler) registry.handlers.delete(kind); };
}

/** A failure that says nothing about the connection (403, 404, 409, validation) is not counted. */
export const countsAsFailure = error => error?.name !== 'AbortError' && (!error?.status || error.status >= 500 || error.status === 408 || error.status === 429);
/** data-source.js reports every request: 'success', or 'failure' (network, timeout or 5xx). */
export function reportLive(outcome, registry = liveRegistry, now = Date.now()) {
  const health = registry.health;
  if (outcome === 'success') {
    const recovered = health.failures > 0;
    health.lastSuccess = now; health.failures = 0;
    nudge(registry, 'healthChanged', recovered, 'success');
    return;
  }
  health.failures++; health.lastFailure = now;
  nudge(registry, 'healthChanged', false, 'failure');
}

/** Badges other modules publish for the shell (team chat): a count, or null when unknown. */
export function publishLiveCount(name, value, registry = liveRegistry) {
  const next = Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (registry.counts.has(name) && registry.counts.get(name) === next) return;
  registry.counts.set(name, next);
  for (const listener of registry.countListeners) try { listener(name, next); } catch {}
}
export const liveCount = (name, registry = liveRegistry) => registry.counts.has(name) ? registry.counts.get(name) : null;
export function onLiveCount(listener, registry = liveRegistry) { registry.countListeners.add(listener); return () => registry.countListeners.delete(listener); }
/** The scheduler of this page (null before app.js creates it). */
export const currentLive = (registry = liveRegistry) => registry.live;

const validTask = task => task && typeof task.name === 'string' && task.name && typeof task.run === 'function' && Number.isFinite(task.every) && task.every > 0;
const presenceOf = doc => { try { return doc?.querySelector?.('.sh-account [data-presence]')?.getAttribute?.('data-presence') || 'available'; } catch { return 'available'; } };
const clone = value => { try { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch { return value; } };

/**
 * Policies of the tasks app.js hands over (FRONTEND-V2 §7.1): the interval in ms, or null when the
 * task has nothing to do now. The run functions keep their own guards (screen, busy, open modal).
 */
const POLICIES = {
  inbox: env => env.visible && env.view === 'inbox' ? CADENCE.inbox : null,
  contacts: env => env.visible ? CADENCE.contacts : null,
  'team-chat': env => env.visible && env.view === 'team-chat' ? CADENCE.teamOpen : null
};

/**
 * createLive({tasks, attention}) → {start, stop, kick, state, pause, resume, retry, shared, subscribe, touch}.
 * tasks: [{name, every, run()}] from app.js; known names follow the policies above, others keep their
 * fixed interval. Every dependency is injectable for tests: timers (setTimeout/clearTimeout and an
 * optional now()), document, navigator (locks, onLine), window, BroadcastChannel, EventSource, random
 * and the registry of the page.
 */
export function createLive({ tasks = [], attention = null, timers = globalThis, now = () => (typeof timers.now === 'function' ? timers.now() : Date.now()), random = Math.random,
  document: doc = globalThis.document, navigator: nav = globalThis.navigator, window: win = globalThis.window, BroadcastChannel: Channel = globalThis.BroadcastChannel,
  EventSource: Source = globalThis.EventSource, registry = liveRegistry } = {}) {
  if (!Array.isArray(tasks) || !tasks.every(validTask)) throw new TypeError('createLive: every task needs a name, an interval and run()');
  if (new Set(tasks.map(task => task.name)).size !== tasks.length) throw new TypeError('createLive: task names must be unique');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') throw new TypeError('createLive needs timers with setTimeout and clearTimeout');
  const own = tasks.map(task => ({ name: task.name, every: task.every, run: task.run, policy: POLICIES[task.name] || (() => task.every), network: true }));
  const records = new Map(), listeners = new Set(), cache = new Map(), inflight = new Map(), waiting = new Map();
  const tabId = `${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let running = false, paused = false, timer = null, scope = '', leader = false, coordinated = false, channel = null, releaseLock = null, queued = null;
  let backoff = 0, backoffFor = 0, source = null, stream = false, streamRetryAt = 0, lastBeat = -Infinity, leaderVisible = null;

  const visible = () => doc?.visibilityState ? doc.visibilityState !== 'hidden' : true;
  const online = () => nav?.onLine !== false;
  const health = () => registry.health;

  // The pulse of attention.js keeps "não lidas para mim" fresh on every screen, also hidden (leader).
  const pulse = attention && typeof attention.refresh === 'function' ? {
    name: 'attention', network: true, run: () => attention.refresh(),
    policy: env => coordinated && !leader ? null : env.presence === 'offline' ? CADENCE.away : env.visible ? CADENCE.pulse : CADENCE.hidden
  } : null;

  function allTasks() {
    const list = [...own];
    if (pulse) list.push(pulse);
    for (const task of registry.tasks.values()) list.push({ name: task.name, run: task.run, policy: task.cadence, network: task.network !== false });
    return list;
  }
  function environment() {
    const context = liveContext(registry);
    return { visible: visible(), leader, coordinated, view: context.view || '', presence: presenceOf(doc), failures: health().failures, stream, online: online(), now: now() };
  }
  // last: start of the last run; since: when the task became eligible; forced: an earlier run asked
  // for (kick, tab visible again, stale pulse); due: the next run; rerun: one coalesced invalidation
  // received during a request, belonging only to its current user/workspace/grant.
  function record(name) { if (!records.has(name)) records.set(name, { last: null, since: null, forced: null, due: null, running: false, every: null, rerun: null }); return records.get(name); }
  function cadenceOf(task, env, { withBackoff = true } = {}) {
    let every = null;
    try { every = task.policy(env); } catch { every = null; }
    if (!Number.isFinite(every) || every <= 0) return null;
    if (task.network && stream) every = Math.max(every, CADENCE.resync);
    if (withBackoff && task.network && env.failures > 0) {
      if (backoffFor !== env.failures) { backoffFor = env.failures; backoff = backoffDelay(env.failures, random); }
      every = Math.max(every, backoff);
    }
    return every;
  }

  function plan() {
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    if (!running || paused) return;
    syncScope();
    if (!running || paused) return;
    if (leader && !source && now() >= streamRetryAt) openStream();
    const env = environment();
    let earliest = Infinity;
    for (const task of allTasks()) {
      const entry = record(task.name), every = cadenceOf(task, env);
      entry.every = every;
      if (every === null) { entry.due = null; entry.since = null; entry.forced = null; entry.rerun = null; continue; }
      if (entry.since === null) entry.since = env.now;
      // A running request owns the slot until it settles. Its completion plans the next run;
      // otherwise an expired cadence/forced time would keep creating zero-delay timer ticks.
      if (entry.running) { entry.due = null; continue; }
      // First run: the pulse at once, the others one interval after they became eligible.
      const natural = entry.last === null || entry.last < entry.since ? entry.since + (task === pulse ? 0 : every) : entry.last + every;
      // The pulse runs as soon as the scope it knows is not the panel's (boot, workspace change).
      if (task === pulse && !entry.running && attention.stale?.() === true) entry.forced = Math.min(entry.forced ?? Infinity, Math.max(env.now, (entry.last ?? -Infinity) + 1000));
      entry.due = Math.max(env.now, entry.forced !== null ? Math.min(entry.forced, natural) : natural);
      earliest = Math.min(earliest, entry.due);
    }
    const delay = Math.max(0, Math.min(MAX_SLEEP, earliest - env.now));
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(tick, Number.isFinite(delay) ? delay : MAX_SLEEP);
  }
  function tick() {
    timer = null;
    if (!running || paused) return;
    const time = now();
    for (const task of allTasks()) {
      const entry = record(task.name);
      if (entry.due !== null && entry.due <= time) runTask(task, entry);
    }
    plan();
    emit();
  }
  function runTask(task, entry = record(task.name)) {
    if (!running || paused || lockName(liveContext(registry)) !== scope || cadenceOf(task, environment(), { withBackoff: false }) === null) return false;
    if (entry.running) { entry.rerun = scope; return false; }
    entry.last = now(); entry.forced = null;
    entry.due = entry.every ? entry.last + entry.every : null;
    entry.running = true;
    const finish = () => {
      entry.running = false;
      const rerun = entry.rerun;
      entry.rerun = null;
      const current = allTasks().find(candidate => candidate.name === task.name);
      if (running && !paused && rerun !== null && rerun === scope && rerun === lockName(liveContext(registry)) && current && cadenceOf(current, environment(), { withBackoff: false }) !== null) entry.forced = now();
      if (running && !paused) plan();
    };
    let result;
    try { result = task.run(); } catch { finish(); return true; }
    if (result && typeof result.then === 'function') Promise.resolve(result).then(finish, finish);
    else finish();
    return true;
  }

  // Leader election and the channel between the tabs of the same person, workspace and grant.
  function syncScope() {
    const next = lockName(liveContext(registry));
    if (next === scope) return;
    resign();
    scope = next;
    cache.clear();
    if (!scope) return;
    const locks = nav?.locks;
    if (typeof locks?.request !== 'function' || typeof Channel !== 'function') { coordinated = false; leader = true; openStream(); return; }
    try { channel = new Channel(LIVE_CHANNEL); channel.onmessage = event => receive(event?.data); channel.unref?.(); }
    catch { channel = null; coordinated = false; leader = true; openStream(); return; }
    coordinated = true; leader = false; leaderVisible = null;
    claim(scope);
    post({ type: 'hello' });
  }
  // One request of the lock per tab: queued (aborted before a steal or when the tab leaves) or a steal
  // by a visible tab while the leader is hidden. Losing the lock to a steal makes this tab a follower
  // that queues again; a browser that refuses steal simply queues, as before.
  function claim(mine, { steal = false } = {}) {
    const locks = nav?.locks;
    try { queued?.abort(); } catch {}
    queued = null;
    let granted = false, release = null, request;
    const held = new Promise(resolve => { release = resolve; });
    const controller = !steal && typeof AbortController === 'function' ? new AbortController() : null;
    queued = controller;
    releaseLock = () => { try { controller?.abort(); } catch {} release(); };
    try {
      request = locks.request(mine, steal ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ...(controller ? { signal: controller.signal } : {}) }, () => {
        if (mine !== scope || !running) return undefined;
        granted = true; if (queued === controller) queued = null;
        leader = true;
        // What this tab was waiting for from the previous leader is now its own to fetch.
        for (const key of [...waiting.keys()]) settle(key, waiter => waiter.fallback());
        // Its own event stream is not open yet: the followers poll until it is.
        stream = false; leaderVisible = null;
        post({ type: 'stream', open: false }); post({ type: 'leader', visible: visible() });
        openStream();
        if (pulse) record('attention').forced = now();
        plan(); emit();
        return held;
      });
    } catch (error) { request = Promise.reject(error); }
    Promise.resolve(request).catch(() => {
      if (mine !== scope || !running) return;
      if (granted) { if (leader) { leader = false; closeStream(); plan(); emit(); } claim(mine); }
      else if (steal && !leader) claim(mine);
    });
  }
  /** A visible follower takes the lock from a leader that said it is hidden. */
  function leadIfLeaderHidden() {
    if (!running || paused || !coordinated || leader || !scope || !channel || leaderVisible !== false || !visible()) return false;
    leaderVisible = null;
    claim(scope, { steal: true });
    return true;
  }
  function resign() {
    for (const entry of records.values()) { entry.rerun = null; entry.forced = null; }
    releaseLock?.(); releaseLock = null; queued = null;
    if (channel) { try { channel.close(); } catch {} channel = null; }
    closeStream();
    leader = false; coordinated = false;
    for (const [key, list] of [...waiting]) { waiting.delete(key); for (const waiter of list) { timers.clearTimeout(waiter.timer); waiter.fallback(); } }
  }
  function post(message) {
    if (!channel || !scope) return;
    try { channel.postMessage({ ...message, scope, from: tabId }); } catch {}
  }
  function receive(message) {
    if (!message || typeof message !== 'object' || message.scope !== scope || message.from === tabId) return;
    if (message.type === 'hello') { if (leader) { const snapshot = attention?.snapshot?.(); if (snapshot) post({ type: 'attention', snapshot }); post({ type: 'stream', open: stream }); post({ type: 'leader', visible: visible() }); } return; }
    if (message.type === 'leader') { if (!leader) { leaderVisible = message.visible === true; leadIfLeaderHidden(); } return; }
    if (message.type === 'attention') { if (!leader) { attention?.receive?.(message.snapshot); reportLive('success', registry, now()); } return; }
    if (message.type === 'invalidate-attention') { if (leader) kick('attention'); return; }
    // The leader reached the server: the data of this tab is as fresh as its last snapshot (failures of
    // this tab's own requests still count).
    if (message.type === 'beat') { if (!leader) { registry.health.lastSuccess = Math.max(registry.health.lastSuccess || 0, now()); emit(); } return; }
    if (message.type === 'stream') { if (!leader) { stream = Boolean(message.open); plan(); emit(); } return; }
    if (message.type === 'event') { if (!leader) handleEvent(message.name, message.data); return; }
    if (message.type === 'page' && typeof message.key === 'string') {
      remember(message.key, message.value, Number.isFinite(message.startedAt) ? message.startedAt : now());
      reportLive('success', registry, now());
      settle(message.key, waiter => waiter.resolve(clone(message.value)));
      return;
    }
    if (message.type === 'page-error' && typeof message.key === 'string') { settle(message.key, waiter => waiter.fallback()); return; }
    if (message.type === 'want' && leader && typeof message.key === 'string') {
      const handler = registry.handlers.get(message.kind);
      let accepted = false;
      try { accepted = Boolean(handler?.accept(message.params)); } catch {}
      if (!accepted) { post({ type: 'page-error', key: message.key }); return; }
      fetchAndShare(message.key, () => handler.fetch(message.params)).catch(() => {});
    }
  }
  // An answer to a request that started earlier never replaces a newer copy (a poll in flight during
  // an action of the person).
  function remember(key, value, startedAt = now()) {
    const previous = cache.get(key);
    if (previous && previous.startedAt > startedAt) return;
    cache.delete(key);
    cache.set(key, { value, at: now(), startedAt });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  function settle(key, apply) {
    const list = waiting.get(key);
    if (!list) return;
    waiting.delete(key);
    for (const waiter of list) { timers.clearTimeout(waiter.timer); apply(waiter); }
  }
  function fetchAndShare(key, fetcher, { join = true } = {}) {
    if (join && inflight.has(key)) return inflight.get(key);
    const startedAt = now();
    const promise = Promise.resolve().then(fetcher).then(value => {
      remember(key, value, startedAt);
      post({ type: 'page', key, value, startedAt });
      settle(key, waiter => waiter.resolve(clone(value)));
      return value;
    }, error => {
      post({ type: 'page-error', key });
      settle(key, waiter => waiter.fallback());
      throw error;
    }).finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  }

  /**
   * One GET shared by the tabs of the same person and workspace (the inbox page). A copy younger
   * than maxAge answers at once; the leader fetches once and broadcasts; a follower asks the leader
   * and falls back to its own request when no answer arrives in `wait` ms. Without coordination the
   * fetcher simply runs (one tab, or a browser without locks). reuse:false (a page the person asked
   * for outside the polls, after an action) skips the copy and the request in flight: it fetches now
   * and shares the fresh page with the other tabs.
   */
  function shared(key, fetcher, { kind = null, params = null, maxAge = CADENCE.inbox - 500, wait = SHARE_WAIT, reuse = true } = {}) {
    if (!running || !coordinated || !channel) return Promise.resolve().then(fetcher);
    if (!reuse) return fetchAndShare(key, fetcher, { join: false });
    const entry = cache.get(key);
    if (entry && now() - entry.at < maxAge) return Promise.resolve(clone(entry.value));
    if (leader || !kind) return fetchAndShare(key, fetcher);
    return new Promise((resolve, reject) => {
      const waiter = { timer: null, resolve, fallback: () => { fetchAndShare(key, fetcher).then(resolve, reject); } };
      waiter.timer = timers.setTimeout(() => {
        const list = waiting.get(key) || [], index = list.indexOf(waiter);
        if (index < 0) return;
        list.splice(index, 1);
        if (!list.length) waiting.delete(key);
        waiter.fallback();
      }, wait);
      if (!waiting.has(key)) waiting.set(key, []);
      waiting.get(key).push(waiter);
      post({ type: 'want', key, kind, params });
    });
  }

  // Event stream (P9 feature "events"): only the leader connects and relays the invalidation pointers.
  function openStream() {
    if (source || !leader || !running || typeof Source !== 'function' || !liveFeatures(registry).has('events')) return;
    const { workspaceId, supportGrantId } = liveContext(registry);
    if (!workspaceId) return;
    const query = new URLSearchParams({ workspace: workspaceId, ...(supportGrantId ? { supportGrant: supportGrantId } : {}) });
    try { source = new Source(`/api/events?${query}`); } catch { source = null; return; }
    source.onopen = () => { stream = true; post({ type: 'stream', open: true }); reportLive('success', registry, now()); plan(); emit(); };
    source.onerror = () => {
      // A closed stream (401/403/429 before opening) is retried a minute later; the polls cover the gap.
      if (source?.readyState === 2) { try { source.close(); } catch {} source = null; streamRetryAt = now() + CADENCE.resync; }
      if (stream) { stream = false; post({ type: 'stream', open: false }); plan(); emit(); }
    };
    for (const name of ['inbox.changed', 'run.changed', 'attention.changed', 'channel.state', 'teamchat.message', 'reset']) {
      source.addEventListener?.(name, event => {
        let data = {};
        try { data = JSON.parse(event?.data || '{}'); } catch {}
        post({ type: 'event', name, data });
        handleEvent(name, data);
      });
    }
  }
  function closeStream() { if (source) { try { source.close(); } catch {} source = null; } stream = false; }
  function handleEvent(name, data) {
    reportLive('success', registry, now());
    if (name === 'reset') { cache.clear(); kick(); return; }
    if (name === 'inbox.changed' || name === 'run.changed') { cache.clear(); if (environment().view === 'inbox') kick('inbox'); }
    if (leader && pulse && ['attention.changed', 'channel.state', 'run.changed', 'inbox.changed'].includes(name)) kick('attention');
    for (const task of registry.tasks.values()) if (Array.isArray(task.events) && task.events.includes(name)) kick(task.name);
    emit({ event: name, data });
  }

  function connection() {
    if (!running) return null;
    const { lastSuccess, failures } = health();
    if (!online() || failures >= 3) return 'offline';
    if (stream) return 'live';
    if (!lastSuccess) return failures >= 2 ? 'late' : null;
    // A follower hears from the leader at its pulse (15 s): the margin keeps the dot from blinking.
    const expected = coordinated && !leader ? CADENCE.pulse : Math.min(CADENCE.pulse, ...allTasks().map(task => record(task.name).every).filter(Number.isFinite));
    return failures >= 2 || now() - lastSuccess > Math.max(LATE_AFTER, expected + 5000) ? 'late' : 'live';
  }
  function emit(extra = {}) { const value = { ...state(), ...extra }; for (const listener of listeners) try { listener(value); } catch {} }

  /** Starts the scheduler; a second start() is ignored. */
  function start() {
    if (running) return false;
    running = true; paused = false;
    registry.live = api;
    plan(); emit();
    return true;
  }
  /** Stops every timer and leaves the leadership. */
  function stop() {
    if (!running) return false;
    running = false;
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    resign(); scope = '';
    emit();
    return true;
  }
  /** Runs one task now (or every task without a name), as the next tick would; nothing while paused. */
  function kick(name) {
    const chosen = allTasks().filter(task => name === undefined || task.name === name);
    if (!chosen.length) return false;
    if (!running || paused) return true;
    syncScope();
    for (const task of chosen) {
      if (task === pulse && coordinated && !leader) post({ type: 'invalidate-attention' });
      else runTask(task);
    }
    plan();
    return true;
  }
  /** Session expired (elozi:reauth): nothing runs until resume() (elozi:reauth-ok). */
  function pause() { if (paused) return false; paused = true; for (const entry of records.values()) { entry.rerun = null; entry.forced = null; } if (timer !== null) { timers.clearTimeout(timer); timer = null; } emit(); return true; }
  function resume() { if (!paused) return false; paused = false; streamRetryAt = 0; if (running) kick(); emit(); return true; }
  /** "Tentar agora": skips the backoff wait and runs every task that has something to do now. */
  function retry() {
    if (!running || paused) return false;
    backoffFor = 0; backoff = 0;
    const env = environment();
    for (const task of allTasks()) if (cadenceOf(task, env, { withBackoff: false }) !== null) runTask(task);
    plan(); emit();
    return true;
  }
  /** Something changed outside (render, context, features): plan again without running anything. */
  function touch() { if (running && !paused) { plan(); emit(); } }
  function healthChanged(recovered, outcome) {
    if (recovered) { backoffFor = 0; backoff = 0; }
    if (outcome === 'success' && leader && coordinated && now() - lastBeat >= BEAT_EVERY) { lastBeat = now(); post({ type: 'beat' }); }
    if (running && !paused) plan();
    emit();
  }
  /** Whether a task is running now (data-source.js: only the inbox poll reuses a shared page). */
  function polling(name) { return Boolean(records.get(name)?.running); }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe needs a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  /** What the scheduler is doing; connection stays null (unknown) until something was measured. */
  function state() {
    return { running, paused, leader, coordinated, stream, connection: connection(), lastSuccess: health().lastSuccess || null, failures: health().failures,
      tasks: own.map(({ name, every }) => ({ name, every })) };
  }

  const api = { start, stop, kick, state, pause, resume, retry, shared, polling, subscribe, touch, healthChanged, get leader() { return leader; } };

  doc?.addEventListener?.('visibilitychange', () => {
    if (!running || paused) return;
    if (visible()) {
      for (const task of allTasks()) { const entry = record(task.name); if (entry.last === null || now() - entry.last >= 1000) entry.forced = now(); }
    }
    // The leader says whether the person looks at it; the tab the person came back to takes the lead
    // from a hidden leader (FRONTEND-V2 §7.1: pulse, sound and the event stream).
    if (leader && coordinated) post({ type: 'leader', visible: visible() });
    else leadIfLeaderHidden();
    plan(); emit();
  });
  if (win?.addEventListener) {
    win.addEventListener('online', () => { registry.health.failures = 0; backoffFor = 0; backoff = 0; if (running && !paused) kick(); emit(); });
    win.addEventListener('offline', () => emit());
    win.addEventListener('elozi:reauth', () => pause());
    win.addEventListener('elozi:reauth-ok', () => resume());
    win.addEventListener('pagehide', event => { if (!event?.persisted && running) { resign(); scope = ''; } });
  }
  if (typeof attention?.subscribe === 'function') attention.subscribe(snapshot => { if (leader && coordinated) post({ type: 'attention', snapshot }); });
  return api;
}

// ---------------------------------------------------------------------------------------------
// Drawers of the live layer (Pendências and Equipe, FRONTEND-V2 §2.3, §4.3, §6): a <dialog> outside
// #app, so render() never destroys it. Side drawer from 900 px (non-modal: the page stays usable) and
// a modal sheet below 900 px. One drawer at a time; Esc and the close button close it and the focus
// returns to the trigger. Namespaced data-action controls inside go through the actions registry
// (app.js only listens inside #app).
const DRAWER_MOBILE_QUERY = '(max-width: 899.98px)';
const drawers = new Map();
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * liveDrawer(name) → {open({title, body, actions, trigger, onClose}), update(body), close(), isOpen, element}.
 * title/body/actions are SafeHTML (h``) or escaped text. doc and matchMedia are injectable.
 */
export function liveDrawer(name, { doc = globalThis.document, matchMedia = globalThis.matchMedia } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(name))) throw new TypeError('liveDrawer needs a simple name');
  const key = `${name}`;
  if (drawers.has(key) && drawers.get(key).doc === doc) return drawers.get(key).api;
  let element = null, trigger = null, onClose = null, written = null;
  const mobile = () => { try { return Boolean(matchMedia?.(DRAWER_MOBILE_QUERY)?.matches); } catch { return false; } };
  const isOpen = () => Boolean(element?.open);
  function ensure() {
    if (element?.isConnected) return element;
    element = doc.createElement('dialog');
    element.className = 'lv-drawer';
    element.setAttribute('data-live-drawer', key);
    element.setAttribute('aria-labelledby', `lv-drawer-${key}-title`);
    element.addEventListener('close', () => {
      const back = trigger; trigger = null;
      const done = onClose; onClose = null;
      done?.();
      const target = back?.isConnected && !back.closest?.('[inert]') ? back : doc.getElementById('main-content');
      target?.focus?.({ preventScroll: true });
    });
    element.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); close(); }
    });
    element.addEventListener('click', event => {
      const target = event.target;
      if (target?.closest?.('[data-live-drawer-close]')) { event.preventDefault(); close(); return; }
      const control = target?.closest?.('[data-action]');
      if (control && element.contains(control) && isNamespacedName(control.dataset.action)) {
        event.preventDefault();
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') return;
        void dispatchAction(control.dataset.action, control, event);
        return;
      }
      if (target?.closest?.('a[href^="#"][data-live-drawer-dismiss]')) close();
    });
    doc.body.append(element);
    return element;
  }
  function open({ title, body = '', actions = '', trigger: opener = doc.activeElement, onClose: closed = null } = {}) {
    for (const other of drawers.values()) if (other.api !== api) other.api.close({ restoreFocus: false });
    const dialog = ensure();
    trigger = opener && opener !== doc.body ? opener : null;
    onClose = closed;
    dialog.setAttribute('data-sheet', mobile() ? 'true' : 'false');
    written = String(body ?? '');
    dialog.innerHTML = String(h`<div class="lv-drawer__panel"><header class="lv-drawer__header"><h2 class="lv-drawer__title" id="${`lv-drawer-${key}-title`}">${title}</h2><div class="lv-drawer__actions">${actions}</div><button type="button" class="ui-iconbtn ui-iconbtn--sm lv-drawer__close" data-live-drawer-close aria-label="${t('Fechar')}" title="${t('Fechar')}">${glyph('close')}</button></header><div class="lv-drawer__body" data-live-drawer-body>${body}</div></div>`);
    if (!dialog.open) {
      try { if (mobile()) dialog.showModal(); else dialog.show(); } catch { dialog.setAttribute('open', ''); }
    }
    const first = dialog.querySelector('[data-live-drawer-body]')?.querySelector?.('[autofocus]') || dialog.querySelector('.lv-drawer__close');
    first?.focus?.({ preventScroll: true });
    return dialog;
  }
  function update(body) {
    const host = element?.querySelector?.('[data-live-drawer-body]');
    if (!host) return false;
    // The browser serializes the markup its own way (<path/> → <path></path>): compare with what was
    // written, so an unchanged body keeps its nodes, the focus and the reading position.
    const markup = String(body ?? '');
    if (markup === written) return false;
    written = markup;
    const scroll = host.scrollTop, active = doc.activeElement, focusKey = host.contains(active) ? active?.getAttribute?.('data-focus-key') : null;
    host.innerHTML = markup;
    host.scrollTop = scroll;
    if (focusKey) host.querySelector(`[data-focus-key="${globalThis.CSS?.escape ? globalThis.CSS.escape(focusKey) : focusKey}"]`)?.focus?.({ preventScroll: true });
    return true;
  }
  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return false;
    if (!restoreFocus) trigger = null;
    element.close();
    return true;
  }
  const api = { open, update, close, get isOpen() { return isOpen(); }, get element() { return element; }, focusable: () => [...(element?.querySelectorAll?.(FOCUSABLE) || [])] };
  drawers.set(key, { doc, api });
  return api;
}
