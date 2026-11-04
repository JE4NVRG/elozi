import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramAccountUI, renderTelegramAccountConnection, openTelegramAccountConnection } from '../public/telegram-account-ui.js';
import { setLocale } from '../public/i18n.js';
import { createAgentRail } from '../public/agent-rail-ui.js';
import { createGroupsWorkspaceUI } from '../public/groups-workspace-ui.js';
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const HASH = 'a'.repeat(32);
const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attribute = (source, name) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] || '');
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, options = {}) {
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.fields = form.fields; }
    getAll(name) { return this.fields.filter(field => field.name === name && (field.type !== 'checkbox' || field.checked)).map(field => field.value); }
    get(name) { return this.getAll(name)[0] ?? null; }
  };
  t.after(() => { globalThis.FormData = originalFormData; setLocale('pt-BR', { persist: false, notify: false }); });
  const tasks = new Map(), listeners = new Map(); let timerId = 0, now = Date.parse('2026-10-09T12:00:00Z');
  const document = { visibilityState: 'visible', activeElement: null, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const timers = { setTimeout: fn => { tasks.set(++timerId, fn); return timerId; }, clearTimeout: value => tasks.delete(value), now: () => now };
  const channel = { id: 'channel-a', kind: 'telegram_user', transport: 'telegram-user', state: 'disconnected' };
  const state = { workspaceId: 'workspace-a', view: 'channels', tenant: { id: 'company-a', name: 'Own company', resellerId: 'workspace-a', channels: [channel] }, boot: { csrfToken: 'csrf-synthetic', session: { userId: 'human-a', role: 'reseller', permissions: ['inbox.read'], tenantIds: ['company-a'] }, tenants: [{ id: 'company-a' }], workspaces: [{ id: 'workspace-a' }] } };
  const closeListeners = new Set(), modal = { open: false, markup: '', panel: null, forms: [], ownerDocument: document,
    querySelector: () => modal.panel, addEventListener: (name, fn) => { if (name === 'close') closeListeners.add(fn); }, removeEventListener: (name, fn) => closeListeners.delete(fn),
    close() { this.open = false; for (const fn of [...closeListeners]) fn(); } };
  const opened = [], calls = [], updates = [], notices = []; let source = { tenantId: 'company-a', channelId: 'channel-a', version: 0, configured: false, state: 'disconnected', authState: 'idle', selectedCount: 0, ...options.status };
  const dialogs = [{ id: '1234567890123456789', name: 'Own private', type: 'private', selected: false, canSend: true }, { id: '-1001234567890', name: 'Own group', type: 'group', selected: false, canSend: true }]; let selected = [];
  function parse(markup) {
    const token = attribute(markup, 'data-telegram-account-token');
    const fields = [];
    const parseFields = (text, form) => [...text.matchAll(/<input\b([^>]*)>/g)].map(match => {
      const field = { name: attribute(match[1], 'name'), value: attribute(match[1], 'value'), type: attribute(match[1], 'type') || 'text', checked: /\bchecked\b/.test(match[1]), disabled: /\bdisabled\b/.test(match[1]),
        focus() { document.activeElement = field; } };
      fields.push(field); return field;
    });
    const forms = [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(match => {
      const form = { dataset: { telegramAccountForm: attribute(match[1], 'data-telegram-account-form'), telegramAccountToken: token }, fields: [],
        querySelectorAll: () => form.fields, set(name, value) { const field = form.fields.find(item => item.name === name); assert.ok(field, `Fixture has ${name}`); field.value = value; return field; },
        check(value, checked = true) { const field = form.fields.find(item => item.value === value); assert.ok(field, 'Fixture has requested peer'); field.checked = checked; },
        get(name) { return form.fields.find(item => item.name === name)?.value; } };
      form.fields = parseFields(match[2], form); return form;
    });
    const buttons = [...markup.matchAll(/<button\b([^>]*)>/g)].filter(match => attribute(match[1], 'data-telegram-account-action')).map(match => {
      const button = { dataset: { telegramAccountAction: attribute(match[1], 'data-telegram-account-action'), telegramAccountToken: token }, disabled: /\bdisabled\b/.test(match[1]), focus() { document.activeElement = button; } }; return button;
    });
    modal.forms = forms;
    modal.panel = { dataset: { telegramAccountToken: token }, querySelectorAll: () => fields, contains: value => fields.includes(value) || buttons.includes(value),
      querySelector: selector => {
        const name = /^\[name="([^"]+)"\]$/.exec(selector)?.[1], action = /^\[data-telegram-account-action="([^"]+)"\]$/.exec(selector)?.[1];
        return name ? fields.find(field => field.name === name) : buttons.find(button => button.dataset.telegramAccountAction === action);
      } };
  }
  const dialog = { get: () => modal, open: (title, subtitle, markup) => { modal.open = true; modal.markup = markup; parse(markup); opened.push({ title, subtitle, markup }); } };
  async function fallback(path, init) {
    const suffix = path.split('/telegram-account/')[1];
    if (suffix === 'status') return structuredClone(source);
    if (suffix === 'dialogs' && init.method === 'GET') return { ...source, dialogs, selectedPeerIds: [...selected] };
    const body = JSON.parse(init.body);
    assert.equal(body.version, source.version, 'Writes use the confirmed revision');
    if (suffix === 'configuration') source = { ...source, version: source.version + 1, configured: true, state: 'disconnected', authState: 'idle' };
    else if (suffix === 'auth/start') source = { ...source, state: 'connecting', authState: body.method === 'qr' ? 'qr' : 'code', attemptId: 'attempt-private', ...(body.method === 'qr' ? { qrDataUrl: PNG, qrExpiresAt: new Date(now + 10000).toISOString() } : {}) };
    else if (suffix === 'auth/submit') source = body.code ? { ...source, authState: 'password' } : { ...source, state: 'connected', authState: 'authenticated', attemptId: null, account: { name: 'Own Telegram account' } };
    else if (suffix === 'auth/cancel') source = { ...source, state: 'disconnected', authState: 'idle', attemptId: null, qrDataUrl: null };
    else if (suffix === 'disconnect') source = { ...source, state: 'disconnected', authState: 'idle', attemptId: null, qrDataUrl: null };
    else if (suffix === 'dialogs') { selected = body.peerIds; source = { ...source, version: source.version + 1, selectedCount: selected.length }; return { ...source, dialogs, selectedPeerIds: [...selected] }; }
    else if (suffix === 'history') return { ...source, imported: 3, duplicates: 2, conversations: selected.length, limitPerConversation: body.limitPerConversation, attachmentsAnalyzed: false };
    return structuredClone(source);
  }
  const api = async (path, init = {}) => { calls.push({ path, init }); return options.intercept ? options.intercept(path, init, () => fallback(path, init)) : fallback(path, init); };
  const ui = createTelegramAccountUI({ state, api, dialog, timers, document, authorityGuard: options.authorityGuard || (() => true), onUpdate: value => updates.push(value), toast: (message, error) => notices.push({ message, error }) });
  t.after(() => ui.destroy());
  return { ui, state, channel, modal, opened, calls, updates, notices, tasks, document, listeners, source: () => source, patch: update => { source = { ...source, ...update }; }, setNow: value => { now = value; },
    form: kind => modal.forms.find(form => form.dataset.telegramAccountForm === kind), action: name => ui.action({ dataset: { telegramAccountAction: name, telegramAccountToken: modal.panel?.dataset.telegramAccountToken } }),
    writes: () => calls.filter(call => call.init.method === 'POST'), data: value => JSON.parse(value.init.body), setSelected: value => { selected = value; source.selectedCount = value.length; } };
}

test('app configuration stays disconnected and does not reflect or retain private credentials', async t => {
  const f = fixture(t, { status: { apiHash: 'synthetic-response-secret', session: 'synthetic-response-session', phoneNumber: '+19999999999' } });
  assert.equal(await f.ui.open(f.channel), true);
  const form = f.form('configuration'); form.set('apiId', '12345'); form.set('apiHash', HASH);
  assert.equal(await f.ui.submit(form), true);
  assert.deepEqual(f.data(f.writes()[0]), { version: 0, apiId: 12345, apiHash: HASH });
  assert.equal(form.get('apiId'), ''); assert.equal(form.get('apiHash'), '');
  assert.match(f.modal.markup, /Aplicativo cadastrado · autenticação pendente/);
  assert.match(f.modal.markup, /data-connected="false"/);
  assert.equal(f.opened.some(item => /synthetic-response|19999999999/.test(item.markup)), false);
  assert.equal(f.updates[0].apiHash, undefined); assert.equal(f.updates[0].attemptId, undefined);
  assert.equal(f.state.telegramAccount, undefined);
  assert.equal(f.calls[0].init.headers['X-Elozi-Workspace'], 'workspace-a');
  assert.equal(f.calls[0].init.headers['X-CSRF-Token'], 'csrf-synthetic');
});

test('the application guide gives four accessible steps, exact official links and private-form boundaries in PT and EN', t => {
  t.after(() => setLocale('pt-BR', { persist: false, notify: false }));
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const document = createDocument(renderTelegramAccountConnection({ status: { configured: false } })), guide = document.querySelector('.telegram-account__guide');
    assert.ok(guide.hasAttribute('open')); assert.equal(guide.querySelectorAll('.telegram-account__guide-steps li').length, 4);
    assert.deepEqual(guide.querySelectorAll('dt').map(node => node.textContent), ['App title', locale === 'en' ? 'Short name' : 'Nome curto (Short name)', 'URL', locale === 'en' ? 'Platform' : 'Plataforma (Platform)', 'Description']);
    assert.deepEqual(guide.querySelectorAll('a').map(node => node.getAttribute('href')), ['https://my.telegram.org/auth', 'https://my.telegram.org/apps', 'https://core.telegram.org/api/obtaining_api_id']);
    for (const link of guide.querySelectorAll('a')) { assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.getAttribute('rel'), 'noopener noreferrer'); assert.ok(link.textContent.trim()); }
    assert.equal(guide.querySelectorAll('input, form, iframe, img, script, [data-telegram-account-action]').length, 0);
    assert.match(guide.textContent, /\+55/); assert.match(guide.textContent, /Elozi/); assert.match(guide.textContent, /elozisuaempresa/); assert.match(guide.textContent, /5–32/); assert.match(guide.textContent, /Other/);
    assert.match(guide.textContent, locale === 'en' ? /Telegram app, not by SMS/ : /aplicativo Telegram, não por SMS/);
    assert.match(guide.textContent, locale === 'en' ? /reuse its API ID and API hash/ : /reutilize seu API ID e API hash/);
    assert.match(guide.textContent, locale === 'en' ? /QR or phone authentication/ : /QR ou telefone para autenticar/);
    assert.match(guide.textContent, locale === 'en' ? /only in this private Elozi form/ : /somente neste formulário privado da Elozi/);
    assert.doesNotMatch(guide.textContent, /BotFather|Delete Account|apagar conta/);
    for (const name of ['apiId', 'apiHash']) assert.equal(document.querySelector(`[name="${name}"]`).value, '');
    const configured = createDocument(renderTelegramAccountConnection({ status: { configured: true } }));
    assert.equal(configured.querySelector('.telegram-account__guide').hasAttribute('open'), false);
  }
});

test('native guide disclosure retains typed private fields and focus without repainting or requesting the API', async t => {
  const f = fixture(t), document = createDocument('<dialog id="telegram-test-modal"></dialog>'), modal = document.querySelector('dialog'), calls = [];
  modal.close = () => { modal.open = false; modal.dispatchEvent(new FakeEvent('close')); };
  const ui = createTelegramAccountUI({ state: f.state, company: () => f.state.tenant, document,
    api: async (path, init) => { calls.push({ path, init }); return f.source(); },
    dialog: { get: () => modal, open: (title, subtitle, markup) => { modal.open = true; modal.innerHTML = markup; } } });
  t.after(() => ui.destroy()); await ui.open(f.channel);
  const guide = modal.querySelector('.telegram-account__guide'), summary = guide.querySelector('summary'), apiId = modal.querySelector('[name="apiId"]'), apiHash = modal.querySelector('[name="apiHash"]');
  apiId.value = '12345'; apiHash.value = HASH; summary.focus();
  for (const open of [false, true]) {
    guide.toggleAttribute('open', open); guide.dispatchEvent(new FakeEvent('toggle')); assert.equal(await ui.action(summary), false);
    assert.ok(modal.querySelector('[name="apiId"]') === apiId); assert.ok(modal.querySelector('[name="apiHash"]') === apiHash);
    assert.equal(apiId.value, '12345'); assert.equal(apiHash.value, HASH); assert.ok(document.activeElement === summary); assert.equal(calls.length, 1);
  }
  assert.equal(modal.innerHTML.includes(HASH), false); assert.equal(f.state.telegramAccount, undefined);
  ui.reset(); assert.equal(apiId.value, ''); assert.equal(apiHash.value, ''); assert.equal(calls.length, 1);
});

test('phone, code and 2FA advance only after explicit private submissions', async t => {
  const f = fixture(t, { status: { configured: true, version: 2 } }); await f.ui.open(f.channel);
  const phone = f.form('phone'); phone.set('phoneNumber', '+5511999999999'); await f.ui.submit(phone);
  assert.equal(phone.get('phoneNumber'), ''); assert.match(f.modal.markup, /Código de acesso necessário/);
  assert.equal(f.tasks.size, 0, 'Code entry is not replaced by a polling repaint');
  const code = f.form('authentication'); code.set('code', '123456'); await f.ui.submit(code);
  assert.equal(code.get('code'), ''); assert.match(f.modal.markup, /Senha de duas etapas necessária/);
  const password = f.form('authentication'); password.set('password', 'synthetic-private-password'); await f.ui.submit(password);
  assert.equal(password.get('password'), ''); assert.match(f.modal.markup, /Conta autenticada · Own Telegram account/);
  assert.match(f.modal.markup, /data-connected="true"/);
  assert.equal(f.opened.some(item => /attempt-private|123456|synthetic-private-password|5511999999999/.test(item.markup)), false);
  assert.equal(f.calls.some(call => /attempt-private|5511999999999|123456|password/.test(call.path)), false);
  assert.deepEqual(f.data(f.writes()[2]), { version: 2, attemptId: 'attempt-private', password: 'synthetic-private-password' });
  assert.equal(f.writes().length, 3);
});

test('private QR uses a revocable opaque blob; expiry offers explicit fresh authentication', async t => {
  const revoked = [], originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = value => { revoked.push(value); originalRevoke(value); };
  t.after(() => { URL.revokeObjectURL = originalRevoke; });
  const f = fixture(t, { status: { configured: true } }); await f.ui.open(f.channel); await f.action('qr');
  assert.match(f.modal.markup, /src="blob:/); assert.equal(f.modal.markup.includes(PNG), false); assert.equal(f.tasks.size, 1);
  const blob = /src="(blob:[^"]+)"/.exec(f.modal.markup)[1];
  f.setNow(Date.parse(f.source().qrExpiresAt) + 1); await f.action('refresh');
  assert.match(f.modal.markup, /O QR expirou/); assert.equal(f.modal.markup.includes('<img '), false);
  assert.equal(await f.action('qr'), true);
  f.modal.close(); assert.ok(revoked.includes(blob)); assert.equal(f.tasks.size, 0);
});

test('closing native dialog clears typed secrets even while the dialog is already closed', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connecting', authState: 'password', attemptId: 'attempt-private' } }); await f.ui.open(f.channel);
  const form = f.form('authentication'); form.set('password', 'synthetic-not-submitted'); f.modal.close();
  assert.equal(form.get('password'), ''); assert.equal(f.writes().length, 0);
  assert.equal(await f.ui.submit(form), false);
});

test('late status from another company does not paint or apply authority to its dialog', async t => {
  const response = pending();
  const f = fixture(t, { intercept: () => response.promise });
  const opened = f.ui.open(f.channel); f.state.tenant = { id: 'company-b', name: 'B', resellerId: 'workspace-a', channels: [] };
  response.resolve({ tenantId: 'company-a', channelId: 'channel-a', version: 0, state: 'connected', authState: 'authenticated', configured: true, selectedCount: 0 });
  assert.equal(await opened, false); assert.equal(f.modal.open, false); assert.equal(f.updates.length, 0);
});

test('replaced modal is neither painted, closed nor scrubbed by an old response', async t => {
  const response = pending(); const f = fixture(t, { intercept: () => response.promise }); const opened = f.ui.open(f.channel);
  const otherInput = { name: 'password', value: 'synthetic-other-dialog' };
  f.modal.panel = { dataset: { telegramAccountToken: 'other-module' }, querySelectorAll: () => [otherInput] }; f.modal.markup = 'Different dialog';
  response.resolve({ tenantId: 'company-a', channelId: 'channel-a', version: 0, state: 'disconnected', authState: 'idle', configured: false, selectedCount: 0 });
  assert.equal(await opened, false); assert.equal(f.modal.markup, 'Different dialog'); assert.equal(f.modal.open, true); assert.equal(otherInput.value, 'synthetic-other-dialog');
});

test('authority loss during POST prevents application and wipes the old private form', async t => {
  const response = pending();
  const f = fixture(t, { intercept: (path, init, fallback) => init.method === 'POST' ? response.promise : fallback() }); await f.ui.open(f.channel);
  const form = f.form('configuration'); form.set('apiId', '12345'); form.set('apiHash', HASH);
  const writing = f.ui.submit(form); f.state.boot.session.permissions = []; f.state.boot.csrfToken = 'different-authority';
  response.resolve({ tenantId: 'company-a', channelId: 'channel-a', version: 1, configured: true, state: 'disconnected', authState: 'idle', selectedCount: 0 });
  assert.equal(await writing, false); assert.equal(form.get('apiHash'), ''); assert.equal(f.updates.length, 0); assert.equal(f.modal.open, false);
});

test('uncertain write is verified by GET without replaying code or credentials', async t => {
  let rejectWrite = true;
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'POST' && rejectWrite) throw new Error('synthetic-private-secret-response'); return fallback(); } }); await f.ui.open(f.channel);
  const form = f.form('configuration'); form.set('apiId', '12345'); form.set('apiHash', HASH);
  assert.equal(await f.ui.submit(form), false); assert.match(f.modal.markup, /A confirmação não chegou/); assert.equal(f.modal.markup.includes('synthetic-private-secret-response'), false);
  assert.equal(await f.ui.submit(f.form('configuration')), false); assert.equal(f.writes().length, 1);
  rejectWrite = false; await f.action('refresh'); assert.equal(f.writes().length, 1); assert.equal(f.calls.at(-1).init.method, 'GET');
});

test('explicit selection starts empty, preserves signed 64-bit strings and imports only after a limit', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connected', authState: 'authenticated' } }); await f.ui.open(f.channel);
  assert.match(f.modal.markup, /consentimento específico dos participantes/); assert.equal(f.form('history'), undefined);
  await f.action('dialogs'); assert.equal(f.form('selection').fields.some(field => field.checked), false);
  const form = f.form('selection'); form.check('-1001234567890'); await f.ui.submit(form);
  assert.deepEqual(f.data(f.writes()[0]), { version: 0, peerIds: ['-1001234567890'] });
  assert.equal(f.form('selection').fields.find(field => field.value === '1234567890123456789').checked, false);
  const history = f.form('history'); history.set('limitPerConversation', '101'); await assert.rejects(f.ui.submit(history), /entre 1 e 100/);
  assert.equal(f.writes().length, 1); history.set('limitPerConversation', '25'); await f.ui.submit(history);
  assert.deepEqual(f.data(f.writes()[1]), { version: 1, limitPerConversation: 25 }); assert.match(f.modal.markup, /Recibo da importação/);
  assert.match(f.modal.markup, /não comprova leitura de mídia por IA/); assert.equal(f.calls.some(call => /send|reply|agent|mcp/.test(call.path)), false);
});

test('history import blocks more than 20 selected chats without changing the 100-chat live selection', async t => {
  const dialogs = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1), name: `Own synthetic chat ${index + 1}`, type: 'private', canSend: true }));
  let selection = dialogs.map(item => item.id);
  const f = fixture(t, { status: { configured: true, state: 'connected', authState: 'authenticated', selectedCount: 100 }, intercept: (path, init, fallback) => {
    if (path.endsWith('/dialogs')) {
      if (init.method === 'POST') { selection = JSON.parse(init.body).peerIds; f.patch({ version: f.source().version + 1, selectedCount: selection.length }); }
      return { ...f.source(), dialogs, selectedPeerIds: [...selection] };
    }
    if (path.endsWith('/history')) return { ...f.source(), imported: 20, duplicates: 0, conversations: selection.length, limitPerConversation: JSON.parse(init.body).limitPerConversation, attachmentsAnalyzed: false };
    return fallback();
  } });
  await f.ui.open(f.channel); await f.action('dialogs');
  const historyMarkup = () => /<form\b[^>]*data-telegram-account-form="history"[^>]*>([\s\S]*?)<\/form>/.exec(f.modal.markup)?.[1] || '';
  assert.match(historyMarkup(), /type="submit"[^>]*disabled/); assert.match(f.modal.markup, /reduza a seleção e salve até 20 conversas/); assert.match(f.modal.markup, /até 100 conversas selecionadas/);
  assert.equal(f.form('selection').fields.filter(field => field.checked).length, 100); assert.equal(f.form('selection').fields.some(field => field.disabled), false); assert.equal(f.writes().length, 0);
  await assert.rejects(f.ui.submit(f.form('history')), /até 20 conversas/); assert.equal(f.writes().length, 0); assert.equal(selection.length, 100);
  await f.ui.submit(f.form('selection')); assert.equal(f.data(f.writes()[0]).peerIds.length, 100); assert.equal(selection.length, 100); assert.match(historyMarkup(), /type="submit"[^>]*disabled/);
  const form = f.form('selection'); for (const peerId of selection.slice(20)) form.check(peerId, false);
  await f.ui.submit(form); assert.equal(selection.length, 20); assert.equal(f.data(f.writes()[1]).peerIds.length, 20); assert.doesNotMatch(historyMarkup(), /type="submit"[^>]*disabled/);
  f.form('history').set('limitPerConversation', '10'); await f.ui.submit(f.form('history'));
  assert.equal(f.writes().length, 3); assert.ok(f.writes()[2].path.endsWith('/history')); assert.deepEqual(f.data(f.writes()[2]), { version: 2, limitPerConversation: 10 }); assert.equal(selection.length, 20);
  setLocale('en', { persist: false, notify: false }); t.after(() => setLocale('pt-BR', { persist: false, notify: false }));
  const english = renderTelegramAccountConnection({ status: { configured: true, state: 'connected', authState: 'authenticated', selectedCount: 21 } });
  assert.match(english, /Up to 20 conversations per import/); assert.match(english, /Support allows up to 100 selected conversations/); assert.match(english, /reduce the selection and save up to 20 conversations/);
});

test('forged or incomplete dialog selection cannot broaden or silently erase saved access', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connected', authState: 'authenticated' }, intercept: (path, init, fallback) => path.endsWith('/dialogs') && init.method === 'GET' ? { tenantId: 'company-a', channelId: 'channel-a', version: 0, state: 'connected', dialogs: [], selectedPeerIds: ['-1001234567890'] } : fallback() });
  await f.ui.open(f.channel); assert.equal(await f.action('dialogs'), false); assert.equal(f.form('selection'), undefined); assert.equal(f.writes().length, 0);
  assert.equal(f.modal.markup.includes('-1001234567890'), false);
});

test('cancel only targets the current pending authentication and does not disconnect an authenticated account', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connecting', authState: 'code', attemptId: 'attempt-private', version: 8 } }); await f.ui.open(f.channel); await f.action('cancel');
  assert.deepEqual(f.data(f.writes()[0]), { version: 8, attemptId: 'attempt-private' });
  f.patch({ state: 'connected', authState: 'authenticated', attemptId: null }); await f.action('refresh'); assert.equal(await f.action('cancel'), false); assert.equal(f.writes().length, 1);
});

test('service/support/foreign context and fake connected DTOs are denied', async t => {
  const scoped = fixture(t);
  for (const mutate of [f => { f.state.boot.session.kind = 'service'; }, f => { f.state.supportGrantId = 'support-fixture'; }, f => { f.state.tenant.resellerId = 'other-workspace'; }]) {
    scoped.state.boot.session.kind = undefined; scoped.state.supportGrantId = null; scoped.state.tenant.resellerId = 'workspace-a';
    mutate(scoped); assert.equal(await scoped.ui.open(scoped.channel), false); assert.equal(scoped.calls.length, 0);
  }
  scoped.state.boot.session.kind = undefined; scoped.state.supportGrantId = null; scoped.state.tenant.resellerId = 'workspace-a';
  scoped.patch({ configured: true, state: 'connected', authState: 'idle' }); assert.equal(await scoped.ui.open(scoped.channel), false); assert.match(scoped.modal.markup, /data-connected="false"/);
});

test('disconnect requires contextual confirmation and cancel preserves the unsaved selection', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connected', authState: 'authenticated', version: 4 } }); await f.ui.open(f.channel); await f.action('dialogs');
  f.form('selection').check('-1001234567890');
  assert.equal(await f.action('confirm-disconnect'), false); assert.equal(f.writes().length, 0);
  await f.action('disconnect'); assert.match(f.modal.markup, /Desconectar esta conta da Elozi/); assert.equal(f.writes().length, 0);
  await f.action('keep'); assert.equal(f.form('selection').fields.find(field => field.value === '-1001234567890').checked, true);
  await f.action('disconnect'); assert.equal(await f.action('confirm-disconnect'), true);
  assert.equal(f.writes().length, 1); assert.ok(f.writes()[0].path.endsWith('/disconnect')); assert.deepEqual(f.data(f.writes()[0]), { version: 4 });
  assert.match(f.modal.markup, /data-connected="false"/); assert.equal(f.form('selection'), undefined);
});

test('refresh preserves an unchanged private challenge and never resubmits its value', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connecting', authState: 'code', attemptId: 'attempt-private' } }); await f.ui.open(f.channel);
  const form = f.form('authentication'); form.set('code', '123456'); await f.action('refresh');
  assert.equal(f.form('authentication'), form); assert.equal(form.get('code'), '123456'); assert.equal(f.writes().length, 0);
  f.patch({ authState: 'password' }); await f.action('refresh'); assert.equal(form.get('code'), ''); assert.equal(f.form('authentication').get('password'), '');
});

test('dialog refresh retains explicit unsaved choices only while the server revision is unchanged', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connected', authState: 'authenticated' } }); await f.ui.open(f.channel); await f.action('dialogs');
  f.form('selection').check('-1001234567890'); await f.action('dialogs');
  assert.equal(f.form('selection').fields.find(field => field.value === '-1001234567890').checked, true);
  assert.equal(f.form('selection').fields.find(field => field.value === '1234567890123456789').checked, false);
  f.patch({ version: 3 }); await f.action('dialogs'); assert.equal(f.form('selection').fields.some(field => field.checked), false); assert.equal(f.writes().length, 0);
});

test('English copy and public renderer never place raw QR tokens or grants in markup', async () => {
  setLocale('en', { persist: false, notify: false });
  const html = renderTelegramAccountConnection({ token: 'render-test', status: { configured: true, state: 'connecting', authState: 'code', attemptId: 'private-attempt', apiHash: HASH }, qrURL: 'tg://login?token=private-token' });
  assert.match(html, /Login code required/); assert.match(html, /autocomplete="one-time-code"/); assert.equal(html.includes('private-attempt'), false); assert.equal(html.includes('private-token'), false); assert.equal(html.includes(HASH), false);
  setLocale('pt-BR', { persist: false, notify: false });
});

test('convenience opener reuses the persistent controller supplied by the integrator', async () => {
  const opened = [], controller = { open: async channel => { opened.push(channel.id); } };
  assert.equal(await openTelegramAccountConnection({ id: 'a' }, { controller }), controller); assert.deepEqual(opened, ['a']);
});

test('private authentication errors from successful HTTP responses stay visible without exposing provider text', async t => {
  for (const [code, authState, hint] of [['PHONE_CODE_INVALID', 'code', /Código inválido/], ['PASSWORD_HASH_INVALID', 'password', /Senha incorreta/]]) {
    const f = fixture(t, { status: { configured: true, state: 'connecting', authState, attemptId: 'attempt-private' }, intercept: (path, init, fallback) => {
      if (path.endsWith('/auth/submit')) { f.patch({ errorCode: code, error: 'synthetic-provider-secret' }); return structuredClone(f.source()); }
      return fallback();
    } });
    await f.ui.open(f.channel); const form = f.form('authentication'), field = authState === 'code' ? 'code' : 'password'; form.set(field, authState === 'code' ? '123456' : 'synthetic-private-password');
    assert.equal(await f.ui.submit(form), false); assert.equal(form.get(field), ''); assert.match(f.modal.markup, hint); assert.equal(f.modal.markup.includes('synthetic-provider-secret'), false);
    await f.action('refresh'); assert.match(f.modal.markup, hint); assert.equal(f.writes().length, 1); assert.equal(f.updates[0].errorCode, undefined);
    f.patch({ errorCode: null, error: null }); await f.action('refresh'); assert.doesNotMatch(f.modal.markup, hint);
  }
});

test('finite login errors explain expiry, rate limit, timeout and QR fallback; unknown codes stay generic', async t => {
  const cases = [['PHONE_CODE_EXPIRED', /Código expirado/], ['EMAIL_AUTH_UNSUPPORTED', /Use QR/], ['AUTH_RATE_LIMITED', /Aguarde antes/], ['AUTH_TIMEOUT', /não respondeu no prazo/], ['AUTH_EXPIRED', /autenticação expirou/], ['AUTH_FAILED', /Não foi possível autenticar/], ['synthetic-private-provider-code', /Não foi possível autenticar/]];
  for (const [errorCode, hint] of cases) {
    const f = fixture(t, { status: { configured: true, state: 'failed', authState: 'error', errorCode, error: 'synthetic-provider-secret' } }); await f.ui.open(f.channel);
    assert.match(f.modal.markup, hint); assert.equal(f.modal.markup.includes(errorCode), false); assert.equal(f.modal.markup.includes('synthetic-provider-secret'), false); assert.equal(f.writes().length, 0);
    assert.match(f.modal.markup, /data-telegram-account-action="qr"/); assert.equal(f.tasks.size, 0);
  }
  setLocale('en', { persist: false, notify: false }); t.after(() => setLocale('pt-BR', { persist: false, notify: false }));
  const timeout = fixture(t, { status: { configured: true, state: 'failed', authState: 'error', errorCode: 'AUTH_TIMEOUT' } }); await timeout.ui.open(timeout.channel);
  assert.match(timeout.modal.markup, /Authentication did not respond in time/);
});

test('two-step password limit matches the private backend before any request', async t => {
  const f = fixture(t, { status: { configured: true, state: 'connecting', authState: 'password', attemptId: 'attempt-private' } }); await f.ui.open(f.channel);
  assert.match(f.modal.markup, /name="password"[^>]*maxlength="256"/);
  const form = f.form('authentication'); form.set('password', 'x'.repeat(257)); await assert.rejects(f.ui.submit(form), /senha de verificação/); assert.equal(f.writes().length, 0);
});

const AI_REASON = 'Conversas da conta Telegram pessoal estão disponíveis para atendimento humano. Uso por IA exige consentimento específico dos participantes.';
function railPolicyFixture({ transport = 'telegram-user', capabilities = { aiAllowed: false, aiReason: AI_REASON }, runs = [] } = {}) {
  const conversation = { id: 'conversation-a', channelId: 'channel-a', owner: 'human', assignedUserId: 'human-a', status: 'open', version: 1, messages: [] };
  const state = { workspaceId: 'workspace-a', conversation: conversation.id, boot: { session: { userId: 'human-a', role: 'operator' } }, tenant: { id: 'company-a', channels: [{ id: 'channel-a', transport, capabilities }], conversations: [conversation], runs, agents: [{ id: 'agent-a', name: 'Configured copilot', provider: 'hermes', configured: true, mode: 'copilot' }] } };
  const calls = [], rail = createAgentRail({ state, api: async (path, init) => { calls.push({ path, init }); return {}; }, tenantApi: path => `/api/tenants/company-a/${path}`, canReplyTo: item => item?.owner === 'human' && item.assignedUserId === 'human-a', refresh: async () => {}, render: () => {}, renderRuns: () => {}, toast: () => {}, document: null, noListeners: true, now: () => Date.parse('2026-10-08T12:00:00Z') });
  return { state, conversation, rail, calls };
}

test('personal Telegram rail blocks generation and resuming inference, preserving existing runs and safe controls', async () => {
  const draft = { id: 'draft-a', conversationId: 'conversation-a', conversationVersion: 1, agentId: 'agent-a', agentName: 'Configured copilot', provider: 'hermes', version: 1, state: 'draft', draft: 'Existing reviewed draft', updatedAt: '2026-10-08T11:58:00Z' };
  const approval = { ...draft, id: 'approval-a', state: 'waiting_approval', draft: null, toolProposal: { id: 'proposal-a', title: 'Existing proposal', toolName: 'synthetic_read', serverId: 'synthetic-server', serverName: 'Synthetic server', autoApproved: false, readOnly: true, expiresAt: '2026-10-08T12:10:00Z' } };
  const f = railPolicyFixture({ runs: [draft, approval] }), before = structuredClone(f.state.tenant.runs);
  assert.equal(f.rail.generateState().enabled, false); assert.equal(f.rail.generateState().reason, AI_REASON);
  const panel = String(f.rail.contextTab(f.conversation)); assert.ok(panel.includes(AI_REASON)); assert.match(panel, /type="submit"[^>]*disabled/); assert.match(panel, /data-rail-instruction[^>]*disabled/);
  assert.match(String(f.rail.composerButton()), /disabled/);
  for (const [name, id, element] of [['rail:generate', 'conversation-a'], ['rail:retry', 'conversation-a'], ['rail:regenerate', 'draft-a'], ['rail:approve', 'approval-a', { dataset: { id: 'approval-a' }, closest: () => ({}) }], ['mcp-approve', 'approval-a']]) {
    await assert.rejects(f.rail.act(name, id, element), error => error.message === AI_REASON);
  }
  const markup = String(f.rail.render(f.conversation)); assert.ok(markup.includes('Existing reviewed draft'));
  assert.match(markup, /data-action="rail:regenerate"[^>]*disabled/); assert.match(markup, /data-action="rail:approve"[^>]*disabled/); assert.doesNotMatch(markup, /data-action="rail:reject"[^>]*disabled/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state.tenant.runs, before);
  await f.rail.act('rail:reject', 'approval-a', { dataset: { id: 'approval-a' }, closest: () => ({}) });
  assert.ok(f.calls[0].path.endsWith('/tool/reject')); assert.equal(f.calls.filter(call => call.init?.method === 'POST').length, 1);
});

test('rail denies personal transport when capability is absent and leaves the Telegram bot eligible', async () => {
  const personal = railPolicyFixture({ capabilities: null }); assert.equal(personal.rail.generateState().enabled, false); assert.equal(personal.rail.generateState().reason, AI_REASON);
  const bot = railPolicyFixture({ transport: 'telegram-bot', capabilities: { aiAllowed: true } }); assert.equal(bot.rail.generateState().enabled, true);
  await bot.rail.act('rail:generate', 'conversation-a'); assert.equal(bot.calls.length, 1); assert.ok(bot.calls[0].path.endsWith('/run'));
});

function groupPolicyFixture(transport, aiAllowed) {
  const group = { conversationId: 'group-a', version: 1, title: 'Own synthetic group', channelId: 'channel-a', channelName: 'Own synthetic channel', transport, aiAllowed, state: 'connected', lastMessageAt: '2026-10-08T11:00:00Z', unread: 1, historyCount: 1 };
  const context = { active: true, workspaceId: 'workspace-a', tenantId: 'company-a', userId: 'human-a', authorityKey: 'own-synthetic-authority', canSummarize: true, boot: {}, session: {} };
  const coverage = { from: '2026-10-08T00:00:00Z', to: '2026-10-08T12:00:00Z', availableCount: 1, includedCount: 1, hasMore: false, historySource: 'elozi', attachmentsAnalyzed: false };
  const calls = [], opened = [], host = { isConnected: true, dataset: {}, innerHTML: '', contains: node => node?.owner === host, querySelectorAll: () => [], addEventListener() {} };
  const ui = createGroupsWorkspaceUI({ context: () => context, getAgents: () => [{ id: 'agent-a', name: 'Configured copilot', provider: 'hermes', mode: 'copilot', configured: true }], openConversation: (...args) => opened.push(args), api: async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/groups')) return { tenantId: context.tenantId, groups: [group] };
    if (path.endsWith('/group-context')) return { ...group, tenantId: context.tenantId, group: { title: group.title, description: null, type: 'group', announcement: null, forum: null, source: 'observed', availability: 'available', observedAt: null }, topic: null, participants: { items: [], total: null, complete: false, source: 'observed', availability: 'available', limit: 40, truncated: false } };
    if (path.endsWith('/group-summary')) { const body = JSON.parse(init.body); return { conversationId: group.conversationId, version: group.version, agentId: body.agentId, state: 'ready', summary: 'Synthetic private summary', coverage, createdAt: '2026-10-08T12:00:00Z' }; }
    return { conversationId: group.conversationId, version: group.version, messages: [{ id: 'message-a', kind: 'customer', text: 'Own synthetic human history', senderName: 'Own synthetic participant', createdAt: '2026-10-08T11:00:00Z', attachments: [] }], coverage, nextCursor: null };
  } });
  const action = name => ui.handleAction({ owner: host, isConnected: true, dataset: { groupsToken: host.dataset.groupsToken, groupsAction: name, groupId: group.conversationId } });
  const mount = async () => { host.innerHTML = ui.render(); host.dataset.groupsToken = attribute(host.innerHTML, 'data-groups-token'); await ui.bind(host); await action('select'); };
  return { ui, host, calls, opened, action, mount };
}

test('personal Telegram groups explain the AI restriction and retain human history, reply and scheduling', async () => {
  for (const capability of [false, true, undefined]) {
    const f = groupPolicyFixture('telegram-user', capability); await f.mount();
    assert.ok(f.host.innerHTML.includes(AI_REASON)); assert.ok(f.host.innerHTML.includes('Own synthetic human history')); assert.ok(f.host.innerHTML.includes('Telegram pessoal'));
    assert.match(f.host.innerHTML, /data-groups-action="summary"[^>]*aria-disabled="true"/);
    await f.action('summary'); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
    for (const action of ['open', 'reply', 'schedule']) await f.action(action);
    assert.deepEqual(f.opened, [['group-a', 'company-a', { intent: null }], ['group-a', 'company-a', { intent: 'reply' }], ['group-a', 'company-a', { intent: 'schedule' }]]);
    assert.ok(f.calls.some(call => call.path.includes('/group-history')));
  }
});

test('Telegram bot group summaries remain available and personal restriction is translated', async t => {
  const bot = groupPolicyFixture('telegram-bot', true); await bot.mount(); await bot.action('summary');
  assert.equal(bot.calls.filter(call => call.init.method === 'POST').length, 1); assert.ok(bot.host.innerHTML.includes('Synthetic private summary')); assert.equal(bot.host.innerHTML.includes(AI_REASON), false);
  setLocale('en', { persist: false, notify: false }); t.after(() => setLocale('pt-BR', { persist: false, notify: false }));
  const personal = groupPolicyFixture('telegram-user', false); await personal.mount();
  const rail = railPolicyFixture();
  assert.match(personal.host.innerHTML, /AI use requires specific consent from the participants/); assert.match(String(rail.rail.contextTab(rail.conversation)), /AI use requires specific consent from the participants/);
  assert.match(personal.host.innerHTML, /1 visible messages/); assert.doesNotMatch(personal.host.innerHTML, /mensagens visíveis/);
});
