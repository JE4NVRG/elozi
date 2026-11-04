import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFixture, at } from './helpers/realtime-fixture.js';

const run = (id, extra = {}) => ({ id, conversationId: 'c-sales', agentId: 'agent-1', agentName: 'Assistente sintético', state: 'failed', version: 2, actorName: 'Admin A',
  startedAt: at(0), updatedAt: at(1), draft: null, reason: 'Falha sintética.', ...extra });

test('histórico de execuções: só administração, filtros, cursor e DTO sem rascunho, prompt ou argumentos', async t => {
  const f = await realtimeFixture(t);
  f.mutate('rt-a1', tenant => {
    tenant.runs = [
      run('r-used', { state: 'invalidated', outcome: 'used', startedAt: at(1), completedAt: at(2), updatedAt: at(2), usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }, draft: 'Rascunho confidencial',
        toolSteps: [{ proposalId: 'p1', serverId: 's', toolName: 'elozi_contact_profile', title: 'Perfil do contato', autoApproved: true, isError: false, completedAt: at(1) }],
        toolProposal: { title: 'Perfil do contato', arguments: { cpf: '000.000.000-00' } }, toolReceipt: { state: 'completed', autoApproved: true, approvedAt: at(1), result: { phone: '+55 11 90000-0000' } } }),
      run('r-approved', { state: 'draft', startedAt: at(2), updatedAt: at(3), draft: 'Outro rascunho', stale: true, toolProposal: { title: 'ERP › Consultar pedido' }, toolReceipt: { approvedAt: at(2), approvedBy: 'Operador Vendas' } }),
      run('r-rejected', { state: 'rejected', conversationId: 'c-support', startedAt: at(3), updatedAt: at(4), toolProposal: { title: 'ERP › Cancelar pedido' }, toolReceipt: { state: 'rejected', rejectedAt: at(4), rejectedBy: 'Operador Suporte' } }),
      run('r-service', { serviceId: 'svc-1', actorName: 'Hermes do Jean', state: 'cancelled', startedAt: at(4), updatedAt: at(5) }),
      run('r-auto', { id: 'autopilot_abc', actorName: 'Piloto automático Elozi', state: 'running', startedAt: at(5), updatedAt: at(5) }),
      run('r-other-agent', { agentId: 'agent-2', startedAt: at(6), updatedAt: at(7) })
    ];
  });
  const all = await f.request('/api/tenants/rt-a1/agents/runs');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.items.map(item => item.id), ['r-other-agent', 'autopilot_abc', 'r-service', 'r-rejected', 'r-approved', 'r-used']); assert.equal(all.data.nextCursor, null);
  const used = all.data.items.find(item => item.id === 'r-used');
  assert.deepEqual(used, { id: 'r-used', agentId: 'agent-1', agentName: 'Assistente sintético', conversationId: 'c-sales', initiator: { kind: 'user', name: 'Admin A' }, state: 'invalidated', stale: false, outcome: 'used',
    toolSteps: [{ toolName: 'elozi_contact_profile', title: 'Perfil do contato', autoApproved: true, isError: false, completedAt: at(1) }], approvals: [], tokens: { input: 120, output: 30 },
    latencyMs: 60000, createdAt: at(1), completedAt: at(2), invalidation: null, reason: 'Falha sintética.' });
  const byId = Object.fromEntries(all.data.items.map(item => [item.id, item]));
  assert.equal(byId['r-other-agent'].completedAt, null, 'legacy fixture has no recorded completion');
  assert.equal(byId['r-other-agent'].latencyMs, null, 'updatedAt is not a legacy duration');
  assert.equal(byId['r-approved'].outcome, 'stale'); assert.deepEqual(byId['r-approved'].approvals, [{ toolTitle: 'ERP › Consultar pedido', decision: 'approved', by: 'Operador Vendas', at: at(2) }]);
  assert.equal(byId['r-rejected'].outcome, 'rejected'); assert.equal(byId['r-rejected'].approvals[0].decision, 'rejected');
  assert.deepEqual(byId['r-service'].initiator, { kind: 'service', name: 'Hermes do Jean' }); assert.equal(byId['r-service'].outcome, 'discarded');
  assert.deepEqual(byId.autopilot_abc.initiator.kind, 'autopilot'); assert.equal(byId.autopilot_abc.completedAt, null); assert.equal(byId.autopilot_abc.latencyMs, null);
  for (const secret of ['Rascunho confidencial', 'Outro rascunho', 'cpf', '000.000', '+55 11']) assert.equal(all.text.includes(secret), false, secret);
  // Filters and paging.
  assert.deepEqual((await f.request('/api/tenants/rt-a1/agents/runs?agentId=agent-2')).data.items.map(item => item.id), ['r-other-agent']);
  assert.deepEqual((await f.request('/api/tenants/rt-a1/agents/runs?state=draft')).data.items.map(item => item.id), ['r-approved']);
  assert.deepEqual((await f.request(`/api/tenants/rt-a1/agents/runs?from=${encodeURIComponent(at(3))}&to=${encodeURIComponent(at(4))}`)).data.items.map(item => item.id), ['r-service', 'r-rejected']);
  const first = await f.request('/api/tenants/rt-a1/agents/runs?limit=4');
  assert.deepEqual(first.data.items.map(item => item.id), ['r-other-agent', 'autopilot_abc', 'r-service', 'r-rejected']); assert.ok(first.data.nextCursor);
  const second = await f.request('/api/tenants/rt-a1/agents/runs?limit=4&cursor=' + first.data.nextCursor);
  assert.deepEqual(second.data.items.map(item => item.id), ['r-approved', 'r-used']); assert.equal(second.data.nextCursor, null);
  for (const invalid of ['limit=0', 'limit=101', 'state=unknown', 'from=ontem', 'cursor=abc', 'agentId=a&agentId=b', 'other=1']) assert.equal((await f.request('/api/tenants/rt-a1/agents/runs?' + invalid)).status, 400, invalid);
  // Administration only, inside its own workspace.
  for (const as of ['sales', 'support', 'a2']) assert.equal((await f.request('/api/tenants/rt-a1/agents/runs', { as })).status, 403, as);
  assert.equal((await f.request('/api/tenants/rt-a1/agents/runs', { as: 'foreign' })).status, 404);
  assert.equal((await f.request('/api/tenants/rt-b1/agents/runs')).status, 404);
  assert.deepEqual((await f.request('/api/tenants/rt-a2/agents/runs')).data, { items: [], nextCursor: null });
  assert.ok((await f.request('/api/bootstrap')).data.features.includes('agent-runs'));
});

test('envio com sourceRunId: valida a conversa, marca usado/editado pelo servidor e nunca chega ao transporte', async t => {
  const f = await realtimeFixture(t);
  let sends = 0;
  f.app.gateway.send = async (actor, tenantId, cid, input) => {
    sends++;
    assert.equal(Object.hasOwn(input, 'sourceRunId'), false, 'the transport never sees the provenance');
    return f.app.store.mutate(actor, tenantId, 'Envio sintético', state => {
      const c = state.conversations.find(item => item.id === cid);
      c.messages.push({ id: 'sent-' + sends, kind: 'human', text: input.text, authorUserId: actor.userId, authorName: actor.name, createdAt: at(20 + sends), delivery: 'sent' });
      c.version++; c.unread = 0; return c;
    });
  };
  f.mutate('rt-a1', tenant => {
    tenant.runs = [run('run-a', { conversationId: 'c-mine', state: 'draft', draft: 'Olá!\r\nPosso ajudar?  ', failed: undefined, reason: undefined }), run('run-b', { conversationId: 'c-mine', state: 'draft', draft: 'Seu pedido saiu.' }),
      run('run-other', { conversationId: 'c-sales', state: 'draft', draft: 'Outra conversa' })];
  });
  const version = () => f.tenant('rt-a1').conversations.find(item => item.id === 'c-mine').version;
  const post = (body, as = 'sales') => f.request('/api/tenants/rt-a1/conversations/c-mine/messages', { as, method: 'POST', body: { channelId: 'wa-a1', version: version(), ...body } });
  for (const [sourceRunId, status] of [['run-other', 400], ['inexistente', 400], ['../x', 400], [42, 400]]) {
    const refused = await post({ text: 'Olá!\nPosso ajudar?', idempotencyKey: 'synthetic-key-' + String(sourceRunId).replace(/\W/g, 'x').padEnd(8, 'x'), sourceRunId });
    assert.equal(refused.status, status, String(sourceRunId));
  }
  assert.equal(sends, 0, 'an invalid provenance stops the send before any transport');
  const used = await post({ text: 'Olá!\nPosso ajudar?', idempotencyKey: 'synthetic-key-used-0001', sourceRunId: 'run-a' });
  assert.equal(used.status, 200, JSON.stringify(used.data)); assert.equal(used.data.messages.at(-1).sourceRunId, 'run-a');
  const edited = await post({ text: 'Seu pedido saiu hoje cedo.', idempotencyKey: 'synthetic-key-edit-0001', sourceRunId: 'run-b' });
  assert.equal(edited.status, 200); assert.equal(edited.data.messages.at(-1).sourceRunId, 'run-b');
  const runs = Object.fromEntries(f.tenant('rt-a1').runs.map(item => [item.id, item]));
  assert.equal(runs['run-a'].outcome, 'used'); assert.equal(runs['run-a'].outcomeMessageId, 'sent-1');
  assert.equal(runs['run-b'].outcome, 'edited'); assert.equal(runs['run-other'].outcome, undefined);
  const history = await f.request('/api/tenants/rt-a1/agents/runs');
  assert.equal(history.data.items.find(item => item.id === 'run-b').outcome, 'edited');
  // A plain send keeps working and records nothing.
  const plain = await post({ text: 'Sem rascunho', idempotencyKey: 'synthetic-key-plain-001' });
  assert.equal(plain.status, 200); assert.equal(plain.data.messages.at(-1).sourceRunId, undefined); assert.equal(sends, 3);
  // Sandbox channels (no transport) record the provenance in the same mutation.
  f.mutate('rt-a1', tenant => { tenant.channels.push({ id: 'sandbox-a1', name: 'Sandbox', kind: 'webchat', state: 'sandbox' });
    tenant.conversations.push({ id: 'c-box', contact: 'Sandbox', channelId: 'sandbox-a1', departmentId: 'sales', owner: 'human', assignedUserId: f.users.admin.id, status: 'open', version: 1, unread: 0, messages: [] });
    tenant.runs.push(run('run-box', { conversationId: 'c-box', state: 'draft', draft: 'Pronto.' })); });
  const box = await f.request('/api/tenants/rt-a1/conversations/c-box/messages', { method: 'POST', body: { channelId: 'sandbox-a1', version: 1, text: 'Pronto.', sourceRunId: 'run-box' } });
  assert.equal(box.status, 200, JSON.stringify(box.data)); assert.equal(box.data.messages.at(-1).sourceRunId, 'run-box');
  assert.equal(f.tenant('rt-a1').runs.find(item => item.id === 'run-box').outcome, 'used');
  // Another department cannot cite runs of a conversation it cannot reply to.
  assert.equal((await f.request('/api/tenants/rt-a1/conversations/c-mine/messages', { as: 'support', method: 'POST', body: { channelId: 'wa-a1', version: version(), text: 'x', sourceRunId: 'run-a' } })).status, 403);
});

test('lastSeenAt do serviço: qualquer chamada autenticada, gravação no máximo por minuto e isolada por empresa', async t => {
  const f = await realtimeFixture(t);
  const created = await f.request('/api/tenants/rt-a1/service-principals', { method: 'POST', body: { name: 'Serviço sintético', agentId: 'agent-1', capabilities: ['conversation.read', 'company.read'] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.principal.lastSeenAt, null);
  const auth = { Authorization: 'Bearer ' + created.data.token };
  const me = await f.request('/api/service/v1/me', { as: null, headers: auth });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  const listed = await f.request('/api/tenants/rt-a1/service-principals');
  const seen = listed.data.principals[0].lastSeenAt;
  assert.ok(Date.parse(seen) > Date.now() - 60000);
  // A second call inside the minute does not write again.
  f.db.prepare('UPDATE service_principal_presence SET last_seen_at=? WHERE principal_id=?').run(Date.parse(seen) - 1000, created.data.principal.id);
  await f.request('/api/service/v1/me', { as: null, headers: auth });
  assert.equal((await f.request('/api/tenants/rt-a1/service-principals')).data.principals[0].lastSeenAt, new Date(Date.parse(seen) - 1000).toISOString());
  // Revision and audit of the principal are untouched by presence.
  assert.equal((await f.request('/api/tenants/rt-a1/service-principals')).data.principals[0].revision, created.data.principal.revision);
  assert.equal((await f.request('/api/tenants/rt-a1/service-principals', { as: 'sales' })).status, 403);
  assert.equal((await f.request('/api/tenants/rt-a1/service-principals', { as: 'foreign' })).status, 404);
  assert.equal((await f.request('/api/service/v1/me', { as: null, headers: { Authorization: 'Bearer elozi_svc_' + 'x'.repeat(43) } })).status, 401);
  assert.ok((await f.request('/api/bootstrap')).data.features.includes('principal-last-seen'));
});

test('contatos com limite simples para seletores, sem mudar o snapshot', async t => {
  const f = await realtimeFixture(t);
  f.mutate('rt-a1', tenant => { tenant.contacts = Array.from({ length: 12 }, (_, index) => ({ id: 'contact-' + index, name: 'Contato ' + index, type: 'person', phone: '', email: '', notes: '', tags: [], identities: [], version: 1 })); });
  const limited = await f.request('/api/tenants/rt-a1/contacts?search=Contato&limit=8');
  assert.equal(limited.status, 200); assert.equal(limited.data.contacts.length, 8); assert.equal(limited.data.hasMore, true);
  const all = await f.request('/api/tenants/rt-a1/contacts?limit=50');
  assert.equal(all.data.contacts.length, 12); assert.equal(all.data.hasMore, false);
  assert.equal((await f.request('/api/tenants/rt-a1/contacts')).data.hasMore, undefined);
  for (const invalid of ['limit=0', 'limit=201', 'limit=abc', 'limit=5&snapshot=true', 'limit=1&limit=2']) assert.equal((await f.request('/api/tenants/rt-a1/contacts?' + invalid)).status, 400, invalid);
  assert.equal((await f.request('/api/tenants/rt-a1/contacts?limit=8', { as: 'a2' })).status, 403);
});
