import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createServicePrincipalsUI } from '../public/service-principals-ui.js';
import { labels, t, html, txt, markup, getLocale, setLocale, translateError } from '../public/i18n.js';
import { excerpt } from './helpers/app-source.js';
// The legacy agents page moved from app.js (anchor view-agents) to agents-hub-ui.js in P1 commit 1f (FRONTEND-V2 §8.1).
import { createAgentsHub } from '../public/agents-hub-ui.js';
import { agentJourneyTranslations } from '../public/locales-agent-journey.js';

const token = 'elozi_svc_' + 'A'.repeat(43);
const principal = (extra = {}) => ({ id: 'service-a', name: 'Hermes de suporte', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft'], channelIds: null, departmentIds: null, dailyRequests: 100, dailyBudgetMicros: 0, estimatedRequestMicros: 0, budgetEnabled: false, maxConcurrent: 1, active: true, state: 'active', revision: 3, keyRevision: 2, expiresAt: '2027-01-01T12:00:00Z', usage: { requests: 2, budgetMicros: 0 }, ...extra });

function fixture(t, intercept) {
  const oldFormData = globalThis.FormData, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  class FormDataFake {
    constructor(form) { this.values = form.fields; }
    getAll(name) { const value = this.values[name]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
    get(name) { return this.getAll(name)[0] ?? null; }
    has(name) { return this.getAll(name).length > 0; }
  }
  globalThis.FormData = FormDataFake;
  const clipboard = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(value) { clipboard.push(value); } } } });
  t.after(() => { globalThis.FormData = oldFormData; if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; });
  const context = { workspaceId: 'workspace-a', tenantId: 'tenant-a', userId: 'admin-a', authorityKey: 'session-a', isAdmin: true, publicOrigin: 'https://elozi.example.test', agents: [{ id: 'hermes', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true }, { id: 'mcp', name: 'Meu agente MCP', provider: 'mcp', mode: 'copilot', configured: true, state: 'awaiting_connection' }, { id: 'pending', name: 'Sem configuração', provider: 'hermes', mode: 'copilot', configured: false }], channels: [{ id: 'wa', name: 'WhatsApp' }, { id: 'tg', name: 'Telegram' }], departments: [{ id: 'support', name: 'Suporte', active: true }, { id: 'old', name: 'Desativado', active: false }] };
  const calls = [], messages = [], updates = [], opened = [], listeners = new Map();
  let rows = [principal()];
  const modal = { title: '', html: '', error: { textContent: '' }, input: null, closed: false,
    querySelector(selector) { return selector === '[data-service-secret]' ? this.input : selector === '.form-error' ? this.error : null; },
    addEventListener(event, fn) { listeners.set(event, fn); },
    close() { this.closed = true; listeners.get('close')?.(); }
  };
  const defaultResponse = (path, init) => {
    if (!init?.method) return path.endsWith('/receipts') ? { receipts: [] } : { principals: structuredClone(rows) };
    if (init.method === 'POST' && !path.endsWith('/rotate') && !path.endsWith('/revoke')) return { principal: principal(), token };
    if (path.endsWith('/rotate')) return { principal: principal({ revision: 4, keyRevision: 3 }), token };
    return { principal: principal({ revision: 4, state: path.endsWith('/revoke') ? 'revoked' : 'active' }) };
  };
  const ui = createServicePrincipalsUI({ getContext: () => context,
    request: async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, defaultResponse) : defaultResponse(path, init); },
    openModal(title, subtitle, html) { modal.title = title; modal.html = html; modal.error = { textContent: '' }; modal.closed = false; const secret = html.match(/data-service-secret value="([^"]+)"/); modal.input = secret ? { value: secret[1], attribute: secret[1], removeAttribute(name) { if (name === 'value') this.attribute = null; } } : null; opened.push({ title, subtitle, html }); },
    getModal: () => modal, toast: (message, failure) => messages.push({ message, failure }), onUpdate: () => updates.push(true), onError: message => messages.push({ message, failure: true })
  });
  function form(extra = {}) {
    const match = modal.html.match(/data-service-principal-token="([^"]+)"/);
    assert.ok(match, 'o formulário precisa ter sido aberto pelo módulo');
    const fields = { name: '  Agente Hermes  ', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft'], 'channelIds-all': 'all', 'departmentIds-all': 'all', dailyRequests: '100', dailyBudgetUSD: '0', estimatedRequestUSD: '0', maxConcurrent: '1', ttlHours: '168', active: 'yes', reviewAccess: 'yes', ...extra };
    const feedback = { textContent: '' }, button = { disabled: false };
    return { dataset: { servicePrincipalForm: 'editor', servicePrincipalToken: match[1] }, fields, feedback, button, querySelector: selector => selector === '.form-error' ? feedback : selector === '[type="submit"]' ? button : null };
  }
  return { ui, context, calls, messages, updates, opened, modal, clipboard, form, setRows: value => { rows = value; } };
}

test('lista administrativa escapa nomes e explica revisão humana, escopo, limites e orçamento estimado', async t => {
  const f = fixture(t); f.setRows([principal({ name: '<img onerror="bad()">', channelIds: ['wa'], departmentIds: ['support'], dailyBudgetMicros: 1000000, estimatedRequestMicros: 10000, budgetEnabled: true })]);
  await f.ui.load(); const html = f.ui.markup();
  assert.equal(f.calls[0].path, '/api/tenants/tenant-a/service-principals'); assert.equal(f.calls[0].init.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.ok(html.includes('&lt;img onerror=&quot;bad()&quot;&gt;')); assert.equal(html.includes('<img'), false);
  for (const value of ['Identidades de serviço', 'permissões começam desmarcadas', '1 canal', '1 departamento', '2/100 chamadas', 'por dia (UTC)', 'estimados', 'meia-noite UTC', 'Configuração 3 · chave 2', 'min-height:44px']) assert.ok(html.includes(value), value);
  assert.equal(html.includes(token), false); assert.equal(html.includes('reply.autonomous'), false);
});

test('primeiro agente MCP usa o assistente real sem criar adaptador, identidade ou chave pela navegação', async t => {
  const f = fixture(t);
  for (const agents of [[], [f.context.agents[0]], [{ id: 'pending-mcp', provider: 'mcp', configured: false }]]) {
    f.context.agents = agents;
    assert.match(f.ui.markup(), /<a class="button" href="#agents\/connect\/identity">Conectar meu agente via MCP<\/a>/);
    await f.ui.action('start-external');
    const guide = f.ui.markup(); assert.match(guide, /Abra o assistente de conexão para cadastrar seu agente MCP/);
    assert.match(guide, /href="#agents\/connect\/identity"/); assert.doesNotMatch(guide, /Em Copilotos, adicione|Volte a esta tela|Abrir Copilotos/);
    assert.equal(f.opened.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.modal.input, null);
  }
  f.context.agents = []; await f.ui.action('choose-objective', 'draft');
  assert.match(f.ui.markup(), /Escolha o objetivo e revise o acesso antes de criar a identidade e a chave/);
  assert.equal(f.calls.length, 0); assert.equal(f.messages.length, 0);
  f.context.authorityKey = 'new-authority'; assert.doesNotMatch(f.ui.markup(), /service-journey-preparation/);
});

test('agente MCP existente conserva revisão de acesso sem selecionar ações adicionais automaticamente', async t => {
  const f = fixture(t); assert.match(f.ui.markup(), /data-service-principal-action="start-external"/);
  await f.ui.action('start-external');
  assert.match(f.modal.html, /value="mcp" selected/); assert.match(f.modal.html, /name="capabilities" value="conversation\.read" checked/);
  for (const capability of ['reply.submit', 'reply.send', 'message.schedule', 'events.read', 'conversation.manage']) {
    const field = f.modal.html.match(new RegExp(`<input[^>]+value="${capability.replace('.', '\\.')}"[^>]*>`));
    assert.ok(field, capability); assert.equal(field[0].includes(' checked'), false, capability);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.modal.input, null);
});

test('acesso vigente e última chamada não anunciam consulta validada; ausência ou valor inválido permanecem desconhecidos em PT/EN', async ctx => {
  const originalLocale = getLocale(); ctx.after(() => setLocale(originalLocale, { persist: false, notify: false }));
  const f = fixture(ctx), when = '2026-10-08T12:30:00Z';
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    for (const [extra, expected] of [[{}, 'Última chamada indisponível nesta atualização.'], [{ lastSeenAt: undefined }, 'Última chamada indisponível nesta atualização.'], [{ lastSeenAt: 'invalid' }, 'Última chamada indisponível nesta atualização.'], [{ lastSeenAt: null }, 'Nenhuma chamada registrada nesta identidade.'], [{ lastSeenAt: when }, 'Última chamada autenticada: {when}']]) {
      f.setRows([principal(extra)]); await f.ui.load({ force: true }); const page = f.ui.markup(), call = page.match(/data-service-last-call>([\s\S]*?)<\/p>/)?.[1];
      assert.ok(page.includes(t('Acesso ativo'))); assert.ok(call);
      assert.ok(call.includes(t(expected, { when: new Date(when).toLocaleString(locale) })));
      assert.ok(call.includes(t('Uma chamada autenticada não comprova uma consulta validada.')));
      if (expected.includes('indisponível')) assert.ok(!call.includes(t('Nenhuma chamada registrada nesta identidade.')));
    }
  }
  assert.equal(f.calls.some(call => call.init.method), false);
});

test('jornada e guia explicam configuração do cliente, recibo e mídia autorizada em PT/EN sem alterar capacidades', async ctx => {
  const originalLocale = getLocale(); ctx.after(() => setLocale(originalLocale, { persist: false, notify: false }));
  const f = fixture(ctx); await f.ui.load();
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    for (const source of ['Você configura o cliente MCP no seu ambiente. Criar a identidade e a chave não instala nem conecta o cliente.', 'Fotos, vídeos, áudios e documentos chegam ao agente como metadados autorizados; visão e transcrição não estão disponíveis pelo MCP.']) {
      assert.ok(f.ui.markup().includes(t(source))); assert.ok(agentJourneyTranslations[source]);
      if (locale === 'en') assert.equal(t(source), agentJourneyTranslations[source]);
    }
    await f.ui.action('connection-guide', 'service-a');
    assert.ok(f.modal.html.includes(t('Use a mesma chave desta identidade no MCP e na API REST. No cliente MCP, descubra tools/list e confirme sua identidade com elozi_me. O GET /api/service/v1/me confere somente o acesso REST.')));
    assert.match(f.modal.html, /elozi_search_conversations/); assert.match(f.modal.html, /elozi_read_conversation_history/);
    assert.ok(f.modal.html.includes(t('Para validar a consulta, use elozi_search_conversations ou elozi_read_conversation_history na empresa autorizada e confira o recibo e o escopo retornados. A pesquisa usa o histórico registrado no painel.')));
    assert.equal(f.modal.input, null);
  }
  f.setRows([principal({ capabilities: ['company.read'] })]); await f.ui.load({ force: true }); await f.ui.action('connection-guide', 'service-a');
  assert.ok(f.modal.html.includes(t('Valide uma ferramenta de consulta do catálogo permitido e confira o recibo e o escopo retornados.')));
  assert.doesNotMatch(f.modal.html, /elozi_search_conversations|elozi_read_conversation_history/);
  assert.equal(f.calls.some(call => call.init.method), false);
});

test('operador não carrega identidades nem abre ações administrativas', async t => {
  const f = fixture(t); f.context.isAdmin = false; await f.ui.load(); assert.equal(f.ui.markup(), '');
  assert.equal(await f.ui.action('create'), true); assert.equal(f.calls.length, 0); assert.equal(f.opened.length, 0); assert.match(f.messages[0].message, /administrador/);
  assert.equal(await f.ui.action('unrelated'), false); assert.equal(await f.ui.submit({ dataset: {} }), false);
});

test('cadastro exige adaptador configurado e apresenta apenas capacidades implementadas', async t => {
  const f = fixture(t); f.context.agents.forEach(agent => { agent.configured = false; }); await f.ui.action('create'); assert.equal(f.opened.length, 0); assert.match(f.messages.at(-1).message, /Configure primeiro/);
  f.context.agents[0].configured = true; await f.ui.action('create');
  assert.ok(f.modal.html.includes('value="hermes"')); assert.equal(f.modal.html.includes('value="pending"'), false); assert.equal(f.modal.html.includes('value="old"'), false);
  assert.ok(f.modal.html.includes('value="unassigned"')); assert.ok(f.modal.html.includes('name="dailyBudgetUSD"')); assert.ok(f.modal.html.includes('name="estimatedRequestUSD"')); assert.ok(f.modal.html.includes('step="0.000001"')); assert.ok(f.modal.html.includes('sem consulta à fatura'));
  assert.equal(f.modal.html.includes('reply.autonomous'), false); assert.equal(f.calls.length, 0);
  for(const capability of ['reply.send','message.schedule']){
    const field=f.modal.html.match(new RegExp('<input[^>]+value="'+capability.replace('.','\\.')+'"[^>]*>'));
    assert.ok(field,'A ação de grupo deve ser selecionável');assert.equal(field[0].includes(' checked'),false,'Novos acessos não ganham publicação automática por padrão');
  }
  assert.match(f.modal.html,/sem revisão de cada mensagem/);
});

test('cadastro envia empresa fixada, escopo explícito e USD convertido para micros sem flags humanas', async t => {
  const f = fixture(t); await f.ui.action('create'); const form = f.form({ 'channelIds-all': undefined, channelIds: ['wa'], 'departmentIds-all': undefined, departmentIds: ['support'], dailyBudgetUSD: '2.50', estimatedRequestUSD: '0.012345', dailyRequests: '50', maxConcurrent: '2' });
  await f.ui.submit(form); const call = f.calls.find(value => value.init.method === 'POST');
  assert.equal(call.path, '/api/tenants/tenant-a/service-principals'); assert.equal(call.init.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.deepEqual(JSON.parse(call.init.body), { name: 'Agente Hermes', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft'], channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 50, dailyBudgetMicros: 2500000, estimatedRequestMicros: 12345, maxConcurrent: 2, ttlHours: 168, active: true });
  assert.equal(f.modal.title, 'Chave criada'); assert.equal(form.button.disabled, false); assert.equal(f.updates.length, 1); assert.equal(f.calls.at(-1).init.method, undefined);
});

test('chave aparece uma vez, só copia por ação explícita e fecha removendo valor e atributo DOM', async t => {
  let response; const f = fixture(t, (path, init, fallback) => { const result = fallback(path, init); if (init.method === 'POST') response = result; return result; });
  await f.ui.action('create'); await f.ui.submit(f.form()); assert.equal(response.token, ''); assert.equal(f.modal.input.value, token); assert.equal(f.clipboard.length, 0);
  assert.ok(f.modal.html.includes('GET /api/service/v1/me')); assert.ok(f.modal.html.includes('Bearer SUA_CHAVE')); assert.equal(f.ui.markup().includes(token), false);
  await f.ui.handleAction({ dataset: { servicePrincipalAction: 'copy-key' } }); assert.deepEqual(f.clipboard, [token]);
  const input = f.modal.input; f.modal.close(); assert.equal(input.value, ''); assert.equal(input.attribute, null);
  await f.ui.action('copy-key'); assert.equal(f.clipboard.length, 1); assert.match(f.messages.at(-1).message, /já deixou/);
});

test('API de clipboard indisponível conserva chave e oferece cópia manual', async t => {
  const f = fixture(t); await f.ui.action('create'); await f.ui.submit(f.form()); globalThis.navigator.clipboard = undefined;
  await f.ui.action('copy-key'); assert.match(f.modal.error.textContent, /copie manualmente/); assert.equal(f.modal.input.value, token);
});

test('chave de resposta atrasada após trocar empresa é descartada e não abre modal', async t => {
  let resolve; const f = fixture(t, (path, init, fallback) => init.method === 'POST' ? new Promise(done => { resolve = done; }) : fallback(path, init));
  await f.ui.action('create'); const waiting = f.ui.submit(f.form()); f.context.tenantId = 'tenant-b'; const result = { principal: principal(), token }; resolve(result); await waiting;
  assert.equal(result.token, ''); assert.equal(f.opened.length, 1); assert.equal(f.updates.length, 0); assert.equal(f.clipboard.length, 0); assert.equal(f.calls.length, 1);
});

test('resposta tardia de lista é descartada após troca de sessão ou novo load', async t => {
  const resolvers = []; const f = fixture(t, () => new Promise(done => resolvers.push(done)));
  const old = f.ui.load(); f.context.authorityKey = 'session-b'; const current = f.ui.load();
  resolvers[1]({ principals: [principal({ name: 'Atual' })] }); await current; resolvers[0]({ principals: [principal({ name: 'Antigo' })] }); await old;
  assert.ok(f.ui.markup().includes('Atual')); assert.equal(f.ui.markup().includes('Antigo'), false);
});

test('erro de lista é visível e atualização recupera a operação sem perder o contexto', async t => {
  let failing = true; const f = fixture(t, (path, init, fallback) => { if (failing) throw new Error('Consulta indisponível.'); return fallback(path, init); });
  await f.ui.load(); assert.ok(f.ui.markup().includes('Consulta indisponível.')); failing = false; await f.ui.action('refresh');
  assert.ok(f.ui.markup().includes('Hermes de suporte')); assert.equal(f.ui.markup().includes('Consulta indisponível.'), false); assert.equal(f.updates.length, 1);
});

test('cadastro bloqueia capacidades sem leitura e orçamento sem estimativa antes do POST', async t => {
  const f = fixture(t); await f.ui.action('create'); const form = f.form({ capabilities: ['reply.draft'] }); await f.ui.submit(form); assert.match(form.feedback.textContent, /Mantenha leitura/);
  form.fields.capabilities = ['conversation.read', 'reply.draft']; form.fields.dailyBudgetUSD = '2'; await f.ui.submit(form); assert.match(form.feedback.textContent, /estimativa/); assert.equal(f.calls.length, 0);
});

test('400 de configuração preserva todos os valores e permite corrigir o mesmo formulário', async t => {
  let failing = true; const f = fixture(t, (path, init, fallback) => { if (init.method === 'POST' && failing) throw Object.assign(new Error('Nome inválido.'), { status: 400 }); return fallback(path, init); });
  await f.ui.action('create'); const form = f.form(); await f.ui.submit(form); assert.equal(form.feedback.textContent, 'Nome inválido.'); assert.equal(form.fields.name, '  Agente Hermes  '); assert.equal(form.button.disabled, false);
  failing = false; form.fields.name = 'Nome corrigido'; await f.ui.submit(form); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 2); assert.equal(f.modal.title, 'Chave criada');
});

test('falha de transporte ou resposta sem chave não repete criação de resultado incerto', async t => {
  for (const malformed of [false, true]) {
    await t.test(malformed ? 'resposta sem chave válida' : 'transporte incerto', async child => {
      const f = fixture(child, (path, init, fallback) => { if (init.method === 'POST') { if (malformed) return { principal: principal(), token: 'invalid' }; throw new Error('Rede caiu.'); } return fallback(path, init); });
      await f.ui.action('create'); const form = f.form(); await f.ui.submit(form); assert.match(form.feedback.textContent, /Atualize a lista/); await f.ui.submit(form); assert.match(form.feedback.textContent, /Abra o editor/); assert.equal(f.calls.length, 1); assert.equal(f.modal.input, null);
    });
  }
});

test('duplo submit durante requisição não duplica identidade e bloqueia botão até confirmação', async t => {
  let resolve; const f = fixture(t, (path, init, fallback) => init.method === 'POST' ? new Promise(done => { resolve = done; }) : fallback(path, init));
  await f.ui.action('create'); const form = f.form(), waiting = f.ui.submit(form); assert.equal(form.button.disabled, true); await f.ui.submit(form); assert.equal(f.calls.length, 1);
  resolve({ principal: principal(), token }); await waiting; assert.equal(form.button.disabled, false); assert.equal(f.modal.title, 'Chave criada');
});

test('editar usa PATCH e revisão persistida sem retornar chave anterior', async t => {
  const f = fixture(t); await f.ui.load(); await f.ui.action('edit', 'service-a'); assert.equal(f.modal.title, 'Editar serviço');
  await f.ui.submit(f.form()); const call = f.calls.find(value => value.init.method === 'PATCH'); assert.equal(call.path, '/api/tenants/tenant-a/service-principals/service-a'); assert.equal(JSON.parse(call.init.body).revision, 3); assert.equal(f.modal.closed, true); assert.equal(f.modal.input, null); assert.match(f.messages.at(-1).message, /atualizado/);
});

test('trocar e revogar exigem confirmação da empresa atual e enviam só revisão CAS', async t => {
  const f = fixture(t); await f.ui.load(); await f.ui.action('rotate', 'service-a'); assert.equal(f.calls.length, 1); assert.match(f.messages.at(-1).message, /confirmação/);
  await f.ui.action('confirm-rotate', 'service-a'); assert.equal(f.calls.length, 1); assert.match(f.modal.html, /deixará de funcionar imediatamente/); await f.ui.action('rotate', 'service-a');
  const rotate = f.calls.find(value => value.path.endsWith('/rotate')); assert.equal(rotate.init.method, 'POST'); assert.deepEqual(JSON.parse(rotate.init.body), { revision: 3 }); assert.equal(f.modal.title, 'Chave criada');
  await f.ui.action('confirm-revoke', 'service-a'); assert.equal(f.modal.input, null); await f.ui.action('revoke', 'service-a');
  const revoke = f.calls.find(value => value.path.endsWith('/revoke')); assert.deepEqual(JSON.parse(revoke.init.body), { revision: 3 }); assert.equal(f.modal.closed, true); assert.equal(f.updates.length, 2);
});

test('resposta incompleta não anuncia alteração ou revogação e não permite repetição cega', async t => {
  const f = fixture(t, (path, init, fallback) => init.method ? {} : fallback(path, init));
  await f.ui.load(); await f.ui.action('edit', 'service-a'); const form = f.form(); await f.ui.submit(form); assert.match(form.feedback.textContent, /Atualize a lista/); assert.equal(f.modal.closed, false); await f.ui.submit(form); assert.match(form.feedback.textContent, /Abra o editor/);
  await f.ui.action('confirm-revoke', 'service-a'); await f.ui.action('revoke', 'service-a'); assert.match(f.modal.error.textContent, /não confirmou a revogação/); assert.equal(f.modal.closed, false); await f.ui.action('revoke', 'service-a');
  assert.equal(f.calls.filter(call => call.init.method).length, 2); assert.equal(f.messages.some(value => /atualizado|revogado/.test(value.message)), false);
});

test('rotação que responde com identidade diferente elimina token e não mostra chave', async t => {
  const returned = { principal: principal({ id: 'different' }), token }; const f = fixture(t, (path, init, fallback) => path.endsWith('/rotate') ? returned : fallback(path, init));
  await f.ui.load(); await f.ui.action('confirm-rotate', 'service-a'); await f.ui.action('rotate', 'service-a');
  assert.equal(returned.token, ''); assert.equal(f.modal.input, null); assert.match(f.modal.error.textContent, /não confirmou a nova chave/); assert.equal(f.updates.length, 0);
});

test('fechar modal, reset e trocar sessão invalidam formulário ou confirmação anteriores', async t => {
  const f = fixture(t); await f.ui.load(); await f.ui.action('create'); const closed = f.form(); f.modal.close(); await f.ui.submit(closed); assert.match(closed.feedback.textContent, /Abra o editor/);
  await f.ui.action('create'); const reset = f.form(); f.ui.reset(); await f.ui.submit(reset); assert.match(reset.feedback.textContent, /Abra o editor/);
  await f.ui.load(); await f.ui.action('confirm-revoke', 'service-a'); f.context.authorityKey = 'changed'; await f.ui.action('revoke', 'service-a'); assert.equal(f.calls.some(value => value.init.method), false);
  f.context.authorityKey = 'session-a'; await f.ui.action('create'); const stale = f.form(); f.context.userId = 'other'; await f.ui.submit(stale); assert.match(stale.feedback.textContent, /Abra o editor/);
});

test('reset elimina chave transitória do DOM e impede copiar depois', async t => {
  const f = fixture(t); await f.ui.action('create'); await f.ui.submit(f.form()); const input = f.modal.input; f.ui.reset();
  assert.equal(input.value, ''); assert.equal(input.attribute, null); await f.ui.action('copy-key'); assert.equal(f.clipboard.length, 0); assert.match(f.modal.error.textContent, /já deixou/); assert.equal(f.ui.markup().includes('Hermes de suporte'), false);
});

test('recibos mostram efeitos conhecidos com escape e sem expor payload ou resultado', async t => {
  const f = fixture(t, (path, init, fallback) => path.endsWith('/receipts') ? { receipts: [{ requestId: '<unsafe>', capability: 'reply.draft', state: 'confirmed', stale: true, createdAt: '2026-10-03T12:00:00Z', result: { token: 'do-not-render' }, context: { secret: 'do-not-render' } }] } : fallback(path, init));
  await f.ui.load(); await f.ui.action('receipts', 'service-a'); assert.equal(f.calls.at(-1).path, '/api/tenants/tenant-a/service-principals/service-a/receipts');
  assert.ok(f.modal.html.includes('&lt;unsafe&gt;')); assert.ok(f.modal.html.includes('acesso anterior')); assert.ok(f.modal.html.includes('não deve ser repetido automaticamente')); assert.equal(f.modal.html.includes('do-not-render'), false);
});

test('revogados mantêm recibos e expirados não oferecem troca de chave', async t => {
  const f = fixture(t); f.setRows([principal({ state: 'revoked' }), principal({ id: 'expired', state: 'expired' })]); await f.ui.load(); const html = f.ui.markup();
  assert.equal(html.includes('data-service-principal-action="confirm-rotate"'), false); assert.equal(html.includes('data-service-principal-action="edit" data-id="service-a"'), false); assert.ok(html.includes('Recibos preservados')); assert.ok(html.includes('data-service-principal-action="receipts" data-id="service-a"'));
});

test('segredos não são salvos em storage, console, URL nem exibidos em exemplos', async t => {
  const f = fixture(t); const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = { setItem() { assert.fail('credenciais não podem entrar no storage'); } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage }); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => { if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else delete globalThis.localStorage; if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession); else delete globalThis.sessionStorage; });
  await f.ui.action('create'); await f.ui.submit(f.form()); assert.equal(f.calls.some(value => value.path.includes(token) || value.init.body?.includes(token)), false); assert.equal(f.messages.some(value => value.message.includes(token)), false);
  const example = f.modal.html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1]; assert.equal(example.includes(token), false); assert.ok(example.includes('SUA_CHAVE'));
});

test('identidade MCP começa somente com leitura e aceita entrega de texto explicitamente revisada', async t => {
  const f = fixture(t); await f.ui.action('create', 'mcp');
  assert.match(f.modal.html, /value="mcp" selected/);
  assert.match(f.modal.html, /name="capabilities" value="conversation\.read" checked/);
  assert.doesNotMatch(f.modal.html, /name="capabilities" value="reply\.submit" checked/);
  assert.doesNotMatch(f.modal.html, /value="reply\.draft"/);
  assert.doesNotMatch(f.modal.html, /value="handoff\.request" checked/);
  await f.ui.submit(f.form({ agentId: 'mcp', capabilities: ['conversation.read', 'reply.submit'] }));
  assert.deepEqual(JSON.parse(f.calls.find(call => call.init.method === 'POST').init.body).capabilities, ['conversation.read', 'reply.submit']);
});

test('capacidades da empresa são opt-in e permitem identidade sem leitura de atendimentos', async t => {
  for (const capabilities of [['company.read'], ['company.read', 'company.propose']]) await t.test(capabilities.join('+'), async child => {
    const f = fixture(child); await f.ui.action('create', 'mcp');
    assert.match(f.modal.html, /value="company\.read"/); assert.match(f.modal.html, /value="company\.propose"/);
    assert.doesNotMatch(f.modal.html, /value="company\.(?:read|propose)" checked/);
    const form = f.form({ agentId: 'mcp', capabilities }); await f.ui.submit(form);
    const write = f.calls.find(call => call.init.method === 'POST'); assert.ok(write, 'somente escopo da empresa não exige conversation.read');
    assert.deepEqual(JSON.parse(write.init.body).capabilities, capabilities); assert.equal(form.feedback.textContent, '');
  });
});

test('propor operação exige leitura da empresa mesmo quando atendimentos estão autorizados', async t => {
  const f = fixture(t); await f.ui.action('create', 'mcp');
  for (const capabilities of [['company.propose'], ['conversation.read', 'reply.submit', 'company.propose']]) {
    const form = f.form({ agentId: 'mcp', capabilities }); await f.ui.submit(form);
    assert.ok(form.feedback.textContent, 'a dependência company.read precisa ser explicada');
  }
  assert.equal(f.calls.length, 0);
});

test('agente escolhido que deixou de estar habilitado não é substituído por outro adaptador', async t => {
  const f = fixture(t); await f.ui.action('create', 'gone-agent');
  assert.equal(f.opened.length, 0); assert.match(f.messages.at(-1).message, /não está mais habilitado/);
  f.setRows([principal({ agentId: 'gone-agent' })]); await f.ui.load(); await f.ui.action('edit', 'service-a');
  assert.equal(f.opened.length, 0); assert.match(f.messages.at(-1).message, /não está mais habilitado/);
  assert.equal(f.calls.some(call => call.init.method), false);
});

test('troca de agente atualiza capacidades iniciais sem conceder envio automático', async t => {
  const f = fixture(t); await f.ui.action('create'); const form = f.form(), fieldset = { innerHTML: '' };
  form.querySelector = selector => selector === '[data-service-capabilities]' ? fieldset : null;
  const target = { value: 'mcp', matches: selector => selector.includes('select[name="agentId"]'), closest: () => form };
  assert.equal(f.ui.handleChange({ target }), true);
  assert.match(fieldset.innerHTML, /value="conversation\.read" checked/); assert.doesNotMatch(fieldset.innerHTML, /value="reply\.submit" checked|reply\.draft|reply\.autonomous/);
  target.value = 'hermes'; f.ui.handleChange({ target }); assert.match(fieldset.innerHTML, /value="conversation\.read" checked/); assert.doesNotMatch(fieldset.innerHTML, /value="reply\.draft" checked|reply\.submit/);
  const before = fieldset.innerHTML; f.context.authorityKey = 'changed'; target.value = 'mcp'; f.ui.handleChange({ target }); assert.equal(fieldset.innerHTML, before);
  assert.equal(f.ui.handleChange({ target: { matches: () => false } }), false); assert.equal(f.calls.length, 0);
});

test('formulário recusa capacidades falsificadas ou incompatíveis com o agente antes de enviar', async t => {
  const f = fixture(t); await f.ui.action('create');
  for (const fields of [
    { agentId: 'hermes', capabilities: ['conversation.read', 'reply.submit'] },
    { agentId: 'mcp', capabilities: ['conversation.read', 'reply.draft'] },
    { agentId: 'mcp', capabilities: ['conversation.read', 'reply.autonomous'] },
    { agentId: 'pending', capabilities: ['conversation.read'] },
    { agentId: 'another-tenant-agent', capabilities: ['conversation.read'] }
  ]) {
    const form = f.form(fields); await f.ui.submit(form); assert.match(form.feedback.textContent, /capacidades disponíveis/);
  }
  f.context.agents.find(agent => agent.id === 'mcp').mode = 'automatic';
  const invalidMode = f.form({ agentId: 'mcp', capabilities: ['conversation.read', 'reply.submit'] }); await f.ui.submit(invalidMode);
  assert.match(invalidMode.feedback.textContent, /capacidades disponíveis/); assert.equal(f.calls.length, 0);
});

test('guia da identidade explica servidor candidato, mesma chave REST MCP e revogação sem revelar segredo', async t => {
  const f = fixture(t); f.setRows([principal({ name: '<script>agente</script>', agentId: 'mcp', capabilities: ['conversation.read', 'reply.submit'], token })]);
  await f.ui.load(); assert.match(f.ui.markup(), /data-service-principal-action="connection-guide"/);
  await f.ui.action('connection-guide', 'service-a');
  for (const value of ['https://elozi.example.test/api/agent/mcp', 'Servidor MCP do painel', 'primeira chamada', 'Claude Code, Codex, OpenClaw ou outro agente', 'mesma chave', 'elozi_submit_draft', 'revisão humana', 'Revogar ou trocar a chave', 'REST e MCP', 'Agentes › Ferramentas']) assert.ok(f.modal.html.includes(value), value);
  assert.ok(f.modal.html.includes('&lt;script&gt;agente&lt;/script&gt;')); assert.equal(f.modal.html.includes('<script>'), false);
  assert.doesNotMatch(f.modal.html.replace(/elozi_[a-z_]+|elozi\.example\.test/g, ''), /Hermes|Elozi/, 'nenhum motor ou marca da plataforma no guia de clientes');
  assert.equal(f.modal.html.includes(token), false); assert.equal(f.modal.input, null); assert.equal(f.calls.length, 1);
  await f.ui.action('confirm-revoke', 'service-a'); await f.ui.action('revoke', 'service-a');
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path.endsWith('/revoke')).init.body), { revision: 3 });
});

test('guia explica regras de envio privado e anexos em inglês junto às capacidades interpoladas', async t => {
  const previous = getLocale(); t.after(() => setLocale(previous)); setLocale('en');
  const f = fixture(t); await f.ui.load(); await f.ui.action('connection-guide', 'service-a');
  assert.match(f.modal.html, /Drafts are reviewed by the attendant/);
  assert.match(f.modal.html, /private conversations assigned to them/);
  assert.match(f.modal.html, /This query does not download or interpret media content/);
  assert.doesNotMatch(f.modal.html, /Rascunhos são revisados|Esta consulta não baixa/);
});

test('guia não fabrica endpoint HTTPS a partir de origem insegura ou URL com credencial', async t => {
  const f = fixture(t); await f.ui.load();
  for (const publicOrigin of ['http://127.0.0.1:49554', 'https://user:password@elozi.example.test', 'https://elozi.example.test/<img>', 'javascript:alert(1)', '']) {
    f.context.publicOrigin = publicOrigin; await f.ui.action('connection-guide', 'service-a');
    assert.match(f.modal.html, /origem HTTPS.*ainda não foi confirmada/); assert.equal(f.modal.html.includes(publicOrigin || 'no-invented-endpoint'), false);
    assert.equal(f.modal.html.includes('value="https://'), false); assert.equal(f.modal.html.includes('password@'), false);
  }
});

function agentsAppFixture() {
  const agents = [{ id: 'mcp-agent', name: '<Meu agente>', description: '<Função própria>', provider: 'mcp', mode: 'copilot', configured: true, state: 'awaiting_connection', model: 'do-not-infer-model' }, { id: 'hermes-agent', name: 'Hermes', provider: 'hermes', mode: 'copilot', configured: true }];
  const state = { boot: { session: { role: 'reseller' } }, tenant: { agents }, supportGrantId: null }, opened = [], calls = [];
  const globals = { state, labels, t, html, txt, markup, getLocale, translateError, escape: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    badge: (value, tone) => `<span class="badge ${tone}">${value}</span>`, icon: () => '<svg></svg>',
    formModal: (title, subtitle, type, html) => opened.push({ title, subtitle, type, html }), openModal: (title, subtitle, html) => opened.push({ title, subtitle, html }),
    $: () => ({ close() { calls.push('close'); } }), navigate: async view => calls.push(view), servicePrincipalsUI: { async action(action, id) { calls.push({ action, id }); } },
    api: async () => { assert.fail('Agente MCP não pode disparar probe ou configuração Hermes'); }, refresh: async () => {}, render: () => {}, toast: () => {} };
  // The legacy agent card and its connect-agent-mcp / agent-info actions left app.js in P10 (the
  // Central de Agentes of agents-hub-ui.js draws the agents); the actions below are still served.
  const real = runInNewContext([
    excerpt('provider-names'),
    excerpt('field-helpers'),
    'async function action(action,id){switch(action){', excerpt('act-new-agent'), excerpt('act-test-agent'), '}}',
    '({action})'
  ].join('\n'), globals);
  return { real, agents, state, opened, calls };
}

test('cadastro MCP mantém copiloto, sem probe nem credencial de runtime; Hermes e MCP não se misturam', async () => {
  const f = agentsAppFixture(); await f.real.action('new-agent');
  assert.match(f.opened[0].html, /value="mcp">Agente via MCP/); assert.match(f.opened[0].html, /name="mode" value="copilot"/); assert.match(f.opened[0].html, /name="description"/);
  assert.doesNotMatch(f.opened[0].html, /name="endpoint"|name="token"|name="model"|value="automatic"/);
  await assert.rejects(f.real.action('test-agent', 'mcp-agent'), /conexão MCP/);
  await assert.rejects(f.real.action('configure-agent', 'mcp-agent'), /Agentes conectados/);
  await f.real.action('configure-agent', 'hermes-agent');
  assert.equal(f.opened.at(-1).type, 'agent-config'); assert.match(f.opened.at(-1).html, /name="agentId" value="hermes-agent"/); assert.match(f.opened.at(-1).html, /type="password" name="token"/);
  assert.equal(f.calls.length, 0, 'nenhuma navegação nem identidade criada por estas ações');
});

test('shell e carregamento do assistente central exigem proprietário estrito e ficam fora do suporte delegado', () => {
  const f = agentsAppFixture(); f.state.tenant.id = 'tenant-a'; f.state.view = 'agents';
  const calls = [], root = {}, sandbox = { state: f.state, labels, t, html, txt, markup, getLocale, translateError, escape: value => String(value), icon: () => '', button: () => '', pageHeading: () => '',
    renderAgentAdminProposals: () => '', bindAgentAdminProposals: () => {},
    renderSupportAssistant: () => { calls.push('shell'); return '<section data-support-assistant-root>Assistente central</section>'; },
    bindSupportAssistant: options => calls.push(options), $: () => root, api: () => {}, toast: () => {}, refresh: () => {} };
  const hub = createAgentsHub({ state: f.state, escape: sandbox.escape, pageHeading: sandbox.pageHeading,
    renderAgentAdminProposals: (...args) => sandbox.renderAgentAdminProposals(...args), renderSupportAssistant: (...args) => sandbox.renderSupportAssistant(...args) });
  const view = () => hub.view({ section: 'agents', params: {}, query: {}, workspaceId: null, alias: null });
  const binding = excerpt('render-agent-bindings');
  for (const platformOwner of [undefined, false, 'true', 1]) {
    f.state.boot.session.platformOwner = platformOwner;
    assert.equal(view().includes('data-support-assistant-root'), false);
    runInNewContext(binding, sandbox); assert.equal(calls.length, 0);
  }
  f.state.boot.session.platformOwner = true; f.state.supportGrantId = 'delegated';
  assert.equal(view().includes('data-support-assistant-root'), false); runInNewContext(binding, sandbox); assert.equal(calls.length, 0);
  f.state.supportGrantId = null;
  assert.equal(view().includes('data-support-assistant-root'), true); runInNewContext(binding, sandbox);
  assert.equal(calls[0], 'shell'); assert.equal(calls[1].root, root); assert.equal(calls[1].tenantId, 'tenant-a'); assert.equal(calls[1].platformAdmin, true);
  f.state.view = 'channels'; runInNewContext(binding, sandbox); assert.equal(calls.length, 2);
});

function interactiveEditor(f, fields = {}) {
  const form = f.form(fields), review = { get checked() { return form.fields.reviewAccess !== undefined; }, set checked(value) { form.fields.reviewAccess = value ? 'yes' : undefined; } };
  const summary = { innerHTML: '' }, hint = { textContent: '' }, status = { textContent: '' };
  const fieldset = { value: '', get innerHTML() { return this.value; }, set innerHTML(value) { this.value = value; form.fields.capabilities = [...value.matchAll(/<input[^>]*name="capabilities"[^>]*value="([^"]+)"[^>]* checked/g)].map(match => match[1]); } };
  const oldQuery = form.querySelector;
  form.querySelector = selector => selector === 'input[name="reviewAccess"]' ? review : selector === '[name="agentId"]' ? { value: form.fields.agentId } : selector === '[data-service-capabilities]' ? fieldset : selector === '[data-service-review-summary]' ? summary : selector === '[data-service-objective-hint]' ? hint : selector === '[data-service-objective-status]' ? status : oldQuery(selector);
  form.querySelectorAll = selector => selector === 'input[name="capabilities"]:checked' ? form.fields.capabilities.map(value => ({ value })) : [];
  const change = (name, value) => {
    if (!['capabilities','reviewAccess'].includes(name)) form.fields[name] = value;
    return f.ui.handleChange({ target: { name, value, checked: value === true, closest: () => form, matches: selector => selector.includes('select[name="' + name + '"]') || selector.includes('input,') || (['capabilities','reviewAccess'].includes(name) && selector.includes('input[type="checkbox"]')) } });
  };
  return { form, review, summary, hint, status, fieldset, change };
}

test('criação e edição exigem confirmação explícita de revisão sem incluir objetivo ou confirmação no payload', async t => {
  const f = fixture(t); await f.ui.action('choose-objective', 'consult');
  const form = f.form({ capabilities: ['conversation.read'], reviewAccess: undefined });
  await f.ui.submit(form); assert.match(form.feedback.textContent, /Revise e confirme/); assert.equal(f.calls.length, 0);
  form.fields.reviewAccess = 'yes'; form.fields.objective = 'consult'; await f.ui.submit(form);
  const payload = JSON.parse(f.calls.find(call => call.init.method === 'POST').init.body);
  assert.equal('reviewAccess' in payload, false); assert.equal('objective' in payload, false);
  await f.ui.action('edit', 'service-a'); const edit = f.form({ reviewAccess: undefined }); await f.ui.submit(edit);
  assert.match(edit.feedback.textContent, /Revise e confirme/); assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
});

test('objetivo e adaptador preservam overrides compatíveis e exigem nova revisão sem novas permissões implícitas', async t => {
  const f = fixture(t); await f.ui.action('choose-objective', 'draft');
  const e = interactiveEditor(f, { capabilities: ['conversation.read','reply.draft','company.read','reply.send'], channelIds: ['wa'], 'channelIds-all': undefined });
  e.change('capabilities', true); assert.equal(e.review.checked, false);
  e.review.checked = true; e.change('agentId', 'mcp');
  assert.deepEqual(e.form.fields.capabilities, ['conversation.read','company.read','reply.send']);
  assert.equal(e.form.fields.capabilities.includes('reply.submit'), false); assert.equal(e.review.checked, false); assert.deepEqual(e.form.fields.channelIds, ['wa']);
  e.change('objective', 'management'); assert.deepEqual(e.form.fields.capabilities, ['conversation.read','company.read','reply.send']);
  assert.match(e.status.textContent, /Capacidades indisponíveis.*removidas/); assert.equal(f.calls.length, 0);
  f.modal.querySelector = selector => selector === '[data-service-principal-form="editor"]' ? e.form : null;
  await f.ui.action('apply-objective'); assert.deepEqual(e.form.fields.capabilities, ['company.read']);
  assert.deepEqual(e.form.fields.channelIds, ['wa']); assert.equal(e.review.checked, false); assert.equal(f.calls.length, 0);
});

test('objetivo rascunhos troca somente a capacidade suportada enquanto não há overrides', async t => {
  const f = fixture(t); await f.ui.action('choose-objective', 'draft');
  const e = interactiveEditor(f, { capabilities: ['conversation.read','reply.draft'] }); e.change('agentId', 'mcp');
  assert.deepEqual(e.form.fields.capabilities, ['conversation.read','reply.submit']);
  e.change('agentId', 'hermes'); assert.deepEqual(e.form.fields.capabilities, ['conversation.read','reply.draft']);
  e.change('objective', 'team'); assert.deepEqual(e.form.fields.capabilities, ['conversation.read','handoff.request']); assert.equal(f.calls.length, 0);
});

test('edição preserva ACL explícita, cotas e revisão CAS enquanto objetivo apenas orienta', async t => {
  const f = fixture(t); f.setRows([principal({ channelIds: ['wa'], departmentIds: ['support'], capabilities: ['conversation.read','reply.send'], dailyRequests: 35, maxConcurrent: 2 })]);
  await f.ui.load(); await f.ui.action('edit', 'service-a');
  assert.match(f.modal.html, /value="reply\.send" checked/); assert.match(f.modal.html, /name="channelIds" value="wa" checked/);
  assert.doesNotMatch(f.modal.html, /name="channelIds-all" value="all" checked|name="channelIds" value="tg" checked/);
  assert.match(f.modal.html, /name="dailyRequests"[^>]*value="35"/); assert.match(f.modal.html, /name="maxConcurrent"[^>]*value="2"/);
  const e = interactiveEditor(f, { capabilities: ['conversation.read','reply.send'], channelIds: ['wa'], 'channelIds-all': undefined, departmentIds: ['support'], 'departmentIds-all': undefined, dailyRequests: '35', maxConcurrent: '2' });
  e.change('objective', 'consult'); assert.deepEqual(e.form.fields.capabilities, ['conversation.read','reply.send']);
  await f.ui.submit(e.form); assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
  e.review.checked = true; await f.ui.submit(e.form);
  const payload = JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body);
  assert.deepEqual(payload.capabilities, ['conversation.read','reply.send']); assert.deepEqual(payload.channelIds, ['wa']); assert.deepEqual(payload.departmentIds, ['support']); assert.equal(payload.revision, 3); assert.equal(payload.dailyRequests, 35); assert.equal(payload.maxConcurrent, 2);
});

test('editar cota de atendente conserva eventos e gestão da identidade sem conceder ações novas', async t => {
  const grants = ['conversation.read','reply.send','events.read','conversation.manage'];
  const f = fixture(t); f.setRows([principal({ agentId: 'mcp', capabilities: grants, channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 40 })]);
  await f.ui.load(); await f.ui.action('edit', 'service-a');
  for (const capability of grants) assert.match(f.modal.html, new RegExp(`value="${capability.replace('.', '\\.')}" checked`), capability);
  assert.doesNotMatch(f.modal.html, /value="message\.schedule" checked|value="reply\.submit" checked/);
  const renderedGrants = [...f.modal.html.matchAll(/<input[^>]*name="capabilities"[^>]*value="([^"]+)"[^>]* checked/g)].map(match => match[1]);
  const e = interactiveEditor(f, { agentId: 'mcp', capabilities: renderedGrants, channelIds: ['wa'], 'channelIds-all': undefined, departmentIds: ['support'], 'departmentIds-all': undefined });
  e.change('dailyRequests', '45'); e.change('objective', 'consult');
  assert.deepEqual(new Set(e.form.fields.capabilities), new Set(grants)); assert.equal(e.review.checked, false);
  await f.ui.submit(e.form); assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
  e.review.checked = true; await f.ui.submit(e.form);
  const payload = JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body);
  assert.deepEqual(new Set(payload.capabilities), new Set(grants)); assert.deepEqual(payload.channelIds, ['wa']); assert.deepEqual(payload.departmentIds, ['support']);
  assert.equal(payload.dailyRequests, 45); assert.equal(payload.revision, 3);
});

test('eventos e gestão começam desmarcados e envio explica grupos e atendimento atribuído ao MCP', async t => {
  const f = fixture(t); await f.ui.action('create');
  for (const capability of ['events.read','conversation.manage','reply.send','message.schedule']) {
    const field = f.modal.html.match(new RegExp(`<input[^>]+value="${capability.replace('.', '\\.')}"[^>]*>`));
    assert.ok(field, capability); assert.equal(field[0].includes(' checked'), false, capability);
  }
  assert.match(f.modal.html, /Eventos e gestão do atendimento/);
  assert.match(f.modal.html, /conversas privadas atribuídas ao agente/);
  assert.match(f.modal.html, /Agendar publica somente nos grupos selecionados/);
  await f.ui.load(); await f.ui.action('connection-guide', 'service-a');
  assert.match(f.modal.html, /agentes via MCP podem responder nas conversas privadas atribuídas a eles/);
  assert.match(f.modal.html, /metadados de anexos/); assert.match(f.modal.html, /não baixa nem interpreta/);
});

// Production 26/10/2026: checking "digitando…" on the FullCommerce admin identity and saving removed contact.read
// (revision 2 → 3), because the editor neither drew nor sent the grant.
test('editar identidade MCP com telefone do contato e marcar "digitando…" salva as duas capacidades', async t => {
  const grants = ['contact.read','conversation.manage','conversation.read','events.read','reply.send'];
  const f = fixture(t); f.setRows([principal({ name: 'FullCommerce · admin WhatsApp', agentId: 'mcp', capabilities: grants, channelIds: ['wa'], revision: 2 })]);
  await f.ui.load(); await f.ui.action('edit', 'service-a');
  assert.match(f.modal.html, /name="capabilities" value="contact\.read" checked/);
  assert.match(f.modal.html, /Ler o telefone do contato \(WhatsApp\)/);
  assert.match(f.modal.html, /name="capabilities" value="presence\.typing"/); assert.doesNotMatch(f.modal.html, /value="presence\.typing" checked/);
  assert.doesNotMatch(f.modal.html, /data-service-preserved-capabilities/, 'um agente MCP em modo copiloto vê todas as suas concessões');
  const rendered = [...f.modal.html.matchAll(/<input[^>]*name="capabilities"[^>]*value="([^"]+)"[^>]* checked/g)].map(match => match[1]);
  assert.deepEqual(rendered.toSorted(), grants);
  const e = interactiveEditor(f, { agentId: 'mcp', capabilities: [...rendered, 'presence.typing'], channelIds: ['wa'], 'channelIds-all': undefined });
  e.change('capabilities', true); assert.equal(e.review.checked, false);
  e.review.checked = true; await f.ui.submit(e.form);
  assert.equal(e.form.feedback.textContent, '');
  const patch = f.calls.find(call => call.init.method === 'PATCH');
  assert.equal(patch.path, '/api/tenants/tenant-a/service-principals/service-a');
  const payload = JSON.parse(patch.init.body);
  assert.deepEqual(payload.capabilities.toSorted(), [...grants, 'presence.typing'].toSorted());
  assert.equal(payload.revision, 2); assert.deepEqual(payload.channelIds, ['wa']);
});

test('salvar devolve no PATCH as concessões que o editor não desenha e as lista como mantidas', async t => {
  const product = ['conversation.read','future.capability','notification.read','notification.send'];
  const f = fixture(t); f.setRows([principal({ agentId: 'mcp', capabilities: product, channelIds: ['wa'] }), principal({ id: 'service-b', agentId: 'hermes', capabilities: ['contact.read','conversation.read','reply.draft'] })]);
  await f.ui.load(); await f.ui.action('edit', 'service-a');
  assert.doesNotMatch(f.modal.html, /name="capabilities" value="(?:notification|future)\./);
  assert.match(f.modal.html, /data-service-preserved-capabilities>Mantidas sem alteração ao salvar \(não editáveis nesta tela\): future\.capability · notification\.read · notification\.send</);
  assert.match(f.modal.html, /data-service-review-summary><dl[^]*notification\.send/, 'a revisão mostra o que será salvo');
  const e = interactiveEditor(f, { agentId: 'mcp', capabilities: ['conversation.read'], channelIds: ['wa'], 'channelIds-all': undefined });
  e.change('dailyRequests', '45'); assert.match(e.summary.innerHTML, /notification\.read/);
  f.modal.querySelector = selector => selector === '[data-service-principal-form="editor"]' ? e.form : null;
  await f.ui.action('apply-objective'); assert.match(e.fieldset.innerHTML, /data-service-preserved-capabilities/, 'sugestões trocam somente as caixas');
  e.review.checked = true; await f.ui.submit(e.form);
  assert.equal(e.form.feedback.textContent, '', 'concessões mantidas não passam pela checagem das caixas');
  const payload = JSON.parse(f.calls.find(call => call.init.method === 'PATCH').init.body);
  assert.deepEqual(payload.capabilities.toSorted(), product); assert.equal(payload.dailyRequests, 45);
  // contact.read on a Hermes adapter stays hidden and is kept; switching to MCP shows it checked again.
  await f.ui.action('edit', 'service-b');
  assert.match(f.modal.html, /data-service-preserved-capabilities>[^<]*Ler o telefone do contato \(WhatsApp\)</); assert.doesNotMatch(f.modal.html, /value="contact\.read"/);
  const hermes = interactiveEditor(f, { capabilities: ['conversation.read','reply.draft'] });
  hermes.change('agentId', 'mcp');
  assert.match(hermes.fieldset.innerHTML, /value="contact\.read" checked/); assert.doesNotMatch(hermes.fieldset.innerHTML, /data-service-preserved-capabilities/);
  assert.deepEqual(hermes.form.fields.capabilities, ['conversation.read','contact.read']);
  assert.match(hermes.status.textContent, /Capacidades indisponíveis.*removidas/, 'reply.draft some de forma visível, nunca em silêncio');
  hermes.review.checked = true; await f.ui.submit(hermes.form);
  assert.deepEqual(JSON.parse(f.calls.filter(call => call.init.method === 'PATCH').at(-1).init.body).capabilities, ['conversation.read','contact.read']);
});

test('toda ação de atendimento exige leitura antes de criar ou alterar o acesso', async t => {
  for (const capability of ['reply.draft','reply.submit','handoff.request','reply.send','message.schedule','events.read','conversation.manage','presence.typing','contact.read']) await t.test(capability, async t => {
    const f = fixture(t); await f.ui.action('create');
    const invalid = f.form({ agentId: ['reply.submit','presence.typing','contact.read'].includes(capability) ? 'mcp' : 'hermes', capabilities: [capability] });
    await f.ui.submit(invalid); assert.match(invalid.feedback.textContent, /Mantenha leitura de atendimentos/);
    assert.equal(f.calls.some(call => call.init.method === 'POST' || call.init.method === 'PATCH'), false);
  });
});

test('alterar valores invalida revisão e atualiza resumo sem traduzir ou executar dados do cliente', async t => {
  const f = fixture(t); f.context.agents[0].name = '<img onerror="private()"> Consultar'; f.context.channels[0].name = 'Preparar respostas <cliente>';
  await f.ui.action('create'); const e = interactiveEditor(f, { 'channelIds-all': undefined, channelIds: ['wa'] });
  assert.equal(e.change('dailyRequests', '25'), true); assert.equal(e.review.checked, false);
  assert.match(e.summary.innerHTML, /25 chamadas por dia/); assert.match(e.summary.innerHTML, /&lt;img onerror=&quot;private\(\)&quot;&gt; Consultar/);
  assert.match(e.summary.innerHTML, /Preparar respostas &lt;cliente&gt;/); assert.doesNotMatch(e.summary.innerHTML, /<img/);
  e.review.checked = true; e.change('name', 'Nome privado'); assert.equal(e.review.checked, false);
  await f.ui.submit(e.form); assert.equal(f.calls.length, 0); assert.match(e.form.feedback.textContent, /Revise e confirme/);
});

test('summary oferece somente metadados atuais isolados e exclui chave, editor, payload e autoridade anterior', async t => {
  const f = fixture(t); f.setRows([principal({ token, payload: { private: 'hidden' }, usage: { requests: 3, budgetMicros: 5, private: 'hidden' }, channelIds: ['wa'] })]);
  assert.deepEqual(f.ui.summary, { loaded: false, loading: false, error: '', items: [] });
  await f.ui.load(); const snapshot = f.ui.summary;
  assert.equal(snapshot.loaded, true); assert.equal(snapshot.items[0].id, 'service-a'); assert.deepEqual(snapshot.items[0].usage, { requests: 3, budgetMicros: 5 });
  assert.deepEqual(snapshot.items[0].capabilities, ['conversation.read','reply.draft']); assert.equal(snapshot.items[0].lastSeenAt, null, 'sem lastSeenAt do servidor: null, nunca inventado');
  assert.doesNotMatch(JSON.stringify(snapshot), /elozi_svc_|payload|hidden|secret|editor/);
  snapshot.items[0].name = 'mutated'; snapshot.items[0].channelIds.push('tg'); snapshot.items[0].capabilities.push('reply.autonomous'); snapshot.items[0].usage.requests = 999;
  assert.equal(f.ui.summary.items[0].name, 'Hermes de suporte'); assert.deepEqual(f.ui.summary.items[0].channelIds, ['wa']); assert.equal(f.ui.summary.items[0].usage.requests, 3);
  await f.ui.action('create'); assert.equal(JSON.stringify(f.ui.summary).includes('servicePrincipalToken'), false);
  f.context.authorityKey = 'new-session'; assert.equal(f.ui.summary.loaded, false); assert.deepEqual(f.ui.summary.items, []);
  f.context.isAdmin = false; assert.deepEqual(f.ui.summary, { loaded: false, loading: false, error: '', items: [] });
});

test('summary descarta carregamento e erro de outra empresa e sanitiza falha remota', async t => {
  let resolve; const f = fixture(t, () => new Promise(done => { resolve = done; }));
  const waiting = f.ui.load(); assert.equal(f.ui.summary.loading, true); f.context.tenantId = 'tenant-b'; assert.equal(f.ui.summary.loading, false);
  resolve({ principals: [principal()] }); await waiting; assert.deepEqual(f.ui.summary.items, []);
  const failing = fixture(t, () => { throw new Error('private provider body elozi_svc_should_not_leave'); });
  await failing.ui.load(); assert.equal(failing.ui.summary.loaded, false); assert.equal(failing.ui.summary.error, 'Não foi possível consultar os serviços.');
  failing.context.tenantId = 'tenant-c'; assert.equal(failing.ui.summary.error, '');
});

test('webhook assinado: estado sem segredo nem caminho completo e ligar/desligar com a revisão atual', async t => {
  const f = fixture(t);
  f.setRows([principal({ capabilities: ['conversation.read', 'events.read'], webhook: { configured: true, enabled: false, url: 'https://produto.example.com/api/hook', revision: 2, lastStatus: null, failures: 0, pending: 0, secretFingerprint: 'e755d7fa7d8e' } }),
    principal({ id: 'service-b', capabilities: ['conversation.read', 'events.read'], webhook: { configured: false, enabled: false } })]);
  await f.ui.load(); const html = f.ui.markup();
  for (const value of ['Webhook assinado', 'Desligado', 'https://produto.example.com', 'Segredo e755d7fa7d8e', 'Ligar webhook', 'Webhook não configurado']) assert.ok(html.includes(value), value);
  assert.equal(html.includes('/api/hook'), false, 'only the origin is shown');
  await f.ui.action('webhook-toggle', 'service-a');
  const put = f.calls.find(call => call.init.method === 'PUT');
  assert.equal(put.path, '/api/tenants/tenant-a/service-principals/service-a/webhook'); assert.deepEqual(JSON.parse(put.init.body), { enabled: true, revision: 2 });
  assert.equal(put.init.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.ok(f.messages.some(message => /Webhook ligado/.test(message.message) && !message.failure));
  await f.ui.action('webhook-toggle', 'service-b');
  assert.ok(f.messages.some(message => message.failure && /não está configurado/.test(message.message)));
});
