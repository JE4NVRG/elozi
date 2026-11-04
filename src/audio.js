import { spawn } from 'node:child_process';
import { MAX_MEDIA_BYTES, validateMedia } from './media.js';
import { fail } from './store.js';

export const MAX_VOICE_SECONDS = 300;
const formats = new Map([['audio/webm', 'matroska'], ['audio/ogg', 'ogg'], ['audio/mp4', 'mov']]);
const oggMagic = Buffer.from('OggS'), opusMagic = Buffer.from('OpusHead');
let activeConversions = 0;

function opusHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 47) return null;
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!data.subarray(0, 4).equals(oggMagic) || data[4] !== 0 || data[5] !== 2 || data.readUInt32LE(18) !== 0) return null;
  const segments = data[26], body = 27 + segments;
  if (!segments || body > data.length) return null;
  let packetLength = 0, bodyLength = 0, packetComplete = false;
  for (let index = 0; index < segments; index++) {
    const length = data[27 + index]; bodyLength += length;
    if (!packetComplete) { packetLength += length; packetComplete = length < 255; }
  }
  if (body + bodyLength > data.length || !packetComplete || packetLength < 19 || !data.subarray(body, body + 8).equals(opusMagic)) return null;
  const packet = data.subarray(body, body + packetLength);
  // Mapping family zero is the mono/stereo Opus identification packet. A marker
  // elsewhere in an Ogg payload or a claimed filename/MIME does not identify it.
  if (packet[8] !== 1 || ![1, 2].includes(packet[9]) || packet[18] !== 0 || packetLength !== 19) return null;
  return { data, serial: data.readUInt32LE(14), preSkip: packet.readUInt16LE(10), channels: packet[9] };
}

export function isOggOpus(bytes) { return !!opusHeader(bytes); }

function outputDuration(bytes) {
  const header = opusHeader(bytes);
  if (!header || header.channels !== 1) return null;
  const { data, serial, preSkip } = header;
  let offset = 0, sequence = 0, lastGranule = 0n, endOfStream = false;
  while (offset < data.length) {
    if (endOfStream || offset + 27 > data.length || !data.subarray(offset, offset + 4).equals(oggMagic) || data[offset + 4] !== 0 || (data[offset + 5] & ~7) || data.readUInt32LE(offset + 14) !== serial || data.readUInt32LE(offset + 18) !== sequence++) return null;
    const segments = data[offset + 26], body = offset + 27 + segments;
    if (body > data.length) return null;
    let size = 0;
    for (let index = offset + 27; index < body; index++) size += data[index];
    if (body + size > data.length) return null;
    const granule = data.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn) {
      if (granule < lastGranule) return null;
      lastGranule = granule;
    }
    endOfStream = !!(data[offset + 5] & 4);
    offset = body + size;
  }
  if (!endOfStream || lastGranule <= BigInt(preSkip)) return null;
  return Number(lastGranule - BigInt(preSkip)) / 48000;
}

function argumentsFor(format) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', String(MAX_MEDIA_BYTES),
    '-filter_threads', '1', '-protocol_whitelist', 'pipe',
    '-format_whitelist', 'matroska,webm,ogg,mov,mp4,m4a,3gp,3g2,mj2',
    '-probesize', '1048576', '-analyzeduration', '1000000', '-threads', '1',
    '-f', format, '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1',
    // One extra Opus frame allows an overlong source to be rejected instead of
    // silently cutting its final words; decoding is still bounded near 5 min.
    '-t', '300.02', '-threads', '1', '-ac', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip',
    '-frame_duration', '20', '-avoid_negative_ts', 'make_zero', '-f', 'ogg', 'pipe:1'
  ];
}

/** Convert a browser recording in memory. Options only inject dependencies or lower limits. */
export async function normalizeVoiceRecording(bytes, { mime } = {}, { spawnImpl = spawn, timeoutMs = 30000, maxOutputBytes = MAX_MEDIA_BYTES } = {}) {
  const type = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  const format = formats.get(type);
  if (!format) fail(400, 'Grave o áudio em WebM, Ogg ou MP4.');
  validateMedia(bytes, { kind: 'audio', mime: type });
  if (typeof spawnImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_MEDIA_BYTES) throw new TypeError('Configuração de gravação inválida.');
  if (activeConversions >= 2) fail(429, 'Há outras gravações em processamento. Tente novamente em instantes.');
  const input = Buffer.from(bytes);
  activeConversions++;
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, released = false, size = 0;
    const output = [];
    const release = () => { if (!released) { released = true; activeConversions--; } };
    const finish = (status, message, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); output.length = 0;
      if (status) reject(Object.assign(new Error(message), { status }));
      else resolve(result);
    };
    const abort = (status, message) => {
      if (settled) return;
      finish(status, message);
      // A killed child keeps its concurrency slot until close, so a request
      // cannot start a third process while an earlier one is shutting down.
      try { child.kill('SIGKILL'); } catch {}
      child.stdin.destroy();
    };
    try { child = spawnImpl('ffmpeg', argumentsFor(format), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { release(); finish(503, 'A gravação de voz está temporariamente indisponível.'); return; }
    child.on('error', () => abort(503, 'A gravação de voz está temporariamente indisponível.'));
    child.stdin.on('error', () => abort(400, 'Não foi possível processar esta gravação. Grave novamente.'));
    child.stdout.on('error', () => abort(502, 'Não foi possível finalizar a gravação de voz.'));
    child.stderr.on('error', () => {});
    child.stderr.resume(); // Decoder diagnostics can include input data: discard, never return/store them.
    child.stdout.on('data', chunk => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > maxOutputBytes) abort(413, 'O limite por gravação é 16 MiB.');
      else output.push(data);
    });
    child.on('close', (code, signal) => {
      release();
      if (settled) return;
      if (code !== 0 || signal) { finish(400, 'Não foi possível processar esta gravação. Grave novamente.'); return; }
      const normalized = Buffer.concat(output, size), duration = outputDuration(normalized);
      if (duration === null) { finish(502, 'Não foi possível finalizar a gravação de voz.'); return; }
      // make_zero moves the first packet by its codec delay. Allow only that
      // bounded encoder padding plus one WebM timestamp tick (1 ms); a source
      // clipped at 300.02 s still fails on both supported FFmpeg versions.
      const encoderPadding = Math.min(opusHeader(normalized).preSkip, 960) / 48000 + 0.001;
      if (duration > MAX_VOICE_SECONDS + encoderPadding) { finish(400, 'A gravação pode ter até cinco minutos.'); return; }
      finish(null, null, { bytes: normalized, kind: 'audio', mime: 'audio/ogg', name: 'Mensagem de voz.ogg' });
    });
    timer = setTimeout(() => abort(504, 'O processamento da gravação excedeu o tempo limite.'), timeoutMs);
    try { child.stdin.end(input); }
    catch { abort(400, 'Não foi possível processar esta gravação. Grave novamente.'); }
  });
}
