// The finder of areas (navigation-search-ui.js) gave way to the command palette (FRONTEND-V2 §2.5,
// §8.3 P2): the guarantees it had now hold in command-palette.js. Since P10 the area descriptions live
// in nav-config.js and no module imports navigation-search-ui.js any more (the file can go).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommandPalette, screenResults } from '../public/command-palette.js';
import { createLiveRegistry } from '../public/live.js';

test('a busca de telas trata acentos, várias palavras e descrições de ação', () => {
  const items = [{ key: 'channels', label: 'Canais', description: 'Conectar WhatsApp e Instagram' }, { key: 'team', label: 'Equipe', description: 'Convidar pessoas' }, { key: 'flows', label: 'Fluxos', description: 'Criar triagens' }];
  assert.deepEqual(screenResults(items, 'conectar INSTAGRAM').map(item => item.id), ['channels'], 'a paleta encontra pelo que se quer fazer');
  assert.deepEqual(screenResults(items, 'TRIÁGENS').map(item => item.id), ['flows']);
  assert.deepEqual(screenResults(items, 'não existe'), []);
});

function fixture() {
  let authority = 'scope-a', items = [{ key: 'inbox', label: 'Atendimento', description: 'Consultar conversas', glyph: 'chat' }];
  const navigations = [], input = { listeners: {}, value: '', addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {} };
  const list = { innerHTML: '', addEventListener() {}, removeEventListener() {}, querySelector: () => null, contains: () => true }, status = { textContent: '' };
  const modal = { open: false, listeners: {}, classList: { add() {}, remove() {} }, querySelector: selector => ({ '[data-palette-input]': input, '[data-palette-list]': list, '[data-palette-status]': status })[selector],
    addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener() {}, close() { this.open = false; this.listeners.close?.(); } };
  const ui = createCommandPalette({ getItems: () => items, getAuthority: () => authority, getModal: () => modal, openModal() { modal.open = true; }, navigate: key => navigations.push(key), registry: createLiveRegistry(), storage: null, request: null, document: null });
  const enter = () => input.listeners.keydown({ key: 'Enter', preventDefault() {} });
  return { ui, modal, list, navigations, enter, setItems(value) { items = value; }, setAuthority(value) { authority = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a paleta só mostra telas permitidas e confere a autoridade de novo na escolha', async () => {
  const f = fixture();
  assert.equal(f.ui.open(), true);
  assert.match(f.list.innerHTML, /Atendimento/); assert.doesNotMatch(f.list.innerHTML, /platform-users/);
  f.setItems([]);
  f.enter(); await settle();
  assert.deepEqual(f.navigations, [], 'tela que saiu da lista permitida não abre');
  f.setItems([{ key: 'inbox', label: 'Atendimento', glyph: 'chat' }]);
  f.ui.open(); f.setAuthority('scope-b'); f.enter(); await settle();
  assert.deepEqual(f.navigations, []); assert.equal(f.modal.open, false);
});

test('escolha autorizada fecha o diálogo e abre a tela pedida', async () => {
  const f = fixture();
  f.ui.open(); f.enter(); await settle();
  assert.deepEqual(f.navigations, ['inbox']); assert.equal(f.modal.open, false);
});

test('Ctrl+K abre uma vez, sem substituir outro diálogo ativo; o app usa a paleta', () => {
  const f = fixture(); let prevented = 0; const event = { key: 'k', ctrlKey: true, preventDefault() { prevented++; } };
  f.ui.keydown(event); assert.equal(prevented, 1); f.ui.keydown(event); assert.equal(prevented, 1);
  assert.equal(f.modal.open, true);
  const palette = readFileSync(new URL('../public/command-palette.js', import.meta.url), 'utf8');
  assert.doesNotMatch(palette, /from '\.\/navigation-search-ui\.js'/, 'a paleta não depende mais do localizador antigo');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /navigation-search-ui\.js/, 'o app também não: as descrições vêm de nav-config.js');
  assert.match(app, /navigationDescriptions, HUBS, SCREEN_VIEWS \} from '\.\/nav-config\.js'/);
});
