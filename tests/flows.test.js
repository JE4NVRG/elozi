import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { FlowService, preserveFlowDepartmentReferences, validateFlowGraph } from '../src/flows.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'QA fluxos' };
const graph = () => ({
  nodes: [
    { id: 'start', type: 'start', config: {} },
    { id: 'check', type: 'condition', config: { field: 'text', operator: 'contains', value: 'plano' } },
    { id: 'tag', type: 'tag', config: { tag: 'Comercial' } },
    { id: 'route', type: 'department', config: { department: 'Comercial' } },
    { id: 'handoff', type: 'handoff', config: { owner: 'human' } },
    { id: 'end', type: 'end', config: {} }
  ],
  edges: [{ from: 'start', to: 'check' }, { from: 'check', to: 'tag', when: 'true' }, { from: 'check', to: 'end', when: 'false' }, { from: 'tag', to: 'route' }, { from: 'route', to: 'handoff' }, { from: 'handoff', to: 'end' }]
});
function setup(t, options) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tenant = store.createTenant(admin, { name: 'Fluxos QA', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture', state => {
    state.departments = [{ id: 'sales', name: 'Comercial' }, { id: 'support', name: 'Suporte' }];
    state.channels.push({ id: 'tg', kind: 'telegram' });
    state.conversations.push({ id: 'conv', channelId: 'tg', contact: 'Cliente QA', department: 'Suporte', owner: 'agent', agentId: 'fixture-agent', status: 'open', version: 1, tags: [], messages: [{ id: 'm1', kind: 'customer', text: 'Quero um PLANO', createdAt: new Date().toISOString() }] });
  });
  return { store, tenant, service: new FlowService(store, options), operator: { ...admin, role: 'operator', tenantId: tenant.id } };
}
const status = code => error => error.status === code;

test('fluxos têm revisão CAS, publicação imutável e arquivamento preserva histórico', t => {
  const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Comercial', graph: graph() });
  const published = c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
  assert.equal(published.version, 2); assert.equal(published.publishedVersion, 1);
  published.versions[0].graph.nodes[2].config.tag = 'Não persistir';
  const edited = graph(); edited.nodes[2].config.tag = 'Outra versão';
  const saved = c.service.save(admin, c.tenant.id, created.id, { version: 2, graph: edited });
  assert.equal(saved.versions[0].graph.nodes[2].config.tag, 'Comercial');
  assert.throws(() => c.service.save(admin, c.tenant.id, created.id, { version: 2, name: 'Concorrente' }), status(409));
  const second = c.service.publish(admin, c.tenant.id, created.id, { version: saved.version });
  assert.equal(second.versions[1].version, 2);
  assert.equal(c.service.simulate(admin, c.tenant.id, created.id, { flowVersion: 1, text: 'plano' }).output.tags[0], 'Comercial');
  assert.equal(c.service.simulate(admin, c.tenant.id, created.id, { flowVersion: 2, text: 'plano' }).output.tags[0], 'Outra versão');
  c.service.remove(admin, c.tenant.id, created.id, { version: second.version });
  assert.equal(c.service.list(admin, c.tenant.id).length, 0);
  assert.equal(c.service.list(admin, c.tenant.id, { includeArchived: true })[0].versions.length, 2);
  assert.throws(() => c.service.simulate(admin, c.tenant.id, created.id), status(409));
});

test('grafo rejeita destinos desconhecidos, ciclos, inacessíveis e saídas ambíguas', () => {
  const unknown = graph(); unknown.edges[0].to = 'missing';
  assert.throws(() => validateFlowGraph(unknown), /desconhecido/);
  const cycle = graph(); cycle.edges.find(edge => edge.from === 'handoff').to = 'tag';
  assert.throws(() => validateFlowGraph(cycle), /Ciclos/);
  const unreachable = graph(); unreachable.nodes.push({ id: 'unused', type: 'end' });
  assert.throws(() => validateFlowGraph(unreachable), /inacessíveis/);
  const ambiguous = graph(); ambiguous.edges.find(edge => edge.when === 'false').when = 'true';
  assert.throws(() => validateFlowGraph(ambiguous), /true.*false/);
  assert.throws(() => validateFlowGraph(graph(), { departments: [{ id: 'support', name: 'Suporte' }] }), /Departamento/);
  const unknownType = graph(); unknownType.nodes[2].type = 'webhook';
  assert.throws(() => validateFlowGraph(unknownType), /tipo/);
});

test('preview é determinístico e aplicação só roteia versão publicada com CAS da conversa', t => {
  const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Vendas', graph: graph() });
  const original = c.store.tenant(admin, c.tenant.id).conversations[0];
  const input = { conversationId: 'conv', conversationVersion: 1 };
  const preview = c.service.simulate(c.operator, c.tenant.id, created.id, input);
  assert.deepEqual(preview, c.service.simulate(c.operator, c.tenant.id, created.id, input));
  assert.deepEqual(preview.output, { tags: ['Comercial'], department: 'Comercial', owner: 'human', agentId: null });
  assert.deepEqual(c.store.tenant(admin, c.tenant.id).conversations[0], original);
  assert.throws(() => c.service.simulate(c.operator, c.tenant.id, created.id, { ...input, apply: true }), status(400));
  c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
  const applied = c.service.simulate(c.operator, c.tenant.id, created.id, { ...input, apply: true });
  const current = c.store.tenant(admin, c.tenant.id).conversations[0];
  assert.equal(applied.conversationVersion, 2); assert.equal(current.channelId, 'tg');
  assert.equal(current.messages.length, 2); assert.equal(current.messages[1].kind, 'system');
  assert.equal(current.owner, 'human'); assert.equal(current.agentId, null);
  assert.throws(() => c.service.simulate(c.operator, c.tenant.id, created.id, { ...input, apply: true }), status(409));
  assert.equal(c.service.simulate(c.operator, c.tenant.id, created.id, { text: 'Olá' }).steps.length, 3);
});

test('fluxos respeitam empresa, edição da revenda e limite de passos', t => {
  const c = setup(t, { maxSteps: 2 }), created = c.service.create(admin, c.tenant.id, { name: 'Teste', graph: graph() });
  const other = c.store.createTenant(admin, { name: 'Outra', segment: 'QA' });
  assert.throws(() => c.service.list(c.operator, other.id), status(403));
  assert.throws(() => c.service.simulate(admin, other.id, created.id), status(404));
  assert.throws(() => c.service.save(c.operator, c.tenant.id, created.id, { version: 1, name: 'Não' }), status(403));
  assert.throws(() => c.service.simulate(admin, c.tenant.id, created.id, { text: 'plano' }), /Limite de passos/);
});

test('destinos novos usam IDs estáveis e condições e resultado mantêm nomes legíveis', t => {
  const c = setup(t), source = graph(); source.nodes.find(node => node.id === 'handoff').config.department = 'support';
  const forgedPins = { draft: { graphHash: '0'.repeat(64), nodes: { route: 'support' } } };
  const created = c.service.create(admin, c.tenant.id, { name: 'Destino estável', graph: source, departmentReferences: forgedPins });
  assert.equal(created.graph.departmentReferenceFormat, 'id-v1');
  assert.equal(created.graph.nodes.find(node => node.id === 'route').config.department, 'sales');
  assert.equal(created.graph.nodes.find(node => node.id === 'handoff').config.department, 'support'); assert.equal(created.departmentReferences, undefined);
  const saved = c.service.save(admin, c.tenant.id, created.id, { version: created.version, graph: graph(), departmentReferences: forgedPins });
  const published = c.service.publish(admin, c.tenant.id, created.id, { version: saved.version, departmentReferences: forgedPins });
  assert.equal(published.versions[0].graph.nodes.find(node => node.id === 'route').config.department, 'sales'); assert.equal(published.departmentReferences, undefined);
  assert.equal(published.versions[0].graph.departmentReferenceFormat, 'id-v1');
  assert.equal(validateFlowGraph(published.graph, c.store.tenant(admin, c.tenant.id)).departmentReferenceFormat, 'id-v1');
  assert.throws(() => validateFlowGraph({ ...published.graph, departmentReferenceFormat: 'name-v2' }, c.store.tenant(admin, c.tenant.id)), status(400));
  const before = c.service.list(admin, c.tenant.id)[0];
  c.store.mutate(admin, c.tenant.id, 'Rename sintético', state => {
    const target = state.departments.find(item => item.id === 'sales'); preserveFlowDepartmentReferences(state, target); target.name = 'Vendas atuais';
    state.departments.push({ id: 'replacement', name: 'Comercial' });
  });
  assert.deepEqual(c.service.list(admin, c.tenant.id)[0], before);
  assert.equal(c.service.simulate(admin, c.tenant.id, created.id, { flowVersion: 1, text: 'plano' }).output.department, 'Vendas atuais');
  const conditional = { nodes: [
    { id: 'start', type: 'start', config: {} }, { id: 'route', type: 'department', config: { department: 'sales' } },
    { id: 'check', type: 'condition', config: { field: 'department', operator: 'equals', value: 'Vendas atuais' } },
    { id: 'yes', type: 'end', config: {} }, { id: 'no', type: 'end', config: {} }
  ], edges: [{ from: 'start', to: 'route' }, { from: 'route', to: 'check' }, { from: 'check', to: 'yes', when: true }, { from: 'check', to: 'no', when: false }] };
  const named = c.service.create(admin, c.tenant.id, { name: 'Condição legível', graph: conditional });
  assert.equal(c.service.simulate(admin, c.tenant.id, named.id).steps.find(step => step.nodeId === 'check').matched, true);
  assert.throws(() => c.service.save(admin, c.tenant.id, created.id, { version: published.version, graph: null }), status(400));
});

test('ID excluído não usa departamento que reutilizou o nome nem altera conversa ou auditoria', t => {
  const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Destino removido', graph: graph() });
  c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
  c.store.mutate(admin, c.tenant.id, 'Exclusão sintética', state => {
    state.departments = state.departments.filter(item => item.id !== 'sales');
    state.departments.push({ id: 'replacement', name: 'Comercial' }, { id: 'id-as-name', name: 'sales' });
  });
  const before = c.store.tenant(admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.throws(() => c.service.simulate(admin, c.tenant.id, created.id, { flowVersion: 1, conversationId: 'conv', conversationVersion: 1, apply: true }), status(400));
  assert.deepEqual(c.store.tenant(admin, c.tenant.id), before); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
});

test('pins legados indisponíveis, de outro grafo ou conflitantes falham fechados', t => {
  for (const corruption of ['missing-id', 'graph-changed', 'not-routing-node', 'explicit-id-conflict']) {
    const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Legado fixado', graph: graph() });
    c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
    c.store.mutate(admin, c.tenant.id, 'Legado e rename sintéticos', state => {
      const flow = state.flows[0]; flow.graph = graph(); flow.versions[0].graph = graph();
      preserveFlowDepartmentReferences(state, state.departments[0]); state.departments[0].name = 'Vendas atuais'; state.departments.push({ id: 'replacement', name: 'Comercial' });
      const refs = flow.departmentReferences.published['1'];
      if (corruption === 'missing-id') state.departments = state.departments.filter(item => item.id !== 'sales');
      if (corruption === 'graph-changed') flow.versions[0].graph.nodes.find(node => node.id === 'route').config.department = 'support';
      if (corruption === 'not-routing-node') refs.nodes = { start: 'sales' };
      if (corruption === 'explicit-id-conflict') {
        flow.versions[0].graph.nodes.find(node => node.id === 'route').config.department = 'support';
        flow.versions[0].graph.departmentReferenceFormat = 'id-v1';
        refs.graphHash = createHash('sha256').update(JSON.stringify(flow.versions[0].graph)).digest('hex');
      }
    });
    const before = c.store.tenant(admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    assert.throws(() => c.service.simulate(admin, c.tenant.id, created.id, { flowVersion: 1, conversationId: 'conv', conversationVersion: 1, apply: true }), status(409), corruption);
    assert.deepEqual(c.store.tenant(admin, c.tenant.id), before, corruption); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits, corruption);
  }
});

test('list entrega grafo do editor com o destino executado e conserva publicação e estado persistido', t => {
  const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Legado no editor', graph: graph() });
  c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
  c.store.mutate(admin, c.tenant.id, 'Legado e rename sintéticos', state => {
    const flow = state.flows[0]; flow.graph = graph(); flow.versions[0].graph = graph();
    preserveFlowDepartmentReferences(state, state.departments[0]); state.departments[0].name = 'Vendas atuais'; state.departments.push({ id: 'replacement', name: 'Comercial' });
  });
  const before = c.store.tenant(admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const listed = c.service.list(c.operator, c.tenant.id)[0];
  assert.equal(listed.editorReferenceIssue, false); assert.equal(listed.editorGraph.departmentReferenceFormat, 'id-v1');
  assert.equal(listed.editorGraph.nodes.find(node => node.id === 'route').config.department, 'sales');
  assert.equal(listed.graph.nodes.find(node => node.id === 'route').config.department, 'Comercial');
  assert.deepEqual(listed.versions, before.flows[0].versions); assert.equal(listed.version, before.flows[0].version);
  assert.equal(c.service.simulate(c.operator, c.tenant.id, listed.id, { text: 'plano' }).output.department, 'Vendas atuais');
  listed.editorGraph.nodes.find(node => node.id === 'route').config.department = 'replacement';
  assert.equal(c.service.list(c.operator, c.tenant.id)[0].editorGraph.nodes.find(node => node.id === 'route').config.department, 'sales');
  assert.deepEqual(c.store.tenant(admin, c.tenant.id), before); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
});

test('list sinaliza vínculo ausente ou conflitante sem sugerir destino por nome ou editar estado', t => {
  for (const corruption of ['missing-id', 'conflicting-hash']) {
    const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Legado inválido no editor', graph: graph() });
    c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
    c.store.mutate(admin, c.tenant.id, 'Legado inválido sintético', state => {
      const flow = state.flows[0]; flow.graph = graph(); flow.versions[0].graph = graph();
      preserveFlowDepartmentReferences(state, state.departments[0]); state.departments[0].name = 'Vendas atuais'; state.departments.push({ id: 'replacement', name: 'Comercial' });
      if (corruption === 'missing-id') state.departments = state.departments.filter(item => item.id !== 'sales');
      else flow.departmentReferences.draft.graphHash = '0'.repeat(64);
    });
    const before = c.store.tenant(admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    const listed = c.service.list(c.operator, c.tenant.id)[0];
    assert.equal(listed.editorGraph, null, corruption); assert.equal(listed.editorReferenceIssue, true, corruption);
    assert.equal(listed.graph.nodes.find(node => node.id === 'route').config.department, 'Comercial');
    assert.deepEqual(listed.versions, before.flows[0].versions); assert.deepEqual(c.store.tenant(admin, c.tenant.id), before);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
  }
});

test('save id-v1 honra escolha explícita cujo ID coincide com o antigo nome legado', t => {
  const c = setup(t), created = c.service.create(admin, c.tenant.id, { name: 'Escolha explícita', graph: graph() });
  c.service.publish(admin, c.tenant.id, created.id, { version: 1 });
  c.store.mutate(admin, c.tenant.id, 'Colisão de nome e ID sintética', state => {
    const flow = state.flows[0]; flow.graph = graph(); flow.versions[0].graph = graph();
    preserveFlowDepartmentReferences(state, state.departments[0]); state.departments[0].name = 'Vendas atuais'; state.departments.push({ id: 'Comercial', name: 'Destino explícito' });
  });
  const before = c.store.tenant(admin, c.tenant.id).flows[0];
  const legacyEditor = c.service.list(c.operator, c.tenant.id)[0];
  assert.equal(legacyEditor.editorReferenceIssue, false); assert.equal(legacyEditor.editorGraph.nodes.find(node => node.id === 'route').config.department, 'sales');
  const selected = { ...graph(), departmentReferenceFormat: 'id-v1' };
  const saved = c.service.save(admin, c.tenant.id, created.id, { version: 2, graph: selected });
  assert.equal(saved.graph.nodes.find(node => node.id === 'route').config.department, 'Comercial');
  assert.equal(saved.graph.departmentReferenceFormat, 'id-v1'); assert.equal(saved.departmentReferences.draft, undefined);
  assert.deepEqual(saved.versions, before.versions); assert.equal(saved.publishedVersion, 1);
  assert.equal(c.service.simulate(c.operator, c.tenant.id, created.id, { text: 'plano' }).output.department, 'Destino explícito');
  assert.equal(c.service.simulate(c.operator, c.tenant.id, created.id, { flowVersion: 1, text: 'plano' }).output.department, 'Vendas atuais');
  const editor = c.service.list(c.operator, c.tenant.id)[0]; assert.equal(editor.editorReferenceIssue, false);
  assert.equal(editor.editorGraph.nodes.find(node => node.id === 'route').config.department, 'Comercial');
});
