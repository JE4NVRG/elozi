// Public-site HTTP negotiation only. Explicit JSON callers and private/app policies stay separate.
export function publicSiteHtmlHint(pathname, accept = '') {
  const entries = String(accept ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const [type, ...parameters] = value.toLowerCase().split(';').map(part => part.trim());
    const quality = parameters.find(part => /^q\s*=/.test(part));
    const number = quality === undefined ? 1 : Number(quality.slice(quality.indexOf('=') + 1).trim());
    return { type, quality: Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0 };
  });
  const html = entries.filter(entry => entry.type === 'text/html');
  if (html.length) return html.some(entry => entry.quality > 0);
  return pathname === '/' && (!entries.length || entries.length === 1 && entries[0].type === '*/*' && entries[0].quality > 0);
}

export function publicRootVary(current) {
  const values = (Array.isArray(current) ? current : [current ?? '']).flatMap(value => String(value).split(',')).map(value => value.trim()).filter(Boolean);
  if (values.includes('*')) return '*';
  const seen = new Set(values.map(value => value.toLowerCase()));
  for (const value of ['Accept', 'Cookie']) if (!seen.has(value.toLowerCase())) { values.push(value); seen.add(value.toLowerCase()); }
  return values.join(', ');
}

// Existing Cloudflare automatic injection uses the same-origin /cdn-cgi/rum endpoint (already 'self').
// Permit only the documented file and its observed versioned path, never the whole host or inline code.
export const PUBLIC_BEACON_SCRIPTS = Object.freeze([
  'https://static.cloudflareinsights.com/beacon.min.js',
  'https://static.cloudflareinsights.com/beacon.min.js/'
]);
export function publicSiteCsp(base) {
  return String(base).replace(/(^|;)(\s*)script-src\s+([^;]*)/, (_, prefix, space, sources) => {
    const tokens = sources.trim().split(/\s+/);
    for (const source of PUBLIC_BEACON_SCRIPTS) if (!tokens.includes(source)) tokens.push(source);
    return `${prefix}${space}script-src ${tokens.join(' ')}`;
  });
}
