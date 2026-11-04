import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInboxTimeline } from '../public/inbox-live.js';

// Minimal DOM semantics used by the timeline: moving a node keeps its players,
// replacing a node creates new players, and scrollTop clamps to the visible end.
class MessageNode {
  constructor(markup) {
    this.dataset = { messageId: markup.match(/data-message-id="([^"]+)"/)[1] };
    this.textContent = markup.match(/<p>(.*?)<\/p>/)[1];
    this.meta = { textContent: markup.match(/class="message-meta">(.*?)<\/span>/)[1] };
    this.players = new Map([...markup.matchAll(/<(audio|video) src="([^"]+)">/g)].map(([, kind, src]) => [kind, { tagName: kind.toUpperCase(), src, currentTime: 0, paused: true, playbackRate: 1 }]));
    this.parentElement = null;
  }
  querySelector(selector) { return selector === '.message-meta' ? this.meta : this.players.get(selector) || null; }
  replaceWith(replacement) {
    const parent = this.parentElement;
    assert.ok(parent, 'replaceWith exige um nó conectado');
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, replacement); replacement.parentElement = parent; this.parentElement = null;
  }
  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
  }
}

class TimelineElement {
  constructor(nodes = []) {
    this.children = nodes; this.clientHeight = 200; this.position = 0;
    for (const node of nodes) node.parentElement = this;
  }
  get scrollHeight() { return Math.max(this.clientHeight, 40 + this.children.length * 120); }
  get scrollTop() { return Math.max(0, Math.min(this.position, this.scrollHeight - this.clientHeight)); }
  set scrollTop(value) { this.position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  insertBefore(node, current) {
    assert.ok(!current || current.parentElement === this, 'a âncora pertence ao container');
    if (node === current) return;
    node.remove();
    const index = current ? this.children.indexOf(current) : this.children.length;
    this.children.splice(index, 0, node); node.parentElement = this;
  }
}

function renderMessage(message) {
  const media = (message.attachments || []).filter(item => ['audio', 'video'].includes(item.kind)).map(item => `<${item.kind} src="${item.id}"></${item.kind}>`).join('');
  return `<article data-message-id="${message.id}"><p>${message.text}</p><span class="message-meta">${message.delivery || ''}</span>${media}</article>`;
}

function setup(t, messages = []) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'template');
      return {
        content: { firstElementChild: null, querySelector(selector) { return this.firstElementChild?.querySelector(selector) || null; } },
        set innerHTML(markup) { this.content.firstElementChild = new MessageNode(markup); }
      };
    }
  };
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const element = new TimelineElement(messages.map(message => new MessageNode(renderMessage(message))));
  const timeline = createInboxTimeline({ renderMessage }); timeline.bind(element, messages);
  return { element, timeline };
}

const message = (id, overrides = {}) => ({ id, kind: 'human', text: `Texto ${id}`, createdAt: '2026-10-02T12:00:00.000Z', delivery: 'pending', ...overrides });
const mediaMessages = () => [message('audio', { attachments: [{ id: 'audio-attachment', kind: 'audio' }] }), message('video', { attachments: [{ id: 'video-attachment', kind: 'video' }] })];
const play = (player, time, rate) => { player.currentTime = time; player.paused = false; player.playbackRate = rate; return player; };
const assertPlayback = (player, time, rate) => { assert.equal(player.currentTime, time); assert.equal(player.paused, false); assert.equal(player.playbackRate, rate); };

test('nova mensagem preserva os mesmos nós e reprodução dos players de áudio e vídeo', t => {
  const messages = mediaMessages(), { element, timeline } = setup(t, messages);
  const [audioNode, videoNode] = element.children;
  const audio = play(audioNode.querySelector('audio'), 14.5, 1.5), video = play(videoNode.querySelector('video'), 27, 2);
  const result = timeline.update(element, [...structuredClone(messages), message('incoming', { kind: 'user', delivery: undefined })]);
  assert.equal(result.added, 1); assert.equal(element.children.length, 3);
  assert.strictEqual(element.children[0], audioNode); assert.strictEqual(element.children[1], videoNode);
  assert.strictEqual(element.children[0].querySelector('audio'), audio); assert.strictEqual(element.children[1].querySelector('video'), video);
  assertPlayback(audio, 14.5, 1.5); assertPlayback(video, 27, 2);
  assert.equal(element.children[2].dataset.messageId, 'incoming');
});

test('alterar somente delivery atualiza recibo e mantém mensagem, meta e players em reprodução', t => {
  const messages = mediaMessages(), { element, timeline } = setup(t, messages);
  const originalNodes = [...element.children], originalMeta = originalNodes.map(node => node.meta);
  const audio = play(originalNodes[0].querySelector('audio'), 9, 1.5), video = play(originalNodes[1].querySelector('video'), 19, 2);
  for (const delivery of ['sent', 'delivered', 'read']) {
    const result = timeline.update(element, messages.map(item => ({ ...item, delivery })));
    assert.equal(result.added, 0);
    for (const [index, node] of element.children.entries()) {
      assert.strictEqual(node, originalNodes[index]); assert.strictEqual(node.meta, originalMeta[index]); assert.equal(node.meta.textContent, delivery);
    }
    assert.strictEqual(element.children[0].querySelector('audio'), audio); assert.strictEqual(element.children[1].querySelector('video'), video);
    assertPlayback(audio, 9, 1.5); assertPlayback(video, 19, 2);
  }
});

test('texto realmente alterado substitui só a mensagem afetada e mostra conteúdo novo', t => {
  const messages = mediaMessages(), { element, timeline } = setup(t, messages);
  const [originalAudioNode, originalVideoNode] = element.children;
  const originalAudio = originalAudioNode.querySelector('audio'), video = play(originalVideoNode.querySelector('video'), 20, 1.5);
  const changed = [{ ...messages[0], text: 'Texto revisado' }, messages[1]];
  const result = timeline.update(element, changed);
  assert.equal(result.added, 0);
  assert.notStrictEqual(element.children[0], originalAudioNode); assert.notStrictEqual(element.children[0].querySelector('audio'), originalAudio);
  assert.equal(element.children[0].textContent, 'Texto revisado'); assert.equal(originalAudioNode.parentElement, null);
  assert.strictEqual(element.children[1], originalVideoNode); assert.strictEqual(element.children[1].querySelector('video'), video); assertPlayback(video, 20, 1.5);
  const replacement = element.children[0]; timeline.update(element, changed);
  assert.strictEqual(element.children[0], replacement, 'atualização idêntica não volta a substituir');
});

test('leitura de mensagens antigas preserva scroll e posição quando outra mensagem chega', t => {
  const messages = Array.from({ length: 6 }, (_, index) => message(`old-${index}`));
  const { element, timeline } = setup(t, messages); element.scrollTop = 120;
  const oldScroll = element.scrollTop, originalNode = element.children[1];
  const result = timeline.update(element, [...messages, message('latest')]);
  assert.equal(result.nearBottom, false); assert.equal(element.scrollTop, oldScroll); assert.strictEqual(element.children[1], originalNode);
  timeline.update(element, [...messages, message('latest', { delivery: 'read' })]);
  assert.equal(element.scrollTop, oldScroll, 'recibo também preserva a leitura antiga');
});

test('perto do fim acompanha a nova mensagem até o fim visível', t => {
  const messages = Array.from({ length: 6 }, (_, index) => message(`recent-${index}`));
  const { element, timeline } = setup(t, messages);
  element.scrollTop = element.scrollHeight - element.clientHeight - 20;
  const oldBottom = element.scrollHeight - element.clientHeight;
  const result = timeline.update(element, [...messages, message('last')]);
  assert.equal(result.nearBottom, true); assert.ok(element.scrollTop > oldBottom);
  assert.equal(element.scrollTop, element.scrollHeight - element.clientHeight);
});

test('remoção reconcilia IDs sem recriar players das mensagens preservadas', t => {
  const messages = [...mediaMessages(), message('removed')], { element, timeline } = setup(t, messages);
  const [audioNode, videoNode, removedNode] = element.children;
  const audio = play(audioNode.querySelector('audio'), 11, 1.5), video = play(videoNode.querySelector('video'), 21, 2);
  const result = timeline.update(element, messages.slice(0, 2));
  assert.equal(result.added, 0); assert.deepEqual(element.children.map(node => node.dataset.messageId), ['audio', 'video']);
  assert.strictEqual(element.children[0], audioNode); assert.strictEqual(element.children[1], videoNode); assert.equal(removedNode.parentElement, null);
  assertPlayback(audio, 11, 1.5); assertPlayback(video, 21, 2);
  timeline.update(element, []); assert.equal(element.children.length, 0); assert.equal(audioNode.parentElement, null); assert.equal(videoNode.parentElement, null);
});

test('reordenação reconcilia os IDs na ordem atual sem deixar nós duplicados', t => {
  const messages = [message('one'), message('two'), message('three')], { element, timeline } = setup(t, messages);
  timeline.update(element, [messages[2], messages[0], messages[1]]);
  assert.deepEqual(element.children.map(node => node.dataset.messageId), ['three', 'one', 'two']);
  assert.equal(new Set(element.children).size, 3); assert.equal(element.children.every(node => node.parentElement === element), true);
});

test('bind de outro contexto isola snapshots e preserva seus próprios nós mesmo com IDs repetidos', t => {
  const messages = mediaMessages(), { element: firstElement, timeline } = setup(t, messages);
  const firstNode = firstElement.children[0];
  const otherMessages = [message('audio', { text: 'Outro atendimento', attachments: [{ id: 'other-audio', kind: 'audio' }] })];
  const secondElement = new TimelineElement(otherMessages.map(item => new MessageNode(renderMessage(item)))), secondNode = secondElement.children[0];
  const player = play(secondNode.querySelector('audio'), 12, 1.5);
  timeline.bind(secondElement, otherMessages);
  timeline.update(secondElement, otherMessages.map(item => ({ ...item, delivery: 'read' })));
  assert.strictEqual(secondElement.children[0], secondNode); assert.notStrictEqual(secondElement.children[0], firstNode);
  assert.equal(secondNode.textContent, 'Outro atendimento'); assertPlayback(player, 12, 1.5);
  assert.strictEqual(firstElement.children[0], firstNode); assert.equal(firstNode.parentElement, firstElement);
});

test('troca automática de elemento e reset descartam snapshots do contexto anterior', t => {
  const messages = [message('same-id')], { element, timeline } = setup(t, messages);
  const otherElement = new TimelineElement([new MessageNode(renderMessage(message('same-id', { text: 'Conteúdo anterior' })))]);
  const previous = otherElement.children[0];
  timeline.update(otherElement, [message('same-id', { text: 'Conteúdo do novo contexto' })]);
  assert.notStrictEqual(otherElement.children[0], previous); assert.equal(otherElement.children[0].textContent, 'Conteúdo do novo contexto');
  assert.equal(element.children[0].textContent, 'Texto same-id');
  const beforeReset = otherElement.children[0]; timeline.reset();
  timeline.update(otherElement, [message('same-id', { text: 'Conteúdo do novo contexto' })]);
  assert.notStrictEqual(otherElement.children[0], beforeReset); assert.equal(beforeReset.parentElement, null);
  assert.deepEqual(timeline.update(null, messages), { added: 0, nearBottom: false });
});

test('timeline inicial vazia recebe mensagens com os players e a ordem corretos', t => {
  const { element, timeline } = setup(t), messages = mediaMessages();
  const result = timeline.update(element, messages);
  assert.equal(result.added, 2); assert.deepEqual(element.children.map(node => node.dataset.messageId), ['audio', 'video']);
  assert.equal(element.children[0].querySelector('audio').src, 'audio-attachment'); assert.equal(element.children[1].querySelector('video').src, 'video-attachment');
  assert.equal(element.scrollTop, element.scrollHeight - element.clientHeight);
});

// ---------------------------------------------------------------------------------------------
// Atendimento v2 (FRONTEND-V2 §5.2.3, P3): window of 60 messages with "Carregar anteriores", role=log
// announced only for received messages, inline agent receipts by time and the "N novas ↓" pill.
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';
import { TIMELINE_WINDOW } from '../public/inbox-live.js';

function windowed(t, count, { extras = () => [] } = {}) {
  const previous = globalThis.document;
  const doc = createDocument('<div id="messages" role="log" aria-live="polite"></div><button id="pill" hidden><span data-unseen-label></span></button>');
  globalThis.document = doc;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const timers = { pending: [], setTimeout(fn) { this.pending.push(fn); return this.pending.length; }, clearTimeout() {}, run() { for (const fn of this.pending.splice(0)) fn(); } };
  const render = (message, previousMessage) => `<div class="message-entry" data-message-id="${message.id}">${previousMessage ? '' : '<span class="day">Dia</span>'}<p>${message.text}</p><small class="message-meta">${message.delivery || ''}</small></div>`;
  const timeline = createInboxTimeline({ renderMessage: render, extras, pill: () => doc.getElementById('pill'), timers });
  const list = Array.from({ length: count }, (_, index) => ({ id: `m${index}`, kind: index % 2 ? 'human' : 'customer', text: `Mensagem ${index}`, createdAt: new Date(Date.UTC(2026, 9, 6, 10, 0, index)).toISOString() }));
  const element = doc.getElementById('messages');
  element.innerHTML = timeline.markup(list, 't:c');
  timeline.bind(element, list);
  const ids = () => element.children.map(node => node.dataset.messageId);
  return { doc, element, timeline, list, ids, timers };
}

test('janela de 60: as últimas 60 na tela, "Carregar anteriores" abre mais 60 e a âncora de leitura fica', t => {
  const f = windowed(t, 130);
  assert.equal(TIMELINE_WINDOW, 60);
  assert.equal(f.ids()[0], '__earlier'); assert.equal(f.ids().length, 61); assert.equal(f.ids()[1], 'm70'); assert.equal(f.ids().at(-1), 'm129');
  assert.match(f.element.children[0].textContent, /Carregar anteriores \(70\)/); assert.match(f.element.children[0].innerHTML, /data-action="inbox:earlier"/);
  assert.match(f.element.children[1].innerHTML, /Dia/, 'a primeira mensagem visível mostra o dia');
  const anchor = f.element.children[2]; f.element.scrollTop = 0;
  assert.equal(f.timeline.showEarlier(f.element, f.list), 60);
  assert.equal(f.ids()[1], 'm10'); assert.equal(f.ids().length, 121); assert.match(f.element.children[0].textContent, /\(10\)/);
  assert.ok(f.element.querySelector('[data-message-id="m71"]') === anchor, 'a mensagem que a pessoa lia continua o mesmo nó');
  assert.doesNotMatch(f.element.querySelector('[data-message-id="m70"]').innerHTML, /Dia/, 'o divisor do dia sobe com o novo topo da janela');
  assert.equal(f.element.scrollTop, 6000, 'a rolagem compensa o que entrou acima (60 × 100 px)');
  assert.equal(f.timeline.unseen, 0, 'mensagens antigas não contam como novas'); assert.equal(f.element.querySelector('[data-enter]'), null, 'nem animam');
  f.timeline.showEarlier(f.element, f.list); assert.equal(f.ids()[0], 'm0', 'sem mais anteriores, o botão some');
});

test('"Carregar anteriores" guarda o mesmo nó (e o foco) enquanto restam mensagens; só a contagem muda', t => {
  const f = windowed(t, 190);
  const control = f.element.children[0], button = control.querySelector('[data-action="inbox:earlier"]');
  button.focus();
  f.timeline.showEarlier(f.element, f.list);
  assert.ok(f.element.children[0] === control, 'o mesmo nó do controle'); assert.match(control.textContent, /Carregar anteriores \(70\)/);
  assert.ok(f.doc.activeElement === button, 'o foco continua no botão');
  f.timeline.showEarlier(f.element, f.list); assert.match(control.textContent, /\(10\)/); assert.ok(f.doc.activeElement === button);
});

test('mensagens que chegam não empurram a janela e entram animadas abaixo do que já estava na tela', t => {
  const f = windowed(t, 80);
  f.element.scrollTop = f.element.scrollHeight;
  const next = [...f.list, { id: 'm80', kind: 'customer', text: 'Nova', createdAt: '2026-10-06T10:02:00.000Z' }];
  const result = f.timeline.update(f.element, next);
  assert.equal(result.added, 1); assert.equal(result.incoming, 1); assert.equal(f.ids()[1], 'm20', 'a janela continua ancorada');
  assert.equal(f.element.lastElementChild.dataset.messageId, 'm80'); assert.equal(f.element.lastElementChild.hasAttribute('data-enter'), true);
  f.timers.run(); assert.equal(f.element.lastElementChild.hasAttribute('data-enter'), false);
});

test('role=log anuncia só mensagens recebidas: o que sai da equipe entra com aria-live=off', t => {
  const f = windowed(t, 4);
  f.element.scrollTop = f.element.scrollHeight;
  f.timeline.update(f.element, [...f.list, { id: 'mine', kind: 'human', text: 'Resposta', createdAt: '2026-10-06T10:05:00.000Z' }]);
  assert.equal(f.element.getAttribute('aria-live'), 'off'); f.timers.run(); assert.equal(f.element.getAttribute('aria-live'), 'polite');
  f.timeline.update(f.element, [...f.list, { id: 'mine', kind: 'human', text: 'Resposta', createdAt: '2026-10-06T10:05:00.000Z' }, { id: 'in', kind: 'customer', text: 'Oi', createdAt: '2026-10-06T10:06:00.000Z' }]);
  assert.equal(f.element.getAttribute('aria-live'), 'polite', 'mensagem do cliente é anunciada');
});

test('lendo o histórico, nada rola sozinho e a pílula "N novas" conta o que chegou; no fim ela some', t => {
  const f = windowed(t, 10);
  f.element.scrollTop = 0;
  const more = [...f.list, { id: 'a', kind: 'customer', text: 'A', createdAt: '2026-10-06T11:00:00.000Z' }, { id: 'b', kind: 'customer', text: 'B', createdAt: '2026-10-06T11:01:00.000Z' }];
  const result = f.timeline.update(f.element, more);
  assert.equal(result.nearBottom, false); assert.equal(f.element.scrollTop, 0);
  const pill = f.doc.getElementById('pill');
  assert.equal(pill.hidden, false); assert.equal(pill.querySelector('[data-unseen-label]').textContent, '2 novas'); assert.equal(f.timeline.unseen, 2);
  f.element.scrollTop = f.element.scrollHeight; f.element.dispatchEvent(new FakeEvent('scroll'));
  assert.equal(pill.hidden, true); assert.equal(f.timeline.unseen, 0);
});

test('recibos do trilho do agente entram intercalados pelo horário, sem que a timeline desenhe estado de run', t => {
  const receipts = [{ id: 'r1', at: '2026-10-06T10:00:01.500Z', markup: '<p class="receipt-p4">✦ Consulta automática</p>' }];
  const f = windowed(t, 4, { extras: () => receipts });
  assert.deepEqual(f.ids(), ['m0', 'm1', 'receipt:r1', 'm2', 'm3']);
  assert.match(f.element.children[2].innerHTML, /receipt-p4/);
  const node = f.element.children[2]; f.timeline.update(f.element, f.list);
  assert.ok(f.element.children[2] === node, 'recibo igual não é recriado');
});

test('a conversa abre na última mensagem e segue o fim enquanto carrega, até a pessoa rolar para cima', () => {
  const listeners = new Map();
  const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400, isConnected: true, addEventListener(type, handler) { listeners.set(type, handler); } };
  const timeline = createInboxTimeline({ renderMessage: () => '' });
  timeline.pin(element);
  assert.equal(element.scrollTop, 1000, 'abre no fim');
  element.scrollHeight = 1600; listeners.get('load')();
  assert.equal(element.scrollTop, 1600, 'foto carregada depois mantém o fim');
  element.scrollHeight = 1700; listeners.get('loadedmetadata')();
  assert.equal(element.scrollTop, 1700, 'vídeo que recebe o tamanho também');
  element.scrollTop = 200; listeners.get('scroll')();
  element.scrollHeight = 2000; listeners.get('load')();
  assert.equal(element.scrollTop, 200, 'quem rolou para ler não é puxado');
  element.scrollTop = 1600 - 0; element.scrollHeight = 2000; element.scrollTop = 2000 - 400; listeners.get('scroll')();
  element.scrollHeight = 2300; listeners.get('load')();
  assert.equal(element.scrollTop, 2300, 'voltando ao fim, segue de novo');
  timeline.pin(element); assert.equal(element.scrollTop, 2300, 'religar o mesmo elemento respeita a escolha');
});

test('presa no fim, a conversa acompanha o tamanho da timeline e de cada mensagem, e a mensagem nova também', t => {
  const observers = [], previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); } observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } };
  t.after(() => { if (previous === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous; });
  const f = windowed(t, 10);
  f.timeline.pin(f.element);
  assert.equal(f.element.scrollTop, 600, 'abre no fim');
  const sizes = observers.at(-1);
  assert.ok(sizes.targets.has(f.element) && f.element.children.every(child => sizes.targets.has(child)), 'observa a timeline e cada mensagem');
  f.element.clientHeight = 250; sizes.callback([]);
  assert.equal(f.element.scrollTop, 750, 'compositor maior: continua no fim');
  f.element.clientHeight = 100;
  const result = f.timeline.update(f.element, [...f.list, { id: 'n', kind: 'customer', text: 'Nova', createdAt: '2026-10-06T11:00:00.000Z' }]);
  assert.equal(result.nearBottom, true); assert.equal(f.element.scrollTop, 1000, 'a mensagem nova aparece'); assert.equal(f.timeline.unseen, 0);
});

test('as mensagens da conversa não usam altura provisória (content-visibility), que tirava a abertura do fim', () => {
  const css = readFileSync(new URL('../public/screen-inbox.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[^]*?\*\//g, ''), /content-visibility|contain-intrinsic-size/);
});
