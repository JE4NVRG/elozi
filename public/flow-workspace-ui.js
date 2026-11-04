import { t, h, raw, escapeHTML } from './i18n.js';
import './locales-product-review.js';
import './locales-operations.js';
import { button, iconButton, badge, banner, emptyState, attributes } from './ui.js';
import { glyph } from './icons.js';
import { formatHash } from './router.js';
import { flowEditorGraph, flowDepartment, flowDepartmentOptions } from './flow-departments-ui.js';

// Automação › Fluxos (FRONTEND-V2 §2.1, §8.9; P8-B). createFlowWorkspace draws the flows screen
// (views.flows, wired by automation-ui.js through the automationUI.views merge of app.js) on the
// design tokens (.pg-automation__*, public/automation.css). The versioned behaviour stays where it
// was: selecting a flow in the library (data-flow-id: unsaved-draft guard), Novo fluxo (new-flow),
// Salvar rascunho (save-flow, CAS on flow.version), the advanced JSON (flow-json) and the publication
// itself (publish-flow, reached only from the confirmation dialog) are the legacy handlers of app.js.
// This module owns the editing of the local draft (select a step, change its configuration, add or
// remove a step), the simulation of the saved draft and the publication confirmation, all through
// 'automation:*' actions and the data-form="automation:simulate" form of the actions registry.

/** Templates store department IDs, independently of the panel language. */
export function createFlowTemplate(kind = 'linear', { departmentId = '', departments = [] } = {}) {
  const graph = { departmentReferenceFormat: 'id-v1', nodes: [
    { id: 'start', type: 'start', config: {} },
    { id: 'handoff', type: 'handoff', config: { owner: 'queue' } },
    { id: 'end', type: 'end', config: {} }
  ], edges: [{ from: 'start', to: 'handoff' }, { from: 'handoff', to: 'end' }] };
  if (kind !== 'conditional') return graph;
  const matches = departments.filter(item => item.id === departmentId && item.active !== false);
  if (!departmentId || matches.length !== 1) throw new Error(t('Escolha um departamento ativo para a triagem.'));
  return { departmentReferenceFormat: 'id-v1', nodes: [
    graph.nodes[0],
    { id: 'condition', type: 'condition', config: { field: 'text', operator: 'contains', value: 'suporte' } },
    { id: 'support', type: 'department', config: { department: matches[0].id } },
    { id: 'queue', type: 'handoff', config: { owner: 'queue' } }, graph.nodes[2]
  ], edges: [{ from: 'start', to: 'condition' }, { from: 'condition', to: 'support', when: true },
    { from: 'condition', to: 'queue', when: false }, { from: 'support', to: 'end' }, { from: 'queue', to: 'end' }] };
}

/** One pending decision; failures and stale contexts retain the local draft. */
export function createFlowDraftGuard({ getContext, openModal, getModal, save, discard, escape }) {
  let pending = false;
  const same = before => {
    const current = getContext();
    return current.key === before.key && current.revision === before.revision;
  };
  return {
    async confirm() {
      const before = getContext();
      if (before.busy) return false;
      if (!before.dirty) return true;
      if (pending || getModal()?.open) return false;
      pending = true;
      return new Promise(resolve => {
        let busy = false, settled = false;
        // .form-error and data-flow-draft-choice are the hooks of this guard (and of the tests that
        // drive it); the look comes from .pg-automation__* and the ui-btn components.
        try { openModal(t('Há alterações no fluxo'), before.name || t('Fluxo'), String(h`<div class="pg-automation__guard" data-flow-draft-guard>
          <p class="pg-automation__dialog-text">Salve o rascunho para continuar ou descarte somente as alterações locais deste fluxo.</p>
          <p class="pg-automation__form-error form-error" role="alert"></p><div class="pg-automation__dialog-actions">
            ${button({ label: t('Continuar editando'), variant: 'ghost', attrs: { 'data-flow-draft-choice': 'cancel' } })}
            ${button({ label: t('Descartar alterações'), variant: 'secondary', attrs: { 'data-flow-draft-choice': 'discard' } })}
            ${button({ label: t('Salvar e continuar'), variant: 'primary', attrs: { 'data-flow-draft-choice': 'save' } })}
          </div></div>`)); } catch (error) { pending = false; throw error; }
        const modal = getModal();
        const settle = (value, close = true) => {
          if (settled) return;
          settled = true; pending = false;
          modal.removeEventListener('click', choose); modal.removeEventListener('close', closed); modal.removeEventListener('cancel', cancelled);
          if (close && modal.open) modal.close();
          resolve(value);
        };
        const closed = () => settle(false, false);
        const cancelled = event => { if (busy) event.preventDefault(); };
        const choose = async event => {
          const button = event.target.closest('[data-flow-draft-choice]');
          if (!button || busy) return;
          const decision = button.dataset.flowDraftChoice;
          if (decision === 'cancel') return settle(false);
          if (!same(before)) return settle(false);
          busy = true;
          const controls = [...modal.querySelectorAll('button')]; controls.forEach(control => { control.disabled = true; });
          const error = modal.querySelector('.form-error'); error.textContent = '';
          try {
            if (decision === 'save') await save();
            else if (decision === 'discard') discard();
            else return settle(false);
            const current = getContext();
            // Saving may update the revision; the identity must remain the same.
            settle(current.key === before.key && !current.dirty);
          } catch (failure) {
            if (!same(before) || !modal.open) return settle(false);
            error.textContent = String(failure?.message || t('Não foi possível salvar o fluxo. Tente novamente.'));
          } finally { busy = false; if (!settled) controls.forEach(control => { control.disabled = false; }); }
        };
        modal.addEventListener('click', choose); modal.addEventListener('close', closed); modal.addEventListener('cancel', cancelled);
        modal.querySelector('[data-flow-draft-choice="cancel"]')?.focus();
      });
    }
  };
}

// ---- pure helpers (tests and the screen) -------------------------------------------------------

export const FLOW_NODE_GLYPHS = Object.freeze({ start: 'link', condition: 'code', tag: 'palette', department: 'building', handoff: 'users', end: 'check' });
/** Name of each step type in the panel language (read on every call: the locale can change). */
export function flowNodeTypes() {
  return { start: t('Entrada'), condition: t('Condição'), tag: t('Etiqueta'), department: t('Departamento'), handoff: t('Transferência'), end: t('Concluir') };
}

/** One line that says what a step does (same wording as the legacy editor). */
export function flowNodeSummary(node, { departments = [], format } = {}) {
  const config = node?.config || {};
  if (node?.type === 'condition') {
    const field = { text: t('Mensagem'), tag: t('Etiqueta'), department: t('Departamento'), owner: t('Responsável'), channelKind: t('Canal') }[config.field] || config.field;
    const operator = { contains: t('contém'), equals: t('é igual a'), exists: t('existe') }[config.operator] || config.operator;
    return field || operator ? `${field || ''} · ${operator || ''} ${config.value || ''}`.trim() : t('Defina a condição');
  }
  if (node?.type === 'tag') return `${config.operation === 'remove' ? t('Remover') : t('Adicionar')} ${config.tag || t('etiqueta')}`;
  if (node?.type === 'department') return config.department ? flowDepartment(config.department, departments, format)?.name || t('Revise o departamento') : t('Escolha o departamento');
  if (node?.type === 'handoff') return config.owner === 'human' ? t('Atendimento humano') : t('Fila da equipe');
  return node?.type === 'start' ? t('Receber contexto da conversa') : t('Aplicar o resultado da rota');
}

// Geometry of the diagram. Rows are the longest path from the entry (like the legacy editor); the
// edges are drawn in an SVG whose x axis is 0–1000 across the canvas width (the canvas is fluid) and
// whose y axis is in pixels. The constants are the single source: the markup passes them to CSS.
export const FLOW_LAYOUT = Object.freeze({ nodeHeight: 72, rowGap: 48, padding: 8, columnWidth: 156 });

/** Rows, positions and edges of a flow graph; pure (no DOM), so the layout is testable. */
export function flowLayout(graph, { nodeHeight = FLOW_LAYOUT.nodeHeight, rowGap = FLOW_LAYOUT.rowGap, padding = FLOW_LAYOUT.padding } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.filter(node => node && typeof node.id === 'string') : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges.filter(edge => edge && nodes.some(node => node.id === edge.from) && nodes.some(node => node.id === edge.to)) : [];
  const depth = new Map(), start = nodes.find(node => node.type === 'start');
  if (start) {
    // Longest path from the entry, bounded by the number of steps (a malformed cycle cannot loop).
    depth.set(start.id, 0);
    for (let round = 0; round < nodes.length; round++) {
      let changed = false;
      for (const edge of edges) {
        if (!depth.has(edge.from)) continue;
        const next = Math.min(nodes.length, depth.get(edge.from) + 1);
        if (!depth.has(edge.to) || depth.get(edge.to) < next) { depth.set(edge.to, next); changed = true; }
      }
      if (!changed) break;
    }
  }
  const rows = new Map();
  for (const node of nodes) { const row = depth.get(node.id) || 0; if (!rows.has(row)) rows.set(row, []); rows.get(row).push(node); }
  const ordered = [...rows.keys()].sort((a, b) => a - b), pitch = nodeHeight + rowGap, place = new Map();
  ordered.forEach((row, index) => rows.get(row).forEach((node, column, list) => place.set(node.id, {
    node, row: index, column, columns: list.length, x: 1000 * (column + .5) / list.length, y: padding + index * pitch
  })));
  const placed = [...place.values()].sort((a, b) => a.row - b.row || a.column - b.column);
  const lines = edges.map(edge => {
    const from = place.get(edge.from), to = place.get(edge.to);
    const branch = edge.when === true || edge.when === 'true' ? 'yes' : edge.when === false || edge.when === 'false' ? 'no' : null;
    return { from: edge.from, to: edge.to, branch, x1: from.x, y1: from.y + nodeHeight, x2: to.x, y2: to.y };
  });
  const height = ordered.length ? padding * 2 + (ordered.length - 1) * pitch + nodeHeight : 0;
  return { nodes: placed, edges: lines, rows: ordered.length, columns: Math.max(1, ...placed.map(item => item.columns)), height, nodeHeight };
}

const round = value => Math.round(value * 100) / 100;
const flowHash = id => { try { return formatHash({ section: 'automation', params: id ? { tab: 'flows', id } : { tab: 'flows' } }); } catch { return '#automation/flows'; } };

/**
 * The Fluxos screen. deps: state (app.js), render(), request(path, options) (app.js api),
 * tenantPath(tail) (app.js tenantApi), toast(message, error), dialogs (automation-ui.js dialog host)
 * and focus (automation-ui.js focus memory: want(key)).
 * Returns {view(route), act(name, id, element), submit(form), handleInput(event), afterRender(root), reset()}.
 */
export function createFlowWorkspace(deps = {}) {
  const { state = {}, dialogs = null, focus = null } = deps;
  const render = () => deps.render?.();
  const request = (path, options) => deps.request(path, options);
  const tenantPath = tail => deps.tenantPath(tail);
  const admin = () => state.boot?.session?.role === 'reseller';
  const scope = () => JSON.stringify([state.workspaceId || null, state.supportGrantId || null, state.tenant?.id || null, state.flowId || null]);
  // routeFlow: the flow id of the last route applied (a link #automation/flows/<id>); simulation: the
  // typed test message (kept across renders); announced: the dirty state already said to screen readers.
  let routeFlow = null, simulation = '', simulating = false, announced = false;

  const departments = () => state.tenant?.departments || [];
  const summary = node => flowNodeSummary(node, { departments: departments(), format: state.flowDraft?.departmentReferenceFormat });
  const currentFlow = () => (state.flows || []).find(item => item.id === state.flowId) || null;

  /** Same selection as app.js selectFlow (the draft of the flow, its first step, clean). */
  function selectFlow(id) {
    const flow = (state.flows || []).find(item => item.id === id);
    state.flowId = flow?.id || null; state.flowDraft = flow ? flowEditorGraph(flow) || null : null; state.flowNode = flow?.graph?.nodes?.[0]?.id || null; state.flowDirty = false; state.flowResult = null;
  }

  // A link #automation/flows/<id> opens that flow, unless the open one has local changes (they are
  // never discarded by a link; the library click keeps the save/discard guard of app.js).
  function applyRoute(route) {
    const id = route?.section === 'automation' && route.params?.tab === 'flows' ? route.params.id || null : null;
    if (!id || id === routeFlow) return;
    routeFlow = id;
    if (id !== state.flowId && !state.flowDirty && (state.flows || []).some(item => item.id === id)) selectFlow(id);
  }

  // ---- markup -------------------------------------------------------------------------------

  function header() {
    const action = admin() && (state.flows || []).length ? button({ label: t('Novo fluxo'), action: 'new-flow', variant: 'primary', icon: 'plus', attrs: { 'data-automation-focus': 'flow-new', 'aria-haspopup': 'dialog' } }) : '';
    return h`<header class="pg-automation__head"><div class="pg-automation__head-text"><h1 class="pg-automation__title">${t('Fluxos')}</h1><p class="pg-automation__lead">${t('Rotas versionadas que organizam cada nova entrada: condições, etiquetas, departamentos e transferências.')}</p></div>${action ? h`<div class="pg-automation__head-actions">${action}</div>` : ''}</header>`;
  }

  function publicationBadge(flow) {
    if (!flow.publishedVersion) return badge(t('Rascunho'), 'neutral');
    return flow.state === 'draft' ? badge(t('Mudanças não publicadas'), 'warning') : badge(t('Publicada v{version}', { version: flow.publishedVersion }), 'success');
  }

  function library() {
    const flows = state.flows || [];
    return h`<section class="pg-automation__library" aria-labelledby="automation-library-title"><h2 class="pg-automation__section-title" id="automation-library-title">${t('Seus fluxos')} <span class="pg-automation__count">${flows.length}</span></h2><ul class="pg-automation__library-list">${flows.map(flow => {
      const current = flow.id === state.flowId;
      const meta = flow.publishedVersion && flow.state === 'draft' ? t('Em uso: v{published} · edição v{version}', { published: flow.publishedVersion, version: flow.version }) : t('Edição v{version}', { version: flow.version });
      return h`<li><button type="button" class="pg-automation__library-item"${attributes({ 'data-flow-id': flow.id, 'aria-current': current ? 'true' : null, 'data-automation-focus': `flow:${flow.id}` })}><span class="pg-automation__library-name">${flow.name}</span><span class="pg-automation__library-meta">${publicationBadge(flow)}<span>${meta}</span></span></button></li>`;
    })}</ul></section>`;
  }

  function stateLines(flow) {
    const dirty = Boolean(state.flowDirty);
    const draft = dirty ? t('Alterações locais não salvas') : t('Salvo · edição v{version}', { version: flow.version });
    const publication = !flow.publishedVersion ? t('Nenhuma versão publicada') : flow.state === 'draft' ? t('v{version} em uso · o rascunho tem mudanças não publicadas', { version: flow.publishedVersion }) : t('v{version} em uso · igual ao rascunho', { version: flow.publishedVersion });
    return h`<dl class="pg-automation__flow-state" data-automation-flow-state><div class="pg-automation__state-item"${attributes({ 'data-tone': dirty ? 'warning' : 'neutral' })}><dt>${t('Rascunho')}</dt><dd>${draft}</dd></div><div class="pg-automation__state-item"${attributes({ 'data-tone': flow.publishedVersion ? flow.state === 'draft' ? 'warning' : 'success' : 'neutral' })}><dt>${t('Publicação')}</dt><dd>${publication}</dd></div></dl>`;
  }

  function exitsOf(node) {
    const graph = state.flowDraft, labels = flowNodeTypes();
    return (graph?.edges || []).filter(edge => edge.from === node.id).map(edge => {
      const target = graph.nodes.find(item => item.id === edge.to);
      const branch = edge.when === true || edge.when === 'true' ? t('Se sim') : edge.when === false || edge.when === 'false' ? t('Se não') : t('Próximo');
      return { branch, target, label: target ? `${labels[target.type] || target.type}: ${summary(target)}` : t('Passo indisponível') };
    });
  }

  function exitsText(node) {
    const exits = exitsOf(node);
    if (!exits.length) return node.type === 'end' ? t('Fim da rota.') : t('Sem saída.');
    return exits.map(exit => `${exit.branch}: ${exit.label}.`).join(' ');
  }

  function canvas() {
    const layout = flowLayout(state.flowDraft), labels = flowNodeTypes(), steps = Array.isArray(state.flowResult?.steps) ? state.flowResult.steps : [];
    const visited = new Set(steps.map(step => step.nodeId));
    const walked = (from, to) => steps.some((step, index) => step.nodeId === from && steps[index + 1]?.nodeId === to);
    const incoming = new Set(layout.edges.map(edge => edge.to));
    const style = `--canvas-h:${layout.height}px;--canvas-cols:${layout.columns};--node-h:${layout.nodeHeight}px;--column-w:${FLOW_LAYOUT.columnWidth}px`;
    const paths = layout.edges.map(edge => {
      const bend = Math.max(16, (edge.y2 - edge.y1) / 2);
      return h`<path class="pg-automation__edge"${attributes({ d: `M${round(edge.x1)} ${edge.y1} C${round(edge.x1)} ${edge.y1 + bend} ${round(edge.x2)} ${edge.y2 - bend} ${round(edge.x2)} ${edge.y2}`, 'data-state': walked(edge.from, edge.to) ? 'traced' : null })}/>`;
    });
    const branchLabels = layout.edges.filter(edge => edge.branch).map(edge => h`<span class="pg-automation__edge-label"${attributes({ 'data-branch': edge.branch, 'data-state': walked(edge.from, edge.to) ? 'traced' : null, style: `--x:${round((edge.x1 + edge.x2) / 20)}%;--y:${round((edge.y1 + edge.y2) / 2)}px` })}>${edge.branch === 'yes' ? t('Sim') : t('Não')}</span>`);
    const items = layout.nodes.map(({ node, x, y, columns }, index) => {
      const selected = node.id === state.flowNode, traced = visited.has(node.id);
      return h`<li class="pg-automation__node-item"${attributes({ style: `--x:${round(x / 10)}%;--y:${y}px;--cols:${columns}`, 'data-incoming': incoming.has(node.id) ? 'true' : null })}><button type="button" class="pg-automation__node"${attributes({ 'data-type': node.type, 'data-action': 'automation:flow-node', 'data-id': node.id, 'data-automation-focus': `node:${node.id}`, 'aria-current': selected ? 'true' : null, 'aria-controls': 'automation-node-panel', 'aria-describedby': `automation-node-exits-${index}`, 'data-state': traced ? 'traced' : null })}><span class="pg-automation__node-icon" aria-hidden="true">${glyph(FLOW_NODE_GLYPHS[node.type] || 'activity')}</span><span class="pg-automation__node-text"><span class="pg-automation__node-type">${labels[node.type] || node.type}</span><small class="pg-automation__node-summary" data-automation-node-summary>${summary(node)}</small></span>${traced ? h`<span class="sr-only">${t('(percorrido na simulação)')}</span>` : ''}</button><span class="sr-only"${attributes({ id: `automation-node-exits-${index}` })}>${exitsText(node)}</span></li>`;
    });
    return h`<div class="pg-automation__canvas-scroll"><div class="pg-automation__canvas"${attributes({ style })}><svg class="pg-automation__edges" viewBox="${`0 0 1000 ${Math.max(1, layout.height)}`}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${paths}</svg>${branchLabels}<ol class="pg-automation__nodes" aria-label="${t('Passos do fluxo, de cima para baixo')}">${items}</ol></div></div>`;
  }

  function addStep() {
    return h`<div class="pg-automation__add-step" data-automation-add-step><label class="pg-automation__label" for="automation-new-node-type">${t('Adicionar passo antes da conclusão')}</label><div class="pg-automation__add-step-row"><select class="pg-automation__control" id="automation-new-node-type" data-automation-focus="node-type"><option value="tag">${t('Etiqueta')}</option><option value="department">${t('Departamento')}</option><option value="handoff">${t('Transferência')}</option></select>${button({ label: t('Adicionar passo'), action: 'automation:add-flow-node', variant: 'secondary', icon: 'plus', attrs: { 'data-automation-focus': 'node-add' } })}</div></div>`;
  }

  function editor(flow) {
    const isAdmin = admin();
    const actions = h`${isAdmin ? h`${button({ label: t('Salvar rascunho'), action: 'save-flow', variant: 'secondary', size: 'sm', icon: 'check', attrs: { 'data-automation-focus': 'flow-save' } })}${button({ label: t('Publicar'), action: 'automation:publish-flow', variant: 'primary', size: 'sm', icon: 'send', attrs: { 'data-automation-focus': 'flow-publish', 'aria-haspopup': 'dialog' } })}` : ''}${iconButton({ label: isAdmin ? t('Editar estrutura avançada') : t('Ver estrutura avançada'), icon: 'code', action: 'flow-json', attrs: { 'data-automation-focus': 'flow-json', 'aria-haspopup': 'dialog' } })}`;
    const issue = flow.editorReferenceIssue === true ? banner({ tone: 'warning', title: t('Revise os departamentos'), body: t('Há destinos indisponíveis neste fluxo. Escolha novamente os departamentos antes de salvar e publicar. A publicação anterior foi preservada.') }) : '';
    return h`<section class="pg-automation__editor" aria-labelledby="automation-flow-title"><div class="pg-automation__toolbar"><div class="pg-automation__toolbar-text"><h2 class="pg-automation__flow-name" id="automation-flow-title">${flow.name}</h2>${stateLines(flow)}</div><div class="pg-automation__toolbar-actions">${actions}</div></div><p class="sr-only" role="status" aria-live="polite" data-automation-flow-live></p>${issue}${canvas()}${isAdmin ? addStep() : ''}</section>`;
  }

  function nodeFields(node) {
    const config = node.config || {};
    const field = (key, label, control) => h`<div class="pg-automation__field"><label class="pg-automation__label"${attributes({ for: `automation-node-${key}` })}>${label}</label>${control}</div>`;
    const control = key => ({ class: 'pg-automation__control', id: `automation-node-${key}`, 'data-automation-node-config': key, 'data-automation-focus': `node-config:${key}` });
    const select = (key, label, value, options) => field(key, label, h`<select${attributes(control(key))}>${Object.entries(options).map(([id, name]) => h`<option${attributes({ value: id, selected: id === value })}>${name}</option>`)}</select>`);
    const input = (key, label, value, max = 100) => field(key, label, h`<input${attributes({ ...control(key), value: value ?? '', maxlength: max, autocomplete: 'off' })}/>`);
    const department = optional => field('department', optional ? t('Departamento (opcional)') : t('Departamento'), h`<select${attributes(control('department'))}>${raw(flowDepartmentOptions(config.department, departments(), { format: state.flowDraft?.departmentReferenceFormat, optional, escape: escapeHTML }))}</select>`);
    if (node.type === 'condition') return h`${select('field', t('Comparar'), config.field, { text: t('Texto da mensagem'), tag: t('Etiqueta'), department: t('Departamento'), owner: t('Responsável'), channelKind: t('Tipo de canal') })}${select('operator', t('Regra'), config.operator, { contains: t('Contém'), equals: t('É igual a'), exists: t('Existe') })}${input('value', t('Valor'), config.value, 160)}`;
    if (node.type === 'tag') return h`${select('operation', t('Operação'), config.operation || 'add', { add: t('Adicionar'), remove: t('Remover') })}${input('tag', t('Etiqueta'), config.tag)}`;
    if (node.type === 'department') return department(false);
    if (node.type === 'handoff') return h`${select('owner', t('Destino'), config.owner || 'queue', { queue: t('Fila da equipe'), human: t('Atendente humano') })}${department(true)}`;
    return '';
  }

  function nodePanel(node) {
    const isAdmin = admin(), labels = flowNodeTypes();
    if (!node) return h`<section class="pg-automation__panel" id="automation-node-panel" aria-labelledby="automation-node-title"><h2 class="pg-automation__panel-title" id="automation-node-title">${t('Passo selecionado')}</h2><p class="pg-automation__muted">${t('Selecione um passo no diagrama para ver e editar a configuração.')}</p></section>`;
    const fields = nodeFields(node), exits = exitsOf(node);
    const removable = isAdmin && !['start', 'end', 'condition'].includes(node.type);
    return h`<section class="pg-automation__panel" id="automation-node-panel" aria-labelledby="automation-node-title"><div class="pg-automation__panel-head"><span class="pg-automation__node-icon"${attributes({ 'data-type': node.type })} aria-hidden="true">${glyph(FLOW_NODE_GLYPHS[node.type] || 'activity')}</span><div><p class="pg-automation__eyebrow">${t('Passo selecionado')}</p><h2 class="pg-automation__panel-title" id="automation-node-title">${labels[node.type] || node.type}</h2><p class="pg-automation__meta">${t('ID do passo')} <code class="pg-automation__code">${node.id}</code></p></div></div><fieldset class="pg-automation__fieldset pg-automation__fieldset--bare"${attributes({ disabled: !isAdmin })}><legend class="sr-only">${t('Configuração do passo')}</legend>${fields || h`<p class="pg-automation__muted">${t('Este passo delimita a rota do atendimento.')}</p>`}</fieldset>${!isAdmin ? h`<p class="pg-automation__muted">${t('Somente a administração altera os fluxos.')}</p>` : ''}${exits.length ? h`<div class="pg-automation__exits"><h3 class="pg-automation__subtitle">${t('Saídas')}</h3><ul class="pg-automation__exit-list">${exits.map(exit => h`<li><span class="pg-automation__exit-branch">${exit.branch}</span>${exit.target ? button({ label: exit.label, action: 'automation:flow-node', variant: 'link', size: 'sm', attrs: { 'data-id': exit.target.id } }) : h`<span>${exit.label}</span>`}</li>`)}</ul></div>` : ''}${removable ? button({ label: t('Remover passo'), action: 'automation:delete-flow-node', variant: 'ghost', size: 'sm', icon: 'close', className: 'pg-automation__danger', attrs: { 'data-id': node.id, 'data-automation-focus': 'node-delete' } }) : ''}</section>`;
  }

  function result() {
    const outcome = state.flowResult;
    if (!outcome) return '';
    const labels = flowNodeTypes(), owner = { human: t('Atendente'), queue: t('Fila'), agent: t('Agente') }[outcome.output?.owner] || t('Mantido');
    const tags = Array.isArray(outcome.output?.tags) && outcome.output.tags.length ? outcome.output.tags.join(', ') : t('Nenhuma');
    return h`<section class="pg-automation__result" aria-labelledby="automation-result-title" data-automation-result><div class="pg-automation__result-head"><h3 class="pg-automation__result-title" id="automation-result-title" tabindex="-1" data-automation-focus="sim-result">${outcome.applied ? t('Resultado aplicado') : t('Resultado da simulação')}</h3>${button({ label: t('Limpar resultado'), action: 'automation:clear-simulation', variant: 'ghost', size: 'sm' })}</div>${outcome.draftVersion ? h`<p class="pg-automation__meta">${t('Rascunho salvo · edição v{version}', { version: outcome.draftVersion })}</p>` : ''}<ol class="pg-automation__trace" aria-label="${t('Caminho percorrido')}">${(outcome.steps || []).map(step => h`<li class="pg-automation__trace-step"${attributes({ 'data-type': step.type })}><span>${labels[step.type] || step.type}</span>${step.type === 'condition' ? badge(step.matched ? t('condição atendida') : t('condição não atendida'), step.matched ? 'success' : 'neutral') : ''}</li>`)}</ol><dl class="pg-automation__kv"><div><dt>${t('Departamento')}</dt><dd>${outcome.output?.department || t('Mantido')}</dd></div><div><dt>${t('Responsável')}</dt><dd>${owner}</dd></div><div><dt>${t('Etiquetas')}</dt><dd>${tags}</dd></div></dl><p class="pg-automation__muted">${t('Nenhuma conversa foi alterada e nenhuma mensagem foi enviada.')}</p></section>`;
  }

  function simulator() {
    const dirty = Boolean(state.flowDirty);
    return h`<section class="pg-automation__panel" aria-labelledby="automation-sim-title"><h2 class="pg-automation__panel-title" id="automation-sim-title">${t('Testar a rota')}</h2><p class="pg-automation__muted">${t('Simula o rascunho salvo com uma mensagem de teste. Nenhuma conversa muda e nada é enviado.')}</p><form class="pg-automation__form" data-form="automation:simulate"><div class="pg-automation__field"><label class="pg-automation__label" for="automation-sim-text">${t('Mensagem de teste')}</label><textarea class="pg-automation__control pg-automation__textarea" id="automation-sim-text" name="text" rows="3" maxlength="4000" required data-automation-focus="sim-text"${attributes({ placeholder: t('Ex.: Preciso de suporte para meu pedido'), 'aria-describedby': dirty ? 'automation-sim-dirty' : null })}>${simulation}</textarea></div>${dirty ? h`<p class="pg-automation__notice" id="automation-sim-dirty">${t('Salve as alterações para testar a versão atual do rascunho.')}</p>` : ''}<p class="pg-automation__form-error" role="alert" data-automation-error></p><div class="pg-automation__form-actions">${button({ label: t('Simular rascunho salvo'), type: 'submit', variant: 'secondary', icon: 'arrow', busy: simulating, attrs: { 'data-automation-focus': 'sim-submit' } })}</div></form>${result()}</section>`;
  }

  function empty() {
    const action = admin() ? { label: t('Criar o primeiro fluxo'), action: 'new-flow', icon: 'plus', attrs: { 'data-automation-focus': 'flow-new', 'aria-haspopup': 'dialog' } } : undefined;
    return h`<section class="pg-automation__card">${emptyState({ icon: 'workflow', title: t('Nenhum fluxo nesta empresa'), body: admin() ? t('Comece por uma triagem: identifique o assunto, marque a conversa e encaminhe para a equipe.') : t('A administração cria e publica os fluxos desta empresa.'), action })}</section>`;
  }

  /** Markup of #automation/flows[/<id>] (the hub tabs come from nav-config.js). */
  function view(route) {
    applyRoute(route);
    const flows = state.flows || [];
    if (!flows.some(flow => flow.id === state.flowId) && flows.length) selectFlow(flows[0].id);
    const flow = currentFlow();
    if (flow && !state.flowDraft && (flow.graph || flow.editorGraph)) selectFlow(flow.id);
    announced = Boolean(state.flowDirty);
    const body = flow ? h`<div class="pg-automation__flows">${library()}${editor(flow)}<aside class="pg-automation__inspector" aria-label="${t('Passo e teste do fluxo')}">${nodePanel(state.flowDraft?.nodes.find(node => node.id === state.flowNode))}${simulator()}</aside></div>` : empty();
    return h`<div class="pg-automation pg-automation--flows">${header()}${body}</div>`;
  }

  // ---- live updates without a full render (typing in a step) -----------------------------------

  function patchState(root) {
    const flow = currentFlow(), target = root?.querySelector?.('[data-automation-flow-state]');
    if (!flow || !target) return;
    const template = root.ownerDocument.createElement('template');
    template.innerHTML = String(stateLines(flow));
    target.replaceWith(template.content.firstElementChild);
    if (state.flowDirty && !announced) {
      announced = true;
      const live = root.querySelector('[data-automation-flow-live]');
      if (live) live.textContent = t('Alterações locais não salvas.');
    }
  }

  /** input/change on a step field (data-automation-node-config); true when handled. */
  function handleInput(event) {
    const input = event?.target;
    if (!input?.matches?.('[data-automation-node-config]')) return false;
    const node = state.flowDraft?.nodes.find(item => item.id === state.flowNode);
    // Same rule as the legacy editor: only the administration edits the draft.
    if (!node || !admin()) return true;
    node.config ||= {};
    node.config[input.dataset.automationNodeConfig] = input.value;
    state.flowDirty = true; state.flowResult = null;
    if (event.type === 'change' && input.tagName === 'SELECT') { focus?.want?.(`node-config:${input.dataset.automationNodeConfig}`); render(); return true; }
    const root = input.closest?.('.pg-automation');
    const step = [...(root?.querySelectorAll?.('.pg-automation__node') || [])].find(item => item.dataset.id === node.id);
    const summaryNode = step?.querySelector?.('[data-automation-node-summary]');
    if (summaryNode) summaryNode.textContent = summary(node);
    root?.querySelector?.('[data-automation-result]')?.setAttribute('data-state', 'stale');
    for (const traced of root?.querySelectorAll?.('[data-state="traced"]') || []) traced.removeAttribute('data-state');
    patchState(root);
    return true;
  }

  // ---- actions ------------------------------------------------------------------------------

  function openPublish(element) {
    if (!admin()) throw new Error(t('Somente a administração publica fluxos.'));
    const flow = currentFlow();
    if (!flow) throw new Error(t('Escolha um fluxo para publicar.'));
    const next = (Array.isArray(flow.versions) && flow.versions.length ? Number(flow.versions.at(-1)?.version) || 0 : 0) + 1;
    const body = h`<div class="pg-automation__dialog-section"><p class="pg-automation__dialog-text">${state.flowDirty ? t('As alterações locais serão salvas e o rascunho vira a versão publicada v{next}.', { next }) : t('O rascunho salvo (edição v{version}) vira a versão publicada v{next}.', { version: flow.version, next })}</p><ul class="pg-automation__bullets"><li>${t('A nova versão fica disponível para aplicar nas conversas do Atendimento.')}</li><li>${t('Cada regra de entrada continua na versão escolhida nela; para usar a nova, edite a regra em Regras e SLA.')}</li>${flow.publishedVersion ? h`<li>${t('A versão v{version} continua no histórico de publicações.', { version: flow.publishedVersion })}</li>` : ''}</ul></div><div class="pg-automation__dialog-actions">${button({ label: t('Cancelar'), action: 'automation:close-dialog', variant: 'ghost' })}${button({ label: t('Publicar v{next}', { next }), action: 'publish-flow', variant: 'primary', icon: 'send', attrs: { 'data-automation-focus': 'flow-publish-confirm' } })}</div>`;
    dialogs?.open?.({ title: t('Publicar fluxo'), description: flow.name, body, kind: 'publish', returnElement: element, returnKey: 'flow-publish', size: 'sm' });
    return true;
  }

  function addNode(element) {
    if (!admin()) throw new Error(t('Somente a administração altera os fluxos.'));
    if (!state.flowDraft) throw new Error(t('Escolha um fluxo para editar.'));
    const select = element?.closest?.('[data-automation-add-step]')?.querySelector?.('select') || globalThis.document?.getElementById?.('automation-new-node-type');
    const type = ['tag', 'department', 'handoff'].includes(select?.value) ? select.value : 'tag';
    // Same step as the legacy editor: before the conclusion, with the same default configuration.
    const nodeId = 'step_' + Date.now().toString(36), end = state.flowDraft.nodes.find(node => node.type === 'end');
    if (!end) throw new Error(t('Este fluxo não tem conclusão. Ajuste a estrutura avançada.'));
    const config = type === 'tag' ? { tag: t('Nova etiqueta'), operation: 'add' } : type === 'department' ? { department: t('Atendimento') } : { owner: 'queue' };
    state.flowDraft.edges = state.flowDraft.edges.map(edge => edge.to === end.id ? { ...edge, to: nodeId } : edge); state.flowDraft.edges.push({ from: nodeId, to: end.id }); state.flowDraft.nodes.push({ id: nodeId, type, config }); state.flowNode = nodeId; state.flowDirty = true; state.flowResult = null;
    focus?.want?.(type === 'handoff' ? 'node-config:owner' : type === 'department' ? 'node-config:department' : 'node-config:operation');
    render();
    return true;
  }

  function deleteNode(id) {
    if (!admin()) throw new Error(t('Somente a administração altera os fluxos.'));
    const node = state.flowDraft?.nodes.find(item => item.id === id);
    if (!node || ['start', 'end', 'condition'].includes(node.type)) throw new Error(t('Este passo não pode ser removido.'));
    const next = state.flowDraft.edges.find(edge => edge.from === id)?.to;
    if (!next) throw new Error(t('Este passo não tem saída. Ajuste a estrutura avançada.'));
    state.flowDraft.edges = state.flowDraft.edges.filter(edge => edge.from !== id).map(edge => edge.to === id ? { ...edge, to: next } : edge); state.flowDraft.nodes = state.flowDraft.nodes.filter(item => item.id !== id); state.flowNode = state.flowDraft.nodes[0].id; state.flowDirty = true; state.flowResult = null;
    focus?.want?.(`node:${state.flowNode}`);
    render();
    return true;
  }

  async function act(name, id, element) {
    switch (name) {
      case 'automation:flow-node':
        if (!state.flowDraft?.nodes.some(node => node.id === id)) return true;
        state.flowNode = id; focus?.want?.(`node:${id}`); render(); return true;
      case 'automation:publish-flow': return openPublish(element);
      case 'automation:add-flow-node': return addNode(element);
      case 'automation:delete-flow-node': return deleteNode(id);
      case 'automation:clear-simulation': state.flowResult = null; focus?.want?.('sim-text'); render(); return true;
      default: return false;
    }
  }

  /** data-form="automation:simulate": the saved draft only (same request as the legacy form). */
  async function submit(form) {
    if (form?.dataset?.form !== 'automation:simulate') return false;
    const text = String(form.elements?.namedItem?.('text')?.value ?? '');
    simulation = text;
    if (state.flowDirty) throw new Error(t('Salve as alterações antes de testar a rota.'));
    if (!state.flowId) throw new Error(t('Escolha um fluxo para testar.'));
    if (simulating) return true;
    const before = scope();
    simulating = true;
    try {
      const outcome = await request(tenantPath(`flows/${state.flowId}/simulate`), { method: 'POST', body: JSON.stringify({ text }) });
      if (scope() !== before) return true;
      state.flowResult = outcome;
    } finally { simulating = false; }
    focus?.want?.('sim-result');
    render();
    return true;
  }

  /** After a render of the screen: the hash carries the open flow (history.replaceState, no entry). */
  function afterRender() {
    if (!state.flowId || typeof globalThis.history?.replaceState !== 'function') return;
    const hash = flowHash(state.flowId);
    if (globalThis.location?.hash === hash) { routeFlow = state.flowId; return; }
    routeFlow = state.flowId;
    globalThis.history.replaceState(globalThis.history.state, '', hash);
    if (state.screenRoutes) state.screenRoutes.flows = JSON.stringify(['automation', { tab: 'flows', id: state.flowId }]);
  }

  function reset() { routeFlow = null; simulation = ''; simulating = false; announced = false; }

  return { view, act, submit, handleInput, afterRender, reset, selectFlow };
}
