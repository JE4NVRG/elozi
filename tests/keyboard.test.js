// Keyboard map (FRONTEND-V2 §2.6, §8.3 P2): scopes, single-key shortcuts only outside fields and
// switchable off, the "?" sheet, and no forbidden key registered anywhere (static test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createKeyboard, keyboard, isForbiddenCombo, normalizeCombo, eventCombo, FORBIDDEN_KEYS, APPROVAL_FOCUS } from '../public/keyboard.js';
import { createLiveRegistry, provideLiveContext } from '../public/live.js';

const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
function walk(node, visit) { if (!node || typeof node !== 'object') return; if (typeof node.type === 'string') visit(node); for (const [key, child] of Object.entries(node)) if (key !== 'type') { if (Array.isArray(child)) for (const item of child) walk(item, visit); else if (child?.type) walk(child, visit); } }

test('teste estático: nenhuma chamada registerScope do painel registra uma tecla proibida', () => {
  const directory = new URL('../public/', import.meta.url), found = [];
  for (const file of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    if (!source.includes('registerScope(')) continue;
    walk(acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), node => {
      if (node.type !== 'CallExpression' || node.callee?.property?.name !== 'registerScope' && node.callee?.name !== 'registerScope') return;
      const bindings = node.arguments[1];
      if (bindings?.type !== 'ObjectExpression') return;
      for (const property of bindings.properties) {
        const key = property.key?.type === 'Identifier' ? property.key.name : property.key?.value;
        if (key !== undefined) found.push([file, String(key)]);
      }
    });
  }
  assert.ok(found.length >= 25, 'o mapa padrão está no keyboard.js');
  assert.deepEqual(found.filter(([, key]) => isForbiddenCombo(key)), []);
  for (const [, key] of found) assert.doesNotMatch(normalizeCombo(key), /(?:^|\s)(?:tab|mod\+enter)$/, 'Tab nunca é ação; Ctrl+Enter fica com o compositor');
  assert.ok(!found.some(([, key]) => /approve|aprovar/i.test(key)));
});

test('teclas proibidas: Tab, Ctrl+J, Ctrl+Shift+D/O, Ctrl+T/W/N/L/H/D e Alt+letra nunca são registradas', () => {
  const keys = createKeyboard({ storage: null });
  for (const combo of ['Tab', 'Ctrl+J', 'Meta+j', 'Ctrl+Shift+D', 'ctrl+shift+o', 'Ctrl+T', 'Ctrl+W', 'Ctrl+N', 'Ctrl+L', 'Ctrl+H', 'Ctrl+D', 'Alt+A', 'alt+z', 'shift+tab']) {
    assert.equal(isForbiddenCombo(combo), true, combo);
    assert.throws(() => keys.registerScope('x', { [combo]: () => {} }), /proibida/, combo);
  }
  for (const combo of ['?', '[', 'g o', 'j', 'shift+a', 'mod+k', 'escape', '1']) assert.equal(isForbiddenCombo(combo), false, combo);
  assert.deepEqual([...FORBIDDEN_KEYS].sort(), ['mod+d', 'mod+h', 'mod+j', 'mod+l', 'mod+n', 'mod+shift+d', 'mod+shift+o', 'mod+t', 'mod+w', 'tab']);
  assert.equal(eventCombo({ key: 'A', shiftKey: true }), 'shift+a'); assert.equal(eventCombo({ key: '?', shiftKey: true }), '?');
  assert.equal(eventCombo({ key: 'k', ctrlKey: true }), 'mod+k'); assert.equal(eventCombo({ key: 'ArrowDown' }), 'arrowdown');
});

// A page with a list of rows, a conversation and the controls the shortcuts click or focus.
function page({ singleKey = true } = {}) {
  const storage = new Map(), registry = createLiveRegistry();
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1' }), registry);
  if (!singleKey) storage.set('elozi:prefs:u1', JSON.stringify({ singleKey: false }));
  const store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const log = [];
  const control = (name, extra = {}) => ({ name, disabled: false, getAttribute: () => null, closest: () => null, getClientRects: () => [1], click() { log.push(['click', name]); }, focus() { log.push(['focus', name]); doc.activeElement = this; }, ...extra });
  const rows = ['r1', 'r2', 'r3'].map(id => control(id, { closest(selector) { return selector.includes('[data-conversation]') ? this : null; }, scrollIntoView() {} }));
  const controls = { '[data-action="takeover"]': [control('takeover')], '[data-action="conversation-close"]': [control('close', { disabled: true })], '#conversation-search': [control('search')], '[data-filter="mine"]': [control('mine')],
    [APPROVAL_FOCUS]: [control('approval')], '.sh-nav a[href^="#inbox"], .sh-bottombar a[href^="#inbox"], .sh-sheet a[href^="#inbox"]': [control('nav-inbox')], '#message-text': [control('composer')] };
  let listener = null;
  const doc = {
    activeElement: null, getElementById: id => id === 'messages' ? { tabIndex: 0, focus() { log.push(['focus', 'messages']); } } : null,
    addEventListener(name, fn) { if (name === 'keydown') listener = fn; },
    querySelector: () => null,
    querySelectorAll(selector) { if (selector.includes('#conversation-items [data-conversation]')) return rows; return controls[selector] || []; }
  };
  const keys = createKeyboard({ storage: store, registry });
  for (const scope of ['global', 'list', 'conversation', 'composer']) {
    // The default bindings of the panel's keyboard, on this private instance.
    keys.registerScope(scope, Object.fromEntries([...keyboardBindings(scope)]));
  }
  keys.setScope('inbox');
  keys.install(doc);
  const press = (key, target = doc.activeElement || { closest: () => null }, extra = {}) => { const event = { key, target, preventDefault() { this.prevented = true; }, ...extra }; listener(event); return event; };
  return { keys, doc, log, rows, press, storage };
}
// Bindings of the module's default keyboard (same functions), read through its private scopes.
function keyboardBindings(scope) { return keyboard.bindings(scope); }

test('atalhos de uma tecla agem nos controles da tela, só fora de campos, e podem ser desligados', () => {
  const p = page();
  p.press('j'); p.press('j');
  assert.deepEqual(p.log.slice(0, 2), [['focus', 'r1'], ['focus', 'r2']], 'j move o foco sem abrir');
  p.press('o', p.rows[1]);
  assert.deepEqual(p.log.at(-1), ['click', 'r2'], 'o abre a conversa em foco');
  p.press('a', { closest: () => null });
  assert.deepEqual(p.log.at(-1), ['click', 'takeover'], 'a assume quando o botão está na tela');
  const before = p.log.length;
  p.press('e', { closest: () => null });
  assert.equal(p.log.length, before, 'botão desabilitado: o atalho não faz nada');
  p.press('A', { closest: () => null }, { shiftKey: true });
  assert.deepEqual(p.log.at(-1), ['focus', 'approval'], 'Shift+A só leva o foco à aprovação; nunca aprova');
  const typing = { closest: selector => selector.includes('input') ? typing : null };
  const event = p.press('j', typing);
  assert.equal(event.prevented, undefined, 'dentro de campo editável a tecla é texto');
  p.press('g'); p.press('i');
  assert.deepEqual(p.log.at(-1), ['click', 'nav-inbox'], 'g depois i abre Atendimento');
  assert.equal(p.keys.singleKeyEnabled(), true);
  assert.equal(p.keys.setSingleKey(false), true);
  assert.equal(p.keys.singleKeyEnabled(), false);
  const count = p.log.length;
  p.press('j'); p.press('a', { closest: () => null });
  assert.equal(p.log.length, count, 'desligados: nenhuma tecla única age');
  assert.deepEqual(JSON.parse(p.storage.get('elozi:prefs:u1')), { singleKey: false }, 'preferência da pessoa em elozi:prefs:<userId>');
});

test('Esc sobe um nível (compositor → conversa) sem jogar o foco no body', () => {
  const p = page();
  const composer = { closest: selector => selector.includes('#message-text') ? composer : null };
  const event = p.press('Escape', composer);
  assert.equal(event.prevented, true);
  assert.deepEqual(p.log.at(-1), ['focus', 'messages']);
});

test('o teclado padrão do painel registra os escopos da especificação e começa sem atalhos ativos fora da página', () => {
  const scopes = keyboard.scopes();
  for (const scope of ['global', 'list', 'conversation', 'composer']) assert.ok(scopes.includes(scope), scope);
  assert.equal(createKeyboard().singleKeyEnabled(), false, 'sem página instalada nenhum atalho de uma tecla age');
});

test('Shift+A mira o título da aprovação (tabindex=-1), nunca um botão: Enter em seguida não decide nada', () => {
  assert.equal(APPROVAL_FOCUS, '.ui-approval__title[tabindex]');
  assert.doesNotMatch(APPROVAL_FOCUS, /button|data-action|approve|reject/);
  const rail = readFileSync(new URL('../public/agent-rail-ui.js', import.meta.url), 'utf8');
  assert.match(rail, /class="ui-approval__title"[^>]*tabindex="-1"/, 'o cartão do P4 deixa o título focável');
});
