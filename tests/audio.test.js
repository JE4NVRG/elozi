import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { normalizeVoiceRecording, isOggOpus, MAX_VOICE_SECONDS } from '../src/audio.js';
import { MAX_MEDIA_BYTES } from '../src/media.js';

const webm = Buffer.concat([Buffer.from([26, 69, 223, 163]), Buffer.from('Fixture sintética')]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture')]);
const status = value => error => error.status === value;
function page(packet, { flags = 0, sequence = 0, granule = 0n } = {}) {
  const header = Buffer.alloc(28); header.write('OggS'); header[5] = flags;
  header.writeBigUInt64LE(granule, 6); header.writeUInt32LE(1, 14); header.writeUInt32LE(sequence, 18);
  header[26] = 1; header[27] = packet.length;
  return Buffer.concat([header, packet]);
}
function ogg(seconds = 0.1) {
  const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  return Buffer.concat([page(head, { flags: 2 }), page(Buffer.from('OpusTagsfixture'), { sequence: 1 }), page(Buffer.from([0xf8, 0xff, 0xfe]), { flags: 4, sequence: 2, granule: BigInt(Math.round(seconds * 48000) + 312) })]);
}
function processFixture(run) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const chunks = []; child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
  if (run) child.stdin.on('finish', () => queueMicrotask(() => run(child, Buffer.concat(chunks))));
  return child;
}
function encoder(result = ogg(), observe) {
  return (command, args, options) => {
    observe?.(command, args, options);
    return processFixture(child => { child.stdout.write(result); child.emit('close', 0, null); });
  };
}

test('gravações WebM/Ogg/MP4 são normalizadas por pipe com opções fixas e metadados mínimos', async () => {
  const output = ogg(), calls = [];
  const spawnImpl = encoder(output, (command, args, options) => calls.push({ command, args, options }));
  for (const [mime, bytes, format] of [['audio/webm;codecs=opus', webm, 'matroska'], ['audio/ogg; codecs=opus', ogg(), 'ogg'], ['audio/mp4;codecs=mp4a.40.2', mp4, 'mov']]) {
    const original = Buffer.from(bytes), result = await normalizeVoiceRecording(bytes, { mime }, { spawnImpl });
    assert.deepEqual(result, { bytes: output, kind: 'audio', mime: 'audio/ogg', name: 'Mensagem de voz.ogg' });
    assert.deepEqual(bytes, original);
    const call = calls.at(-1), position = flag => call.args.indexOf(flag);
    assert.equal(call.command, 'ffmpeg'); assert.deepEqual(call.options, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(call.args[position('-protocol_whitelist') + 1], 'pipe');
    assert.equal(call.args[position('-f') + 1], format); assert.equal(call.args[position('-i') + 1], 'pipe:0'); assert.equal(call.args.at(-1), 'pipe:1');
    assert.equal(call.args[position('-c:a') + 1], 'libopus'); assert.equal(call.args[position('-ac') + 1], '1');
    assert.equal(call.args[position('-map_metadata') + 1], '-1'); assert.equal(call.args[position('-t') + 1], '300.02');
    for (const [index, value] of call.args.entries()) if (['-threads', '-filter_threads'].includes(value)) assert.equal(call.args[index + 1], '1');
    assert.equal(call.args.some(value => /https?:|file:|secret/i.test(value)), false);
  }
  assert.equal(calls.length, 3);
});

test('normalização recusa MIME/assinatura incompatíveis e limites antes de iniciar processo', async () => {
  let calls = 0;
  const options = { spawnImpl: () => { calls++; throw new Error('Nunca iniciar'); } };
  for (const mime of ['audio/mpeg', 'video/webm', 'application/octet-stream', 'audio/webm\r\nprotocol_whitelist=file', undefined]) await assert.rejects(normalizeVoiceRecording(webm, { mime }, options), status(400));
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/ogg' }, options), status(400));
  await assert.rejects(normalizeVoiceRecording(mp4, { mime: 'audio/webm' }, options), status(400));
  await assert.rejects(normalizeVoiceRecording(Buffer.alloc(0), { mime: 'audio/webm' }, options), status(400));
  await assert.rejects(normalizeVoiceRecording(Buffer.alloc(MAX_MEDIA_BYTES + 1), { mime: 'audio/webm' }, options), status(413));
  assert.equal(calls, 0);
});

test('identificação de voz exige primeiro pacote de identificação Opus em página Ogg completa', () => {
  assert.equal(isOggOpus(ogg()), true); assert.equal(isOggOpus(new Uint8Array(ogg())), true);
  for (const data of [webm, Buffer.from('OggSOpusHead'), Buffer.concat([page(Buffer.alloc(19), { flags: 2 }), Buffer.from('OpusHead')]), ogg().subarray(0, 46)]) assert.equal(isOggOpus(data), false);
  for (const [offset, value] of [[4, 1], [5, 0], [18, 1], [26, 255], [36, 255], [37, 0], [46, 1]]) {
    const data = ogg(); data[offset] = value; assert.equal(isOggOpus(data), false, `offset ${offset}`);
  }
});

test('falhas de spawn/decoder/streams retornam erro sanitizado sem diagnósticos', async () => {
  const sensitive = 'token-fixture segredo-do-cliente https://provider.invalid/private';
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl: () => { throw new Error(sensitive); } }), error => error.status === 503 && !error.message.includes('segredo') && !error.cause);
  for (const failure of ['spawn', 'stdin', 'stdout', 'exit', 'signal']) {
    const spawnImpl = () => processFixture(child => {
      child.stderr.write(sensitive);
      if (failure === 'spawn') child.emit('error', new Error(sensitive));
      else if (['stdin', 'stdout'].includes(failure)) child[failure].emit('error', new Error(sensitive));
      else child.emit('close', failure === 'exit' ? 1 : 0, failure === 'signal' ? 'SIGTERM' : null);
    });
    await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl }), error => [400, 502, 503].includes(error.status) && !error.message.includes('segredo') && !error.message.includes('provider.invalid') && !error.cause);
  }
});

test('encoder rejeita saída vazia/codec incorreto/container incompleto e duração acima de cinco minutos', async () => {
  const incomplete = ogg(); incomplete[incomplete.length - 31 + 5] = 0;
  for (const output of [Buffer.alloc(0), webm, Buffer.from('OggS000000000000000000OpusHeadfixture'), ogg().subarray(0, 47), incomplete]) await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl: encoder(output) }), status(502));
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl: encoder(ogg(MAX_VOICE_SECONDS + 0.02)) }), error => error.status === 400 && error.message.includes('cinco minutos'));
  assert.equal((await normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl: encoder(ogg(MAX_VOICE_SECONDS)) })).mime, 'audio/ogg');
});

test('normalização mata processo por saída excessiva e timeout; limites internos não podem subir', async () => {
  let child;
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { maxOutputBytes: 10, spawnImpl: () => child = processFixture(process => process.stdout.write(ogg())) }), status(413));
  assert.equal(child.killed, 'SIGKILL');
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { timeoutMs: 10, spawnImpl: () => child = processFixture() }), status(504));
  assert.equal(child.killed, 'SIGKILL');
  for (const options of [{ timeoutMs: 30001 }, { timeoutMs: 0 }, { maxOutputBytes: MAX_MEDIA_BYTES + 1 }, { maxOutputBytes: 0 }, { spawnImpl: null }]) await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, options), TypeError);
});

test('limite global é dois processos e mantém slot até close depois de abortar', async () => {
  const children = [], spawnImpl = () => { const child = processFixture(); children.push(child); return child; };
  const first = normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl });
  const second = normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl });
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl }), status(429));
  assert.equal(children.length, 2);
  // Emulate a child taking time to close after SIGKILL.
  children[0].kill = signal => { children[0].killed = signal; return true; };
  children[0].stdout.emit('error', new Error('Fixture sem diagnóstico externo'));
  await assert.rejects(first, status(502));
  await assert.rejects(normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl }), status(429));
  children[0].emit('close', null, 'SIGKILL');
  children[1].stdout.write(ogg()); children[1].emit('close', 0, null); await second;
  assert.equal((await normalizeVoiceRecording(webm, { mime: 'audio/webm' }, { spawnImpl: encoder() })).mime, 'audio/ogg');
});

test('FFmpeg real converte gravações sintéticas WebM/Ogg/MP4 em voz Ogg Opus decodificável sem arquivos', async t => {
  const available = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  if (available.error?.code === 'ENOENT') { t.skip('FFmpeg não instalado neste executor; normalização exige FFmpeg no runtime.'); return; }
  assert.equal(available.status, 0);
  const fixed = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1'];
  for (const [mime, encoding] of [['audio/webm', ['-c:a', 'libopus', '-f', 'webm']], ['audio/ogg', ['-c:a', 'libvorbis', '-f', 'ogg']], ['audio/mp4', ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']]]) {
    const generated = spawnSync('ffmpeg', [...fixed, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-map_metadata', '-1', '-ac', '1', ...encoding, 'pipe:1'], { shell: false, windowsHide: true, timeout: 10000, maxBuffer: MAX_MEDIA_BYTES });
    assert.equal(generated.status, 0, `gera ${mime}`); assert.ok(generated.stdout.length > 0);
    const normalized = await normalizeVoiceRecording(generated.stdout, { mime });
    assert.equal(isOggOpus(normalized.bytes), true); assert.equal(normalized.mime, 'audio/ogg');
    const packets = spawnSync('ffmpeg', [...fixed, '-copyts', '-protocol_whitelist', 'pipe', '-f', 'ogg', '-i', 'pipe:0', '-map', '0:a:0', '-c:a', 'copy', '-f', 'framecrc', 'pipe:1'], { input: normalized.bytes, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    assert.equal(packets.status, 0, `lê timestamps ${mime}`);
    const first = packets.stdout.toString().split('\n').find(line => line.trim() && !line.startsWith('#'));
    assert.ok(first, `pacote ${mime}`);
    assert.ok(Number(first.split(',')[1]) >= 0 && Number(first.split(',')[2]) >= 0, `sem timestamp negativo no primeiro pacote ${mime}`);
    const decoded = spawnSync('ffmpeg', [...fixed, '-protocol_whitelist', 'pipe', '-f', 'ogg', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { input: normalized.bytes, shell: false, windowsHide: true, timeout: 10000, maxBuffer: MAX_MEDIA_BYTES });
    assert.equal(decoded.status, 0, `decodifica ${mime}`); assert.ok(decoded.stdout.length >= 1600);
    let energy = 0;
    for (let offset = 0; offset < decoded.stdout.length; offset += 2) energy += decoded.stdout.readInt16LE(offset) ** 2;
    assert.ok(energy > 0, `sinal audível em ${mime}`);
  }
});

test('FFmpeg real aceita cinco minutos exatos e rejeita excesso sem perder a correção de timestamps', async t => {
  const available = spawnSync('ffmpeg', ['-hide_banner', '-version'], { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  if (available.error?.code === 'ENOENT') { t.skip('FFmpeg não instalado neste executor.'); return; }
  assert.equal(available.status, 0);
  for (const seconds of [300, 300.04]) {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', '-c:a', 'libopus', '-b:a', '16k', '-f', 'webm', 'pipe:1'], { shell: false, windowsHide: true, timeout: 30000, maxBuffer: MAX_MEDIA_BYTES });
    assert.equal(generated.status, 0);
    const conversion = normalizeVoiceRecording(generated.stdout, { mime: 'audio/webm' });
    if (seconds === 300) assert.ok(isOggOpus((await conversion).bytes));
    else await assert.rejects(conversion, status(400));
  }
});
