import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepliesUI, quickRepliesScreen, quickRepliesResults, quickRepliesCount, quickReplyEditorForm, quickReplyPreview, readQuickReplyForm, filterQuickReplies, QUICK_REPLY_LIMITS } from '../public/replies-ui.js';
import { setLocale } from '../public/i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const message = (id = 'original', extra = {}) => ({ id, kind: 'customer', senderName: 'Cliente', text: 'Mensagem original', ...extra });
const actor = (conversationId = 'one', extra = {}) => ({ workspaceId: 'workspace', tenantId: 'tenant', conversationId, messages: [message()], ...extra });
const item = (extra = {}) => ({ id: 'welcome', shortcut: 'ola', title: 'Boas-vindas', text: 'Olá!', version: 3, active: true, ...extra });
function setup() {
  const ui = createRepliesUI({ escape, icon: name => `<svg data-icon="${name}" aria-hidden="true"></svg>` });
  ui.syncContext(actor());
  return ui;
}
function textarea(value, extra = {}) {
  return {
    value, maxLength: 4000, selectionStart: value.length, selectionEnd: value.length, disabled: false,
    events: [], focusCount: 0, focus() { this.focusCount++; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    dispatchEvent(event) { this.events.push(event); }, ...extra
  };
}
function mockDocument(t, document) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
}

test('inserção no cursor conserva texto antes/depois e a seleção anterior', () => {
  const ui = setup(), field = textarea('Antes depois', { selectionStart: 6, selectionEnd: 12 });
  assert.deepEqual(ui.insert(item({ text: 'Olá! ' }), field), { ok: true, value: 'Antes Olá! depois', cursor: 11, inserted: 5 });
  assert.equal(field.selectionStart, 11); assert.equal(field.selectionEnd, 11);
  assert.equal(field.focusCount, 1);
  assert.deepEqual(field.events.map(event => event.type), ['input']);
  assert.equal(field.events[0].bubbles, true);
});

test('limite de legenda recusa a resposta inteira sem alterar texto ou cursor', () => {
  const ui = setup(), field = textarea('x'.repeat(1020), { maxLength: 1024, selectionStart: 9, selectionEnd: 13 });
  const result = ui.insert(item({ text: 'abcde' }), field);
  assert.equal(result.ok, false); assert.match(result.error, /1\.024/);
  assert.equal(field.value, 'x'.repeat(1020)); assert.equal(field.selectionStart, 9); assert.equal(field.selectionEnd, 13);
  assert.equal(field.events.length, 0); assert.equal(field.focusCount, 0);
  assert.equal(ui.insert(item({ text: 'abcd' }), field).ok, true);
  assert.equal(field.value.length, 1024);
});

test('inserção conta unidades UTF-16 como maxlength do navegador e não envia automaticamente', () => {
  const ui = setup(), field = textarea('abc', { maxLength: 4 });
  assert.equal(ui.insert(item({ text: '🙂' }), field).ok, false);
  assert.equal(field.value, 'abc');
  field.maxLength = 5;
  assert.equal(ui.insert(item({ text: '🙂' }), field).ok, true);
  assert.equal(field.value, 'abc🙂');
  assert.deepEqual(field.events.map(event => event.type), ['input']);
});

test('resposta desativada, vazia e campo bloqueado não alteram rascunho', () => {
  const ui = setup(), field = textarea('Revisão');
  assert.equal(ui.insert(item({ active: false }), field).ok, false);
  assert.equal(ui.insert(item({ text: ' \n ' }), field).ok, false);
  field.disabled = true; assert.equal(ui.insert(item(), field).ok, false);
  field.disabled = false; field.readOnly = true; assert.equal(ui.insert(item(), field).ok, false);
  assert.equal(field.value, 'Revisão'); assert.equal(field.events.length, 0);
  ui.reset(); field.readOnly = false; assert.equal(ui.insert(item(), field).ok, false);
});

test('referências por conversa em RAM voltam após navegação sem reutilizar corpos de outra conversa', () => {
  const ui = setup(); assert.equal(ui.selectQuote('original'), true);
  ui.syncContext(actor('two', { messages: [message('second', { text: 'Mensagem dois' })] }));
  assert.equal(ui.replyToMessageId, null); assert.doesNotMatch(ui.quoteComposer(), /Mensagem original/);
  ui.selectQuote('second');
  ui.syncContext(actor()); assert.equal(ui.replyToMessageId, 'original');
  assert.match(ui.quoteComposer(), /Mensagem original/); assert.doesNotMatch(ui.quoteComposer(), /Mensagem dois/);
  ui.syncContext(actor('two', { messages: [message('second')] })); assert.equal(ui.replyToMessageId, 'second');
});

test('sair do atendimento preserva referência e mudar empresa/workspace elimina contexto privado', () => {
  const ui = setup(); ui.selectQuote('original');
  ui.syncContext(actor('one', { active: false })); assert.equal(ui.replyToMessageId, null);
  ui.syncContext(actor()); assert.equal(ui.replyToMessageId, 'original');
  ui.syncContext(actor('one', { tenantId: 'other' })); assert.equal(ui.replyToMessageId, null); assert.equal(ui.draftCount, 0);
  ui.selectQuote('original'); ui.syncContext(actor('one', { workspaceId: 'other-workspace', tenantId: 'other' }));
  assert.equal(ui.replyToMessageId, null); assert.equal(ui.draftCount, 0);
  ui.syncContext(actor()); assert.equal(ui.replyToMessageId, null);
});

test('revogação elimina a referência revogada e impede restaurá-la de mensagens antigas', () => {
  const ui = setup(); ui.selectQuote('original');
  ui.syncContext(actor('two')); ui.selectQuote('original');
  assert.equal(ui.retainConversations(['two']), true); assert.equal(ui.draftCount, 1);
  assert.equal(ui.syncContext(actor('one')), false); assert.equal(ui.replyToMessageId, null);
  assert.equal(ui.selectQuote('original'), false);
  assert.equal(ui.syncContext(actor('two')), true); assert.equal(ui.replyToMessageId, 'original');
  assert.equal(ui.retainConversations([]), false); assert.equal(ui.replyToMessageId, null); assert.equal(ui.draftCount, 0);
  assert.doesNotMatch(ui.quoteComposer(), /Mensagem original/);
  assert.equal(ui.syncContext(actor('two')), false);
});

test('syncContext aplica lista autorizada inclusive na seleção atual', () => {
  const ui = setup(); ui.selectQuote('original');
  assert.equal(ui.syncContext(actor(), []), false); assert.equal(ui.replyToMessageId, null);
  assert.equal(ui.syncContext(actor(), ['one']), true); assert.equal(ui.replyToMessageId, null);
});

test('sistema e IDs de outra conversa não podem ser citados, falha conserva referência válida', () => {
  const ui = setup(); ui.selectQuote('original');
  ui.syncContext(actor('one', { messages: [message(), message('sys', { kind: 'system', text: 'Evento interno' }), message('foreign', { conversationId: 'other', text: 'Segredo externo' })] }));
  assert.equal(ui.selectQuote('sys'), false); assert.equal(ui.selectQuote('foreign'), false);
  assert.equal(ui.replyToMessageId, 'original');
  assert.equal(ui.messageReplyButton(message('sys', { kind: 'system' })), '');
  assert.equal(ui.messageReplyButton(message('foreign', { conversationId: 'other' })), '');
  assert.equal(ui.messageQuote(message('foreign', { conversationId: 'other', replyToMessageId: 'original' })), '');
  assert.doesNotMatch(ui.quoteComposer(), /Evento interno|Segredo externo/);
});

test('mensagens pendentes, falhas ou de envio incerto não geram referência e status confirmado habilita', () => {
  const ui = setup(), invalid = ['pending', 'failed', 'unconfirmed'].map(delivery => message(delivery, { kind: 'human', delivery }));
  ui.syncContext(actor('one', { messages: [...invalid, message('bot', { kind: 'agent' }), message('sent', { kind: 'human', delivery: 'sent' })] }));
  for (const value of [...invalid, message('bot', { kind: 'agent' })]) {
    assert.equal(ui.selectQuote(value.id), false); assert.equal(ui.messageReplyButton(value), '');
  }
  assert.equal(ui.selectQuote('sent'), true);
  assert.match(ui.messageReplyButton(message('sent', { kind: 'human', delivery: 'sent' })), /Responder/);
  assert.match(ui.messageQuote(message('next', { kind: 'human', delivery: 'pending', replyToMessageId: 'sent' })), /data-id="sent"/);
});

test('referência removida da conversa é invalidada e citação recebida indisponível não confia em corpo externo', () => {
  const ui = setup(); ui.selectQuote('original'); ui.syncContext(actor('one', { messages: [] }));
  assert.equal(ui.replyToMessageId, null); assert.equal(ui.draftCount, 0);
  assert.match(ui.quoteComposer(), /não está mais disponível/);
  const quote = ui.messageQuote(message('reply', { replyToMessageId: 'original', quote: { text: 'Texto de outra empresa' } }));
  assert.match(quote, /indisponível nesta conversa/); assert.doesNotMatch(quote, /Texto de outra empresa|data-reply-action/);
});

test('limite de 200 contextos recusa somente referência nova e conserva as anteriores', () => {
  const ui = setup();
  for (let index = 0; index < 200; index++) { ui.syncContext(actor(`conversation-${index}`)); assert.equal(ui.selectQuote('original'), true); }
  ui.syncContext(actor('overflow')); assert.equal(ui.selectQuote('original'), false);
  assert.equal(ui.draftCount, 200); assert.match(ui.error, /200 referências/);
  ui.syncContext(actor('conversation-0')); assert.equal(ui.replyToMessageId, 'original');
  ui.clearQuote(); assert.equal(ui.draftCount, 199);
  ui.syncContext(actor('overflow')); assert.equal(ui.selectQuote('original'), true); assert.equal(ui.draftCount, 200);
});

test('clearSent só remove a referência atual e reset apaga todas', () => {
  const ui = setup(); ui.selectQuote('original'); ui.syncContext(actor('two')); ui.selectQuote('original');
  ui.clearSent(); assert.equal(ui.replyToMessageId, null); assert.equal(ui.status, ''); assert.equal(ui.draftCount, 1);
  ui.syncContext(actor()); assert.equal(ui.replyToMessageId, 'original');
  ui.reset(); ui.syncContext(actor()); assert.equal(ui.replyToMessageId, null); assert.equal(ui.draftCount, 0);
});

test('citações escapam autor, ID, texto e nomes de anexos sem HTML executável', () => {
  const ui = setup(), id = '" onclick="bad()', original = message(id, { senderName: '<img src=x onerror=bad()>', text: '<script>bad()</script>' });
  ui.syncContext(actor('one', { messages: [original] })); ui.selectQuote(id);
  const html = ui.quoteComposer() + ui.messageQuote(message('reply', { replyToMessageId: id })) + ui.messageReplyButton(original);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.match(html, /data-id="&quot; onclick=&quot;bad\(\)"/); assert.doesNotMatch(html, /<script>|<img |data-id="" onclick/);
  ui.syncContext(actor('one', { messages: [message('audio', { text: '', attachments: [{ mime: 'audio/ogg', name: '<svg onload=bad()>' }] })] }));
  ui.selectQuote('audio'); assert.match(ui.quoteComposer(), /Áudio · &lt;svg onload=bad\(\)&gt;/);
});

test('picker procura atalho/título/texto sem acentos e exibe só ativos mesmo a administrador', () => {
  const ui = setup(), items = [item(), item({ id: 'delivery', shortcut: 'prazo', title: 'Entrega', text: 'Prazo de três dias.' }), item({ id: 'disabled', active: false, title: 'Conteúdo desativado' })];
  assert.deepEqual(ui.filterItems(items, '/ola').map(result => result.id), ['welcome']);
  assert.deepEqual(ui.filterItems(items, 'boas-vindas').map(result => result.id), ['welcome']);
  assert.deepEqual(ui.filterItems(items, 'tres').map(result => result.id), ['delivery']);
  assert.equal(ui.filterItems(items, '', { admin: true }).length, 3);
  const html = ui.picker(items, { admin: true });
  assert.match(html, /Gerenciar respostas/); assert.match(html, /id="quick-reply-search"/); assert.match(html, /id="quick-reply-results"/);
  assert.doesNotMatch(html, /Conteúdo desativado|type="submit"/);
  assert.match(ui.picker(items, { query: 'não existe' }), /Nenhuma resposta encontrada/);
  assert.match(ui.picker([]), /Nenhuma resposta ativa/);
  assert.doesNotMatch(ui.picker(items), /Gerenciar respostas/);
});

test('picker, manager e editor escapam textos, erros e atributos e preservam versão CAS', () => {
  const ui = setup(), malicious = item({ id: '" bad="x', shortcut: '" bad="x', title: '<img onerror=bad()>', text: '</textarea><script>bad()</script>' });
  const html = ui.picker([malicious], { query: '"' }) + ui.manager([malicious], { error: '<script>oops()</script>' }) + ui.editor(malicious);
  assert.doesNotMatch(html, /<script>|<img |<\/textarea><script>/);
  assert.match(html, /&lt;img onerror=bad\(\)&gt;/); assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /name="version" value="3"/); assert.match(html, /data-version="3"/);
  assert.match(html, /name="title"[^>]*maxlength="80"/); assert.match(html, /minlength="2" maxlength="32"/);
  assert.match(ui.manager([item({ active: false })]), /Reativar/);
  assert.match(ui.editor({}, { busy: true }), /aria-busy="true"/); assert.match(ui.editor({}, { busy: true }), /Salvando…/);
});

test('readEditor conserva versão lida e updatePreview usa texto escapado', () => {
  const ui = setup(), values = { id: 'welcome', version: '7', shortcut: ' /OLA ', title: ' Título ', text: ' <script>bad()</script> ' }, target = {};
  const form = { elements: { namedItem: name => ({ value: values[name] }) }, querySelector: selector => selector === '[name="text"]' ? { value: values.text } : target };
  assert.deepEqual(ui.readEditor(form), { id: 'welcome', version: 7, shortcut: 'ola', title: 'Título', text: '<script>bad()</script>' });
  ui.updatePreview(form); assert.match(target.innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.doesNotMatch(target.innerHTML, /<script>/);
});

test('selecionar/limpar referência só altera seu bloco, sem recriar compositor, arquivo, gravador ou players', t => {
  const ui = setup(), target = { innerHTML: '' }, field = textarea('Texto físico'), calls = [];
  mockDocument(t, { querySelector(selector) { calls.push(selector); if (selector === '#message-quote') return target; if (selector === '#message-text') return field; throw new Error(`Outro componente alterado: ${selector}`); } });
  ui.selectQuote('original'); assert.match(target.innerHTML, /Mensagem original/); assert.equal(field.value, 'Texto físico');
  ui.clearQuote(); assert.doesNotMatch(target.innerHTML, /Mensagem original/); assert.equal(field.value, 'Texto físico');
  assert.ok(calls.every(selector => ['#message-quote', '#message-text'].includes(selector)));
  assert.equal(field.events.length, 0);
});

test('atualização idêntica preserva foco no controle de referência e evita replacement normalizado pelo navegador', t => {
  const ui = setup(), field = textarea('Meu texto'); let html = '', writes = 0;
  const target = { get innerHTML() { return html; }, set innerHTML(value) { writes++; html = value.replace(/ disabled>/g, ' disabled="">'); } };
  mockDocument(t, { querySelector: selector => selector === '#message-quote' ? target : field });
  ui.selectQuote('original'); const previousWrites = writes;
  for (let index = 0; index < 3; index++) { ui.syncContext(actor()); ui.updateQuoteComposer(); }
  assert.equal(writes, previousWrites);
  ui.updateQuoteComposer(true); const disabledWrites = writes; assert.ok(disabledWrites > previousWrites);
  ui.updateQuoteComposer(true); assert.equal(writes, disabledWrites);
  ui.updateQuoteComposer(false); assert.equal(writes, disabledWrites + 1);
});

test('jump usa mensagem no contexto, move foco ao balão sem substituir nós e respeita movimento reduzido', t => {
  const ui = setup(), calls = [], classes = new Set();
  const bubble = { setAttribute(...args) { calls.push(args); }, focus(value) { calls.push(['focus', value]); }, scrollIntoView(value) { calls.push(['scroll', value]); }, addEventListener(type, callback) { this.onBlur = callback; } };
  const entry = { dataset: { messageId: 'original' }, querySelector: () => bubble, classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } } };
  mockDocument(t, { querySelector: selector => selector === '#messages' ? { querySelectorAll: () => [entry] } : null });
  const previous = globalThis.matchMedia; globalThis.matchMedia = () => ({ matches: true });
  t.after(() => { if (previous) globalThis.matchMedia = previous; else delete globalThis.matchMedia; });
  assert.equal(ui.jumpToMessage('foreign'), false); assert.equal(ui.jumpToMessage('original'), true);
  assert.deepEqual(calls, [['tabindex', '-1'], ['focus', { preventScroll: true }], ['scroll', { block: 'center', behavior: 'instant' }]]);
  assert.ok(classes.has('reply-jump-target')); bubble.onBlur(); assert.equal(classes.size, 0);
});

test('ações exigem permissão antes de alterar referência e botão desativado não executa', () => {
  const ui = setup(), target = { dataset: { replyAction: 'quote', id: 'original' } };
  assert.equal(ui.handleAction(target, { canReply: false }), false); assert.equal(ui.replyToMessageId, null);
  assert.equal(ui.handleAction({ ...target, disabled: true }), false); assert.equal(ui.replyToMessageId, null);
  assert.equal(ui.handleAction(target), true); assert.equal(ui.replyToMessageId, 'original');
  assert.equal(ui.handleAction({ dataset: { replyAction: 'clear' } }), true); assert.equal(ui.replyToMessageId, null);
});

// ---- management screen (Automação › Respostas rápidas, P8-B) -------------------------------------

test('tela de gestão lista ativas e desativadas com ações do namespace automation e sem os ganchos do compositor', () => {
  const items = [item(), item({ id: 'old', shortcut: 'antigo', title: 'Antigo', text: 'Linha 1\nLinha 2', active: false, version: 9 })];
  const html = String(quickRepliesScreen(items));
  assert.match(html, /data-automation-search="replies"/); assert.match(html, /aria-controls="automation-replies-results"/);
  assert.match(html, /role="status" aria-live="polite" data-automation-replies-count>2 respostas · 1 desativada</);
  assert.match(html, /data-action="automation:reply-edit" data-id="welcome"/); assert.match(html, /data-action="automation:reply-toggle" data-id="old"/);
  assert.match(html, /aria-label="Reativar Antigo"/); assert.match(html, /data-state="inactive"/); assert.match(html, /Versão 9/);
  assert.doesNotMatch(html, /data-reply-action|data-reply-search|data-reply-results|data-reply-form/);
  assert.equal(quickRepliesCount(items, 'antigo'), '1 resposta encontrada');
  assert.match(String(quickRepliesResults(items, { query: 'nada disso' })), /Nenhuma resposta encontrada[\s\S]*automation:replies-clear-search/);
  const empty = String(quickRepliesScreen([]));
  assert.match(empty, /Nenhuma resposta rápida ainda/); assert.match(empty, /automation:reply-new/); assert.doesNotMatch(empty, /data-automation-search/);
});

test('tela de gestão escapa atalho, título, texto e IDs', () => {
  const malicious = item({ id: '" onclick="bad()', shortcut: '<b>', title: '<img src=x onerror=bad()>', text: '</textarea><script>bad()</script>' });
  const html = String(quickRepliesScreen([malicious], { query: '"><script>' })) + String(quickReplyEditorForm(malicious));
  assert.doesNotMatch(html, /<script>|<img |<b>|data-id="" onclick/);
  assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/); assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /value="&quot;&gt;&lt;script&gt;"/);
});

test('editor da tela guarda a versão CAS, limites do servidor, contador a partir de 80% e prévia escapada', () => {
  const html = String(quickReplyEditorForm(item()));
  assert.match(html, /<form class="pg-automation__form" data-form="automation:reply">/);
  assert.match(html, /name="id" value="welcome"/); assert.match(html, /name="version" value="3"/);
  assert.match(html, /name="shortcut"[^>]*value="ola" maxlength="32"/); assert.match(html, /name="title"[^>]*maxlength="80"/); assert.match(html, /maxlength="4000">Olá!<\/textarea>/);
  assert.match(html, /aria-describedby="automation-reply-shortcut-hint"/); assert.match(html, /De 2 a 32 letras/);
  assert.match(html, /data-automation-counter hidden>4 \/ 4\.000</, 'the counter only shows from 80% of the limit');
  assert.match(String(quickReplyEditorForm(item({ text: 'x'.repeat(3300) }))), /data-automation-counter>3\.300 \/ 4\.000</);
  assert.match(String(quickReplyEditorForm(item({ text: 'x'.repeat(4000) }))), /data-automation-counter data-state="full">4\.000 \/ 4\.000</);
  assert.match(html, /data-action="automation:close-dialog"/); assert.match(html, /type="submit"[^>]*>[\s\S]*Salvar resposta/);
  assert.match(String(quickReplyEditorForm({})), /name="version" value=""/);
  assert.match(String(quickReplyPreview('<b>oi</b>')), /&lt;b&gt;oi&lt;\/b&gt;/); assert.match(String(quickReplyPreview('  ')), /O texto da resposta aparecerá aqui/);
  assert.deepEqual(QUICK_REPLY_LIMITS, { shortcut: 32, title: 80, text: 4000 });
});

test('leitura do editor e filtro são os mesmos do modal do compositor', () => {
  const values = { id: 'welcome', version: '7', shortcut: ' /OLA ', title: ' Título ', text: ' Texto ' };
  const form = { elements: { namedItem: name => ({ value: values[name] }) } };
  assert.deepEqual(readQuickReplyForm(form), { id: 'welcome', version: 7, shortcut: 'ola', title: 'Título', text: 'Texto' });
  assert.deepEqual(readQuickReplyForm(form), setup().readEditor(form));
  const items = [item(), item({ id: 'off', active: false, title: 'Desligada' })];
  assert.deepEqual(filterQuickReplies(items, 'desligada').map(entry => entry.id), []);
  assert.deepEqual(filterQuickReplies(items, 'desligada', { admin: true }).map(entry => entry.id), ['off']);
  assert.deepEqual(setup().filterItems(items, '', { admin: true }).map(entry => entry.id), ['welcome', 'off']);
});

test('tela de gestão em inglês não traduz o conteúdo das respostas', t => {
  setLocale('en', { persist: false, notify: false });
  t.after(() => setLocale('pt-BR', { persist: false, notify: false }));
  const html = String(quickRepliesScreen([item({ title: 'Ativa', text: 'Desativar' })])) + String(quickReplyEditorForm(item()));
  assert.match(html, /1 reply/); assert.match(html, />Edit</); assert.match(html, /aria-label="Disable Ativa"/); assert.match(html, /Up to 4,000 characters/); assert.match(html, /From 2 to 32 letters/);
  assert.match(html, /<h3 class="pg-automation__reply-title">Ativa<\/h3>/); assert.match(html, /<p class="pg-automation__reply-text">Desativar<\/p>/);
});
