// Central de Agentes, agent detail (FRONTEND-V2 §5.3.2, §8.6): eight tabs with deep links, instructions
// with templates, CAS 409 conflict, line diff and leave guard; tool policy with CAS; external tools always
// with approval; "Testar" only with agent-preview; autopilot saved through the agent PATCH when the server
// takes it and read-only "em breve" when it does not; connected agents and their elozi_* tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../public/i18n.js';
import { parseHash } from '../public/router.js';
import { createAgentDetail, lineDiff, agentKind, kindLabel, healthOf, policyOf, autopilotOf, DETAIL_TABS } from '../public/agent-detail-ui.js';

const conflict = message => Object.assign(new Error(message), { status: 409 });
const rejected = message => Object.assign(new Error(message), { status: 400 });

function fixture({ role = 'reseller', features = [], agent = {}, responses = {}, principals = null } = {}) {
  const calls = [], renders = [], grants = [];
  const state = { workspaceId: 'w1', supportGrantId: null, boot: { features, session: { role, userId: 'u1' } }, knowledgeLoaded: true,
    knowledgeSources: [{ id: 's1', title: 'Trocas', archived: false, published: { version: 3, hash: 'h3', title: 'Política de trocas' } }],
    mcpServers: [{ id: 'erp', name: 'ERP <Loja>', kind: 'remote' }],
    tenant: { id: 't1', name: 'Loja Centro', departments: [{ id: 'd1', name: 'Suporte' }, { id: 'd2', name: 'Antigo', active: false }],
      channels: [{ id: 'wa', name: 'WhatsApp Vendas', kind: 'whatsapp_qr' }, { id: 'site', name: 'Chat do site', kind: 'webchat' }],
      conversations: [{ id: 'conv1', contact: 'Maria', version: 5 }], runs: [],
      agents: [{ id: 'a1', name: 'Assistente Loja', provider: 'hermes', mode: 'copilot', configured: true, version: 7, instructions: 'Linha A\nLinha B', toolPolicy: 'auto_readonly',
        mcpGrants: [{ serverId: 'elozi-internal', toolName: 'elozi_contact_profile' }, { serverId: 'elozi-internal', toolName: 'elozi_knowledge_search' }, { serverId: 'erp', toolName: 'lookup_order' }],
        knowledgeGrants: [{ sourceId: 's1', publicationVersion: 3, publicationHash: 'h3' }, { sourceId: 'gone', publicationVersion: 1 }], ...agent },
      { id: 'm1', name: 'Bot Estoque', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }, { id: 'x1', name: 'Velho', provider: 'codex' }] } };
  const admin = role === 'reseller';
  const detail = createAgentDetail({ state, context: () => ({ admin, owner: false, features: new Set(features), scope: 'w1:t1' }),
    request: async (path, options = {}) => {
      const call = { path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
      const answer = responses[`${call.method} ${path}`];
      const value = typeof answer === 'function' ? answer(call) : answer;
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    render: () => renders.push('render'), refresh: async () => {}, usage: { agentPanel: id => `<section data-usage="${id}"></section>`, agentRecent: () => ({ runs: 3, total: 4200 }) },
    principals: () => principals, grants: { tools: id => grants.push(['tools', id]), knowledge: id => grants.push(['knowledge', id]) } });
  const view = hash => detail.view(parseHash(hash));
  const form = (name, values = {}, extra = {}) => ({ dataset: { form: name, id: extra.id || 'a1' }, values, querySelector: selector => selector === '[data-agents-instructions]' && 'instructions' in values ? { value: values.instructions } : null, setAttribute() {}, removeAttribute() {}, ...extra });
  return { detail, state, calls, renders, grants, view, form, agent: state.tenant.agents[0] };
}

const realFormData = globalThis.FormData;
test.before(() => { globalThis.FormData = class { constructor(form) { this.values = form.values || {}; } get(name) { const value = this.values[name]; return value === undefined ? null : Array.isArray(value) ? value[0] : value; } getAll(name) { return [].concat(this.values[name] ?? []); } }; });
test.after(() => { globalThis.FormData = realFormData; });
test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));

test('oito abas com deep link, cabeçalho com tipo sem o motor e agente inexistente com h1 honesto', () => {
  const f = fixture(), page = f.view('#agents/a1/tools');
  assert.deepEqual(DETAIL_TABS, ['overview', 'instructions', 'tools', 'knowledge', 'memory', 'access', 'usage', 'activity']);
  assert.deepEqual([...page.matchAll(/data-tab="([a-z]+)" href="([^"]+)"/g)].map(match => [match[1], match[2]]), DETAIL_TABS.map(tab => [tab, `#agents/a1/${tab}`]));
  assert.match(page, /aria-selected="true"[^>]*data-tab="tools" href="#agents\/a1\/tools" aria-current="page">Ferramentas<\/a>/);
  assert.match(page, /<h1 class="pg-agents__h1">Assistente Loja<\/h1><p class="pg-agents__muted">Copiloto gerenciado<\/p>/);
  assert.match(f.view('#agents/a1'), /aria-selected="true"[^>]*data-tab="overview"/, 'sem aba: Visão geral');
  assert.match(f.view('#agents/nada'), /<h1 class="pg-agents__h1">Agente não encontrado<\/h1>[\s\S]*href="#agents"/);
  assert.equal(agentKind({ provider: 'webhook' }), 'planned'); assert.equal(kindLabel({ provider: 'webhook' }), 'API / webhook · em breve');
  assert.equal(kindLabel({ provider: 'hermes' }, { owner: true }), 'Copiloto gerenciado · Hermes');
  assert.equal(healthOf({ provider: 'mcp' }), null, 'sem agent.health: nada inventado');
  assert.equal(healthOf({ provider: 'hermes', health: { level: 'degraded', reason: 'Chave expira em 3 dias' } }).label, 'Atenção');
  assert.equal(policyOf({}), 'auto_readonly'); assert.equal(policyOf({ toolPolicy: 'x' }), 'approve_all', 'valor inesperado cai na política mais restrita');
});

test('instruções: modelos PT/EN com a empresa, contador, seção e salvar com CAS da versão', async () => {
  const f = fixture({ responses: { 'PATCH /api/tenants/t1/agents/a1': ({ body }) => ({ instructions: body.instructions.trim(), version: 8 }) } });
  let page = f.view('#agents/a1/instructions');
  assert.match(page, /<form class="pg-agents__card pg-agents__editor" data-form="agents:instructions" data-id="a1" data-state="saved">/);
  for (const [value, label] of [['sales', 'Vendas'], ['support', 'Suporte'], ['billing', 'Cobrança'], ['empty', 'Vazio']]) assert.match(page, new RegExp(`data-action="agents:instructions-template" data-id="a1" data-value="${value}"><span class="ui-btn__label">${label}</span>`));
  assert.match(page, /maxlength="4000"[^>]*data-agents-instructions="a1"[^>]*>Linha A\nLinha B<\/textarea>/);
  assert.match(page, /15 \/ 4.000 caracteres/); assert.match(page, /Salvo · v7/);
  await f.detail.act('agents:instructions-template', 'a1', { dataset: { value: 'sales' } });
  page = f.view('#agents/a1/instructions');
  assert.match(page, /## Papel\nVocê é o assistente de vendas da Loja Centro\./); assert.match(page, /Alterações não salvas/); assert.match(page, /data-state="dirty"/);
  setLocale('en', { persist: false, notify: false });
  await f.detail.act('agents:instructions-template', 'a1', { dataset: { value: 'billing' } });
  assert.match(f.view('#agents/a1/instructions'), /## Role\nYou kindly remind the customers of Loja Centro about open invoices/);
  setLocale('pt-BR', { persist: false, notify: false });
  await f.detail.act('agents:instructions-template', 'a1', { dataset: { value: 'empty' } });
  await f.detail.act('agents:instructions-section', 'a1', { dataset: { value: 'never' } });
  assert.match(f.view('#agents/a1/instructions'), /data-agents-instructions="a1"[^>]*>## Nunca faça\n<\/textarea>/);
  assert.equal(await f.detail.submit(f.form('agents:instructions', { instructions: 'Seja breve.\n' })), true);
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t1/agents/a1', method: 'PATCH', body: { version: 7, instructions: 'Seja breve.\n' } });
  assert.equal(f.agent.version, 8); assert.equal(f.agent.instructions, 'Seja breve.');
  assert.match(f.view('#agents/a1/instructions'), /Salvo · v8/);
});

test('instruções: 409 mostra o conflito, a diferença por linha, "Manter a minha" e "Descartar a minha" sem perder texto', async () => {
  let attempt = 0;
  const f = fixture({ responses: {
    'PATCH /api/tenants/t1/agents/a1': ({ body }) => ++attempt === 1 ? conflict('O agente mudou. Atualize antes de salvar.') : { instructions: body.instructions, version: body.version + 1 },
    'GET /api/tenants/t1': { agents: [{ id: 'a1', instructions: 'Linha A\nLinha nova deles', version: 9 }] } } });
  f.view('#agents/a1/instructions');
  await f.detail.submit(f.form('agents:instructions', { instructions: 'Linha A\nLinha minha\nExtra' }));
  let page = f.view('#agents/a1/instructions');
  assert.match(page, /data-state="conflict"/); assert.match(page, /role="alert"[\s\S]*Alguém salvou antes de você\.[\s\S]*Seu texto continua no editor/);
  assert.match(page, /data-action="agents:instructions-diff"[^>]*aria-expanded="false"[\s\S]*Manter a minha[\s\S]*Descartar a minha/);
  assert.match(page, />Linha A\nLinha minha\nExtra<\/textarea>/, 'o texto digitado continua no editor');
  await f.detail.act('agents:instructions-diff', 'a1');
  page = f.view('#agents/a1/instructions');
  assert.match(page, /<th scope="col">Versão salva \(v9\)<\/th><th scope="col">Sua versão<\/th>/);
  assert.match(page, /<tr data-diff="same">[^]*?Linha A[^]*?<tr data-diff="change">[^]*?Linha nova deles[^]*?Linha minha[^]*?<tr data-diff="add">[^]*?Extra/);
  await f.detail.act('agents:instructions-keep', 'a1');
  await f.detail.submit(f.form('agents:instructions', { instructions: 'Linha A\nLinha minha\nExtra' }));
  assert.equal(f.calls.at(-1).body.version, 9, '"Manter a minha" salva sobre a versão atual do servidor');
  assert.match(f.view('#agents/a1/instructions'), /Salvo · v10/);
  attempt = 0;
  await f.detail.submit(f.form('agents:instructions', { instructions: 'Outra' }));
  await f.detail.act('agents:instructions-take', 'a1');
  assert.match(f.view('#agents/a1/instructions'), />Linha A\nLinha nova deles<\/textarea>[\s\S]*Salvo · v9/, '"Descartar a minha" adota a versão salva');
});

test('guarda de saída: só com texto não salvo e com o editor na tela; descartar e sair limpa o rascunho', async () => {
  const f = fixture(), previous = globalThis.document;
  f.view('#agents/a1/instructions');
  await f.detail.act('agents:instructions-template', 'a1', { dataset: { value: 'support' } });
  f.detail.view(parseHash('#agents/a1/instructions'));
  try {
    globalThis.document = { querySelector: selector => selector.startsWith('form[data-form="agents:instructions"]') ? { isConnected: true } : null };
    assert.equal(f.detail.dirty(), true);
    globalThis.document = { querySelector: () => null };
    assert.equal(f.detail.dirty(), false, 'fora da tela (voltar do navegador) nada é bloqueado');
  } finally { globalThis.document = previous; }
  await f.detail.act('agents:instructions-discard', 'a1');
  assert.match(f.view('#agents/a1/instructions'), /Salvo · v7/);
});

test('ferramentas: política segmentada salva com CAS; internas automáticas ou com aprovação; externas sempre com aprovação', async () => {
  const f = fixture({ responses: { 'PATCH /api/tenants/t1/agents/a1': { toolPolicy: 'approve_all', version: 8 } } });
  let page = f.view('#agents/a1/tools');
  assert.match(page, /role="radiogroup" aria-label="Política de ferramentas"/);
  assert.match(page, /value="auto_readonly" checked\/><span class="ui-seg__label">Consultas automáticas \(somente leitura, até 3 por rascunho\)<\/span>/);
  assert.match(page, /<code class="pg-agents__code">elozi_contact_profile<\/code>[\s\S]*?Automática · até 3 por rascunho/);
  assert.match(page, /<code class="pg-agents__code">elozi_channel_status<\/code>[\s\S]*?Não concedida/);
  assert.match(page, /<code class="pg-agents__code">lookup_order<\/code><p class="pg-agents__muted">ERP &lt;Loja&gt; · servidor MCP externo<\/p><\/div><span class="ui-badge ui-badge--warning">Sempre requer aprovação<\/span>/);
  assert.match(page, /data-agents-policy-save=""/); assert.match(page, /data-action="agents:tool-grants" data-id="a1"/);
  await f.detail.submit(f.form('agents:tool-policy', { toolPolicy: 'approve_all' }));
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t1/agents/a1', method: 'PATCH', body: { version: 7, toolPolicy: 'approve_all' } });
  page = f.view('#agents/a1/tools');
  assert.match(page, /<code class="pg-agents__code">elozi_contact_profile<\/code>[\s\S]*?<span class="ui-badge ui-badge--neutral">Com aprovação<\/span>/);
  assert.match(page, /lookup_order[\s\S]*?Sempre requer aprovação/, 'a política nunca torna automática uma ferramenta externa');
  await f.detail.act('agents:tool-grants', 'a1'); await f.detail.act('agents:knowledge-grants', 'a1');
  assert.deepEqual(f.grants, [['tools', 'a1'], ['knowledge', 'a1']], 'diálogos de concessão de hoje (mcp-ui e knowledge-ui)');
  const bare = fixture({ agent: { mcpGrants: undefined } }).view('#agents/a1/tools');
  for (const tool of ['elozi_knowledge_search', 'elozi_contact_profile', 'elozi_conversation_history', 'elozi_channel_status', 'elozi_attendance_status']) assert.match(bare, new RegExp(`<code class="pg-agents__code">${tool}</code>[^]*?Não concedida`), `${tool} sem concessão`);
  assert.doesNotMatch(bare, /Automática · até 3 por rascunho|Com aprovação/, 'copiloto recém-criado não tem ferramentas');
  const operator = fixture({ role: 'operator' }).view('#agents/a1/tools');
  assert.match(operator, /type="radio" name="toolPolicy" value="auto_readonly" checked disabled/); assert.doesNotMatch(operator, /data-agents-policy-save|agents:tool-grants/);
});

test('testar: oculto sem a função agent-preview; com ela, gera o rascunho com o texto do editor sem gravar', async () => {
  const without = fixture().view('#agents/a1/instructions');
  assert.doesNotMatch(without, /data-form="agents:preview"/); assert.match(without, /Teste sem gravar: em breve\./);
  const f = fixture({ features: ['agent-preview'], responses: { 'POST /api/tenants/t1/agents/a1/preview': { draft: 'Oi Maria!', toolSteps: [{}], references: [], tokens: { input: 1000, output: 240 }, latencyMs: 3200 } } });
  assert.match(f.view('#agents/a1/instructions'), /data-form="agents:preview" data-id="a1"[\s\S]*<option value="conv1">Maria<\/option>[\s\S]*Gerar rascunho de teste/);
  await f.detail.submit(f.form('agents:preview', { conversationId: 'conv1' }));
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t1/agents/a1/preview', method: 'POST', body: { conversationId: 'conv1', conversationVersion: 5, instructions: 'Linha A\nLinha B' } });
  assert.match(f.view('#agents/a1/instructions'), /<blockquote class="pg-agents__draft">Oi Maria!<\/blockquote>[\s\S]*1.240 tokens · 3,2 s · não gravado/);
  const quiet = fixture({ features: ['agent-preview'], responses: { 'POST /api/tenants/t1/agents/a1/preview': { draft: 'Oi!', toolSteps: [], wouldPropose: [{ serverName: 'ERP', toolName: 'lookup_order', title: 'Consultar pedido', external: true }], references: [], tokens: null, latencyMs: 1500 } } });
  quiet.view('#agents/a1/instructions');
  await quiet.detail.submit(quiet.form('agents:preview', { conversationId: 'conv1' }));
  const page = quiet.view('#agents/a1/instructions');
  assert.match(page, /tokens não informados pelo provedor · 1,5 s · não gravado/); assert.doesNotMatch(page, /0 tokens/, 'uso não informado nunca vira zero');
  assert.match(page, /Pediria a ferramenta ERP › Consultar pedido <span class="ui-badge ui-badge--warning">Sempre requer aprovação<\/span>/);
  assert.match(page, /Na prévia nenhuma ferramenta é executada/);
});

test('instruções: seção perto do limite não corta o texto; "Desfazer modelo" devolve o texto substituído', async () => {
  const long = 'x'.repeat(3984) + 'FIM';
  const f = fixture({ agent: { instructions: long } });
  f.view('#agents/a1/instructions');
  await assert.rejects(f.detail.act('agents:instructions-section', 'a1', { dataset: { value: 'rules' } }), /Não há espaço para a seção/);
  assert.match(f.view('#agents/a1/instructions'), /xFIM<\/textarea>/, 'nada do que a pessoa escreveu é cortado');
  assert.match(f.view('#agents/a1/instructions'), /data-action="agents:instructions-undo"[^>]*hidden/, 'sem modelo aplicado, sem desfazer');
  const g = fixture();
  g.view('#agents/a1/instructions');
  await g.detail.act('agents:instructions-template', 'a1', { dataset: { value: 'support' } });
  let page = g.view('#agents/a1/instructions');
  assert.match(page, /data-action="agents:instructions-undo" data-id="a1" data-agents-undo=""><span class="ui-btn__label">Desfazer modelo<\/span>/, 'botão visível enquanto há texto para recuperar');
  await g.detail.act('agents:instructions-undo', 'a1');
  page = g.view('#agents/a1/instructions');
  assert.match(page, />Linha A\nLinha B<\/textarea>/); assert.match(page, /Salvo · v7/);
});

test('versão única do agente: salvar a política com instruções não salvas não gera conflito consigo mesma', async () => {
  const f = fixture({ responses: { 'PATCH /api/tenants/t1/agents/a1': ({ body }) => body.toolPolicy ? { toolPolicy: body.toolPolicy, version: 8 } : body.version === 8 ? { instructions: body.instructions, version: 9 } : conflict('Versão antiga.') } });
  f.view('#agents/a1/instructions');
  await f.detail.act('agents:instructions-template', 'a1', { dataset: { value: 'sales' } });
  await f.detail.submit(f.form('agents:tool-policy', { toolPolicy: 'approve_all' }));
  assert.deepEqual(f.calls.at(-1).body, { version: 7, toolPolicy: 'approve_all' });
  await f.detail.submit(f.form('agents:instructions', { instructions: 'Minha versão' }));
  assert.equal(f.calls.at(-1).body.version, 8, 'o editor acompanha a versão salva pela política');
  assert.match(f.view('#agents/a1/instructions'), /Salvo · v9/); assert.doesNotMatch(f.view('#agents/a1/instructions'), /Alguém salvou antes de você/);
});

test('piloto automático: canais com opt-in, aviso do WhatsApp por QR, validação local e PATCH com a versão', async () => {
  const f = fixture({ features: ['agent-autopilot'], responses: { 'PATCH /api/tenants/t1/agents/a1': ({ body }) => ({ autopilot: body.autopilot, version: 8 }) } });
  let page = f.view('#agents/a1/access');
  assert.match(page, /<form class="pg-agents__card pg-agents__autopilot" id="agent-autopilot" data-form="agents:autopilot" data-id="a1" data-state="yes">/);
  assert.match(page, /<input type="checkbox" role="switch" name="enabled"\/>/);
  assert.match(page, /name="channelIds" value="wa"\/><span>WhatsApp Vendas <span class="pg-agents__muted">WhatsApp · QR Code<\/span> <span class="ui-badge ui-badge--warning">Protocolo não oficial<\/span>/);
  assert.match(page, /WhatsApp por QR usa um protocolo não oficial\.[\s\S]*risco de bloqueio do número/);
  assert.match(page, /name="maxRepliesPerHour" min="1" max="30"[^>]*value="6"/); assert.match(page, /name="requireKnowledge" checked/);
  assert.match(page, /<option value="d1">Suporte<\/option>/); assert.doesNotMatch(page, /value="d2"/, 'departamento inativo fora da transferência');
  await f.detail.submit(f.form('agents:autopilot', { enabled: 'on', channelIds: [], maxRepliesPerHour: '6' }));
  assert.equal(f.calls.length, 0, 'ativar sem canal nunca chega ao servidor');
  await f.detail.submit(f.form('agents:autopilot', { enabled: 'on', channelIds: ['site', 'wa', 'outro'], maxRepliesPerHour: '4', requireKnowledge: 'on', quiet: 'on', quietStart: '22:00', quietEnd: '07:00', quietTimezone: 'America/Sao_Paulo', handoffDepartmentId: 'd1' }));
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t1/agents/a1', method: 'PATCH', body: { version: 7, autopilot: { enabled: true, channelIds: ['site', 'wa'], maxRepliesPerHour: 4, requireKnowledge: true, quietHours: { timezone: 'America/Sao_Paulo', start: '22:00', end: '07:00' }, handoffDepartmentId: 'd1' } } });
  page = f.view('#agents/a1/access');
  assert.match(page, /data-state="yes"/); assert.match(page, /name="channelIds" value="wa" checked/);
  assert.deepEqual(autopilotOf(f.agent).channelIds, ['site', 'wa']);
  assert.match(f.view('#agents/a1'), /Ativo em 2 canal\(is\)\./);
});

test('piloto automático: sem sinal do servidor a seção já nasce somente leitura "em breve"; atendente só lê', async () => {
  const f = fixture();
  const page = f.view('#agents/a1/access');
  assert.match(page, /data-state="no"/); assert.match(page, /Piloto automático: em breve\.[\s\S]*somente leitura/);
  assert.match(page, /<input type="checkbox" role="switch" name="enabled" disabled\/>/);
  assert.match(page, /<fieldset class="pg-agents__fieldset" disabled>/); assert.doesNotMatch(page, /Salvar piloto automático/);
  await f.detail.submit(f.form('agents:autopilot', { enabled: 'on', channelIds: ['site'], maxRepliesPerHour: '6' }));
  assert.equal(f.calls.length, 0, 'somente leitura não envia');
  assert.match(fixture({ agent: { autopilot: { enabled: false, channelIds: [] } } }).view('#agents/a1/access'), /data-state="yes"/, 'agente que já traz o campo: o servidor aceita');
  const operator = fixture({ role: 'operator', features: ['agent-autopilot'] }).view('#agents/a1/access');
  assert.match(operator, /Somente a administração do workspace altera o piloto automático\./); assert.doesNotMatch(operator, /Salvar piloto automático/);
  assert.match(fixture({ features: ['agent-autopilot'], agent: { configured: false } }).view('#agents/a1/access'), /Configure o serviço do copiloto antes de ativar o piloto automático\./);
});

test('piloto automático: erro e 409 mantêm o rascunho; estado salvo aparece separado', async () => {
  let answer = rejected('Escolha canais desta empresa.');
  const f = fixture({ features: ['agent-autopilot'], responses: {
    'PATCH /api/tenants/t1/agents/a1': () => answer,
    'GET /api/tenants/t1': { agents: [{ id: 'a1', instructions: 'Linha A\nLinha B', version: 9, toolPolicy: 'auto_readonly', autopilot: { enabled: true, channelIds: ['site'], maxRepliesPerHour: 6 } }] } } });
  f.view('#agents/a1/access');
  await f.detail.submit(f.form('agents:autopilot', { channelIds: ['site'], maxRepliesPerHour: '9' }));
  let page = f.view('#agents/a1/access');
  assert.match(page, /data-agents-unsaved="">Alterações não salvas: o servidor ainda tem a configuração anterior\./, 'o rascunho nunca passa por salvo');
  assert.match(page, /name="maxRepliesPerHour"[^>]*value="9"/, 'o valor digitado continua no formulário');
  answer = conflict('O agente mudou.');
  await f.detail.submit(f.form('agents:autopilot', { channelIds: [], maxRepliesPerHour: '6' }));
  page = f.view('#agents/a1/access');
  assert.match(page, /data-agents-unsaved/); assert.match(page, /<input type="checkbox" role="switch" name="enabled"\/>/, '409 não descarta o switch editado');
  assert.match(page, /Estado salvo: piloto automático ativo/); assert.equal(f.agent.version, 9);
  await f.detail.act('agents:autopilot-discard', 'a1');
  assert.doesNotMatch(f.view('#agents/a1/access'), /data-agents-unsaved/);
  assert.match(f.view('#agents/a1/access'), /name="channelIds" value="site" checked/);
});

test('conhecimento: fontes autorizadas com revisão pendente e busca dos trechos que o agente receberia', async () => {
  const f = fixture({ responses: { 'POST /api/tenants/t1/knowledge/search': { state: 'matched', references: [{ title: 'Política de trocas', publicationVersion: 3, excerpt: 'Até 7 dias <b>' }] } } });
  let page = f.view('#agents/a1/knowledge');
  assert.match(page, /<strong>Política de trocas<\/strong><p class="pg-agents__muted">Publicação v3<\/p><\/div><span class="ui-badge ui-badge--success">Autorizada<\/span>/);
  assert.match(page, /<strong>Fonte removida<\/strong>[\s\S]*?Precisa de revisão/);
  assert.match(page, /data-action="agents:knowledge-grants" data-id="a1"[\s\S]*href="#agents\/knowledge"/);
  await f.detail.submit(f.form('agents:knowledge-search', { query: ' prazo de troca ' }));
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t1/knowledge/search', method: 'POST', body: { agentId: 'a1', query: 'prazo de troca' } });
  page = f.view('#agents/a1/knowledge');
  assert.match(page, /<li><strong>Política de trocas<\/strong> <span class="pg-agents__muted">Publicação v3<\/span><p>Até 7 dias &lt;b&gt;<\/p><\/li>/);
  assert.match(page, />prazo de troca<\/textarea>/);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('autonomia captura input/change antes do submit e preserva valores inválidos, opt-ins e horário após aba/render/remount/reset', async t => {
  const dom = resultDom(t), f = fixture({ features: ['agent-autopilot'] }), listeners = {};
  const form = f.form('agents:autopilot', { enabled: 'on', channelIds: ['site'], maxRepliesPerHour: '', requireKnowledge: 'on', quietStart: '21:20', quietEnd: '06:10', quietTimezone: 'UTC', handoffDepartmentId: 'd1' });
  const main = { addEventListener: (name, fn) => { listeners[name] = fn; }, querySelector: () => null };
  dom.show('a1', 'access'); f.view(globalThis.location.hash); f.detail.mount(main, parseHash(globalThis.location.hash));
  listeners.input({ target: { closest: () => form } });
  assert.equal(f.calls.length, 0, 'edição não emite PATCH');
  dom.show('a1', 'overview'); f.view(globalThis.location.hash); f.detail.reset();
  dom.show('a1', 'access'); f.view(globalThis.location.hash); f.detail.mount(main, parseHash(globalThis.location.hash));
  const page = f.view(globalThis.location.hash);
  assert.match(page, /data-agents-unsaved/); assert.match(page, /name="enabled" checked/);
  assert.match(page, /name="channelIds" value="site" checked/); assert.doesNotMatch(page, /name="channelIds" value="wa" checked/);
  assert.match(page, /name="maxRepliesPerHour"[^>]*value=""/); assert.match(page, /name="requireKnowledge" checked/);
  assert.match(page, /name="quietStart" value="21:20"/); assert.match(page, /name="quietEnd" value="06:10"/);
  form.values.maxRepliesPerHour = '9'; listeners.change({ target: { closest: () => form } });
  assert.match(f.view(globalThis.location.hash), /name="maxRepliesPerHour"[^>]*value="9"/);
  assert.equal(f.calls.length, 0);
  await f.detail.act('agents:autopilot-discard', 'a1');
  assert.doesNotMatch(f.view(globalThis.location.hash), /data-agents-unsaved/);
});

test('prévia bloqueia imediatamente, deduplica durante render/remount e libera retry após erro', async t => {
  const dom = resultDom(t), waiting = deferred(); let attempt = 0;
  const f = fixture({ features: ['agent-preview'], responses: { 'POST /api/tenants/t1/agents/a1/preview': () => ++attempt === 1 ? waiting.promise : { draft: 'retry ok' } } });
  const button = { disabled: false, setAttribute() {} }, attrs = {};
  const form = f.form('agents:preview', { conversationId: 'conv1' }, { querySelector: selector => selector === '[type="submit"]' ? button : null, setAttribute: (name, value) => { attrs[name] = value; } });
  dom.show('a1', 'instructions'); f.view(globalThis.location.hash);
  const first = f.detail.submit(form);
  assert.equal(button.disabled, true); assert.equal(attrs['aria-busy'], 'true');
  assert.match(f.view(globalThis.location.hash), /aria-busy="true"/);
  f.detail.mount(dom.main, parseHash(globalThis.location.hash));
  await f.detail.submit(form); assert.equal(f.calls.length, 1);
  waiting.resolve(Promise.reject(new Error('preview failed'))); await first;
  assert.equal(button.disabled, false); assert.equal(attrs['aria-busy'], 'false');
  assert.match(f.view(globalThis.location.hash), /preview failed/);
  await f.detail.submit(form); assert.equal(f.calls.length, 2); assert.match(f.view(globalThis.location.hash), /retry ok/);
});

test('autonomia reutiliza guarda de saída, cancelar mantém draft e descarte é explícito em PT/EN', async t => {
  const saved = Object.fromEntries(['document', 'location'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const events = {}, listeners = {}, f = fixture({ features: ['agent-autopilot'] });
  const form = f.form('agents:autopilot', { enabled: 'on', channelIds: ['site'], maxRepliesPerHour: '6', requireKnowledge: 'on' }, { isConnected: true });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener: (name, fn) => { events[name] = fn; }, querySelector: selector => selector.startsWith('form[data-form="agents:autopilot"]') ? form : null } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#agents/a1/access' } });
  f.view(globalThis.location.hash); f.detail.mount({ addEventListener: (name, fn) => { listeners[name] = fn; }, querySelector: () => null }, parseHash(globalThis.location.hash));
  listeners.change({ target: { closest: () => form } }); assert.equal(f.detail.dirty(), true);
  let prevented = false;
  const control = { getAttribute: () => '#agents/a1/instructions', closest: () => null };
  events.click({ target: { closest: () => control }, preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
  assert.equal(prevented, true); assert.match(f.view(globalThis.location.hash), /O piloto automático tem alterações que ainda não foram salvas/);
  setLocale('en', { persist: false, notify: false }); assert.match(f.view(globalThis.location.hash), /Autopilot has unsaved changes/);
  await f.detail.act('agents:leave-cancel', 'a1'); assert.equal(f.detail.dirty(), true);
  events.click({ target: { closest: () => control }, preventDefault() {}, stopImmediatePropagation() {} });
  await f.detail.act('agents:leave-discard', 'a1'); assert.equal(globalThis.location.hash, '#agents/a1/instructions');
  assert.equal(f.calls.length, 0); assert.doesNotMatch(f.view('#agents/a1/access'), /data-agents-unsaved/);
});

for (const boundary of ['reset', 'contexto']) test(`prévia: finally antigo não libera busy do novo dono após ${boundary}`, async t => {
  const dom = resultDom(t), old = deferred(), fresh = deferred(); let attempt = 0;
  const f = fixture({ features: ['agent-preview'], responses: { 'POST /api/tenants/t1/agents/a1/preview': () => ++attempt === 1 ? old.promise : fresh.promise } });
  const button = { disabled: false, setAttribute() {} }, form = f.form('agents:preview', { conversationId: 'conv1' }, { querySelector: () => button });
  dom.show('a1', 'instructions'); f.view(globalThis.location.hash); const a = f.detail.submit(form);
  if (boundary === 'reset') f.detail.reset(); else f.state.boot.session.userId = 'another-user';
  f.view(globalThis.location.hash); const b = f.detail.submit(form);
  assert.equal(f.calls.length, 2); old.resolve({ draft: 'old' }); await a;
  assert.equal(button.disabled, true); assert.match(f.view(globalThis.location.hash), /Preparando o rascunho/);
  fresh.resolve({ draft: 'fresh' }); await b; assert.equal(button.disabled, false);
});

function resultDom(t) {
  const saved = Object.fromEntries(['document', 'location'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const paints = [], screen = { agentId: 'a1', tab: 'knowledge' };
  const target = { replaceWith(node) { paints.push(node.html); }, set innerHTML(html) { paints.push(html); } };
  const doc = { addEventListener() {}, querySelector(selector) {
    if (!selector.includes('[data-agents-slot=')) return null;
    if (selector.startsWith('.pg-agents--detail') && (!selector.includes(`data-agent="${screen.agentId}"`) || !selector.includes(`#agent-detail-panel-${screen.tab}:`))) return null;
    return target;
  }, createElement() {
    let html = '';
    return { set innerHTML(value) { html = value; }, get innerHTML() { return html; }, content: { querySelector: () => ({ html }) } };
  } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#agents/a1/knowledge' } });
  t.after(() => { for (const [name, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return { paints, screen, main: { addEventListener() {}, querySelector: () => null }, show(agentId, tab) { Object.assign(screen, { agentId, tab }); globalThis.location.hash = `#agents/${agentId}/${tab}`; } };
}

const asyncResultCases = [
  { name: 'prévia', tab: 'instructions', form: 'agents:preview', values: { conversationId: 'conv1' }, endpoint: 'POST /api/tenants/t1/agents/a1/preview', answer: { draft: 'Resultado somente de A' } },
  { name: 'busca', tab: 'knowledge', form: 'agents:knowledge-search', values: { query: 'trocas' }, endpoint: 'POST /api/tenants/t1/knowledge/search', answer: { state: 'matched', references: [{ title: 'Resultado somente de A', excerpt: 'Trecho de A' }] } }
];

for (const kind of asyncResultCases) {
  test(`${kind.name}: retorno tardio não aparece no outro agente e fica disponível ao voltar`, async t => {
    const dom = resultDom(t), waiting = deferred(), f = fixture({ features: ['agent-preview'], responses: { [kind.endpoint]: () => waiting.promise } });
    f.state.tenant.agents.push({ ...f.agent, id: 'a2', name: 'Agente B' });
    dom.show('a1', kind.tab); f.view(globalThis.location.hash);
    const pending = f.detail.submit(f.form(kind.form, kind.values));
    dom.show('a2', kind.tab); f.view(globalThis.location.hash); dom.paints.length = 0;
    waiting.resolve(kind.answer); await pending;
    assert.deepEqual(dom.paints, [], 'resultado de A não altera o painel de B');
    assert.doesNotMatch(f.view(globalThis.location.hash), /Resultado somente de A/);
    dom.show('a1', kind.tab);
    assert.match(f.view(globalThis.location.hash), /Resultado somente de A/, 'resultado válido continua no cache de A');
  });

  test(`${kind.name}: retorno válido atualiza somente o painel visível`, async t => {
    const dom = resultDom(t), waiting = deferred(), f = fixture({ features: ['agent-preview'], responses: { [kind.endpoint]: () => waiting.promise } });
    dom.show('a1', kind.tab); f.view(globalThis.location.hash);
    const pending = f.detail.submit(f.form(kind.form, kind.values)); dom.paints.length = 0;
    waiting.resolve(kind.answer); await pending;
    assert.equal(dom.paints.length, 1); assert.match(dom.paints[0], /Resultado somente de A/);
  });

  for (const [boundary, change] of [
    ['aba', (f, dom) => { dom.show('a1', 'overview'); f.view(globalThis.location.hash); }],
    ['rota fora do detalhe', () => { globalThis.location.hash = '#agents'; }],
    ['painel substituído', (f, dom) => { dom.screen.agentId = 'a2'; }],
    ['workspace', f => { f.state.workspaceId = 'w2'; }],
    ['empresa', f => { f.state.tenant.id = 't2'; }],
    ['usuário', f => { f.state.boot.session.userId = 'u2'; }],
    ['perfil', f => { f.state.boot.session.role = 'operator'; }],
    ['suporte delegado', f => { f.state.supportGrantId = 'grant-other'; }],
    ['reset', f => { f.detail.reset(); }]
  ]) test(`${kind.name}: retorno tardio respeita mudança de ${boundary}`, async t => {
    const dom = resultDom(t), waiting = deferred(), f = fixture({ features: ['agent-preview'], responses: { [kind.endpoint]: () => waiting.promise } });
    dom.show('a1', kind.tab); f.view(globalThis.location.hash);
    const pending = f.detail.submit(f.form(kind.form, kind.values)); change(f, dom); dom.paints.length = 0;
    waiting.resolve(kind.answer); await pending;
    assert.deepEqual(dom.paints, []);
  });
}

test('identidades: carregamento tardio não repinta acesso de outro agente; resultado válido aparece ao voltar', async t => {
  const dom = resultDom(t), waiting = deferred(), principals = { summary: { loaded: false, loading: false, items: [] }, load: () => waiting.promise };
  const f = fixture({ principals }); f.state.tenant.agents.push({ id: 'm2', name: 'Outro conectado', provider: 'mcp' });
  dom.show('m1', 'access'); f.view(globalThis.location.hash); f.detail.mount(dom.main, parseHash(globalThis.location.hash));
  dom.show('m2', 'access'); f.view(globalThis.location.hash); dom.paints.length = 0;
  principals.summary = { loaded: true, loading: false, items: [{ name: 'Identidade somente de M1', agentId: 'm1', state: 'active', capabilities: ['conversation.read'], channelIds: null, usage: { requests: 0 } }] };
  waiting.resolve(); await waiting.promise; await Promise.resolve();
  assert.deepEqual(dom.paints, []);
  dom.show('m1', 'access'); assert.match(f.view(globalThis.location.hash), /Identidade somente de M1/);
});

test('identidades: carregamento válido atualiza acesso do mesmo agente', async t => {
  const dom = resultDom(t), waiting = deferred(), principals = { summary: { loaded: false, loading: false, items: [] }, load: () => waiting.promise }, f = fixture({ principals });
  dom.show('m1', 'access'); f.view(globalThis.location.hash); f.detail.mount(dom.main, parseHash(globalThis.location.hash));
  principals.summary = { loaded: true, loading: false, items: [] };
  waiting.resolve(); await waiting.promise; await Promise.resolve();
  assert.equal(dom.paints.length, 1); assert.match(dom.paints[0], /Nenhuma identidade de serviço/);
});

test('agente conectado e provedor em breve: instruções no cliente, identidades e ferramentas elozi_* pelas capacidades', () => {
  const principals = { summary: { loaded: true, loading: false, error: '', items: [{ id: 'p1', name: 'Chave <QA>', agentId: 'm1', state: 'active', capabilities: ['conversation.read', 'reply.submit'], channelIds: ['wa'], dailyRequests: 500, maxConcurrent: 2, expiresAt: '2026-12-31T00:00:00Z', usage: { requests: 34 } }] } };
  const f = fixture({ principals });
  assert.match(f.view('#agents/m1/instructions'), /ficam no seu próprio cliente/);
  const access = f.view('#agents/m1/access');
  assert.match(access, /<strong>Chave &lt;QA&gt;<\/strong><span class="ui-badge ui-badge--success">Ativo<\/span>/);
  assert.match(access, /34\/500 chamadas hoje · 2 simultâneas/); assert.match(access, /1 canal\(is\) autorizado\(s\)/);
  assert.deepEqual([...access.matchAll(/<li><code class="pg-agents__code">([a-z_]+)<\/code><\/li>/g)].map(match => match[1]), ['elozi_me', 'elozi_get_receipt', 'elozi_read_conversation', 'elozi_read_attachment', 'elozi_list_conversations', 'elozi_search_conversations', 'elozi_read_conversation_history', 'elozi_list_groups', 'elozi_read_group_history', 'elozi_submit_draft']);
  assert.match(fixture({ principals: { summary: { loaded: false, loading: true, items: [] } } }).view('#agents/m1/access'), /Carregando as identidades de serviço…/);
  assert.match(f.view('#agents/m1/usage'), /a plataforma não mede os tokens dele/);
  assert.match(f.view('#agents/x1'), /Codex · em breve[\s\S]*Em breve/); assert.match(f.view('#agents/x1/instructions'), /ainda não executa nesta versão/);
});

test('atendente: instruções em leitura, uso só para a administração, memória e atividade honestas', () => {
  const f = fixture({ role: 'operator' });
  const instructions = f.view('#agents/a1/instructions');
  assert.match(instructions, /<pre class="pg-agents__pre" tabindex="0">Linha A\nLinha B<\/pre>/); assert.doesNotMatch(instructions, /data-form="agents:instructions"/);
  assert.match(f.view('#agents/a1/usage'), /visível para a administração do workspace/);
  assert.match(f.view('#agents/a1/memory'), /Até 12 fatos ou 4 KiB por execução\./);
  assert.match(f.view('#agents/a1/activity'), /Nenhuma execução carregada/);
});

test('atividade do agente: usa a atividade completa quando existe, com piloto automático, desfecho e latência', () => {
  const items = [{ id: 'autopilot_1', agentId: 'a1', conversationId: 'conv1', initiatorKind: 'autopilot', actorName: 'Piloto automático Elozi', state: 'draft', outcome: 'used', latencyMs: 4100, startedAt: new Date().toISOString(), toolSteps: [] },
    { id: 'other', agentId: 'm1', conversationId: 'conv1', initiatorKind: 'user', state: 'draft', outcome: null, startedAt: new Date().toISOString() }];
  const state = { workspaceId: 'w1', boot: { features: ['agent-runs'], session: { role: 'reseller' } }, tenant: { id: 't1', conversations: [{ id: 'conv1', contact: 'Maria' }], runs: [], agents: [{ id: 'a1', name: 'Assistente', provider: 'hermes', configured: true, version: 1 }] } };
  const detail = createAgentDetail({ state, context: () => ({ admin: true, owner: false, features: new Set(['agent-runs']), scope: 's' }), runsFeed: () => ({ items, error: null, note: 'Últimas execuções desta empresa.' }) });
  const page = detail.view(parseHash('#agents/a1/activity'));
  assert.match(page, /data-agents-slot="agent-activity"/); assert.match(page, /Últimas execuções desta empresa\./);
  assert.match(page, /<td>Piloto automático<\/td>/); assert.match(page, /<td class="pg-agents__num">4,1 s<\/td><td>Usado<\/td>/);
  assert.doesNotMatch(page, /agents-run-other/, 'só as execuções deste agente');
  assert.match(detail.view(parseHash('#agents/a1')), /data-agents-slot="agent-runs"[\s\S]*Piloto automático/, 'Visão geral com as últimas execuções da mesma fonte');
});

test('diferença por linha (LCS): iguais, removidas, adicionadas e trocadas lado a lado', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc\nd'), [{ type: 'same', left: 'a', right: 'a' }, { type: 'change', left: 'b', right: 'x' }, { type: 'same', left: 'c', right: 'c' }, { type: 'add', left: null, right: 'd' }]);
  assert.deepEqual(lineDiff('a\nb', 'b'), [{ type: 'del', left: 'a', right: null }, { type: 'same', left: 'b', right: 'b' }]);
  assert.deepEqual(lineDiff('', ''), [{ type: 'same', left: '', right: '' }]);
});
