import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFixture } from './helpers/realtime-fixture.js';

const future = () => new Date(Date.now() + 600000).toISOString();
function handoff(f, id, conversationId, state = 'pending', tenantId = 'rt-a1') {
  // Service handoffs reference receipts and principals; the fixture inserts only the request row it needs.
  f.db.exec('PRAGMA foreign_keys=OFF');
  try {
    f.db.prepare("INSERT INTO service_handoff_requests VALUES (?,?,?,?,?,?,?,?,1,?,?,NULL,NULL)").run(id, 'receipt-' + id, 'principal-1', tenantId, conversationId, 1, 'Cliente pediu uma pessoa', state, new Date().toISOString(), new Date().toISOString());
  } finally { f.db.exec('PRAGMA foreign_keys=ON'); }
}

test('atenção: não lidas para mim batem com as lentes do inbox e cada seção respeita escopo e papel', async t => {
  const f = await realtimeFixture(t);
  const recent = new Date(Date.now() - 60000).toISOString(), old = new Date(Date.now() - 3600000).toISOString();
  f.mutate('rt-a1', tenant => {
    tenant.conversations.find(item => item.id === 'c-agent').messages[0].createdAt = old;
    tenant.runs = [
      { id: 'run-approval', conversationId: 'c-mine', agentName: 'Assistente sintético', state: 'waiting_approval', conversationVersion: 1,
        toolProposal: { title: 'ERP › Consultar pedido', toolName: 'erp_order', readOnly: false, arguments: { cpf: '000.000.000-00' }, expiresAt: future() } },
      { id: 'run-expired', conversationId: 'c-mine', state: 'waiting_approval', toolProposal: { title: 'Expirada', expiresAt: new Date(Date.now() - 1000).toISOString() } },
      { id: 'run-hidden', conversationId: 'c-support', state: 'waiting_approval', toolProposal: { title: 'Outro depto', readOnly: true, expiresAt: future() } }
    ];
    tenant.agentAdminProposals = [{ id: 'p1', state: 'pending' }, { id: 'p2', state: 'approved' }];
    tenant.aiDailyTokenLimit = 1000;
  });
  f.app.runtime._meter('rt-a1', 'agent-1', { prompt: 850, completion: 10 });
  handoff(f, 'h1', 'c-sales'); handoff(f, 'h2', 'c-support'); handoff(f, 'h3', 'c-sales', 'accepted');
  f.app.gateway.entries.set('wa-a1', { tenantId: 'rt-a1', channelId: 'wa-a1', state: 'logged_out' });

  const admin = (await f.request('/api/me/attention')).data;
  assert.match(admin.revision, /^a_[a-f0-9]{32}$/); assert.equal(admin.workspaceId, 'ws-a'); assert.ok(Date.parse(admin.generatedAt));
  assert.deepEqual(admin.unreadForMe, { total: 4, byTenant: { 'rt-a1': 3, 'rt-a2': 1 } });
  assert.deepEqual(admin.approvals, [], 'only the responsible person decides an approval');
  assert.deepEqual(admin.handoffs, { total: 2, byTenant: { 'rt-a1': 2 } });
  assert.deepEqual(admin.parked.map(item => [item.tenantId, item.conversationId]), [['rt-a1', 'c-agent']]); assert.equal(admin.parked[0].since, old);
  assert.deepEqual(admin.proposals, { total: 1, byTenant: { 'rt-a1': 1 } });
  assert.deepEqual(admin.aiQuota, [{ tenantId: 'rt-a1', usedPct: 86 }]);
  assert.deepEqual(admin.channelsDown.map(item => [item.tenantId, item.channelId, item.state]).sort(), [['rt-a1', 'tg-a1', 'disconnected'], ['rt-a1', 'wa-a1', 'logged_out'], ['rt-a2', 'wa-a2', 'disconnected']]);

  const sales = (await f.request('/api/me/attention', { as: 'sales' })).data;
  assert.deepEqual(sales.unreadForMe, { total: 2, byTenant: { 'rt-a1': 2 } });
  assert.deepEqual(sales.approvals, [{ tenantId: 'rt-a1', conversationId: 'c-mine', runId: 'run-approval', agentName: 'Assistente sintético', toolTitle: 'ERP › Consultar pedido', external: true, expiresAt: sales.approvals[0].expiresAt }]);
  assert.deepEqual(sales.handoffs, { total: 1, byTenant: { 'rt-a1': 1 } });
  assert.deepEqual(sales.parked.map(item => item.conversationId), ['c-agent']);
  assert.equal(sales.proposals, null); assert.equal(sales.aiQuota, null, 'quota and proposals are administrative');
  assert.deepEqual(sales.channelsDown.map(item => item.channelId), ['wa-a1'], 'the Telegram channel is outside the sales scope');
  const serialized = JSON.stringify(sales);
  for (const hidden of ['c-support', 'c-tg', 'rt-a2', 'run-hidden', 'cpf', '000.000', 'tg-a1']) assert.equal(serialized.includes(hidden), false, hidden);
  // The same number as the inbox lenses: countTabs.mine + countTabs.queue of /api/inbox?unread=1.
  for (const [as, expected] of [['admin', admin], ['sales', sales]]) {
    const lens = (await f.request('/api/inbox?unread=1&limit=1', { as })).data.countTabs;
    assert.equal(lens.mine + lens.queue, expected.unreadForMe.total, as);
  }

  const support = (await f.request('/api/me/attention', { as: 'support' })).data;
  assert.deepEqual(support.unreadForMe, { total: 1, byTenant: { 'rt-a1': 1 } }); assert.deepEqual(support.approvals, []);
  assert.deepEqual(support.handoffs, { total: 1, byTenant: { 'rt-a1': 1 } }); assert.deepEqual(support.parked, []);
  const a2 = (await f.request('/api/me/attention', { as: 'a2' })).data;
  assert.deepEqual(a2.unreadForMe, { total: 1, byTenant: { 'rt-a2': 1 } }); assert.deepEqual(a2.handoffs, { total: 0, byTenant: {} });
  assert.deepEqual(a2.channelsDown.map(item => item.channelId), ['wa-a2']);
  const foreign = (await f.request('/api/me/attention', { as: 'foreign' })).data;
  assert.equal(foreign.workspaceId, 'ws-b'); assert.deepEqual(foreign.unreadForMe, { total: 1, byTenant: { 'rt-b1': 1 } });
  assert.equal(JSON.stringify(foreign).includes('rt-a1'), false);
  assert.equal((await f.request('/api/me/attention', { as: 'foreign', headers: { 'X-Elozi-Workspace': 'ws-a' } })).status, 403);
  assert.equal((await f.request('/api/me/attention', { as: null })).status, 401);
});

test('atenção: revisão estável, unchanged e pilotos automáticos só contam quando a resposta atrasou', async t => {
  const f = await realtimeFixture(t);
  f.mutate('rt-a1', tenant => {
    tenant.agents[0].autopilot = { enabled: true, channelIds: ['wa-a1'] };
    tenant.conversations.find(item => item.id === 'c-agent').messages[0].createdAt = new Date(Date.now() - 60000).toISOString();
  });
  const first = (await f.request('/api/me/attention', { as: 'sales' })).data;
  assert.deepEqual(first.parked, [], 'a recent customer message is being answered by the autopilot');
  assert.deepEqual((await f.request('/api/me/attention?since=' + first.revision, { as: 'sales' })).data, { workspaceId: 'ws-a', unchanged: true, revision: first.revision });
  f.mutate('rt-a1', tenant => { tenant.conversations.find(item => item.id === 'c-agent').messages[0].createdAt = new Date(Date.now() - 3600000).toISOString(); });
  const stalled = (await f.request('/api/me/attention?since=' + first.revision, { as: 'sales' })).data;
  assert.equal(stalled.unchanged, undefined); assert.deepEqual(stalled.parked.map(item => item.conversationId), ['c-agent']);
  // A change outside the scope keeps the revision.
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-support'); c.unread = 7; c.version++; });
  assert.equal((await f.request('/api/me/attention?since=' + stalled.revision, { as: 'sales' })).data.unchanged, true);
  for (const invalid of ['other=1', 'since=a&since=b', 'since=' + 'x'.repeat(121)]) assert.equal((await f.request('/api/me/attention?' + invalid, { as: 'sales' })).status, 400, invalid);
});

test('atenção: piloto que não pode responder (sem configuração, desligado no canal ou conta pausada) estaciona na hora', async t => {
  const f = await realtimeFixture(t);
  const recent = () => f.mutate('rt-a1', tenant => { tenant.conversations.find(item => item.id === 'c-agent').messages[0].createdAt = new Date(Date.now() - 60000).toISOString(); });
  const parked = async () => (await f.request('/api/me/attention', { as: 'sales' })).data.parked.map(item => item.conversationId);
  f.mutate('rt-a1', tenant => { tenant.agents[0].autopilot = { enabled: true, channelIds: ['wa-a1'] }; }); recent();
  assert.deepEqual(await parked(), [], 'a runnable autopilot is answering');
  f.mutate('rt-a1', tenant => { tenant.agents[0].configured = false; });
  assert.deepEqual(await parked(), ['c-agent'], 'a Hermes without configuration never answers');
  f.mutate('rt-a1', tenant => { tenant.agents[0].configured = true; tenant.agents[0].autopilot = { enabled: true, channelIds: ['tg-a1'] }; });
  assert.deepEqual(await parked(), ['c-agent'], 'channel outside the opt-in');
  f.mutate('rt-a1', tenant => { tenant.agents[0].autopilot = { enabled: true, channelIds: ['wa-a1'] }; });
  assert.deepEqual(await parked(), []);
  const row = f.db.prepare('SELECT data FROM resellers WHERE id=?').get('ws-a'), data = JSON.parse(row.data);
  data.commercialLifecycle = { state: 'paused', trialStartsAt: null, trialEndsAt: null, changedAt: '2026-10-06T12:00:00.000Z', changedBy: { userId: f.users.admin.id, workspaceId: 'ws-a' }, reason: 'Pausa sintética.' };
  f.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), 'ws-a');
  assert.deepEqual(await parked(), ['c-agent'], 'a paused workspace never sends automatic replies');
});

test('atenção: fila sem dono conta de 5 minutos a 24 horas, respeita o escopo e traz a última chamada do agente conectado que pode assumir', async t => {
  const f = await realtimeFixture(t);
  const waiting = async as => (await f.request('/api/me/attention', { as })).data;
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  // The fixture's queue conversations end with a customer message from weeks ago: backlog, not an alert.
  assert.deepEqual((await waiting('admin')).waiting, []); assert.equal((await waiting('admin')).waitingTotal, 0);
  f.mutate('rt-a1', tenant => {
    tenant.conversations.find(item => item.id === 'c-sales').messages.at(-1).createdAt = ago(10);
    tenant.conversations.find(item => item.id === 'c-support').messages[0].createdAt = ago(20);
    tenant.conversations.find(item => item.id === 'c-tg').messages[0].createdAt = ago(15);
    // Owned and agent conversations never count here, however old the customer message.
    for (const id of ['c-mine', 'c-agent']) tenant.conversations.find(item => item.id === id).messages[0].createdAt = ago(30);
  });
  f.mutate('rt-a2', tenant => { tenant.conversations[0].messages[0].createdAt = ago(23 * 60); });
  const admin = await waiting('admin');
  assert.deepEqual(admin.waiting.map(item => [item.tenantId, item.conversationId]), [['rt-a2', 'c-a2'], ['rt-a1', 'c-support'], ['rt-a1', 'c-tg'], ['rt-a1', 'c-sales']], 'oldest first');
  assert.equal(admin.waitingTotal, 4);
  assert.equal(admin.waiting.some(item => 'agent' in item), false, 'without a connected identity there is no agent line');
  assert.deepEqual((await waiting('sales')).waiting.map(item => item.conversationId), ['c-sales'], 'only the channel and department of the person');
  f.mutate('rt-a1', tenant => {
    tenant.conversations.find(item => item.id === 'c-support').messages[0].createdAt = ago(1);
    tenant.conversations.find(item => item.id === 'c-tg').messages.push({ id: 'c-tg-m2', kind: 'human', text: 'Já respondemos', createdAt: new Date().toISOString() });
  });
  f.mutate('rt-a2', tenant => { tenant.conversations[0].messages[0].createdAt = ago(25 * 60); });
  assert.deepEqual((await waiting('admin')).waiting.map(item => item.conversationId), ['c-sales'], 'recent, answered last and older than a day do not wait');

  // A connected agent that manages and replies on the channel is named with its last authenticated call (its health).
  const actor = f.app.auth.workspaceActor(f.app.auth.authenticate(f.users.admin.token));
  f.mutate('rt-a1', tenant => { tenant.agents.push({ id: 'agent-mcp', name: 'Sofia sintética', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }); });
  const reader = f.app.servicePrincipals.create(actor, 'rt-a1', { name: 'Só leitura', agentId: 'agent-mcp', capabilities: ['conversation.read'], ttlHours: 24 });
  f.app.servicePrincipals.markSeen(reader.principal.id);
  assert.equal((await waiting('admin')).waiting.find(item => item.conversationId === 'c-sales').agent, undefined, 'an identity that cannot take and reply is not a taker');
  const taker = f.app.servicePrincipals.create(actor, 'rt-a1', { name: 'Sofia', agentId: 'agent-mcp', capabilities: ['conversation.read', 'conversation.manage', 'reply.send'], channelIds: ['wa-a1'], ttlHours: 24 });
  assert.deepEqual((await waiting('admin')).waiting.find(item => item.conversationId === 'c-sales').agent, { name: 'Sofia sintética', lastSeenAt: null }, 'never called yet');
  f.app.servicePrincipals.markSeen(taker.principal.id);
  const seen = (await waiting('admin')).waiting;
  assert.equal(seen.find(item => item.conversationId === 'c-sales').agent.name, 'Sofia sintética'); assert.ok(Date.parse(seen.find(item => item.conversationId === 'c-sales').agent.lastSeenAt) > Date.now() - 60000);
  f.mutate('rt-a2', tenant => { tenant.conversations[0].messages[0].createdAt = ago(40); });
  assert.equal((await waiting('admin')).waiting.find(item => item.conversationId === 'c-a2').agent, undefined, 'another company has no taker');
});
