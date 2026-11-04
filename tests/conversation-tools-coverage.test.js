import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationTools } from '../public/conversation-tools.js';
import { getLocale, setLocale } from '../public/i18n.js';

const context = (extra = {}) => ({ workspaceId: 'w', tenantId: 't', channelId: 'c', conversationId: 'one', active: true, ...extra });
const recent = { id: 'recent', text: 'Resposta recente', kind: 'human', authorName: 'Ana' };
const old = { id: 'old', text: 'Resposta antiga: orçamento', kind: 'human', authorName: 'Bia', attachments: [
  { id: 'old-file', name: 'contrato-antigo.pdf', kind: 'document', status: 'ready', size: 10 }
] };
const snapshot = (extra = {}) => ({ id: 'one', channelId: 'c', messages: [recent], messageCount: 2, ...extra });
function setup(extra = {}) {
  let source = snapshot();
  const changes = [], jumps = [];
  const ui = createConversationTools({ conversation: () => source, onChange: event => changes.push(event),
    navigateToMessage: id => { jumps.push(id); return true; }, ...extra });
  ui.syncContext(context(), ['one', 'two']);
  return { ui, changes, jumps, set: next => { source = next; } };
}
const action = (ui, name, extra = {}) => ({ dataset: { contextKey: ui.contextKey, conversationTool: name, ...extra } });
const locale = value => setLocale(value, { persist: false, notify: false });

for (const language of ['pt-BR', 'en']) {
  test(`coverage: old reply and file become findable only after explicit snapshot expansion (${language})`, t => {
    const previous = getLocale(); t.after(() => locale(previous)); locale(language);
    const { ui, set, changes, jumps } = setup();
    ui.open(); ui.setQuery('orçamento');
    assert.match(ui.panel(), language === 'en' ? /Search loaded history/ : /Buscar no histórico carregado/);
    assert.match(ui.results(), /data-conversation-tool-coverage="partial"/);
    assert.match(ui.results(), language === 'en' ? /1 of 2 messages loaded/ : /1 de 2 mensagens carregadas/);
    assert.match(ui.results(), language === 'en' ? /No results in loaded messages/ : /Nenhum resultado nas mensagens carregadas/);
    assert.match(ui.results(), language === 'en' ? /Load earlier/ : /Carregar anteriores/);
    ui.open('gallery'); ui.setQuery('contrato-antigo');
    assert.doesNotMatch(ui.results(), /conversation-tool-filename/);
    // The owner explicitly loads a page; the module itself never fetches it.
    set(snapshot({ messages: [old, recent] }));
    assert.match(ui.results(), /contrato-antigo.pdf/);
    assert.match(ui.results(), /data-conversation-tool-coverage="complete"/);
    assert.doesNotMatch(ui.results(), /Use (Carregar anteriores|Load earlier)/);
    ui.open(); ui.setQuery('orçamento');
    assert.match(ui.results(), /Resposta antiga: orçamento/);
    assert.equal(ui.handleAction(action(ui, 'jump', { id: 'old' })), true);
    assert.deepEqual(jumps, ['old']);
    assert.equal(changes.at(-1).resultsOnly, true);
    ui.setQuery('ausente');
    assert.match(ui.results(), language === 'en' ? /No results in loaded messages/ : /Nenhum resultado nas mensagens carregadas/);
    assert.doesNotMatch(ui.results(), /Nenhum resultado encontrado|Nenhum arquivo nesta conversa/);
  });

  test(`coverage: empty search and gallery stay local, including zero-message complete history (${language})`, t => {
    const previous = getLocale(); t.after(() => locale(previous)); locale(language);
    const { ui, set } = setup();
    ui.open('gallery');
    assert.match(ui.results(), language === 'en' ? /No files in loaded messages/ : /Nenhum arquivo nas mensagens carregadas/);
    set(snapshot({ messageCount: 0, messages: [] })); ui.open();
    assert.match(ui.results(), /data-conversation-tool-coverage="complete"/);
    assert.match(ui.results(), language === 'en' ? /No messages loaded/ : /Nenhuma mensagem carregada/);
    assert.match(ui.results(), language === 'en' ? /0 of 0 messages loaded/ : /0 de 0 mensagens carregadas/);
  });
}

test('coverage: actual hasMore adapter is read fresh; filtered counts never become coverage totals', () => {
  let page = { hasMore: true, messageCount: 10 };
  const reads = [];
  const { ui, set } = setup({ getHistoryCoverage: scope => { reads.push(scope); return page; } });
  ui.open(); ui.setQuery('missing');
  assert.match(ui.results(), /1 de 10 mensagens carregadas/);
  assert.deepEqual(reads.at(-1), { ...context(), contextKey: ui.contextKey });
  page = { hasMore: false, messageCount: 2 }; set(snapshot({ messages: [old, recent] }));
  assert.match(ui.results(), /data-conversation-tool-coverage="complete"/);
  ui.open('gallery'); ui.handleAction(action(ui, 'filter', { value: 'audio' }));
  assert.match(ui.results(), /2 de 2 mensagens carregadas/);
  assert.match(ui.results(), /0 arquivos encontrados/);
  // Conflicting metadata must not advertise completeness.
  page = { hasMore: true, messageCount: 2 };
  assert.match(ui.results(), /data-conversation-tool-coverage="partial"/);
  page = { hasMore: false, messageCount: 10 };
  assert.match(ui.results(), /data-conversation-tool-coverage="partial"/);
});

test('coverage: missing, malformed and unavailable metadata are unknown, not complete', () => {
  for (const getHistoryCoverage of [undefined, () => null, () => ({ hasMore: 'false', messageCount: '1' }), () => { throw Error('unavailable'); }]) {
    const { ui, set } = setup({ getHistoryCoverage });
    set(snapshot({ messageCount: undefined })); ui.open();
    assert.match(ui.results(), /data-conversation-tool-coverage="unknown"/);
    assert.match(ui.results(), /cobertura total do histórico não foi confirmada/);
    assert.match(ui.results(), /1 mensagens carregadas/);
    assert.doesNotMatch(ui.results(), /Todo o histórico disponível/);
  }
});

test('coverage: no network, automatic pagination, media, focus or DOM access during search', t => {
  const blocked = () => { throw Error('side effect forbidden'); };
  t.mock.method(globalThis, 'fetch', blocked);
  const { ui, changes, set } = setup({ mediaAction: blocked, navigateToMessage: blocked });
  ui.open(); const target = { value: 'orçamento', selectionStart: 2, selectionEnd: 5, focus: blocked,
    dataset: { conversationToolSearch: '', contextKey: ui.contextKey } };
  const composer = { value: 'Rascunho intacto', selectionStart: 3, selectionEnd: 6 };
  assert.equal(ui.handleInput(target), true);
  assert.equal(changes.at(-1).resultsOnly, true);
  assert.equal(changes.at(-1).event, 'query');
  const before = changes.length;
  set(snapshot({ messages: [old, recent] }));
  assert.match(ui.results(), /Resposta antiga/);
  assert.equal(changes.length, before); // Read/render does not schedule a focus/full-panel update.
  assert.equal(ui.query, 'orçamento');
  assert.equal(target.selectionStart, 2); assert.equal(target.selectionEnd, 5);
  assert.deepEqual(composer, { value: 'Rascunho intacto', selectionStart: 3, selectionEnd: 6 });
  assert.match(ui.results(), /role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(ui.results(), /data-action="inbox:earlier"|data-conversation-tool="load/);
});

test('coverage: stale page, revoked context and channel switch cannot leak old reply/file or totals', () => {
  let page = { hasMore: true, messageCount: 999 }, reads = 0;
  const { ui, set } = setup({ getHistoryCoverage: () => { reads++; return page; } });
  ui.open(); const oldInput = { value: 'privado', dataset: { conversationToolSearch: '', contextKey: ui.contextKey } };
  set(snapshot({ id: 'two', messages: [], messageCount: 0 }));
  ui.syncContext(context({ conversationId: 'two' })); page = { hasMore: false, messageCount: 0 }; ui.open();
  assert.match(ui.results(), /0 de 0 mensagens carregadas/);
  assert.doesNotMatch(ui.results(), /999|Resposta|contrato/);
  assert.equal(ui.handleInput(oldInput), false);
  const before = reads;
  set(snapshot({ id: 'two', tenantId: 'foreign' }));
  assert.equal(ui.results(), ''); assert.equal(reads, before);
  set(snapshot({ channelId: 'other', messages: [old], messageCount: 1 }));
  ui.syncContext(context({ channelId: 'other' }), ['one']); ui.open();
  assert.equal(ui.query, ''); assert.match(ui.results(), /Resposta antiga/);
  ui.retainConversations([]); assert.equal(ui.results(), '');
});
