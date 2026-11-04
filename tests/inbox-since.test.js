import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFixture, message, at } from './helpers/realtime-fixture.js';
import { createConsolidatedInbox } from '../src/consolidated-inbox.js';

const keys = page => page.items.map(item => item.tenantId + '/' + item.id).sort();

test('inbox since: revisão por pessoa e filtros, unchanged sem itens e página completa quando algo visível muda', async t => {
  const f = await realtimeFixture(t);
  const first = await f.request('/api/inbox');
  assert.equal(first.status, 200); assert.match(first.data.revision, /^r_[a-f0-9]{32}$/);
  assert.deepEqual(keys(first.data), ['rt-a1/c-agent', 'rt-a1/c-mine', 'rt-a1/c-sales', 'rt-a1/c-support', 'rt-a1/c-tg', 'rt-a2/c-a2']);
  const same = await f.request('/api/inbox?since=' + first.data.revision);
  assert.deepEqual(same.data, { workspaceId: 'ws-a', unchanged: true, revision: first.data.revision });
  // Other filters are another page: their revision differs and an old revision never short-circuits them.
  const queue = await f.request('/api/inbox?tab=queue&since=' + first.data.revision);
  assert.equal(queue.data.unchanged, undefined); assert.notEqual(queue.data.revision, first.data.revision); assert.ok(Array.isArray(queue.data.items));
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-sales'); c.messages.push(message('c-sales-m4', 'customer', 'Nova', 5)); c.version++; c.unread++; c.updatedAt = at(5); });
  const changed = await f.request('/api/inbox?since=' + first.data.revision);
  assert.equal(changed.data.unchanged, undefined); assert.notEqual(changed.data.revision, first.data.revision);
  assert.equal(changed.data.items.find(item => item.id === 'c-sales').preview.text, 'Nova');
  // An event cursor or an unknown token is accepted as since and answers the full page.
  assert.equal((await f.request('/api/inbox?since=0123456789ab-1')).data.items.length, 6);
  for (const invalid of ['since=a&since=b', 'since=' + 'x'.repeat(121), 'delta=2']) assert.equal((await f.request('/api/inbox?' + invalid)).status, 400, invalid);
});

test('inbox since isola empresa, departamento, canal e responsável: mudanças fora do escopo não mudam a revisão', async t => {
  const f = await realtimeFixture(t);
  const sales = await f.request('/api/inbox', { as: 'sales' }), support = await f.request('/api/inbox', { as: 'support' });
  assert.deepEqual(keys(sales.data), ['rt-a1/c-agent', 'rt-a1/c-mine', 'rt-a1/c-sales']);
  assert.deepEqual(keys(support.data), ['rt-a1/c-support']);
  assert.deepEqual(sales.data.countTabs, { all: 3, mine: 1, queue: 1, agent: 1 }); assert.equal(support.data.countTabs.mine, 0);
  for (const hidden of ['c-support', 'c-tg', 'c-a2', 'c-b1', 'rt-a2', 'rt-b1', 'tg-a1']) assert.equal(sales.text.includes(hidden), false, hidden);
  // Another person's revision never matches, even for the same filters.
  assert.equal((await f.request('/api/inbox?since=' + support.data.revision, { as: 'sales' })).data.unchanged, undefined);
  // Changes in another department, channel, company or workspace keep the sales page (and its revision) intact.
  f.mutate('rt-a1', tenant => { for (const id of ['c-support', 'c-tg']) { const c = tenant.conversations.find(item => item.id === id); c.messages.push(message(id + '-new', 'customer', 'Fora do escopo', 6)); c.version++; c.unread++; c.updatedAt = at(6); } });
  f.mutate('rt-a2', tenant => { tenant.conversations[0].unread = 9; tenant.conversations[0].version++; });
  f.mutate('rt-b1', tenant => { tenant.conversations[0].unread = 9; tenant.conversations[0].version++; });
  assert.deepEqual((await f.request('/api/inbox?since=' + sales.data.revision, { as: 'sales' })).data, { workspaceId: 'ws-a', unchanged: true, revision: sales.data.revision });
  // Moving the conversation assigned to sales into another department removes it from the sales page.
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-mine'); c.departmentId = 'support'; c.version++; });
  const moved = await f.request('/api/inbox?since=' + sales.data.revision, { as: 'sales' });
  assert.deepEqual(keys(moved.data), ['rt-a1/c-agent', 'rt-a1/c-sales']); assert.equal(moved.data.countTabs.mine, 0);
  // Workspaces stay isolated.
  assert.equal((await f.request('/api/inbox', { as: 'foreign', headers: { 'X-Elozi-Workspace': 'ws-a' } })).status, 403);
  assert.equal((await f.request('/api/inbox?tenantId=rt-a2', { as: 'sales' })).status, 403);
});

test('inbox delta=1 traz só as linhas alteradas, removidas e a ordem, sem expor conversas fora do escopo', async t => {
  const f = await realtimeFixture(t);
  const first = await f.request('/api/inbox?delta=1', { as: 'sales' });
  assert.equal(first.data.delta, false); assert.equal(first.data.items.length, 3);
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-sales'); c.messages.push(message('c-sales-m4', 'customer', 'Nova', 7)); c.version++; c.updatedAt = at(7); });
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-support'); c.version++; c.unread = 5; });
  const second = await f.request('/api/inbox?delta=1&since=' + first.data.revision, { as: 'sales' });
  assert.equal(second.data.delta, true);
  assert.deepEqual(second.data.items.map(item => item.id), ['c-sales']); assert.deepEqual(second.data.removed, []);
  assert.deepEqual(second.data.order, [['rt-a1', 'c-sales'], ['rt-a1', 'c-mine'], ['rt-a1', 'c-agent']]);
  assert.equal(second.data.total, 3); assert.ok(second.data.countTabs);
  f.mutate('rt-a1', tenant => { const c = tenant.conversations.find(item => item.id === 'c-mine'); c.departmentId = 'support'; c.version++; });
  const third = await f.request('/api/inbox?delta=1&since=' + second.data.revision, { as: 'sales' });
  assert.deepEqual(third.data.items, []); assert.deepEqual(third.data.removed, [['rt-a1', 'c-mine']]);
  assert.equal(third.text.includes('c-support'), false);
  assert.deepEqual((await f.request('/api/inbox?delta=1&since=' + third.data.revision, { as: 'sales' })).data, { workspaceId: 'ws-a', unchanged: true, revision: third.data.revision });
  // A revision served to another person never seeds a delta.
  const other = await f.request('/api/inbox?delta=1&since=' + third.data.revision, { as: 'support' });
  assert.equal(other.data.delta, false); assert.deepEqual(other.data.items.map(item => item.id).sort(), ['c-mine', 'c-support']);
});

test('inbox agentState vem dos runs persistidos sem rascunho, ferramenta ou recibo', async t => {
  const f = await realtimeFixture(t);
  f.mutate('rt-a1', tenant => {
    tenant.runs = [
      { id: 'run-1', conversationId: 'c-sales', state: 'running', conversationVersion: 3, draft: null },
      { id: 'run-2', conversationId: 'c-mine', state: 'waiting_approval', conversationVersion: 1, toolProposal: { title: 'ERP segredo', arguments: { cpf: '123' }, expiresAt: at(60 * 24 * 365 * 10) } },
      { id: 'run-3', conversationId: 'c-agent', state: 'draft', conversationVersion: 1, draft: 'Rascunho confidencial' },
      { id: 'run-4', conversationId: 'c-support', state: 'draft', conversationVersion: 0, draft: 'Rascunho antigo' },
      { id: 'run-5', conversationId: 'c-tg', state: 'waiting_approval', conversationVersion: 1, toolProposal: { expiresAt: at(-60) } }
    ];
  });
  const page = await f.request('/api/inbox');
  const states = Object.fromEntries(page.data.items.map(item => [item.id, item.agentState]));
  assert.deepEqual(states, { 'c-tg': null, 'c-sales': 'running', 'c-support': 'stale', 'c-mine': 'waiting_approval', 'c-a2': null, 'c-agent': 'draft' });
  for (const secret of ['Rascunho', 'ERP segredo', 'cpf', 'run-1']) assert.equal(page.text.includes(secret), false, secret);
  // A newer stale mark wins over an older draft of the same conversation.
  f.mutate('rt-a1', tenant => { tenant.runs.push({ id: 'run-6', conversationId: 'c-agent', state: 'draft', conversationVersion: 1, stale: true, draft: 'novo' }); });
  assert.equal((await f.request('/api/inbox')).data.items.find(item => item.id === 'c-agent').agentState, 'stale');
  assert.equal((await f.request('/api/bootstrap')).data.features.includes('inbox-agent-state'), true);
});

test('cache de delta é limitado e configurável', () => {
  const tenants = [{ id: 't1', name: 'T1', channels: [], departments: [], conversations: [{ id: 'c1', channelId: 'x', owner: 'queue', status: 'open', version: 1, messages: [] }] }];
  const store = { db: { prepare: () => ({ all: () => tenants.map(({ id }) => ({ id })) }) }, tenant: (_actor, id) => tenants.find(item => item.id === id) };
  const inbox = createConsolidatedInbox(store, { can: () => true, channelState: () => 'connected', deltaCacheSize: 1 });
  const actor = { userId: 'u1', role: 'reseller', resellerId: 'w' };
  const first = inbox.list(actor, new URLSearchParams('delta=1')), other = inbox.list(actor, new URLSearchParams('delta=1&tab=queue'));
  tenants[0].conversations[0].version = 2;
  // The first revision was evicted by the second page: the answer is the full page, not a delta.
  assert.equal(inbox.list(actor, new URLSearchParams('delta=1&since=' + first.revision)).delta, false);
  assert.ok(other.revision);
  assert.throws(() => createConsolidatedInbox(store, { can: () => true, channelState: () => 'x', deltaCacheSize: -1 }), TypeError);
});
