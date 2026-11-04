import test from 'node:test';
import assert from 'node:assert/strict';
import { t, tForLocale, txt, html, markup, labels, setLocale, getLocale, normalizeLocale, registerTranslations, translateError, translateStatic, translateCopy } from '../public/i18n.js';
import { captureLocaleFormState, restoreLocaleFormState } from '../public/locale-ui.js';
import '../public/locales-shell.js';

test('explicit widget language does not change the operator preference or page language', () => {
  setLocale('pt-BR');
  assert.equal(tForLocale('en', 'Minha conta'), 'My account');
  assert.equal(getLocale(), 'pt-BR');
  setLocale('en');
  assert.equal(tForLocale('pt-BR', 'Minha conta'), 'Minha conta');
  assert.equal(getLocale(), 'en');
  setLocale('pt-BR');
});

test('importing the shared engine does not change the embedding page language', async () => {
  const savedDocument = globalThis.document, savedStorage = globalThis.localStorage;
  try {
    globalThis.document = { documentElement: { lang: 'en-GB' } };
    globalThis.localStorage = { getItem: () => 'pt-BR' };
    await import('../public/i18n.js?embedded-page-language');
    assert.equal(globalThis.document.documentElement.lang, 'en-GB');
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedStorage;
  }
});

test('locale normalization, labels and formatters follow PT/EN without changing currency', () => {
  assert.equal(normalizeLocale('fr'), 'pt-BR'); assert.equal(normalizeLocale('en-US'), 'en');
  const names = labels({ open: 'Aberta', pending: 'Pendente' });
  const frozen = Object.freeze(labels({ open: 'Aberta' }));
  setLocale('pt-BR'); assert.equal(names.open, 'Aberta'); assert.equal(t('Minha conta'), 'Minha conta');
  setLocale('en'); assert.equal(names.open, 'Open'); assert.equal(t('Minha conta'), 'My account');
  assert.deepEqual(Object.values(names), ['Open', 'Pending']);
  assert.equal(frozen.open, 'Open');
  assert.throws(() => { frozen.open = 'changed'; }, TypeError);
  assert.match(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'BRL' }).format(1500.2), /1,500\.20/);
  setLocale('pt-BR');
});
test('static markup translation never scans dynamic names, messages, IDs or integration values', () => {
  setLocale('en');
  const clientMessage = 'Minha conta', companyName = 'Grupos';
  const result = html`<section data-action="Grupos"><h1>Minha conta</h1><p>${companyName}</p><input value="Minha conta" placeholder="Escreva sua mensagem…"/><div>${clientMessage}</div></section>`;
  assert.match(result, /<h1>My account<\/h1>/); assert.match(result, /<p>Grupos<\/p>/);
  assert.match(result, /data-action="Grupos"/); assert.match(result, /value="Minha conta"/);
  assert.match(result, /placeholder="Write your message…"/); assert.match(result, /<div>Minha conta<\/div>/);
  assert.equal(markup('<button>Salvar</button>'), '<button>Save</button>'); setLocale('pt-BR');
});
test('interpolation reordering and HTML attribute quotes preserve customer values exactly once', () => {
  registerTranslations({ 'Pessoa {0} em {1}': 'At {1}: {0}', 'Conta de {0}': "{0}'s account" });
  setLocale('en');
  assert.equal(txt`Pessoa ${'Salvar {1}'} em ${'Grupos'}`, 'At Grupos: Salvar {1}');
  assert.equal(html`<b title='Conta de ${'Jean'}'>${'Minha conta'}</b>`, "<b title='Jean&#39;s account'>Minha conta</b>");
  assert.equal(html`<b>${undefined} ${null}</b>`, '<b>undefined null</b>'); setLocale('pt-BR');
});
test('only explicitly marked static DOM copy is translated; server errors have an English fallback', () => {
  const named = { dataset: { i18n: 'Minha conta' } }, dynamic = { textContent: 'Minha conta' };
  const root = { querySelectorAll: selector => selector === '[data-i18n]' ? [named] : [] };
  setLocale('en'); translateStatic(root); assert.equal(named.textContent, 'My account'); assert.equal(dynamic.textContent, 'Minha conta');
  assert.equal(translateError('Senha atual incorreta.'), 'Incorrect current password.');
  assert.equal(translateError(translateError('Senha atual incorreta.')), 'Incorrect current password.');
  assert.equal(translateError('Erro privado não catalogado'), 'Unable to complete this action. Please try again.');
  setLocale('pt-BR'); assert.equal(translateError('Erro privado'), 'Erro privado');
  assert.equal(translateError('Incorrect current password.'), 'Senha atual incorreta.');
  assert.equal(translateCopy('Profile saved.'), 'Perfil salvo.');
});
test('form state survives translated render without copying passwords or selected file handles', () => {
  const fields = [{ id: 'reply', name: 'message', value: 'Minha conta', type: 'textarea', selectionStart: 2, selectionEnd: 5 }, { id: 'tag', name: 'tag', value: 'Minha conta', type: 'text' }, { id: 'secret', name: 'password', value: 'do-not-copy', type: 'password' }, { id: 'file', name: 'file', value: 'private', type: 'file' }];
  const root = { ownerDocument: { activeElement: fields[0] }, querySelectorAll: () => fields };
  const snapshot = captureLocaleFormState(root); assert.equal(snapshot.length, 2); assert.ok(!JSON.stringify(snapshot).includes('do-not-copy'));
  const fresh = fields.slice(0, 2).map(field => ({ ...field, value: '', focus(options) { this.focusOptions = options; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } }));
  restoreLocaleFormState({ querySelectorAll: () => fresh }, snapshot); assert.equal(fresh[0].value, 'Minha conta'); assert.equal(fresh[1].value, 'Minha conta'); assert.deepEqual(fresh[0].focusOptions, { preventScroll: true }); assert.equal(fresh[0].selectionEnd, 5);
});
