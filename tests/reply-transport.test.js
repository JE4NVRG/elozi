import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { MediaService } from '../src/media.js';
import { WhatsAppGateway } from '../src/whatsapp.js';
import { TelegramGateway } from '../src/telegram.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', userId: 'reply-fixture-user', name: 'Atendente QA' };
const groupJid = '120363099999999@g.us', participant = '5511900000001@s.whatsapp.net';
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('Imagem QA')]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture')]);
const opus = Buffer.alloc(47);
opus.write('OggS'); opus[5] = 2; opus[26] = 1; opus[27] = 19;
opus.write('OpusHead', 28); opus[36] = 1; opus[37] = 1; opus.writeUInt32LE(48000, 40);
const status = code => error => error.status === code;

function setup(t, kind, { group = true, handler } = {}) {
  const store = new Store(':memory:'), key = randomBytes(32), tenant = store.createTenant(actor, { name: 'Respostas QA', segment: 'Fixture sintética' });
  const channelId = kind === 'wa' ? 'reply-wa' : 'reply-tg', conversationId = randomUUID(), originalId = randomUUID();
  const remoteJid = group ? groupJid : participant, remoteChatId = group ? '-1000001' : '1001';
  store.mutate(actor, tenant.id, 'Fixture', state => {
    state.channels.push(kind === 'wa' ? { id: channelId, kind: 'whatsapp_qr', transport: 'baileys', allowedGroups: [groupJid] } : { id: channelId, kind: 'telegram', transport: 'telegram-bot' });
    state.conversations.push({ id: conversationId, contact: 'Contato QA', initials: 'QA', channelId, ...(kind === 'wa' ? { remoteJid, remoteAliases: [remoteJid] } : { remoteChatId, chatAliases: [remoteChatId], ...(group ? { threadId: 72 } : {}) }), conversationKind: group ? 'group' : 'direct', department: 'Suporte', owner: 'human', assignedUserId: actor.userId, status: 'open', version: 1, unread: 0, tags: [], messages: [{ id: originalId, externalId: kind === 'wa' ? 'original-wa' : `${remoteChatId}:1`, kind: 'customer', text: 'Texto original confiável', senderName: 'Cliente QA', ...(kind === 'wa' && group ? { senderJid: participant } : {}), delivery: 'received', createdAt: '2026-10-02T00:00:00Z' }] });
  });
  const sends = [], media = new MediaService(store, { directory: null, authKey: key });
  const socket = { user: { id: '5511900000000@s.whatsapp.net' }, end() {}, sendMessage: async (jid, payload, options) => { sends.push({ jid, payload, options }); if (handler) return handler({ jid, payload, options }); return { key: { id: options.messageId } }; } };
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1), payload = options.body instanceof FormData ? options.body : JSON.parse(options.body);
    sends.push({ method, payload });
    const body = handler ? await handler({ method, payload }) : { ok: true, result: { message_id: 100 + sends.length, chat: { id: Number(payload instanceof FormData ? payload.get('chat_id') : payload.chat_id) } } };
    return { ok: body.ok, status: body.error_code || 200, json: async () => body };
  };
  const gateway = kind === 'wa' ? new WhatsAppGateway(store, { authKey: key, socketFactory: () => { throw new Error('Sem rede'); } }) : new TelegramGateway(store, { authKey: key, polling: false, fetchImpl });
  const entry = { channelId, tenantId: tenant.id, actor: gateway.actor('mep-demo'), state: 'connected', matched: true, generation: 1, socket, abort: new AbortController(), token: '123456789:' + 'a'.repeat(35) };
  gateway.entries.set(channelId, entry); gateway.media = media; gateway.operations = { canReply() {}, routeIncoming() {} };
  t.after(async () => { await gateway.close(); store.close(); });
  const conversation = () => store.getConversation(store.tenant(actor, tenant.id), conversationId);
  const change = fn => store.mutate(actor, tenant.id, 'Fixture alteração', state => fn(store.getConversation(state, conversationId), state));
  const send = input => gateway.send(actor, tenant.id, conversationId, { channelId, version: conversation().version, text: 'Resposta QA', replyToMessageId: originalId, ...input });
  const upload = fixture => media.upload({ tenantId: tenant.id, conversationId, channelId }, { name: 'arquivo.fixture', ...fixture });
  return { store, tenant, gateway, entry, media, sends, socket, conversation, change, send, upload, originalId, channelId, conversationId, remoteJid, remoteChatId };
}

test('WhatsApp cita a mensagem local no grupo e o contrato Baileys preserva stanza/participante/texto', async t => {
  const c = setup(t, 'wa');
  await c.send({ quoted: { key: { id: 'forjado' }, message: { conversation: 'CORPO FORJADO' } }, replyTo: { externalId: 'forjado', text: 'CORPO FORJADO' } });
  const sent = c.sends[0], quoted = sent.options.quoted;
  assert.deepEqual(quoted, { key: { remoteJid: groupJid, id: 'original-wa', fromMe: false, participant }, message: { conversation: 'Texto original confiável' } });
  const generated = generateWAMessageFromContent(groupJid, { extendedTextMessage: { text: 'Resposta QA' } }, { userJid: c.socket.user.id, quoted });
  const context = generated.message.extendedTextMessage.contextInfo;
  assert.equal(context.stanzaId, 'original-wa'); assert.equal(context.participant, participant); assert.equal(context.quotedMessage.conversation, 'Texto original confiável');
  assert.equal(c.conversation().messages.at(-1).replyToMessageId, c.originalId);
  assert.equal(JSON.stringify(c.conversation()).includes('CORPO FORJADO'), false);
});

test('WhatsApp cita customer direto e envio human usando fromMe confiável', async t => {
  const c = setup(t, 'wa', { group: false });
  await c.send(); assert.equal(c.sends[0].options.quoted.key.participant, undefined); assert.equal(c.sends[0].options.quoted.key.fromMe, false);
  c.change(current => { Object.assign(current.messages[0], { kind: 'human', delivery: 'sent' }); current.version++; });
  await c.send(); assert.equal(c.sends[1].options.quoted.key.fromMe, true);
  const generated = generateWAMessageFromContent(c.remoteJid, { extendedTextMessage: { text: 'Resposta' } }, { userJid: c.socket.user.id, quoted: c.sends[1].options.quoted });
  assert.equal(generated.message.extendedTextMessage.contextInfo.participant, c.socket.user.id);
});

for (const kind of ['wa', 'tg']) {
  test(`${kind}: texto sem referência mantém o envio simples`, async t => {
    const c = setup(t, kind); await c.send({ replyToMessageId: undefined });
    assert.equal(kind === 'wa' ? c.sends[0].options.quoted : c.sends[0].payload.reply_parameters, undefined);
    assert.equal(c.conversation().messages.at(-1).replyToMessageId, undefined);
  });

  test(`${kind}: origem ausente/estrangeira/system/não confirmada falha antes de persistir ou chamar provider`, async t => {
    const c = setup(t, kind);
    for (const input of [{ replyToMessageId: 'não-existe' }, { replyToMessageId: {} }]) await assert.rejects(c.send(input), error => [400, 404].includes(error.status));
    c.change((current, state) => state.conversations.push({ ...current, id: randomUUID(), messages: [{ ...current.messages[0], id: 'estrangeiro' }] }));
    await assert.rejects(c.send({ replyToMessageId: 'estrangeiro' }), status(404));
    c.change(current => { current.messages[0].kind = 'system'; }); await assert.rejects(c.send(), status(404));
    for (const delivery of ['pending', 'failed', 'unconfirmed']) {
      c.change(current => Object.assign(current.messages[0], { kind: 'human', delivery }));
      await assert.rejects(c.send(), status(409));
    }
    c.change(current => Object.assign(current.messages[0], { kind: 'customer', delivery: 'received', externalId: undefined }));
    await assert.rejects(c.send(), status(409));
    assert.equal(c.sends.length, 0); assert.equal(c.conversation().messages.length, 1);
  });

  test(`${kind}: revalida referência depois do await de mídia mesmo sem mudança de versão`, async t => {
    const c = setup(t, kind), file = await c.upload({ mime: 'image/png', bytes: png }), resolve = c.media.resolve.bind(c.media);
    c.media.resolve = async (...args) => { const files = await resolve(...args); c.change(current => Object.assign(current.messages[0], { kind: 'human', delivery: 'failed' })); return files; };
    await assert.rejects(c.send({ attachmentIds: [file.id] }), status(409));
    assert.equal(c.sends.length, 0); assert.equal(c.conversation().messages.length, 1);
  });

  test(`${kind}: foto/áudio/vídeo/documento levam referência única e preservam wire de mídia`, async t => {
    const c = setup(t, kind);
    c.change(current => Object.assign(current.messages[0], { text: '', attachments: [{ kind: 'image' }] }));
    for (const fixture of [{ kind: 'image', mime: 'image/png', bytes: png, method: 'sendPhoto' }, { kind: 'audio', mime: 'audio/ogg', bytes: opus, method: 'sendVoice' }, { kind: 'video', mime: 'video/mp4', bytes: mp4, method: 'sendVideo' }, { kind: 'document', mime: 'application/pdf', bytes: Buffer.from('%PDF-fixture'), method: 'sendDocument' }]) {
      const file = await c.upload(fixture); await c.send({ attachmentIds: [file.id], text: fixture.kind === 'audio' ? '' : 'Legenda QA' });
      const sent = c.sends.at(-1);
      if (kind === 'wa') {
        assert.equal(sent.options.quoted.key.id, 'original-wa'); assert.equal(sent.options.quoted.message.conversation, '[Foto]');
        assert.deepEqual(sent.payload[fixture.kind], fixture.bytes); assert.equal(sent.payload.ptt, fixture.kind === 'audio' ? true : undefined);
      } else {
        assert.equal(sent.method, fixture.method); assert.equal(sent.payload.get('chat_id'), c.remoteChatId); assert.equal(sent.payload.get('message_thread_id'), '72');
        assert.deepEqual(JSON.parse(sent.payload.get('reply_parameters')), { message_id: 1, allow_sending_without_reply: false });
      }
      assert.equal(c.conversation().messages.at(-1).replyToMessageId, c.originalId);
    }
    assert.equal(c.sends.length, 4);
  });

  test(`${kind}: timeout de resposta mantém envio incerto e não repete provider`, async t => {
    const c = setup(t, kind, { handler: () => { throw new Error('Timeout QA'); } });
    await assert.rejects(c.send(), status(502));
    assert.equal(c.sends.length, 1); assert.equal(c.conversation().messages.at(-1).delivery, 'unconfirmed'); assert.equal(c.conversation().messages.at(-1).replyToMessageId, c.originalId);
  });
}

test('WhatsApp exige participante válido para quote customer de grupo', async t => {
  const c = setup(t, 'wa'); c.change(current => delete current.messages[0].senderJid);
  await assert.rejects(c.send(), status(409)); assert.equal(c.sends.length, 0);
});

test('WhatsApp revalida grupo, origem e participante depois do await de mídia', async t => {
  for (const change of [
    (current, state) => { state.channels.find(item => item.id === current.channelId).allowedGroups = []; },
    current => { current.remoteJid = '120363088888888@g.us'; },
    current => { current.messages[0].senderJid = 'participante-inválido'; }
  ]) {
    const c = setup(t, 'wa'), file = await c.upload({ mime: 'image/png', bytes: png }), resolve = c.media.resolve.bind(c.media);
    c.media.resolve = async (...args) => { const files = await resolve(...args); c.change(change); return files; };
    await assert.rejects(c.send({ attachmentIds: [file.id] }), status(409));
    assert.equal(c.sends.length, 0); assert.equal(c.conversation().messages.length, 1);
  }
});

test('WhatsApp entrada resolve só id local, unwrap e ignora corpo/remoteJid estrangeiros', async t => {
  const c = setup(t, 'wa');
  const incoming = (id, context) => ({ key: { id, remoteJid: groupJid, participant }, pushName: 'Cliente QA', messageTimestamp: 1750000000, message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'Resposta recebida', contextInfo: { stanzaId: 'original-wa', quotedMessage: { conversation: 'CORPO REMOTO DESCARTADO' }, ...context } } } } } });
  await c.gateway.receive(c.entry, incoming('reply-1'));
  assert.equal(c.conversation().messages.at(-1).replyToMessageId, c.originalId);
  await c.gateway.receive(c.entry, incoming('reply-2', { stanzaId: 'fora' })); assert.equal(c.conversation().messages.at(-1).replyToMessageId, undefined);
  await c.gateway.receive(c.entry, incoming('reply-3', { remoteJid: '120363088888888@g.us' })); assert.equal(c.conversation().messages.at(-1).replyToMessageId, undefined);
  assert.equal(JSON.stringify(c.conversation()).includes('CORPO REMOTO DESCARTADO'), false);
});

test('Telegram JSON usa message_id numérico e recusa referência de chat antigo/inválida', async t => {
  const c = setup(t, 'tg'); await c.send({ reply_parameters: { message_id: 999, allow_sending_without_reply: true } });
  assert.equal(c.sends[0].method, 'sendMessage'); assert.deepEqual(c.sends[0].payload.reply_parameters, { message_id: 1, allow_sending_without_reply: false });
  assert.equal(c.sends[0].payload.message_thread_id, 72);
  for (const externalId of ['-1000002:1', '-1000001:9007199254740992', '-1000001:0', '1']) {
    c.change(current => current.messages[0].externalId = externalId);
    await assert.rejects(c.send(), status(409));
  }
  assert.equal(c.sends.length, 1);
});

test('Telegram referência removida é failed e jamais vira envio sem reply', async t => {
  const c = setup(t, 'tg', { handler: () => ({ ok: false, error_code: 400, description: 'message to be replied not found' }) });
  await assert.rejects(c.send(), status(502));
  assert.equal(c.sends.length, 1); assert.equal(c.sends[0].payload.reply_parameters.allow_sending_without_reply, false); assert.equal(c.conversation().messages.at(-1).delivery, 'failed');
});

test('Telegram entrada resolve só id do mesmo tópico/chat e ignora texto remoto citado', async t => {
  const c = setup(t, 'tg');
  const incoming = (id, extra = {}) => ({ update_id: id, message: { message_id: id, date: 1750000000, chat: { id: -1000001, type: 'supergroup', title: 'Grupo QA' }, from: { id: 1001, first_name: 'Cliente QA' }, message_thread_id: 72, text: 'Resposta recebida', reply_to_message: { message_id: 1, chat: { id: -1000001 }, text: 'CORPO REMOTO DESCARTADO' }, ...extra } });
  c.gateway.receive(c.entry, incoming(2)); assert.equal(c.conversation().messages.at(-1).replyToMessageId, c.originalId);
  c.gateway.receive(c.entry, incoming(3, { reply_to_message: { message_id: 1, chat: { id: -1000002 } } })); assert.equal(c.conversation().messages.at(-1).replyToMessageId, undefined);
  c.gateway.receive(c.entry, incoming(4, { message_thread_id: 73 }));
  const other = c.store.tenant(actor, c.tenant.id).conversations.find(item => item.threadId === 73);
  assert.equal(other.messages[0].replyToMessageId, undefined);
  assert.equal(JSON.stringify(c.store.tenant(actor, c.tenant.id)).includes('CORPO REMOTO DESCARTADO'), false);
});
