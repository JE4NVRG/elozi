// Connection flow of Canais (FRONTEND-V2 §5.5, §8.8): every connectionStateNames state has a view in
// the stepper, the round-trip test detects the first message after its baseline, and no request
// runs while the drawer is closed or the tab is hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale } from '../public/i18n.js';
import {
  CONNECTION_STATES, CONNECT_STEPS, connectionView, channelTransport, channelHealth, initialStep, stepperStates, telegramTokenError,
  createPoller, createRoundTripTest, firstMessageAfter, probeBaseline, inboxProbePath, expectedSuffix, createChannelConnectFlow, provideAppServices, appServices, channelLabel
} from '../public/channel-connect-flow.js';
import { createChannelsUI } from '../public/channels-ui.js';

const locale = value => setLocale(value, { persist: false, notify: false });
test.afterEach(() => { locale('pt-BR'); provideAppServices(null); delete globalThis.document; });

const qr = (more = {}) => ({ id: 'wa-1', kind: 'whatsapp_qr', transport: 'baileys', name: 'Vendas', state: 'disconnected', label: 'Número de teste · final 4321', ...more });
const bot = (more = {}) => ({ id: 'tg-1', kind: 'telegram', transport: 'telegram-bot', name: 'Bot', state: 'disconnected', label: 'Bot aguardando conexão', ...more });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function clock() {
  let now = 0, id = 0;
  const tasks = new Map();
  const timers = {
    setTimeout(fn, ms) { tasks.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(handle) { tasks.delete(handle); },
    now: () => now
  };
  async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      tasks.delete(due[0]); now = due[1].at; due[1].fn(); await settle();
    }
    now = end; await settle();
  }
  return { timers, advance, settle, pending: () => tasks.size };
}
function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible', activeElement: null, body: {},
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    listeners: type => listeners.get(type)?.size || 0,
    hide() { this.visibilityState = 'hidden'; for (const fn of listeners.get('visibilitychange') || []) fn(); },
    show() { this.visibilityState = 'visible'; for (const fn of listeners.get('visibilitychange') || []) fn(); }
  };
}

test('cada estado de connectionStateNames de app.js tem uma tela no passo Conectar', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const names = /const connectionStateNames = labels\(\{([^}]*)\}\)/.exec(app)[1];
  const states = [...names.matchAll(/(\w+):\s*'/g)].map(match => match[1]);
  assert.deepEqual([...states].sort(), [...CONNECTION_STATES].sort(), 'o stepper conhece todos os estados nomeados pelo painel');
  const views = Object.fromEntries(CONNECTION_STATES.map(state => [state, connectionView(qr(), { state, qr: state === 'qr' ? PNG : null, error: state === 'failed' ? 'O WhatsApp restringiu o número.' : null })]));
  for (const [state, view] of Object.entries(views)) { assert.ok(view.title && view.body, state); assert.equal(view.state, state); }
  assert.equal(new Set(Object.values(views).map(view => view.title)).size, CONNECTION_STATES.length, 'cada estado tem um título próprio');
  assert.deepEqual(CONNECTION_STATES.filter(state => views[state].poll).sort(), ['connecting', 'qr', 'reconnecting', 'starting']);
  assert.deepEqual(CONNECTION_STATES.filter(state => views[state].done).sort(), ['configured', 'connected']);
  assert.equal(views.starting.title, 'Gerando QR'); assert.equal(views.qr.qr, PNG); assert.equal(views.qr.body, 'O código renova sozinho.');
  assert.equal(views.connecting.title, 'Lido. Conectando…'); assert.equal(views.reconnecting.tone, 'warning');
  assert.equal(views.logged_out.title, 'Sessão encerrada no celular'); assert.equal(views.logged_out.action.label, 'Gerar novo QR');
  assert.equal(views.wrong_number.body, 'Use o WhatsApp do número com final 4321.'); assert.equal(views.wrong_number.action.verb, 'start');
  assert.equal(views.failed.body, 'O WhatsApp restringiu o número.'); assert.equal(views.failed.action.label, 'Tentar de novo');
  assert.equal(views.disconnected.action.label, 'Gerar QR');
  for (const unsafe of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'https://evil.example/qr.png']) assert.equal(connectionView(qr(), { state: 'qr', qr: unsafe }).qr, null, unsafe);
  assert.match(connectionView(qr(), { state: 'reconnecting', nextRetryAt: '2026-10-06T14:31:00Z' }).body, /^Nova tentativa automática às /);
  assert.equal(expectedSuffix(qr()), '4321'); assert.equal(expectedSuffix(qr({ label: '<b>' })), '');
  locale('en');
  assert.equal(connectionView(qr(), { state: 'starting' }).title, 'Generating QR');
  assert.equal(connectionView(qr(), { state: 'wrong_number' }).body, 'Use the WhatsApp of the number ending in 4321.');
});

test('Telegram, webchat, e-mail e Meta: transporte, saúde e passo inicial sem estados inventados', () => {
  assert.equal(channelTransport(qr()), 'qr'); assert.equal(channelTransport(bot()), 'bot');
  for (const kind of ['webchat', 'email', 'instagram', 'messenger']) assert.equal(channelTransport({ id: kind, kind }), 'connector');
  assert.equal(channelTransport({ id: 'x', kind: 'whatsapp_cloud', transport: 'future' }), null);
  assert.equal(connectionView(bot(), { state: 'connected', username: 'loja_bot' }).title, '@loja_bot conectado');
  assert.equal(connectionView(bot(), { state: 'disconnected' }).action.verb, 'token');
  assert.equal(connectionView(bot(), { state: 'failed', error: 'Unauthorized' }).body, 'Unauthorized');
  assert.equal(connectionView(bot(), { state: 'starting' }).poll, true);
  assert.equal(connectionView({ id: 'w', kind: 'webchat', state: 'connected' }).title, 'Pronto agora');
  assert.equal(connectionView({ id: 'e', kind: 'email', state: 'configured' }).title, 'Configurado · validar recebimento');
  assert.equal(connectionView({ id: 'e', kind: 'email', state: 'disconnected' }).action.verb, 'configure');
  assert.equal(channelHealth(qr()), 'setup', 'nunca conectado não é canal caído');
  assert.equal(channelHealth(qr({ linkedAt: '2026-10-01T10:00:00Z' })), 'problem');
  for (const state of ['logged_out', 'wrong_number', 'failed']) assert.equal(channelHealth(qr({ state })), 'problem', state);
  for (const state of ['starting', 'qr', 'connecting', 'reconnecting']) assert.equal(channelHealth(qr({ state })), 'pending', state);
  assert.equal(channelHealth(qr({ state: 'connected' })), 'ok'); assert.equal(channelHealth(qr({ state: 'connected', enabled: false })), 'unknown');
  assert.equal(initialStep(null), 'name'); assert.equal(initialStep(qr()), 'connect'); assert.equal(initialStep(qr({ state: 'connected' })), 'test');
  assert.equal(initialStep({ id: 'w', kind: 'webchat', state: 'connected' }, 'groups'), 'test', 'webchat não tem grupos');
  assert.deepEqual(CONNECT_STEPS, ['name', 'connect', 'test', 'groups']);
  const steps = stepperStates('test', { channel: qr({ state: 'connected' }), connected: true });
  assert.deepEqual(steps.map(step => step.state), ['done', 'done', 'current', 'next']);
  assert.deepEqual(stepperStates('connect', { channel: qr(), error: true }).map(step => step.state), ['done', 'error', 'next', 'next']);
  assert.equal(stepperStates('test', { channel: { id: 'w', kind: 'webchat', state: 'connected' } })[3].disabled, true);
  assert.deepEqual(stepperStates('name', {}).map(step => step.disabled), [false, true, true, true]);
});

test('erros conhecidos do token do Telegram viram texto de produto; os demais ficam genéricos', () => {
  assert.equal(telegramTokenError({ status: 409, message: 'Este bot possui um webhook ativo. Use um bot exclusivo para o MEPChat.' }), 'Este bot usa um webhook ativo. Crie um bot só para o atendimento.');
  assert.equal(telegramTokenError({ status: 409, message: 'Este bot já pertence a outra conexão.' }), 'Este bot já está ligado a outra conexão. Use um bot exclusivo.');
  assert.equal(telegramTokenError({ status: 409, message: 'O token pertence a outro bot. Crie uma conexão separada.' }), 'Este bot já está ligado a outra conexão. Use um bot exclusivo.');
  assert.equal(telegramTokenError({ status: 400, message: 'Cadastre o token do BotFather no campo protegido.' }), 'Token não aceito. Copie de novo o token do @BotFather.');
  assert.equal(telegramTokenError({ status: 502, message: 'socket hang up 10.0.0.3' }), 'Não conseguimos validar o token agora. Tente de novo.');
});

test('poller: para quando a gaveta fecha, pausa com a aba oculta e retoma uma vez ao voltar', async () => {
  const { timers, advance } = clock(), doc = fakeDocument();
  let open = true, calls = 0;
  const poller = createPoller({ interval: 2000, document: doc, timers, active: () => open, tick: async () => { calls++; return true; } }).start();
  await advance(0); assert.equal(calls, 1, 'pergunta já ao abrir');
  await advance(4000); assert.equal(calls, 3);
  doc.hide(); await advance(10000); assert.equal(calls, 3, 'aba oculta: nenhuma requisição'); assert.equal(poller.paused, true);
  doc.show(); await advance(0); assert.equal(calls, 4, 'ao voltar pergunta uma vez e retoma');
  await advance(2000); assert.equal(calls, 5);
  open = false; await advance(10000); assert.equal(calls, 5, 'gaveta fechada: para'); assert.equal(poller.running, false);
  assert.equal(doc.listeners('visibilitychange'), 0, 'remove o ouvinte ao parar');
  const done = createPoller({ interval: 10, document: doc, timers, tick: async () => false }).start();
  await advance(100); assert.equal(done.running, false, 'tick false encerra');
});

test('teste de ida e volta: linha de base no início, detecta a primeira mensagem do cliente e para', async () => {
  const { timers, advance } = clock(), doc = fakeDocument(), paths = [], changes = [];
  const base = { tenantId: 't-1', channelId: 'wa-1' };
  const responses = [
    { items: [{ ...base, id: 'old', updatedAt: '2026-10-06T10:00:00Z', preview: { kind: 'customer', text: 'antiga' } }] },
    { items: [{ ...base, id: 'old', updatedAt: '2026-10-06T10:00:00Z', preview: { kind: 'customer', text: 'antiga' } }] },
    { items: [{ ...base, id: 'old', updatedAt: '2026-10-06T10:05:00Z', preview: { kind: 'human', text: 'resposta da equipe' } }] },
    { items: [{ ...base, id: 'other-channel', channelId: 'tg-9', updatedAt: '2026-10-06T10:06:00Z', preview: { kind: 'customer', text: 'outro canal' } }] },
    { items: [{ ...base, id: 'new', contact: 'Marina', updatedAt: '2026-10-06T10:07:00Z', preview: { kind: 'customer', text: 'oi', createdAt: '2026-10-06T10:07:00Z' } }] }
  ];
  const probe = createRoundTripTest({ request: async path => { paths.push(path); return responses[Math.min(paths.length - 1, responses.length - 1)]; }, tenantId: 't-1', channelId: 'wa-1', document: doc, timers, onChange: value => changes.push(value.state) }).start();
  await advance(0); assert.equal(probe.state, 'waiting');
  await advance(3000 * 3); assert.equal(probe.state, 'waiting', 'mensagem antiga, resposta da equipe e outro canal não contam');
  await advance(3000); assert.equal(probe.state, 'received');
  assert.deepEqual(probe.result, { tenantId: 't-1', conversationId: 'new', text: 'oi', at: '2026-10-06T10:07:00Z', contact: 'Marina' });
  const asked = paths.length; await advance(30000); assert.equal(paths.length, asked, 'parou depois de receber');
  const url = new URL(paths[0], 'https://panel.test');
  assert.equal(url.pathname, '/api/inbox'); assert.deepEqual(Object.fromEntries(url.searchParams), { tenantId: 't-1', channelId: 'wa-1', status: 'all', limit: '5' });
  assert.equal(inboxProbePath('t-1', 'wa-1'), paths[0]); assert.deepEqual(changes.slice(-1), ['received']);
  assert.equal(firstMessageAfter(null, [{ ...base, id: 'first', preview: { kind: 'customer', text: 'oi' } }], base).conversationId, 'first', 'canal sem conversas: a primeira já conta');
  // Reconnection of a number that already has conversations: an assignment or a transfer moves
  // updatedAt of an old conversation (its last public message is still yesterday's customer message).
  const yesterday = { kind: 'customer', text: 'preciso de ajuda', createdAt: '2026-10-05T09:12:00Z' };
  const baseline = probeBaseline([{ ...base, id: 'c-old', updatedAt: '2026-10-06T09:00:00Z', preview: yesterday }, { ...base, id: 'c-b', updatedAt: '2026-10-04T09:00:00Z', preview: { ...yesterday, createdAt: '2026-10-04T08:00:00Z' } }], base);
  assert.deepEqual(baseline, { at: Date.parse('2026-10-06T09:00:00Z') });
  assert.equal(firstMessageAfter(baseline, [{ ...base, id: 'c-old', updatedAt: '2026-10-06T10:00:00Z', preview: yesterday }], base), null, 'atribuição sobe updatedAt sem mensagem nova');
  assert.equal(firstMessageAfter(baseline, [{ ...base, id: 'c-b', updatedAt: '2026-10-06T10:01:00Z', preview: { ...yesterday, createdAt: '2026-10-04T08:00:00Z' } }], base), null, 'outra conversa antiga que subiu também não conta');
  assert.equal(firstMessageAfter(baseline, [{ ...base, id: 'c-old', updatedAt: '2026-10-06T10:02:00Z', preview: { kind: 'customer', text: 'sem data' } }], base), null, 'mensagem sem horário do servidor não prova nada');
  const later = firstMessageAfter(baseline, [{ ...base, id: 'c-b', updatedAt: '2026-10-06T10:05:00Z', preview: yesterday }, { ...base, id: 'c-old', updatedAt: '2026-10-06T10:04:00Z', preview: { kind: 'customer', text: 'oi', createdAt: '2026-10-06T10:04:00Z' } }], base);
  assert.equal(later.conversationId, 'c-old', 'a mensagem nova é achada mesmo atrás de outra conversa que subiu'); assert.equal(later.text, 'oi');
  assert.equal(probeBaseline([], base), null);
  const denied = createRoundTripTest({ request: async () => { throw Object.assign(new Error('Sem acesso'), { status: 403 }); }, ...base, document: doc, timers }).start();
  await advance(0); assert.equal(denied.state, 'error'); assert.equal(denied.running, false);
  let hiddenCalls = 0; doc.hide();
  const hidden = createRoundTripTest({ request: async () => { hiddenCalls++; return { items: [] }; }, ...base, document: doc, timers }).start();
  await advance(9000); assert.equal(hiddenCalls, 0, 'aba oculta não consulta'); hidden.stop(); assert.equal(hidden.state, 'idle'); doc.show();
});

function appFixture({ channel = qr(), role = 'reseller', supportGrantId = null, conversations = [], refresh = null, openTelegramAccount = null } = {}) {
  const calls = [], storage = [];
  const state = { boot: { session: { userId: 'u-1', role, name: 'Jean' } }, supportGrantId, workspaceId: 'w-1', tenant: { id: 't-1', name: 'Loja QA', channels: channel ? [channel] : [], conversations } };
  const responses = [];
  const api = async (path, options = {}) => { calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }); const next = responses.shift(); if (next instanceof Error) throw next; return typeof next === 'function' ? next(path, options) : next ?? {}; };
  const refreshed = [], notices = [];
  provideAppServices({ state, api, refresh: async () => { refreshed.push(true); return refresh?.(); }, toast: (message, error) => notices.push({ message, error }) });
  const doc = fakeDocument();
  globalThis.document = doc;
  const ui = createChannelsUI({ state, channels: () => state.tenant.channels, openTelegramAccount });
  const panel = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelector: () => ({ focus() {} }) };
  doc.querySelector = selector => selector === '[data-channel-flow]' && ui.flow ? { dataset: { channelFlow: ui.flow.key } } : null;
  doc.getElementById = () => null;
  const main = { querySelector: selector => selector === '[data-channel-flow]' && ui.flow ? panel : null, querySelectorAll: () => [] };
  return { state, ui, api, calls, responses, refreshed, notices, doc, main, storage };
}
const route = params => ({ section: 'channels', params });
const creationForm = values => ({ dataset: { form: 'channels:create' }, elements: { namedItem: name => Object.hasOwn(values, name) ? { value: values[name] } : null }, querySelector: () => null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('gaveta de conexão: consulta a conexão só enquanto aberta e visível; fechar para o polling', async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    const f = appFixture({ channel: qr({ state: 'qr' }) });
    for (let i = 0; i < 20; i++) f.responses.push({ state: 'qr', qr: PNG, label: 'Número de teste · final 4321' });
    const html = f.ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="channel-flow-title"/);
    assert.match(html, /<ol class="pg-channels__stepper" aria-label="Etapas da conexão">/);
    assert.match(html, /data-id="connect" aria-current="step"/);
    f.ui.mount(f.main, route({ channelId: 'wa-1', tab: 'connect' }));
    await advance(0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/tenants/t-1/channels/wa-1/connection');
    await advance(4000); assert.equal(f.calls.length, 3, 'a cada 2 s com a gaveta aberta');
    f.doc.hide(); await advance(20000); assert.equal(f.calls.length, 3, 'aba oculta para de consultar');
    f.doc.show(); await advance(0); assert.equal(f.calls.length, 4);
    await f.ui.act('channels:close'); await advance(20000); assert.equal(f.calls.length, 4, 'fechar a gaveta para o polling');
    assert.equal(f.ui.flow, null);
    assert.ok(f.calls.every(call => call.method === 'GET'), 'abrir a gaveta não gera QR sozinho');
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
});

for (const obsolete of ['connected', 'network-error', 'denied']) test('ocultar e reexibir durante GET exige leitura fresca, sem readmitir observação antiga: ' + obsolete, async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  let f;
  try {
    f = appFixture({ channel: qr({ state: 'qr' }) }); const old = deferred(), fresh = deferred();
    f.responses.push(() => old.promise, () => fresh.promise);
    f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })); f.ui.mount(f.main, route({ channelId: 'wa-1', tab: 'connect' }));
    await advance(0); assert.equal(f.calls.length, 1);
    f.doc.hide(); f.doc.show(); await advance(0); assert.equal(f.calls.length, 1, 'sem GET concorrente');
    if (obsolete === 'connected') old.resolve({ state: 'connected' });
    else old.reject(Object.assign(Error('obsolete'), { status: obsolete === 'denied' ? 403 : 503 }));
    await advance(0); assert.equal(f.calls.length, 2, 'consulta fresca assim que o GET antigo termina');
    assert.equal(f.ui.flow.step, 'connect'); assert.equal(f.ui.flow.status, null);
    assert.equal(f.ui.flow.statusStale, false); assert.equal(f.ui.flow.error, '');
    fresh.resolve({ state: 'qr', qr: PNG }); await advance(0);
    assert.equal(f.ui.flow.status.state, 'qr'); assert.equal(f.ui.flow.step, 'connect');
    assert.ok(f.calls.every(call => call.method === 'GET'));
  } finally { await f?.ui.act('channels:close'); globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
});

test('Gerar QR, conectado e passo Testar: o teste de ida e volta começa e detecta a primeira mensagem', async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    const f = appFixture({ channel: qr({ state: 'logged_out' }) });
    f.ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
    f.responses.push({ state: 'logged_out', error: 'O aparelho foi desconectado no WhatsApp. Gere um novo QR.' });
    f.ui.mount(f.main); await advance(0);
    assert.equal(f.calls.length, 1); assert.equal(f.ui.flow.status.state, 'logged_out');
    await advance(10000); assert.equal(f.calls.length, 1, 'estado final: não insiste');
    f.responses.push({ state: 'starting' }, { state: 'qr', qr: PNG }, { state: 'connecting' }, { state: 'connected', label: '+55 11 ****-4321' });
    await f.ui.act('channels:start');
    assert.deepEqual(f.calls[1], { path: '/api/tenants/t-1/channels/wa-1/connect', method: 'POST', body: {} });
    await advance(2000 * 3);
    assert.equal(f.ui.flow.status.state, 'connected'); assert.equal(f.refreshed.length, 1, 'conectado atualiza a empresa');
    f.state.tenant.channels = [qr({ state: 'connected', label: '+55 11 ****-4321' })];
    f.responses.push({ items: [] }, { items: [] }, { items: [{ tenantId: 't-1', channelId: 'wa-1', id: 'conv-1', updatedAt: '2026-10-06T10:00:00Z', preview: { kind: 'customer', text: 'oi', createdAt: '2026-10-06T10:00:00Z' } }] });
    await advance(1400); assert.equal(f.ui.flow.step, 'test', 'conectado avança para Testar');
    await advance(6000);
    assert.equal(f.ui.flow.test.state, 'received'); assert.equal(f.ui.flow.test.result.conversationId, 'conv-1');
    const html = f.ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
    assert.match(html, /Recebida às /); assert.match(html, /href="#inbox\/t-1\/conv-1"/); assert.match(html, /<blockquote class="pg-channels__quote">oi<\/blockquote>/);
    const probes = f.calls.filter(call => call.path.startsWith('/api/inbox')).length; await advance(30000);
    assert.equal(f.calls.filter(call => call.path.startsWith('/api/inbox')).length, probes, 'o teste para depois de receber');
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
});

test('novo canal: Nome → Conectar cria pelo POST existente, atualiza a empresa e abre a conexão já gerando o QR', async () => {
  const f = appFixture({ channel: null });
  const form = creationForm;
  let html = f.ui.view(route({ kind: 'whatsapp_qr' }));
  assert.match(html, /data-form="channels:create"/); assert.match(html, /name="expectedNumber"/); assert.match(html, /data-id="name" aria-current="step"/);
  await f.ui.submit(form({ kind: 'whatsapp_qr', name: 'Vendas', expectedNumber: '11 9' }));
  assert.equal(f.calls.length, 0, 'número incompleto não chama o servidor'); assert.equal(f.ui.flow.error, 'Informe o número com DDD.');
  f.responses.push({ id: 'wa-new', name: 'Vendas', kind: 'whatsapp_qr', transport: 'baileys', state: 'disconnected', label: 'Número de teste · final 4321' });
  await f.ui.submit(form({ kind: 'whatsapp_qr', name: ' Vendas ', expectedNumber: '11 91234-4321' }));
  assert.deepEqual(f.calls[0], { path: '/api/tenants/t-1/channels', method: 'POST', body: { name: 'Vendas', kind: 'whatsapp_qr', real: true, expectedNumber: '11 91234-4321' } });
  assert.equal(f.refreshed.length, 1);
  assert.equal(f.ui.flow.channelId, 'wa-new'); assert.equal(f.ui.flow.autostart, true); assert.equal(f.ui.flow.step, 'connect');
  f.responses.length = 0;
  const telegram = appFixture({ channel: null });
  telegram.ui.view(route({ kind: 'telegram' }));
  telegram.responses.push({ id: 'tg-new', name: 'Bot', kind: 'telegram', transport: 'telegram-bot', state: 'disconnected' });
  await telegram.ui.submit(form({ kind: 'telegram', name: 'Bot' }));
  assert.deepEqual(telegram.calls[0].body, { name: 'Bot', kind: 'telegram', real: true }, 'Telegram não envia número');
  assert.equal(telegram.ui.flow.autostart, false);
  const operator = appFixture({ channel: null, role: 'operator' });
  html = operator.ui.view(route({ kind: 'whatsapp_qr' }));
  assert.ok(!html.includes('data-form="channels:create"'), 'atendente não cria canal'); assert.equal(operator.ui.flow, null);
});

test('criação confirmada sobrevive à falha de atualização e o formulário antigo não repete o POST', async () => {
  const pending = deferred(), f = appFixture({ channel: null, refresh: () => pending.promise });
  const created = { id: 'tg-new', name: 'Bot', kind: 'telegram', transport: 'telegram-bot', state: 'disconnected' };
  const form = creationForm({ kind: 'telegram', name: 'Bot' });
  f.ui.view(route({ kind: 'telegram' })); f.responses.push(created);
  const submitted = f.ui.submit(form);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.refreshed.length, 1);
  await f.ui.submit(form);
  assert.equal(f.calls.length, 1, 'durante a atualização, o cadastro continua ocupado');
  pending.reject(new Error('Atualização indisponível'));
  await submitted;
  assert.deepEqual(f.state.tenant.channels, [created]);
  assert.equal(f.ui.flow.channelId, created.id); assert.equal(f.ui.flow.step, 'connect'); assert.equal(f.ui.flow.error, '');
  assert.deepEqual(f.notices, [{ message: 'Canal criado. Agora conecte.', error: false }]);
  assert.doesNotMatch(f.ui.view(route({ channelId: created.id, tab: 'connect' })), /data-form="channels:create"/);
  await f.ui.submit(form);
  assert.equal(f.calls.length, 1, 'o formulário anterior não pode criar o canal confirmado novamente');
  assert.deepEqual(f.calls.map(call => call.path), ['/api/tenants/t-1/channels'], 'nenhuma conexão ou mensagem é enviada');
});

test('Telegram pessoal criado abre uma vez somente depois de montar a listagem estabilizada', async t => {
  const previous = globalThis.location; globalThis.location = { hash: '#channels/new/telegram_user' };
  t.after(() => { if (previous === undefined) delete globalThis.location; else globalThis.location = previous; });
  const opened = [], f = appFixture({ channel: null, openTelegramAccount: channel => opened.push(channel.id) });
  const created = { id: 'personal-new', name: 'Pessoal', kind: 'telegram_user', transport: 'telegram-user', state: 'disconnected' };
  f.ui.view(route({ kind: 'telegram_user' })); f.responses.push(created);
  await f.ui.submit(creationForm({ kind: 'telegram_user', name: 'Pessoal' }));
  assert.equal(globalThis.location.hash, '#channels'); assert.deepEqual(opened, []);
  assert.deepEqual(f.state.tenant.channels, [created]); assert.equal(f.ui.flow, null);
  f.ui.view(route({})); f.ui.mount(f.main, route({})); assert.deepEqual(opened, [created.id]);
  f.ui.view(route({})); f.ui.mount(f.main, route({})); assert.deepEqual(opened, [created.id], 'render posterior não reabre');
  await f.ui.submit(creationForm({ kind: 'telegram_user', name: 'Pessoal' }));
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body, { name: 'Pessoal', kind: 'telegram_user', real: true });
});

test('deep link pessoal usa a mesma fila e não é cancelado pelo hashchange que iniciou seu redirecionamento', t => {
  const previousLocation = globalThis.location, previousListener = globalThis.addEventListener, handlers = new Map();
  globalThis.location = { hash: '#channels/personal-existing/connect' };
  globalThis.addEventListener = (name, callback) => handlers.set(name, callback);
  t.after(() => {
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
    if (previousListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = previousListener;
  });
  const opened = [], channel = { id: 'personal-existing', name: 'Pessoal', kind: 'telegram_user', transport: 'telegram-user' };
  const f = appFixture({ channel, openTelegramAccount: value => opened.push(value.id) });
  f.ui.view(route({ channelId: channel.id, tab: 'connect' })); f.ui.mount(f.main, route({ channelId: channel.id, tab: 'connect' }));
  handlers.get('hashchange')({ newURL: 'https://elozi.example/#channels/personal-existing/connect' });
  assert.equal(globalThis.location.hash, '#channels'); assert.deepEqual(opened, []); assert.equal(f.ui.flow, null);
  f.ui.view(route({})); f.ui.mount(f.main, route({})); assert.deepEqual(opened, [channel.id]);
  f.ui.mount(f.main, route({})); assert.deepEqual(opened, [channel.id]); assert.equal(f.calls.length, 0);
});

test('abertura pessoal pendente é descartada se contexto, autoridade, canal ou rota mudarem, ou no reset', async t => {
  const previousLocation = globalThis.location, previousListener = globalThis.addEventListener;
  t.after(() => {
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
    if (previousListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = previousListener;
  });
  const changes = {
    empresa: f => { f.state.tenant.id = 't-2'; },
    workspace: f => { f.state.workspaceId = 'w-2'; },
    pessoa: f => { f.state.boot.session.userId = 'u-2'; },
    suporte: f => { f.state.supportGrantId = 'grant-2'; },
    operador: f => { f.state.boot.session.role = 'operator'; },
    serviço: f => { f.state.boot.session.kind = 'service'; },
    canal: f => { f.state.tenant.channels = []; },
    transporte: f => { f.state.tenant.channels[0].transport = 'telegram-bot'; },
    rota: f => { f.ui.view({ section: 'agents', params: {} }); },
    hashchange: (_f, handlers) => { handlers.get('hashchange')({ newURL: 'https://elozi.example/#agents' }); },
    reset: f => { f.ui.reset(); }
  };
  for (const [name, change] of Object.entries(changes)) {
    const opened = [], handlers = new Map(); globalThis.location = { hash: '#channels/new/telegram_user' };
    globalThis.addEventListener = (event, callback) => handlers.set(event, callback);
    const f = appFixture({ channel: null, openTelegramAccount: channel => opened.push(channel.id) });
    f.ui.view(route({ kind: 'telegram_user' }));
    f.responses.push({ id: 'personal-new', name: 'Pessoal', kind: 'telegram_user', transport: 'telegram-user' });
    await f.ui.submit(creationForm({ kind: 'telegram_user', name: 'Pessoal' }));
    change(f, handlers); f.ui.view(route({})); f.ui.mount(f.main, route({}));
    assert.deepEqual(opened, [], name); assert.equal(f.calls.length, 1, name);
  }
});

test('criação tardia não aplica o canal nem atualiza o painel de outro contexto', async () => {
  const changes = {
    empresa: state => { state.tenant = { id: 't-2', name: 'Outra empresa', channels: [], conversations: [] }; },
    conta: state => { state.workspaceId = 'w-2'; },
    suporte: state => { state.supportGrantId = 'grant-2'; },
    pessoa: state => { state.boot.session.userId = 'u-2'; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const pending = deferred(), f = appFixture({ channel: null });
    f.ui.view(route({ kind: 'telegram' })); f.responses.push(() => pending.promise);
    const submitted = f.ui.submit(creationForm({ kind: 'telegram', name: 'Bot' }));
    change(f.state);
    pending.resolve({ id: 'tg-old', name: 'Bot', kind: 'telegram', state: 'disconnected' });
    await submitted;
    assert.deepEqual(f.state.tenant.channels, [], name);
    assert.deepEqual(f.refreshed, [], name);
    assert.deepEqual(f.notices, [], name);
    assert.equal(f.calls.length, 1, name);
  }
});

test('trocar empresa durante a atualização mantém a confirmação fora da empresa nova', async () => {
  const pending = deferred(), f = appFixture({ channel: null, refresh: () => pending.promise });
  f.ui.view(route({ kind: 'telegram' })); f.responses.push({ id: 'tg-old', name: 'Bot', kind: 'telegram', state: 'disconnected' });
  const submitted = f.ui.submit(creationForm({ kind: 'telegram', name: 'Bot' }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.refreshed.length, 1);
  f.state.tenant = { id: 't-2', name: 'Outra empresa', channels: [], conversations: [] };
  pending.reject(new Error('Atualização indisponível'));
  await submitted;
  assert.deepEqual(f.state.tenant.channels, []); assert.deepEqual(f.notices, []);
  assert.equal(f.calls.length, 1);
});

test('fechar e reabrir a criação não reaproveita uma resposta da gaveta anterior', async () => {
  for (const response of [{ id: 'tg-old', name: 'Bot antigo', kind: 'telegram', state: 'disconnected' }, new Error('Falha antiga')]) {
    const pending = deferred(), f = appFixture({ channel: null });
    f.ui.view(route({ kind: 'telegram' })); f.responses.push(() => pending.promise);
    const submitted = f.ui.submit(creationForm({ kind: 'telegram', name: 'Bot antigo' }));
    f.ui.reset(); f.ui.view(route({ kind: 'telegram' }));
    if (response instanceof Error) pending.reject(response); else pending.resolve(response);
    await submitted;
    assert.deepEqual(f.state.tenant.channels, []);
    assert.deepEqual(f.refreshed, []); assert.deepEqual(f.notices, []);
    assert.equal(f.ui.flow.channelId, null); assert.equal(f.ui.flow.error, ''); assert.equal(f.ui.flow.busy, false);
  }
});

test('token do Telegram: só no corpo do POST, nunca em storage, URL ou estado; erros mapeados', async () => {
  const f = appFixture({ channel: bot() });
  const touched = [];
  const spy = { getItem: key => { touched.push(key); return null; }, setItem: key => touched.push(key), removeItem: key => touched.push(key) };
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
  Object.defineProperty(globalThis, 'localStorage', { value: spy, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: spy, configurable: true, writable: true });
  try {
    const html = f.ui.view(route({ channelId: 'tg-1', tab: 'connect' }));
    assert.match(html, /data-form="channels:token"/); assert.match(html, /name="token" type="password"/); assert.match(html, /https:\/\/t\.me\/BotFather/); assert.match(html, /<code>\/newbot<\/code>/);
    const secret = '123456:ABC-private-token';
    const form = { dataset: { form: 'channels:token' }, elements: { namedItem: name => name === 'token' ? { value: secret } : null }, querySelector: () => null };
    f.responses.push(Object.assign(new Error('Este bot possui um webhook ativo. Use um bot exclusivo para o MEPChat.'), { status: 409 }));
    await f.ui.submit(form);
    assert.equal(f.ui.flow.error, 'Este bot usa um webhook ativo. Crie um bot só para o atendimento.');
    f.responses.push({ state: 'connected', username: 'loja_bot', label: '@loja_bot' });
    await f.ui.submit(form);
    assert.deepEqual(f.calls.map(call => [call.method, call.path, call.body]), [['POST', '/api/tenants/t-1/channels/tg-1/connect', { token: secret }], ['POST', '/api/tenants/t-1/channels/tg-1/connect', { token: secret }]]);
    assert.equal(f.ui.flow.status.state, 'connected');
    assert.ok(!JSON.stringify(f.ui.flow).includes(secret), 'o token não fica no estado da gaveta');
    assert.ok(!f.ui.view(route({ channelId: 'tg-1', tab: 'connect' })).includes(secret), 'nem no markup');
    assert.deepEqual(touched, [], 'nem em localStorage/sessionStorage');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: saved.localStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'sessionStorage', { value: saved.sessionStorage, configurable: true, writable: true });
  }
});

test('lista: saúde, empresa, última conversa, ação contextual e banner de canal caído; leitura para quem não administra', () => {
  const channels = [qr({ id: 'down', name: 'Atacado', state: 'logged_out' }), qr({ id: 'ok', name: 'Vendas <b>', state: 'connected', enabledGroups: 3 }), qr({ id: 'new', name: 'Novo', state: 'disconnected' }), { id: 'site', kind: 'webchat', transport: 'elozi-webchat', name: 'Site', state: 'connected' }];
  const f = appFixture({ channel: null, conversations: [{ id: 'c-1', channelId: 'ok', updatedAt: new Date(Date.now() - 180000).toISOString() }] });
  f.state.tenant.channels = channels;
  const html = f.ui.view(route({}));
  assert.match(html, /<h1 class="pg-channels__title">Canais<\/h1>/);
  assert.match(html, /class="ui-banner ui-banner--danger"[\s\S]*1 canal precisa de atenção[\s\S]*Atacado: Sessão encerrada\.[\s\S]*data-action="channels:open" data-id="down"/);
  assert.match(html, /data-channel-card="down" data-health="problem"[\s\S]*?Reconectar/);
  assert.match(html, /data-channel-card="ok" data-health="ok"[\s\S]*?Ver conexão[\s\S]*?data-action="channels:groups" data-id="ok"/);
  assert.match(html, /data-channel-card="new" data-health="setup"[\s\S]*?>Conectar</);
  assert.match(html, /Última conversa há 3 minutos/); assert.match(html, /Sem conversas carregadas/);
  assert.match(html, /Vendas &lt;b&gt;/); assert.ok(!html.includes('Vendas <b>'));
  assert.match(html, /data-action="channels:new" data-id="whatsapp_qr"/);
  for (const [role, supportGrantId] of [['operator', null], ['reseller', 'grant-1']]) {
    const reader = appFixture({ channel: null, role, supportGrantId }); reader.state.tenant.channels = channels;
    const view = reader.ui.view(route({}));
    for (const forbidden of ['channels:new', 'Reconectar', 'channels:groups', 'channels:start']) assert.ok(!view.includes(forbidden), `${role}: ${forbidden}`);
    assert.match(view, /Ver conexão/);
    const drawer = reader.ui.view(route({ channelId: 'down', tab: 'connect' }));
    assert.match(drawer, /Somente a administração da empresa conecta canais\./); assert.ok(!drawer.includes('data-action="channels:start"'));
  }
  const empty = appFixture({ channel: null }).ui.view(route({}));
  const actions = empty.match(/<div class="ui-empty__actions">([\s\S]*?)<\/div>/)[1];
  assert.equal((actions.match(/ui-btn--primary/g) || []).length, 1, 'estado vazio com uma única ação');
  assert.match(empty, /Nenhum canal conectado ainda/);
});

test('grupos dentro do canal: WhatsApp e Telegram em #channels/<id>/groups; canal sem grupos explica', () => {
  const f = appFixture({ channel: qr({ state: 'connected', enabledGroups: 2 }), conversations: [{ id: 'g-1', channelId: 'wa-1', conversationKind: 'group', contact: 'Revendedores', updatedAt: '2026-10-06T10:00:00Z' }] });
  let html = f.ui.view(route({ channelId: 'wa-1', tab: 'groups' }));
  assert.match(html, /<h1 class="pg-channels__title">Grupos · Vendas<\/h1>/); assert.match(html, /2 grupos no atendimento/);
  assert.match(html, /data-action="channel-groups" data-id="wa-1"/, 'a seleção revisada (CAS) é a do painel atual');
  assert.match(html, /Revendedores[\s\S]*href="#inbox\/t-1\/g-1"/);
  const disconnected = appFixture({ channel: qr({ state: 'logged_out' }) }).ui.view(route({ channelId: 'wa-1', tab: 'groups' }));
  assert.match(disconnected, /data-action="channel-groups" disabled/); assert.match(disconnected, /Conecte o número para listar os grupos\./);
  const telegram = appFixture({ channel: bot({ state: 'connected', botUsername: 'loja_bot', groupSelectionMode: 'selected', selectedGroups: 1 }) });
  html = telegram.ui.view(route({ channelId: 'tg-1', tab: 'groups' }));
  assert.match(html, /href="https:\/\/t\.me\/loja_bot\?startgroup=true"/); assert.match(html, /\/setprivacy/); assert.match(html, /1 grupo selecionado/);
  assert.match(html, /data-action="telegram-groups" data-id="tg-1"/); assert.match(html, /data-action="telegram-profile" data-id="tg-1"/);
  const site = appFixture({ channel: { id: 'site', kind: 'webchat', transport: 'elozi-webchat', name: 'Site', state: 'connected' } }).ui.view(route({ channelId: 'site', tab: 'groups' }));
  assert.match(site, /Este canal não tem grupos/);
  const missing = f.ui.view(route({ channelId: 'nope', tab: 'groups' }));
  assert.match(missing, /Este canal não está nesta empresa/);
});

test('contrato do stub e ponte de serviços continuam válidos', async () => {
  const opened = [], flow = createChannelConnectFlow({ connectWhatsApp: async id => opened.push(['qr', id]), connectTelegram: async id => opened.push(['bot', id]), configure: async channel => opened.push(['connector', channel.id]) });
  assert.equal(await flow.open(qr()), true); assert.equal(await flow.open(bot()), true); assert.equal(await flow.open({ id: 'site', kind: 'webchat' }), true);
  assert.equal(await flow.open({ id: 'x', kind: 'whatsapp_cloud', transport: 'future' }), false); assert.equal(await flow.open(null), false);
  assert.deepEqual(opened, [['qr', 'wa-1'], ['bot', 'tg-1'], ['connector', 'site']]);
  assert.equal(appServices(), null);
  const services = provideAppServices({ api: () => {} });
  assert.equal(appServices(), services); assert.ok(Object.isFrozen(services));
  const ui = createChannelsUI({ state: { boot: { session: { role: 'operator' } }, tenant: { name: 'E' } }, channels: () => [] });
  assert.equal(await ui.act('channels:anything', 'id'), false); assert.equal(await ui.submit({ dataset: { form: 'channels:x' } }), false); assert.equal(ui.reset(), undefined);
});

// Minimal DOM for patch(): the drawer body, its template and the typed fields of each form.
function flowDom(f, html) {
  const parse = markup => {
    const inputs = [];
    for (const form of markup.matchAll(/<form[^>]*data-form="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
      for (const input of form[2].matchAll(/<input([^>]*)\/?>/g)) {
        const attrs = input[1], name = /\bname="([^"]*)"/.exec(attrs)?.[1], type = /\btype="([^"]*)"/.exec(attrs)?.[1] || 'text';
        if (!name || ['radio', 'checkbox'].includes(type)) continue;
        const value = (/\bvalue="([^"]*)"/.exec(attrs)?.[1] || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        inputs.push({ name, type, value, form: form[1], dataset: {}, closest: selector => selector === '[data-form]' ? { dataset: { form: form[1] } } : null, focus() {} });
      }
    }
    return { markup, inputs };
  };
  const body = markup => /data-flow-body>([\s\S]*)<\/div><\/aside>/.exec(markup)?.[1] || '';
  const root = {
    current: parse(body(html)),
    contains: () => false,
    querySelector: () => null,
    querySelectorAll(selector) { return selector.includes('input[name]') ? this.current.inputs : []; },
    replaceChildren(fresh) { this.current = fresh; }
  };
  const doc = f.doc;
  doc.querySelector = selector => {
    if (selector === '[data-channel-flow]') return f.ui.flow ? { dataset: { channelFlow: f.ui.flow.key } } : null;
    if (selector === '[data-flow-body]') return root;
    const control = /^\[data-form="([^"]+)"\] \[name="([^"]+)"\]$/.exec(selector);
    return control ? root.current.inputs.find(input => input.form === control[1] && input.name === control[2]) || null : null;
  };
  doc.querySelectorAll = selector => selector.includes('[data-flow-body]') ? root.current.inputs : [];
  doc.createElement = () => {
    const template = { content: { querySelector: selector => selector === '[data-flow-body]' ? { childNodes: [template.parsed], querySelector: () => null } : null } };
    Object.defineProperty(template, 'innerHTML', { set(markup) { template.parsed = parse(body(markup)); } });
    return template;
  };
  return { root, field: name => root.current.inputs.find(input => input.name === name), markup: () => root.current.markup };
}

test('gaveta Novo canal: erro de validação ou do servidor não apaga o que foi digitado; fechar com alterações pergunta antes', async () => {
  const f = appFixture({ channel: null });
  const form = values => ({ dataset: { form: 'channels:create' }, elements: { namedItem: name => Object.hasOwn(values, name) ? { value: values[name] } : null }, querySelector: () => null });
  const dom = flowDom(f, f.ui.view(route({ kind: 'whatsapp_qr' })));
  dom.field('name').value = 'Vendas Centro'; dom.field('expectedNumber').value = '11 9';
  await f.ui.submit(form({ kind: 'whatsapp_qr', name: 'Vendas Centro', expectedNumber: '11 9' }));
  assert.equal(f.ui.flow.error, 'Informe o número com DDD.');
  assert.equal(dom.field('name').value, 'Vendas Centro'); assert.equal(dom.field('expectedNumber').value, '11 9');
  assert.match(dom.markup(), /name="name"[^>]*value="Vendas Centro"/, 'o nome continua no markup da gaveta');
  f.responses.push(Object.assign(new Error('Limite do piloto atingido.'), { status: 409 }));
  dom.field('expectedNumber').value = '11 91234-4321';
  await f.ui.submit(form({ kind: 'whatsapp_qr', name: 'Vendas Centro', expectedNumber: '11 91234-4321' }));
  assert.equal(f.ui.flow.error, 'Limite do piloto atingido.');
  assert.equal(dom.field('name').value, 'Vendas Centro'); assert.equal(dom.field('expectedNumber').value, '11 91234-4321');
  assert.match(f.ui.view(route({ kind: 'whatsapp_qr' })), /value="Vendas Centro"[\s\S]*value="11 91234-4321"/, 'uma nova pintura da página também mantém');
  await f.ui.act('channels:close');
  assert.ok(f.ui.flow, 'com alterações, fechar pergunta antes'); assert.equal(f.ui.flow.confirmClose, true);
  assert.match(f.ui.view(route({ kind: 'whatsapp_qr' })), /Descartar alterações\?[\s\S]*data-action="channels:keep"[\s\S]*data-action="channels:discard"/);
  await f.ui.act('channels:keep'); assert.equal(f.ui.flow.confirmClose, false); assert.equal(dom.field('name').value, 'Vendas Centro');
  await f.ui.act('channels:close'); await f.ui.act('channels:discard');
  assert.equal(f.ui.flow, null, 'descartar fecha');
  const clean = appFixture({ channel: null }); clean.ui.view(route({ kind: 'telegram' }));
  await clean.ui.act('channels:close'); assert.equal(clean.ui.flow, null, 'sem alterações fecha direto');
});

test('token do Telegram: um erro não apaga o campo, o aceito limpa e nada vai para o estado', async () => {
  const f = appFixture({ channel: bot() });
  const dom = flowDom(f, f.ui.view(route({ channelId: 'tg-1', tab: 'connect' })));
  const secret = '123456:ABC-private-token';
  dom.field('token').value = secret;
  const form = { dataset: { form: 'channels:token' }, elements: { namedItem: name => name === 'token' ? { value: secret } : null }, querySelector: () => null };
  f.responses.push(Object.assign(new Error('Token inválido'), { status: 400 }));
  await f.ui.submit(form);
  assert.equal(f.ui.flow.error, 'Token não aceito. Copie de novo o token do @BotFather.');
  assert.equal(dom.field('token').value, secret, 'o token digitado continua no campo para corrigir');
  assert.ok(!JSON.stringify(f.ui.flow).includes(secret));
  f.responses.push({ state: 'starting' });
  await f.ui.submit(form);
  assert.equal(f.ui.flow.status.state, 'starting'); assert.equal(dom.field('token')?.value || '', '', 'aceito: o campo fica vazio');
});

test('polling: resposta atrasada de outra gaveta é ignorada e 401/403 param as consultas', async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    const f = appFixture({ channel: qr({ id: 'wa-a', state: 'qr' }) });
    f.state.tenant.channels.push(qr({ id: 'wa-b', name: 'Atacado', state: 'disconnected', label: 'Número de teste · final 9999' }));
    let release;
    f.responses.push(() => new Promise(resolve => { release = resolve; }));
    f.ui.view(route({ channelId: 'wa-a', tab: 'connect' })); f.ui.mount(f.main); await advance(0);
    assert.equal(f.calls.at(-1).path, '/api/tenants/t-1/channels/wa-a/connection');
    await f.ui.act('channels:close');
    f.responses.push({ state: 'disconnected', label: 'Número de teste · final 9999' });
    f.ui.view(route({ channelId: 'wa-b', tab: 'connect' })); f.ui.mount(f.main); await advance(0);
    assert.equal(f.calls.at(-1).path, '/api/tenants/t-1/channels/wa-b/connection');
    release({ state: 'connected', label: '+55 11 ****-4321' }); await advance(0);
    assert.equal(f.ui.flow.channelId, 'wa-b'); assert.equal(f.ui.flow.status.state, 'disconnected', 'o status do canal A não vira o do canal B');
    assert.equal(f.ui.flow.step, 'connect'); assert.equal(f.refreshed.length, 0);
    const expired = appFixture({ channel: qr({ state: 'qr' }) });
    expired.responses.push(Object.assign(new Error('Sessão expirada'), { status: 401 }));
    expired.ui.view(route({ channelId: 'wa-1', tab: 'connect' })); expired.ui.mount(expired.main); await advance(0);
    await advance(20000);
    assert.equal(expired.calls.length, 1, '401: nenhuma consulta a cada 2 s atrás do diálogo de sessão');
    assert.equal(expired.ui.flow.error, 'Seu acesso mudou ou expirou. Atualize a página.');
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
});

test('failed com próxima tentativa futura é observável; falhas terminais conservam suas ações', () => {
  const now = Date.parse('2026-10-24T12:00:00Z'), nextRetryAt = '2026-10-24T12:05:00Z';
  for (const failureReason of [undefined, 'unstable', 'bad_session']) {
    const view = connectionView(qr(), { state: 'failed', nextRetryAt, failureReason }, { now });
    assert.equal(view.poll, true); assert.equal(view.action, null);
    assert.equal(view.title, 'Retentativa agendada'); assert.match(view.body, /Nova tentativa automática às /);
  }
  for (const retry of [null, '', 'invalid', '2026-10-24T11:59:00Z', '2026-10-24T12:00:00Z']) {
    const view = connectionView(qr(), { state: 'failed', nextRetryAt: retry }, { now });
    assert.equal(view.poll, false); assert.equal(view.action.label, 'Tentar de novo');
  }
  assert.equal(connectionView(qr(), { state: 'failed', nextRetryAt, failureReason: 'restricted' }, { now }).poll, false);
  for (const state of ['logged_out', 'wrong_number']) {
    const view = connectionView(qr(), { state, nextRetryAt }, { now });
    assert.equal(view.poll, false); assert.equal(view.action.label, 'Gerar novo QR');
  }
  assert.equal(connectionView(bot(), { state: 'failed', nextRetryAt }, { now }).poll, false);
  locale('en');
  assert.equal(connectionView(qr(), { state: 'failed', nextRetryAt }, { now }).title, 'Retry scheduled');
});

test('drawer failed → reconnecting → connected usa somente GET e bloqueia duplicate connect', async () => {
  const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    const f = appFixture({ channel: qr({ state: 'reconnecting' }) });
    const nextRetryAt = new Date(Date.now() + 60000).toISOString();
    f.responses.push({ state: 'failed', nextRetryAt, failureReason: 'unstable' }, { state: 'reconnecting' }, { state: 'connected' });
    const dom = flowDom(f, f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })));
    f.ui.mount(f.main); await advance(0);
    assert.match(dom.markup(), /Retentativa agendada/);
    assert.doesNotMatch(dom.markup(), /data-action="channels:start"/);
    await f.ui.act('channels:start'); assert.equal(f.calls.length, 1);
    await advance(2000); assert.equal(f.ui.flow.status.state, 'reconnecting');
    await advance(2000); assert.equal(f.ui.flow.status.state, 'connected');
    assert.equal(f.refreshed.length, 1); assert.ok(f.calls.every(call => call.method === 'GET'));
    await f.ui.act('channels:close'); await advance(20000); assert.equal(f.calls.length, 3);
  } finally { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear; }
});

test('retry agendado pausa oculto, retoma por GET e revogação cancela inclusive resposta em voo', async () => {
  const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    for (const revoke of [f => { f.state.boot.session.role = 'operator'; }, f => { f.state.tenant.id = 't-2'; }, f => { f.state.supportGrantId = 'grant'; }]) {
      const f = appFixture({ channel: qr({ state: 'reconnecting' }) }), pending = deferred();
      f.responses.push({ state: 'failed', nextRetryAt: new Date(Date.now() + 60000).toISOString() }, () => pending.promise);
      f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })); f.ui.mount(f.main); await advance(0);
      f.doc.hide(); await advance(10000); assert.equal(f.calls.length, 1);
      f.doc.show(); await advance(0); assert.equal(f.calls.length, 2);
      revoke(f); pending.resolve({ state: 'connected' }); await advance(20000);
      assert.equal(f.calls.length, 2); assert.equal(f.ui.flow.status.state, 'failed'); assert.equal(f.refreshed.length, 0);
      f.ui.reset();
    }
    for (const state of ['failed', 'logged_out', 'wrong_number']) {
      const f = appFixture({ channel: qr() }); f.responses.push({ state });
      f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })); f.ui.mount(f.main); await advance(20000);
      assert.equal(f.calls.length, 1, state); f.ui.reset();
    }
  } finally { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear; }
});

test('erro GET de rede/503 sinaliza QR desatualizado e recuperação limpa aviso sem POST', async () => {
  const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    for (const failure of [new Error('network'), Object.assign(new Error('unavailable'), { status: 503 })]) {
      const f = appFixture({ channel: qr({ state: 'qr' }) });
      const dom = flowDom(f, f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })));
      f.responses.push({ state: 'qr', qr: PNG }, failure, { state: 'qr', qr: PNG });
      f.ui.mount(f.main); await advance(0); await advance(2000);
      assert.equal(f.ui.flow.statusStale, true); assert.equal(f.ui.flow.status.qr, PNG);
      assert.match(dom.markup(), /data-flow-stale role="status"/);
      assert.match(dom.markup(), /O código exibido pode estar desatualizado/);
      assert.doesNotMatch(dom.markup(), /O código renova sozinho/);
      await advance(2000); assert.equal(f.ui.flow.statusStale, false);
      assert.doesNotMatch(dom.markup(), /data-flow-stale/); assert.match(dom.markup(), /O código renova sozinho/);
      assert.ok(f.calls.every(call => call.method === 'GET')); f.ui.reset();
    }
  } finally { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear; }
});

test('#channels/<id>/connect abre em Conectar sem iniciar o teste; #channels/<id> abre no passo que o canal pede', async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout, { timers, advance } = clock();
  globalThis.setTimeout = timers.setTimeout; globalThis.clearTimeout = timers.clearTimeout;
  try {
    const f = appFixture({ channel: qr({ state: 'connected' }) });
    f.responses.push({ state: 'connected', label: '+55 11 ****-4321' });
    const html = f.ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
    assert.equal(f.ui.flow.step, 'connect'); assert.match(html, /data-id="connect" aria-current="step"/); assert.match(html, /Testar agora/);
    f.ui.mount(f.main); await advance(30000);
    assert.ok(!f.calls.some(call => call.path.startsWith('/api/inbox')), 'Ver conexão não consulta a caixa sozinho');
    const direct = appFixture({ channel: qr({ state: 'connected' }) });
    direct.ui.view(route({ channelId: 'wa-1' })); assert.equal(direct.ui.flow.step, 'test');
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
});

test('rótulos gerados pelo servidor saem no idioma do painel; os digitados ficam como estão', () => {
  const channels = [qr({ id: 'a', label: 'Número de teste · final 4321' }), bot({ id: 'b' }), qr({ id: 'c', label: 'Aguardando configuração do canal' }), qr({ id: 'd', label: 'Loja <Centro>' })];
  const f = appFixture({ channel: null }); f.state.tenant.channels = channels;
  locale('en');
  const html = f.ui.view(route({}));
  for (const label of ['Registered number · ending 4321', 'Bot awaiting connection', 'Awaiting channel setup', 'Loja &lt;Centro&gt;']) assert.ok(html.includes(label), label);
  assert.equal(channelLabel({ label: 'Número de teste · final 12345' }), 'Número de teste · final 12345');
  assert.equal(connectionView(qr(), { state: 'connected', label: 'Número de teste · final 0042' }).body, 'Test number · ending 0042');
  locale('pt-BR');
  assert.ok(f.ui.view(route({})).includes('Número cadastrado · final 4321'));
});

test('fechar a gaveta de canal novo devolve o foco ao botão que a abriu', async () => {
  const f = appFixture({ channel: null });
  await f.ui.act('channels:new', 'telegram');
  f.ui.view(route({ kind: 'telegram' }));
  await f.ui.act('channels:close');
  f.ui.view(route({}));
  const focused = [];
  const node = id => ({ dataset: { id }, focus() { focused.push(id); } });
  f.ui.mount({ querySelector: () => null, querySelectorAll: selector => selector === '[data-action="channels:new"]' ? [node('whatsapp_qr'), node('telegram')] : [] });
  assert.deepEqual(focused, ['telegram']);
});

test('screen-channels.css: in the catalog grid the card text keeps the full top row', async () => {
  // Cards of ~335 px in a four-column grid (1920 px screens): with the badge and the button in a third "auto"
  // column the text column reached 0 px, one letter per line. Above 600 px the text spans columns 2-3 and the
  // row below holds the badge on the left and the button on the right.
  const { cssRules, parseCss } = await import('./helpers/css-tree.js');
  const rules = cssRules(parseCss(readFileSync(new URL('../public/screen-channels.css', import.meta.url), 'utf8')));
  const wide = selector => rules.find(rule => rule.context.includes('@media (min-width: 600px)') && rule.selector === selector);
  const value = (selector, property) => wide(selector)?.declarations.find(declaration => declaration.property === property)?.value;
  assert.equal(value('.pg-channels__offer .pg-channels__identity', 'grid-column'), '2 / -1');
  assert.equal(value('.pg-channels__offer .pg-channels__actions', 'grid-column'), '1 / -1');
  assert.equal(value('.pg-channels__offer .pg-channels__actions', 'justify-content'), 'space-between');
});

test('canais de marca conhecida mostram o logo oficial; webchat e e-mail ficam com o ícone da plataforma', async () => {
  const { channelMark, CHANNEL_BRANDS } = await import('../public/icons.js');
  assert.deepEqual([...CHANNEL_BRANDS], ['whatsapp', 'telegram', 'instagram', 'messenger']);
  for (const brand of CHANNEL_BRANDS) assert.match(String(channelMark(brand)), new RegExp(`<svg class="channel-mark " data-brand="${brand}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"`));
  assert.match(String(channelMark('telegram', { tile: true })), /viewBox="3\.5 4\.3 16 16"/, 'no ladrilho do Telegram, só o avião');
  assert.equal(channelMark('desconhecido'), '');
  const f = appFixture({ channel: null }); f.state.tenant.channels = [qr({ id: 'ok', name: 'Vendas', state: 'connected' })];
  const html = String(f.ui.view(route({})));
  assert.match(html, /data-channel-card="ok"[\s\S]*?class="pg-channels__kind" data-brand="whatsapp"/, 'cartão do canal conectado');
  for (const brand of ['telegram', 'instagram', 'messenger']) assert.match(html, new RegExp(`<li class="pg-channels__offer"><span class="pg-channels__kind" data-brand="${brand}"`), `catálogo: ${brand}`);
  assert.doesNotMatch(html, /data-brand="(webchat|email)"/);
  const drawer = String(f.ui.view(route({ kind: 'whatsapp_qr' })));
  assert.match(drawer, /pg-channels__kind-label"><svg class="channel-mark " data-brand="whatsapp"/, 'escolha do tipo na gaveta');
});

test('webchat com logo do site mostra a imagem no cartão; endereço que não é imagem segura fica com o globo', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const site = (id, siteIcon) => ({ id, name: 'Suporte ' + id, kind: 'webchat', transport: 'elozi-webchat', state: 'connected', label: 'Webchat por origens autorizadas', webchat: { version: 1, enabled: true, origins: ['https://site.example'] }, siteIcon });
  const f = appFixture({ channel: null });
  f.state.tenant.channels = [site('logo', { origin: 'https://site.example', src: png, checkedAt: '2026-10-06T12:00:00.000Z' }), site('svg', { origin: 'https://site.example', src: 'data:image/svg+xml;base64,PHN2Zz4=', checkedAt: '2026-10-06T12:00:00.000Z' }), site('js', { src: 'javascript:alert(1)' }), site('none')];
  const html = String(f.ui.view(route({})));
  assert.match(html, /data-channel-card="logo"[\s\S]*?<span class="pg-channels__kind pg-channels__kind--site" aria-hidden="true"><img class="pg-channels__site-icon" src="data:image\/png;base64,iVBORw0KGgo/);
  for (const id of ['svg', 'js', 'none']) assert.match(html, new RegExp(`data-channel-card="${id}"[\\s\\S]*?<span class="pg-channels__kind" aria-hidden="true"><svg class="icon `), id);
  assert.doesNotMatch(html, /javascript:|image\/svg/);
});

test('agenda do WhatsApp: o cartão conectado oferece Agenda ao administrador e a ação sincroniza pelo servidor', async () => {
  const f = appFixture({ channel: null }); f.state.tenant.channels = [qr({ id: 'ok', name: 'Vendas', state: 'connected' }), qr({ id: 'off', name: 'Novo', state: 'disconnected' })];
  const html = String(f.ui.view(route({})));
  assert.match(html, /data-channel-card="ok"[\s\S]*?data-action="channels:agenda" data-id="ok"/);
  assert.doesNotMatch(html, /data-action="channels:agenda" data-id="off"/, 'sem conexão não há agenda');
  f.responses.push({ channelId: 'ok', contacts: 120, renamed: 7 });
  await f.ui.act('channels:agenda', 'ok');
  assert.deepEqual(f.calls.at(-1), { path: '/api/tenants/t-1/channels/ok/address-book-sync', method: 'POST', body: {} });
  const reader = appFixture({ channel: null, role: 'operator' }); reader.state.tenant.channels = [qr({ id: 'ok', name: 'Vendas', state: 'connected' })];
  assert.doesNotMatch(String(reader.ui.view(route({}))), /channels:agenda/, 'só o administrador sincroniza');
});
