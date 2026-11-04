// Real-use audit of 27/10/2026: queue alert in the list, keys typed in the visitor widget mounted on the panel,
// privacy mode, transfer with an explicit destination, a readable origin refusal and pages a browser can read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { queueChip, inboxRowMarkup } from '../public/inbox-list-ui.js';
import { createKeyboard, keyboard } from '../public/keyboard.js';
import { createLiveRegistry, provideLiveContext } from '../public/live.js';
import { applyThemePrefs, normalizeThemePrefs, DEFAULT_THEME_PREFS } from '../public/theme-prefs.js';
import { realtimeFixture } from './helpers/realtime-fixture.js';
import { createApp } from '../src/server.js';

const NOW = Date.parse('2026-10-27T13:56:00.000Z');
const minutesAgo = minutes => new Date(NOW - minutes * 60000).toISOString();

test('lista: selo "Na fila há N min" só para fila sem dono em que o cliente falou por último entre 5 minutos e 24 horas atrás', () => {
  const item = { tenantId: 't1', id: 'c1', conversationId: 'c1', contact: 'Visitante', channelId: 'web', channelName: 'Site', owner: 'queue', status: 'open', unread: 1,
    preview: { text: 'Hi, how do I set up DKIM for a custom domain?', kind: 'customer', createdAt: minutesAgo(17) } };
  assert.match(String(queueChip(item, NOW)), /Na fila há 17 min/);
  assert.match(String(queueChip({ ...item, preview: { ...item.preview, createdAt: minutesAgo(130) } }, NOW)), /Na fila há 2 h/);
  for (const [label, changed] of [['recent', { preview: { ...item.preview, createdAt: minutesAgo(4) } }], ['answered last', { preview: { ...item.preview, kind: 'human' } }],
    ['owned', { owner: 'human' }], ['older than a day', { preview: { ...item.preview, createdAt: minutesAgo(24 * 60) } }], ['agent', { owner: 'agent' }], ['closed', { status: 'closed' }], ['no date', { preview: { ...item.preview, createdAt: null } }]]) {
    assert.equal(String(queueChip({ ...item, ...changed }, NOW)), '', label);
  }
  assert.match(String(inboxRowMarkup(item, { workspaceId: 'w', tenants: [], now: NOW })), /pg-inbox__chip--warning[^>]*>.*Na fila há 17 min/);
});

test('busca: enquanto a página da busca digitada não chega, a lista diz "Buscando…" e marca as linhas antigas', async () => {
  const { createDocument } = await import('./helpers/inbox-dom.js');
  const { inboxListMarkup, createInboxList } = await import('../public/inbox-list-ui.js');
  const row = id => ({ tenantId: 't1', tenantName: 'Loja Centro', id, conversationId: id, contact: `Contato ${id}`, channelId: 'ch1', channelName: 'WhatsApp', channelKind: 'whatsapp_qr', owner: 'human', status: 'open', unread: 0, updatedAt: '2026-10-27T13:00:00Z', preview: { text: 'Oi', kind: 'customer' } });
  const data = items => ({ workspaceId: 'w', items, total: items.length, offset: 0, limit: 50, hasMore: false, tenants: [{ id: 't1', name: 'Loja Centro' }], channels: [], departments: [], assignees: [], counts: {}, countTabs: {} });
  const filters = search => ({ inboxCompany: 'all', channel: 'all', department: 'all', assignedUser: 'all', filter: 'all', status: 'active', kind: 'all', sort: 'recent', search, unread: false });
  const options = (items, search, more = {}) => ({ data: data(items), filters: filters(search), workspaceId: 'w', userId: 'u', tenants: [{ id: 't1', name: 'Loja Centro' }], ...more });
  const doc = createDocument(String(inboxListMarkup(options([row('a'), row('b')], ''))));
  const list = createInboxList({ doc, motion: () => false });
  const box = () => doc.getElementById('conversation-items'), status = () => doc.querySelector('[data-inbox-status]');
  // The person typed: the old page is still on screen while the search request runs.
  list.patch(options([row('a'), row('b')], 'DKIM', { loading: true }));
  assert.equal(status().textContent, 'Buscando “DKIM”…'); assert.equal(status().getAttribute('data-state'), 'busy');
  assert.equal(box().getAttribute('aria-busy'), 'true');
  // The result arrived: the rows are the search result and the notice goes away.
  list.patch(options([row('a')], 'DKIM'));
  assert.equal(status().textContent, ''); assert.equal(status().getAttribute('data-state'), null); assert.equal(box().getAttribute('aria-busy'), null);
  // A poll of the same search (nothing the person changed) never shows it.
  list.patch(options([row('a')], 'DKIM', { loading: true }));
  assert.equal(status().textContent, ''); assert.equal(box().getAttribute('aria-busy'), null);
  // An error wins over the notice.
  list.patch(options([row('a')], 'spam', { loading: true, error: 'Não foi possível buscar.' }));
  assert.equal(status().textContent, 'Não foi possível buscar.'); assert.equal(status().getAttribute('data-state'), null);
});

function keyboardPage() {
  const registry = createLiveRegistry();
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1' }), registry);
  const storage = new Map(), store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  let listener = null;
  const doc = { activeElement: null, getElementById: () => null, addEventListener(name, fn) { if (name === 'keydown') listener = fn; }, querySelector: () => null, querySelectorAll: () => [] };
  const keys = createKeyboard({ storage: store, registry });
  for (const scope of ['global', 'list', 'conversation', 'composer']) keys.registerScope(scope, Object.fromEntries([...keyboard.bindings(scope)]));
  keys.setScope('channels'); keys.install(doc);
  const press = (key, target, extra = {}) => { const event = { key, target, preventDefault() { this.prevented = true; }, ...extra }; listener(event); return event; };
  return { press };
}

test('teclado: dentro do widget (shadow DOM) "?", "g" e "[" ficam como texto; fora de campos os atalhos continuam', () => {
  const page = keyboardPage();
  // The panel's listener sees the shadow host as the target; the focused textarea is first in the composed path.
  const host = { closest: () => null };
  const field = { closest: selector => selector.includes('textarea') ? field : null };
  const insideWidget = { composedPath: () => [field, { closest: () => null }, host] };
  for (const key of ['g', '[', 'j']) assert.equal(page.press(key, host, insideWidget).prevented, undefined, key);
  assert.equal(page.press('?', host, { ...insideWidget, shiftKey: true }).prevented, undefined, '?');
  // Without the composed path (the behaviour before the fix) the same host swallowed the key: "g" started a sequence.
  assert.equal(page.press('g', host).prevented, true);
  page.press('Escape', host);
  const button = { closest: () => null };
  assert.equal(page.press('g', host, { composedPath: () => [button, host] }).prevented, true, 'a key on a widget button that is not a field is not text');
});

test('modo privacidade: preferência por pessoa reflete data-privacy no <html>; padrão desligado', () => {
  assert.equal(DEFAULT_THEME_PREFS.privacy, 'off');
  assert.equal(normalizeThemePrefs({ privacy: 'on' }).privacy, 'on');
  assert.equal(normalizeThemePrefs({ privacy: 'sometimes' }).privacy, 'off');
  const attributes = new Map(), root = { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name), ownerDocument: { querySelectorAll: () => [] } };
  applyThemePrefs(root, { privacy: 'on' });
  assert.equal(attributes.get('data-privacy'), 'on');
  applyThemePrefs(root, { privacy: 'off' });
  assert.equal(attributes.has('data-privacy'), false);
});

test('transferência: destino explícito; fila para a mesma fila é recusada, pessoa e copiloto mudam o dono', async t => {
  const f = await realtimeFixture(t);
  const owner = (conversationId, body) => f.request(`/api/tenants/rt-a1/conversations/${conversationId}/owner`, { method: 'POST', body });
  const refused = await owner('c-sales', { owner: 'queue', version: 3 });
  assert.equal(refused.status, 409); assert.match(refused.data.error, /já está na fila deste departamento/);
  assert.equal(f.tenant('rt-a1').conversations.find(item => item.id === 'c-sales').version, 3, 'nothing changed: no "devolvido à fila" message');
  const moved = await owner('c-sales', { owner: 'queue', version: 3, departmentId: 'support' });
  assert.equal(moved.status, 200, 'another department queue is a real destination');
  const person = await owner('c-support', { owner: 'human', version: 1, assignedUserId: f.users.admin.id, reason: 'Cliente pediu uma pessoa' });
  assert.equal(person.status, 200);
  const human = f.tenant('rt-a1').conversations.find(item => item.id === 'c-support');
  assert.equal(human.owner, 'human'); assert.equal(human.assignedUserId, f.users.admin.id);
  assert.match(human.messages.at(-1).text, /Atendimento atribuído a Admin A\. Motivo: Cliente pediu uma pessoa/);
  const agent = await owner('c-tg', { owner: 'agent', version: 1, agentId: 'agent-1' });
  assert.equal(agent.status, 200); assert.equal(f.tenant('rt-a1').conversations.find(item => item.id === 'c-tg').agentId, 'agent-1');
});

async function server(t) {
  const key = randomBytes(32), deny = async () => { throw Error('Transporte externo proibido no teste'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, gatewayOptions: { authKey: key, socketFactory: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny }, googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([app.webchat.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    pending.on('error', reject); pending.end(body);
  });
  return { app, request };
}

test('páginas: navegação sem sessão vai da raiz ao login; página inexistente em HTML; API e verificador seguem iguais', async t => {
  const { request } = await server(t);
  const navigate = { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const root = await request('/', { headers: navigate });
  assert.equal(root.status, 302); assert.equal(root.headers.location, '/login');
  const signedIn = await request('/', { headers: { ...navigate, Cookie: 'mep_session=sintetico' } });
  assert.equal(signedIn.status, 200, 'a session cookie keeps the app shell (it validates the session itself)');
  const fetched = await request('/');
  assert.equal(fetched.status, 200, 'scripts/verify.mjs and other non-navigation reads still get the shell');
  assert.match(fetched.text, /app-entry\.js/);
  const pricing = await request('/pricing', { headers: navigate });
  assert.equal(pricing.status, 404); assert.match(pricing.headers['content-type'], /^text\/html/);
  assert.match(pricing.text, /Página não encontrada/); assert.match(pricing.text, /href="\/login"/); assert.doesNotMatch(pricing.text, /<script/i);
  assert.doesNotMatch(pricing.text, /Elozi/, 'neutral on resellers\' own domains');
  const api = await request('/api/nada', { headers: navigate });
  assert.equal(api.status, 404); assert.match(api.headers['content-type'], /^application\/json/);
  const json = await request('/pricing');
  assert.equal(json.status, 404); assert.match(json.headers['content-type'], /^application\/json/, 'a programmatic read keeps the JSON error');
});

test('webchat: site fora das origens recebe recusa legível (preflight e 403 com CORS e código); canal desligado continua sem CORS', async t => {
  const { app, request } = await server(t);
  const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Teste sintético' };
  app.store.mutate(admin, 'loja-demo', 'Webchat sintético', tenant => {
    tenant.channels.push({ id: 'site-qa', name: 'Site', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { enabled: true, version: 1, origins: ['https://loja.example'] } });
  });
  const path = '/api/public/webchat/loja-demo/site-qa/config';
  const preflight = await request(path, { method: 'OPTIONS', headers: { Origin: 'https://outro.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], 'https://outro.example');
  const refused = await request(path, { method: 'POST', headers: { Origin: 'https://outro.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 403); assert.equal(refused.headers['access-control-allow-origin'], 'https://outro.example');
  assert.deepEqual(JSON.parse(refused.text), { error: 'Webchat indisponível para esta origem.', code: 'webchat_origin_denied' });
  const allowed = await request(path, { method: 'POST', headers: { Origin: 'https://loja.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(allowed.status, 200); assert.equal(JSON.parse(allowed.text).allowed, true);
  app.store.mutate(admin, 'loja-demo', 'Webchat desligado', tenant => { tenant.channels.find(item => item.id === 'site-qa').webchat.enabled = false; });
  const disabled = await request(path, { method: 'POST', headers: { Origin: 'https://loja.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(disabled.status, 403); assert.equal(disabled.headers['access-control-allow-origin'], undefined);
  assert.equal(JSON.parse(disabled.text).code, undefined, 'a disabled channel does not say which sites it accepts');
});
