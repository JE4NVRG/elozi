import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowTemplate, createFlowDraftGuard, createFlowWorkspace, flowLayout, flowNodeSummary, FLOW_LAYOUT } from '../public/flow-workspace-ui.js';
import { setLocale } from '../public/i18n.js';
import { validateFlowEditorGraph } from '../public/flow-departments-ui.js';

test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));
test('conditional templates use the same department ID in both languages, without editing source data', () => {
  const departments = [{ id: 'dept-a', name: 'Suporte', active: true }, { id: 'dept-b', name: 'Support', active: true }];
  const original = JSON.stringify(departments), graphs = [];
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const graph = createFlowTemplate('conditional', { departmentId: 'dept-a', departments });
    assert.equal(graph.departmentReferenceFormat, 'id-v1');
    assert.equal(graph.nodes.find(node => node.type === 'department').config.department, 'dept-a');
    assert.deepEqual(validateFlowEditorGraph(graph), graph); graphs.push(graph);
  }
  assert.deepEqual(graphs[0], graphs[1]); assert.equal(JSON.stringify(departments), original);
});
test('triage never guesses a department by translated name, inactive record or ambiguous ID', () => {
  for (const options of [{}, { departmentId: 'Suporte', departments: [{ id: 'd', name: 'Suporte' }] },
    { departmentId: 'd', departments: [{ id: 'd', active: false }] }, { departmentId: 'd', departments: [{ id: 'd' }, { id: 'd' }] }]) {
    assert.throws(() => createFlowTemplate('conditional', options), /departamento ativo/);
  }
  assert.equal(createFlowTemplate().departmentReferenceFormat, 'id-v1');
});

function fixture() {
  const context = { key: 'workspace:tenant:flow-a', revision: 3, dirty: true, name: 'Meu fluxo' };
  const listeners = new Map(), feedback = { textContent: '' }, controls = ['cancel', 'discard', 'save'].map(choice => ({ dataset: { flowDraftChoice: choice }, disabled: false, focus() {} }));
  const modal = { open: false, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    querySelector(selector) { return selector === '.form-error' ? feedback : controls[0]; }, querySelectorAll() { return controls; },
    close() { this.open = false; for (const fn of [...listeners.get('close') || []]) fn({}); } };
  let saves = 0, discards = 0, rejectSave = false, markup = '';
  const guard = createFlowDraftGuard({ getContext: () => ({ ...context }), getModal: () => modal, escape: String,
    openModal(title, description, body) { markup = body; modal.open = true; },
    async save() { saves++; if (rejectSave) throw new Error('Conflito de versão'); context.revision++; context.dirty = false; },
    discard() { discards++; context.dirty = false; } });
  const click = async choice => { const control = controls.find(item => item.dataset.flowDraftChoice === choice); for (const fn of [...listeners.get('click') || []]) await fn({ target: { closest: () => control } }); };
  return { context, modal, feedback, controls, guard, click, listeners, get saves() { return saves; }, get discards() { return discards; },
    get markup() { return markup; }, reject(value) { rejectSave = value; } };
}
test('cancel or dialog close retains the draft and performs no API save', async () => {
  for (const action of ['cancel', 'close']) {
    const f = fixture(), decision = f.guard.confirm();
    if (action === 'cancel') await f.click('cancel'); else f.modal.close();
    assert.equal(await decision, false); assert.equal(f.context.dirty, true); assert.equal(f.saves, 0); assert.equal(f.discards, 0);
    assert.ok([...f.listeners.values()].every(set => set.size === 0));
  }
});
test('save and discard are explicit, distinct decisions and are localized', async () => {
  setLocale('en', { persist: false, notify: false });
  for (const action of ['save', 'discard']) {
    const f = fixture(), decision = f.guard.confirm(); assert.match(f.markup, /Save and continue/);
    await f.click(action); assert.equal(await decision, true); assert.equal(f.context.dirty, false);
    assert.equal(f.saves, action === 'save' ? 1 : 0); assert.equal(f.discards, action === 'discard' ? 1 : 0);
  }
});
test('a failed save keeps the same modal and draft available for correction', async () => {
  const f = fixture(); f.reject(true); const decision = f.guard.confirm(); await f.click('save');
  assert.equal(f.context.dirty, true); assert.equal(f.modal.open, true); assert.equal(f.feedback.textContent, 'Conflito de versão');
  assert.ok(f.controls.every(control => !control.disabled));
  f.reject(false); await f.click('save'); assert.equal(await decision, true); assert.equal(f.saves, 2);
});
test('stale context and repeated confirmation cannot discard a different flow', async () => {
  const f = fixture(), decision = f.guard.confirm(); assert.equal(await f.guard.confirm(), false);
  f.context.key = 'workspace:other-tenant:flow-b'; await f.click('discard');
  assert.equal(await decision, false); assert.equal(f.discards, 0); assert.equal(f.saves, 0); assert.equal(f.context.dirty, true);
});
test('a clean flow continues without opening a modal', async () => {
  const f = fixture(); f.context.dirty = false; assert.equal(await f.guard.confirm(), true); assert.equal(f.modal.open, false);
});

test('the draft guard keeps its hooks (.form-error, data-flow-draft-choice) on the new components', async () => {
  const f = fixture(), decision = f.guard.confirm();
  assert.match(f.markup, /class="pg-automation__guard" data-flow-draft-guard/);
  for (const choice of ['cancel', 'discard', 'save']) assert.match(f.markup, new RegExp(`class="ui-btn [^"]*"[^>]*data-flow-draft-choice="${choice}"`));
  assert.match(f.markup, /class="pg-automation__form-error form-error" role="alert"/);
  assert.doesNotMatch(f.markup, /class="button|modal-actions/);
  await f.click('cancel'); assert.equal(await decision, false);
});

// ---- Fluxos screen (FRONTEND-V2 §8.9, P8-B) ------------------------------------------------------

const triage = () => ({ departmentReferenceFormat: 'id-v1', nodes: [
  { id: 'start', type: 'start', config: {} },
  { id: 'condition', type: 'condition', config: { field: 'text', operator: 'contains', value: 'suporte' } },
  { id: 'support', type: 'department', config: { department: 'dept-a' } },
  { id: 'queue', type: 'handoff', config: { owner: 'queue' } },
  { id: 'end', type: 'end', config: {} }
], edges: [{ from: 'start', to: 'condition' }, { from: 'condition', to: 'support', when: true }, { from: 'condition', to: 'queue', when: false }, { from: 'support', to: 'end' }, { from: 'queue', to: 'end' }] });

function workspace({ role = 'reseller', flows } = {}) {
  const state = { workspaceId: 'w-a', supportGrantId: null, boot: { session: { role } }, tenant: { id: 't-a', departments: [{ id: 'dept-a', name: 'Suporte <N1>', active: true }] },
    flows: flows || [{ id: 'flow-a', name: 'Triagem', state: 'published', version: 5, publishedVersion: 2, versions: [{ version: 1 }, { version: 2 }], graph: triage() }, { id: 'flow-b', name: 'Fila', state: 'draft', version: 1, publishedVersion: null, versions: [], graph: createFlowTemplate() }] };
  const calls = [], opened = [], wanted = []; let renders = 0, respond = null;
  const outcome = () => ({ steps: [{ nodeId: 'start', type: 'start' }, { nodeId: 'condition', type: 'condition', matched: true }, { nodeId: 'support', type: 'department' }, { nodeId: 'end', type: 'end' }], output: { department: 'Suporte <N1>', owner: 'queue', tags: [] }, draftVersion: 5 });
  const ui = createFlowWorkspace({ state, render: () => { renders++; }, request: async (path, options) => { calls.push({ path, ...options, body: JSON.parse(options.body) }); return respond ? respond() : outcome(); },
    tenantPath: tail => `/api/tenants/${state.tenant.id}/${tail}`, toast: () => {}, dialogs: { open: options => { opened.push({ ...options, body: String(options.body) }); return true; } }, focus: { want: key => wanted.push(key) } });
  return { ui, state, calls, opened, wanted, get renders() { return renders; }, respond(fn) { respond = fn; } };
}
const input = (key, value, tagName = 'INPUT') => ({ matches: selector => selector === '[data-automation-node-config]', dataset: { automationNodeConfig: key }, value, tagName, closest: () => null });

test('layout: rows by longest path from the entry, columns per row and edges from bottom to top of each step', () => {
  const layout = flowLayout(triage());
  assert.equal(layout.rows, 4); assert.equal(layout.columns, 2);
  assert.deepEqual(layout.nodes.map(item => [item.node.id, item.row, item.column, item.columns]), [['start', 0, 0, 1], ['condition', 1, 0, 1], ['support', 2, 0, 2], ['queue', 2, 1, 2], ['end', 3, 0, 1]]);
  const yes = layout.edges.find(edge => edge.to === 'support');
  assert.equal(yes.branch, 'yes'); assert.equal(yes.x1, 500); assert.equal(yes.x2, 250);
  assert.equal(yes.y1, FLOW_LAYOUT.padding + (FLOW_LAYOUT.nodeHeight + FLOW_LAYOUT.rowGap) + FLOW_LAYOUT.nodeHeight); assert.equal(yes.y2, FLOW_LAYOUT.padding + 2 * (FLOW_LAYOUT.nodeHeight + FLOW_LAYOUT.rowGap));
  const loop = flowLayout({ nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'tag' }], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'start' }, { from: 'a', to: 'missing' }] });
  assert.ok(loop.rows <= 3, 'a malformed cycle cannot loop'); assert.equal(loop.edges.length, 2, 'edges to unknown steps are dropped');
  assert.equal(flowLayout(null).height, 0);
});

test('summaries keep the legacy wording and resolve departments by ID', () => {
  const graph = triage();
  assert.equal(flowNodeSummary(graph.nodes[1]), 'Mensagem · contém suporte');
  assert.equal(flowNodeSummary(graph.nodes[2], { departments: [{ id: 'dept-a', name: 'Suporte' }], format: 'id-v1' }), 'Suporte');
  assert.equal(flowNodeSummary(graph.nodes[2], { departments: [], format: 'id-v1' }), 'Revise o departamento');
  assert.equal(flowNodeSummary({ type: 'tag', config: { operation: 'remove', tag: 'vip' } }), 'Remover vip');
  assert.equal(flowNodeSummary({ type: 'condition', config: {} }), 'Defina a condição');
});

test('the editor draws a readable diagram, explicit draft and publication state and escapes customer copy', () => {
  const w = workspace(), view = String(w.ui.view({ section: 'automation', params: { tab: 'flows' } }));
  assert.equal(w.state.flowId, 'flow-a', 'the first flow opens like the legacy screen');
  assert.match(view, /<ol class="pg-automation__nodes" aria-label="Passos do fluxo, de cima para baixo">/);
  assert.ok((view.match(/data-action="automation:flow-node"/g) || []).length >= 5);
  assert.match(view, /aria-describedby="automation-node-exits-1"/); assert.match(view, /id="automation-node-exits-1">Se sim: Departamento: Suporte &lt;N1&gt;\. Se não: Transferência: Fila da equipe\./);
  assert.match(view, /class="pg-automation__edge-label" data-branch="yes"/); assert.match(view, /<svg class="pg-automation__edges" viewBox="0 0 1000 /);
  assert.match(view, /<dt>Rascunho<\/dt><dd>Salvo · edição v5<\/dd>/); assert.match(view, /<dt>Publicação<\/dt><dd>v2 em uso · igual ao rascunho<\/dd>/);
  assert.match(view, /data-flow-id="flow-b"/); assert.match(view, /ui-badge--neutral">Rascunho/); assert.match(view, /ui-badge--success">Publicada v2/);
  assert.match(view, /data-form="automation:simulate"/); assert.match(view, /id="automation-node-panel"/);
  assert.doesNotMatch(view, /style="[^"]*#[0-9a-f]{3,6}/i, 'positions only, never colors, inline');
});

test('selecting, adding and removing steps changes only the local draft, like the legacy editor', async () => {
  const w = workspace(); w.ui.view({ section: 'automation', params: { tab: 'flows' } });
  await w.ui.act('automation:flow-node', 'queue');
  assert.equal(w.state.flowNode, 'queue'); assert.equal(w.state.flowDirty, false); assert.equal(w.wanted.at(-1), 'node:queue');
  const select = { value: 'department' };
  await w.ui.act('automation:add-flow-node', null, { closest: () => ({ querySelector: () => select }) });
  const added = w.state.flowDraft.nodes.at(-1);
  assert.equal(added.type, 'department'); assert.deepEqual(added.config, { department: 'Atendimento' }); assert.equal(w.state.flowNode, added.id); assert.equal(w.state.flowDirty, true);
  assert.ok(w.state.flowDraft.edges.some(edge => edge.from === added.id && edge.to === 'end')); assert.ok(!w.state.flowDraft.edges.some(edge => edge.from === 'support' && edge.to === 'end'));
  assert.equal(w.calls.length, 0, 'no request: the draft is saved by Salvar rascunho');
  await w.ui.act('automation:delete-flow-node', added.id);
  assert.ok(!w.state.flowDraft.nodes.some(node => node.id === added.id)); assert.ok(w.state.flowDraft.edges.some(edge => edge.from === 'support' && edge.to === 'end'));
  await assert.rejects(w.ui.act('automation:delete-flow-node', 'condition'), /não pode ser removido/);
  assert.equal(w.renders, 3);
});

test('typing in a step updates the draft without a render; a select change renders and keeps the focus on it', () => {
  const w = workspace(); w.ui.view({ section: 'automation', params: { tab: 'flows' } });
  w.state.flowNode = 'condition';
  assert.equal(w.ui.handleInput({ type: 'input', target: input('value', 'financeiro') }), true);
  assert.equal(w.state.flowDraft.nodes[1].config.value, 'financeiro'); assert.equal(w.state.flowDirty, true); assert.equal(w.renders, 0);
  assert.equal(w.state.flows[0].graph.nodes[1].config.value, 'suporte', 'the published graph is never edited');
  w.ui.handleInput({ type: 'change', target: input('operator', 'equals', 'SELECT') });
  assert.equal(w.state.flowDraft.nodes[1].config.operator, 'equals'); assert.equal(w.renders, 1); assert.equal(w.wanted.at(-1), 'node-config:operator');
  assert.match(String(w.ui.view()), /<dt>Rascunho<\/dt><dd>Alterações locais não salvas<\/dd>/);
  assert.equal(w.ui.handleInput({ type: 'input', target: { matches: () => false } }), false);
});

test('only the administration edits: read-only screen and refused actions for other roles', async () => {
  const w = workspace({ role: 'operator' }), view = String(w.ui.view({ section: 'automation', params: { tab: 'flows' } }));
  assert.doesNotMatch(view, /save-flow|automation:publish-flow|automation:add-flow-node|automation:delete-flow-node|new-flow/);
  assert.match(view, /fieldset--bare" disabled>/); assert.match(view, /Somente a administração altera os fluxos/); assert.match(view, /Ver estrutura avançada/);
  w.state.flowNode = 'condition';
  w.ui.handleInput({ type: 'input', target: input('value', 'nada') });
  assert.equal(w.state.flowDraft.nodes[1].config.value, 'suporte'); assert.equal(w.state.flowDirty, false);
  await assert.rejects(w.ui.act('automation:add-flow-node'), /Somente a administração/);
  await assert.rejects(w.ui.act('automation:publish-flow'), /Somente a administração/);
});

test('simulation posts the saved draft text, refuses local changes and shows the path and output', async () => {
  const w = workspace(); w.ui.view({ section: 'automation', params: { tab: 'flows' } });
  const form = text => ({ dataset: { form: 'automation:simulate' }, elements: { namedItem: () => ({ value: text }) } });
  await w.ui.submit(form('Preciso de suporte'));
  assert.deepEqual(w.calls.map(call => [call.path, call.method, call.body]), [['/api/tenants/t-a/flows/flow-a/simulate', 'POST', { text: 'Preciso de suporte' }]]);
  assert.equal(w.wanted.at(-1), 'sim-result');
  const view = String(w.ui.view());
  assert.match(view, /<h3 class="pg-automation__result-title" id="automation-result-title" tabindex="-1"[^>]*>Resultado da simulação<\/h3>/);
  assert.match(view, /condição atendida/); assert.match(view, /Suporte &lt;N1&gt;/); assert.match(view, />Preciso de suporte<\/textarea>/, 'the test message stays for the next run');
  assert.match(view, /class="pg-automation__edge" d="[^"]*" data-state="traced"/); assert.match(view, /\(percorrido na simulação\)/);
  w.state.flowDirty = true;
  await assert.rejects(w.ui.submit(form('Outra')), /Salve as alterações antes de testar/); assert.equal(w.calls.length, 1);
  w.state.flowDirty = false; w.state.flowResult = null;
  w.respond(() => { w.state.tenant = { id: 't-b' }; return { steps: [{ nodeId: 'start', type: 'start' }] }; });
  await w.ui.submit(form('Troca de empresa'));
  assert.equal(w.state.flowResult, null, 'a result that arrives after the company changed is not kept');
});

test('publication is confirmed in a dialog whose confirm button is the legacy publish-flow handler', async () => {
  const w = workspace(); w.ui.view({ section: 'automation', params: { tab: 'flows' } });
  await w.ui.act('automation:publish-flow', null, { focus() {} });
  const dialog = w.opened.at(-1);
  assert.equal(dialog.title, 'Publicar fluxo'); assert.equal(dialog.returnKey, 'flow-publish');
  assert.match(dialog.body, /O rascunho salvo \(edição v5\) vira a versão publicada v3\./); assert.match(dialog.body, /A versão v2 continua no histórico/);
  assert.match(dialog.body, /data-action="publish-flow"/); assert.match(dialog.body, /data-action="automation:close-dialog"/);
  w.state.flowDirty = true; await w.ui.act('automation:publish-flow');
  assert.match(w.opened.at(-1).body, /As alterações locais serão salvas e o rascunho vira a versão publicada v3\./);
  assert.equal(w.calls.length, 0, 'opening the confirmation publishes nothing');
});

test('a link #automation/flows/<id> opens that flow when clean and never discards local changes', () => {
  const w = workspace(); w.ui.view({ section: 'automation', params: { tab: 'flows' } });
  w.ui.view({ section: 'automation', params: { tab: 'flows', id: 'flow-b' } });
  assert.equal(w.state.flowId, 'flow-b');
  w.state.flowDirty = true; w.state.flowDraft.nodes[1].config.owner = 'human';
  w.ui.view({ section: 'automation', params: { tab: 'flows', id: 'flow-a' } });
  assert.equal(w.state.flowId, 'flow-b'); assert.equal(w.state.flowDraft.nodes[1].config.owner, 'human');
});

test('after a render the hash names the open flow without a new history entry', t => {
  const previous = { history: globalThis.history, location: globalThis.location }, replaced = [];
  globalThis.history = { state: { kept: true }, replaceState(state, title, url) { replaced.push([state, url]); } };
  globalThis.location = { hash: '#automation/flows' };
  t.after(() => { globalThis.history = previous.history; if (previous.location === undefined) delete globalThis.location; else globalThis.location = previous.location; });
  const w = workspace(); w.state.screenRoutes = {}; w.ui.view({ section: 'automation', params: { tab: 'flows' } }); w.ui.afterRender();
  assert.deepEqual(replaced, [[{ kept: true }, '#automation/flows/flow-a']]);
  assert.equal(w.state.screenRoutes.flows, JSON.stringify(['automation', { tab: 'flows', id: 'flow-a' }]));
  globalThis.location.hash = '#automation/flows/flow-a'; w.ui.afterRender(); assert.equal(replaced.length, 1);
});

test('empty company: one primary action for the administration, an explanation for everyone else', () => {
  const admin = String(workspace({ flows: [] }).ui.view());
  assert.match(admin, /Nenhum fluxo nesta empresa/); assert.equal((admin.match(/ui-btn--primary/g) || []).length, 1); assert.match(admin, /data-action="new-flow"/);
  const reader = String(workspace({ role: 'operator', flows: [] }).ui.view());
  assert.match(reader, /A administração cria e publica os fluxos/); assert.doesNotMatch(reader, /ui-btn--primary/);
});

test('flows screen in English keeps flow names and step IDs as written', () => {
  setLocale('en', { persist: false, notify: false });
  const view = String(workspace().ui.view({ section: 'automation', params: { tab: 'flows' } }));
  assert.match(view, />Flows</); assert.match(view, /Flow steps, top to bottom/); assert.match(view, /Saved · edit v5/); assert.match(view, />Triagem</); assert.match(view, /Simulate saved draft/);
});
