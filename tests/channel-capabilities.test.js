import test from 'node:test';
import assert from 'node:assert/strict';
import { channelCapabilities, textLength, validateAttachmentSelection, assertChannelText } from '../public/channel-capabilities.js';

const status = code => error => error.status === code;
const limit = 16 * 1024 * 1024;
const file = (type, size = 32) => ({ type, size, arrayBuffer() { assert.fail('A seleção não pode ler bytes nem iniciar upload.'); } });
const messenger = { kind: 'messenger', transport: 'meta-messenger', state: 'connected' };
const mediaSettings = { mediaSupported: true, mediaKinds: ['image', 'document'], mediaMimes: ['image/jpeg', 'application/pdf'], mediaMaxBytes: 128 };

test('Telegram separa texto de fotos e arquivos e valida o método final por MIME e tamanho', () => {
  const group = { canSend: true, sendPermissions: { text: false, photos: true, audios: false, documents: false, videos: false, voiceNotes: false } };
  const caps = channelCapabilities({ transport: 'telegram-bot' }, {}, { group });
  assert.equal(caps.textSupported, false);
  assert.throws(() => assertChannelText('Resposta textual', caps), status(409));
  assert.equal(assertChannelText('Legenda permitida', caps, { attachment: true }), 'Legenda permitida');
  assert.deepEqual(caps.uploadKinds, ['image']); assert.equal(caps.voice, false);
  assert.equal(validateAttachmentSelection(file('image/jpeg'), caps).kind, 'image');
  for (const value of [file('image/gif'), file('image/webp'), file('image/png', 10_000_001), file('audio/ogg'), file('application/pdf')]) assert.throws(() => validateAttachmentSelection(value, caps));
  const docs = channelCapabilities({ transport: 'telegram-bot' }, {}, { group: { canSend: true, sendPermissions: { text: false, photos: false, audios: false, documents: true, videos: false, voiceNotes: false } } });
  assert.equal(validateAttachmentSelection(file('image/gif'), docs).kind, 'image');
  assert.equal(validateAttachmentSelection(file('image/png', 10_000_001), docs).kind, 'image');
  assert.equal(validateAttachmentSelection(file('audio/webm'), docs).kind, 'audio');
  assert.equal(validateAttachmentSelection(file('video/webm'), docs).kind, 'video');
  assert.throws(() => validateAttachmentSelection(file('image/png'), docs), status(409));
  assert.equal(validateAttachmentSelection(file('image/png', 1), docs, { sizeUnknown: true }).kind, 'image');
  assert.throws(() => validateAttachmentSelection(file('video/mp4'), docs), status(409));
  assert.throws(() => validateAttachmentSelection(file('audio/ogg'), docs, { voice: true }));
});

test('Telegram mantém permissões desconhecidas e não herda restrições de outra conversa ou canal', () => {
  const blocked = { group: { canSend: false, sendPermissions: { text: false, photos: false, audios: false, documents: false, videos: false, voiceNotes: false } } };
  const caps = channelCapabilities({ transport: 'telegram-bot' }, {}, blocked);
  assert.equal(caps.textSupported, false); assert.deepEqual(caps.uploadKinds, []); assert.equal(caps.voice, false);
  const unknown = channelCapabilities({ transport: 'telegram-bot' }, {}, { group: { canSend: true, sendPermissions: { text: null, photos: null, audios: null, documents: null, videos: null, voiceNotes: null } } });
  assert.equal(unknown.textSupported, true); assert.equal(unknown.voice, true); assert.equal(validateAttachmentSelection(file('image/png'), unknown).kind, 'image');
  const direct = channelCapabilities({ transport: 'telegram-bot' }); assert.equal(assertChannelText('Direto', direct), 'Direto');
  const qr = channelCapabilities({ transport: 'baileys' }, {}, blocked); assert.equal(qr.textSupported, true); assert.equal(validateAttachmentSelection(file('image/png'), qr).kind, 'image');
});

test('QR e Telegram permitem os quatro tipos locais sem ligar capacidades Meta por consequência', () => {
  for (const transport of ['baileys', 'telegram-bot']) {
    const caps = channelCapabilities({ transport });
    for (const [type, kind] of [['image/png', 'image'], ['audio/ogg', 'audio'], ['video/mp4', 'video'], ['application/pdf', 'document']]) assert.deepEqual(validateAttachmentSelection(file(type), caps), { kind, mime: type });
    assert.equal(caps.maxMediaBytes, limit); assert.equal(caps.voice, true); assert.equal(caps.avatar, true); assert.equal(caps.forward, true); assert.equal(caps.quote, true);
    assert.equal(caps.audioCaptionSupported, transport === 'telegram-bot'); assert.equal(assertChannelText('x'.repeat(4000), caps), 'x'.repeat(4000)); assert.throws(() => assertChannelText('x'.repeat(4001), caps), status(400));
    assert.deepEqual(validateAttachmentSelection(file('application/octet-stream'), caps), { kind: 'document', mime: 'application/octet-stream' });
  }
});

test('receber mídia Meta ou ter canal conectado não permite selecionar arquivo ou gravar voz', () => {
  for (const transport of ['meta-instagram', 'meta-messenger']) {
    const caps = channelCapabilities({ transport, state: 'connected', mediaSupported: true, mediaKinds: ['image'], meta: { incomingMediaSupported: true } });
    assert.deepEqual(caps.uploadKinds, []); assert.equal(caps.maxMediaBytes, 0);
    for (const capability of ['voice', 'avatar', 'quote', 'forward', 'audioCaptionSupported']) assert.equal(caps[capability], false);
    assert.throws(() => validateAttachmentSelection(file('image/jpeg'), caps), status(400));
    assert.throws(() => validateAttachmentSelection(file('audio/ogg'), caps, { voice: true }), status(400));
  }
});

test('Messenger usa somente tipos e MIME explicitamente liberados, com limite da conexão e nenhuma legenda/voz', () => {
  const caps = channelCapabilities(messenger, mediaSettings);
  assert.deepEqual(validateAttachmentSelection(file('IMAGE/JPEG; charset=binary', 128), caps), { kind: 'image', mime: 'image/jpeg' });
  assert.deepEqual(validateAttachmentSelection(file('application/pdf', 128), caps), { kind: 'document', mime: 'application/pdf' });
  assert.throws(() => validateAttachmentSelection(file('image/jpeg', 129), caps), status(413));
  for (const type of ['image/png', 'image/svg+xml', 'audio/ogg', 'video/mp4', 'application/octet-stream']) assert.throws(() => validateAttachmentSelection(file(type), caps), status(400));
  assert.equal(assertChannelText('', caps, { attachment: true }), ''); assert.throws(() => assertChannelText('Legenda não suportada', caps, { attachment: true }), status(400));
  assert.throws(() => validateAttachmentSelection(file('audio/ogg'), caps, { voice: true }), status(400));
  assert.equal(caps.voice, false); assert.equal(caps.avatar, false); assert.equal(caps.forward, false); assert.equal(caps.quote, false);
});

test('configuração de mídia não habilita upload em Instagram, e-mail ou transporte desconhecido', () => {
  for (const transport of ['meta-instagram', 'mepmail-channel', 'unknown']) {
    const caps = channelCapabilities({ transport }, mediaSettings);
    assert.deepEqual(caps.uploadKinds, [], transport); assert.throws(() => validateAttachmentSelection(file('image/jpeg'), caps), status(400));
  }
  assert.throws(() => validateAttachmentSelection(file('image/jpeg'), channelCapabilities(messenger, { ...mediaSettings, mediaSupported: false })), status(400));
});

test('Webchat encaminha itens recebidos e exige capacidades explícitas para enviar mídia ou voz', () => {
  const channel={transport:'elozi-webchat',state:'connected',mediaSupported:true};
  for(const settings of [{},{mediaSupported:false,mediaKinds:['image','audio','video','document']}]){const caps=channelCapabilities(channel,settings);assert.deepEqual(caps.uploadKinds,[]);assert.equal(caps.voice,false);assert.equal(caps.maxMediaBytes,0);assert.equal(caps.forward,true);assert.equal(caps.avatar,false);}
  const caps=channelCapabilities(channel,{mediaSupported:true,mediaKinds:['image','audio','video','document'],mediaMaxBytes:limit,captionMaxLength:1024,voiceSupported:true});
  for(const [mime,kind] of [['image/png','image'],['audio/webm','audio'],['video/mp4','video'],['application/pdf','document']])assert.deepEqual(validateAttachmentSelection(file(mime),caps),{kind,mime});
  assert.equal(caps.maxMediaBytes,limit);assert.equal(caps.voice,true);assert.equal(caps.audioCaptionSupported,true);assert.equal(caps.avatar,false);assert.equal(caps.forward,true);assert.equal(caps.quote,true);
  assert.equal(assertChannelText('',caps,{attachment:true}),'');assert.equal(assertChannelText('x'.repeat(1024),caps,{attachment:true,audio:true}),'x'.repeat(1024));assert.throws(()=>assertChannelText('x'.repeat(1025),caps,{attachment:true}),status(400));
  const noVoice=channelCapabilities(channel,{mediaSupported:true,mediaKinds:['audio'],mediaMaxBytes:128});assert.equal(noVoice.voice,false);assert.throws(()=>validateAttachmentSelection(file('audio/ogg'),noVoice,{voice:true}),status(400));
  const limited=channelCapabilities(channel,{mediaSupported:true,mediaKinds:['image'],mediaMaxBytes:128,captionMaxLength:64,voiceSupported:true});assert.equal(limited.voice,false);assert.equal(limited.captionMaxLength,64);assert.throws(()=>validateAttachmentSelection(file('image/png',129),limited),status(413));
});

test('seleção valida tamanho sem ler bytes, limita 16 MB e exige áudio quando marcado como voz', () => {
  const caps = channelCapabilities({ transport: 'telegram-bot' });
  for (const size of [0, -1, 1.5, NaN, Infinity, '32']) assert.throws(() => validateAttachmentSelection(file('image/png', size), caps), status(400));
  assert.deepEqual(validateAttachmentSelection(file('image/png', limit), caps), { kind: 'image', mime: 'image/png' });
  assert.throws(() => validateAttachmentSelection(file('image/png', limit + 1), caps), status(413));
  const larger = channelCapabilities(messenger, { ...mediaSettings, mediaMaxBytes: limit * 2 }); assert.equal(larger.maxMediaBytes, limit);
  assert.deepEqual(validateAttachmentSelection(file('audio/webm'), caps, { voice: true }), { kind: 'audio', mime: 'audio/webm' });
  assert.throws(() => validateAttachmentSelection(file('image/png'), caps, { voice: true }), status(400));
});

test('Meta aceita mil caracteres Unicode incluindo emoji, sem confundir duas mil unidades UTF-16', () => {
  const caps = channelCapabilities(messenger), text = '😀'.repeat(1000);
  assert.equal(text.length, 2000); assert.equal(textLength(text, caps), 1000); assert.equal(new TextEncoder().encode(text).byteLength, 4000); assert.equal(assertChannelText(text, caps), text);
  assert.throws(() => assertChannelText(text + 'a', caps), status(400));
  assert.equal(textLength(text, channelCapabilities({ transport: 'baileys' })), 2000);
  for (const value of ['', ' \t\n ', undefined, null, 123, {}]) assert.throws(() => assertChannelText(value, caps), status(400));
});

test('limite UTF-8 continua independente do limite de caracteres e legendas respeitam o tipo do áudio', () => {
  const caps = { ...channelCapabilities(messenger), maxTextLength: 4000 };
  assert.equal(assertChannelText('é'.repeat(2000), caps), 'é'.repeat(2000)); assert.throws(() => assertChannelText('é'.repeat(2001), caps), status(400));
  const qr = channelCapabilities({ transport: 'baileys' }), tg = channelCapabilities({ transport: 'telegram-bot' });
  assert.equal(assertChannelText('x'.repeat(1024), qr, { attachment: true }), 'x'.repeat(1024)); assert.throws(() => assertChannelText('x'.repeat(1025), qr, { attachment: true }), status(400));
  assert.throws(() => assertChannelText('Legenda de áudio', qr, { attachment: true, audio: true }), status(400)); assert.equal(assertChannelText('Legenda de áudio', tg, { attachment: true, audio: true }), 'Legenda de áudio');
});

