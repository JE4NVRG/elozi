import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations, noteStatus } from '../src/operations.js';
import { FlowService } from '../src/flows.js';

const status = code => error => error.status === code;
const routingGraph = department => ({ nodes: [
  { id: 'start', type: 'start', config: {} },
  { id: 'route', type: 'department', config: { department } },
  { id: 'handoff', type: 'handoff', config: { owner: 'human', department } },
  { id: 'end', type: 'end', config: {} }
], edges: [{ from: 'start', to: 'route' }, { from: 'route', to: 'handoff' }, { from: 'handoff', to: 'end' }] });
const graphHash = graph => createHash('sha256').update(JSON.stringify(graph)).digest('hex');
function legacyFlow(c) {
  const flows = new FlowService(c.store), created = flows.create(c.admin, c.tenant.id, { name: 'Rota aprovada', graph: routingGraph(c.department.name) });
  const published = flows.publish(c.admin, c.tenant.id, created.id, { version: created.version });
  c.store.mutate(c.admin, c.tenant.id, 'Publicação legada sintética', state => {
    const flow = state.flows.find(item => item.id === published.id);
    flow.graph = routingGraph(c.department.name);
    flow.versions[0].graph = routingGraph(c.department.name);
  });
  return { flows, id: published.id };
}
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let userCounter = 0, conversationCounter = 0, clock = Date.parse('2026-10-01T13:00:00Z');
  const addUser = ({ role = 'operator', tenantIds = [], resellerId = 'mep-demo', permissions = null, scopeRules = null, presence = 'available' } = {}) => {
    const row = auth.insertUser({ username: 'synthetic-' + ++userCounter, name: 'Pessoa ' + userCounter }, Buffer.alloc(16, userCounter), Buffer.alloc(64, userCounter), role, tenantIds, resellerId);
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=?,presence=? WHERE id=?').run(permissions === null ? null : JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), presence, row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  };
  const admin = addUser({ role: 'reseller' });
  const tenant = store.createTenant(admin, { name: 'Atendimento sintético', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Canais sintéticos', state => { state.channels = [{ id: 'wa-a', kind: 'whatsapp_qr' }, { id: 'tg-b', kind: 'telegram' }]; });
  const operations = new Operations(store, auth, { now: () => clock });
  const alice = addUser({ tenantIds: [tenant.id] }), bob = addUser({ tenantIds: [tenant.id] });
  const department = operations.create(admin, tenant.id, { name: 'Suporte', memberIds: [alice.userId, bob.userId] });
  const addConversation = (extra = {}) => {
    const conversation = { id: 'conversation-' + ++conversationCounter, contact: 'Cliente sintético', channelId: 'wa-a', departmentId: department.id, department: department.name, owner: 'queue', assignedUserId: null, agentId: null, status: 'open', version: 1, origin: 'whatsapp', messages: [], ...extra };
    store.mutate(admin, tenant.id, 'Conversa sintética', state => state.conversations.push(conversation)); return conversation;
  };
  return { store, auth, admin, tenant, operations, alice, bob, department, addUser, addConversation,
    conversation: id => store.tenant(admin, tenant.id).conversations.find(item => item.id === id),
    time: date => { clock = Date.parse(date); } };
}

test('departamentos têm CAS, membros do tenant, revisão preservada e padrão escolhido explicitamente', t => {
  const c = fixture(t), id = c.tenant.id;
  assert.equal(c.store.tenant(c.admin, id).defaultDepartmentId, undefined);
  assert.equal(c.operations.list(c.admin, id)[0].isDefault, false);
  const configured = c.operations.update(c.admin, id, c.department.id, { version: 1, isDefault: true, distribution: 'round_robin' });
  assert.equal(configured.version, 2); assert.equal(configured.isDefault, true);
  assert.equal(c.store.tenant(c.admin, id).defaultDepartmentId, c.department.id);
  assert.throws(() => c.operations.update(c.admin, id, c.department.id, { version: 1, name: 'Revisão antiga' }), status(409));
  const archived = c.operations.update(c.admin, id, c.department.id, { version: 2, active: false });
  assert.equal(archived.active, false); assert.equal(archived.isDefault, false);
  assert.equal(c.store.tenant(c.admin, id).defaultDepartmentId, null);
  assert.equal(c.operations.list(c.admin, id).length, 1);
  assert.throws(() => c.operations.update(c.admin, id, c.department.id, { version: 3, isDefault: true }), status(400));
  assert.throws(() => c.operations.create(c.admin, id, { name: ' suporte ' }), status(409));
  assert.throws(() => c.operations.create({ ...c.alice, role: 'reseller' }, id, { name: 'Elevação' }), status(403));
  const other = c.store.createTenant(c.admin, { name: 'Outra empresa', segment: 'QA' });
  const foreign = c.addUser({ tenantIds: [other.id] });
  assert.throws(() => c.operations.create(c.admin, id, { name: 'Fora', memberIds: [foreign.userId] }), status(400));
  c.auth.disableUser(c.admin, c.bob.userId);
  assert.throws(() => c.operations.create(c.admin, id, { name: 'Desativado', memberIds: [c.bob.userId] }), status(400));
});

test('renomear departamento preserva a publicação legada e reutilizar o nome não muda o destino', t => {
  const c = fixture(t), { flows, id } = legacyFlow(c), before = flows.list(c.admin, c.tenant.id)[0];
  const auditBefore = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  let queued = 0; c.store.queuePostgres = tenantId => { assert.equal(tenantId, c.tenant.id); queued++; };
  const renamed = c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, name: 'Atendimento' });
  assert.equal(renamed.id, c.department.id); assert.equal(renamed.version, 2);
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 1 }).output.department, 'Atendimento');
  const afterRename = flows.list(c.admin, c.tenant.id)[0], { departmentReferences, ...unchanged } = afterRename;
  assert.deepEqual(unchanged, before);
  assert.equal(departmentReferences.published['1'].graphHash, graphHash(before.versions[0].graph));
  assert.deepEqual(departmentReferences.published['1'].nodes, { route: c.department.id, handoff: c.department.id });
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditBefore + 1); assert.equal(queued, 1);
  const reused = c.operations.create(c.admin, c.tenant.id, { name: 'Suporte' });
  assert.notEqual(reused.id, c.department.id);
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 1 }).output.department, 'Atendimento');
  assert.equal(flows.simulate(c.admin, c.tenant.id, id).output.department, 'Atendimento');
  assert.equal(flows.list(c.admin, c.tenant.id).length, 1); assert.equal(flows.list(c.admin, c.tenant.id)[0].versions.length, 1);
  const checkpoint = c.store.tenant(c.admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.throws(() => c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, name: 'Outra' }), status(409));
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id), checkpoint); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
  const saved = flows.save(c.admin, c.tenant.id, id, { version: before.version, description: 'Revisão explícita' });
  assert.equal(saved.version, before.version + 1); assert.equal(saved.publishedVersion, before.publishedVersion);
  assert.deepEqual(saved.versions, before.versions);
});

test('falha ao persistir rename reverte os pins e a auditoria na mesma transação', t => {
  const c = fixture(t); legacyFlow(c);
  const before = c.store.tenant(c.admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  c.store.queuePostgres = () => { throw new Error('Persistência sintética indisponível'); };
  assert.throws(() => c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, name: 'Atendimento' }), /Persistência sintética/);
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id), before);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
});

test('rename de referência legada ambígua falha sem editar departamento, publicação ou auditoria', t => {
  const c = fixture(t); legacyFlow(c);
  c.store.mutate(c.admin, c.tenant.id, 'Ambiguidade legada sintética', state => { state.departments.push({ ...state.departments[0], id: 'duplicated-legacy' }); });
  const before = c.store.tenant(c.admin, c.tenant.id), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.throws(() => c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, name: 'Atendimento' }), status(409));
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id), before); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
});

test('save e publicação explícitos recalculam IDs sem trocar vínculos de versões anteriores', t => {
  const c = fixture(t), { flows, id } = legacyFlow(c), original = flows.list(c.admin, c.tenant.id)[0];
  c.operations.update(c.admin, c.tenant.id, c.department.id, { version: 1, name: 'Atendimento' });
  const replacement = c.operations.create(c.admin, c.tenant.id, { name: 'Suporte' });
  const saved = flows.save(c.admin, c.tenant.id, id, { version: original.version, graph: routingGraph('Suporte'), departmentReferences: { draft: { nodes: { route: replacement.id } } } });
  assert.equal(saved.graph.nodes.find(node => node.id === 'route').config.department, c.department.id);
  assert.equal(saved.graph.nodes.find(node => node.id === 'handoff').config.department, c.department.id);
  assert.equal(saved.departmentReferences.draft, undefined); assert.deepEqual(saved.versions, original.versions);
  const published = flows.publish(c.admin, c.tenant.id, id, { version: saved.version });
  assert.equal(published.publishedVersion, 2); assert.deepEqual(published.versions[0], original.versions[0]);
  assert.equal(published.versions[1].graph.nodes.find(node => node.id === 'route').config.department, c.department.id);
  assert.deepEqual(Object.keys(published.departmentReferences.published), ['1']);
  const selected = flows.save(c.admin, c.tenant.id, id, { version: published.version, graph: routingGraph(replacement.id) });
  flows.publish(c.admin, c.tenant.id, id, { version: selected.version });
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 1 }).output.department, 'Atendimento');
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 2 }).output.department, 'Atendimento');
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 3 }).output.department, 'Suporte');
  c.operations.update(c.admin, c.tenant.id, replacement.id, { version: 1, name: 'Suporte alternativo' });
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 1 }).output.department, 'Atendimento');
  assert.equal(flows.simulate(c.admin, c.tenant.id, id, { flowVersion: 3 }).output.department, 'Suporte alternativo');
  assert.deepEqual(flows.list(c.admin, c.tenant.id)[0].versions[0], original.versions[0]);
});

test('assumir vincula pessoa real e legado human sem ID continua sem responsável', t => {
  const c = fixture(t), conversation = c.addConversation({ owner: 'human', assignedUserId: undefined });
  assert.throws(() => c.operations.canReply(c.alice, c.tenant.id, conversation), status(409));
  assert.throws(() => c.operations.canReply(c.admin, c.tenant.id, conversation), status(409));
  const assigned = c.operations.assign(c.alice, c.tenant.id, conversation.id, { version: 1, owner: 'human' });
  assert.equal(assigned.assignedUserId, c.alice.userId); assert.equal(assigned.assignedUserName, c.alice.name);
  assert.equal(assigned.version, 2); assert.equal(assigned.origin, 'whatsapp');
  assert.equal(c.operations.canReply(c.alice, c.tenant.id, assigned), true);
  assert.throws(() => c.operations.canReply(c.bob, c.tenant.id, { ...assigned, assignedUserId: c.bob.userId }), status(409));
  assert.equal(assigned.attendantEvents[0].actorId, c.alice.userId);
  assert.equal(assigned.attendantEvents[0].from.assignedUserId, null);
  assert.equal(assigned.attendantEvents[0].to.assignedUserId, c.alice.userId);
  assert.equal(assigned.messages.at(-1).kind, 'system');
});

test('operador não rouba conversa e transferências exigem titular e permissão explícita', t => {
  const c = fixture(t), conversation = c.addConversation();
  const first = c.operations.assign(c.alice, c.tenant.id, conversation.id, { version: 1, owner: 'human' });
  assert.throws(() => c.operations.assign({ ...c.bob, role: 'reseller' }, c.tenant.id, conversation.id, { version: 2, owner: 'human' }), status(409));
  assert.throws(() => c.operations.assign(c.bob, c.tenant.id, conversation.id, { version: 2, owner: 'human', assignedUserId: c.alice.userId }), status(409));
  const second = c.operations.assign(c.alice, c.tenant.id, conversation.id, { version: first.version, owner: 'human', assignedUserId: c.bob.userId, reason: 'Troca de turno' });
  assert.equal(second.assignedUserId, c.bob.userId); assert.equal(second.version, 3);
  assert.throws(() => c.operations.canReply(c.alice, c.tenant.id, second), status(409));
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read', 'inbox.reply']), c.bob.userId);
  assert.throws(() => c.operations.assign(c.bob, c.tenant.id, conversation.id, { version: 3, owner: 'queue' }), status(403));
  const administrator = c.operations.assign(c.admin, c.tenant.id, conversation.id, { version: 3, owner: 'human' });
  assert.equal(administrator.assignedUserId, c.admin.userId);
  assert.equal(c.operations.canReply(c.admin, c.tenant.id, administrator), true);
});

test('duas mudanças da mesma revisão geram um único evento e sem edição parcial', t => {
  const c = fixture(t), conversation = c.addConversation();
  c.operations.assign(c.alice, c.tenant.id, conversation.id, { version: 1, owner: 'human' });
  assert.throws(() => c.operations.assign(c.bob, c.tenant.id, conversation.id, { version: 1, owner: 'human' }), status(409));
  const current = c.conversation(conversation.id);
  assert.equal(current.attendantEvents.length, 1); assert.equal(current.version, 2); assert.equal(current.assignedUserId, c.alice.userId);
  assert.throws(() => c.operations.assign(c.admin, c.tenant.id, conversation.id, { owner: 'queue' }), status(400));
  assert.throws(() => c.operations.assign(c.admin, c.tenant.id, conversation.id, { version: 2, owner: 'queue', platformAdmin: true }), status(400));
  assert.equal(c.conversation(conversation.id).version, 2);
});

test('canal e departamento delimitam assumir, responder, transferir e pessoas elegíveis', t => {
  const c = fixture(t), id = c.tenant.id;
  const restricted = c.addUser({ tenantIds: [id], scopeRules: { [id]: { channelIds: ['wa-a'], departmentIds: [c.department.id] } } });
  c.operations.update(c.admin, id, c.department.id, { version: 1, memberIds: [c.alice.userId, c.bob.userId, restricted.userId] });
  const wa = c.addConversation(), tg = c.addConversation({ channelId: 'tg-b' });
  assert.equal(c.operations.assign(restricted, id, wa.id, { version: 1, owner: 'human' }).assignedUserId, restricted.userId);
  assert.throws(() => c.operations.assign(restricted, id, tg.id, { version: 1, owner: 'human' }), status(403));
  assert.throws(() => c.operations.assign(c.admin, id, tg.id, { version: 1, owner: 'human', assignedUserId: restricted.userId }), status(400));
  const secondDepartment = c.operations.create(c.admin, id, { name: 'Comercial', memberIds: [c.alice.userId] });
  assert.throws(() => c.operations.assign(restricted, id, wa.id, { version: 2, owner: 'human', departmentId: secondDepartment.id }), status(403));
  assert.equal(c.operations.list(restricted, id).length, 1);
  assert.equal(c.operations.assignees(c.admin, id, { channelId: 'tg-b', departmentId: c.department.id }).some(user => user.id === restricted.userId), false);
  assert.throws(() => c.operations.assign(c.admin, id, wa.id, { version: 2, owner: 'human', assignedUserId: c.bob.userId, departmentId: secondDepartment.id }), status(400));
  assert.equal(c.conversation(wa.id).departmentId, c.department.id);
});

test('legado textual é resolvido sem perder origem e retirada do departamento exige destino permitido', t => {
  const c = fixture(t), conversation = c.addConversation({ departmentId: undefined });
  const assigned = c.operations.assign(c.alice, c.tenant.id, conversation.id, { version: 1, owner: 'human' });
  assert.equal(assigned.departmentId, c.department.id); assert.equal(assigned.department, 'Suporte');
  const unknown = c.addConversation({ departmentId: undefined, department: 'Departamento legado' });
  const taken = c.operations.assign(c.admin, c.tenant.id, unknown.id, { version: 1, owner: 'human' });
  assert.equal(taken.department, 'Departamento legado');
  const moved = c.operations.assign(c.admin, c.tenant.id, unknown.id, { version: 2, owner: 'queue', departmentId: null });
  assert.equal(moved.departmentId, null); assert.equal(moved.department, '');
  assert.equal(moved.assignedUserId, null); assert.equal(moved.agentId, null);
});

test('atribuição a agente requer copiloto configurado e fila limpa todas as identidades', t => {
  const c = fixture(t), conversation = c.addConversation();
  c.store.mutate(c.admin, c.tenant.id, 'Agentes sintéticos', state => { state.agents = [{ id: 'copilot', name: 'Copiloto QA', mode: 'copilot', configured: true }, { id: 'planned', mode: 'copilot', configured: false }, { id: 'automatic', mode: 'automatic', configured: true }]; });
  for (const agentId of ['planned', 'automatic']) assert.throws(() => c.operations.assign(c.admin, c.tenant.id, conversation.id, { version: 1, owner: 'agent', agentId }), status(409));
  assert.throws(() => c.operations.assign(c.admin, c.tenant.id, conversation.id, { version: 1, owner: 'agent', agentId: 'foreign-agent' }), status(404));
  const assigned = c.operations.assign(c.admin, c.tenant.id, conversation.id, { version: 1, owner: 'agent', agentId: 'copilot' });
  assert.equal(assigned.assignedUserId, null); assert.equal(assigned.agentId, 'copilot');
  assert.match(assigned.messages.at(-1).text, /envio permanece com a equipe humana/);
  assert.throws(() => c.operations.canReply(c.admin, c.tenant.id, assigned), status(409));
  const queued = c.operations.assign(c.admin, c.tenant.id, conversation.id, { version: 2, owner: 'queue' });
  assert.equal(queued.assignedUserId, null); assert.equal(queued.assignedUserName, null); assert.equal(queued.agentId, null);
});

test('distribuição circular persiste cursor e revisão e ignora busy, away, offline e desativados', t => {
  const c = fixture(t), id = c.tenant.id;
  c.operations.update(c.admin, id, c.department.id, { version: 1, distribution: 'round_robin', isDefault: true });
  const first = c.addConversation(), second = c.addConversation(), third = c.addConversation();
  assert.equal(c.operations.routeIncoming(id, first.id).assignedUserId, c.alice.userId);
  assert.equal(c.operations.routeIncoming(id, second.id).assignedUserId, c.bob.userId);
  assert.equal(c.operations.routeIncoming(id, third.id).assignedUserId, c.alice.userId);
  assert.equal(c.operations.list(c.admin, id)[0].version, 5);
  for (const presence of ['busy', 'away', 'offline']) {
    c.auth.updatePresence(c.bob, presence);
    const next = c.addConversation(); assert.equal(c.operations.routeIncoming(id, next.id).assignedUserId, c.alice.userId);
  }
  c.auth.updatePresence(c.bob, 'available'); c.auth.disableUser(c.admin, c.bob.userId);
  const next = c.addConversation(); assert.equal(c.operations.routeIncoming(id, next.id).assignedUserId, c.alice.userId);
  c.auth.updatePresence(c.alice, 'offline');
  const waiting = c.addConversation(), before = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.equal(c.operations.routeIncoming(id, waiting.id), null);
  assert.equal(c.conversation(waiting.id).version, 1); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, before);
});

test('routing não toma responsável existente e não distribui canal fora do grant nem departamento inativo', t => {
  const c = fixture(t), id = c.tenant.id;
  c.operations.update(c.admin, id, c.department.id, { version: 1, distribution: 'round_robin', memberIds: [c.alice.userId] });
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [id]: { channelIds: ['wa-a'] } }), c.alice.userId);
  const restricted = c.addConversation({ channelId: 'tg-b' }); assert.equal(c.operations.routeIncoming(id, restricted.id), null);
  const assigned = c.addConversation({ owner: 'human', assignedUserId: c.bob.userId }); assert.equal(c.operations.routeIncoming(id, assigned.id), null);
  const closed = c.addConversation({ status: 'closed' }); assert.equal(c.operations.routeIncoming(id, closed.id), null);
  const agent = c.addConversation({ owner: 'agent', agentId: 'already-copilot' }); assert.equal(c.operations.routeIncoming(id, agent.id), null);
  const version = c.operations.list(c.admin, id)[0].version;
  c.operations.update(c.admin, id, c.department.id, { version, active: false });
  assert.equal(c.operations.routeIncoming(id, c.addConversation().id), null);
});

test('desativação devolve apenas atendimentos abertos do usuário à fila com IDs para invalidar', t => {
  const c = fixture(t), open = c.addConversation({ owner: 'human', assignedUserId: c.alice.userId }), pending = c.addConversation({ owner: 'human', assignedUserId: c.alice.userId, status: 'pending' }), closed = c.addConversation({ owner: 'human', assignedUserId: c.alice.userId, status: 'closed' }), other = c.addConversation({ owner: 'human', assignedUserId: c.bob.userId });
  c.auth.disableUser(c.admin, c.alice.userId);
  const released = c.operations.releaseUser(c.admin, c.alice.userId);
  assert.deepEqual(released.map(item => item.conversationId).sort(), [open.id, pending.id].sort());
  for (const item of released) { assert.equal(item.tenantId, c.tenant.id); const current = c.conversation(item.conversationId); assert.equal(current.owner, 'queue'); assert.equal(current.assignedUserId, null); assert.equal(current.version, 2); assert.equal(current.attendantEvents[0].origin, 'user-disabled'); }
  assert.equal(c.conversation(closed.id).assignedUserId, c.alice.userId); assert.equal(c.conversation(other.id).assignedUserId, c.bob.userId);
  assert.deepEqual(c.operations.releaseUser(c.admin, c.alice.userId), []);
  assert.throws(() => c.operations.releaseUser({ ...c.bob, role: 'reseller' }, c.alice.userId), status(403));
  const foreign = c.addUser({ role: 'reseller', resellerId: 'foreign-reseller' });
  assert.throws(() => c.operations.releaseUser(c.admin, foreign.userId), status(404));
});

test('indicadores contam período, evento único e autoria real sem inferir fechamentos de snapshots', t => {
  const c = fixture(t), id = c.tenant.id, conversation = c.addConversation({ messages: [{ id: 'customer', kind: 'customer', createdAt: '2026-10-01T13:00:00Z' }] });
  c.time('2026-10-01T13:01:00Z'); c.operations.assign(c.alice, id, conversation.id, { version: 1, owner: 'human' });
  c.store.mutate(c.admin, id, 'Resposta e fechamento sintéticos', state => {
    const current = state.conversations.find(item => item.id === conversation.id);
    const reply = { id: 'reply', kind: 'human', delivery: 'sent', authorUserId: c.alice.userId, authorName: c.alice.name, createdAt: '2026-10-01T13:02:00Z' };
    current.messages.push(reply, { ...reply }, { id: 'failed', kind: 'human', delivery: 'failed', createdAt: '2026-10-01T13:00:01Z' });
    current.status = 'closed'; noteStatus(current, c.alice, 'open', { createdAt: '2026-10-01T13:03:00Z' });
    current.attendantEvents.push({ ...current.attendantEvents.at(-1) });
  });
  c.addConversation({ status: 'closed', messages: [{ id: 'older', kind: 'customer', createdAt: '2026-09-30T13:00:00Z' }, { id: 'legacy-human', kind: 'human', createdAt: '2026-10-01T13:04:00Z' }] });
  const metrics = c.operations.metrics(c.admin, id, { from: '2026-10-01T13:00:00Z', to: '2026-10-01T14:00:00Z' });
  assert.equal(metrics.totals.conversationsReceived, 1); assert.equal(metrics.totals.incomingMessages, 1);
  assert.equal(metrics.totals.humanMessages, 2); assert.equal(metrics.totals.closed, 1); assert.equal(metrics.totals.assignments, 1);
  assert.equal(metrics.totals.firstReplies, 2); assert.equal(metrics.firstReply.samples, 2);
  const person = metrics.attendants.find(item => item.id === c.alice.userId);
  assert.equal(person.name, c.alice.name); assert.equal(person.humanMessages, 1); assert.equal(person.closed, 1); assert.equal(person.averageFirstReplySeconds, 120);
  assert.equal(metrics.attendants.length, 1); assert.equal(metrics.coverage.recordedEvents, 2);
  const outside = c.operations.metrics(c.admin, id, { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' });
  assert.equal(outside.totals.closed, 0); assert.equal(outside.firstReply.averageSeconds, null);
});

test('indicadores respeitam grant de cada conversa e períodos inválidos não produzem números', t => {
  const c = fixture(t), id = c.tenant.id;
  const restricted = c.addUser({ tenantIds: [id], scopeRules: { [id]: { channelIds: ['wa-a'] } } });
  c.addConversation({ messages: [{ id: 'allowed', kind: 'customer', createdAt: '2026-10-01T13:00:00Z' }] });
  c.addConversation({ channelId: 'tg-b', messages: [{ id: 'hidden', kind: 'customer', createdAt: '2026-10-01T13:00:00Z' }] });
  assert.equal(c.operations.metrics(restricted, id).totals.incomingMessages, 1);
  assert.throws(() => c.operations.metrics(restricted, id, { from: 'inválido' }), status(400));
  assert.throws(() => c.operations.metrics(restricted, id, { from: '2026-10-02', to: '2026-10-01' }), status(400));
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), restricted.userId);
  assert.throws(() => c.operations.metrics(restricted, id), status(403));
});

test('compatibilidade sem identidade fica restrita às fixtures internas e conversa fechada exige reabrir', t => {
  const c = fixture(t), conversation = c.addConversation({ owner: 'human' });
  const internal = { role: 'reseller', resellerId: 'mep-demo', name: 'Fixture interna' };
  assert.equal(c.operations.canReply(internal, c.tenant.id, conversation), true);
  assert.throws(() => c.operations.canReply(c.admin, c.tenant.id, conversation), status(409));
  const closed = c.addConversation({ status: 'closed', owner: 'human', assignedUserId: c.alice.userId });
  assert.throws(() => c.operations.assign(c.admin, c.tenant.id, closed.id, { version: 1, owner: 'human' }), status(409));
  assert.throws(() => c.operations.canReply(c.alice, c.tenant.id, closed), status(409));
  assert.throws(() => c.operations.canReply(internal, c.tenant.id, closed), status(409));
});

test('participantes exibem foto atual autorizada sem gravar imagem na conversa', t => {
  const c=fixture(t), image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6wS8AAAAASUVORK5CYII=';
  for(const user of [c.alice,c.bob]) c.auth.updateProfile(user,{avatar:image});
  const conversation=c.addConversation({owner:'human',assignedUserId:c.alice.userId,assignedUserName:c.alice.name});
  const before=c.operations.participants(c.admin,c.tenant.id,conversation.id);
  assert.equal(before.responsible.avatar,image);
  assert.equal(before.eligible.find(u=>u.id===c.bob.userId).avatar,image);
  c.operations.updateParticipants(c.admin,c.tenant.id,conversation.id,{version:1,action:'add',userId:c.bob.userId});
  const dto=c.operations.participants(c.alice,c.tenant.id,conversation.id);
  assert.equal(dto.participants.find(u=>u.userId===c.bob.userId).avatar,image);
  assert.equal(Object.hasOwn(c.conversation(conversation.id).participants[0],'avatar'),false);
  c.auth.updateProfile(c.bob,{avatar:null});
  assert.equal(c.operations.participants(c.alice,c.tenant.id,conversation.id).participants[0].avatar??null,null);
});

test('fotos de participantes revogados, encerrados ou inválidas não chegam ao DTO', t => {
  const c=fixture(t), image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6wS8AAAAASUVORK5CYII=';
  c.auth.updateProfile(c.bob,{avatar:image});
  const conversation=c.addConversation({owner:'human',assignedUserId:c.alice.userId,assignedUserName:c.alice.name});
  c.operations.updateParticipants(c.admin,c.tenant.id,conversation.id,{version:1,action:'add',userId:c.bob.userId});
  c.store.db.prepare('UPDATE auth_users SET avatar=? WHERE id=?').run('https://example.invalid/private-photo',c.alice.userId);
  assert.equal(c.operations.participants(c.admin,c.tenant.id,conversation.id).responsible.avatar??null,null);
  c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(),c.bob.userId);
  const revoked=c.operations.participants(c.admin,c.tenant.id,conversation.id).participants[0];
  assert.equal(revoked.eligible,false);assert.equal(revoked.avatar??null,null);
  assert.equal(c.operations.participants(c.alice,c.tenant.id,conversation.id).participants[0].avatar??null,null);
  c.store.db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(c.bob.userId);
  c.store.mutate(c.admin,c.tenant.id,'Encerramento sintético',state=>state.conversations.find(x=>x.id===conversation.id).status='closed');
  assert.equal(c.operations.participants(c.admin,c.tenant.id,conversation.id).participants.length,0);
});
