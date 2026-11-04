import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../public/i18n.js';
import '../public/locales-operations.js';
import { createMcpUI } from '../public/mcp-ui.js';
// Stale drafts, regeneration and the run form moved to the agent rail in P1 commit 1f (FRONTEND-V2 §8.2);
// the AI usage panel stays in mcp-ui.js.
import { createAgentRail } from '../public/agent-rail-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const usageReport = extra => ({ days: 30, limit: 1000, limitVersion: 4, today: { runs: 2, promptTokens: 700, completionTokens: 300, totalTokens: 1000, remaining: 0, blocked: true },
  totals: { runs: 9, promptTokens: 4000, completionTokens: 1200, totalTokens: 5200 }, agents: [{ agentId: 'hermes-a', agentName: 'Hermes <A>', totalTokens: 5000 }, { agentId: 'gone', agentName: null, totalTokens: 200 }], ...extra });
function ui(t, { role = 'operator', responses = {} } = {}) {
  const calls = [], counters = { refresh: 0, render: 0, renderRuns: 0 }, modal = { closed: 0, close() { this.closed++; } }, sections = {};
  const previous = { FormData: globalThis.FormData, document: globalThis.document };
  globalThis.FormData = class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } getAll(name) { return [].concat(this.fields[name] ?? []); } has(name) { return Object.hasOwn(this.fields, name); } };
  globalThis.document = { querySelector: selector => selector === '#modal' ? modal : sections[selector] || null };
  t.after(() => { globalThis.FormData = previous.FormData; globalThis.document = previous.document; setLocale('pt-BR'); });
  const state = { workspaceId: 'w-a', boot: { session: { role, userId: 'person-a' } }, conversation: 'case-a', tenant: { id: 'tenant-a', name: 'Empresa A', runs: [],
    conversations: [{ id: 'case-a', version: 5, owner: 'human', assignedUserId: 'person-a', agentId: null, channelId: 'tg', departmentId: null, status: 'open',
      messages: [{ id: 'msg-1', kind: 'customer', text: 'Oi' }, { id: 'msg-2', kind: 'customer', text: 'Ainda aí?' }] }],
    agents: [{ id: 'hermes-a', name: 'Hermes A', provider: 'hermes', mode: 'copilot', configured: true }] } };
  const forms = [];
  const deps = { state, escape, icon: name => `<i data-icon="${name}"></i>`, badge: (value, tone) => `<span class="badge ${tone}">${escape(value)}</span>`,
    tenantApi: path => `/api/tenants/tenant-a/${path}`, api: async (path, options) => { calls.push({ path, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : undefined }); return responses[path] ?? {}; },
    canReplyTo: conversation => conversation?.assignedUserId === 'person-a' && conversation?.owner === 'human',
    formModal: (title, description, type, fields, submit) => forms.push({ title, description, type, fields, submit }),
    runNames: { draft: 'Rascunho pronto' }, refresh: async () => { counters.refresh++; }, render: () => { counters.render++; }, renderRuns: () => { counters.renderRuns++; }, toast() {}, navigate() {} };
  const mcp = createMcpUI(deps), rail = createAgentRail(deps);
  return { state, mcp, rail, calls, counters, forms, sections, conversation: state.tenant.conversations[0] };
}
const draft = extra => ({ id: 'run-a', state: 'draft', draft: 'Rascunho anterior.\nSegunda linha.', conversationId: 'case-a', conversationVersion: 4, agentId: 'hermes-a', agentName: 'Hermes A', actorName: 'Pessoa A', version: 3, stale: true, staleSince: '2026-10-06T12:00:00.000Z', ...extra });

test('rascunho anterior às novas mensagens mostra selo e ações em PT e EN', t => {
  const f = ui(t);
  // The stale card of the rail (P4, §5.2.3): warning badge, old text kept as typed, regenerate first.
  const pt = String(f.rail.runCard(draft(), f.conversation));
  assert.match(pt, /Rascunho anterior às novas mensagens/); assert.match(pt, /class="ui-badge ui-badge--warning"/); assert.match(pt, /<p class="ui-draft__text">Rascunho anterior\.\nSegunda linha\.<\/p>/);
  assert.match(pt, /data-action="rail:insert-draft" data-id="run-a">/); assert.match(pt, /data-action="rail:regenerate" data-id="run-a">/);
  assert.match(pt, />Usar mesmo assim</); assert.match(pt, />Gerar novamente com o novo contexto</); assert.match(pt, /O cliente enviou mensagens depois deste rascunho/);
  setLocale('en');
  const en = String(f.rail.runCard(draft(), f.conversation));
  assert.match(en, /Draft from before the newer messages/); assert.match(en, />Use anyway</); assert.match(en, />Generate again with the new context</); assert.match(en, /The customer sent messages after this draft/);
  setLocale('pt-BR');
  const old = String(f.rail.runCard(draft({ stale: undefined }), f.conversation));
  assert.match(old, /data-action="rail:insert-draft" disabled data-id="run-a"/, 'Sem o selo do servidor, versão diferente continua bloqueada.');
  f.state.tenant.runs = [{ id: 'busy', state: 'running', conversationId: 'case-a' }];
  assert.match(String(f.rail.runCard(draft(), f.conversation)), /data-action="rail:regenerate" disabled data-id="run-a"/);
  f.state.tenant.runs = [];
  const other = { ...f.conversation, assignedUserId: 'person-b' }, foreign = String(f.rail.runCard(draft(), other));
  assert.match(foreign, /data-action="rail:insert-draft" disabled data-id="run-a"/); assert.match(foreign, /data-action="rail:regenerate" disabled data-id="run-a"/);
  const unavailable = String(f.rail.runCard(draft({ memoryUnavailable: true }), f.conversation));
  assert.match(unavailable, /data-action="rail:insert-draft" disabled data-id="run-a"/); assert.match(unavailable, /O contexto mudou/);
});

test('gerar novamente pede novo rascunho com a versão atual e a última mensagem vista', async t => {
  const f = ui(t); f.state.tenant.runs = [draft()];
  await f.rail.act('mcp-regenerate', 'run-a');
  assert.deepEqual(f.calls, [{ path: '/api/tenants/tenant-a/conversations/case-a/run', method: 'POST', body: { version: 5, agentId: 'hermes-a', lastMessageId: 'msg-2' } }]);
  assert.deepEqual([f.counters.refresh, f.counters.render, f.counters.renderRuns], [1, 1, 1], 'O trilho mostra o pedido em andamento e a releitura desenha o novo estado.');
  f.state.tenant.runs = [draft(), { id: 'busy', state: 'tool_running', conversationId: 'case-a' }];
  await assert.rejects(f.rail.act('mcp-regenerate', 'run-a'), /execução ativa/);
  f.state.tenant.runs = [draft()]; f.conversation.assignedUserId = 'person-b';
  await assert.rejects(f.rail.act('mcp-regenerate', 'run-a'), /não corresponde ao contexto atual/);
  await assert.rejects(f.rail.act('mcp-regenerate', 'missing'), /não corresponde ao contexto atual/);
  assert.equal(f.calls.length, 1);
});

test('✦ do compositor gera sem orientação; a orientação vai só pela aba Agente, com as novas mensagens do cliente na tela', async t => {
  const f = ui(t);
  f.conversation.messages.push({ id: 'msg-3', kind: 'customer', text: 'Mais uma.' }); f.conversation.version = 6;
  // run-agent (app.js) → openRun: no "Acionar copiloto" dialog any more (§5.2.3, guidance has one place).
  assert.equal(await f.rail.openRun(f.conversation, f.state.tenant.agents[0]), true);
  assert.deepEqual(f.calls.at(-1).body, { version: 6, agentId: 'hermes-a', lastMessageId: 'msg-3' }); assert.deepEqual(f.forms, []);
  const form = { dataset: { form: 'rail:generate', conversationId: 'case-a' }, fields: { instruction: ' Confirme o pedido. ' }, reset() {} };
  assert.equal(await f.rail.submit(form), true);
  assert.deepEqual(f.calls.at(-1).body, { version: 6, agentId: 'hermes-a', lastMessageId: 'msg-3', instruction: 'Confirme o pedido.' });
  assert.equal(await f.rail.submit({ dataset: { dialogForm: 'mcp-run' }, fields: form.fields }), false, 'o formulário antigo não é mais do trilho');
  // A route that is no longer the person's refuses before any request (the server checks it again).
  f.conversation.assignedUserId = 'person-b';
  assert.equal(await f.rail.openRun(f.conversation, f.state.tenant.agents[0]), false); assert.equal(f.calls.length, 2);
});

test('painel de uso mostra consumo, limite e bloqueio; somente administrador define o limite', async t => {
  const operator = ui(t);
  const slot = { outerHTML: '<div id="ai-usage" hidden></div>' }; operator.sections['#ai-usage'] = slot;
  assert.equal(operator.mcp.usagePanel(), ''); await operator.mcp.mountUsage(); assert.equal(slot.outerHTML, ''); assert.equal(operator.calls.length, 0);
  await assert.rejects(operator.mcp.act('mcp-ai-limit'), /administrador/);
  const f = ui(t, { role: 'reseller', responses: { '/api/tenants/tenant-a/agents/usage?days=30': usageReport() } });
  assert.match(f.mcp.usagePanel(), /Carregando o consumo de IA/); assert.match(f.mcp.usagePanel(), /data-action="mcp-ai-limit" data-id="" disabled/);
  const section = { outerHTML: '' }; f.sections['#ai-usage'] = section;
  await f.mcp.mountUsage(); await f.mcp.mountUsage();
  assert.equal(f.calls.length, 1, 'Renderizações seguidas reaproveitam o consumo recente.');
  assert.match(section.outerHTML, /<strong>1.000<\/strong> tokens hoje · limite diário de 1.000 tokens/); assert.match(section.outerHTML, /<meter min="0" max="1000" value="1000"/);
  assert.match(section.outerHTML, /Limite diário atingido/); assert.match(section.outerHTML, /Últimos 30 dias: 5.200 tokens em 9 execuções\./);
  assert.match(section.outerHTML, /Hermes &lt;A&gt;/); assert.match(section.outerHTML, /Agente removido/);
  setLocale('en'); assert.match(f.mcp.usagePanel(), /tokens today · daily limit of 1,000 tokens/); assert.match(f.mcp.usagePanel(), /Daily limit reached/); setLocale('pt-BR');
  f.state.supportGrantId = 'grant'; assert.equal(f.mcp.usagePanel(), ''); delete f.state.supportGrantId;
  await f.mcp.act('mcp-ai-limit');
  assert.equal(f.forms.at(-1).type, 'mcp-ai-limit'); assert.match(f.forms.at(-1).fields, /name="limit"[^>]*value="1000"/);
  await assert.rejects(f.mcp.submit({ dataset: { dialogForm: 'mcp-ai-limit' }, fields: { limit: '1.5' } }), /número inteiro/);
  assert.equal(await f.mcp.submit({ dataset: { dialogForm: 'mcp-ai-limit' }, fields: { limit: ' ' } }), true);
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/tenant-a/agents/usage/limit', method: 'PUT', body: { version: 4, limit: null } });
  assert.match(f.mcp.usagePanel(), /Carregando o consumo de IA/, 'Depois de salvar, o consumo é consultado de novo.');
  await f.mcp.loadUsage(); await f.mcp.act('mcp-ai-limit');
  assert.equal(await f.mcp.submit({ dataset: { dialogForm: 'mcp-ai-limit' }, fields: { limit: '2500' } }), true);
  assert.deepEqual(f.calls.at(-1).body, { version: 4, limit: 2500 });
  const unlimited = ui(t, { role: 'reseller', responses: { '/api/tenants/tenant-a/agents/usage?days=30': usageReport({ limit: null, today: { runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, remaining: null, blocked: false } }) } });
  await unlimited.mcp.loadUsage(); const open = unlimited.mcp.usagePanel();
  assert.match(open, /sem limite diário/); assert.doesNotMatch(open, /<meter/); assert.doesNotMatch(open, /Limite diário atingido/);
});
