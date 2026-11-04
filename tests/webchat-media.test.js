import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWebchatMedia, decodeWebchatMediaMetadata, WEBCHAT_MEDIA_FRAME_MAX_BYTES, WEBCHAT_MEDIA_METADATA_MAX_BYTES, validateWebchatMedia } from '../src/webchat-media.js';
import { MAX_MEDIA_BYTES } from '../src/media.js';

const status = code => error => error.status === code;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 11]);
const header = { clientMessageId: 'synthetic-frame-0001', text: ' Foto ', name: 'foto.png', mime: 'image/png', voice: false };
function frame(metadata = header, file = png) {
  const encoded = Buffer.isBuffer(metadata) ? metadata : Buffer.from(JSON.stringify(metadata));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(encoded.length);
  return Buffer.concat([prefix, encoded, file]);
}

test('binary frame decodes big-endian UTF-8 metadata and a private immutable file snapshot', () => {
  const source = frame({ ...header, name: '../../foto.png', text: 'Legenda 😀' }), result = decodeWebchatMedia(source);
  assert.deepEqual(result, { clientMessageId: header.clientMessageId, text: 'Legenda 😀', attachment: { bytes: png, name: 'foto.png', mime: 'image/png', voice: false } });
  source.fill(0); assert.deepEqual(result.attachment.bytes, png);
  assert.equal(WEBCHAT_MEDIA_FRAME_MAX_BYTES, MAX_MEDIA_BYTES + 8196);
  assert.equal(WEBCHAT_MEDIA_METADATA_MAX_BYTES, 8192);
});

test('header-only validation rejects forged fields, malformed UTF-8, captions and nonaudio voice before bytes', () => {
  assert.equal(decodeWebchatMediaMetadata(Buffer.from(JSON.stringify(header))).text, 'Foto');
  for (const value of [null, [], { ...header, token: 'never-accepted' }, { ...header, attachmentIds: [] }, { ...header, clientMessageId: 'short' },
    { ...header, text: 'a'.repeat(1025) }, { ...header, text: 'bad\u0000caption' }, { ...header, name: 1 }, { ...header, mime: 'image/png\n' },
    { ...header, voice: 'true' }, { ...header, voice: true }]) {
    assert.throws(() => decodeWebchatMediaMetadata(Buffer.from(JSON.stringify(value))), status(400));
  }
  assert.throws(() => decodeWebchatMediaMetadata(Buffer.from([0xff])), status(400));
  assert.throws(() => decodeWebchatMediaMetadata(Buffer.alloc(8193)), status(413));
  assert.throws(() => decodeWebchatMediaMetadata(Buffer.alloc(0)), status(400));
  const audio = { ...header, text: '', voice: true, mime: 'audio/webm;codecs=opus' };
  assert.equal(decodeWebchatMediaMetadata(Buffer.from(JSON.stringify(audio))).mime, 'audio/webm');
});

test('truncated frames, oversized headers/files and mismatched signatures are rejected', () => {
  for (const value of [Buffer.alloc(0), Buffer.alloc(4), Buffer.from([0, 0, 0, 0, 1]), frame(Buffer.from('{')), frame(header, Buffer.alloc(0)), frame(header, Buffer.from('false png'))]) {
    assert.throws(() => decodeWebchatMedia(value), status(400));
  }
  const tooLongHeader = Buffer.alloc(5); tooLongHeader.writeUInt32BE(8193);
  assert.throws(() => decodeWebchatMedia(tooLongHeader), status(413));
  const missingHeader = Buffer.alloc(5); missingHeader.writeUInt32BE(99);
  assert.throws(() => decodeWebchatMedia(missingHeader), status(400));
  assert.throws(() => decodeWebchatMedia(frame({ ...header, mime: 'application/octet-stream' }, Buffer.alloc(MAX_MEDIA_BYTES + 1))), status(413));
  assert.throws(() => decodeWebchatMedia(Buffer.alloc(WEBCHAT_MEDIA_FRAME_MAX_BYTES + 1)), status(413));
});

test('four media kinds use existing signature rules; active unknown files remain safe documents', () => {
  const cases = [
    ['image/jpeg', Buffer.from([255, 216, 255, 1]), 'image'],
    ['audio/ogg', Buffer.from('OggSfixture'), 'audio'],
    ['video/mp4', Buffer.from('\0\0\0\x18ftypisomfixture'), 'video'],
    ['application/pdf', Buffer.from('%PDF-fixture'), 'document'],
    ['image/svg+xml', Buffer.from('<svg onload="synthetic"/>'), 'document']
  ];
  for (const [mime, bytes, kind] of cases) {
    const result = validateWebchatMedia({ clientMessageId: header.clientMessageId, attachment: { bytes, name: 'arquivo', mime } });
    assert.equal(result.attachment.kind, kind); assert.equal(result.attachment.preview, kind !== 'document');
    if (mime === 'image/svg+xml') assert.equal(result.attachment.mime, 'application/octet-stream');
  }
  const voice = decodeWebchatMedia(frame({ ...header, mime: 'audio/ogg', voice: true }, Buffer.from('OggSOpusHead-fixture')));
  assert.equal(voice.attachment.voice, true);
  assert.throws(() => decodeWebchatMedia(frame({ ...header, mime: 'audio/unsupported', voice: true }, Buffer.from('content'))), status(400));
  assert.throws(() => validateWebchatMedia({ clientMessageId: header.clientMessageId, attachment: { bytes: png, name: 'foto', mime: 'image/png', url: 'https://invalid.example' } }), status(400));
});
