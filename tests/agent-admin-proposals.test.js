import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { AgentAdminProposals } from '../src/agent-admin-proposals.js';

const status = code => error => error.status === code;
const graph = department => ({ nodes: [{ id: 'start', type: 'start' }, { id: 'route', type: 'department', config: { department } }, { id: 'end', type: 'end' }], edges: [{ from: 'start', to: 'route' }, { from: 'route', to: 'end' }], departmentReferenceFormat: 'id-v1' });
function fixture(t, capabilities = ['company.read', 'company.propose']) {
  const store = new Store(':memory:'); new Outbox(store);
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'company.proposal.admin', name: 'Administrador sintético' }, Buffer.alloc(16, 5), Buffer.alloc(64, 5), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Empresa de propostas QA', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture propostas', state => {
    state.channels = [{ id: 'wa', name: 'Canal autorizado', kind: 'whatsapp_qr', state: 'planned', expectedNumber: 'private-number' }, { id: 'hidden', name: 'private-channel', kind: 'telegram', state: 'planned', token: 'private-token' }];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'private-department', active: true }];
    state.agents = [{ id: 'planner', provider: 'mcp', mode: 'copilot', configured: true, version: 1, name: 'Planejador', description: 'private-agent-prompt', endpoint: 'https://private-endpoint.invalid', tools: ['conversation.read', 'reply.submit'] }];
    state.flows = [{ id: 'existing', name: 'Fluxo já publicado', state: 'published', version: 2, publishedVersion: 1, graph: graph('support'), versions: [{ version: 1 }] }];
    state.conversations = [{ id: 'private-customer', channelId: 'wa', departmentId: 'support', version: 1, status: 'open', owner: 'human', messages: [{ id: 'message', kind: 'customer', text: 'private-customer-message' }] }];
    state.contacts = [{ id: 'contact', name: 'private-customer-name', notes: ['private-note'] }]; state.agentMemories = [{ content: 'private-memory' }];
  });
  const principals = new ServicePrincipals(store, auth), proposals = new AgentAdminProposals(store, principals, { auth });
  const created = principals.create(admin, tenant.id, { name: 'Planejador QA', agentId: 'planner', capabilities, channelIds: ['wa'], departmentIds: ['support'], dailyRequests: 20, maxConcurrent: 1 });
  const actor = principals.authenticate('Bearer ' + created.token);
  t.after(() => store.close());
  return { store, auth, admin, tenant, principals, proposals, created, actor,
    input: extra => ({ requestId: 'synthetic_proposal_001', type: 'flow', name: 'Fluxo sugerido', description: 'Proposta para revisão humana.', graph: graph('support'), ...extra }),
    current: () => store.tenant(admin, tenant.id), quota: () => principals.list(admin, tenant.id).principals[0].usage,
    assertNoSend: () => { assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(store.tenant(admin, tenant.id).conversations[0].messages.length, 1); } };
}

test('leitura da empresa usa somente concessões próprias e não fornece dados de clientes ou privados', t => {
  const f = fixture(t), result = f.proposals.readCompany(f.actor, 'synthetic_company_001'), again = f.proposals.readCompany(f.actor, 'synthetic_company_001');
  assert.equal(result.company.id, f.tenant.id); assert.deepEqual(result.channels.map(item => item.id), ['wa']); assert.deepEqual(result.departments.map(item => item.id), ['support']);
  assert.equal(result.agents[0].description, undefined); assert.equal(result.flows[0].graph, undefined); assert.equal(result.receipt, again.receipt); assert.equal(f.quota().requests, 1);
  for (const secret of ['private-number', 'private-channel', 'private-department', 'private-token', 'private-agent-prompt', 'private-endpoint', 'private-customer', 'private-note', 'private-memory']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.conversations, undefined); assert.equal(result.agentAdminProposals, undefined); f.assertNoSend();
});

test('proposta é idempotente, consumindo uma cota sem criar ou modificar fluxo, agente ou autoridade', async t => {
  const f = fixture(t), before = JSON.stringify({ flows: f.current().flows, agents: f.current().agents, channels: f.current().channels }), users = f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n;
  const results = await Promise.all([Promise.resolve().then(() => f.proposals.propose(f.actor, f.input())), Promise.resolve().then(() => f.proposals.propose(f.actor, f.input()))]);
  assert.equal(results[0].proposal.id, results[1].proposal.id); assert.equal(results[0].proposal.state, 'pending'); assert.equal(results[0].receipt.id, results[1].receipt.id); assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 0);
  assert.equal(f.current().agentAdminProposals.length, 1); assert.equal(JSON.stringify({ flows: f.current().flows, agents: f.current().agents, channels: f.current().channels }), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, users); assert.equal(JSON.stringify(results[0].receipt).includes('Proposta para revisão humana'), false);
  assert.throws(() => f.proposals.propose(f.actor, f.input({ name: 'Outra proposta' })), status(409)); f.assertNoSend();
});

test('lista humana identifica nome do serviço somente no workspace e empresa da proposta, sem stamps', t => {
  const f = fixture(t); f.proposals.propose(f.actor, f.input());
  const item = f.proposals.list(f.admin, f.tenant.id).proposals[0]; assert.equal(item.serviceName, 'Planejador QA');
  for (const stamp of ['serviceRevision', 'serviceKeyRevision', 'serviceAdapterHash', 'receiptId']) assert.equal(item[stamp], undefined);
  const other = f.store.createTenant(f.admin, { name: 'Outra empresa QA', segment: 'QA' });
  f.store.mutate(f.admin, other.id, 'Fixture de nome isolado', state => { state.agentAdminProposals = structuredClone(f.current().agentAdminProposals); });
  const isolated = f.proposals.list(f.admin, other.id).proposals[0]; assert.equal(isolated.serviceName, 'Serviço indisponível'); assert.equal(isolated.canApprove, false);
});

test('aprovação humana cria somente fluxo draft no formato histórico e decide atomicamente por CAS', async t => {
  const f = fixture(t), original = JSON.stringify(f.current().flows[0]), proposed = f.proposals.propose(f.actor, f.input());
  const outcomes = await Promise.allSettled([Promise.resolve().then(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' })), Promise.resolve().then(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }))]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(outcomes.find(item => item.status === 'rejected').reason.status, 409);
  const result = outcomes.find(item => item.status === 'fulfilled').value;
  assert.equal(result.proposal.state, 'approved'); assert.equal(result.proposal.version, 2); assert.equal(result.proposal.decidedBy, f.admin.userId); assert.equal(result.entity.state, 'draft'); assert.equal(result.entity.version, 1);
  assert.match(result.entity.id, /^[a-f0-9-]{36}$/); assert.deepEqual(result.entity.versions, []); assert.equal(result.entity.publishedVersion, null); assert.equal(result.entity.graph.departmentReferenceFormat, 'id-v1');
  assert.equal(f.current().flows.length, 2); assert.equal(JSON.stringify(f.current().flows[0]), original);
  const replay = f.proposals.propose(f.actor, f.input()); assert.equal(replay.proposal.state, 'approved'); assert.equal(replay.proposal.entityId, result.entity.id); assert.equal(f.current().flows.length, 2); f.assertNoSend();
});

test('aprovação de agente cria somente MCP copilot aguardando conexão, sem usuário ou chave', t => {
  const f = fixture(t), humans = f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, services = f.store.db.prepare('SELECT count(*) n FROM service_principals').get().n;
  const proposed = f.proposals.propose(f.actor, { requestId: 'synthetic_agent_001', type: 'agent', name: 'Copiloto sugerido', description: 'Agente externo para revisão.' });
  assert.equal(f.current().agents.length, 1);
  const result = f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' });
  assert.equal(result.entity.provider, 'mcp'); assert.equal(result.entity.mode, 'copilot'); assert.equal(result.entity.state, 'awaiting_connection'); assert.equal(result.entity.configured, true);
  assert.deepEqual(result.entity.tools, ['conversation.read', 'reply.submit']); assert.equal(result.entity.endpoint, undefined); assert.equal(result.entity.token, undefined); assert.equal(result.entity.role, undefined);
  assert.equal(f.current().agents.length, 2); assert.equal(f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, humans); assert.equal(f.store.db.prepare('SELECT count(*) n FROM service_principals').get().n, services); f.assertNoSend();
});

test('propostas rejeitam campos de administração, publicação, tenants e departamentos fora da concessão', t => {
  const f = fixture(t);
  for (const extra of [{ tenantId: 'other' }, { workspaceId: 'other' }, { provider: 'hermes' }, { mode: 'automatic' }, { publish: true }, { endpoint: 'https://forged.invalid' }, { role: 'reseller' }, { userId: f.admin.userId }, { type: 'channel' }, { graph: graph('sales') }]) assert.throws(() => f.proposals.propose(f.actor, f.input(extra)), status(400));
  assert.throws(() => f.proposals.propose(f.actor, f.input({ graph: { nodes: [], edges: [] } })), status(400));
  assert.throws(() => f.proposals.propose(f.actor, f.input({ type: 'agent' })), status(400));
  assert.equal(f.quota().requests, 0); assert.equal(f.current().agentAdminProposals, undefined); f.assertNoSend();
});

test('somente administrador humano atual da mesma empresa pode listar ou decidir', t => {
  const f = fixture(t), proposed = f.proposals.propose(f.actor, f.input());
  const operator = f.auth.actor(f.auth.insertUser({ username: 'proposal.operator', name: 'Operador QA' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'operator', [f.tenant.id], 'mep-demo'));
  for (const actor of [f.actor, { ...f.actor, userId: f.admin.userId, role: 'reseller' }, { ...operator, role: 'reseller', platformAdmin: true }]) {
    assert.throws(() => f.proposals.list(actor, f.tenant.id), status(403)); assert.throws(() => f.proposals.decide(actor, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(403));
  }
  const other = f.store.createTenant(f.admin, { name: 'Outra empresa QA', segment: 'QA' });
  assert.throws(() => f.proposals.decide(f.admin, other.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(404));
  assert.throws(() => f.proposals.list({ ...f.admin, resellerId: 'forged' }, f.tenant.id), status(403));
  f.store.db.prepare('UPDATE auth_users SET role=? WHERE id=?').run('operator', f.admin.userId);
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(403));
});

test('capacidade readonly não propõe; proposta revogada fica inelegível e não reexecuta via replay', t => {
  const read = fixture(t, ['company.read']); assert.throws(() => read.proposals.propose(read.actor, read.input()), status(403)); assert.equal(read.quota().requests, 0);
  const f = fixture(t), proposed = f.proposals.propose(f.actor, f.input()); f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  assert.throws(() => f.proposals.propose(f.actor, f.input()), status(401)); assert.throws(() => f.proposals.readCompany(f.actor, 'synthetic_read_001'), status(401));
  assert.equal(f.proposals.list(f.admin, f.tenant.id).proposals[0].canApprove, false);
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(409));
  assert.equal(f.current().flows.length, 1); assert.equal(f.current().agentAdminProposals[0].state, 'pending');
  const rejected = f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'reject' }); assert.equal(rejected.proposal.state, 'rejected'); assert.equal(rejected.entity, null); f.assertNoSend();
});

test('rotação, redução de capacidades e mudança do adaptador invalidam aprovação antiga', t => {
  for (const change of ['rotate', 'capabilities', 'adapter']) {
    const f = fixture(t), proposed = f.proposals.propose(f.actor, f.input());
    if (change === 'rotate') f.principals.rotate(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
    else if (change === 'capabilities') f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, capabilities: ['company.read'] });
    else f.store.mutate(f.admin, f.tenant.id, 'Configuração atualizada', state => { state.agents[0].description = 'Nova orientação'; state.agents[0].version++; });
    assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(409)); assert.equal(f.current().flows.length, 1); assert.equal(f.current().agentAdminProposals[0].version, 1); f.assertNoSend();
  }
});

test('aprovação revalida departamentos e limites dentro da transação; falha preserva pending', t => {
  const f = fixture(t), proposed = f.proposals.propose(f.actor, f.input());
  f.store.mutate(f.admin, f.tenant.id, 'Departamento desativado', state => { state.departments[0].active = false; });
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(400)); assert.equal(f.current().agentAdminProposals[0].state, 'pending'); assert.equal(f.current().flows.length, 1);
  f.store.mutate(f.admin, f.tenant.id, 'Limite de fluxos QA', state => { state.departments[0].active = true; state.flows = Array.from({ length: 100 }, (_, index) => ({ id: 'fixture_' + index, state: 'draft' })); });
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(400)); assert.equal(f.current().agentAdminProposals[0].version, 1); assert.equal(f.current().flows.length, 100);
});

test('rejeição e campos desconhecidos de decisão não criam entidade; versões antigas são recusadas', t => {
  const f = fixture(t), proposed = f.proposals.propose(f.actor, f.input());
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve', tenantId: f.tenant.id }), status(400));
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 2, action: 'approve' }), status(409));
  const result = f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'reject' }); assert.equal(result.proposal.state, 'rejected'); assert.equal(result.entity, null); assert.equal(f.current().flows.length, 1);
  assert.throws(() => f.proposals.decide(f.admin, f.tenant.id, proposed.proposal.id, { version: 1, action: 'approve' }), status(409)); f.assertNoSend();
});

test('falha do recibo depois da persistência conserva unknown e replay reconcilia sem duplicar', t => {
  const f = fixture(t), complete = f.principals.complete.bind(f.principals); let first = true;
  f.principals.complete = (actor, id, input) => { if (first && input.state === 'confirmed') { first = false; throw Object.assign(new Error('Falha sintética'), { status: 503 }); } return complete(actor, id, input); };
  assert.throws(() => f.proposals.propose(f.actor, f.input()), status(503));
  const receipt = f.principals.receipts(f.admin, f.tenant.id, f.created.principal.id).receipts[0]; assert.equal(receipt.state, 'unknown'); assert.equal(f.current().agentAdminProposals.length, 1);
  const replay = f.proposals.propose(f.actor, f.input()); assert.equal(replay.receipt.state, 'confirmed'); assert.equal(replay.proposal.id, f.current().agentAdminProposals[0].id); assert.equal(f.quota().requests, 1); f.assertNoSend();
});
