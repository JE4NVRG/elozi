import { allowedFields } from './access.js';
import { fail } from './store.js';
import { MAX_MEDIA_BYTES, outgoingText, validateMedia } from './media.js';

export const WEBCHAT_MEDIA_METADATA_MAX_BYTES = 8192;
export const WEBCHAT_MEDIA_FRAME_MAX_BYTES = MAX_MEDIA_BYTES + WEBCHAT_MEDIA_METADATA_MAX_BYTES + 4;
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);

function metadata(input) {
  allowedFields(input, ['clientMessageId', 'text', 'name', 'mime', 'voice']);
  if (!opaque(input.clientMessageId)) fail(400, 'Identificador de mensagem do webchat inválido.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 512
    || typeof input.mime !== 'string' || !input.mime.trim() || input.mime.length > 120 || /[\x00-\x1f\x7f]/.test(input.mime)
    || input.voice !== undefined && typeof input.voice !== 'boolean') fail(400, 'Metadados de arquivo inválidos.');
  const content = outgoingText(input, true);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail(400, 'Legenda de webchat inválida.');
  const mime = input.mime.split(';')[0].trim().toLowerCase(), voice = input.voice ?? false;
  if (voice && !mime.startsWith('audio/')) fail(400, 'Gravações de voz precisam conter áudio.');
  return { clientMessageId: input.clientMessageId, text: content, name: input.name, mime, voice };
}

/** Validate the bounded header before the HTTP reader buffers any file bytes. */
export function decodeWebchatMediaMetadata(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) fail(400, 'Cabeçalho de arquivo inválido.');
  if (bytes.byteLength > WEBCHAT_MEDIA_METADATA_MAX_BYTES) fail(413, 'Cabeçalho de arquivo acima do limite.');
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'Cabeçalho de arquivo inválido.'); }
  return metadata(input);
}

/** The adapter owns a snapshot: callers cannot alter bytes while capture awaits. */
export function validateWebchatMedia(input) {
  allowedFields(input, ['clientMessageId', 'text', 'attachment']);
  allowedFields(input.attachment, ['bytes', 'name', 'mime', 'voice']);
  const header = metadata({ clientMessageId: input.clientMessageId, text: input.text,
    name: input.attachment.name, mime: input.attachment.mime, voice: input.attachment.voice });
  const validated = validateMedia(input.attachment.bytes, header);
  if (header.voice && validated.kind !== 'audio') fail(400, 'Este formato não permite gravações de voz.');
  return { clientMessageId: header.clientMessageId, text: header.text,
    attachment: { ...validated, voice: header.voice, bytes: Buffer.from(input.attachment.bytes) } };
}

export function decodeWebchatMedia(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) fail(400, 'Frame de arquivo inválido.');
  if (bytes.byteLength > WEBCHAT_MEDIA_FRAME_MAX_BYTES) fail(413, 'Arquivo acima do limite do webchat.');
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = frame.readUInt32BE(0);
  if (!length || length > WEBCHAT_MEDIA_METADATA_MAX_BYTES) fail(length > WEBCHAT_MEDIA_METADATA_MAX_BYTES ? 413 : 400, 'Cabeçalho de arquivo inválido.');
  if (length >= frame.length - 4) fail(400, 'Frame de arquivo incompleto.');
  const header = decodeWebchatMediaMetadata(frame.subarray(4, 4 + length));
  const result = validateWebchatMedia({ clientMessageId: header.clientMessageId, text: header.text,
    attachment: { bytes: frame.subarray(4 + length), name: header.name, mime: header.mime, voice: header.voice } });
  // Do not expose internal preview/size fields as accepted attachment input.
  return { clientMessageId: result.clientMessageId, text: result.text,
    attachment: { bytes: result.attachment.bytes, name: result.attachment.name, mime: result.attachment.mime, voice: result.attachment.voice } };
}
