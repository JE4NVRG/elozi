import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { isPublicDeploymentAddress } from './domain-deployment.js';
import { MAX_MEDIA_BYTES, validateMedia } from './media.js';

const failure = (status = 502) => Object.assign(new Error(status === 413 ? 'Mídia Meta acima de 16 MiB.' : 'Mídia Meta indisponível para captura privada.'), { status });
const mimes = Object.freeze({ image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], audio: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg'], video: ['video/mp4', 'video/quicktime'], document: ['application/pdf', 'text/plain', 'application/octet-stream'] });
const names = Object.freeze({ image: 'Imagem Meta', audio: 'Áudio Meta', video: 'Vídeo Meta', document: 'Documento Meta' });
export const META_RECEIVE_KINDS = Object.freeze({ instagram: Object.freeze(['image', 'audio', 'video']), messenger: Object.freeze(['image', 'audio', 'video', 'document']) });
// Page/message_attachments accepts filedata; Send consumes its attachment_id.
// Instagram Login's graph.instagram.com contract has no proven binary upload here.
export const META_SEND_KINDS = Object.freeze({ instagram: Object.freeze([]), messenger: Object.freeze(['image', 'audio', 'video', 'document']) });
// Product subset and 16 MiB cap, not a claim about every Meta codec/size limit.
export const MESSENGER_UPLOAD_MIMES = Object.freeze(['image/jpeg', 'image/png', 'audio/mpeg', 'audio/mp4', 'video/mp4', 'application/pdf', 'application/octet-stream']);
const uploadTypes = Object.freeze({ 'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'audio/mpeg': ['audio', 'mp3'],
  'audio/mp4': ['audio', 'm4a'], 'video/mp4': ['video', 'mp4'], 'application/pdf': ['document', 'pdf'], 'application/octet-stream': ['document', 'bin'] });
const uploadFailure = (status, message) => Object.assign(new Error(message), { status });

export function messengerUploadDescriptor(metadata) {
  const format = uploadTypes[metadata?.mime];
  if (!format || format[0] !== metadata.kind || metadata.voice === true) throw uploadFailure(400, 'Este formato de arquivo não está habilitado para envio Messenger.');
  if (metadata.status !== 'ready') throw uploadFailure(404, 'Este arquivo está indisponível.');
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 1) throw uploadFailure(400, 'Selecione um arquivo com conteúdo.');
  if (metadata.size > MAX_MEDIA_BYTES) throw uploadFailure(413, 'O limite Elozi por arquivo Messenger é 16 MiB.');
  return { type: metadata.kind === 'document' ? 'file' : metadata.kind,
    filename: `attachment.${format[1]}`, metadata: { id: metadata.id, kind: metadata.kind, name: metadata.name,
      mime: metadata.mime, size: metadata.size, preview: metadata.preview === true, status: 'ready' } };
}

export function validateMessengerUpload({ metadata, bytes }) {
  const result = messengerUploadDescriptor(metadata), validated = validateMedia(bytes, metadata);
  if (validated.kind !== metadata.kind || validated.mime !== metadata.mime || validated.size !== metadata.size) throw uploadFailure(400, 'O arquivo Messenger mudou. Selecione o arquivo novamente.');
  return result;
}

/** Native signed CDN URL is transient input, never attachment metadata or diagnostics. */
export function metaMediaURL(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\p{Cc}]/u.test(value)) throw failure(400);
  let url; try { url = new URL(value); } catch { throw failure(400); }
  const native = /^(?:scontent|video)(?:-[a-z0-9-]+)?(?:\.[a-z0-9-]+)?\.(?:fbcdn\.net|cdninstagram\.com)$/.test(url.hostname)
    || url.hostname === 'cdn.fbsbx.com' && url.pathname.startsWith('/v/')
    || url.hostname === 'lookaside.fbsbx.com' && url.pathname === '/ig_messaging_cdn/';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !native || isIP(url.hostname)
    || [...url.searchParams.keys()].some(key => /^(?:access_token|authorization|password|api_key|cookie)$/i.test(key))) throw failure(400);
  return url;
}

const address = value => {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const normalized = new URL(`https://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
};
const abortable = (operation, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(failure());
  if (signal.aborted) return abort();
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
});

/** One DNS-pinned TLS request: no credentials, cookies, redirects or decompression. */
export function createMetaMediaDownloader({ lookupImpl = lookup, requestImpl = request, timeoutMs = 15000, maxBytes = MAX_MEDIA_BYTES } = {}) {
  if (typeof lookupImpl !== 'function' || typeof requestImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES) throw new Error('Captura Meta exige limites e transporte válidos.');
  return async ({ url: value, kind, signal, reauthorize }) => {
    const url = metaMediaURL(value);
    if (!Object.hasOwn(mimes, kind) || typeof reauthorize !== 'function') throw failure(400);
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const fresh = () => { if (boundedSignal.aborted) throw failure(); const result = reauthorize(); if (result?.then) { Promise.resolve(result).catch(() => {}); throw failure(); } if (result === false) throw failure(); };
    try {
      fresh();
      const records = await abortable(() => lookupImpl(url.hostname, { all: true, verbatim: true }), boundedSignal);
      fresh();
      if (!Array.isArray(records) || !records.length || records.length > 16 || records.some(item => !item || ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicDeploymentAddress(item.address))) throw failure();
      const pinned = records[0];
      return await new Promise((resolve, reject) => {
        let outgoing, incoming, ended = false;
        const finish = (error, value) => { if (ended) return; ended = true; boundedSignal.removeEventListener('abort', abort); if (error) { incoming?.destroy(); outgoing?.destroy(); reject(error?.status === 413 ? failure(413) : failure()); } else resolve(value); };
        const abort = () => finish(failure());
        boundedSignal.addEventListener('abort', abort, { once: true });
        if (boundedSignal.aborted) return abort();
        try {
          fresh();
          outgoing = requestImpl(url, { method: 'GET', agent: false, servername: url.hostname, rejectUnauthorized: true,
            lookup: (host, options, callback) => { if (host !== url.hostname) return callback(failure()); options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family); },
            headers: { Accept: '*/*', 'Accept-Encoding': 'identity', Connection: 'close' }, signal: boundedSignal }, response => {
            incoming = response;
            if (ended) { response.destroy(); return; }
            try {
              fresh();
              const socket = response.socket, certificate = socket?.getPeerCertificate?.();
              if (response.statusCode !== 200 || !socket?.encrypted || socket.authorized !== true || address(socket.remoteAddress) !== address(pinned.address)
                || !certificate || checkServerIdentity(url.hostname, certificate) || response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw failure();
              const mime = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase(), declared = response.headers?.['content-length'];
              if (!mimes[kind].includes(mime)) throw failure();
              if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes)) throw failure(/^\d+$/.test(String(declared)) && Number(declared) > maxBytes ? 413 : 502);
              const chunks = []; let size = 0;
              response.on('data', chunk => {
                if (ended) return;
                try { fresh(); const bytes = Buffer.from(chunk); size += bytes.length; if (size > maxBytes) throw failure(413); chunks.push(bytes); } catch (error) { finish(error); }
              });
              response.on('end', () => {
                if (ended) return;
                try { fresh(); if (declared !== undefined && Number(declared) !== size) throw failure(); const bytes = Buffer.concat(chunks, size), metadata = validateMedia(bytes, { kind, mime, name: names[kind] });
                  if (metadata.kind !== kind || metadata.mime !== mime) throw failure(); fresh(); finish(null, { bytes, metadata: { kind: metadata.kind, mime: metadata.mime, name: metadata.name } }); } catch (error) { finish(error); }
              });
              response.on('error', () => finish(failure())); response.on('aborted', () => finish(failure()));
              response.on('close', () => { if (!ended) finish(failure()); });
            } catch (error) { finish(error); }
          });
          outgoing.on('error', () => finish(failure())); outgoing.end();
        } catch (error) { finish(error); }
      });
    } catch (error) { throw error?.status === 413 ? failure(413) : failure(); }
  };
}
