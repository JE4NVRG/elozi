// Keyed patch of live regions (FRONTEND-V2 §5.2.2, §7.5; P3): the same nodes, ids and focus survive
// the updates; only what changed is written; a frozen order holds new keys back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './helpers/inbox-dom.js';
import { patchKeyed, patchNode, syncAttributes, replaceWithMarkup, elementFromMarkup, markRendered } from '../public/dom-patch.js';

const row = (key, text, extra = '') => ({ key, markup: `<div role="option" id="${key}" tabindex="-1"${extra}><span>${text}</span></div>` });
const keys = parent => parent.children.map(node => node.id);

test('patchKeyed cria, atualiza no lugar, reordena e remove por chave', () => {
  const doc = createDocument('<div id="list"></div>'), list = doc.getElementById('list');
  let result = patchKeyed(list, [row('a', 'A'), row('b', 'B'), row('c', 'C')]);
  assert.deepEqual(keys(list), ['a', 'b', 'c']); assert.equal(result.added.length, 3);
  const [a, b, c] = list.children;
  result = patchKeyed(list, [row('c', 'C'), row('a', 'A2'), row('d', 'D')]);
  assert.deepEqual(keys(list), ['c', 'a', 'd']);
  assert.ok(list.children[0] === c, 'a linha que fica mantém o nó'); assert.ok(list.children[1] === a, 'texto novo, mesmo nó');
  assert.equal(a.textContent, 'A2'); assert.equal(b.parentNode, null, 'a linha que saiu foi removida');
  assert.deepEqual(result.removed, ['b']); assert.deepEqual(result.updated, ['a']); assert.equal(result.added.length, 1);
});

test('marcação idêntica não escreve nada no nó (nem atributo nem conteúdo)', () => {
  const doc = createDocument('<div id="list"></div>'), list = doc.getElementById('list');
  patchKeyed(list, [row('a', 'A')]);
  const node = list.firstElementChild;
  let writes = 0;
  const original = node.setAttribute.bind(node);
  node.setAttribute = (...args) => { writes++; return original(...args); };
  Object.defineProperty(node, 'innerHTML', { set() { writes++; }, get() { return '<span>A</span>'; } });
  const result = patchKeyed(list, [row('a', 'A')]);
  assert.equal(writes, 0); assert.deepEqual(result.updated, []);
});

test('o foco sobrevive a três atualizações quando a linha focada fica', () => {
  const doc = createDocument('<div id="list"></div>'), list = doc.getElementById('list');
  patchKeyed(list, [row('a', 'A'), row('b', 'B')]);
  const focused = doc.getElementById('b'); focused.focus();
  for (const label of ['B1', 'B2', 'B3']) patchKeyed(list, [row('a', 'A'), row('b', label)], { freeze: true });
  assert.ok(doc.activeElement === focused); assert.ok(doc.getElementById('b') === focused); assert.equal(focused.textContent, 'B3');
});

test('ordem congelada mantém a posição e segura chaves novas em pending', () => {
  const doc = createDocument('<div id="list"></div>'), list = doc.getElementById('list');
  patchKeyed(list, [row('a', 'A'), row('b', 'B')]);
  const result = patchKeyed(list, [row('n', 'Nova'), row('b', 'B'), row('a', 'A')], { freeze: true });
  assert.deepEqual(keys(list), ['a', 'b'], 'nada se move sob o ponteiro ou o foco'); assert.deepEqual(result.pending, ['n']); assert.deepEqual(result.moved, []);
  const applied = patchKeyed(list, [row('n', 'Nova'), row('b', 'B'), row('a', 'A')]);
  assert.deepEqual(keys(list), ['n', 'b', 'a']); assert.deepEqual(applied.pending, []);
});

test('mover um nó focado perde o foco (por isso a lista congela com foco), e keep preserva atributos vivos', () => {
  const doc = createDocument('<div id="list"></div>'), list = doc.getElementById('list');
  patchKeyed(list, [row('a', 'A'), row('b', 'B')]);
  doc.getElementById('b').focus();
  patchKeyed(list, [row('b', 'B'), row('a', 'A')]);
  assert.equal(doc.activeElement, doc.body, 'o DOM de teste reproduz a regra do navegador');
  const node = doc.getElementById('a'); node.setAttribute('tabindex', '0');
  patchKeyed(list, [row('b', 'B'), row('a', 'A*')], { keep: ['tabindex'] });
  assert.equal(node.getAttribute('tabindex'), '0'); assert.equal(node.textContent, 'A*');
});

test('filhos sem chave (estado vazio) saem quando chegam linhas', () => {
  const doc = createDocument('<div id="list"><p class="empty">Nada</p></div>'), list = doc.getElementById('list');
  patchKeyed(list, [row('a', 'A')]);
  assert.deepEqual(keys(list), ['a']);
});

test('patchNode sincroniza atributos e conteúdo; syncAttributes remove o que saiu', () => {
  const doc = createDocument('<section id="s" data-x="1" hidden><b>old</b></section>'), node = doc.getElementById('s');
  assert.equal(patchNode(node, '<section id="s" data-y="2"><i>new</i></section>'), true);
  assert.equal(node.hasAttribute('hidden'), false); assert.equal(node.getAttribute('data-x'), null); assert.equal(node.getAttribute('data-y'), '2'); assert.equal(node.innerHTML, '<i>new</i>');
  assert.equal(patchNode(node, '<section id="s" data-y="2"><i>new</i></section>'), false, 'mesma marcação: nenhuma escrita');
  assert.equal(patchNode(node, '<div id="s"></div>'), false, 'outra tag não é trocada às escondidas');
  const target = doc.createElement('p'); target.setAttribute('a', '1'); target.setAttribute('keep', 'me');
  const source = elementFromMarkup(doc, '<p b="2"></p>');
  assert.equal(syncAttributes(target, source, { keep: ['keep'] }), 2); assert.deepEqual(target.attributes.map(item => item.name).sort(), ['b', 'keep']);
  assert.equal(markRendered(target, '<p></p>'), target);
});

test('replaceWithMarkup troca o elemento inteiro e ignora nós soltos ou marcação vazia', () => {
  const doc = createDocument('<div id="old">x</div>'), old = doc.getElementById('old');
  const fresh = replaceWithMarkup(old, '<section id="new">y</section>');
  assert.equal(fresh.id, 'new'); assert.equal(old.parentNode, null); assert.equal(replaceWithMarkup(old, '<p></p>'), null);
  assert.equal(replaceWithMarkup(fresh, ''), null); assert.ok(doc.getElementById('new') === fresh);
});
