// GETs of the live poll (FRONTEND-V2 §7.1, §7.4, §8.3 P2). The callers (the poll in app.js and
// consolidated-inbox-ui.js) keep the shapes of today; this module decides how each GET is made:
//
// - Each request reports its outcome to live.js (last success and consecutive failures feed the
//   connection indicator and the backoff). 403/404/409 say nothing about the connection.
// - The inbox page is shared between the tabs of the same person and workspace (live.shared): the
//   leader fetches each distinct page once and broadcasts it. Only the inbox poll reuses a shared copy:
//   a page asked outside it (after Assumir, a send, "Atualizar") is fetched now and shared fresh. A
//   browser without locks or BroadcastChannel keeps one request per tab, exactly as before.
// - Adapters for the features of GET /api/bootstrap (liveFeatures()):
//   · "inbox-since": GET /api/inbox?…&since=<revision> → {unchanged:true} reuses the page already held;
//   · "conversation-delta" (or "conversation-page"): conversationPage() reads
//     /api/tenants/:id/conversations/:cid?after|before=<messageId>|version=<n>&limit=… and
//     "tenant-summary": tenantSummary() reads /api/tenants/:id?summary=1 — both offered to the owner
//     of the poll (P3): tenant() keeps the full DTO because app.js still reads every message of it.
//   Without a feature the request below stays the one of today.
import { CADENCE, countsAsFailure, currentLive, liveContext, liveFeatures, liveRegistry, registerLiveHandler, reportLive } from './live.js';

const encode = value => encodeURIComponent(String(value ?? ''));
const options = (workspaceId, signal) => ({ ...(signal ? { signal } : {}), headers: { 'X-Elozi-Workspace': workspaceId } });
const SINCE_LIMIT = 20;
/** Paths the leader accepts to fetch for another tab: only inbox pages of the same workspace. */
export const sharedInboxPath = path => typeof path === 'string' && /^\/api\/inbox\?[^#\s]*$/.test(path) && path.length <= 2000;

/**
 * createDataSource({request}) → {inboxPage, tenant, conversation, conversationPage, tenantSummary, features}.
 * request is the api() of app.js. live and registry are injectable for tests (one per simulated tab).
 */
export function createDataSource({ request, live = null, registry = liveRegistry, now = () => Date.now() } = {}) {
  if (typeof request !== 'function') throw new TypeError('createDataSource needs request()');
  const revisions = new Map();
  const hub = () => live || currentLive(registry);
  const has = name => liveFeatures(registry).has(name);

  function track(promise) {
    return promise.then(value => { reportLive('success', registry, now()); return value; }, error => {
      if (countsAsFailure(error)) reportLive('failure', registry, now());
      throw error;
    });
  }

  // "inbox-since": the server answers {unchanged:true, revision} when the page did not change.
  async function inboxSince(path, workspaceId, signal) {
    const key = `${workspaceId}\n${path}`, last = revisions.get(key);
    const result = await request(last ? `${path}${path.includes('?') ? '&' : '?'}since=${encode(last.revision)}` : path, options(workspaceId, signal));
    if (result?.unchanged === true && last && (!result.revision || result.revision === last.revision)) return last.page;
    if (result && typeof result.revision === 'string' && Array.isArray(result.items)) {
      revisions.delete(key);
      revisions.set(key, { revision: result.revision, page: result });
      while (revisions.size > SINCE_LIMIT) revisions.delete(revisions.keys().next().value);
    } else revisions.delete(key);
    if (result?.unchanged === true) return request(path, options(workspaceId, signal));
    return result;
  }
  const fetchInbox = (path, workspaceId, signal) => has('inbox-since') ? inboxSince(path, workspaceId, signal) : request(path, options(workspaceId, signal));

  // The leader fetches an inbox page for another tab only for its own workspace.
  registerLiveHandler('inbox', {
    accept: params => sharedInboxPath(params?.path) && Boolean(params?.workspaceId) && params.workspaceId === liveContext(registry).workspaceId,
    fetch: params => track(fetchInbox(params.path, params.workspaceId))
  }, registry);

  return {
    /** Page of /api/inbox for a path built by inboxQuery() → the page DTO (items, totals, countTabs). */
    inboxPage(path, { workspaceId, signal } = {}) {
      const scheduler = hub();
      if (!signal && workspaceId && sharedInboxPath(path) && typeof scheduler?.shared === 'function') {
        // Only the inbox poll reuses a shared copy; a page asked after an action of the person is fetched now.
        const reuse = typeof scheduler.polling === 'function' ? scheduler.polling('inbox') : true;
        return scheduler.shared(`inbox\n${workspaceId}\n${path}`, () => track(fetchInbox(path, workspaceId)), { kind: 'inbox', params: { path, workspaceId }, maxAge: CADENCE.inbox - 500, reuse });
      }
      return track(fetchInbox(path, workspaceId, signal));
    },
    /** Tenant DTO of the open company (conversations with messages, runs, agents, channels). */
    tenant(tenantId, { workspaceId, signal } = {}) { return track(request(`/api/tenants/${encode(tenantId)}`, options(workspaceId, signal))); },
    /** Scoped runs DTO ({runs}) of the open conversation, refreshed by the poll on its own. */
    conversation(tenantId, conversationId, { workspaceId, signal } = {}) {
      return track(request(`/api/tenants/${encode(tenantId)}/conversations/${encode(conversationId)}/runs`, options(workspaceId, signal)));
    },
    /**
     * Page of one conversation (feature "conversation-page" or "conversation-delta", §7.4): after a
     * message id brings the new ones, before an id the older ones. Resolves null when the backend
     * does not list the feature, so the caller keeps reading the tenant DTO as today.
     */
    conversationPage(tenantId, conversationId, { workspaceId, after, before, version, limit = 50, signal } = {}) {
      if (!has('conversation-page') && !has('conversation-delta')) return Promise.resolve(null);
      const query = new URLSearchParams({ limit: String(Math.min(60, Math.max(1, Number(limit) || 50))) });
      if (after) query.set('after', String(after)); else if (before) query.set('before', String(before));
      if (Number.isSafeInteger(version)) query.set('version', String(version));
      return track(request(`/api/tenants/${encode(tenantId)}/conversations/${encode(conversationId)}?${query}`, options(workspaceId, signal)));
    },
    /**
     * Summary of a company (feature "tenant-summary"): conversations without messages (lastMessage and
     * messageCount), active runs plus the latest 50. Null without the feature, so the caller keeps tenant().
     */
    tenantSummary(tenantId, { workspaceId, signal } = {}) {
      if (!has('tenant-summary')) return Promise.resolve(null);
      return track(request(`/api/tenants/${encode(tenantId)}?summary=1`, options(workspaceId, signal)));
    },
    /** Features of the current workspace (a copy; empty until known). */
    features() { return new Set(liveFeatures(registry)); }
  };
}
