// Command palette (FRONTEND-V2 §2.5, §8.3 P2): combobox with ↑/↓/Enter/Esc, prefixes > @ #, old screen
// names, conversations and contacts through the existing APIs (debounce 150 ms, one AbortController
// per keystroke), authority checked again on choose and recent routes without customer names.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import { createCommandPalette, parseQuery, newHome, screenResults, actionResults, PALETTE_DEBOUNCE } from '../public/command-palette.js';
import { createLiveRegistry, provideLiveContext } from '../public/live.js';

function memoryStorage() { const map = new Map(); return { map, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)) }; }
function fakeTimers() {
  let sequence = 0; const pending = new Map();
  return { pending, setTimeout(fn, ms) { const id = ++sequence; pending.set(id, { fn, ms }); return id; }, clearTimeout(id) { pending.delete(id); }, async flush() { for (const [id, { fn }] of [...pending]) { pending.delete(id); await fn(); } } };
}
function element() {
  const listeners = {};
  return { listeners, value: '', innerHTML: '', textContent: '', attributes: {}, addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener(name) { delete listeners[name]; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, focus() { this.focused = true; }, querySelector: () => null, contains: () => true };
}
function fixture({ items, request, authority = 'a', doc = null, storage = memoryStorage() } = {}) {
  const registry = createLiveRegistry();
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1', tenantId: 't1' }), registry);
  const input = element(), list = element(), status = element(), recovery = element(), failureNote = element(), retry = element(), timers = fakeTimers(), navigations = [], location = { hash: '' };
  const modal = { open: false, closed: 0, classList: { add() {}, remove() {} }, listeners: {}, querySelector: selector => ({ '[data-palette-input]': input, '[data-palette-list]': list, '[data-palette-status]': status, '[data-palette-recovery]': recovery, '[data-palette-failure]': failureNote, '[data-palette-retry]': retry })[selector] || null,
    addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; }, close() { this.open = false; this.closed++; this.listeners.close?.(); } };
  let auth = authority, body = '';
  const palette = createCommandPalette({ getItems: () => items || [{ key: 'inbox', label: 'Atendimento', glyph: 'chat', description: 'Atender clientes' }, { key: 'knowledge', label: 'Conhecimento', glyph: 'document', description: 'Organizar fontes' }, { key: 'team', label: 'Equipe', glyph: 'users', description: 'Convidar pessoas' }],
    getAuthority: () => auth, openModal: (_title, _description, markup) => { modal.open = true; body = String(markup); }, getModal: () => modal, navigate: key => navigations.push(key),
    request, registry, storage, timers, document: doc, location });
  const type = value => { input.value = value; input.listeners.input(); };
  const key = (name, extra = {}) => { const event = { key: name, preventDefault() { this.prevented = true; }, ...extra }; input.listeners.keydown(event); return event; };
  const options = () => [...list.innerHTML.matchAll(/<li class="lv-palette__option" role="option" id="([^"]+)" aria-selected="(true|false)"[\s\S]*?<span class="lv-palette__label">([^<]*)<\/span>/g)].map(match => ({ id: match[1], selected: match[2] === 'true', label: match[3] }));
  return { palette, modal, input, list, status, recovery, failureNote, retry, timers, navigations, location, storage, type, key, options, get body() { return body; }, setAuthority(value) { auth = value; } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
test.afterEach(() => i18n.setLocale('pt-BR', { persist: false, notify: false }));

test('prefixos: nenhum = busca mista, > ações, @ pessoas, # empresas e canais', () => {
  assert.deepEqual(parseQuery('  maria'), { mode: 'all', text: 'maria' });
  assert.deepEqual(parseQuery('>assumir'), { mode: 'actions', text: 'assumir' });
  assert.deepEqual(parseQuery('@ ana'), { mode: 'people', text: 'ana' });
  assert.deepEqual(parseQuery('#loja'), { mode: 'places', text: 'loja' });
});

test('nomes antigos: as telas que mudaram de lugar dizem "agora em …" e são encontradas pelo nome novo também', () => {
  assert.equal(newHome('knowledge'), 'Agentes › Conhecimento');
  assert.equal(newHome('team'), 'Configurações › Equipe');
  const items = [{ key: 'knowledge', label: 'Conhecimento', description: 'Organizar fontes' }, { key: 'team', label: 'Equipe', description: 'Convidar pessoas' }, { key: 'inbox', label: 'Atendimento', description: '' }];
  assert.equal(screenResults(items, 'conhecimento')[0].detail, 'agora em Agentes › Conhecimento');
  assert.deepEqual(screenResults(items, 'configuracoes').map(item => item.id), ['team'], 'acentos e o lugar novo entram na busca');
  assert.deepEqual(screenResults(items, 'atendimento').map(item => item.detail), ['']);
});

test('Ctrl+K abre uma vez; ↑/↓ movem aria-activedescendant; Enter abre e fecha; Esc fecha pelo diálogo', async () => {
  const f = fixture();
  const event = { key: 'k', ctrlKey: true, preventDefault() { this.prevented = (this.prevented || 0) + 1; } };
  f.palette.keydown(event); f.palette.keydown(event);
  assert.equal(event.prevented, 1, 'outro diálogo aberto: não abre de novo');
  assert.match(f.body, /role="combobox"/); assert.match(f.body, /aria-controls="lv-palette-list"/); assert.match(f.body, /role="listbox"/);
  assert.deepEqual(f.options().map(item => item.label), ['Atendimento', 'Conhecimento', 'Equipe']);
  assert.equal(f.input.attributes['aria-activedescendant'], 'lv-palette-option-0');
  f.key('ArrowDown'); f.key('ArrowDown');
  assert.equal(f.input.attributes['aria-activedescendant'], 'lv-palette-option-2');
  assert.deepEqual(f.options().filter(item => item.selected).map(item => item.label), ['Equipe']);
  f.key('ArrowDown');
  assert.equal(f.input.attributes['aria-activedescendant'], 'lv-palette-option-0', 'volta ao início');
  f.key('ArrowUp');
  const enter = f.key('Enter');
  await settle();
  assert.equal(enter.prevented, true); assert.deepEqual(f.navigations, ['team']); assert.equal(f.modal.open, false);
  assert.deepEqual(JSON.parse(f.storage.getItem('elozi:palette:recent:u1')), ['view:team'], 'recentes guardam só a rota');
  assert.equal(f.palette.isOpen, false, 'o fechamento do diálogo (Esc ou escolha) encerra a sessão');
});

test('Shift+Enter abre e mantém a paleta aberta; autoridade mudada fecha sem navegar', async () => {
  const f = fixture();
  f.palette.open();
  f.key('Enter', { shiftKey: true });
  await settle();
  assert.deepEqual(f.navigations, ['inbox']); assert.equal(f.modal.open, true); assert.equal(f.input.focused, true);
  f.setAuthority('b');
  f.key('Enter');
  await settle();
  assert.deepEqual(f.navigations, ['inbox'], 'autoridade diferente: não navega'); assert.equal(f.modal.open, false);
});

test('conversas e contatos pelas APIs atuais, com debounce de 150 ms e AbortController por tecla', async () => {
  const calls = [];
  const request = async (path, { signal }) => {
    calls.push({ path, signal });
    if (path.startsWith('/api/inbox?status=active&unread=1')) return { tenants: [{ id: 't1', name: 'Loja Centro' }], channels: [] };
    if (path.startsWith('/api/inbox?')) return { items: [{ tenantId: 't1', id: 'c1', contact: 'Maria Souza', tenantName: 'Loja Centro', channelName: 'WhatsApp' }] };
    if (path.startsWith('/api/tenants/t1/contacts?')) return { contacts: Array.from({ length: 12 }, (_, index) => ({ id: `k${index}`, name: `Maria ${index}` })) };
    throw new Error('inesperado');
  };
  const f = fixture({ request });
  f.palette.open(); await settle();
  f.type('m'); f.type('ma'); f.type('mar');
  assert.equal(f.timers.pending.size, 1, 'debounce: só a última tecla agenda a busca');
  assert.equal(f.status.textContent, 'Buscando…');
  await f.timers.flush(); await settle();
  const searches = calls.filter(call => !call.path.includes('unread=1'));
  assert.deepEqual(searches.map(call => call.path), ['/api/inbox?status=all&q=mar&limit=8', '/api/tenants/t1/contacts?search=mar'], 'limit=8 nos contatos só com o recurso contacts-limit');
  const labels = f.options().map(item => item.label);
  assert.ok(labels.includes('Maria Souza')); assert.equal(labels.filter(label => /^Maria \d+$/.test(label)).length, 8, 'contatos cortados em 8 no cliente');
  f.type('mari');
  assert.equal(searches.at(-1).signal.aborted, true, 'a busca anterior é abortada a cada tecla');
  f.type('mar'); await f.timers.flush(); await settle();
  const index = f.options().findIndex(item => item.label === 'Maria Souza');
  assert.ok(index >= 0);
  for (let i = 0; i < index; i++) f.key('ArrowDown');
  f.key('Enter'); await settle();
  assert.equal(f.location.hash, '#inbox/t1/c1', 'abre a conversa pelo link profundo');
  assert.doesNotMatch(f.storage.getItem('elozi:palette:recent:u1'), /Maria/, 'nenhum nome de cliente nos recentes');
  const contacts = fixture({ request });
  contacts.palette.open(); await settle();
  contacts.type('@m'); await contacts.timers.flush(); await settle();
  assert.equal(contacts.options().length, 0, 'contatos só a partir de 2 caracteres');
});

test('falha parcial preserva resultados reais, anuncia incompletude e permite retry sem perder o termo', async () => {
  let failContacts = true;
  const f = fixture({ request: async path => {
    if (path.includes('unread=1')) return { tenants: [], channels: [] };
    if (path.startsWith('/api/inbox?')) return { items: [{ tenantId: 't1', id: 'c1', contact: 'Maria' }] };
    if (failContacts) throw Error('network failure');
    return { contacts: [{ id: 'k1', name: 'Maria contato' }] };
  } });
  f.palette.open(); await settle(); f.type('maria'); await f.timers.flush();
  assert.ok(f.options().some(item => item.label === 'Maria'));
  assert.match(f.status.textContent, /Não foi possível buscar contatos/);
  assert.equal(f.recovery.hidden, false); assert.equal(f.failureNote.textContent, f.status.textContent);
  assert.doesNotMatch(f.status.textContent, /Nada encontrado/);
  failContacts = false; f.retry.listeners.click(); assert.equal(f.input.value, 'maria');
  await f.timers.flush(); assert.equal(f.recovery.hidden, true);
  assert.ok(f.options().some(item => item.label === 'Maria contato'));
  f.palette.close(); assert.equal(f.retry.listeners.click, undefined);
});

for (const malformed of [false, true]) test('falha de busca não é lista vazia, inclusive payload malformado=' + malformed, async () => {
  i18n.setLocale('en', { persist: false, notify: false });
  const f = fixture({ request: async path => {
    if (path.includes('unread=1')) return { tenants: [], channels: [] };
    if (malformed) return { unexpected: [] };
    throw Error('network failure');
  } });
  f.palette.open(); await settle(); f.type('zzzz'); await f.timers.flush();
  assert.equal(f.options().length, 0); assert.equal(f.recovery.hidden, false);
  assert.match(f.status.textContent, /Could not complete the search/);
  assert.doesNotMatch(f.status.textContent, /Nothing found|Nada encontrado/);
  f.setAuthority('other-owner'); f.retry.listeners.click(); assert.equal(f.palette.isOpen, false);
});

test('resposta obsoleta de erro não contamina busca nova ou paleta reaberta', async () => {
  let rejectOld;
  const pending = new Promise((_resolve, reject) => { rejectOld = reject; });
  const f = fixture({ request: async path => {
    if (path.includes('unread=1')) return { tenants: [], channels: [] };
    if (path.includes('old')) return pending;
    return path.startsWith('/api/inbox?') ? { items: [] } : { contacts: [] };
  } });
  f.palette.open(); await settle(); f.type('@old'); const old = f.timers.flush(); await settle();
  f.palette.close(); f.palette.open(); await settle(); f.type('@new'); await f.timers.flush();
  rejectOld(Error('stale')); await old; assert.equal(f.recovery.hidden, true);
  assert.match(f.status.textContent, /Nada encontrado/); f.palette.close();
});

test('> ações só oferecem controles que estão na tela e habilitados para esta pessoa', () => {
  const node = (disabled = false) => ({ disabled, getAttribute: () => null, closest: () => null });
  const doc = { querySelectorAll: selector => ({ '[data-action="takeover"]': [node()], '[data-action="conversation-close"]': [node(true)] })[selector] || [], querySelector: () => null };
  const results = actionResults(doc, '');
  assert.ok(results.some(item => item.id === 'takeover'));
  assert.ok(!results.some(item => item.id === 'close'), 'Encerrar desabilitado não aparece');
  assert.ok(!results.some(item => item.id === 'transfer'), 'Transferir ausente não aparece');
  assert.ok(results.some(item => item.id === 'shortcuts'));
  assert.ok(!results.some(item => /aprova/i.test(item.label)), 'aprovação nunca é ação da paleta');
});
