import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
import { WebchatGateway, webchatOrigin } from '../src/channel-webchat.js';
import { MediaService } from '../src/media.js';
import { ContactService } from '../src/contacts.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const status = code => error => error.status === code;
function fixture(t, options = {}) {
  const store = new Store(':memory:'); let clock = Date.parse('2026-10-03T12:00:00Z');
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const row = auth.insertUser({ username: 'webchat-synthetic-admin', name: 'Atendente sintético' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo');
  const admin = auth.actor(row), tenant = store.createTenant(admin, { name: 'Webchat RAM', segment: 'QA' });
  store.mutate(admin, tenant.id, 'Fixture: canal', state => { state.channels = [{ id: 'webchat-qa', kind: 'webchat', state: 'planned' }]; });
  const operations = new Operations(store, auth, { now: () => clock }), events = [], routes = [];
  const route = operations.routeIncoming.bind(operations); operations.routeIncoming = (id, cid) => { routes.push([id, cid]); return route(id, cid); };
  const { mediaOptions, ...gatewayOptions } = options;
  const media = options.media === true ? new MediaService(store, { directory: null, authKey: Buffer.alloc(32, 3), ...mediaOptions }) : options.media;
  const gateway = new WebchatGateway(store, { now: () => clock, operations, onIncoming: (...event) => events.push(event), ...gatewayOptions, media });
  gateway.configure(admin, tenant.id, 'webchat-qa', { origins: ['https://site.example', 'https://other.example'], version: 0 });
  const outbox = new Outbox(store, { authorize: (actor, id, conversation) => operations.canReply(actor, id, conversation) });
  t.after(async () => { await gateway.close(); store.close(); });
  const open = (name = 'Visitante de teste', origin = 'https://site.example') => {
    const challenge = gateway.challenge({ tenantId: tenant.id, channelId: 'webchat-qa', origin });
    return gateway.openSession({ tenantId: tenant.id, channelId: 'webchat-qa', origin, challenge: challenge.challenge, name });
  };
  const receive = (session, value = 'Olá', key = 'client-message-0001', origin = 'https://site.example') => gateway.receive({ token: session.token, origin, clientMessageId: key, text: value });
  const conversation = () => store.tenant(admin, tenant.id).conversations[0];
  const take = cid => store.mutate(admin, tenant.id, 'Fixture: assumir', state => {
    const current = store.getConversation(state, cid); current.owner = 'human'; current.assignedUserId = admin.userId; current.assignedUserName = admin.name; current.version++; return current;
  });
  return { store, auth, admin, tenant, operations, gateway, media, outbox, events, routes, open, receive, conversation, take,
    time(ms) { clock += ms; }, now: () => clock };
}

test('webchat configuration checks fresh admin, exact origins, revision and supported scheme', t => {
  const c = fixture(t);
  for (const origin of ['*', 'null', 'https://site.example/path', 'https://site.example/', 'http://remote.example', 'https://user:pass@site.example']) assert.throws(() => webchatOrigin(origin), status(400));
  assert.equal(webchatOrigin('http://127.0.0.1:49554'), 'http://127.0.0.1:49554');
  assert.throws(() => c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { origins: ['https://site.example'], version: 0 }), status(409));
  assert.throws(() => c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { origins: ['https://site.example'], enabled: 'true' }), status(400));
  c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId);
  assert.throws(() => c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { origins: ['https://site.example'] }), status(403));
});

test('public handshake has one-use nonce and token hash; it creates no customer message', t => {
  const c = fixture(t), origin = 'https://site.example';
  const challenge = c.gateway.challenge({ tenantId: c.tenant.id, channelId: 'webchat-qa', origin });
  assert.throws(() => c.gateway.openSession({ tenantId: c.tenant.id, channelId: 'webchat-qa', origin: 'https://other.example', challenge: challenge.challenge }), status(403));
  const session = c.gateway.openSession({ tenantId: c.tenant.id, channelId: 'webchat-qa', origin, challenge: challenge.challenge });
  assert.throws(() => c.gateway.openSession({ tenantId: c.tenant.id, channelId: 'webchat-qa', origin, challenge: challenge.challenge }), status(403));
  const stored = c.store.db.prepare('SELECT * FROM webchat_sessions').get();
  assert.notEqual(stored.token_hash, session.token); assert.equal(JSON.stringify(stored).includes(session.token), false);
  assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 0);
  assert.equal((c.store.tenant(c.admin, c.tenant.id).contacts || []).length, 0);
  assert.deepEqual(c.gateway.history({ token: session.token, origin }).messages, []);
  assert.throws(() => c.gateway.history({ token: session.token, origin: 'https://other.example' }), status(403));
  assert.throws(() => c.gateway.history({ token: 'invalid', origin }), status(403));
});

test('inbound webchat is transactional and idempotent; replay does not audit, route or run flows twice', async t => {
  const c = fixture(t), session = c.open();
  const first = await c.receive(session), original = JSON.stringify(c.conversation());
  const audits = c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count;
  assert.equal(first.replayed, false); assert.equal(c.conversation().owner, 'queue'); assert.equal(c.conversation().messages[0].transport, 'webchat');
  assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1);
  assert.deepEqual(await c.receive(session), { ...first, replayed: true });
  assert.equal(JSON.stringify(c.conversation()), original); assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count, audits);
  assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1);
  await assert.rejects(c.receive(session, 'Conteúdo alterado'), status(409));
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 1);
  await assert.rejects(c.gateway.receive({ token: session.token, origin: 'https://site.example', clientMessageId: 'client-message-0002', text: 'Arquivo', attachments: [{ id: 'metadata' }] }), status(400));
});

test('outbox reply reaches only the visitor timeline and confirmed replay sends no duplicate', async t => {
  const c = fixture(t), session = c.open(); await c.receive(session); let current = c.take(c.conversation().id);
  const input = { version: current.version, channelId: 'webchat-qa', text: 'Resposta sintética', idempotencyKey: 'webchat-outbox-0001', replyToMessageId: current.messages[0].id };
  const result = await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input));
  assert.equal(result.messages.at(-1).delivery, 'sent'); assert.equal(result.messages.at(-1).authorUserId, c.admin.userId);
  let calls = 0; await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => { calls++; }); assert.equal(calls, 0);
  const visible = c.gateway.history({ token: session.token, origin: 'https://site.example' });
  assert.deepEqual(visible.messages.map(item => item.text), ['Olá', 'Resposta sintética']);
  assert.equal(JSON.stringify(visible).includes(c.admin.userId), false); assert.equal(JSON.stringify(visible).includes(c.admin.name), false);
  assert.equal(c.conversation().messages.length, 2);
  await assert.rejects(c.gateway.send(c.admin, c.tenant.id, current.id, { ...input, version: result.version, attachmentIds: ['metadata'] }), status(400));
});

test('public history filters notes/system/unconfirmed messages and bounds page/cursor to this session', async t => {
  const c = fixture(t), session = c.open(); await c.receive(session);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: histórico', state => {
    const conversation = state.conversations[0];
    conversation.messages.push({ id: 'private-note-00001', kind: 'note', text: 'Segredo interno', delivery: 'sent' },
      { id: 'system-entry-00001', kind: 'system', text: 'Sistema interno' },
      { id: 'human-pending-0001', kind: 'human', text: 'Envio em andamento', delivery: 'pending' },
      { id: 'human-failed-00001', kind: 'human', text: 'Envio rejeitado', delivery: 'failed' },
      { id: 'human-visible-001', kind: 'human', text: 'Resposta confirmada', delivery: 'sent', createdAt: new Date(c.now()).toISOString() });
  });
  const page = c.gateway.history({ token: session.token, origin: 'https://site.example', limit: 1 });
  assert.equal(page.messages.length, 1); assert.equal(page.hasMore, true);
  const next = c.gateway.history({ token: session.token, origin: 'https://site.example', after: page.nextCursor, limit: 1 });
  assert.equal(next.messages[0].text, 'Resposta confirmada'); assert.equal(next.hasMore, false);
  assert.throws(() => c.gateway.history({ token: session.token, origin: 'https://site.example', after: 'private-note-00001' }), status(400));
  assert.throws(() => c.gateway.history({ token: session.token, origin: 'https://site.example', limit: 101 }), status(400));
  const other = c.open('Outro visitante'); assert.equal(c.gateway.history({ token: other.token, origin: 'https://site.example' }).messages.length, 0);
});

test('configuration epoch, disable/enable and expiration invalidate capabilities without deleting history', async t => {
  const c = fixture(t, { sessionTtlMs: 60_000 }), session = c.open(); await c.receive(session);
  let current = c.take(c.conversation().id); c.time(60_000);
  assert.throws(() => c.gateway.history({ token: session.token, origin: 'https://site.example' }), status(403));
  await assert.rejects(c.gateway.send(c.admin, c.tenant.id, current.id, { channelId: 'webchat-qa', version: current.version, text: 'Após prazo' }), status(409));
  const fresh = c.open(); await c.receive(fresh, 'Antes da mudança');
  c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { enabled: false, version: 1 });
  assert.throws(() => c.gateway.history({ token: fresh.token, origin: 'https://site.example' }), status(403));
  c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { enabled: true, version: 2 });
  assert.throws(() => c.gateway.history({ token: fresh.token, origin: 'https://site.example' }), status(403));
  assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.length, 2);
});

test('rate, pending handshake and session caps are enforced; confirmed replay remains available', async t => {
  const c = fixture(t, { maxPendingChallenges: 1, maxActiveSessions: 1 });
  c.gateway.challenge({ tenantId: c.tenant.id, channelId: 'webchat-qa', origin: 'https://site.example' });
  assert.throws(() => c.gateway.challenge({ tenantId: c.tenant.id, channelId: 'webchat-qa', origin: 'https://site.example' }), status(429));
  c.time(120_001); const session = c.open(); assert.throws(() => c.open(), status(429));
  for (let i = 0; i < 20; i++) await c.receive(session, 'Mensagem ' + i, 'client-message-' + String(i).padStart(4, '0'));
  await assert.rejects(c.receive(session, 'Acima do limite', 'client-message-0021'), status(429));
  assert.equal((await c.receive(session, 'Mensagem 0', 'client-message-0000')).replayed, true);
  c.time(60_001); await c.receive(session, 'Após o limite', 'client-message-0021');
  await assert.rejects(c.receive(session, 'x'.repeat(4001), 'client-message-0022'), status(400));
});

test('new incoming message reopens as queue, clears collaborators and uses the existing session', async t => {
  const c = fixture(t), session = c.open(); await c.receive(session); const before = c.conversation();
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: fechamento', state => {
    const current = state.conversations[0]; current.status = 'closed'; current.owner = 'human'; current.assignedUserId = c.admin.userId;
    current.assignedSupportGrantId = 'old-support'; current.participants = [{ userId: c.admin.userId, name: c.admin.name }];
  });
  await c.receive(session, 'Novo atendimento', 'client-message-0002'); const current = c.conversation();
  assert.equal(current.id, before.id); assert.equal(current.status, 'open'); assert.equal(current.owner, 'queue'); assert.equal(current.assignedUserId, null);
  assert.deepEqual(current.participants, []); assert.equal(current.assignedSupportGrantId, undefined);
  assert.equal(current.attendantEvents.some(item => item.type === 'reopened'), true);
});

test('visitor sessions survive adapter restart but their nonce does not; operator revocation blocks replies', async t => {
  const c = fixture(t), session = c.open(); await c.receive(session); let current = c.take(c.conversation().id);
  c.gateway.close();
  const restarted = new WebchatGateway(c.store, { operations: c.operations, now: c.now }); t.after(() => restarted.close());
  assert.equal(restarted.history({ token: session.token, origin: 'https://site.example' }).messages.length, 1);
  c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId);
  await assert.rejects(restarted.send(c.admin, c.tenant.id, current.id, { channelId: 'webchat-qa', version: current.version, text: 'Revogado' }), status(403));
  assert.equal(restarted.history({ token: session.token, origin: 'https://site.example' }).messages.length, 1);
});

test('public CORS access checks origin without minting nonce/token or consuming rate capacity', t => {
  const c = fixture(t), before = c.gateway.challenges.size;
  const allowed = c.gateway.publicAccess(c.tenant.id, 'webchat-qa', 'https://site.example');
  assert.equal(allowed.allowed, true); assert.equal(allowed.mediaSupported, false); assert.equal(allowed.brand.name, 'Webchat RAM Chat');
  // Without a brand name the widget shows the company's own name, never the platform's.
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: sem marca', state => { state.brand = { ...state.brand, name: '' }; });
  const unbranded = c.gateway.publicAccess(c.tenant.id, 'webchat-qa', 'https://site.example');
  assert.equal(unbranded.brand.name, c.store.tenant(c.admin, c.tenant.id).name.slice(0, 80)); assert.notEqual(unbranded.brand.name, 'Elozi');
  assert.equal(c.gateway.challenges.size, before); assert.equal(c.gateway.rates.size, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_sessions').get().count, 0);
  assert.throws(() => c.gateway.publicAccess(c.tenant.id, 'webchat-qa', 'https://unlisted.example'), status(403));
});

test('resource-scoped message/history endpoints reject a capability for another tenant or channel', async t => {
  const c = fixture(t), session = c.open(); await c.receive(session);
  const context = { token: session.token, origin: 'https://site.example', tenantId: c.tenant.id, channelId: 'webchat-qa' };
  assert.equal(c.gateway.history(context).messages.length, 1);
  for (const wrong of [{ tenantId: 'other-tenant' }, { channelId: 'other-channel' }]) {
    assert.throws(() => c.gateway.history({ ...context, ...wrong }), status(403));
    await assert.rejects(c.gateway.receive({ ...context, ...wrong, clientMessageId: 'client-message-0002', text: 'Outro contexto' }), status(403));
  }
  assert.equal(c.conversation().messages.length, 1);
});

const photo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7, 8, 9]);
const publicInput = (c, session) => ({ token: session.token, origin: 'https://site.example', tenantId: c.tenant.id, channelId: 'webchat-qa' });
const incomingFile = (c, session, overrides = {}) => ({ ...publicInput(c, session), clientMessageId: 'media-message-0001', text: 'Foto do visitante',
  attachment: { bytes: photo, mime: 'image/png', name: 'foto.png', voice: false }, ...overrides });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('visitor/media preflight exposes explicit capabilities without creating conversation or rate/receipt state', t => {
  const c = fixture(t, { media: true }), one = c.open(), two = c.open();
  const before = c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count;
  const first = c.gateway.visitorAccess(publicInput(c, one)), second = c.gateway.mediaAccess(publicInput(c, two));
  assert.notEqual(first.conversationId, second.conversationId); assert.equal(first.reauthorize(), true);
  assert.equal(c.conversation(), undefined); assert.equal(c.media.blobs.size, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count, before);
  assert.deepEqual(c.gateway.capabilities(), { identityHistorySupported: true, mediaSupported: true, mediaKinds: ['image', 'audio', 'video', 'document'], mediaMaxBytes: 16777216, captionMaxLength: 1024, voiceSupported: true });
  for (const dto of [one, c.gateway.publicAccess(c.tenant.id, 'webchat-qa', 'https://site.example'), c.gateway.status(c.admin, c.tenant.id, 'webchat-qa'), c.gateway.history(publicInput(c, one))]) {
    assert.equal(dto.mediaSupported, true); assert.equal(dto.mediaMaxBytes, 16777216); assert.equal(dto.voiceSupported, true);
  }
  const plain = fixture(t), session = plain.open();
  assert.equal(plain.gateway.visitorAccess(publicInput(plain, session)).tenantId, plain.tenant.id);
  assert.throws(() => plain.gateway.mediaAccess(publicInput(plain, session)), status(503));
  assert.equal(plain.gateway.capabilities().mediaSupported, false);
});

test('first media message commits a private attachment and survives an encrypted filesystem restart', async t => {
  const prefix = resolve(tmpdir(), 'elozi-webchat-media-unit-'), directory = await mkdtemp(prefix);
  t.after(async () => { assert.ok(resolve(directory).startsWith(prefix)); await rm(directory, { recursive: true, force: true }); });
  const c = fixture(t, { media: true, mediaOptions: { directory } }), session = c.open();
  const result = await c.gateway.receiveMedia(incomingFile(c, session));
  const message = c.conversation().messages[0], attachment = message.attachments[0];
  assert.equal(result.messageId, message.id); assert.equal(message.delivery, 'received'); assert.equal(attachment.status, 'ready');
  assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1);
  const names = await readdir(directory); assert.deepEqual(names, [attachment.id + '.mepmedia']);
  const encrypted = await readFile(join(directory, names[0])); assert.equal(encrypted.includes(photo), false);
  assert.equal(encrypted.length, photo.length + 28);
  const downloaded = await c.gateway.readMedia({ ...publicInput(c, session), attachmentId: attachment.id });
  assert.deepEqual(downloaded.bytes, photo); assert.deepEqual(downloaded.metadata, attachment);
  await c.gateway.close();
  const restoredMedia = new MediaService(c.store, { directory, authKey: Buffer.alloc(32, 3) });
  const restored = new WebchatGateway(c.store, { operations: c.operations, now: c.now, media: restoredMedia });
  try {
    assert.deepEqual((await restored.readMedia({ ...publicInput(c, session), attachmentId: attachment.id })).bytes, photo);
    assert.deepEqual(restored.history(publicInput(c, session)).messages[0].attachments, [attachment]);
    assert.equal((await restored.receiveMedia(incomingFile(c, session))).replayed, true);
    assert.equal(c.conversation().messages.length, 1); assert.equal((await readdir(directory)).length, 1);
  } finally { await restored.close(); }
});

test('concurrent replay shares one pending capture and hashes bytes/caption/descriptor without mutation', async t => {
  const entered = deferred(), release = deferred(); let keyLoads = 0;
  const c = fixture(t, { media: true, mediaOptions: { authKey: undefined, keyLoader: async () => { keyLoads++; entered.resolve(); await release.promise; return Buffer.alloc(32, 3); } } });
  const session = c.open(), bytes = Buffer.from(photo), input = incomingFile(c, session, { attachment: { bytes, name: 'foto.png', mime: 'image/png' } });
  const first = c.gateway.receiveMedia(input); await entered.promise;
  assert.equal(c.conversation().messages[0].attachments[0].status, 'pending');
  const duplicate = c.gateway.receiveMedia(incomingFile(c, session));
  for (const changed of [{ text: 'Legenda trocada' }, { attachment: { bytes: photo, name: 'outro.png', mime: 'image/png' } },
    { attachment: { bytes: Buffer.concat([photo, Buffer.from([1])]), name: 'foto.png', mime: 'image/png' } }]) {
    await assert.rejects(c.gateway.receiveMedia(incomingFile(c, session, changed)), status(409));
  }
  bytes.fill(0); input.token = 'mutated'; release.resolve();
  const [received, replayed] = await Promise.all([first, duplicate]);
  assert.deepEqual(replayed, { ...received, replayed: true }); assert.equal(keyLoads, 1);
  assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1); assert.equal(c.conversation().messages.length, 1);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 1);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM media_attachments').get().count, 1);
  assert.deepEqual((await c.gateway.readMedia({ ...publicInput(c, session), attachmentId: c.conversation().messages[0].attachments[0].id })).bytes, photo);
});

test('receipt failure rolls back the first conversation, message and attachment together', async t => {
  const c = fixture(t, { media: true }), session = c.open();
  c.store.db.exec("CREATE TRIGGER refuse_webchat_receipt BEFORE INSERT ON webchat_inbound_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  await assert.rejects(c.gateway.receiveMedia(incomingFile(c, session)), /synthetic receipt failure/);
  assert.equal(c.conversation(), undefined); assert.equal(c.events.length, 0); assert.equal(c.routes.length, 0);
  assert.equal((c.store.tenant(c.admin, c.tenant.id).contacts || []).length, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM media_attachments').get().count, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 0);
  assert.equal(c.media.blobs.size, 0);
  c.store.db.exec('DROP TRIGGER refuse_webchat_receipt');
  assert.equal((await c.gateway.receiveMedia(incomingFile(c, session))).replayed, false);
  assert.equal(c.conversation().messages.length, 1);
  assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 1);
});

test('quota failure preserves one unavailable received message and replay never starts a new file', async t => {
  const c = fixture(t, { media: true, mediaOptions: { maxTenantBytes: photo.length - 1 } }), session = c.open();
  const first = await c.gateway.receiveMedia(incomingFile(c, session)), attachment = c.conversation().messages[0].attachments[0];
  assert.equal(attachment.status, 'unavailable'); assert.equal(attachment.reason, 'quota'); assert.equal(c.media.blobs.size, 0);
  await assert.rejects(c.gateway.readMedia({ ...publicInput(c, session), attachmentId: attachment.id }), status(404));
  assert.deepEqual(await c.gateway.receiveMedia(incomingFile(c, session)), { ...first, replayed: true });
  assert.equal(c.conversation().messages.length, 1); assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM media_attachments').get().count, 1);
});

test('public media/history exclude drafts, notes, unconfirmed files and every other visitor/tenant/channel', async t => {
  const c = fixture(t, { media: true }), session = c.open(), other = c.open();
  await c.gateway.receiveMedia(incomingFile(c, session));
  const conversation = c.conversation(), context = { tenantId: c.tenant.id, conversationId: conversation.id, channelId: 'webchat-qa' };
  const publicId = conversation.messages[0].attachments[0].id;
  const files = await Promise.all(['draft', 'note', 'unconfirmed'].map(name => c.media.upload(context, { bytes: photo, name: name + '.png', mime: 'image/png' })));
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: private attachments', tenant => {
    const current = c.store.getConversation(tenant, conversation.id);
    current.messages.push({ id: 'note-media-message', kind: 'note', text: 'private note', attachments: [files[1]] },
      { id: 'unknown-media-message', kind: 'human', delivery: 'unconfirmed', text: 'private unknown', attachments: [files[2]] });
    Object.assign(current.messages[0].attachments[0], { url: 'https://secret.invalid/file', token: session.token, remoteReference: 'private-ref', bytes: 'private-bytes' });
  });
  let reads = 0; const read = c.media.read.bind(c.media); c.media.read = (...args) => { reads++; return read(...args); };
  for (const attachment of files) await assert.rejects(c.gateway.readMedia({ ...publicInput(c, session), attachmentId: attachment.id }), status(404));
  await assert.rejects(c.gateway.readMedia({ ...publicInput(c, other), attachmentId: publicId }), status(404));
  const tenant = c.store.createTenant(c.admin, { name: 'Other media RAM', segment: 'QA' });
  c.store.mutate(c.admin, tenant.id, 'Fixture: other tenant', state => { state.channels = [{ id: 'webchat-qa', kind: 'webchat' }]; });
  c.gateway.configure(c.admin, tenant.id, 'webchat-qa', { origins: ['https://site.example'] });
  const challenge = c.gateway.challenge({ tenantId: tenant.id, channelId: 'webchat-qa', origin: 'https://site.example' });
  const remote = c.gateway.openSession({ tenantId: tenant.id, channelId: 'webchat-qa', origin: 'https://site.example', challenge: challenge.challenge });
  await assert.rejects(c.gateway.readMedia({ ...publicInput(c, session), tenantId: tenant.id, attachmentId: publicId }), status(403));
  await assert.rejects(c.gateway.readMedia({ token: remote.token, origin: 'https://site.example', tenantId: tenant.id, channelId: 'webchat-qa', attachmentId: publicId }), status(404));
  await assert.rejects(c.gateway.readMedia({ ...publicInput(c, session), channelId: 'other-channel', attachmentId: publicId }), status(403));
  await assert.rejects(c.gateway.readMedia({ ...publicInput(c, session), origin: 'https://other.example', attachmentId: publicId }), status(403));
  assert.equal(reads, 0);
  const history = c.gateway.history(publicInput(c, session)), serialized = JSON.stringify(history);
  assert.equal(history.messages.length, 1); assert.deepEqual(history.messages[0].attachments[0], { id: publicId, kind: 'image', name: 'foto.png', mime: 'image/png', size: photo.length, status: 'ready', preview: true });
  for (const value of [session.token, conversation.remoteSessionId, 'private note', 'private unknown', 'private-ref', 'private-bytes', 'secret.invalid']) assert.equal(serialized.includes(value), false);
});

test('configuration revocation during capture denies original/replay and leaves one unavailable receipt', async t => {
  const entered = deferred(), release = deferred();
  const c = fixture(t, { media: true, mediaOptions: { authKey: undefined, keyLoader: async () => { entered.resolve(); await release.promise; return Buffer.alloc(32, 3); } } });
  const session = c.open(), outcome = c.gateway.receiveMedia(incomingFile(c, session)).then(() => 'success', error => error);
  await entered.promise;
  const replay = c.gateway.receiveMedia(incomingFile(c, session)).then(() => 'success', error => error);
  c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { version: 1, enabled: false }); release.resolve();
  const [firstError, replayError] = await Promise.all([outcome, replay]);
  assert.equal(firstError.status, 403); assert.equal(replayError.status, 403);
  assert.equal(c.conversation().messages.length, 1); assert.equal(c.conversation().messages[0].attachments[0].status, 'unavailable');
  assert.equal(c.media.blobs.size, 0); assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1);
  assert.throws(() => c.gateway.mediaAccess(publicInput(c, session)), status(403));
  await assert.rejects(c.gateway.receiveMedia(incomingFile(c, session)), status(403));
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 1);
});

test('media read composes domain authority after key loading and refuses bytes after revocation', async t => {
  const c = fixture(t, { media: true }), session = c.open(); await c.gateway.receiveMedia(incomingFile(c, session));
  const attachmentId = c.conversation().messages[0].attachments[0].id, entered = deferred(), release = deferred(); let domainAllowed = true;
  c.media.authKey = null; c.media.keyLoader = async () => { entered.resolve(); await release.promise; return Buffer.alloc(32, 3); };
  const outcome = c.gateway.readMedia({ ...publicInput(c, session), attachmentId }, { reauthorize: () => domainAllowed }).then(() => 'success', error => error);
  await entered.promise; domainAllowed = false; release.resolve();
  assert.equal((await outcome).status, 403); assert.equal(c.media.blobs.size, 1);
  assert.equal(c.conversation().messages[0].attachments[0].status, 'ready');
  assert.deepEqual((await c.gateway.readMedia({ ...publicInput(c, session), attachmentId })).bytes, photo);
  await assert.rejects(c.gateway.readMedia({ ...publicInput(c, session), attachmentId }, { reauthorize: async () => false }), status(500));
});

test('all four incoming media kinds are private readable files and voice metadata cannot forge a photo', async t => {
  const c = fixture(t, { media: true }), session = c.open();
  const cases = [['image/png', photo, 'image'], ['audio/ogg', Buffer.from('OggSOpusHead-fixture'), 'audio'],
    ['video/mp4', Buffer.from('\0\0\0\x18ftypisomfixture'), 'video'], ['application/pdf', Buffer.from('%PDF-fixture'), 'document']];
  for (let index = 0; index < cases.length; index++) {
    const [mime, bytes, kind] = cases[index];
    await c.gateway.receiveMedia(incomingFile(c, session, { clientMessageId: 'four-kinds-message-' + index, text: '', attachment: { bytes, name: 'arquivo', mime, voice: kind === 'audio' } }));
    const attachment = c.conversation().messages.at(-1).attachments[0]; assert.equal(attachment.kind, kind); assert.equal(attachment.status, 'ready');
    assert.deepEqual((await c.gateway.readMedia({ ...publicInput(c, session), attachmentId: attachment.id })).bytes, bytes);
  }
  await assert.rejects(c.gateway.receiveMedia(incomingFile(c, session, { attachment: { bytes: photo, name: 'foto', mime: 'image/png', voice: true } })), status(400));
  assert.equal(c.conversation().messages.length, 4);
});

test('operator media reply is scoped, quoted and confirmed exactly once through the real outbox', async t => {
  const c = fixture(t, { media: true }), session = c.open(); await c.receive(session);
  const current = c.take(c.conversation().id), originalId = current.messages[0].id;
  const context = c.gateway.assertReplySession(c.admin, c.tenant.id, current.id, { channelId: current.channelId, version: current.version });
  assert.equal(context.expiresAt, session.expiresAt); assert.equal(context.reauthorize(), true);
  const uploaded = await c.media.upload(context, { bytes: photo, name: 'resposta.png', mime: 'image/png' });
  const input = { channelId: current.channelId, version: current.version, text: 'Legenda da resposta', attachmentIds: [uploaded.id], replyToMessageId: originalId, idempotencyKey: 'operator-media-reply-0001' };
  let calls = 0;
  const send = () => { calls++; return c.gateway.send(c.admin, c.tenant.id, current.id, input); };
  const result = await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, send, { validate: () => c.gateway.validateOutgoing(c.admin, c.tenant.id, current.id, input) });
  assert.equal(result.messages.at(-1).replyToMessageId, originalId); assert.equal(result.messages.at(-1).delivery, 'sent');
  assert.deepEqual((await c.gateway.readMedia({ ...publicInput(c, session), attachmentId: uploaded.id })).bytes, photo);
  c.time(24 * 3600_000 + 1);
  await c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, send, { validate: () => { throw new Error('expired policy must not run on confirmed replay'); } });
  assert.equal(calls, 1); assert.equal(c.conversation().messages.length, 2);
  const command = c.store.db.prepare('SELECT state,attempts FROM outbound_commands').get(); assert.deepEqual({ ...command }, { state: 'confirmed', attempts: 1 });
});

test('outgoing policy rejects received, pending and foreign files before outbox registration or file reads', async t => {
  const c = fixture(t, { media: true }), session = c.open(); await c.gateway.receiveMedia(incomingFile(c, session));
  const current = c.take(c.conversation().id), receivedId = current.messages[0].attachments[0].id;
  const other = c.open(); await c.receive(other, 'Outro visitante', 'other-visitor-message');
  const remote = c.conversation(), remoteFile = await c.media.upload({ tenantId: c.tenant.id, conversationId: remote.id, channelId: 'webchat-qa' }, { bytes: photo, name: 'other.png', mime: 'image/png' });
  const upload = await c.media.upload({ tenantId: c.tenant.id, conversationId: current.id, channelId: 'webchat-qa' }, { bytes: photo, name: 'pending.png', mime: 'image/png' });
  c.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify({ ...upload, status: 'pending' }), upload.id);
  let reads = 0; const resolveFiles = c.media.resolve.bind(c.media); c.media.resolve = (...args) => { reads++; return resolveFiles(...args); };
  for (const [id, expected] of [[receivedId, 404], [remoteFile.id, 404], [upload.id, 409]]) {
    const input = { channelId: 'webchat-qa', version: current.version, text: 'Arquivo', attachmentIds: [id], idempotencyKey: 'invalid-file-intent-' + expected + '-' + id };
    await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, () => c.gateway.send(c.admin, c.tenant.id, current.id, input),
      { validate: () => c.gateway.validateOutgoing(c.admin, c.tenant.id, current.id, input) }), status(expected));
  }
  assert.equal(reads, 0); assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM outbound_commands').get().count, 0);
  assert.equal(c.store.tenant(c.admin, c.tenant.id).conversations.find(item => item.id === current.id).messages.length, 1);
});

test('operator permission, CAS, session revision and expiry are fresh after asynchronous file resolution', async t => {
  for (const mutation of ['permission', 'CAS', 'revision', 'expiry']) await t.test(mutation, async subtest => {
    const c = fixture(subtest, { media: true }), session = c.open(); await c.receive(session);
    const current = c.take(c.conversation().id), context = { tenantId: c.tenant.id, conversationId: current.id, channelId: 'webchat-qa' };
    const uploaded = await c.media.upload(context, { bytes: photo, name: 'resposta.png', mime: 'image/png' });
    const entered = deferred(), release = deferred();
    c.media.authKey = null; c.media.keyLoader = async () => { entered.resolve(); await release.promise; return Buffer.alloc(32, 3); };
    const input = { channelId: 'webchat-qa', version: current.version, text: 'Resposta', attachmentIds: [uploaded.id] };
    const outcome = c.gateway.send(c.admin, c.tenant.id, current.id, input).then(() => 'success', error => error);
    await entered.promise;
    if (mutation === 'permission') c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date(c.now()).toISOString(), c.admin.userId);
    if (mutation === 'CAS') c.store.mutate(c.admin, c.tenant.id, 'Fixture: CAS changed', state => { c.store.getConversation(state, current.id).version++; });
    if (mutation === 'revision') c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { version: 1, origins: ['https://site.example'] });
    if (mutation === 'expiry') c.time(24 * 3600_000);
    release.resolve(); assert.equal((await outcome).status, mutation === 'permission' ? 403 : 409);
    assert.equal(c.conversation().messages.length, 1); assert.equal(c.media.blobs.size, 1);
  });
});

test('uncertain outbox settlement after a visible media reply prevents replay and a second attachment intent', async t => {
  const c = fixture(t, { media: true }), session = c.open(); await c.receive(session);
  const current = c.take(c.conversation().id), uploaded = await c.media.upload({ tenantId: c.tenant.id, conversationId: current.id, channelId: 'webchat-qa' }, { bytes: photo, name: 'resposta.png', mime: 'image/png' });
  const input = { channelId: 'webchat-qa', version: current.version, text: '', attachmentIds: [uploaded.id], idempotencyKey: 'uncertain-media-intent-0001' };
  c.store.db.exec("CREATE TRIGGER refuse_webchat_settle BEFORE UPDATE OF state ON outbound_commands WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'synthetic settle failure'); END;");
  let sends = 0; const send = () => { sends++; return c.gateway.send(c.admin, c.tenant.id, current.id, input); };
  const options = { validate: () => c.gateway.validateOutgoing(c.admin, c.tenant.id, current.id, input) };
  await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, send, options), error => error.code === 'OUTBOUND_UNCONFIRMED');
  c.store.db.exec('DROP TRIGGER refuse_webchat_settle');
  assert.equal(c.gateway.history(publicInput(c, session)).messages.length, 2);
  assert.equal(c.store.db.prepare('SELECT state FROM outbound_commands').get().state, 'unknown');
  await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, input, send, options), error => error.status === 409 && error.code === 'OUTBOUND_UNCONFIRMED');
  const changed = { ...input, version: c.conversation().version, idempotencyKey: 'uncertain-media-intent-0002' };
  await assert.rejects(c.outbox.dispatch(c.admin, c.tenant.id, current.id, changed, send,
    { validate: () => c.gateway.validateOutgoing(c.admin, c.tenant.id, current.id, changed) }), status(409));
  assert.equal(sends, 1); assert.equal(c.conversation().messages.length, 2);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM outbound_commands').get().count, 1);
});

test('webchat scheduling cannot outlive its visitor and upload preflight denies expired visitor before storage', async t => {
  const c = fixture(t, { media: true }), session = c.open(); await c.receive(session);
  const current = c.take(c.conversation().id);
  assert.equal(c.gateway.validateSchedule(c.admin, c.tenant.id, current.id, { text: 'Programada', dueAt: new Date(c.now() + 1000).toISOString() }), true);
  assert.throws(() => c.gateway.validateSchedule(c.admin, c.tenant.id, current.id, { text: 'Programada', dueAt: session.expiresAt }), status(409));
  c.time(24 * 3600_000);
  assert.throws(() => c.gateway.assertReplySession(c.admin, c.tenant.id, current.id, { channelId: 'webchat-qa', version: current.version }), status(409));
  assert.throws(() => c.gateway.mediaAccess(publicInput(c, session)), status(403));
  await assert.rejects(c.gateway.receiveMedia(incomingFile(c, session)), status(403));
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM media_attachments').get().count, 0);
  assert.equal(c.conversation().messages.length, 1);
});

test('voice replay uses the trusted original frame digest when normalized OGG bytes, names and sizes change', async t => {
  const c = fixture(t, { media: true }), session = c.open();
  const originalContentHash = createHash('sha256').update('synthetic original microphone bytes').digest('hex');
  const normalized = (bytes, text = '') => incomingFile(c, session, { text, attachment: { bytes, name: 'voz.ogg', mime: 'audio/ogg', voice: true } });
  const firstBytes = Buffer.from('OggSOpusHead-first-encoding'), retryBytes = Buffer.from('OggSOpusHead-second-encoding-with-more-bytes');
  const first = await c.gateway.receiveMedia(normalized(firstBytes), { originalContentHash });
  const retry = normalized(retryBytes); retry.attachment.name = 'normalizer-retry-name.ogg';
  assert.deepEqual(await c.gateway.receiveMedia(retry, { originalContentHash }), { ...first, replayed: true });
  const attachment = c.conversation().messages[0].attachments[0];
  assert.deepEqual((await c.gateway.readMedia({ ...publicInput(c, session), attachmentId: attachment.id })).bytes, firstBytes);
  assert.equal(c.events.length, 1); assert.equal(c.routes.length, 1); assert.equal(c.conversation().messages.length, 1); assert.equal(c.media.blobs.size, 1);
  const changedFrameHash = createHash('sha256').update('synthetic original microphone bytes with changed caption').digest('hex');
  await assert.rejects(c.gateway.receiveMedia(normalized(retryBytes, 'Legenda trocada'), { originalContentHash: changedFrameHash }), status(409));
  await assert.rejects(c.gateway.receiveMedia(normalized(retryBytes), { originalContentHash: 'f'.repeat(64) }), status(409));
  await assert.rejects(c.gateway.receiveMedia(normalized(retryBytes)), status(409));
  await assert.rejects(c.gateway.receiveMedia({ ...normalized(retryBytes), originalContentHash }), status(400));
  await assert.rejects(c.gateway.receiveMedia(incomingFile(c, session), { originalContentHash: 'invalid' }), status(500));
  assert.equal(JSON.stringify(c.gateway.history(publicInput(c, session))).includes(originalContentHash), false);
});

function fillAgenda(c, size = 10000) {
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: agenda RAM', state => {
    state.contacts ||= []; const timestamp = new Date(c.now()).toISOString();
    for (let index = state.contacts.length; index < size; index++) state.contacts.push({ id: `contact-ram-${index}`, name: `Contato RAM ${index}`, type: 'person', phone: '', email: '', notes: '', tags: [], identities: [], version: 1, createdAt: timestamp, updatedAt: timestamp });
  });
}

test('first incoming webchat links CRM in the same transaction without inferring phone/email from visitor name', async t => {
  const c = fixture(t), visitorName = 'visitante@example.com +55 (11) 99999-0000', session = c.open(visitorName);
  assert.equal((c.store.tenant(c.admin, c.tenant.id).contacts || []).length, 0);
  await c.receive(session);
  const tenant = c.store.tenant(c.admin, c.tenant.id), conversation = c.conversation(), contact = tenant.contacts[0];
  assert.equal(tenant.contacts.length, 1); assert.equal(conversation.contactId, contact.id); assert.equal(conversation.contactSyncStatus, 'linked');
  assert.equal(contact.name, visitorName); assert.equal(contact.phone, ''); assert.equal(contact.email, ''); assert.equal(contact.type, 'person'); assert.equal(contact.version, 1);
  assert.deepEqual(contact.identities, [{ channelId: 'webchat-qa', kind: 'person', externalId: `conversation:${conversation.id}` }]);
  assert.equal(c.events[0][1], conversation.id); assert.equal(c.events[0][3].contactSync, undefined);
  const visible = JSON.stringify(c.gateway.history(publicInput(c, session)));
  for (const internal of [contact.id, conversation.remoteSessionId, 'contactSyncStatus', 'identities', 'conversation:']) assert.equal(visible.includes(internal), false);
});

test('equal visitor names in distinct sessions and channels never merge contacts or expose another visitor', async t => {
  const c = fixture(t), one = c.open('Visitante igual'), two = c.open('Visitante igual');
  await c.receive(one, 'Primeiro visitante'); await c.receive(two, 'Segundo visitante');
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: outro Webchat', state => state.channels.push({ id: 'webchat-other', kind: 'webchat', state: 'planned' }));
  c.gateway.configure(c.admin, c.tenant.id, 'webchat-other', { origins: ['https://site.example'], version: 0 });
  const challenge = c.gateway.challenge({ tenantId: c.tenant.id, channelId: 'webchat-other', origin: 'https://site.example' });
  const three = c.gateway.openSession({ tenantId: c.tenant.id, channelId: 'webchat-other', origin: 'https://site.example', challenge: challenge.challenge, name: 'Visitante igual' });
  await c.gateway.receive({ token: three.token, tenantId: c.tenant.id, channelId: 'webchat-other', origin: 'https://site.example', clientMessageId: 'client-message-third', text: 'Outro canal' });
  const tenant = c.store.tenant(c.admin, c.tenant.id);
  assert.equal(tenant.contacts.length, 3); assert.equal(new Set(tenant.conversations.map(item => item.contactId)).size, 3);
  for (const conversation of tenant.conversations) assert.deepEqual(tenant.contacts.find(item => item.id === conversation.contactId).identities, [{ channelId: conversation.channelId, kind: 'person', externalId: `conversation:${conversation.id}` }]);
  assert.deepEqual(c.gateway.history(publicInput(c, one)).messages.map(item => item.text), ['Primeiro visitante']);
  assert.deepEqual(c.gateway.history(publicInput(c, two)).messages.map(item => item.text), ['Segundo visitante']);
});

test('replay and new messages preserve edited/archived contact fields, identity and version through reopening', async t => {
  const c = fixture(t), session = c.open(); await c.receive(session); const service = new ContactService(c.store, c.auth), contactId = c.conversation().contactId;
  const edited = service.update(c.admin, c.tenant.id, contactId, { name: 'Nome escolhido pela equipe', phone: '11987654321', email: 'own@example.com', notes: 'Contexto próprio', tags: ['VIP'], version: 1 });
  service.archive(c.admin, c.tenant.id, contactId, { version: edited.version });
  const before = JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts[0]);
  const version = c.conversation().version, audits = c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count;
  assert.equal((await c.receive(session)).replayed, true); assert.equal(c.conversation().version, version); assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM audit').get().count, audits);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: fechar', state => { const conversation = state.conversations[0]; conversation.status = 'closed'; conversation.version++; });
  await c.receive(session, 'Retorno do mesmo visitante', 'client-message-contact-next');
  assert.equal(c.conversation().status, 'open'); assert.equal(c.conversation().contactId, contactId); assert.equal(c.conversation().contactSyncStatus, 'linked');
  assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 1); assert.equal(JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts[0]), before);
});

test('first media entry and concurrent replay create one contact before capture and preserve its version', async t => {
  const entered = deferred(), release = deferred(), c = fixture(t, { media: true, mediaOptions: { authKey: undefined, keyLoader: async () => { entered.resolve(); await release.promise; return Buffer.alloc(32, 3); } } }), session = c.open();
  const first = c.gateway.receiveMedia(incomingFile(c, session)); await entered.promise;
  const tenant = c.store.tenant(c.admin, c.tenant.id), contact = tenant.contacts[0], before = JSON.stringify(contact);
  assert.equal(tenant.contacts.length, 1); assert.equal(c.conversation().contactId, contact.id); assert.equal(c.conversation().contactSyncStatus, 'linked');
  assert.equal(c.conversation().messages[0].attachments[0].status, 'pending');
  const retry = c.gateway.receiveMedia(incomingFile(c, session)); release.resolve(); const [result, replay] = await Promise.all([first, retry]);
  assert.deepEqual(replay, { ...result, replayed: true }); assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 1); assert.equal(JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts[0]), before);
  assert.equal(c.conversation().messages.length, 1); assert.equal(c.events.length, 1); assert.equal(c.media.blobs.size, 1);
});

for (const reason of ['origin', 'tenant', 'channel', 'expired', 'revoked', 'configuration-before-commit']) test(`webchat ${reason} denied before contact/message/receipt creation`, async t => {
  const c = fixture(t), session = c.open(), input = { ...publicInput(c, session), clientMessageId: 'client-message-denied', text: 'Não registrar' };
  let reauthorize = () => {};
  if (reason === 'origin') input.origin = 'https://other.example';
  if (reason === 'tenant') input.tenantId = 'other-tenant';
  if (reason === 'channel') input.channelId = 'other-channel';
  if (reason === 'expired') c.time(24 * 3600_000 + 1);
  if (reason === 'revoked') { let checks = 0; reauthorize = () => ++checks < 2; }
  if (reason === 'configuration-before-commit') {
    const mutate = c.store.mutate.bind(c.store);
    c.store.mutate = (...args) => { c.store.mutate = mutate; c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { version: 1, enabled: false }); return mutate(...args); };
  }
  await assert.rejects(c.gateway.receive(input, { reauthorize }), status(403));
  assert.equal((c.store.tenant(c.admin, c.tenant.id).contacts || []).length, 0); assert.equal(c.conversation(), undefined); assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 0); assert.equal(c.events.length, 0);
});

test('full agenda keeps incoming text/receipt/replay and links only a later message after a slot is freed', async t => {
  const c = fixture(t); fillAgenda(c); const original = JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts), session = c.open();
  const first = await c.receive(session), conversation = c.conversation();
  assert.equal(conversation.contactId, undefined); assert.equal(conversation.contactSyncStatus, 'capacity'); assert.equal(conversation.messages.length, 1);
  assert.deepEqual(c.events[0][3].contactSync, { code: 'CONTACT_CAPACITY', limit: 10000 });
  assert.equal(JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts), original); assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts').get().count, 1);
  assert.equal(JSON.stringify(first).includes('CONTACT_CAPACITY'), false); assert.equal(JSON.stringify(c.gateway.history(publicInput(c, session))).includes('contactSync'), false);
  c.store.mutate(c.admin, c.tenant.id, 'Fixture: vaga própria', state => { state.contacts.pop(); });
  assert.deepEqual(await c.receive(session), { ...first, replayed: true }); assert.equal(c.conversation().contactId, undefined); assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 9999); assert.equal(c.events.length, 1);
  await c.receive(session, 'Nova entrada com vaga', 'client-message-agenda-slot');
  const linkedId = c.conversation().contactId, contact = c.store.tenant(c.admin, c.tenant.id).contacts.find(item => item.id === linkedId);
  assert.equal(c.conversation().contactSyncStatus, 'linked'); assert.equal(contact.version, 1); assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 10000); assert.equal(c.conversation().messages.length, 2); assert.equal(c.events[1][3].contactSync, undefined);
});

test('agenda at 10000 preserves the existing edited/archived contact on a new media message', async t => {
  const c = fixture(t, { media: true }), session = c.open(); await c.receive(session); const service = new ContactService(c.store, c.auth), id = c.conversation().contactId;
  const edited = service.update(c.admin, c.tenant.id, id, { name: 'Nome mantido', notes: 'Não substituir', tags: ['VIP'], version: 1 });
  service.archive(c.admin, c.tenant.id, id, { version: edited.version }); fillAgenda(c);
  const before = JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts[0]); await c.gateway.receiveMedia(incomingFile(c, session));
  assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 10000); assert.equal(JSON.stringify(c.store.tenant(c.admin, c.tenant.id).contacts[0]), before); assert.equal(c.conversation().contactId, id); assert.equal(c.conversation().contactSyncStatus, 'linked'); assert.equal(c.events[1][3].contactSync, undefined); assert.equal(c.conversation().messages.at(-1).attachments[0].status, 'ready');
});

test('full agenda still stores first media entry privately without adding contact or replaying capture', async t => {
  const c = fixture(t, { media: true }); fillAgenda(c); const session = c.open(), first = await c.gateway.receiveMedia(incomingFile(c, session));
  const conversation = c.conversation(), attachment = conversation.messages[0].attachments[0];
  assert.equal(conversation.contactSyncStatus, 'capacity'); assert.equal(conversation.contactId, undefined); assert.equal(attachment.status, 'ready'); assert.equal(c.store.tenant(c.admin, c.tenant.id).contacts.length, 10000);
  assert.deepEqual((await c.gateway.readMedia({ ...publicInput(c, session), attachmentId: attachment.id })).bytes, photo);
  assert.deepEqual(await c.gateway.receiveMedia(incomingFile(c, session)), { ...first, replayed: true }); assert.equal(c.media.blobs.size, 1); assert.equal(c.events.length, 1); assert.equal(c.conversation().messages.length, 1);
});

test('logo do site do webchat: administrador busca uma vez pela primeira origem https, guarda no canal e não repete dentro do prazo', async t => {
  const asked = [], png = 'data:image/png;base64,iVBORw0KGgo=';
  let answer = { src: png, from: 'https://site.example/apple.png' };
  const c = fixture(t, { siteIcon: async origin => { asked.push(origin); return answer; } });
  const first = await c.gateway.refreshSiteIcon(c.admin, c.tenant.id, 'webchat-qa');
  assert.deepEqual(asked, ['https://site.example']); assert.equal(first.siteIcon.src, png); assert.equal(first.siteIcon.origin, 'https://site.example');
  assert.deepEqual(c.store.tenant(c.admin, c.tenant.id).channels[0].siteIcon, first.siteIcon, 'guardado no canal');
  await c.gateway.refreshSiteIcon(c.admin, c.tenant.id, 'webchat-qa'); assert.equal(asked.length, 1, 'logo encontrado vale 7 dias');
  c.time(7 * 86400_000 + 1); answer = { src: 'data:image/svg+xml;base64,PHN2Zz4=' };
  const svg = await c.gateway.refreshSiteIcon(c.admin, c.tenant.id, 'webchat-qa');
  assert.equal(asked.length, 2); assert.equal(svg.siteIcon.src, null, 'SVG nunca é guardado');
  await c.gateway.refreshSiteIcon(c.admin, c.tenant.id, 'webchat-qa'); assert.equal(asked.length, 2, 'sem logo, nova tentativa só depois de 24 horas');
  c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { origins: ['https://novo.example'], version: c.store.tenant(c.admin, c.tenant.id).channels[0].webchat.version });
  answer = null; const changed = await c.gateway.refreshSiteIcon(c.admin, c.tenant.id, 'webchat-qa');
  assert.deepEqual(asked.slice(-1), ['https://novo.example'], 'origem nova busca de novo'); assert.equal(changed.siteIcon.src, null);
  const row = c.auth.insertUser({ username: 'webchat-synthetic-operator', name: 'Operador sintético' }, Buffer.alloc(16, 2), Buffer.alloc(64, 2), 'operator', [c.tenant.id], 'mep-demo');
  await assert.rejects(c.gateway.refreshSiteIcon(c.auth.actor(row), c.tenant.id, 'webchat-qa'), error => error.status === 403);
  assert.equal(asked.length, 3, 'operador não dispara busca');
});

test('logo do site do webchat: sem origem https não há busca', async t => {
  const asked = [];
  const c = fixture(t, { siteIcon: async origin => { asked.push(origin); return null; } });
  c.gateway.configure(c.admin, c.tenant.id, 'webchat-qa', { origins: ['http://localhost:3000'], version: c.store.tenant(c.admin, c.tenant.id).channels[0].webchat.version });
  assert.deepEqual(await c.gateway.refreshSiteIcon(c.admin, c.tenant.id, 'webchat-qa'), { siteIcon: null }); assert.equal(asked.length, 0);
});
