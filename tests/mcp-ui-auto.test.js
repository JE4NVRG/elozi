import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../public/i18n.js';
import '../public/locales-operations.js';
// The run cards and the approval decision moved from mcp-ui.js to the agent rail in P1 commit 1f and became
// the rail of FRONTEND-V2 §5.2.3 in P4: automatic lookups are inline receipts of the timeline (timelineItems),
// labelled only from the server flag autoApproved; approval is the .ui-approval card with rail:approve.
import { createAgentRail, clockTime } from '../public/agent-rail-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function ui(calls = []) {
  const state = { workspaceId: 'w-a', boot: { session: { role: 'operator', userId: 'person-a' } }, conversation: 'case-a',
    tenant: { id: 'tenant-a', name: 'Empresa A', runs: [], conversations: [{ id: 'case-a', version: 3, assignedUserId: 'person-a' }], agents: [] } };
  const rail = createAgentRail({ state, escape, icon: () => '', badge: value => `<span class="badge">${escape(value)}</span>`, tenantApi: path => `/api/tenants/tenant-a/${path}`,
    api: async (path, options) => { calls.push({ path, options }); return {}; }, canReplyTo: conversation => conversation?.assignedUserId === 'person-a',
    runNames: { draft: 'Rascunho pronto', waiting_approval: 'Aguardando sua aprovação', tool_running: 'Executando ferramenta' }, renderRuns() {}, toast() {}, document: null, noListeners: true });
  return { state, rail, conversation: state.tenant.conversations[0] };
}
const run = extra => ({ id: 'run-a', state: 'draft', draft: 'Rascunho revisável.', conversationId: 'case-a', conversationVersion: 3, agentName: 'Hermes', actorName: 'Pessoa A', version: 4,
  toolProposal: { id: 'proposal-a', toolName: 'elozi_channel_status', title: 'Status do canal', serverName: 'Elozi interna', arguments: {}, readOnly: true, autoApproved: true },
  toolReceipt: { state: 'completed', proposalId: 'proposal-a', autoApproved: true, approvedBy: 'Consulta automática', approvedUserId: null, approvedAt: '2026-10-06T12:00:00.000Z', dispatchedAt: '2026-10-06T12:00:00.000Z', completedAt: '2026-10-06T12:00:00.400Z', result: { content: [], isError: false } },
  toolSteps: [{ proposalId: 'proposal-a', toolName: 'elozi_channel_status', title: 'Status do canal', autoApproved: true, completedAt: '2026-10-06T12:00:00.400Z' }], ...extra });
const timeline = (f, value) => { f.state.tenant.runs = [value]; return f.rail.timelineItems(f.conversation).map(item => String(item.markup)).join(''); };

test('recibo automático aparece como Consulta automática em PT e EN, sem botão de aprovação', () => {
  const f = ui();
  try {
    for (const [locale, label, hidden] of [['pt-BR', 'Consulta automática · Status do canal · 0,4 s', /aprovada por|Execução aprovada|aprovou/], ['en', 'Automatic lookup · Status do canal · 0.4 s', /Execution approved|approved by|approved/]]) {
      setLocale(locale, { persist: false, notify: false });
      const markup = timeline(f, run()), card = String(f.rail.runCard(run(), f.conversation));
      assert.ok(markup.includes(label), label); assert.doesNotMatch(markup + card, hidden); assert.doesNotMatch(markup + card, /data-action="(?:rail:approve|mcp-approve)"/);
    }
    setLocale('en', { persist: false, notify: false });
    const running = String(f.rail.runCard(run({ state: 'tool_running', draft: null, toolSteps: [], toolReceipt: { state: 'in_flight', autoApproved: true, approvedAt: '2026-10-06T12:00:00.000Z' } }), f.conversation));
    assert.match(running, /Looking up Status do canal \(1\/3\)/); assert.doesNotMatch(running, /approve/);
    const steps = timeline(f, run({ toolSteps: [{ title: 'Status do canal', autoApproved: true, completedAt: '2026-10-06T12:00:00.100Z' }, { title: 'Perfil do contato', autoApproved: true, completedAt: '2026-10-06T12:00:00.300Z' }] }));
    assert.match(steps, /Automatic lookup · Status do canal/); assert.match(steps, /Automatic lookup · Perfil do contato/);
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
});

test('somente proposta que realmente espera aprovação mostra o botão e aceita decisão', async () => {
  const calls = [], f = ui(calls);
  const waiting = run({ state: 'waiting_approval', draft: null, toolReceipt: undefined, toolSteps: [], toolProposal: { id: 'proposal-b', toolName: 'lookup_order', title: 'Pedido externo', serverName: 'Remoto', arguments: { id: '1' }, readOnly: false } });
  f.state.tenant.runs = [waiting];
  assert.match(String(f.rail.render(f.conversation)), /data-rail-approval[\s\S]*data-action="rail:approve"/);
  const forged = run({ state: 'waiting_approval', draft: null });
  f.state.tenant.runs = [forged];
  assert.doesNotMatch(String(f.rail.render(f.conversation)), /data-action="(?:rail:|mcp-)approve"/);
  await assert.rejects(f.rail.act('mcp-approve', forged.id), /não corresponde ao atendimento atual/);
  assert.equal(calls.length, 0);
  const human = run({ state: 'draft', toolProposal: { ...waiting.toolProposal }, toolReceipt: { state: 'completed', proposalId: 'proposal-b', approvedBy: 'Pessoa A', approvedUserId: 'person-a', approvedAt: '2026-10-06T12:00:00.000Z' },
    toolSteps: [{ title: 'Status do canal', autoApproved: true, completedAt: '2026-10-06T11:59:59.000Z' }, { proposalId: 'proposal-b', title: 'Pedido externo', autoApproved: false, completedAt: '2026-10-06T12:00:01.000Z' }] });
  const markup = timeline(f, human);
  assert.match(markup, new RegExp(`Pessoa A aprovou Remoto › Pedido externo · ${clockTime('2026-10-06T12:00:00.000Z')}`));
  assert.match(markup, /Consulta automática · Status do canal/); assert.doesNotMatch(markup, /Consulta automática · Pedido externo/);
});

test('recibo resumido de consulta interna explica que o conteúdo foi só para o copiloto, em PT e EN', () => {
  const f = ui();
  const summary = run({ toolReceipt: { state: 'completed', proposalId: 'proposal-a', autoApproved: true, approvedAt: '2026-10-06T12:00:00.000Z', summarized: true,
    result: { content: [{ type: 'text', text: '{}' }], isError: false, structuredContent: { state: 'matched', results: [{ title: 'Política <garantia>' }] } } } });
  try {
    setLocale('pt-BR', { persist: false, notify: false });
    const pt = timeline(f, summary);
    assert.match(pt, /Resumo da consulta\. O conteúdo completo foi entregue somente ao copiloto\./); assert.match(pt, /Política &lt;garantia&gt;/); assert.match(pt, /<\/small><\/details>/);
    setLocale('en', { persist: false, notify: false });
    assert.match(timeline(f, summary), /Lookup summary\. The full content was delivered only to the copilot\./);
    assert.doesNotMatch(timeline(f, run()), /Lookup summary/);
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
});
