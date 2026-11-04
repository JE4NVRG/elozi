import test from 'node:test';
import assert from 'node:assert/strict';
import { contactPage } from '../public/workspace-ui.js';

const contacts = [
  { id: 'br-mobile', name: 'Érica', phone: '(11) 91234-5678', email: 'erica@example.test', tags: ['Prioritário'] },
  { id: 'br-prefixed', name: 'Contato com país', phone: '+55 (31) 98888-7047', tags: ['Comercial'] },
  { id: 'br-canonical', name: 'Contato importado', phone: '5511987654321', tags: [] },
  { id: 'br-landline', name: 'Contato fixo', phone: '(21) 2555-1234', tags: [] },
  { id: 'us', name: 'Contato internacional EUA', phone: '+1 (212) 555-1234', tags: [] },
  { id: 'pt', name: 'Contato internacional Portugal', phone: '+351 912 345 678', tags: [] },
  { id: 'different-br', name: 'Outro telefone brasileiro', phone: '+55 11 91234-5679', tags: [] },
  { id: 'archived', name: 'Contato arquivado', phone: '+55 11 93333-0001', tags: [], archivedAt: '2026-10-03T00:00:00Z' },
];
const ids = (search, options = {}) => contactPage(contacts, { search, ...options }).items.map(item => item.id);

test('busca encontra o telefone brasileiro completo em formatos de usuário sem alterar sua apresentação', () => {
  const before = structuredClone(contacts);
  for (const search of ['(11) 91234-5678', '11 91234 5678', '11912345678', '+55 (11) 91234-5678', '5511912345678', '  +55 11 91234-5678  ']) {
    assert.deepEqual(ids(search), ['br-mobile'], search);
  }
  for (const search of ['(31) 98888-7047', '31988887047', '+55 31 98888 7047', '5531988887047']) assert.deepEqual(ids(search), ['br-prefixed'], search);
  for (const search of ['(11) 98765-4321', '11987654321', '+55 11 98765-4321', '5511987654321']) assert.deepEqual(ids(search), ['br-canonical'], search);
  assert.deepEqual(contacts, before);
});

test('DDD e país brasileiros completos não colidem com a parte nacional de outro país', () => {
  for (const search of ['(21) 2555-1234', '2125551234', '+55 (21) 2555-1234', '552125551234']) assert.deepEqual(ids(search), ['br-landline'], search);
  assert.deepEqual(ids('+1 (212) 555-1234'), ['us']);
  assert.deepEqual(ids('+1 212'), ['us']);
  assert.deepEqual(ids('+351 912 345 678'), ['pt']);
  assert.deepEqual(ids('+351 912'), ['pt']);
  assert.deepEqual(ids('5511912345679'), ['different-br']);
  assert.deepEqual(ids('5511912345677'), []);
  assert.deepEqual(ids('+55'), ['br-mobile', 'br-prefixed', 'br-canonical', 'br-landline', 'different-br']);
});

test('sufixos, nomes sem acento, e-mail e etiquetas continuam cobrindo todos os contatos autorizados', () => {
  assert.deepEqual(ids('7047'), ['br-prefixed']);
  assert.deepEqual(ids('4321'), ['br-canonical']);
  assert.deepEqual(ids('5551234'), ['br-landline', 'us']);
  assert.deepEqual(ids('912345678'), ['br-mobile', 'pt']);
  assert.deepEqual(ids('ERICA'), ['br-mobile']);
  assert.deepEqual(ids('erica (11)'), ['br-mobile']);
  assert.deepEqual(ids('erica@example.test'), ['br-mobile']);
  assert.deepEqual(ids('prioritario'), ['br-mobile']);
  assert.deepEqual(ids('comercial'), ['br-prefixed']);
  assert.deepEqual(ids('internacional'), ['us', 'pt']);
  assert.deepEqual(ids('5511933330001'), []);
  assert.deepEqual(ids('5511933330001', { showArchived: true }), ['archived']);
});

test('busca por número fora da página mantém totais, recua a página e não inventa cadastros', () => {
  const list = Array.from({ length: 51 }, (_, i) => ({ id: 'other-' + i, name: 'Cadastro ' + i, phone: '', tags: [] }));
  list.push(contacts[0]);
  const page = contactPage(list, { search: '5511912345678', page: 1 });
  assert.deepEqual(page.items.map(item => item.id), ['br-mobile']);
  assert.deepEqual({ total: page.total, page: page.page, pages: page.pages, start: page.start, end: page.end }, { total: 1, page: 0, pages: 1, start: 1, end: 1 });
  assert.equal(contactPage([], { search: '5511912345678' }).total, 0);
});
