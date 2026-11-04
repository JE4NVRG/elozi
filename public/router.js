// Hash grammar of the panel (FRONTEND-V2 §2.4). Pure functions, no DOM: parseHash, formatHash and
// registerAlias. Routes keep the legacy form '#section/...' (never '#/' or '#/w/'):
//
//   #overview
//   Advanced list filters: status=active|all|open|pending|closed, sort=recent|oldest|unread,
//   department=<id>|unassigned, assignedUser=<id> (authorized catalog required for IDs).
//   #inbox[?lens=all|mine|queue|agent&kind=direct|group&unread=1&tenant=<id>&channel=<id>&q=<texto>]
//   #inbox/<tenantId>/<conversationId>[?run=<runId>|m=<messageId>]
//   #contacts[/<tenantId>/<contactId>]
//   #agents[/knowledge|tools|activity|usage]                       hub tab
//   #agents/<agentId>[/overview|instructions|tools|knowledge|memory|access|usage|activity]
//   #agents/connect[/identity|goal|access|key|configure|verify]
//   #pending[/<type>/<id>]                                         approval|handoff|proposal|parked|waiting|channel|quota
//   #automation[/rules|flows|replies][/<id>]
//   #channels[/<channelId>[/connect|test|groups]] · #channels/new/<kind>
//   #metrics[/attendance|sla|agents] · #accounts[/<accountId>] · #settings/<tab> · #platform/<tab>
//   #account · #help[/<topic>] · #team-chat[/<roomId>] · #setup
//   any route: ?w=<workspaceId>   (the app asks before switching workspace; never switches alone)
//
// A route is a plain object { section, params, query, workspaceId, alias }. Reserved words used as
// tabs ('knowledge', 'connect', 'new', …) never collide with IDs in the same position. IDs are
// percent-encoded on format and must match ID_PATTERN once decoded; anything else is not a route.
// Legacy hashes ('#knowledge', '#tenants', …) are aliases registered by nav-config.js; the last
// registration of a name wins, so a later package can repoint an alias (P3: '#groups').

export const INBOX_STATUSES = Object.freeze(['active', 'all', 'open', 'pending', 'closed']);
export const INBOX_SORTS = Object.freeze(['recent', 'oldest', 'unread']);
const ADVANCED_INBOX_FILTERS = ['status', 'department', 'assignedUser', 'sort'];

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
const isId = value => typeof value === 'string' && ID_PATTERN.test(value);
const oneOf = list => value => list.includes(value);

export const AGENT_HUB_TABS = Object.freeze(['knowledge', 'tools', 'activity', 'usage']);
export const AGENT_TABS = Object.freeze(['overview', 'instructions', 'tools', 'knowledge', 'memory', 'access', 'usage', 'activity']);
export const CONNECT_STEPS = Object.freeze(['identity', 'goal', 'access', 'key', 'configure', 'verify']);
export const PENDING_TYPES = Object.freeze(['approval', 'handoff', 'proposal', 'parked', 'waiting', 'channel', 'quota']);
export const AUTOMATION_TABS = Object.freeze(['rules', 'flows', 'replies']);
export const METRICS_TABS = Object.freeze(['attendance', 'sla', 'agents']);
export const SETTINGS_TABS = Object.freeze(['companies', 'team', 'brand', 'support', 'billing', 'activity']);
export const PLATFORM_TABS = Object.freeze(['overview', 'accounts', 'products', 'users', 'billing', 'integrations', 'health']);
const CHANNEL_TABS = Object.freeze(['connect', 'test', 'groups', 'visitor']);

// Each section turns its decoded path segments into params, or null when they are not a route.
// format() returns the canonical segments of params produced by parse().
const SECTIONS = {
  overview: { parse: s => s.length ? null : {}, format: () => [] },
  inbox: {
    parse: s => !s.length ? {} : s.length === 2 && isId(s[0]) && isId(s[1]) ? { tenantId: s[0], conversationId: s[1] } : null,
    format: p => p.tenantId || p.conversationId ? [p.tenantId, p.conversationId] : [],
    query: {
      lens: oneOf(['all', 'mine', 'queue', 'agent']), kind: oneOf(['direct', 'group']), unread: oneOf(['1']),
      tenant: isId, channel: isId,
      status: oneOf(INBOX_STATUSES), department: value => isId(value) && value !== 'all' && !/\p{Cc}/u.test(value), assignedUser: value => isId(value) && value !== 'all' && !/\p{Cc}/u.test(value), sort: oneOf(INBOX_SORTS), q: value => value.length > 0 && value.length <= 200 && !/\p{Cc}/u.test(value), run: isId, m: isId
    }
  },
  contacts: {
    parse: s => !s.length ? {} : s.length === 2 && isId(s[0]) && isId(s[1]) ? { tenantId: s[0], contactId: s[1] } : null,
    format: p => p.tenantId || p.contactId ? [p.tenantId, p.contactId] : []
  },
  agents: {
    parse(s) {
      if (!s.length) return {};
      if (s[0] === 'connect') return s.length === 1 ? { tab: 'connect' } : s.length === 2 && CONNECT_STEPS.includes(s[1]) ? { tab: 'connect', step: s[1] } : null;
      if (AGENT_HUB_TABS.includes(s[0])) return s.length === 1 ? { tab: s[0] } : null;
      if (!isId(s[0])) return null;
      return s.length === 1 ? { agentId: s[0] } : s.length === 2 && AGENT_TABS.includes(s[1]) ? { agentId: s[0], agentTab: s[1] } : null;
    },
    format: p => p.tab === 'connect' ? ['connect', ...(p.step ? [p.step] : [])] : p.agentId ? [p.agentId, ...(p.agentTab ? [p.agentTab] : [])] : p.tab ? [p.tab] : []
  },
  pending: {
    parse: s => !s.length ? {} : s.length === 2 && PENDING_TYPES.includes(s[0]) && isId(s[1]) ? { type: s[0], id: s[1] } : null,
    format: p => p.type || p.id ? [p.type, p.id] : []
  },
  automation: {
    parse: s => !s.length ? {} : AUTOMATION_TABS.includes(s[0]) && s.length <= 2 && (s.length === 1 || isId(s[1])) ? { tab: s[0], ...(s.length === 2 ? { id: s[1] } : {}) } : null,
    format: p => p.tab ? [p.tab, ...(p.id ? [p.id] : [])] : []
  },
  channels: {
    parse(s) {
      if (!s.length) return {};
      if (s[0] === 'new') return s.length === 2 && SLUG.test(s[1]) ? { kind: s[1] } : null;
      if (!isId(s[0])) return null;
      return s.length === 1 ? { channelId: s[0] } : s.length === 2 && CHANNEL_TABS.includes(s[1]) ? { channelId: s[0], tab: s[1] } : null;
    },
    format: p => p.kind ? ['new', p.kind] : p.channelId ? [p.channelId, ...(p.tab ? [p.tab] : [])] : []
  },
  metrics: { parse: s => !s.length ? {} : s.length === 1 && METRICS_TABS.includes(s[0]) ? { tab: s[0] } : null, format: p => p.tab ? [p.tab] : [] },
  accounts: { parse: s => !s.length ? {} : s.length === 1 && isId(s[0]) ? { accountId: s[0] } : null, format: p => p.accountId ? [p.accountId] : [] },
  settings: { parse: s => !s.length ? {} : s.length === 1 && SETTINGS_TABS.includes(s[0]) ? { tab: s[0] } : null, format: p => p.tab ? [p.tab] : [] },
  platform: { parse: s => !s.length ? {} : s.length === 1 && PLATFORM_TABS.includes(s[0]) ? { tab: s[0] } : null, format: p => p.tab ? [p.tab] : [] },
  account: { parse: s => s.length ? null : {}, format: () => [] },
  help: { parse: s => !s.length ? {} : s.length === 1 && SLUG.test(s[0]) ? { topic: s[0] } : null, format: p => p.topic ? [p.topic] : [] },
  'team-chat': { parse: s => !s.length ? {} : s.length === 1 && isId(s[0]) ? { roomId: s[0] } : null, format: p => p.roomId ? [p.roomId] : [] },
  setup: { parse: s => s.length ? null : {}, format: () => [] },
  // Legacy screen kept as its own route until P3 registers the alias #groups → #inbox?kind=group.
  groups: { parse: s => s.length ? null : {}, format: () => [] }
};
export const ROUTE_SECTIONS = Object.freeze(Object.keys(SECTIONS));
// Sections that an alias may replace (the legacy screens that move elsewhere later).
const REPLACEABLE_SECTIONS = new Set(['groups']);
const aliases = new Map();

function split(hash) {
  let value = String(hash ?? '');
  if (value.startsWith('#')) value = value.slice(1);
  if (!value || value.startsWith('/') || value.length > 2048) return null;
  const mark = value.indexOf('?');
  const path = mark < 0 ? value : value.slice(0, mark), search = mark < 0 ? '' : value.slice(mark + 1);
  let segments;
  try { segments = path.split('/').map(decodeURIComponent); } catch { return null; }
  if (segments.some(segment => !segment)) return null;
  // URLSearchParams repairs malformed escapes/UTF-8. New filters must not lose intent.
  if (segments[0] === 'inbox' || aliases.has(segments[0])) {
    for (const part of search.split('&')) {
      const mark = part.indexOf('='), rawName = mark < 0 ? part : part.slice(0, mark);
      let name;
      try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')); } catch { continue; }
      if (ADVANCED_INBOX_FILTERS.includes(name)) {
        try { decodeURIComponent((mark < 0 ? '' : part.slice(mark + 1)).replace(/\+/g, ' ')); } catch { return null; }
      }
    }
  }
  return { segments, search: new URLSearchParams(search) };
}

function readQuery(section, search) {
  const rules = SECTIONS[section].query || {}, query = {};
  if (section === 'inbox' && ADVANCED_INBOX_FILTERS.some(name => search.has(name)
    && (search.getAll(name).length !== 1 || !rules[name](search.get(name))))) return null;
  for (const [name, accept] of Object.entries(rules)) {
    const value = search.get(name);
    if (typeof value === 'string' && accept(value)) query[name] = value;
  }
  const workspace = search.get('w');
  return { query, workspaceId: isId(workspace) ? workspace : null };
}

function grammar(segments, search) {
  const [section, ...rest] = segments;
  if (!Object.hasOwn(SECTIONS, section)) return null;
  const params = SECTIONS[section].parse(rest);
  if (!params) return null;
  const query = readQuery(section, search);
  return query && { section, params, ...query, alias: null };
}

/** '#inbox/t/c?run=r' → { section:'inbox', params:{tenantId,conversationId}, query:{run}, workspaceId, alias } or null. */
export function parseHash(hash) {
  const parts = split(hash);
  if (!parts) return null;
  const [name] = parts.segments;
  if (parts.segments.length === 1 && aliases.has(name)) {
    if (ADVANCED_INBOX_FILTERS.some(key => parts.search.getAll(key).length > 1)) return null;
    const target = split(aliases.get(name));
    for (const [key, value] of parts.search) target.search.set(key, value);
    const route = grammar(target.segments, target.search);
    return route && { ...route, alias: name };
  }
  return grammar(parts.segments, parts.search);
}

/** Canonical hash ('#…') of a route; throws when the route is not one parseHash accepts. */
export function formatHash(route) {
  const section = route?.section;
  if (!Object.hasOwn(SECTIONS, section)) throw new TypeError('Rota desconhecida: ' + section);
  const segments = SECTIONS[section].format(route.params || {});
  const search = new URLSearchParams();
  const rules = SECTIONS[section].query || {};
  if (section === 'inbox' && ADVANCED_INBOX_FILTERS.some(name => route.query?.[name] !== undefined
    && (typeof route.query[name] !== 'string' || !rules[name](route.query[name])))) throw new TypeError('Filtro inbox inválido');
  for (const name of Object.keys(rules)) { const value = route.query?.[name]; if (value !== undefined && value !== null && value !== '') search.set(name, String(value)); }
  if (route.workspaceId) search.set('w', route.workspaceId);
  const query = search.toString();
  const hash = '#' + [section, ...segments.map(segment => encodeURIComponent(segment ?? ''))].join('/') + (query ? '?' + query : '');
  // Only hashes that parse back to the same params, query and workspace are produced.
  const check = split(hash), parsed = check && grammar(check.segments, check.search);
  const same = (given, read) => Object.entries(given || {}).every(([name, value]) => value === undefined || value === null || value === '' || read[name] === String(value));
  if (!parsed || !same(route.params, parsed.params) || !same(route.query, parsed.query) || (route.workspaceId || null) !== parsed.workspaceId) throw new TypeError('Rota inválida: ' + hash);
  return hash;
}

/**
 * Registers a legacy single-segment hash ('knowledge') as an alias of a route hash
 * ('#agents/knowledge'). The query of the legacy link is kept (e.g. ?w=). Last registration wins.
 */
export function registerAlias(name, target) {
  if (!SLUG.test(String(name)) || Object.hasOwn(SECTIONS, name) && !REPLACEABLE_SECTIONS.has(name)) throw new TypeError('Alias inválido: ' + name);
  const parts = split(target);
  if (!parts || !grammar(parts.segments, parts.search)) throw new TypeError('Destino de alias inválido: ' + target);
  aliases.set(name, String(target).startsWith('#') ? String(target) : '#' + target);
}

/** Registered aliases as [name, targetHash] pairs (for tests and the command palette). */
export function aliasEntries() { return [...aliases]; }
