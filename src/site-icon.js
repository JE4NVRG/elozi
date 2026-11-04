// Logo of a webchat's site: the channel's first authorized https origin, found the way browsers do. The page's
// apple-touch-icon and PNG icons come first, then the web app manifest, then /apple-touch-icon.png and
// /favicon.ico.
// The server only reaches public https addresses on port 443: every DNS answer is checked and the connection
// uses the checked address (no rebinding), at most three https redirects, five seconds of silence and eight
// seconds per request, 256 KiB of page or manifest and 48 KiB of image. Only PNG, JPEG or WebP bytes are kept
// (avatarImage), never SVG; an ICO counts when it carries a PNG image. The result is a data URL the panel shows
// in an <img> (CSP img-src allows data:).
import { request } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { avatarImage } from './avatars.js';

export const SITE_ICON_MAX_BYTES = 48 * 1024;
const PAGE_MAX_BYTES = 256 * 1024, MANIFEST_MAX_BYTES = 64 * 1024, MAX_REDIRECTS = 3, IDLE_MS = 5000, HARD_MS = 8000, MAX_FETCHES = 6;
const IMAGE_ACCEPT = 'image/png,image/webp,image/jpeg,image/x-icon,image/vnd.microsoft.icon;q=0.9,image/*;q=0.5';

const ipv4 = address => {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
};
function publicIPv4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
function ipv6(address) {
  let value = String(address).toLowerCase().split('%')[0];
  const dotted = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = ipv4(dotted[1]); if (!octets) return null;
    value = `${value.slice(0, -dotted[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const parts = right === null ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map(part => parseInt(part, 16));
}
const embeddedIPv4 = (h, at) => [h[at] >> 8, h[at] & 255, h[at + 1] >> 8, h[at + 1] & 255];
/** True only for a global unicast address: private, loopback, link-local, documentation, multicast and tunnel ranges are refused. */
export function publicAddress(address) {
  const v4 = ipv4(String(address));
  if (v4) return publicIPv4(v4);
  const h = ipv6(address);
  if (!h) return false;
  const zeros = count => h.slice(0, count).every(part => part === 0);
  if (zeros(5) && h[5] === 0xffff) return publicIPv4(embeddedIPv4(h, 6));          // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(0) && h.slice(2, 6).every(part => part === 0)) return publicIPv4(embeddedIPv4(h, 6)); // NAT64
  if ((h[0] & 0xe000) !== 0x2000) return false;                                    // only 2000::/3 is global unicast
  if (h[0] === 0x2001 && (h[1] === 0x0db8 || h[1] === 0)) return false;           // documentation, Teredo
  if (h[0] === 0x2002) return false;                                               // 6to4
  return true;
}

/** dns.lookup that answers only when every address of the name is public; the request connects to the address it returns. */
export function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || !addresses.every(item => publicAddress(item.address))) return callback(Object.assign(new Error('Endereço do site não é público.'), { code: 'ESITENOTPUBLIC' }));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const httpsUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password ? url : null;
  } catch { return null; }
};

/** GET of one public https URL with the limits above; null on any refusal, error or non-200 answer. */
export function getBounded(target, { maxBytes, accept }, hops = 0) {
  const url = httpsUrl(target);
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; clearTimeout(hard); resolve(value); } };
    const req = request(url, { method: 'GET', lookup: publicLookup, timeout: IDLE_MS, headers: { 'User-Agent': 'EloziSiteIcon/1.0', Accept: accept, 'Accept-Encoding': 'identity' } }, res => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return done(null);
        let next; try { next = new URL(res.headers.location, url).href; } catch { return done(null); }
        return done(getBounded(next, { maxBytes, accept }, hops + 1));
      }
      if (status !== 200) { res.resume(); return done(null); }
      const declared = Number(res.headers['content-length'] || 0);
      if (!Number.isFinite(declared) || declared > maxBytes) { res.destroy(); return done(null); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(); done(null); } else chunks.push(chunk); });
      res.on('end', () => done({ url: url.href, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks) }));
      res.on('error', () => done(null));
    });
    const hard = setTimeout(() => { req.destroy(); done(null); }, HARD_MS);
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
    req.end();
  });
}

const attributesOf = tag => {
  const out = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return out;
};
const largest = sizes => Math.max(0, ...String(sizes || '').toLowerCase().split(/\s+/).map(size => Number(size.split('x')[0]) || 0));
const absolute = (href, base) => { try { const url = httpsUrl(new URL(href, base).href); return url ? url.href : null; } catch { return null; } };
const decodeEntities = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const score = size => size === 0 ? 1 : size >= 120 && size <= 256 ? 4 : size > 256 ? 3 : 2;

/** Icon URLs and the manifest named by the page's <link> tags, the best first (never SVG). */
export function linkIcons(html, base) {
  const icons = []; let manifest = null;
  for (const [tag] of String(html).slice(0, PAGE_MAX_BYTES).matchAll(/<link\b[^>]*>/gi)) {
    const a = attributesOf(tag), rel = String(a.rel || '').toLowerCase().split(/\s+/), href = a.href ? absolute(decodeEntities(a.href), base) : null;
    if (!href) continue;
    if (rel.includes('manifest')) { manifest ||= href; continue; }
    const apple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!apple && !rel.includes('icon')) continue;
    const type = String(a.type || '').toLowerCase(), path = new URL(href).pathname.toLowerCase();
    if (type.includes('svg') || path.endsWith('.svg')) continue;
    icons.push({ href, rank: (apple ? 10 : 0) + score(largest(a.sizes)) + (path.endsWith('.ico') ? -5 : 0) });
  }
  icons.sort((a, b) => b.rank - a.rank);
  return { icons: icons.map(icon => icon.href), manifest };
}

/** PNG icons of a web app manifest, closest to 192 px first. */
export function manifestIcons(text, base) {
  let data; try { data = JSON.parse(String(text)); } catch { return []; }
  const icons = Array.isArray(data?.icons) ? data.icons : [];
  return icons.filter(icon => icon && typeof icon.src === 'string' && !String(icon.purpose || '').includes('monochrome') && (String(icon.type || '').includes('png') || /\.png(\?|$)/i.test(icon.src)))
    .map(icon => ({ href: absolute(icon.src, base), size: largest(icon.sizes) }))
    .filter(icon => icon.href)
    .sort((a, b) => Math.abs((a.size || 192) - 192) - Math.abs((b.size || 192) - 192))
    .map(icon => icon.href);
}

/** The largest PNG image inside an ICO file, or null (BMP entries are not decoded). */
export function pngFromIco(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return null;
  const count = data.readUInt16LE(4); let best = null;
  for (let index = 0; index < count && 6 + (index + 1) * 16 <= data.length; index++) {
    const entry = 6 + index * 16, size = data.readUInt32LE(entry + 8), offset = data.readUInt32LE(entry + 12);
    if (!size || offset + size > data.length) continue;
    const image = avatarImage(data.subarray(offset, offset + size));
    if (image?.mime === 'image/png' && (!best || image.bytes.length > best.bytes.length)) best = image;
  }
  return best;
}

/** { src: data URL, from } for the site of an https origin, or null when it has no usable icon. */
export async function discoverSiteIcon(origin, { get = getBounded } = {}) {
  const site = httpsUrl(origin);
  if (!site) return null;
  let fetches = 0;
  const fetchOnce = (url, options) => fetches < MAX_FETCHES ? (fetches++, get(url, options)) : Promise.resolve(null);
  const page = await fetchOnce(`${site.origin}/`, { maxBytes: PAGE_MAX_BYTES, accept: 'text/html' });
  const base = page?.url || `${site.origin}/`;
  const found = page && /html/i.test(page.contentType) ? linkIcons(page.body.toString('utf8'), base) : { icons: [], manifest: null };
  const candidates = [...found.icons];
  if (found.manifest) {
    const manifest = await fetchOnce(found.manifest, { maxBytes: MANIFEST_MAX_BYTES, accept: 'application/manifest+json, application/json' });
    if (manifest) candidates.push(...manifestIcons(manifest.body.toString('utf8'), manifest.url));
  }
  candidates.push(`${site.origin}/apple-touch-icon.png`, `${site.origin}/favicon.ico`);
  for (const url of [...new Set(candidates)]) {
    if (fetches >= MAX_FETCHES) break;
    const answer = await fetchOnce(url, { maxBytes: SITE_ICON_MAX_BYTES, accept: IMAGE_ACCEPT });
    const image = answer && (avatarImage(answer.body) || pngFromIco(answer.body));
    if (image && image.bytes.length <= SITE_ICON_MAX_BYTES) return { src: `data:${image.mime};base64,${image.bytes.toString('base64')}`, from: url };
  }
  return null;
}
