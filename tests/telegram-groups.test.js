import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { TelegramGateway } from '../src/telegram.js';
import { Outbox } from '../src/outbox.js';
import { createScheduledMessages } from '../src/scheduled-messages.js';
import { MediaService } from '../src/media.js';

const status = expected => error => error.status === expected;
const update = (n, id, text = 'Mensagem sintética', extra = {}) => ({ update_id: n, message: { message_id: n, date: 1750000000, chat: { id, type: id < 0 ? 'group' : 'private', title: 'Grupo <QA>', first_name: 'Visitante' }, from: { id: 80, first_name: 'Participante' }, text, ...extra } });
const member = (n, id, state = 'member', extra = {}) => ({ update_id: n, my_chat_member: { chat: { id, type: 'supergroup', title: 'Grupo sintético' }, new_chat_member: { status: state, user: { id: 123456789, is_bot: true }, ...extra } } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('other-reseller', JSON.stringify({ name: 'Outro workspace sintético', brand: { name: 'QA' } }));
  const createActor = (name, resellerId, role = 'reseller') => auth.actor(auth.insertUser({ username: name, name }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), role, [], resellerId));
  const admin = createActor('telegram-qa-admin', 'mep-demo'), other = createActor('telegram-qa-other', 'other-reseller');
  const operator = createActor('telegram-qa-operator', 'mep-demo', 'operator');
  const tenant = store.createTenant(admin, { name: 'TG RAM A', segment: 'QA' }), second = store.createTenant(other, { name: 'TG RAM B', segment: 'QA' });
  for (const [actor, target, cid] of [[admin, tenant, 'tg-a'], [other, second, 'tg-b']]) store.mutate(actor, target.id, 'Fixture canal', state => { state.channels = [{ id: cid, kind: 'telegram', transport: 'telegram-bot', name: 'Bot sintético', state: 'disconnected' }]; state.conversations = []; });
  const operations = new Operations(store, auth), calls = [], events = [];
  const gateway = new TelegramGateway(store, { authKey: randomBytes(32), polling: false, fetchImpl: async (url, init) => {
    const method = url.split('/').at(-1), payload = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body); calls.push({ method, payload });
    const result = method === 'getMe' ? { id: url.includes('234567890:') ? 234567890 : 123456789, is_bot: true, username: 'synthetic_bot', can_read_all_group_messages: false }
      : method === 'getWebhookInfo' ? { url: '' } : { message_id: 900 + calls.length, chat: { id: Number(payload.chat_id) } };
    return { ok: true, json: async () => ({ ok: true, result }) };
  } });
  gateway.operations = operations; gateway.onIncoming = (...values) => events.push(values);
  await gateway.start(admin, tenant.id, 'tg-a', '123456789:' + 'a'.repeat(35));
  await gateway.start(other, second.id, 'tg-b', '234567890:' + 'b'.repeat(35));
  t.after(async () => { await gateway.close(); store.close(); });
  const state = () => store.tenant(admin, tenant.id), groups = () => gateway.groups(admin, tenant.id, 'tg-a');
  const choose = (ids, mode = 'selected', options) => gateway.setGroups(admin, tenant.id, 'tg-a', { version: groups().version, mode, groupIds: ids }, options);
  const receive = value => gateway.receive(gateway.entries.get('tg-a'), value);
  const take = id => store.mutate(admin, tenant.id, 'Fixture assume', current => { const c = store.getConversation(current, id); c.owner = 'human'; c.assignedUserId = admin.userId; c.version++; return c; });
  return { store, auth, admin, operator, other, tenant, second, gateway, calls, events, groups, choose, state, receive, take, sends: () => calls.filter(call => call.method.startsWith('send')) };
}

async function mediaFixture(t) {
  const f = await fixture(t); await f.receive(update(1, -11)); f.choose(['-11']);
  const conversation = f.take(f.state().conversations[0].id), media = new MediaService(f.store, { directory: null, authKey: randomBytes(32) });
  f.gateway.media = media; let offset = 2;
  return { ...f, conversation, media,
    restrict: flags => f.receive(member(offset++, -11, 'restricted', { is_member: true, ...flags })),
    upload: input => media.upload({ tenantId: f.tenant.id, conversationId: conversation.id, channelId: 'tg-a' }, { name: 'fixture', ...input }),
    body: (attachment, extra = {}) => ({ version: f.state().conversations.find(c => c.id === conversation.id).version, channelId: 'tg-a', text: 'Legenda sintética', attachmentIds: attachment ? [attachment.id] : [], ...extra }) };
}

test('descoberta por membership/conversa guarda somente metadados e separa empresas/canais', async t => {
  const f = await fixture(t); await f.receive(member(1, -11)); await f.receive(update(2, -12, 'Conteúdo que não pertence ao cadastro'));
  f.gateway.receive(f.gateway.entries.get('tg-b'), { ...member(1, -22), my_chat_member: { ...member(1, -22).my_chat_member, new_chat_member: { status: 'member', user: { id: 234567890 } } } });
  assert.equal(f.groups().version, 0); assert.equal(f.groups().mode, 'all'); assert.equal(f.groups().groupReadMode, 'mentions');
  assert.deepEqual(f.groups().groups.map(group => group.id).sort(), ['-11', '-12']);
  assert.equal(f.groups().groups.find(group => group.id === '-11').joined, true);
  assert.equal(f.state().channels[0].telegramGroups.known.some(group => JSON.stringify(group).includes('Conteúdo')), false);
  assert.deepEqual(f.gateway.groups(f.other, f.second.id, 'tg-b').groups.map(group => group.id), ['-22']);
  assert.throws(() => f.gateway.groups(f.admin, f.second.id, 'tg-b'), status(404));
  assert.throws(() => f.choose(['-22']), status(400));
  assert.throws(() => f.gateway.setGroups(f.admin, f.tenant.id, 'tg-b', { version: 0, mode: 'all', groupIds: [] }), status(404));
  // A conversa antiga é descoberta mesmo antes de existir metadata do novo recurso.
  f.store.mutate(f.admin, f.tenant.id, 'Fixture legado', state => { delete state.channels[0].telegramGroups; });
  assert.deepEqual(f.groups().groups.map(group => group.id), ['-12']);
});

test('seleção exige autoridade persistida fresca, campos exatos e CAS, incluindo revogação no commit', async t => {
  const f = await fixture(t); await f.receive(member(1, -11));
  for (const actor of [f.operator, { ...f.admin, supportGrantId: 'synthetic-grant' }, { ...f.admin, kind: 'service' }, { ...f.admin, resellerId: 'other-reseller' }]) assert.throws(() => f.gateway.groups(actor, f.tenant.id, 'tg-a'), status(403));
  for (const body of [{ version: 0, mode: 'selected', groupIds: ['11'] }, { version: 0, mode: 'none', groupIds: [] }, { version: 0, mode: 'all', groupIds: [], tenantId: 'forged' }, { version: '0', mode: 'all', groupIds: [] }]) assert.throws(() => f.gateway.setGroups(f.admin, f.tenant.id, 'tg-a', body), status(400));
  const saved = f.choose(['-11', '-11']); assert.equal(saved.version, 1); assert.deepEqual(saved.groupIds, ['-11']);
  assert.throws(() => f.gateway.setGroups(f.admin, f.tenant.id, 'tg-a', { version: 0, mode: 'all', groupIds: [] }), status(409));
  let checks = 0;
  assert.throws(() => f.choose([], 'selected', { reauthorize: () => { if (++checks === 2) f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.admin.userId); } }), status(403));
  f.store.db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(f.admin.userId);
  assert.equal(f.groups().version, 1); assert.deepEqual(f.groups().groupIds, ['-11']);
  const changed = { ...f.admin };
  assert.throws(() => f.gateway.setGroups(changed, f.tenant.id, 'tg-a', { version: 1, mode: 'all', groupIds: [] }, { reauthorize: () => { changed.userId = f.other.userId; } }), status(403));
  assert.throws(() => f.choose([], 'all', { reauthorize: async () => {} }), status(400));
});

test('grupo excluído avança offset sem criar mensagem, mídia ou automação; diretos e legado seguem', async t => {
  const f = await fixture(t); await f.receive(update(1, -11)); const old = f.state().conversations[0];
  let placeholders = 0, captures = 0; f.gateway.media = { placeholder() { placeholders++; }, capture() { captures++; } };
  f.choose([], 'selected'); await f.receive(update(2, -11, 'Bloqueada', { photo: [{ file_id: 'synthetic-file', width: 1, height: 1 }] }));
  await f.receive(update(3, -12));
  assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-a').next_offset, 4);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM telegram_seen WHERE channel_id=?').get('tg-a').n, 1);
  assert.equal(placeholders, 0); assert.equal(captures, 0); assert.equal(f.events.length, 1);
  assert.equal(f.state().conversations.length, 1); assert.deepEqual(f.state().conversations[0].messages, old.messages);
  assert.ok(f.groups().groups.some(group => group.id === '-12'));
  await f.receive(update(4, 81)); assert.equal(f.state().conversations.length, 2); assert.equal(f.events.length, 2);
  f.choose([], 'all'); await f.receive(update(5, -12)); assert.equal(f.state().conversations.length, 3);
});

test('entrada efêmera ou destinada a usuário não vira mensagem pública, mídia ou automação e confirma offset', async t => {
  const f = await fixture(t), routes = [];
  const routeIncoming = f.gateway.operations.routeIncoming.bind(f.gateway.operations);
  f.gateway.operations.routeIncoming = (...args) => { routes.push(args); return routeIncoming(...args); };
  await f.receive(update(1, -11, 'Histórico público anterior')); f.choose(['-11']);
  const before = JSON.stringify(f.state()), publicMessageId = 999, media = new MediaService(f.store, { directory: null, authKey: randomBytes(32) });
  const usage = media.usage(f.tenant.id); let placeholders = 0, captures = 0, downloads = 0;
  const placeholder = media.placeholder.bind(media), capture = media.capture.bind(media);
  media.placeholder = (...args) => { placeholders++; return placeholder(...args); };
  media.capture = (...args) => { captures++; return capture(...args); };
  f.gateway.media = media; f.gateway.downloadMedia = async () => { downloads++; return Buffer.from([255, 216, 255, 1]); };
  const privateContexts = [
    { message_id: 0, receiver_user: { id: 80, first_name: 'Destinatário privado' }, ephemeral_message_id: 7 },
    { message_id: publicMessageId, receiver_user: { id: 80 } },
    { message_id: publicMessageId, ephemeral_message_id: 8 },
    { message_id: publicMessageId, receiver_user: null },
    { message_id: publicMessageId, ephemeral_message_id: 0 },
    { message_id: publicMessageId, receiver_user: undefined },
    { message_id: publicMessageId, ephemeral_message_id: null }
  ];
  for (let index = 0; index < privateContexts.length; index++) {
    const incoming = update(index + 2, -11, 'Conteúdo privado que nunca deve entrar no grupo', { ...privateContexts[index],
      photo: [{ file_id: 'synthetic-private-photo', width: 1, height: 1, file_size: 4 }] });
    await f.receive(incoming); await f.receive(incoming);
    assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-a').next_offset, index + 3);
    assert.equal(JSON.stringify(f.state()), before);
  }
  await Promise.all(f.gateway.mediaTasks);
  assert.equal(placeholders, 0); assert.equal(captures, 0); assert.equal(downloads, 0);
  assert.equal(media.usage(f.tenant.id), usage); assert.equal(media.blobs.size, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM media_attachments').get().n, 0);
  assert.equal(f.events.length, 1); assert.equal(routes.length, 1); assert.equal(f.sends().length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM telegram_seen WHERE channel_id=?').get('tg-a').n, 1);
  await f.receive(update(privateContexts.length + 2, -11, 'Entrada pública posterior', { message_id: publicMessageId }));
  const current = f.state().conversations[0];
  assert.deepEqual(current.messages.map(message => message.text), ['Histórico público anterior', 'Entrada pública posterior']);
  assert.equal(current.messages.at(-1).externalId, '-11:' + publicMessageId);
  assert.equal(f.events.length, 2); assert.equal(routes.length, 2); assert.equal(media.usage(f.tenant.id), usage);
});

test('IDs de mensagem não positivos ou inválidos avançam offset sem consumir seen, contexto ou cota', async t => {
  const f = await fixture(t), secondBefore = JSON.stringify(f.store.tenant(f.other, f.second.id));
  let placeholders = 0, captures = 0, downloads = 0, routes = 0;
  f.gateway.media = { placeholder() { placeholders++; throw new Error('Unexpected placeholder'); }, capture() { captures++; throw new Error('Unexpected capture'); } };
  f.gateway.downloadMedia = async () => { downloads++; throw new Error('Unexpected download'); };
  const routeIncoming = f.gateway.operations.routeIncoming.bind(f.gateway.operations);
  f.gateway.operations.routeIncoming = (...args) => { routes++; return routeIncoming(...args); };
  const before = JSON.stringify(f.state()), invalidIds = [0, -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, false, {}, []];
  for (let index = 0; index < invalidIds.length; index++) {
    await f.receive(update(index + 1, index % 2 ? 81 : -11, 'Invalid identity private content', { message_id: invalidIds[index],
      voice: { file_id: 'synthetic-invalid-voice', file_size: 4 } }));
    assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-a').next_offset, index + 2);
    assert.equal(JSON.stringify(f.state()), before);
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM telegram_seen').get().n, 0);
  assert.equal(placeholders, 0); assert.equal(captures, 0); assert.equal(downloads, 0); assert.equal(routes, 0); assert.equal(f.events.length, 0);
  assert.equal(JSON.stringify(f.store.tenant(f.other, f.second.id)), secondBefore);
  const entry = f.gateway.entries.get('tg-b');
  await f.gateway.receive(entry, update(1, 81, 'Specific recipient private content', { receiver_user: { id: 81 }, message_id: 1 }));
  assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-b').next_offset, 2);
  assert.equal(JSON.stringify(f.store.tenant(f.other, f.second.id)), secondBefore); assert.equal(routes, 0);
  await f.gateway.receive(entry, update(2, 81, 'Normal direct reply remains available'));
  assert.equal(f.store.tenant(f.other, f.second.id).conversations[0].messages[0].text, 'Normal direct reply remains available');
  assert.equal(routes, 1); assert.equal(f.events.length, 1);
  assert.equal(f.state().conversations.length, 0);
});

test('migração de grupo para supergrupo preserva seleção, atendimento, tópico e histórico', async t => {
  const f = await fixture(t); await f.receive(update(1, -11, 'Original', { message_thread_id: 7 })); f.choose(['-11']);
  const original = f.state().conversations[0], revision = f.groups().version;
  await f.receive(update(2, -11, '', { migrate_to_chat_id: -1001234567890 }));
  assert.deepEqual(f.groups().groupIds, ['-1001234567890']); assert.equal(f.groups().version, revision + 1);
  await f.receive(update(3, -1001234567890, 'No supergrupo', { chat: { id: -1001234567890, type: 'supergroup', title: 'Novo nome' }, message_thread_id: 7, migrate_from_chat_id: -11 }));
  const current = f.state().conversations[0]; assert.equal(f.state().conversations.length, 1); assert.equal(current.id, original.id);
  assert.equal(current.threadId, 7); assert.equal(current.messages.length, 2); assert.equal(current.messages[0].id, original.messages[0].id);
  assert.equal(current.remoteChatId, '-1001234567890'); assert.ok(current.chatAliases.includes('-11'));
  assert.equal(f.groups().groups.length, 1); assert.equal(f.groups().groups[0].selected, true);
});

test('revogar grupo durante resolução de arquivo bloqueia envio antes de mensagem/outbox/provider', async t => {
  const f = await fixture(t); await f.receive(update(1, -11)); f.choose(['-11']);
  const current = f.take(f.state().conversations[0].id), pending = deferred(), entered = deferred(); let resolves = 0;
  f.gateway.media = { resolve: async () => { resolves++; entered.resolve(); return pending.promise; } };
  const outbox = new Outbox(f.store, { authorize: (actor, tid, c) => f.gateway.operations.canReply(actor, tid, c) });
  const body = { version: current.version, channelId: 'tg-a', text: 'Anexo', attachmentIds: ['12345678-1234-4234-8234-123456789012'], idempotencyKey: 'synthetic-group-send' };
  const sending = outbox.dispatch(f.admin, f.tenant.id, current.id, body, () => f.gateway.send(f.admin, f.tenant.id, current.id, body));
  await entered.promise; assert.equal(resolves, 1); f.choose([]);
  pending.resolve([{ metadata: { id: 'synthetic-media', kind: 'document', mime: 'text/plain', name: 'qa.txt', size: 2 }, bytes: Buffer.from('QA') }]);
  await assert.rejects(sending, status(409)); assert.equal(f.sends().length, 0); assert.equal(f.state().conversations[0].messages.length, 1);
  assert.equal(outbox.list(f.admin, f.tenant.id)[0].state, 'failed');
  await assert.rejects(outbox.dispatch(f.admin, f.tenant.id, current.id, body, () => f.gateway.send(f.admin, f.tenant.id, current.id, body)), status(409));
  assert.equal(resolves, 1);
  await assert.rejects(f.gateway.send(f.admin, f.tenant.id, current.id, { ...body, attachmentIds: [] }), status(409));
  assert.equal(f.sends().length, 0);
});

test('membership left/kicked/restricted bloqueia saída e reentrada restaura envio selecionado', async t => {
  const f = await fixture(t); await f.receive(update(1, -11)); f.choose(['-11']); const c = f.take(f.state().conversations[0].id);
  await f.receive(member(2, -11, 'left')); assert.equal(f.groups().groups[0].joined, false);
  await assert.rejects(f.gateway.send(f.admin, f.tenant.id, c.id, { version: c.version, channelId: 'tg-a', text: 'Não enviar' }), status(409));
  await f.receive(member(3, -11, 'restricted', { is_member: true, can_send_messages: false }));
  await f.receive(update(4, -11, 'Entrada permitida')); assert.equal(f.state().conversations[0].messages.length, 2);
  await assert.rejects(f.gateway.send(f.admin, f.tenant.id, c.id, { version: f.state().conversations[0].version, channelId: 'tg-a', text: 'Não enviar' }), status(409));
  await f.receive(member(5, -11));
  const result = await f.gateway.send(f.admin, f.tenant.id, c.id, { version: f.state().conversations[0].version, channelId: 'tg-a', text: 'Autorizada', attachmentIds: [] });
  assert.equal(result.messages.at(-1).delivery, 'sent'); assert.equal(f.sends().length, 1); assert.equal(f.groups().groups[0].joined, true);
  await f.receive(member(6, -11, 'kicked')); assert.throws(() => f.gateway.assertGroupAllowed(f.admin, f.tenant.id, 'tg-a', '-11'), status(409));
});

test('permissões restritas independentes permitem foto com legenda mesmo sem texto e negam texto antes da outbox', async t => {
  const f = await mediaFixture(t);
  await f.restrict({ can_send_messages: false, can_send_photos: true, can_send_audios: false, can_send_documents: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false });
  const group = f.groups().groups[0];
  assert.equal(group.canSend, true);
  assert.deepEqual(group.sendPermissions, { text: false, photos: true, audios: false, documents: false, videos: false, videoNotes: false, voiceNotes: false });
  assert.deepEqual(f.gateway.replyPolicy(f.admin, f.tenant.id, f.conversation.id), { allowed: true, sendPermissions: group.sendPermissions });
  const outbox = new Outbox(f.store, { authorize: (actor, tid, c) => f.gateway.operations.canReply(actor, tid, c) });
  const dispatch = input => outbox.dispatch(f.admin, f.tenant.id, f.conversation.id, input, () => f.gateway.send(f.admin, f.tenant.id, f.conversation.id, input), { validate: () => f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, input) });
  let reads = 0; const read = f.media.read.bind(f.media); f.media.read = (...args) => { reads++; return read(...args); };
  const before = structuredClone(f.state().conversations[0]);
  await assert.rejects(dispatch(f.body(null, { idempotencyKey: 'group-permission-text-denied' })), status(409));
  assert.equal(outbox.list(f.admin, f.tenant.id).length, 0); assert.equal(reads, 0); assert.equal(f.sends().length, 0);
  assert.deepEqual(f.state().conversations[0], before);
  const photo = await f.upload({ mime: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 1]) }), input = f.body(photo, { idempotencyKey: 'group-permission-photo-allowed' });
  const result = await dispatch(input); assert.equal(result.messages.at(-1).delivery, 'sent');
  assert.equal(f.sends().at(-1).method, 'sendPhoto'); assert.equal(f.sends().at(-1).payload.caption, 'Legenda sintética');
  await f.restrict({ can_send_messages: false, can_send_photos: false, can_send_audios: false, can_send_documents: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false });
  assert.equal(f.groups().groups[0].canSend, false);
  await dispatch(input); assert.equal(f.sends().length, 1); assert.equal(outbox.list(f.admin, f.tenant.id)[0].attempts, 1);
  f.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), f.admin.userId);
  await assert.rejects(dispatch(input), status(403)); assert.equal(f.sends().length, 1);
});

test('permissão acompanha método nativo e fallback real, incluindo Opus, Vorbis, GIF e vídeo WebM', async t => {
  const f = await mediaFixture(t), deny = { can_send_messages: true, can_send_photos: false, can_send_audios: false, can_send_documents: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false };
  const fixtures = [
    { mime: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 1]), permission: 'can_send_photos', method: 'sendPhoto' },
    { mime: 'audio/mpeg', bytes: Buffer.from('ID3fixture'), permission: 'can_send_audios', method: 'sendAudio' },
    { mime: 'audio/ogg', bytes: Buffer.from('OggSfixtureOpusHead'), permission: 'can_send_voice_notes', method: 'sendVoice' },
    { mime: 'audio/ogg', bytes: Buffer.from('OggSfixtureVorbis'), permission: 'can_send_documents', method: 'sendDocument' },
    { mime: 'image/gif', bytes: Buffer.from('GIF89afixture'), permission: 'can_send_documents', method: 'sendDocument' },
    { mime: 'video/webm', bytes: Buffer.from([26, 69, 223, 163, 1]), permission: 'can_send_documents', method: 'sendDocument' },
    { mime: 'video/mp4', bytes: Buffer.from('0000ftypfixture'), permission: 'can_send_videos', method: 'sendVideo' },
    { mime: 'audio/wav', bytes: Buffer.from('RIFF0000WAVEfixture'), permission: 'can_send_documents', method: 'sendDocument' }
  ];
  for (const sample of fixtures) {
    const attachment = await f.upload(sample); await f.restrict(deny);
    const before = structuredClone(f.state().conversations[0]), input = f.body(attachment);
    await assert.rejects(f.gateway.send(f.admin, f.tenant.id, f.conversation.id, input), status(409));
    assert.deepEqual(f.state().conversations[0], before);
    const count = f.sends().length;
    await f.restrict({ ...deny, can_send_messages: false, [sample.permission]: true });
    const result = await f.gateway.send(f.admin, f.tenant.id, f.conversation.id, f.body(attachment));
    assert.equal(result.messages.at(-1).delivery, 'sent'); assert.equal(f.sends().length, count + 1); assert.equal(f.sends().at(-1).method, sample.method);
  }
  // MIME OGG sozinho é ambíguo; a decisão por bytes não pode cair para documento para contornar voz negada.
  await f.restrict({ ...deny, can_send_documents: true, can_send_voice_notes: false });
  const opus = await f.upload(fixtures[2]); let policyChecks = 0;
  const original = f.gateway.assertGroupAllowed.bind(f.gateway);
  f.gateway.assertGroupAllowed = (...args) => { if (args[4]?.method === 'sendVoice') policyChecks++; return original(...args); };
  f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, f.body(opus));
  const before = structuredClone(f.state().conversations[0]), count = f.sends().length;
  await assert.rejects(f.gateway.send(f.admin, f.tenant.id, f.conversation.id, f.body(opus)), status(409));
  assert.ok(policyChecks > 0); assert.equal(f.sends().length, count); assert.deepEqual(f.state().conversations[0], before);
  const outbox = new Outbox(f.store, { authorize: (actor, tid, c) => f.gateway.operations.canReply(actor, tid, c) });
  const intent = f.body(opus, { idempotencyKey: 'group-ogg-ambiguous-denied' });
  const dispatch = () => outbox.dispatch(f.admin, f.tenant.id, f.conversation.id, intent, () => f.gateway.send(f.admin, f.tenant.id, f.conversation.id, intent), { validate: () => f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, intent) });
  await assert.rejects(dispatch(), status(409));
  assert.equal(outbox.list(f.admin, f.tenant.id)[0].state, 'failed'); assert.equal(outbox.list(f.admin, f.tenant.id)[0].attempts, 1);
  await assert.rejects(dispatch(), status(409)); assert.equal(outbox.list(f.admin, f.tenant.id).length, 1);
  assert.equal(f.sends().length, count); assert.deepEqual(f.state().conversations[0], before);
});

test('revogar tipo de mídia durante resolve bloqueia pending e provider com autoridade fresca', async t => {
  const f = await mediaFixture(t); await f.restrict({ can_send_messages: true, can_send_photos: true });
  const photo = await f.upload({ mime: 'image/jpeg', bytes: Buffer.from([255, 216, 255, 1]) }), entered = deferred(), released = deferred();
  const resolve = f.media.resolve.bind(f.media);
  f.media.resolve = async (...args) => { entered.resolve(); await released.promise; return resolve(...args); };
  let checks = 0; const before = structuredClone(f.state().conversations[0]);
  const sending = f.gateway.send(f.admin, f.tenant.id, f.conversation.id, f.body(photo), { reauthorize: () => { checks++; } });
  await entered.promise; await f.restrict({ can_send_messages: true, can_send_photos: false }); released.resolve();
  await assert.rejects(sending, status(409)); assert.ok(checks >= 2);
  assert.equal(f.sends().length, 0); assert.deepEqual(f.state().conversations[0], before);
  assert.equal(f.media.metadata(photo.id, { tenantId: f.tenant.id, conversationId: f.conversation.id, channelId: 'tg-a' }).status, 'ready');
});

test('DTO preserva desconhecido, flags malformadas e permissões granulares na migração sem herdar outro canal', async t => {
  const f = await mediaFixture(t), none = { text: null, photos: null, audios: null, documents: null, videos: null, videoNotes: null, voiceNotes: null };
  assert.deepEqual(f.groups().groups[0].sendPermissions, none); assert.equal(f.groups().groups[0].canSend, null);
  await f.restrict({ can_send_messages: false, can_send_photos: true, can_send_voice_notes: 'false', can_send_audios: 1 });
  assert.equal(f.groups().groups[0].sendPermissions.text, false); assert.equal(f.groups().groups[0].sendPermissions.voiceNotes, null);
  assert.equal(f.groups().groups[0].sendPermissions.audios, null);
  const before = f.groups().groups[0].sendPermissions;
  await f.receive(update(100, -11, '', { migrate_to_chat_id: -100999 }));
  assert.deepEqual(f.groups().groups[0].sendPermissions, before); assert.deepEqual(f.groups().groupIds, ['-100999']);
  f.store.mutate(f.admin, f.tenant.id, 'Fixture granular legado', state => { const group = state.channels[0].telegramGroups.known[0]; delete group.sendPermissions; group.canSend = false; });
  assert.deepEqual(f.groups().groups[0].sendPermissions, { ...none, text: false }); assert.equal(f.groups().groups[0].canSend, null);
  const directEntry = f.gateway.entries.get('tg-b'); await f.gateway.receive(directEntry, update(1, 81, 'Conversa direta sintética'));
  const direct = f.store.tenant(f.other, f.second.id).conversations[0];
  assert.equal(f.gateway.replyPolicy(f.other, f.second.id, direct.id).allowed, true);
  assert.throws(() => f.gateway.replyPolicy(f.admin, f.second.id, direct.id), status(404));
  await f.receive(member(101, -100999, 'restricted', { is_member: true, can_send_messages: false, can_send_photos: false, can_send_audios: false, can_send_documents: false, can_send_videos: false, can_send_voice_notes: false, can_send_video_notes: true }));
  assert.equal(f.groups().groups[0].sendPermissions.videoNotes, true); assert.equal(f.groups().groups[0].canSend, false);
  assert.equal(f.gateway.replyPolicy(f.admin, f.tenant.id, f.conversation.id).allowed, false);
  assert.throws(() => f.gateway.assertGroupAllowed(f.admin, f.tenant.id, 'tg-a', '-100999', { method: 'sendVideoNote' }), status(400));
});

test('preflight usa upload pronto e escopo real sem ler bytes de anexo recebido ou de outro atendimento', async t => {
  const f = await mediaFixture(t); await f.restrict({ can_send_messages: true, can_send_documents: true });
  let reads = 0; const read = f.media.read.bind(f.media); f.media.read = (...args) => { reads++; return read(...args); };
  const context = { tenantId: f.tenant.id, conversationId: f.conversation.id, channelId: 'tg-a' };
  const incoming = f.media.placeholder(context, { kind: 'document', mime: 'text/plain', size: 2 }); await f.media.capture(incoming.id, context, async () => Buffer.from('QA'));
  assert.throws(() => f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, f.body(incoming)), status(404));
  await f.receive(update(50, 81)); const other = f.state().conversations.find(c => c.remoteChatId === '81');
  const otherFile = await f.media.upload({ ...context, conversationId: other.id }, { bytes: Buffer.from('QA'), mime: 'text/plain' });
  assert.throws(() => f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, f.body(otherFile)), status(404));
  const ready = await f.upload({ bytes: Buffer.from('QA'), mime: 'text/plain' });
  assert.equal(f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, f.body(ready)).content, 'Legenda sintética');
  const row = f.store.db.prepare('SELECT metadata FROM media_attachments WHERE id=?').get(ready.id);
  const pendingMetadata = { ...JSON.parse(row.metadata), status: 'pending' };
  f.store.db.prepare('UPDATE media_attachments SET metadata=? WHERE id=?').run(JSON.stringify(pendingMetadata), ready.id);
  assert.throws(() => f.gateway.validateOutgoing(f.admin, f.tenant.id, f.conversation.id, f.body(ready)), status(409));
  assert.equal(reads, 0); assert.equal(f.sends().length, 0);
});

test('agenda real revalida seleção no adapter e encerra falha sem disparar nem repetir automaticamente', async t => {
  const f = await fixture(t); await f.receive(update(1, -11)); f.choose(['-11']); const c = f.take(f.state().conversations[0].id);
  let clock = Date.parse('2026-10-03T12:00:00Z');
  const outbox = new Outbox(f.store, { authorize: (actor, tid, conversation) => f.gateway.operations.canReply(actor, tid, conversation) });
  const scheduler = createScheduledMessages(f.store, {
    now: () => clock,
    authorize: (actor, tid, conversation, permission) => f.auth.can(actor, permission, { tenantId: tid, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' }),
    resolveActor: (userId, resellerId) => f.auth.workspaceActor({ userId, resellerId }, resellerId),
    send: (actor, tid, cid, input) => outbox.dispatch(actor, tid, cid, input, () => f.gateway.send(actor, tid, cid, input))
  });
  scheduler.create(f.admin, f.tenant.id, c.id, { version: c.version, text: 'Intent agendado sintético', commandId: 'group-schedule-qa', dueAt: new Date(clock + 60000).toISOString() });
  f.choose([]); clock += 60000;
  assert.equal((await scheduler.tick()).failed, 1); assert.equal(f.sends().length, 0);
  assert.equal(scheduler.list(f.admin, f.tenant.id, c.id)[0].state, 'failed');
  f.choose(['-11']); assert.equal((await scheduler.tick()).processed, 0); assert.equal(f.sends().length, 0);
  assert.equal(f.state().conversations[0].messages.length, 1); await scheduler.waitIdle();
});

test('migração não apaga estado de saída do bot quando destino conhecido ainda não tem membership', async t => {
  const f = await fixture(t); await f.receive(update(1, -11)); await f.receive(member(2, -11, 'left'));
  await f.receive(update(3, -100999, '')); f.choose(['-11']);
  await f.receive(update(4, -11, '', { migrate_to_chat_id: -100999 }));
  assert.deepEqual(f.groups().groupIds, ['-100999']); assert.equal(f.groups().groups.length, 1);
  assert.equal(f.groups().groups[0].joined, false); assert.equal(f.groups().groups[0].memberStatus, 'left');
  assert.throws(() => f.gateway.assertGroupAllowed(f.admin, f.tenant.id, 'tg-a', '-100999'), status(409));
});

test('colisão de migração preserva contatos e dois históricos, confirma offset e bloqueia ambos os destinos', async t => {
  const f = await fixture(t); await f.receive(update(1, -11, 'Histórico original A')); await f.receive(update(2, -100999, 'Histórico original B'));
  for (const c of f.state().conversations) f.take(c.id);
  f.choose(['-11']);
  const before = f.state(), histories = structuredClone(before.conversations), contacts = structuredClone(before.contacts), revision = f.groups().version;
  assert.equal(new Set(histories.map(c => c.contactId)).size, 2);
  await f.receive(update(3, -11, '', { migrate_to_chat_id: -100999 }));
  assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-a').next_offset, 4);
  assert.deepEqual(f.state().conversations, histories); assert.deepEqual(f.state().contacts, contacts);
  assert.deepEqual(f.groups().groupIds, ['-11']); assert.equal(f.groups().version, revision + 1);
  assert.deepEqual(f.groups().migrationConflicts, [{ fromGroupId: '-11', toGroupId: '-100999' }]);
  assert.equal(f.groups().groups.every(group => group.migrationConflict && group.canSend === false), true);
  let media = 0; f.gateway.media = { placeholder() { media++; } };
  await f.receive(update(4, -100999, 'Não ingerir', { photo: [{ file_id: 'synthetic-conflict-file' }] }));
  await f.receive(update(5, -11, 'Não ingerir origem'));
  for (const c of histories) await assert.rejects(f.gateway.send(f.admin, f.tenant.id, c.id, { version: c.version, channelId: 'tg-a', text: 'Não enviar ao chat errado' }), status(409));
  assert.equal(f.sends().length, 0); assert.equal(media, 0); assert.deepEqual(f.state().conversations, histories);
  assert.equal(f.events.length, 2);
  // Membership ou escolher explicitamente ambos não resolve um vínculo ambíguo.
  await f.receive(member(6, -100999)); f.choose(['-11', '-100999']); await f.receive(update(7, -100999, 'Ainda bloqueada'));
  assert.deepEqual(f.state().conversations, histories);
  assert.throws(() => f.gateway.setGroups(f.admin, f.tenant.id, 'tg-a', { version: f.groups().version, mode: 'all', groupIds: [], migrationConflicts: [] }), status(400));
  await f.receive(update(8, -100999, '', { migrate_from_chat_id: -11 }));
  assert.equal(f.groups().migrationConflicts.length, 1); assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-a').next_offset, 9);
  assert.deepEqual(f.state().contacts, contacts);
  assert.deepEqual(f.gateway.groups(f.other, f.second.id, 'tg-b').migrationConflicts, []);
  await f.receive(update(9, -100999, '', { migrate_to_chat_id: -100888 })); await f.receive(update(10, -100888, 'Destino de cadeia também bloqueado'));
  assert.equal(f.groups().migrationConflicts.length, 2); assert.deepEqual(f.groups().groupIds, ['-11', '-100999']);
  assert.equal(f.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get('tg-a').next_offset, 11);
  assert.deepEqual(f.state().conversations, histories); assert.deepEqual(f.state().contacts, contacts);
});

test('migração recusada no envio não redireciona para destino com outro contato nem reenvia pelo outbox', async t => {
  const f = await fixture(t); await f.receive(update(1, -11, 'Original A')); await f.receive(update(2, -100999, 'Original B')); f.choose(['-11']);
  const original = f.take(f.state().conversations.find(c => c.remoteChatId === '-11').id), destination = f.state().conversations.find(c => c.remoteChatId === '-100999'), contacts = structuredClone(f.state().contacts);
  const fetchOriginal = f.gateway.fetch;
  f.gateway.fetch = async (url, init) => {
    if (!url.endsWith('/sendMessage')) return fetchOriginal(url, init);
    f.calls.push({ method: 'sendMessage', payload: JSON.parse(init.body) });
    return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, parameters: { migrate_to_chat_id: -100999 } }) };
  };
  const outbox = new Outbox(f.store, { authorize: (actor, tid, c) => f.gateway.operations.canReply(actor, tid, c) });
  const input = { version: original.version, text: 'Tentativa no grupo original', channelId: 'tg-a', idempotencyKey: 'synthetic-migration-collision-send' };
  await assert.rejects(outbox.dispatch(f.admin, f.tenant.id, original.id, input, () => f.gateway.send(f.admin, f.tenant.id, original.id, input)), error => error.status === 409 && /vínculos conflitantes/.test(error.message));
  assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].payload.chat_id, '-11'); assert.equal(outbox.list(f.admin, f.tenant.id)[0].state, 'failed');
  const current = f.state().conversations.find(c => c.id === original.id);
  assert.equal(current.remoteChatId, original.remoteChatId); assert.deepEqual(current.chatAliases, original.chatAliases);
  assert.deepEqual(current.messages.slice(0, original.messages.length), original.messages); assert.equal(current.messages.at(-1).delivery, 'failed');
  assert.deepEqual(f.state().conversations.find(c => c.id === destination.id), destination); assert.deepEqual(f.state().contacts, contacts);
  assert.deepEqual(f.groups().groupIds, ['-11']);
  await assert.rejects(outbox.dispatch(f.admin, f.tenant.id, original.id, input, () => f.gateway.send(f.admin, f.tenant.id, original.id, input)), status(409));
  await assert.rejects(f.gateway.send(f.admin, f.tenant.id, original.id, { ...input, version: current.version }), status(409)); assert.equal(f.sends().length, 1);
});
