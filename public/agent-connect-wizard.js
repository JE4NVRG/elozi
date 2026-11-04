import { h, raw, t, labels, getLocale, translateError } from './i18n.js';
import './locales-agent-connect.js';
import { button, badge, avatar, banner, emptyState, tabs, tabPanel, companyMark, attributes, toasts } from './ui.js';
import { glyph } from './icons.js';
import { CONNECT_STEPS, formatHash, parseHash } from './router.js';
import { MCP_CAPABILITIES, MCP_PLANNED_CAPABILITIES, MCP_CAPABILITY_LABELS, MCP_TOOL_LABELS, toolsForCapabilities, plannedToolsForCapabilities, acceptedCapabilities } from './mcp-catalog.js';

// "Conectar meu agente" (#agents/connect[/<step>], FRONTEND-V2 §5.3.3, §8.7). Owned by P6.
//
// Contract (§8.2): createAgentConnectWizard(deps) → {view(route), act, submit, reset, mount}. act/submit
// answer the 'connect:*' actions and the data-form="connect:<step>" forms through actions.js; mount(main,
// route) runs after each render of the view (afterRender of app.js).
//
// Six steps with deep links: identity · goal · access · key · configure · verify. The progress (never the
// key) is kept in sessionStorage per workspace/company/person, so a reload resumes where it stopped. The
// key exists only in this module's memory: shown masked once, copied only to the clipboard, never written
// to a URL, to storage or to a file, and wiped when the person leaves the key/configure steps, the
// screen, the company or the workspace.
//
// Orchestration (step 4): POST /api/tenants/:id/agents {name, provider:'mcp', mode:'copilot', description} then
// POST …/service-principals {name, agentId, capabilities, channelIds, departmentIds, dailyRequests,
// maxConcurrent, ttlHours, active}. One run at a time (a double click joins the run in flight); when the
// second call fails, the agentId already created is kept and the next attempt only creates the key. A call
// whose outcome is unknown (no answer, 5xx, unreadable answer) leaves a marker in the progress: the next
// attempt first looks for what it may have created (the new agent by name, the identity by agentId) and
// adopts it instead of creating another one; an identity adopted this way never showed its key, so the
// wizard offers "Trocar chave". What the server confirms after the person switched company is saved in
// that company's progress, never dropped.
// Step 5, Hermes tab: the attendant skill (src/agent-skill.js, docs/HERMES-SKILL.md), one install command whose
// origin follows the rules of the snippets (mcpOrigin) and whose --name is the connection slug plus "-atendente"
// (Hermes names the skill and its slash command after it), copied only to the clipboard, and the next step told by
// the capabilities of step 2: the agent sends, delivers drafts for review, or only reads.
// Verification (step 6) polls …/service-principals/:pid/receipts every 3 s and stops on the first
// authorized read made with the current key (keyRevision), while the tab is hidden (resumes when visible),
// 10 minutes after it started (a re-render never restarts that budget) or on leaving.
// Cancelar/Recomeçar after the key exists ask whether to revoke it: otherwise the identity stays valid.
//
// deps:
// - pageHeading, principals: legacy helpers of P1 (today's "Agentes conectados" page). Without the panel
//   context (state or context) and request, the screen keeps rendering that legacy page unchanged.
// - state (the app state object, as createAgentsHub receives it) or context() → contextFromState shape.
// - request (api() of app.js), toast(message, error), refresh() (reload the company after creating).
// - Injectable for tests: navigate(hash), history, location, clipboard(), storage(), timers, doc, win.

const STEP_LABELS = labels({ identity: 'Identidade', goal: 'O que pode fazer', access: 'Acesso e limites', key: 'Chave', configure: 'Configurar', verify: 'Verificar' });
const CLIENT_LABELS = labels({ hermes: 'Hermes Agent', claude: 'Claude Code', codex: 'Codex', json: 'JSON genérico', curl: 'Teste de conexão', bridge: 'Ponte local' });
const CLIENT_CHOICES = Object.freeze(['hermes', 'claude', 'codex', 'json']);
const CLIENT_CHOICE_LABELS = labels({ hermes: 'Hermes Agent', claude: 'Claude Code', codex: 'Codex', json: 'Outro cliente MCP (JSON)' });
// Goals of step 2 (multiple choice) → capabilities the server implements: the 4 of §5.3.3 plus "Atender
// sozinho", the agent as attendant of src/service-mcp.js ("Seu Hermes como atendente",
// docs/AGENT-CONNECTIONS.md), offered only while the server accepts all of its capabilities.
const GOALS = Object.freeze([
  Object.freeze({ id: 'consult', capabilities: ['conversation.read'] }),
  Object.freeze({ id: 'draft', capabilities: ['conversation.read', 'reply.submit'] }),
  Object.freeze({ id: 'team', capabilities: ['conversation.read', 'handoff.request'] }),
  Object.freeze({ id: 'management', capabilities: ['company.read', 'company.propose'] }),
  Object.freeze({ id: 'attend', capabilities: ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'] })
]);
const GOAL_LABELS = labels({ consult: 'Consultar', draft: 'Preparar respostas', team: 'Ajudar a equipe', management: 'Ajudar na gestão', attend: 'Atender sozinho' });
const GOAL_HELP = labels({
  consult: 'Ler e buscar conversas dos canais escolhidos.',
  draft: 'Entregar rascunhos para a equipe revisar e enviar.',
  team: 'Pedir uma pessoa da equipe quando o caso exigir.',
  management: 'Ler a estrutura da empresa e propor fluxos e agentes, sempre com a sua aprovação.',
  attend: 'Assumir da fila, responder nas conversas do agente, transferir e encerrar.'
});
// reply.send publishes without review in the selected groups and, since the attendant tools, also answers
// the private conversations assigned to this agent (elozi_send_reply): the box says both.
const DIRECT_ACTIONS = Object.freeze(['reply.send', 'message.schedule']);
// Same rule as src/service-principals.js: actions on a conversation keep the conversation read grant.
const NEEDS_READ = Object.freeze(['reply.draft', 'reply.submit', 'handoff.request', 'reply.send', 'message.schedule', 'events.read', 'conversation.manage']);
const CLIENTS = Object.freeze(['hermes', 'claude', 'codex', 'json', 'curl', 'bridge']);
const TTL_CHOICES = Object.freeze([168, 720, 2160]);
const NAME_MAX = 48;
// Longest name of a client entry: clients that prefix tools with it (mcp__<name>__<tool>) keep ≤ 64 chars.
const SLUG_MAX = 26;
const SECRET = /^elozi_svc_[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const POLL_EVERY_MS = 3000;
export const POLL_BUDGET_MS = 10 * 60 * 1000;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_CAPABILITIES_MS = 60 * 1000;
export const CONNECT_STORAGE_PREFIX = 'elozi:connect:v1:';
const PROBLEM = new Set(['failed', 'unknown', 'rejected', 'invalidated']);
const ERROR_ID = 'connect-error';
const KEY_TITLE = '[data-connect-key-title]';

const integer = (value, min, max, fallback) => { const number = Number(value); return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback; };
const ids = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && ID.test(item)))] : [];
const stepHash = step => formatHash({ section: 'agents', params: { tab: 'connect', ...(step ? { step } : {}) } });
const timeText = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
const instant = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
const before = (value, limit) => Boolean(limit) && Date.parse(value) < Date.parse(limit);
/** An answer the server gave (4xx): nothing was created. Anything else (no answer, 5xx) is an unknown outcome. */
const definite = failure => Number.isSafeInteger(failure?.status) && failure.status >= 400 && failure.status < 500;
const localError = message => Object.assign(new Error(message), { local: true });
const slugWords = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Cuts a slug at a word boundary in its second half, or at `max` when there is none. */
const cutSlug = (slug, max) => { if (slug.length <= max) return slug; const head = slug.slice(0, max), boundary = head.lastIndexOf('-'); return (boundary >= Math.ceil(max / 2) ? head.slice(0, boundary) : head).replace(/-+$/, ''); };

/**
 * Slug of the workspace brand for the snippets (§5.3.3 white label): "Acme Atendimento" →
 * "acme-atendimento". Without a brand name, the platform's own workspace uses "elozi" and the others
 * "atendimento". A slug never starts with a digit (it names an environment variable).
 */
export function brandSlug(name, { platform = false } = {}) {
  let slug = cutSlug(slugWords(name), 36);
  if (slug && !/^[a-z]/.test(slug)) slug = 'ws-' + slug;
  return slug || (platform ? 'elozi' : 'atendimento');
}

/**
 * Name of the connection in the client (entry, environment variable, bridge id): the brand slug plus the
 * company, because the key is valid for one company. "Acme Atendimento" + "Loja Centro" →
 * "acme-loja-centro" (the brand keeps its first word when both do not fit in 26 characters). Two
 * companies of one workspace never overwrite each other's entry or key, and the local bridge, which
 * refuses repeated ids, takes both.
 */
export function connectionSlug(brandName, companyName, { platform = false } = {}) {
  const brand = brandSlug(brandName, { platform }), company = slugWords(companyName);
  if (!company) return cutSlug(brand, SLUG_MAX);
  const full = `${brand}-${company}`;
  return full.length <= SLUG_MAX ? full : cutSlug(`${brand.split('-')[0]}-${company}`, SLUG_MAX);
}

/** Environment variable that holds the key: <SLUG>_MCP_TOKEN. */
export const tokenVariable = slug => brandSlug(slug).toUpperCase().replace(/-/g, '_') + '_MCP_TOKEN';

const anyOrigin = value => { try { const url = new URL(String(value ?? '')); return /^https?:$/.test(url.protocol) ? url.origin : ''; } catch { return ''; } };

/**
 * Origin of the MCP endpoint. location.origin only when the page is served by the workspace's own
 * domain, active with TLS (the server then answers boot.publicOrigin = https://<that host>, different
 * from the main origin); otherwise the main origin of the deployment. secure=false without HTTPS.
 */
export function mcpOrigin({ locationOrigin, publicOrigin, canonicalPublicOrigin } = {}) {
  const here = anyOrigin(locationOrigin), bound = anyOrigin(publicOrigin), canonical = anyOrigin(canonicalPublicOrigin);
  if (here && bound.startsWith('https:') && here === bound && bound !== canonical) return { origin: bound, custom: true, secure: true };
  const origin = canonical || here;
  return { origin, custom: false, secure: origin.startsWith('https:') };
}

const jsonText = value => JSON.stringify(String(value ?? '')).slice(1, -1);
export const clientSystem = platform => /^win/i.test(String(platform || '')) ? 'windows' : 'posix';

/**
 * All snippets contain only environment references or placeholders. Terminal input is private;
 * POSIX runs in a subshell and PowerShell restores the previous process environment in finally.
 * No profile is edited, existing client sessions are untouched, and clipboard copies never embed a key.
 */
export function clientSnippet(client, { origin, slug, envVar = tokenVariable(slug), tenantName = '', system = 'posix' } = {}) {
  const endpoint = `${origin}/api/agent/mcp`, windows = system === 'windows', ref = windows ? `$env:${envVar}` : '${' + envVar + '}';
  const prompt = t('Cole a chave quando o terminal pedir: ela não aparece e não fica no histórico.');
  const terminal = command => windows
    ? `# ${prompt}\n& {\n  $eloziMcpPreviousToken = [Environment]::GetEnvironmentVariable('${envVar}', 'Process')\n  $eloziMcpSecret = Read-Host '${t('Chave privada')}' -AsSecureString\n  try {\n    $env:${envVar} = [System.Net.NetworkCredential]::new('', $eloziMcpSecret).Password\n    ${command}\n  } finally {\n    [Environment]::SetEnvironmentVariable('${envVar}', $eloziMcpPreviousToken, 'Process')\n    $eloziMcpSecret.Dispose()\n  }\n}`
    : `# ${prompt}\n(\n  read -rs ${envVar} && export ${envVar} || exit\n  ${command}\n)`;
  let code;
  if (client === 'hermes') code = `# ~/.hermes/config.yaml\nmcp_servers:\n  ${slug}:\n    url: "${endpoint}"\n    headers:\n      Authorization: "Bearer ${'${' + envVar + '}'}"\n    timeout: 60\n\n# ~/.hermes/.env (${t('privado, fora do Git')})\n${envVar}=${t('<sua chave>')}`;
  else if (client === 'claude') code = terminal(`claude mcp add --transport http ${slug} ${endpoint} --header "Authorization: Bearer ${ref}"`);
  else if (client === 'codex') code = `# ~/.codex/config.toml\n[mcp_servers.${slug}]\nurl = "${endpoint}"\nbearer_token_env_var = "${envVar}"\ntool_timeout_sec = 60\n\n# ${t('Abra uma nova sessão do Codex CLI com a chave somente nesta execução.')}\n${terminal('codex')}`;
  else if (client === 'json') code = JSON.stringify({ mcpServers: { [slug]: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${'${' + envVar + '}'}` } } } }, null, 2);
  else if (client === 'curl') {
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'elozi_me', arguments: {} } });
    code = terminal(windows
      ? `$eloziMcpBody = '${requestBody}'\n    Invoke-RestMethod -Uri '${endpoint}' -Method Post -Headers @{ Authorization = "Bearer ${ref}"; Accept = 'application/json, text/event-stream' } -ContentType 'application/json' -Body $eloziMcpBody`
      : `curl -sS "${endpoint}" \\\n    -H "Authorization: Bearer ${ref}" \\\n    -H "Content-Type: application/json" \\\n    -H "Accept: application/json, text/event-stream" \\\n    -d '${requestBody}'`);
  } else if (client === 'bridge') {
    const config = `# elozi-mcp.json (${t('privado, fora do Git')})\n{\n  "connections": [\n    { "id": "${slug}", "name": "${jsonText(String(tenantName || slug).slice(0, 80))}", "endpoint": "${endpoint}", "tokenEnv": "${envVar}" }\n  ]\n}`;
    const command = windows
      ? `$eloziMcpPreviousConfig = [Environment]::GetEnvironmentVariable('ELOZI_MCP_CONFIG_PATH', 'Process')\n    try {\n      $env:ELOZI_MCP_CONFIG_PATH = 'C:/${t('caminho/privado')}/elozi-mcp.json'\n      node 'C:/${t('caminho/absoluto')}/scripts/elozi-agent-mcp.mjs'\n    } finally {\n      [Environment]::SetEnvironmentVariable('ELOZI_MCP_CONFIG_PATH', $eloziMcpPreviousConfig, 'Process')\n    }`
      : `export ELOZI_MCP_CONFIG_PATH="/${t('caminho/privado')}/elozi-mcp.json"\n  node /${t('caminho/absoluto')}/scripts/elozi-agent-mcp.mjs`;
    code = `${config}\n\n# ${t('cliente MCP local (stdio)')}\n${terminal(command)}`;
  } else return null;
  return { client, code, withKey: null };
}

/** Public route of the attendant skill (src/agent-skill.js ATTENDANT_SKILL_PATH); the brand comes from the host. */
export const ATTENDANT_SKILL_PATH = '/api/agent/skills/attendant/SKILL.md';

/**
 * One-line install of the attendant skill. `--name` names the skill and its slash command in Hermes (the SKILL.md has
 * no frontmatter name), so each company gets /<slug>-atendente next to its MCP entry <slug>, never another's.
 */
export function skillInstallCommand({ origin, slug }) {
  return `hermes skills install ${origin}${ATTENDANT_SKILL_PATH} --name ${slug}-atendente`;
}

/** What the skill will do with the capabilities of step 2: send (attendant), drafts (consultant) or read. */
export function skillMode(capabilities = []) {
  return !capabilities.includes('conversation.read') && capabilities.includes('company.read') ? 'company' : capabilities.includes('reply.send') ? 'send' : capabilities.includes('reply.submit') ? 'drafts' : 'read';
}

const CLIENT_NOTES = labels({
  hermes: 'Formato conferido com a documentação de MCP do Hermes Agent (10/2026). ${VAR} vem do ambiente ou de ~/.hermes/.env.',
  claude: 'Formato conferido com a documentação do Claude Code (10/2026).',
  codex: 'Formato conferido com a documentação do Codex CLI (10/2026).',
  json: 'Confira se seu cliente lê variáveis de ambiente; caso contrário, preencha a chave somente no arquivo privado.',
  curl: 'Chamada conferida com o MCP desta versão (10/2026): sem sessão, resposta em JSON.',
  bridge: 'Conferido com scripts/elozi-agent-mcp.mjs desta versão (10/2026). Somente leitura; reúne várias empresas.'
});

/** Panel context read from the app state (the fields app.js already gives the other agent screens). */
export function contextFromState(state) {
  const boot = state?.boot, session = boot?.session || {}, tenant = state?.tenant;
  return {
    workspaceId: state?.workspaceId || null, userId: session.userId || null, role: session.role || null,
    platformOwner: Boolean(session.platformOwner), supportGrantId: state?.supportGrantId || session.supportGrantId || null,
    tenant: tenant ? { id: tenant.id, name: tenant.name, brand: tenant.brand, agents: tenant.agents || [], channels: tenant.channels || [], departments: tenant.departments || [] } : null,
    brandName: boot?.reseller?.brand?.name || '', publicOrigin: boot?.publicOrigin || '', canonicalPublicOrigin: boot?.canonicalPublicOrigin || '',
    features: Array.isArray(boot?.features) ? boot.features : [],
    authorityKey: JSON.stringify([session.permissions, session.scopeRules])
  };
}

// agentAttempt/principalAttempt: a create call whose outcome is unknown (see the orchestration above).
// keyRevision/keyIssuedAt: the key shown last, so the verification ignores calls made with an older key.
const freshDraft = () => ({ name: '', client: 'hermes', system: '', goals: [], directActions: [], directRisk: false, attendRisk: false, channelMode: 'all', channelIds: [], departmentMode: 'all', departmentIds: [],
  dailyRequests: 500, maxConcurrent: 2, ttlHours: 2160, agentId: null, agentName: '', principalId: null, principalRevision: null, keyRevision: null, keyIssuedAt: null, keySaved: false,
  agentAttempt: null, principalAttempt: null });

// Keep invalid input verbatim. Number inputs erase malformed/localized text before validation.
const validLimit = (value, max) => /^[0-9]+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max;
const limitValue = (value, max) => validLimit(value, max) ? Number(value) : String(value ?? '');

function attemptOf(value, named) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(value.at)) return null;
  if (!named) return { at: value.at };
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, NAME_MAX) : '';
  return name ? { at: value.at, name, known: ids(value.known).slice(0, 100) } : null;
}

function sanitizeDraft(value) {
  const base = freshDraft();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  return {
    name: typeof value.name === 'string' ? value.name.slice(0, NAME_MAX) : '', client: CLIENTS.includes(value.client) ? value.client : 'hermes', system: ['windows', 'posix'].includes(value.system) ? value.system : '',
    goals: Array.isArray(value.goals) ? GOALS.map(goal => goal.id).filter(id => value.goals.includes(id)) : [],
    directActions: Array.isArray(value.directActions) ? DIRECT_ACTIONS.filter(id => value.directActions.includes(id)) : [],
    directRisk: value.directRisk === true, attendRisk: value.attendRisk === true,
    channelMode: value.channelMode === 'some' ? 'some' : 'all', channelIds: ids(value.channelIds), departmentMode: value.departmentMode === 'some' ? 'some' : 'all', departmentIds: ids(value.departmentIds),
    dailyRequests: limitValue(value.dailyRequests ?? base.dailyRequests, 10000), maxConcurrent: limitValue(value.maxConcurrent ?? base.maxConcurrent, 20), ttlHours: integer(value.ttlHours, 1, 2160, base.ttlHours),
    agentId: typeof value.agentId === 'string' && ID.test(value.agentId) ? value.agentId : null, agentName: typeof value.agentName === 'string' ? value.agentName.slice(0, NAME_MAX) : '',
    principalId: typeof value.principalId === 'string' && ID.test(value.principalId) ? value.principalId : null,
    principalRevision: Number.isSafeInteger(value.principalRevision) ? value.principalRevision : null, keyRevision: Number.isSafeInteger(value.keyRevision) ? value.keyRevision : null,
    keyIssuedAt: instant(value.keyIssuedAt), keySaved: value.keySaved === true, agentAttempt: attemptOf(value.agentAttempt, true), principalAttempt: attemptOf(value.principalAttempt, false)
  };
}

/** Capabilities a draft asks for, limited to the ones `accepted` (server), in catalog order. */
export function draftCapabilities(draft, accepted = MCP_CAPABILITIES) {
  const chosen = new Set();
  for (const goal of GOALS) if (draft.goals.includes(goal.id)) for (const capability of goal.capabilities) chosen.add(capability);
  for (const action of draft.directActions) chosen.add(action);
  if ([...chosen].some(capability => NEEDS_READ.includes(capability))) chosen.add('conversation.read');
  if (chosen.has('company.propose')) chosen.add('company.read');
  return [...MCP_CAPABILITIES, ...MCP_PLANNED_CAPABILITIES].filter(capability => chosen.has(capability) && accepted.includes(capability));
}

const goalAvailable = (goal, accepted) => goal.capabilities.every(capability => accepted.includes(capability));

export function createAgentConnectWizard({
  pageHeading, principals = () => '', state = null, context = null, request = null, toast = null, refresh = null,
  navigate = null, history = globalThis.history, location = globalThis.location, clipboard = () => globalThis.navigator?.clipboard,
  storage = () => { try { return globalThis.sessionStorage; } catch { return null; } }, timers = globalThis, doc = globalThis.document, win = globalThis.window,
  platform = () => globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || ''
} = {}) {
  const wired = typeof request === 'function' && (Boolean(state) || typeof context === 'function');
  let draft = freshDraft(), draftScope = '', secret = null, revealed = false, busy = false, inflight = null, error = '', errorField = '', rotating = false, leaving = null;
  let server = { scope: '', capabilities: null, loading: false, failedAt: 0 }, mounted = null, poll = null, listening = false, pendingReplace = null, lastStep = null;
  // painted: the markup of the live verification region, written only when it changes (aria-live).
  let pendingFocus = '', painted = { target: null, html: '' };

  const now = () => typeof timers.now === 'function' ? timers.now() : Date.now();
  const ctx = () => { try { return (typeof context === 'function' ? context() : contextFromState(state)) || {}; } catch { return {}; } };
  const scopeOf = c => c.workspaceId && c.tenant?.id && c.userId ? `${c.workspaceId}:${c.tenant.id}:${c.userId}` : '';
  const authorityOf = c => JSON.stringify([scopeOf(c), c.role, c.supportGrantId, c.platformOwner, c.authorityKey]);
  const isAdmin = c => c.role === 'reseller' && !c.supportGrantId;
  const system = () => draft.system || clientSystem(typeof platform === 'function' ? platform() : platform);
  const accepted = () => acceptedCapabilities(server.scope === draftScope ? server.capabilities : null);
  const tenantPath = (c, path = '') => `/api/tenants/${encodeURIComponent(c.tenant.id)}${path}`;
  const options = (c, extra = {}) => ({ ...extra, headers: { 'X-Elozi-Workspace': c.workspaceId, ...(extra.headers || {}) } });
  const say = (message, failure = false) => { if (!message) return; if (typeof toast === 'function') toast(message, failure); else toasts.show({ message, tone: failure ? 'error' : 'success' }); };
  const go = hash => { if (typeof navigate === 'function') navigate(hash); else if (location) location.hash = hash; };
  const hasSecret = () => Boolean(secret?.token && secret.principalId === draft.principalId);

  // ---- progress in sessionStorage (never the key) -------------------------------------------------
  function load(scope) {
    if (scope === draftScope) return;
    clearSecret(); stopPoll('scope'); draftScope = scope; draft = freshDraft(); error = ''; errorField = ''; revealed = false; rotating = false; leaving = null;
    if (!scope) return;
    try {
      const saved = JSON.parse(storage()?.getItem(CONNECT_STORAGE_PREFIX + scope) || 'null');
      if (saved && saved.v === 1 && Number.isFinite(saved.updatedAt) && now() - saved.updatedAt < DRAFT_TTL_MS) draft = sanitizeDraft(saved.draft);
      else if (saved) storage()?.removeItem(CONNECT_STORAGE_PREFIX + scope);
    } catch { /* storage unavailable or corrupt: start again */ }
  }
  function persist() {
    if (!draftScope) return;
    try { storage()?.setItem(CONNECT_STORAGE_PREFIX + draftScope, JSON.stringify({ v: 1, updatedAt: now(), draft })); } catch { /* private mode: progress lives only in memory */ }
  }
  function forget() { try { storage()?.removeItem(CONNECT_STORAGE_PREFIX + draftScope); } catch {} draft = freshDraft(); }
  /** Saves `target`, the progress of `scope`, even when the person is now on another company. */
  function save(scope, target) {
    if (!scope) return;
    if (scope === draftScope) { draft = target; persist(); return; }
    try { storage()?.setItem(CONNECT_STORAGE_PREFIX + scope, JSON.stringify({ v: 1, updatedAt: now(), draft: target })); } catch { /* private mode */ }
  }

  // ---- the key: memory only ---------------------------------------------------------------------
  function clearSecret() { if (secret) secret.token = ''; secret = null; revealed = false; syncListener(); }
  function syncListener() {
    const wanted = Boolean(secret || poll);
    if (wanted === listening || typeof win?.addEventListener !== 'function') return;
    listening = wanted;
    if (wanted) { win.addEventListener('hashchange', onHashChange); win.addEventListener('pagehide', onPageHide); }
    else { win.removeEventListener('hashchange', onHashChange); win.removeEventListener('pagehide', onPageHide); }
  }
  function currentStep() { const route = parseHash(location?.hash || ''); return route?.section === 'agents' && route.params?.tab === 'connect' ? route.params.step || 'identity' : null; }
  function onHashChange() {
    const step = currentStep();
    if (!['key', 'configure'].includes(step)) clearSecret();
    if (step !== 'verify') stopPoll('left');
  }
  function onPageHide() { clearSecret(); stopPoll('left'); }

  // ---- steps -------------------------------------------------------------------------------------
  const validName = () => draft.name.trim().length > 0 && draft.name.trim().length <= NAME_MAX && !/[\x00-\x1f\x7f]/.test(draft.name);
  // A problem names the field it points to: the field gets aria-invalid + aria-describedby and the focus.
  const problemOf = (message, field = '') => ({ message, field });
  function goalProblem() {
    if (!draft.goals.length && !draft.directActions.length) return problemOf(t('Escolha pelo menos uma tarefa para o agente.'), 'goals');
    if (!draftCapabilities(draft, accepted()).length) return problemOf(t('As tarefas escolhidas ainda não estão disponíveis nesta versão.'), 'goals');
    if (draft.directActions.length && !draft.directRisk) return problemOf(t('Confirme que entende o risco das ações diretas em grupos.'), 'directRisk');
    if (draft.goals.includes('attend') && !draft.attendRisk) return problemOf(t('Confirme como o agente atende sozinho antes de continuar.'), 'attendRisk');
    return null;
  }
  function accessProblem(c) {
    const channels = c.tenant?.channels || [], departments = (c.tenant?.departments || []).filter(item => item.active !== false);
    if (draft.channelMode === 'some' && (!draft.channelIds.length || draft.channelIds.some(id => !channels.some(channel => channel.id === id)))) return problemOf(t('Escolha pelo menos um canal ou use todos nesta empresa.'), 'channelIds');
    if (draft.departmentMode === 'some' && (!draft.departmentIds.length || draft.departmentIds.some(id => id !== 'unassigned' && !departments.some(item => item.id === id)))) return problemOf(t('Escolha pelo menos um departamento ou use todos nesta empresa.'), 'departmentIds');
    if (!validLimit(draft.dailyRequests, 10000)) return problemOf(t('Use um número inteiro de 1 a 10.000 para requisições por dia.'), 'dailyRequests');
    if (!validLimit(draft.maxConcurrent, 20)) return problemOf(t('Use um número inteiro de 1 a 20 para execuções simultâneas.'), 'maxConcurrent');
    return null;
  }
  function showProblem(problem) { error = problem.message; errorField = problem.field || ''; rerender({ focus: errorField ? '[aria-invalid="true"]' : '' }); }
  /** aria-invalid and aria-describedby of a field (§4.2), pointing to the error message when it is wrong. */
  const fieldState = (field, hint = '') => { const wrong = Boolean(error) && errorField === field; return attributes({ 'aria-invalid': wrong ? 'true' : null, 'aria-describedby': [hint, wrong ? ERROR_ID : ''].filter(Boolean).join(' ') || null }); };
  /** First step still to complete; null once the key exists (every step can open). */
  function firstOpen(c) {
    if (draft.principalId) return null;
    if (!validName()) return 'identity';
    if (goalProblem()) return 'goal';
    if (accessProblem(c)) return 'access';
    return 'key';
  }
  /** The step that can open: a later step waits for the earlier ones; configure/verify need the key. */
  function allowedStep(requested, c) {
    const wanted = CONNECT_STEPS.includes(requested) ? requested : 'identity', open = firstOpen(c);
    return !open || CONNECT_STEPS.indexOf(wanted) <= CONNECT_STEPS.indexOf(open) ? wanted : open;
  }

  // ---- markup ------------------------------------------------------------------------------------
  function heading(c) {
    const title = t('Conectar meu agente');
    const brand = c.brandName || t('o painel');
    return h`<header class="pg-connect__head"><div class="pg-connect__title"><h1>${title}</h1><p>Seu agente continua rodando no seu ambiente e acessa ${brand} por MCP, com o acesso e os limites que você define.</p></div>${button({ label: t('Cancelar'), action: 'connect:cancel', variant: 'ghost' })}</header>`;
  }
  function stepper(step, c) {
    const open = firstOpen(c), last = open ? CONNECT_STEPS.indexOf(open) : CONNECT_STEPS.length - 1, index = CONNECT_STEPS.indexOf(step);
    return h`<nav class="pg-connect__stepper" aria-label="${t('Etapas')}"><ol>${CONNECT_STEPS.map((name, position) => {
      const status = position === index ? 'current' : position < index ? 'done' : 'next';
      const mark = h`<span class="pg-connect__dot" aria-hidden="true">${status === 'done' ? glyph('check') : position + 1}</span><span class="pg-connect__step-label">${STEP_LABELS[name]}</span>${status === 'done' ? h`<span class="sr-only">${t('(concluído)')}</span>` : ''}`;
      return h`<li class="pg-connect__step" data-state="${status}">${position !== index && position <= last ? h`<a href="${stepHash(name)}">${mark}</a>` : h`<span${attributes({ 'aria-current': position === index ? 'step' : null, 'aria-disabled': position > last ? 'true' : null })}>${mark}</span>`}</li>`;
    })}</ol><p class="sr-only">${t('Passo {n} de {total}', { n: index + 1, total: CONNECT_STEPS.length })}</p></nav>`;
  }
  const feedback = () => h`<p class="pg-connect__error" id="${ERROR_ID}" role="alert" data-connect-error${attributes({ hidden: !error })}>${error}</p>`;
  const navRow = (step, { next = t('Avançar'), nextDisabled = false } = {}) => {
    const index = CONNECT_STEPS.indexOf(step);
    return h`<div class="pg-connect__nav">${index > 0 ? button({ label: t('Voltar'), action: 'connect:back', disabled: busy, attrs: { 'data-step': CONNECT_STEPS[index - 1] } }) : h`<span></span>`}${button({ label: next, type: 'submit', variant: 'primary', disabled: nextDisabled || busy, attrs: { 'data-connect-next': '' } })}</div>`;
  };
  const lockedNote = () => draft.principalId ? banner({ tone: 'info', title: t('A conexão já foi criada.'), body: t('Para mudar tarefas, canais ou limites depois, edite o acesso do agente em Agentes.') }) : '';

  function identityStep() {
    const locked = Boolean(draft.agentId), choice = CLIENT_CHOICES.includes(draft.client) ? draft.client : 'json';
    return h`<form class="pg-connect__card" data-form="connect:identity" novalidate><h2>1 · ${STEP_LABELS.identity}</h2>${lockedNote()}
      <div class="pg-connect__identity">${avatar({ kind: 'agent', name: draft.name, size: 56 })}
      <label class="pg-connect__field"><span class="pg-connect__label">Nome do agente</span><input name="name" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" required value="${draft.name}"${attributes({ readonly: locked })}${fieldState('name', 'connect-name-hint')}/><small id="connect-name-hint" class="pg-connect__hint">${locked ? t('O agente já foi criado com este nome.') : t('Até 48 caracteres. Aparece para a equipe nas conversas e nos recibos.')}</small></label></div>
      <fieldset class="pg-connect__fieldset"><legend class="pg-connect__label">Cliente que você usa</legend><p class="pg-connect__hint">Só escolhe a aba de configuração do passo 5.</p><div class="pg-connect__choices">${CLIENT_CHOICES.map(client => h`<label class="pg-connect__choice"><input type="radio" name="client" value="${client}"${attributes({ checked: choice === client })}/><span>${CLIENT_CHOICE_LABELS[client]}</span></label>`)}</div></fieldset>
      ${feedback()}${navRow('identity')}</form>`;
  }

  function toolList(capabilities) {
    const served = toolsForCapabilities(capabilities), planned = plannedToolsForCapabilities(capabilities);
    return h`<ul class="pg-connect__tools">${served.map(tool => h`<li><code>${tool}</code><span>${MCP_TOOL_LABELS[tool] || ''}</span></li>`)}${planned.map(tool => h`<li data-state="planned"><code>${tool}</code><span>${MCP_TOOL_LABELS[tool] || ''}</span>${badge(t('em breve'), 'neutral')}</li>`)}</ul>`;
  }
  function preview() {
    const caps = draftCapabilities(draft, accepted()), wanted = draftCapabilities(draft, [...MCP_CAPABILITIES, ...MCP_PLANNED_CAPABILITIES]);
    return h`<h3 class="pg-connect__subhead">O que este agente poderá usar</h3><p class="pg-connect__hint">${caps.length ? caps.map(capability => MCP_CAPABILITY_LABELS[capability]).join(' · ') : t('Escolha as tarefas para ver as ferramentas liberadas.')}</p>${toolList(wanted)}`;
  }
  function goalStep() {
    const allowed = accepted(), locked = Boolean(draft.principalId), attend = GOALS.find(goal => goal.id === 'attend');
    const attendOn = draft.goals.includes('attend') && goalAvailable(attend, allowed);
    const card = goal => {
      const available = goalAvailable(goal, allowed), checked = draft.goals.includes(goal.id) && available;
      const tools = [...toolsForCapabilities(goal.capabilities).filter(tool => tool !== 'elozi_me'), ...plannedToolsForCapabilities(goal.capabilities)];
      return h`<label class="pg-connect__option"${attributes({ 'data-state': available ? null : 'planned' })}><input type="checkbox" name="goals" value="${goal.id}"${attributes({ checked, disabled: !available || locked })}${available ? fieldState('goals') : ''}/><span class="pg-connect__option-body"><strong>${GOAL_LABELS[goal.id]}${available ? '' : h` ${badge(t('Em breve'), 'neutral')}`}</strong><small>${GOAL_HELP[goal.id]}</small><small class="pg-connect__mono">${tools.join(' · ')}</small></span></label>`;
    };
    return h`<form class="pg-connect__card" data-form="connect:goal" novalidate><h2>2 · ${STEP_LABELS.goal}</h2>${lockedNote()}<p class="pg-connect__hint">Escolha uma ou mais tarefas. Cada uma libera só as ferramentas necessárias.</p>
      <fieldset class="pg-connect__fieldset"><legend class="sr-only">Tarefas do agente</legend><div class="pg-connect__options">${GOALS.map(card)}</div></fieldset>
      ${attendOn ? h`<div class="pg-connect__risk">${glyph('warning')}<label class="pg-connect__check"><input type="checkbox" name="attendRisk" value="yes"${attributes({ checked: draft.attendRisk, disabled: locked })}${fieldState('attendRisk')}/><span>Atender sozinho solicita permissão para responder sem revisão por mensagem nas conversas atribuídas e autorizadas; não comprova execução. Grupos só podem receber envio se a política permitir. Pedido de pessoa, irritação ou mídia exigem transferir; uma pessoa que assume interrompe o agente.</span></label></div>` : ''}
      <fieldset class="pg-connect__fieldset pg-connect__direct"><legend class="pg-connect__label">Ações diretas: exigem confiança</legend><p class="pg-connect__hint">Solicitam envio sem revisão por mensagem, sujeito à política atual do servidor. Grupos exigem política que permita, seleção e canal autorizado. Enviar também responde ao cliente nas conversas atribuídas a este agente.</p>
        ${DIRECT_ACTIONS.map(action => { const implied = action === 'reply.send' && attendOn; return h`<label class="pg-connect__check"><input type="checkbox" name="directActions" value="${action}"${attributes({ checked: draft.directActions.includes(action) || implied, disabled: locked || implied })}/><span>${MCP_CAPABILITY_LABELS[action]}${implied ? h` <small class="pg-connect__hint">${t('(incluído em Atender sozinho)')}</small>` : ''}</span></label>`; })}
        ${draft.directActions.length ? h`<label class="pg-connect__check pg-connect__check--risk"><input type="checkbox" name="directRisk" value="yes"${attributes({ checked: draft.directRisk, disabled: locked })}${fieldState('directRisk')}/><span>Entendo que essas ações publicam sem revisão humana de cada mensagem.</span></label>` : ''}</fieldset>
      <section class="pg-connect__preview" data-connect-preview aria-live="polite">${preview()}</section>
      ${feedback()}${navRow('goal')}</form>`;
  }

  function scopeField(name, legend, items, mode, selected, help, locked) {
    return h`<fieldset class="pg-connect__fieldset"><legend class="pg-connect__label">${legend}</legend>
      <div class="pg-connect__row"><label class="pg-connect__check"><input type="radio" name="${name}Mode" value="all"${attributes({ checked: mode === 'all', disabled: locked })}/><span>Todos nesta empresa</span></label>
      <label class="pg-connect__check"><input type="radio" name="${name}Mode" value="some"${attributes({ checked: mode === 'some', disabled: locked })}/><span>Escolher</span></label></div>
      <p class="pg-connect__hint">${help}</p>
      <div class="pg-connect__choices">${items.length ? items.map(item => h`<label class="pg-connect__choice"><input type="checkbox" name="${name}Ids" value="${item.id}"${attributes({ checked: mode === 'all' || selected.includes(item.id), disabled: locked || mode !== 'some' })}${fieldState(name + 'Ids')}/><span>${item.name}</span></label>`) : h`<p class="pg-connect__hint">Nenhum cadastrado nesta empresa.</p>`}</div></fieldset>`;
  }
  function accessStep(c) {
    const locked = Boolean(draft.principalId), departments = [{ id: 'unassigned', name: t('Sem departamento') }, ...(c.tenant?.departments || []).filter(item => item.active !== false)];
    const days = hours => t('{n} dias', { n: Math.round(hours / 24) });
    return h`<form class="pg-connect__card" data-form="connect:access" novalidate><h2>3 · ${STEP_LABELS.access}</h2>${lockedNote()}
      <div class="pg-connect__company"><span class="pg-connect__label">Empresa</span>${companyMark(c.tenant)}<small class="pg-connect__hint">A chave vale só para esta empresa. Para outra empresa, conecte de novo com ela aberta.</small></div>
      ${scopeField('channel', t('Canais'), c.tenant?.channels || [], draft.channelMode, draft.channelIds, t('Todos nesta empresa inclui os canais criados depois.'), locked)}
      ${scopeField('department', t('Departamentos'), departments, draft.departmentMode, draft.departmentIds, t('Todos nesta empresa inclui os departamentos criados depois.'), locked)}
      <div class="pg-connect__limits">
        <label class="pg-connect__field"><span class="pg-connect__label">Requisições por dia</span><input name="dailyRequests" type="text" inputmode="numeric" pattern="[0-9]*" required value="${draft.dailyRequests}"${attributes({ readonly: locked })}${fieldState('dailyRequests', 'connect-daily-hint')}/><small id="connect-daily-hint" class="pg-connect__hint">${t('Use um número inteiro de 1 a 10.000 para requisições por dia.')}</small></label>
        <label class="pg-connect__field"><span class="pg-connect__label">Execuções simultâneas</span><input name="maxConcurrent" type="text" inputmode="numeric" pattern="[0-9]*" required value="${draft.maxConcurrent}"${attributes({ readonly: locked })}${fieldState('maxConcurrent', 'connect-concurrent-hint')}/><small id="connect-concurrent-hint" class="pg-connect__hint">${t('Use um número inteiro de 1 a 20 para execuções simultâneas.')}</small></label>
        <label class="pg-connect__field"><span class="pg-connect__label">Validade da chave</span><select name="ttlHours"${attributes({ disabled: locked })}>${[...new Set([...TTL_CHOICES, draft.ttlHours])].map(hours => h`<option value="${hours}"${attributes({ selected: draft.ttlHours === hours })}>${days(hours)}</option>`)}</select></label>
      </div><p class="pg-connect__hint">As cotas viram à meia-noite UTC. Depois de vencer, a chave para de funcionar e os recibos continuam guardados.</p>
      ${feedback()}${navRow('access')}</form>`;
  }

  function summary(c) {
    const caps = draftCapabilities(draft, accepted());
    const scopeText = (mode, list, items) => mode === 'all' ? t('Todos nesta empresa') : list.map(id => items.find(item => item.id === id)?.name || id).join(' · ');
    const departments = [{ id: 'unassigned', name: t('Sem departamento') }, ...(c.tenant?.departments || [])];
    return h`<dl class="pg-connect__summary"><div><dt>Agente</dt><dd>${draft.agentName || draft.name}</dd></div><div><dt>Empresa</dt><dd>${c.tenant?.name || ''}</dd></div>
      <div><dt>Pode</dt><dd>${caps.map(capability => MCP_CAPABILITY_LABELS[capability]).join(' · ')}</dd></div>
      <div><dt>Canais</dt><dd>${scopeText(draft.channelMode, draft.channelIds, c.tenant?.channels || [])}</dd></div><div><dt>Departamentos</dt><dd>${scopeText(draft.departmentMode, draft.departmentIds, departments)}</dd></div>
      <div><dt>Limites</dt><dd>${t('{requests} requisições por dia · {concurrent} simultâneas · validade de {days} dias', { requests: draft.dailyRequests, concurrent: draft.maxConcurrent, days: Math.round(draft.ttlHours / 24) })}</dd></div></dl>`;
  }
  const maskedKey = token => token.slice(0, 10) + '•'.repeat(24) + token.slice(-4);
  function keyStep(c) {
    if (!draft.principalId) {
      const resume = Boolean(draft.agentId);
      return h`<form class="pg-connect__card" data-form="connect:key" novalidate><h2>4 · ${STEP_LABELS.key}</h2>
        ${resume ? banner({ tone: 'info', title: t('O agente {name} já foi criado.', { name: draft.agentName || draft.name }), body: t('Falta criar a chave. Tentar de novo não cria outro agente.') }) : ''}
        <p class="pg-connect__hint">Confira antes de criar. A chave aparece uma única vez, logo depois.</p>${summary(c)}
        <div class="pg-connect__create">${button({ label: resume ? t('Criar a chave') : t('Criar agente e chave'), action: 'connect:create', variant: 'primary', size: 'lg', busy, icon: 'shield' })}</div>
        ${feedback()}<div class="pg-connect__nav">${button({ label: t('Voltar'), action: 'connect:back', disabled: busy, attrs: { 'data-step': 'access' } })}<span></span></div></form>`;
    }
    if (hasSecret()) {
      return h`<form class="pg-connect__card" data-form="connect:key" novalidate><h2>4 · ${STEP_LABELS.key}</h2>
        <div class="pg-connect__keybox"><strong data-connect-key-title tabindex="-1">Sua chave aparece uma única vez</strong>
          <code class="pg-connect__secret" data-connect-secret>${revealed ? secret.token : maskedKey(secret.token)}</code>
          <div class="pg-connect__row">${button({ label: revealed ? t('Ocultar') : t('Mostrar'), action: 'connect:reveal', size: 'sm', attrs: { 'aria-pressed': revealed ? 'true' : 'false' } })}${button({ label: t('Copiar chave'), action: 'connect:copy-key', size: 'sm', icon: 'copy' })}</div>
          <label class="pg-connect__check"><input type="checkbox" name="keySaved" value="yes" data-connect-saved${attributes({ checked: draft.keySaved })}${fieldState('keySaved')}/><span>Guardei a chave em local seguro (ex.: o arquivo .env do cliente).</span></label>
          <p class="pg-connect__hint">O painel guarda só uma impressão da chave. Ela nunca vai para a URL, para o armazenamento do navegador ou para um arquivo, e some desta tela quando você sai do passo 5.</p></div>
        ${feedback()}${navRow('key', { nextDisabled: !draft.keySaved })}</form>`;
    }
    return h`<form class="pg-connect__card" data-form="connect:key" novalidate><h2>4 · ${STEP_LABELS.key}</h2>
      ${banner({ tone: 'warning', title: t('A chave não aparece de novo.'), body: t('Ela foi exibida uma única vez e não fica guardada. Se você não a guardou, troque a chave: a anterior deixa de funcionar na hora.') })}
      ${rotating ? h`<div class="pg-connect__confirm" role="group" aria-label="${t('Confirmar troca de chave')}"><p>Trocar a chave agora? Clientes que usam a chave atual param de funcionar.</p><div class="pg-connect__row">${button({ label: t('Trocar agora'), action: 'connect:rotate-confirm', variant: 'danger', busy })}${button({ label: t('Manter a chave atual'), action: 'connect:rotate-cancel', disabled: busy })}</div></div>`
        : h`<div class="pg-connect__row">${button({ label: t('Trocar chave'), action: 'connect:rotate', icon: 'refresh' })}</div>`}
      ${feedback()}${navRow('key')}</form>`;
  }

  /** Step 5, Hermes tab: install command of the attendant skill and the next step by the capabilities of step 2. */
  function skillBlock(origin, slug) {
    const mode = skillMode(draftCapabilities(draft, accepted()));
    if(mode==='company')return '';
    const command = `/${slug}-atendente ${mode === 'read' ? t('resuma meus atendimentos abertos') : t('comece a atender')}`;
    const note = mode === 'send' ? t('Permissão solicitada: responder sem revisão por mensagem nas conversas atribuídas e autorizadas, com transferência quando necessário. Confira a política efetiva em Acesso; isto não comprova listener ativo.')
      : mode === 'drafts' ? t('Sem permissão de envio: o agente entrega rascunhos para a equipe revisar e enviar.')
        : t('Sem envio nem rascunhos: o agente só lê e resume os atendimentos para você.');
    return h`<section class="pg-connect__preview" data-connect-skill="${mode}" aria-labelledby="connect-skill-title"><h3 class="pg-connect__subhead" id="connect-skill-title">Skill de atendente</h3>
      <p class="pg-connect__hint">Ensina o agente a atender com as regras do painel: versão exata, transferência para a equipe e nenhuma informação inventada.</p>
      <pre class="pg-connect__code" tabindex="0" aria-label="${t('Comando de instalação da skill')}"><code data-connect-skill-command>${skillInstallCommand({ origin, slug })}</code></pre>
      <div class="pg-connect__row">${button({ label: t('Copiar comando'), action: 'connect:copy-skill', icon: 'copy', size: 'sm' })}</div>
      <p class="pg-connect__hint">Depois, no chat: ${h`<code>/reload-mcp</code>`} e ${h`<code>/reload-skills</code>`}; em seguida: ${h`<code>${command}</code>`}</p>
      <p class="pg-connect__hint">${note}</p></section>`;
  }

  function operationalSteps() {
    const caps = draftCapabilities(draft, accepted()), steps = [t('Descubra tools/list no cliente e use elozi_me para conferir empresa, capacidades, escopo, validade e cotas.')];
    if(caps.includes('company.read'))steps.push(t('Use elozi_read_company para consultar a estrutura autorizada. Propostas exigem company.propose e aprovação humana.'));
    if(caps.includes('conversation.read'))steps.push(t('Localize a conversa com elozi_search_conversations e leia o contexto e a versão atual com elozi_read_conversation ou elozi_read_conversation_history.'));
    if(caps.includes('conversation.manage'))steps.push(t('Use elozi_claim_conversation somente para uma conversa da fila sem responsável; nunca assuma o atendimento de uma pessoa ou outro agente.'));
    if(caps.includes('events.read'))steps.push(t('Use elozi_wait_for_events para acompanhar mensagens e atribuições dentro do escopo.'));
    if(caps.includes('reply.send'))steps.push(t('Use elozi_send_reply somente na conversa atribuída e autorizada a este agente. Use elozi_send_group_message apenas se a política atual permitir grupos e o grupo estiver selecionado e autorizado.'));
    else if(caps.includes('reply.submit'))steps.push(t('Use elozi_submit_draft para entregar texto à revisão humana. Entregar rascunho não envia uma mensagem.'));
    if(caps.includes('message.schedule'))steps.push(t('Use elozi_schedule_group_message apenas se a política atual permitir grupos e o grupo estiver selecionado e autorizado; essa permissão não concede envio imediato.'));
    if(caps.includes('conversation.manage'))steps.push(t('Pedido de pessoa, insatisfação ou mídia exigem elozi_transfer_to_human. Encerre somente a própria conversa já respondida.'));
    else if(caps.includes('handoff.request'))steps.push(t('Use elozi_request_human_support para pedir apoio. O pedido não transfere o atendimento.'));
    steps.push(t('Em ações, use a versão atual e mantenha o mesmo requestId e corpo para reconciliar. Resultado incerto exige conferir o recibo antes de reenviar.')+' elozi_get_receipt({requestId})');
    return steps;
  }

  function operationalMarkup() {
    return h`<section class="pg-connect__preview" data-connect-operation aria-labelledby="connect-operation-title"><h3 class="pg-connect__subhead" id="connect-operation-title">${t('Como usar o acesso autorizado')}</h3><ol>${operationalSteps().map(step=>h`<li>${step}</li>`)}</ol><p class="pg-connect__hint">${t('Este roteiro não executa consultas, assume conversas nem envia mensagens. Seu cliente usa somente as ferramentas concedidas.')}</p></section>`;
  }

  function configureStep(c) {
    const where = mcpOrigin({ locationOrigin: location?.origin, publicOrigin: c.publicOrigin, canonicalPublicOrigin: c.canonicalPublicOrigin });
    const slug = connectionSlug(c.brandName, c.tenant?.name, { platform: c.platformOwner }), envVar = tokenVariable(slug);
    const clients = ['hermes', 'claude', 'codex', 'json', 'curl', ...(c.platformOwner ? ['bridge'] : [])];
    const active = clients.includes(draft.client) ? draft.client : 'hermes';
    const snippet = clientSnippet(active, { origin: where.origin, slug, envVar, tenantName: c.tenant?.name, system: system() });
    const after = active === 'hermes' ? h`<p class="pg-connect__hint">Depois: ${h`<code>hermes mcp test ${slug}</code>`} · no chat: ${h`<code>/reload-mcp</code>`}</p>`
      : active === 'claude' ? h`<p class="pg-connect__hint">Depois: ${h`<code>claude mcp list</code>`}</p>` : active === 'codex' ? h`<p class="pg-connect__hint">Depois: ${h`<code>codex mcp list</code>`}</p>` : '';
    const panel = h`<div class="pg-connect__snippet">${active === 'json' ? h`<p class="pg-connect__hint">Defina ${h`<code>${envVar}</code>`} com a sua chave no ambiente do cliente.</p>` : ''}
      <pre class="pg-connect__code" tabindex="0" aria-label="${t('Configuração de {client}', { client: CLIENT_LABELS[active] })}"><code data-connect-snippet>${snippet.code}</code></pre>
      <div class="pg-connect__row">${button({ label: t('Copiar configuração'), action: 'connect:copy-config', icon: 'copy', size: 'sm' })}</div>
      <p class="pg-connect__hint">${t('A configuração copiada não contém a chave. Insira-a somente no ambiente ou arquivo privado do cliente.')}</p>
      ${!hasSecret()?h`<p class="pg-connect__hint">${t('A chave não está mais nesta tela. Cole a que você guardou quando o terminal pedir.')}</p>`:''}
      ${after}<p class="pg-connect__verified">${glyph('check')} ${CLIENT_NOTES[active]}</p>${active === 'hermes' ? skillBlock(where.origin, slug) : ''}</div>`;
    return h`<form class="pg-connect__card" data-form="connect:configure" novalidate><h2>5 · Configure o seu cliente</h2>
      ${where.secure ? '' : banner({ tone: 'warning', title: t('Endereço sem HTTPS confirmado.'), body: t('Clientes MCP fora desta máquina exigem HTTPS. Confirme o domínio antes de usar estes trechos fora do ambiente local.') })}
      <p class="pg-connect__hint">Endereço: ${h`<code>${where.origin}/api/agent/mcp</code>`}${where.custom ? t(' (domínio próprio com HTTPS ativo)') : ''}</p>
      <fieldset class="pg-connect__fieldset"><legend class="pg-connect__label">${t('Sistema do cliente')}</legend><div class="pg-connect__row">${[['windows','Windows / PowerShell'],['posix','Linux / macOS (POSIX)']].map(([id,label])=>button({label,action:'connect:system',size:'sm',attrs:{'data-system':id,'aria-pressed':system()===id?'true':'false'}}))}</div></fieldset>
      <p class="pg-connect__hint">${t('Escolha o sistema onde seu cliente executa. Os exemplos de terminal preservam o ambiente atual e não alteram perfis nem sessões já abertas.')}</p>
      ${tabs({ id: 'connect-clients', label: t('Cliente MCP'), active, items: clients.map(client => ({ id: client, label: CLIENT_LABELS[client], action: 'connect:client' })) })}
      ${tabPanel({ tabsId: 'connect-clients', id: active, active: true, focusable: false, content: panel })}
      ${operationalMarkup()}${eventActivationMarkup()}${feedback()}${navRow('configure', { next: t('Já configurei') })}</form>`;
  }

  function eventActivationMarkup() {
    const caps = draftCapabilities(draft, accepted());
    if (!caps.includes('conversation.read')) return '';
    const enabled = caps.includes('events.read');
    return h`<details class="pg-connect__preview" data-connect-event-activation="${enabled ? 'authorized' : 'not-authorized'}"><summary>${t('Ativação por eventos')}</summary>
      <p>${t('Conectar o MCP permite consultar e agir quando você pede. Isso não inicia um agente em atendimento contínuo.')}</p>
      <p>${enabled ? t('Esta identidade pode esperar eventos. Execute o listener no ambiente do seu agente e conecte seu destino de ativação autorizado.') : t('Esta identidade não tem acesso a eventos. Revise as tarefas em Agentes antes de configurar atendimento contínuo.')}</p>
      ${enabled ? h`<p><code>elozi_wait_for_events</code> · ${t('A espera ociosa não chama o modelo. Uma mensagem pendente em conversa atribuída ao agente pode ativá-lo; ele relê o contexto antes de agir.')}</p>` : ''}
      <p>${t('O listener usa webhook assinado, retomada e chave de idempotência. O destino precisa validar e deduplicar antes de iniciar o agente; um humano assumir interrompe novas ativações.')}</p>
      <p>${t('Uma consulta confirmada não comprova listener ativo, resposta enviada nem integração instalada no seu site.')}</p>
    </details>`;
  }

  function checkLine(status, title, detail) {
    return h`<li class="pg-connect__check-line" data-state="${status}"><span class="pg-connect__check-mark" aria-hidden="true">${status === 'ok' ? glyph('check') : status === 'problem' ? glyph('warning') : ''}</span><span class="pg-connect__check-text"><strong>${title}</strong><small>${detail}</small></span><span class="sr-only">${status === 'ok' ? t('concluído') : status === 'problem' ? t('com problema') : t('aguardando')}</span></li>`;
  }
  function readTool(receipt) {
    if(receipt.capability==='company.read')return 'elozi_read_company';
    const operation = receipt.result?.operation;
    return operation === 'inbox' ? 'elozi_list_conversations' : operation === 'search' ? 'elozi_search_conversations' : operation === 'conversation-history' ? 'elozi_read_conversation_history' : operation === 'groups' ? 'elozi_list_groups' : operation === 'group-history' ? 'elozi_read_group_history' : receipt.result?.conversationId ? 'elozi_read_conversation' : '';
  }
  /** A receipt of the current key: same keyRevision, or (without it) made after the key was issued. */
  const currentKey = (receipt, p) => !(Number.isSafeInteger(p?.principalRevision)&&Number.isSafeInteger(receipt?.revision)&&receipt.revision!==p.principalRevision) && (Number.isSafeInteger(p?.keyRevision) && Number.isSafeInteger(receipt?.keyRevision) ? receipt.keyRevision === p.keyRevision : !before(receipt?.createdAt, p?.keyIssuedAt));
  const readCapabilities = () => draftCapabilities(draft, accepted()).filter(capability=>['conversation.read','company.read'].includes(capability));
  function checksMarkup() {
    const p = poll || {}, reads=readCapabilities(),caps=draftCapabilities(draft,accepted()),receipts = (p.receipts || []).filter(item => currentKey(item, p)), read = receipts.find(item => reads.includes(item.capability) && item.state === 'confirmed');
    const readProblem = !read && receipts.find(item => reads.includes(item.capability) && PROBLEM.has(item.state));
    const draftReceipt = receipts.find(item => item.capability === 'reply.submit' && item.state === 'confirmed');
    const sentReceipt=receipts.find(item=>item.capability==='reply.send'&&item.state==='confirmed');
    const status = p.state === 'success' ? t('Leitura confirmada. Nenhuma mensagem foi enviada pelo assistente de configuração.') : p.state === 'timeout' ? t('Ainda sem chamada depois de 10 minutos.') : p.state === 'hidden' ? t('Verificação pausada com a aba oculta.') : p.state === 'error' ? t('Não foi possível consultar os recibos agora.') : t('Aguardando a primeira chamada…');
    const readDetail = read ? [readTool(read), timeText(read.createdAt)].filter(Boolean).join(' · ') : readProblem ? t('Chamada recusada: confira canais, departamentos e validade.') : reads.includes('conversation.read')?'elozi_list_conversations':'elozi_read_company';
    return h`<p class="pg-connect__status" data-state="${p.state || 'waiting'}">${status}${!p.state || p.state === 'running' ? h` <small>${t('(consulta a cada 3 s, até 10 min; pausa com a aba oculta)')}</small>` : ''}</p>
      <ul class="pg-connect__checks">${p.features?.lastSeen ? checkLine(p.lastSeenAt ? 'ok' : 'waiting', t('Chave aceita'), p.lastSeenAt ? timeText(p.lastSeenAt) : t('aguardando a primeira chamada')) : ''}
      ${checkLine(read ? 'ok' : readProblem ? 'problem' : 'waiting', reads.includes('conversation.read')?t('Leitura autorizada'):t('Consulta da empresa autorizada'), readDetail)}
      ${caps.includes('reply.submit') ? checkLine(draftReceipt ? 'ok' : 'waiting', t('Rascunho para revisão'), draftReceipt ? timeText(draftReceipt.createdAt) : t('opcional · elozi_submit_draft')) : ''}
      ${caps.includes('reply.send')?checkLine(sentReceipt?'ok':'waiting',t('Envio confirmado por recibo'),sentReceipt?timeText(sentReceipt.createdAt):t('Não verificado; nenhum envio de teste é executado.')):''}</ul>
      ${p.accessChanged?h`<p class="pg-connect__hint">${t('O acesso desta identidade mudou. Revise-o em Agentes antes de verificar novamente.')}</p>`:''}
      ${['success', 'timeout', 'hidden', 'error'].includes(p.state) ? button({ label: p.state === 'success' ? t('Atualizar recibos') : t('Verificar de novo'), action: 'connect:verify-again', icon: 'refresh', size: 'sm' }) : ''}`;
  }
  const promptText = c => readCapabilities().includes('conversation.read')?t('Liste meus atendimentos abertos na {company} e resuma o mais antigo.', { company: c.tenant?.name || '' }):t('Consulte a estrutura autorizada da {company} com elozi_read_company e confira o recibo, sem criar propostas.',{company:c.tenant?.name||''});
  const agentHash = agentId => { try { return formatHash({ section: 'agents', params: { agentId } }); } catch { return '#agents'; } };
  function verifyStep(c) {
    const checks = String(checksMarkup()); painted = { target: null, html: checks };
    return h`<section class="pg-connect__card" aria-labelledby="connect-verify-title"><h2 id="connect-verify-title">6 · ${STEP_LABELS.verify}</h2>
      <div data-connect-checks aria-live="polite">${raw(checks)}</div>
      <p class="pg-connect__hint">${t('Descoberta: confira tools/list no cliente. A consulta confirma o acesso; não comprova resposta enviada. Esta tela nunca envia uma mensagem de teste.')}</p>
      <div class="pg-connect__prompt"><p><span>${t('Peça ao seu agente:')}</span> ${h`<q>${promptText(c)}</q>`}</p>${button({ label: t('Copiar'), action: 'connect:copy-prompt', icon: 'copy', size: 'sm' })}</div>
      <div class="pg-connect__nav">${draft.agentId ? h`<a class="ui-btn ui-btn--secondary ui-btn--md" href="${agentHash(draft.agentId)}"><span class="ui-btn__label">${t('Ir para o agente')}</span></a>` : h`<span></span>`}<a class="ui-btn ui-btn--primary ui-btn--md" href="#inbox"><span class="ui-btn__label">${t('Abrir Atendimento')}</span></a></div></section>`;
  }

  /** Cancelar/Recomeçar after the key exists: revoke it or keep it, never forget it silently. */
  function leaveConfirm() {
    if (!leaving || !draft.principalId) return '';
    const restart = leaving === 'restart';
    return h`<div class="pg-connect__confirm" role="group" aria-labelledby="connect-leave-title" data-connect-leave><p id="connect-leave-title" tabindex="-1"><strong>${t('A chave criada continua ativa.')}</strong></p>
      <p>${t('{name} pode usar a chave com as tarefas e os canais escolhidos até ela vencer. Revogue se não for usar esta conexão.', { name: draft.agentName || draft.name })}</p>
      <div class="pg-connect__row">${button({ label: restart ? t('Revogar a chave e recomeçar') : t('Revogar a chave e sair'), action: 'connect:leave-revoke', variant: 'danger', busy })}${button({ label: restart ? t('Recomeçar e manter a chave') : t('Sair e manter a chave'), action: 'connect:leave-keep', disabled: busy })}${button({ label: t('Continuar no assistente'), action: 'connect:leave-stay', variant: 'ghost', disabled: busy })}</div></div>`;
  }

  const legacyView = () => pageHeading(t('AGENTES CONECTADOS'), t('Uma identidade para cada integração.'), t('Escolha o adaptador, as ações e os limites de cada serviço.')) + principals();

  /** The page for #agents/connect[/<step>] (legacy key service-agents; #service-agents is an alias). */
  function view(route) {
    if (!wired) return legacyView();
    const c = ctx();
    if (!c.tenant?.id) return String(h`<section class="pg-connect">${emptyState({ icon: 'building', title: t('Abra uma empresa para conectar um agente.'), body: t('A chave do agente vale para uma empresa por vez.') })}</section>`);
    if (!isAdmin(c)) return String(h`<section class="pg-connect">${emptyState({ icon: 'shield', title: c.supportGrantId ? t('Durante o suporte temporário, a conexão de agentes fica com a administração da conta.') : t('Somente a administração da empresa conecta agentes.'), body: t('Peça a quem administra a empresa para conectar o agente.') })}</section>`);
    load(scopeOf(c));
    const requested = route?.section === 'agents' && route.params?.tab === 'connect' ? route.params.step || 'identity' : 'identity';
    const step = allowedStep(requested, c);
    if (!['key', 'configure'].includes(step)) clearSecret();
    if (step !== 'verify') stopPoll('left');
    pendingReplace = step !== requested ? stepHash(step) : null;
    const body = { identity: identityStep, goal: goalStep, access: accessStep, key: keyStep, configure: configureStep, verify: verifyStep }[step](c);
    const resume = step === 'identity' && (draft.principalId || draft.agentId) && !leaving ? h`${banner({ tone: 'info', title: t('Há uma conexão em andamento.'), body: t('Continue de onde parou ou recomece do início.'), action: { label: t('Continuar'), action: 'connect:resume' } })}<div class="pg-connect__row">${button({ label: t('Recomeçar'), action: 'connect:restart', variant: 'link', size: 'sm' })}</div>` : '';
    const existing = step === 'identity' ? h`<details class="pg-connect__existing"><summary>Agentes já conectados nesta empresa</summary>${raw(principals())}</details>` : '';
    return String(h`<section class="pg-connect" data-connect-root data-step="${step}">${heading(c)}${stepper(step, c)}${leaveConfirm()}${resume}${body}${existing}</section>`);
  }

  // ---- after render ------------------------------------------------------------------------------
  function mount(main, route) {
    if (!wired) return;
    mounted = { main, route };
    if (pendingReplace && typeof history?.replaceState === 'function') { try { history.replaceState(history.state, '', pendingReplace); } catch { /* keep the hash */ } }
    pendingReplace = null;
    const c = ctx(); if (!isAdmin(c) || !c.tenant?.id) return;
    void loadServerCapabilities(c);
    const root = main?.querySelector?.('[data-connect-root]'), form = root?.querySelector?.('form[data-form^="connect:"]');
    // Moving between steps re-renders the page: the focus goes to the heading of the new step (§4.2).
    const step = root?.dataset?.step;
    if (step && lastStep && step !== lastStep) { const title = root.querySelector?.('.pg-connect__card h2'); if (title) { title.tabIndex = -1; title.focus?.({ preventScroll: false }); } }
    if (step) lastStep = step;
    if (form?.addEventListener) {
      form.addEventListener('input', () => capture(form));
      form.addEventListener('change', event => {
        capture(form);
        if (root.dataset.step === 'goal' || root.dataset.step === 'access' && ['channelMode', 'departmentMode'].includes(event?.target?.name)) rerender();
        if (event?.target?.matches?.('[data-connect-saved]')) { const next = form.querySelector('[data-connect-next]'); if (next) next.disabled = !draft.keySaved; }
      });
    }
    if (root?.dataset?.step === 'verify') startPoll(c);
  }
  /**
   * Re-renders only the wizard (never the whole app). The focus goes to `focus` (or a target the last task
   * asked for), else back to the same control, else, when that control is gone, to the step title (§4.2).
   */
  function rerender({ focus = '' } = {}) {
    const wanted = focus || pendingFocus; pendingFocus = '';
    const root = mounted?.main?.querySelector?.('[data-connect-root]');
    if (!root?.isConnected || !root.ownerDocument?.createElement) return false;
    const active = root.ownerDocument.activeElement, inside = Boolean(active && root.contains?.(active)), selector = inside ? focusSelector(active) : '';
    const template = root.ownerDocument.createElement('template');
    template.innerHTML = view(mounted.route);
    const fresh = template.content.firstElementChild;
    if (!fresh) return false;
    root.replaceWith(fresh);
    mount(mounted.main, mounted.route);
    const title = () => { const heading = fresh.querySelector?.('.pg-connect__card h2'); if (heading) heading.tabIndex = -1; return heading; };
    const target = (wanted && fresh.querySelector?.(wanted)) || (selector && fresh.querySelector?.(selector)) || (inside || wanted ? title() : null);
    target?.focus?.({ preventScroll: true });
    return true;
  }
  function focusSelector(element) {
    const quote = value => String(value).replace(/["\\]/g, '\\$&');
    if (element.dataset?.action) return `[data-action="${quote(element.dataset.action)}"]${element.dataset.tab ? `[data-tab="${quote(element.dataset.tab)}"]` : ''}`;
    if (element.hasAttribute?.('data-connect-next')) return '[data-connect-next]';
    if (element.name) return `[name="${quote(element.name)}"]${element.type === 'checkbox' || element.type === 'radio' ? `[value="${quote(element.value)}"]` : ''}`;
    if (element.id) return `[id="${quote(element.id)}"]`;
    return '';
  }

  // ---- form values -------------------------------------------------------------------------------
  function values(form) {
    const result = {}, many = new Set(['goals', 'directActions', 'channelIds', 'departmentIds']);
    for (const element of Array.from(form?.elements || [])) {
      const name = element?.name; if (!name || element.disabled) continue;
      if (element.type === 'checkbox') { if (many.has(name)) { result[name] ||= []; if (element.checked) result[name].push(element.value); } else result[name] = Boolean(element.checked); }
      else if (element.type === 'radio') { if (element.checked) result[name] = element.value; }
      else result[name] = element.value;
    }
    return result;
  }
  /** Copies what the person typed into the draft (no validation), so a re-render never loses it. */
  function capture(form) {
    const step = String(form?.dataset?.form || '').slice('connect:'.length), v = values(form);
    if (draft.principalId && step !== 'key') return;
    if (step === 'identity') { if (!draft.agentId && typeof v.name === 'string') draft.name = v.name.slice(0, NAME_MAX); if (v.client) draft.client = CLIENT_CHOICES.includes(v.client) ? v.client : 'json'; }
    if (step === 'goal') {
      draft.goals = GOALS.filter(goal => (v.goals || []).includes(goal.id) && goalAvailable(goal, accepted())).map(goal => goal.id);
      draft.directActions = DIRECT_ACTIONS.filter(id => (v.directActions || []).includes(id));
      draft.directRisk = draft.directActions.length > 0 && v.directRisk === true; draft.attendRisk = draft.goals.includes('attend') && v.attendRisk === true;
    }
    if (step === 'access') {
      // Disabled all-mode controls are absent from values; retain the last explicit selection.
      if (v.channelIds !== undefined && (draft.channelMode === 'some' || v.channelMode === 'some')) draft.channelIds = ids(v.channelIds);
      if (v.departmentIds !== undefined && (draft.departmentMode === 'some' || v.departmentMode === 'some')) draft.departmentIds = ids(v.departmentIds);
      draft.channelMode = v.channelMode === 'some' ? 'some' : 'all';
      draft.departmentMode = v.departmentMode === 'some' ? 'some' : 'all';
      draft.dailyRequests = limitValue(v.dailyRequests, 10000); draft.maxConcurrent = limitValue(v.maxConcurrent, 20); draft.ttlHours = integer(v.ttlHours, 1, 2160, draft.ttlHours);
    }
    if (step === 'key') draft.keySaved = v.keySaved === true;
    persist();
  }

  // ---- server data -------------------------------------------------------------------------------
  async function loadServerCapabilities(c) {
    const scope = scopeOf(c);
    if (!scope || server.scope === scope && (server.loading || server.capabilities || now() - server.failedAt < RETRY_CAPABILITIES_MS)) return;
    server = { scope, capabilities: null, loading: true, failedAt: 0 };
    try {
      const result = await request(tenantPath(c, '/service-principals'), options(c));
      if (server.scope !== scope) return;
      server = { scope, capabilities: Array.isArray(result?.capabilities) ? result.capabilities : null, loading: false, failedAt: Array.isArray(result?.capabilities) ? 0 : now() };
      if (server.capabilities && scopeOf(ctx()) === scope && currentStep() === 'goal') rerender();
    } catch { if (server.scope === scope) server = { scope, capabilities: null, loading: false, failedAt: now() }; }
  }

  // ---- orchestration -----------------------------------------------------------------------------
  /**
   * One run at a time. task(c, same, scope, mine) gets the company and the progress (`mine`) it started
   * with: what the server confirms is saved there (save) even if the person switched company meanwhile.
   */
  function run(task) {
    if (inflight) return inflight;
    const c = ctx(), scope = scopeOf(c);
    if (!isAdmin(c) || !scope || scope !== draftScope) return Promise.resolve(false);
    const mine = draft, authority=authorityOf(c),same = () => isAdmin(ctx())&&authorityOf(ctx())===authority && draftScope === scope;
    inflight = (async () => {
      busy = true; error = ''; errorField = ''; rerender();
      try { return await task(c, same, scope, mine); }
      catch (failure) {
        if (!same()) return false;
        error = failure?.local ? failure.message
          : Number.isSafeInteger(failure?.status) && failure.status >= 400 ? translateError(failure.message) || t('Não foi possível concluir. Tente de novo.')
            : t('A resposta do servidor não chegou. Tente de novo: o assistente confere antes o que já foi criado.');
        errorField = '';
        return false;
      } finally { busy = false; inflight = null; if (same()) rerender(); }
    })();
    return inflight;
  }
  /** Agents of the company as the server has them now (the summary when the server offers it). */
  async function freshAgents(c) {
    let tenant = null;
    try { tenant = await request(tenantPath(c, (c.features || []).includes('tenant-summary') ? '?summary=1' : ''), options(c)); } catch { /* below */ }
    if (!Array.isArray(tenant?.agents)) throw localError(t('Não foi possível conferir se o agente já foi criado. Tente de novo em instantes.'));
    return tenant.agents;
  }
  /** After an unknown outcome: the agent this wizard may have created (new since the attempt, same name, MCP). */
  async function adoptAgent(c, scope, mine) {
    const attempt = mine.agentAttempt, known = new Set(attempt.known);
    const found = (await freshAgents(c)).find(agent => agent && typeof agent.id === 'string' && ID.test(agent.id) && !known.has(agent.id) && agent.provider === 'mcp' && String(agent.name || '').trim() === attempt.name);
    if (found) { mine.agentId = found.id; mine.agentName = String(found.name || attempt.name).slice(0, NAME_MAX); }
    mine.agentAttempt = null; save(scope, mine);
  }
  /** After an unknown outcome: the identity this wizard may have created for its agent. Its key was never shown. */
  async function adoptPrincipal(c, scope, mine) {
    let list = null;
    try { list = await request(tenantPath(c, '/service-principals'), options(c)); } catch { /* below */ }
    if (!Array.isArray(list?.principals)) throw localError(t('Não foi possível conferir se a chave já foi criada. Tente de novo em instantes.'));
    const found = list.principals.filter(item => item && typeof item.id === 'string' && ID.test(item.id) && item.agentId === mine.agentId && ['active', 'paused'].includes(item.state))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    mine.principalAttempt = null;
    if (found) Object.assign(mine, { principalId: found.id, principalRevision: Number.isSafeInteger(found.revision) ? found.revision : null, keyRevision: Number.isSafeInteger(found.keyRevision) ? found.keyRevision : null, keyIssuedAt: instant(found.updatedAt) || instant(found.createdAt), keySaved: false });
    save(scope, mine);
    return Boolean(found);
  }
  async function createAgent(c, scope, mine) {
    if (mine.agentAttempt) await adoptAgent(c, scope, mine);
    if (mine.agentId) return;
    const name = mine.name.trim();
    mine.agentAttempt = { at: now(), name, known: ids((c.tenant?.agents || []).map(agent => agent?.id)).slice(0, 100) }; save(scope, mine);
    let agent;
    // The server requires the agent's role (1–200 characters): it is the summary of the tasks chosen in step 2.
    const description = Array.from(`${t('Agente conectado por MCP')}: ${mine.goals.map(id => GOAL_LABELS[id] || id).join(', ') || t('consulta')}`).slice(0, 200).join('');
    try { agent = await request(tenantPath(c, '/agents'), options(c, { method: 'POST', body: JSON.stringify({ name, provider: 'mcp', mode: 'copilot', description }) })); }
    catch (failure) { if (definite(failure)) { mine.agentAttempt = null; save(scope, mine); } throw failure; }
    if (!agent || typeof agent.id !== 'string' || !ID.test(agent.id) || agent.provider !== 'mcp') throw localError(t('O servidor não confirmou o agente criado. Tente de novo: o assistente confere antes o que já foi criado.'));
    mine.agentId = agent.id; mine.agentName = String(agent.name || name).slice(0, NAME_MAX); mine.agentAttempt = null; save(scope, mine);
  }
  function create() {
    // A stale "Criar" (old tab, late click) never mints a second key: once the key exists, only "Trocar chave" does.
    if (draft.principalId && !inflight) return Promise.resolve(false);
    const c = ctx(), problem = !validName() ? problemOf(t('Volte ao passo 1 e dê um nome ao agente.')) : goalProblem() || accessProblem(c);
    if (problem && !inflight) { showProblem({ message: problem.message }); return Promise.resolve(false); }
    return run(async (c, same, scope, mine) => {
      if (mine.principalId) return false;
      if (!mine.agentId) await createAgent(c, scope, mine);
      if (!same()) return false;
      if (mine.principalAttempt && await adoptPrincipal(c, scope, mine)) {
        if (same()) say(t('A chave já tinha sido criada, mas a resposta não chegou. Troque a chave para receber uma nova.'));
        return true;
      }
      const payload = { name: (mine.agentName || mine.name).trim(), agentId: mine.agentId, capabilities: draftCapabilities(mine, accepted()),
        channelIds: mine.channelMode === 'all' ? null : mine.channelIds, departmentIds: mine.departmentMode === 'all' ? null : mine.departmentIds,
        dailyRequests: mine.dailyRequests, maxConcurrent: mine.maxConcurrent, ttlHours: mine.ttlHours, active: true };
      mine.principalAttempt = { at: now() }; save(scope, mine);
      let result;
      try { result = await request(tenantPath(c, '/service-principals'), options(c, { method: 'POST', body: JSON.stringify(payload) })); }
      catch (failure) {
        if (definite(failure)) { mine.principalAttempt = null; save(scope, mine); }
        // The agent may have been removed meanwhile: only a fresh company without it releases the agentId
        // (a stale list would otherwise create a second agent on the next attempt).
        if (failure?.status === 400 && typeof refresh === 'function' && same()) {
          try { await refresh(); if (same() && Array.isArray(ctx().tenant?.agents) && !ctx().tenant.agents.some(agent => agent.id === mine.agentId)) { mine.agentId = null; mine.agentName = ''; save(scope, mine); } } catch { /* keep the agent */ }
        }
        throw failure;
      }
      const token = typeof result?.token === 'string' ? result.token : '', principal = result?.principal;
      if (result && typeof result === 'object') result.token = '';
      if (!principal?.id || !ID.test(principal.id) || principal.agentId !== mine.agentId) throw localError(t('O servidor não confirmou a chave. Tente de novo: o assistente confere antes o que já foi criado.'));
      Object.assign(mine, { principalId: principal.id, principalRevision: Number.isSafeInteger(principal.revision) ? principal.revision : null, keyRevision: Number.isSafeInteger(principal.keyRevision) ? principal.keyRevision : null,
        keyIssuedAt: instant(principal.updatedAt) || instant(principal.createdAt), keySaved: false, principalAttempt: null });
      save(scope, mine);
      if (!SECRET.test(token)) throw localError(t('A chave criada não chegou a esta tela. Troque a chave para receber uma nova.'));
      if (!same()) return false;
      secret = { token, principalId: mine.principalId }; revealed = false; pendingFocus = KEY_TITLE; syncListener();
      say(t('Agente e chave criados. Guarde a chave agora.'));
      if (typeof refresh === 'function') Promise.resolve().then(() => refresh()).catch(() => {});
      return true;
    });
  }
  /** The identity as the server has it now (null when it is gone). */
  async function currentPrincipal(c, mine) {
    const list = await request(tenantPath(c, '/service-principals'), options(c));
    return (list?.principals || []).find(item => item?.id === mine.principalId) || null;
  }
  function rotate() {
    if (!draft.principalId) return Promise.resolve(false);
    return run(async (c, same, scope, mine) => {
      const current = await currentPrincipal(c, mine);
      if (!same()) return false;
      if (!current || !['active', 'paused'].includes(current.state) || !Number.isSafeInteger(current.revision)) throw localError(t('Esta conexão não está mais ativa. Recomece o assistente para criar outra.'));
      const result = await request(tenantPath(c, `/service-principals/${encodeURIComponent(mine.principalId)}/rotate`), options(c, { method: 'POST', body: JSON.stringify({ revision: current.revision }) }));
      const token = typeof result?.token === 'string' ? result.token : '', principal = result?.principal;
      if (result && typeof result === 'object') result.token = '';
      if (principal?.id !== mine.principalId) throw localError(t('O servidor não confirmou a nova chave. Atualize antes de tentar de novo.'));
      Object.assign(mine, { principalRevision: Number.isSafeInteger(principal.revision) ? principal.revision : mine.principalRevision,
        keyRevision: Number.isSafeInteger(principal.keyRevision) ? principal.keyRevision : Number.isSafeInteger(mine.keyRevision) ? mine.keyRevision + 1 : null,
        keyIssuedAt: instant(principal.updatedAt), keySaved: false });
      save(scope, mine);
      if (!SECRET.test(token)) throw localError(t('A chave criada não chegou a esta tela. Troque a chave para receber uma nova.'));
      if (!same()) return false;
      secret = { token, principalId: mine.principalId }; revealed = false; rotating = false; pendingFocus = KEY_TITLE; syncListener();
      say(t('Chave trocada. A anterior deixou de funcionar.'));
      return true;
    });
  }
  /** Ends the wizard: Cancelar goes to Agentes, Recomeçar starts over. The key (if any) was revoked or kept on purpose. */
  function finishLeaving(kind, { quiet = false } = {}) {
    const agent = !quiet && Boolean(draft.agentId) && !draft.principalId, unknownKey = agent && Boolean(draft.principalAttempt);
    clearSecret(); stopPoll('left'); forget(); error = ''; errorField = ''; leaving = null; rotating = false;
    if (agent) say(unknownKey ? t('O agente criado continua em Agentes. Confira o acesso dele: uma chave pode ter sido criada sem resposta.') : t('O agente criado continua em Agentes, aguardando a conexão.'));
    if (kind === 'cancel') go('#agents'); else rerender({ focus: '[name="name"]' });
    return true;
  }
  function revokeAndLeave() {
    const kind = leaving;
    return run(async (c, same, scope, mine) => {
      const current = await currentPrincipal(c, mine);
      if (current && current.state !== 'revoked') {
        if (!Number.isSafeInteger(current.revision)) throw localError(t('Não foi possível conferir a chave atual. Revogue em Agentes, no acesso do agente.'));
        await request(tenantPath(c, `/service-principals/${encodeURIComponent(mine.principalId)}/revoke`), options(c, { method: 'POST', body: JSON.stringify({ revision: current.revision }) }));
      }
      if (!same()) { try { storage()?.removeItem(CONNECT_STORAGE_PREFIX + scope); } catch {} return false; }
      const name = mine.agentName || mine.name;
      finishLeaving(kind, { quiet: true });
      say(t('Chave revogada. O agente {name} continua em Agentes, sem conexão.', { name }));
      return true;
    });
  }

  // ---- verification ------------------------------------------------------------------------------
  function startPoll(c, { force = false } = {}) {
    if (!draft.principalId||!isAdmin(c)) return;
    const same = poll && poll.principalId === draft.principalId && poll.scope === draftScope && poll.authority===authorityOf(c)&&poll.principalRevision===draft.principalRevision&&poll.keyRevision === draft.keyRevision && poll.keyIssuedAt === draft.keyIssuedAt;
    if (same && !force) {
      // A re-render never restarts the 10 minutes: a paused check resumes (or times out) as when the tab shows again.
      if (poll.state === 'hidden' && doc?.visibilityState !== 'hidden') resume(); else paintChecks();
      return;
    }
    if (same && force && poll.state === 'running') return;
    const previous = same ? poll : null;
    stopPoll('restart');
    poll = { scope: draftScope, authority:authorityOf(c),principalId: draft.principalId, principalRevision:draft.principalRevision,keyRevision: draft.keyRevision, keyIssuedAt: draft.keyIssuedAt, startedAt: now(), timer: null, state: 'running', receipts: previous?.receipts || [], lastSeenAt: previous?.lastSeenAt || null, notified: previous?.notified || false,
      features: { lastSeen: (c.features || []).includes('principal-last-seen') }, ticket: 0 };
    if (typeof doc?.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
    syncListener();
    if (doc?.visibilityState === 'hidden') { poll.state = 'hidden'; paintChecks(); return; }
    paintChecks(); void tick();
  }
  function stopPoll(reason) {
    if (!poll) return;
    timers.clearTimeout?.(poll.timer); poll.timer = null; poll.ticket++;
    if (reason !== 'hidden' && typeof doc?.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
    if (['left', 'scope', 'restart'].includes(reason)) { poll = null; syncListener(); return; }
    poll.state = reason; paintChecks();
  }
  /** Back from a hidden tab: the budget counts from the start, hidden time included. */
  function resume() {
    if (now() - poll.startedAt >= POLL_BUDGET_MS) { stopPoll('timeout'); return; }
    poll.state = 'running'; paintChecks(); void tick();
  }
  function onVisibility() {
    if (!poll) return;
    if (doc.visibilityState === 'hidden') { if (poll.state === 'running') stopPoll('hidden'); return; }
    if (poll.state === 'hidden') resume();
  }
  function verifyMounted() { const root = mounted?.main?.querySelector?.('[data-connect-root]'); return Boolean(root && root.isConnected !== false && root.dataset?.step === 'verify'); }
  async function tick() {
    const current = poll; if (!current || current.state !== 'running') return;
    const ticket = ++current.ticket, c = ctx();
    const active=()=>poll===current&&ticket===current.ticket&&isAdmin(ctx())&&authorityOf(ctx())===current.authority&&draft.principalId===current.principalId&&draft.principalRevision===current.principalRevision&&draft.keyRevision===current.keyRevision&&verifyMounted();
    if (!active()) { stopPoll('left'); return; }
    if (doc?.visibilityState === 'hidden') { stopPoll('hidden'); return; }
    if (now() - current.startedAt >= POLL_BUDGET_MS) { stopPoll('timeout'); return; }
    try {
      const result = await request(tenantPath(c, `/service-principals/${encodeURIComponent(current.principalId)}/receipts`), options(c));
      if (!active()) { if(poll===current)stopPoll('left');return; }
      const list = await request(tenantPath(c, '/service-principals'), options(c));
      if (!active()) { if(poll===current)stopPoll('left');return; }
      const principal=(list?.principals||[]).find(item=>item?.id===current.principalId);
      if(!principal||principal.state!=='active'||principal.revision!==current.principalRevision||Number.isSafeInteger(current.keyRevision)&&principal.keyRevision!==current.keyRevision){current.accessChanged=true;stopPoll('error');return;}
      current.receipts = (Array.isArray(result?.receipts) ? result.receipts : []).filter(item => item && typeof item.capability === 'string');
      if (current.features.lastSeen) {
        const seen = instant(principal.lastSeenAt);
        // A call before the key was issued (the previous key) does not count as "Chave aceita".
        current.lastSeenAt = seen && !before(seen, current.keyIssuedAt) ? seen : null;
      }
      if (current.receipts.some(item => readCapabilities().includes(item.capability) && item.state === 'confirmed' && currentKey(item, current))) {
        stopPoll('success'); if (!current.notified) { current.notified = true; say(t('{name} está conectado.', { name: draft.agentName || draft.name })); } return;
      }
      paintChecks();
    } catch (failure) {
      if (!active()) { if(poll===current)stopPoll('left');return; }
      if ([401, 403, 404].includes(failure?.status)) { stopPoll('error'); return; }
    }
    if (poll === current && current.state === 'running' && ticket === current.ticket) current.timer = timers.setTimeout(() => { void tick(); }, POLL_EVERY_MS);
  }
  /** Writes the live region only when its content changes, so a screen reader hears each change once. */
  function paintChecks() {
    const target = mounted?.main?.querySelector?.('[data-connect-checks]');
    if (!target) return;
    const html = String(checksMarkup());
    if (painted.html === html && (painted.target === target || painted.target === null)) { painted.target = target; return; }
    painted = { target, html }; target.innerHTML = html;
  }

  // ---- actions -----------------------------------------------------------------------------------
  async function copy(text, success) {
    const authority=authorityOf(ctx()),scope=draftScope;
    try {
      const target = clipboard();
      if (typeof target?.writeText !== 'function') throw new Error('clipboard');
      await target.writeText(text);if(!isAdmin(ctx())||authorityOf(ctx())!==authority||draftScope!==scope)return false;say(success); return true;
    } catch { if(isAdmin(ctx())&&authorityOf(ctx())===authority&&draftScope===scope)say(t('Não foi possível copiar. Selecione o texto e copie manualmente.'), true); return false; }
  }
  function snippetFor(c) {
    const where = mcpOrigin({ locationOrigin: location?.origin, publicOrigin: c.publicOrigin, canonicalPublicOrigin: c.canonicalPublicOrigin });
    const client = draft.client === 'bridge' && !c.platformOwner ? 'hermes' : draft.client;
    return clientSnippet(client, { origin: where.origin, slug: connectionSlug(c.brandName, c.tenant?.name, { platform: c.platformOwner }), tenantName: c.tenant?.name,system:system() });
  }
  function skillCommandFor(c) {
    const where = mcpOrigin({ locationOrigin: location?.origin, publicOrigin: c.publicOrigin, canonicalPublicOrigin: c.canonicalPublicOrigin });
    return skillInstallCommand({ origin: where.origin, slug: connectionSlug(c.brandName, c.tenant?.name, { platform: c.platformOwner }) });
  }
  const VERBS = new Set(['back', 'cancel', 'create', 'reveal', 'copy-key', 'copy-config', 'copy-with-key', 'copy-skill', 'client','system', 'rotate', 'rotate-confirm', 'rotate-cancel', 'verify-again', 'copy-prompt', 'resume', 'restart', 'leave-revoke', 'leave-keep', 'leave-stay']);
  async function act(name, id, element) {
    if (!wired || typeof name !== 'string' || !name.startsWith('connect:')) return false;
    const verb = name.slice('connect:'.length);
    if (!VERBS.has(verb)) return false;
    const c = ctx();
    if (!isAdmin(c) || !c.tenant?.id) return true;
    load(scopeOf(c));
    if (verb === 'back') { const form = element?.closest?.('form'); if (form) capture(form); error = ''; errorField = ''; const target = element?.dataset?.step; go(stepHash(CONNECT_STEPS.includes(target) ? target : 'identity')); return true; }
    if (verb === 'cancel' || verb === 'restart') {
      if (inflight) return true;
      // With a key, leaving asks first: revoke it or keep it (it stays valid until it expires).
      if (draft.principalId) { leaving = verb; error = ''; errorField = ''; rerender({ focus: '#connect-leave-title' }); return true; }
      return finishLeaving(verb);
    }
    if (verb === 'leave-stay') { const from = leaving; leaving = null; rerender({ focus: from ? `[data-action="connect:${from}"]` : '' }); return true; }
    if (verb === 'leave-keep') {
      if (!leaving || inflight) return true;
      const kind = leaving; finishLeaving(kind);
      say(t('A chave continua ativa até vencer. Para desligar a conexão, revogue a chave no acesso do agente, em Agentes.'));
      return true;
    }
    if (verb === 'leave-revoke') { if (leaving && draft.principalId) await revokeAndLeave(); return true; }
    if (verb === 'create') { await create(); return true; }
    if (verb === 'reveal') { if (hasSecret()) { revealed = !revealed; rerender(); } return true; }
    if (verb === 'copy-key') { if(currentStep()!=='key')return true;if (hasSecret()) await copy(secret.token, t('Chave copiada. Cole só no cliente do agente.')); else say(t('A chave não está mais disponível nesta tela.'), true); return true; }
    if (verb === 'copy-config') { const snippet = snippetFor(c); if (snippet) await copy(snippet.code, t('Configuração copiada, sem a chave.')); return true; }
    // The install command has no key: it goes to the clipboard and nowhere else (no URL, storage or download).
    if (verb === 'copy-skill') { await copy(skillCommandFor(c), t('Comando copiado.')); return true; }
    if (verb === 'copy-with-key') return true;
    if (verb === 'client') { const client = element?.dataset?.tab || id; if (CLIENTS.includes(client) && (client !== 'bridge' || c.platformOwner)) { draft.client = client; persist(); rerender(); } return true; }
    if (verb === 'system') { const selected=element?.dataset?.system||id;if(['windows','posix'].includes(selected)){draft.system=selected;persist();rerender();}return true; }
    if (verb === 'rotate') { rotating = true; error = ''; errorField = ''; rerender(); return true; }
    if (verb === 'rotate-cancel') { rotating = false; rerender(); return true; }
    if (verb === 'rotate-confirm') { await rotate(); return true; }
    if (verb === 'verify-again') { startPoll(c, { force: true }); return true; }
    if (verb === 'copy-prompt') { await copy(promptText(c), t('Pedido copiado.')); return true; }
    if (verb === 'resume') { go(stepHash(firstOpen(c) || 'configure')); return true; }
    return true;
  }

  async function submit(form) {
    const name = form?.dataset?.form;
    if (!wired || typeof name !== 'string' || !name.startsWith('connect:')) return false;
    const step = name.slice('connect:'.length);
    if (!CONNECT_STEPS.includes(step)) return false;
    const c = ctx(); if (!isAdmin(c) || !c.tenant?.id) return true;
    load(scopeOf(c));
    if (busy) return true;
    capture(form);
    const problem = step === 'identity' ? (validName() ? null : problemOf(t('Dê um nome ao agente, com até 48 caracteres.'), 'name'))
      : step === 'goal' && !draft.principalId ? goalProblem()
        : step === 'access' && !draft.principalId ? accessProblem(c)
          : step === 'key' ? (!draft.principalId ? problemOf(t('Crie a chave antes de avançar.')) : hasSecret() && !draft.keySaved ? problemOf(t('Confirme que guardou a chave.'), 'keySaved') : null) : null;
    if (problem) { showProblem(problem); return true; }
    error = ''; errorField = '';
    const next = CONNECT_STEPS[CONNECT_STEPS.indexOf(step) + 1];
    if (next) go(stepHash(next));
    return true;
  }

  function reset() { clearSecret(); stopPoll('left'); draftScope = ''; draft = freshDraft(); error = ''; errorField = ''; busy = false; inflight = null; rotating = false; leaving = null; mounted = null; pendingReplace = null; pendingFocus = ''; painted = { target: null, html: '' }; lastStep = null; server = { scope: '', capabilities: null, loading: false, failedAt: 0 }; }

  return { view, act, submit, reset, mount,
    /** Diagnostics for tests and support: never exposes the key. */
    get debug() { return { scope: draftScope, draft: { ...draft }, hasSecret: Boolean(secret?.token), revealed, busy, polling: poll ? poll.state : null, error, errorField, leaving }; } };
}
