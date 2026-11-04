import './locales-telegram-account.js';
import { t, txt, getLocale } from './i18n.js';
import './locales-channel-recovery.js';
import './locales-shell.js';
import './locales-home.js';

// Channel connection flow (FRONTEND-V2 §5.5, §8.8): the stepper Nome → Conectar → Testar → Grupos
// over the existing routes (POST channels, POST channels/:id/connect, GET channels/:id/connection,
// GET/POST channels/:id/groups, POST channels/:id/profile) and the "primeira mensagem" test over
// GET /api/inbox?tenantId=&channelId=&limit=1. Owned by P7. Pure models plus two small controllers
// (poller and round-trip test) that never ask the server while the drawer is closed or the tab hidden.
//
// App services. app.js gives api/state/openModal/toast/refresh only to createChannelConnectorsUI
// (channel-connectors-ui.js, P7), which publishes them here once with provideAppServices(); the
// Canais, Visão geral and #setup screens of P7 read them with appServices(). Services passed
// explicitly to createChannelsUI/createOnboarding (integrator, P10) win over this bridge.
let services = null;
/** Records the app services ({state, api, openModal, toast, refresh}); returns them. */
export function provideAppServices(value) {
  services = value && typeof value === 'object' ? Object.freeze({ ...value }) : null;
  return services;
}
/** The app services recorded by provideAppServices(), or null (tests, before app.js boots). */
export function appServices() { return services; }

/** Steps of the connection drawer, in order. */
export const CONNECT_STEPS = Object.freeze(['name', 'connect', 'test', 'groups']);
/** Every state of app.js connectionStateNames; the stepper has a view for each. */
export const CONNECTION_STATES = Object.freeze(['disconnected', 'starting', 'qr', 'connecting', 'reconnecting', 'connected', 'logged_out', 'wrong_number', 'failed', 'configured']);
/** Kinds the server connects for real (POST channels with real:true). */
export const CONNECTABLE_KINDS = Object.freeze(['whatsapp_qr', 'telegram', 'telegram_user', 'webchat', 'email', 'instagram', 'messenger']);
const CONNECTORS = new Set(['webchat', 'email', 'instagram', 'messenger']);
const POLLED = new Set(['starting', 'qr', 'connecting', 'reconnecting']);
const PROBLEM = new Set(['disconnected', 'logged_out', 'wrong_number', 'failed']);

const text = (value, max = 240) => typeof value === 'string' && value.length <= max && !/\p{Cc}/u.test(value) ? value : '';
const stamp = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : 0; };

/** 'qr' (WhatsApp QR), 'bot' (Telegram) or 'connector' (webchat, e-mail, Meta); null otherwise. */
export function channelTransport(channel) {
  if (!channel || typeof channel !== 'object') return null;
  if (channel.transport === 'baileys' && channel.kind === 'whatsapp_qr') return 'qr';
  if (channel.transport === 'telegram-bot' && channel.kind === 'telegram') return 'bot';
  if(channel.transport==='telegram-user'&&channel.kind==='telegram_user')return 'account';
  if (CONNECTORS.has(channel.kind)) return 'connector';
  return null;
}
/** Group selection lives inside WhatsApp QR and Telegram channels only. */
export const hasGroups = channel => ['qr', 'bot', 'account'].includes(channelTransport(channel));

/** Health of a channel for the list and the banner: ok, pending, problem, setup (never connected) or unknown. */
export function channelHealth(channel) {
  if (!channel || channel.enabled === false || channel.state === 'disabled') return 'unknown';
  const transport = channelTransport(channel), state = CONNECTION_STATES.includes(channel.state) ? channel.state : null;
  if (!transport) return 'unknown';
  if (state === 'connected' || state === 'configured') return 'ok';
  if (POLLED.has(state)) return 'pending';
  if (transport === 'connector') return 'setup';
  if (state === 'disconnected') return channel.linkedAt ? 'problem' : 'setup';
  if (PROBLEM.has(state)) return 'problem';
  return 'setup';
}

// Labels the server writes on a channel (or its connection status) in Portuguese; the panel shows
// them in its language. Same list and rule as displayChannelLabel in app.js: anything else typed by
// a person stays byte for byte.
const GENERATED_LABELS = new Set([
  'Número A · demonstração', 'Número B · demonstração', 'Widget de demonstração', 'Integração pendente',
  'Webchat por origens autorizadas', 'Webchat desativado',
  'Meta configurada · aceite da conta pendente', 'Meta desativada', 'Webhook Meta recebido',
  'MepMail e relay assinado; caixa postal externa necessária', 'Canal de e-mail desativado',
  'Bot aguardando conexão', 'Conta Telegram aguardando conexão', 'Aguardando configuração do canal'
]);
/** The label of a channel (or connection status) in the panel language; '' when there is none. */
export function channelLabel(source) {
  const label = typeof source?.label === 'string' ? source.label : '';
  if (!label) return '';
  if (GENERATED_LABELS.has(label)) return t(label);
  const testNumber = /^Número de teste · final (\d{4})$/.exec(label);
  return testNumber ? txt`Número de teste · final ${testNumber[1]}` : label;
}

/** Last four digits the person expects to read the QR with ("final 4321" in the channel label). */
export function expectedSuffix(channel) {
  const match = /final (\d{4})\b/.exec(text(channel?.label));
  return match ? match[1] : '';
}

const timeOf = value => new Date(stamp(value)).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });

/**
 * View model of one connection status (GET channels/:id/connection, or the channel DTO for the
 * connectors) → {state, tone, title, body, action, poll, done, qr}. tone: info|success|warning|danger.
 * action: null or {verb:'start'|'token'|'configure', label}. poll: keep asking the server.
 */
export function connectionView(channel, status = null, { now = Date.now() } = {}) {
  const transport = channelTransport(channel);
  const source = status && typeof status === 'object' ? status : channel || {};
  const state = CONNECTION_STATES.includes(source.state) ? source.state : 'disconnected';
  const error = text(source.error, 300);
  const suffix = expectedSuffix(channel);
  const view = { state, tone: 'info', title: '', body: '', action: null, poll: false, done: false, qr: null };
  if(transport==='account')return {...view,done:state==='connected',tone:state==='connected'?'success':'info',title:t(state==='connected'?'Conta Telegram conectada':'Conectar conta Telegram'),body:t('Escolha as conversas da sua conta para atendimento humano.'),action:{verb:'account',label:t('Abrir conexão pessoal')}};
  if (transport === 'connector') {
    const ready = state === 'connected' || state === 'configured';
    return { ...view, tone: ready ? 'success' : 'info', done: ready,
      title: ready ? (channel.kind === 'webchat' ? t('Pronto agora') : t('Configurado · validar recebimento')) : t('Configuração pendente'),
      body: ready ? t('A configuração foi salva. Faça o teste para confirmar a chegada da primeira mensagem.') : t('Abra a configuração do canal, preencha os dados e salve.'),
      action: { verb: 'configure', label: ready ? t('Revisar configuração') : t('Configurar canal') } };
  }
  if (transport === 'bot') {
    const username = text(source.username, 64) || text(channel?.botUsername, 64);
    if (state === 'connected') return { ...view, tone: 'success', done: true, title: username ? t('@{bot} conectado', { bot: username }) : t('Bot conectado'), body: t('O bot recebe mensagens. Faça o teste com /start.') };
    if (state === 'starting') return { ...view, poll: true, title: t('Validando o token…'), body: t('Confirmando o bot com o Telegram.') };
    if (state === 'reconnecting') return { ...view, poll: true, tone: 'warning', title: t('Reconectando'), body: t('O Telegram parou de responder. Tentamos de novo sozinhos.') };
    return { ...view, tone: state === 'failed' ? 'danger' : 'info', title: state === 'failed' ? t('Falha de conexão') : t('Cole o token do bot'), body: state === 'failed' ? error || t('O Telegram recusou a conexão. Confira o token e tente de novo.') : t('Crie o bot no @BotFather e cole o token aqui.'), action: { verb: 'token', label: t('Conectar bot') } };
  }
  if (transport !== 'qr') return { ...view, title: t('Integração pendente'), body: t('Este tipo de canal ainda não conecta por aqui.') };
  switch (state) {
    case 'starting': return { ...view, poll: true, title: t('Gerando QR'), body: t('Preparando o código de pareamento…') };
    case 'qr': return { ...view, poll: true, qr: typeof source.qr === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source.qr) ? source.qr : null, title: t('Aponte o celular para o código'), body: t('O código renova sozinho.') };
    case 'connecting': return { ...view, poll: true, title: t('Lido. Conectando…'), body: t('Não feche o WhatsApp até concluir.') };
    case 'reconnecting': return { ...view, poll: true, tone: 'warning', title: t('Reconectando'), body: stamp(source.nextRetryAt) ? t('Nova tentativa automática às {time}.', { time: timeOf(source.nextRetryAt) }) : t('A conexão caiu e tentamos de novo sozinhos.') };
    case 'connected': return { ...view, tone: 'success', done: true, title: t('Número conectado'), body: text(channelLabel(source)) || text(channelLabel(channel)) || t('O WhatsApp está pronto para receber mensagens.') };
    case 'logged_out': return { ...view, tone: 'danger', title: t('Sessão encerrada no celular'), body: t('O aparelho foi desconectado no WhatsApp. Gere um novo QR para parear de novo.'), action: { verb: 'start', label: t('Gerar novo QR') } };
    case 'wrong_number': return { ...view, tone: 'danger', title: t('Lido por outro número'), body: suffix ? t('Use o WhatsApp do número com final {suffix}.', { suffix }) : t('Use o WhatsApp do número cadastrado neste canal.'), action: { verb: 'start', label: t('Gerar novo QR') } };
    case 'failed': {
      // Only a future server retry, never a terminal restriction, keeps this GET observer alive.
      const retry = typeof source.nextRetryAt === 'string' && stamp(source.nextRetryAt) > now
        && (!source.failureReason || ['unstable', 'bad_session'].includes(source.failureReason));
      if (retry) return { ...view, poll: true, tone: 'warning', title: t('Retentativa agendada'), body: t('Nova tentativa automática às {time}.', { time: timeOf(source.nextRetryAt) }) };
      return { ...view, tone: 'danger', title: t('Falha de conexão'), body: error || t('Não foi possível concluir a conexão.'), action: { verb: 'start', label: t('Tentar de novo') } };
    }
    case 'configured': return { ...view, tone: 'success', done: true, title: t('Configurado · validar recebimento'), body: t('Faça o teste para confirmar a chegada da primeira mensagem.') };
    default: return { ...view, title: t('Desconectado'), body: suffix ? t('Gere o QR e leia com o WhatsApp do número com final {suffix}.', { suffix }) : t('Gere o QR e leia com o WhatsApp do número cadastrado.'), action: { verb: 'start', label: t('Gerar QR') } };
  }
}

/** Step the drawer opens on: name (new channel), connect (not ready) or test (ready). */
export function initialStep(channel, requested = null) {
  if (!channel) return 'name';
  if (requested && CONNECT_STEPS.includes(requested) && requested !== 'name') return requested === 'groups' && !hasGroups(channel) ? 'test' : requested;
  return connectionView(channel).done ? 'test' : 'connect';
}

/** Each step of the stepper as done, current, next or error (groups disabled without groups). */
export function stepperStates(step, { channel = null, connected = false, tested = false, error = false } = {}) {
  const index = CONNECT_STEPS.indexOf(step);
  return CONNECT_STEPS.map((id, position) => {
    const done = id === 'name' ? Boolean(channel) : id === 'connect' ? connected : id === 'test' ? tested : false;
    const state = position === index ? (error ? 'error' : 'current') : done || position < index ? 'done' : 'next';
    return { id, state, disabled: id === 'name' ? Boolean(channel) : !channel || id === 'groups' && !hasGroups(channel) };
  });
}

/** Known errors of POST channels/:id/connect for a Telegram token, as product copy; others → generic. */
export function telegramTokenError(error) {
  const message = String(error?.message || ''), status = Number(error?.status);
  if (/webhook/i.test(message)) return t('Este bot usa um webhook ativo. Crie um bot só para o atendimento.');
  if (/outro bot|outra conexão|another bot|another connection/i.test(message)) return t('Este bot já está ligado a outra conexão. Use um bot exclusivo.');
  if (/está conectando|is connecting/i.test(message)) return t('Este bot ainda está conectando. Aguarde a confirmação.');
  if (status === 400 || status === 401 || /token|bot válido|valid bot/i.test(message)) return t('Token não aceito. Copie de novo o token do @BotFather.');
  return t('Não conseguimos validar o token agora. Tente de novo.');
}

/**
 * Calls tick() every `interval` ms while running, the tab is visible and active() holds. A hidden
 * tab pauses it (no request); showing the tab again asks once and resumes. tick() returning false,
 * active() turning false or stop() end it for good.
 */
export function createPoller({ tick, interval = 2000, active = () => true, document: doc = globalThis.document, timers = globalThis } = {}) {
  if (typeof tick !== 'function') throw new TypeError('createPoller needs tick()');
  let running = false, timer = null, busy = false, generation = 0;
  const hidden = () => doc?.visibilityState === 'hidden';
  const clear = () => { if (timer !== null) timers.clearTimeout(timer); timer = null; };
  const schedule = () => { clear(); if (running && !hidden()) timer = timers.setTimeout(run, interval); };
  async function run() {
    timer = null;
    if (!running || busy) return;
    if (!active()) { stop(); return; }
    if (hidden()) return;
    busy = true;
    const ticket = generation;
    let keep = true;
    try { keep = (await tick({ isCurrent: () => running && ticket === generation && !hidden() && active() })) !== false; } catch { /* the view shows the failure; the next tick asks again */ }
    finally { busy = false; }
    if (ticket !== generation) { if (running && !hidden()) void run(); return; }
    if (!keep) { stop(); return; }
    if (running && !active()) { stop(); return; }
    schedule();
  }
  const visibility = () => { if (!running) return; generation++; if (hidden()) clear(); else if (timer === null && !busy) void run(); };
  const control = {
    start({ immediate = true } = {}) {
      if (running) return control;
      running = true; doc?.addEventListener?.('visibilitychange', visibility);
      if (immediate) void run(); else schedule();
      return control;
    },
    stop() { running = false; generation++; clear(); doc?.removeEventListener?.('visibilitychange', visibility); return control; },
    get running() { return running; },
    get paused() { return running && hidden(); }
  };
  const stop = control.stop;
  return control;
}

/** Path of the round-trip probe: the most recent conversations of one channel (any status). */
export const inboxProbePath = (tenantId, channelId) => `/api/inbox?${new URLSearchParams({ tenantId, channelId, status: 'all', limit: '5' })}`;

const sameChannel = (entry, tenantId, channelId) => entry && entry.tenantId === tenantId && entry.channelId === channelId;
/**
 * Baseline of the round-trip test: the newest server instant (updatedAt or the last public message)
 * among the conversations of the channel when the test starts; null when the channel had none.
 */
export function probeBaseline(items, { tenantId, channelId } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter(entry => sameChannel(entry, tenantId, channelId));
  return rows.length ? { at: Math.max(0, ...rows.map(entry => Math.max(stamp(entry.updatedAt), stamp(entry.preview?.createdAt)))) } : null;
}

/**
 * First customer message after the baseline (server clock, never the browser clock). Only a customer
 * message created after the baseline counts: an assignment, a transfer or a merge moves updatedAt
 * of an old conversation without a new message and never passes for the message the test waits for.
 * With no baseline (the channel had no conversation) the first customer message counts.
 */
export function firstMessageAfter(baseline, items, { tenantId, channelId } = {}) {
  const since = baseline && Number.isFinite(baseline.at) ? baseline.at : null;
  const item = (Array.isArray(items) ? items : []).find(entry => sameChannel(entry, tenantId, channelId) && entry.preview?.kind === 'customer'
    && (since === null || stamp(entry.preview.createdAt) > since));
  if (!item) return null;
  return { tenantId: item.tenantId, conversationId: item.id, text: text(item.preview.text, 280), at: text(item.preview.createdAt, 40) || text(item.updatedAt, 40), contact: text(item.contact, 120) };
}

/**
 * Round-trip test: idle → waiting → received (or error on 401/403). The first request records the
 * baseline; the next ones (every 3 s) look for the first customer message created after it. It stops when the message arrives,
 * on stop(), when active() turns false (drawer closed) and pauses while the tab is hidden.
 */
export function createRoundTripTest({ request, tenantId, channelId, interval = 3000, active = () => true, onChange = () => {}, document: doc = globalThis.document, timers = globalThis } = {}) {
  if (typeof request !== 'function') throw new TypeError('createRoundTripTest needs request()');
  let baseline, state = 'idle', result = null, error = null;
  const emit = () => onChange({ state, result, error });
  const poller = createPoller({ interval, active, document: doc, timers, tick: async () => {
    try {
      const page = await request(inboxProbePath(tenantId, channelId));
      const items = Array.isArray(page?.items) ? page.items : [];
      if (error) { error = null; emit(); }
      if (baseline === undefined) { baseline = probeBaseline(items, { tenantId, channelId }); return true; }
      const found = firstMessageAfter(baseline, items, { tenantId, channelId });
      if (!found) return true;
      result = found; state = 'received'; emit();
      return false;
    } catch (failure) {
      error = failure;
      if (failure?.status === 401 || failure?.status === 403) { state = 'error'; emit(); return false; }
      emit();
      return true;
    }
  } });
  return {
    start() { if (poller.running) return this; baseline = undefined; result = null; error = null; state = 'waiting'; emit(); poller.start(); return this; },
    stop() { poller.stop(); if (state === 'waiting') { state = 'idle'; emit(); } return this; },
    get state() { return state; }, get result() { return result; }, get error() { return error; },
    get running() { return poller.running; }, get paused() { return poller.paused; }
  };
}

/**
 * Legacy dialogs by transport (P1 stub contract, kept for callers that have no stepper): the QR of
 * app.js connectChannel, the token form of connectTelegram and the connectors of channel-connectors-ui.
 * createChannelConnectFlow({connectWhatsApp, connectTelegram, configure}) → {open(channel)}.
 */
export function createChannelConnectFlow({ connectWhatsApp, connectTelegram, connectTelegramAccount, configure } = {}) {
  return {
    /** Opens the legacy dialog for the channel's transport; false when the channel has none. */
    async open(channel) {
      const transport = channelTransport(channel);
      if(transport==='account'){await connectTelegramAccount?.(channel);return Boolean(connectTelegramAccount);}
      if (transport === 'connector') { await configure?.(channel); return Boolean(configure); }
      if (transport === 'qr') { await connectWhatsApp?.(channel.id); return Boolean(connectWhatsApp); }
      if (transport === 'bot') { await connectTelegram?.(channel.id); return Boolean(connectTelegram); }
      return false;
    }
  };
}
