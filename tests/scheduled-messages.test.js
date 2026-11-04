import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, fail } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { createScheduledMessages } from '../src/scheduled-messages.js';

const status = code => error => error.status === code;
const DAY = 24 * 60 * 60 * 1000;

function fixture(t, { beforeSend = async () => {}, providerSend = null, sendOverride = null } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let clock = Date.parse('2026-10-02T12:00:00Z'), users = 0;
  function user({ role = 'operator', tenantIds = [], permissions = null, scopeRules = null } = {}) {
    const n = ++users, row = auth.insertUser({ username: `scheduled-qa-${n}`, name: `Pessoa sintética ${n}` }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, 'mep-demo');
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions === null ? null : JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  }
  const admin = user({ role: 'reseller' });
  const tenant = store.createTenant(admin, { name: 'Agendamento QA', segment: 'Sintético' });
  const other = store.createTenant(admin, { name: 'Outra empresa QA', segment: 'Sintético' });
  const scopeRules = { [tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } };
  const alice = user({ tenantIds: [tenant.id], scopeRules }), bob = user({ tenantIds: [tenant.id] });
  const reader = user({ tenantIds: [tenant.id], permissions: ['inbox.read'], scopeRules });
  store.mutate(admin, tenant.id, 'Fixture sintética de agendamento', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }, { id: 'tg', kind: 'telegram', transport: 'telegram-bot', state: 'connected' }, { id: 'web', kind: 'webchat' }];
    state.departments = [{ id: 'support', name: 'Suporte' }, { id: 'sales', name: 'Comercial' }];
    state.conversations = [{ id: 'conv', contact: 'Contato sintético', channelId: 'wa', departmentId: 'support', department: 'Suporte', status: 'open', owner: 'human', assignedUserId: alice.userId, version: 1, unread: 3, updatedAt: '2026-10-02T11:00:00.000Z', messages: [{ id: 'incoming', kind: 'customer', text: 'Pergunta pública.', createdAt: '2026-10-02T11:00:00.000Z' }] }];
  });
  const deliveries = [], resolved = [], permissions = [];
  const authorize = (actor, tid, conversation, permission) => {
    permissions.push({ userId: actor.userId, tenantId: tid, conversationId: conversation.id, permission });
    return auth.can(actor, permission, { tenantId: tid, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' });
  };
  const requireReply = (actor, tid, conversation) => {
    if (!authorize(actor, tid, conversation, 'inbox.reply')) fail(403, 'Acesso sintético recusado.');
    if (conversation.owner !== 'human' || conversation.assignedUserId !== actor.userId || !['open', 'pending'].includes(conversation.status)) fail(409, 'Responsável sintético mudou.');
  };
  const resolveActor = (uid, rid) => {
    resolved.push({ userId: uid, resellerId: rid });
    return auth.workspaceActor({ userId: uid, resellerId: rid }, rid);
  };
  const outbox = new Outbox(store, { beforeSend, authorize: requireReply });
  const send = sendOverride || ((actor, tid, cid, input) => outbox.dispatch(actor, tid, cid, input, async () => {
    deliveries.push({ actor, tenantId: tid, conversationId: cid, input });
    if (providerSend) return providerSend(actor, tid, cid, input);
    return store.mutate(actor, tid, 'Envio sintético confirmado', state => {
      const conversation = store.getConversation(state, cid, input.version);
      requireReply(actor, tid, conversation);
      conversation.messages.push({ id: `out-${deliveries.length}`, kind: 'human', text: input.text, authorUserId: actor.userId, delivery: 'sent', createdAt: new Date(clock).toISOString() });
      conversation.version++; conversation.updatedAt = new Date(clock).toISOString();
      return conversation;
    });
  }));
  const options = { authorize, resolveActor, send, now: () => clock };
  const service = createScheduledMessages(store, options);
  const current = () => store.getConversation(store.tenant(admin, tenant.id), 'conv');
  const payload = (extra = {}) => ({ version: current().version, text: 'Mensagem agendada sintética.', dueAt: new Date(clock + 60000).toISOString(), commandId: `schedule-${current().version}`, ...extra });
  return {
    store, auth, admin, tenant, other, alice, bob, reader, user, service, options, outbox, deliveries, resolved, permissions, current, payload,
    schedule: extra => service.create(alice, tenant.id, 'conv', payload(extra)),
    change: change => store.mutate(admin, tenant.id, 'Fixture: alteração concorrente', state => change(state.conversations[0], state)),
    advance: ms => { clock += ms; }, time: () => clock,
    auditCount: () => store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenant.id).n,
    command: key => store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(tenant.id, key)
  };
}

test('criação persiste programação e autoridade sem enviar ou subir a conversa', t => {
  const c = fixture(t), before = c.current(), result = c.schedule({ text: '  CANARIO_PRIVADO_DO_AGENDAMENTO  ' });
  const conversation = c.current(), record = conversation.scheduledMessages[0];
  assert.equal(conversation.version, before.version + 1);
  assert.equal(conversation.updatedAt, before.updatedAt);
  assert.deepEqual(conversation.messages, before.messages);
  assert.equal(conversation.unread, before.unread);
  assert.equal(record.text, 'CANARIO_PRIVADO_DO_AGENDAMENTO');
  assert.equal(record.userId, c.alice.userId);
  assert.equal(record.resellerId, c.alice.resellerId);
  assert.equal(record.tenantId, c.tenant.id);
  assert.equal(record.channelId, 'wa'); assert.equal(record.departmentId, 'support');
  assert.match(record.idempotencyKey, /^[A-Za-z0-9_-]{16,100}$/);
  assert.equal(record.state, 'pending'); assert.equal(result.version, conversation.version);
  assert.equal(result.idempotencyKey, undefined); assert.equal(result.resellerId, undefined);
  assert.equal(c.deliveries.length, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0);
  assert.equal(JSON.stringify(c.store.audit(c.admin, c.tenant.id)).includes(record.text), false);
});

test('validação de texto, horário explícito e janela de um minuto a 365 dias é atômica', t => {
  const c = fixture(t), before = c.current(), audit = c.auditCount();
  for (const extra of [{ text: '' }, { text: ' \n ' }, { text: 'x'.repeat(4001) }, { text: '\u0000privado' }, { dueAt: new Date(c.time() + 59999).toISOString() }, { dueAt: new Date(c.time() + 365 * DAY + 1).toISOString() }, { dueAt: '2026-10-02T15:00:00' }, { dueAt: '2027-02-30T12:00:00Z' }, { dueAt: '2026-10-02T24:00:00Z' }, { dueAt: 'inexistente' }, { version: 0 }, { version: 1.5 }, { commandId: '' }, { commandId: ' key ' }, { commandId: 'x'.repeat(121) }, { attachmentIds: ['file'] }, { userId: c.bob.userId }, { channelId: 'tg' }]) assert.throws(() => c.schedule(extra), status(400));
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audit);
  assert.equal(c.schedule({ text: 'x'.repeat(4000), dueAt: new Date(c.time() + 365 * DAY).toISOString() }).text.length, 4000);
  const another = c.schedule({ dueAt: '2026-10-02T09:01:00-03:00' });
  assert.equal(another.dueAt, '2026-10-02T12:01:00.000Z');
});

test('CAS e replay impedem duplicação inclusive quando o horário original já passou', t => {
  const c = fixture(t), input = c.payload({ commandId: 'stable-key' });
  const created = c.service.create(c.alice, c.tenant.id, 'conv', input), audit = c.auditCount();
  c.advance(120000);
  assert.deepEqual(c.service.create(c.alice, c.tenant.id, 'conv', input), created);
  assert.equal(c.auditCount(), audit);
  assert.equal(c.current().scheduledMessages.length, 1);
  for (const extra of [{ text: 'Outro corpo.' }, { dueAt: new Date(c.time() + 60000).toISOString() }, { version: 2 }]) assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', { ...input, ...extra }), status(409));
  assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', { ...input, commandId: 'new-key', dueAt: new Date(c.time() + 60000).toISOString() }), status(409));
  assert.equal(c.current().scheduledMessages[0].state, 'pending');
});

test('listagem tem escopo de leitura e criação exige titular real inclusive administrador', t => {
  const c = fixture(t), input = c.payload();
  assert.throws(() => c.service.create(c.reader, c.tenant.id, 'conv', input), status(403));
  assert.throws(() => c.service.create(c.bob, c.tenant.id, 'conv', input), status(409));
  assert.throws(() => c.service.create(c.admin, c.tenant.id, 'conv', input), status(409));
  assert.throws(() => c.service.create(c.alice, c.other.id, 'conv', input), status(403));
  assert.throws(() => c.service.list({ ...c.admin, resellerId: 'foreign-workspace' }, c.tenant.id, 'conv'), status(404));
  c.schedule({ text: 'CANARIO_ESCOPADO_EMPRESA_A' });
  assert.equal(c.service.list(c.reader, c.tenant.id, 'conv')[0].text, 'CANARIO_ESCOPADO_EMPRESA_A');
  assert.throws(() => c.service.list(c.alice, c.other.id, 'conv'), status(403));
  c.change(conversation => { conversation.channelId = 'tg'; });
  assert.throws(() => c.service.list(c.reader, c.tenant.id, 'conv'), status(403));
  c.change(conversation => { conversation.channelId = 'wa'; conversation.departmentId = 'sales'; });
  assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', c.payload()), status(403));
  c.change(conversation => { conversation.departmentId = 'support'; conversation.status = 'closed'; });
  assert.throws(() => c.schedule(), status(409));
  c.change(conversation => { conversation.status = 'pending'; conversation.channelId = 'web'; conversation.assignedUserId = c.admin.userId; });
  assert.throws(() => c.service.create(c.admin, c.tenant.id, 'conv', c.payload()), status(400));
});

test('cancelamento é CAS pelo responsável e não altera timeline ou horário da conversa', t => {
  const c = fixture(t), first = c.schedule(), before = c.current();
  assert.throws(() => c.service.cancel(c.bob, c.tenant.id, 'conv', { version: 2, id: first.id }), status(409));
  assert.throws(() => c.service.cancel(c.alice, c.tenant.id, 'conv', { version: 1, id: first.id }), status(409));
  const cancelled = c.service.cancel(c.alice, c.tenant.id, 'conv', { version: 2, id: first.id });
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.version, 3);
  assert.equal(c.current().updatedAt, before.updatedAt); assert.deepEqual(c.current().messages, before.messages);
  assert.throws(() => c.service.cancel(c.alice, c.tenant.id, 'conv', { version: 3, id: first.id }), status(409));
  const another = c.schedule(); c.change(conversation => { conversation.status = 'closed'; });
  assert.equal(c.service.cancel(c.alice, c.tenant.id, 'conv', { version: c.current().version, id: another.id }).state, 'cancelled');
});

test('tick vencido envia via Outbox com claim persistido e não repete ciclos', async t => {
  const c = fixture(t);
  const created = c.schedule();
  assert.deepEqual(await c.service.tick(), { processed: 0, sent: 0, blocked: 0, failed: 0, unknown: 0 });
  c.advance(60000);
  const result = await c.service.tick(), conversation = c.current(), record = conversation.scheduledMessages[0];
  assert.deepEqual(result, { processed: 1, sent: 1, blocked: 0, failed: 0, unknown: 0 });
  assert.equal(c.deliveries.length, 1); assert.equal(record.state, 'sent'); assert.equal(record.attempts, 1);
  assert.equal(c.deliveries[0].input.version, record.claimVersion);
  assert.equal(c.deliveries[0].input.idempotencyKey, record.idempotencyKey);
  assert.equal(c.deliveries[0].actor.userId, c.alice.userId);
  assert.equal(c.deliveries[0].tenantId, c.tenant.id); assert.equal(c.deliveries[0].conversationId, 'conv');
  assert.equal(c.command(record.idempotencyKey).state, 'confirmed');
  assert.equal(conversation.messages.at(-1).text, created.text);
  assert.equal(record.sentAt, new Date(c.time()).toISOString());
  await c.service.tick(); assert.equal(c.deliveries.length, 1);
  assert.equal(JSON.stringify(result).includes(created.text), false);
});

test('ciclos concorrentes compartilham uma execução e processam no máximo cinco vencidos', async t => {
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  const c = fixture(t, { beforeSend: async () => { reached(); await gate; } });
  for (let n = 0; n < 7; n++) c.schedule({ commandId: `batch-${n}` });
  c.advance(60000);
  const first = c.service.tick(); await entered;
  const sending = c.current().scheduledMessages.find(record => record.state === 'sending');
  assert.ok(sending); assert.equal(sending.claimVersion, c.current().version); assert.ok(sending.idempotencyKey);
  const second = c.service.tick(); assert.equal(second, first);
  assert.throws(() => c.service.recover(), status(409));
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two); assert.equal(one.processed, 5); assert.equal(one.sent, 5); assert.equal(c.deliveries.length, 5);
  assert.equal(c.current().scheduledMessages.filter(record => record.state === 'pending').length, 2);
  assert.equal((await c.service.tick()).sent, 2); assert.equal(c.deliveries.length, 7);
});

test('permissão, pessoa desativada, status, canal e departamento vivos bloqueiam envio sem replay', async t => {
  for (const change of [c => c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.alice.userId), c => c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(c.time(), c.alice.userId), c => c.change(conversation => { conversation.assignedUserId = c.bob.userId; }), c => c.change(conversation => { conversation.status = 'closed'; }), c => c.change(conversation => { conversation.channelId = 'tg'; }), c => c.change(conversation => { conversation.departmentId = 'sales'; }), c => c.change((_conversation, tenant) => { tenant.channels[0].transport = 'telegram-bot'; })]) {
    const c = fixture(t); c.schedule(); change(c); c.advance(60000);
    assert.equal((await c.service.tick()).blocked, 1);
    assert.equal(c.current().scheduledMessages[0].state, 'blocked');
    assert.equal(c.current().scheduledMessages[0].reasonCode, 'authority_changed');
    assert.equal(c.deliveries.length, 0);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0);
    await c.service.tick(); assert.equal(c.deliveries.length, 0);
  }
});

test('troca de responsável durante flush da Outbox impede efeito externo e mantém bloqueio', async t => {
  let c, gates = 0;
  c = fixture(t, { beforeSend: async () => { if (++gates === 2) c.change(conversation => { conversation.assignedUserId = c.bob.userId; conversation.version++; }); } });
  c.schedule(); c.advance(60000);
  assert.equal((await c.service.tick()).blocked, 1);
  const record = c.current().scheduledMessages[0];
  assert.equal(record.state, 'blocked'); assert.equal(c.command(record.idempotencyKey).state, 'failed'); assert.equal(c.deliveries.length, 0);
  await c.service.tick(); assert.equal(c.deliveries.length, 0);
});

test('revalidação imediatamente antes do callback protege versão alterada depois do claim', async t => {
  const c = fixture(t), originalResolver = c.options.resolveActor;
  let resolutions = 0, callbacks = 0;
  const service = createScheduledMessages(c.store, { ...c.options, send: async () => { callbacks++; }, resolveActor: (uid, rid) => {
    if (++resolutions === 2) c.change(conversation => { conversation.version++; conversation.assignedUserId = c.bob.userId; });
    return originalResolver(uid, rid);
  } });
  c.schedule(); c.advance(60000);
  assert.equal((await service.tick()).blocked, 1);
  assert.equal(c.deliveries.length, 0);
  assert.equal(callbacks, 0);
});

test('waitIdle não inicia ciclo pendente e aguarda somente envio já iniciado', async t => {
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  const c = fixture(t, { beforeSend: async () => { reached(); await gate; } });
  c.schedule(); c.advance(60000);
  await c.service.waitIdle();
  assert.equal(c.current().scheduledMessages[0].state, 'pending'); assert.equal(c.deliveries.length, 0);
  const active = c.service.tick(); await entered;
  const idle = c.service.waitIdle(); assert.equal(idle, active);
  release(); await idle;
  assert.equal(c.current().scheduledMessages[0].state, 'sent'); assert.equal(c.deliveries.length, 1);
});

test('captura de departamento legado usa nome resolvido e bloqueia mudança com mesmo canal', async t => {
  const c = fixture(t);
  c.change(conversation => { delete conversation.departmentId; conversation.assignedUserId = c.admin.userId; });
  c.service.create(c.admin, c.tenant.id, 'conv', c.payload());
  assert.equal(c.current().scheduledMessages[0].departmentId, 'support');
  c.change(conversation => { conversation.department = 'Comercial'; }); c.advance(60000);
  assert.equal((await c.service.tick()).blocked, 1);
  assert.equal(c.deliveries.length, 0);
});

test('resultado incerto e falha definida são terminais e só a falha definida permite cancelamento', async t => {
  for (const uncertain of [true, false]) {
    const c = fixture(t, { providerSend: async () => { throw uncertain ? Error('CANARIO_ERRO_PRIVADO') : Object.assign(Error('CANARIO_ERRO_PRIVADO'), { status: 400 }); } });
    c.schedule(); c.advance(60000);
    const result = await c.service.tick(), record = c.current().scheduledMessages[0];
    assert.equal(record.state, uncertain ? 'unknown' : 'failed');
    assert.equal(result[record.state], 1); assert.equal(c.deliveries.length, 1);
    assert.equal(JSON.stringify(record).includes('CANARIO_ERRO_PRIVADO'), false);
    await c.service.tick(); assert.equal(c.deliveries.length, 1);
    if (uncertain) assert.throws(() => c.service.cancel(c.alice, c.tenant.id, 'conv', { version: c.current().version, id: record.id }), status(409));
    else assert.equal(c.service.cancel(c.alice, c.tenant.id, 'conv', { version: c.current().version, id: record.id }).state, 'cancelled');
  }
});

test('aceitação confirmada durante troca de responsável registra sent sem tentar desfazer ou reenviar', async t => {
  let c;
  c = fixture(t, { providerSend: async () => { c.change(conversation => { conversation.assignedUserId = c.bob.userId; conversation.version++; }); return c.current(); } });
  c.schedule(); c.advance(60000);
  assert.equal((await c.service.tick()).sent, 1);
  assert.equal(c.current().scheduledMessages[0].state, 'sent');
  assert.equal(c.current().assignedUserId, c.bob.userId);
  await c.service.tick(); assert.equal(c.deliveries.length, 1);
});

test('recover de sending órfão marca unknown e não reenvia mesmo após reinício da factory', async t => {
  const c = fixture(t), created = c.schedule();
  c.change(conversation => { const record = conversation.scheduledMessages[0]; record.state = 'sending'; record.claimVersion = ++conversation.version; record.claimedAt = new Date(c.time()).toISOString(); record.attempts = 1; });
  c.advance(120000);
  const recovered = createScheduledMessages(c.store, c.options);
  assert.deepEqual(recovered.recover(), { recovered: 1 });
  assert.equal(c.current().scheduledMessages[0].state, 'unknown');
  assert.equal(c.current().scheduledMessages[0].reasonCode, 'restart_unconfirmed');
  assert.deepEqual(recovered.recover(), { recovered: 0 });
  assert.equal((await recovered.tick()).processed, 0);
  assert.equal(c.deliveries.length, 0);
  assert.throws(() => recovered.cancel(c.alice, c.tenant.id, 'conv', { version: c.current().version, id: created.id }), status(409));
});

test('falha de banco antes do envio não vira repetição automática quando o banco volta', async t => {
  const c = fixture(t, { beforeSend: async () => { throw Error('Banco sintético indisponível.'); } });
  c.schedule(); c.advance(60000);
  assert.equal((await c.service.tick()).failed, 1);
  const record = c.current().scheduledMessages[0];
  assert.equal(c.command(record.idempotencyKey).state, 'pending'); assert.equal(c.deliveries.length, 0);
  c.outbox.beforeSend = async () => {};
  assert.equal((await c.service.tick()).processed, 0); assert.equal(c.deliveries.length, 0);
});

test('factory falha fechada sem callbacks síncronos e DTO não inclui captura privada', t => {
  const c = fixture(t);
  assert.throws(() => createScheduledMessages(c.store), TypeError);
  const denied = createScheduledMessages(c.store, { ...c.options, authorize: async () => true });
  assert.throws(() => denied.create(c.alice, c.tenant.id, 'conv', c.payload()), TypeError);
  const result = c.schedule();
  for (const privateKey of ['commandId', 'commandVersion', 'idempotencyKey', 'resellerId', 'tenantId', 'conversationId', 'channelId', 'channelKind', 'channelTransport', 'departmentId', 'claimVersion']) assert.equal(Object.hasOwn(result, privateKey), false);
  assert.equal(c.current().scheduledMessages.length, 1);
});

test('transporte indisponível, erro ou callback assíncrono conserva pending sem audit, versão ou outbox', async t => {
  const c = fixture(t); c.schedule(); c.advance(60000);
  const before = c.current(), audit = c.auditCount();
  let queued = 0; c.store.queuePostgres = () => { queued++; };
  for (const isTransportReady of [() => false, () => { throw Error('Status de conexão indisponível.'); }, async () => true]) {
    const service = createScheduledMessages(c.store, { ...c.options, isTransportReady });
    assert.deepEqual(await service.tick(), { processed: 0, sent: 0, blocked: 0, failed: 0, unknown: 0 });
    assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audit);
    assert.equal(queued, 0); assert.equal(c.deliveries.length, 0);
    assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0);
  }
});

test('transporte reconectado envia intenção adiada uma vez com autoridade e origem atuais', async t => {
  const c = fixture(t); c.schedule(); c.advance(60000);
  let ready = false;
  const checks = [], service = createScheduledMessages(c.store, { ...c.options, isTransportReady: (actor, tid, conversation) => {
    checks.push({ userId: actor.userId, tenantId: tid, conversationId: conversation.id, channelId: conversation.channelId });
    return ready;
  } });
  assert.equal((await service.tick()).processed, 0); assert.equal(c.current().scheduledMessages[0].state, 'pending');
  ready = true;
  assert.equal((await service.tick()).sent, 1); assert.equal(c.deliveries.length, 1);
  assert.equal(c.current().scheduledMessages[0].state, 'sent');
  assert.deepEqual(checks[1], { userId: c.alice.userId, tenantId: c.tenant.id, conversationId: 'conv', channelId: 'wa' });
  assert.equal((await service.tick()).processed, 0); assert.equal(c.deliveries.length, 1);
});

test('autoridade revogada bloqueia mesmo offline antes de consultar disponibilidade do transporte', async t => {
  const c = fixture(t); c.schedule(); c.advance(60000);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.alice.userId);
  let checks = 0;
  const service = createScheduledMessages(c.store, { ...c.options, isTransportReady: () => { checks++; return false; } });
  assert.equal((await service.tick()).blocked, 1);
  assert.equal(c.current().scheduledMessages[0].state, 'blocked'); assert.equal(checks, 0);
  assert.equal(c.deliveries.length, 0); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n, 0);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(null, c.alice.userId);
  assert.equal((await service.tick()).processed, 0); assert.equal(checks, 0);
});

test('indisponíveis antes dos cinco primeiros não impedem mensagem de outro canal conectado', async t => {
  const c = fixture(t);
  for (let n = 0; n < 6; n++) c.schedule({ commandId: `offline-${n}`, dueAt: new Date(c.time() + 60000 + n * 1000).toISOString() });
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: outro canal conectado', tenant => {
    tenant.conversations.push({ ...tenant.conversations[0], id: 'online', channelId: 'tg', assignedUserId: c.admin.userId, version: 1, scheduledMessages: [], messages: [] });
  });
  c.service.create(c.admin, c.tenant.id, 'online', { version: 1, text: 'Mensagem de outro canal.', dueAt: new Date(c.time() + 70000).toISOString(), commandId: 'online-one' });
  c.advance(90000);
  const service = createScheduledMessages(c.store, { ...c.options, isTransportReady: (_actor, _tid, conversation) => conversation.channelId === 'tg' });
  assert.equal((await service.tick()).sent, 1);
  assert.equal(c.deliveries.length, 1); assert.equal(c.deliveries[0].conversationId, 'online');
  assert.equal(c.current().scheduledMessages.filter(record => record.state === 'pending').length, 6);
});
