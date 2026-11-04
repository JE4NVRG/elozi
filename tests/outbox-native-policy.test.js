import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import { TelegramGateway } from '../src/telegram.js';
import { MetaGateway } from '../src/channel-meta.js';

const status = expected => error => error.status === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { kind = 'telegram', beforeSend = async () => {} } = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const row = auth.insertUser({ username: 'native-policy-admin', name: 'Administrador sintético' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo');
  const actor = auth.actor(row), tenant = store.createTenant(actor, { name: 'Política nativa RAM', segment: 'QA' }), channelId = `native-${kind}`;
  store.mutate(actor, tenant.id, 'Fixture canal nativo', state => { state.channels = [{ id: channelId, kind, ...(kind === 'telegram' ? { transport: 'telegram-bot' } : {}), state: 'planned' }]; state.conversations = []; state.contacts = []; });
  const operations = new Operations(store, auth), counters = { provider: 0, media: 0, policy: 0, send: 0, authority: 0 }, requests = [];
  let clock = Date.parse('2026-10-03T12:00:00Z'), gateway, entry;
  const media = { placeholder() { throw new Error('Fixture has no incoming attachments'); }, capture() { throw new Error('Fixture has no downloads'); }, resolve: async () => { counters.media++; return []; } };
  if (kind === 'telegram') {
    gateway = new TelegramGateway(store, { authKey: randomBytes(32), polling: false, fetchImpl: async (url, init) => {
      counters.provider++; const payload = JSON.parse(init.body); requests.push({ method: url.split('/').at(-1), payload });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 999, chat: { id: Number(payload.chat_id) } } }) };
    } });
    gateway.operations = operations; gateway.media = media;
    entry = { tenantId: tenant.id, channelId, actor: gateway.actor(actor.resellerId), botId: '123456789', token: '123456789:' + 'a'.repeat(35), state: 'connected', stopped: false, abort: new AbortController() };
    gateway.entries.set(channelId, entry);
    await gateway.receive(entry, { update_id: 1, message: { message_id: 1, date: Math.floor(clock / 1000), chat: { id: -1234, type: 'supergroup', title: 'Grupo sintético' }, from: { id: 99, first_name: 'Visitante' }, text: 'Pergunta sintética' } });
  } else {
    gateway = new MetaGateway(store, { authKey: randomBytes(32), operations, media, now: () => clock, fetchImpl: async (url, init) => {
      counters.provider++; requests.push({ method: 'Meta messages', payload: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ recipient_id: '987654321001', message_id: 'synthetic-confirmed-mid' }) };
    } });
    await gateway.configure(actor, tenant.id, channelId, { version: 0, enabled: true, resourceId: '123456789001', apiVersion: 'v23.0', accessToken: 'synthetic-meta-access', appSecret: 'synthetic-meta-app-secret', verifyToken: 'synthetic-meta-verify' });
    const body = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '123456789001', messaging: [{ sender: { id: '987654321001' }, recipient: { id: '123456789001' }, timestamp: clock, message: { mid: 'synthetic-inbound-mid', text: 'Pergunta sintética' } }] }] }));
    await gateway.receiveWebhook(tenant.id, channelId, body, 'sha256=' + createHmac('sha256', 'synthetic-meta-app-secret').update(body).digest('hex'));
  }
  t.after(async () => { await gateway.close(); store.close(); });
  const cid = store.tenant(actor, tenant.id).conversations[0].id;
  store.mutate(actor, tenant.id, 'Fixture assumir', state => { const c = store.getConversation(state, cid); c.owner = 'human'; c.assignedUserId = actor.userId; c.version++; });
  const current = () => store.getConversation(store.tenant(actor, tenant.id), cid);
  const commands = () => store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=?').all(tenant.id).map(row => ({ ...row }));
  const outbox = new Outbox(store, { beforeSend, authorize: (person, id, c) => { counters.authority++; operations.canReply(person, id, c); } });
  const input = (extra = {}) => ({ version: current().version, channelId, text: 'Resposta sintética', idempotencyKey: randomUUID(), ...extra });
  const reauthorize = () => { auth.currentActor(actor); };
  const policy = body => {
    counters.policy++;
    if (kind === 'telegram') return gateway.assertGroupAllowed(actor, tenant.id, channelId, current().remoteChatId);
    gateway.validateOutgoing(kind, body); gateway.sendContext(actor, tenant.id, cid, body); return true;
  };
  const send = body => { counters.send++; return gateway.send(actor, tenant.id, cid, body, { reauthorize }); };
  const dispatch = (body, options = {}) => outbox.dispatch(actor, tenant.id, cid, body, () => send(body), { reauthorize, validate: () => policy(body), ...options });
  const select = ids => gateway.setGroups(actor, tenant.id, channelId, { version: gateway.groups(actor, tenant.id, channelId).version, mode: 'selected', groupIds: ids });
  const revoke = () => store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), actor.userId);
  return { store, auth, actor, tenant, gateway, entry, channelId, cid, outbox, counters, requests, current, commands, input, dispatch, select, revoke, advance: ms => { clock += ms; } };
}

test('Meta: formato, quote, upload e janela inválidos não deixam comando, leitura de mídia ou provider', async t => {
  const f = await fixture(t, { kind: 'messenger' }), original = structuredClone(f.current());
  const bodies = [f.input({ text: 'a'.repeat(1001) }), f.input({ replyToMessageId: original.messages[0].id }), f.input({ attachmentIds: [randomUUID()] })];
  for (const body of bodies) await assert.rejects(f.dispatch(body), status(400));
  f.advance(24 * 3600_000 + 1); await assert.rejects(f.dispatch(f.input()), status(409));
  assert.equal(f.counters.policy, 4); assert.equal(f.counters.send, 0); assert.equal(f.counters.media, 0); assert.equal(f.counters.provider, 0);
  assert.deepEqual(f.commands(), []); assert.deepEqual(f.current(), original);
});

test('Telegram: grupo fora da seleção recusa intent e anexo antes de outbox/media/provider', async t => {
  const f = await fixture(t), original = structuredClone(f.current()); f.select([]);
  await assert.rejects(f.dispatch(f.input({ attachmentIds: [randomUUID()] })), status(409));
  assert.deepEqual(f.commands(), []); assert.deepEqual(f.current(), original); assert.equal(f.counters.media, 0); assert.equal(f.counters.provider, 0);
  assert.equal(f.counters.send, 0); assert.equal(f.counters.policy, 1);
});

test('política false ou erro específico recusa sem criar registro nem alterar corpo ou histórico', async t => {
  const f = await fixture(t), body = f.input({ attachmentIds: [randomUUID()] }), frozen = structuredClone(body), original = structuredClone(f.current());
  await assert.rejects(f.dispatch(body, { validate: () => false }), status(409));
  const failure = Object.assign(new Error('Synthetic native-policy rejection'), { status: 422 });
  await assert.rejects(f.dispatch(body, { validate: () => { throw failure; } }), error => error === failure);
  assert.deepEqual(body, frozen); assert.deepEqual(f.commands(), []); assert.deepEqual(f.current(), original);
  assert.equal(f.counters.send, 0); assert.equal(f.counters.media, 0); assert.equal(f.counters.provider, 0);
});

test('replay confirmado depois da janela Meta expirar ignora política atual mas revalida autenticação', async t => {
  const f = await fixture(t, { kind: 'messenger' }), body = f.input(); await f.dispatch(body);
  const record = structuredClone(f.commands()[0]), current = structuredClone(f.current()), authorities = f.counters.authority;
  assert.equal(record.state, 'confirmed'); assert.equal(f.counters.provider, 1); f.advance(24 * 3600_000 + 1);
  assert.equal(f.gateway.replyWindow(f.actor, f.tenant.id, f.cid).open, false);
  assert.deepEqual(await f.dispatch(body), current); assert.equal(f.counters.policy, 1); assert.ok(f.counters.authority > authorities);
  assert.deepEqual(f.commands()[0], record); assert.equal(f.counters.provider, 1); assert.equal(f.counters.send, 1);
  f.revoke(); await assert.rejects(f.dispatch(body), status(403));
  assert.deepEqual(f.commands()[0], record); assert.equal(f.counters.policy, 1); assert.equal(f.counters.provider, 1);
  f.store.db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(f.actor.userId); let rechecks = 0;
  await assert.rejects(f.dispatch(body, { reauthorize: () => { if (++rechecks === 2) f.revoke(); } }), status(403));
  assert.equal(rechecks, 2); assert.deepEqual(f.commands()[0], record); assert.equal(f.counters.policy, 1); assert.equal(f.counters.provider, 1);
});

test('pending retomado revalida grupo e conserva ID/payload/attempts até uma única confirmação', async t => {
  const f = await fixture(t, { beforeSend: async () => { throw new Error('Synthetic persistence gate offline'); } });
  f.select(['-1234']); const body = f.input(); await assert.rejects(f.dispatch(body), status(503));
  const pending = structuredClone(f.commands()[0]); assert.equal(pending.state, 'pending'); assert.equal(pending.attempts, 0); assert.equal(f.counters.provider, 0);
  f.outbox.beforeSend = async () => {}; f.select([]); await assert.rejects(f.dispatch(body), status(409));
  assert.deepEqual(f.commands()[0], pending); assert.equal(f.counters.send, 0);
  f.select(['-1234']); await f.dispatch(body);
  const confirmed = f.commands()[0]; assert.equal(f.commands().length, 1); assert.equal(confirmed.id, pending.id); assert.equal(confirmed.payload, pending.payload);
  assert.equal(confirmed.state, 'confirmed'); assert.equal(confirmed.attempts, 1); assert.equal(f.counters.provider, 1); assert.equal(f.counters.policy, 3);
  await f.dispatch(body); assert.equal(f.counters.provider, 1); assert.equal(f.counters.policy, 3);
});

test('políticas async resolved/rejected falham500 e não produzem unhandled, registro ou envio', async t => {
  const f = await fixture(t), body = f.input({ attachmentIds: [randomUUID()] }), original = structuredClone(body), unhandled = [];
  const collect = error => unhandled.push(error); process.on('unhandledRejection', collect); t.after(() => process.off('unhandledRejection', collect));
  for (const validate of [async () => true, () => Promise.reject(new Error('Synthetic async denial'))]) await assert.rejects(f.dispatch(body, { validate }), status(500));
  await nextTurn(); assert.deepEqual(unhandled, []); assert.deepEqual(f.commands(), []); assert.deepEqual(body, original);
  assert.equal(f.counters.provider, 0); assert.equal(f.counters.send, 0); assert.equal(f.counters.media, 0);
});

test('seleção revogada após gate assíncrono é revalidada pelo adapter sem mensagem/mídia/provider', async t => {
  const entered = deferred(), resume = deferred(); let gates = 0;
  const f = await fixture(t, { beforeSend: async () => { if (++gates === 2) { entered.resolve(); await resume.promise; } } });
  f.select(['-1234']); const body = f.input({ attachmentIds: [randomUUID()] }), original = structuredClone(f.current());
  const sending = f.dispatch(body); await entered.promise; f.select([]); resume.resolve(); await assert.rejects(sending, status(409));
  assert.equal(f.commands()[0].state, 'failed'); assert.equal(f.commands()[0].attempts, 1); assert.equal(f.counters.send, 1);
  assert.equal(f.counters.policy, 1); assert.equal(f.counters.provider, 0); assert.equal(f.counters.media, 0); assert.deepEqual(f.current(), original);
});

test('CAS e revogação de autoridade após gates continuam protegendo o transporte apesar de política aprovada', async t => {
  for (const change of ['cas', 'revoke']) {
    const entered = deferred(), resume = deferred(); let gates = 0;
    const f = await fixture(t, { beforeSend: async () => { if (++gates === 2) { entered.resolve(); await resume.promise; } } });
    f.select(['-1234']); const body = f.input(), original = structuredClone(f.current());
    const sending = f.dispatch(body); await entered.promise;
    if (change === 'revoke') f.revoke();
    else await f.gateway.receive(f.entry, { update_id: 2, message: { message_id: 2, date: 1750000000, chat: { id: -1234, type: 'supergroup', title: 'Grupo sintético' }, from: { id: 99, first_name: 'Visitante' }, text: 'Nova entrada muda versão' } });
    resume.resolve(); await assert.rejects(sending, status(change === 'revoke' ? 403 : 409));
    assert.equal(f.commands()[0].state, 'failed'); assert.equal(f.counters.send, 0); assert.equal(f.counters.provider, 0); assert.equal(f.counters.media, 0); assert.equal(f.counters.policy, 1);
    const stored = f.store.tenant({ role: 'reseller', resellerId: 'mep-demo' }, f.tenant.id).conversations.find(c => c.id === f.cid);
    assert.deepEqual(stored.messages.slice(0, original.messages.length), original.messages); assert.equal(stored.messages.filter(m => m.kind === 'human').length, 0);
  }
});

test('versão/canal incorretos são recusados antes da política e sem armazenar payload', async t => {
  const f = await fixture(t);
  await assert.rejects(f.dispatch(f.input({ version: f.current().version - 1 })), status(409));
  await assert.rejects(f.dispatch(f.input({ channelId: 'wrong-native-channel' })), status(400));
  assert.equal(f.counters.policy, 0); assert.equal(f.counters.provider, 0); assert.deepEqual(f.commands(), []);
});
