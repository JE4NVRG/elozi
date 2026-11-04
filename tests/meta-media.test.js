import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createMetaMediaDownloader, metaMediaURL, messengerUploadDescriptor, validateMessengerUpload, META_SEND_KINDS, MESSENGER_UPLOAD_MIMES } from '../src/meta-media.js';
import { MAX_MEDIA_BYTES } from '../src/media.js';

const url = 'https://scontent.xx.fbcdn.net/v/photo.jpg?oh=synthetic-private-signature';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const publicIP = '157.240.1.35';

test('subset privado Messenger usa tipos nativos exatos e limite próprio Elozi; Instagram Login permanece OFF', () => {
  assert.deepEqual(META_SEND_KINDS.instagram, []); assert.deepEqual(META_SEND_KINDS.messenger, ['image', 'audio', 'video', 'document']);
  for (const [kind, mime, bytes, type, extension] of [
    ['image', 'image/png', png, 'image', 'png'], ['image', 'image/jpeg', Buffer.from([255, 216, 255]), 'image', 'jpg'],
    ['audio', 'audio/mpeg', Buffer.from('ID3private'), 'audio', 'mp3'],
    ['audio', 'audio/mp4', Buffer.from('\x00\x00\x00\x18ftypM4A private', 'latin1'), 'audio', 'm4a'],
    ['video', 'video/mp4', Buffer.from('\x00\x00\x00\x18ftypmp42private', 'latin1'), 'video', 'mp4'],
    ['document', 'application/pdf', Buffer.from('%PDF-1.7 private'), 'file', 'pdf'], ['document', 'application/octet-stream', Buffer.from('Private bytes'), 'file', 'bin'],
  ]) {
    const metadata = { id: 'synthetic-upload-id', kind, mime, name: 'Private é\r\nname', size: bytes.length, status: 'ready', preview: kind !== 'document', url: 'https://private.invalid/', access_token: 'private token' };
    const result = validateMessengerUpload({ metadata, bytes }); assert.equal(result.type, type); assert.equal(result.filename, `attachment.${extension}`);
    assert.deepEqual(result.metadata, { id: metadata.id, kind, name: metadata.name, mime, size: bytes.length, preview: kind !== 'document', status: 'ready' });
    assert.equal(JSON.stringify(result).includes('access_token'), false); assert.equal(JSON.stringify(result).includes('https://'), false); assert.ok(MESSENGER_UPLOAD_MIMES.includes(mime));
  }
});

test('upload privado Messenger recusa tipo/MIME/voz/status/tamanho incompatíveis antes de construir arquivo', () => {
  const metadata = { id: 'synthetic', kind: 'image', mime: 'image/png', name: 'Private.png', size: png.length, status: 'ready', preview: true };
  for (const [change, code] of [[{ mime: 'image/gif' }, 400], [{ kind: 'document' }, 400], [{ voice: true }, 400], [{ size: 0 }, 400],
    [{ size: 1.5 }, 400], [{ size: MAX_MEDIA_BYTES + 1 }, 413], [{ status: 'pending' }, 404]]) {
    assert.throws(() => messengerUploadDescriptor({ ...metadata, ...change }), error => error.status === code);
  }
  assert.throws(() => validateMessengerUpload({ metadata, bytes: Buffer.alloc(png.length) }), error => error.status === 400);
  assert.throws(() => validateMessengerUpload({ metadata: { ...metadata, size: png.length + 1 }, bytes: png }), error => error.status === 400);
  assert.throws(() => validateMessengerUpload({ metadata, bytes: Buffer.alloc(MAX_MEDIA_BYTES + 1) }), error => error.status === 413);
  const boundary = Buffer.alloc(MAX_MEDIA_BYTES); png.copy(boundary);
  assert.equal(validateMessengerUpload({ metadata: { ...metadata, size: boundary.length }, bytes: boundary }).metadata.size, MAX_MEDIA_BYTES);
});
function transport(options = {}) {
  const calls = [], state = { calls, destroyed: false };
  state.request = (target, input, receive) => {
    calls.push({ target: String(target), input });
    const req = new EventEmitter();
    req.destroy = () => { state.destroyed = true; };
    req.end = () => queueMicrotask(() => {
      if (options.never) return;
      const stream = Readable.from(options.chunks || [options.bytes || png]);
      stream.statusCode = options.status || 200;
      stream.headers = { 'content-type': 'image/png', ...(options.headers || {}) };
      stream.socket = { encrypted: true, authorized: true, remoteAddress: options.peer || publicIP,
        getPeerCertificate: () => ({ subjectaltname: `DNS:${options.certificateHost || target.hostname}`, subject: { CN: options.certificateHost || target.hostname } }) };
      options.beforeHeaders?.(); receive(stream);
    });
    return req;
  };
  return state;
}
const status = code => error => error.status === code && !error.message.includes('oh=') && !error.message.includes('synthetic-private');
const downloader = (tr, extra = {}) => createMetaMediaDownloader({ lookupImpl: async () => [{ address: publicIP, family: 4 }], requestImpl: tr.request, ...extra });

test('CDN nativo restrito: HTTPS e assinatura transitória permitidos, entradas arbitrárias recusadas', () => {
  for (const value of [url, 'https://scontent-atl3-1.xx.fbcdn.net/v/1.jpg', 'https://video-lis1-1.xx.fbcdn.net/v/1.mp4', 'https://scontent.cdninstagram.com/v/photo.jpg', 'https://cdn.fbsbx.com/v/file.pdf', 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123&signature=private']) assert.ok(metaMediaURL(value));
  for (const value of ['http://scontent.xx.fbcdn.net/file', 'https://127.0.0.1/file', 'https://user:pass@scontent.xx.fbcdn.net/file', 'https://scontent.xx.fbcdn.net:8443/file', 'https://scontent.xx.fbcdn.net.evil.example/file', 'https://evil.example/file', 'https://graph.facebook.com/v23.0/1', 'https://lookaside.fbsbx.com/arbitrary', url + '#secret', url + '&access_token=secret', 'https://scontent.xx.fbcdn.net/file?access%5Ftoken=secret']) assert.throws(() => metaMediaURL(value), error => error.status === 400);
});

test('TLS/DNS pin, MIME e assinatura de bytes; CDN nunca recebe bearer/cookie nem redirect', async () => {
  const tr = transport(), result = await downloader(tr)({ url, kind: 'image', reauthorize: () => {} });
  assert.deepEqual(result.bytes, png); assert.equal(result.metadata.mime, 'image/png'); assert.equal(result.metadata.kind, 'image');
  assert.deepEqual(Object.keys(result.metadata).sort(), ['kind', 'mime', 'name']); assert.equal(JSON.stringify(result.metadata).includes('oh='), false);
  const { input } = tr.calls[0]; assert.equal(input.rejectUnauthorized, true); assert.equal(input.servername, 'scontent.xx.fbcdn.net'); assert.equal(input.agent, false);
  assert.equal(input.headers.Authorization, undefined); assert.equal(input.headers.Cookie, undefined); assert.equal(input.headers['Accept-Encoding'], 'identity');
  input.lookup('scontent.xx.fbcdn.net', {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, publicIP); assert.equal(family, 4); });
  input.lookup('another.example', {}, error => assert.ok(error));
});

test('todo IP resolvido deve ser público, incluindo IPv6 encapsulado e link-local', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2002:7f00:1::1']) {
    const tr = transport(), family = ip.includes(':') ? 6 : 4;
    await assert.rejects(downloader(tr, { lookupImpl: async () => [{ address: publicIP, family: 4 }, { address: ip, family }] })({ url, kind: 'image', reauthorize: () => {} }), status(502));
    assert.equal(tr.calls.length, 0, ip);
  }
});

test('peer alterado, certificado de outro host, redirect, 401 e conteúdo ativo falham fechados', async () => {
  for (const options of [{ peer: '157.240.1.36' }, { certificateHost: 'other.fbcdn.net' }, { status: 302 }, { status: 401 }, { headers: { 'content-type': 'image/svg+xml' } }, { headers: { 'content-encoding': 'gzip' } }, { bytes: Buffer.from('not a PNG') }]) {
    const tr = transport(options); await assert.rejects(downloader(tr)({ url, kind: 'image', reauthorize: () => {} }), status(502));
    assert.equal(tr.calls.length, 1); assert.equal(tr.destroyed, true);
  }
});

test('tamanho declarado e stream limitado encerram transporte sem armazenar parcial', async () => {
  for (const options of [{ headers: { 'content-length': '65' } }, { chunks: [png, Buffer.alloc(53)] }]) {
    const tr = transport(options); await assert.rejects(downloader(tr, { maxBytes: 64 })({ url, kind: 'image', reauthorize: () => {} }), status(413)); assert.equal(tr.destroyed, true);
  }
  const tr = transport({ headers: { 'content-length': '13' } }); await assert.rejects(downloader(tr)({ url, kind: 'image', reauthorize: () => {} }), status(502));
});

test('revogação depois do DNS ou antes dos bytes impede captura; aborto cancela transporte', async () => {
  let authorized = true; const reauthorize = () => { if (!authorized) throw Object.assign(new Error('Private authority'), { status: 403 }); };
  let tr = transport(); await assert.rejects(downloader(tr, { lookupImpl: async () => { authorized = false; return [{ address: publicIP, family: 4 }]; } })({ url, kind: 'image', reauthorize }), status(502)); assert.equal(tr.calls.length, 0);
  authorized = true; tr = transport({ beforeHeaders: () => { authorized = false; } }); await assert.rejects(downloader(tr)({ url, kind: 'image', reauthorize }), status(502)); assert.equal(tr.destroyed, true);
  const controller = new AbortController(); tr = transport({ never: true });
  const pending = downloader(tr)({ url, kind: 'image', reauthorize: () => {}, signal: controller.signal }); await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, status(502)); assert.equal(tr.destroyed, true);
});

test('prazo inclui DNS; erros privados não vazam URL ou credenciais', async t => {
  const keepAlive = setTimeout(() => {}, 500); t.after(() => clearTimeout(keepAlive));
  const tr = transport(); await assert.rejects(downloader(tr, { timeoutMs: 100, lookupImpl: async () => new Promise(() => {}) })({ url, kind: 'image', reauthorize: () => {} }), status(502)); assert.equal(tr.calls.length, 0);
});

test('áudio, vídeo e documento recebem MIME preciso; conteúdo ativo nunca vira preview', async () => {
  for (const [kind, mime, bytes] of [
    ['audio', 'audio/mpeg', Buffer.from('ID3synthetic audio')], ['video', 'video/mp4', Buffer.from('\x00\x00\x00\x18ftypmp42synthetic video', 'latin1')],
    ['document', 'application/pdf', Buffer.from('%PDF-1.7 synthetic document')],
  ]) {
    const tr = transport({ bytes, headers: { 'content-type': mime } }), result = await downloader(tr)({ url, kind, reauthorize: () => {} });
    assert.equal(result.metadata.kind, kind); assert.equal(result.metadata.mime, mime); assert.deepEqual(result.bytes, bytes);
  }
  const tr = transport({ bytes: Buffer.from('<html>active</html>'), headers: { 'content-type': 'text/html' } });
  await assert.rejects(downloader(tr)({ url, kind: 'document', reauthorize: () => {} }), status(502));
});

test('guard false ou assíncrono falha antes do DNS; corpo interrompido termina sem ficar pendente', async () => {
  for (const reauthorize of [() => false, async () => true, async () => { throw new Error('Private authority detail'); }]) {
    let dns = 0; const tr = transport();
    await assert.rejects(downloader(tr, { lookupImpl: async () => { dns++; return [{ address: publicIP, family: 4 }]; } })({ url, kind: 'image', reauthorize }), status(502));
    assert.equal(dns, 0); assert.equal(tr.calls.length, 0);
  }
  const tr = transport();
  const requestImpl = (target, input, receive) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.destroy = () => {}; response.statusCode = 200; response.headers = { 'content-type': 'image/png' };
      response.socket = { encrypted: true, authorized: true, remoteAddress: publicIP, getPeerCertificate: () => ({ subjectaltname: `DNS:${target.hostname}` }) };
      receive(response); response.emit('data', png); response.emit('close');
    }); return req;
  };
  await assert.rejects(downloader(tr, { requestImpl })({ url, kind: 'image', reauthorize: () => {} }), status(502));
});
