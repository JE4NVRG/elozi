// SEO basics of Elozi's public pages (src/public-site.js): every PT/EN page is self-canonical with exact hreflang
// alternates, description, Open Graph/Twitter cards and the site icon set; robots.txt keeps crawlers out of the API,
// billing return and one-time e-mail links; sitemap.xml lists every page with alternates and <lastmod>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicSite, PUBLIC_SITE_LASTMOD, PUBLIC_SITE_DISALLOW } from '../src/public-site.js';
import { localeAlternates } from '../src/public-site-locales.js';
import { PANEL_ASSETS, PANEL_PAGES } from '../src/panel-assets.js';

const origin = 'https://elozi.je4ndev.com';
const PAGES = ['/', '/precos', '/contato', '/termos', '/privacidade', '/en/', '/en/pricing', '/en/contact', '/en/terms', '/en/privacy'];
const page = (site, path) => { const result = site(path, { html: true }); assert.equal(result?.status, 200, path); return result.body.toString('utf8'); };
const meta = (html, attribute, name) => new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`).exec(html)?.[1];
const head = html => html.slice(0, html.indexOf('</head>'));

test('each public page: canonical to itself, three hreflang alternates, description, robots, OG/Twitter and icons', () => {
  const site = createPublicSite({ origin });
  for (const path of PAGES) {
    const html = head(page(site, path)), en = path.startsWith('/en/');
    assert.match(html, new RegExp(`<html lang="${en ? 'en' : 'pt-BR'}">`), path);
    assert.deepEqual([...html.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(m => m[1]), [origin + path], path);
    const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(alternates, localeAlternates(path).map(([lang, target]) => [lang, origin + target]), path);
    assert.ok(alternates.some(([, href]) => href === origin + path), `${path} is one of its own alternates`);
    assert.ok((meta(html, 'name', 'description') || '').length >= 50, path);
    assert.equal(meta(html, 'name', 'robots'), 'index,follow', path);
    assert.ok((/<title>([^<]+)<\/title>/.exec(html)?.[1] || '').includes('Elozi'), path);
    assert.equal(meta(html, 'property', 'og:url'), origin + path, path);
    assert.equal(meta(html, 'property', 'og:locale'), en ? 'en_US' : 'pt_BR', path);
    assert.equal(meta(html, 'property', 'og:title'), /<title>([^<]+)<\/title>/.exec(html)[1], path);
    assert.equal(meta(html, 'property', 'og:description'), meta(html, 'name', 'description'), path);
    assert.equal(meta(html, 'property', 'og:image'), `${origin}/social-${en ? 'en' : 'pt'}.png`, path);
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image', path);
    assert.match(html, /<link rel="icon" href="\/mark\.svg" type="image\/svg\+xml">/, path);
    assert.match(html, /<link rel="icon" href="\/icon-192\.png" type="image\/png" sizes="192x192">/, path);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/, path);
  }
});

test('icon, social and favicon targets are served assets whose PNG sizes match the declared sizes', async () => {
  const png = async file => { const bytes = await readFile(new URL(`../public/${file}`, import.meta.url)); assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', file); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; };
  for (const file of ['mark.svg', 'icon-192.png', 'apple-touch-icon.png', 'social-pt.png', 'social-en.png']) assert.ok(PANEL_ASSETS.includes(file), file);
  assert.deepEqual(await png('icon-192.png'), [192, 192]);
  assert.deepEqual(await png('apple-touch-icon.png'), [180, 180]);
  for (const file of ['social-pt.png', 'social-en.png']) assert.deepEqual(await png(file), [1200, 630], file);
  assert.deepEqual(createPublicSite({ origin })('/favicon.ico'), { status: 301, location: '/icon-192.png' });
});

test('robots.txt allows the public site, disallows API/billing/token links, keeps /login crawlable and points to the sitemap', () => {
  const robots = page(createPublicSite({ origin }), '/robots.txt');
  const lines = robots.trim().split('\n');
  assert.equal(lines[0], 'User-agent: *'); assert.ok(lines.includes('Allow: /'));
  assert.deepEqual(lines.filter(line => line.startsWith('Disallow: ')).map(line => line.slice(10)), [...PUBLIC_SITE_DISALLOW]);
  assert.equal(lines.at(-1), `Sitemap: ${origin}/sitemap.xml`);
  for (const path of PAGES) assert.ok(!PUBLIC_SITE_DISALLOW.some(prefix => path.startsWith(prefix)), path);
  assert.ok(!PUBLIC_SITE_DISALLOW.some(prefix => '/login'.startsWith(prefix)), '/login carries noindex and must stay crawlable');
  for (const route of ['/verify-email', '/accept-invite', '/reset-password']) assert.ok(Object.hasOwn(PANEL_PAGES, route) && PUBLIC_SITE_DISALLOW.includes(route), route);
});

test('sitemap.xml: every public page once, with <lastmod> and pt-BR/en/x-default alternates', () => {
  for (const pricing of [undefined, null]) {
    const xml = page(createPublicSite({ origin, pricing }), '/sitemap.xml');
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml">/);
    assert.ok(xml.trimEnd().endsWith('</urlset>'));
    const entries = [...xml.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>((?:<xhtml:link [^>]+\/>)+)<\/url>/g)];
    const expected = PAGES.filter(path => pricing !== null || !/precos|pricing/.test(path));
    assert.deepEqual(entries.map(m => m[1]).sort(), expected.map(path => origin + path).sort());
    assert.equal((xml.match(/<url>/g) || []).length, entries.length, 'every <url> follows loc, lastmod, alternates');
    for (const [, loc, lastmod, links] of entries) {
      assert.equal(lastmod, PUBLIC_SITE_LASTMOD);
      const found = [...links.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map(m => [m[1], m[2]]);
      assert.deepEqual(found, localeAlternates(loc.slice(origin.length)).map(([lang, target]) => [lang, origin + target]), loc);
    }
  }
  assert.equal(PUBLIC_SITE_LASTMOD, '2026-11-03');
  assert.match(page(createPublicSite({ origin, lastmod: '2027-01-15' }), '/sitemap.xml'), /<lastmod>2027-01-15<\/lastmod>/);
  for (const lastmod of ['2026-13-01', '03/11/2026', '2026-02-30', '']) assert.throws(() => createPublicSite({ origin, lastmod }), /lastmod/, lastmod);
});

test('login page is noindex (served for /login, /verify-email, /accept-invite, /reset-password)', async () => {
  const html = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');
  assert.match(head(html), /<meta name="robots" content="noindex">/);
});
