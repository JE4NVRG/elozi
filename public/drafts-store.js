// Drafts of the reply composer (FRONTEND-V2 §7.2, §8.3 P2). sessionStorage only — never localStorage —
// under elozi:draft:v1:<userId>:<workspaceId>:<tenantId>:<conversationId> with {text, mode, updatedAt}:
//
// - a draft survives a reload of the tab and lives at most 24 h; at most `limit` (200) per scope;
// - every store created purges the expired drafts and the drafts of another person (user change);
// - clear() runs wherever the inbox drops every draft (logout, workspace or access change, 401/403 on
//   the list) and removes the drafts of its scope, except while a re-authentication is pending
//   (session-guard.js holds it): the text typed before a 401 is never lost;
// - logout clears every draft of the tab (clearDraftsStorage(), called by the logout reset of
//   team-chat-ui.js, also when the inbox store was never created on this page) and stops the flush
//   for the rest of the page; the login page never touches storage, and another person signing in
//   purges the previous person's drafts;
// - an empty composer removes a stored draft only after this page has shown or written it: after a
//   reload the inbox may save the still-empty composer before reading the draft back, and the text
//   must survive that (it comes back when the conversation is opened again);
// - the composer (#message-text) is flushed into the store when the tab is hidden or closed, under the
//   conversation it was drawn for: the deep link (#inbox/<t>/<c>) at the time it was drawn. When the
//   hash moves (hashchange) before the next conversation is drawn, the composer on screen keeps the
//   route it left (rememberComposerRoute), so its text never lands in the conversation being opened.
//   Without an inbox store on this page the flush uses the scope of live.js (person and workspace).
// Without sessionStorage (private modes, tests) the store keeps the drafts in memory, as before.
// Attachments stay in memory only (media-ui.js).
import { parseHash } from './router.js';
import { liveContext } from './live.js';

export const DRAFT_PREFIX = 'elozi:draft:v1:';
export const DRAFT_TTL = 24 * 60 * 60 * 1000;
const MAX_TEXT = 4000;
let held = false, latest = null, closed = false;
// Keys of each storage that this page has shown (get/entry) or written: only those may be removed by
// an empty composer. Composer element → route it was drawn for (set when the hash leaves it).
const shownByStorage = new WeakMap(), drawnFor = new WeakMap();
const shownIn = storage => { let keys = shownByStorage.get(storage); if (!keys) shownByStorage.set(storage, keys = new Set()); return keys; };
const routeOfUrl = url => { const value = String(url ?? ''), mark = value.indexOf('#'); return mark < 0 ? null : parseHash(value.slice(mark)); };
const defaultStorage = () => { try { const storage = globalThis.sessionStorage; storage?.length; return storage || null; } catch { return null; } };
const part = value => encodeURIComponent(String(value ?? ''));
const conversationOf = ref => ref?.conversationId || ref?.id || '';

/** While true (re-authentication pending), clear() keeps the stored drafts. */
export function holdDrafts(value) { held = Boolean(value); }
/** Removes every draft of this tab (logout, another person signed in); nothing is flushed afterwards on this page. */
export function clearDraftsStorage(storage = defaultStorage()) {
  closed = true;
  if (!storage) return 0;
  let removed = 0;
  try {
    for (const key of keysOf(storage)) if (key.startsWith(DRAFT_PREFIX)) { storage.removeItem(key); removed++; }
  } catch {}
  return removed;
}
function keysOf(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key) keys.push(key); }
  return keys;
}
function parseEntry(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value.text === 'string' && Number.isFinite(value.updatedAt) ? { text: value.text, mode: value.mode === 'note' ? 'note' : 'reply', updatedAt: value.updatedAt } : null;
  } catch { return null; }
}

/** createDraftsStore({userId, workspaceId, limit}) → {get, entry, set, delete, retain, clear, flush, size}. */
export function createDraftsStore({ userId = '', workspaceId = '', limit = 200, storage = defaultStorage(), now = () => Date.now() } = {}) {
  const scope = `${DRAFT_PREFIX}${part(userId)}:${part(workspaceId)}:`;
  const keyOf = ref => ref?.tenantId && conversationOf(ref) ? `${scope}${part(ref.tenantId)}:${part(conversationOf(ref))}` : '';
  const memory = new Map();
  const persistent = Boolean(storage), shown = persistent ? shownIn(storage) : new Set();
  closed = false;
  const read = key => persistent ? parseEntry(storage.getItem(key)) : memory.get(key) || null;
  const write = (key, value) => { if (persistent) storage.setItem(key, JSON.stringify(value)); else memory.set(key, value); };
  const remove = key => { if (persistent) { const had = storage.getItem(key) !== null; storage.removeItem(key); return had; } return memory.delete(key); };
  const own = () => persistent ? keysOf(storage).filter(key => key.startsWith(scope)) : [...memory.keys()];
  const fresh = entry => entry && now() - entry.updatedAt <= DRAFT_TTL;

  // Purge: expired drafts and the drafts of another person (the key carries the person).
  if (persistent) try {
    const mine = `${DRAFT_PREFIX}${part(userId)}:`;
    for (const key of keysOf(storage)) {
      if (!key.startsWith(DRAFT_PREFIX)) continue;
      if (userId && !key.startsWith(mine) || !fresh(parseEntry(storage.getItem(key)))) storage.removeItem(key);
    }
  } catch {}

  const store = {
    userId, workspaceId, limit, persistent,
    /** Text kept for {tenantId, conversationId} ('' when none or expired). */
    get(ref) { const entry = store.entry(ref); return entry ? entry.text : ''; },
    /** {text, mode, updatedAt} of a conversation, or null. */
    entry(ref) {
      const key = keyOf(ref);
      if (!key) return null;
      try { const entry = read(key); if (fresh(entry)) { shown.add(key); return entry; } if (entry) remove(key); } catch {}
      return null;
    },
    /** Keeps the text (empty text removes it); false when a new conversation would pass the limit or storage refuses. */
    set(ref, text, { mode = 'reply' } = {}) {
      const key = keyOf(ref);
      if (!key) return true;
      const value = String(text ?? '').slice(0, MAX_TEXT);
      try {
        if (!value) {
          // A draft of an earlier load that this page never showed stays: the composer is empty only
          // because the draft was not read back yet (reload), not because the person cleared it.
          if (persistent && !shown.has(key) && fresh(read(key))) return true;
          remove(key); return true;
        }
        if (!read(key) && own().length >= limit) return false;
        write(key, { text: value, mode: mode === 'note' ? 'note' : 'reply', updatedAt: now() });
        shown.add(key);
        return true;
      } catch { return false; }
    },
    delete(ref) { const key = keyOf(ref); try { return key ? remove(key) : false; } catch { return false; } },
    /** Keeps only the drafts of `tenantId` whose conversation is in `ids` (other companies untouched). */
    retain(tenantId, ids = []) {
      const allowed = new Set(ids.map(String)), prefix = `${scope}${part(tenantId)}:`;
      try { for (const key of own()) if (key.startsWith(prefix) && !allowed.has(decodeURIComponent(key.slice(prefix.length)))) remove(key); } catch {}
    },
    /** Drops every draft of this scope, unless a re-authentication is pending (session-guard.js). */
    clear() {
      if (held) return false;
      try { for (const key of own()) remove(key); } catch {}
      if (latest === store) latest = null;
      return true;
    },
    /**
     * Saves the composer before the tab leaves, under the conversation it was drawn for: the route it
     * kept when the hash moved away (rememberComposerRoute), else the deep link (#inbox/<t>/<c>).
     */
    flush(doc = globalThis.document) {
      const field = doc?.getElementById?.('message-text');
      if (!field || field.disabled) return false;
      const route = drawnFor.has(field) ? drawnFor.get(field) : parseHash(doc?.defaultView?.location?.hash ?? globalThis.location?.hash ?? '');
      if (route?.section !== 'inbox' || !route.params?.conversationId) return false;
      if (route.workspaceId && route.workspaceId !== workspaceId) return false;
      return store.set({ tenantId: route.params.tenantId, conversationId: route.params.conversationId }, field.value);
    },
    get size() { try { return own().length; } catch { return 0; } }
  };
  latest = store;
  return store;
}

/**
 * The hash moved from oldURL: the composer on screen was drawn for that route and keeps it until the
 * next conversation is drawn (a new element), whatever the hash says meanwhile (hashchange listener).
 */
export function rememberComposerRoute(oldURL, doc = globalThis.document) {
  const field = doc?.getElementById?.('message-text');
  if (!field || drawnFor.has(field)) return false;
  drawnFor.set(field, routeOfUrl(oldURL));
  return true;
}

/**
 * Saves the composer into the store of the current scope when the tab is hidden or closed: the inbox
 * store, or one of the person and workspace of live.js when the inbox has none yet (reload). Nothing
 * after a logout (clearDraftsStorage) on this page.
 */
export function flushDrafts(doc = globalThis.document, registry) {
  if (closed) return false;
  try {
    const c = liveContext(registry);
    let store = latest;
    if (c.userId && c.workspaceId && (store?.userId !== c.userId || store?.workspaceId !== c.workspaceId)) store = createDraftsStore({ userId: String(c.userId), workspaceId: String(c.workspaceId) });
    return Boolean(store?.flush(doc));
  } catch { return false; }
}
if (globalThis.document?.addEventListener) {
  globalThis.document.addEventListener('visibilitychange', () => { if (globalThis.document.visibilityState === 'hidden') flushDrafts(); });
  globalThis.addEventListener?.('pagehide', () => flushDrafts());
  globalThis.addEventListener?.('hashchange', event => { try { rememberComposerRoute(event?.oldURL); } catch {} });
}
