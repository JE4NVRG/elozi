// The panel's served files come from one allowlist (src/panel-assets.js), shared by src/server.js
// and scripts/verify.mjs. scripts/staging.mjs serves any file of public/, so a module missing from
// the allowlist works in staging and fails with 404 in production; this graph check prevents that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { PANEL_ASSETS, PANEL_DYNAMIC_ASSETS, PANEL_PAGES, PANEL_STATIC_FILES, VERIFIED_ASSET_PATHS } from '../src/panel-assets.js';

const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
const publicDirectory = new URL('../public/', import.meta.url);
const read = file => readFileSync(new URL(file, publicDirectory), 'utf8');
const verified = new Set(VERIFIED_ASSET_PATHS);
const ASSET_REFERENCE = /["'`(]\/([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?\.(?:js|css|svg|png|jpe?g|webp|ico|woff2))\b/g;

function requireServed(path, from) {
  assert.ok(path.startsWith('/'), `${from}: referência local precisa ser absoluta ou relativa à raiz: ${path}`);
  assert.ok(PANEL_STATIC_FILES[path], `${from} usa ${path}, ausente de src/panel-assets.js (produção responderia 404)`);
  assert.ok(existsSync(new URL(PANEL_STATIC_FILES[path], publicDirectory)), `${path} precisa existir em public/`);
  if (!PANEL_STATIC_FILES[path].endsWith('.html')) assert.ok(verified.has(path), `${path} precisa estar na verificação de SHA de scripts/verify.mjs`);
}

function pageReferences(page) {
  const html = read(page), references = [];
  for (const tag of html.match(/<(?:link|script)\b[^>]*>/g) || []) {
    const url = tag.match(/\s(?:href|src)="([^"]+)"/)?.[1];
    if (!url) continue;
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(url), `${page}: sem CDN externo (${url})`);
    references.push({ url, module: /^<script\b/.test(tag) && /type="module"/.test(tag) });
  }
  return references;
}

function moduleImports(file) {
  const source = read(file), specifiers = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) specifiers.push(node.source.value);
    if (node.type === 'ImportExpression') {
      assert.equal(node.source.type, 'Literal', `${file}: import() dinâmico precisa de caminho literal para ser auditado`);
      specifiers.push(node.source.value);
    }
    for (const key of Object.keys(node)) if (key !== 'loc') visit(node[key]);
  };
  visit(acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  return { source, specifiers };
}

function resolveModule(specifier, from) {
  assert.ok(specifier.startsWith('./') || specifier.startsWith('/'), `${from}: módulo ${specifier} precisa ser local (sem bundler nem CDN)`);
  const file = specifier.replace(/^\.?\//, '');
  assert.ok(!file.includes('/'), `${from}: ${specifier} precisa ficar plano em public/ (check, verify e i18n não são recursivos)`);
  return file;
}

test('todo <link> e <script> das páginas do painel está na allowlist única e na verificação', () => {
  for (const page of new Set(Object.values(PANEL_PAGES))) {
    const references = pageReferences(page);
    assert.ok(references.length > 0, `${page} sem assets`);
    // /brand.css (P10) is written per host by src/server.js: listed apart and never a file of public/.
    for (const { url } of references) if (!PANEL_DYNAMIC_ASSETS.includes(url)) requireServed(url, page);
  }
  for (const path of PANEL_DYNAMIC_ASSETS) {
    assert.equal(PANEL_STATIC_FILES[path], undefined, `${path} não é arquivo estático`);
    assert.equal(existsSync(new URL(path.slice(1), publicDirectory)), false, `${path} não existe em public/`);
  }
});

test('o manifest do app instalável só aponta para ícones servidos e verificados', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.start_url, '/'); assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable') && manifest.icons.some(icon => icon.sizes === '512x512'));
  for (const icon of manifest.icons) requireServed(icon.src, 'manifest.webmanifest');
  assert.doesNotMatch(JSON.stringify(manifest), /elozi/i, 'nome genérico: o manifest é o mesmo em todos os endereços (white label)');
});

test('todo módulo alcançável a partir de app.js e login.js está na allowlist única e na verificação', () => {
  const entries = [...new Set(Object.values(PANEL_PAGES))].flatMap(page => pageReferences(page).filter(reference => reference.module).map(reference => reference.url.slice(1)));
  assert.ok(entries.includes('app-entry.js') && entries.includes('login.js'));
  const seen = new Set(), queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    requireServed('/' + file, 'grafo de módulos');
    const { source, specifiers } = moduleImports(file);
    for (const specifier of specifiers) queue.push(resolveModule(specifier, file));
    for (const match of source.matchAll(ASSET_REFERENCE)) requireServed('/' + match[1], file);
  }
  assert.ok(seen.size > 40, 'o grafo precisa cobrir os módulos do painel');
  assert.ok(seen.has('app.js'), 'a recuperação inicial precisa importar o aplicativo auditado');
});

test('CSS servido só referencia arquivos da allowlist', () => {
  for (const file of PANEL_ASSETS.filter(name => name.endsWith('.css'))) {
    const css = read(file);
    for (const match of css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) if (!match[1].startsWith('data:')) requireServed(match[1], file);
    for (const match of css.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)) requireServed(match[1], file);
  }
});

test('a allowlist não aponta para arquivos ausentes e todo arquivo plano do painel está registrado', () => {
  for (const [path, file] of Object.entries(PANEL_STATIC_FILES)) assert.ok(existsSync(new URL(file, publicDirectory)), `${path} → public/${file} ausente`);
  const registered = new Set(Object.values(PANEL_STATIC_FILES));
  const unregistered = readdirSync(publicDirectory).filter(file => /\.(?:js|css|html|svg)$/.test(file) && !registered.has(file));
  assert.deepEqual(unregistered, [], 'arquivo novo em public/ precisa entrar em src/panel-assets.js');
  assert.equal(new Set(PANEL_ASSETS).size, PANEL_ASSETS.length, 'arquivo repetido na allowlist');
});
