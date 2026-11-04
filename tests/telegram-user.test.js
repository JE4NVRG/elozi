import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { MediaService } from '../src/media.js';
import { TelegramGateway } from '../src/telegram.js';
import { TelegramUserGateway, createTelegramUserClient } from '../src/telegram-user.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'QA' };
const hash = 'a'.repeat(32), savedSession = 'synthetic-private-session-never-network';
const message = (id = '1', chatId = '81', extra = {}) => ({ id, chatId, date: 1750000000 + Number(id), text: 'Mensagem própria sintética', outgoing: false, ...extra });
const dialog = (id, type = id.startsWith('-') ? 'group' : 'private') => ({ id, name: type === 'group' ? 'Grupo QA' : 'Pessoa QA', type, canSend: true, privatePeer: { type, peerType: type === 'group' ? 'channel' : 'user', rawId: id.replace(/^-100/, ''), accessHash: '123456789987654321' } });
function setup(t, options = {}) {
  const store = new Store(':memory:'), key = randomBytes(32), tenant = store.createTenant(admin, { name: 'Pessoal QA', segment: 'QA' });
  const botGateway = new TelegramGateway(store, { authKey: key, polling: false, fetchImpl: () => { throw new Error('Network forbidden'); } });
  store.mutate(admin, tenant.id, 'Fixture', state => state.channels.push({ id: 'personal', kind: 'telegram_user', transport: 'telegram-user', name: 'Pessoal QA', state: 'disconnected' }));
  const calls = [], clients = [], pending = {};
  const factory = async params => {
    calls.push('factory'); const client = {
      async connect() { calls.push('connect'); }, async authorized() { return options.authorized !== false; },
      async getMe() { return { id: options.accountId || '123456789123456789', name: 'Conta QA', username: 'qa', bot: false }; }, exportSession: () => savedSession,
      async sendCode() { calls.push('sendCode'); return { phoneCodeHash: 'private-code-hash' }; },
      async signInCode() { calls.push('signInCode'); if (options.twoFA) { const error = new Error('PRIVATE-MUST-NOT-LEAK'); error.errorMessage = 'SESSION_PASSWORD_NEEDED'; throw error; } return client.getMe(); },
      async signInPassword() { calls.push('signInPassword'); return client.getMe(); },
      async loginQr({ qrCode, password, signal }) {
        await qrCode({ token: Buffer.from('synthetic-login-qr'), expires: Math.floor(Date.now() / 1000) + 30 });
        await new Promise((resolve, reject) => { pending.scan = resolve; signal.addEventListener('abort', () => reject(new Error('PRIVATE-CANCEL')), { once: true }); });
        if (options.qrPassword) { await password(); calls.push('qrPasswordSubmitted'); } return client.getMe();
      },
      async dialogs() { calls.push('dialogs'); return options.dialogs ? options.dialogs() : [dialog('81'), dialog('-100456'), dialog('82')]; },
      async history(peer, limit) { calls.push({ method: 'history', peer, limit }); return options.history ? options.history(peer, limit) : [message('3'), message('2'), message('1')]; },
      async send(peer, payload) { calls.push({ method: 'send', peer, payload }); if (options.send) return options.send(params, peer, payload); return { id: '99' }; },
      async download() { calls.push('download'); return options.download ? options.download() : Buffer.from('synthetic-file'); },
      async avatar() { return Buffer.from([255, 216, 255, 217]); }, async disconnect() { calls.push('disconnect'); }, params
    }; clients.push(client); return client;
  };
  const gateway = new TelegramUserGateway(store, { authKey: key, clientFactory: factory, timeoutMs: options.timeoutMs || 500, loginTimeoutMs: options.loginTimeoutMs || 1000 });
  gateway.operations = new Operations(store, new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) })); gateway.media = new MediaService(store, { directory: ':memory:', authKey: key });
  const incoming = []; gateway.onIncoming = (entry, conversationId, messageId, flags) => incoming.push({ conversationId, messageId, flags });
  t.after(async () => { await gateway.close(); await botGateway.close(); store.close(); });
  return { store, gateway, tenant, key, calls, clients, pending, incoming };
}
const channel = c => c.store.tenant(admin, c.tenant.id).channels.find(item => item.id === 'personal');
const conversations = c => c.store.tenant(admin, c.tenant.id).conversations;
async function configure(c, actor = admin) { return c.gateway.configure(actor, c.tenant.id, 'personal', { version: 0, apiId: 1234, apiHash: hash }); }
async function connect(c) { await configure(c); const result = await c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 1, method: 'qr' }); assert.equal(result.authState, 'authenticated'); return c.gateway.entries.get('personal'); }
async function select(c, ids = ['81']) { const dialogs = await c.gateway.dialogs(admin, c.tenant.id, 'personal'); return c.gateway.setDialogs(admin, c.tenant.id, 'personal', { version: dialogs.version, peerIds: ids }); }
function takeOver(c, id) { c.store.mutate(admin, c.tenant.id, 'Fixture', state => { const item = state.conversations.find(item => item.id === id); item.owner = 'human'; item.version++; }); return conversations(c).find(item => item.id === id); }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Telegram personal native client instantiates the installed library without connecting or disk sessions', async () => {
  const client = await createTelegramUserClient({ apiId: 1234, apiHash: hash, session: '', onUpdate: () => {}, signal: new AbortController().signal });
  assert.equal(typeof client.loginQr, 'function'); assert.equal(typeof client.send, 'function'); assert.equal(client.exportSession(), ''); await client.disconnect();
});

test('Personal adapter requires existing Telegram tables and never provisions schema', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const before = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.throws(() => new TelegramUserGateway(store, { authKey: randomBytes(32) }), error => error.status === 503);
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), before);
});

test('Personal Telegram credentials/session/access hashes remain encrypted outside tenant JSON and DTOs', async t => {
  const c = setup(t); await connect(c); await select(c);
  const json = JSON.stringify(c.store.tenant(admin, c.tenant.id));
  for (const secret of [hash, savedSession, dialog('81').privatePeer.accessHash]) assert.equal(json.includes(secret), false);
  for (const row of c.store.db.prepare('SELECT payload FROM channel_secrets').all()) for (const secret of [hash, savedSession]) assert.equal(Buffer.from(row.payload).includes(Buffer.from(secret)), false);
  const status = c.gateway.status(admin, c.tenant.id, 'personal'); assert.equal(status.account.id, '123456789123456789'); assert.equal(status.selectedCount, 1);
  assert.equal(JSON.stringify(status).includes(savedSession), false); assert.equal(c.calls.includes('sendCode'), false);
  assert.equal(c.store.db.prepare('SELECT bot_id FROM telegram_bindings').get().bot_id, 'user:123456789123456789');
});

test('Personal account refuses bot channel, service administration and stale configuration', async t => {
  const c = setup(t); await assert.rejects(c.gateway.configure({ ...admin, kind: 'service' }, c.tenant.id, 'personal', { version: 0, apiId: 1234, apiHash: hash }), error => error.status === 403);
  await configure(c); await assert.rejects(c.gateway.configure(admin, c.tenant.id, 'personal', { version: 0, apiId: 1234, apiHash: hash }), error => error.status === 409);
  c.store.mutate(admin, c.tenant.id, 'Fixture', state => state.channels.push({ id: 'bot', kind: 'telegram', transport: 'telegram-bot' }));
  assert.throws(() => c.gateway.status(admin, c.tenant.id, 'bot'), error => error.status === 400);
});

test('Phone login waits for a private code and 2FA without leaking provider error/code hash/phone', async t => {
  const c = setup(t, { authorized: false, twoFA: true }); await configure(c);
  const started = await c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 1, method: 'phone', phoneNumber: '+5511999999999' }); assert.equal(started.authState, 'code');
  const password = await c.gateway.submitLogin(admin, c.tenant.id, 'personal', { version: 1, attemptId: started.attemptId, code: '12345' }); assert.equal(password.authState, 'password');
  const done = await c.gateway.submitLogin(admin, c.tenant.id, 'personal', { version: 1, attemptId: started.attemptId, password: 'synthetic-2fa' }); assert.equal(done.authState, 'authenticated');
  const visible = JSON.stringify([started, password, done, c.store.tenant(admin, c.tenant.id)]); for (const secret of ['synthetic-2fa', 'private-code-hash', '+5511999999999', 'PRIVATE-MUST-NOT-LEAK']) assert.equal(visible.includes(secret), false);
});

test('QR is a private PNG, cannot be continued by another actor, and cancellation ends the challenge', async t => {
  const c = setup(t, { authorized: false, qrPassword: true }); await configure(c);
  const started = await c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 1, method: 'qr' }); assert.equal(started.authState, 'qr'); assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
  const other = { ...admin, userId: 'another-fixture-actor' };
  const outsider = c.gateway.status(other, c.tenant.id, 'personal'); assert.equal(outsider.qrDataUrl, undefined); assert.equal(outsider.attemptId, undefined);
  await assert.rejects(c.gateway.submitLogin(other, c.tenant.id, 'personal', { version: 1, attemptId: started.attemptId, code: '12345' }), error => error.status === 403);
  c.pending.scan(); await tick(); assert.equal(c.gateway.status(admin, c.tenant.id, 'personal').authState, 'password');
  await c.gateway.cancelLogin(admin, c.tenant.id, 'personal', { version: 1, attemptId: started.attemptId }); await tick(); assert.equal(c.gateway.entries.size, 0); assert.equal(c.calls.includes('qrPasswordSubmitted'), false);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM telegram_bindings').get().n, 0);
});

test('QR 2FA completes only after private submit and no pending resolver survives completion', async t => {
  const c = setup(t, { authorized: false, qrPassword: true }); await configure(c); const started = await c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 1, method: 'qr' });
  c.pending.scan(); await tick(); const status = await c.gateway.submitLogin(admin, c.tenant.id, 'personal', { version: 1, attemptId: started.attemptId, password: 'synthetic-qr-2fa' });
  assert.equal(status.authState, 'authenticated'); assert.equal(status.qrDataUrl, undefined); assert.equal(c.gateway.entries.get('personal').passwordChallenge, null);
});

test('One real personal account cannot be bound to another tenant/channel; bot numeric namespace is preserved', async t => {
  const c = setup(t); c.store.db.prepare('INSERT INTO telegram_bindings VALUES (?,?,?)').run('123456789123456789', 'existing-bot', c.tenant.id); await connect(c);
  const other = c.store.createTenant(admin, { name: 'Outra', segment: 'QA' }); c.store.mutate(admin, other.id, 'Fixture', state => state.channels.push({ id: 'other', kind: 'telegram_user', transport: 'telegram-user', state: 'disconnected' }));
  await c.gateway.configure(admin, other.id, 'other', { version: 0, apiId: 1234, apiHash: hash });
  await assert.rejects(c.gateway.startLogin(admin, other.id, 'other', { version: 1, method: 'qr' }), error => error.status === 409);
  assert.equal(c.gateway.status(admin, other.id, 'other').state, 'failed');
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM telegram_bindings').get().n, 2); assert.equal(c.gateway.connectedCount(), 1);
});

test('Unselected updates do not create contacts/conversations/media/dedupe or invoke automation', async t => {
  const c = setup(t), entry = await connect(c), before = JSON.stringify(c.store.tenant(admin, c.tenant.id));
  await c.gateway.receive(entry, message()); assert.equal(JSON.stringify(c.store.tenant(admin, c.tenant.id)), before); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM telegram_seen').get().n, 0); assert.equal(c.incoming.length, 0);
  await select(c); await c.gateway.receive(entry, message('2', '82')); assert.equal(conversations(c).length, 0);
});

test('Selected messages are serialized/deduped, distinguish groups/topics and keep provider IDs as strings', async t => {
  const c = setup(t), entry = await connect(c); await select(c, ['81', '-100456']);
  await Promise.all([c.gateway.receive(entry, message('1')), c.gateway.receive(entry, message('1', '81', { text: 'Replay' })), c.gateway.receive(entry, message('2', '-100456', { threadId: 7, senderName: 'Ana', senderId: '99999999999999999' })), c.gateway.receive(entry, message('3', '-100456', { threadId: 8 }))]);
  assert.equal(conversations(c).length, 3); assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM telegram_seen').get().n, 3); assert.equal(c.incoming.length, 3);
  const group = conversations(c).find(item => item.threadId === 7); assert.equal(group.conversationKind, 'group'); assert.equal(group.messages[0].senderId, '99999999999999999');
  assert.equal(c.incoming[0].flags.autoReplyEligible, false);
});

test('Deselection immediately revokes send/receive/avatar/history without deleting old messages', async t => {
  const c = setup(t), entry = await connect(c); await select(c); await c.gateway.receive(entry, message()); const conversation = takeOver(c, conversations(c)[0].id); const before = JSON.stringify(conversation.messages);
  await select(c, []); await c.gateway.receive(entry, message('2')); assert.equal(JSON.stringify(conversations(c)[0].messages), before);
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: 'Não autorizado' }), error => error.status === 403);
  assert.equal(await c.gateway.avatar(admin, c.tenant.id, 'personal', { peer: '81' }), null); assert.equal(c.calls.some(item => item?.method === 'send'), false);
});

test('Metadata refresh preserves selected peers missing from the limited discovery page', async t => {
  let page = [dialog('81')]; const c = setup(t, { dialogs: async () => page }); await connect(c); await select(c); page = [dialog('82')];
  const result = await c.gateway.dialogs(admin, c.tenant.id, 'personal'); assert.deepEqual(result.selectedPeerIds, ['81']); assert.equal(result.dialogs.find(item => item.id === '81').selected, true); assert.equal(JSON.stringify(result).includes(dialog('81').privatePeer.accessHash), false);
});

test('History imports only selected chats, is bounded/idempotent, preserves unread and never invokes automation', async t => {
  const c = setup(t, { history: async () => [message('3'), message('2'), message('1'), message('4', '82')] }), entry = await connect(c); await select(c); await c.gateway.receive(entry, message('3'));
  const incoming = c.incoming.length, beforeUnread = conversations(c)[0].unread;
  const result = await c.gateway.importHistory(admin, c.tenant.id, 'personal', { version: 2, limitPerConversation: 10 }); assert.equal(result.imported, 2); assert.equal(result.duplicates, 1); assert.equal(result.attachmentsAnalyzed, false); assert.equal(conversations(c)[0].unread, beforeUnread); assert.equal(c.incoming.length, incoming);
  assert.deepEqual(conversations(c)[0].messages.map(item => item.externalId), ['81:1', '81:2', '81:3']);
  const replay = await c.gateway.importHistory(admin, c.tenant.id, 'personal', { version: 2, limitPerConversation: 10 }); assert.equal(replay.imported, 0); assert.equal(conversations(c).length, 1);
  await assert.rejects(c.gateway.importHistory(admin, c.tenant.id, 'personal', { version: 2, limitPerConversation: 101 }), error => error.status === 400);
});

test('One outgoing intent is confirmed once and the account echo is not duplicated', async t => {
  const c = setup(t, { send: async (params) => { void params.onUpdate(message('99', '81', { outgoing: true, text: 'Resposta' })); return { id: '99' }; } }), entry = await connect(c); await select(c); await c.gateway.receive(entry, message()); const conversation = takeOver(c, conversations(c)[0].id);
  await c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: 'Resposta' }); await entry.queue;
  assert.equal(conversations(c)[0].messages.length, 2); assert.equal(conversations(c)[0].messages.at(-1).delivery, 'sent'); assert.equal(c.calls.filter(item => item?.method === 'send').length, 1);
});

test('A provider error never leaks details or automatically retries an uncertain outgoing intent', async t => {
  const c = setup(t, { send: async () => { throw new Error('PRIVATE-SESSION-CONTENT'); } }), entry = await connect(c); await select(c); await c.gateway.receive(entry, message()); const conversation = takeOver(c, conversations(c)[0].id);
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: 'Resposta' }), error => error.status === 502 && !error.message.includes('PRIVATE'));
  assert.equal(conversations(c)[0].messages.at(-1).delivery, 'unconfirmed'); assert.equal(c.calls.filter(item => item?.method === 'send').length, 1);
});

test('Authority changed while resolving a private upload prevents any provider send', async t => {
  const c = setup(t), entry = await connect(c); await select(c); await c.gateway.receive(entry, message()); const conversation = takeOver(c, conversations(c)[0].id), id = randomUUID();
  c.gateway.media = { record: () => ({ metadata: { status: 'ready' } }), async resolve() { c.store.mutate(admin, c.tenant.id, 'Fixture', state => { const current = state.conversations[0]; current.owner = 'queue'; current.version++; }); return [{ metadata: { name: 'x.txt', kind: 'document' }, bytes: Buffer.from('x') }]; } };
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: '', attachmentIds: [id] }), error => error.status === 409);
  assert.equal(c.calls.some(item => item?.method === 'send'), false); assert.equal(conversations(c)[0].messages.length, 1);
});

test('Auth context revoked during metadata discovery cannot return the old dialogs', async t => {
  let resolve; const c = setup(t, { dialogs: () => new Promise(done => { resolve = done; }) }); await connect(c); let alive = true;
  const task = c.gateway.dialogs(admin, c.tenant.id, 'personal', { reauthorize: () => { if (!alive) { const error = new Error('Revoked'); error.status = 403; throw error; } } }); await tick(); alive = false; resolve([dialog('81')]);
  await assert.rejects(task, error => error.status === 403); assert.equal(channel(c).telegramUser.selectedPeerIds.length, 0);
});

for (const [change, replacement] of [
  ['user', { ...admin, userId: 'another-user' }], ['workspace', { ...admin, resellerId: 'another-workspace' }],
  ['role', { ...admin, role: 'tenant' }], ['explicit denial', false], ['support grant', { ...admin, supportGrantId: 'another-grant' }],
  ['actor kind', { ...admin, kind: 'service' }], ['service identity', { ...admin, serviceId: 'another-service' }]
]) test(`Reauthorization returning a changed ${change} during discovery rejects metadata`, async t => {
  let resolve, current = { ...admin }; const c = setup(t, { dialogs: () => new Promise(done => { resolve = done; }) }); await connect(c);
  const task = c.gateway.dialogs(admin, c.tenant.id, 'personal', { reauthorize: () => current });
  await tick(); current = replacement; resolve([dialog('81')]);
  await assert.rejects(task, error => error.status === 403);
  assert.deepEqual(channel(c).telegramUser.dialogs, []); assert.equal(c.gateway.entries.get('personal').peers.size, 0);
});

test('Reauthorization returning denial after upload resolution prevents provider send', async t => {
  const c = setup(t), entry = await connect(c); await select(c); await c.gateway.receive(entry, message());
  const conversation = takeOver(c, conversations(c)[0].id), id = randomUUID(); let current = { ...admin };
  c.gateway.media = { record: () => ({ metadata: { status: 'ready' } }), async resolve() { current = false; return [{ metadata: { name: 'x.txt', kind: 'document' }, bytes: Buffer.from('x') }]; } };
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: '', attachmentIds: [id] }, { reauthorize: () => current }), error => error.status === 403);
  assert.equal(c.calls.some(item => item?.method === 'send'), false); assert.equal(conversations(c)[0].messages.length, 1);
});

test('Login rejects authority denial after connect and stops the unfinished account', async t => {
  const c = setup(t); await configure(c); let current = { ...admin };
  const create = c.gateway.clientFactory;
  c.gateway.clientFactory = async options => { const client = await create(options); client.connect = async () => { current = false; }; return client; };
  await assert.rejects(c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 1, method: 'qr' }, { reauthorize: () => current }), error => error.status === 403);
  assert.equal(c.gateway.entries.get('personal').stopped, true); assert.equal(c.gateway.connectedCount(), 0);
  assert.equal(channel(c).telegramUser.accountId, undefined);
});

for (const [providerCode, publicCode] of [
  ['PHONE_CODE_INVALID', 'PHONE_CODE_INVALID'], ['PHONE_CODE_EXPIRED', 'PHONE_CODE_EXPIRED'],
  ['PASSWORD_HASH_INVALID', 'PASSWORD_HASH_INVALID'], ['LOGIN_EMAIL_REQUIRED', 'EMAIL_AUTH_UNSUPPORTED'],
  ['FLOOD_WAIT_97', 'AUTH_RATE_LIMITED'], ['PRIVATE_PROVIDER_VALUE', 'AUTH_FAILED']
]) test(`Authentication exposes only the finite error code ${publicCode}`, async t => {
  const c = setup(t, { authorized: false }); await configure(c);
  const started = await c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 1, method: 'phone', phoneNumber: '+5511999999999' });
  c.clients[0].signInCode = async () => { const error = new Error('PRIVATE-SECRET'); error.errorMessage = providerCode; throw error; };
  const result = await c.gateway.submitLogin(admin, c.tenant.id, 'personal', { version: 1, attemptId: started.attemptId, code: '12345' });
  assert.equal(result.errorCode, publicCode); assert.equal(result.authState, 'code');
  assert.equal(JSON.stringify(result).includes('PRIVATE-SECRET'), false); assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_VALUE'), false);
  assert.equal(c.gateway.status({ ...admin, userId: 'another-owner' }, c.tenant.id, 'personal').errorCode, undefined);
});

test('A colliding channel ID in another company cannot read or disconnect a live entry', async t => {
  const c = setup(t); await connect(c); const other = c.store.createTenant(admin, { name: 'Outra QA', segment: 'QA' });
  c.store.mutate(admin, other.id, 'Fixture', state => state.channels.push({ ...channel(c) }));
  assert.throws(() => c.gateway.status(admin, other.id, 'personal'), error => error.status === 409);
  await assert.rejects(c.gateway.dialogs(admin, other.id, 'personal'), error => error.status === 409);
  await assert.rejects(c.gateway.disconnect(admin, other.id, 'personal', { version: 1 }), error => error.status === 409);
  assert.equal(c.gateway.connectedCount(), 1); assert.equal(c.calls.includes('disconnect'), false);
});

test('Native 2FA callback preserves a provider error once without a library retry', async () => {
  const error = Object.assign(new Error('PRIVATE-PASSWORD-ERROR'), { errorMessage: 'PASSWORD_HASH_INVALID' }); let attempts = 0;
  const nativeClient = { setLogLevel() {}, setParseMode() {}, addEventHandler() {}, removeEventHandler() {}, disconnect: async () => {},
    async signInWithPassword(_credentials, callbacks) { attempts++; assert.equal(await callbacks.password(), 'synthetic-2fa'); return callbacks.onError(error); }
  };
  const client = await createTelegramUserClient({ apiId: 1234, apiHash: hash, onUpdate: () => {}, signal: new AbortController().signal, nativeClient });
  await assert.rejects(client.signInPassword('synthetic-2fa'), actual => actual === error); assert.equal(attempts, 1); await client.disconnect();
});

test('Operational deadlines disconnect a hanging provider and reject further work', async t => {
  const c = setup(t, { timeoutMs: 60, dialogs: () => new Promise(() => {}) }); await connect(c);
  await assert.rejects(c.gateway.dialogs(admin, c.tenant.id, 'personal')); assert.equal(c.gateway.connectedCount(), 0); assert.equal(c.calls.includes('disconnect'), true);
  assert.equal(c.gateway.entries.get('personal').stopped, true);
});

test('Saved encrypted session restores its own identity and selection without initiating login/code', async t => {
  const c = setup(t); await connect(c); await select(c); await c.gateway.close();
  const restored = new TelegramUserGateway(c.store, { authKey: c.key, clientFactory: async params => { assert.equal(params.session, savedSession); return { connect: async () => {}, authorized: async () => true, getMe: async () => ({ id: '123456789123456789', name: 'Conta QA' }), exportSession: () => savedSession, disconnect: async () => {} }; } });
  try { await restored.restore(); assert.equal(restored.connectedCount(), 1); assert.equal(restored.entries.get('personal').peers.size, 1); assert.equal(channel(c).telegramUser.selectedPeerIds[0], '81'); } finally { await restored.close(); }
});

test('Disconnect keeps encrypted session/selection but restart stays disconnected until an explicit reconnect', async t => {
  const c = setup(t); await connect(c); await select(c); const result = await c.gateway.disconnect(admin, c.tenant.id, 'personal', { version: 2 });
  assert.equal(result.state, 'disconnected'); assert.equal(result.authState, 'idle'); assert.equal(result.configured, true); assert.equal(result.selectedCount, 1); assert.equal(result.version, 3);
  const factories = c.calls.filter(item => item === 'factory').length; await c.gateway.restore(); assert.equal(c.calls.filter(item => item === 'factory').length, factories);
  const reopened = await c.gateway.startLogin(admin, c.tenant.id, 'personal', { version: 3, method: 'qr' }); assert.equal(reopened.state, 'connected'); assert.equal(c.calls.includes('sendCode'), false);
});

test('A refreshed provider restriction prevents sending even before the selection is saved again', async t => {
  let canSend = true; const c = setup(t, { dialogs: async () => [{ ...dialog('81'), canSend }] }), entry = await connect(c); await select(c); await c.gateway.receive(entry, message()); const conversation = takeOver(c, conversations(c)[0].id);
  canSend = false; const result = await c.gateway.dialogs(admin, c.tenant.id, 'personal'); assert.equal(result.dialogs[0].canSend, false);
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: 'Bloqueado' }), error => error.status === 409);
  assert.equal(c.calls.some(item => item?.method === 'send'), false);
});

test('Received selected media uses encrypted shared storage; historical media is never downloaded', async t => {
  const c = setup(t), entry = await connect(c); await select(c); const bytes = Buffer.from('synthetic-file');
  await c.gateway.receive(entry, message('1', '81', { text: '', media: { kind: 'document', mime: 'text/plain', size: bytes.length, name: 'qa.txt' } }));
  await Promise.all([...c.gateway.mediaTasks]); const conversation = conversations(c)[0], attachment = conversation.messages[0].attachments[0]; assert.equal(attachment.status, 'ready');
  const read = await c.gateway.media.read(attachment.id, { tenantId: c.tenant.id, channelId: 'personal', conversationId: conversation.id }); assert.deepEqual(read.bytes, bytes); assert.equal(c.gateway.media.blobs.get(attachment.id).includes(bytes), false);
  c.clients[0].history = async () => [message('2', '81', { text: '', media: { kind: 'document', mime: 'text/plain', size: bytes.length, name: 'old.txt' } })];
  await c.gateway.importHistory(admin, c.tenant.id, 'personal', { version: 2, limitPerConversation: 1 }); assert.equal(c.calls.filter(item => item === 'download').length, 1); assert.equal(conversations(c)[0].messages.at(-1).attachments[0].status, 'unavailable');
});

test('Media capture revalidates selection after download and never publishes bytes after deselection', async t => {
  let finish; const c = setup(t, { download: () => new Promise(resolve => { finish = resolve; }) }), entry = await connect(c); await select(c);
  await c.gateway.receive(entry, message('1', '81', { text: '', media: { kind: 'document', mime: 'text/plain', size: 1, name: 'x.txt' } })); await tick(); await select(c, []); finish(Buffer.from('x'));
  await Promise.all([...c.gateway.mediaTasks]); const attachment = conversations(c)[0].messages[0].attachments[0]; assert.notEqual(attachment.status, 'ready'); assert.equal(c.gateway.media.blobs.has(attachment.id), false);
});

test('Changing channel/account state during history fetch prevents importing returned messages', async t => {
  let finish; const c = setup(t, { history: () => new Promise(resolve => { finish = resolve; }) }); await connect(c); await select(c);
  const task = c.gateway.importHistory(admin, c.tenant.id, 'personal', { version: 2, limitPerConversation: 10 }); await tick(); c.store.mutate(admin, c.tenant.id, 'Fixture', state => { state.channels.find(item => item.id === 'personal').state = 'disconnected'; }); finish([message()]);
  await assert.rejects(task, error => error.status === 409); assert.equal(conversations(c).length, 0);
});

test('Installed MTProto types carry marked BigInteger peers and private media payloads without coercing IDs', async () => {
  const { Api } = await import('teleproto'), { default: bigInt } = await import('big-integer'); const calls = [], handlers = [];
  const user = new Api.User({ id: bigInt('123456789123456789'), firstName: 'QA', accessHash: bigInt('777'), bot: false });
  const nativeClient = { session: { save: () => '' }, setLogLevel: () => {}, setParseMode: () => {}, addEventHandler: (handler, builder) => handlers.push({ handler, builder }), removeEventHandler: () => {},
    async getMe() { return user; }, async getDialogs() { return [{ entity: new Api.Channel({ id: bigInt('456'), accessHash: bigInt('123456789987654321'), title: 'QA Grupo', megagroup: true }), title: 'QA Grupo' }]; },
    async sendMessage(peer, payload) { calls.push({ peer, payload }); return { id: 99 }; }, async sendFile(peer, payload) { calls.push({ peer, payload }); return { id: 100 }; }, async disconnect() {} };
  const transport = await createTelegramUserClient({ apiId: 1234, apiHash: hash, onUpdate: () => {}, signal: new AbortController().signal, nativeClient });
  const [selected] = await transport.dialogs(100); assert.equal(selected.id, '-100456'); assert.equal(selected.type, 'group'); assert.equal(selected.privatePeer.accessHash, '123456789987654321');
  await transport.send(selected.privatePeer, { text: 'Texto próprio', replyTo: '44' }); assert.ok(calls[0].peer instanceof Api.InputPeerChannel); assert.equal(calls[0].peer.channelId.toString(), '456'); assert.equal(calls[0].peer.accessHash.toString(), '123456789987654321');
  const bytes = Buffer.from('private'); await transport.send(selected.privatePeer, { text: '', file: { bytes, metadata: { name: 'qa.txt', kind: 'document' } } }); assert.deepEqual(calls[1].payload.file, Object.assign(Buffer.from(bytes), { name: 'qa.txt' })); assert.equal(calls[1].payload.forceDocument, true);
  await transport.disconnect();
});

test('Native muted-account permissions remain read-only after selecting the group and never dispatch a reply', async t => {
  const { Api } = await import('teleproto'), { default: bigInt } = await import('big-integer');
  const rights = () => new Api.ChatBannedRights({ sendMessages: true, untilDate: 0 });
  const group = (id, extra) => new Api.Channel({ id: bigInt(id), accessHash: bigInt('123456789987654321'), title: 'Grupo QA', megagroup: true, ...extra });
  const entities = [group('456', { bannedRights: rights() }), group('457', { defaultBannedRights: rights() }),
    group('458', { defaultBannedRights: rights(), adminRights: new Api.ChatAdminRights({ postMessages: true }) }),
    group('459', { bannedRights: rights(), adminRights: new Api.ChatAdminRights({ postMessages: true }) })];
  const nativeClient = { setLogLevel() {}, setParseMode() {}, addEventHandler() {}, removeEventHandler() {}, disconnect: async () => {},
    getDialogs: async () => entities.map(entity => ({ entity, title: entity.title })) };
  const transport = await createTelegramUserClient({ apiId: 1234, apiHash: hash, onUpdate: () => {}, signal: new AbortController().signal, nativeClient });
  t.after(() => transport.disconnect());
  const metadata = await transport.dialogs(100);
  assert.deepEqual(metadata.map(item => [item.id, item.canSend]), [['-100456', false], ['-100457', false], ['-100458', null], ['-100459', false]]);
  const c = setup(t, { dialogs: () => transport.dialogs(100) }), entry = await connect(c);
  await select(c, ['-100456']); await c.gateway.receive(entry, message('1', '-100456'));
  const conversation = takeOver(c, conversations(c)[0].id);
  assert.equal(c.gateway.replyPolicy(admin, c.tenant.id, conversation.id).allowed, false);
  assert.equal(conversation.messages.length, 1);
  await assert.rejects(c.gateway.send(admin, c.tenant.id, conversation.id, { channelId: 'personal', version: conversation.version, text: 'Não enviar' }), error => error.status === 409);
  assert.equal(c.calls.some(item => item?.method === 'send'), false); assert.equal(conversations(c)[0].messages.length, 1);
});

test('Native QR callback refresh/migration is cancellable and never logs or returns a Telegram URI', async () => {
  const { Api } = await import('teleproto'), { default: bigInt } = await import('big-integer'); const handlers = [], removed = [], calls = []; let exports = 0;
  const user = new Api.User({ id: bigInt('123456789123456789'), firstName: 'QA', bot: false }), controller = new AbortController();
  const nativeClient = { session: { save: () => '' }, setLogLevel: () => {}, setParseMode: () => {}, addEventHandler: (handler, builder) => handlers.push({ handler, builder }), removeEventHandler: (handler) => removed.push(handler),
    async invoke(request) { calls.push(request.className); if (request instanceof Api.auth.ExportLoginToken) return ++exports === 1 ? new Api.auth.LoginToken({ token: Buffer.from('synthetic'), expires: Math.floor(Date.now() / 1000) + 30 }) : new Api.auth.LoginTokenMigrateTo({ dcId: 2, token: Buffer.from('synthetic-migrate') }); return new Api.auth.LoginTokenSuccess({ authorization: new Api.auth.Authorization({ user }) }); },
    async _switchDC(id) { calls.push('DC:' + id); }, async disconnect() {} };
  const transport = await createTelegramUserClient({ apiId: 1234, apiHash: hash, onUpdate: () => {}, signal: controller.signal, nativeClient });
  const result = await transport.loginQr({ signal: controller.signal, password: async () => '', qrCode: async value => { assert.ok(Buffer.isBuffer(value.token)); queueMicrotask(() => handlers.at(-1).handler(new Api.UpdateLoginToken({}))); } });
  assert.equal(result.id, '123456789123456789'); assert.ok(calls.includes('auth.ImportLoginToken')); assert.ok(calls.includes('DC:2')); assert.equal(removed.length, 1); await transport.disconnect();
});
