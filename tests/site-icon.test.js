import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAddress, publicLookup, getBounded, linkIcons, manifestIcons, pngFromIco, discoverSiteIcon, SITE_ICON_MAX_BYTES } from '../src/site-icon.js';

// 1×1 PNG with its IEND trailer (avatarImage accepts it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ico = image => {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16); entry[0] = 1; entry[1] = 1; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(image.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
};
const page = html => ({ url: 'https://site.example/', contentType: 'text/html; charset=utf-8', body: Buffer.from(html) });

test('only global unicast addresses are public: private, loopback, link-local, CGNAT, documentation and tunnel ranges are refused', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '200.147.67.142', '2606:4700:4700::1111', '2a03:2880:f12f:83:face:b00c:0:25de']) assert.equal(publicAddress(address), true, address);
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2001::1', '2002:c000:204::1', 'not-an-ip', '1.2.3']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('::ffff:8.8.8.8'), true, 'IPv4 público mapeado em IPv6');
});

test('localhost never resolves for a site logo, and only https on port 443 without credentials is requested', async () => {
  const error = await new Promise(resolve => publicLookup('localhost', {}, resolve));
  assert.equal(error?.code, 'ESITENOTPUBLIC');
  for (const url of ['http://site.example/', 'https://site.example:8443/', 'https://user:pass@site.example/', 'ftp://site.example/', 'not a url']) assert.equal(await getBounded(url, { maxBytes: 10, accept: '*/*' }), null, url);
});

test('page links: apple-touch-icon and PNG icons first, never SVG; relative and http links resolved or dropped; the manifest is kept', () => {
  const found = linkIcons(`<head>
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-180.png">
    <link rel="icon" href="http://cdn.example/insecure.png">
    <link rel="manifest" href="/site.webmanifest">
    <link rel="stylesheet" href="/app.css">
  </head>`, 'https://site.example/pt/');
  assert.deepEqual(found.icons, ['https://site.example/apple-180.png', 'https://site.example/icon-32.png', 'https://site.example/favicon.ico']);
  assert.equal(found.manifest, 'https://site.example/site.webmanifest');
});

test('manifest icons: PNG closest to 192 px first, monochrome and SVG ignored', () => {
  const icons = manifestIcons(JSON.stringify({ icons: [
    { src: '/icons/512.png', sizes: '512x512', type: 'image/png' }, { src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/mono.png', sizes: '192x192', type: 'image/png', purpose: 'monochrome' }, { src: '/icons/logo.svg', sizes: 'any', type: 'image/svg+xml' },
  ] }), 'https://site.example/site.webmanifest');
  assert.deepEqual(icons, ['https://site.example/icons/192.png', 'https://site.example/icons/512.png']);
  assert.deepEqual(manifestIcons('not json', 'https://site.example/'), []);
});

test('ICO: the PNG inside is used; BMP entries and broken files are not', () => {
  assert.equal(pngFromIco(ico(PNG))?.mime, 'image/png');
  assert.equal(pngFromIco(ico(Buffer.alloc(40, 1))), null, 'entrada BMP não é decodificada');
  assert.equal(pngFromIco(Buffer.from('nope')), null);
});

test('discovery: the best icon of the page becomes a data URL; misses fall back to /apple-touch-icon.png and /favicon.ico, at most six requests', async () => {
  const calls = [];
  const fake = answers => async url => { calls.push(url); return answers[url] || null; };
  const found = await discoverSiteIcon('https://site.example', { get: fake({ 'https://site.example/': page('<link rel="apple-touch-icon" href="/apple.png">'), 'https://site.example/apple.png': { url: 'https://site.example/apple.png', contentType: 'image/png', body: PNG } }) });
  assert.equal(found.src, `data:image/png;base64,${PNG.toString('base64')}`); assert.equal(found.from, 'https://site.example/apple.png');
  calls.length = 0;
  const fallback = await discoverSiteIcon('https://site.example', { get: fake({ 'https://site.example/favicon.ico': { url: 'https://site.example/favicon.ico', contentType: 'image/x-icon', body: ico(PNG) } }) });
  assert.equal(fallback.from, 'https://site.example/favicon.ico'); assert.deepEqual(calls, ['https://site.example/', 'https://site.example/apple-touch-icon.png', 'https://site.example/favicon.ico']);
  calls.length = 0;
  const many = Array.from({ length: 10 }, (_, index) => `<link rel="icon" type="image/png" href="/i${index}.png">`).join('');
  assert.equal(await discoverSiteIcon('https://site.example', { get: fake({ 'https://site.example/': page(many) }) }), null);
  assert.equal(calls.length, 6, 'no máximo seis pedidos por site');
  calls.length = 0;
  const svg = { url: 'https://site.example/apple.png', contentType: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') };
  assert.equal(await discoverSiteIcon('https://site.example', { get: fake({ 'https://site.example/': page('<link rel="apple-touch-icon" href="/apple.png">'), 'https://site.example/apple.png': svg }) }), null, 'SVG nunca vira ícone');
  const big = { url: 'https://site.example/favicon.ico', contentType: 'image/png', body: Buffer.concat([PNG.subarray(0, 33), Buffer.alloc(SITE_ICON_MAX_BYTES), PNG.subarray(33)]) };
  assert.equal(await discoverSiteIcon('https://site.example', { get: fake({ 'https://site.example/favicon.ico': big }) }), null, 'acima do limite não é guardado');
  calls.length = 0;
  assert.equal(await discoverSiteIcon('http://localhost:3000', { get: fake({}) }), null); assert.equal(calls.length, 0, 'origem sem https não é consultada');
});
