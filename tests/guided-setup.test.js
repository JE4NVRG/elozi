import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, readinessInput, readSetupPrefs, saveSetupPrefs, forgetHomeData } from '../public/onboarding-ui.js';
import { createOperationReadinessModel, deriveSetup } from '../public/operation-readiness.js';
import { setLocale } from '../public/i18n.js';
import { provideAppServices } from '../public/channel-connect-flow.js';

const channel = (more = {}) => ({ id: 'wa-1', tenantId: 't-1', kind: 'whatsapp_qr', transport: 'baileys', name: 'Vendas', state: 'connected', ...more });
const proof = (more = {}) => ({ tenantId: 't-1', channelId: 'wa-1', version: 2, state: 'validated', startedAt: '2026-10-09T10:00:00Z', validatedAt: '2026-10-09T10:02:00Z', conversationId: 'conv-1', incomingRecorded: true, replyRecorded: true, recipientConfirmed: true, channelAvailable: true, ...more });
function appState(more = {}) {
  const state = { workspaceId: 'w-1', supportGrantId: null, boot: { csrfToken: 'fixture-csrf', session: { role: 'reseller', userId: 'u-1', resellerId: 'w-1' }, reseller: { accountKind: 'business' } },
    tenant: { id: 't-1', name: 'Empresa', channels: [channel()], agents: [], runs: [], conversations: [{ id: 'conv-1', tenantId: 't-1', channelId: 'wa-1', status: 'open', messages: [{ kind: 'customer', text: 'PRIVATE-CUSTOMER' }, { kind: 'human', delivery: 'sent' }] }] },
    overviewLoaded: { assignees: true, contacts: true }, assignees: [{ id: 'u-1' }, { id: 'u-2' }], contacts: [] };
  return { ...state, ...more };
}
const steps = html => Object.fromEntries([...html.matchAll(/<li class="pg-home__setup-item" data-state="([a-z]+)"><button[^>]*data-id="([a-z]+)"/g)].map(match => [match[2], match[1]]));
const readiness = state => createOperationReadinessModel(readinessInput(state));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function memory() { const values = new Map(), writes = []; return { values, writes, getItem: key => values.get(key) || null, setItem(key, value) { writes.push([key, String(value)]); values.set(key, String(value)); } }; }
let storage, oldStorage, oldDocument;
test.beforeEach(() => { oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); oldDocument = globalThis.document; storage = memory(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage }); globalThis.document = { querySelector: () => null }; });
test.afterEach(() => { setLocale('pt-BR', { persist: false, notify: false }); provideAppServices(null); forgetHomeData(); if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage; if (oldDocument) globalThis.document = oldDocument; else delete globalThis.document; });
function fixture({ state = appState(), api = async () => ({ tenantId: 't-1', items: [] }) } = {}) {
  const calls = [], ui = createOnboarding({ state, durableOnboarding: true, api: async (path, options = {}) => { calls.push({ path, options }); return api(path, options); } }); return { ui, state, calls };
}

test('durable readiness requires the saved scoped destination acceptance, never legacy inbound/reply records', () => {
  const model = readiness(appState()); assert.equal(model.exchangeRecorded, true);
  assert.equal(deriveSetup(model).steps.find(step => step.id === 'test').state, 'done', 'legacy contract stays available when no durable mode is supplied');
  for (const validation of [null, { state: 'loading', items: [proof()] }, { state: 'error', items: [proof()] }]) assert.equal(deriveSetup(model, { validation }).steps.find(step => step.id === 'test').state, 'unknown');
  for (const item of [proof({ state: 'waiting_reply', replyRecorded: false, recipientConfirmed: false }), proof({ state: 'waiting_confirmation', recipientConfirmed: false }), proof({ state: 'stale' }), proof({ channelAvailable: false }), proof({ tenantId: 'foreign' }), proof({ channelId: 'missing' })]) {
    const setup = deriveSetup(model, { validation: { state: 'loaded', items: [item] } }); assert.equal(setup.complete, false, JSON.stringify(item)); assert.equal(setup.steps.find(step => step.id === 'test').state, 'todo');
  }
  assert.equal(deriveSetup(model, { validation: { state: 'loaded', items: [proof()] } }).complete, true);
});

test('setup opens with pending proof, loads one read-only batch and completes only after server acceptance', async () => {
  const pending = deferred(), f = fixture({ api: async () => pending.promise }); assert.equal(steps(f.ui.view()).test, 'unknown');
  f.ui.mount(); await flush(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/tenants/t-1/channels/onboarding'); assert.equal(f.calls[0].options.headers['X-Elozi-Workspace'], 'w-1'); assert.equal(f.calls[0].options.method, undefined);
  assert.equal(steps(f.ui.view()).test, 'unknown'); pending.resolve({ tenantId: 't-1', items: [proof({ text: 'PRIVATE-PROOF', phone: 'PRIVATE-PHONE', secret: 'PRIVATE-SECRET' })] }); await flush();
  const html = f.ui.view(); assert.equal(steps(html).test, 'done'); assert.match(html, /Preparação do atendimento manual concluída/); assert.match(html, /Recebimento no destino confirmado/); assert.doesNotMatch(html, /PRIVATE/); assert.deepEqual(storage.writes, []); f.ui.reset();
});

test('HTTP errors, foreign DTOs and malformed confirmation remain unknown and offer retry without a write', async () => {
  for (const result of [Object.assign(new Error('Denied'), { status: 403 }), { tenantId: 'foreign', items: [proof()] }, { tenantId: 't-1', items: [proof({ recipientConfirmed: false })] }, { tenantId: 't-1', items: [proof({ channelId: 'missing' })] }]) {
    const f = fixture({ api: async () => { if (result instanceof Error) throw result; return result; } }); f.ui.mount(); await flush(); await f.ui.act('setup:select', 'test'); const html = f.ui.view();
    assert.equal(steps(html).test, 'unknown'); assert.doesNotMatch(html, /Preparação do atendimento manual concluída/); assert.match(html, /Não foi possível carregar os testes salvos/); assert.match(html, /data-action="setup:validation-refresh"/); assert.ok(f.calls.every(call => call.options.method === undefined)); f.ui.reset();
  }
});

test('scope changes and late reset discard a proof from the previous workspace, tenant or authority', async () => {
  for (const change of [f => { f.state.workspaceId = 'other'; }, f => { f.state.tenant.id = 'other'; }, f => { f.state.boot.session.userId = 'other'; }, f => { f.state.supportGrantId = 'support'; }, f => { f.state.boot.csrfToken = 'changed'; }, f => f.ui.reset()]) {
    const pending = deferred(), f = fixture({ api: async () => pending.promise }); f.ui.mount(); await flush(); change(f); pending.resolve({ tenantId: 't-1', items: [proof()] }); await flush();
    const html = f.ui.view(); assert.doesNotMatch(html, /Preparação do atendimento manual concluída|Recebimento no destino confirmado/); f.ui.reset();
  }
});

test('a newer refresh wins over an earlier batch and canceled requests cannot make setup complete', async () => {
  const older = deferred(), newer = deferred(); let index = 0; const f = fixture({ api: async () => ++index === 1 ? older.promise : newer.promise });
  f.ui.mount(); await flush(); const refreshing = f.ui.act('setup:validation-refresh'); assert.equal(f.calls[0].options.signal.aborted, true);
  newer.resolve({ tenantId: 't-1', items: [proof({ state: 'waiting_confirmation', recipientConfirmed: false, validatedAt: null })] }); await refreshing;
  older.resolve({ tenantId: 't-1', items: [proof()] }); await flush(); assert.equal(steps(f.ui.view()).test, 'todo'); assert.doesNotMatch(f.ui.view(), /Preparação do atendimento manual concluída/); f.ui.reset();
});

test('timeout aborts a proof request and ignores an API result that arrives after cancellation', async () => {
  const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout, pending = deferred(); let timeout;
  globalThis.setTimeout = fn => { timeout = fn; return 1; }; globalThis.clearTimeout = () => {};
  try { const f = fixture({ api: async () => pending.promise }); f.ui.mount(); await flush(); timeout(); assert.equal(f.calls[0].options.signal.aborted, true); pending.resolve({ tenantId: 't-1', items: [proof()] }); await flush(); assert.notEqual(steps(f.ui.view()).test, 'done'); f.ui.reset(); }
  finally { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear; }
});

test('attendance modes are local choices with whitelisted values and links, with no agent activation or access creation', async () => {
  const f = fixture(); const original = JSON.stringify(f.state.tenant.agents);
  const targets = { solo: '#inbox', team: '#settings/team', agent: '#agents/connect', hybrid: '#agents/connect' };
  for (const mode of ['solo', 'team', 'agent', 'hybrid']) {
    await f.ui.act('setup:attendance', mode); const prefs = readSetupPrefs('u-1', 't-1', storage), html = f.ui.view(); assert.equal(prefs.attendanceMode, mode); assert.equal(prefs.solo, mode === 'solo');
    assert.match(html, new RegExp(`href="${targets[mode]}"`)); if (mode === 'hybrid') assert.match(html, /href="#settings\/team"/); assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.state.tenant.agents), original);
  }
  const before = storage.getItem('elozi:setup:u-1'); for (const mode of ['all-tools', '', 'auto', '__proto__']) await f.ui.act('setup:attendance', mode); assert.equal(storage.getItem('elozi:setup:u-1'), before);
  assert.deepEqual([...storage.values.keys()], ['elozi:setup:u-1']); assert.doesNotMatch(before, /PRIVATE|token|tenantId|channelId|conversationId|incomingRecorded|validatedAt/); f.ui.reset();
});

test('attendance preferences are isolated per person/company and stale untrusted modes do not reappear', () => {
  saveSetupPrefs('u-1', 't-1', { attendanceMode: 'agent' }, storage); saveSetupPrefs('u-1', 't-2', { attendanceMode: 'team' }, storage); saveSetupPrefs('u-2', 't-1', { attendanceMode: 'solo', solo: true }, storage);
  assert.equal(readSetupPrefs('u-1', 't-1', storage).attendanceMode, 'agent'); assert.equal(readSetupPrefs('u-1', 't-2', storage).attendanceMode, 'team'); assert.equal(readSetupPrefs('u-2', 't-1', storage).attendanceMode, 'solo');
  storage.setItem('elozi:setup:untrusted', JSON.stringify({ 't-1': { attendanceMode: 'activate-all', secret: 'PRIVATE' } })); assert.deepEqual(readSetupPrefs('untrusted', 't-1', storage), { dismissed: false, solo: false, completedAt: null });
  assert.equal(Object.hasOwn(saveSetupPrefs('u-3', 't-1', { attendanceMode: 'activate-all' }, storage), 'attendanceMode'), false);
});

test('operator, service and temporary support cannot load proof or save attendance choices', async () => {
  for (const patch of [{ role: 'operator' }, { kind: 'service' }, { supportGrantId: 'support' }]) {
    const state = appState(); Object.assign(state.boot.session, patch); const f = fixture({ state }); f.ui.mount(); await flush(); await f.ui.act('setup:attendance', 'agent'); assert.equal(f.calls.length, 0); assert.deepEqual(storage.writes, []); assert.doesNotMatch(f.ui.view(), /data-action="setup:attendance"/); f.ui.reset();
  }
});

test('PT/EN setup resumes an existing channel and labels adding another explicitly, without creating it', async () => {
  const f = fixture(); await f.ui.act('setup:select', 'channel');
  for (const locale of ['pt-BR', 'en']) { setLocale(locale, { persist: false, notify: false }); const html = f.ui.view(); assert.match(html, /href="#channels\/wa-1\/test"/); assert.match(html, /href="#channels\/new\/whatsapp_qr"/); assert.match(html, locale === 'en' ? /Continue setup/ : /Continuar configuração/); assert.match(html, locale === 'en' ? /Add another/ : /Adicionar outro/); }
  await f.ui.act('setup:select', 'team'); assert.match(f.ui.view(), /Who will handle support\?/); assert.match(f.ui.view(), /Team \+ Hermes/); assert.equal(f.calls.length, 0); f.ui.reset();
});
