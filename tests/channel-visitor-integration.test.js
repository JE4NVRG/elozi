import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelsUI } from '../public/channels-ui.js';
import { parseHash, formatHash } from '../public/router.js';
import { setLocale } from '../public/i18n.js';

const webchat = (more = {}) => ({ id: 'site-1', kind: 'webchat', transport: 'elozi-webchat', name: 'Site autorizado', state: 'connected', webchat: { enabled: true, origins: ['https://example.test'] }, ...more });
const route = (params = {}, workspaceId = 'workspace-a') => ({ section: 'channels', params, query: {}, workspaceId, alias: null });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture({ channel = webchat(), session = {}, durable = true, visitor = true } = {}) {
  const calls = [], delegated = [], state = { workspaceId: 'workspace-a', boot: { session: { role: 'reseller', userId: 'human-a', ...session } }, tenant: { id: 'tenant-a', name: 'Empresa', channels: [channel], conversations: [] } };
  const visitorTestUI = visitor ? {
    view(value) { delegated.push(['view', value]); return '<main data-visitor-sentinel>Visitante privado</main>'; },
    mount(main, value) { delegated.push(['mount', main, value]); return 'mounted-by-visitor'; },
    async act(name, id) { delegated.push(['act', name, id]); return name !== 'channels:visitor-unknown'; },
    reset() { delegated.push(['reset']); }
  } : undefined;
  const ui = createChannelsUI({ state, durableOnboarding: durable, visitorTestUI, api: async (path, options = {}) => { calls.push({ path, options }); return {}; } });
  return { ui, state, calls, delegated, visitorTestUI };
}
let previousDocument;
test.beforeEach(() => { previousDocument = globalThis.document; globalThis.document = { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [], getElementById: () => null }; });
test.afterEach(() => { if (previousDocument) globalThis.document = previousDocument; else delete globalThis.document; setLocale('pt-BR', { persist: false, notify: false }); });

test('private visitor route delegates view/mount/actions/reset without running channel API, icons or batch hydration', async () => {
  const f = fixture(), current = route({ channelId: 'site-1', tab: 'visitor' });
  const main = { querySelector() { throw new Error('Normal channel DOM must not be inspected'); } };
  assert.equal(f.ui.view(current), '<main data-visitor-sentinel>Visitante privado</main>'); assert.equal(f.ui.flow, null);
  assert.equal(f.ui.mount(main, current), 'mounted-by-visitor');
  assert.equal(await f.ui.act('channels:visitor-start', 'site-1'), true); assert.equal(await f.ui.act('channels:visitor-unknown', 'site-1'), false);
  await flush(); assert.deepEqual(f.calls, []); assert.deepEqual(f.delegated, [['view', current], ['mount', main, current], ['act', 'channels:visitor-start', 'site-1'], ['act', 'channels:visitor-unknown', 'site-1']]);
  f.ui.reset(); assert.deepEqual(f.delegated.at(-1), ['reset']); assert.deepEqual(f.calls, []);
});

test('entering visitor closes a normal drawer, leaving visitor resets it and returns the normal channel screen', async () => {
  const f = fixture(); f.ui.view(route({ channelId: 'site-1', tab: 'connect' })); assert.equal(f.ui.flow.channelId, 'site-1');
  const resetsBefore = f.delegated.filter(call => call[0] === 'reset').length;
  const current = route({ channelId: 'site-1', tab: 'visitor' }); assert.match(f.ui.view(current), /data-visitor-sentinel/); assert.equal(f.ui.flow, null);
  assert.equal(f.delegated.filter(call => call[0] === 'reset').length, resetsBefore);
  const html = f.ui.view(route()); assert.match(html, /<h1 class="pg-channels__title">Canais<\/h1>/); assert.doesNotMatch(html, /data-visitor-sentinel/);
  assert.equal(f.delegated.filter(call => call[0] === 'reset').length, resetsBefore + 1); assert.deepEqual(f.calls, []); f.ui.reset();
});

test('normal channel actions do not pass through the visitor namespace', async () => {
  const f = fixture(); assert.equal(await f.ui.act('channels:unrelated', 'site-1'), false); assert.deepEqual(f.delegated, []); assert.deepEqual(f.calls, []); f.ui.reset();
});

test('durable webchat visitor link preserves the workspace and opens a separate tab with noopener in PT/EN', () => {
  const f = fixture(), current = route({ channelId: 'site-1', tab: 'test' });
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false }); const html = f.ui.view(current), link = /<a\b[^>]*href="#channels\/site-1\/visitor\?w=workspace-a"[^>]*>[\s\S]*?<\/a>/.exec(html)?.[0];
    assert.ok(link, locale); assert.match(link, /target="_blank"/); assert.match(link, /rel="[^"\n]*\bnoopener\b[^"\n]*"/);
    assert.match(link, locale === 'en' ? /Open test visitor chat/ : /Abrir chat visitante de teste/); assert.doesNotMatch(link, /tenant-a|token|secret|conversation/);
  }
  assert.deepEqual(f.calls, []); f.ui.reset();
});

test('visitor link is absent for operator, service, support, WhatsApp, legacy mode or missing visitor controller', () => {
  for (const options of [{ session: { role: 'operator' } }, { session: { kind: 'service' } }, { session: { supportGrantId: 'support-a' } },
    { channel: { id: 'site-1', name: 'WhatsApp', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' } }, { durable: false }, { visitor: false }]) {
    const f = fixture(options); assert.doesNotMatch(f.ui.view(route({ channelId: 'site-1', tab: 'test' })), /href="#channels\/site-1\/visitor/); assert.deepEqual(f.calls, []); f.ui.reset();
  }
});

test('router round-trips the private visitor route and encoded workspace without carrying extra query authority', () => {
  const expected = route({ channelId: 'site@product.test', tab: 'visitor' }, 'workspace@company.test');
  const hash = '#channels/site%40product.test/visitor?w=workspace%40company.test'; assert.equal(formatHash(expected), hash); assert.deepEqual(parseHash(hash), expected);
  assert.deepEqual(parseHash(hash + '&token=private&tenant=foreign&admin=1'), expected);
  for (const value of ['#channels/site-1/visitor/extra?w=workspace-a', '#channels/site-1/visitor/../test', '#channels/site%2Fother/visitor', '#channels/visitor/extra']) assert.equal(parseHash(value), null);
});

test('router formatting rejects extra params/query shapes and malformed visitor identities', () => {
  for (const value of [route({ channelId: 'site-1', tab: 'visitor', kind: 'webchat' }), route({ channelId: 'site-1', tab: 'visitor', tenantId: 'tenant-a' }),
    route({ tab: 'visitor' }), route({ channelId: 'site/other', tab: 'visitor' }), route({ channelId: 'site-1', tab: 'visitor' }, 'bad workspace'),
    { ...route({ channelId: 'site-1', tab: 'visitor' }), query: { token: 'private' } }]) assert.throws(() => formatHash(value), TypeError);
});
