import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv, createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { getMediaKeys } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { MediaService, MAX_MEDIA_BYTES } from '../src/media.js';
import { WhatsAppGateway, downloadWhatsAppMedia } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', userId: 'fixture-user', name: 'Atendente QA' };
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('Imagem de fixture sintética')]);
const jpeg = Buffer.from([255, 216, 255, 224, 0, 1, 2, 3]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture')]);
const opus = Buffer.alloc(47);
opus.write('OggS'); opus[5] = 2; opus[26] = 1; opus[27] = 19;
opus.write('OpusHead', 28); opus[36] = 1; opus[37] = 1; opus.writeUInt32LE(48000, 40);
const status = code => error => error.status === code;
function setup(t, kind, { download, fetchImpl } = {}) {
  const store = new Store(':memory:'), key = randomBytes(32), tenant = store.createTenant(actor, { name: 'Mídia transport QA', segment: 'Fixture sintética' });
  const channelId = kind === 'wa' ? 'wa-fixture' : 'tg-fixture';
  store.mutate(actor, tenant.id, 'Fixture canal', state => state.channels.push(kind === 'wa' ? { id: channelId, kind: 'whatsapp_qr', transport: 'baileys', allowedGroups: ['120363099999999@g.us'], groupNames: { '120363099999999@g.us': 'Grupo QA' } } : { id: channelId, kind: 'telegram', transport: 'telegram-bot' }));
  const media = new MediaService(store, { directory: null, authKey: key }), sends = [], requests = [], routes = [], hooks = [];
  const telegramFetch = fetchImpl || (async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET') return { ok: true, headers: new Headers({ 'content-length': String(jpeg.length) }), body: Readable.from([jpeg]) };
    const method = url.split('/').at(-1), payload = options.body instanceof FormData ? options.body : JSON.parse(options.body);
    if (payload instanceof FormData) sends.push({ method, payload });
    const result = method === 'getFile' ? { file_path: 'photos/fixture.jpg', file_size: jpeg.length } : { message_id: sends.length + 80, chat: { id: Number(payload instanceof FormData ? payload.get('chat_id') : payload.chat_id) } };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  });
  const gateway = kind === 'wa' ? new WhatsAppGateway(store, { authKey: key, socketFactory: () => { throw new Error('Sem rede'); }, downloadMediaImpl: download || (async () => png) }) : new TelegramGateway(store, { authKey: key, polling: false, fetchImpl: telegramFetch });
  const socket = { user: { id: '5511900000000@s.whatsapp.net' }, end() {}, sendMessage: async (jid, content, options) => { sends.push({ jid, content, options }); return { key: { id: options.messageId } }; } };
  const entry = { channelId, tenantId: tenant.id, actor: gateway.actor('mep-demo'), state: 'connected', matched: true, generation: 1, socket, abort: new AbortController(), token: '123456789:' + 'a'.repeat(35) };
  gateway.entries.set(channelId, entry); gateway.media = media;
  gateway.onIncoming = (...args) => hooks.push(args);
  gateway.operations = { routeIncoming: (...args) => routes.push(args), canReply: () => {} };
  t.after(async () => { await gateway.close(); store.close(); });
  const state = () => store.tenant(actor, tenant.id), context = conversationId => ({ tenantId: tenant.id, conversationId, channelId });
  const take = id => store.mutate(actor, tenant.id, 'Fixture assumir', tenant => { const current = store.getConversation(tenant, id); current.owner = 'human'; current.assignedUserId = actor.userId; current.version++; return current; });
  const settle = async () => { await Promise.allSettled([...gateway.mediaTasks]); };
  return { store, key, tenant, media, gateway, entry, socket, sends, requests, routes, hooks, state, context, take, settle, channelId };
}
const waMessage = (id, inner, extra = {}) => ({ key: { id, remoteJid: '120363099999999@g.us', participant: '5511900000001@s.whatsapp.net', ...extra }, message: inner, pushName: 'Participante QA', messageTimestamp: 1750000000 });
const tgMessage = (id, extra = {}) => ({ update_id: id, message: { message_id: id, date: 1750000000, chat: { id: -1000001, type: 'supergroup', title: 'Grupo QA' }, from: { id: 1001, first_name: 'Participante' }, message_thread_id: 72, ...extra } });

test('WhatsApp recebe arquivo sem texto no grupo, deduplica e executa hook antes da distribuição', async t => {
  let downloads = 0;
  const c = setup(t, 'wa', { download: async () => { downloads++; return png; } });
  const order = [];
  c.gateway.onIncoming = (entry, cid, mid, meta) => { order.push('hook'); c.hooks.push([entry, cid, mid, meta]); };
  c.gateway.operations.routeIncoming = () => order.push('route');
  const incoming = waMessage('media-1', { imageMessage: { mimetype: 'image/png', fileLength: png.length, url: 'https://provider.invalid/secret', mediaKey: randomBytes(32) } });
  await c.gateway.receive(c.entry, incoming); await c.settle();
  const conversation = c.state().conversations[0], message = conversation.messages[0];
  assert.equal(conversation.remoteJid, '120363099999999@g.us'); assert.equal(conversation.conversationKind, 'group');
  assert.equal(message.text, ''); assert.equal(message.senderName, 'Participante QA'); assert.equal(message.attachments[0].status, 'ready');
  assert.equal(JSON.stringify(message.attachments).includes('secret'), false); assert.deepEqual(order, ['hook', 'route']);
  assert.equal(c.hooks[0][3].newConversation, true); assert.equal(c.hooks[0][3].reopened, false);
  await c.gateway.receive(c.entry, incoming); await c.settle(); assert.equal(downloads, 1); assert.equal(c.state().conversations[0].messages.length, 1);
  c.store.mutate(actor, c.tenant.id, 'Fixture encerrar', tenant => tenant.conversations[0].status = 'closed');
  await c.gateway.receive(c.entry, waMessage('media-2', { conversation: 'Reabertura' }));
  assert.equal(c.hooks[1][3].reopened, true);
  await c.gateway.receive(c.entry, waMessage('media-from-me', { conversation: 'Eco do aparelho' }, { fromMe: true }));
  assert.equal(c.hooks.length, 2);
});

test('WhatsApp falha de mídia e visualização única preservam legenda sem retenção extra', async t => {
  let downloads = 0;
  const c = setup(t, 'wa', { download: async () => { downloads++; throw new Error('Token sensível fictício'); } });
  await c.gateway.receive(c.entry, waMessage('failed', { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Texto preservado', fileName: '../documento.pdf', mimetype: 'application/pdf', fileLength: 11 } } } }));
  await c.settle();
  const first = c.state().conversations[0].messages[0]; assert.equal(first.text, 'Texto preservado'); assert.equal(first.attachments[0].status, 'unavailable'); assert.equal(first.attachments[0].name, 'documento.pdf');
  await c.gateway.receive(c.entry, waMessage('once', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/png', caption: 'Visualização única', fileLength: png.length } } } }));
  await c.settle();
  assert.equal(downloads, 1); assert.equal(c.state().conversations[0].messages[1].attachments[0].status, 'unavailable');
  assert.equal(JSON.stringify(c.state().conversations[0].messages).includes('Token sensível'), false);
});

test('WhatsApp envia foto/documento/áudio/vídeo em único disparo no grupo original; legenda de áudio é recusada', async t => {
  const c = setup(t, 'wa');
  await c.gateway.receive(c.entry, waMessage('text', { conversation: 'Fixture' }));
  const conversation = c.take(c.state().conversations[0].id);
  for (const fixture of [{ kind: 'image', mime: 'image/png', bytes: png, text: 'Foto QA' }, { kind: 'document', mime: 'application/pdf', bytes: Buffer.from('%PDF-fixture'), text: 'Documento QA' }, { kind: 'audio', mime: 'audio/ogg', bytes: opus, text: '' }, { kind: 'video', mime: 'video/mp4', bytes: mp4, text: 'Vídeo QA' }]) {
    const metadata = await c.media.upload(c.context(conversation.id), { ...fixture, name: fixture.kind + '.fixture' });
    const version = c.state().conversations[0].version;
    if (fixture.kind === 'audio') await assert.rejects(c.gateway.send(actor, c.tenant.id, conversation.id, { version, channelId: c.channelId, attachmentIds: [metadata.id], text: 'Não perder texto' }), status(400));
    await c.gateway.send(actor, c.tenant.id, conversation.id, { version, channelId: c.channelId, attachmentIds: [metadata.id], text: fixture.text });
    const sent = c.sends.at(-1); assert.equal(sent.jid, '120363099999999@g.us'); assert.deepEqual(sent.content[fixture.kind], fixture.bytes); assert.equal(sent.content.mimetype, fixture.kind === 'audio' ? 'audio/ogg; codecs=opus' : fixture.mime);
    assert.equal(sent.content.ptt, fixture.kind === 'audio' ? true : undefined);
    if (fixture.text) assert.equal(sent.content.caption, fixture.text);
    const recorded = c.state().conversations[0].messages.at(-1); assert.equal(recorded.authorUserId, actor.userId); assert.equal(recorded.attachments[0].id, metadata.id); assert.equal(recorded.delivery, 'sent');
  }
  assert.equal(c.sends.length, 4);
});

test('WhatsApp identifica voz pelo primeiro pacote Ogg Opus; nome e marcador solto não ativam ptt', async t => {
  const c = setup(t, 'wa');
  await c.gateway.receive(c.entry, waMessage('voice-seed', { conversation: 'Fixture' }));
  const conversation = c.take(c.state().conversations[0].id);
  const spoofed = Buffer.from(opus); spoofed[28] = 0;
  const marker = Buffer.concat([Buffer.from('OggSfixture de outro codec'), Buffer.from('OpusHead')]);
  for (const fixture of [{ mime: 'audio/ogg', bytes: opus, ptt: true }, { mime: 'audio/ogg', bytes: spoofed }, { mime: 'audio/ogg', bytes: marker }, { mime: 'audio/mpeg', bytes: Buffer.from('ID3OpusHead') }, { mime: 'audio/webm', bytes: Buffer.concat([Buffer.from([26, 69, 223, 163]), Buffer.from('OpusHead')]) }]) {
    const metadata = await c.media.upload(c.context(conversation.id), { ...fixture, name: 'Mensagem de voz.ogg' });
    await c.gateway.send(actor, c.tenant.id, conversation.id, { version: c.state().conversations[0].version, channelId: c.channelId, attachmentIds: [metadata.id], text: '' });
    assert.equal(c.sends.at(-1).content.ptt, fixture.ptt);
    assert.equal(c.sends.at(-1).content.mimetype, fixture.ptt ? 'audio/ogg; codecs=opus' : fixture.mime);
    assert.deepEqual(c.sends.at(-1).content.audio, fixture.bytes);
  }
  assert.equal(c.sends.length, 5);
});

test('WhatsApp valida versão novamente após ler arquivo e cancela antes do provider', async t => {
  const c = setup(t, 'wa'); await c.gateway.receive(c.entry, waMessage('seed', { conversation: 'Fixture' }));
  const conversation = c.take(c.state().conversations[0].id), metadata = await c.media.upload(c.context(conversation.id), { bytes: png, mime: 'image/png' });
  const resolve = c.media.resolve.bind(c.media);
  c.media.resolve = async (...args) => { const result = await resolve(...args); c.store.mutate(actor, c.tenant.id, 'Fixture transferência concorrente', tenant => { tenant.conversations[0].owner = 'queue'; tenant.conversations[0].version++; }); return result; };
  await assert.rejects(c.gateway.send(actor, c.tenant.id, conversation.id, { version: conversation.version, channelId: c.channelId, attachmentIds: [metadata.id], text: '' }), status(409));
  assert.equal(c.sends.length, 0); assert.equal(c.state().conversations[0].messages.length, 1);
});

test('download WhatsApp usa origem fixa, timeout, HMAC e SHA do contrato Baileys', async () => {
  const mediaKey = randomBytes(32), keys = await getMediaKeys(mediaKey, 'image'), cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(png), cipher.final()]), mac = createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10), encrypted = Buffer.concat([ciphertext, mac]);
  const item = { type: 'image', node: { directPath: '/fixture.enc', mediaKey, fileLength: png.length, fileSha256: createHash('sha256').update(png).digest(), fileEncSha256: createHash('sha256').update(encrypted).digest() } };
  let calls = 0;
  const fetchImpl = async (url, options) => { calls++; assert.equal(url, 'https://mmg.whatsapp.net/fixture.enc'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal); return { ok: true, headers: new Headers(), body: Readable.from([encrypted]) }; };
  assert.deepEqual(await downloadWhatsAppMedia(item, { fetchImpl }), png);
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(downloadWhatsAppMedia(item, { fetchImpl: async () => ({ ok: true, headers: new Headers(), body: Readable.from([tampered]) }) }), status(400));
  await assert.rejects(downloadWhatsAppMedia({ ...item, node: { ...item.node, directPath: undefined, url: 'http://127.0.0.1/secret' } }, { fetchImpl }), status(400));
  await assert.rejects(downloadWhatsAppMedia({ ...item, node: { ...item.node, fileLength: MAX_MEDIA_BYTES + 1 } }, { fetchImpl }), status(413));
  assert.equal(calls, 1);
});

test('Telegram recebe foto sem texto no tópico, deduplica e não expõe file_id/URL/token', async t => {
  const c = setup(t, 'tg'), incoming = tgMessage(1, { photo: [{ file_id: 'small-secret', file_size: 1 }, { file_id: 'large-secret', file_size: jpeg.length }] });
  c.gateway.receive(c.entry, incoming); await c.settle();
  const conversation = c.state().conversations[0], message = conversation.messages[0];
  assert.equal(conversation.threadId, 72); assert.equal(conversation.remoteChatId, '-1000001'); assert.equal(message.text, ''); assert.equal(message.attachments[0].status, 'ready');
  assert.equal(c.requests.filter(item => item.options.method === 'GET').length, 1);
  const getFile = c.requests.find(item => item.url.endsWith('/getFile')); assert.equal(JSON.parse(getFile.options.body).file_id, 'large-secret');
  assert.equal(JSON.stringify(message.attachments).includes('secret'), false); assert.equal(JSON.stringify(message.attachments).includes(c.entry.token), false);
  c.gateway.receive(c.entry, incoming); await c.settle(); assert.equal(c.requests.filter(item => item.options.method === 'GET').length, 1); assert.equal(c.hooks.length, 1); assert.equal(c.routes.length, 1);
});

test('Telegram envia multipart no tópico: foto/documento/áudio/vídeo e formatos extras viram documento', async t => {
  const c = setup(t, 'tg'); c.gateway.receive(c.entry, tgMessage(1, { text: 'Fixture' }));
  const conversation = c.take(c.state().conversations[0].id);
  for (const fixture of [{ mime: 'image/png', bytes: png, method: 'sendPhoto', field: 'photo' }, { mime: 'application/pdf', bytes: Buffer.from('%PDF-fixture'), method: 'sendDocument', field: 'document' }, { mime: 'audio/mpeg', bytes: Buffer.from('ID3fixture'), method: 'sendAudio', field: 'audio' }, { mime: 'audio/ogg', bytes: opus, method: 'sendVoice', field: 'voice' }, { mime: 'video/mp4', bytes: mp4, method: 'sendVideo', field: 'video' }, { mime: 'audio/wav', bytes: Buffer.from('RIFF0000WAVEfixture'), method: 'sendDocument', field: 'document' }, { mime: 'image/gif', bytes: Buffer.from('GIF89afixture'), method: 'sendDocument', field: 'document' }]) {
    const metadata = await c.media.upload(c.context(conversation.id), { ...fixture, name: 'arquivo.fixture' });
    await c.gateway.send(actor, c.tenant.id, conversation.id, { version: c.state().conversations[0].version, channelId: c.channelId, text: 'Legenda QA', attachmentIds: [metadata.id] });
    const sent = c.sends.at(-1); assert.equal(sent.method, fixture.method); assert.equal(sent.payload.get('chat_id'), '-1000001'); assert.equal(sent.payload.get('message_thread_id'), '72'); assert.equal(sent.payload.get('caption'), 'Legenda QA');
    assert.deepEqual(Buffer.from(await sent.payload.get(fixture.field).arrayBuffer()), fixture.bytes);
    const recorded = c.state().conversations[0].messages.at(-1); assert.equal(recorded.text, 'Legenda QA'); assert.equal(recorded.delivery, 'sent'); assert.equal(recorded.authorUserId, actor.userId);
  }
  assert.equal(c.sends.length, 7);
});

test('Telegram limita origens/bytes e mantém offset e texto quando a mídia falha', async t => {
  let calls = 0;
  const c = setup(t, 'tg', { fetchImpl: async (url, options) => { calls++; assert.ok(url.startsWith('https://api.telegram.org/')); return { ok: true, json: async () => ({ ok: true, result: { file_path: '../../segredo', file_size: 1 } }) }; } });
  c.gateway.receive(c.entry, tgMessage(1, { caption: 'Legenda preservada', document: { file_id: 'fixture-doc', file_size: 1, file_name: 'qa.txt', mime_type: 'text/plain' } }));
  await c.settle(); const first = c.state().conversations[0].messages[0]; assert.equal(first.text, 'Legenda preservada'); assert.equal(first.attachments[0].status, 'unavailable'); assert.equal(calls, 1);
  c.gateway.receive(c.entry, tgMessage(2, { document: { file_id: 'large', file_size: MAX_MEDIA_BYTES + 1 } })); await c.settle();
  assert.equal(c.state().conversations[0].messages[1].attachments[0].reason, 'too_large'); assert.equal(calls, 1);
  assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets').get().next_offset, 3);
});

test('Telegram registra próxima mensagem durante download pendente sem travar polling', async t => {
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  const c = setup(t, 'tg', { fetchImpl: async (url, options) => {
    if (options.method === 'GET') { reached(); return new Promise(resolve => { release = () => resolve({ ok: true, headers: new Headers(), body: Readable.from([jpeg]) }); }); }
    return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/fixture.jpg', file_size: jpeg.length } }) };
  } });
  c.gateway.receive(c.entry, tgMessage(1, { photo: [{ file_id: 'fixture-photo', file_size: jpeg.length }] })); await entered;
  c.gateway.receive(c.entry, tgMessage(2, { text: 'Recebida enquanto baixa' }));
  assert.equal(c.state().conversations[0].messages.length, 2); assert.equal(c.store.db.prepare('SELECT next_offset FROM telegram_offsets').get().next_offset, 3);
  release(); await c.settle(); assert.equal(c.state().conversations[0].messages[0].attachments[0].status, 'ready');
});

