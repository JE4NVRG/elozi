// Pendências (public/pending-ui.js, P6, FRONTEND-V2 §5.3.4 and §8.7): the page and the sections of the bell
// drawer. Sections follow §5.3.4; a section without a source says "Indisponível nesta versão" (never a
// false zero); approving happens in the conversation; "Marcar como visto" never transfers and is separate
// from "Assumir"; admin-only sections stay hidden from attendants; the drawer gets SafeHTML sections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, setLocale, SafeHTML } from '../public/i18n.js';
import { parseHash } from '../public/router.js';
import { EMPTY_ATTENTION } from '../public/attention.js';
import { createPending, pendingContextFromState } from '../public/pending-ui.js';

const NOW = Date.parse('2026-10-06T14:00:00Z');
const settle = () => new Promise(resolve => setImmediate(resolve));
const pageHeading = (eyebrow, title, description) => `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions"></div></div>`;
const minutesAgo = n => new Date(NOW - n * 60000).toISOString();

function fixture({ role = 'reseller', permissions = null, support = null, userId = 'person-a', intercept, tenant = {} } = {}) {
  const state = {
    workspaceId: 'workspace-a', supportGrantId: support,
    boot: { session: { userId, role, permissions, platformOwner: false }, tenants: [{ id: 'tenant-a', name: 'Loja Centro' }, { id: 'tenant-b', name: 'Atacado Sul' }] },
    tenant: {
      id: 'tenant-a', name: 'Loja Centro', brand: { accent: '#3157d5' },
      agents: [{ id: 'agent-1', name: 'Assistente Vendas' }],
      runs: [
        { id: 'run-7', agentId: 'agent-1', conversationId: 'conv-1', state: 'waiting_approval', toolProposal: { id: 'tp', serverName: 'ERP', title: 'Consultar pedido', toolName: 'erp_order', expiresAt: new Date(NOW + 6 * 60000).toISOString() } },
        { id: 'run-8', agentId: 'agent-1', conversationId: 'conv-1', state: 'waiting_approval', toolProposal: { id: 'tq', title: 'Automática', autoApproved: true, expiresAt: new Date(NOW + 60000).toISOString() } },
        { id: 'run-9', agentId: 'agent-1', conversationId: 'conv-1', state: 'waiting_approval', toolProposal: { id: 'tr', title: 'Vencida', expiresAt: minutesAgo(1) } },
        { id: 'run-10', agentId: 'agent-1', conversationId: 'conv-2', state: 'completed' }
      ],
      conversations: [
        { id: 'conv-1', contact: 'Maria Souza', owner: 'human', status: 'open', version: 4, updatedAt: minutesAgo(2) },
        { id: 'conv-2', contact: 'Grupo Revendas Sul', owner: 'agent', agentId: 'agent-1', status: 'open', version: 9, updatedAt: minutesAgo(1), assignedUserId: null, messages: [{ kind: 'customer', createdAt: minutesAgo(14) }, { kind: 'note', createdAt: minutesAgo(1) }] },
        { id: 'conv-3', contact: 'João P.', owner: 'agent', agentId: 'agent-1', status: 'open', version: 2, updatedAt: minutesAgo(30), assignedUserId: 'person-b', messages: [{ kind: 'customer', createdAt: minutesAgo(30) }] },
        { id: 'conv-4', contact: 'Fechada', owner: 'agent', status: 'closed', version: 3 }
      ],
      channels: [{ id: 'wa-atacado', name: 'WhatsApp Atacado', state: 'logged_out' }, { id: 'tg', name: 'Telegram', state: 'connected' }, { id: 'site', name: 'Site', state: 'disconnected' }],
      ...tenant
    }
  };
  const calls = [], toasts = [], hashes = [];
  const fallback = (path, init = {}) => {
    if (path === '/api/inbox?unread=1&limit=1') return { items: [], countTabs: { all: 9, mine: 2, queue: 3, agent: 1 } };
    if (path === '/api/tenants/tenant-a/agent-admin-proposals') return { proposals: [{ id: 'prop-1', state: 'pending', type: 'flow', name: 'Trocas', serviceName: 'Hermes do Jean', version: 1 }, { id: 'prop-2', state: 'approved', type: 'agent', name: 'Velha' }] };
    if (path === '/api/tenants/tenant-a/agents/usage?days=1') return { limit: 500000, today: { totalTokens: 430000 } };
    if (init.method === 'POST' && path.endsWith('/owner')) return { ok: true };
    throw Object.assign(new Error('rota inesperada ' + path), { status: 404 });
  };
  const request = async (path, init = {}) => { calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers }); return intercept ? intercept(path, init, () => fallback(path, init)) : fallback(path, init); };
  let snapshot = null;
  const pending = createPending({ pageHeading, state, request, attention: () => ({ snapshot: () => snapshot }), toast: (message, error = false) => toasts.push([message, error]), navigate: hash => hashes.push(hash), timers: { now: () => NOW } });
  return { pending, state, calls, toasts, hashes, setSnapshot: value => { snapshot = value; }, view: (hash = '#pending') => pending.view(parseHash(hash)) };
}
const section = (html, id) => new RegExp(`<section class="pg-pending__section" aria-labelledby="pending-title-${id}" data-section="${id}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? null;

test('sem o contexto do painel continua o aviso honesto do P1 e a gaveta não recebe seções', () => {
  const pending = createPending({ pageHeading });
  assert.match(pending.view(parseHash('#pending')), /<h1>Pendências<\/h1>[\s\S]*A lista de pendências ainda não está disponível nesta versão\.[\s\S]*data-action="shell:pending"/);
  assert.deepEqual(pending.drawerSections(EMPTY_ATTENTION), []);
});

test('seções na ordem do §5.3.4; sem fonte diz "Indisponível nesta versão", nunca zero falso', () => {
  const f = fixture(), html = f.view();
  assert.deepEqual([...html.matchAll(/data-section="([a-z]+)"/g)].map(match => match[1]), ['approvals', 'handoffs', 'parked', 'waiting', 'proposals', 'channels', 'quota']);
  const handoffs = section(html, 'handoffs');
  assert.match(handoffs, /Indisponível nesta versão/); assert.doesNotMatch(handoffs, /\(0\)|pg-pending__count/, 'sem fonte, sem contagem');
  assert.match(handoffs, /Marcar como visto não transfere a conversa\. Para atender, use Assumir na conversa\./);
  assert.match(html, /Escopo: Loja Centro/); assert.match(html, /cobrem só a empresa aberta/);
  assert.match(section(html, 'proposals'), /Carregando…/, 'fonte existente ainda não carregada aparece carregando, não indisponível');
});

test('aprovações levam até a conversa (com ?run=) e nunca aprovam daqui; automáticas e vencidas não entram', () => {
  const html = section(fixture().view(), 'approvals');
  assert.match(html, /\(1\)/); assert.match(html, /Assistente Vendas quer usar ERP › Consultar pedido/); assert.match(html, /Loja Centro · Maria Souza · expira em 6 min/);
  assert.match(html, /href="#inbox\/tenant-a\/conv-1\?run=run-7"/); assert.match(html, /A aprovação acontece na conversa/);
  assert.doesNotMatch(html, /Automática|Vencida|data-action="(?:mcp|rail|pending):(?:approve|reject)/);
});

test('conversas paradas com agente: Assumir separado de Abrir, só com permissão de responder e sem dono humano', async () => {
  const f = fixture(), html = section(f.view(), 'parked');
  assert.match(html, /\(2\)/); assert.match(html, /Grupo Revendas Sul/); assert.match(html, /há 14 min sem resposta/, 'tempo desde a mensagem do cliente, não da nota');
  assert.match(html, /data-action="pending:take"[^>]*data-id="conv-2" data-version="9" data-tenant="tenant-a"/);
  assert.doesNotMatch(html, /data-id="conv-3"/, 'conversa com outra pessoa responsável não é assumida daqui');
  assert.match(html, /href="#inbox\/tenant-a\/conv-3"/); assert.doesNotMatch(html, /Fechada/);
  await f.pending.act('pending:take', 'conv-2', { dataset: { id: 'conv-2', version: '9', tenant: 'tenant-a' } });
  const post = f.calls.find(call => call.method === 'POST');
  assert.equal(post.path, '/api/tenants/tenant-a/conversations/conv-2/owner'); assert.deepEqual(post.body, { owner: 'human', version: 9 });
  assert.equal(post.headers['X-Elozi-Workspace'], 'workspace-a'); assert.deepEqual(f.hashes, ['#inbox/tenant-a/conv-2']); assert.equal(f.toasts.at(-1)[1], false);
  const conflict = fixture({ intercept: (path, init, fallback) => { if (init.method === 'POST') throw Object.assign(new Error('Versão antiga.'), { status: 409 }); return fallback(); } });
  await conflict.pending.act('pending:take', null, { dataset: { id: 'conv-2', version: '9', tenant: 'tenant-a' } });
  assert.match(conflict.toasts.at(-1)[0], /A conversa mudou/); assert.deepEqual(conflict.hashes, []);
  const forged = fixture();
  await forged.pending.act('pending:take', null, { dataset: { id: 'conv-3', version: '2', tenant: 'tenant-a' } });
  assert.equal(forged.calls.some(call => call.method === 'POST'), false, 'botão forjado para conversa de outra pessoa não chega ao servidor');
  const reader = fixture({ role: 'operator', permissions: ['inbox.read'] });
  assert.doesNotMatch(section(reader.view(), 'parked'), /pending:take/, 'sem inbox.reply não há Assumir');
});

test('administração vê propostas e cota (fontes da empresa aberta); atendente não vê essas seções', async () => {
  const f = fixture(), main = { querySelector: () => null };
  f.pending.mount(main, parseHash('#pending')); await settle();
  assert.deepEqual(f.calls.map(call => call.path).sort(), ['/api/inbox?unread=1&limit=1', '/api/tenants/tenant-a/agent-admin-proposals', '/api/tenants/tenant-a/agents/usage?days=1']);
  const html = f.view();
  assert.match(section(html, 'proposals'), /\(1\)[\s\S]*Novo fluxo “Trocas”[\s\S]*proposto por Hermes do Jean[\s\S]*href="#agents"[\s\S]*Revisar/);
  assert.match(section(html, 'quota'), /\(1\)[\s\S]*Loja Centro[\s\S]*86% da cota de hoje[\s\S]*role="progressbar"/);
  assert.match(html, /5 conversas não lidas para você\./, 'não lidas para você = mine + queue');
  f.pending.mount(main, parseHash('#pending')); await settle();
  assert.equal(f.calls.length, 3, 'no máximo uma carga por minuto');
  const attendant = fixture({ role: 'operator', permissions: ['inbox.read', 'inbox.reply'] });
  attendant.pending.mount(main, parseHash('#pending')); await settle();
  const page = attendant.view();
  assert.equal(section(page, 'proposals'), null); assert.equal(section(page, 'quota'), null);
  assert.deepEqual(attendant.calls.map(call => call.path), ['/api/inbox?unread=1&limit=1']);
  assert.match(section(page, 'channels'), /WhatsApp Atacado · Sessão encerrada[\s\S]*Avise a administração da empresa\./);
  assert.doesNotMatch(section(page, 'channels'), /Reconectar|href="#channels/, 'atendente não recebe ação de reconectar');
  assert.match(section(f.view(), 'channels'), /\(1\)[\s\S]*href="#channels\/wa-atacado"[\s\S]*Reconectar/);
  const failing = fixture({ intercept: (path, init, fallback) => { if (path.includes('agents/usage')) throw Object.assign(new Error('x'), { status: 500 }); return fallback(); } });
  failing.pending.mount(main, parseHash('#pending')); await settle();
  assert.match(section(failing.view(), 'quota'), /Não foi possível carregar agora\.[\s\S]*pending:refresh/);
  const off = fixture({ intercept: (path, init, fallback) => path.includes('agents/usage') ? { limit: 0, today: { totalTokens: 0 } } : fallback() });
  off.pending.mount(main, parseHash('#pending')); await settle();
  const quota = section(off.view(), 'quota');
  assert.match(quota, /\(1\)[\s\S]*100% da cota de hoje[\s\S]*a IA está desligada nesta empresa/, 'limite 0 é IA desligada (100%), como no servidor');
  assert.doesNotMatch(quota, /Não foi possível carregar/);
});

test('conversas paradas seguem a regra do servidor: cliente por último; com piloto automático no canal, só após 10 min; parkedTotal conta todas', () => {
  const f = fixture({ tenant: {
    agents: [{ id: 'agent-1', name: 'Assistente Vendas' }, { id: 'agent-auto', name: 'Piloto', autopilot: { enabled: true, channelIds: null } }, { id: 'agent-wa', name: 'Só WhatsApp', autopilot: { enabled: true, channelIds: ['wa'] } }],
    runs: [],
    conversations: [
      { id: 'c-replied', contact: 'Ana', owner: 'agent', agentId: 'agent-auto', channelId: 'wa', status: 'open', version: 3, messages: [{ kind: 'customer', createdAt: minutesAgo(5) }, { kind: 'agent', createdAt: minutesAgo(2) }] },
      { id: 'c-fresh', contact: 'Bia', owner: 'agent', agentId: 'agent-auto', channelId: 'wa', status: 'open', version: 3, messages: [{ kind: 'customer', createdAt: minutesAgo(3) }] },
      { id: 'c-stalled', contact: 'Caio', owner: 'agent', agentId: 'agent-auto', channelId: 'wa', status: 'open', version: 3, messages: [{ kind: 'customer', createdAt: minutesAgo(12) }, { kind: 'note', createdAt: minutesAgo(1) }] },
      { id: 'c-other-channel', contact: 'Duda', owner: 'agent', agentId: 'agent-wa', channelId: 'tg', status: 'open', version: 3, messages: [{ kind: 'customer', createdAt: minutesAgo(2) }] },
      { id: 'c-manual', contact: 'Edu', owner: 'agent', agentId: 'agent-1', channelId: 'wa', status: 'open', version: 3, messages: [{ kind: 'customer', createdAt: minutesAgo(1) }] },
      { id: 'c-summary-note', contact: 'Fê', owner: 'agent', agentId: 'agent-1', channelId: 'wa', status: 'open', version: 3, lastMessage: { kind: 'note', createdAt: minutesAgo(20) } },
      { id: 'c-summary', contact: 'Gil', owner: 'agent', agentId: 'agent-1', channelId: 'wa', status: 'open', version: 3, lastMessage: { kind: 'customer', createdAt: minutesAgo(8) } }
    ] } });
  const html = section(f.view(), 'parked');
  assert.match(html, /\(4\)/);
  for (const id of ['c-stalled', 'c-other-channel', 'c-manual', 'c-summary']) assert.match(html, new RegExp(`href="#inbox/tenant-a/${id}"`), id);
  for (const id of ['c-replied', 'c-fresh', 'c-summary-note']) assert.doesNotMatch(html, new RegExp(`/${id}"`), `${id} não está parada`);
  assert.match(html, /Caio[\s\S]*há 12 min sem resposta/);
  assert.ok(html.indexOf('c-stalled') < html.indexOf('c-manual'), 'mais antigas primeiro');
  f.setSnapshot({ ...EMPTY_ATTENTION, source: 'attention', parked: [{ tenantId: 'tenant-b', conversationId: 'c5', since: minutesAgo(14) }], parkedTotal: 73 });
  assert.match(section(f.view(), 'parked'), /\(73\)/, 'o servidor lista até 50 e conta todas');
});

test('snapshot de /api/me/attention cobre todas as empresas; o pulso de P2 não substitui a leitura rica da empresa aberta', () => {
  const f = fixture();
  f.setSnapshot({ ...EMPTY_ATTENTION, source: 'attention', approvals: [{ tenantId: 'tenant-b', conversationId: 'c9', runId: 'r77', agentName: 'Hermes do Jean', toolTitle: 'Consultar estoque', external: true, expiresAt: new Date(NOW + 120000).toISOString() }],
    handoffs: { total: 2, byTenant: { 'tenant-b': 2 } }, parked: [{ tenantId: 'tenant-b', conversationId: 'c5', since: minutesAgo(14) }], proposals: { total: 3, byTenant: { 'tenant-a': 3 } },
    channelsDown: [{ tenantId: 'tenant-b', channelId: 'ch2', state: 'reconnecting', name: 'WhatsApp B' }], aiQuota: [{ tenantId: 'tenant-b', usedPct: 91, name: 'Atacado Sul' }] });
  const html = f.view();
  assert.match(html, /Escopo: Todas as empresas autorizadas/); assert.doesNotMatch(html, /cobrem só a empresa aberta/);
  assert.match(section(html, 'approvals'), /\(1\)[\s\S]*Hermes do Jean quer usar Consultar estoque[\s\S]*Atacado Sul · ferramenta externa · expira em 2 min[\s\S]*href="#inbox\/tenant-b\/c9\?run=r77"/);
  assert.match(section(html, 'handoffs'), /\(2\)[\s\S]*2 pedido\(s\) em Atacado Sul[\s\S]*href="#inbox\?tenant=tenant-b"/);
  assert.match(section(html, 'parked'), /\(1\)[\s\S]*Sem resposta automática · assuma[\s\S]*href="#inbox\/tenant-b\/c5"/);
  assert.match(section(html, 'proposals'), /\(3\)[\s\S]*3 proposta\(s\) aguardando a sua decisão/);
  assert.match(section(html, 'channels'), /WhatsApp B · Reconectando/); assert.doesNotMatch(section(html, 'channels'), /href="#channels/, 'canal de outra empresa: sem atalho fora do escopo');
  assert.match(section(html, 'quota'), /Atacado Sul[\s\S]*91% da cota de hoje/);
  const pulse = fixture();
  pulse.setSnapshot({ ...EMPTY_ATTENTION, source: 'pulse', approvals: [{ tenantId: 'tenant-a', conversationId: 'conv-1', runId: 'run-7', agentName: '', toolTitle: '' }], proposals: { total: 1, byTenant: { 'tenant-a': 1 } } });
  const page = pulse.view();
  assert.match(section(page, 'approvals'), /Assistente Vendas quer usar ERP › Consultar pedido/, 'no pulso a empresa aberta vem do estado do painel');
  assert.match(section(page, 'proposals'), /\(1\)[\s\S]*1 proposta\(s\)/, 'contagem do pulso enquanto a lista não carrega');
});

test('#pending/<tipo>/<id> destaca o item; a gaveta recebe seções SafeHTML com os dados', () => {
  const f = fixture(), html = f.view('#pending/approval/run-7');
  assert.match(html, /<li class="pg-pending__item" id="pending-approval-run-7" data-state="focused" tabindex="-1">/);
  let focused = null; const main = { querySelector: selector => selector === '[id="pending-approval-run-7"]' ? { focus: () => { focused = true; } } : null };
  f.pending.mount(main, parseHash('#pending/approval/run-7')); assert.equal(focused, true);
  const sections = f.pending.drawerSections({ ...EMPTY_ATTENTION, source: 'pulse' });
  assert.deepEqual(sections.map(item => [item.id, item.available, item.count, item.scope]), [['approvals', true, 1, 'tenant'], ['handoffs', false, null, null], ['parked', true, 2, 'tenant'], ['waiting', true, 0, 'tenant'], ['proposals', false, null, null], ['channels', true, 1, 'tenant'], ['quota', false, null, null]]);
  for (const item of sections) assert.ok(item instanceof SafeHTML);
  const drawer = String(h`<div>${sections}</div>`);
  assert.match(drawer, /<h3 class="pg-pending__title" id="pending-title-drawer-approvals">/); assert.match(drawer, /id="pending-drawer-approval-run-7"/);
  assert.doesNotMatch(drawer, /data-action="pending:take"|pending:refresh/, 'a gaveta só leva até a conversa'); assert.match(drawer, /Abra Pendências para ver\./);
  assert.ok(!drawer.includes('[object Object]'));
});

test('EN: títulos, avisos e contagens traduzidos; nomes de empresas e contatos preservados', () => {
  setLocale('en', { persist: false, notify: false });
  try {
    const html = fixture().view();
    assert.match(html, /<h1>Pending<\/h1>/); assert.match(html, /Agent approvals/); assert.match(html, /Unavailable in this version/); assert.match(html, /Mark as seen does not transfer the conversation/);
    assert.match(html, /Assistente Vendas wants to use ERP › Consultar pedido/); assert.match(html, /Grupo Revendas Sul/); assert.match(html, /Scope: Loja Centro/);
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
});

test('contexto lido do estado do painel; ações fora do namespace voltam ao código legado', async () => {
  const context = pendingContextFromState({ workspaceId: 'w', supportGrantId: null, boot: { session: { userId: 'u', role: 'operator', permissions: ['inbox.read'] }, tenants: [{ id: 't', name: 'T' }] }, tenant: { id: 't', name: 'T' } });
  assert.deepEqual({ workspaceId: context.workspaceId, userId: context.userId, role: context.role, runs: context.tenant.runs, channels: context.tenant.channels }, { workspaceId: 'w', userId: 'u', role: 'operator', runs: [], channels: [] });
  const f = fixture();
  assert.equal(await f.pending.act('pending:anything'), false); assert.equal(await f.pending.act('connect:create'), false); assert.equal(await f.pending.submit({ dataset: { form: 'pending:x' } }), false);
  assert.equal(f.pending.reset(), undefined);
});

test('fila sem dono: espera de 5 minutos na empresa aberta, Assumir da fila e linha de saúde do agente do servidor', async () => {
  const queue = (id, minutes, extra = {}) => ({ id, contact: 'Cliente ' + id, owner: 'queue', status: 'open', version: 3, updatedAt: minutesAgo(minutes), messages: [{ kind: 'customer', createdAt: minutesAgo(minutes) }], ...extra });
  const f = fixture({ tenant: { conversations: [queue('q-old', 16), queue('q-new', 2), queue('q-answered', 30, { messages: [{ kind: 'customer', createdAt: minutesAgo(30) }, { kind: 'human', createdAt: minutesAgo(29) }] }), queue('q-closed', 40, { status: 'closed' }), queue('q-stale', 25 * 60)] } });
  const html = section(f.view(), 'waiting');
  assert.match(html, /\(1\)/); assert.match(html, /Cliente q-old/); assert.match(html, /há 16 min sem dono/);
  assert.doesNotMatch(html, /q-new|q-answered|q-closed|q-stale/, 'recent, answered, closed and day-old conversations do not wait');
  assert.match(html, /<strong data-pii>Cliente q-old<\/strong>/, 'the contact name is hidden by the privacy mode');
  assert.match(html, /data-action="pending:take"[^>]*data-id="q-old" data-version="3" data-tenant="tenant-a"/);
  await f.pending.act('pending:take', null, { dataset: { id: 'q-old', version: '3', tenant: 'tenant-a' } });
  const post = f.calls.find(call => call.method === 'POST');
  assert.equal(post.path, '/api/tenants/tenant-a/conversations/q-old/owner'); assert.deepEqual(post.body, { owner: 'human', version: 3 });
  assert.deepEqual(f.hashes, ['#inbox/tenant-a/q-old']);

  const all = fixture({ tenant: { conversations: [queue('q-old', 16)] } });
  all.setSnapshot({ ...EMPTY_ATTENTION, source: 'attention', waitingTotal: 61, waiting: [
    { tenantId: 'tenant-a', conversationId: 'q-old', since: minutesAgo(16), agent: { name: 'Sofia', lastSeenAt: minutesAgo(15) } },
    { tenantId: 'tenant-b', conversationId: 'q-b', since: minutesAgo(12), agent: null }] });
  const page = section(all.view(), 'waiting');
  assert.match(page, /\(61\)/, 'the server lists up to 50 and counts all of them');
  assert.match(page, /Cliente q-old[\s\S]*Loja Centro · há 16 min sem dono · Sofia: última chamada há 15 min/);
  assert.match(page, /Conversa na fila[\s\S]*Atacado Sul · há 12 min sem dono/, 'another company: no contact name from the open company');
  assert.doesNotMatch(page, /data-id="q-b"/, 'take only what the open company holds');
});
