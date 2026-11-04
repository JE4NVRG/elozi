import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { Outbox } from '../src/outbox.js';

const status = value => error => error.status === value;
function fixture(t) {
  const store = new Store(':memory:'); new Outbox(store);
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'external.draft.qa', name: 'Admin QA' }, Buffer.alloc(16, 4), Buffer.alloc(64, 4), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'MCP QA', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture MCP', state => {
    state.agents = [{ id: 'mcp-agent', provider: 'mcp', mode: 'copilot', configured: true, version: 1, name: 'Agente externo QA', tools: ['conversation.read', 'reply.submit'] },
      { id: 'hermes-agent', provider: 'hermes', mode: 'copilot', configured: true, version: 1, name: 'Hermes QA', tools: [] }];
    state.channels = [{ id: 'web', kind: 'webchat' }, { id: 'other', kind: 'telegram' }];
    state.conversations = [{ id: 'conversation', channelId: 'web', version: 1, owner: 'human', assignedUserId: admin.userId, status: 'open', contact: 'QA', messages: [{ id: 'inbound', kind: 'customer', text: 'Pergunta sintética' }] },
      { id: 'forbidden', channelId: 'other', version: 1, owner: 'queue', status: 'open', messages: [] }];
  });
  let runtime;
  const principals = new ServicePrincipals(store, auth, { onChange: serviceId => runtime?.invalidateInitiator(admin, tenant.id, { serviceId }) });
  runtime = new AgentRuntime(store, { providerCall: () => assert.fail('MCP externo não usa o provedor da Elozi'), validateInitiator: run => principals.runCurrent(run) });
  const api = new ServiceApi(store, principals, runtime), created = principals.create(admin, tenant.id, { name: 'Conector MCP QA', agentId: 'mcp-agent', channelIds: ['web'], dailyRequests: 5 });
  const actor = principals.authenticate('Bearer ' + created.token), input = { requestId: 'draft_request_0001', conversationId: 'conversation', version: 1, text: 'Resposta do agente externo para revisão.' };
  t.after(() => store.close());
  return { store, auth, admin, tenant, principals, runtime, api, created, actor, input,
    current: () => store.tenant(admin, tenant.id), quota: () => principals.list(admin, tenant.id).principals[0].usage };
}

test('agente MCP recebe e preserva rascunho sem provedor, mensagem enviada ou identidade humana', t => {
  const f = fixture(t), before = f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, result = f.api.submitDraft(f.actor, f.input);
  assert.equal(result.run.draft, f.input.text); assert.equal(result.run.state, 'draft'); assert.equal(result.humanApprovalRequired, true);
  assert.deepEqual(f.created.principal.capabilities, ['conversation.read', 'reply.submit']);
  const run = f.current().runs[0]; assert.equal(run.externalDraft, true); assert.equal(run.actorUserId, null); assert.equal(run.providerCalled, false); assert.equal(run.provider, 'mcp');
  assert.equal(f.current().conversations[0].messages.length, 1); assert.equal(f.current().conversations[0].assignedUserId, f.admin.userId);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(f.store.db.prepare('SELECT count(*) n FROM auth_users').get().n, before);
  assert.equal(f.quota().requests, 1); assert.equal(f.quota().budgetMicros, 0);
  assert.equal(JSON.stringify(result.receipt).includes(f.input.text), false);
});

test('replay e payload conflitante conservam um rascunho e uma cota', t => {
  const f = fixture(t), result = f.api.submitDraft(f.actor, f.input), again = f.api.submitDraft(f.actor, f.input);
  assert.equal(result.receipt.id, again.receipt.id); assert.equal(result.run.id, again.run.id); assert.equal(again.run.draft, f.input.text); assert.equal(f.current().runs.length, 1); assert.equal(f.quota().requests, 1);
  assert.throws(() => f.api.submitDraft(f.actor, { ...f.input, text: 'Outro resultado' }), status(409)); assert.equal(f.quota().requests, 1);
});

test('tenant, canal, versão e configuração forjados não recebem rascunho', t => {
  const f = fixture(t);
  for (const extra of [{ tenantId: 'other' }, { agentId: 'hermes-agent' }, { userId: f.admin.userId }, { endpoint: 'https://qa.invalid' }, { text: 'x'.repeat(8001) }]) assert.throws(() => f.api.submitDraft(f.actor, { ...f.input, ...extra }), status(400));
  assert.throws(() => f.api.submitDraft(f.actor, { ...f.input, conversationId: 'forbidden' }), status(403));
  assert.throws(() => f.api.submitDraft(f.actor, { ...f.input, version: 2 }), status(409)); assert.equal(f.quota().requests, 0);
  assert.throws(() => f.principals.create(f.admin, f.tenant.id, { name: 'Errado', agentId: 'hermes-agent', capabilities: ['conversation.read', 'reply.submit'] }), status(400));
  assert.throws(() => f.principals.create(f.admin, f.tenant.id, { name: 'Errado', agentId: 'mcp-agent', capabilities: ['conversation.read', 'reply.draft'] }), status(400));
});

test('revogação e nova mensagem invalidam o texto para revisão e envio', t => {
  const f = fixture(t), result = f.api.submitDraft(f.actor, f.input);
  f.store.mutate(f.admin, f.tenant.id, 'Nova mensagem QA', tenant => { tenant.conversations[0].version++; });
  assert.equal(f.runtime.list(f.admin, f.tenant.id)[0].draft, null); assert.equal(f.runtime.list(f.admin, f.tenant.id)[0].state, 'invalidated');
  assert.throws(() => f.api.submitDraft(f.actor, f.input), status(409));
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  assert.throws(() => f.api.submitDraft(f.actor, { ...f.input, version: 2 }), status(401)); assert.equal(f.current().runs[0].id, result.run.id);
});

test('ator direto ou colisão de identidade não burla o caminho de autorização', t => {
  const f = fixture(t);
  assert.throws(() => f.runtime.submitExternal(f.admin, f.tenant.id, 'conversation', { ...f.input, agentId: 'mcp-agent' }), status(403));
  const authority = f.principals.revalidate(f.actor, 'reply.submit', f.api.context(f.actor, 'conversation', 1));
  assert.throws(() => f.runtime.submitExternal(f.api.internalActor(f.actor, authority), f.tenant.id, 'conversation', { agentId: 'mcp-agent', version: 1, runId: 'run', idempotencyKey: 'run', text: 'Texto' }, { authorize: () => false }), status(403));
  assert.equal(f.current().runs?.length || 0, 0);
});
test('falha de recibo após persistir rascunho conserva resultado conhecido e replay', t => {
  const f = fixture(t), complete = f.principals.complete.bind(f.principals); let first = true;
  f.principals.complete = (...args) => { if (first) { first = false; throw Object.assign(new Error('Falha sintética'), { status: 503 }); } return complete(...args); };
  assert.throws(() => f.api.submitDraft(f.actor, f.input), status(503));
  const replay = f.api.submitDraft(f.actor, f.input);
  assert.equal(replay.receipt.state, 'confirmed'); assert.equal(replay.run.draft, f.input.text); assert.equal(f.current().runs.length, 1); assert.equal(f.quota().requests, 1);
});
test('descoberta de atendimentos respeita canal/departamento e não fornece textos privados', t => {
  const f = fixture(t), result = f.api.inbox(f.actor, { requestId: 'list_request_0001', status: 'open', limit: 20 });
  assert.deepEqual(result.conversations.map(item => item.id), ['conversation']); assert.equal(result.conversations[0].version, 1);
  assert.equal(JSON.stringify(result).includes('Pergunta sintética'), false);
  assert.equal(f.api.inbox(f.actor, { requestId: 'list_request_0001', status: 'open', limit: 20 }).receipt, result.receipt); assert.equal(f.quota().requests, 1);
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'list_request_0002', tenantId: 'other' }), status(400));
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 });
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'list_request_0003' }), status(401));
});
