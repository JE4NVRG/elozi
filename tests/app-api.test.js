import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import { runInNewContext } from 'node:vm';
import { createMediaUI } from '../public/media-ui.js';
import { createSendIntent } from '../public/send-intent.js';
import { excerpt } from './helpers/app-source.js';
import { sessionExpired, resetSessionGuard } from '../public/session-guard.js';
import { createJsonRead } from '../public/json-read.js';
// A 401 goes through session-guard.js (FRONTEND-V2 §7.2, §8.3 P2): the real sessionExpired runs with the fixture's location.
// Without a page for the dialog it keeps the behaviour of before (these first tests); with one (the last
// tests) it never navigates and keeps the composer, the attachments and the send intent (P2).
let page = null;
const withSessionGuard = globals => Object.assign(globals, { readJsonResponse: createJsonRead({ fetch: (...args) => globals.fetch(...args) }), sessionExpired: options => sessionExpired({ ...options, location: globals.location, ...(page ? { document: page.document, window: page.window } : {}) }) });

const apiSource = excerpt('api');
const path = '/api/auth/password/change', current = 'Synthetic-current-4567', next = 'Synthetic-next-4567';

function fixture(status, value, { html = false } = {}) {
  const redirects = [], requests = [], headers = { 'Content-Type': html ? 'text/html' : 'application/json' }, agenda = { resets: 0 };
  const visitor = { resets: 0, reset() { this.resets++; } };
  const state = { boot: { csrfToken: 'synthetic-csrf', session: { userId: 'operator', role: 'operator' } }, workspaceId: 'synthetic-workspace', sendIntent: null };
  const mediaUI = createMediaUI({ escape: String, icon: () => '', download: () => assert.fail('Este fixture não lê mídia'), getPendingSend: () => Boolean(state.sendIntent) });
  const actor = tenantId => ({ userId: 'operator', workspaceId: state.workspaceId, authorityKey: 'synthetic-authority', tenantId, conversationId: 'same', active: true });
  mediaUI.syncContext(actor('a')); mediaUI.choose(new File(['A'], 'a.txt', { type: 'text/plain' }), 'Rascunho A');
  mediaUI.syncContext(actor('b'), mediaUI.draft); mediaUI.choose(new File(['B'], 'b.txt', { type: 'text/plain' }), 'Rascunho B');
  mediaUI.syncContext(actor('a'), mediaUI.draft);
  state.sendIntent = createSendIntent(null, { workspaceId: state.workspaceId, tenantId: 'a', conversationId: 'same', channelId: 'channel-a', text: mediaUI.draft, attachmentIds: [], version: 1 }, { randomUUID: () => 'synthetic-intent-app-api' });
  const selected = mediaUI.selected, intent = state.sendIntent;
  const api = runInNewContext(apiSource + '\napi', withSessionGuard({
    ...i18n,
    state, mediaUI, channelVisitorTestUI: visitor, contactLinksUI: { reset() {} }, contactRefresh: { reset() { agenda.resets++; } }, memoryUI: { reset() {} },
    location: { assign(target) { assert.equal(visitor.resets, 1, 'Descartar visitante antes de redirecionar'); assert.equal(agenda.resets, 1, 'Abortar agenda antes de redirecionar'); assert.equal(mediaUI.selected, null, 'Limpar mídia antes de redirecionar'); assert.equal(mediaUI.draft, ''); assert.equal(state.sendIntent, null); redirects.push(target); } },
    fetch: async (path, options) => { requests.push({ path, options }); return new Response(html ? value : JSON.stringify(value), { status, headers }); }
  }));
  return { api, redirects, requests, state, mediaUI, actor, selected, intent, agenda, visitor };
}

test('senha atual incorreta permanece na tela de conta e mantém o erro para correção', async () => {
  const f = fixture(401, { error: 'Senha atual incorreta.' });
  const options = { method: 'POST', body: JSON.stringify({ currentPassword: current, password: next }) };
  await assert.rejects(f.api(path, options), error => error.status === 401 && error.message === 'Senha atual incorreta.');
  assert.deepEqual(f.redirects, []); assert.equal(f.requests.length, 1); assert.equal(f.agenda.resets, 0);
  assert.equal(f.visitor.resets, 0, 'Senha incorreta não invalida o visitante da sessão vigente');
  assert.equal(f.mediaUI.selected, f.selected); assert.equal(f.mediaUI.draft, 'Rascunho A'); assert.equal(f.state.sendIntent, f.intent);
  assert.equal(options.body, JSON.stringify({ currentPassword: current, password: next }));
  assert.equal(f.requests[0].options.headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.equal(f.requests[0].options.headers['X-Elozi-Workspace'], 'synthetic-workspace');
});

for (const [requestPath, value] of [
  [path, { error: 'Sessão inválida ou expirada. Entre novamente.' }],
  [path, { error: 'Senha atual incorreta. ' }],
  [path, null],
  ['/api/auth/me', { error: 'Senha atual incorreta.' }],
  [path + '?reason=synthetic', { error: 'Senha atual incorreta.' }]
]) {
  test('outro 401 continua levando ao login: ' + requestPath + ' / ' + String(value?.error || 'sem erro'), async () => {
    const f = fixture(401, value);
    await assert.rejects(f.api(requestPath), error => error.status === 401 && error.message === 'Entre para continuar.');
    assert.deepEqual(f.redirects, ['/login?reason=session-expired']);
    assert.equal(f.visitor.resets, 1);
    f.mediaUI.syncContext(f.actor('b'), 'Textarea anterior'); assert.equal(f.mediaUI.draft, ''); assert.equal(f.mediaUI.selected, null);
  });
}

test('401 HTML na rota de troca de senha continua sinalizando sessão expirada', async () => {
  const f = fixture(401, '<html>Proxy synthetic detail</html>', { html: true });
  await assert.rejects(f.api(path), error => error.status === 401 && error.message === 'Entre para continuar.');
  assert.deepEqual(f.redirects, ['/login?reason=session-expired']);
});

test('troca confirmada conserva retorno e não redireciona', async () => {
  const data = { changed: true, revokedSessions: 2 }, f = fixture(200, data);
  assert.deepEqual(await f.api(path, { method: 'POST', body: '{}' }), data); assert.deepEqual(f.redirects, []);
});

test('validação 400 mantém mensagem, status e formulário na sessão atual', async () => {
  const f = fixture(400, { error: 'Use uma letra maiúscula e um caractere especial.' });
  await assert.rejects(f.api(path), error => error.status === 400 && error.message === 'Use uma letra maiúscula e um caractere especial.');
  assert.deepEqual(f.redirects, []);
});

// P2: the dialog of re-authentication instead of leaving the page.
function reauthPage() {
  const events = [], listeners = {};
  const dialog = { open: false, isConnected: true, setAttribute() {}, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; }, remove() {}, querySelector: () => null, innerHTML: '' };
  return { events, dialog,
    document: { body: { append() {} }, createElement: () => dialog },
    window: { location: { origin: 'https://painel.example.test' }, addEventListener(name, fn) { (listeners[name] ||= []).push(fn); }, dispatchEvent(event) { events.push(event.type); return true; }, open: () => null } };
}

test('P2: 401 não navega e preserva compositor, anexos e intenção de envio; o diálogo pede para entrar de novo', async () => {
  page = reauthPage();
  try {
    const f = fixture(401, { error: 'Sessão inválida ou expirada. Entre novamente.' });
    await assert.rejects(f.api('/api/inbox?status=active'), error => error.status === 401 && error.message === 'Entre para continuar.');
    assert.deepEqual(f.redirects, [], 'a página não sai');
    assert.equal(f.agenda.resets, 1, 'os carregadores da sessão antiga param');
    assert.equal(f.visitor.resets, 1, 'o visitante para mesmo quando o compositor e os anexos são preservados');
    assert.equal(f.mediaUI.selected, f.selected, 'o anexo continua'); assert.equal(f.mediaUI.draft, 'Rascunho A', 'o texto do compositor continua');
    assert.equal(f.state.sendIntent, f.intent, 'a intenção de envio fica para conferir depois; nada é reenviado sozinho');
    assert.deepEqual(page.events, ['elozi:reauth'], 'o live pausa pelo evento');
    assert.equal(page.dialog.open, true);
    await assert.rejects(f.api('/api/inbox?status=active'), error => error.status === 401);
    assert.deepEqual(page.events, ['elozi:reauth'], 'um único diálogo para vários 401');
  } finally { page = null; resetSessionGuard(); }
});
