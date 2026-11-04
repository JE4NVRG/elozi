import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { EmailChannelGateway, channelEmailAddress } from '../src/channel-email.js';
import { createSendIntent } from '../public/send-intent.js';
import { ContactService } from '../src/contacts.js';

const status = code => error => error.status === code;
const relaySecret = 'synthetic-relay-secret-' + 'x'.repeat(32), apiKey = 'ms_' + 'synthetic'.repeat(5);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const store = new Store(':memory:'); let clock = Date.parse('2026-10-03T12:00:00Z');
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const row = auth.insertUser({ username: 'email-synthetic-admin', name: 'Atendente sintético' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo');
  const admin = auth.actor(row), tenant = store.createTenant(admin, { name: 'E-mail RAM', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture: canal', state => { state.channels = [{ id: 'email-qa', kind: 'email', state: 'planned' }]; });
  const operations = new Operations(store, auth, { now: () => clock }), calls = [], events = [], secrets = encryptedChannelSecrets(store.db, randomBytes(32));
  const gateway = new EmailChannelGateway(store, { operations, now: () => clock, loadSecrets: async () => secrets,
    getDeliveryConfiguration: async () => ({ apiKey, from: 'Elozi QA <mailbox@example.test>' }),
    fetchImpl: async (url, input) => { calls.push({ url, ...input, payload: JSON.parse(input.body) }); return { ok: true, status: 200, json: async () => ({ id: 'synthetic-provider-id' }) }; },
    onIncoming: (...event) => events.push(event), ...options });
  t.after(async () => { await gateway.close(); store.close(); });
  await gateway.configure(admin, tenant.id, 'email-qa', { address: 'mailbox@example.test', ingressSecret: relaySecret, version: 0 });
  const envelope = (values = {}, signed = {}) => {
    const rawBody = Buffer.from(JSON.stringify({ id: 'email-message-0001', from: 'visitor@example.test', to: 'mailbox@example.test', subject: 'Ajuda sintética', text: 'Olá', ...values }));
    const timestamp = String(Math.floor(clock / 1000));
    return { tenantId: tenant.id, channelId: 'email-qa', rawBody, timestamp, signature: createHmac('sha256', relaySecret).update(`${timestamp}.`).update(rawBody).digest('hex'), ...signed };
  };
  const receive = (values, signed) => gateway.receiveWebhook(envelope(values, signed));
  const conversation = () => store.tenant(admin, tenant.id).conversations[0];
  const take = cid => store.mutate(admin, tenant.id, 'Fixture: assumir', state => {
    const current = store.getConversation(state, cid); current.owner = 'human'; current.assignedUserId = admin.userId; current.assignedUserName = admin.name; current.version++; return current;
  });
  return { store, auth, admin, tenant, operations, gateway, calls, events, secrets, envelope, receive, conversation, take,
    outbox: new Outbox(store, { authorize: (actor, id, conversation) => operations.canReply(actor, id, conversation) }),
    time(ms) { clock += ms; }, now: () => clock };
}

test('email configuration stores only encrypted relay secret and explicit non-IMAP capability', async t => {
  const c = await fixture(t), channel = c.store.tenant(c.admin, c.tenant.id).channels[0];
  assert.equal(JSON.stringify(channel).includes(relaySecret), false);
  assert.equal(Buffer.from(c.store.db.prepare('SELECT payload FROM channel_secrets').get().payload).includes(Buffer.from(relaySecret)), false);
  const current = await c.gateway.status(c.admin, c.tenant.id, 'email-qa');
  assert.equal(current.ingressConfigured, true); assert.equal(current.mailboxConnected, false); assert.equal(current.mediaSupported, false); assert.equal(current.state, 'configured');
  for (const email of ['display <mailbox@example.test>', 'a\r\nBcc:evil@example.test', 'a..b@example.test', '.a@example.test']) assert.throws(() => channelEmailAddress(email), status(400));
  await assert.rejects(c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { address: 'mailbox@example.test', ingressSecret: 'short' }), status(400));
  await assert.rejects(c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { address: 'mailbox@example.test', version: 0 }), status(409));
});

test('signed relay validates bytes, timestamp, exact destination and rejects attachment/HTML envelopes', async t => {
  const c = await fixture(t);
  await assert.rejects(c.receive({}, { signature: '0'.repeat(64) }), status(403));
  const altered = c.envelope(); altered.rawBody = Buffer.from(altered.rawBody.toString().replace('Olá', 'Outro')); await assert.rejects(c.gateway.receiveWebhook(altered), status(403));
  await assert.rejects(c.receive({}, { timestamp: String(Math.floor(c.now() / 1000) - 301) }), status(403));
  await assert.rejects(c.receive({ to: 'different@example.test' }), status(403));
  await assert.rejects(c.receive({ html: '<img src="x">' }), status(400));
  await assert.rejects(c.receive({ attachments: [{ url: 'https://private.example/file' }] }), status(400));
  await assert.rejects(c.receive({ subject: 'Assunto\nBcc:outro@example.test' }), status(400));
  await assert.rejects(c.receive({ text: 'x'.repeat(4001) }), status(400));
  await assert.rejects(c.gateway.receiveWebhook({ ...c.envelope(), rawBody: Buffer.alloc(65_537) }), status(413));
  assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 0); assert.equal(c.events.length, 0);
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id).contacts || [], []);
});

test('email ingress is exactly once per channel and replays no audit or automation', async t => {
  const c = await fixture(t), first = await c.receive(), before = JSON.stringify(c.conversation());
  const audits = c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count;
  assert.equal(first.replayed, false); assert.equal(c.conversation().remoteEmail, 'visitor@example.test'); assert.equal(c.conversation().messages[0].transport, 'email');
  assert.deepEqual(await c.receive(), { ...first, replayed: true }); assert.equal(JSON.stringify(c.conversation()), before);
  assert.equal(c.events.length, 1); assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count, audits);
  await assert.rejects(c.receive({ text: 'Replay divergente' }), status(409));
  await c.receive({ id: 'email-message-0002', subject: 'Novo assunto' }); assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 1);
  assert.equal(c.conversation().emailSubject, 'Novo assunto'); assert.equal(c.conversation().messages.length, 2);
  await c.receive({ id: 'email-message-0003', from: 'other@example.test' }); assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 2);
});

test('email incoming links one CRM contact, preserves edited/archive fields and dedupes without contact writes', async t => {
  const c = await fixture(t), first = await c.receive({ from: 'VISITOR@example.test', fromName: 'Visitante do relay' });
  const state = () => c.store.tenant(c.admin, c.tenant.id), original = (state().contacts || []).find(item => item.id === c.conversation().contactId);
  assert.ok(original, 'A entrada deve vincular contato na mesma transação da mensagem.');
  assert.equal(original.name, 'Visitante do relay'); assert.equal(original.email, 'visitor@example.test'); assert.equal(original.phone, '');
  assert.equal(c.conversation().contactSyncStatus, 'linked');
  assert.deepEqual(original.identities, [{ channelId: 'email-qa', kind: 'person', externalId: 'conversation:' + first.conversationId }]);
  const crm = new ContactService(c.store, c.auth), edited = crm.update(c.admin, c.tenant.id, original.id, { version: original.version, name: 'Nome revisado pela equipe', email: 'edited@example.test', phone: '', notes: 'Notas preservadas', tags: ['CRM QA'] });
  crm.archive(c.admin, c.tenant.id, original.id, { version: edited.version });
  const saved = structuredClone(state().contacts.find(item => item.id === original.id));
  await c.receive({ id: 'email-message-next', fromName: 'Nome recebido depois' });
  assert.equal(c.conversation().contactId, original.id); assert.deepEqual(state().contacts.find(item => item.id === original.id), saved);
  const beforeReplay = JSON.stringify(state()), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  assert.equal((await c.receive({ from: 'VISITOR@example.test', fromName: 'Visitante do relay' })).replayed, true);
  assert.equal(JSON.stringify(state()), beforeReplay); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
  assert.equal(state().contacts.length, 1); assert.equal(c.conversation().messages.length, 2); assert.equal(c.calls.length, 0);
});

test('email incoming never merges by sender/name and isolates identities by current channel and tenant', async t => {
  const c = await fixture(t), other = c.store.createTenant(c.admin, { name: 'Outra empresa CRM RAM', segment: 'QA' });
  for (const [tenantId, channelId] of [[c.tenant.id, 'email-same-tenant'], [other.id, 'email-other-tenant']]) {
    c.store.mutate(c.admin, tenantId, 'Fixture: outro canal CRM', state => state.channels.push({ id: channelId, kind: 'email', state: 'planned' }));
    await c.gateway.configure(c.admin, tenantId, channelId, { address: 'mailbox@example.test', ingressSecret: relaySecret, version: 0 });
  }
  await c.receive({ fromName: 'Nome igual' });
  for (const [tenantId, channelId] of [[c.tenant.id, 'email-same-tenant'], [other.id, 'email-other-tenant']]) await c.gateway.receiveWebhook({ ...c.envelope({ fromName: 'Nome igual' }), tenantId, channelId });
  await c.receive({ id: 'email-different-sender', from: 'another@example.test', fromName: 'Nome igual' });
  const same = c.store.tenant(c.admin, c.tenant.id), foreign = c.store.tenant(c.admin, other.id), contacts = [...same.contacts, ...foreign.contacts];
  assert.equal(same.contacts.length, 3); assert.equal(foreign.contacts.length, 1); assert.equal(new Set(contacts.map(item => item.id)).size, 4);
  for (const conversation of same.conversations) assert.ok(same.contacts.find(item => item.id === conversation.contactId && item.identities.some(identity => identity.channelId === conversation.channelId && identity.externalId === 'conversation:' + conversation.id)));
  assert.equal(c.calls.length, 0);
});

test('email contact capacity retains incoming receipt/message and retries linking only on a new event', async t => {
  const c = await fixture(t);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: CRM cheio em RAM', state => { state.contacts = Array.from({ length: 10000 }, (_, n) => ({ id: 'email-capacity-' + n, name: 'Contato sintético ' + n, type: 'person', identities: [], version: 1, email: '', phone: '', notes: '', tags: [] })); });
  const contactsBefore = JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts), first = await c.receive();
  let state = c.store.tenant(c.admin, c.tenant.id), current = c.conversation();
  assert.equal(current.contactId, undefined); assert.equal(current.contactSyncStatus, 'capacity'); assert.equal(current.messages.length, 1);
  assert.equal(JSON.stringify(state.contacts), contactsBefore); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM channel_email_seen').get().n, 1); assert.equal(c.events.length, 1);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: vaga sintética', tenant => tenant.contacts.pop());
  assert.deepEqual(await c.receive(), { ...first, replayed: true }); assert.equal(c.conversation().contactId, undefined);
  await c.receive({ id: 'email-after-capacity' }); state = c.store.tenant(c.admin, c.tenant.id); current = c.conversation();
  assert.equal(current.id, first.conversationId); assert.equal(current.messages.length, 2); assert.equal(current.contactSyncStatus, 'linked');
  assert.equal(state.contacts.length, 10000); assert.ok(state.contacts.find(item => item.id === current.contactId)); assert.equal(c.calls.length, 0);
});

test('email projection rollback cannot leave a CRM contact without its incoming conversation/receipt', async t => {
  const c = await fixture(t), before = JSON.stringify(c.store.tenant(c.admin, c.tenant.id)), audits = c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  c.store.queuePostgres = () => { throw Error('Falha sintética de projeção'); };
  await assert.rejects(c.receive(), /Falha sintética de projeção/); c.store.queuePostgres = undefined;
  assert.equal(JSON.stringify(c.store.tenant(c.admin, c.tenant.id)), before); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM channel_email_seen').get().n, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits); assert.equal(c.events.length, 0); assert.equal(c.calls.length, 0);
});

test('MepMail outbound uses current from/source, scoped idempotency and outbox replay without another fetch', async t => {
  const c = await fixture(t); await c.receive(); const current = c.take(c.conversation().id);
  const input = { channelId: 'email-qa', version: current.version, text: 'Resposta de teste', idempotencyKey: 'email-outbox-0001' };
  const result = await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input));
  assert.equal(c.calls.length, 1); const call = c.calls[0];
  assert.equal(call.url, 'https://api-mepmail.je4ndev.com/emails'); assert.equal(call.method, 'POST'); assert.equal(call.redirect, 'error');
  assert.deepEqual(call.payload, { from: 'Elozi QA <mailbox@example.test>', to: ['visitor@example.test'], subject: 'Re: Ajuda sintética', text: 'Resposta de teste' });
  assert.equal(call.headers.Authorization, `Bearer ${apiKey}`); assert.match(call.headers['Idempotency-Key'], /^[a-f0-9]{64}$/);
  assert.equal(result.messages.at(-1).delivery, 'sent'); assert.equal(result.messages.at(-1).externalId, 'synthetic-provider-id'); assert.equal(result.messages.at(-1).authorUserId, c.admin.userId);
  await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input)); assert.equal(c.calls.length, 1);
  await assert.rejects(c.gateway.send(c.admin, c.tenant.id, current.id, { ...input, version: result.version, attachmentIds: ['fake-id'] }), status(400));
});

test('provider failure or timeout is explicit and uncertain outbox cannot be blindly replayed', async t => {
  for (const mode of ['timeout', 'server-error', 'missing-id', 'rejected']) {
    const c = await fixture(t, { fetchImpl: async () => {
      if (mode === 'timeout') throw new Error('Synthetic network timeout');
      return { ok: mode === 'missing-id', status: mode === 'rejected' ? 422 : 500, json: async () => ({}) };
    } });
    await c.receive(); const current = c.take(c.conversation().id), input = { channelId: 'email-qa', version: current.version, text: 'Falha sintética', idempotencyKey: 'email-failure-' + mode };
    await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input)), status(mode === 'rejected' ? 400 : 502));
    assert.equal(c.conversation().messages.at(-1).delivery, mode === 'rejected' ? 'failed' : 'unconfirmed');
    assert.equal(c.store.db.prepare('SELECT state FROM outbound_commands').get().state, mode === 'rejected' ? 'failed' : 'unknown');
    let replay = 0; await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => { replay++; }), status(409)); assert.equal(replay, 0);
  }
});

test('authority, config epoch and source are rechecked after the async provider configuration loader', async t => {
  for (const change of ['revoke', 'epoch', 'recipient']) {
    const c = await fixture(t); await c.receive(); const current = c.take(c.conversation().id), waiting = deferred(), started = deferred();
    c.gateway.getDeliveryConfiguration = async () => { started.resolve(); await waiting.promise; return { apiKey, from: 'mailbox@example.test' }; };
    const pending = c.gateway.send(c.admin, c.tenant.id, current.id, { channelId: 'email-qa', version: current.version, text: 'Não pode sair' });
    await started.promise;
    if (change === 'revoke') c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId);
    if (change === 'epoch') await c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { enabled: false, version: 1 });
    if (change === 'recipient') c.store.mutate(c.admin, c.tenant.id, 'Fixture: destino mudou', state => { state.conversations[0].remoteEmail = 'other@example.test'; });
    waiting.resolve(); await assert.rejects(pending, status(change === 'revoke' ? 403 : 409));
    assert.equal(c.calls.length, 0); assert.equal(c.conversation().messages.length, 1);
  }
});

test('relay rechecks epoch after async secret lookup and cannot write into a reconfigured channel', async t => {
  const c = await fixture(t), waiting = deferred(), started = deferred(), original = c.secrets.get.bind(c.secrets);
  let blocked = false;
  c.secrets.get = async id => { const result = original(id); if (!blocked) { blocked = true; started.resolve(); await waiting.promise; } return result; };
  const pending = c.receive(); await started.promise;
  await c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { enabled: false, version: 1 });
  waiting.resolve(); await assert.rejects(pending, status(409)); assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 0);
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id).contacts || [], []); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM channel_email_seen').get().n, 0);
});

test('revocation while a secret is saved leaves the old active configuration and its secret intact', async t => {
  const c = await fixture(t), original = c.secrets.set.bind(c.secrets), before = c.store.tenant(c.admin, c.tenant.id).channels[0], waiting = deferred(), started = deferred();
  c.secrets.set = async (id, value) => { started.resolve(); await waiting.promise; original(id, value); };
  const pending = c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { ingressSecret: 'different-synthetic-' + 'y'.repeat(32), version: 1 });
  await started.promise; c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId);
  waiting.resolve(); await assert.rejects(pending, status(403));
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id).channels[0], before);
  const secret = c.secrets.get(`elozi:email-channel:${c.tenant.id}:email-qa:${before.email.epoch}`); assert.equal(secret.ingressSecret, relaySecret);
  await c.receive(); assert.equal(c.conversation().messages.length, 1);
});

test('provider receipt is retained if authority is revoked during fetch; no second send is performed', async t => {
  const waiting = deferred(), started = deferred(), c = await fixture(t, { fetchImpl: async () => { started.resolve(); await waiting.promise; return { ok: true, json: async () => ({ id: 'accepted-before-revoke' }) }; } });
  await c.receive(); const current = c.take(c.conversation().id), input = { channelId: 'email-qa', version: current.version, text: 'Em andamento', idempotencyKey: 'email-revoke-during-0001' };
  const reauthorize = () => { if (c.store.db.prepare('SELECT disabled_at FROM auth_users WHERE id=?').get(c.admin.userId).disabled_at) throw Object.assign(new Error('Sessão revogada.'), { status: 403 }); };
  const pending = c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input, { reauthorize }));
  await started.promise; c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId); waiting.resolve();
  await assert.rejects(pending, error => error.status === 502 && error.code === 'OUTBOUND_UNCONFIRMED'); assert.equal(c.conversation().messages.at(-1).delivery, 'sent'); assert.equal(c.conversation().messages.at(-1).externalId, 'accepted-before-revoke');
  assert.equal(c.store.db.prepare('SELECT state FROM outbound_commands').get().state, 'unknown');
  let replay = 0; await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => { replay++; }), status(403)); assert.equal(replay, 0);
});

test('new signed email reopens the existing sender conversation with a clean responsibility', async t => {
  const c = await fixture(t); await c.receive(); const id = c.conversation().id;
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: fechamento', state => {
    const current = state.conversations[0]; current.status = 'closed'; current.owner = 'human'; current.assignedUserId = c.admin.userId;
    current.participants = [{ userId: c.admin.userId, name: c.admin.name }]; current.assignedSupportGrantId = 'expired-support';
  });
  await c.receive({ id: 'email-message-0002', text: 'Nova mensagem' }); const current = c.conversation();
  assert.equal(current.id, id); assert.equal(current.owner, 'queue'); assert.equal(current.status, 'open'); assert.equal(current.assignedUserId, null);
  assert.deepEqual(current.participants, []); assert.equal(current.assignedSupportGrantId, undefined); assert.equal(current.attendantEvents.some(item => item.type === 'reopened'), true);
});

test('email tenant/channel isolation is retained for the same relay event ID and sender', async t => {
  const c = await fixture(t), other = c.store.createTenant(c.admin, { name: 'Outra empresa RAM', segment: 'QA' });
  c.store.mutate(c.admin, other.id, 'Fixture: outro canal', state => { state.channels = [{ id: 'email-other', kind: 'email' }]; });
  await c.gateway.configure(c.admin, other.id, 'email-other', { address: 'mailbox@example.test', ingressSecret: relaySecret, version: 0 });
  await c.receive(); await c.gateway.receiveWebhook({ ...c.envelope(), tenantId: other.id, channelId: 'email-other' });
  assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 1); assert.equal(c.store.tenant(c.admin, other.id).conversations.length, 1);
  assert.notEqual(c.conversation().id, c.store.tenant(c.admin, other.id).conversations[0].id);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM channel_email_seen').get().count, 2);
});

test('email ingress rate bounds new commands while preserving the confirmed replay', async t => {
  const c = await fixture(t, { maxMessagesPerMinute: 1 }); await c.receive();
  assert.equal((await c.receive()).replayed, true);
  await assert.rejects(c.receive({ id: 'email-message-0002' }), status(429));
  c.time(60_001); await c.receive({ id: 'email-message-0002' }); assert.equal(c.conversation().messages.length, 2);
});

test('confirmed provider receipt survives configuration/scope/source changes during fetch without exposing the conversation', async t => {
  for (const change of ['epoch', 'scope', 'recipient']) {
    const waiting = deferred(), started = deferred(), c = await fixture(t, { fetchImpl: async () => {
      started.resolve(); await waiting.promise; return { ok: true, json: async () => ({ id: 'confirmed-during-change' }) };
    } });
    await c.receive(); const current = c.take(c.conversation().id);
    const pending = c.gateway.send(c.admin, c.tenant.id, current.id, { channelId: 'email-qa', version: current.version, text: 'Envio iniciado' });
    await started.promise;
    if (change === 'epoch') await c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { enabled: false, version: 1 });
    if (change === 'scope') c.store.db.prepare("UPDATE auth_users SET role='operator',tenant_ids=?,permissions=? WHERE id=?").run(JSON.stringify([c.tenant.id]), JSON.stringify(['inbox.read']), c.admin.userId);
    if (change === 'recipient') c.store.mutate(c.admin, c.tenant.id, 'Fixture: destino mudou após envio', state => { state.conversations[0].remoteEmail = 'other@example.test'; });
    waiting.resolve(); await assert.rejects(pending, status(502));
    assert.equal(c.conversation().messages.at(-1).delivery, 'sent'); assert.equal(c.conversation().messages.at(-1).externalId, 'confirmed-during-change');
  }
});

test('post-attempt changes and receipt write failures preserve the polled email intent without another delivery', async t => {
  for (const change of ['revoke', 'epoch', 'recipient', 'settle-confirmed', 'settle-unconfirmed']) {
    await t.test(change, async t => {
      const waiting = deferred(), started = deferred(); let attempts = 0;
      const c = await fixture(t, { fetchImpl: async () => {
        attempts++; started.resolve(); await waiting.promise;
        if (change === 'settle-unconfirmed') throw new Error('Synthetic acknowledgement unavailable');
        return { ok: true, status: 200, json: async () => ({ id: 'accepted-after-change' }) };
      } });
      await c.receive(); const current = c.take(c.conversation().id); let keys = 0;
      const commandInput = () => ({ workspaceId: c.admin.resellerId, tenantId: c.tenant.id, conversationId: current.id,
        channelId: 'email-qa', version: c.conversation().version, text: 'Mesmo rascunho após polling', attachmentIds: [] });
      const generator = { randomUUID: () => `email-change-command-${++keys}` }, original = createSendIntent(null, commandInput(), generator);
      const reauthorize = () => c.auth.resolveActor({ userId: c.admin.userId, resellerId: c.admin.resellerId });
      const execute = intent => {
        const body = { channelId: 'email-qa', text: commandInput().text, attachmentIds: [], version: intent.version, idempotencyKey: intent.idempotencyKey };
        return c.outbox.dispatch(c.admin, c.tenant.id, current.id, body,
          () => c.gateway.send(c.admin, c.tenant.id, current.id, body, { reauthorize }), { reauthorize });
      };
      const pending = execute(original); await started.promise;
      if (change === 'revoke') c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId);
      if (change === 'epoch') await c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { enabled: false, version: 1 });
      if (change === 'recipient') c.store.mutate(c.admin, c.tenant.id, 'Synthetic source changed during delivery', state => { state.conversations[0].remoteEmail = 'other@example.test'; state.conversations[0].version++; });
      if (change.startsWith('settle-')) {
        const mutate = c.store.mutate.bind(c.store); let nextWrite = true;
        c.store.mutate = (...args) => {
          if (nextWrite) { nextWrite = false; throw Object.assign(new Error('Synthetic local write conflict'), { status: 409 }); }
          return mutate(...args);
        };
      }
      waiting.resolve(); await assert.rejects(pending, error => error.status === 502 && error.code === 'OUTBOUND_UNCONFIRMED');
      const message = c.conversation().messages.at(-1);
      assert.equal(message.delivery, change.startsWith('settle-') ? 'pending' : 'sent');
      if (!change.startsWith('settle-')) assert.equal(message.externalId, 'accepted-after-change');
      if (change === 'revoke') c.store.db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(c.admin.userId);
      if (change === 'epoch') await c.gateway.configure(c.admin, c.tenant.id, 'email-qa', { enabled: true, version: 2 });
      if (change === 'recipient') c.store.mutate(c.admin, c.tenant.id, 'Synthetic source restored before manual retry', state => { state.conversations[0].remoteEmail = 'visitor@example.test'; state.conversations[0].version++; });
      const polled = commandInput(); assert.ok(polled.version > original.version);
      const retry = createSendIntent(original, polled, generator);
      assert.equal(retry, original); assert.equal(keys, 1);
      await assert.rejects(execute(retry), error => error.status === 409 && error.code === 'OUTBOUND_UNCONFIRMED');
      assert.equal(attempts, 1); assert.equal(c.conversation().messages.filter(item => item.kind === 'human').length, 1);
      const receipt = c.store.db.prepare('SELECT state,attempts,version FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(c.tenant.id, original.idempotencyKey);
      assert.deepEqual({ ...receipt }, { state: 'unknown', attempts: 1, version: original.version });
    });
  }
});

test('a reply without a subject of its own is titled with the company brand, never the platform', async t => {
  const c = await fixture(t); await c.receive(); const id = c.conversation().id;
  const current = c.store.mutate(c.admin, c.tenant.id, 'Fixture: sem assunto', state => {
    state.brand = { ...state.brand, name: 'Loja Acme' };
    const conversation = c.store.getConversation(state, id); delete conversation.emailSubject;
    conversation.owner = 'human'; conversation.assignedUserId = c.admin.userId; conversation.assignedUserName = c.admin.name; conversation.version++; return conversation;
  });
  const input = { channelId: 'email-qa', version: current.version, text: 'Resposta sem assunto', idempotencyKey: 'email-no-subject-0001' };
  await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input));
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].payload.subject, 'Re: Atendimento Loja Acme');
});
