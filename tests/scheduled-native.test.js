import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, fail } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { createScheduledMessages } from '../src/scheduled-messages.js';
import { channelCapabilities, assertChannelText } from '../public/channel-capabilities.js';

const status = code => error => error.status === code;
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const actor = auth.actor(auth.insertUser({ username: 'schedule-native-qa', name: 'Pessoa sintética QA' }, Buffer.alloc(16, 3), Buffer.alloc(64, 3), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(actor, { name: 'Agenda nativa em RAM', segment: 'QA' });
  let clock = Date.parse('2026-10-03T12:00:00Z'), windowEndsAt = clock + 3600000, nativePolicy = true, policyOverride, readyOverride;
  store.mutate(actor, tenant.id, 'Fixture: conversa Meta', state => {
    state.channels = [{ id: 'meta-qa', kind: 'messenger', transport: 'meta-messenger', state: 'connected', meta: { enabled: true, credentialsConfigured: true, version: 1 } }];
    state.conversations = [{ id: 'conversation-qa', contact: 'Contato sintético', channelId: 'meta-qa', departmentId: 'unassigned', status: 'open', owner: 'human', assignedUserId: actor.userId, version: 1, messages: [] }];
  });
  const policies = [], deliveries = [], readyCalls = [];
  const authorize = (who, tid, conversation, permission) => auth.can(who, permission, { tenantId: tid, channelId: conversation.channelId, departmentId: 'unassigned' });
  const outbox = new Outbox(store, { authorize: (who, tid, conversation) => { if (!authorize(who, tid, conversation, 'inbox.reply')) fail(403, 'Autoridade sintética revogada.'); } });
  const service = createScheduledMessages(store, {
    now: () => clock, authorize, resolveActor: (userId, resellerId) => auth.workspaceActor({ userId, resellerId }, resellerId),
    validateSchedule(who, tid, conversation, input) {
      policies.push({ userId: who.userId, tenantId: tid, conversationId: conversation.id, state: conversation.scheduledMessages?.[0]?.state || null, input: structuredClone(input) });
      if (policyOverride) return policyOverride(who, tid, conversation, input);
      assertChannelText(input.text, channelCapabilities(input.channel));
      if (!nativePolicy || !input.channel.meta?.enabled || !input.channel.meta?.credentialsConfigured || Date.parse(input.dueAt) >= windowEndsAt || clock >= windowEndsAt) return false;
      return true;
    },
    isTransportReady(who, tid, conversation) { readyCalls.push(conversation.id); return readyOverride ? readyOverride(who, tid, conversation) : true; },
    send: (who, tid, cid, input) => outbox.dispatch(who, tid, cid, input, async () => { deliveries.push({ tenantId: tid, conversationId: cid, input }); return store.getConversation(store.tenant(who, tid), cid); })
  });
  const current = () => store.getConversation(store.tenant(actor, tenant.id), 'conversation-qa');
  const payload = (extra = {}) => ({ version: current().version, text: 'Mensagem sintética para Meta', dueAt: new Date(clock + 60000).toISOString(), commandId: 'schedule-native-qa-1', ...extra });
  return { store, auth, actor, tenant, service, current, policies, deliveries, readyCalls, payload,
    create: input => service.create(actor, tenant.id, 'conversation-qa', input), advance: ms => { clock += ms; },
    change: fn => store.mutate(actor, tenant.id, 'Fixture: alteração de política', state => fn(state.conversations[0], state)),
    setPolicy: value => { nativePolicy = value; }, setHook: value => { policyOverride = value; }, setReady: value => { readyOverride = value; }, setWindow: value => { windowEndsAt = value; },
    rows: () => store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n,
    snapshot: () => ({ data: store.db.prepare('SELECT data FROM tenants WHERE id=?').get(tenant.id).data, audits: store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenant.id).n }) };
}

test('política Meta valida Unicode e janela antes de persistir; CAS inválido não chama o hook', t => {
  const f = fixture(t), before = f.snapshot();
  assert.throws(() => f.create(f.payload({ text: '😀'.repeat(1001) })), status(400)); assert.deepEqual(f.snapshot(), before);
  assert.throws(() => f.create(f.payload({ dueAt: '2026-10-03T13:00:00.000Z' })), status(409)); assert.deepEqual(f.snapshot(), before);
  const called = f.policies.length; assert.throws(() => f.create(f.payload({ version: 99 })), status(409)); assert.equal(f.policies.length, called);
  const result = f.create(f.payload({ text: '😀'.repeat(1000) })); assert.equal(result.state, 'pending'); assert.equal(f.current().scheduledMessages[0].text.length, 2000); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []);
  const call = f.policies.at(-1); assert.equal(call.userId, f.actor.userId); assert.equal(call.tenantId, f.tenant.id); assert.equal(call.conversationId, 'conversation-qa'); assert.equal(call.input.channel.transport, 'meta-messenger'); assert.equal(call.input.dueAt, '2026-10-03T12:01:00.000Z');
});

test('replay conhecido conserva o agendamento quando a política/janela fecha e não volta a validá-lo', t => {
  const f = fixture(t), input = f.payload(), first = f.create(input), before = f.snapshot(), calls = f.policies.length;
  f.setPolicy(false); f.setHook(() => { assert.fail('Replay não deve revalidar a política nem criar outro agendamento.'); });
  const replay = f.create(input); assert.equal(replay.id, first.id); assert.deepEqual(f.snapshot(), before); assert.equal(f.policies.length, calls); assert.equal(f.current().scheduledMessages.length, 1);
  assert.throws(() => f.create({ ...input, text: 'Outro payload' }), status(409)); assert.equal(f.policies.length, calls); assert.equal(f.rows(), 0);
});

test('revogação da política ou credencial após agendar bloqueia claim de canal disponível sem outbox', async t => {
  for (const mode of ['policy', 'credentials', 'window']) await t.test(mode, async child => {
    const f = fixture(child); f.create(f.payload());
    if (mode === 'policy') f.setPolicy(false); if (mode === 'credentials') f.change((conversation, state) => { state.channels[0].meta.credentialsConfigured = false; }); if (mode === 'window') f.setWindow(Date.parse('2026-10-03T12:00:30Z'));
    f.advance(60000); const result = await f.service.tick(), record = f.current().scheduledMessages[0];
    assert.equal(record.state, 'blocked'); assert.equal(record.reasonCode, 'channel_policy_changed'); assert.equal(result.blocked, 1); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []); assert.deepEqual(f.readyCalls, ['conversation-qa']);
    await f.service.tick(); assert.equal(f.rows(), 0); assert.equal(f.policies.length, 2);
  });
});

test('excluir canal ou revogar a pessoa após agendar não chama política nova, outbox nem envio', async t => {
  for (const mode of ['channel', 'person']) await t.test(mode, async child => {
    const f = fixture(child); f.create(f.payload());
    if (mode === 'channel') f.change((conversation, state) => { state.channels = []; }); else f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run('2026-10-03T12:00:30Z', f.actor.userId);
    f.advance(60000); const result = await f.service.tick();
    const tenant = JSON.parse(f.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.tenant.id).data), record = tenant.conversations[0].scheduledMessages[0];
    assert.equal(record.state, 'blocked'); assert.equal(record.reasonCode, 'authority_changed'); assert.equal(result.blocked, 1); assert.equal(f.policies.length, 1); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []);
  });
});

test('política é consultada de novo entre claim e envio e uma recusa tardia não produz I/O', async t => {
  const f = fixture(t); f.create(f.payload());
  f.setHook(() => { f.setHook(() => false); return true; }); f.advance(60000);
  const result = await f.service.tick(); assert.equal(result.blocked, 1); assert.equal(f.current().scheduledMessages[0].state, 'blocked'); assert.equal(f.policies.length, 3); assert.deepEqual(f.policies.map(call => call.state), [null, 'pending', 'sending']); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []);
});

test('canal offline conserva intenção pending sem consultar política e bloqueia após reconectar com política revogada', async t => {
  const f = fixture(t); f.create(f.payload()); f.setPolicy(false);
  f.change((conversation, tenant) => { tenant.channels[0].state = 'disconnected'; });
  f.setReady(() => f.store.tenant(f.actor, f.tenant.id).channels[0].state === 'connected'); f.advance(60000);
  const before = f.snapshot(), offline = await f.service.tick();
  assert.equal(offline.processed, 0); assert.equal(offline.blocked, 0); assert.equal(f.current().scheduledMessages[0].state, 'pending'); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.policies.length, 1, 'A criação validou a política; o claim offline não a consulta.'); assert.equal(f.policies[0].state, null);
  assert.deepEqual(f.readyCalls, ['conversation-qa']); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []);
  f.change((conversation, tenant) => { tenant.channels[0].state = 'connected'; }); const connected = await f.service.tick();
  assert.equal(connected.blocked, 1); assert.equal(f.current().scheduledMessages[0].state, 'blocked'); assert.equal(f.current().scheduledMessages[0].reasonCode, 'channel_policy_changed');
  assert.equal(f.policies.length, 2); assert.deepEqual(f.readyCalls, ['conversation-qa', 'conversation-qa']); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []);
});

test('política válida é revalidada e gera apenas um comando/enviador mesmo em ticks repetidos', async t => {
  const f = fixture(t); f.create(f.payload()); f.advance(60000); const result = await f.service.tick();
  assert.equal(result.sent, 1); assert.equal(f.current().scheduledMessages[0].state, 'sent'); assert.equal(f.policies.length, 3); assert.equal(f.rows(), 1); assert.equal(f.deliveries.length, 1); assert.deepEqual(Object.keys(f.deliveries[0].input).sort(), ['channelId', 'idempotencyKey', 'text', 'version']);
  await f.service.tick(); assert.equal(f.rows(), 1); assert.equal(f.deliveries.length, 1);
});

test('hooks async resolvidos/rejeitados falham fechados na criação e no claim sem unhandled rejection', async t => {
  for (const stage of ['create', 'claim']) for (const rejection of [false, true]) await t.test(`${stage}-${rejection}`, async child => {
    const f = fixture(child), unhandled = [], listener = error => unhandled.push(error); process.on('unhandledRejection', listener); child.after(() => process.off('unhandledRejection', listener));
    const hook = () => rejection ? Promise.reject(new Error('Recusa sintética async')) : Promise.resolve(true);
    if (stage === 'create') { const before = f.snapshot(); f.setHook(hook); assert.throws(() => f.create(f.payload()), error => error instanceof TypeError && /síncrona/.test(error.message)); assert.deepEqual(f.snapshot(), before); }
    else { f.create(f.payload()); f.setHook(hook); f.advance(60000); const result = await f.service.tick(); assert.equal(result.blocked, 1); assert.equal(f.current().scheduledMessages[0].reasonCode, 'channel_policy_changed'); }
    await settle(); await settle(); assert.deepEqual(unhandled, []); assert.equal(f.rows(), 0); assert.deepEqual(f.deliveries, []);
  });
});
