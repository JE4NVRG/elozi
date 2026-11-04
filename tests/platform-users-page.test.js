import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createPlatformUsersUI, platformUsersMarkup, platformUsersQuery } from '../public/platform-users-ui.js';
import { getLocale, setLocale } from '../public/i18n.js';
import { managementTranslations } from '../public/locales-management.js';
import { platformUsersTranslations } from '../public/locales-platform-users.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const person = { id: 'synthetic-user', name: 'Buscar Suporte', username: 'pessoa-portuguesa', role: 'operator', reseller: { name: 'Revenda Ativo' }, tenants: [{ name: 'Empresa Atualizar' }], tenantCount: 1, disabled: false };
const result = (overrides = {}) => ({ users: [structuredClone(person)], total: 1, offset: 0, limit: 50, hasMore: false, ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(request = async () => result()) {
  let context = { userId: 'principal', workspaceId: 'workspace-a', platformOwner: true, active: true, authorityKey: 'authority-a' };
  const calls = [], modalContents = [], toasts = [], modal = { open: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  let renders = 0;
  const ui = createPlatformUsersUI({ request: (...args) => { calls.push(args); return request(...args); }, getContext: () => context, escape, onRender: () => renders++, toast: (...args) => toasts.push(args), getModal: () => modal, openModal: (...args) => { modal.open = true; modalContents.push(args[2]); } });
  return { ui, calls, modalContents, modal, toasts, setContext: patch => { context = { ...context, ...patch }; }, renders: () => renders };
}
function form(q, state = 'all') {
  const button = { disabled: false, isConnected: true };
  return { matches: selector => selector === '[data-platform-users-form]', elements: { namedItem: name => ({ value: name === 'q' ? q : state }) }, querySelector: () => button, button };
}

test('página carrega sem modal, exibe identidade, empresa e estados de leitura', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  assert.match(f.ui.view(), /Carregar diretório/);
  const run = f.ui.load();
  assert.match(f.ui.view(), /role="status"/);
  assert.doesNotMatch(f.ui.view(), /Nenhuma pessoa encontrada/);
  pending.resolve(result());
  assert.equal(await run, true);
  assert.equal(f.modalContents.length, 0);
  assert.ok(f.renders() >= 2);
  assert.match(f.ui.view(), /Buscar Suporte/);
  assert.match(f.ui.view(), /Revenda Ativo/);
  assert.match(f.ui.view(), /Empresa Atualizar/);
  assert.match(f.ui.view(), /class="ui-avatar__initials">/);
  assert.doesNotMatch(f.ui.view(), /<img|data-action="edit-user"/);
  assert.equal(f.calls[0][1].headers['X-Elozi-Workspace'], 'workspace-a');
  assert.equal(f.calls[0][1].signal.aborted, false);
});

test('busca, paginação, atualizar e limpar usam filtro atual e consulta limitada', async () => {
  const f = fixture(async url => result({ total: 103, offset: Number(new URL(url, 'http://local').searchParams.get('offset')), hasMore: true }));
  await f.ui.load();
  const search = form('nome & empresa', 'disabled');
  assert.equal(await f.ui.submit(search), true);
  assert.equal(search.button.disabled, false);
  await f.ui.action('platform-users-page', '50');
  await f.ui.action('platform-users-refresh');
  const url = new URL(f.calls.at(-1)[0], 'http://local');
  assert.equal(url.searchParams.get('q'), 'nome & empresa');
  assert.equal(url.searchParams.get('state'), 'disabled');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.match(f.ui.view(), /Página 2 de 3/);
  await f.ui.action('platform-users-clear');
  const cleared = new URL(f.calls.at(-1)[0], 'http://local');
  assert.equal(cleared.searchParams.get('offset'), '0');
  assert.equal(cleared.searchParams.get('q'), '');
  assert.equal(cleared.searchParams.get('state'), 'all');
});

test('consulta vazia filtrada oferece limpar em vez de cadastrar ou intervir', async () => {
  const f = fixture(async () => result({ users: [], total: 0 }));
  await f.ui.load(); await f.ui.submit(form('ninguém'));
  assert.match(f.ui.view(), /Nenhuma pessoa encontrada/);
  assert.match(f.ui.view(), /Tente outro nome/);
  assert.match(f.ui.view(), /data-action="platform-users-clear"/);
  assert.doesNotMatch(f.ui.view(), /data-action="(?:create|edit)-user"/);
});

for (const context of [{ platformOwner: false }, { supportGrantId: 'support-synthetic' }, { kind: 'service' }]) {
  test(`diretório não consulta fora da autoridade principal: ${JSON.stringify(context)}`, async () => {
    const f = fixture(); f.setContext(context);
    await assert.rejects(f.ui.load(), /administrador da plataforma/);
    await assert.rejects(f.ui.open(), /administrador da plataforma/);
    assert.equal(f.calls.length, 0);
    assert.match(f.ui.view(), /reservado/);
    assert.doesNotMatch(f.ui.view(), /data-platform-users-form/);
  });
}

for (const patch of [{ workspaceId: 'workspace-b' }, { userId: 'another-user' }, { authorityKey: 'authority-b' }, { supportGrantId: 'support-synthetic' }, { platformOwner: false }]) {
  test(`resultado tardio não atravessa mudança de autoridade: ${JSON.stringify(patch)}`, async () => {
    const pending = deferred(), f = fixture(() => pending.promise);
    const run = f.ui.load(); f.setContext(patch); pending.resolve(result());
    assert.equal(await run, false);
    assert.doesNotMatch(f.ui.view(), /Buscar Suporte/);
  });
}

test('reset aborta carregamento e nova consulta vence resposta anterior fora de ordem', async () => {
  const first = deferred(), second = deferred(); let n = 0;
  const f = fixture(() => (++n === 1 ? first : second).promise);
  const old = f.ui.load(); f.ui.reset();
  assert.equal(f.calls[0][1].signal.aborted, true);
  const fresh = f.ui.load(); second.resolve(result({ users: [{ ...person, name: 'Pessoa recente' }] }));
  assert.equal(await fresh, true); first.resolve(result()); assert.equal(await old, false);
  assert.match(f.ui.view(), /Pessoa recente/);
  assert.doesNotMatch(f.ui.view(), /Buscar Suporte/);
});

test('sair da página durante consulta impede pintura e nova carga inativa', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const run = f.ui.load(); const count = f.renders(); f.setContext({ active: false }); pending.resolve(result());
  assert.equal(await run, false); assert.equal(f.renders(), count);
  assert.equal(await f.ui.load(), false); assert.equal(f.calls.length, 1);
});

test('falha inicial é erro com retry; sucesso posterior não herda falsa lista vazia', async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error('Não foi possível carregar o diretório.'); return result(); });
  assert.equal(await f.ui.load(), false);
  assert.match(f.ui.view(), /role="alert"/);
  assert.match(f.ui.view(), /data-action="platform-users-retry"/);
  assert.doesNotMatch(f.ui.view(), /Nenhuma pessoa encontrada/);
  fail = false; await f.ui.action('platform-users-retry');
  assert.match(f.ui.view(), /Buscar Suporte/); assert.doesNotMatch(f.ui.view(), /role="alert"/);
});

test('falha transitória identifica último resultado; acesso revogado retira pessoas e bloqueia retry', async () => {
  let failure;
  const f = fixture(async () => { if (failure) throw failure; return result(); });
  await f.ui.load(); failure = Object.assign(new Error('Não foi possível carregar o diretório.'), { status: 503 });
  await f.ui.action('platform-users-refresh');
  assert.match(f.ui.view(), /última consulta concluída/); assert.match(f.ui.view(), /Buscar Suporte/);
  failure = Object.assign(new Error('Este diretório é reservado ao administrador da plataforma.'), { status: 403 });
  await f.ui.action('platform-users-retry');
  assert.doesNotMatch(f.ui.view(), /Buscar Suporte|data-action="platform-users-retry"/);
  assert.match(f.ui.view(), /Confirme seu acesso/);
  const count = f.calls.length; await f.ui.action('platform-users-refresh'); assert.equal(f.calls.length, count);
});

test('DTO inválido não fabrica resultado vazio e paginação adulterada não chega à API', async () => {
  const f = fixture(async () => ({ total: 1, users: [null] }));
  assert.equal(await f.ui.load(), false);
  assert.match(f.ui.view(), /Não foi possível conferir/);
  assert.doesNotMatch(f.ui.view(), /Nenhuma pessoa encontrada/);
  const count = f.calls.length;
  for (const id of ['-1', 'NaN', '100001', '0.5']) await f.ui.action('platform-users-page', id);
  assert.equal(f.calls.length, count);
  assert.throws(() => platformUsersQuery({ state: 'unknown' }), /Invalid directory query/);
  assert.throws(() => platformUsersQuery({ offset: -1 }), /Invalid directory query/);
});

test('atalho modal permanece amplo; close nativo cancela busca sem reabrir e close deferido é ignorado', async () => {
  const pending = deferred(); let n = 0;
  const f = fixture(() => ++n === 1 ? Promise.resolve(result()) : pending.promise);
  await f.ui.open(); assert.equal(f.modalContents.length, 1);
  const run = f.ui.action('platform-users-refresh');
  f.modal.listeners.close(); // A queued close for a dialog which is already open.
  assert.equal(f.calls[1][1].signal.aborted, false);
  f.modal.open = false; f.modal.listeners.close();
  assert.equal(f.calls[1][1].signal.aborted, true);
  const count = f.modalContents.length; pending.resolve(result()); await run;
  assert.equal(f.modalContents.length, count);
});

test('PT→EN→PT atualiza controles e erros sem alterar pessoas, filtro ou parâmetros', async context => {
  const prior = getLocale(); context.after(() => setLocale(prior, { persist: false, notify: false }));
  setLocale('pt-BR', { persist: false, notify: false });
  const f = fixture(); await f.ui.load(); await f.ui.submit(form('Nome Atualizar', 'active'));
  const beforeCalls = f.calls.length, before = result();
  setLocale('en', { persist: false, notify: false });
  const en = f.ui.view();
  assert.match(en, /Global users/); assert.match(en, /people found/); assert.match(en, /Page 1 of 1/);
  assert.match(en, /placeholder="Name, username or reseller"/);
  assert.match(en, /Buscar Suporte|Revenda Ativo|Empresa Atualizar/);
  assert.match(en, /value="Nome Atualizar"/); assert.match(en, /value="active" selected/);
  assert.equal(f.calls.length, beforeCalls); assert.deepEqual(result(), before);
  setLocale('pt-BR', { persist: false, notify: false }); assert.match(f.ui.view(), /Usuários globais/);
  const errorUI = fixture(async () => { throw new Error('Não foi possível carregar o diretório.'); });
  await errorUI.ui.load(); setLocale('en', { persist: false, notify: false }); assert.match(errorUI.ui.view(), /Unable to load the directory/);
  setLocale('pt-BR', { persist: false, notify: false }); assert.match(errorUI.ui.view(), /Não foi possível carregar o diretório/);
});

test('dados externos são escapados em iniciais, filtro, nomes e empresas sem expor campos extras', () => {
  const data = result({ users: [{ ...person, name: '<img src=x onerror=alert(1)>', username: '<script>', reseller: { name: '<Revenda>' }, tenants: [{ name: 'A & B' }], password: 'synthetic-private-password', token: 'synthetic-private-token' }] });
  const markup = platformUsersMarkup(data, { escape }, { q: '" onfocus="bad' });
  assert.doesNotMatch(markup, /<img|<script>|synthetic-private|value="" onfocus/);
  assert.match(markup, /&lt;img/); assert.match(markup, /&lt;Revenda&gt;/); assert.match(markup, /A &amp; B/);
});

// P8 (§8.9): the directory uses the shared sheet of the settings screens (platform-users.css, emptied by P8, left in P10).
test('CSS próprio amplia apenas modal do diretório e permite tabela navegável no celular', () => {
  assert.equal(existsSync(new URL('../public/platform-users.css', import.meta.url)), false);
  const css = readFileSync(new URL('../public/screen-settings.css', import.meta.url), 'utf8');
  assert.match(css, /#modal:has\(\[data-platform-users-panel\]\)[^{]*\{[^}]*1100px/);
  assert.match(css, /\.pg-settings__table-wrap\s*\{[^}]*overflow-x: auto/);
  assert.match(css, /@media \(max-width: 599\.98px\)\s*\{\s*\.pg-settings__table--cards thead/);
  const markup = platformUsersMarkup(result(), { escape }, {});
  assert.match(markup, /class="pg-settings__table pg-settings__table--cards"/);
  assert.match(markup, /<button type="button" class="ui-btn [^"]*" data-action="platform-users-refresh"/, 'botões do design system: alvo de 44 px abaixo de 900 px');
});

test('cada texto e atributo estático do diretório possui tradução e parâmetros preservados', () => {
  const acorn = { exports: {} };
  new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
  const source = readFileSync(new URL('../public/platform-users-ui.js', import.meta.url), 'utf8');
  const tree = acorn.exports.parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const dictionary = { ...managementTranslations, ...platformUsersTranslations }, keys = new Set();
  const pattern = node => node.quasis.reduce((text, quasi, i) => text + (i ? `{${i - 1}}` : '') + quasi.value.cooked, '');
  const markupKeys = text => text.split(/(<[^>]*>)/g).flatMap(part => part.startsWith('<') ? [...part.matchAll(/\b(?:aria-label|title|placeholder|alt|label|data-nav-label)=("|')([\s\S]*?)\1/g)].map(match => match[2].trim()) : [part.trim()]);
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TaggedTemplateExpression' && ['html', 'h', 'txt'].includes(node.tag?.name)) for (const key of node.tag.name === 'txt' ? [pattern(node.quasi)] : markupKeys(pattern(node.quasi))) keys.add(key);
    if (node.type === 'CallExpression' && node.callee?.name === 't' && typeof node.arguments[0]?.value === 'string') keys.add(node.arguments[0].value);
    if (node.type === 'CallExpression' && node.callee?.name === 'labels') for (const property of node.arguments[0].properties) keys.add(property.value.value);
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(walk); else if (child?.type) walk(child);
  }
  walk(tree);
  const textKeys = [...keys].filter(key => /[A-Za-zÀ-ÿ]/.test(key.replace(/\{\d+\}/g, '')));
  assert.ok(textKeys.length > 30, 'Must exercise headers, filters, rows, pagination, notices and attributes');
  assert.deepEqual(textKeys.filter(key => !Object.hasOwn(dictionary, key)), []);
  const slots = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [pt, en] of Object.entries(platformUsersTranslations)) assert.deepEqual(slots(pt), slots(en), pt);
});
