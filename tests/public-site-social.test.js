import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createPublicSite } from '../src/public-site.js';
import { PANEL_ASSETS } from '../src/panel-assets.js';

const origin = 'https://elozi.je4ndev.com';
const assets = [
  ['pt', '8ea1e507219921d545d5af9f023fc474968a2edfc4883fc34d1278fa557da35d'],
  ['en', '3c9ee9af07b48792fac51417acd8d3b187bfcefb268a1d8ebdef9827583333b7']
];
test('social cards are real registered PNGs,1200×630,under300KB and match inspected source assets', () => {
  for (const [locale, hash] of assets) {
    const name = `social-${locale}.png`, bytes = readFileSync(new URL(`../public/${name}`, import.meta.url));
    assert.ok(PANEL_ASSETS.includes(name));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1200, 630]);
    assert.ok(bytes.length < 300000);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  }
});
test('every localized page has the matching large social image and translated illustrative alt text', () => {
  for (const pricing of [undefined, null]) {
    const site = createPublicSite({ origin, pricing });
    for (const path of ['/', '/contato', '/termos', '/privacidade', '/en/', '/en/contact', '/en/terms', '/en/privacy', ...(pricing === null ? [] : ['/precos', '/en/pricing'])]) {
      const html = site(path, { signedIn: false, html: true }).body.toString();
      const en = path.startsWith('/en/'), image = `${origin}/social-${en ? 'en' : 'pt'}.png`;
      assert.ok(html.includes(`<meta property="og:image" content="${image}">`));
      assert.ok(html.includes(`<meta name="twitter:image" content="${image}">`));
      assert.match(html, /twitter:card" content="summary_large_image"/);
      assert.match(html, /og:image:width" content="1200"/); assert.match(html, /og:image:height" content="630"/);
      assert.match(html, /og:image:type" content="image\/png"/);
      assert.ok(html.includes(en ? 'Illustrative example.' : 'Exemplo ilustrativo.'));
      assert.match(html, /rel="preload" href="\/fonts\/manrope-latin-wght-normal\.woff2" as="font" type="font\/woff2" crossorigin/);
    }
  }
});
