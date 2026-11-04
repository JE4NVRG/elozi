import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import { runInNewContext } from 'node:vm';
import { createMediaUI } from '../public/media-ui.js';
import { createSendIntent } from '../public/send-intent.js';
import { excerpt } from './helpers/app-source.js';
import { sessionExpired } from '../public/session-guard.js';
import { createJsonRead } from '../public/json-read.js';
// A 401 goes through session-guard.js (FRONTEND-V2 §8.1, P1 commit 1f): the real sessionExpired runs with the fixture's location.
const withSessionGuard = globals => Object.assign(globals, { readJsonResponse: createJsonRead({ fetch: (...args) => globals.fetch(...args) }), sessionExpired: options => sessionExpired({ ...options, location: globals.location }) });

const apiSource = excerpt('api');
const html = '<html><body><h1>Proxy error</h1><p>Upstream detail must stay private.</p></body></html>';

function harness(status, body, contentType = 'text/html') {
  const redirects = [], requests = [];
  const visitor = { resets: 0, reset() { this.resets++; } };
  const state = { boot: { csrfToken: 'synthetic-csrf', session: { userId: 'operator', role: 'operator' } }, workspaceId: 'workspace-current', sendIntent: null };
  const mediaUI = createMediaUI({ escape: String, icon: () => '', download: () => assert.fail('API fixture cannot download media'), getPendingSend: () => Boolean(state.sendIntent) });
  const actor = tenantId => ({ userId: 'operator', workspaceId: state.workspaceId, authorityKey: 'synthetic-authority', tenantId, conversationId: 'same', active: true });
  mediaUI.syncContext(actor('a')); mediaUI.choose(new File(['A'], 'a.txt', { type: 'text/plain' }), 'Private draft A');
  mediaUI.syncContext(actor('b'), mediaUI.draft); mediaUI.choose(new File(['B'], 'b.txt', { type: 'text/plain' }), 'Private draft B');
  mediaUI.syncContext(actor('a'), mediaUI.draft);
  state.sendIntent = createSendIntent(null, { workspaceId: state.workspaceId, tenantId: 'a', conversationId: 'same', channelId: 'channel-a', text: mediaUI.draft, attachmentIds: [], version: 1 }, { randomUUID: () => 'synthetic-intent-api-errors' });
  const api = runInNewContext(apiSource + '\napi', withSessionGuard({
    ...i18n,
    state, mediaUI, channelVisitorTestUI: visitor, contactLinksUI: { reset() {} }, contactRefresh: { reset() {} }, memoryUI: { reset() {} },
    location: { assign: path => { assert.equal(visitor.resets, 1, 'Session expiry destroys the visitor before redirect'); assert.equal(mediaUI.selected, null, 'Session expiry resets media before redirect'); assert.equal(mediaUI.draft, ''); assert.equal(state.sendIntent, null); redirects.push(path); } },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return new Response(body, { status, headers: { 'Content-Type': contentType } });
    }
  }));
  return { api, redirects, requests, state, mediaUI, actor, visitor };
}

test('413 HTML preserves the HTTP status and reports the upload limit in Portuguese without proxy HTML', async () => {
  const h = harness(413, html);
  await assert.rejects(h.api('/api/tenants/a/contacts/import/preview', { method: 'POST', body: '{}' }), error => {
    assert.equal(error.status, 413);assert.match(error.message, /arquivo.*limite de envio/i);assert.match(error.message, /divida.*lotes/i);assert.doesNotMatch(error.message, /<html|Upstream|Unexpected token/i);return true;
  });
  assert.equal(h.redirects.length, 0);
  assert.equal(h.visitor.resets, 0, 'Upload limit does not end the visitor context');
});

test('401 HTML still redirects to expired-session login and retains status 401', async () => {
  const h = harness(401, html);
  await assert.rejects(h.api('/api/inbox'), error => error.status === 401 && error.message === 'Entre para continuar.');
  assert.deepEqual(h.redirects, ['/login?reason=session-expired']);
  assert.equal(h.visitor.resets, 1);
  h.mediaUI.syncContext(h.actor('b'), 'Stale textarea');
  assert.equal(h.mediaUI.draft, ''); assert.equal(h.mediaUI.selected, null);
});

for (const status of [502, 503]) test(`${status} HTML reports temporary unavailability with the original status`, async () => {
  const h = harness(status, html);
  await assert.rejects(h.api('/api/inbox'), error => {
    assert.equal(error.status, status);assert.match(error.message, /temporariamente indisponível/);assert.doesNotMatch(error.message, /<|Proxy|Upstream|Unexpected token/i);return true;
  });
  assert.equal(h.redirects.length, 0);
});

test('a JSON 400 retains the server validation message and status', async () => {
  const h = harness(400, JSON.stringify({ error: 'Escolha uma conexão válida.' }), 'application/json');
  await assert.rejects(h.api('/api/tenants/a/contacts/import/preview'), error => error.status === 400 && error.message === 'Escolha uma conexão válida.');
});

test('valid JSON 200 keeps its data, CSRF header, body and explicitly pinned workspace', async () => {
  const data = { workspaceId: 'workspace-pinned', items: [{ tenantId: 'a', id: 'same' }], total: 1 };
  const h = harness(200, JSON.stringify(data), 'application/json');
  assert.deepEqual(await h.api('/api/inbox', { method: 'POST', body: '{}', headers: { 'X-Elozi-Workspace': 'workspace-pinned' } }), data);
  assert.equal(h.requests[0].options.headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.equal(h.requests[0].options.headers['X-Elozi-Workspace'], 'workspace-pinned');
  assert.equal(h.requests[0].options.headers['Content-Type'], 'application/json');
  assert.equal(h.requests[0].options.body, '{}');assert.equal(h.redirects.length, 0);
});

for (const body of [html, '{"accepted":']) test(`malformed successful response fails safely (${body === html ? 'HTML' : 'truncated JSON'})`, async () => {
  const h = harness(200, body);
  await assert.rejects(h.api('/api/tenants/a/contacts/import/apply'), error => {
    assert.equal(error.status, 200);assert.match(error.message, /resposta inválida/);assert.doesNotMatch(error.message, /<html|accepted|Upstream|Unexpected token/i);return true;
  });
  assert.equal(h.redirects.length, 0);
});

test('another non-JSON error receives a safe fallback and its HTTP status', async () => {
  const h = harness(403, html);
  await assert.rejects(h.api('/api/inbox'), error => error.status === 403 && error.message === 'Não foi possível concluir a solicitação. Tente novamente.');
});
