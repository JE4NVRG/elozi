import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { AgentMemory, AGENT_MEMORY_LIMITS } from '../src/agent-memory.js';

const admin = { userId: 'memory-reviewer', role: 'reseller', resellerId: 'mep-demo', name: 'Revisor sintético' };
const status = code => error => error.status === code;
function setup(t, { store = new Store(':memory:'), close = true } = {}) {
  if (close) t.after(() => store.close());
  const tenant = store.createTenant(admin, { name: 'Memória própria QA', segment: 'Teste' });
  const agent = { id: 'memory-agent', name: 'Hermes próprio', provider: 'hermes', mode: 'copilot', configured: true, version: 1 };
  store.mutate(admin, tenant.id, 'Fixture própria', state => {
    state.agents = [agent, { ...agent, id: 'other-agent' }];
    state.channels = [{ id: 'origin-channel', kind: 'webchat' }, { id: 'second-channel', kind: 'telegram' }];
    state.contacts = [{ id: 'own-contact', name: 'Mesmo nome', type: 'person', version: 1,
      identities: [{ channelId: 'origin-channel', kind: 'person', externalId: 'conversation:own-conversation' }] },
    { id: 'other-contact', name: 'Mesmo nome', type: 'person', version: 1,
      identities: [{ channelId: 'second-channel', kind: 'person', externalId: '123' }] }];
    state.conversations = [
      { id: 'own-conversation', channelId: 'origin-channel', contactId: 'own-contact', departmentId: 'sales', owner: 'human', assignedUserId: admin.userId, status: 'open', version: 1, messages: [] },
      { id: 'other-conversation', channelId: 'second-channel', contactId: 'other-contact', departmentId: 'support', remoteChatId: '123', owner: 'human', assignedUserId: admin.userId, status: 'open', version: 1, messages: [] }
    ];
  });
  const denied = new Set(), actors = new Map([[admin.userId, admin]]);
  const access = (actor, state, conversation, mode) => !denied.has(`${actor.userId}:${conversation.id}:${mode}`);
  const service = new AgentMemory({ sync: store }, { access, resolveActor: run => actors.get(run.actorUserId) || null });
  const state = () => store.tenant(admin, tenant.id), conversation = (cid = 'own-conversation') => state().conversations.find(item => item.id === cid);
  return { store, tenant, agent, service, state, conversation, denied, actors };
}
function create(c, extra = {}, actor = admin, cid = 'own-conversation') {
  return c.service.create(actor, c.tenant.id, cid, { agentId: c.agent.id, scope: 'contact', title: 'Preferência confirmada', content: 'Prefere atendimento por escrito.', expiresAt: null, conversationVersion: c.conversation(cid).version, reviewed: true, ...extra });
}
function list(c, actor = admin, cid = 'own-conversation', agentId = c.agent.id) { return c.service.list(actor, c.tenant.id, cid, { agentId }); }
function revise(c, record, extra = {}, actor = admin, cid = 'own-conversation') {
  return c.service.update(actor, c.tenant.id, cid, record.id, { version: record.version, conversationVersion: c.conversation(cid).version,
    title: record.title, content: record.content, expiresAt: record.expiresAt, reviewed: true, ...extra });
}
function run(c, cid = 'own-conversation') {
  const state = c.state(), conversation = state.conversations.find(item => item.id === cid);
  const { references, ...memorySnapshot } = c.service.snapshot(admin, state, c.agent, conversation);
  return { agentId: c.agent.id, conversationId: cid, actorUserId: admin.userId, memorySnapshot };
}
function change(c, fn) { return c.store.mutate(admin, c.tenant.id, 'Alteração sintética autorizada', fn); }

test('memória fica em tabela privada, DTO não expõe binding, auditoria não inclui conteúdo e retorno é separado', t => {
  const c = setup(t), record = create(c, { content: 'DADO-PRIVADO-DO-CLIENTE' });
  assert.equal(record.version, 1); assert.equal(record.status, 'active'); assert.equal(record.expired, false);
  assert.deepEqual(record.origin, { conversationId: 'own-conversation', channelId: 'origin-channel', departmentId: 'sales', contactId: 'own-contact' });
  assert.equal(record.createdBy, admin.userId); assert.equal(record.reviewedBy, admin.userId);
  assert.equal(Object.hasOwn(record.origin, 'contactHash'), false); assert.equal(Object.hasOwn(record, 'subjectId'), false);
  assert.equal(JSON.stringify(c.state()).includes('DADO-PRIVADO'), false);
  assert.equal(JSON.stringify(c.store.db.prepare('SELECT action,actor FROM audit WHERE tenant_id=?').all(c.tenant.id)).includes('DADO-PRIVADO'), false);
  record.content = 'Manipulado'; record.origin.contactId = 'other-contact';
  assert.equal(list(c).items[0].content, 'DADO-PRIVADO-DO-CLIENTE'); assert.equal(list(c).items[0].origin.contactId, 'own-contact');
});

test('tabela e revisão sobrevivem à reabertura do SQLite sem outro serviço', t => {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-memory-unit-')), file = join(directory, 'own.sqlite');
  let store = new Store(file);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const c = setup(t, { store, close: false }), record = create(c), edited = revise(c, record, { content: 'Fato revisado persistente.' });
  store.close(); store = new Store(file);
  const reopened = new AgentMemory(store, { access: () => true, resolveActor: () => admin });
  const found = reopened.list(admin, c.tenant.id, 'own-conversation', { agentId: c.agent.id }).items[0];
  assert.equal(found.id, record.id); assert.equal(found.version, 2); assert.equal(found.content, edited.content);
});

test('CAS da memória e atendimento recusa alterações concorrentes sem mudar dado ou auditoria', t => {
  const c = setup(t), record = create(c), edited = revise(c, record, { title: 'Revisão nova' });
  const before = c.store.db.prepare('SELECT count(*) AS count FROM audit WHERE tenant_id=?').get(c.tenant.id).count;
  assert.throws(() => revise(c, record), status(409));
  change(c, state => { state.conversations[0].version++; });
  assert.throws(() => revise(c, edited, { conversationVersion: 1 }), status(409));
  assert.equal(list(c).items[0].version, 2); assert.equal(list(c).items[0].title, 'Revisão nova');
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit WHERE tenant_id=?').get(c.tenant.id).count, before + 1);
});

test('contato requer responsável humano e ACL de escrita; leitura não concede alteração', t => {
  const c = setup(t), operator = { ...admin, userId: 'other-reviewer', role: 'operator', tenantIds: [c.tenant.id] };
  assert.throws(() => create(c, {}, operator), status(403));
  c.denied.add(`${admin.userId}:own-conversation:write`);
  assert.equal(list(c).canWrite, false); assert.throws(() => create(c), status(403));
  c.denied.clear(); change(c, state => { state.conversations[0].owner = 'queue'; });
  assert.throws(() => create(c), status(403));
  change(c, state => { state.conversations[0].owner = 'human'; state.conversations[0].assignedUserId = null; });
  assert.throws(() => create(c), status(403));
});

test('operação exige admin humano; leitura atual/origem basta sem exigir write do contato', t => {
  const c = setup(t), operator = { ...admin, role: 'operator', tenantIds: [c.tenant.id] };
  c.denied.add(`${admin.userId}:own-conversation:write`);
  const record = create(c, { scope: 'operation' });
  assert.equal(list(c).canManageOperation, true); assert.equal(list(c).canWrite, false);
  assert.equal(list(c, operator).items[0].id, record.id); assert.equal(list(c, operator).canManageOperation, false);
  for (const actor of [operator, { ...admin, supportGrantId: 'support-own' }, { ...admin, serviceId: 'service-own' }]) {
    assert.throws(() => create(c, { scope: 'operation' }, actor), status(403));
    assert.throws(() => revise(c, record, {}, actor), status(403));
  }
  c.denied.add(`${admin.userId}:own-conversation:read`);
  assert.throws(() => create(c, { scope: 'operation' }), status(403));
});

test('validação rejeita texto inválido, falta de revisão, campos de autoridade e validade incorreta', t => {
  const c = setup(t);
  const cases = [{ reviewed: false }, { reviewed: undefined }, { title: '' }, { title: 'x'.repeat(101) }, { content: 'x'.repeat(1501) },
    { content: 'inválido\u0000' }, { title: 'linha\nnova' }, { content: '\ud800' }, { expiresAt: '2026-01-01' }, { expiresAt: '2026-02-30T10:00:00Z' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: new Date(Date.now() + 366 * 86400000).toISOString() },
    { scope: 'workspace' }, { contactId: 'other-contact' }, { origin: {} }, { status: 'active' }];
  for (const input of cases) assert.throws(() => create(c, input), status(400));
  assert.equal(list(c).items.length, 0);
  const record = create(c, { title: '  Revisado  ', content: '  Texto em\nduas linhas.  ' });
  assert.equal(record.title, 'Revisado'); assert.equal(record.content, 'Texto em\nduas linhas.');
  assert.throws(() => c.service.archive(admin, c.tenant.id, 'own-conversation', record.id, { version: 1, conversationVersion: 1, reviewed: true }), status(400));
});

test('empresa, revenda e agente ficam isolados mesmo com ids de conversa iguais', t => {
  const c = setup(t), record = create(c);
  assert.equal(list(c, admin, 'own-conversation', 'other-agent').items.length, 0);
  const other = c.store.createTenant(admin, { name: 'Empresa distinta', segment: 'Teste' });
  c.store.mutate(admin, other.id, 'Outra fixture', state => { const original = c.state(); state.agents = original.agents; state.channels = original.channels; state.contacts = original.contacts; state.conversations = original.conversations; });
  assert.equal(c.service.list(admin, other.id, 'own-conversation', { agentId: c.agent.id }).items.length, 0);
  assert.throws(() => c.service.archive(admin, other.id, 'own-conversation', record.id, { version: 1, conversationVersion: 1 }), status(404));
  const resellerId = `reseller_${randomUUID()}`, tenantId = `tenant_${randomUUID()}`;
  c.store.provisionReseller({ resellerId, tenantId, name: 'Outra revenda' });
  assert.throws(() => list(c, { ...admin, resellerId }), status(404));
  assert.throws(() => create(c, { agentId: 'missing-agent' }), status(404));
  change(c, state => { state.agents[1].configured = false; });
  assert.throws(() => list(c, admin, 'own-conversation', 'other-agent'), status(409));
});

test('nome igual não compartilha memória; vínculo explícito multicanal exige ler também a origem', t => {
  const c = setup(t), record = create(c);
  assert.equal(list(c, admin, 'other-conversation').items.length, 0);
  change(c, state => { state.contacts[0].identities.push(state.contacts[1].identities[0]); state.contacts[0].version++; state.contacts[1].identities = []; state.contacts[1].archivedAt = new Date().toISOString(); state.contacts[1].mergedIntoId = state.contacts[0].id; state.conversations[1].contactId = state.contacts[0].id; state.conversations[1].version++; });
  // Existing immutable origin was recorded before union, so it remains suspended.
  assert.equal(list(c, admin, 'other-conversation').items.length, 0);
  const reviewed = create(c);
  assert.equal(list(c, admin, 'other-conversation').items[0].id, reviewed.id);
  c.denied.add(`${admin.userId}:own-conversation:read`);
  assert.equal(list(c, admin, 'other-conversation').items.length, 0);
  assert.throws(() => revise(c, record, {}, admin, 'other-conversation'), status(403));
});

test('canal, departamento, identidade e arquivo da origem suspendem itens; undo não revive run ABA', t => {
  const c = setup(t), record = create(c), first = run(c), original = c.state().contacts[0];
  change(c, state => { state.conversations[0].departmentId = 'new-department'; state.conversations[0].version++; });
  assert.equal(list(c).items.length, 0); assert.equal(c.service.current(c.state(), first), false);
  change(c, state => { state.conversations[0].departmentId = 'sales'; state.conversations[0].version++; });
  assert.equal(list(c).items[0].id, record.id); assert.equal(c.service.current(c.state(), first), false);
  change(c, state => { state.contacts[0].archivedAt = new Date().toISOString(); state.contacts[0].mergedIntoId = 'other-contact'; state.conversations[0].contactId = 'other-contact'; state.conversations[0].version++; });
  assert.equal(list(c).items.length, 0);
  change(c, state => { state.contacts[0] = { ...original, version: 3 }; state.conversations[0].contactId = original.id; state.conversations[0].version++; });
  assert.equal(list(c).items[0].id, record.id); assert.equal(c.service.current(c.state(), first), false);
  change(c, state => { state.contacts[0].identities[0].externalId = 'conversation:another'; });
  assert.equal(list(c).items.length, 0);
});

test('arquivo conserva texto, reativação revisada renova CAS e validade vencida exige edição', t => {
  const c = setup(t), record = create(c, { expiresAt: new Date(Date.now() + 2000).toISOString() }), initial = run(c);
  const archived = c.service.archive(admin, c.tenant.id, 'own-conversation', record.id, { version: 1, conversationVersion: 1 });
  assert.equal(archived.content, record.content); assert.equal(archived.status, 'archived'); assert.equal(c.service.current(c.state(), initial), false);
  assert.equal(list(c).items[0].status, 'archived');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3000 });
  assert.equal(list(c).items[0].expired, true);
  assert.throws(() => c.service.reactivate(admin, c.tenant.id, 'own-conversation', record.id, { version: 2, conversationVersion: 1, reviewed: true }), status(409));
  const renewed = revise(c, archived, { expiresAt: null });
  assert.equal(renewed.status, 'archived');
  const active = c.service.reactivate(admin, c.tenant.id, 'own-conversation', record.id, { version: 3, conversationVersion: 1, reviewed: true });
  assert.equal(active.version, 4); assert.equal(active.status, 'active'); assert.equal(active.content, record.content);
});

test('expiração exclui contexto e invalida uma execução sem apagar registro', t => {
  const c = setup(t), record = create(c, { expiresAt: new Date(Date.now() + 1000).toISOString() }), saved = run(c);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2000 });
  const snapshot = c.service.snapshot(admin, c.state(), c.agent, c.conversation());
  assert.equal(snapshot.references.length, 0); assert.equal(c.service.current(c.state(), saved), false);
  assert.equal(list(c).items[0].id, record.id); assert.equal(list(c).items[0].expired, true);
});

test('snapshot persistível contém só metadata e contexto respeita 12 itens e 4KiB de JSON UTF8', t => {
  const c = setup(t);
  for (let index = 0; index < 15; index++) create(c, { title: `Fato ${index}`, content: `DADO-PRIVADO-${index}` });
  let snapshot = c.service.snapshot(admin, c.state(), c.agent, c.conversation());
  assert.equal(snapshot.references.length, 12); assert.equal(snapshot.pins.length, 12);
  const saved = run(c); assert.equal(JSON.stringify(saved).includes('DADO-PRIVADO'), false); assert.equal(Object.hasOwn(saved.memorySnapshot, 'references'), false);
  assert.equal(Object.hasOwn(saved.memorySnapshot.pins[0], 'title'), false);
  create(c, { title: 'Fato maior', content: '漢'.repeat(1500) });
  snapshot = c.service.snapshot(admin, c.state(), c.agent, c.conversation());
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.references)) <= AGENT_MEMORY_LIMITS.contextBytes);
  assert.ok(snapshot.references.length <= 12); assert.ok(snapshot.references.every(item => item.content.length <= 1500));
  assert.equal(c.service.current(c.state(), saved), false, 'novo fato fora da prévia também invalida seleção completa');
});

test('novo fato invalida snapshot vazio; fato de outro cliente ou agente não invalida', t => {
  const c = setup(t), empty = run(c);
  assert.equal(c.service.current(c.state(), empty), true);
  create(c, {}, admin, 'other-conversation'); create(c, { agentId: 'other-agent' });
  assert.equal(c.service.current(c.state(), empty), true);
  create(c); assert.equal(c.service.current(c.state(), empty), false);
});

test('atualização, revogação, vínculo e responsável atuais invalidam pins sem recuperar texto', t => {
  const c = setup(t), record = create(c), saved = run(c);
  revise(c, record, { content: 'Outro fato revisado' }); assert.equal(c.service.current(c.state(), saved), false);
  const fresh = run(c); c.actors.delete(admin.userId); assert.equal(c.service.current(c.state(), fresh), false);
  c.actors.set(admin.userId, admin); c.denied.add(`${admin.userId}:own-conversation:read`);
  assert.equal(c.service.current(c.state(), fresh), false);
  c.denied.clear(); change(c, state => { state.conversations[0].assignedUserId = 'other-reviewer'; });
  assert.equal(c.service.current(c.state(), fresh), false);
});

test('visible exige ator iniciador vigente e acesso de cada origem do viewer', t => {
  const c = setup(t); create(c, { scope: 'operation' });
  const saved = run(c), viewer = { ...admin, userId: 'viewer-only', role: 'operator', tenantIds: [c.tenant.id] };
  assert.equal(c.service.visible(viewer, c.state(), saved), true);
  c.denied.add(`${viewer.userId}:own-conversation:read`);
  assert.equal(c.service.visible(viewer, c.state(), saved), false);
  c.denied.clear(); c.actors.delete(admin.userId);
  assert.equal(c.service.visible(viewer, c.state(), saved), false);
  assert.equal(c.service.visible(viewer, c.state(), { agentId: c.agent.id }), true);
});

test('copiloto sem fatos privados preserva rascunho visível sem exigir permissão de memória', t => {
  const c = setup(t);
  c.denied.add(`${admin.userId}:own-conversation:read`);
  const saved = run(c);
  assert.deepEqual(saved.memorySnapshot.pins, []);
  assert.equal(saved.memorySnapshot.binding.canRead, false);
  assert.equal(c.service.current(c.state(), saved), true);
  assert.equal(c.service.visible(admin, c.state(), saved), true);
  c.actors.delete(admin.userId);
  assert.equal(c.service.visible(admin, c.state(), saved), false, 'ator iniciador ainda precisa estar vigente');
});

test('serviços e legacy não recebem memória; ACL negativa e conversa sem contato não quebram runtime vazio', t => {
  const c = setup(t), state = c.state(), conversation = state.conversations[0];
  assert.equal(c.service.snapshot({ ...admin, serviceId: 'own-service' }, state, c.agent, conversation), null);
  assert.equal(c.service.snapshot({ ...admin, kind: 'service' }, state, c.agent, conversation), null);
  assert.equal(c.service.snapshot({ ...admin, userId: null }, state, c.agent, conversation), null);
  assert.equal(c.service.current(state, { agentId: c.agent.id }), true);
  c.denied.add(`${admin.userId}:own-conversation:read`);
  const inaccessible = c.service.snapshot(admin, state, c.agent, conversation);
  assert.deepEqual(inaccessible.references, []); assert.equal(inaccessible.binding.canRead, false);
  c.denied.clear(); change(c, data => { delete data.conversations[0].contactId; });
  const saved = run(c); assert.equal(saved.memorySnapshot.binding.contactId, null); assert.equal(c.service.current(c.state(), saved), true);
  assert.throws(() => create(c), status(409));
  create(c, { scope: 'operation' }); assert.equal(c.service.current(c.state(), saved), false);
});

test('resolver indisponível e snapshot malformado falham fechados', t => {
  const c = setup(t), saved = run(c);
  const unavailable = new AgentMemory(c.store, { access: () => true, resolveActor: () => { throw new Error('Resolver privado indisponível'); } });
  assert.equal(unavailable.current(c.state(), saved), false);
  for (const snapshot of [null, [], { ...saved.memorySnapshot, references: [{ content: 'forged' }] }, { ...saved.memorySnapshot, binding: {} }]) {
    assert.equal(c.service.current(c.state(), { ...saved, memorySnapshot: snapshot }), false);
  }
});

test('limite por assunto conta arquivos preservados, sem poda ou reuso automático', t => {
  const c = setup(t);
  for (let index = 0; index < 20; index++) create(c, { title: `Fato ${index}` });
  const first = list(c).items[0]; c.service.archive(admin, c.tenant.id, 'own-conversation', first.id, { version: 1, conversationVersion: 1 });
  assert.throws(() => create(c), status(429)); assert.equal(list(c).items.length, 20);
  create(c, { agentId: 'other-agent' }); assert.equal(list(c, admin, 'own-conversation', 'other-agent').items.length, 1);
});

test('limite agregado por empresa preserva 200 registros distribuídos e recusa o próximo', t => {
  const c = setup(t);
  change(c, state => { state.agents = Array.from({ length: 11 }, (_, index) => ({ ...c.agent, id: `agent-${index}` })); });
  for (let agent = 0; agent < 10; agent++) for (let item = 0; item < 20; item++) create(c, { agentId: `agent-${agent}`, title: `Fato ${item}` });
  assert.throws(() => create(c, { agentId: 'agent-10' }), status(429));
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM agent_memories WHERE reseller_id=? AND tenant_id=?').get(admin.resellerId, c.tenant.id).count, 200);
});

test('falha posterior à escrita reverte memória, JSON da empresa e auditoria na mesma transação', t => {
  const c = setup(t), before = c.store.db.prepare('SELECT count(*) AS count FROM audit WHERE tenant_id=?').get(c.tenant.id).count;
  const prior = JSON.stringify(c.state()); c.store.queuePostgres = () => { throw new Error('Falha sintética da projeção'); };
  assert.throws(() => create(c), /Falha sintética/);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM agent_memories WHERE reseller_id=? AND tenant_id=?').get(admin.resellerId, c.tenant.id).count, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit WHERE tenant_id=?').get(c.tenant.id).count, before);
  assert.equal(JSON.stringify(c.state()), prior);
});

test('ponteiro para contato ativo errado suspende memória e recusa revisão sem backfill', t => {
  const c = setup(t), record = create(c), saved = run(c);
  change(c, state => { state.conversations[0].contactId = 'other-contact'; state.conversations[0].version++; });
  const before = JSON.stringify(c.state());
  assert.deepEqual(list(c).items, []); assert.equal(list(c).canWrite, false);
  assert.throws(() => create(c), status(409)); assert.throws(() => revise(c, record), status(409));
  const empty = run(c); assert.deepEqual(empty.memorySnapshot.pins, []);
  assert.equal(c.service.current(c.state(), empty), true); assert.equal(c.service.current(c.state(), saved), false);
  assert.equal(JSON.stringify(c.state()), before, 'não corrige ponteiro nem acrescenta identidade por inferência');
});

test('ponteiro inexistente e identidade física malformada ficam indisponíveis sem quebrar snapshot vazio', async t => {
  for (const condition of ['missing-contact', 'malformed-remote']) await t.test(condition, child => {
    const c = setup(child);
    change(c, state => {
      if (condition === 'missing-contact') state.conversations[0].contactId = 'missing-contact';
      else { state.channels[0].kind = 'telegram'; state.conversations[0].remoteChatId = 'not-a-chat-id'; }
    });
    assert.equal(list(c).canWrite, false); assert.deepEqual(list(c).items, []);
    assert.throws(() => create(c), status(409));
    const saved = run(c); assert.deepEqual(saved.memorySnapshot.pins, []);
    assert.equal(c.service.current(c.state(), saved), true);
  });
});

test('identidade da origem removida ou duplicada em outro cadastro impede seleção e criação', async t => {
  for (const condition of ['missing', 'duplicate-owner']) await t.test(condition, child => {
    const c = setup(child); create(c);
    change(c, state => {
      if (condition === 'missing') state.contacts[0].identities = [];
      else state.contacts[1].identities.push(structuredClone(state.contacts[0].identities[0]));
    });
    assert.equal(list(c).items.length, 0); assert.equal(list(c).canWrite, false);
    assert.throws(() => create(c), status(409));
    assert.deepEqual(run(c).memorySnapshot.pins, []);
  });
});

test('atendimento atual válido não autoriza fato cuja conversa de origem perdeu a identidade', t => {
  const c = setup(t);
  change(c, state => {
    state.contacts[0].identities.push(state.contacts[1].identities[0]); state.contacts[1].identities = [];
    state.contacts[1].archivedAt = new Date().toISOString(); state.contacts[1].mergedIntoId = 'own-contact';
    state.conversations[1].contactId = 'own-contact'; state.conversations[1].version++;
  });
  const record = create(c), saved = run(c, 'other-conversation');
  assert.equal(list(c, admin, 'other-conversation').items[0].id, record.id);
  change(c, state => { state.contacts[0].identities = state.contacts[0].identities.filter(identity => identity.channelId !== 'origin-channel'); });
  assert.equal(list(c, admin, 'other-conversation').canWrite, true, 'a conversa Telegram atual ainda tem vínculo exato');
  assert.deepEqual(list(c, admin, 'other-conversation').items, []);
  assert.throws(() => revise(c, record, {}, admin, 'other-conversation'), status(403));
  assert.equal(c.service.current(c.state(), saved), false);
});

test('grupo/pessoa e canal divergentes recusam fato mesmo com contactId real e ativo', async t => {
  for (const condition of ['contact-kind', 'conversation-kind', 'wrong-channel']) await t.test(condition, child => {
    const c = setup(child);
    change(c, state => {
      if (condition === 'wrong-channel') state.contacts[0].identities[0].channelId = 'second-channel';
      else {
        state.channels[0].kind = 'telegram'; state.conversations[0].remoteChatId = '-123';
        state.conversations[0].conversationKind = condition === 'conversation-kind' ? 'direct' : 'group';
        state.contacts[0].type = condition === 'contact-kind' ? 'person' : 'group';
        state.contacts[0].identities = [{ channelId: 'origin-channel', kind: 'group', externalId: '-123' }];
      }
    });
    assert.throws(() => create(c), status(409)); assert.deepEqual(list(c).items, []); assert.equal(list(c).canWrite, false);
  });
});

test('WhatsApp exige JID exato; aliases, LID e dispositivo não inferem equivalência de telefone', t => {
  const c = setup(t), phoneJid = '5511000000001@s.whatsapp.net', lid = '987654@lid';
  change(c, state => {
    state.channels[0].kind = 'whatsapp-qr'; state.conversations[0].remoteJid = phoneJid; state.conversations[0].conversationKind = 'direct';
    state.contacts[0].identities = [{ channelId: 'origin-channel', kind: 'person', externalId: phoneJid }];
  });
  const record = create(c); assert.equal(list(c).items[0].id, record.id);
  change(c, state => { state.conversations[0].remoteJid = lid; state.conversations[0].remoteAliases = [phoneJid]; state.contacts[0].remoteAliases = [lid]; });
  assert.throws(() => create(c), status(409)); assert.equal(list(c).items.length, 0);
  change(c, state => { state.contacts[0].identities.push({ channelId: 'origin-channel', kind: 'person', externalId: lid }); });
  const lidRecord = create(c); assert.equal(list(c).items[0].id, lidRecord.id);
  change(c, state => { state.conversations[0].remoteJid = '5511000000001:2@s.whatsapp.net'; });
  assert.throws(() => create(c), status(409));
  change(c, state => { state.contacts[0].identities.push({ channelId: 'origin-channel', kind: 'person', externalId: state.conversations[0].remoteJid }); });
  assert.equal(create(c).status, 'active');
});

test('Telegram e Webchat usam identidade exata, grupos permanecem separados de visitantes', async t => {
  for (const kind of ['telegram-person', 'telegram-group', 'whatsapp-group', 'webchat']) await t.test(kind, child => {
    const c = setup(child);
    change(c, state => {
      if (kind === 'webchat') return;
      const group = kind.endsWith('group'), whatsapp = kind === 'whatsapp-group', externalId = whatsapp ? '12345-67890@g.us' : group ? '-12345' : '12345';
      state.channels[0].kind = whatsapp ? 'whatsapp-qr' : 'telegram';
      state.conversations[0].conversationKind = group ? 'group' : 'direct';
      state.conversations[0][whatsapp ? 'remoteJid' : 'remoteChatId'] = externalId;
      state.contacts[0].type = group ? 'group' : 'person';
      state.contacts[0].identities = [{ channelId: 'origin-channel', kind: group ? 'group' : 'person', externalId }];
    });
    const record = create(c), saved = run(c);
    assert.equal(list(c).items[0].id, record.id); assert.equal(c.service.current(c.state(), saved), true);
    change(c, state => { state.contacts[0].identities[0].externalId += '0'; });
    assert.deepEqual(list(c).items, []); assert.equal(c.service.current(c.state(), saved), false); assert.throws(() => create(c), status(409));
  });
});
