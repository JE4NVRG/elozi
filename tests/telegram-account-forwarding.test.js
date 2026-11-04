import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Outbox } from '../src/outbox.js';
import { createForwardingService } from '../src/forwarding.js';
import { channelCapabilities } from '../public/channel-capabilities.js';
import { forwardMessageContent, forwardingFingerprint } from '../public/forwarding.js';

const denied = error => error.status === 403 && /encaminhamento.*conta pessoal do Telegram/.test(error.message);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const actor = { userId: 'forward-policy-qa', role: 'reseller', resellerId: 'mep-demo', name: 'Encaminhamento QA' };
function fixture(t, { sourceChannel = {}, destinationChannel = {}, attachment = false, beforeSend = async () => {}, read } = {}) {
  const store = new Store(':memory:'), tenant = store.createTenant(actor, { name: 'Encaminhamento pessoal QA', segment: 'Teste' });
  const bytes = Buffer.from([1, 2, 3, 4]), metadata = { id: 'source_file', kind: 'image', name: 'synthetic.png', mime: 'image/png', size: bytes.length, status: 'ready' };
  store.mutate(actor, tenant.id, 'Fixture sintética', state => {
    state.channels = [{ id: 'source_channel', name: 'Origem', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', ...sourceChannel }, { id: 'destination_channel', name: 'Destino', kind: 'telegram', transport: 'telegram-bot', state: 'connected', ...destinationChannel }];
    state.conversations = [{ id: 'source', channelId: 'source_channel', version: 1, status: 'open', owner: 'human', assignedUserId: actor.userId, messages: [{ id: 'original_message', kind: 'customer', text: 'Conteúdo sintético recebido', delivery: 'received', ...(attachment ? { attachments: [metadata] } : {}) }] }, { id: 'destination', channelId: 'destination_channel', version: 1, status: 'open', owner: 'human', assignedUserId: actor.userId, messages: [] }];
  });
  const counts = { capabilities: 0, read: 0, upload: 0, send: 0 }, outbox = new Outbox(store, { beforeSend });
  const current = () => store.tenant(actor, tenant.id);
  const makePersonal = () => store.mutate(actor, tenant.id, 'Mudança sintética de origem', state => { state.channels[0].kind = 'telegram_user'; state.channels[0].transport = 'telegram-user'; });
  const adapter = { entries: new Map([['destination_channel', { tenantId: tenant.id, state: 'connected', matched: true }]]), send: async () => { counts.send++; return store.getConversation(current(), 'destination'); } };
  const service = createForwardingService({ store, outbox,
    media: { read: async (...args) => { counts.read++; return read ? read(...args) : { bytes, metadata }; }, upload: async () => { counts.upload++; return { id: 'copied_file' }; }, discard: async () => {} },
    authorize: (who, id, conversationId, version) => store.getConversation(store.tenant(who, id), conversationId, version),
    // Deliberately override the product capability: backend origin policy must stand on its own.
    capabilities: (_who, _id, _conversation, channel) => { counts.capabilities++; return { ...channelCapabilities(channel), forward: true }; },
    adapterFor: () => adapter, messagePolicy: () => true
  });
  const source = store.getConversation(current(), 'source'), content = forwardMessageContent(source.messages[0], source, { active: true, canReply: true, workspaceId: actor.resellerId, tenantId: tenant.id, userId: actor.userId, conversationId: source.id });
  const input = { messageId: 'original_message', sourceVersion: 1, sourceChannelId: 'source_channel', fingerprint: forwardingFingerprint(content), destinationId: 'destination', destinationVersion: 1, destinationChannelId: 'destination_channel', idempotencyKey: 'forward_policy_synthetic_001' };
  const commands = () => store.db.prepare('SELECT state,payload FROM outbound_commands').all();
  t.after(() => store.close());
  return { store, tenant, service, counts, input, current, makePersonal, commands, forward: options => service.forward(actor, tenant.id, 'source', input, options) };
}

test('capability nega os dois discriminantes pessoais e preserva bot/WhatsApp', () => {
  assert.equal(channelCapabilities({ kind: 'telegram_user', transport: 'telegram-bot' }).forward, false);
  assert.equal(channelCapabilities({ kind: 'telegram', transport: 'telegram-user' }).forward, false);
  assert.equal(channelCapabilities({ kind: 'telegram', transport: 'telegram-bot' }).forward, true);
  assert.equal(channelCapabilities({ kind: 'whatsapp_qr', transport: 'baileys' }).forward, true);
});

for (const sourceChannel of [{ kind: 'telegram_user', transport: 'telegram-bot' }, { kind: 'telegram', transport: 'telegram-user' }]) {
  test(`backend nega origem pessoal por ${sourceChannel.kind === 'telegram_user' ? 'kind' : 'transport'}, mesmo com capability permissiva`, async t => {
    const f = fixture(t, { sourceChannel, attachment: true });
    await assert.rejects(f.forward(), denied);
    assert.deepEqual(f.counts, { capabilities: 0, read: 0, upload: 0, send: 0 }); assert.deepEqual(f.commands(), []);
    assert.equal(f.current().conversations[0].messages.length, 1);
  });
}

test('reauthorize converte a origem antes da leitura sem criar cópia ou recibo', async t => {
  const f = fixture(t); let changed = false;
  await assert.rejects(f.forward({ reauthorize: () => { if (!changed) { changed = true; f.makePersonal(); } } }), denied);
  assert.deepEqual(f.counts, { capabilities: 0, read: 0, upload: 0, send: 0 }); assert.deepEqual(f.commands(), []);
});

test('mudança durante leitura de mídia impede upload/outbox/transporte após await', async t => {
  const reached = deferred(), pendingRead = deferred(), f = fixture(t, { attachment: true, read: async () => { reached.resolve(); return pendingRead.promise; } });
  const pending = f.forward(); await reached.promise; f.makePersonal();
  pendingRead.resolve({ bytes: Buffer.from([1, 2, 3, 4]), metadata: { id: 'source_file', kind: 'image', name: 'synthetic.png', mime: 'image/png', size: 4, status: 'ready' } });
  await assert.rejects(pending, denied);
  assert.equal(f.counts.read, 1); assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 0); assert.deepEqual(f.commands(), []);
});

test('mudança durante fila do outbox impede despacho e preserva recibo failed', async t => {
  const reached = deferred(), release = deferred(), f = fixture(t, { beforeSend: async () => { reached.resolve(); await release.promise; } });
  const pending = f.forward(); await reached.promise; f.makePersonal(); release.resolve();
  await assert.rejects(pending, denied);
  assert.equal(f.counts.send, 0); assert.deepEqual(f.commands().map(command => command.state), ['failed']);
});

test('replay confirmado nega origem agora pessoal sem repetir transporte nem alterar recibo', async t => {
  const f = fixture(t); await f.forward(); const before = f.commands();
  assert.equal(f.counts.send, 1); assert.equal(before[0].state, 'confirmed'); f.makePersonal();
  await assert.rejects(f.forward(), denied);
  assert.equal(f.counts.send, 1); assert.deepEqual(f.commands(), before);
});

test('outro canal continua encaminhando para destino pessoal por atendimento humano', async t => {
  const f = fixture(t, { destinationChannel: { kind: 'telegram_user', transport: 'telegram-user' } });
  const result = await f.forward(); assert.equal(result.id, 'destination'); assert.equal(f.counts.send, 1);
  assert.deepEqual(f.commands().map(command => command.state), ['confirmed']);
});
