import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFixture, message } from './helpers/realtime-fixture.js';

const path = (cid, query = '', tenant = 'rt-a1') => `/api/tenants/${tenant}/conversations/${cid}${query ? '?' + query : ''}`;
function longConversation(f, count = 130) {
  f.mutate('rt-a1', tenant => {
    const c = tenant.conversations.find(item => item.id === 'c-sales');
    c.messages = Array.from({ length: count }, (_, index) => message('m' + index, index % 2 ? 'human' : 'customer', 'Mensagem ' + index, index,
      index === 5 ? { senderJid: '5511999999999@s.whatsapp.net', senderId: 'remetente', supportAssistantJobId: 'job-1' } : {}));
    c.version = 10;
  });
}

test('conversa paginada: janela recente, anteriores com before, novas com after e unchanged por versão', async t => {
  const f = await realtimeFixture(t); longConversation(f);
  const latest = await f.request(path('c-sales'));
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.data.messages.map(item => item.id), Array.from({ length: 60 }, (_, index) => 'm' + (70 + index)));
  assert.equal(latest.data.hasMore, true); assert.deepEqual(latest.data.cursor, { before: 'm70', after: 'm129' });
  assert.equal(latest.data.version, 10); assert.equal(latest.data.messageCount, 130);
  assert.equal(latest.data.conversation.id, 'c-sales'); assert.equal(latest.data.conversation.messages, undefined);
  assert.ok(Array.isArray(latest.data.runs)); assert.ok(latest.data.conversation.attendanceAccess);
  assert.equal(latest.text.includes('expectedNumber'), false);
  const older = await f.request(path('c-sales', 'before=m70&limit=50'));
  assert.deepEqual(older.data.messages.map(item => item.id), Array.from({ length: 50 }, (_, index) => 'm' + (20 + index)));
  assert.equal(older.data.hasMore, true); assert.deepEqual(older.data.cursor, { before: 'm20' }); assert.equal(older.data.conversation, undefined);
  const oldest = await f.request(path('c-sales', 'before=m20&limit=50'));
  assert.equal(oldest.data.messages.length, 20); assert.equal(oldest.data.hasMore, false);
  // The public DTO strips sender transport identities and internal job links.
  const five = oldest.data.messages.find(item => item.id === 'm5');
  for (const field of ['senderJid', 'senderId', 'supportAssistantJobId']) assert.equal(Object.hasOwn(five, field), false, field);
  assert.equal(oldest.text.includes('5511999999999'), false);
  assert.deepEqual((await f.request(path('c-sales', 'version=10&after=m129'))).data, { unchanged: true, version: 10 });
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-sales'); c.messages.push(message('m130', 'customer', 'Nova', 200)); c.version = 11; c.status = 'pending'; });
  const delta = await f.request(path('c-sales', 'version=10&after=m129'));
  assert.deepEqual(delta.data.messages.map(item => item.id), ['m130']); assert.equal(delta.data.hasMore, false); assert.equal(delta.data.reset, undefined);
  assert.equal(delta.data.conversation.status, 'pending'); assert.equal(delta.data.version, 11); assert.equal(delta.data.cursor.after, 'm130');
  const nothingNew = await f.request(path('c-sales', 'after=m130'));
  assert.deepEqual(nothingNew.data.messages, []); assert.equal(nothingNew.data.version, 11);
  // A vanished anchor or a gap larger than the limit resets to the latest window.
  const gone = await f.request(path('c-sales', 'after=desconhecida&limit=5'));
  assert.equal(gone.data.reset, true); assert.deepEqual(gone.data.messages.map(item => item.id), ['m126', 'm127', 'm128', 'm129', 'm130']); assert.equal(gone.data.hasMore, true);
  assert.equal((await f.request(path('c-sales', 'after=m100&limit=5'))).data.reset, true);
  assert.deepEqual((await f.request(path('c-sales', 'before=desconhecida'))).data, { messages: [], hasMore: false, reset: true, cursor: { before: null }, version: 11 });
  for (const invalid of ['before=m1&after=m2', 'limit=0', 'limit=201', 'version=abc', 'other=1', 'limit=5&limit=6', 'before=']) assert.equal((await f.request(path('c-sales', invalid))).status, 400, invalid);
  assert.equal((await f.request(path('missing'))).status, 404);
});

test('conversa paginada isola empresa, departamento, canal e responsável antes de revelar versão ou mensagens', async t => {
  const f = await realtimeFixture(t);
  assert.equal((await f.request(path('c-sales'), { as: null })).status, 401);
  assert.equal((await f.request(path('c-sales'), { as: 'sales' })).status, 200);
  for (const cid of ['c-support', 'c-tg']) {
    for (const query of ['', 'version=1', 'before=' + cid + '-m1', 'after=' + cid + '-m1']) {
      const refused = await f.request(path(cid, query), { as: 'sales' });
      assert.equal(refused.status, 403, cid + ' ' + query); assert.equal(refused.text.includes('Pergunta pública'), false);
    }
  }
  // Being the responsible person does not widen the department scope.
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-support'); Object.assign(c, { owner: 'human', assignedUserId: f.users.sales.id }); c.version++; });
  assert.equal((await f.request(path('c-support'), { as: 'sales' })).status, 403);
  assert.equal((await f.request(path('c-a2', '', 'rt-a2'), { as: 'sales' })).status, 403);
  assert.equal((await f.request(path('c-b1', '', 'rt-b1'), { as: 'admin' })).status, 404);
  assert.equal((await f.request(path('c-b1', '', 'rt-b1'), { as: 'foreign' })).status, 200);
  assert.equal((await f.request(path('c-sales'), { as: 'foreign', headers: { 'X-Elozi-Workspace': 'ws-a' } })).status, 403);
});

test('resumo da empresa sem mensagens: última mensagem curta, contagem e runs ativos mais os últimos 50', async t => {
  const f = await realtimeFixture(t, { providerCall: async () => ({ text: 'Rascunho sintético' }) }); longConversation(f, 5);
  f.mutate('rt-a1', tenant => {
    const c = tenant.conversations.find(item => item.id === 'c-sales'); c.messages.push(message('long', 'customer', 'x'.repeat(600), 20, { attachments: [{ id: 'a1', kind: 'image', name: 'foto.jpg' }] })); c.version++;
  });
  // A real current draft (kept active by the runtime), then 69 older-style failed runs after it.
  const admin = f.app.auth.workspaceActor(f.app.auth.authenticate(f.users.admin.token));
  const draft = await f.app.runtime.start(admin, 'rt-a1', 'c-sales', { agentId: 'agent-1', version: f.tenant('rt-a1').conversations.find(item => item.id === 'c-sales').version });
  assert.equal(draft.state, 'draft');
  f.mutate('rt-a1', tenant => { for (let index = 0; index < 69; index++) tenant.runs.push({ id: 'run-' + index, conversationId: index === 3 ? 'c-support' : 'c-sales', state: 'failed', conversationVersion: 1, startedAt: message('x', 'x', '', index).createdAt, updatedAt: message('x', 'x', '', index).createdAt }); });
  const full = await f.request('/api/tenants/rt-a1'), summary = await f.request('/api/tenants/rt-a1?summary=1');
  assert.equal(summary.status, 200);
  assert.ok(full.data.conversations.every(item => Array.isArray(item.messages)));
  assert.ok(summary.data.conversations.every(item => item.messages === undefined));
  const sales = summary.data.conversations.find(item => item.id === 'c-sales');
  assert.equal(sales.messageCount, 6); assert.deepEqual(sales.lastMessage, { id: 'long', kind: 'customer', text: 'x'.repeat(280), createdAt: message('x', 'x', '', 20).createdAt, attachmentKind: 'image' });
  assert.deepEqual(summary.data.runs.map(run => run.id), [draft.id, ...Array.from({ length: 50 }, (_, index) => 'run-' + (19 + index))]);
  assert.equal(summary.data.runs[0].draft, 'Rascunho sintético');
  assert.equal(full.data.runs.length, 70);
  assert.ok(summary.text.length < full.text.length);
  for (const key of ['channels', 'agents', 'departments', 'audit', 'brand']) assert.deepEqual(summary.data[key], full.data[key], key);
  // Same authorization as the full DTO: the sales operator sees only its conversations and their runs.
  const scoped = await f.request('/api/tenants/rt-a1?summary=1', { as: 'sales' });
  assert.deepEqual(scoped.data.conversations.map(item => item.id).sort(), ['c-agent', 'c-mine', 'c-sales']);
  assert.equal(scoped.data.runs.some(run => run.conversationId === 'c-support'), false);
  assert.equal(scoped.text.includes('Pergunta pública c-support'), false);
  assert.equal((await f.request('/api/tenants/rt-a2?summary=1', { as: 'sales' })).status, 403);
  assert.equal((await f.request('/api/tenants/rt-b1?summary=1')).status, 404);
  for (const invalid of ['summary=2', 'summary=1&summary=1']) assert.equal((await f.request('/api/tenants/rt-a1?' + invalid)).status, 400, invalid);
  const features = (await f.request('/api/bootstrap')).data.features;
  for (const feature of ['tenant-summary', 'conversation-delta', 'inbox-since', 'attention']) assert.ok(features.includes(feature), feature);
});
