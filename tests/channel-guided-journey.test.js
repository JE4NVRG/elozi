import test from 'node:test';
import assert from 'node:assert/strict';
import { channelNextAction, channelValidationDTO, createChannelValidation } from '../public/channel-journey.js';
import { createChannelsUI } from '../public/channels-ui.js';
import { setLocale } from '../public/i18n.js';

const route = (params = {}) => ({ section: 'channels', params });
const qr = (more = {}) => ({ id: 'wa-1', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', name: 'Vendas', ...more });
const proof = (more = {}) => ({ tenantId: 't-1', channelId: 'wa-1', version: 0, state: 'not_started', startedAt: null, validatedAt: null, conversationId: null,
  incomingRecorded: false, replyRecorded: false, recipientConfirmed: false, channelAvailable: true, ...more });
const awaiting = (more = {}) => proof({ version: 1, state: 'waiting_confirmation', startedAt: '2026-10-09T10:00:00Z', conversationId: 'conv-1', incomingRecorded: true, replyRecorded: true, ...more });
const accepted = (more = {}) => awaiting({ version: 2, state: 'validated', validatedAt: '2026-10-09T10:03:00Z', recipientConfirmed: true, ...more });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clock() {
  let now = 0, id = 0; const jobs = new Map();
  const timers = { setTimeout(fn, delay) { jobs.set(++id, { at: now + delay, fn }); return id; }, clearTimeout(key) { jobs.delete(key); } };
  return { timers, now: () => now, async advance(ms) { const until = now + ms; await flush(); for (;;) { const task = [...jobs].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!task) break; jobs.delete(task[0]); now = task[1].at; task[1].fn(); await flush(); } now = until; await flush(); } };
}
function documentFixture() {
  const handlers = new Map();
  return { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    addEventListener(type, fn) { const list = handlers.get(type) || new Set(); list.add(fn); handlers.set(type, list); }, removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    hide() { this.visibilityState = 'hidden'; for (const fn of [...(handlers.get('visibilitychange') || [])]) fn(); }, show() { this.visibilityState = 'visible'; for (const fn of [...(handlers.get('visibilitychange') || [])]) fn(); } };
}
function uiFixture({ channels = [qr()], session = {}, api = async () => proof(), durable = true } = {}) {
  const calls = [], state = { workspaceId: 'w-1', boot: { session: { role: 'reseller', userId: 'u-1', ...session } }, tenant: { id: 't-1', name: 'Empresa', channels, conversations: [] } };
  const doc = documentFixture(); globalThis.document = doc;
  const ui = createChannelsUI({ state, durableOnboarding: durable, api: async (path, options = {}) => { calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }); return api(path, options); } });
  const panel = { addEventListener() {}, querySelector: () => ({ focus() {} }) };
  doc.querySelector = selector => selector === '[data-channel-flow]' && ui.flow ? { dataset: { channelFlow: ui.flow.key } } : null;
  const main = { querySelector: selector => selector === '[data-channel-flow]' && ui.flow ? panel : selector === '[data-channel-card]' && channels.length ? {} : null, querySelectorAll: () => [] };
  return { ui, state, doc, calls, main };
}
test.afterEach(() => { delete globalThis.document; delete globalThis.location; setLocale('pt-BR', { persist: false, notify: false }); });

test('next action distinguishes connected, inbound, reply, confirmation, accepted and unavailable proof', () => {
  for (const value of [null, proof(), proof({ state: 'waiting_incoming' }), awaiting({ state: 'waiting_reply', replyRecorded: false }), awaiting()]) assert.equal(channelNextAction(qr(), value).complete, false);
  assert.equal(channelNextAction(qr(), accepted()).complete, true);
  assert.equal(channelNextAction(qr({ state: 'logged_out' }), accepted()).label, 'Reconectar');
  assert.equal(channelNextAction(qr(), accepted({ channelAvailable: false })).complete, false);
  assert.equal(channelNextAction({ id: 'cloud', kind: 'whatsapp_cloud', state: 'connected' }).complete, false);
  assert.equal(channelNextAction({ id: 'site', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { enabled: false } }).step, 'connect');
});

test('server DTO projection strips customer content and rejects foreign, malformed or false acceptance', () => {
  const dto = channelValidationDTO({ ...accepted({ channelAvailable: false }), text: 'PRIVATE-CUSTOMER', phone: 'PRIVATE-PHONE', secret: 'PRIVATE-SECRET' }, { tenantId: 't-1', channelId: 'wa-1' });
  assert.equal(dto.state, 'validated'); assert.equal(dto.channelAvailable, false); assert.equal(Object.keys(dto).length, 11);
  assert.doesNotMatch(JSON.stringify(dto), /PRIVATE/);
  for (const more of [{ tenantId: 'other' }, { channelId: 'other' }, { version: -1 }, { incomingRecorded: false }, { recipientConfirmed: false }, { validatedAt: null }]) assert.equal(channelValidationDTO(accepted(more), { tenantId: 't-1', channelId: 'wa-1' }), null);
});

test('durable controller opens read-only and writes start/confirm only with current CAS and human check', async () => {
  const calls = [], c = clock(), doc = documentFixture(); let current = proof();
  const controller = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', document: doc, timers: c.timers, now: c.now, request: async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (options.method === 'POST') { const body = JSON.parse(options.body); current = body.action === 'start' ? proof({ version: 1, state: 'waiting_incoming', startedAt: '2026-10-09T10:00:00Z' }) : accepted(); } return current;
  } });
  await controller.open(); assert.deepEqual(calls.map(value => value.method), ['GET']);
  assert.equal(await controller.confirm(true), false); await controller.start(); assert.deepEqual(calls[1].body, { action: 'start', version: 0 });
  current = awaiting(); await controller.refresh(); assert.equal(await controller.confirm(false), false); assert.equal(calls.filter(value => value.method === 'POST').length, 1);
  await controller.confirm(true); assert.deepEqual(calls.at(-1).body, { action: 'confirm', version: 1 }); assert.equal(controller.dto.state, 'validated'); controller.stop();
});

test('uncertain POST and CAS conflict reconcile with GET without retrying or auto-confirming', async () => {
  for (const status of [0, 409]) {
    const calls = [], c = clock(); let written = false;
    const controller = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', timers: c.timers, now: c.now, document: documentFixture(), request: async (_path, options = {}) => {
      calls.push(options.method || 'GET'); if (options.method === 'POST') { written = true; throw Object.assign(new Error('Uncertain'), { status }); } return written ? awaiting() : proof();
    } });
    await controller.open(); await controller.start(); assert.deepEqual(calls, ['GET', 'POST', 'GET']); assert.equal(controller.dto.state, 'waiting_confirmation'); controller.stop();
  }
});

test('403 or malformed proof cannot reuse accepted state or send a confirming write', async () => {
  for (const failure of [Object.assign(new Error('Denied'), { status: 403 }), accepted({ incomingRecorded: false })]) {
    let next = accepted(); const calls = [], c = clock(); const controller = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', timers: c.timers, document: documentFixture(), request: async (_path, options = {}) => { calls.push(options.method || 'GET'); if (next instanceof Error) throw next; return next; } });
    await controller.open(); next = failure; await controller.refresh(); assert.equal(controller.dto, null); assert.equal(await controller.confirm(true), false); assert.ok(calls.every(value => value === 'GET')); controller.stop();
  }
});

test('late replies after close, authority change and hidden tab cannot advance proof; visibility resumes by GET', async () => {
  for (const change of ['close', 'authority', 'hidden']) {
    const first = deferred(), c = clock(), doc = documentFixture(); let active = true, calls = 0; const seen = [];
    const controller = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', document: doc, timers: c.timers, active: () => active, request: async () => ++calls === 1 ? first.promise : proof(), onChange: value => seen.push(value.dto) });
    const open = controller.open(); if (change === 'close') controller.stop(); else if (change === 'authority') active = false; else doc.hide();
    first.resolve(accepted()); await open; assert.equal(controller.dto, null); assert.ok(seen.every(value => value === null));
    if (change === 'hidden') { doc.show(); await flush(); assert.equal(calls, 2); assert.equal(controller.dto.state, 'not_started'); } controller.stop();
  }
});

test('waiting proof pauses at the polling budget and explicit refresh resumes the saved attempt', async () => {
  const c = clock(), seen = [], doc = documentFixture(); let calls = 0;
  const controller = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', document: doc, timers: c.timers, now: c.now, interval: 1000, timeBudget: 3000,
    request: async () => { calls++; return proof({ version: 1, state: 'waiting_incoming', startedAt: '2026-10-09T10:00:00Z' }); }, onChange: value => seen.push(value) });
  await controller.open(); await c.advance(9000); assert.equal(calls, 3); assert.equal(controller.paused, true); assert.equal(controller.dto.version, 1); assert.equal(seen.at(-1).paused, true);
  await controller.refresh(); assert.equal(calls, 4); controller.stop();
});

test('request timeout reconciles a pending POST by GET and hidden POST returns without applying or repeating', async () => {
  const c = clock(), pending = deferred(), doc = documentFixture(), calls = [];
  const controller = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', document: doc, timers: c.timers, now: c.now, request: async (_path, options = {}) => {
    calls.push(options.method || 'GET'); return options.method === 'POST' ? pending.promise : calls.length > 1 ? awaiting() : proof();
  } });
  await controller.open(); const starting = controller.start(); await c.advance(20000); await starting; assert.deepEqual(calls, ['GET', 'POST', 'GET']); assert.equal(controller.dto.state, 'waiting_confirmation');
  pending.resolve(accepted()); await flush(); assert.equal(controller.dto.state, 'waiting_confirmation'); controller.stop();
  const hiddenPost = deferred(), hiddenCalls = [];
  const hidden = createChannelValidation({ tenantId: 't-1', channelId: 'wa-1', document: doc, timers: c.timers, now: c.now, request: async (_path, options = {}) => {
    hiddenCalls.push(options.method || 'GET'); return options.method === 'POST' ? hiddenPost.promise : hiddenCalls.length > 1 ? awaiting() : proof();
  } });
  await hidden.open(); const post = hidden.start(); doc.hide(); hiddenPost.resolve(accepted()); await post; assert.equal(hidden.dto.state, 'not_started'); doc.show(); await flush(); assert.deepEqual(hiddenCalls, ['GET', 'POST', 'GET']); assert.equal(hidden.dto.state, 'waiting_confirmation'); hidden.stop();
});

test('catalog resumes the existing channel and offers adding another explicitly; profile is outside Groups', async () => {
  const f = uiFixture({ channels: [qr(), { id: 'tg-1', name: 'Bot', kind: 'telegram', transport: 'telegram-bot', state: 'connected' }] });
  let html = f.ui.view(route()); assert.match(html, /Continuar configuração/); assert.match(html, /Adicionar outro/); assert.match(html, /data-action="telegram-profile" data-id="tg-1"/); assert.match(html, /teste de ida e volta está pendente/);
  globalThis.location = { hash: '' }; await f.ui.act('channels:resume', 'wa-1'); assert.equal(globalThis.location.hash, '#channels/wa-1/test'); assert.equal(f.calls.length, 0);
  setLocale('en', { persist: false, notify: false }); html = f.ui.view(route()); assert.match(html, /Continue setup/); assert.match(html, /Add another/); assert.match(html, /round-trip test is pending/); f.ui.reset();
});

test('explicit test route changes an existing connection drawer while normal rerenders preserve its chosen step', () => {
  const f = uiFixture(); f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })); assert.equal(f.ui.flow.step, 'connect');
  f.ui.view(route({ channelId: 'wa-1', tab: 'test' })); assert.equal(f.ui.flow.step, 'test'); f.ui.reset();
});

test('explicit Testar click writes the canonical route and reload resumes by GET without starting another attempt', async () => {
  const f = uiFixture({ api: async path => path.endsWith('/channels/onboarding') ? { tenantId: 't-1', items: [awaiting({ state: 'waiting_incoming', conversationId: null, incomingRecorded: false, replyRecorded: false })] } : awaiting({ state: 'waiting_incoming', conversationId: null, incomingRecorded: false, replyRecorded: false }) });
  globalThis.location = { hash: '#channels/wa-1/connect' }; f.ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
  await f.ui.act('channels:step', 'test'); assert.equal(globalThis.location.hash, '#channels/wa-1/test'); assert.equal(f.ui.flow.step, 'test'); await flush(); assert.ok(f.calls.every(call => call.method === 'GET'));
  f.ui.reset(); f.ui.view(route({ channelId: 'wa-1', tab: 'test' })); f.ui.mount(f.main, route({ channelId: 'wa-1', tab: 'test' })); await flush();
  assert.equal(f.ui.flow.step, 'test'); assert.equal(f.ui.flow.validation.dto.state, 'waiting_incoming'); assert.ok(f.calls.every(call => call.method === 'GET')); f.ui.reset();
});

test('explicit current Testar, Conectar and valid Grupos clicks keep the route aligned with the displayed step', async () => {
  const f = uiFixture(); globalThis.location = { hash: '#channels/wa-1/connect' }; f.ui.view(route({ channelId: 'wa-1' })); assert.equal(f.ui.flow.step, 'test');
  await f.ui.act('channels:step', 'test'); assert.equal(globalThis.location.hash, '#channels/wa-1/test');
  await f.ui.act('channels:step', 'connect'); assert.equal(globalThis.location.hash, '#channels/wa-1/connect'); assert.equal(f.ui.flow.step, 'connect');
  await f.ui.act('channels:step', 'groups'); assert.equal(globalThis.location.hash, '#channels/wa-1/groups'); assert.equal(f.ui.flow.step, 'groups'); f.ui.reset();
});

test('canonical step navigation rejects a stale tenant/workspace/session, missing channel and unauthorized roles', async () => {
  for (const change of [f => { f.state.workspaceId = 'other'; }, f => { f.state.tenant.id = 'other'; }, f => { f.state.boot.session = { ...f.state.boot.session }; },
    f => { f.state.boot.session.role = 'operator'; }, f => { f.state.boot.session.kind = 'service'; }, f => { f.state.supportGrantId = 'support'; }, f => { f.state.tenant.channels = []; }]) {
    const f = uiFixture(); globalThis.location = { hash: '#channels/wa-1/connect' }; f.ui.view(route({ channelId: 'wa-1', tab: 'connect' })); change(f);
    await f.ui.act('channels:step', 'test'); assert.equal(globalThis.location.hash, '#channels/wa-1/connect'); assert.equal(f.ui.flow.step, 'connect'); assert.equal(f.calls.length, 0); f.ui.reset();
  }
});

test('invalid tabs and groups on webchat do not navigate; legacy steps without the durable flag stay local', async () => {
  const f = uiFixture({ channels: [{ id: 'site-1', name: 'Site', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { enabled: true } }] });
  globalThis.location = { hash: '#channels/site-1/connect' }; f.ui.view(route({ channelId: 'site-1', tab: 'connect' }));
  for (const id of ['groups', 'name', 'invalid', null, '../test']) await f.ui.act('channels:step', id);
  assert.equal(globalThis.location.hash, '#channels/site-1/connect'); assert.equal(f.ui.flow.step, 'connect'); assert.equal(f.calls.length, 0); f.ui.reset();
  const legacy = uiFixture({ durable: false }); globalThis.location.hash = '#channels/wa-1/connect'; legacy.ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
  await legacy.ui.act('channels:step', 'test'); assert.equal(legacy.ui.flow.step, 'test'); assert.equal(globalThis.location.hash, '#channels/wa-1/connect'); legacy.ui.reset();
});

test('drawer reads saved proof, requires checkbox, and resumes a server confirmation after navigation', async () => {
  let saved = awaiting(); const f = uiFixture({ api: async (path, options) => { if (options.method === 'POST') saved = accepted(); return path.endsWith('/channels/onboarding') ? { tenantId: 't-1', items: [saved] } : saved; } });
  const currentRoute = route({ channelId: 'wa-1', tab: 'test' }); f.ui.view(currentRoute); f.ui.mount(f.main, currentRoute); await flush();
  assert.ok(f.calls.every(value => value.method === 'GET')); assert.equal(f.ui.flow.step, 'test'); let html = f.ui.view(currentRoute); assert.match(html, /name="recipientConfirmed" required/); assert.match(html, /registro de envio não confirma o recebimento/);
  await f.ui.submit({ dataset: { form: 'channels:validation-confirm' }, elements: { namedItem: () => ({ checked: false }) } }); assert.ok(f.calls.every(value => value.method === 'GET'));
  await f.ui.submit({ dataset: { form: 'channels:validation-confirm' }, elements: { namedItem: () => ({ checked: true }) } }); assert.deepEqual(f.calls.at(-1).body, { action: 'confirm', version: 1 }); html = f.ui.view(currentRoute); assert.match(html, /Canal validado/); assert.doesNotMatch(html, /data-form="channels:validation-confirm"/);
  f.ui.reset(); f.ui.view(currentRoute); f.ui.mount(f.main, currentRoute); await flush(); assert.equal(f.calls.filter(value => value.method === 'POST').length, 1); assert.match(f.ui.view(currentRoute), /Canal validado/); f.ui.reset();
});

test('PT/EN test drawer renders only public proof and never writes proof or customer data to storage', async () => {
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), writes = [];
  const storage = { getItem: () => null, setItem: (...args) => writes.push(args), removeItem: (...args) => writes.push(args) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage }); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    const data = { ...awaiting(), text: 'PRIVATE-CUSTOMER', phone: 'PRIVATE-PHONE', secret: 'PRIVATE-SECRET' }; const f = uiFixture({ api: async path => path.endsWith('/channels/onboarding') ? { tenantId: 't-1', items: [data] } : data });
    const currentRoute = route({ channelId: 'wa-1', tab: 'test' }); f.ui.view(currentRoute); f.ui.mount(f.main, currentRoute); await flush();
    for (const locale of ['pt-BR', 'en']) { setLocale(locale, { persist: false, notify: false }); const html = f.ui.view(currentRoute); assert.doesNotMatch(html + JSON.stringify(f.ui.flow), /PRIVATE/); assert.match(html, locale === 'en' ? /Confirm validation/ : /Confirmar validação/); assert.match(html, locale === 'en' ? /A send record does not confirm receipt/ : /registro de envio não confirma o recebimento/); }
    assert.deepEqual(writes, []); f.ui.reset();
  } finally { if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else delete globalThis.localStorage; if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession); else delete globalThis.sessionStorage; }
});

test('real admin only: operator, service and support do not query proof or offer confirmation', async () => {
  for (const session of [{ role: 'operator' }, { kind: 'service' }, { supportGrantId: 'support' }]) {
    const f = uiFixture({ session }); const currentRoute = route({ channelId: 'wa-1', tab: 'test' }); f.ui.view(currentRoute); f.ui.mount(f.main, currentRoute); await flush();
    assert.equal(f.calls.length, 0); assert.doesNotMatch(f.ui.view(currentRoute), /data-form="channels:validation-confirm"|Confirmar validação/); f.ui.reset();
  }
});

test('batch cache cannot cross tenant/session, overwrite newer drawer proof, or persist customer data', async () => {
  const pending = deferred(); const f = uiFixture({ api: async path => path.endsWith('/channels/onboarding') ? pending.promise : awaiting() });
  const currentRoute = route({ channelId: 'wa-1', tab: 'test' }); f.ui.view(currentRoute); f.ui.mount(f.main, currentRoute); await flush();
  pending.resolve({ tenantId: 't-1', items: [proof()] }); await flush(); assert.match(f.ui.view(route()), /Resposta registrada\. Confirme o recebimento no destino/);
  f.state.boot.session = { role: 'reseller', userId: 'new-user' }; assert.doesNotMatch(f.ui.view(route()), /Resposta registrada\. Confirme o recebimento no destino/); f.ui.reset();
  const late = deferred(); const foreign = uiFixture({ api: async () => late.promise }); foreign.ui.view(route()); foreign.ui.mount(foreign.main, route()); foreign.state.tenant.id = 't-other';
  late.resolve({ tenantId: 't-1', items: [accepted()] }); await flush(); assert.doesNotMatch(foreign.ui.view(route()), /Validação concluída/); foreign.ui.reset();
});
