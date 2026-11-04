// Composer v2 (FRONTEND-V2 §5.2.3, §8.4; P3): exactly two modes, the "Responder por" origin line with
// the company monogram, and the rule of inserting an agent draft (empty composer only; with text, ask
// Substituir | Acrescentar | Cancelar), with the 400 ms flash and the run that produced the text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';
import * as i18n from '../public/i18n.js';
import { createComposerBridge, composerModeMarkup, composerOriginMarkup, composerChoiceMarkup, composerSubmitLabel, channelNumberHint } from '../public/composer-ui.js';

const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));

function composer(text = '', { disabled = false } = {}) {
  const doc = createDocument(`<div class="pg-inbox__composer" data-mode="reply">${composerChoiceMarkup()}<form id="message-form"><textarea id="message-text"${disabled ? ' disabled' : ''}></textarea></form></div>`);
  const field = doc.getElementById('message-text'); field.value = text; field.disabled = disabled;
  const inputs = []; field.addEventListener('input', event => inputs.push(event.type));
  const timers = { pending: [], setTimeout(fn) { this.pending.push(fn); return this.pending.length; }, clearTimeout() {}, run() { for (const fn of this.pending.splice(0)) fn(); } };
  let mode = 'reply';
  const bridge = createComposerBridge({ doc, getMode: () => mode, timers });
  return { doc, field, inputs, timers, bridge, host: doc.querySelector('.pg-inbox__composer'), choice: doc.querySelector('[data-composer-choice]'), setMode: value => { mode = value; } };
}

test('dois modos apenas: Responder ao cliente e Nota interna, com rótulos de envio distintos', () => {
  const markup = String(composerModeMarkup('note'));
  assert.equal((markup.match(/type="radio"/g) || []).length, 2); assert.match(markup, /role="radiogroup"/);
  assert.match(markup, /value="reply"[^>]*\/><span class="ui-seg__label">Responder ao cliente/); assert.match(markup, /value="note" checked/);
  assert.equal(composerSubmitLabel('reply'), 'Enviar ao cliente'); assert.equal(composerSubmitLabel('note'), 'Salvar nota');
  assert.match(String(composerModeMarkup('reply', { disabled: true })), /disabled/);
  locale('en'); assert.match(String(composerModeMarkup('reply')), /Reply to customer[\s\S]*Internal note/); assert.equal(composerSubmitLabel('note'), 'Save note');
});

test('"Responder por" mostra monograma, empresa, canal e o final do número; a nota diz que só a equipe vê', () => {
  const reply = String(composerOriginMarkup({ mode: 'reply', tenant: { name: 'Loja <Centro>', brand: { accent: '#58c8aa' } }, channel: { name: 'WhatsApp Vendas', label: 'Número de teste · final 4471' } }));
  assert.match(reply, /Responder por/); assert.match(reply, /ui-company__mark/); assert.match(reply, /Loja &lt;Centro&gt;/); assert.match(reply, /WhatsApp Vendas/); assert.match(reply, /…4471/);
  assert.doesNotMatch(reply, /<Centro>/);
  const note = String(composerOriginMarkup({ mode: 'note', tenant: { name: 'Loja' } }));
  assert.match(note, /Nota interna/); assert.match(note, /visível só para a equipe/); assert.doesNotMatch(note, /Responder por/);
  assert.equal(channelNumberHint({ label: 'Webchat' }), ''); assert.equal(channelNumberHint({ label: 'Número de teste · final 1234' }), '…1234');
});

test('inserir rascunho num compositor vazio preenche, pisca 400 ms, foca e guarda o run de origem', async () => {
  const f = composer();
  assert.equal(await f.bridge.insertDraft('Oi, Maria!', { sourceRunId: 'run-1' }), 'inserted');
  assert.equal(f.field.value, 'Oi, Maria!'); assert.deepEqual(f.inputs, ['input']); assert.ok(f.doc.activeElement === f.field);
  assert.equal(f.host.hasAttribute('data-flash'), true); f.timers.run(); assert.equal(f.host.hasAttribute('data-flash'), false);
  assert.equal(f.bridge.sourceRunId, 'run-1'); assert.equal(f.choice.hidden, true);
  f.field.value = ''; assert.equal(f.bridge.sourceRunId, null, 'compositor esvaziado não leva o run no envio');
});

test('com texto, pergunta Substituir | Acrescentar | Cancelar e nunca troca o texto sozinho', async () => {
  for (const [choice, expected, value] of [['replace', 'replaced', 'Rascunho do agente'], ['append', 'appended', 'Meu texto\nRascunho do agente'], ['cancel', 'cancelled', 'Meu texto']]) {
    const f = composer('Meu texto');
    const pending = f.bridge.insertDraft('Rascunho do agente', { sourceRunId: 'run-2' });
    assert.equal(f.choice.hidden, false); assert.equal(f.field.value, 'Meu texto', 'nada muda antes da escolha');
    assert.match(f.choice.textContent, /Substituir[\s\S]*Acrescentar[\s\S]*Cancelar/);
    assert.ok(f.doc.activeElement === f.choice.querySelector('[data-choice="replace"]'));
    f.choice.querySelector(`[data-choice="${choice}"]`).click();
    assert.equal(await pending, expected); assert.equal(f.field.value, value); assert.equal(f.choice.hidden, true);
    assert.equal(f.bridge.sourceRunId, choice === 'cancel' ? null : 'run-2');
  }
  const f = composer('Texto');
  const pending = f.bridge.insertDraft('Outro');
  f.choice.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.equal(await pending, 'cancelled'); assert.equal(f.field.value, 'Texto');
});

test('cada pergunta responde só por si: o Esc de uma pergunta nova não é engolido pela anterior', async () => {
  const f = composer('Texto');
  const first = f.bridge.insertDraft('A');
  f.choice.querySelector('[data-choice="cancel"]').click();
  assert.equal(await first, 'cancelled');
  const second = f.bridge.insertDraft('B');
  assert.equal(f.choice.hidden, false);
  f.choice.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  const outcome = await Promise.race([second, new Promise(resolve => setTimeout(() => resolve('pendente'), 50))]);
  assert.equal(outcome, 'cancelled', 'a segunda pergunta resolve com o Esc'); assert.equal(f.choice.hidden, true);
  assert.equal((f.choice._listeners.get('keydown') || []).length, 0, 'nenhum ouvinte de tecla fica para trás');
  const third = f.bridge.insertDraft('C'); f.bridge.cancelChoice();
  assert.equal(await third, 'cancelled'); assert.equal((f.choice._listeners.get('keydown') || []).length, 0);
});

test('um novo pedido cancela a pergunta anterior; compositor ausente, desabilitado ou texto vazio recusa', async () => {
  const f = composer('Texto');
  const first = f.bridge.insertDraft('A'), second = f.bridge.insertDraft('B');
  assert.equal(await first, 'cancelled'); f.choice.querySelector('[data-choice="replace"]').click(); assert.equal(await second, 'replaced'); assert.equal(f.field.value, 'B');
  assert.equal(await composer('', { disabled: true }).bridge.insertDraft('X'), false);
  assert.equal(await composer().bridge.insertDraft('   '), false);
  assert.equal(await createComposerBridge({ doc: { querySelector: () => null } }).insertDraft('X'), false);
});

test('contrato do composerBridge: getText, setText (replace/append como digitação), focus, flash e mode', () => {
  const f = composer();
  assert.equal(f.bridge.getText(), ''); assert.equal(f.bridge.setText('Olá'), true); assert.equal(f.bridge.setText('Tudo bem?', { mode: 'append' }), true);
  assert.equal(f.bridge.getText(), 'Olá\nTudo bem?'); assert.deepEqual(f.inputs, ['input', 'input']);
  assert.equal(f.bridge.focus(), true); assert.equal(f.bridge.flash(), true); assert.equal(f.bridge.mode, 'reply'); f.setMode('note'); assert.equal(f.bridge.mode, 'note');
  f.field.disabled = true; assert.equal(f.bridge.setText('Não'), false);
});
