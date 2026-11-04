// Drafts of the composer (FRONTEND-V2 §7.2, §8.3 P2): sessionStorage only, survive a reload, 24 h TTL,
// at most `limit` per scope, cleared on logout and when the person changes, kept during re-authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDraftsStore, clearDraftsStorage, holdDrafts, flushDrafts, rememberComposerRoute, DRAFT_PREFIX, DRAFT_TTL } from '../public/drafts-store.js';
import { createLiveRegistry, provideLiveContext } from '../public/live.js';

function memoryStorage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
const ref = (tenantId, conversationId) => ({ tenantId, conversationId });
test.afterEach(() => holdDrafts(false));

test('o rascunho sobrevive ao reload: outra instância da mesma pessoa e workspace lê {text, mode, updatedAt}', () => {
  let now = 1_000_000;
  const storage = memoryStorage(), clock = () => now;
  const before = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage, now: clock });
  assert.equal(before.persistent, true);
  assert.equal(before.set(ref('t:1', 'c/1'), 'Olá, Maria', { mode: 'note' }), true);
  assert.deepEqual([...storage.map.keys()], [`${DRAFT_PREFIX}u1:w1:t%3A1:c%2F1`], 'chave elozi:draft:v1:<userId>:<workspaceId>:<tenantId>:<conversationId>');
  now += 60_000;
  const after = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage, now: clock });
  assert.equal(after.get(ref('t:1', 'c/1')), 'Olá, Maria');
  assert.deepEqual(after.entry(ref('t:1', 'c/1')), { text: 'Olá, Maria', mode: 'note', updatedAt: 1_000_000 });
  assert.equal(createDraftsStore({ userId: 'u1', workspaceId: 'w2', storage, now: clock }).get(ref('t:1', 'c/1')), '', 'outro workspace não lê');
  assert.equal(after.set(ref('t:1', 'c/1'), 'x'.repeat(5000)), true);
  assert.equal(after.get(ref('t:1', 'c/1')).length, 4000, 'o limite de 4000 caracteres continua');
});

test('TTL de 24 h: rascunho vencido some na leitura e na criação da próxima instância', () => {
  let now = 0;
  const storage = memoryStorage(), clock = () => now, store = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage, now: clock });
  store.set(ref('t', 'a'), 'velho'); now = 10; store.set(ref('t', 'b'), 'novo');
  now = DRAFT_TTL + 5;
  assert.equal(store.get(ref('t', 'a')), '', 'vencido');
  assert.equal(store.get(ref('t', 'b')), 'novo');
  now = DRAFT_TTL + 11;
  createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage, now: clock });
  assert.equal(storage.map.size, 0, 'a criação limpa os vencidos');
});

test('limite por escopo, texto vazio remove, retenção só da empresa e troca de pessoa apaga os rascunhos da anterior', () => {
  const storage = memoryStorage();
  const store = createDraftsStore({ userId: 'u1', workspaceId: 'w1', limit: 2, storage });
  assert.equal(store.set(ref('a', 'c1'), 'Um'), true); assert.equal(store.set(ref('b', 'c1'), 'Dois'), true);
  assert.equal(store.set(ref('a', 'c2'), 'Três'), false, 'limite');
  assert.equal(store.set(ref('a', 'c1'), 'Um editado'), true, 'editar não conta como nova');
  store.retain('a', []); assert.equal(store.get(ref('a', 'c1')), ''); assert.equal(store.get(ref('b', 'c1')), 'Dois'); assert.equal(store.size, 1);
  store.set(ref('b', 'c1'), ''); assert.equal(store.size, 0);
  store.set(ref('b', 'c9'), 'Nove');
  storage.setItem('outra-chave', 'mantida');
  createDraftsStore({ userId: 'u2', workspaceId: 'w1', storage });
  assert.equal(storage.getItem(`${DRAFT_PREFIX}u1:w1:b:c9`), null, 'outra pessoa: os rascunhos da anterior saem');
  assert.equal(storage.getItem('outra-chave'), 'mantida');
});

test('clear apaga o escopo (logout, troca de acesso), exceto durante a reautenticação; login limpa tudo', () => {
  const storage = memoryStorage();
  const mine = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage }), other = createDraftsStore({ userId: 'u1', workspaceId: 'w2', storage });
  mine.set(ref('t', 'c'), 'meu'); other.set(ref('t', 'c'), 'outro workspace');
  holdDrafts(true);
  assert.equal(mine.clear(), false); assert.equal(mine.get(ref('t', 'c')), 'meu', 'o 401 da lista não apaga o texto');
  holdDrafts(false);
  assert.equal(mine.clear(), true); assert.equal(mine.get(ref('t', 'c')), ''); assert.equal(other.get(ref('t', 'c')), 'outro workspace');
  storage.setItem('outra-chave', 'mantida');
  assert.equal(clearDraftsStorage(storage), 1); assert.deepEqual([...storage.map.keys()], ['outra-chave']);
});

test('nunca localStorage: sem sessionStorage o rascunho fica só na memória (como antes)', () => {
  const source = readFileSync(new URL('../public/drafts-store.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /localStorage/, 'drafts-store.js não usa localStorage');
  assert.match(source, /globalThis\.sessionStorage/);
  const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), local = memoryStorage();
  // Node 26 exposes native sessionStorage; make the absent-browser-storage fixture explicit.
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true, writable: true });
  try {
    const store = createDraftsStore({ userId: 'u1', workspaceId: 'w1' });
    assert.equal(store.persistent, false, 'sem sessionStorage: memória');
    store.set(ref('t', 'c'), 'texto'); assert.equal(store.get(ref('t', 'c')), 'texto');
    assert.equal(local.map.size, 0, 'localStorage intocado');
    const session = memoryStorage(); globalThis.sessionStorage = session;
    const persisted = createDraftsStore({ userId: 'u1', workspaceId: 'w1' });
    persisted.set(ref('t', 'c'), 'texto');
    assert.equal(session.map.size, 1); assert.equal(local.map.size, 0);
  } finally {
    if (originalLocal === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, 'localStorage', originalLocal);
    if (originalSession === undefined) delete globalThis.sessionStorage; else Object.defineProperty(globalThis, 'sessionStorage', originalSession);
  }
});

test('flush grava o compositor da conversa do link profundo antes de a aba sair', () => {
  const storage = memoryStorage(), store = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage });
  const field = { value: 'Rascunho não salvo', disabled: false };
  const doc = hash => ({ getElementById: id => id === 'message-text' ? field : null, defaultView: { location: { hash } } });
  assert.equal(store.flush(doc('#inbox/t1/c1')), true);
  assert.equal(createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage }).get(ref('t1', 'c1')), 'Rascunho não salvo');
  assert.equal(store.flush(doc('#inbox')), false, 'sem conversa aberta não grava');
  assert.equal(store.flush(doc('#inbox/t1/c2?w=w9')), false, 'link de outro workspace não grava neste escopo');
  field.disabled = true;
  assert.equal(store.flush(doc('#inbox/t1/c3')), false);
});

test('reload: o compositor ainda vazio não apaga o rascunho que esta página não mostrou; depois de mostrado, vazio apaga', () => {
  const storage = memoryStorage(), key = `${DRAFT_PREFIX}u1:w1:t1:c1`;
  createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage }).set(ref('t1', 'c1'), 'Texto ao cliente C');
  // New page: the inbox saves the empty composer of C before reading the draft back.
  const reloaded = memoryStorage();
  reloaded.setItem(key, storage.getItem(key));
  const page = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage: reloaded });
  assert.equal(page.set(ref('t1', 'c1'), ''), true);
  assert.equal(reloaded.getItem(key) !== null, true, 'o texto sobrevive ao saveDraft vazio do primeiro render');
  assert.equal(page.get(ref('t1', 'c1')), 'Texto ao cliente C', 'e volta ao abrir a conversa de novo');
  page.set(ref('t1', 'c1'), '');
  assert.equal(reloaded.getItem(key), null, 'mostrado e limpo pela pessoa: sai');
  page.set(ref('t1', 'c2'), 'escrito aqui'); page.set(ref('t1', 'c2'), '');
  assert.equal(page.get(ref('t1', 'c2')), '', 'escrito nesta página e limpo: sai');
});

test('flush grava na conversa para a qual o compositor foi desenhado, não na do hash que já mudou', () => {
  const storage = memoryStorage(), store = createDraftsStore({ userId: 'u1', workspaceId: 'w1', storage });
  const field = { value: 'Texto para o cliente C', disabled: false };
  const location = { hash: '#inbox/t1/C' };
  const doc = { getElementById: id => id === 'message-text' ? field : null, defaultView: { location } };
  // "Abrir conversa" de D: the hash moves first; D's composer is drawn only after its GETs.
  location.hash = '#inbox/t1/D';
  assert.equal(rememberComposerRoute('https://painel.test/app#inbox/t1/C', doc), true);
  assert.equal(rememberComposerRoute('https://painel.test/app#inbox/t1/D', doc), false, 'a primeira saída vale');
  assert.equal(store.flush(doc), true);
  assert.equal(store.get(ref('t1', 'C')), 'Texto para o cliente C');
  assert.equal(store.get(ref('t1', 'D')), '', 'o texto de C nunca vira rascunho de D');
  const next = { value: 'Texto de D', disabled: false };
  const drawn = { getElementById: id => id === 'message-text' ? next : null, defaultView: { location } };
  assert.equal(store.flush(drawn), true, 'o compositor novo (desenhado para D) segue o hash');
  assert.equal(store.get(ref('t1', 'D')), 'Texto de D');
  const listField = { value: 'x', disabled: false }, list = { getElementById: () => listField, defaultView: { location } };
  rememberComposerRoute('https://painel.test/app#inbox', list);
  assert.equal(store.flush(list), false, 'saiu de uma rota sem conversa: não grava em lugar nenhum');
});

test('flushDrafts sem store da caixa usa a pessoa e o workspace do live.js; depois do logout nada é gravado', () => {
  const session = memoryStorage(), registry = createLiveRegistry();
  globalThis.sessionStorage = session;
  try {
    provideLiveContext(() => ({ userId: 'u9', workspaceId: 'w9' }), registry);
    const field = { value: 'Digitado depois do reload', disabled: false };
    const doc = { getElementById: id => id === 'message-text' ? field : null, defaultView: { location: { hash: '#inbox/t1/c1' } } };
    assert.equal(flushDrafts(doc, registry), true);
    assert.equal(createDraftsStore({ userId: 'u9', workspaceId: 'w9' }).get(ref('t1', 'c1')), 'Digitado depois do reload');
    assert.equal(clearDraftsStorage(), 1, 'logout apaga os rascunhos da aba');
    assert.equal(flushDrafts(doc, registry), false, 'o pagehide do logout não grava o compositor de volta');
    assert.equal(session.map.size, 0);
  } finally { delete globalThis.sessionStorage; }
});
