import { ID_PATTERN, INBOX_STATUSES, INBOX_SORTS } from './router.js';

const isId = value => typeof value === 'string' && ID_PATTERN.test(value) && !/\p{Cc}/u.test(value);
const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const lenses = ['all', 'mine', 'queue', 'agent'];
function validate(q) {
  if (['tenant', 'channel', 'department', 'assignedUser'].some(name => q[name] !== undefined && !isId(q[name]))
    || q.department === 'all' || q.assignedUser === 'all') fail('INBOX_ROUTE_ID');
  if (q.lens !== undefined && !lenses.includes(q.lens)
    || q.kind !== undefined && !['direct', 'group'].includes(q.kind)
    || q.unread !== undefined && q.unread !== '1'
    || q.status !== undefined && !INBOX_STATUSES.includes(q.status)
    || q.sort !== undefined && !INBOX_SORTS.includes(q.sort)
    || q.q !== undefined && (typeof q.q !== 'string' || !q.q.length || q.q.length > 200 || /\p{Cc}/u.test(q.q))) fail('INBOX_ROUTE_QUERY', 400);
}

/**
 * Complete pure list snapshot, with app.js state names. Absent URL fields reset.
 * knownAuthorizedRows is the CURRENT /api/inbox catalog: {workspaceId, tenants:[{id}],
 * channels:[{tenantId,id}], departments:[{tenantId,id}], assignees:[{tenantId,id}]}.
 * Never supply conversations/items, boot users or an unscoped DTO as authorization.
 * Invalidate on workspace/user/grant/permissions changes. currentScope is
 * {workspaceId, defaultLens}. Null means not a list route; errors THROW before any
 * snapshot is applied. Missing catalogs are retryable 409, not permission to broaden.
 * Department/channel IDs infer only a unique authorized tenant and must agree.
 * Assignees are checked within that tenant, or the authorized workspace when all.
 * 'unassigned' is the existing department sentinel, not an inferred tenant.
 */
export function inboxRouteFilters(parsedRoute, knownAuthorizedRows, currentScope = {}) {
  if (parsedRoute?.section !== 'inbox' || parsedRoute.params?.conversationId) return null;
  const scope = currentScope.workspaceId;
  if (!isId(scope) || parsedRoute.workspaceId && parsedRoute.workspaceId !== scope) fail('INBOX_ROUTE_WORKSPACE');
  const q = parsedRoute.query || {};
  validate(q);
  const filter = q.lens ?? currentScope.defaultLens;
  if (!lenses.includes(filter)) fail('INBOX_ROUTE_DEFAULT_LENS', 400);
  const next = { inboxCompany: 'all', assignedUser: q.assignedUser ?? 'all', filter, search: q.q ?? '',
    channel: 'all', status: q.status ?? 'active', unread: q.unread === '1', department: q.department === 'unassigned' ? 'unassigned' : 'all',
    kind: q.kind ?? 'all', sort: q.sort ?? 'recent', kindFromLink: q.kind !== undefined, inboxContactFocus: null };
  const needsDepartment = q.department !== undefined && q.department !== 'unassigned';
  if (!q.tenant && !q.channel && !needsDepartment && !q.assignedUser) return next;
  if (knownAuthorizedRows?.workspaceId !== scope || !Array.isArray(knownAuthorizedRows?.tenants)) fail('INBOX_ROUTE_CATALOG_UNAVAILABLE', 409);
  const tenants = new Set(knownAuthorizedRows.tenants.filter(row => isId(row?.id) && (!row.workspaceId || row.workspaceId === scope)).map(row => row.id));
  if (q.tenant && !tenants.has(q.tenant)) fail('INBOX_ROUTE_TENANT');
  if (q.tenant) next.inboxCompany = q.tenant;
  const rowsFor = name => {
    if (!Array.isArray(knownAuthorizedRows[name])) fail('INBOX_ROUTE_CATALOG_UNAVAILABLE', 409);
    return knownAuthorizedRows[name].filter(row => isId(row?.tenantId) && tenants.has(row.tenantId)
      && (!row.workspaceId || row.workspaceId === scope));
  };
  const resolve = (name, rowsName) => {
    const code = 'INBOX_ROUTE_' + name.toUpperCase();
    const matches = new Map();
    for (const row of rowsFor(rowsName)) {
      if (row.id !== q[name] || next.inboxCompany !== 'all' && row.tenantId !== next.inboxCompany) continue;
      matches.set(JSON.stringify([row.tenantId, row.id]), row);
    }
    if (matches.size !== 1) fail(matches.size ? code + '_AMBIGUOUS' : code);
    const [value, row] = matches.entries().next().value;
    next.inboxCompany = row.tenantId;
    next[name] = value; // Exact JSON pair consumed by inboxChoice()/inboxQuery().
  };
  if (q.channel) resolve('channel', 'channels');
  if (needsDepartment) resolve('department', 'departments');
  if (q.assignedUser && !rowsFor('assignees').some(row => row.id === q.assignedUser
    && (next.inboxCompany === 'all' || row.tenantId === next.inboxCompany))) fail('INBOX_ROUTE_ASSIGNEE');
  return next;
}

/**
 * Pure state -> router query. Does NOT grant authorization: always feed the parsed
 * result back through inboxRouteFilters with a fresh catalog before applying it.
 * Defaults omit new fields, so old list URLs retain their existing grammar.
 * Pair choices must carry their tenant; malformed/conflicting state throws.
 */
export function inboxFilterQuery(state = {}) {
  const q = {};
  if (state.filter !== undefined) q.lens = state.filter;
  if (state.inboxCompany !== undefined && state.inboxCompany !== 'all') q.tenant = state.inboxCompany;
  if (state.search !== undefined && state.search !== '') q.q = state.search;
  if (state.unread !== undefined && typeof state.unread !== 'boolean') fail('INBOX_ROUTE_QUERY', 400);
  if (state.unread) q.unread = '1';
  if (state.kind !== undefined && state.kind !== 'all') q.kind = state.kind;
  if (state.status !== undefined && state.status !== 'active') q.status = state.status;
  if (state.sort !== undefined && state.sort !== 'recent') q.sort = state.sort;
  if (state.assignedUser !== undefined && state.assignedUser !== 'all') q.assignedUser = state.assignedUser;
  for (const name of ['channel', 'department']) {
    const value = state[name];
    if (value === undefined || value === 'all') continue;
    if (name === 'department' && value === 'unassigned') { q.department = value; continue; }
    let pair;
    try { pair = JSON.parse(value); } catch { fail('INBOX_ROUTE_ID'); }
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isId)) fail('INBOX_ROUTE_ID');
    if (q.tenant !== undefined && q.tenant !== pair[0]) fail('INBOX_ROUTE_TENANT');
    q.tenant = pair[0]; q[name] = pair[1];
  }
  validate(q);
  return q;
}
