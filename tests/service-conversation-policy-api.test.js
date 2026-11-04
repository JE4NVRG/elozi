import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';

const status = value => error => error.status === value;
const cutoff = '2026-10-24T11:58:00-03:00';
const question = (at, text = 'Synthetic policy question') => ({ id: 'customer-' + at, kind: 'customer', text, createdAt: at });
function fixture(t, journal) {
  const store = new Store(':memory:', { conversationJournal: journal }); new Outbox(store);
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'policy.api.owner', name: 'Synthetic policy API' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Policy API QA', segment: 'Synthetic' });
  store.mutate(admin, tenant.id, 'Synthetic restricted inventory', state => {
    state.agents = [{ id: 'assistant', name: 'Synthetic MCP', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.channels = [{ id: 'business', name: 'Business QA', kind: 'webchat', state: 'connected' }, { id: 'personal', name: 'Personal QA', kind: 'webchat', state: 'connected' }];
    state.departments = [];
    const conversation = (id, at, extra = {}) => ({ id, contact: 'Synthetic ' + id, channelId: 'business', status: 'open', owner: 'queue', version: 1, updatedAt: '2026-10-24T20:00:00Z', messages: [question(at)], ...extra });
    state.conversations = [conversation('legacy', '2026-10-01T12:00:00Z'), conversation('eligible', cutoff), conversation('personal', cutoff, { channelId: 'personal' }), conversation('group', cutoff, { conversationKind: 'group' }), conversation('missing-date', undefined), conversation('old-thread-new-question', cutoff)];
  });
  const principals = new ServicePrincipals(store, auth), created = principals.create(admin, tenant.id, { name: 'Synthetic scoped service', agentId: 'assistant', capabilities: ['conversation.read', 'conversation.manage', 'reply.send'], channelIds: null,
    conversationPolicy: { customerMessagesAfter: cutoff, excludedChannelIds: ['personal'], allowGroups: false } });
  const actor = principals.authenticate('Bearer ' + created.token), sent = [];
  const api = new ServiceApi(store, principals, {}, { sendPrivate: async (_actor, input) => { sent.push(input); return { state: 'confirmed', messageId: 'synthetic-transport-receipt' }; }, operations: { applyAssignment(c, _actor, value) { c.owner = value.owner; c.agentId = value.agent?.id || null; } } });
  t.after(() => store.close());
  const changed = fn => store.mutate(admin, tenant.id, 'Synthetic policy mutation', state => fn(state));
  const receipts = () => store.db.prepare('SELECT count(*) n FROM service_principal_receipts').get().n;
  return { store, auth, admin, tenant, principals, created, actor, api, sent, changed, receipts };
}

for (const journal of [false, true]) {
  test(`real API filters inventories/search/history without modifying legacy or personal records; journal=${journal}`, t => {
    const f = fixture(t, journal), before = JSON.stringify(f.store.tenant(f.admin, f.tenant.id));
    const result = f.api.inbox(f.actor, { requestId: 'policy_list_first', limit: 50 });
    assert.deepEqual(result.conversations.map(c => c.id).sort(), ['eligible', 'old-thread-new-question']);
    const search = f.api.searchConversations(f.actor, { requestId: 'policy_search_first', query: 'Synthetic', limit: 50 });
    assert.deepEqual(search.conversations.map(c => c.conversationId).sort(), ['eligible', 'old-thread-new-question']);
    const count = f.receipts();
    for (const id of ['legacy', 'personal', 'group', 'missing-date']) {
      assert.throws(() => f.api.read(f.actor, id), status(403));
      assert.throws(() => f.api.readConversationHistory(f.actor, { requestId: 'policy_history_' + id, conversationId: id, after: '2026-10-01T00:00:00Z', before: '2026-10-25T00:00:00Z' }), status(403));
    }
    assert.equal(f.receipts(), count); assert.deepEqual(f.sent, []);
    assert.equal(JSON.stringify(f.store.tenant(f.admin, f.tenant.id)), before);
  });

  test(`real API denies old claim/send and allows a new question in an existing thread; journal=${journal}`, async t => {
    const f = fixture(t, journal), before = f.receipts();
    assert.throws(() => f.api.claimConversation(f.actor, { requestId: 'policy_claim_old_001', conversationId: 'legacy', version: 1 }), status(403));
    await assert.rejects(() => f.api.sendReply(f.actor, { requestId: 'policy_send_old_001', conversationId: 'legacy', version: 1, text: 'Synthetic answer' }), status(403));
    assert.equal(f.receipts(), before); assert.equal(f.sent.length, 0);
    f.changed(state => { const c = state.conversations.find(c => c.id === 'legacy'); c.messages.push(question(cutoff)); c.version++; });
    const claimed = f.api.claimConversation(f.actor, { requestId: 'policy_claim_new_001', conversationId: 'legacy', version: 2 });
    assert.ok(claimed.receipt);
    const current = f.store.tenant(f.admin, f.tenant.id).conversations.find(c => c.id === 'legacy');
    await f.api.sendReply(f.actor, { requestId: 'policy_send_new_001', conversationId: 'legacy', version: current.version, text: 'Synthetic answer' });
    assert.equal(f.sent.length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0, 'only the injected synthetic transport ran');
  });
}

test('inventory cursor cannot reveal a previously eligible record after its policy context changes', t => {
  const f = fixture(t, true);
  const first = f.api.inbox(f.actor, { requestId: 'policy_snapshot_first', limit: 1 });
  assert.ok(first.nextCursor);
  f.changed(state => { for (const c of state.conversations) if (c.id !== first.conversations[0].id) c.messages = [question('2026-10-01T00:00:00Z')]; });
  assert.throws(() => f.api.inbox(f.actor, { requestId: 'policy_snapshot_second', limit: 1, cursor: first.nextCursor }), status(403));
  assert.equal(f.sent.length, 0);
});
