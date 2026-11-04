import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createModalRouteLifecycle } from '../public/modal-route-lifecycle.js';
import { readFile, readdir } from 'node:fs/promises';
import { html, setLocale } from '../public/i18n.js';
import '../public/locales-shell.js';
import '../public/locales-management.js';
import '../public/locales-operations.js';
import '../public/locales-auth.js';
import '../public/locales-support-central.js';
import '../public/locales-telegram-account.js';
import { createOverviewMarkup } from '../public/overview-ui.js';
import { consolidatedListMarkup } from '../public/consolidated-inbox-ui.js';

const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
const parse = source => acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parents);
  for (const [key, child] of Object.entries(node)) if (key !== 'type') {
    if (Array.isArray(child)) for (const item of child) walk(item, visit, [...parents, node]);
    else if (child?.type) walk(child, visit, [...parents, node]);
  }
}
const callName = node => node?.type === 'Identifier' ? node.name : '';
const template = node => node.quasis.reduce((copy, quasi, index) => copy + (index ? `{${index - 1}}` : '') + quasi.value.cooked, '');
function markupCopy(source) {
  const values = [];
  for (const piece of source.split(/(<[^>]*>)/g)) {
    if (piece.startsWith('<')) {
      for (const match of piece.matchAll(/\b(?:aria-label|title|placeholder|alt|label|data-nav-label)=("|')([\s\S]*?)\1/g)) if (match[2].trim()) values.push(match[2].trim());
    } else if (piece.trim()) values.push(piece.trim());
  }
  return values;
}
// This is deliberately scoped to explicitly localized product-copy sites.
// Protocol values, default agent instructions and unmarked customer data are excluded.
const portugueseProductCopy = copy => /[áàâãéêíóôõúç]/i.test(copy) || /\b(?:atendimento|copiloto|agente|conversa|mensagem|equipe|conta|canal|salvar|cancelar|fechar|empresa|contato|suporte|idioma|perfil|senha|nenhum|nenhuma|novo|nova|seu|sua|com|para)\b/i.test(copy);
// One catalog per owner (FRONTEND-V2 §8.1); live … settings were born empty in P1 commit 1f for P2–P8.
// Include every explicit catalog, not only older exported dictionaries.
const catalogs = (await readdir(new URL('../public/', import.meta.url)))
  .filter(file => /^locales(?:-[\w-]+)?\.js$/.test(file)).sort();
const registered = new Map(), collisions = [];
const context = vm.createContext({ registerTranslations(dictionary) {
  for (const [source, target] of Object.entries(dictionary)) {
    if (registered.has(source) && registered.get(source) !== target) collisions.push({ source, first: registered.get(source), second: target });
    if (!registered.has(source)) registered.set(source, target);
  }
} });
for (const catalog of catalogs) {
  const source = await readFile(new URL(`../public/${catalog}`, import.meta.url), 'utf8');
  new vm.Script(source.replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=const|function)/g, '')).runInContext(context);
}
const publicFiles = (await readdir(new URL('../public/', import.meta.url))).filter(file => file.endsWith('.js') && !file.startsWith('locales-') && !['i18n.js', 'login.js', 'google-ui.js'].includes(file));
const sources = new Map(await Promise.all(publicFiles.map(async file => [file, await readFile(new URL('../public/' + file, import.meta.url), 'utf8')])));
const trees = new Map([...sources].map(([file, source]) => [file, parse(source)]));
const namesByFile = new Map();
for (const [file, tree] of trees) {
  const names = new Map();
  for (const statement of tree.body) if (statement.type === 'ImportDeclaration' && statement.source.value === './i18n.js') for (const specifier of statement.specifiers) if (specifier.type === 'ImportSpecifier') names.set(specifier.local.name, specifier.imported.name);
  namesByFile.set(file, names);
}
function localizedValues(node, names) {
  if (node.type === 'TaggedTemplateExpression') {
    const name = names.get(callName(node.tag));
    // h`` (escaped by default, FRONTEND-V2 §4.1) translates its literal markup exactly like html``.
    if (name === 'html' || name === 'h') return markupCopy(template(node.quasi));
    if (name === 'txt') return [template(node.quasi)];
  } else if (node.type === 'CallExpression') {
    const name = names.get(callName(node.callee)), value = node.arguments[0];
    if (name === 't' && value?.type === 'Literal' && typeof value.value === 'string') return [value.value];
    if (name === 'markup' && value?.type === 'Literal' && typeof value.value === 'string') return markupCopy(value.value);
    if (name === 'labels' && value?.type === 'ObjectExpression') return value.properties.filter(property => property.value?.type === 'Literal' && typeof property.value.value === 'string').map(property => property.value.value);
  }
  return [];
}
const grammaticalChoice = expression => expression?.type === 'ConditionalExpression' && [expression.consequent, expression.alternate].every(branch => branch.type === 'Literal' && ['', 's', 'l', 'is'].includes(branch.value));
const grammaticalSlots = new Map();
for (const [file, tree] of trees) walk(tree, node => {
  if (node.type !== 'TaggedTemplateExpression') return;
  for (const source of localizedValues(node, namesByFile.get(file))) {
    const safe = new Set([...source.matchAll(/\{(\d+)\}/g)].filter(match => grammaticalChoice(node.quasi.expressions[Number(match[1])])).map(match => match[1]));
    const prior = grammaticalSlots.get(source);
    grammaticalSlots.set(source, prior ? new Set([...prior].filter(slot => safe.has(slot))) : safe);
  }
});
const protocolExample = source => /^(?:https?:\/\/\S+|…?[a-z][a-z0-9.-]*\.(?:com|app|br|test)|[^\s<>]+@[^\s<>]+|Elozi &lt;[^\s<>]+@[^\s<>]+&gt;)$/i.test(source);

function invalidInterpolations(dictionary) {
  const placeholders = source => [...source.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
  return [...dictionary].filter(([source, target]) => {
    const before = placeholders(source), after = placeholders(target), omitted = before.filter(slot => !after.includes(slot)), allowed = grammaticalSlots.get(source) || new Set();
    return omitted.some(slot => !allowed.has(slot)) || JSON.stringify(before.filter(slot => !omitted.includes(slot))) !== JSON.stringify(after);
  });
}

test('catálogos preservam parâmetros de produto sem omitir ou duplicar valores interpolados', () => {
  const invalid = invalidInterpolations(registered);
  assert.deepEqual(invalid.slice(0, 12), [], `Interpolations changed in ${invalid.length} catalog entries`);
});

function missingProductCopy(sourceFiles, dictionary, importNames = namesByFile) {
  const missing = [], used = new Set();
  for (const [file, source] of sourceFiles) walk(parse(source), node => {
    for (const value of localizedValues(node, importNames.get(file))) {
      used.add(value);
      if (portugueseProductCopy(value) && !protocolExample(value) && !dictionary.has(value)) missing.push({ file, line: source.slice(0, node.start).split('\n').length, source: value });
    }
  });
  return { missing, used };
}

test('cópia portuguesa explicitamente marcada em templates e chamadas possui tradução EN', () => {
  const { missing, used } = missingProductCopy(sources, registered);
  assert.ok(used.size > 500, 'Extraction must exercise the panel and UI modules');
  assert.deepEqual(missing.slice(0, 12), [], `${missing.length} marked product-copy sites lack EN catalog entries`);
});


test('modular catalogs reject new missing keys and removed, duplicated or invented slots', () => {
  const key = 'Mensagem de suporte inédita para regressão de catálogo';
  assert.equal(registered.has(key), false);
  const fixture = new Map([['fixture.js', `i18nT(${JSON.stringify(key)});`]]);
  const imports = new Map([['fixture.js', new Map([['i18nT', 't']])]]);
  assert.deepEqual(missingProductCopy(fixture, registered, imports).missing.map(item => item.source), [key]);
  assert.deepEqual(missingProductCopy(fixture, new Map(registered).set(key, 'New support message for catalog regression'), imports).missing, []);
  for (const target of ['Message', 'Message {0} {0}', 'Message {1}']) {
    assert.deepEqual(invalidInterpolations(new Map([['Mensagem {0}', target]])), [['Mensagem {0}', target]]);
  }
  assert.deepEqual(invalidInterpolations(new Map([['Mensagem {0}', 'Message {0}']])), []);
  assert.equal(registered.get('Buscar texto, nome do arquivo, legenda ou autor nas mensagens carregadas'), 'Search text, filename, caption or author in loaded messages');
});

test('modal do painel conserva nomes de cliente mesmo quando coincidem com uma chave de tradução', () => {
  const source = sources.get('app.js'); let definition;
  walk(parse(source), node => { if (node.type === 'FunctionDeclaration' && node.id.name === 'openModal') definition = source.slice(node.start, node.end); });
  assert.ok(definition);
  const modal = { innerHTML: '', showModal() {} }, escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const isolated = vm.createContext({ modalRouteLifecycle: createModalRouteLifecycle({ getModal: () => null, getContext: () => '' }), $: () => modal, html, escape, icon: () => '', t: value => { assert.fail('Modal infrastructure must not translate dynamic customer title: ' + value); } });
  new vm.Script(definition + '\nthis.open=openModal;').runInContext(isolated);
  setLocale('en');
  try {
    isolated.open('Grupos', 'Minha conta', '<p>Mensagem privada: Salvar</p>');
    assert.match(modal.innerHTML, /id="modal-title">Grupos<\/h2>/); assert.match(modal.innerHTML, /id="modal-description">Minha conta<\/p>/);
    assert.match(modal.innerHTML, /Mensagem privada: Salvar/); assert.match(modal.innerHTML, /aria-label="Close window"/);
  } finally { setLocale('pt-BR'); }
});

test('visões EN completas preservam nomes, mensagens, etiquetas, IDs e DTOs autorizados', () => {
  const tenant = { id: 'Grupos', name: 'Minha conta' }, user = { userId: 'Usuário', role: 'reseller', name: 'Salvar' }, channel = { id: 'Atendimento', tenantId: tenant.id, name: 'Cancelar', kind: 'whatsapp_qr', state: 'connected' };
  const conversation = { id: 'Minha conta', tenantId: tenant.id, contact: 'Grupos', channelId: channel.id, status: 'open', owner: 'human', assignedUserId: 'Outra pessoa', assignedUserName: 'Salvar', department: 'Fechar', updatedAt: '2026-10-05T12:00:00Z', messages: [{ id: 'Salvar', kind: 'customer', text: 'Minha conta · Salvar · Grupos' }] };
  const overviewInput = { tenant, session: user, channels: [channel], conversations: [conversation], contacts: [{ id: 'Cancelar', name: 'Salvar', tags: ['Grupos'], identities: [] }], assignees: [{ id: 'Outra pessoa', name: 'Minha conta', presence: 'available' }], access: { inboxRead: true, contactsRead: true, contactsWrite: true, manageChannels: true, manageTeam: true, teamChatRead: true } };
  const before = JSON.stringify(overviewInput), escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  setLocale('en');
  try {
    const overview = createOverviewMarkup(overviewInput);
    assert.match(overview, /Overview/); assert.match(overview, /data-overview-conversation="Minha conta"/); assert.match(overview, /data-overview-tenant="Grupos"/);
    assert.match(overview, /<strong data-pii>Grupos<\/strong>/); assert.match(overview, /Cancelar/); assert.match(overview, /Fechar/); assert.equal(JSON.stringify(overviewInput), before);
    const item = { ...conversation, tenantName: tenant.name, channelName: channel.name, preview: { text: conversation.messages[0].text } }, data = { items: [item], total: 1, offset: 0, hasMore: false, tenants: [tenant], channels: [channel], departments: [], assignees: [], counts: {}, countTabs: {} };
    const inboxBefore = JSON.stringify(data), inbox = consolidatedListMarkup({ data, filters: { inboxCompany: 'all', assignedUser: 'all', channel: 'all', filter: 'all', status: 'active', department: 'all', kind: 'all', sort: 'recent', search: 'Salvar' }, workspaceId: 'Grupos', userId: user.userId, escape, icon: () => '', avatar: value => `<span>${escape(value)}</span>`, badge: value => `<small>${escape(value)}</small>` });
    assert.match(inbox, /Conversations/); assert.match(inbox, /data-conversation="Minha conta"/); assert.match(inbox, /class="conversation-last">Minha conta · Salvar · Grupos<\/span>/);
    assert.match(inbox, /value="Salvar"/); assert.match(inbox, /<strong>Grupos<\/strong>/); assert.equal(JSON.stringify(data), inboxBefore);
  } finally { setLocale('pt-BR'); }
});
