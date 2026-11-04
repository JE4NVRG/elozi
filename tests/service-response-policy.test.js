import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { serviceResponsePolicy } from '../src/service-response-policy.js';

const all = ['conversation.read', 'reply.send', 'message.schedule', 'reply.submit', 'reply.draft'];
const agent = { provider: 'mcp', mode: 'copilot', configured: true };
const describe = (capabilities = all, adapter = agent, extra = {}) => serviceResponsePolicy({ capabilities, ...extra }, adapter);

test('response policy v2 distinguishes effective autonomy, drafts and selected groups', () => {
  assert.deepEqual(describe(), {
    version: 2, adapterMode: 'copilot', effectiveMode: 'autonomous', requiresConversationAuthorization: false,
    requiresHumanConversationAuthorization: false, requiresServerConversationAuthorization: true,
    humanApprovalRequired: false,
    privateReplies: { capable: true, requiresAgentAssignment: true, requiresPerMessageApproval: false },
    drafts: { submitCapable: true, draftCapable: false, requiresHumanSend: true },
    groups: { sendCapable: true, scheduleCapable: true, requiresSelection: true, requiresPerMessageApproval: false, blockedByConversationPolicy: false }
  });
});

test('effective modes do not confuse direct actions, read-only or human-sent drafts with autonomy', () => {
  for (const [capabilities, adapter, blocked, expected] of [
    [[], agent, false, 'read-only'],
    [['conversation.read'], agent, false, 'read-only'],
    [['reply.send'], agent, true, 'autonomous'],
    [['reply.submit'], agent, true, 'copilot'],
    [['reply.draft'], { ...agent, provider: 'hermes' }, true, 'copilot'],
    [['message.schedule'], agent, false, 'direct-actions'],
    [['message.schedule'], agent, true, 'read-only'],
    [['reply.send'], { ...agent, configured: false }, false, 'direct-actions'],
    [['reply.send'], { ...agent, configured: false }, true, 'read-only']
  ]) {
    const result = describe(capabilities, adapter, { conversationPolicy: { customerMessagesAfter: null, excludedChannelIds: [], allowGroups: !blocked } });
    assert.equal(result.effectiveMode, expected);
    assert.equal(result.requiresConversationAuthorization, expected === 'copilot');
    assert.equal(result.requiresHumanConversationAuthorization, result.requiresConversationAuthorization);
    assert.equal(result.requiresServerConversationAuthorization, true);
    assert.equal(result.drafts.requiresHumanSend, true);
  }
});

test('descriptive policy never synthesizes grants or confuses send with schedule', () => {
  for (const capabilities of [[], ['conversation.read'], ['reply.draft'], ['reply.submit'], ['reply.send'], ['message.schedule']]) {
    const result = describe(capabilities);
    assert.equal(result.privateReplies.capable, capabilities.includes('reply.send'));
    assert.equal(result.drafts.submitCapable, capabilities.includes('reply.submit'));
    assert.equal(result.drafts.draftCapable, false);
    assert.equal(result.groups.sendCapable, capabilities.includes('reply.send'));
    assert.equal(result.groups.scheduleCapable, capabilities.includes('message.schedule'));
  }
  const result = serviceResponsePolicy({}, {});
  assert.equal(result.adapterMode, null);
  assert.equal(result.privateReplies.capable, false);
  assert.equal(result.groups.sendCapable, false);
});

test('provider, configuration and mode fences preserve private reply and draft semantics', () => {
  for (const adapter of [
    { provider: 'hermes', mode: 'copilot', configured: true },
    { provider: 'mcp', mode: 'autopilot', configured: true },
    { provider: 'hermes', mode: 'autopilot', configured: true },
    { provider: 'other', mode: 'copilot', configured: true },
    { provider: 'mcp', mode: 'copilot', configured: false }
  ]) {
    const result = describe(all, adapter);
    assert.equal(result.adapterMode, adapter.mode);
    assert.equal(result.privateReplies.capable, false);
    assert.equal(result.drafts.submitCapable, false);
    assert.equal(result.drafts.draftCapable, adapter.provider === 'hermes' && adapter.mode === 'copilot' && adapter.configured);
    // Selected-group authority does not require a private MCP attendant.
    assert.equal(result.groups.sendCapable, true);
    assert.equal(result.groups.scheduleCapable, true);
  }
});

test('conversation policy blocks groups without promoting any other capability', () => {
  for (const allowGroups of [false, true]) {
    const conversationPolicy = { customerMessagesAfter: '2026-10-24T00:00:00.000Z', excludedChannelIds: ['excluded'], allowGroups };
    const result = describe(all, agent, { conversationPolicy });
    assert.equal(result.groups.blockedByConversationPolicy, !allowGroups);
    assert.equal(result.groups.sendCapable, allowGroups);
    assert.equal(result.groups.scheduleCapable, allowGroups);
    assert.equal(result.privateReplies.capable, true);
    assert.equal(result.requiresConversationAuthorization, false);
    assert.equal(result.requiresServerConversationAuthorization, true);
    assert.deepEqual(result.conversationPolicy, conversationPolicy);
    const noGrants = describe([], agent, { conversationPolicy });
    assert.equal(noGrants.groups.sendCapable, false);
    assert.equal(noGrants.groups.scheduleCapable, false);
  }
});

test('public policy copies cutoff and exclusions without input mutation or private field exposure', () => {
  const conversationPolicy = Object.freeze({ customerMessagesAfter: null, excludedChannelIds: Object.freeze(['excluded']), allowGroups: true, token: 'not-public' });
  const principal = Object.freeze({ capabilities: Object.freeze(all), conversationPolicy, token: 'not-public' });
  const result = serviceResponsePolicy(principal, Object.freeze({ ...agent, endpoint: 'not-public', tools: ['not-public'] }));
  assert.deepEqual(result.conversationPolicy, { customerMessagesAfter: null, excludedChannelIds: ['excluded'], allowGroups: true });
  result.conversationPolicy.excludedChannelIds.push('local-copy');
  assert.deepEqual(principal.conversationPolicy.excludedChannelIds, ['excluded']);
  assert.equal(JSON.stringify(result).includes('not-public'), false);
  assert.equal(Object.hasOwn(describe(), 'conversationPolicy'), false);
});

function fixture(t, { provider = 'mcp', capabilities = ['conversation.read', 'reply.send', 'reply.submit', 'message.schedule'] } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'response.policy.owner', name: 'Admin sintético' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Contrato de resposta sintético', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture de metadados de resposta', state => {
    state.agents = [{ id: 'agent', name: 'Agente sintético', provider, mode: 'copilot', configured: true, version: 1, tools: [], endpoint: 'https://do-not-call.invalid', description: 'private-instructions-do-not-expose' }];
    state.channels = [{ id: 'channel', name: 'Canal sintético', kind: 'webchat', state: 'planned' }];
    state.conversations = [{ id: 'human-owned', contact: 'Contato sintético', channelId: 'channel', departmentId: null, status: 'open', owner: 'human', assignedUserId: admin.userId, version: 1, messages: [] }];
  });
  const principals = new ServicePrincipals(store, auth);
  const created = principals.create(admin, tenant.id, { name: 'Serviço sintético', agentId: 'agent', capabilities, channelIds: ['channel'], departmentIds: ['unassigned'], ttlHours: 1 });
  const actor = principals.authenticate('Bearer ' + created.token);
  const api = new ServiceApi(store, principals, {});
  // No runtime, transports, listener, environment or credentials are required.
  return { store, principals, api, actor, created };
}

test('real me v2 reports autonomous MCP response policy without quota or grants changes', t => {
  const f = fixture(t);
  const before = f.principals.metadata(f.store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(f.actor.principalId));
  const result = f.api.me(f.actor);
  assert.equal(result.humanApprovalRequired, false);
  assert.equal(result.apiVersion, 2);
  assert.equal(result.agent.mode, 'autonomous');
  assert.equal(result.agent.adapterMode, 'copilot');
  assert.deepEqual(result.responsePolicy, serviceResponsePolicy(result.principal, result.agent));
  assert.equal(result.responsePolicy.privateReplies.capable, true);
  assert.equal(result.responsePolicy.drafts.submitCapable, true);
  assert.equal(result.responsePolicy.drafts.requiresHumanSend, true);
  assert.equal(result.responsePolicy.groups.requiresPerMessageApproval, false);
  assert.deepEqual(result.groupActions, { send: true, schedule: true, scope: 'selected-groups', requiresPerMessageApproval: false });
  assert.deepEqual(result.principal, before);
  assert.deepEqual(f.api.me(f.actor).principal, before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM service_principal_receipts').get().n, 0);
  for (const secret of ['do-not-call.invalid', 'private-instructions-do-not-expose', f.created.token]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('real me capability is not authorization to reply in a human-owned conversation', t => {
  const f = fixture(t), result = f.api.me(f.actor);
  assert.equal(result.responsePolicy.privateReplies.capable, true);
  assert.equal(result.responsePolicy.requiresConversationAuthorization, false);
  assert.equal(result.responsePolicy.requiresServerConversationAuthorization, true);
  assert.throws(() => f.principals.revalidate(f.actor, 'reply.send', f.api.context(f.actor, 'human-owned')), error => error.status === 403);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM service_principal_receipts').get().n, 0);
});

test('real me reflects read-only MCP and Hermes draft grants without adding send authority', t => {
  for (const options of [
    { provider: 'mcp', capabilities: ['conversation.read'] },
    { provider: 'hermes', capabilities: ['conversation.read', 'reply.draft', 'reply.send'] }
  ]) {
    const f = fixture(t, options), result = f.api.me(f.actor);
    assert.equal(result.humanApprovalRequired, options.provider === 'hermes');
    assert.equal(result.agent.mode, options.provider === 'hermes' ? 'copilot' : 'read-only');
    assert.equal(result.agent.adapterMode, 'copilot');
    assert.equal(result.responsePolicy.privateReplies.capable, false);
    assert.equal(result.responsePolicy.drafts.submitCapable, false);
    assert.equal(result.responsePolicy.drafts.draftCapable, options.provider === 'hermes');
    assert.equal(result.responsePolicy.groups.sendCapable, options.capabilities.includes('reply.send'));
    assert.equal(result.responsePolicy.groups.scheduleCapable, false);
    assert.deepEqual([...result.principal.capabilities].sort(), [...options.capabilities].sort());
  }
});
