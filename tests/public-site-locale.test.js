import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPublicSite, PUBLIC_SITE_PRICING } from '../src/public-site.js';
import { publicPath, localeAlternates, publicTranslator } from '../src/public-site-locales.js';

const origin = 'https://elozi.je4ndev.com';
const pairs = [['/', '/en/'], ['/precos', '/en/pricing'], ['/contato', '/en/contact'], ['/termos', '/en/terms'], ['/privacidade', '/en/privacy']];
const page = (site, path) => site(path, { html: true }).body.toString();
const ids = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

test('all ten URL-stable pages expose reciprocal SEO and accessible same-page selectors', () => {
  const site = createPublicSite({ origin });
  for (const [pt, en] of pairs) {
    const ptHTML = page(site, pt), enHTML = page(site, en);
    assert.deepEqual(ids(enHTML), ids(ptHTML), en + ': same public fragment IDs');
    for (const [path, locale, og] of [[pt, 'pt-BR', 'pt_BR'], [en, 'en', 'en_US']]) {
      const html = page(site, path);
      assert.ok(html.includes(`<html lang="${locale}">`));
      assert.ok(html.includes(`<meta property="og:locale" content="${og}">`));
      assert.ok(html.includes(`<link rel="canonical" href="${origin}${path}">`));
      for (const [lang, target] of localeAlternates(path)) assert.ok(html.includes(`<link rel="alternate" hreflang="${lang}" href="${origin}${target}">`));
      for (const area of [html.match(/<header[\s\S]*?<\/header>/)[0], html.match(/<footer[\s\S]*?<\/footer>/)[0]]) {
        assert.ok(area.includes(`href="${pt}" lang="pt-BR" hreflang="pt-BR" data-site-locale="pt-BR"`));
        assert.ok(area.includes(`href="${en}" lang="en" hreflang="en" data-site-locale="en"`));
        assert.ok(area.includes(`data-site-locale="${locale}" aria-current="page"`));
      }
      assert.equal((html.match(/<h1\b/g) || []).length, 1);
      assert.equal(new Set(ids(html)).size, ids(html).length);
    }
    assert.match(enHTML, /href="\/login\?lang=en"/);
    assert.match(enHTML, /href="\/login\?cadastro=1&lang=en"/);
    assert.match(enHTML, /Created by <a href="https:\/\/je4ndev.com\/">Je4nDev/);
    for (const [anchor] of enHTML.matchAll(/<a\b[^>]*href="\/(?:contato|termos|privacidade|precos)(?:["#])[^>]*>/g)) assert.match(anchor, /data-site-locale="pt-BR"/, 'only the explicit PT selector may link to the Portuguese counterpart');
    assert.equal(/>[^<]*(?:Sua equipe|Atendimento compartilhado|Criar conta|Privacidade|Pular para|Em todos os planos|não é|mês|Valores mensais em reais)/.exec(enHTML.replace(/<style>[\s\S]*?<\/style>/g, ''))?.[0], undefined, en + ': untranslated visible text');
  }
});

test('review quick wins use clear pricing/FAQ headings and real localized sales contact without promises', () => {
  const site = createPublicSite({ origin });
  for (const [path, title, faq, label, target] of [
    ['/precos', 'Planos e preços da Elozi', 'Perguntas frequentes', 'Falar com o comercial', '/contato'],
    ['/en/pricing', 'Elozi plans and pricing', 'Frequently asked questions', 'Talk to sales', '/en/contact']
  ]) {
    const html = page(site, path);
    assert.ok(html.includes(`<h1 id="pricing-title">${title}</h1>`));
    assert.ok(html.includes(`id="faq-title">${faq}</h2>`));
    assert.ok(html.includes(`href="${target}">${label}</a>`));
    assert.doesNotMatch(html, /wa\.me|1 business day|1 dia útil|Sem dúvida no próximo passo/);
  }
});

test('English entry is public with or without cookie and /en is canonicalized; PT root fallthrough is unchanged', () => {
  const site = createPublicSite({ origin });
  assert.deepEqual(site('/en'), { status: 301, location: '/en/' });
  for (const options of [{}, { html: true }, { signedIn: true, html: true }, { signedIn: true }]) assert.equal(site('/en/', options).status, 200);
  assert.equal(site('/', { signedIn: true, html: true }), null);
  assert.equal(site('/'), null);
  assert.deepEqual(site('/pricing'), { status: 301, location: '/precos' });
});

test('sitemap carries ten or eight canonical entries and three exact alternates per entry', () => {
  for (const pricing of [undefined, null]) {
    const site = createPublicSite({ origin, pricing });
    const xml = page(site, '/sitemap.xml');
    assert.match(xml, /xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml"/);
    const entries = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)];
    const paths = pairs.filter(([pt]) => pricing !== null || pt !== '/precos').flat();
    assert.deepEqual(entries.map(match => match[1]).sort(), paths.map(path => origin + path).sort());
    for (const [, url, links] of entries) {
      const path = url.slice(origin.length);
      assert.equal((links.match(/<xhtml:link /g) || []).length, 3);
      for (const [lang, target] of localeAlternates(path)) assert.ok(links.includes(`hreflang="${lang}" href="${origin}${target}"`));
    }
    if (pricing === null) {
      assert.equal(site('/en/pricing'), null);
      for (const path of ['/en/', '/en/contact', '/en/terms', '/en/privacy']) assert.doesNotMatch(page(site, path), /R\$|\/en\/pricing|\/precos/);
    }
  }
});

test('English commercial pages retain authentic marks, BRL amounts, quotas, disclosures and fictional illustration', () => {
  const site = createPublicSite({ origin });
  for (const [pt, en] of pairs.slice(0, 2)) {
    const html = page(site, en), original = page(site, pt);
    const icons = value => [...value.matchAll(/<span class="brand-mark [^"]+">([\s\S]*?)<\/span>/g)].map(match => match[1]);
    assert.equal(icons(html).length, 8);
    assert.deepEqual(icons(html), icons(original));
    for (const price of [49, 99, 199, 29]) assert.ok(html.includes(`R$ ${price}<small>`));
    assert.match(html, /Brazilian reais/);
    for (const limit of ['1 WhatsApp number', '2 WhatsApp numbers', '5 WhatsApp numbers', 'Up to 2 users', 'Up to 5 users', 'Up to 15 users']) assert.ok(html.includes(limit));
    for (const disclosure of ['BYOK', 'explicit permission', 'Meta configuration', 'custom API/webhook integration', 'separate proposal']) assert.ok(html.includes(disclosure), disclosure);
    assert.doesNotMatch(html, /USD|US\$/);
  }
  assert.match(page(site, '/en/'), /Fictional data · not a product screenshot/);
  assert.equal(PUBLIC_SITE_PRICING.plans[0].name, 'Conecta');
});

test('English signup/trial/hidden pricing combinations use translated configured conditions', () => {
  for (const registration of [true, false]) for (const trial of [true, false]) for (const pricing of [undefined, null]) {
    const site = createPublicSite({ origin, registration, trial, pricing });
    for (const path of ['/en/', ...(pricing === null ? [] : ['/en/pricing']), '/en/contact', '/en/terms', '/en/privacy']) {
      const html = page(site, path);
      assert.match(html, /href="\/login\?lang=en"/);
      if (!registration) assert.doesNotMatch(html, /cadastro=1|7 full days|CPF or CNPJ\.<\/p>/);
      else if (trial) {
        assert.match(html, /Create an account and try it for 7 days/);
        assert.match(html, /7 full days/);
        assert.match(html, /registration requires a CPF or CNPJ/);
      } else {
        assert.match(html, /Create my account/);
        assert.doesNotMatch(html, /7 full days|No card is required/);
      }
    }
  }
});

test('explicit override is immutable business data, not a source-language translation key', () => {
  const pricing = { plans: [{ name: 'Equipe', price: 71, audience: 'Oferta aprovada específica.', limits: ['Até 5 usuários'] }], extraWhatsapp: null, included: ['Recurso autorizado'] };
  const before = JSON.stringify(pricing);
  const html = page(createPublicSite({ origin, pricing }), '/en/pricing');
  for (const value of ['>Equipe<', 'Oferta aprovada específica.', 'Até 5 usuários', 'Recurso autorizado', 'R$ 71<small>/month']) assert.ok(html.includes(value), value);
  assert.equal(JSON.stringify(pricing), before);
});

test('translator identifies missing exact keys and invalid placeholder contracts instead of leaking Portuguese', () => {
  assert.throws(() => publicTranslator('en', {})('Texto ausente'), /Missing English public-site key: "Texto ausente"/);
  assert.throws(() => publicTranslator('en', { 'Plano {price}': 'Plan {count}' })('Plano {price}', { price: 49 }), /placeholder mismatch/);
  assert.throws(() => publicTranslator('en', { 'Plano {price}': 'Plan {price}' })('Plano {price}'), /Missing public-site placeholder: price/);
  assert.equal(publicTranslator('en', { 'Plano {price}': 'Plan {price}' })('Plano {price}', { price: 'R$ 49' }), 'Plan R$ 49');
  assert.equal(publicPath('/privacidade#seus-direitos', 'en'), '/en/privacy#seus-direitos');
  assert.throws(() => publicPath('/app', 'en'), /Unknown public-site path/);
});

const source = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8');
function selectorFixture({ hash = '#seus-direitos', currentID = true, storageDenied = false } = {}) {
  const writes = [], events = {}, attrs = { href: '/en/privacy', 'data-site-locale': 'en' };
  const anchor = { getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; }, addEventListener: (name, fn) => { events[name] = fn; } };
  const location = { pathname: '/privacidade', hash, replace() { assert.fail('public fragment should remain public'); } };
  const document = { readyState: 'complete', querySelector: () => null, querySelectorAll: () => [anchor], getElementById: () => currentID };
  const window = { localStorage: { setItem: (...args) => { if (storageDenied) throw Error('denied'); writes.push(args); } } };
  vm.runInNewContext(source, { location, document, window }, { timeout: 1000 });
  return { attrs, events, writes };
}
test('language selector preserves only shared real fragments and persists only explicit clicks; denied storage is harmless', () => {
  const f = selectorFixture();
  assert.equal(f.attrs.href, '/en/privacy#seus-direitos');
  assert.deepEqual(f.writes, []);
  f.events.click();
  assert.deepEqual(f.writes, [['elozi:locale', 'en']]);
  const absent = selectorFixture({ currentID: false });
  assert.equal(absent.attrs.href, '/en/privacy');
  const denied = selectorFixture({ storageDenied: true });
  assert.doesNotThrow(() => denied.events.click());
  assert.equal(denied.attrs.href, '/en/privacy#seus-direitos');
});

test('English public hash and installed PWA retain locale through sign-in', () => {
  for (const [hash, standalone, expected] of [['#faq', false, []], ['#inbox/abc', false, ['/login?lang=en#inbox/abc']], ['', true, ['/login?lang=en']], ['#faq', true, ['/login?lang=en#faq']]]) {
    const actual = [];
    vm.runInNewContext(source, { location: { pathname: '/en/', hash, replace: target => actual.push(target) }, window: { matchMedia: () => ({ matches: standalone }) } }, { timeout: 1000 });
    assert.deepEqual(actual, expected);
  }
});
