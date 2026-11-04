// "Conectar meu agente" (public/agent-connect-wizard.js, P6, FRONTEND-V2 §5.3.3 and §8.7) against a
// synthetic API: six steps with deep links, progress resumable without the key, orchestration safe against
// double clicks, a failure of the second call, unknown outcomes and a company switch, the key kept only in
// memory (spies on storage, history, URL and location), safe configuration clipboard copies, snippets per
// company that never put the key in a command line, leaving with the key revoked or kept on purpose, and
// the live verification (current key only, a budget no re-render restarts, a live region written on change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setLocale } from '../public/i18n.js';
import '../public/locales-live.js';
import { parseHash } from '../public/router.js';
import '../public/nav-config.js';
import { createAgentConnectWizard, brandSlug, connectionSlug, tokenVariable, mcpOrigin, clientSnippet, clientSystem, draftCapabilities, skillInstallCommand, skillMode, ATTENDANT_SKILL_PATH, POLL_EVERY_MS, POLL_BUDGET_MS, CONNECT_STORAGE_PREFIX } from '../public/agent-connect-wizard.js';
import { ATTENDANT_SKILL_PATH as SERVED_SKILL_PATH } from '../src/agent-skill.js';

const KEY = 'elozi_svc_' + 'K'.repeat(39) + 'Zq9w';
const KEY_2 = 'elozi_svc_' + 'N'.repeat(39) + 'Rt5y';
const OLD_SERVER = ['conversation.read', 'reply.draft', 'reply.submit', 'reply.send', 'message.schedule', 'handoff.request', 'company.read', 'company.propose'];
const settle = () => new Promise(resolve => setImmediate(resolve));
const pageHeading = (eyebrow, title, description, actions = '') => `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const lost = () => Object.assign(new TypeError('Failed to fetch'));

function fakeTimers() {
  let clock = 1_000_000, sequence = 0; const queue = new Map();
  return {
    now: () => clock,
    setTimeout(fn, ms) { const id = ++sequence; queue.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout(id) { queue.delete(id); },
    get pending() { return queue.size; },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...queue.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        clock = next[1].at; queue.delete(next[0]); next[1].fn(); await settle(); await settle();
      }
      clock = end;
    }
  };
}
function emitter(extra = {}) {
  const listeners = new Map();
  return { ...extra, listeners, addEventListener(name, fn) { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, fire(name) { for (const fn of [...(listeners.get(name) || [])]) fn({ type: name }); }, count(name) { return listeners.get(name)?.size || 0; } };
}

function fixture({ owner = false, role = 'reseller', support = null, brand = 'Acme Atendimento', publicOrigin = 'https://app.elozi.test', canonical = 'https://app.elozi.test', origin = 'https://app.elozi.test', features = [], capabilities = null, intercept, tenant = {}, principal = {}, rotated = {}, platform = 'Linux' } = {}) {
  const state = {
    workspaceId: 'workspace-a', supportGrantId: support,
    boot: { session: { userId: 'person-a', role, platformOwner: owner }, reseller: { brand: { name: brand } }, publicOrigin, canonicalPublicOrigin: canonical, features },
    tenant: { id: 'tenant-a', name: 'Loja Centro', agents: [], channels: [{ id: 'whatsapp-a', name: 'WhatsApp Vendas' }, { id: 'telegram-a', name: 'Telegram' }], departments: [{ id: 'sales', name: 'Vendas' }, { id: 'old', name: 'Antigo', active: false }], ...tenant }
  };
  const writes = [], items = new Map();
  const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => { writes.push([key, String(value)]); items.set(key, String(value)); }, removeItem: key => items.delete(key) };
  const location = { hash: '#agents/connect', origin };
  const history = { state: null, calls: [], replaceState(...args) { this.calls.push(['replace', ...args]); }, pushState(...args) { this.calls.push(['push', ...args]); } };
  const hashes = [], clipboard = [], toasts = [], calls = [], timers = fakeTimers(), doc = emitter({ visibilityState: 'visible' }), win = emitter();
  // What the synthetic server holds: agents and identities created through it.
  const server = { agents: [], principals: [] };
  let agents = 0, principals = 0;
  const fallback = (path, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'POST' && path === '/api/tenants/tenant-a/agents') { agents++; const agent = { id: agents === 1 ? 'agent-new' : 'agent-dup-' + agents, name: JSON.parse(init.body).name, provider: 'mcp', mode: 'copilot', configured: true, state: 'awaiting_connection' }; server.agents.push(agent); return agent; }
    if (method === 'GET' && /^\/api\/tenants\/tenant-a(\?summary=1)?$/.test(path)) return { id: 'tenant-a', agents: [...state.tenant.agents, ...server.agents] };
    if (method === 'POST' && path === '/api/tenants/tenant-a/service-principals') { principals++; const created = { id: principals === 1 ? 'principal-new' : 'principal-dup-' + principals, agentId: JSON.parse(init.body).agentId, revision: 1, state: 'active', ...principal }; server.principals.push({ ...created, lastSeenAt: null }); return { principal: created, token: KEY }; }
    if (method === 'GET' && path === '/api/tenants/tenant-a/service-principals') return { principals: server.principals.map(item => ({ ...item })), ...(capabilities ? { capabilities } : {}) };
    if (method === 'POST' && path === '/api/tenants/tenant-a/service-principals/principal-new/rotate') { const next = { id: 'principal-new', revision: 2, state: 'active', ...rotated }; Object.assign(server.principals.find(item => item.id === 'principal-new') || {}, next); return { principal: next, token: KEY_2 }; }
    if (method === 'POST' && path === '/api/tenants/tenant-a/service-principals/principal-new/revoke') { const item = server.principals.find(entry => entry.id === 'principal-new'); Object.assign(item, { state: 'revoked', revision: item.revision + 1 }); return { principal: { ...item } }; }
    if (method === 'GET' && path === '/api/tenants/tenant-a/service-principals/principal-new/receipts') return { receipts: [] };
    throw Object.assign(new Error('rota inesperada ' + method + ' ' + path), { status: 404 });
  };
  const request = async (path, init = {}) => { calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers }); return intercept ? intercept(path, init, () => fallback(path, init)) : fallback(path, init); };
  const options = { pageHeading, principals: () => '<section data-principals>legado</section>', state, request, toast: (message, error = false) => toasts.push([message, error]), refresh: null,
    navigate: hash => { hashes.push(hash); location.hash = hash; }, history, location, clipboard: () => ({ writeText: async text => { clipboard.push(text); } }), storage: () => storage, timers, doc, win, platform: () => platform };
  const wizard = createAgentConnectWizard(options);
  const view = hash => { if (hash) location.hash = hash; return wizard.view(parseHash(location.hash)); };
  const posts = suffix => calls.filter(call => call.method === 'POST' && call.path.endsWith(suffix)).length;
  return { wizard, view, state, storage, writes, items, location, history, hashes, clipboard, toasts, calls, timers, doc, win, options, server, posts, counts: () => ({ agents, principals }) };
}

const element = (name, value, type = 'text', checked = false) => ({ name, value: String(value), type, checked, disabled: false });
const form = (step, elements) => ({ dataset: { form: 'connect:' + step }, elements });
const identity = (name = 'Nova', client = 'hermes') => form('identity', [element('name', name), ...['hermes', 'claude', 'codex', 'json'].map(value => element('client', value, 'radio', value === client))]);
const goal = ({ goals = ['consult', 'draft'], direct = [], directRisk = false, attendRisk = false } = {}) => form('goal', [
  ...['consult', 'draft', 'team', 'management', 'attend'].map(value => element('goals', value, 'checkbox', goals.includes(value))),
  ...['reply.send', 'message.schedule'].map(value => element('directActions', value, 'checkbox', direct.includes(value))),
  element('directRisk', 'yes', 'checkbox', directRisk), element('attendRisk', 'yes', 'checkbox', attendRisk)]);
const access = ({ channelMode = 'all', channels = [], departmentMode = 'all', departments = [], daily = 500, concurrent = 2, ttl = 2160 } = {}) => form('access', [
  ...['all', 'some'].map(value => element('channelMode', value, 'radio', value === channelMode)), ...['whatsapp-a', 'telegram-a'].map(value => element('channelIds', value, 'checkbox', channels.includes(value))),
  ...['all', 'some'].map(value => element('departmentMode', value, 'radio', value === departmentMode)), ...['unassigned', 'sales'].map(value => element('departmentIds', value, 'checkbox', departments.includes(value))),
  element('dailyRequests', daily), element('maxConcurrent', concurrent), element('ttlHours', ttl)]);
async function walk(f, goalOptions) {
  f.view('#agents/connect');
  await f.wizard.submit(identity()); await f.wizard.submit(goal(goalOptions)); await f.wizard.submit(access());
  assert.equal(f.location.hash, '#agents/connect/key');
}
function leaked(f, secret = KEY) {
  const places = [...f.writes.map(([key, value]) => key + value), ...f.history.calls.map(call => JSON.stringify(call)), ...f.hashes, f.location.hash, JSON.stringify(f.wizard.debug), JSON.stringify(f.toasts)];
  return places.filter(place => place.includes(secret) || place.includes(secret.slice(10)));
}
/** A verify page "mounted" with fakes: the live region starts with what the view rendered and counts writes. */
function mountVerify(f) {
  const html = f.view('#agents/connect/verify');
  let content = /<div data-connect-checks aria-live="polite">([\s\S]*?)<\/div>\s*<div class="pg-connect__prompt">/.exec(html)?.[1] ?? '';
  const checks = { writes: 0, get innerHTML() { return content; }, set innerHTML(value) { this.writes++; content = value; } };
  const root = { dataset: { step: 'verify' }, isConnected: true, querySelector: () => null };
  const main = { querySelector: selector => selector === '[data-connect-root]' ? root : selector === '[data-connect-checks]' ? checks : null };
  f.wizard.mount(main, parseHash('#agents/connect/verify'));
  return { checks, root, main };
}
async function toVerify(f, goalOptions) {
  await walk(f, goalOptions); await f.wizard.act('connect:create'); await f.wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', true)])); await f.wizard.submit(form('configure', []));
  assert.equal(f.location.hash, '#agents/connect/verify');
}

test('sem o contexto do painel a tela continua sendo a página legada de Agentes conectados (sem regressão)', async () => {
  const wizard = createAgentConnectWizard({ pageHeading, principals: () => '<section data-principals></section>' });
  assert.equal(wizard.view(parseHash('#agents/connect/key')), pageHeading('AGENTES CONECTADOS', 'Uma identidade para cada integração.', 'Escolha o adaptador, as ações e os limites de cada serviço.') + '<section data-principals></section>');
  assert.equal(await wizard.act('connect:create'), false); assert.equal(await wizard.submit(form('identity', [])), false); assert.equal(wizard.reset(), undefined);
});

test('seis passos com deep link; #service-agents é alias; um passo à frente abre o primeiro pendente sem criar histórico', async () => {
  const f = fixture();
  for (const step of ['identity', 'goal', 'access', 'key', 'configure', 'verify']) assert.deepEqual({ ...parseHash('#agents/connect/' + step).params }, { tab: 'connect', step });
  const alias = parseHash('#service-agents');
  assert.equal(alias.alias, 'service-agents'); assert.deepEqual({ ...alias.params }, { tab: 'connect' });
  assert.match(f.wizard.view(alias), /data-step="identity"/);
  const html = f.view('#agents/connect/configure');
  assert.match(html, /data-step="identity"/, 'sem nome o assistente começa pela identidade');
  f.wizard.mount({ querySelector: () => null }, parseHash(f.location.hash));
  assert.deepEqual(f.history.calls.map(call => [call[0], call[3]]), [['replace', '#agents/connect/identity']], 'replaceState, sem nova entrada de histórico');
  assert.match(html, /<nav class="pg-connect__stepper" aria-label="Etapas"><ol>/); assert.match(html, /aria-current="step"/);
  for (const step of ['goal', 'access', 'key', 'configure', 'verify']) assert.doesNotMatch(html, new RegExp(`href="#agents/connect/${step}"`), `${step} ainda não abre`);
  await f.wizard.submit(identity(''));
  assert.equal(f.wizard.debug.errorField, 'name');
  assert.match(f.view(), /<input name="name"[^>]*aria-invalid="true" aria-describedby="connect-name-hint connect-error"\/>/, 'campo inválido ligado à mensagem (§4.2)');
  assert.match(f.view(), /<p class="pg-connect__error" id="connect-error" role="alert" data-connect-error>Dê um nome ao agente/);
  await f.wizard.submit(identity());
  assert.equal(f.location.hash, '#agents/connect/goal'); assert.equal(f.wizard.debug.error, '');
  assert.match(f.view(), /data-step="goal"/); assert.match(f.view(), /href="#agents\/connect\/identity"/, 'passos concluídos viram links');
  assert.doesNotMatch(f.view('#agents/connect/identity'), /aria-invalid/, 'o erro some depois de corrigido');
});

test('título genérico para clientes MCP; atendente e suporte temporário não conectam', async () => {
  assert.match(fixture({ owner: true }).view(), /<h1>Conectar meu agente<\/h1>/);
  const reseller = fixture().view();
  assert.match(reseller, /<h1>Conectar meu agente<\/h1>/); assert.doesNotMatch(reseller, /Hermes<\/h1>/);
  assert.match(reseller, /acessa Acme Atendimento por MCP/);
  for (const options of [{ role: 'operator' }, { support: 'grant-a' }]) {
    const f = fixture(options), html = f.view('#agents/connect/key');
    assert.doesNotMatch(html, /data-action="connect:create"|data-form="connect:/); assert.match(html, /ui-empty/);
    assert.equal(await f.wizard.act('connect:create'), true); assert.equal(await f.wizard.submit(identity()), true);
    assert.equal(f.calls.length, 0, 'nenhuma requisição sem papel de administração');
  }
  setLocale('en', { persist: false, notify: false });
  try { assert.match(fixture().view(), /<h1>Connect my agent<\/h1>[\s\S]*Identity[\s\S]*Client you use/); }
  finally { setLocale('pt-BR', { persist: false, notify: false }); }
});

test('passo 2: ferramentas do catálogo; "Atender sozinho" só com as capacidades de atendente no servidor; Enviar diz grupos e conversas do agente', async () => {
  const old = fixture({ capabilities: OLD_SERVER });
  old.view('#agents/connect'); old.wizard.mount({ querySelector: () => null }, parseHash('#agents/connect')); await settle();
  assert.deepEqual(old.calls.map(call => [call.method, call.path]), [['GET', '/api/tenants/tenant-a/service-principals']]);
  await old.wizard.submit(identity());
  let html = old.view('#agents/connect/goal');
  for (const tool of ['elozi_list_conversations', 'elozi_submit_draft', 'elozi_request_human_support', 'elozi_read_company', 'elozi_propose_flow']) assert.ok(html.includes(tool), tool);
  assert.match(html, /<input type="checkbox" name="goals" value="attend" disabled\/>/, 'servidor sem as capacidades de atendente');
  assert.match(html, /Atender sozinho <span class="ui-badge ui-badge--neutral">Em breve<\/span>/); assert.doesNotMatch(html, /name="attendRisk"/);
  await old.wizard.submit(goal({ goals: ['attend'], attendRisk: true }));
  assert.equal(old.location.hash, '#agents/connect/goal', 'tarefa indisponível não avança'); assert.match(old.wizard.debug.error, /Escolha pelo menos uma tarefa/); assert.equal(old.wizard.debug.errorField, 'goals');
  await old.wizard.submit(goal({ goals: ['consult'], direct: ['message.schedule'] }));
  assert.match(old.wizard.debug.error, /risco das ações diretas/); assert.equal(old.wizard.debug.errorField, 'directRisk');
  assert.match(old.view(), /<input type="checkbox" name="directRisk" value="yes" aria-invalid="true" aria-describedby="connect-error"\/>/);
  await old.wizard.submit(goal({ goals: ['consult'], direct: ['message.schedule'], directRisk: true }));
  assert.equal(old.location.hash, '#agents/connect/access');
  assert.deepEqual(draftCapabilities(old.wizard.debug.draft), ['conversation.read', 'message.schedule']);

  const g = fixture();
  await g.wizard.submit(identity());
  html = g.view('#agents/connect/goal');
  assert.match(html, /<input type="checkbox" name="goals" value="attend"\/>/); assert.doesNotMatch(html, /name="attendRisk"|name="directRisk"/);
  for (const tool of ['elozi_wait_for_events', 'elozi_send_reply', 'elozi_claim_conversation', 'elozi_transfer_to_human', 'elozi_set_tags', 'elozi_close_conversation']) assert.ok(html.includes(tool), `${tool} servida`);
  assert.doesNotMatch(html, /data-state="planned"/, 'nenhuma ferramenta anunciada sem o servidor');
  assert.match(html, /<legend class="pg-connect__label">Ações diretas: exigem confiança<\/legend>/);
  assert.match(html, /Enviar também responde ao cliente nas conversas atribuídas a este agente\./, 'reply.send não aparece como permissão só de grupos');
  assert.match(html, /name="directActions" value="reply.send"\/><span>Enviar sem revisão nos grupos autorizados e nas conversas atribuídas ao agente<\/span>/);
  await g.wizard.submit(goal({ goals: ['attend'] }));
  assert.match(g.wizard.debug.error, /atende sozinho/); assert.equal(g.wizard.debug.errorField, 'attendRisk');
  await g.wizard.submit(goal({ goals: ['attend'], attendRisk: true }));
  assert.equal(g.location.hash, '#agents/connect/access');
  assert.deepEqual(draftCapabilities(g.wizard.debug.draft), ['conversation.read', 'reply.send', 'events.read', 'conversation.manage']);
  assert.match(g.view('#agents/connect/goal'), /name="directActions" value="reply.send" checked disabled/, 'Atender sozinho inclui reply.send');
});

test('orquestração: duplo clique faz um agente e uma chave, com escopo, limites e cabeçalho do workspace', async () => {
  const gate = deferred();
  const f = fixture({ intercept: async (path, init, fallback) => { if (init.method === 'POST' && path.endsWith('/agents')) await gate.promise; return fallback(); } });
  await walk(f, { goals: ['consult', 'draft', 'team'] });
  await f.wizard.submit(access({ channelMode: 'some', channels: ['whatsapp-a'], departmentMode: 'some', departments: ['unassigned', 'sales'], daily: 750, concurrent: 3, ttl: 720 }));
  const first = f.wizard.act('connect:create'), second = f.wizard.act('connect:create');
  assert.equal(f.wizard.debug.busy, true); assert.match(f.view('#agents/connect/key'), /data-action="connect:create" aria-busy="true"/);
  gate.resolve(); await Promise.all([first, second]); await f.wizard.act('connect:create');
  assert.deepEqual(f.counts(), { agents: 1, principals: 1 });
  const [agent, principal] = f.calls.filter(call => call.method === 'POST');
  // The server requires the agent's role (1–200 chars): the wizard sends the summary of the chosen tasks.
  assert.deepEqual(agent.body, { name: 'Nova', provider: 'mcp', mode: 'copilot', description: 'Agente conectado por MCP: Consultar, Preparar respostas, Ajudar a equipe' });
  assert.deepEqual(principal.body, { name: 'Nova', agentId: 'agent-new', capabilities: ['conversation.read', 'reply.submit', 'handoff.request'], channelIds: ['whatsapp-a'], departmentIds: ['unassigned', 'sales'], dailyRequests: 750, maxConcurrent: 3, ttlHours: 720, active: true });
  for (const call of f.calls) assert.equal(call.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.equal(f.wizard.debug.hasSecret, true); assert.equal(f.wizard.debug.draft.principalId, 'principal-new');
  assert.equal(f.wizard.debug.draft.agentAttempt, null); assert.equal(f.wizard.debug.draft.principalAttempt, null);
  assert.deepEqual(leaked(f), [], 'a chave não vai para storage, histórico, hash ou diagnósticos');
});

test('falha no 2º passo retoma com o agentId já criado e não cria outro agente', async () => {
  let fail = true;
  const f = fixture({ intercept: (path, init, fallback) => { if (init.method === 'POST' && path.endsWith('/service-principals') && fail) throw Object.assign(new Error('Limite de serviços atingido.'), { status: 429 }); return fallback(); } });
  await walk(f);
  assert.equal(await f.wizard.act('connect:create'), true);
  assert.equal(f.wizard.debug.draft.agentId, 'agent-new'); assert.equal(f.wizard.debug.draft.principalId, null); assert.match(f.wizard.debug.error, /Limite de serviços/);
  assert.equal(f.wizard.debug.draft.principalAttempt, null, 'resposta do servidor (4xx): nada a conferir');
  const html = f.view('#agents/connect/key');
  assert.match(html, /O agente Nova já foi criado\./); assert.match(html, />Criar a chave</);
  const reload = createAgentConnectWizard({ ...f.options });
  assert.match(reload.view(parseHash('#agents/connect/key')), /O agente Nova já foi criado\./, 'o agentId sobrevive a recarregar a página');
  fail = false; await f.wizard.act('connect:create');
  assert.deepEqual(f.counts(), { agents: 1, principals: 1 }); assert.equal(f.posts('/agents'), 1);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/service-principals')).at(-1).body.agentId, 'agent-new');
  assert.equal(f.wizard.debug.hasSecret, true);
});

test('resposta perdida ao criar o agente: a nova tentativa adota o agente criado em vez de criar outro', async () => {
  let drop = true;
  const f = fixture({ tenant: { agents: [{ id: 'agent-old', name: 'Nova', provider: 'mcp' }] }, features: ['tenant-summary'],
    intercept: (path, init, fallback) => { if (init.method === 'POST' && path.endsWith('/agents') && drop) { drop = false; fallback(); throw lost(); } return fallback(); } });
  await walk(f);
  await f.wizard.act('connect:create');
  assert.match(f.wizard.debug.error, /A resposta do servidor não chegou/); assert.equal(f.wizard.debug.draft.agentId, null);
  assert.equal(f.wizard.debug.draft.agentAttempt.name, 'Nova'); assert.deepEqual(f.wizard.debug.draft.agentAttempt.known, ['agent-old']);
  const reload = createAgentConnectWizard({ ...f.options });
  reload.view(parseHash('#agents/connect/key'));
  await reload.act('connect:create');
  assert.equal(f.posts('/agents'), 1, 'um único agente no servidor');
  assert.ok(f.calls.some(call => call.method === 'GET' && call.path === '/api/tenants/tenant-a?summary=1'), 'confere antes de criar');
  assert.equal(reload.debug.draft.agentId, 'agent-new', 'adota o agente novo, nunca o homônimo que já existia');
  assert.equal(f.posts('/service-principals'), 1); assert.equal(reload.debug.hasSecret, true);
});

test('resposta perdida ao criar a chave: a nova tentativa adota a identidade criada e oferece trocar a chave', async () => {
  let drop = true;
  const f = fixture({ intercept: (path, init, fallback) => { if (init.method === 'POST' && path.endsWith('/service-principals') && drop) { drop = false; fallback(); throw Object.assign(new Error('Serviço indisponível.'), { status: 502 }); } return fallback(); } });
  await walk(f);
  await f.wizard.act('connect:create');
  assert.equal(f.wizard.debug.draft.principalId, null); assert.ok(f.wizard.debug.draft.principalAttempt, 'resultado incerto (5xx) fica marcado');
  await f.wizard.act('connect:create');
  assert.equal(f.posts('/service-principals'), 1, 'nenhuma segunda identidade');
  assert.equal(f.wizard.debug.draft.principalId, 'principal-new'); assert.equal(f.wizard.debug.hasSecret, false);
  assert.match(f.toasts.at(-1)[0], /Troque a chave para receber uma nova/);
  const html = f.view('#agents/connect/key');
  assert.match(html, /A chave não aparece de novo\./); assert.match(html, /data-action="connect:rotate"/);
  assert.deepEqual(leaked(f), []);
});

test('troca de empresa durante a criação: o agente confirmado fica no progresso da empresa de origem', async () => {
  const gate = deferred();
  const f = fixture({ intercept: async (path, init, fallback) => { if (init.method === 'POST' && path.endsWith('/agents')) await gate.promise; return fallback(); } });
  await walk(f);
  const running = f.wizard.act('connect:create');
  f.state.tenant = { ...f.state.tenant, id: 'tenant-b', name: 'Atacado Sul' }; f.view('#agents/connect');
  gate.resolve(); await running;
  assert.equal(f.posts('/service-principals'), 0, 'a chave não é criada para a empresa que saiu da tela');
  f.state.tenant = { ...f.state.tenant, id: 'tenant-a', name: 'Loja Centro' };
  assert.match(f.view('#agents/connect/key'), /O agente Nova já foi criado\./, 'o agentId não se perde');
  await f.wizard.act('connect:create');
  assert.equal(f.posts('/agents'), 1); assert.equal(f.posts('/service-principals'), 1); assert.equal(f.wizard.debug.hasSecret, true);
});

test('a chave nunca vai para storage, URL, histórico ou download; aparece mascarada, uma vez, e some ao sair do passo 5', async () => {
  const created = [], original = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = (...args) => { created.push(args); return 'blob:x'; };
  try {
    const f = fixture();
    await walk(f); await f.wizard.act('connect:create');
    let html = f.view('#agents/connect/key');
    assert.ok(!html.includes(KEY), 'mascarada por padrão'); assert.match(html, /elozi_svc_•{24}Zq9w/);
    assert.match(html, /<strong data-connect-key-title tabindex="-1">Sua chave aparece uma única vez<\/strong>/, 'alvo do foco depois de criar');
    assert.match(html, /data-action="connect:reveal" aria-pressed="false"/);
    assert.match(html, /<button type="submit" class="ui-btn ui-btn--primary ui-btn--md" disabled data-connect-next="">/, 'Avançar só depois de "Guardei a chave"');
    await f.wizard.act('connect:reveal'); html = f.view();
    assert.ok(html.includes(KEY), 'Mostrar exibe só na tela'); assert.match(html, /aria-pressed="true"/);
    await f.wizard.act('connect:copy-key'); assert.deepEqual(f.clipboard, [KEY]);
    await f.wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', false)]));
    assert.equal(f.location.hash, '#agents/connect/key'); assert.match(f.wizard.debug.error, /guardou a chave/); assert.equal(f.wizard.debug.errorField, 'keySaved');
    await f.wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', true)]));
    assert.equal(f.location.hash, '#agents/connect/configure');
    html = f.view();
    assert.ok(!html.includes(KEY), 'o passo 5 nunca exibe a chave'); assert.match(html, /&lt;sua chave&gt;/);
    await f.wizard.act('connect:copy-config');
    assert.ok(!f.clipboard.at(-1).includes(KEY)); assert.match(f.clipboard.at(-1), /ACME_LOJA_CENTRO_MCP_TOKEN=<sua chave>/);
    await f.wizard.act('connect:copy-with-key');
    assert.ok(!f.clipboard.at(-1).includes(KEY), 'configuração nunca incorpora a chave, inclusive ação antiga forjada');
    assert.ok(!f.view().includes(KEY));
    assert.equal(f.win.count('hashchange'), 1, 'enquanto a chave existe, a saída do passo é vigiada');
    f.location.hash = '#agents/connect/verify'; f.win.fire('hashchange');
    assert.equal(f.wizard.debug.hasSecret, false, 'sair do passo 5 apaga a chave da memória');
    assert.equal(f.win.count('hashchange'), 0);
    const copied=f.clipboard.length;await f.wizard.act('connect:copy-with-key');assert.equal(f.clipboard.length,copied);
    assert.deepEqual(leaked(f), []); assert.deepEqual(created, [], 'nenhum arquivo baixado');
    assert.ok(f.writes.length > 0 && f.writes.every(([key]) => key.startsWith(CONNECT_STORAGE_PREFIX + 'workspace-a:tenant-a:person-a')));
    assert.equal(f.clipboard.filter(text => text.includes(KEY)).length, 1, 'somente a custódia explícita no passo Chave copia o segredo');
  } finally { globalThis.URL.createObjectURL = original; }
});

test('retomar sem a chave: recarregar no passo 5 mostra o aviso, oferece troca de chave e nunca reexibe a anterior', async () => {
  const f = fixture();
  await walk(f); await f.wizard.act('connect:create');
  await f.wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', true)]));
  const reload = createAgentConnectWizard({ ...f.options });
  const configure = reload.view(parseHash('#agents/connect/configure'));
  assert.match(configure, /data-step="configure"/); assert.doesNotMatch(configure, /data-action="connect:copy-with-key"/); assert.match(configure, /A chave não está mais nesta tela/);
  const key = reload.view(parseHash('#agents/connect/key'));
  assert.match(key, /A chave não aparece de novo\./); assert.match(key, /data-action="connect:rotate"/); assert.ok(!key.includes(KEY));
  await reload.act('connect:rotate');
  assert.match(reload.view(parseHash('#agents/connect/key')), /data-action="connect:rotate-confirm"/, 'troca exige confirmação');
  await reload.act('connect:rotate-confirm');
  const rotate = f.calls.find(call => call.path.endsWith('/rotate'));
  assert.deepEqual(rotate.body, { revision: 1 }); assert.equal(reload.debug.hasSecret, true);
  assert.match(reload.view(parseHash('#agents/connect/key')), /elozi_svc_•{24}Rt5y/);
  assert.deepEqual(leaked(f, KEY_2), []);
  reload.reset(); assert.equal(reload.debug.hasSecret, false, 'troca de empresa ou workspace apaga a chave');
});

test('snippets por empresa: slug e variável da marca e da empresa, a chave nunca numa linha de comando, ponte local só para o dono', async () => {
  assert.equal(brandSlug('Acme Atendimento'), 'acme-atendimento'); assert.equal(brandSlug('Ótica São João!'), 'otica-sao-joao'); assert.equal(brandSlug('3D Store'), 'ws-3d-store');
  assert.equal(brandSlug('', { platform: true }), 'elozi'); assert.equal(brandSlug(''), 'atendimento'); assert.equal(tokenVariable('acme-atendimento'), 'ACME_ATENDIMENTO_MCP_TOKEN');
  assert.equal(connectionSlug('Acme Atendimento', 'Loja Centro'), 'acme-loja-centro', 'a marca fica com a 1ª palavra quando as duas não cabem');
  assert.equal(connectionSlug('Acme', 'Loja Centro'), 'acme-loja-centro'); assert.equal(connectionSlug('Acme Atendimento', 'Sul'), 'acme-atendimento-sul');
  assert.equal(connectionSlug('', 'Loja Centro', { platform: true }), 'elozi-loja-centro'); assert.equal(connectionSlug('Acme Atendimento', ''), 'acme-atendimento');
  assert.notEqual(connectionSlug('Acme Atendimento', 'Loja Centro'), connectionSlug('Acme Atendimento', 'Atacado Sul'), 'duas empresas nunca compartilham entrada, variável ou id da ponte');
  assert.ok(connectionSlug('Revenda Nacional de Atendimento', 'Distribuidora Regional Centro-Oeste').length <= 26, 'cabe no prefixo das ferramentas (≤ 64 caracteres)');
  assert.deepEqual(mcpOrigin({ locationOrigin: 'https://painel.acme.com.br', publicOrigin: 'https://painel.acme.com.br', canonicalPublicOrigin: 'https://app.elozi.test' }), { origin: 'https://painel.acme.com.br', custom: true, secure: true });
  assert.deepEqual(mcpOrigin({ locationOrigin: 'https://painel.acme.com.br', publicOrigin: 'https://app.elozi.test', canonicalPublicOrigin: 'https://app.elozi.test' }), { origin: 'https://app.elozi.test', custom: false, secure: true }, 'domínio próprio inativo ou sem TLS usa a origem principal');
  assert.deepEqual(mcpOrigin({ locationOrigin: 'http://painel.acme.com.br', publicOrigin: 'http://painel.acme.com.br', canonicalPublicOrigin: 'https://app.elozi.test' }), { origin: 'https://app.elozi.test', custom: false, secure: true });
  assert.equal(mcpOrigin({ locationOrigin: 'http://127.0.0.1:4318', canonicalPublicOrigin: 'http://127.0.0.1:4318' }).secure, false);
  const base = { origin: 'https://painel.acme.com.br', slug: 'acme-loja-centro', tenantName: 'Loja "Centro"' };
  const hermes = clientSnippet('hermes', base);
  assert.match(hermes.code,/Authorization: "Bearer \$\{ACME_LOJA_CENTRO_MCP_TOKEN\}"/);
  assert.match(hermes.code,/ACME_LOJA_CENTRO_MCP_TOKEN=<sua chave>/);assert.equal(hermes.withKey,null);
  const claude = clientSnippet('claude', base);
  assert.match(claude.code,/\(\n  read -rs ACME_LOJA_CENTRO_MCP_TOKEN && export ACME_LOJA_CENTRO_MCP_TOKEN \|\| exit/);assert.match(claude.code,/claude mcp add --transport http acme-loja-centro/);assert.ok(claude.code.endsWith('\n)'));
  const codex = clientSnippet('codex', base);
  assert.match(codex.code, /^# ~\/\.codex\/config\.toml\n\[mcp_servers\.acme-loja-centro\]\nurl = "https:\/\/painel\.acme\.com\.br\/api\/agent\/mcp"\nbearer_token_env_var = "ACME_LOJA_CENTRO_MCP_TOKEN"\ntool_timeout_sec = 60\n/);
  assert.match(codex.code,/\n  codex\n\)$/);assert.doesNotMatch(codex.code,/bashrc|zshrc|export [A-Z_]+="/);
  const json = clientSnippet('json', base);
  assert.deepEqual(JSON.parse(json.code), { mcpServers: { 'acme-loja-centro': { type: 'http', url: 'https://painel.acme.com.br/api/agent/mcp', headers: { Authorization: 'Bearer ${ACME_LOJA_CENTRO_MCP_TOKEN}' } } } });
  assert.equal(json.withKey,null);
  const curl = clientSnippet('curl', base);
  assert.match(curl.code, /-H "Accept: application\/json, text\/event-stream"/); assert.match(curl.code, /"method":"tools\/call","params":\{"name":"elozi_me","arguments":\{\}\}/);
  const bridge = clientSnippet('bridge', base);
  assert.match(bridge.code, /"id": "acme-loja-centro", "name": "Loja \\"Centro\\"", "endpoint": "https:\/\/painel\.acme\.com\.br\/api\/agent\/mcp", "tokenEnv": "ACME_LOJA_CENTRO_MCP_TOKEN"/); assert.match(bridge.code, /ELOZI_MCP_CONFIG_PATH/);
  for (const snippet of [hermes,claude,codex,json,curl,bridge]) {
    assert.equal(snippet.withKey, null, `${snippet.client}: terminal sem versão com a chave`);
    assert.ok(!snippet.code.includes(KEY));
  }
  assert.equal(clientSnippet('other', base), null);

  const custom = fixture({ origin: 'https://painel.acme.com.br', publicOrigin: 'https://painel.acme.com.br' });
  await walk(custom); await custom.wizard.act('connect:create');
  let html = custom.view('#agents/connect/configure');
  assert.match(html, /https:\/\/painel\.acme\.com\.br\/api\/agent\/mcp/); assert.match(html, /domínio próprio com HTTPS ativo/);
  assert.match(html, /hermes mcp test acme-loja-centro/); assert.match(html, /\/reload-mcp/); assert.match(html, /Formato conferido com a documentação de MCP do Hermes Agent \(10\/2026\)/);
  assert.doesNotMatch(html, /data-tab="bridge"/, 'ponte local só para o dono'); assert.doesNotMatch(html, /elozi-|ELOZI_[A-Z_]*MCP_TOKEN/i);
  assert.match(html, /data-tab="hermes"[^>]*>Hermes Agent/); assert.match(html, /data-tab="curl"/);
  await custom.wizard.act('connect:client', null, { dataset: { tab: 'bridge' } });
  assert.match(custom.view(), /aria-selected="true"[^>]*data-tab="hermes"|data-tab="hermes"[^>]*aria-selected="true"|id="connect-clients-tab-hermes"[^>]*aria-selected="true"/, 'quem não é dono não abre a ponte local');
  await custom.wizard.act('connect:client', null, { dataset: { tab: 'codex' } });
  html = custom.view();
  assert.match(html, /bearer_token_env_var = &quot;ACME_LOJA_CENTRO_MCP_TOKEN&quot;/); assert.match(html, /codex mcp list/);
  await custom.wizard.act('connect:client', null, { dataset: { tab: 'claude' } });
  html = custom.view();
  assert.doesNotMatch(html, /connect:copy-with-key|connect:copy-key/, 'configuração não oferece copiar segredo'); assert.match(html, /A configuração copiada não contém a chave/);
  const before = custom.clipboard.length; await custom.wizard.act('connect:copy-with-key'); assert.equal(custom.clipboard.length, before, 'ação forjada não copia a chave para o terminal');
  const second = fixture({ tenant: { id: 'tenant-a', name: 'Atacado Sul' } });
  await walk(second); await second.wizard.act('connect:create');
  assert.match(second.view('#agents/connect/configure'), /acme-atacado-sul:[\s\S]*ACME_ATACADO_SUL_MCP_TOKEN/, 'outra empresa, outra entrada e outra variável');
  const inactive = fixture({ origin: 'https://painel.acme.com.br' });
  await walk(inactive); await inactive.wizard.act('connect:create');
  assert.match(inactive.view('#agents/connect/configure'), /https:\/\/app\.elozi\.test\/api\/agent\/mcp/);
  const local = fixture({ origin: 'http://127.0.0.1:4318', publicOrigin: 'http://127.0.0.1:4318', canonical: 'http://127.0.0.1:4318' });
  await walk(local); await local.wizard.act('connect:create');
  assert.match(local.view('#agents/connect/configure'), /Endereço sem HTTPS confirmado/);
  const owner = fixture({ owner: true, brand: '' });
  await walk(owner); await owner.wizard.act('connect:create');
  html = owner.view('#agents/connect/configure');
  assert.match(html, /data-tab="bridge"/); assert.match(html, /ELOZI_LOJA_CENTRO_MCP_TOKEN/);
});

test('passo 5, Hermes: skill de atendente com o comando na origem do MCP, cópia só para a área de transferência e próximo passo pelo acesso', async () => {
  assert.equal(ATTENDANT_SKILL_PATH, SERVED_SKILL_PATH, 'o comando aponta para a rota servida');
  assert.equal(skillInstallCommand({ origin: 'https://painel.acme.com.br', slug: 'acme-loja-centro' }), 'hermes skills install https://painel.acme.com.br/api/agent/skills/attendant/SKILL.md --name acme-loja-centro-atendente');
  assert.equal(skillMode(['conversation.read', 'reply.send', 'events.read', 'conversation.manage']), 'send'); assert.equal(skillMode(['conversation.read', 'reply.send', 'reply.submit']), 'send');
  assert.equal(skillMode(['conversation.read', 'reply.submit']), 'drafts'); assert.equal(skillMode(['conversation.read']), 'read'); assert.equal(skillMode(), 'read');

  // Active custom domain with TLS, agent that handles conversations on its own.
  const custom = fixture({ origin: 'https://painel.acme.com.br', publicOrigin: 'https://painel.acme.com.br' }), command = 'hermes skills install https://painel.acme.com.br/api/agent/skills/attendant/SKILL.md --name acme-loja-centro-atendente';
  await walk(custom, { goals: ['attend'], attendRisk: true }); await custom.wizard.act('connect:create');
  let html = custom.view('#agents/connect/configure');
  assert.match(html, /<section class="pg-connect__preview" data-connect-skill="send" aria-labelledby="connect-skill-title"><h3 class="pg-connect__subhead" id="connect-skill-title">Skill de atendente<\/h3>/, 'bloco separado, com título próprio');
  assert.ok(html.includes(`<code data-connect-skill-command>${command}</code>`), 'comando exato, numa linha, com a origem e o slug da conexão');
  assert.match(html, /aria-label="Comando de instalação da skill"/); assert.match(html, /data-action="connect:copy-skill"/);
  assert.match(html, /Depois, no chat: <code>\/reload-mcp<\/code> e <code>\/reload-skills<\/code>; em seguida: <code>\/acme-loja-centro-atendente comece a atender<\/code>/);
  assert.match(html, /Permissão solicitada: responder sem revisão por mensagem nas conversas atribuídas e autorizadas/); assert.match(html, /isto não comprova listener ativo/); assert.doesNotMatch(html, /O agente responde sozinho nas conversas atribuídas a ele/);
  assert.ok(html.indexOf('data-connect-skill=') > html.indexOf('hermes mcp test acme-loja-centro'), 'depois da configuração do MCP');
  assert.doesNotMatch(html, /elozi-|ELOZI_[A-Z_]*MCP_TOKEN/i, 'marca branca'); assert.ok(!html.includes(KEY));
  // The copy goes to the clipboard and nowhere else: no key, no URL, no history entry, no storage write, no download.
  const before = { writes: custom.writes.length, hashes: custom.hashes.length, history: custom.history.calls.length, hash: custom.location.hash };
  assert.equal(await custom.wizard.act('connect:copy-skill'), true);
  assert.equal(custom.clipboard.at(-1), command); assert.ok(!custom.clipboard.at(-1).includes(KEY.slice(10)));
  assert.deepEqual({ writes: custom.writes.length, hashes: custom.hashes.length, history: custom.history.calls.length, hash: custom.location.hash }, before);
  assert.deepEqual(custom.toasts.at(-1), ['Comando copiado.', false]); assert.deepEqual(leaked(custom), []);
  await custom.wizard.act('connect:client', null, { dataset: { tab: 'codex' } });
  assert.doesNotMatch(custom.view(), /data-connect-skill/, 'só na aba do Hermes Agent');

  // Custom domain not active: the canonical origin, as in the MCP snippets. Drafts only: the next step says so.
  const inactive = fixture({ origin: 'https://painel.acme.com.br' }), canonical = 'hermes skills install https://app.elozi.test/api/agent/skills/attendant/SKILL.md --name acme-loja-centro-atendente';
  await walk(inactive); await inactive.wizard.act('connect:create');
  html = inactive.view('#agents/connect/configure');
  assert.ok(html.includes(`<code data-connect-skill-command>${canonical}</code>`)); assert.match(html, /data-connect-skill="drafts"/);
  assert.match(html, /\/acme-loja-centro-atendente comece a atender/); assert.match(html, /Sem permissão de envio: o agente entrega rascunhos para a equipe revisar e enviar\./);
  await inactive.wizard.act('connect:copy-skill'); assert.equal(inactive.clipboard.at(-1), canonical);
  const otherCompany = fixture({ tenant: { id: 'tenant-a', name: 'Atacado Sul' } });
  await walk(otherCompany); await otherCompany.wizard.act('connect:create');
  assert.match(otherCompany.view('#agents/connect/configure'), /--name acme-atacado-sul-atendente/, 'cada empresa tem a sua skill e o seu comando');

  // Read only: no promise of replies or drafts.
  const reader = fixture();
  await walk(reader, { goals: ['consult'] }); await reader.wizard.act('connect:create');
  html = reader.view('#agents/connect/configure');
  assert.match(html, /data-connect-skill="read"/); assert.match(html, /<code>\/acme-loja-centro-atendente resuma meus atendimentos abertos<\/code>/);
  assert.match(html, /Sem envio nem rascunhos: o agente só lê e resume os atendimentos para você\./); assert.doesNotMatch(html, /comece a atender/);
  const owner = fixture({ owner: true, brand: '' });
  await walk(owner); await owner.wizard.act('connect:create');
  assert.match(owner.view('#agents/connect/configure'), /--name elozi-loja-centro-atendente/, 'dono da plataforma sem marca: slug elozi');

  setLocale('en', { persist: false, notify: false });
  try {
    html = reader.view('#agents/connect/configure');
    assert.match(html, /id="connect-skill-title">Attendant skill<\/h3>/); assert.match(html, /aria-label="Skill install command"/); assert.match(html, /Copy command/);
    assert.match(html, /Then, in the chat: <code>\/reload-mcp<\/code> and <code>\/reload-skills<\/code>; next: <code>\/acme-loja-centro-atendente summarize my open conversations<\/code>/);
    assert.match(html, /No sending or drafts: the agent only reads and summarizes conversations for you\./);
    assert.ok(html.includes('--name acme-loja-centro-atendente'), 'o nome da skill não é traduzido');
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
});

test('ativação por eventos distingue acesso MCP, listener e envio em todos os clientes sem criar concessões', async () => {
  const f = fixture();
  await walk(f, { goals: ['attend'], attendRisk: true }); await f.wizard.act('connect:create');
  const before = f.calls.length;
  for (const client of ['hermes', 'claude', 'codex', 'json']) {
    await f.wizard.act('connect:client', null, { dataset: { tab: client } });
    const page = f.view('#agents/connect/configure');
    assert.match(page, /data-connect-event-activation="authorized"/);
    assert.match(page, /elozi_wait_for_events/);
    assert.match(page, /A espera ociosa não chama o modelo/);
    assert.match(page, /não comprova listener ativo/);
    assert.ok(!page.includes(KEY));
  }
  assert.equal(f.calls.length, before, 'render/configure não instala nem amplia acesso');
  setLocale('en', { persist: false, notify: false });
  try { const page = f.view(); assert.match(page, /Event activation/); assert.match(page, /Idle waiting does not call the model/); assert.doesNotMatch(page, /Ativação por eventos/); } finally { setLocale('pt-BR', { persist: false, notify: false }); }
  const reader = fixture(); await walk(reader, { goals: ['consult'] }); await reader.wizard.act('connect:create');
  const page = reader.view('#agents/connect/configure');
  assert.match(page, /data-connect-event-activation="not-authorized"/);
  assert.match(page, /não tem acesso a eventos/); assert.doesNotMatch(page, /elozi_wait_for_events/);
  const manager = fixture(); await walk(manager, { goals: ['management'] }); await manager.wizard.act('connect:create');
  assert.doesNotMatch(manager.view('#agents/connect/configure'), /data-connect-event-activation/);
});

test('verificação ao vivo: consulta recibos a cada 3 s, para no sucesso, ao ocultar a aba, após 10 min e ao sair', async () => {
  const receipts = { list: [] };
  const make = options => fixture({ ...options, intercept: (path, init, fallback) => path.endsWith('/receipts') ? { receipts: receipts.list } : fallback() });
  const receiptCalls = f => f.calls.filter(call => call.path.endsWith('/receipts')).length;

  const f = make(); await toVerify(f);
  const { checks } = mountVerify(f); await settle();
  assert.equal(receiptCalls(f), 1); assert.match(checks.innerHTML, /Aguardando a primeira chamada/); assert.match(checks.innerHTML, /consulta a cada 3 s, até 10 min/);
  assert.doesNotMatch(checks.innerHTML, /Chave aceita/, 'sem lastSeenAt (feature principal-last-seen) a linha não aparece');
  const written = checks.writes;
  await f.timers.advance(POLL_EVERY_MS); assert.equal(receiptCalls(f), 2);
  assert.equal(checks.writes, written, 'região aria-live só é reescrita quando muda');
  receipts.list = [{ capability: 'conversation.read', state: 'confirmed', createdAt: new Date().toISOString(), result: { operation: 'inbox' } }];
  await f.timers.advance(POLL_EVERY_MS);
  assert.equal(receiptCalls(f), 3); assert.equal(f.wizard.debug.polling, 'success'); assert.match(checks.innerHTML, /Leitura confirmada/); assert.match(checks.innerHTML, /elozi_list_conversations/);
  assert.match(f.toasts.at(-1)[0], /Nova está conectado/);
  await f.timers.advance(POLL_EVERY_MS * 5); assert.equal(receiptCalls(f), 3, 'para no primeiro sucesso'); assert.equal(f.timers.pending, 0);

  receipts.list = [];
  const g = make({ features: ['principal-last-seen'] }); await walk(g); await g.wizard.act('connect:create'); await g.wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', true)]));
  const view = mountVerify(g); await settle();
  assert.match(view.checks.innerHTML, /Chave aceita/);
  g.doc.visibilityState = 'hidden'; g.doc.fire('visibilitychange');
  assert.equal(g.wizard.debug.polling, 'hidden'); assert.equal(g.timers.pending, 0, 'aba oculta: nenhuma consulta agendada');
  const before = receiptCalls(g); await g.timers.advance(POLL_EVERY_MS * 3); assert.equal(receiptCalls(g), before);
  g.doc.visibilityState = 'visible'; g.doc.fire('visibilitychange'); await settle();
  assert.equal(g.wizard.debug.polling, 'running'); assert.equal(receiptCalls(g), before + 1, 'retoma ao voltar');
  await g.timers.advance(POLL_BUDGET_MS);
  assert.equal(g.wizard.debug.polling, 'timeout'); assert.equal(g.timers.pending, 0); assert.match(view.checks.innerHTML, /Ainda sem chamada depois de 10 minutos/); assert.match(view.checks.innerHTML, /connect:verify-again/);
  const total = receiptCalls(g); assert.ok(total <= Math.ceil(POLL_BUDGET_MS / POLL_EVERY_MS) + 3, `no máximo uma consulta a cada 3 s (${total})`);
  await g.wizard.act('connect:verify-again'); await settle(); assert.equal(g.wizard.debug.polling, 'running');
  view.root.dataset.step = 'identity'; await g.timers.advance(POLL_EVERY_MS);
  assert.equal(g.wizard.debug.polling, null, 'sair da tela encerra a consulta'); assert.equal(g.timers.pending, 0);
  assert.equal(g.doc.count('visibilitychange'), 0);
});

test('verificação identifica busca e histórico como leituras autorizadas da chave atual', async t => {
  for (const [operation, tool] of [['search', 'elozi_search_conversations'], ['conversation-history', 'elozi_read_conversation_history']]) await t.test(operation, async () => {
    const receipts = { list: [] };
    const f = fixture({ intercept: (path, init, fallback) => path.endsWith('/receipts') ? { receipts: receipts.list } : fallback() });
    await toVerify(f); const { checks } = mountVerify(f); await settle();
    assert.equal(f.wizard.debug.polling, 'running');
    receipts.list = [{ capability: 'conversation.read', state: 'confirmed', createdAt: new Date().toISOString(), result: { operation } }];
    await f.timers.advance(POLL_EVERY_MS);
    assert.equal(f.wizard.debug.polling, 'success'); assert.match(checks.innerHTML, /Leitura autorizada/);
    assert.ok(checks.innerHTML.includes(tool), tool); assert.equal(f.timers.pending, 0);
  });
});

test('verificação: renderizar de novo com a aba oculta não reinicia os 10 minutos', async () => {
  const h = fixture(); await toVerify(h);
  mountVerify(h); await settle();
  assert.equal(h.wizard.debug.polling, 'running');
  h.doc.visibilityState = 'hidden'; h.doc.fire('visibilitychange');
  await h.timers.advance(POLL_BUDGET_MS + 60_000);
  mountVerify(h); await settle();
  assert.equal(h.wizard.debug.polling, 'hidden', 'o novo render só repinta');
  h.doc.visibilityState = 'visible'; h.doc.fire('visibilitychange'); await settle();
  assert.equal(h.wizard.debug.polling, 'timeout', 'o prazo conta desde o início, com o tempo oculto');
  const v = fixture(); await toVerify(v);
  mountVerify(v); await settle();
  v.doc.visibilityState = 'hidden'; v.doc.fire('visibilitychange');
  await v.timers.advance(60_000);
  v.doc.visibilityState = 'visible'; mountVerify(v); await settle();
  assert.equal(v.wizard.debug.polling, 'running', 'dentro do prazo, o render com a aba visível retoma');
});

test('verificação: depois de trocar a chave, recibos e "Chave aceita" da chave anterior não contam', async () => {
  const receipts = { list: [] }, issued = '2026-10-06T12:00:00.000Z', rotatedAt = '2026-10-06T12:30:00.000Z';
  const f = fixture({ features: ['principal-last-seen'], principal: { keyRevision: 1, createdAt: issued, updatedAt: issued }, rotated: { keyRevision: 2, updatedAt: rotatedAt },
    intercept: (path, init, fallback) => path.endsWith('/receipts') ? { receipts: receipts.list } : fallback() });
  await walk(f); await f.wizard.act('connect:create');
  await f.wizard.act('connect:rotate'); await f.wizard.act('connect:rotate-confirm');
  assert.equal(f.wizard.debug.draft.keyRevision, 2); assert.equal(f.wizard.debug.draft.keyIssuedAt, rotatedAt);
  await f.wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', true)])); await f.wizard.submit(form('configure', []));
  f.server.principals[0].lastSeenAt = '2026-10-06T12:10:00.000Z';
  receipts.list = [{ capability: 'conversation.read', state: 'confirmed', keyRevision: 1, createdAt: '2026-10-06T12:10:00.000Z', result: { operation: 'inbox' } }];
  const { checks } = mountVerify(f); await settle();
  assert.equal(f.wizard.debug.polling, 'running', 'recibo da chave anterior não confirma a conexão');
  assert.doesNotMatch(f.toasts.map(([message]) => message).join('\n'), /está conectado/);
  assert.match(checks.innerHTML, /data-state="waiting"[\s\S]*Chave aceita[\s\S]*aguardando a primeira chamada/, 'lastSeenAt anterior à troca não vale');
  f.server.principals[0].lastSeenAt = '2026-10-06T12:31:00.000Z';
  receipts.list = [...receipts.list, { capability: 'conversation.read', state: 'confirmed', keyRevision: 2, createdAt: '2026-10-06T12:31:00.000Z', result: { operation: 'inbox' } }];
  await f.timers.advance(POLL_EVERY_MS);
  assert.equal(f.wizard.debug.polling, 'success'); assert.match(f.toasts.at(-1)[0], /Nova está conectado/);
});

test('Cancelar e Recomeçar com a chave criada perguntam: revogar ou manter (a identidade não fica esquecida)', async () => {
  const f = fixture();
  await walk(f); await f.wizard.act('connect:create');
  await f.wizard.act('connect:cancel');
  assert.equal(f.location.hash, '#agents/connect/key', 'ainda não saiu'); assert.equal(f.wizard.debug.leaving, 'cancel');
  let html = f.view();
  assert.match(html, /<div class="pg-connect__confirm" role="group" aria-labelledby="connect-leave-title" data-connect-leave><p id="connect-leave-title" tabindex="-1"><strong>A chave criada continua ativa\.<\/strong>/);
  assert.match(html, /Nova pode usar a chave com as tarefas e os canais escolhidos até ela vencer/);
  assert.match(html, /data-action="connect:leave-revoke"[\s\S]*Revogar a chave e sair/); assert.match(html, /Sair e manter a chave/); assert.match(html, /Continuar no assistente/);
  await f.wizard.act('connect:leave-stay'); assert.equal(f.wizard.debug.leaving, null); assert.doesNotMatch(f.view(), /data-connect-leave/);
  await f.wizard.act('connect:cancel'); await f.wizard.act('connect:leave-revoke');
  const revoke = f.calls.find(call => call.path.endsWith('/revoke'));
  assert.deepEqual(revoke.body, { revision: 1 }, 'revoga na revisão atual');
  assert.equal(f.server.principals[0].state, 'revoked'); assert.equal(f.location.hash, '#agents'); assert.equal(f.wizard.debug.hasSecret, false); assert.equal(f.items.size, 0);
  assert.match(f.toasts.at(-1)[0], /Chave revogada\. O agente Nova continua em Agentes, sem conexão\./);

  const k = fixture();
  await walk(k); await k.wizard.act('connect:create');
  await k.wizard.act('connect:restart');
  assert.match(k.view(), /Revogar a chave e recomeçar[\s\S]*Recomeçar e manter a chave/);
  await k.wizard.act('connect:leave-keep');
  assert.equal(k.posts('/revoke'), 0); assert.equal(k.wizard.debug.draft.principalId, null); assert.equal(k.items.size, 0);
  assert.match(k.toasts.at(-1)[0], /A chave continua ativa até vencer/);
});

test('cancelar sem chave descarta o progresso (o agente criado continua em Agentes) e a troca de empresa isola o rascunho', async () => {
  const f = fixture({ intercept: (path, init, fallback) => { if (init.method === 'POST' && path.endsWith('/service-principals')) throw Object.assign(new Error('Limite.'), { status: 429 }); return fallback(); } });
  await walk(f); await f.wizard.act('connect:create');
  await f.wizard.act('connect:cancel');
  assert.equal(f.location.hash, '#agents'); assert.equal(f.wizard.debug.hasSecret, false); assert.equal(f.items.size, 0);
  assert.match(f.toasts.at(-1)[0], /continua em Agentes, aguardando a conexão/);
  const g = fixture();
  await g.wizard.submit(identity('Bot Estoque'));
  g.state.tenant = { ...g.state.tenant, id: 'tenant-b', name: 'Atacado Sul' };
  assert.match(g.view('#agents/connect'), /name="name"[^>]*value=""/, 'outra empresa começa do zero');
  g.state.tenant = { ...g.state.tenant, id: 'tenant-a', name: 'Loja Centro' };
  assert.match(g.view('#agents/connect'), /value="Bot Estoque"/, 'e a empresa anterior retoma o seu progresso');
  assert.match(g.view('#agents/connect'), /<details class="pg-connect__existing"><summary>Agentes já conectados nesta empresa<\/summary><section data-principals>legado<\/section><\/details>/);
});

test('ações e formulários fora do namespace ou desconhecidos voltam ao código legado', async () => {
  const f = fixture();
  assert.equal(await f.wizard.act('connect:anything', 'id'), false); assert.equal(await f.wizard.act('agents:save'), false);
  assert.equal(await f.wizard.submit({ dataset: { form: 'connect:x' } }), false); assert.equal(await f.wizard.submit({ dataset: { form: 'pending:x' } }), false);
  assert.equal(f.calls.length, 0);
});

test('com as dependências padrão (globais do navegador espionadas) a chave não toca localStorage, sessionStorage, history, location nem URL', async () => {
  const seen = [], spy = name => ({ getItem: () => null, setItem: (key, value) => seen.push([name, key, String(value)]), removeItem: key => seen.push([name, 'remove', key]), clear: () => seen.push([name, 'clear']) });
  let hash = '#agents/connect';
  const fakes = {
    localStorage: spy('localStorage'), sessionStorage: spy('sessionStorage'),
    history: { state: null, pushState: (...args) => seen.push(['history.push', JSON.stringify(args)]), replaceState: (...args) => seen.push(['history.replace', JSON.stringify(args)]) },
    location: { origin: 'https://app.elozi.test', get hash() { return hash; }, set hash(value) { seen.push(['location.hash', String(value)]); hash = String(value); }, assign: value => seen.push(['location.assign', String(value)]), replace: value => seen.push(['location.replace', String(value)]) }
  };
  const saved = Object.fromEntries(Object.keys(fakes).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const createObjectURL = globalThis.URL.createObjectURL, OriginalURL = globalThis.URL;
  for (const [name, value] of Object.entries(fakes)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  globalThis.URL.createObjectURL = (...args) => { seen.push(['URL.createObjectURL', String(args[0])]); return 'blob:x'; };
  const urls = []; globalThis.URL = new Proxy(OriginalURL, { construct(target, args) { urls.push(String(args[0])); return new target(...args); } });
  try {
    const base = fixture(), clipboard = [];
    const wizard = createAgentConnectWizard({ pageHeading, principals: () => '', state: base.state, request: base.options.request, toast: () => {}, clipboard: () => ({ writeText: async text => { clipboard.push(text); } }), timers: base.timers, doc: base.doc, win: base.win });
    const route = () => parseHash(hash);
    wizard.view(route());
    await wizard.submit(identity()); wizard.view(route()); await wizard.submit(goal()); wizard.view(route()); await wizard.submit(access());
    assert.equal(hash, '#agents/connect/key');
    wizard.view(route()); await wizard.act('connect:create'); await wizard.act('connect:reveal'); await wizard.act('connect:copy-key');
    await wizard.submit(form('key', [element('keySaved', 'yes', 'checkbox', true)])); wizard.view(route());
    await wizard.act('connect:copy-with-key'); await wizard.act('connect:copy-config');
    assert.equal(hash, '#agents/connect/configure'); assert.equal(clipboard.filter(text => text.includes(KEY)).length, 1);
    const leaks = [...seen, ...urls.map(url => ['URL', url])].filter(entry => entry.join(' ').includes(KEY) || entry.join(' ').includes(KEY.slice(10)));
    assert.deepEqual(leaks, [], 'nenhum armazenamento, histórico, endereço ou download recebe a chave');
    assert.ok(seen.some(([name]) => name === 'sessionStorage'), 'o progresso (sem a chave) usa o sessionStorage');
    assert.equal(seen.some(([name]) => name === 'localStorage'), false, 'nada vai para o localStorage');
    assert.equal(seen.some(([name]) => name === 'URL.createObjectURL'), false);
  } finally {
    globalThis.URL = OriginalURL; globalThis.URL.createObjectURL = createObjectURL;
    for (const [name, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});

test('sistema detectado e escolha explícita trocam só os snippets, sem alterar concessões ou copiar segredo',async()=>{
  assert.equal(clientSystem('Win32'),'windows');assert.equal(clientSystem('Windows'),'windows');assert.equal(clientSystem('Darwin'),'posix');
  const f=fixture({platform:'Win32'});await walk(f);await f.wizard.act('connect:create');
  await f.wizard.act('connect:client','codex');const initial={...f.wizard.debug.draft};let html=f.view('#agents/connect/configure');
  assert.match(html,/data-system="windows" aria-pressed="true"/);assert.match(html,/Read-Host/);assert.doesNotMatch(html,/read -rs|bashrc|zshrc/);
  await f.wizard.act('connect:copy-config');assert.match(f.clipboard.at(-1),/Read-Host/);assert.ok(!f.clipboard.at(-1).includes(KEY));
  const copies=f.clipboard.length;await f.wizard.act('connect:copy-key');await f.wizard.act('connect:copy-with-key');assert.equal(f.clipboard.length,copies);
  await f.wizard.act('connect:system','posix');html=f.view();assert.match(html,/read -rs/);assert.doesNotMatch(html,/Read-Host/);
  assert.deepEqual({...f.wizard.debug.draft,system:initial.system},initial);assert.equal(f.posts('/service-principals'),1);
  const reload=createAgentConnectWizard({...f.options});assert.match(reload.view(parseHash('#agents/connect/configure')),/data-system="posix" aria-pressed="true"/);
  assert.deepEqual(leaked(f),[]);
});

test('PowerShell executa apenas adaptadores sintéticos e restaura ambiente mesmo quando o comando falha',{skip:process.platform!=='win32'},()=>{
  for(const client of ['codex','claude','curl','bridge']){
    const snippet=clientSnippet(client,{origin:'https://synthetic.invalid',slug:'synthetic-elozi',envVar:'SYNTHETIC_ELOZI_MCP_TOKEN',system:'windows'});
    assert.equal(snippet.withKey,null);assert.doesNotMatch(snippet.code,/elozi_svc_|read -rs|bashrc|zshrc/);
    const terminal=snippet.code.slice(snippet.code.indexOf('& {'));
    const script=`$ErrorActionPreference = 'Stop'
$env:SYNTHETIC_ELOZI_MCP_TOKEN = 'previous-synthetic-value'
$env:ELOZI_MCP_CONFIG_PATH = 'previous-synthetic-config'
$script:sawToken = $false
function Read-Host { $secret = [Security.SecureString]::new(); foreach ($character in 'synthetic-input'.ToCharArray()) { $secret.AppendChar($character) }; $secret }
function codex { $script:sawToken = $env:SYNTHETIC_ELOZI_MCP_TOKEN -eq 'synthetic-input'; throw 'synthetic-command-failed' }
function claude { $script:sawToken = $env:SYNTHETIC_ELOZI_MCP_TOKEN -eq 'synthetic-input'; throw 'synthetic-command-failed' }
function Invoke-RestMethod { $script:sawToken = $env:SYNTHETIC_ELOZI_MCP_TOKEN -eq 'synthetic-input'; throw 'synthetic-command-failed' }
function node { $script:sawToken = $env:SYNTHETIC_ELOZI_MCP_TOKEN -eq 'synthetic-input'; throw 'synthetic-command-failed' }
try { ${terminal} } catch { if ($_.Exception.Message -ne 'synthetic-command-failed') { throw } }
[Console]::WriteLine('{"inside":' + $script:sawToken.ToString().ToLowerInvariant() + ',"restored":' + ($env:SYNTHETIC_ELOZI_MCP_TOKEN -eq 'previous-synthetic-value').ToString().ToLowerInvariant() + ',"configRestored":' + ($env:ELOZI_MCP_CONFIG_PATH -eq 'previous-synthetic-config').ToString().ToLowerInvariant() + '}')`;
    const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,0,`${client}: ${result.stderr}`);assert.deepEqual(JSON.parse(result.stdout.trim()),{inside:true,restored:true,configRestored:true});
  }
});

test('roteiro comum respeita objetivos e aparece em todos os clientes sem executar operação',async t=>{
  for(const client of ['hermes','claude','codex','json'])for(const selected of ['consult','draft','management','attend'])await t.test(client+'/'+selected,async()=>{
    const f=fixture();await walk(f,{goals:[selected],attendRisk:selected==='attend'});await f.wizard.act('connect:create');await f.wizard.act('connect:client',client);
    const calls=f.calls.length,html=f.view('#agents/connect/configure');assert.match(html,/data-connect-operation/);assert.match(html,/tools\/list/);assert.match(html,/elozi_me/);assert.equal(f.calls.length,calls);
    const operation=html.split('data-connect-operation')[1];assert.ok(!operation.includes(KEY));
    if(selected==='management'){assert.match(operation,/elozi_read_company/);assert.doesNotMatch(operation,/elozi_search_conversations|elozi_send_reply|elozi_submit_draft/);assert.doesNotMatch(html,/data-connect-skill/);}
    if(selected==='consult'){assert.match(operation,/elozi_search_conversations/);assert.doesNotMatch(operation,/elozi_send_reply|elozi_submit_draft/);}
    if(selected==='draft'){assert.match(operation,/elozi_submit_draft/);assert.doesNotMatch(operation,/elozi_send_reply/);}
    if(selected==='attend'){assert.match(operation,/elozi_claim_conversation/);assert.match(operation,/elozi_send_reply/);assert.match(operation,/elozi_transfer_to_human/);assert.match(operation,/requestId/);}
    if(client!=='hermes')assert.doesNotMatch(html,/data-connect-skill/);
  });
});

test('verificação company-only aceita apenas consulta concedida e orienta gestão sem ler atendimentos',async()=>{
  const receipts={list:[]},f=fixture({principal:{keyRevision:1},intercept:(path,init,fallback)=>path.endsWith('/receipts')?{receipts:receipts.list}:fallback()});
  await toVerify(f,{goals:['management']});const mounted=mountVerify(f);await settle();await settle();
  let html=f.view();assert.match(html,/elozi_read_company/);assert.doesNotMatch(html,/Liste meus atendimentos|resuma o mais antigo|Envio confirmado por recibo/);
  receipts.list=[{capability:'conversation.read',state:'confirmed',revision:1,keyRevision:1,createdAt:new Date().toISOString()}];await f.timers.advance(POLL_EVERY_MS);assert.equal(f.wizard.debug.polling,'running');
  receipts.list=[{capability:'company.read',state:'confirmed',revision:1,keyRevision:1,createdAt:new Date().toISOString()}];await f.timers.advance(POLL_EVERY_MS);
  assert.equal(f.wizard.debug.polling,'success');assert.match(mounted.checks.innerHTML,/Consulta da empresa autorizada/);assert.match(mounted.checks.innerHTML,/elozi_read_company/);
  assert.equal(f.posts('/service-principals'),1);assert.equal(f.calls.filter(c=>c.method==='POST').length,2,'apenas os dois cadastros sintéticos do fixture; nenhuma consulta/proposta/envio MCP');
});

test('consulta do atendente não comprova envio; recibo de envio permanece prova separada',async t=>{
  for(const sent of [false,true])await t.test(String(sent),async()=>{
    const receipts=[{capability:'conversation.read',state:'confirmed',revision:1,keyRevision:1,createdAt:new Date().toISOString(),result:{operation:'inbox'}}];
    if(sent)receipts.push({capability:'reply.send',state:'confirmed',revision:1,keyRevision:1,createdAt:new Date().toISOString()});
    const f=fixture({principal:{keyRevision:1},intercept:(path,init,fallback)=>path.endsWith('/receipts')?{receipts}:fallback()});await toVerify(f,{goals:['attend'],attendRisk:true});const {checks}=mountVerify(f);await settle();await settle();
    assert.equal(f.wizard.debug.polling,'success');assert.match(checks.innerHTML,new RegExp(`data-state="${sent?'ok':'waiting'}"[^>]*>[\\s\\S]*?<strong>Envio confirmado por recibo`));
    if(!sent)assert.match(checks.innerHTML,/Não verificado; nenhum envio de teste/);
    assert.equal(f.calls.some(c=>/replies|claims|tools\/call/.test(c.path)),false);
  });
});

test('verificação recusa recibo de revisão antiga e acesso alterado ou revogado durante consulta',async t=>{
  for(const change of ['receipt-revision','principal-revision','revoked'])await t.test(change,async()=>{
    const f=fixture({principal:{keyRevision:1},intercept:(path,init,fallback)=>path.endsWith('/receipts')?{receipts:[{capability:'company.read',state:'confirmed',revision:change==='receipt-revision'?0:1,keyRevision:1,createdAt:new Date().toISOString()}]}:fallback()});
    await toVerify(f,{goals:['management']});if(change==='principal-revision')f.server.principals[0].revision=2;if(change==='revoked')f.server.principals[0].state='revoked';
    const {checks}=mountVerify(f);await settle();await settle();assert.equal(f.wizard.debug.polling,change==='receipt-revision'?'running':'error');assert.doesNotMatch(checks.innerHTML,/Leitura confirmada/);
    if(change!=='receipt-revision')assert.match(checks.innerHTML,/O acesso desta identidade mudou/);
  });
});

test('recibos tardios não confirmam conexão após mudança de autoridade no mesmo escopo',async t=>{
  for(const change of ['role','support','permissions','person','workspace'])await t.test(change,async()=>{
    const waiting=deferred(),f=fixture({intercept:(path,init,fallback)=>path.endsWith('/receipts')?waiting.promise:fallback()});await toVerify(f);mountVerify(f);
    if(change==='role')f.state.boot.session.role='operator';if(change==='support')f.state.supportGrantId='synthetic-grant';if(change==='permissions')f.state.boot.session.permissions=[];if(change==='person')f.state.boot.session.userId='person-b';if(change==='workspace')f.state.workspaceId='workspace-b';
    waiting.resolve({receipts:[{capability:'conversation.read',state:'confirmed',createdAt:new Date().toISOString(),result:{operation:'inbox'}}]});await settle();await settle();
    assert.equal(f.wizard.debug.polling,null);assert.equal(f.toasts.some(([message])=>message.includes('está conectado')),false);
  });
});

test('callback tardio da metadata e do clipboard não confirma sucesso em outra autoridade',async()=>{
  const metadata=deferred();let checking=false;const f=fixture({intercept:(path,init,fallback)=>{if(path.endsWith('/receipts')){checking=true;return{receipts:[{capability:'conversation.read',state:'confirmed',createdAt:new Date().toISOString(),result:{operation:'inbox'}}]};}if(checking&&path.endsWith('/service-principals'))return metadata.promise;return fallback();}});
  await toVerify(f);mountVerify(f);await settle();f.state.boot.session.permissions=[];metadata.resolve({principals:f.server.principals});await settle();await settle();assert.equal(f.wizard.debug.polling,null);assert.equal(f.toasts.some(([message])=>message.includes('está conectado')),false);
  const copied=deferred(),g=fixture(),wizard=createAgentConnectWizard({...g.options,clipboard:()=>({writeText:()=>copied.promise})});wizard.view(parseHash('#agents/connect'));const pending=wizard.act('connect:copy-config');g.state.boot.session.role='operator';copied.resolve();await pending;assert.equal(g.toasts.length,0);
});

test('novas instruções e verificação usam catálogo inglês real, mantendo nomes de ferramentas e empresa',async()=>{
  const f=fixture({platform:'Windows'});await toVerify(f,{goals:['management']});
  setLocale('en',{persist:false,notify:false});try{
    const configure=f.view('#agents/connect/configure');assert.match(configure,/Client operating system/);assert.match(configure,/How to use your authorized access/);assert.match(configure,/The copied configuration does not contain the key/);assert.match(configure,/elozi_get_receipt/);assert.doesNotMatch(configure,/Como usar|Insira-a somente|Sistema do cliente/);
    const verify=f.view('#agents/connect/verify');assert.match(verify,/Authorized company query/);assert.match(verify,/Read the authorized structure of Loja Centro/);assert.match(verify,/This screen never sends a test message/);assert.doesNotMatch(verify,/Consulta da empresa|Consulte a estrutura|resuma o mais antigo/);
  }finally{setLocale('pt-BR',{persist:false,notify:false});}
});

// Use the production-rendered controls, including disabled/checked state, through mount's real
// capture listeners. No alternate scope/payload implementation in the fixture.
function mountedAccess(f) {
  const html = f.view('#agents/connect/access'), listeners = new Map();
  const controls = [...html.matchAll(/<input\b([^>]*)\/>/g)].map(([, attrs]) => {
    const attr = name => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    return { ...element(attr('name'), attr('value') ?? '', attr('type') || 'text', /\bchecked\b/.test(attrs)), disabled: /\bdisabled\b/.test(attrs) };
  }).filter(control => control.name);
  controls.push(element('ttlHours', f.wizard.debug.draft.ttlHours));
  const current = { ...form('access', controls), addEventListener: (name, callback) => listeners.set(name, callback) };
  const root = { dataset: { step: 'access' }, isConnected: true, querySelector: selector => selector.startsWith('form') ? current : null };
  f.wizard.mount({ querySelector: selector => selector === '[data-connect-root]' ? root : null }, parseHash('#agents/connect/access'));
  return {
    current,
    change(name, value) {
      for (const control of controls.filter(control => control.name === name)) {
        if (control.type === 'radio') control.checked = control.value === value;
        else if (control.type === 'checkbox') control.checked = value.includes(control.value);
        else control.value = value;
      }
      const target = controls.find(control => control.name === name);
      listeners.get('input')?.({ target }); listeners.get('change')?.({ target });
    }
  };
}

test('scope: Todos desabilita e marca a lista; all ↔ some preserva escolhas de canais e departamentos', async () => {
  const f = fixture(); await f.wizard.submit(identity()); await f.wizard.submit(goal({ goals: ['consult'] }));
  let mounted = mountedAccess(f);
  const scoped = mounted.current.elements.filter(control => ['channelIds', 'departmentIds'].includes(control.name));
  assert.equal(scoped.length, 4); assert.ok(scoped.every(control => control.checked && control.disabled));
  mounted.change('channelMode', 'some'); mounted = mountedAccess(f);
  assert.ok(mounted.current.elements.filter(control => control.name === 'channelIds').every(control => !control.disabled && !control.checked));
  mounted.change('channelIds', ['telegram-a']); mounted.change('departmentMode', 'some'); mounted = mountedAccess(f);
  mounted.change('departmentIds', ['unassigned']);
  mounted.change('channelMode', 'all'); mounted = mountedAccess(f);
  mounted.change('departmentMode', 'all'); mounted = mountedAccess(f);
  assert.ok(mounted.current.elements.filter(control => ['channelIds', 'departmentIds'].includes(control.name)).every(control => control.checked && control.disabled));
  assert.deepEqual(f.wizard.debug.draft.channelIds, ['telegram-a']); assert.deepEqual(f.wizard.debug.draft.departmentIds, ['unassigned']);
  await f.wizard.submit(mounted.current);
  assert.match(f.view('#agents/connect/key'), /<dt>Canais<\/dt><dd>Todos nesta empresa<\/dd>/);
  assert.match(f.view(), /<dt>Departamentos<\/dt><dd>Todos nesta empresa<\/dd>/);
  mounted = mountedAccess(f); mounted.change('channelMode', 'some'); mounted = mountedAccess(f);
  mounted.change('departmentMode', 'some'); mounted = mountedAccess(f);
  assert.ok(mounted.current.elements.find(control => control.name === 'channelIds' && control.value === 'telegram-a').checked);
  assert.ok(mounted.current.elements.find(control => control.name === 'departmentIds' && control.value === 'unassigned').checked);
  await f.wizard.submit(mounted.current);
  const summary = f.view('#agents/connect/key');
  assert.match(summary, /<dt>Canais<\/dt><dd>Telegram<\/dd>/); assert.match(summary, /<dt>Departamentos<\/dt><dd>Sem departamento<\/dd>/);
  await f.wizard.act('connect:create');
  const payload = f.calls.find(call => call.method === 'POST' && call.path.endsWith('/service-principals')).body;
  assert.deepEqual(payload.channelIds, ['telegram-a']); assert.deepEqual(payload.departmentIds, ['unassigned']);
  mounted = mountedAccess(f);
  assert.ok(mounted.current.elements.filter(control => /Mode$|Ids$/.test(control.name)).every(control => control.disabled));
  await f.wizard.submit(access({ channels: ['whatsapp-a'], departments: ['sales'] }));
  assert.equal(f.wizard.debug.draft.channelMode, 'some'); assert.deepEqual(f.wizard.debug.draft.channelIds, ['telegram-a']);
});

test('scope: vazio em Escolher bloqueia, sem canais Todos mantém escopo futuro explícito e payload null', async () => {
  const f = fixture({ tenant: { channels: [], departments: [] } });
  await f.wizard.submit(identity()); await f.wizard.submit(goal({ goals: ['consult'] }));
  assert.match(f.view('#agents/connect/access'), /Nenhum cadastrado nesta empresa/);
  await f.wizard.submit(access({ channelMode: 'some' }));
  assert.equal(f.wizard.debug.errorField, 'channelIds'); assert.equal(f.location.hash, '#agents/connect/access');
  await f.wizard.act('connect:create'); assert.equal(f.posts('/agents'), 0);
  await f.wizard.submit(access({ departmentMode: 'some' })); assert.equal(f.wizard.debug.errorField, 'departmentIds');
  await f.wizard.submit(access());
  const summary = f.view('#agents/connect/key');
  assert.match(summary, /<dt>Canais<\/dt><dd>Todos nesta empresa<\/dd>/); assert.match(summary, /<dt>Departamentos<\/dt><dd>Todos nesta empresa<\/dd>/);
  await f.wizard.act('connect:create');
  const payload = f.calls.find(call => call.method === 'POST' && call.path.endsWith('/service-principals')).body;
  assert.equal(payload.channelIds, null); assert.equal(payload.departmentIds, null);
});

test('limites: inválido permanece no campo, associado ao erro; valor válido coincide com resumo e payload', async t => {
  for (const field of ['dailyRequests', 'maxConcurrent']) for (const value of ['', '0', '-1', '1.5', '1,5', '1e2', field === 'dailyRequests' ? '10001' : '21', ' 2 ']) await t.test(field + '/' + JSON.stringify(value), async () => {
    const f = fixture(); await f.wizard.submit(identity()); await f.wizard.submit(goal({ goals: ['consult'] }));
    const submitted = access(); submitted.elements.find(control => control.name === field).value = value;
    await f.wizard.submit(submitted);
    assert.equal(f.location.hash, '#agents/connect/access'); assert.equal(f.wizard.debug.errorField, field); assert.equal(f.wizard.debug.draft[field], value);
    const html = f.view();
    assert.match(html, new RegExp(`name="${field}"[^>]*value="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*aria-invalid="true"[^>]*aria-describedby="connect-(?:daily|concurrent)-hint connect-error"`));
    const reload = createAgentConnectWizard({ ...f.options }); reload.view(parseHash('#agents/connect/access'));
    assert.equal(reload.debug.draft[field], value, 'recarregar não troca o inválido por default');
    await f.wizard.act('connect:create'); assert.equal(f.posts('/agents'), 0);
  });
  const f = fixture(); await walk(f); await f.wizard.submit(access({ daily: '10000', concurrent: '20' }));
  assert.match(f.view('#agents/connect/key'), /10000 requisições por dia · 20 simultâneas/);
  await f.wizard.act('connect:create');
  const payload = f.calls.find(call => call.method === 'POST' && call.path.endsWith('/service-principals')).body;
  assert.equal(payload.dailyRequests, 10000); assert.equal(payload.maxConcurrent, 20);
});

test('riscos são condicionais e consentimento removido não é reutilizado ao reativar capacidades', async () => {
  const f = fixture(); await f.wizard.submit(identity()); await f.wizard.submit(goal({ goals: ['consult'] }));
  assert.doesNotMatch(f.view('#agents/connect/goal'), /name="attendRisk"|name="directRisk"/);
  await f.wizard.submit(goal({ goals: ['attend'] })); assert.equal(f.wizard.debug.errorField, 'attendRisk'); assert.match(f.view('#agents/connect/goal'), /name="attendRisk"/);
  await f.wizard.submit(goal({ goals: ['attend'], attendRisk: true }));
  await f.wizard.submit(goal({ goals: ['consult'], attendRisk: true, directRisk: true }));
  assert.equal(f.wizard.debug.draft.attendRisk, false); assert.equal(f.wizard.debug.draft.directRisk, false);
  await f.wizard.submit(goal({ goals: ['attend'] })); assert.equal(f.wizard.debug.errorField, 'attendRisk');
  await f.wizard.submit(goal({ goals: ['consult'], direct: ['reply.send'] })); assert.equal(f.wizard.debug.errorField, 'directRisk'); assert.match(f.view('#agents/connect/goal'), /name="directRisk"/);
  await f.wizard.submit(goal({ goals: ['consult'], direct: ['reply.send'], directRisk: true })); assert.equal(f.location.hash, '#agents/connect/access');
  await f.wizard.submit(goal({ goals: ['consult'], directRisk: true })); assert.equal(f.wizard.debug.draft.directRisk, false);
  await f.wizard.submit(goal({ goals: ['consult'], direct: ['message.schedule'] })); assert.equal(f.wizard.debug.errorField, 'directRisk');
});

test('EN: escopo, erros e atualização de recibos pós-leitura sem mensagem nem chave nova', async () => {
  const receipts = [{ capability: 'conversation.read', state: 'confirmed', createdAt: new Date().toISOString(), result: { operation: 'inbox' } }];
  const f = fixture({ intercept: (path, init, fallback) => path.endsWith('/receipts') ? { receipts: [...receipts] } : fallback() });
  await toVerify(f); const { checks } = mountVerify(f); await settle(); await settle();
  assert.match(checks.innerHTML, /Atualizar recibos/); assert.equal(f.wizard.debug.polling, 'success');
  const before = f.calls.length, notices = f.toasts.length;
  receipts.push({ capability: 'reply.submit', state: 'confirmed', createdAt: new Date().toISOString() });
  await f.wizard.act('connect:verify-again'); await settle(); await settle();
  assert.ok(f.calls.slice(before).every(call => call.method === 'GET')); assert.equal(f.calls.slice(before).filter(call => call.path.endsWith('/receipts')).length, 1);
  assert.equal(f.toasts.length, notices); assert.equal(f.timers.pending, 0); assert.equal(f.posts('/service-principals'), 1);
  const draftLine = checks.innerHTML.match(/<li\b[^>]*>[\s\S]*?<\/li>/g).find(line => line.includes('<strong>Rascunho para revisão'));
  assert.match(draftLine, /data-state="ok"/);
  setLocale('en', { persist: false, notify: false });
  try {
    const verify = f.view(); assert.match(verify, /Refresh receipts/); assert.match(verify, /Read access confirmed\. The setup wizard did not send any messages\./);
    assert.doesNotMatch(verify, /Atualizar recibos|Leitura confirmada/);
    const g = fixture(); await g.wizard.submit(identity()); await g.wizard.submit(goal({ goals: ['consult'] }));
    assert.doesNotMatch(g.view('#agents/connect/goal'), /name="attendRisk"|name="directRisk"/);
    g.view('#agents/connect/access'); // Return to the real form before submitting its values.
    await g.wizard.submit(access({ daily: '1,5' }));
    const html = g.view(); assert.match(html, /Enter a whole number from 1 to 10,000/); assert.match(html, /name="dailyRequests"[^>]*value="1,5"[^>]*aria-invalid="true"/);
    assert.match(html, /All in this company includes channels created later/); assert.match(html, /All in this company includes departments created later/);
    assert.doesNotMatch(html, /Use um número inteiro|Todos nesta empresa/);
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
});
