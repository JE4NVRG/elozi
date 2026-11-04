import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VERIFIED_ASSET_PATHS } from '../src/panel-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = process.env.MEPCHAT_VERIFY_ORIGIN || 'http://127.0.0.1:4318';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function mergeVerificationReceipt(previous, verification) {
  if (previous === null) return { ...verification, state: verification.origin.startsWith('https:') ? 'PRODUCTION-PILOT' : 'PREVIEW', journeys: [] };
  if (typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Recibo anterior inválido; referências preservadas.');
  const journeys = previous.journeys || (previous.whatsappTextJourney ? [{ transport: 'whatsapp_qr', ...previous.whatsappTextJourney }] : []);
  // HTTP/source checks do not publish or revalidate the recorded runtime release.
  // Keep its evidence and retention references; replace only the latest HTTP proof.
  return { ...previous, journeys, latestVerification: { ...verification,
    matchesRecordedSource: previous.sourceSHA256 === verification.sourceSHA256,
    matchesRecordedOrigin: previous.origin === verification.origin } };
}

// Validate the actual entrypoint and its relative application import under the same immutable asset version.
// request is injected in unit tests; the production verifier uses its normal fetch implementation.
export async function validateVersionedPanel({ origin, assetVersion, served, request = globalThis.fetch }) {
  const pageResponse = await request(origin + '/', { headers: { Accept: 'application/json' } });
  if (!pageResponse.ok) throw new Error(`Página do painel: HTTP ${pageResponse.status}`);
  const page = await pageResponse.text();
  const entryPath = `/v/${assetVersion}/app-entry.js`, applicationPath = `/v/${assetVersion}/app.js`;
  if (!page.includes(`src="${entryPath}"`)) throw new Error(`Página sem a versão ${assetVersion} do ponto de entrada.`);
  const expected = new Map(served.map(file => [file.path, file.sha256]));
  let entrySource;
  for (const file of ['app-entry.js', 'app.js']) {
    const pinned = await request(`${origin}/v/${assetVersion}/${file}`);
    if (!pinned.ok || !/\bimmutable\b/i.test(pinned.headers.get('cache-control') || '')) throw new Error(`Arquivo versionado indisponível ou sem cache imutável: ${file}`);
    const bytes = Buffer.from(await pinned.arrayBuffer());
    if (!expected.has('/' + file) || hash(bytes) !== expected.get('/' + file)) throw new Error(`Arquivo versionado diferente da fonte: ${file}`);
    if (file === 'app-entry.js') entrySource = bytes.toString('utf8');
  }
  if (!/\bimport\s*\(\s*(['"])\.\/app\.js\1\s*\)/.test(entrySource) || new URL('./app.js', origin + entryPath).href !== origin + applicationPath) throw new Error('O ponto de entrada não importa a aplicação pela mesma versão relativa.');
  return { assetVersion, entryPath, applicationPath };
}

export async function verificationManifest() {
const files = ['package.json', 'package-lock.json','Dockerfile','.dockerignore','public/mark.svg', 'public/bot-avatar.jpg', 'public/fonts/manrope-latin-wght-normal.woff2', 'public/fonts/LICENSE',
  // Web app manifest and its icons (P10); /brand.css is generated per host and has no fixed bytes to compare.
  'public/manifest.webmanifest', 'public/icon-192.png', 'public/icon-512.png', 'public/icon-maskable-512.png', 'public/apple-touch-icon.png'];
for(const directory of ['src','scripts','db','public']) for(const file of await readdir(resolve(root,directory))) if(/\.(?:js|mjs|ps1|sql|html|css)$/.test(file)) files.push(`${directory}/${file}`);
// Include binary assets from the same server allowlist, including localized social cards.
files.push(...VERIFIED_ASSET_PATHS.map(path => 'public' + path));
const paths = [...new Set(files)].sort();
const manifest = [];
for (const path of paths) manifest.push({ path, sha256: hash(await readFile(resolve(root, path))) });
return manifest;
}

async function verify() {
const args = process.argv.slice(2);
let identity = {};
if (args.length) {
  if (args.length !== 2 || !args.every(arg => /^[a-f0-9]{40}$/.test(arg))) throw new Error('Expected exact operator/runtime revisions.');
  identity = { operatorSource: args[0], runtimeSource: args[1] };
}
const manifest = await verificationManifest();
const expected = new Map(manifest.map(file => [file.path, file.sha256]));
const served = [];
// Same single allowlist that src/server.js serves (src/panel-assets.js); HTML pages are no-store.
for (const path of VERIFIED_ASSET_PATHS) {
  const response = await fetch(origin + path);
  if (!response.ok) throw new Error(`Artefato ${path}: HTTP ${response.status}`);
  const sha256 = hash(Buffer.from(await response.arrayBuffer()));
  if (sha256 !== expected.get('public' + path)) throw new Error(`SHA servido diferente: ${path}`);
  served.push({ path, sha256, verified: true });
}
// Versioned URLs (src/server.js): the panel page must name /v/<version>/ of exactly these bytes, served immutable, so a
// browser that never revalidates still runs this release. The version is the SHA-256 of every asset's quoted SHA-256.
const assetVersion = createHash('sha256').update(served.map(file => `"${file.sha256}"`).join('\n')).digest('hex').slice(0, 12);
await validateVersionedPanel({ origin, assetVersion, served });
const healthResponse = await fetch(origin + '/api/health');
if (!healthResponse.ok) throw new Error('Health falhou.');
const health = await healthResponse.json();
const sourceSHA256 = hash(manifest.map(file => `${file.path}:${file.sha256}`).join('\n'));
const { version } = JSON.parse(await readFile(resolve(root, 'package.json')));
if (health.version !== version) throw new Error('Processo servido usa outra versão.');
let previous = null;
const receiptPath = resolve(root, process.env.MEPCHAT_VERIFY_RECEIPT || '.local/verify-receipt.json');
try { previous = JSON.parse(await readFile(receiptPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const verification = { ...identity, version, verifiedAt: new Date().toISOString(), origin, sourceSHA256, health, manifest, served };
const receipt = mergeVerificationReceipt(previous, verification);
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(`MEPChat verificação HTTP · SHA ${sourceSHA256.slice(0, 12)} · ${served.length}/${served.length} artefatos servidos iguais à fonte · versão ${assetVersion} imutável · health ${health.status}${previous ? ' · recibo de release preservado' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verify();
