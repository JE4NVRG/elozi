import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
import { glyph } from './icons.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 5 * 60;
const STOP_TIMEOUT_MS = 10_000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clock = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

function stopTracks(stream) {
  for (const track of stream?.getTracks() || []) {
    try { track.stop(); } catch { /* Continue releasing the remaining microphone tracks. */ }
  }
}

function recordingError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' || error?.name === 'SecurityError') return i18nText('O acesso ao microfone foi negado. Permita o microfone no navegador para gravar áudio.');
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return i18nText('Nenhum microfone foi encontrado. Conecte um microfone e tente novamente.');
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return i18nText('Não foi possível acessar o microfone. Confira se ele está disponível e tente novamente.');
  return i18nText('Não foi possível gravar o áudio. Tente novamente.');
}

function fileExtension(mime) {
  return ({ 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' })[mime.toLowerCase().split(';')[0].trim()] || 'audio';
}

export function createVoiceRecorder({ onFile = () => {}, onState = () => {}, onError = () => {} } = {}) {
  let state = 'idle', elapsedSeconds = 0, error = '', context = null, generation = 0, active = null;
  const supported = () => typeof globalThis.MediaRecorder === 'function' && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';
  const emit = () => onState({ state, elapsedSeconds, maxSeconds: MAX_SECONDS });
  const isCurrent = session => active === session && session.generation === generation;

  function clearTimers(session) {
    clearInterval(session.tickTimer); clearTimeout(session.limitTimer); clearTimeout(session.stopTimer);
    session.tickTimer = session.limitTimer = session.stopTimer = undefined;
  }

  function releaseStream(session) {
    if (session.released) return;
    session.released = true; stopTracks(session.stream);
  }

  function detach(session) {
    if (session.recorder) session.recorder.ondataavailable = session.recorder.onstop = session.recorder.onerror = null;
  }

  function abortSession(session) {
    clearTimers(session); detach(session); session.chunks = [];
    try { if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop(); }
    catch { /* Discard must still release the stream if the browser recorder fails. */ }
    finally { releaseStream(session); }
  }

  function fail(message, session = active) {
    if (session && !isCurrent(session)) return;
    if (session) { active = null; generation++; abortSession(session); }
    state = 'idle'; elapsedSeconds = 0; error = message; emit(); onError(message);
  }

  function reset() {
    generation++;
    const prior = active; active = null;
    if (prior) abortSession(prior);
    state = 'idle'; elapsedSeconds = 0; error = ''; emit();
  }

  function finish(session) {
    if (!isCurrent(session)) return;
    clearTimers(session); releaseStream(session); detach(session);
    const chunks = session.chunks;
    session.chunks = []; active = null; state = 'idle'; elapsedSeconds = 0; emit();
    if (session.generation !== generation) return;
    if (!session.bytes) { error = i18nText('A gravação ficou vazia. Grave novamente antes de anexar.'); emit(); onError(error); return; }
    try {
      const mime = session.recorder.mimeType || chunks.find(chunk => chunk.type)?.type || session.mime || 'audio/webm';
      const file = new File(chunks, i18nTemplate`Áudio-${new Date().toISOString().replace(/[:.]/g, '-')}.${fileExtension(mime)}`, { type: mime });
      const result = onFile(file);
      // An async consumer may reject after the user has already changed conversations.
      Promise.resolve(result).catch(() => { if (session.generation === generation) fail(i18nText('Não foi possível anexar a gravação. Tente novamente.')); });
    } catch { if (session.generation === generation) fail(i18nText('Não foi possível anexar a gravação. Tente novamente.')); }
  }

  function stop() {
    if (state === 'requesting') { reset(); return; }
    if (state !== 'recording' || !active) return;
    const session = active;
    state = 'stopping'; clearTimers(session); emit();
    if (!isCurrent(session)) return;
    session.stopTimer = setTimeout(() => fail(i18nText('O navegador não concluiu a gravação. Grave novamente.'), session), STOP_TIMEOUT_MS);
    try {
      if (session.recorder.state === 'inactive') finish(session);
      else session.recorder.stop();
    } catch { fail(i18nText('Não foi possível concluir a gravação. Grave novamente.'), session); }
    finally { releaseStream(session); }
  }

  async function start() {
    if (state !== 'idle') return;
    if (!supported()) { fail(i18nText('Este navegador não oferece gravação de áudio. Anexe um arquivo de áudio.')); return; }
    error = ''; elapsedSeconds = 0; state = 'requesting';
    const session = { generation: ++generation, stream: null, recorder: null, chunks: [], bytes: 0, released: false };
    active = session; emit();
    if (!isCurrent(session)) return;
    try {
      // This is the only microphone request and is reached solely by an explicit start action.
      const stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent(session)) { stopTracks(stream); return; }
      session.stream = stream;
      const Recorder = globalThis.MediaRecorder;
      session.mime = typeof Recorder.isTypeSupported === 'function' ? MIME_TYPES.find(mime => Recorder.isTypeSupported(mime)) : undefined;
      try { session.recorder = new Recorder(stream, session.mime ? { mimeType: session.mime } : undefined); }
      catch { session.recorder = new Recorder(stream); session.mime = undefined; }
      session.recorder.ondataavailable = event => {
        if (!isCurrent(session) || !event.data?.size) return;
        session.bytes += event.data.size;
        if (session.bytes > MAX_BYTES) { fail(i18nText('A gravação ultrapassou o limite de 16 MB. Grave um áudio menor.'), session); return; }
        session.chunks.push(event.data);
      };
      session.recorder.onstop = () => finish(session);
      session.recorder.onerror = event => fail(recordingError(event.error), session);
      session.recorder.start(1000);
      if (!isCurrent(session)) return;
      session.startedAt = Date.now(); state = 'recording';
      session.tickTimer = setInterval(() => {
        if (!isCurrent(session) || state !== 'recording') return;
        elapsedSeconds = Math.min(MAX_SECONDS, Math.floor((Date.now() - session.startedAt) / 1000)); emit();
      }, 1000);
      session.limitTimer = setTimeout(stop, MAX_SECONDS * 1000); emit();
    } catch (caught) { if (isCurrent(session)) fail(recordingError(caught), session); }
  }

  function markup(disabled = false) {
    const button = (action, label, unavailable = disabled, extra = '') => {
      const idle = action === 'start', name = escape(label);
      return `<button type="button" class="text-button voice-recorder-button" data-voice-action="${action}" ${unavailable ? 'disabled' : ''} ${idle ? `aria-label="${name}" title="${name}"` : ''} ${extra}>${idle ? `${glyph('microphone')}<span class="pg-inbox__tool-label">${name}</span>` : name}</button>`;
    };
    let controls, status, timer = '';
    if (state === 'requesting') { controls = button('cancel', i18nText('Cancelar')); status = i18nText('Aguardando permissão do microfone…'); }
    else if (state === 'recording') { controls = button('stop', i18nText('Parar gravação')) + button('cancel', i18nText('Descartar')); status = i18nText('Gravando áudio'); timer = i18nHtml`<span class="voice-recorder-timer" role="timer" aria-label="Duração do áudio" aria-live="off">${clock(elapsedSeconds)} / 05:00</span>`; }
    else if (state === 'stopping') { controls = button('cancel', i18nText('Descartar')); status = i18nText('Preparando áudio para revisão…'); }
    else { controls = button('start', i18nText('Gravar áudio'), disabled || !supported(), 'aria-describedby="voice-recorder-status"'); status = supported() ? i18nText('Até 5 minutos e 16 MB. Revise o áudio antes de enviar.') : i18nText('Gravação indisponível neste navegador. Anexe um arquivo de áudio.'); }
    return `<div class="voice-recorder" data-voice-state="${state}"><div class="voice-recorder-controls">${controls}</div><span id="voice-recorder-status" class="voice-recorder-status" role="status" aria-live="polite" aria-atomic="true">${status}</span>${timer}${error ? `<span class="form-error voice-recorder-error" role="alert">${escape(translateError(error))}</span>` : ''}</div>`;
  }

  return {
    markup, reset,
    handleAction(action) { if (action === 'start') return start(); if (action === 'stop') return stop(); if (action === 'cancel' || action === 'discard') reset(); },
    syncContext(key) { if (key === context) return; context = key; reset(); },
    get state() { return state; }, get busy() { return state !== 'idle'; }, get supported() { return supported(); }
  };
}
