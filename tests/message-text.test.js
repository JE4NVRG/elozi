import test from 'node:test';
import assert from 'node:assert/strict';
import {messageTextMarkup} from '../public/ui.js';

test('texto de mensagem agrupa parágrafos e listas sem perder quebras de linha', () => {
  assert.equal(String(messageTextMarkup('Primeira linha\r\nSegunda\n\n• Item A\n- Item B\n\nFim')), '<p>Primeira linha<br>Segunda</p><ul><li>Item A</li><li>Item B</li></ul><p>Fim</p>');
});

test('negrito WhatsApp/Markdown e código são limitados ao conteúdo textual', () => {
  assert.equal(String(messageTextMarkup('*Mercado* e **compras**\n_Nota_ ~antiga~ `*literal*`')), '<p><strong>Mercado</strong> e <strong>compras</strong><br><em>Nota</em> <s>antiga</s> <code>*literal*</code></p>');
  assert.equal(String(messageTextMarkup('2 * 3 = 6; _ sem formato _; *aberto')), '<p>2 * 3 = 6; _ sem formato _; *aberto</p>');
  assert.equal(String(messageTextMarkup('john_doe_test@example.test https://example.test/a_b_c')), '<p>john_doe_test@example.test https://example.test/a_b_c</p>');
});

test('HTML, atributos, URLs e entidades nunca viram elementos ou links de mensagem', () => {
  const markup=String(messageTextMarkup('*<img src=x onerror=alert(1)>*\n• <script>alert(1)</script>\n\n[javascript](javascript:alert(1)) &lt;svg&gt; https://example.test'));
  assert.match(markup, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /&amp;lt;svg&amp;gt;/);
  assert.doesNotMatch(markup, /<(?:img|script|svg|a)\b/);
});

test('texto vazio e delimitadores incompletos permanecem seguros e previsíveis', () => {
  assert.equal(String(messageTextMarkup(null)), '');
  assert.equal(String(messageTextMarkup('***\n_\n`\n~')), '<p>***<br>_<br>`<br>~</p>');
});
