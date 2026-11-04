import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPublicSite } from '../src/public-site.js';

const source = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8');
const execute = (hash, { standalone = false, matchMedia = true, pathname = '/' } = {}) => {
  const redirects = [];
  const window = matchMedia ? { matchMedia: () => ({ matches: standalone }) } : {};
  // Execution guard, not a latency SLA: cold shared-host VM setup exceeded 100ms once on 0.64.
  vm.runInNewContext(source, { location: { hash, pathname, replace: target => redirects.push(target) }, window }, { timeout: 1000 });
  return redirects;
};

test('public sales sections are safe entry points before the body exists', () => {
  for (const hash of ['', '#', '#como-funciona', '#planos', '#conteudo']) assert.deepEqual(execute(hash), [], hash);
});
test('application and unknown fragments retain exact sign-in handoff', () => {
  for (const hash of ['#inbox', '#inbox/conversation-123', '#settings', '#foo%20bar', '#%3Cscript%3E']) {
    assert.deepEqual(execute(hash), ['/login' + hash], hash);
  }
});
test('standalone PWA still opens sign-in even without an application fragment', () => {
  for (const hash of ['', '#como-funciona', '#inbox/conversation-123']) assert.deepEqual(execute(hash, { standalone: true }), ['/login' + hash]);
});
test('older clients without matchMedia keep public links and application handoff', () => {
  assert.deepEqual(execute('#como-funciona', { matchMedia: false }), []);
  assert.deepEqual(execute('#inbox', { matchMedia: false }), ['/login#inbox']);
});

test('every public navigation and information fragment is bound to a real page ID', () => {
  const route = createPublicSite({ origin: 'https://elozi.je4ndev.com' });
  for (const pathname of ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy']) {
    const html = route(pathname, { html: true }).body.toString();
    for (const [, hash] of html.matchAll(/href="(#[^"]+)"/g)) assert.deepEqual(execute(hash, { pathname }), [], pathname + hash);
    for (const [, target, id] of html.matchAll(/href="(\/[^"]*)#([^"]+)"/g)) {
      const destination = route(target, { html: true }).body.toString();
      assert.ok(destination.includes(`id="${id}"`), target + '#' + id);
      assert.deepEqual(execute('#' + id, { pathname: target }), [], target + '#' + id);
    }
    assert.deepEqual(execute('#inbox/abc', { pathname }), [pathname.startsWith('/en/') ? '/login?lang=en#inbox/abc' : '/login#inbox/abc']);
  }
  assert.deepEqual(execute('#seus-direitos'), ['/login#seus-direitos'], 'legal fragments do not become app-safe fragments on home');
});

test('public fragment allowlist contains only IDs present on its own SSR page', () => {
  const context = { location: { pathname: '/', hash: '', replace: () => assert.fail('redirect') }, window: {} };
  const entries = JSON.parse(vm.runInNewContext(source + '\nJSON.stringify(sections)', context, { timeout: 1000 }));
  const route = createPublicSite({ origin: 'https://elozi.je4ndev.com' });
  for (const [path, ids] of Object.entries(entries)) {
    const html = route(path, { html: true }).body.toString();
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), path + '#' + id);
  }
});

// Small DOM contract fixture, not browser/visual acceptance. Native details owns opening and tab order.
function menuFixture(readyState = 'loading') {
  const events = new Map();
  let focused = 0;
  const summary = { focus() { focused++; document.activeElement = summary; } };
  const link = { closest: selector => selector === 'a[href]' ? link : null };
  const outside = {};
  const menu = { open: true, querySelector: () => summary, contains: node => [summary, link].includes(node) };
  const document = { readyState, activeElement: link, querySelector: () => menu,
    addEventListener: (name, listener) => events.set(name, listener) };
  vm.runInNewContext(source, { location: { hash: '', pathname: '/' }, window: {}, document }, { timeout: 1000 });
  return { events, document, menu, summary, link, outside, focused: () => focused };
}

test('mobile disclosure waits for DOM readiness and Escape closes with appropriate focus restoration', () => {
  const f = menuFixture();
  assert.equal(f.events.has('keydown'), false);
  f.events.get('DOMContentLoaded')();
  let prevented = false;
  f.events.get('keydown')({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(f.menu.open, false);
  assert.equal(f.focused(), 1);
  assert.equal(prevented, true);
  f.events.get('keydown')({ key: 'Escape', preventDefault: () => assert.fail('closed menu must not consume Escape') });
  f.menu.open = true; f.document.activeElement = f.outside;
  f.events.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(f.focused(), 1, 'no stolen focus from outside');
});

test('mobile disclosure closes after a link, outside click or focus departure without trapping focus', () => {
  const f = menuFixture('complete');
  f.events.get('click')({ target: f.link });
  assert.equal(f.menu.open, false);
  assert.equal(f.focused(), 1, 'focused link must not remain inside a collapsed details');
  f.menu.open = true;
  f.events.get('click')({ target: f.outside });
  assert.equal(f.menu.open, false); assert.equal(f.focused(), 1);
  f.menu.open = true;
  f.events.get('focusin')({ target: f.outside });
  assert.equal(f.menu.open, false); assert.equal(f.focused(), 1);
});
