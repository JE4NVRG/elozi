import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSendIntent } from '../public/send-intent.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import { WebchatGateway } from '../src/channel-webchat.js';

const input = extra => ({ workspaceId: 'workspace-a', tenantId: 'tenant-a', conversationId: 'conversation-a', channelId: 'channel-a',
  version: 2, text: 'Resposta digitada que precisa ser preservada.', attachmentIds: [], ...extra });
function keys() { let count = 0; return { randomUUID: () => 'synthetic-command-' + ++count, count: () => count }; }

test('a poll advancing revision preserves the manual retry command instead of minting another key', () => {
  const generator = keys(), original = createSendIntent(null, input(), generator);
  const retry = createSendIntent(original, input({ version: 7 }), generator);
  assert.equal(retry, original); assert.equal(retry.idempotencyKey, original.idempotencyKey); assert.equal(retry.version, 2);
  assert.equal(generator.count(), 1); assert.equal(Object.isFrozen(original), true);
});

test('tenant, workspace, channel, attendance, text, attachment or quote change creates a separate command', () => {
  const changes = [{ workspaceId: 'workspace-b' }, { tenantId: 'tenant-b' }, { conversationId: 'conversation-b' }, { channelId: 'channel-b' },
    { text: 'Texto revisado explicitamente.' }, { attachmentIds: ['attachment-b'] }, { replyToMessageId: 'original-message-b' }];
  for (const change of changes) {
    const generator = keys(), original = createSendIntent(null, input(), generator), next = createSendIntent(original, input({ ...change, version: 9 }), generator);
    assert.notEqual(next.idempotencyKey, original.idempotencyKey); assert.equal(next.version, 9); assert.equal(generator.count(), 2);
  }
});

test('attachment retry preserves its original revision and quote without retaining the mutable file list', () => {
  const generator = keys(), attachments = ['uploaded-file-a'], first = input({ attachmentIds: attachments, replyToMessageId: 'message-a' });
  const original = createSendIntent(null, first, generator); attachments[0] = 'uploaded-file-b';
  const retry = createSendIntent(original, input({ version: 3, attachmentIds: ['uploaded-file-a'], replyToMessageId: 'message-a' }), generator);
  assert.equal(retry, original); assert.equal(retry.version, 2); assert.equal(generator.count(), 1);
  const changed = createSendIntent(original, { ...first, version: 3 }, generator); assert.notEqual(changed.idempotencyKey, original.idempotencyKey);
});

test('invalid attendance revision or command key is rejected before generating a send', () => {
  for (const invalid of [{ version: 0 }, { version: 1.5 }, { text: null }, { attachmentIds: null }, { attachmentIds: [null] }, { tenantId: '' }, { conversationId: '' }, { channelId: '' }]) {
    const generator = keys(); assert.throws(() => createSendIntent(null, input(invalid), generator)); assert.equal(generator.count(), 0);
  }
  assert.throws(() => createSendIntent(null, input(), { randomUUID: () => 'invalid key' }));
  const generator = keys(), recovered = createSendIntent({ intent: 'stale', version: 0, idempotencyKey: 'synthetic-stale-command' }, input(), generator);
  assert.equal(recovered.version, 2); assert.equal(generator.count(), 1);
});

async function webchat(t) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, tenantId) => store.tenant(actor, tenantId) });
  const row = auth.insertUser({ name: 'Synthetic send-intent owner', username: 'synthetic.send-intent' }, randomBytes(16), randomBytes(64), 'reseller', [], 'mep-demo');
  const actor = auth.actor(row), tenant = store.createTenant(actor, { name: 'Send intent RAM journey', segment: 'Synthetic fixture' }), channelId = randomUUID();
  store.mutate(actor, tenant.id, 'Synthetic webchat fixture', state => { state.channels.push({ id: channelId, name: 'Synthetic widget', kind: 'webchat', state: 'planned' }); });
  const operations = new Operations(store, auth), gateway = new WebchatGateway(store, { operations }), outbox = new Outbox(store, { authorize: (actor, id, current) => operations.canReply(actor, id, current) });
  t.after(async () => { await gateway.close(); store.close(); });
  const origin = 'https://send-intent.example.test'; gateway.configure(actor, tenant.id, channelId, { origins: [origin], version: 0 });
  const challenge = gateway.challenge({ tenantId: tenant.id, channelId, origin }), visitor = gateway.openSession({ tenantId: tenant.id, channelId, origin, challenge: challenge.challenge });
  await gateway.receive({ token: visitor.token, origin, clientMessageId: randomUUID(), text: 'Entrada de visitante sintética.' });
  const state = () => store.tenant(actor, tenant.id), conversation = () => state().conversations.find(item => item.channelId === channelId);
  operations.assign(actor, tenant.id, conversation().id, { version: conversation().version, owner: 'human' });
  const commandInput = extra => input({ workspaceId: actor.resellerId, tenantId: tenant.id, conversationId: conversation().id, channelId, version: conversation().version, ...extra });
  const execute = (intent, payload) => {
    const body = { channelId, text: payload.text, attachmentIds: payload.attachmentIds, replyToMessageId: payload.replyToMessageId, version: intent.version, idempotencyKey: intent.idempotencyKey };
    return outbox.dispatch(actor, tenant.id, conversation().id, body, () => gateway.send(actor, tenant.id, conversation().id, body));
  };
  return { store, actor, tenant, channelId, gateway, visitor, origin, outbox, conversation, commandInput, execute };
}

test('lost HTTP acknowledgement followed by a real poll and manual retry yields one human message and one outbox attempt', async t => {
  const c = await webchat(t), originalInput = c.commandInput(), original = createSendIntent(null, originalInput);
  // The endpoint commits, then its HTTP acknowledgement fails to reach the page.
  await assert.rejects(async () => { await c.execute(original, originalInput); throw new Error('Synthetic HTTP acknowledgement lost'); }, /acknowledgement lost/);
  const polledVersion = c.conversation().version; assert.ok(polledVersion > original.version);
  const retryInput = c.commandInput(), retry = createSendIntent(original, retryInput); assert.equal(retry.idempotencyKey, original.idempotencyKey);
  await c.execute(retry, retryInput);
  assert.equal(c.conversation().messages.filter(item => item.kind === 'human').length, 1);
  const receipt = c.store.db.prepare('SELECT state,attempts,version FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(c.tenant.id, original.idempotencyKey);
  assert.deepEqual({ ...receipt }, { state: 'confirmed', attempts: 1, version: original.version });
  const history = c.gateway.history({ token: c.visitor.token, origin: c.origin }); assert.equal(history.messages.filter(item => item.kind === 'human').length, 1);
  assert.equal(history.messages.at(-1).text, originalInput.text);
});

test('same command after an uncertain endpoint result is rejected without another provider attempt', async t => {
  const c = await webchat(t), originalInput = c.commandInput(), original = createSendIntent(null, originalInput); let providerAttempts = 0;
  const attempt = (intent, payload) => {
    const body = { channelId: c.channelId, text: payload.text, attachmentIds: [], version: intent.version, idempotencyKey: intent.idempotencyKey };
    return c.outbox.dispatch(c.actor, c.tenant.id, c.conversation().id, body, async () => {
      providerAttempts++; await c.gateway.send(c.actor, c.tenant.id, c.conversation().id, body);
      throw Object.assign(new Error('Synthetic delivery result cannot be confirmed'), { status: 502 });
    });
  };
  await assert.rejects(attempt(original, originalInput), error => error.status === 502);
  const retryInput = c.commandInput(), retry = createSendIntent(original, retryInput); assert.equal(retry.version, original.version);
  await assert.rejects(attempt(retry, retryInput), error => error.status === 409 && error.code === 'OUTBOUND_UNCONFIRMED');
  assert.equal(providerAttempts, 1); assert.equal(c.conversation().messages.filter(item => item.kind === 'human').length, 1);
  assert.equal(c.store.db.prepare('SELECT state FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(c.tenant.id, original.idempotencyKey).state, 'unknown');
});

