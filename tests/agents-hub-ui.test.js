// Central de Agentes, hub (FRONTEND-V2 §5.3.1, §8.6): list, quota, Atividade and Uso tabs, deep links,
// white label of the engine name, providers that do not run yet and the actions of the hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale } from '../public/i18n.js';
import { parseHash, aliasEntries } from '../public/router.js';
import { viewForRoute } from '../public/nav-config.js';
import { createAgentsHub } from '../public/agents-hub-ui.js';
import { createMcpUI } from '../public/mcp-ui.js';
import { usageModel, dailySeries, seriesTotals } from '../public/agent-usage-ui.js';

const today = '2026-10-06';
const report = (extra = {}) => ({ from: '2026-09-07', to: today, days: 30, timeZone: 'America/Sao_Paulo', limit: 500000, limitVersion: 3,
  today: { runs: 41, promptTokens: 150000, completionTokens: 32000, totalTokens: 182000, remaining: 318000, blocked: false },
  daily: [{ day: today, agentId: 'a1', agentName: 'Assistente Vendas', runs: 28, promptTokens: 100000, completionTokens: 20000, totalTokens: 120000 },
    { day: '2026-10-05', agentId: 'a1', agentName: 'Assistente Vendas', runs: 10, promptTokens: 40000, completionTokens: 8000, totalTokens: 48000 }],
  agents: [{ agentId: 'a1', agentName: 'Assistente <Vendas>', runs: 38, promptTokens: 140000, completionTokens: 28000, totalTokens: 168000 }],
  totals: { runs: 38, promptTokens: 140000, completionTokens: 28000, totalTokens: 168000 }, ...extra });

function fixture({ role = 'reseller', platformOwner = false, supportGrantId = null, features = [], usage = { data: report(), error: null, loading: false }, agents } = {}) {
  const calls = [], renders = [];
  const state = { workspaceId: 'w1', supportGrantId, boot: { features, session: { role, userId: 'u1', platformOwner } },
    tenant: { id: 't1', name: 'Acme', channels: [{ id: 'c1', name: 'WhatsApp Vendas', kind: 'whatsapp_qr' }], departments: [],
      conversations: [{ id: 'conv1', contact: 'Maria <b>', version: 4 }],
      agents: agents || [
        { id: 'a1', name: 'Assistente <Vendas>', provider: 'hermes', mode: 'copilot', configured: true, version: 7, toolPolicy: 'approve_all', autopilot: { enabled: true, channelIds: ['c1'] } },
        { id: 'a2', name: 'Bot Estoque', provider: 'mcp', mode: 'copilot', configured: true, version: 1 },
        { id: 'a3', name: 'Antigo', provider: 'claude', mode: 'copilot' }],
      runs: [{ id: 'r1', agentId: 'a1', agentName: 'Assistente Vendas', conversationId: 'conv1', state: 'draft', startedAt: new Date(Date.now() - 180000).toISOString(), actorName: 'Ana', usage: { total_tokens: 1240 }, toolSteps: [{ title: 'Ficha', autoApproved: true }, { title: 'ERP', autoApproved: false }] },
        { id: 'r2', agentId: 'a1', agentName: 'Assistente Vendas', conversationId: 'conv1', state: 'failed', reason: 'Serviço fora do ar.', startedAt: new Date(Date.now() - 7200000).toISOString(), initiatorKind: 'service', actorName: 'Robô' }] } };
  const principals = { summary: { loaded: true, loading: false, error: '', items: [{ id: 'p1', name: 'Chave QA', agentId: 'a2', state: 'active', capabilities: ['conversation.read', 'reply.submit'], channelIds: null, departmentIds: null, dailyRequests: 500, maxConcurrent: 2, expiresAt: '2026-12-31T00:00:00Z', usage: { requests: 34 } }] }, load: async () => {} };
  const hub = createAgentsHub({ state, escape: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    pageHeading: (eyebrow, title, description) => `<div class="page-heading"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>`,
    renderAgentAdminProposals: () => '<section data-proposals>propostas</section>', renderSupportAssistant: () => '<section data-support-assistant-root>central</section>',
    mcpPanel: () => '<section id="mcp-settings">painel MCP</section>',
    request: async (path, options = {}) => { calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }); return { id: 'novo-1' }; },
    render: () => renders.push('render'), refresh: async () => renders.push('refresh'), principals: () => principals,
    usageSource: usage === null ? { snapshot: () => null, load: async () => {}, canEdit: () => role === 'reseller' && !supportGrantId } : { snapshot: () => usage, load: async () => {}, canEdit: () => role === 'reseller' && !supportGrantId } });
  return { hub, state, calls, renders, principals, view: hash => hub.view(parseHash(hash)) };
}

test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));

test('lista: colunas, tipos sem o motor, política, hoje, último uso, cota do dia e nomes escapados', () => {
  const f = fixture(), page = f.view('#agents');
  assert.match(page, /<h1 class="pg-agents__h1">Agentes<\/h1>/);
  for (const column of ['Agente', 'Tipo', 'Saúde', 'Ferramentas / permissões', 'Hoje', 'Último uso']) assert.match(page, new RegExp(`<th scope="col">${column}</th>`));
  assert.match(page, /href="#agents\/a1">Assistente &lt;Vendas&gt;<\/a><p class="pg-agents__muted pg-agents__responsibility">Piloto automático · 1 canal\(is\) autorizado\(s\)/);
  assert.match(page, /cell-value">Copiloto gerenciado<\/span>/); assert.match(page, /cell-value">Agente pessoal · externo \(MCP\)<\/span>/); assert.match(page, /cell-value">Claude · em breve<\/span>/);
  assert.match(page, /cell-value">Aprovar cada uso<\/span>/, 'política do copiloto vinda de toolPolicy');
  assert.match(page, /cell-value">Rascunho para revisão<\/span>/, 'capacidades são permissões, não autonomia');
  assert.match(page, /cell-value">28 execuções · 120\smil tokens<\/span>/); assert.match(page, /cell-value">34 chamadas<\/span>/);
  assert.match(page, /há 3 minutos/);
  assert.match(page, /title="Nenhum uso entre as execuções carregadas">Sem uso nos dados carregados<\/span>/, 'ausência de dados descrita sem inventar nunca');
  assert.match(page, /aria-valuetext="182\smil de 500\smil tokens \(36%\)"/); assert.match(page, /41 execuções hoje/);
  assert.match(page, /data-action="agents:usage-limit"/); assert.doesNotMatch(page, /rascunhos usados: —/, 'métrica sem fonte não compete com a lista');
  assert.match(page, /cell-value">Saúde não informada<\/span>/, 'ausência de saúde tem texto, nunca verde inventado');
  assert.match(page, /href="#agents\/connect"><span class="ui-btn__label">Conectar meu agente<\/span>/); assert.match(page, /data-action="agents:new"/);
  assert.match(page, /data-proposals/); assert.doesNotMatch(page, /data-support-assistant-root/, 'assistente central só para o dono da plataforma');
  assert.doesNotMatch(page, /Hermes/, 'nenhum "Hermes" fora do workspace da plataforma');
});

test('lista: política distingue resposta atribuída, envio e agendamento em grupos pelas identidades ativas', () => {
  const f = fixture(), item = f.principals.summary.items[0];
  const policy = capabilities => { item.capabilities = ['conversation.read', ...capabilities]; return f.view('#agents'); };
  assert.match(policy(['reply.send']), /cell-value">Respostas atribuídas e envio em grupos<\/span>/);
  assert.match(policy(['message.schedule']), /cell-value">Agendamento em grupos<\/span>/);
  assert.match(policy(['reply.send', 'message.schedule']), /cell-value">Respostas atribuídas, envio e agenda em grupos<\/span>/);
  f.principals.summary.items.push({ ...item, state: 'paused', capabilities: ['reply.send'] });
  assert.match(policy(['message.schedule']), /cell-value">Agendamento em grupos<\/span>/, 'identidade pausada não amplia a política exibida');
  assert.doesNotMatch(policy(['reply.send']), /Ações diretas em grupos/);
  setLocale('en', { persist: false, notify: false });
  assert.match(policy(['reply.send']), /cell-value">Assigned replies and group sending<\/span>/);
  assert.match(policy(['message.schedule']), /cell-value">Group scheduling<\/span>/);
  assert.match(policy(['reply.send', 'message.schedule']), /cell-value">Assigned replies, group sending and scheduling<\/span>/);
});

test('novo copiloto: provedores que não executam ficam desabilitados com "Em breve" e o envio só cria o gerenciado', async () => {
  const f = fixture(), page = f.view('#agents');
  assert.match(page, /<input type="radio" name="provider" value="hermes" checked\/>/);
  for (const provider of ['claude', 'codex', 'webhook']) assert.match(page, new RegExp(`<input type="radio" name="provider" value="${provider}" disabled/><span>[^<]+<span class="ui-badge ui-badge--neutral">Em breve</span>`));
  assert.match(page, /name="name" maxlength="48" required value="Assistente Acme"/, 'nome padrão "Assistente <Empresa>"');
  assert.match(page, /<span class="pg-agents__label">Função do copiloto<\/span><input class="pg-agents__control" name="description" maxlength="200" required/, 'o servidor exige de 1 a 200 caracteres');
  const values = { name: ' Assistente Acme ', description: 'Vendas', provider: 'hermes' }, form = { dataset: { form: 'agents:create' }, querySelector: () => null, closest: () => null };
  const previous = globalThis.FormData;
  globalThis.FormData = class { constructor() { this.values = values; } get(name) { return this.values[name] ?? null; } getAll(name) { return [].concat(this.values[name] ?? []); } };
  globalThis.location = { hash: '#agents' };
  try {
    assert.equal(await f.hub.submit(form), true);
    assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t1/agents', method: 'POST', body: { name: 'Assistente Acme', description: 'Vendas', provider: 'hermes', mode: 'copilot' } });
    assert.equal(globalThis.location.hash, '#agents/novo-1/instructions', 'abre as instruções do copiloto criado');
    values.provider = 'claude'; const before = f.calls.length;
    assert.equal(await f.hub.submit(form), true); assert.equal(f.calls.length, before, 'provedor em breve nunca chega ao servidor');
    Object.assign(values, { provider: 'hermes', description: '   ' });
    assert.equal(await f.hub.submit(form), true); assert.equal(f.calls.length, before, 'função vazia nunca chega ao servidor (seria 400)');
  } finally { globalThis.FormData = previous; delete globalThis.location; }
});

test('dono da plataforma vê o motor e a central de suporte; revenda e cliente nunca leem "Hermes"', () => {
  const owner = fixture({ platformOwner: true }).view('#agents');
  assert.match(owner, /cell-value">Copiloto gerenciado · Hermes<\/span>/); assert.match(owner, /Conectar meu agente/); assert.match(owner, /data-support-assistant-root/);
  const delegated = fixture({ platformOwner: true, supportGrantId: 'g1' }).view('#agents');
  assert.doesNotMatch(delegated, /Hermes|data-support-assistant-root/, 'suporte temporário não vê o motor nem a central');
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const f = fixture({ agents: [{ id: 'a1', name: 'Assistente Vendas', provider: 'hermes', configured: false, version: 2 }, { id: 'a2', name: 'Bot', provider: 'mcp' }] });
    for (const hash of ['#agents', '#agents/activity', '#agents/usage', '#agents/a1', '#agents/a1/instructions', '#agents/a1/tools', '#agents/a1/knowledge', '#agents/a1/memory', '#agents/a1/access', '#agents/a1/usage', '#agents/a1/activity', '#agents/a2/access', '#agents/a2/instructions']) {
      assert.doesNotMatch(f.view(hash), /Hermes/, `${locale} ${hash}`);
    }
  }
});

test('atendente: lista em leitura, sem ações, sem tokens nem cota; ações de administração recusadas', async () => {
  const f = fixture({ role: 'operator', usage: null }), page = f.view('#agents');
  assert.doesNotMatch(page, /data-action="agents:new"|agents:usage-limit|href="#agents\/connect"|<th scope="col">Hoje<\/th>|data-agents-slot="quota"|data-proposals/);
  assert.match(page, /Somente a administração do workspace altera os agentes\./);
  await assert.rejects(f.hub.act('agents:new'), /administração do workspace/);
  await assert.rejects(f.hub.act('agents:usage-limit'), /administração do workspace/);
  assert.match(f.view('#agents/usage'), /O consumo de tokens é visível para a administração do workspace\./);
  assert.equal(await f.hub.act('outra:acao'), false);
});

test('lista vazia: dois caminhos para o administrador, aviso para os demais', () => {
  const admin = fixture({ agents: [] }).view('#agents');
  assert.match(admin, /Usar o assistente gerenciado[\s\S]*data-action="agents:new"[\s\S]*Conectar meu agente[\s\S]*Claude Code, Codex ou outro cliente MCP[\s\S]*href="#agents\/connect"/);
  assert.match(fixture({ agents: [], role: 'operator' }).view('#agents'), /Nenhum agente nesta empresa/);
});

test('abas do hub com deep link: Atividade e Uso no hub, Ferramentas do P1, #knowledge como alias de #agents/knowledge', () => {
  const f = fixture();
  assert.equal(viewForRoute(parseHash('#agents/activity')), 'agents'); assert.equal(viewForRoute(parseHash('#agents/usage')), 'agents');
  assert.equal(viewForRoute(parseHash('#agents/a1/instructions')), 'agents');
  assert.deepEqual(aliasEntries().find(([name]) => name === 'knowledge'), ['knowledge', '#agents/knowledge']);
  assert.equal(parseHash('#knowledge').alias, 'knowledge'); assert.equal(viewForRoute(parseHash('#knowledge')), 'knowledge');
  const activity = f.view('#agents/activity');
  assert.match(activity, /<h2 class="pg-agents__h2">Atividade<\/h2>/); assert.match(activity, /href="#inbox\/t1\/conv1">Maria &lt;b&gt;<\/a>/);
  assert.match(activity, /Pessoa · Ana/); assert.match(activity, /Serviço · Robô/); assert.match(activity, /<td class="pg-agents__num">1\/3<\/td>/, 'só consultas automáticas contam no n/3');
  assert.match(activity, /<td class="pg-agents__num">1.240<\/td>/); assert.match(activity, /title="Latência não informada">—/); assert.match(activity, /title="Medição de adoção em breve">—/);
  assert.match(activity, /data-action="agents:toggle-run"[^>]*aria-expanded="false" aria-controls="agents-run-r1"/); assert.match(activity, /id="agents-run-r1" class="pg-agents__run-detail" hidden/);
  assert.match(activity, /Consulta automática · Ficha[\s\S]*Ferramenta aprovada por pessoa · ERP[\s\S]*Rascunho pronto para revisão/, 'cronologia da execução');
  assert.doesNotMatch(fixture({ role: 'operator', usage: null }).view('#agents/activity'), /<th scope="col">Tokens<\/th>/, 'tokens crus só para administração');
  const usage = f.view('#agents/usage');
  assert.match(usage, /<svg class="pg-agents__chart-svg" viewBox="0 0 476 120"[^>]*role="img" aria-label="Tokens por dia nos últimos 30 dias: 168.000 no total">/);
  assert.match(usage, /<th scope="row">Assistente &lt;Vendas&gt;<\/th><td class="pg-agents__num">38<\/td><td class="pg-agents__num">140.000<\/td><td class="pg-agents__num">28.000<\/td><td class="pg-agents__num">168.000<\/td>/);
  assert.match(usage, /Desfechos e latência[\s\S]*medição em breve/);
  assert.match(f.view('#agents/tools'), /<h1>Ferramentas para os copilotos desta empresa\.<\/h1>[\s\S]*<section id="mcp-settings">painel MCP<\/section>$/, 'aba Ferramentas do P1 (commit 1g) mantida');
});

test('uso honesto: carregando, erro, sem fonte "em breve" e limite atingido', () => {
  assert.match(fixture({ usage: { data: null, error: null, loading: true } }).view('#agents/usage'), /role="status">Carregando o consumo de IA…/);
  assert.match(fixture({ usage: { data: null, error: 'Falhou <x>', loading: false } }).view('#agents/usage'), /Não foi possível carregar o consumo de IA\.[\s\S]*Falhou &lt;x&gt;/);
  assert.match(fixture({ usage: null }).view('#agents/usage'), /Medição disponível em breve/);
  const blocked = fixture({ usage: { data: report({ limit: 1000, today: { runs: 2, promptTokens: 700, completionTokens: 300, totalTokens: 1000, blocked: true } }), error: null, loading: false } }).view('#agents');
  assert.match(blocked, /data-state="blocked"/); assert.match(blocked, /Limite diário atingido\.[\s\S]*Novos rascunhos ficam bloqueados até o próximo dia\./);
  const near = fixture({ usage: { data: report({ limit: 200000 }), error: null, loading: false } }).view('#agents');
  assert.match(near, /data-state="near"/); assert.match(near, /Cota de IA perto do limite/);
  const free = fixture({ usage: { data: report({ limit: null }), error: null, loading: false } }).view('#agents');
  assert.match(free, /182\smil tokens hoje · sem limite diário/); assert.doesNotMatch(free, /role="progressbar"/);
  setLocale('en', { persist: false, notify: false });
  assert.match(fixture().view('#agents'), /182K of 500K tokens \(36%\)/);
});

test('modelo de uso: série diária preenchida, totais e relatório desconhecido sem zeros inventados', () => {
  const model = usageModel(report());
  const series = dailySeries(model, { agentId: 'a1', days: 7 });
  assert.equal(series.length, 7); assert.equal(series.at(-1).day, today); assert.equal(series.at(-1).total, 120000); assert.equal(series.at(-2).total, 48000); assert.equal(series[0].total, 0);
  assert.deepEqual(seriesTotals(series), { runs: 38, input: 140000, output: 28000, total: 168000 });
  assert.equal(usageModel({ quota: { dailyTokens: 1 } }), null); assert.equal(usageModel(null), null);
});

test('cota: "Ajustar cota" abre o limite diário do mcp-ui.js (mesma rota e CAS de hoje)', async () => {
  const forms = [], previous = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    const state = { workspaceId: 'w1', boot: { session: { role: 'reseller' } }, tenant: { id: 't1', name: 'Acme', agents: [] } };
    const mcp = createMcpUI({ state, escape: String, icon: () => '', badge: text => text, api: async () => report(), tenantApi: tail => `/api/tenants/t1/${tail}`, formModal: (title, description, type, fields) => forms.push({ type, fields }), refresh: async () => {}, render() {}, toast() {}, navigate() {} });
    await mcp.loadUsage();
    assert.equal(mcp.usageSnapshot().data.limitVersion, 3);
    let notified = 0; const stop = mcp.onUsage(() => notified++); await mcp.loadUsage({ force: true }); stop(); await mcp.loadUsage({ force: true });
    assert.equal(notified, 1, 'o hub é avisado a cada consumo carregado e pode deixar de ouvir');
    const hub = createAgentsHub({ state, pageHeading: () => '' });
    assert.equal(await hub.act('agents:usage-limit'), true);
    assert.equal(forms.at(-1).type, 'mcp-ai-limit'); assert.match(forms.at(-1).fields, /name="limit"[^>]*value="500000"/);
  } finally { globalThis.document = previous; }
});

test('último uso: lastSeenAt da identidade, "nunca" só com principal-last-seen e execuções da atividade completa', () => {
  const seen = new Date(Date.now() - 3600000).toISOString();
  const f = fixture({ features: ['principal-last-seen'] });
  assert.match(f.view('#agents'), /cell-value">nunca<\/span>/, 'o servidor anuncia lastSeenAt e a identidade nunca chamou');
  const withSeen = fixture();
  const principals = { summary: { loaded: true, loading: false, error: '', items: [{ id: 'p1', name: 'Chave', agentId: 'a2', state: 'active', capabilities: ['conversation.read'], channelIds: null, departmentIds: null, dailyRequests: 500, maxConcurrent: 2, expiresAt: '2026-12-31T00:00:00Z', usage: { requests: 34 }, lastSeenAt: seen }] } };
  const hub = createAgentsHub({ state: withSeen.state, principals: () => principals, usageSource: { snapshot: () => null, load: async () => {}, canEdit: () => true } });
  assert.match(hub.view(parseHash('#agents')), /cell-value">34 chamadas<\/span><\/td><td[^>]*><span[^>]*>Último uso<\/span><span class="pg-agents__cell-value">há 1 hora<\/span><\/td>/);
});

test('atividade completa (agent-runs): piloto automático nunca vira pessoa, desfecho traduzido, latência, desatualizado e motivo', async () => {
  const items = [
    { id: 'autopilot_1', agentId: 'a1', agentName: 'Assistente Vendas', conversationId: 'conv1', initiator: { kind: 'autopilot', name: 'Piloto automático Elozi' }, state: 'draft', stale: true, outcome: 'stale', toolSteps: [], tokens: { input: 100, output: 20 }, latencyMs: 2300, createdAt: new Date(Date.now() - 60000).toISOString(), completedAt: null, reason: null },
    { id: 'r9', agentId: 'a1', agentName: 'Assistente Vendas', conversationId: 'conv1', initiator: { kind: 'user', name: 'Ana' }, state: 'cancelled', stale: false, outcome: 'discarded', toolSteps: [], tokens: null, latencyMs: null, createdAt: new Date(Date.now() - 120000).toISOString(), reason: 'Descartado por Ana.' }];
  const f = fixture({ features: ['agent-runs'] });
  const hub = createAgentsHub({ state: f.state, request: async path => { assert.equal(path, '/api/tenants/t1/agents/runs?limit=50'); return { items }; }, usageSource: { snapshot: () => null, load: async () => {}, canEdit: () => true }, principals: () => null });
  assert.match(hub.view(parseHash('#agents/activity')), /Carregando o histórico de execuções…/);
  hub.mount(null, parseHash('#agents/activity'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const page = hub.view(parseHash('#agents/activity'));
  assert.match(page, /Últimas execuções desta empresa\./);
  assert.match(page, /<td>Piloto automático<\/td>/); assert.doesNotMatch(page, /Pessoa · Piloto|Elozi/, 'execução autônoma nunca atribuída a uma pessoa nem com a marca');
  assert.match(page, /<td class="pg-agents__num">2,3 s<\/td><td>Desatualizado<\/td>/); assert.match(page, /ui-badge--warning">Desatualizado/);
  assert.match(page, /<td title="Latência não informada">—<\/td><td>Descartado<\/td>/); assert.doesNotMatch(page, />discarded</, 'nunca o valor cru em inglês');
  assert.match(page, /Descartado por Ana\./, 'o motivo entra na cronologia');
  const legacy = fixture(); legacy.state.tenant.runs = [{ id: 'autopilot_7', agentId: 'a1', conversationId: 'conv1', state: 'draft', actorName: 'Piloto automático Elozi', startedAt: new Date().toISOString() }];
  assert.match(legacy.view('#agents/activity'), /<td>Piloto automático<\/td>/); assert.doesNotMatch(legacy.view('#agents/activity'), /Pessoa · /);
});

test('hierarquia operacional PT/EN: registro antes da cota, ações equivalentes e zeros com unidades', () => {
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const f = fixture({ usage: { data: report({ today: { runs: 0, totalTokens: 0 }, daily: [] }), loading: false, error: null } });
    f.state.tenant.name = 'Empresa <operacional>';
    const page = f.view('#agents');
    assert.ok(page.indexOf('data-agents-slot="agents-table"') < page.indexOf('data-agents-slot="quota"'));
    assert.match(page, /pg-agents__scope">Empresa &lt;operacional&gt;<\/p>/);
    const header = page.match(/<header[\s\S]*?<\/header>/)[0];
    assert.match(header, /ui-btn--secondary[^>]*href="#agents\/connect"/);
    assert.match(header, /ui-btn--secondary[^>]*data-action="agents:new"/);
    assert.doesNotMatch(header, /ui-btn--primary/);
    assert.match(page, locale === 'en' ? /0 runs · 0 tokens/ : /0 execuções · 0 tokens/);
    assert.doesNotMatch(page, /0 · 0|rascunhos usados: —|drafts used: —/);
    assert.match(page, /ui-btn--ghost[^>]*data-action="agents:usage-limit"/);
    assert.match(page, /href="#agents\/usage"/);
    assert.deepEqual(f.calls, [], 'renderizar não envia, concede nem cria');
  }
});

test('papel não é permissão: gerenciado sob demanda, autopilot salvo e cliente externo separados', () => {
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const f = fixture();
    f.state.tenant.agents[0].autopilot.enabled = false;
    f.state.tenant.agents[0].toolPolicy = 'auto_readonly';
    f.principals.summary.items[0].capabilities = ['reply.send', 'message.schedule'];
    const page = f.view('#agents');
    const managed = page.match(/<tr role="row"><th scope="row" role="rowheader">[\s\S]*?<\/tr>/)[0];
    const external = page.match(/<tr role="row"><th scope="row" role="rowheader">[\s\S]*?<\/tr>/g)[1];
    assert.match(managed, locale === 'en' ? /On demand · human review before sending/ : /Sob demanda · revisão humana antes do envio/);
    assert.match(external, locale === 'en' ? /Personal agent · external \(MCP\)/ : /Agente pessoal · externo \(MCP\)/);
    assert.match(external, locale === 'en' ? /Model, instructions and memory in your external client/ : /Modelo, instruções e memória no seu cliente externo/);
    assert.doesNotMatch(external, /Piloto automático|Autopilot|Consultas automáticas|Automatic lookups|Sob demanda|On demand/);
    assert.match(page, locale === 'en' ? /Permissions describe access, not autonomy/ : /Permissões indicam acesso, não autonomia/);
    f.state.tenant.agents[0].autopilot.enabled = true;
    assert.match(f.view('#agents'), locale === 'en' ? /Autopilot · 1 authorized channel\(s\)/ : /Piloto automático · 1 canal\(is\) autorizado\(s\)/);
  }
});

test('tabela mobile tem rótulos no DOM, cabeçalhos e papéis preservados; atendente não recebe consumo', () => {
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    for (const role of ['reseller', 'operator']) {
      const page = fixture({ role }).view('#agents');
      assert.match(page, /<table role="table"[^>]*pg-agents__table--agents/);
      assert.match(page, /<thead role="rowgroup">/);
      const rows = [...page.matchAll(/<tr role="row"><th scope="row" role="rowheader">([\s\S]*?)<\/tr>/g)];
      assert.equal(rows.length, 3);
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td role="cell"[^>]*>([\s\S]*?)<\/td>/g)];
        assert.equal(cells.length, role === 'reseller' ? 5 : 4);
        for (const cell of cells) assert.match(cell[1], /^<span class="pg-agents__cell-label" aria-hidden="true">[^<]+<\/span><span class="pg-agents__cell-value">/);
      }
      if (role === 'operator') assert.doesNotMatch(page, /data-agents-slot="quota"|agents:usage-limit|28 execuções|28 runs|34 chamadas|34 calls|agents:new|href="#agents\/connect"/);
    }
  }
  // Source guards complement, never replace, parent computed-style/pixel acceptance.
  const css = readFileSync(new URL('../public/screen-agents.css', import.meta.url), 'utf8');
  assert.match(css, /\.pg-agents--list \.ui-btn\s*\{[^}]*min-height: var\(--target-touch\)/);
  assert.match(css, /\.pg-agents--list \.pg-agents__agent-name, \.pg-agents__usage-summary a\s*\{[^}]*min-height: var\(--target-touch\)/);
  assert.match(css, /@media \(max-width: 599\.98px\)[\s\S]*\.pg-agents__table--agents \.pg-agents__cell-label\s*\{ display: block/);
});

test('ausência de medição é texto: saúde, uso e permissões não viram zero ou estado saudável', () => {
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const f = fixture({ usage: null, agents: [{ id: 'a1', name: 'Gerenciado', provider: 'hermes', configured: true }, { id: 'a2', name: 'Externo', provider: 'mcp' }] });
    f.state.tenant.runs = [];
    f.principals.summary.loaded = false;
    let page = f.view('#agents');
    assert.match(page, locale === 'en' ? /Health not reported/ : /Saúde não informada/);
    assert.match(page, locale === 'en' ? /Usage not reported/ : /Uso não informado/);
    assert.match(page, locale === 'en' ? /Permissions not loaded/ : /Permissões não carregadas/);
    assert.doesNotMatch(page, /cell-value">—|0 execuções|0 runs|0 chamadas|0 calls|ui-badge--success/);
    f.principals.summary.loaded = true;
    delete f.principals.summary.items[0].usage;
    page = f.view('#agents');
    const external = page.match(/<tr role="row"><th scope="row" role="rowheader">[\s\S]*?<\/tr>/g)[1];
    assert.match(external, locale === 'en' ? /Usage not reported/ : /Uso não informado/);
    assert.doesNotMatch(external, /NaN|0 chamadas|0 calls/);
  }
});

test('vazio PT/EN mantém caminhos reais antes de uso e não oferece administração ao atendente', () => {
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const admin = fixture({ agents: [] }).view('#agents');
    assert.ok(admin.indexOf('data-agents-slot="agents-table"') < admin.indexOf('data-agents-slot="quota"'));
    assert.match(admin, /data-action="agents:new"/);
    assert.match(admin, /href="#agents\/connect"/);
    assert.doesNotMatch(admin, /<table role="table"/);
    const reader = fixture({ agents: [], role: 'operator' }).view('#agents');
    assert.match(reader, locale === 'en' ? /No agents in this company/ : /Nenhum agente nesta empresa/);
    assert.doesNotMatch(reader, /agents:new|agents:usage-limit|href="#agents\/connect"|data-agents-slot="quota"/);
  }
});
