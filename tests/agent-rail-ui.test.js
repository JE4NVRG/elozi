// Agent rail of the conversation (FRONTEND-V2 §5.2.3, §8.5, P4): honest run states, inline receipts,
// approval without shortcut, stale draft, quota and busy by role, real phases, autopilot and motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setLocale } from '../public/i18n.js';
import { registerAction } from '../public/actions.js';
import { cssMetrics } from './helpers/css-metrics.js';
import { createAgentRail, classifyRun, runReceipts, tickRail, formatDuration, clockTime, elapsedText, expiryText, activeRunStates, decisionConfirmed, BUSY_RETRY_MS } from '../public/agent-rail-ui.js';

const publicDir = new URL('../public/', import.meta.url);
const read = file => readFileSync(new URL(file, publicDir), 'utf8');
const T0 = Date.parse('2026-10-06T14:00:00.000Z');
const iso = ms => new Date(T0 + ms).toISOString();
const text = markup => String(markup);

const external = { id: 'p-ext', serverId: 's-erp', serverName: 'ERP Acme', toolName: 'consultar_pedido', title: 'Consultar pedido', arguments: { pedido: '4471', cliente: 'Maria Souza' }, readOnly: false, expiresAt: iso(8 * 60_000) };
const internal = { id: 'p-int', serverId: 'elozi-internal', serverName: 'Elozi interna', toolName: 'elozi_contact_profile', title: 'Perfil do contato', arguments: {}, readOnly: true, expiresAt: iso(10 * 60_000) };
const step = (title, extra = {}) => ({ proposalId: `p-${title}`, toolName: `elozi_${title}`, title, autoApproved: true, isError: false, completedAt: iso(-2_000), ...extra });
const run = (id, extra = {}) => ({ id, conversationId: 'case-a', conversationVersion: 5, agentId: 'agent-a', agentName: 'Assistente Vendas', provider: 'hermes', version: 3, startedAt: iso(-4_000), updatedAt: iso(0), ...extra });

function fixture({ role = 'operator', platformOwner = false, supportGrantId = null, runs = [], conversation = {}, agents, responses = [], composer, loadRuns, extra = {} } = {}) {
  const calls = [], toasts = [], paints = [];
  let clock = T0;
  const conv = { id: 'case-a', version: 5, owner: 'human', assignedUserId: 'person-a', agentId: null, channelId: 'wa', departmentId: null, status: 'open', contact: 'Maria Souza',
    messages: [{ id: 'm1', kind: 'customer', text: 'Oi', createdAt: iso(-60_000) }], ...conversation };
  const state = { workspaceId: 'w-a', conversation: conv.id, supportGrantId, sendIntent: null, boot: { session: { role, userId: 'person-a', platformOwner, permissions: null } },
    tenant: { id: 'tenant-a', name: 'Loja Centro', conversations: [conv], runs,
      agents: agents ?? [{ id: 'agent-a', name: 'Assistente Vendas', provider: 'hermes', mode: 'copilot', configured: true, toolPolicy: 'auto_readonly', version: 2 }] } };
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(state) : next ?? {};
  };
  const rail = createAgentRail({ state, api, tenantApi: path => `/api/tenants/tenant-a/${path}`, canReplyTo: c => c?.assignedUserId === 'person-a' && c?.owner === 'human' && c?.status !== 'closed',
    renderRuns: () => paints.push(clock), toast: (message, error) => toasts.push({ message, error: Boolean(error) }), now: () => clock, composerBridge: composer, document: null, noListeners: true,
    refresh: async () => calls.push({ refresh: true }), render: () => {}, loadRuns,
    knowledgeReferences: item => item.knowledgeReferences?.length ? `<details class="knowledge-run-references"><summary>Fontes consultadas · ${item.knowledgeReferences.length}</summary></details>` : '',
    memoryReferences: item => item.memoryReferences?.length ? `<details class="memory-run-references"><summary>Memória revisada no contexto · ${item.memoryReferences.length}</summary></details>` : '', ...extra });
  return { state, conv, rail, calls, toasts, paints, advance: ms => { clock += ms; }, get now() { return clock; } };
}
const cardButton = id => ({ dataset: { id }, closest: selector => selector === '[data-rail-approval]' ? {} : null });
const quotaError = () => Object.assign(new Error('O limite diário de IA desta empresa foi atingido.'), { status: 429 });
const busyError = () => Object.assign(new Error('Limite de execuções simultâneas atingido.'), { status: 429 });

test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));

// ---------------------------------------------------------------------------------------------
// Fixture matrix: one row per presentation of §5.2.3

const MATRIX = [
  { name: 'queued', run: run('r', { state: 'queued' }), kind: 'running', has: ['data-state="running"', 'Assistente Vendas está preparando…', 'Na fila de preparação', 'data-action="rail:cancel"', 'data-rail-since=', 'class="pg-rail__dots" aria-hidden="true"'] },
  { name: 'running', run: run('r', { state: 'running' }), kind: 'running', has: ['Lendo a conversa', '4 s', 'tabindex="-1" data-rail-focus="run:r"'] },
  { name: 'running after lookups', run: run('r', { state: 'running', toolSteps: [step('Perfil do contato'), step('Histórico')] }), kind: 'running', has: ['Escrevendo o rascunho com o resultado das consultas', 'Consulta automática · Perfil do contato', 'Consulta automática · Histórico', 'class="pg-rail__lookups"'] },
  { name: 'automatic lookup running', run: run('r', { state: 'tool_running', toolProposal: { ...internal, autoApproved: true }, toolReceipt: { state: 'in_flight', autoApproved: true, approvedAt: iso(-1_000) }, toolSteps: [step('Histórico')] }), kind: 'lookup',
    has: ['data-state="lookup"', 'Consultando Perfil do contato (2/3)', 'data-action="rail:cancel"'], not: ['rail:approve', 'Aprovação necessária'] },
  { name: 'approved tool running', run: run('r', { state: 'tool_running', toolProposal: external, toolReceipt: { state: 'in_flight', approvedBy: 'Jean', approvedAt: iso(-1_000) } }), kind: 'tool',
    has: ['data-state="tool"', 'Executando ERP Acme › Consultar pedido…', `Aprovada por Jean · ${clockTime(iso(-1_000))}`], not: ['rail:cancel', 'Consulta automática'] },
  { name: 'waiting approval (external)', run: run('r', { state: 'waiting_approval', toolProposal: external }), kind: 'approval',
    has: ['class="ui-approval"', 'data-state="external"', 'Aprovação necessária', 'expira em 8 min', 'Assistente Vendas quer usar', '<strong>Consultar pedido</strong>', 'ERP Acme', 'Externo', 'Pode alterar dados? O servidor externo não declara.',
      'pedido = &quot;4471&quot; · cliente = &quot;Maria Souza&quot;', 'Ver argumentos', 'data-action="rail:reject"', 'data-action="rail:approve"', 'Aprovar e executar', 'Recusar', 'data-rail-expires=', '--rail-ratio:0.800'] },
  { name: 'waiting approval (internal under approve_all)', run: run('r', { state: 'waiting_approval', toolProposal: internal }), kind: 'approval', has: ['data-state="internal"', 'Interno', 'consulta somente leitura desta empresa'], not: ['Pode alterar dados', 'Externo'] },
  { name: 'forged waiting approval', run: run('r', { state: 'waiting_approval', toolProposal: { ...internal, autoApproved: true } }), kind: 'running', not: ['rail:approve', 'Aprovação necessária'] },
  { name: 'current draft', run: run('r', { state: 'draft', draft: 'Oi, Maria!\nO pedido sai amanhã.', knowledgeReferences: [{ title: 'Prazos' }] }), kind: 'draft',
    has: ['class="ui-draft"', 'data-state="current"', 'Rascunho pronto', 'Oi, Maria!\nO pedido sai amanhã.', 'data-action="rail:insert-draft" data-id="r"', '>Inserir<', 'data-action="rail:regenerate"', 'data-action="rail:discard"', 'Fontes consultadas · 1', 'Nada foi enviado ao cliente. Revise antes de enviar.', 'Rascunho pronto · ver'],
    not: ['<br>', 'use-run-draft', 'tokens'] },
  { name: 'stale draft (server flag)', run: run('r', { state: 'draft', draft: 'Texto antigo', stale: true, staleSince: iso(0), startedAt: iso(-120_000) }), kind: 'stale',
    conversation: { version: 7, messages: [{ id: 'm1', kind: 'customer', createdAt: iso(-180_000) }, { id: 'm2', kind: 'customer', createdAt: iso(-60_000) }, { id: 'm3', kind: 'customer', createdAt: iso(-30_000) }] },
    has: ['data-state="stale"', 'ui-badge--warning', 'Rascunho anterior às novas mensagens', 'Texto antigo', `Maria enviou 2 mensagens depois deste rascunho (${clockTime(iso(-30_000))})`, '>Usar mesmo assim<', '>Gerar novamente com o novo contexto<', 'O texto antigo continua aqui.'], not: ['Usar e editar', 'sr-only'] },
  { name: 'stale draft (version moved, no server flag)', run: run('r', { state: 'draft', draft: 'Texto antigo' }), kind: 'stale', conversation: { version: 6 },
    has: ['data-state="stale"', 'O contexto mudou. Prepare um novo rascunho ou assuma a conversa.'], disabled: ['rail:insert-draft'] },
  { name: 'draft with revoked knowledge', run: run('r', { state: 'draft', draft: 'Resposta', knowledgeUnavailable: true }), kind: 'draft', has: ['O contexto mudou. Prepare um novo rascunho ou assuma a conversa.'], disabled: ['rail:insert-draft'] },
  { name: 'draft hidden from this person', run: run('r', { state: 'draft', draft: null, memoryUnavailable: true }), kind: 'draft_unavailable', has: ['Este rascunho não está mais disponível para você.', 'data-action="rail:regenerate"'] },
  { name: 'unconfirmed external tool', run: run('r', { state: 'tool_unknown', toolProposal: external, reason: 'A ação terminou sem confirmação. Verifique no sistema de destino; não repita automaticamente.' }), kind: 'tool_unknown',
    has: ['Não confirmamos se a ação externa executou. Confira no sistema de destino antes de repetir.', 'data-rail-focus="run:r"'], not: ['rail:regenerate'] },
  { name: 'unconfirmed internal lookup', run: run('r', { state: 'tool_unknown', toolProposal: internal }), kind: 'lookup_failed', has: ['A consulta não terminou. Nada foi alterado.', 'data-action="rail:regenerate"'], not: ['Não confirmamos'] },
  { name: 'failed automatic lookup', run: run('r', { state: 'failed', toolProposal: internal, toolReceipt: { state: 'failed', autoApproved: true }, reason: 'A consulta automática não foi concluída. Prepare um novo rascunho.' }), kind: 'lookup_failed', has: ['A consulta não terminou. Nada foi alterado.', 'Gerar novamente'] },
  { name: 'busy (service_busy)', run: run('r', { state: 'failed', reason: 'O serviço de IA está ocupado agora. Tente novamente em instantes.' }), kind: 'busy',
    has: ['data-state="busy"', 'O assistente está atendendo outras execuções agora.', 'data-action="rail:retry"', 'data-rail-wait-until=', 'Disponível em 10 s', 'Não tentamos de novo sozinhos.'], disabled: ['rail:retry'] },
  { name: 'failed', run: run('r', { state: 'failed', reason: 'Execução interrompida ou tempo limite atingido.' }), kind: 'failed', has: ['Execução interrompida ou tempo limite atingido.', 'data-action="rail:regenerate"'] },
  { name: 'invalidated', run: run('r', { state: 'invalidated', reason: 'A conversa ou configuração mudou durante a execução.' }), kind: 'invalidated', has: ['A conversa ou configuração mudou durante a execução.', 'Gerar novamente'] },
  { name: 'cancelled', run: run('r', { state: 'cancelled', reason: 'Cancelado pelo atendente.' }), kind: 'cancelled', has: ['Cancelado pelo atendente.', 'Gerar novamente'] },
  { name: 'rejected', run: run('r', { state: 'rejected', toolProposal: external, toolReceipt: { state: 'rejected', rejectedBy: 'Ana', rejectedAt: iso(-5_000) }, reason: 'Ferramenta recusada pelo atendente.' }), kind: 'rejected',
    has: [`Recusada por Ana · ${clockTime(iso(-5_000))}`, 'A ferramenta foi recusada. O agente não usou essa consulta.', 'Gerar novamente'] }
];

for (const row of MATRIX) test(`matriz de estados: ${row.name}`, () => {
  const f = fixture({ runs: [row.run], conversation: row.conversation });
  assert.equal(classifyRun(row.run, f.conv), row.kind);
  const markup = text(f.rail.render(f.conv));
  assert.match(markup, /^<div class="pg-rail" data-rail-root data-conversation-id="case-a">/);
  for (const piece of row.has || []) assert.ok(markup.includes(piece), `${row.name}: falta ${piece}`);
  for (const piece of row.not || []) assert.ok(!markup.includes(piece), `${row.name}: não deveria ter ${piece}`);
  for (const action of row.disabled || []) assert.match(markup, new RegExp(`data-action="${action}"[^>]*disabled`), `${row.name}: ${action} desabilitado`);
  // The host redraws the rail on every poll: no live role inside it (transitions are announced outside, once).
  assert.doesNotMatch(markup, /role="(?:status|alert)"/, `${row.name}: sem papel vivo no trilho`);
  // A run in progress is never shown as a finished draft and the other way around.
  assert.equal(activeRunStates.has(row.run.state), ['running', 'lookup', 'tool', 'approval'].includes(row.kind) || row.name === 'forged waiting approval');
});

test('ordem do trilho: aprovação bloqueante > rascunho > status, e nada quando não há execução', () => {
  const f = fixture({ runs: [run('old', { state: 'draft', draft: 'Rascunho anterior' }), run('wait', { state: 'waiting_approval', toolProposal: external })] });
  const markup = text(f.rail.render(f.conv));
  assert.ok(markup.indexOf('class="ui-approval"') < markup.indexOf('class="ui-draft"'), 'aprovação antes do rascunho');
  const g = fixture({ runs: [run('d', { state: 'draft', draft: 'Pronto' }), run('now', { state: 'running' })] });
  const second = text(g.rail.render(g.conv));
  assert.ok(second.indexOf('class="ui-draft"') < second.indexOf('class="pg-rail__status"'), 'rascunho antes do status');
  assert.match(second, /data-action="rail:regenerate"[^>]*disabled/, 'sem novo pedido enquanto o agente trabalha');
  assert.equal(text(fixture().rail.render(fixture().conv)), '');
  // A failure newer than the draft is shown below it; an older one is not.
  const h = fixture({ runs: [run('f1', { state: 'failed', reason: 'Execução interrompida ou tempo limite atingido.' }), run('d2', { state: 'draft', draft: 'Novo' })] });
  assert.doesNotMatch(text(h.rail.render(h.conv)), /tempo limite/);
});

// ---------------------------------------------------------------------------------------------
// Acceptance §8.5

test('aceite: "Consulta automática" só aparece com autoApproved vindo do servidor, nunca inferido da política', () => {
  const policyOnly = run('r', { state: 'draft', draft: 'Texto', toolProposal: { ...internal }, toolReceipt: { state: 'completed', approvedBy: 'Pessoa A', approvedAt: iso(-3_000), completedAt: iso(-2_000) },
    toolSteps: [{ proposalId: 'p-int', toolName: 'elozi_contact_profile', title: 'Perfil do contato', isError: false, completedAt: iso(-2_000) }] });
  const f = fixture({ runs: [policyOnly] });
  const outputs = [text(f.rail.render(f.conv)), ...f.rail.timelineItems(f.conv).map(item => text(item.markup)), text(f.rail.contextTab(f.conv))].join('\n');
  assert.doesNotMatch(outputs, /consulta automática(?!s)/i, 'a política auto_readonly sozinha não rotula a consulta');
  assert.match(outputs, /Pessoa A aprovou Consultas internas › Perfil do contato/); assert.doesNotMatch(outputs, /Elozi/);
  const automatic = run('r2', { state: 'draft', draft: 'Texto', toolProposal: { ...internal, autoApproved: true }, toolReceipt: { state: 'completed', autoApproved: true, proposalId: 'p-Perfil do contato', approvedBy: 'Consulta automática', approvedAt: iso(-3_000), dispatchedAt: iso(-2_400), completedAt: iso(-2_000), result: { ok: true } },
    toolSteps: [step('Perfil do contato')] });
  const g = fixture({ runs: [automatic] });
  const receipts = g.rail.timelineItems(g.conv);
  assert.equal(receipts.length, 1);
  assert.match(text(receipts[0].markup), new RegExp(`Consulta automática · Perfil do contato · ${formatDuration(400).replace('.', '\\.')}`));
  assert.match(text(receipts[0].markup), /<details class="ui-receipt"[^>]*data-kind="auto"[\s\S]*>ver<\/span><\/summary><pre class="ui-receipt__result" tabindex="0">/);
  assert.doesNotMatch(text(receipts[0].markup), /aprovada por|Consulta automática aprov/i, 'o texto do servidor "Consulta automática" no approvedBy nunca vira "aprovada por"');
  // Without a duration from the server the receipt omits it instead of inventing one.
  assert.equal(runReceipts(run('r3', { toolSteps: [step('Histórico', { completedAt: iso(0) })] }))[0].label, 'Consulta automática · Histórico');
});

test('aceite: o cartão de aprovação não reage a nenhuma tecla além da ativação do botão focado', async () => {
  const source = read('agent-rail-ui.js');
  for (const forbidden of ['keydown', 'keyup', 'keypress', 'registerScope', 'accesskey', 'aria-keyshortcuts']) assert.ok(!source.includes(forbidden), `sem ${forbidden} no trilho`);
  const pending = run('r', { state: 'waiting_approval', toolProposal: external });
  const f = fixture({ runs: [pending], responses: [{}, { runs: [run('r', { state: 'tool_running', toolProposal: external, toolReceipt: { state: 'in_flight', approvedBy: 'Pessoa', approvedAt: iso(1_000) } })] }] });
  const card = text(f.rail.render(f.conv)).match(/<section class="ui-approval"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(card, /<kbd|accesskey|aria-keyshortcuts|data-kbd/);
  // A shortcut would dispatch the action without the focused card button: refused, nothing is sent.
  await assert.rejects(f.rail.act('rail:approve', 'r'), /botões do cartão de aprovação/);
  await assert.rejects(f.rail.act('rail:reject', 'r', { dataset: { id: 'r' }, closest: () => null }), /botões do cartão de aprovação/);
  await assert.rejects(f.rail.act('rail:approve', 'r', cardButton('other')), /botões do cartão de aprovação/);
  assert.equal(f.calls.length, 0);
  // Enter or Space on the focused button is a click: the decision goes with the run version and the proposal.
  assert.equal(await f.rail.act('rail:approve', 'r', cardButton('r')), true);
  assert.deepEqual(f.calls[0], { path: '/api/tenants/tenant-a/runs/r/tool/approve', method: 'POST', body: { version: 3, proposalId: 'p-ext' } });
  assert.equal(f.calls[1].path, '/api/tenants/tenant-a/conversations/case-a/runs');
  assert.equal(f.toasts.at(-1).message, 'Execução autorizada. O resultado será usado no rascunho.');
  // rail:focus-approval (Shift+A, bound by P2) only moves the focus: no request.
  assert.equal(await f.rail.act('rail:focus-approval'), false);
  assert.equal(f.calls.length, 2);
});

test('aceite: depois da decisão o cartão colapsa num recibo com nome e hora (rail e timeline)', async () => {
  const pending = run('r', { state: 'waiting_approval', toolProposal: external });
  const approved = run('r', { state: 'tool_running', toolProposal: external, version: 4, toolReceipt: { state: 'in_flight', approvedBy: 'Jean', approvedAt: iso(2_000) } });
  const f = fixture({ runs: [pending], responses: [{}, { runs: [approved] }] });
  assert.match(text(f.rail.render(f.conv)), /data-enter/, 'o cartão entra uma vez');
  assert.doesNotMatch(text(f.rail.render(f.conv)), /class="ui-approval"[^>]*data-enter/, 'o poll não repete a entrada');
  await f.rail.act('rail:approve', 'r', cardButton('r'));
  const after = text(f.rail.render(f.conv));
  assert.doesNotMatch(after, /class="ui-approval"/);
  assert.match(after, new RegExp(`<p class="ui-receipt" data-kind="approved"[^>]*data-enter=""[^>]*tabindex="-1" data-rail-focus="receipt:r">[\\s\\S]*Aprovada por Jean · ${clockTime(iso(2_000))}`));
  const timeline = f.rail.timelineItems(f.conv).map(item => text(item.markup)).join('');
  assert.match(timeline, new RegExp(`Jean aprovou ERP Acme › Consultar pedido · ${clockTime(iso(2_000))}`));
  const rejected = fixture({ runs: [run('x', { state: 'rejected', toolProposal: external, toolReceipt: { state: 'rejected', rejectedBy: 'Ana', rejectedAt: iso(3_000) } })] });
  assert.match(rejected.rail.timelineItems(rejected.conv).map(item => text(item.markup)).join(''), new RegExp(`Recusada por Ana · Consultar pedido · ${clockTime(iso(3_000))}`));
  // A decision on a proposal that no longer matches the view never reaches the server.
  const moved = fixture({ runs: [pending], conversation: { version: 6 } });
  assert.match(text(moved.rail.render(moved.conv)), /data-action="rail:approve"[^>]*disabled/);
  await assert.rejects(moved.rail.act('rail:approve', 'r', cardButton('r')), /não corresponde ao atendimento atual/);
  assert.equal(moved.calls.length, 0);
});

test('aceite: tool_unknown só para ferramenta externa', () => {
  const f = fixture();
  assert.equal(classifyRun(run('a', { state: 'tool_unknown', toolProposal: external }), f.conv), 'tool_unknown');
  assert.equal(classifyRun(run('b', { state: 'tool_unknown', toolProposal: internal }), f.conv), 'lookup_failed');
  const internalMarkup = text(fixture({ runs: [run('b', { state: 'tool_unknown', toolProposal: internal })] }).rail.render(f.conv));
  assert.doesNotMatch(internalMarkup, /ação externa|role="alert"/);
  assert.match(internalMarkup, /A consulta não terminou\. Nada foi alterado\./);
});

test('aceite: 429 não tenta de novo sozinho; "Tentar de novo" habilita depois de 10 s e só a pessoa repete', async () => {
  const f = fixture({ responses: [busyError(), {}, { runs: [run('new', { state: 'running' })] }] });
  assert.equal(await f.rail.act('rail:generate', 'case-a'), true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { path: '/api/tenants/tenant-a/conversations/case-a/run', method: 'POST', body: { version: 5, agentId: 'agent-a', lastMessageId: 'm1' } });
  let markup = text(f.rail.render(f.conv));
  assert.match(markup, /data-state="busy"/); assert.match(markup, /data-action="rail:retry"[^>]*disabled[^>]*data-rail-wait-until="\d+"/); assert.match(markup, /Disponível em 10 s/);
  assert.match(text(f.rail.composerButton(f.conv)), /aria-disabled="true"[^>]*title="O assistente está atendendo outras execuções agora\. Tente de novo em 10 s\."/);
  await assert.rejects(f.rail.act('rail:retry', 'case-a'), /Aguarde 10 s para tentar de novo/);
  f.advance(BUSY_RETRY_MS + 1_000);
  assert.equal(f.calls.length, 1, 'nenhuma nova tentativa automática com o tempo');
  markup = text(f.rail.render(f.conv));
  assert.doesNotMatch(markup, /data-action="rail:retry"[^>]*disabled/);
  assert.equal(await f.rail.act('rail:retry', 'case-a'), true);
  assert.equal(f.calls[1].method, 'POST'); assert.equal(f.calls.length, 3, 'POST e a releitura das execuções');
  // tickRail enables the button on screen without calling the server.
  const button = { dataset: { railWaitUntil: String(T0 + BUSY_RETRY_MS) }, disabled: true, removeAttribute(name) { this.removed = name; } };
  const countdown = { dataset: { railCountdown: String(T0 + BUSY_RETRY_MS) }, textContent: '', hidden: false };
  const root = { querySelectorAll: selector => ({ '[data-rail-wait-until]': [button], '[data-rail-countdown]': [countdown] })[selector] || [] };
  assert.equal(tickRail(root, T0 + 3_000), 2); assert.equal(countdown.textContent, 'Disponível em 7 s'); assert.equal(button.disabled, true);
  assert.equal(tickRail(root, T0 + BUSY_RETRY_MS), 0); assert.equal(button.disabled, false); assert.equal(button.removed, 'data-rail-wait-until'); assert.equal(countdown.hidden, true);
  assert.equal(f.calls.length, 3);
});

test('aceite: CTA da cota diferente para administrador e atendente; o botão ✦ fica desabilitado com o motivo', async () => {
  for (const [role, supportGrantId, who] of [['reseller', null, 'admin'], ['operator', null, 'attendant'], ['reseller', 'grant-1', 'support'], ['operator', 'grant-1', 'support']]) {
    const f = fixture({ role, supportGrantId, responses: [quotaError()] });
    assert.equal(await f.rail.act('rail:generate', 'case-a'), true);
    const markup = text(f.rail.render(f.conv));
    assert.match(markup, /Cota diária de IA da Loja Centro atingida\./); assert.match(markup, /Renova às 00:00\./);
    // The limit belongs to the company: Agentes › Uso holds "Ajustar cota" (agents:usage-limit of P5).
    if (who === 'admin') { assert.match(markup, /<a class="ui-btn ui-btn--secondary ui-btn--sm" href="#agents\/usage"><span class="ui-btn__label">Ajustar cota<\/span><\/a>/); assert.doesNotMatch(markup, /rail:notify-admin/); }
    else if (who === 'attendant') { assert.match(markup, /data-action="rail:notify-admin"[^>]*><span class="ui-btn__label">Avisar administrador/); assert.doesNotMatch(markup, /Ajustar cota/); }
    else {
      // A support session has no Equipe (nav-config): it is told who adjusts the quota, with no control that leads nowhere.
      assert.match(markup, /<small class="pg-rail__hint">Peça ao administrador da empresa para ajustar a cota\.<\/small>/); assert.doesNotMatch(markup, /rail:notify-admin|Ajustar cota/);
      await assert.rejects(f.rail.act('rail:notify-admin'), /Peça ao administrador da empresa/);
    }
    assert.match(text(f.rail.composerButton(f.conv)), /aria-disabled="true" title="Cota diária de IA atingida\. Renova às 00:00\."/);
    await assert.rejects(f.rail.act('rail:generate', 'case-a'), /Cota diária de IA atingida/);
    assert.equal(f.calls.length, 1, 'sem nova chamada enquanto a cota está esgotada');
    // An administrator who changes the limit (aiLimitVersion of the company DTO) frees the button at once.
    f.state.tenant.aiLimitVersion = 7;
    assert.equal(f.rail.generateState(f.conv).enabled, true); assert.doesNotMatch(text(f.rail.render(f.conv)), /Cota diária/);
  }
  setLocale('en', { persist: false, notify: false });
  const en = fixture({ responses: [Object.assign(new Error("This company's daily AI limit was reached."), { status: 429 })] });
  await en.rail.act('rail:generate', 'case-a');
  assert.match(text(en.rail.render(en.conv)), /Loja Centro&#39;s daily AI quota reached\.[\s\S]*It renews at 00:00\.[\s\S]*Notify administrator/);
});

test('avisar administrador abre a Equipe e entrega o texto sugerido; a pessoa envia', async () => {
  const opened = [];
  const undo = registerAction('shell:team', ({ element }) => opened.push(element));
  const previous = { window: globalThis.window, CustomEvent: globalThis.CustomEvent };
  try {
    const f = fixture({ responses: [quotaError()] });
    await f.rail.act('rail:generate', 'case-a');
    const element = { dataset: {} };
    // Without a drawer that answers elozi:team-prefill, the text goes to a toast (never sent by itself).
    globalThis.window = undefined;
    await f.rail.act('rail:notify-admin', null, element);
    assert.deepEqual(opened, [element]);
    assert.match(f.toasts.at(-1).message, /Loja Centro/);
    // With the drawer of P2 answering the event, nothing else is shown.
    const events = [];
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
    globalThis.window = { dispatchEvent: event => { events.push(event); return false; } };
    const toasts = f.toasts.length;
    await f.rail.act('rail:notify-admin', null, element);
    assert.equal(events[0].type, 'elozi:team-prefill'); assert.match(events[0].detail.text, /cota diária de IA da Loja Centro/);
    assert.equal(f.toasts.length, toasts);
    assert.equal(f.calls.length, 1, 'avisar não chama a API');
  } finally { undo(); globalThis.window = previous.window; globalThis.CustomEvent = previous.CustomEvent; }
});

test('aceite: o motor só aparece para o dono da plataforma; tokens e tempo só para administrador', () => {
  const draft = run('r', { state: 'draft', draft: 'Texto', usage: { prompt_tokens: 700, completion_tokens: 212, total_tokens: 912 }, startedAt: iso(-3_100), completedAt: iso(0), updatedAt: iso(0) });
  const owner = fixture({ role: 'reseller', platformOwner: true, runs: [draft] });
  assert.match(text(owner.rail.render(owner.conv)), /<span class="ui-draft__meta">912 tokens · 3,1 s · Motor: Hermes<\/span>/);
  assert.match(text(owner.rail.contextTab(owner.conv)), /Copiloto gerenciado · consultas internas automáticas · Motor: Hermes/);
  const admin = fixture({ role: 'reseller', runs: [draft] });
  assert.match(text(admin.rail.render(admin.conv)), /<span class="ui-draft__meta">912 tokens · 3,1 s<\/span>/);
  const attendant = fixture({ runs: [draft] });
  assert.doesNotMatch(text(attendant.rail.render(attendant.conv)), /tokens|ui-draft__meta/);
  // The engine fallback name of a run never leaks to a company: "Hermes" becomes "Assistente".
  const unnamed = run('u', { state: 'running', agentId: 'gone', agentName: 'Hermes' });
  for (const f of [fixture({ role: 'reseller', runs: [unnamed] }), fixture({ runs: [unnamed] })]) {
    const all = [text(f.rail.render(f.conv)), text(f.rail.contextTab(f.conv)), ...f.rail.timelineItems(f.conv).map(item => text(item.markup))].join('');
    assert.doesNotMatch(all, /Hermes/); assert.match(all, /Assistente está preparando…/);
  }
  assert.match(text(fixture({ platformOwner: true, runs: [unnamed] }).rail.render(fixture().conv)), /Hermes está preparando…/);
  // Provider errors that name the engine or the provider are neutral for everyone but the owner.
  const failure = run('f', { state: 'failed', reason: 'A CommandCode recusou a chave da API. O administrador precisa atualizar a integração.' });
  assert.match(text(fixture({ role: 'reseller', runs: [failure] }).rail.render(fixture().conv)), /O serviço de IA precisa de atenção do administrador\./);
  assert.match(text(fixture({ platformOwner: true, runs: [failure] }).rail.render(fixture().conv)), /CommandCode/);
});

test('aceite: a string "aprovada por sistema" não existe no painel', () => {
  for (const file of readdirSync(publicDir).filter(name => /\.(?:js|css|html)$/.test(name))) assert.doesNotMatch(read(file), /aprovada por sistema/i, file);
});

test('aceite: movimento reduzido mostra texto estático (pontos e barra param; rascunho e recibo só aparecem)', () => {
  const css = read('agent-rail.css');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(css, /\.pg-rail__dots i \{[^}]*animation: pg-rail-dot 1200ms/);
  assert.match(css, /\.pg-rail__dots i:nth-child\(2\) \{\s*animation-delay: 160ms;/);
  for (const rule of [/@media \(prefers-reduced-motion: reduce\) \{\s*\.ui-approval__fill,\s*\.ui-draft\[data-reveal\] \.ui-draft__reveal \{\s*animation: none;/, /:root\[data-motion="reduced"\] \.ui-approval__fill,/, /@media \(prefers-reduced-motion: reduce\) \{\s*\.pg-rail__dots \{\s*display: none;/, /:root\[data-motion="reduced"\] \.pg-rail__dots \{\s*display: none;/]) assert.match(css, rule);
  assert.ok(reduced.length > 0);
  for (const name of ['pg-rail-fade', 'pg-rail-rise', 'pg-rail-rows']) assert.match(css, new RegExp(`@keyframes ${name}`));
  assert.deepEqual(Object.values(cssMetrics(css)), [0, 0, 0, 0, 0, 0], 'tokens only, 12 px minimum, allowed breakpoints, no !important');
  // The dots are decoration: the text "… está preparando… 4 s" is there with or without them.
  const f = fixture({ runs: [run('r', { state: 'running' })] });
  assert.match(text(f.rail.render(f.conv)), /<span class="pg-rail__dots" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span><span class="pg-rail__title">Assistente Vendas está preparando…<\/span><span class="pg-rail__clock"[^>]*aria-hidden="true">4 s<\/span>/);
  // Clocks only change text: the approval bar is CSS (static with reduced motion), never touched by tickRail.
  const since = { dataset: { railSince: iso(-4_000) }, textContent: '' }, expires = { dataset: { railExpires: iso(8 * 60_000), railTick: String(T0) }, textContent: 'expira em 8 min' };
  const root = { querySelectorAll: selector => ({ '[data-rail-since]': [since], '[data-rail-expires]': [expires] })[selector] || [] };
  tickRail(root, T0 + 1_000); assert.equal(since.textContent, '5 s'); assert.equal(expires.textContent, 'expira em 8 min', 'a expiração muda a cada 30 s');
  tickRail(root, T0 + 31_000); assert.equal(expires.textContent, 'expira em 8 min'); tickRail(root, T0 + 121_000); assert.equal(expires.textContent, 'expira em 6 min');
});

// ---------------------------------------------------------------------------------------------
// Draft: reveal, insert through composerBridge, stale, discard and regenerate

test('revelar rascunho anima só na transição preparando → pronto, nunca no poll nem ao abrir a conversa', () => {
  const f = fixture({ runs: [run('r', { state: 'running' })] });
  f.rail.render(f.conv);
  f.state.tenant.runs = [run('r', { state: 'draft', draft: 'Pronto' })];
  assert.match(text(f.rail.render(f.conv)), /class="ui-draft"[^>]*data-reveal=""/);
  assert.doesNotMatch(text(f.rail.render(f.conv)), /data-reveal/);
  const g = fixture({ runs: [run('r', { state: 'draft', draft: 'Pronto' })] });
  assert.doesNotMatch(text(g.rail.render(g.conv)), /data-reveal/);
  // Small screens start with the chip; the toggle is a real button with aria-expanded.
  assert.match(text(g.rail.render(g.conv)), /<button type="button" class="ui-draft__peek" data-action="rail:expand-draft" data-id="r" aria-expanded="false" aria-controls="rail-draft-r">/);
  g.rail.act('rail:expand-draft', 'r');
  assert.match(text(g.rail.render(g.conv)), /data-expanded="true"[\s\S]*aria-expanded="true"/);
});

function bridge({ value = '', mode = 'reply', withInsert = false, outcome = 'inserted' } = {}) {
  const log = [];
  const api = { getText: () => value, setText(textValue, options) { log.push(['setText', textValue, options]); value = options.mode === 'append' && value ? `${value}\n${textValue}` : textValue; return true; },
    flash() { log.push(['flash']); return true; }, focus() { log.push(['focus']); return true; }, get mode() { return mode; } };
  if (withInsert) api.insertDraft = async (textValue, options) => { log.push(['insertDraft', textValue, options]); return outcome; };
  return { api, log, get value() { return value; } };
}

test('inserir rascunho pelo composerBridge: vazio preenche; com texto pergunta Substituir | Acrescentar | Cancelar', async () => {
  const ready = run('r', { state: 'draft', draft: 'Olá, Maria!' });
  const empty = bridge(), f = fixture({ runs: [ready], composer: empty.api });
  await f.rail.act('rail:insert-draft', 'r');
  assert.deepEqual(empty.log, [['setText', 'Olá, Maria!', { mode: 'replace', sourceRunId: 'r' }], ['flash'], ['focus']]);
  assert.equal(f.toasts.at(-1).message, 'Rascunho inserido. Revise antes de enviar.'); assert.equal(f.rail.insertedRun('case-a'), 'r');
  const typed = bridge({ value: 'Meu texto' }), g = fixture({ runs: [ready], composer: typed.api });
  await g.rail.act('rail:insert-draft', 'r');
  assert.deepEqual(typed.log, [], 'nada muda sem a escolha da pessoa');
  const asking = text(g.rail.render(g.conv));
  assert.match(asking, /O compositor já tem texto\. O que fazer com o rascunho\?/);
  for (const action of ['rail:insert-replace', 'rail:insert-append', 'rail:insert-cancel']) assert.match(asking, new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(asking, /data-action="rail:insert-draft"/, 'a pergunta substitui as ações do cartão até a escolha');
  await g.rail.act('rail:insert-cancel', 'r');
  assert.doesNotMatch(text(g.rail.render(g.conv)), /O compositor já tem texto/);
  await g.rail.act('rail:insert-draft', 'r'); await g.rail.act('rail:insert-append', 'r');
  assert.deepEqual(typed.log[0], ['setText', 'Olá, Maria!', { mode: 'append', sourceRunId: 'r' }]); assert.equal(typed.value, 'Meu texto\nOlá, Maria!');
  // The composer of P3 asks the question itself: the rail hands over the text and the run.
  const own = bridge({ value: 'Meu texto', withInsert: true, outcome: 'cancelled' }), h = fixture({ runs: [ready], composer: own.api });
  await h.rail.act('rail:insert-draft', 'r');
  assert.deepEqual(own.log, [['insertDraft', 'Olá, Maria!', { sourceRunId: 'r' }]]); assert.equal(h.toasts.length, 0, 'cancelar não avisa nada');
  assert.doesNotMatch(text(h.rail.render(h.conv)), /O compositor já tem texto/);
});

test('inserir rascunho respeita nota interna, envio pendente, fonte revogada e rascunho relido do servidor', async () => {
  const ready = run('r', { state: 'draft', draft: 'Olá' });
  const note = bridge({ mode: 'note' });
  await assert.rejects(fixture({ runs: [ready], composer: note.api }).rail.act('rail:insert-draft', 'r'), /Volte para Responder/);
  const pending = fixture({ runs: [ready], composer: bridge().api }); pending.state.sendIntent = { id: 'send-1' };
  await assert.rejects(pending.rail.act('rail:insert-draft', 'r'), /Confira o envio pendente/);
  const revoked = bridge();
  await assert.rejects(fixture({ runs: [run('r', { state: 'draft', draft: 'Olá', knowledgeUnavailable: true })], composer: revoked.api }).rail.act('rail:insert-draft', 'r'), /não corresponde ao contexto atual/);
  assert.deepEqual(revoked.log, [] );
  // With the scoped loader, the draft is read again: a run invalidated meanwhile never reaches the composer.
  const fresh = bridge();
  let f;
  f = fixture({ runs: [ready], composer: fresh.api, loadRuns: async () => { f.state.tenant.runs = [run('r', { state: 'invalidated', draft: null })]; return true; } });
  await assert.rejects(f.rail.act('rail:insert-draft', 'r'), /não corresponde ao contexto atual/);
  assert.deepEqual(fresh.log, []);
  // "d" (bound by P2) inserts the latest ready draft without an id.
  const latest = bridge(), g = fixture({ runs: [run('old', { state: 'draft', draft: 'Antigo' }), run('new', { state: 'draft', draft: 'Novo' })], composer: latest.api });
  await g.rail.act('rail:insert-draft', null);
  assert.equal(latest.log[0][1], 'Novo');
  await assert.rejects(fixture({ composer: bridge().api }).rail.act('rail:insert-draft', null), /Nenhum rascunho pronto/);
});

test('rascunho desatualizado: texto antigo visível, gerar de novo é o primário e usar continua possível', async () => {
  const stale = run('r', { state: 'draft', draft: 'Antigo', stale: true, startedAt: iso(-120_000) });
  const f = fixture({ runs: [stale], conversation: { version: 6, messages: [{ id: 'm1', kind: 'customer', createdAt: iso(-180_000) }, { id: 'm2', kind: 'customer', createdAt: iso(-10_000) }] },
    responses: [{}, { runs: [stale, run('n', { state: 'running' })] }] });
  const markup = text(f.rail.render(f.conv));
  assert.match(markup, /Maria enviou 1 mensagem depois deste rascunho/);
  const actions = markup.slice(markup.indexOf('class="pg-rail__actions"'));
  assert.ok(actions.indexOf('rail:regenerate') < actions.indexOf('rail:insert-draft'), 'Gerar novamente vem primeiro');
  assert.match(actions, /ui-btn--primary[^"]*"[^>]*data-action="rail:regenerate"/);
  assert.doesNotMatch(actions, /data-action="rail:insert-draft"[^>]*disabled/);
  await f.rail.act('rail:regenerate', 'r');
  assert.deepEqual(f.calls[0], { path: '/api/tenants/tenant-a/conversations/case-a/run', method: 'POST', body: { version: 6, agentId: 'agent-a', lastMessageId: 'm2' } });
  setLocale('en', { persist: false, notify: false });
  const en = text(fixture({ runs: [stale], conversation: { version: 6 } }).rail.render(fixture().conv));
  assert.match(en, /Draft from before the newer messages/); assert.match(en, />Use anyway</); assert.match(en, />Generate again with the new context</);
});

test('descartar e cancelar usam o cancelamento do servidor e releem as execuções', async () => {
  const f = fixture({ runs: [run('d', { state: 'draft', draft: 'Texto' })], responses: [{}, { runs: [run('d', { state: 'cancelled', reason: 'Cancelado pelo atendente.' })] }] });
  await f.rail.act('rail:discard', 'd');
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['POST', '/api/tenants/tenant-a/runs/d/cancel'], ['GET', '/api/tenants/tenant-a/conversations/case-a/runs']]);
  assert.equal(f.toasts.at(-1).message, 'Rascunho descartado. Nada foi enviado ao cliente.');
  assert.match(text(f.rail.render(f.conv)), /Cancelado pelo atendente\./);
  await assert.rejects(f.rail.act('rail:cancel', 'd'), /já terminou/);
  const g = fixture({ runs: [run('a', { state: 'running' })], responses: [{}, { runs: [] }] });
  await g.rail.act('rail:cancel', 'a');
  assert.equal(g.toasts.at(-1).message, 'Preparação cancelada.');
  // Someone else's conversation: no button and no request.
  const other = fixture({ runs: [run('a', { state: 'running' })], conversation: { assignedUserId: 'person-b' } });
  assert.doesNotMatch(text(other.rail.render(other.conv)), /rail:cancel/);
  await assert.rejects(other.rail.act('rail:cancel', 'a'), /não corresponde ao atendimento atual/); assert.equal(other.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Generate, Agente tab, timeline, list glyph and autopilot

test('gerar rascunho pelo formulário da aba Agente envia a orientação e trata erros sem postar a página', async () => {
  const previous = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } };
  try {
    const f = fixture({ responses: [{}, { runs: [run('n', { state: 'running' })] }] });
    const tab = text(f.rail.contextTab(f.conv));
    assert.match(tab, /<form class="pg-rail-tab__form" data-form="rail:generate" data-conversation-id="case-a">/);
    assert.match(tab, /Orientação para o agente \(opcional\)<textarea name="instruction" rows="3" maxlength="1000"/);
    assert.doesNotMatch(tab, /<button type="submit"[^>]*disabled/);
    const form = { dataset: { form: 'rail:generate', conversationId: 'case-a' }, fields: { instruction: ' Tom formal. ' }, reset() { this.cleared = true; } };
    assert.equal(await f.rail.submit(form), true);
    assert.deepEqual(f.calls[0].body, { version: 5, agentId: 'agent-a', lastMessageId: 'm1', instruction: 'Tom formal.' });
    assert.equal(form.cleared, true);
    const g = fixture({ responses: [Object.assign(new Error('A conversa mudou. Atualize antes de continuar.'), { status: 409 })] });
    assert.equal(await g.rail.submit({ dataset: { form: 'rail:generate', conversationId: 'case-a' }, fields: {} }), true);
    assert.deepEqual(g.toasts, [{ message: 'A conversa mudou. Atualize antes de continuar.', error: true }]);
    // Without responsibility the form explains why and nothing is requested.
    const other = fixture({ conversation: { assignedUserId: 'person-b' } });
    assert.match(text(other.rail.contextTab(other.conv)), /<button type="submit"[^>]*disabled[\s\S]*O responsável coordena o agente deste atendimento\./);
    assert.equal(await other.rail.submit({ dataset: { form: 'rail:generate', conversationId: 'case-a' }, fields: {} }), true);
    assert.equal(other.calls.length, 0); assert.equal(other.toasts[0].error, true);
  } finally { globalThis.FormData = previous; }
});

test('aba Agente: identidade sem motor, execução atual com fases reais e fontes', () => {
  const current = run('r', { state: 'tool_running', providerCalled: true, toolProposal: { ...internal, autoApproved: true }, toolReceipt: { state: 'in_flight', autoApproved: true, approvedAt: iso(0) },
    toolSteps: [step('Histórico'), step('Busca no conhecimento', { isError: true })], knowledgeReferences: [{ title: 'Prazos' }] });
  const f = fixture({ runs: [current], agents: [{ id: 'agent-a', name: 'Assistente Vendas', provider: 'hermes', mode: 'copilot', configured: true, toolPolicy: 'approve_all', health: { level: 'degraded' } }] });
  const tab = text(f.rail.contextTab(f.conv));
  assert.match(tab, /<strong>Assistente Vendas<\/strong><small>Copiloto gerenciado · aprovação em cada uso de ferramenta<\/small>/);
  assert.match(tab, /ui-badge--warning">Instável/); assert.doesNotMatch(tab, /Hermes/);
  assert.match(tab, /<h3 id="rail-run-case-a">Execução atual<\/h3>/);
  for (const piece of ['Leu a conversa', 'Histórico · consulta automática', 'Busca no conhecimento · consulta automática · retornou erro', 'Consultando Perfil do contato (3/3)', 'Fontes consultadas · 1']) assert.ok(tab.includes(piece), piece);
  assert.match(tab, /<li data-state="error">/); assert.match(tab, /<li data-state="current">/);
});

test('timeline: recibos intercalados por hora, com ver ▸ e resumo da consulta interna, em PT e EN', () => {
  const summary = { content: [{ type: 'text', text: '{}' }], isError: false, structuredContent: { state: 'matched', results: [{ title: 'Política <garantia>' }] } };
  const done = run('r', { state: 'draft', draft: 'Texto', toolProposal: { ...internal, id: 'p-Status do canal', autoApproved: true },
    toolReceipt: { state: 'completed', autoApproved: true, proposalId: 'p-Status do canal', approvedAt: iso(-3_000), dispatchedAt: iso(-2_600), completedAt: iso(-2_200), result: summary, summarized: true },
    toolSteps: [step('Histórico', { completedAt: iso(-5_000) }), step('Status do canal', { completedAt: iso(-2_200) })] });
  const f = fixture({ runs: [done] });
  const items = f.rail.timelineItems(f.conv);
  assert.deepEqual(items.map(item => item.id), ['r:auto:0', 'r:auto:1']);
  assert.ok(Date.parse(items[0].at) < Date.parse(items[1].at));
  const last = text(items[1].markup);
  assert.match(last, /Política &lt;garantia&gt;/); assert.match(last, /Resumo da consulta\. O conteúdo completo foi entregue somente ao copiloto\.<\/small><\/details>$/);
  assert.doesNotMatch(text(items[0].markup), /<details/, 'consultas antigas não guardam resultado');
  setLocale('en', { persist: false, notify: false });
  const en = f.rail.timelineItems(f.conv).map(item => text(item.markup)).join('');
  assert.match(en, /Automatic lookup · Status do canal · 0\.4 s/); assert.match(en, /Lookup summary\. The full content was delivered only to the copilot\./); assert.match(en, />view<\/span>/);
});

test('glifo da lista: estático, por agentState do servidor ou pelas execuções carregadas', () => {
  const f = fixture({ runs: [run('r', { state: 'waiting_approval', toolProposal: external })] });
  assert.match(text(f.rail.listGlyph({ id: 'case-a', tenantId: 'tenant-a' })), /<span class="ui-agent-glyph" data-agent-state="waiting_approval" data-tone="warning" title="Aprovação do agente pendente"><span aria-hidden="true">✦<\/span><span class="sr-only">Aprovação do agente pendente<\/span><\/span>/);
  assert.match(text(f.rail.listGlyph({ id: 'x', tenantId: 'other', agentState: 'stale' })), /data-agent-state="stale" data-tone="stale"/);
  assert.equal(text(f.rail.listGlyph({ id: 'x', tenantId: 'other' })), '', 'empresa não carregada sem agentState: nada');
  // A row that carries agentState follows the server, null included (nothing pending there, e.g. an expired approval).
  assert.equal(text(f.rail.listGlyph({ id: 'case-a', tenantId: 'tenant-a', agentState: null })), '');
  // An approval past expiresAt not reconciled yet: no pending mark from the loaded runs, and the Agente tab does not open for it.
  const expired = fixture({ runs: [run('r', { state: 'waiting_approval', toolProposal: { ...external, expiresAt: iso(-1_000) } })] });
  assert.equal(text(expired.rail.listGlyph({ id: 'case-a', tenantId: 'tenant-a' })), '');
  assert.equal(expired.rail.status(expired.conv).approval, false);
  const g = fixture({ runs: [run('r', { state: 'draft', draft: 'x', stale: true })] });
  assert.match(text(g.rail.listGlyph({ id: 'case-a' })), /data-agent-state="stale"/);
  assert.deepEqual(g.rail.status(g.conv), { approval: false, active: false, draft: false, stale: true, agentState: 'stale', quota: false });
});

test('piloto automático: detectado por agent.autopilot; status na aba Agente e linha viva no trilho', () => {
  const autopilot = { enabled: true, channelIds: ['wa'], maxRepliesPerHour: 4, requireKnowledge: true, quietHours: { timezone: 'America/Sao_Paulo', start: '22:00', end: '07:00' }, handoffDepartmentId: null };
  const agents = [{ id: 'agent-a', name: 'Assistente Vendas', provider: 'hermes', mode: 'copilot', configured: true, autopilot }];
  const f = fixture({ agents, conversation: { owner: 'agent', agentId: 'agent-a', assignedUserId: null } });
  assert.deepEqual({ ...f.rail.autopilotState(f.conv), agent: undefined }, { owned: true, known: true, active: true, agent: undefined, config: autopilot });
  const tab = text(f.rail.contextTab(f.conv));
  assert.match(tab, /✦ Piloto automático ativo/); assert.match(tab, /até 4 respostas por hora nesta conversa/);
  assert.match(tab, /Assistente Vendas responde sozinho neste canal, só com base publicada\./); assert.match(tab, /Horário silencioso: 22:00–07:00\./);
  assert.match(tab, /<button type="submit"[^>]*disabled/, 'quem não é responsável não gera rascunho');
  assert.equal(text(f.rail.render(f.conv)), '', 'o cabeçalho (P3) já diz que o piloto está ativo');
  f.state.tenant.agentAutopilotJobs = [{ id: 'j1', conversationId: 'case-a', state: 'running' }];
  assert.match(text(f.rail.render(f.conv)), /Preparando a resposta automática…/);
  const off = fixture({ agents: [{ ...agents[0], autopilot: { ...autopilot, channelIds: ['tg'] } }], conversation: { owner: 'agent', agentId: 'agent-a', assignedUserId: null } });
  assert.match(text(off.rail.contextTab(off.conv)), /que não responde automaticamente neste canal/);
  const unknown = fixture({ conversation: { owner: 'agent', agentId: 'agent-a', assignedUserId: null } });
  assert.equal(unknown.rail.autopilotState(unknown.conv).known, false);
  assert.doesNotMatch(text(unknown.rail.contextTab(unknown.conv)), /Piloto automático|não responde automaticamente/);
});

test('o foco volta ao mesmo controle quando o anfitrião redesenha o trilho, e os relógios só existem com o trilho na tela', async () => {
  const intervals = [], cleared = [];
  const previous = { dataset: { action: 'rail:reject', id: 'r' }, closest: selector => selector.includes('data-rail-root') ? {} : null, isConnected: false };
  const next = { dataset: { action: 'rail:reject', id: 'r' }, focused: 0, focus() { this.focused++; } }, other = { dataset: { action: 'rail:approve', id: 'r' }, focus() { assert.fail('outro controle'); } };
  const doc = { body: {}, documentElement: {}, activeElement: previous, querySelectorAll: selector => selector.includes('data-rail-focus') ? [other, next] : [] };
  const f = fixture({ runs: [run('r', { state: 'waiting_approval', toolProposal: external })], extra: { document: doc, timers: { setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: id => cleared.push(id) } } });
  f.rail.render(f.conv);
  doc.activeElement = doc.body; // the host replaced the rail (outerHTML) and the focus fell to <body>
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(next.focused, 1);
  assert.equal(intervals.length, 1, 'um relógio para a expiração');
  intervals[0](); assert.deepEqual(cleared, [1], 'sem relógios vivos o intervalo para');
  // Focus elsewhere (the composer) is never taken back by a re-render of the rail.
  const composer = { closest: () => null, isConnected: true };
  doc.activeElement = composer; f.rail.render(f.conv); await new Promise(resolve => setImmediate(resolve));
  assert.equal(next.focused, 1); assert.equal(doc.activeElement, composer);
});

test('contrato do §8.2 e utilidades: render vazio, ações desconhecidas, reset e formatos', async () => {
  const f = fixture();
  for (const key of ['render', 'timelineItems', 'contextTab', 'listGlyph', 'act', 'submit', 'reset', 'runCard', 'openRun', 'status', 'autopilotState', 'generateState', 'composerButton', 'insertedRun', 'tick']) assert.equal(typeof f.rail[key], 'function', key);
  assert.equal(await f.rail.act('rail:unknown'), false); assert.equal(await f.rail.act('mcp-discover', 'x'), false);
  assert.equal(await f.rail.submit({ dataset: { dialogForm: 'mcp-server' } }), false);
  assert.deepEqual(f.rail.timelineItems(null), []); assert.equal(text(f.rail.render(null)), ''); assert.equal(text(f.rail.listGlyph(null)), '');
  assert.match(text(f.rail.composerButton(f.conv)), /data-action="rail:generate"[^>]*title="Gerar rascunho com o agente"/);
  f.state.tenant.agents = [];
  assert.deepEqual(f.rail.generateState(f.conv), { enabled: false, reason: 'Nenhum agente configurado para preparar rascunhos nesta empresa.', agent: null });
  assert.equal(elapsedText(65_000), '1 min 5 s'); assert.equal(formatDuration(400), '0,4 s'); assert.equal(formatDuration(-1), ''); assert.equal(expiryText(-1), 'expirada'); assert.equal(expiryText(30_000), 'expira em menos de 1 min');
  setLocale('en', { persist: false, notify: false }); assert.equal(formatDuration(400), '0.4 s');
});

// ---------------------------------------------------------------------------------------------
// Expiry, server-confirmed decisions, announcements and focus after actions

test('aprovação expirada: o cartão para de oferecer a decisão e nada vai ao servidor', async () => {
  const late = run('r', { state: 'waiting_approval', toolProposal: { ...external, expiresAt: iso(-1_000) } });
  const f = fixture({ runs: [late] });
  const card = text(f.rail.render(f.conv));
  assert.match(card, /data-action="rail:reject"[^>]*disabled/); assert.match(card, /data-action="rail:approve"[^>]*disabled/);
  assert.match(card, /<span data-rail-expired="true" aria-hidden="true">expirada<\/span>/); assert.doesNotMatch(card, /data-rail-expires=/, 'sem relógio para um cartão já expirado');
  assert.match(card, /<p class="ui-approval__note">Esta proposta expirou\. Nada foi executado\.<\/p>/);
  await assert.rejects(f.rail.act('rail:approve', 'r', cardButton('r')), /Esta proposta expirou\. Nada foi executado\./);
  await assert.rejects(f.rail.act('rail:reject', 'r', cardButton('r')), /Esta proposta expirou/);
  assert.equal(f.calls.length, 0);
  assert.match(text(f.rail.contextTab(f.conv)), /<li data-state="warning">[^]*Esta proposta expirou\. Nada foi executado\./, 'a aba Agente não diz "aguardando aprovação"');
  assert.doesNotMatch(text(f.rail.contextTab(f.conv)), /aguardando aprovação/);
  // Between two polls the clock closes the card at expiresAt: both buttons disabled and the note says why.
  const buttons = [{ disabled: false }, { disabled: false }], note = { textContent: 'A execução gera contexto para o rascunho.' };
  const cardNode = { querySelectorAll: selector => selector.includes('rail:approve') && selector.includes('rail:reject') ? buttons : [], querySelector: selector => selector === '.ui-approval__note' ? note : null };
  const expiry = { dataset: { railExpires: iso(60_000), railTick: String(T0) }, textContent: 'expira em 1 min', closest: selector => selector === '[data-rail-approval]' ? cardNode : null };
  const root = { querySelectorAll: selector => selector === '[data-rail-expires]' ? [expiry] : [] };
  assert.equal(tickRail(root, T0 + 30_000), 1); assert.deepEqual(buttons.map(item => item.disabled), [false, false]);
  assert.equal(tickRail(root, T0 + 60_000), 0, 'nenhum relógio vivo depois de expirar');
  assert.equal(expiry.textContent, 'expirada'); assert.equal(expiry.dataset.railExpired, 'true');
  assert.deepEqual(buttons.map(item => item.disabled), [true, true]); assert.equal(note.textContent, 'Esta proposta expirou. Nada foi executado.');
  setLocale('en', { persist: false, notify: false });
  assert.match(text(fixture({ runs: [late] }).rail.render(fixture().conv)), /This proposal expired\. Nothing was run\./);
});

test('decisão confirmada só pelo servidor: proposta que perdeu a validade volta invalidada e nunca vira "Execução autorizada"', async () => {
  const lookup = { state: 'completed', autoApproved: true, proposalId: 'p-Histórico', approvedBy: 'Consulta automática', approvedAt: iso(-9_000), completedAt: iso(-8_000) };
  const pending = run('r', { state: 'waiting_approval', toolProposal: external, toolReceipt: lookup });
  // approveTool answers 202 with the run it invalidated (expired or outdated proposal), keeping the receipt of the earlier lookup.
  const invalidated = run('r', { state: 'invalidated', version: 4, reason: 'A conversa ou configuração mudou durante a execução.', toolProposal: external, toolReceipt: lookup });
  const f = fixture({ runs: [pending], responses: [invalidated, { runs: [invalidated] }] });
  assert.equal(await f.rail.act('rail:approve', 'r', cardButton('r')), true);
  assert.deepEqual(f.toasts, [{ message: 'A proposta perdeu a validade antes da sua decisão. Nada foi executado.', error: true }]);
  const after = text(f.rail.render(f.conv));
  assert.match(after, /A conversa ou configuração mudou durante a execução\./); assert.doesNotMatch(after, /Aprovada por|class="ui-approval"/);
  const approved = run('r', { state: 'tool_running', version: 4, toolProposal: external, toolReceipt: { state: 'pending_dispatch', proposalId: 'p-ext', approvedBy: 'Jean', approvedAt: iso(1_000) } });
  const g = fixture({ runs: [pending], responses: [approved, { runs: [approved] }] });
  await g.rail.act('rail:approve', 'r', cardButton('r'));
  assert.deepEqual(g.toasts, [{ message: 'Execução autorizada. O resultado será usado no rascunho.', error: false }]);
  // The run decides: the receipt of this proposal for an approval, the rejected state for a rejection.
  assert.equal(decisionConfirmed(approved, 'approve', 'p-ext'), true);
  assert.equal(decisionConfirmed(approved, 'approve', 'p-other'), false, 'recibo de outra proposta');
  assert.equal(decisionConfirmed(invalidated, 'approve', 'p-ext'), false, 'recibo de uma consulta automática anterior');
  assert.equal(decisionConfirmed({ state: 'invalidated', toolReceipt: { approvedAt: iso(0) } }, 'approve', 'p-ext'), false);
  assert.equal(decisionConfirmed({ state: 'rejected' }, 'reject', 'p-ext'), true); assert.equal(decisionConfirmed({ state: 'invalidated' }, 'reject', 'p-ext'), false);
  assert.equal(decisionConfirmed(null, 'approve', 'p-ext'), false);
});

function announcerDocument() {
  const regions = [];
  const element = () => ({ attributes: {}, className: '', said: [], value: '', setAttribute(name, value) { this.attributes[name] = String(value); },
    get textContent() { return this.value; }, set textContent(value) { this.value = value; if (value) this.said.push(value); } });
  return { regions, body: { appendChild: node => { regions.push(node); return node; } }, createElement: () => element(),
    querySelector: selector => regions.find(node => selector === `[data-rail-announcer="${node.attributes['data-rail-announcer']}"]`) || null };
}

test('leitores de tela: nenhum papel vivo no trilho; cada mudança real é dita uma vez fora do anfitrião, nunca no poll nem ao abrir', async () => {
  const doc = announcerDocument(), timers = { setTimeout: fn => fn(), setInterval: () => 0, clearInterval() {} };
  const f = fixture({ runs: [run('r', { state: 'running' })], responses: [run('r', { state: 'tool_running', toolProposal: external, toolReceipt: { state: 'pending_dispatch', proposalId: 'p-ext', approvedBy: 'Jean', approvedAt: iso(1_000) } }), { runs: [] }], extra: { document: doc, timers } });
  const said = name => doc.regions.find(region => region.attributes['data-rail-announcer'] === name)?.said || [];
  const poll = (times = 3) => { for (let index = 0; index < times; index++) assert.doesNotMatch(text(f.rail.render(f.conv)), /role="(?:status|alert)"/); };
  poll();
  assert.deepEqual(doc.regions.map(region => [region.className, region.attributes.role, region.attributes['data-rail-announcer']]), [['sr-only', 'status', 'polite'], ['sr-only', 'alert', 'assertive']]);
  assert.deepEqual(said('polite'), [], 'abrir a conversa não fala nada');
  f.state.tenant.runs = [run('r', { state: 'waiting_approval', toolProposal: external })];
  poll();
  assert.deepEqual(said('polite'), ['Aprovação necessária: Assistente Vendas quer usar Consultar pedido.'], 'uma vez, apesar de três polls');
  // The decision of this person is said by its toast and focus, not again by the rail.
  await f.rail.act('rail:approve', 'r', cardButton('r'));
  f.state.tenant.runs = [run('r', { state: 'tool_running', toolProposal: external, toolReceipt: { state: 'in_flight', proposalId: 'p-ext', approvedBy: 'Jean', approvedAt: iso(1_000) } })];
  poll();
  assert.equal(said('polite').length, 1);
  f.state.tenant.runs = [run('r', { state: 'draft', draft: 'Pronto' })];
  poll();
  assert.deepEqual(said('polite').slice(1), ['Rascunho do agente pronto']);
  // An external action without confirmation is urgent; a run this person just started is said by its toast.
  f.state.tenant.runs = [run('r', { state: 'draft', draft: 'Pronto' }), run('x', { state: 'tool_unknown', toolProposal: external })];
  poll();
  assert.deepEqual(said('assertive'), ['Não confirmamos se a ação externa executou. Confira no sistema de destino antes de repetir.']);
  f.state.tenant.runs = [...f.state.tenant.runs, run('n', { state: 'running' })];
  poll();
  assert.equal(said('polite').length, 2); assert.equal(said('assertive').length, 1);
  // Coming back to a conversation never replays what changed while it was closed.
  f.rail.render({ ...f.conv, id: 'case-b' });
  f.state.tenant.runs = [run('r', { state: 'draft', draft: 'Pronto' }), run('x', { state: 'tool_unknown', toolProposal: external }), run('n', { state: 'failed', reason: 'Execução interrompida ou tempo limite atingido.' })];
  poll();
  assert.equal(said('polite').length, 2);
});

// A document made from the last markup of the rail: the nodes that take the focus, by their keys.
function railDocument() {
  const doc = { body: { tag: 'body' }, documentElement: {}, markup: '' };
  doc.activeElement = doc.body;
  doc.querySelectorAll = selector => !selector.includes('data-rail-focus') ? [] : [...doc.markup.matchAll(/<(?:section|button|div|p|details)\b([^>]*)>/g)].map(([, attrs]) => {
    const read = name => (new RegExp(`\\s${name}="([^"]*)"`).exec(attrs) || [])[1];
    const node = { dataset: {}, disabled: /\sdisabled(?:\s|$)/.test(attrs), isConnected: true, closest: query => query.includes('data-rail-root') ? {} : null, focus() { doc.activeElement = node; } };
    for (const [name, key] of [['data-rail-focus', 'railFocus'], ['data-action', 'action'], ['data-id', 'id']]) if (read(name)) node.dataset[key] = read(name);
    return node;
  }).filter(node => node.dataset.railFocus || node.dataset.action);
  return doc;
}
function focusFixture(options = {}) {
  const doc = railDocument(), holder = {};
  const paint = () => { doc.markup = text(holder.f.rail.render(holder.f.conv)); };
  holder.f = fixture({ ...options, loadRuns: options.loadRuns && ((...args) => options.loadRuns(holder.f, paint, ...args)), extra: { document: doc, renderRuns: paint } });
  paint(); doc.activeElement = doc.body; // the click disabled the control and the focus fell to <body>
  return { f: holder.f, doc, paint };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('depois de Descartar, Cancelar, Gerar novamente, Tentar de novo e de uma decisão, o foco vai para o que a ação produziu', async () => {
  const discard = focusFixture({ runs: [run('d', { state: 'draft', draft: 'Texto' })], responses: [{}, { runs: [run('d', { state: 'cancelled', reason: 'Cancelado pelo atendente.' })] }] });
  await discard.f.rail.act('rail:discard', 'd'); await settle();
  assert.equal(discard.doc.activeElement.dataset.railFocus, 'run:d'); assert.match(discard.doc.markup, /data-state="cancelled" tabindex="-1" data-rail-focus="run:d">[\s\S]*Cancelado pelo atendente\./);
  const cancel = focusFixture({ runs: [run('a', { state: 'running' })], responses: [{}, { runs: [run('a', { state: 'cancelled', reason: 'Cancelado pelo atendente.' })] }] });
  await cancel.f.rail.act('rail:cancel', 'a'); await settle();
  assert.equal(cancel.doc.activeElement.dataset.railFocus, 'run:a');
  // A refused cancel gives the focus back to the same button, enabled again.
  const refused = focusFixture({ runs: [run('a', { state: 'running' })], responses: [Object.assign(new Error('A execução já terminou.'), { status: 409 })] });
  await assert.rejects(refused.f.rail.act('rail:cancel', 'a'), /já terminou/); await settle();
  assert.deepEqual([refused.doc.activeElement.dataset.action, refused.doc.activeElement.dataset.id], ['rail:cancel', 'a']);
  const failed = run('r', { state: 'failed', reason: 'Execução interrompida ou tempo limite atingido.' });
  const again = focusFixture({ runs: [failed], responses: [run('n', { state: 'queued' })], loadRuns: async (f, paint) => { f.state.tenant.runs = [failed, run('n', { state: 'running' })]; paint(); return true; } });
  await again.f.rail.act('rail:regenerate', 'r'); await settle();
  assert.equal(again.doc.activeElement.dataset.railFocus, 'run:n', 'o cartão da nova execução');
  const wait = focusFixture({ responses: [busyError(), busyError()] });
  await wait.f.rail.act('rail:generate', 'case-a');
  wait.f.advance(BUSY_RETRY_MS + 1_000); wait.paint(); wait.doc.activeElement = wait.doc.body;
  assert.equal(await wait.f.rail.act('rail:retry', 'case-a'), true); await settle();
  assert.equal(wait.doc.activeElement.dataset.railFocus, 'busy:case-a', 'a linha de ocupado, com o botão de novo em espera');
  const pending = run('r', { state: 'waiting_approval', toolProposal: external });
  const approved = run('r', { state: 'tool_running', version: 4, toolProposal: external, toolReceipt: { state: 'in_flight', proposalId: 'p-ext', approvedBy: 'Jean', approvedAt: iso(1_000) } });
  const ok = focusFixture({ runs: [pending], responses: [approved, { runs: [approved] }] });
  await ok.f.rail.act('rail:approve', 'r', cardButton('r')); await settle();
  assert.equal(ok.doc.activeElement.dataset.railFocus, 'receipt:r');
  const invalidated = run('r', { state: 'invalidated', version: 4, reason: 'A conversa ou configuração mudou durante a execução.', toolProposal: external });
  const lost = focusFixture({ runs: [pending], responses: [invalidated, { runs: [invalidated] }] });
  await lost.f.rail.act('rail:approve', 'r', cardButton('r')); await settle();
  assert.equal(lost.doc.activeElement.dataset.railFocus, 'run:r', 'a linha do que mudou, nunca um recibo que não existe');
  // Nothing came back: the composer keeps the person in the conversation instead of <body>.
  const composer = bridge();
  const empty = focusFixture({ runs: [run('d', { state: 'draft', draft: 'Texto' })], composer: composer.api, responses: [{}, { runs: [] }] });
  await empty.f.rail.act('rail:discard', 'd'); await settle();
  assert.deepEqual(composer.log, [['focus']]);
});

test('aba Agente diz o mesmo que o trilho: consulta interna interrompida e ação externa sem confirmação, em PT e EN', () => {
  const reason = 'A ação foi interrompida sem confirmação. Verifique no sistema de destino; não repita automaticamente.';
  const f = fixture({ runs: [run('r', { state: 'tool_unknown', toolProposal: internal, reason })] });
  for (const markup of [text(f.rail.render(f.conv)), text(f.rail.contextTab(f.conv))]) {
    assert.match(markup, /A consulta não terminou\. Nada foi alterado\./); assert.doesNotMatch(markup, /não repita|ação externa/);
  }
  setLocale('en', { persist: false, notify: false });
  const outside = fixture({ runs: [run('x', { state: 'tool_unknown', toolProposal: external, reason })] });
  const tab = text(outside.rail.contextTab(outside.conv));
  assert.match(tab, /<li data-state="warning">[\s\S]*We could not confirm whether the external action ran\. Check the target system before repeating it\./);
  assert.doesNotMatch(tab, /The preparation did not finish/);
});

test('avisar administrador com a Equipe já aberta não fecha a gaveta: só leva o foco ao campo da mensagem', async () => {
  const opened = [];
  const undo = registerAction('shell:team', ({ element }) => opened.push(element));
  const previous = globalThis.window;
  try {
    const field = { focused: 0, focus() { this.focused++; } };
    const drawer = { open: true, querySelector: selector => selector.startsWith('[data-team-chat-draft]') ? field : null };
    const f = fixture({ responses: [quotaError()], extra: { document: { querySelector: selector => selector === 'dialog[data-live-drawer="team"]' ? drawer : null } } });
    await f.rail.act('rail:generate', 'case-a');
    globalThis.window = undefined;
    await f.rail.act('rail:notify-admin', null, { dataset: {} });
    assert.deepEqual(opened, [], 'shell:team alterna a gaveta: aberta, ela fecharia');
    assert.equal(field.focused, 1); assert.match(f.toasts.at(-1).message, /Loja Centro/);
    drawer.open = false;
    await f.rail.act('rail:notify-admin', null, { dataset: {} });
    assert.equal(opened.length, 1);
  } finally { undo(); globalThis.window = previous; }
});
