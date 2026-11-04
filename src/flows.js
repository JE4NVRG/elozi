import { createHash, randomUUID } from 'node:crypto';
import { fail, text } from './store.js';

export const FLOW_NODE_TYPES = ['start', 'condition', 'tag', 'department', 'handoff', 'end'];
const copy = value => structuredClone(value);
const timestamp = () => new Date().toISOString();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, `${label} inválido.`);
  return value;
}
function department(value, tenant, idsOnly = false) {
  const name = text(value, 80);
  const registered = Array.isArray(tenant?.departments) ? tenant.departments : null;
  if (!registered) { if (idsOnly) fail(400, 'Departamento não encontrado nesta empresa.'); return name; }
  const ids = registered.filter(item => typeof item === 'object' && item?.id === name);
  const found = ids.length || idsOnly ? ids : registered.filter(item => (typeof item === 'string' ? item : item?.name) === name);
  if (!found.length) fail(400, 'Departamento não encontrado nesta empresa.');
  if (found.length !== 1) fail(409, 'Referência de departamento ambígua. Revise o fluxo.');
  return typeof found[0] === 'string' ? found[0] : text(found[0].id, 80);
}
function configuration(node, tenant, idsOnly) {
  const config = object(node.config ?? {}, 'Configuração do nó');
  if (node.type === 'condition') {
    const field = config.field ?? 'text', operator = config.operator ?? 'contains';
    if (!['text', 'department', 'owner', 'tag', 'channelKind'].includes(field) || !['contains', 'equals', 'exists'].includes(operator)) fail(400, 'Condição não suportada.');
    return { field, operator, ...(operator === 'exists' ? {} : { value: text(config.value, 500) }) };
  }
  if (node.type === 'tag') {
    const operation = config.operation ?? 'add';
    if (!['add', 'remove'].includes(operation)) fail(400, 'Operação de etiqueta inválida.');
    return { tag: text(config.tag, 48), operation };
  }
  if (node.type === 'department') return { department: department(config.department, tenant, idsOnly) };
  if (node.type === 'handoff') {
    const owner = config.owner ?? 'human';
    if (!['human', 'queue'].includes(owner)) fail(400, 'O fluxo pode encaminhar somente para humano ou fila.');
    return { owner, ...(config.department ? { department: department(config.department, tenant, idsOnly) } : {}) };
  }
  return {};
}

/** Validates a bounded DAG. Conditions have exactly one true and one false exit. */
export function validateFlowGraph(input, tenant = {}) {
  object(input, 'Grafo');
  if (input.departmentReferenceFormat !== undefined && input.departmentReferenceFormat !== 'id-v1') fail(400, 'Formato de referência de departamento inválido.');
  const idsOnly = input.departmentReferenceFormat === 'id-v1';
  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 100 || !Array.isArray(input.edges) || input.edges.length > 200) fail(400, 'Informe de 2 a 100 nós e até 200 conexões.');
  const nodes = input.nodes.map(node => {
    object(node, 'Nó');
    if (!identifier(node.id) || !FLOW_NODE_TYPES.includes(node.type)) fail(400, 'Identificador ou tipo de nó inválido.');
    return { id: node.id, type: node.type, config: configuration(node, tenant, idsOnly) };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) fail(400, 'Identificador de nó duplicado.');
  const starts = nodes.filter(node => node.type === 'start');
  if (starts.length !== 1 || !nodes.some(node => node.type === 'end')) fail(400, 'O fluxo exige um início e pelo menos um fim.');
  const edges = input.edges.map(edge => {
    object(edge, 'Conexão');
    if (!byId.has(edge.from) || !byId.has(edge.to)) fail(400, 'Conexão aponta para um nó desconhecido.');
    if (byId.get(edge.from).type === 'condition') {
      const when = edge.when === 'true' ? true : edge.when === 'false' ? false : edge.when;
      if (typeof when !== 'boolean') fail(400, 'Saídas da condição precisam indicar true ou false.');
      return { from: edge.from, to: edge.to, when };
    }
    if (edge.when !== undefined) fail(400, 'Somente condições admitem uma saída condicional.');
    return { from: edge.from, to: edge.to };
  });
  const outgoing = new Map(nodes.map(node => [node.id, edges.filter(edge => edge.from === node.id)]));
  if (edges.some(edge => edge.to === starts[0].id)) fail(400, 'O início não pode receber conexões.');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail(400, 'Ciclos não são permitidos no fluxo.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of outgoing.get(id)) visit(edge.to);
    visiting.delete(id); visited.add(id);
  }
  // Inspect all components so a disconnected cycle is reported explicitly.
  for (const node of nodes) visit(node.id);
  const reachable = new Set();
  function reach(id) { if (reachable.has(id)) return; reachable.add(id); for (const edge of outgoing.get(id)) reach(edge.to); }
  reach(starts[0].id);
  if (reachable.size !== nodes.length) fail(400, 'Há nós inacessíveis a partir do início.');
  for (const node of nodes) {
    const exits = outgoing.get(node.id);
    if (node.type === 'end' && exits.length) fail(400, 'O fim não pode ter saídas.');
    if (node.type === 'condition' && (exits.length !== 2 || new Set(exits.map(edge => edge.when)).size !== 2)) fail(400, 'A condição exige uma saída true e uma false.');
    if (!['condition', 'end'].includes(node.type) && exits.length !== 1) fail(400, 'Cada nó exige exatamente uma saída.');
  }
  const idFormat = idsOnly || Array.isArray(tenant.departments) && tenant.departments.every(item => item && typeof item === 'object' && typeof item.id === 'string');
  return { nodes, edges, ...(idFormat ? { departmentReferenceFormat: 'id-v1' } : {}) };
}

const graphHash = graph => createHash('sha256').update(JSON.stringify(graph)).digest('hex');
const routingNodes = graph => (Array.isArray(graph?.nodes) ? graph.nodes : []).filter(node => ['department', 'handoff'].includes(node?.type) && node.config?.department);
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const referenceFailure = () => fail(409, 'O vínculo do departamento mudou ou está indisponível. Revise o fluxo.');
function referencesFor(flow) {
  const value = flow.departmentReferences;
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).some(key => !['draft', 'published'].includes(key)) || value.published !== undefined && !record(value.published)) referenceFailure();
  return value;
}
function pinnedTargets(graph, references) {
  if (references === undefined) return new Map();
  if (!record(references) || Object.keys(references).some(key => !['graphHash', 'nodes'].includes(key)) || references.graphHash !== graphHash(graph) || !record(references.nodes)) referenceFailure();
  const nodes = new Map(routingNodes(graph).map(node => [node.id, node])), entries = Object.entries(references.nodes);
  if (!entries.length || entries.length > 100) referenceFailure();
  for (const [nodeId, departmentId] of entries) if (!nodes.has(nodeId) || typeof departmentId !== 'string' || !departmentId.trim() || departmentId !== departmentId.trim() || departmentId.length > 80) referenceFailure();
  return new Map(entries);
}
function departmentById(tenant, id) {
  const found = (tenant.departments ?? []).filter(item => typeof item === 'object' && item?.id === id);
  if (found.length !== 1) referenceFailure();
  return found[0];
}
function resolveGraph(graph, tenant, references) {
  object(graph, 'Grafo');
  if (graph.departmentReferenceFormat === 'id-v1' && references !== undefined) referenceFailure();
  const resolved = copy(graph), pins = pinnedTargets(graph, references);
  for (const node of routingNodes(resolved)) if (pins.has(node.id)) {
    node.config.department = departmentById(tenant, pins.get(node.id)).id;
  }
  return validateFlowGraph(resolved, tenant);
}
function draftGraph(input, flow, tenant) {
  object(input, 'Grafo');
  if (input.departmentReferenceFormat === 'id-v1') return validateFlowGraph(input, tenant);
  const resolved = copy(input), pins = pinnedTargets(flow.graph, referencesFor(flow).draft);
  const previous = new Map(routingNodes(flow.graph).map(node => [node.id, node]));
  for (const node of routingNodes(resolved)) {
    const old = previous.get(node.id);
    // An unchanged legacy target retains its binding; selecting another ID is explicit.
    if (pins.has(node.id) && old.type === node.type && old.config.department === node.config.department) node.config.department = departmentById(tenant, pins.get(node.id)).id;
  }
  return validateFlowGraph(resolved, tenant);
}
function clearDraftReferences(flow) {
  const references = referencesFor(flow), published = references.published;
  if (published && Object.keys(published).length) flow.departmentReferences = { published };
  else delete flow.departmentReferences;
}

/** Pins unambiguous legacy names in the same transaction that renames a department. */
export function preserveFlowDepartmentReferences(tenant, department) {
  for (const flow of tenant.flows ?? []) {
    const existing = referencesFor(flow), published = { ...(existing.published ?? {}) };
    const pin = (graph, references) => {
      const targets = pinnedTargets(graph, references);
      if (graph.departmentReferenceFormat === 'id-v1') { if (references !== undefined) referenceFailure(); return references; }
      let changed = false;
      for (const node of routingNodes(graph)) {
        const value = node.config.department;
        if (value !== department.name || value === department.id || targets.has(node.id)) continue;
        const candidates = (tenant.departments ?? []).filter(item => typeof item === 'object' && (item?.id === value || item?.name === value));
        if (candidates.length !== 1 || candidates[0].id !== department.id) referenceFailure();
        targets.set(node.id, department.id); changed = true;
      }
      return changed ? { graphHash: graphHash(graph), nodes: Object.fromEntries(targets) } : references;
    };
    const draft = pin(flow.graph, existing.draft);
    let changed = draft !== existing.draft;
    for (const version of flow.versions ?? []) {
      const previous = published[version.version], next = pin(version.graph, previous);
      if (next !== previous) { published[version.version] = next; changed = true; }
    }
    if (changed) flow.departmentReferences = { ...(draft ? { draft } : {}), ...(Object.keys(published).length ? { published } : {}) };
  }
}

function departmentName(tenant, value) {
  const target = (tenant.departments ?? []).find(item => typeof item === 'object' && item?.id === value);
  if (!target) return value;
  if ((tenant.departments ?? []).some(item => item !== target && (item?.id === target.name || item?.name === target.name))) referenceFailure();
  return target.name;
}

const emptyGraph = () => ({ nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'end', type: 'end', config: {} }], edges: [{ from: 'start', to: 'end' }] });
function findFlow(tenant, id) {
  const flow = (tenant.flows ?? []).find(item => item.id === id);
  if (!flow) fail(404, 'Fluxo não encontrado nesta empresa.');
  return flow;
}
function expected(flow, version) {
  if (!revision(version)) fail(400, 'Informe a versão atual do fluxo.');
  if (flow.version !== version) fail(409, 'O fluxo mudou. Atualize antes de continuar.');
  if (flow.state === 'archived') fail(409, 'O fluxo está arquivado.');
}
function contextFor(tenant, conversation, input) {
  const tags = input.tags ?? conversation?.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 100) fail(400, 'Etiquetas inválidas.');
  const supplied = input.text ?? [...(conversation?.messages ?? [])].reverse().find(message => message.kind === 'customer')?.text ?? '';
  if (typeof supplied !== 'string' || supplied.length > 20000) fail(400, 'Texto de teste inválido.');
  return { text: supplied, tags: [...new Set(tags.map(value => text(value, 48)))], department: input.department ?? conversation?.department ?? '', owner: input.owner ?? conversation?.owner ?? 'human', agentId: conversation?.agentId ?? null, channelKind: tenant.channels?.find(channel => channel.id === conversation?.channelId)?.kind ?? input.channelKind ?? '' };
}
function matches(config, context) {
  const actual = config.field === 'tag' ? context.tags : context[config.field];
  if (config.operator === 'exists') return Array.isArray(actual) ? actual.length > 0 : Boolean(actual);
  const value = config.value.toLocaleLowerCase('pt-BR');
  if (Array.isArray(actual)) return actual.some(tag => config.operator === 'equals' ? tag.toLocaleLowerCase('pt-BR') === value : tag.toLocaleLowerCase('pt-BR').includes(value));
  const normalized = String(actual ?? '').toLocaleLowerCase('pt-BR');
  return config.operator === 'equals' ? normalized === value : normalized.includes(value);
}
function execute(graph, context, maxSteps, tenant) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const output = copy(context), steps = [];
  let node = graph.nodes.find(item => item.type === 'start');
  while (node) {
    if (steps.length >= maxSteps) fail(400, 'Limite de passos do fluxo atingido.');
    const step = { nodeId: node.id, type: node.type };
    if (node.type === 'tag') output.tags = node.config.operation === 'remove' ? output.tags.filter(tag => tag !== node.config.tag) : [...new Set([...output.tags, node.config.tag])];
    if (node.type === 'department') output.department = departmentName(tenant, node.config.department);
    if (node.type === 'handoff') { output.owner = node.config.owner; output.agentId = null; if (node.config.department) output.department = departmentName(tenant, node.config.department); }
    if (node.type === 'condition') step.matched = matches(node.config, output);
    steps.push(step);
    if (node.type === 'end') break;
    const edge = graph.edges.find(item => item.from === node.id && (node.type !== 'condition' || item.when === step.matched));
    node = nodes.get(edge.to);
  }
  return { steps, output: { tags: output.tags, department: output.department, owner: output.owner, agentId: output.agentId } };
}

/** Synchronous Store adapter. Preview never mutates a conversation or sends messages. */
export class FlowService {
  constructor(store, { maxSteps = 100 } = {}) {
    this.store = store.sync ?? store;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new TypeError('maxSteps inválido.');
    this.maxSteps = maxSteps;
  }
  list(actor, tenantId, { includeArchived = false } = {}) {
    const tenant = this.store.tenant(actor, tenantId);
    return copy((tenant.flows ?? []).filter(flow => includeArchived || flow.state !== 'archived').map(flow => {
      try {
        return { ...flow, editorGraph: resolveGraph(flow.graph, tenant, referencesFor(flow).draft), editorReferenceIssue: false };
      } catch (error) {
        if (![400, 409].includes(error.status)) throw error;
        return { ...flow, editorGraph: null, editorReferenceIssue: true };
      }
    }));
  }
  create(actor, tenantId, input) {
    this.store.admin(actor); object(input, 'Fluxo');
    return this.store.mutate(actor, tenantId, 'Fluxo criado', tenant => {
      tenant.flows ??= [];
      if (tenant.flows.length >= 100) fail(400, 'Limite de fluxos atingido.');
      const date = timestamp(), flow = { id: randomUUID(), name: text(input.name, 80), description: input.description ? text(input.description, 500) : '', state: 'draft', version: 1, graph: validateFlowGraph(input.graph ?? emptyGraph(), tenant), versions: [], publishedVersion: null, createdAt: date, updatedAt: date };
      tenant.flows.push(flow); return copy(flow);
    });
  }
  save(actor, tenantId, flowId, input) {
    this.store.admin(actor); object(input, 'Fluxo');
    return this.store.mutate(actor, tenantId, 'Rascunho de fluxo atualizado', tenant => {
      const flow = findFlow(tenant, flowId); expected(flow, input.version);
      if (input.name !== undefined) flow.name = text(input.name, 80);
      if (input.description !== undefined) flow.description = input.description === '' ? '' : text(input.description, 500);
      if (input.graph !== undefined) { flow.graph = draftGraph(input.graph, flow, tenant); clearDraftReferences(flow); }
      flow.version++; flow.state = 'draft'; flow.updatedAt = timestamp(); return copy(flow);
    });
  }
  publish(actor, tenantId, flowId, input) {
    this.store.admin(actor); object(input, 'Publicação');
    return this.store.mutate(actor, tenantId, 'Versão de fluxo publicada', tenant => {
      const flow = findFlow(tenant, flowId); expected(flow, input.version);
      const graph = resolveGraph(flow.graph, tenant, referencesFor(flow).draft), date = timestamp(), version = (flow.versions.at(-1)?.version ?? 0) + 1;
      flow.graph = copy(graph); clearDraftReferences(flow);
      flow.versions.push({ version, graph: copy(graph), publishedAt: date });
      flow.publishedVersion = version; flow.version++; flow.state = 'published'; flow.updatedAt = date; return copy(flow);
    });
  }
  remove(actor, tenantId, flowId, input) {
    this.store.admin(actor); object(input, 'Arquivamento');
    return this.store.mutate(actor, tenantId, 'Fluxo arquivado', tenant => {
      const flow = findFlow(tenant, flowId); expected(flow, input.version);
      flow.state = 'archived'; flow.version++; flow.updatedAt = timestamp(); return copy(flow);
    });
  }
  simulate(actor, tenantId, flowId, input = {}) {
    object(input, 'Teste do fluxo');
    const evaluate = tenant => {
      const flow = findFlow(tenant, flowId);
      if (flow.state === 'archived') fail(409, 'O fluxo está arquivado.');
      if (input.version !== undefined && (!revision(input.version) || input.version !== flow.version)) fail(409, 'O fluxo mudou. Atualize antes de continuar.');
      let selected = null;
      if (input.flowVersion !== undefined || input.apply === true) {
        const version = input.flowVersion ?? flow.publishedVersion;
        if (!revision(version)) fail(400, 'Publique uma versão antes de executar o fluxo.');
        selected = flow.versions.find(item => item.version === version);
        if (!selected) fail(404, 'Versão publicada não encontrada.');
      }
      const references = referencesFor(flow), graph = resolveGraph(selected?.graph ?? flow.graph, tenant, selected ? references.published?.[selected.version] : references.draft);
      let conversation;
      if (input.conversationId) {
        if (!revision(input.conversationVersion)) fail(400, 'Informe a versão da conversa.');
        conversation = this.store.getConversation(tenant, input.conversationId, input.conversationVersion);
        if (conversation.status === 'closed') fail(409, 'A conversa está encerrada.');
      }
      if (input.apply === true && !conversation) fail(400, 'Informe a conversa para aplicar o fluxo.');
      this.authorize?.(actor,tenantId,conversation,input.apply===true);
      const contextInput = input.apply === true ? { text: input.text } : input;
      const result = { flowId, flowVersion: selected?.version ?? null, draftVersion: flow.version, simulated: input.apply !== true, applied: input.apply === true, ...execute(graph, contextFor(tenant, conversation, contextInput), this.maxSteps, tenant) };
      if (input.apply === true) {
        this.routeOutput?.(actor,tenantId,tenant,conversation,result.output,graph,result.steps);
        Object.assign(conversation, result.output);
        conversation.version++; conversation.updatedAt = timestamp();
        conversation.messages.push({ id: randomUUID(), kind: 'system', text: `Fluxo ${flow.name} aplicado (versão ${selected.version}).`, createdAt: conversation.updatedAt });
        result.conversationId = conversation.id; result.conversationVersion = conversation.version;
      }
      return copy(result);
    };
    return input.apply === true ? this.store.mutate(actor, tenantId, 'Roteamento de fluxo aplicado', evaluate) : evaluate(this.store.tenant(actor, tenantId));
  }
}
