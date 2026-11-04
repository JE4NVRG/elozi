import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { normalizeServiceConversationPolicy as normalize, serviceConversationDecision as decide } from '../src/service-conversation-policy.js';

const cutoff = '2026-10-24T11:58:00-03:00';
const policy = normalize({ customerMessagesAfter: cutoff, allowGroups: false, excludedChannelIds: ['personal'] });
const status = n => error => error.status === n;
const customer = (at, extra = {}) => ({ id: 'customer', kind: 'customer', text: 'Synthetic question', createdAt: at, ...extra });
const conv = (messages, extra = {}) => ({ id: 'conversation', contact: 'Synthetic contact', channelId: 'business', departmentId: null, status: 'open', owner: 'queue', version: 1, messages, updatedAt: '2026-10-24T20:00:00Z', ...extra });
function fixture(t, { path = ':memory:', journal = false, restriction = policy } = {}) {
  const store = new Store(path, { conversationJournal: journal }); new Outbox(store);
  t.after(() => { if (store.db.isOpen) store.close(); });
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'policy.owner', name: 'Synthetic policy owner' }, Buffer.alloc(16, 5), Buffer.alloc(64, 5), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Policy QA', segment: 'Synthetic' });
  store.mutate(admin, tenant.id, 'Synthetic policy fixture', state => {
    state.agents = [{ id: 'assistant', name: 'Synthetic MCP', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
    state.channels = [{ id: 'business', kind: 'webchat' }, { id: 'personal', kind: 'whatsapp_qr' }];
    state.departments = [];
    state.conversations = [conv([customer(cutoff)])];
  });
  const principals = new ServicePrincipals(store, auth);
  const created = principals.create(admin, tenant.id, { name: 'Synthetic service', agentId: 'assistant', capabilities: ['conversation.read', 'reply.send', 'conversation.manage'], channelIds: null, conversationPolicy: restriction });
  const actor = principals.authenticate('Bearer ' + created.token);
  const context = () => ({ workspaceId: actor.workspaceId, tenantId: tenant.id, agentId: actor.agentId, conversationId: 'conversation', channelId: 'business', departmentId: 'unassigned' });
  const change = fn => store.mutate(admin, tenant.id, 'Synthetic conversation update', state => fn(state.conversations[0]));
  return { store, auth, admin, tenant, principals, created, actor, context, change };
}

test('cutoff normalizes explicit BRT and accepts equality without changing the source token', () => {
  assert.equal(policy.customerMessagesAfter, '2026-10-24T14:58:00.000Z');
  assert.equal(decide(policy, conv([customer(cutoff)])).allowed, true);
  assert.equal(decide(policy, conv([customer('2026-10-24T14:57:59.999Z')])).reason, 'customer_message_before_cutoff');
});

test('old thread with a new customer message qualifies; human/system activity does not qualify it', () => {
  assert.equal(decide(policy, conv([customer('2026-10-01T12:00:00Z'), customer('2026-10-24T14:59:00Z')])).allowed, true);
  assert.equal(decide(policy, conv([customer('2026-10-01T12:00:00Z'), { kind: 'human', createdAt: '2026-10-24T19:00:00Z' }])).allowed, false);
});

test('unknown, malformed or late last customer timestamp fails closed', () => {
  for (const at of [undefined, null, '2026-02-31T12:00:00Z', '2026-10-24T11:58:00', 'garbage']) assert.equal(decide(policy, conv([customer(cutoff), customer(at)])).allowed, false);
  assert.equal(decide(policy, conv([])).allowed, false);
  assert.equal(decide(policy, conv([customer(cutoff, { deliveredLate: true })])).reason, 'customer_message_delivered_late');
});

test('group and channel exclusions restrict rather than granting an action', () => {
  assert.equal(decide(policy, conv([customer(cutoff)], { channelId: 'personal' })).reason, 'excluded_channel');
  assert.equal(decide(policy, conv([customer(cutoff)], { conversationKind: 'group' })).reason, 'groups_disabled');
  assert.equal(decide(normalize(null), conv([])).allowed, true);
});

test('policy input strictly rejects wrong types, unknown keys, invalid calendars and missing timezones', () => {
  for (const input of [true, [], { allowGroups: 'false' }, { grant: 'reply.send' }, { excludedChannelIds: null }, { excludedChannelIds: [''] }, { customerMessagesAfter: '2026-02-31T12:00:00Z' }, { customerMessagesAfter: '2026-10-24T12:00:00' }]) assert.throws(() => normalize(input), status(400));
});

for (const journal of [false, true]) {
  test(`fresh principal authorization enforces cutoff/exclusions from private source; journal=${journal}`, t => {
    const f = fixture(t, { journal });
    assert.doesNotThrow(() => f.principals.revalidate(f.actor, 'conversation.read', f.context()));
    const original = JSON.stringify(f.store.tenant(f.admin, f.tenant.id));
    f.change(c => { c.messages = [customer('2026-10-01T12:00:00Z')]; });
    for (const capability of ['conversation.read', 'conversation.manage', 'reply.send']) assert.throws(() => f.principals.revalidate(f.actor, capability, f.context()), status(403));
    f.change(c => { c.messages.push(customer(cutoff)); c.owner = 'agent'; c.agentId = 'assistant'; });
    assert.doesNotThrow(() => f.principals.revalidate(f.actor, 'reply.send', f.context()));
    f.change(c => { c.channelId = 'personal'; });
    assert.throws(() => f.principals.revalidate(f.actor, 'conversation.read', { ...f.context(), channelId: 'personal' }), status(403));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0);
    assert.ok(original.includes('Synthetic question'));
  });
}

test('policy updates preserve restrictions on ordinary edits and reject stale authority', t => {
  const f = fixture(t);
  const changed = f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, name: 'Renamed service' });
  assert.deepEqual(changed.conversationPolicy, policy);
  assert.throws(() => f.principals.revalidate(f.actor, 'conversation.read', f.context()), status(409));
  assert.throws(() => f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, conversationPolicy: null }), status(409));
  assert.throws(() => f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 2, conversationPolicy: { excludedChannelIds: ['other-tenant-channel'] } }), status(400));
});

for (const state of ['dispatched', 'unknown']) {
  test(`policy changes cannot strand a ${state} receipt`, t => {
    const f = fixture(t, { restriction: null });
    const reservation = f.principals.reserve(f.actor, { requestId: 'policy_pending_001', capability: 'conversation.read', context: f.context(), units: 1, costMicros: 0 });
    f.principals.beginDispatch(f.actor, reservation.receipt.id);
    if (state === 'unknown') f.principals.complete(f.actor, reservation.receipt.id, { state: 'unknown' });
    assert.throws(() => f.principals.update(f.admin, f.tenant.id, f.created.principal.id, { revision: 1, conversationPolicy: policy }), status(409));
    assert.equal(f.principals.receipt(f.actor, reservation.receipt.id).state, state);
    assert.equal(f.principals.list(f.admin, f.tenant.id).principals[0].revision, 1);
    assert.deepEqual(f.principals.list(f.admin, f.tenant.id).principals[0].conversationPolicy, normalize(null));
  });
}

test('file-backed close/reopen preserves restriction without changing token or agent mode', t => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'elozi-service-policy-'));
  let reopened;
  t.after(() => { if (reopened?.db.isOpen) reopened.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'synthetic.sqlite'), f = fixture(t, { path });
  const tokenHash = f.store.db.prepare('SELECT token_hash FROM service_principals WHERE id=?').get(f.created.principal.id).token_hash;
  f.store.close();
  const store = reopened = new Store(path), auth = new Auth(store.db);
  const principals = new ServicePrincipals(store, auth), actor = principals.authenticate('Bearer ' + f.created.token);
  assert.deepEqual(principals.list(f.admin, f.tenant.id).principals[0].conversationPolicy, policy);
  assert.doesNotThrow(() => principals.revalidate(actor, 'conversation.read', f.context()));
  assert.equal(store.db.prepare('SELECT token_hash FROM service_principals WHERE id=?').get(actor.principalId).token_hash, tokenHash);
  assert.equal(principals.adapter(store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(actor.principalId)).agent.mode, 'copilot');
});
