import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationIndex, conversationContextKey, conversationExcerpt, createConversationTools,
  filterConversationIndex, nextConversationResult, normalizeConversationSearch } from '../public/conversation-tools.js';

const actor = (extra = {}) => ({ workspaceId: 'workspace', tenantId: 'tenant', channelId: 'channel', conversationId: 'one', active: true, ...extra });
const file = (id = 'photo', extra = {}) => ({ id, name: `${id}.jpg`, kind: 'image', mime: 'image/jpeg', size: 128, preview: true, status: 'ready', ...extra });
const message = (id = 'first', extra = {}) => ({ id, kind: 'customer', senderName: 'Contato sintético', text: 'Pedido de informação', createdAt: '2026-10-02T10:30:00Z', ...extra });
const conversation = (extra = {}) => ({ id: 'one', channelId: 'channel', messages: [message()], ...extra });
function setup(extra = {}) {
  let snapshot = conversation();
  const notifications = [], navigations = [], media = [];
  const ui = createConversationTools({ icon: name => `<svg data-icon="${name}" aria-hidden="true"></svg>`, conversation: () => snapshot,
    navigateToMessage: id => { navigations.push(id); return true; }, mediaAction: payload => { media.push(payload); },
    onChange: event => notifications.push(event), ...extra });
  ui.syncContext(actor(), ['one', 'two']);
  return { ui, notifications, navigations, media, snapshot: value => { snapshot = value; } };
}
function action(ui, name, extra = {}) { return { dataset: { conversationTool: name, contextKey: ui.contextKey, ...extra } }; }
function input(ui, value) { return { value, dataset: { conversationToolSearch: '', contextKey: ui.contextKey } }; }

test('normalização trata caixa, acentos compostos/decompostos e espaço sem alterar símbolos', () => {
  assert.equal(normalizeConversationSearch('  INFORMAÇÃO\nDe  João '), 'informacao de joao');
  assert.equal(normalizeConversationSearch('Informac\u0327a\u0303o'), 'informacao');
  assert.equal(normalizeConversationSearch('ÁUDIO + /Arquivo.pdf'), 'audio + /arquivo.pdf');
  assert.equal(normalizeConversationSearch(null), '');
});

test('chave de contexto inclui empresa, canal e conversa e recusa contexto sem autoridade ativa', () => {
  assert.equal(conversationContextKey(actor()), '["workspace","tenant","channel","one"]');
  for (const change of [{ tenantId: '' }, { channelId: '' }, { conversationId: '' }, { active: false }]) assert.equal(conversationContextKey(actor(change)), '');
  assert.notEqual(conversationContextKey(actor({ channelId: 'other' })), conversationContextKey(actor()));
});

test('índice leve omite URLs, binários e corpos auxiliares e não modifica o snapshot', () => {
  const source = conversation({ messages: [message('first', { internalPayload: 'private payload', attachments: [file('photo', {
    url: 'https://external.invalid/photo', thumbnail: 'javascript:bad()', buffer: ['private bytes'], path: '/private/file' })] })] });
  const before = structuredClone(source), index = buildConversationIndex(source, actor());
  assert.equal(index.length, 1); assert.equal(index[0].attachments[0].id, 'photo');
  const serialized = JSON.stringify(index);
  assert.doesNotMatch(serialized, /external\.invalid|javascript:|private payload|private bytes|\/private\/file/);
  assert.deepEqual(source, before);
});

test('índice recusa conversa ou canal diferente e ignora metadados de outro escopo', () => {
  const context = actor();
  for (const source of [null, conversation({ id: 'two' }), conversation({ channelId: 'other' }), conversation({ tenantId: 'other' }), conversation({ workspaceId: 'other' })]) {
    assert.deepEqual(buildConversationIndex(source, context), []);
  }
  assert.deepEqual(buildConversationIndex(conversation(), actor({ active: false })), []);
  const source = conversation({ messages: [message('correct', { conversationId: 'one', tenantId: 'tenant', attachments: [file('valid'),
    file('wrong-message', { messageId: 'other' }), file('wrong-tenant', { tenantId: 'other' }), file('wrong-channel', { channelId: 'other' })] }),
    message('foreign', { conversationId: 'two' }), message('foreign-company', { tenantId: 'other' }), message('foreign-channel', { channelId: 'other' })] });
  const index = buildConversationIndex(source, context);
  assert.deepEqual(index.map(row => row.id), ['correct']);
  assert.deepEqual(index[0].attachments.map(row => row.id), ['valid']);
});

test('busca encontra texto, legenda da mensagem/anexo, filename e autor inclusive notas', () => {
  const index = buildConversationIndex(conversation({ messages: [message('text', { text: 'Condição de ENTREGA' }),
    message('caption', { text: '', caption: 'Prévia aprovada' }), message('name', { text: '', attachments: [file('pdf', { name: 'Cotação.pdf' })] }),
    message('file-caption', { text: '', attachments: [file('photo', { caption: 'Após revisão' })] }),
    message('author', { kind: 'human', authorName: 'André', senderName: 'Other', text: 'Já recebido' }),
    message('note', { kind: 'system', senderName: '', text: 'Nota interna sintética' })] }), actor());
  for (const [query, id] of [['condicao de entrega', 'text'], ['previa', 'caption'], ['cotacao', 'name'], ['apos revisao', 'file-caption'], ['ANDRE', 'author'], ['nota interna', 'note']]) {
    assert.deepEqual(filterConversationIndex(index, { query }).map(row => row.id), [id]);
  }
  assert.equal(index.find(row => row.id === 'note').author, 'Sistema');
});

test('filtros de mensagem e galeria tratam anexos múltiplos, MIME e formatos de documento', () => {
  const index = buildConversationIndex(conversation({ messages: [message('multiple', { attachments: [file('image'),
    file('video', { kind: undefined, mime: 'video/mp4' }), file('audio', { kind: undefined, mime: 'audio/ogg' }),
    file('document', { kind: undefined, mime: 'application/pdf', preview: false })] }), message('text')] }), actor());
  assert.equal(filterConversationIndex(index).length, 2);
  for (const type of ['image', 'video', 'audio', 'document']) {
    assert.deepEqual(filterConversationIndex(index, { filter: type }).map(row => row.id), ['multiple']);
    assert.deepEqual(filterConversationIndex(index, { filter: type, mode: 'gallery' }).map(row => row.id), [type]);
  }
  assert.equal(filterConversationIndex(index, { mode: 'gallery' }).length, 4);
  assert.equal(filterConversationIndex(index, { mode: 'gallery', query: 'pedido' }).length, 4);
  assert.equal(filterConversationIndex(index, { filter: 'invalid' }).length, 2);
});

test('galeria busca cada arquivo sem usar nome de outro anexo como resultado falso', () => {
  const index = buildConversationIndex(conversation({ messages: [message('multiple', { text: '', attachments: [file('proposal', { name: 'Proposta.pdf' }), file('receipt', { name: 'Recibo.pdf' })] })] }), actor());
  assert.deepEqual(filterConversationIndex(index, { mode: 'gallery', query: 'proposta' }).map(row => row.id), ['proposal']);
});

test('ordem segue timeline carregada, preserva anexos e não ordena o array de origem', () => {
  const source = conversation({ messages: [message('older', { createdAt: '2040-01-01', attachments: [file('a'), file('b')] }),
    message('newer', { createdAt: '2000-01-01', attachments: [file('c')] })] });
  const index = buildConversationIndex(source, actor());
  assert.deepEqual(filterConversationIndex(index).map(row => row.id), ['newer', 'older']);
  assert.deepEqual(filterConversationIndex(index, { mode: 'gallery' }).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(index.map(row => row.id), ['older', 'newer']);
  assert.deepEqual(source.messages.map(row => row.id), ['older', 'newer']);
});

test('excerpt mostra o trecho encontrado com acentos e mantém texto como dado', () => {
  const text = `${'Á'.repeat(240)} condição confirmada ${'Z'.repeat(240)}`;
  const excerpt = conversationExcerpt(text, 'CONDICAO', 72);
  assert.match(excerpt, /condição confirmada/); assert.ok(excerpt.startsWith('…')); assert.ok(excerpt.endsWith('…'));
  assert.equal(conversationExcerpt(' <img onerror=bad()> '), '<img onerror=bad()>');
  assert.equal(conversationExcerpt(''), 'Mensagem sem texto');
  const emojiExcerpt = conversationExcerpt(`${'🙂'.repeat(120)}fim`, 'fim', 37);
  assert.ok(!/[\uD800-\uDBFF]$/.test(emojiExcerpt.replace(/…$/, '')));
  assert.ok(!/^[\uDC00-\uDFFF]/.test(emojiExcerpt.replace(/^…/, '')));
});

test('navegação de resultados é cíclica, determinística e deduplica mensagem de anexos múltiplos', () => {
  const rows = [{ messageId: 'three' }, { messageId: 'two' }, { messageId: 'two' }, { messageId: 'one' }];
  assert.equal(nextConversationResult(rows, '', 1), 'three');
  assert.equal(nextConversationResult(rows, '', -1), 'one');
  assert.equal(nextConversationResult(rows, 'three', 1), 'two');
  assert.equal(nextConversationResult(rows, 'three', -1), 'one');
  assert.equal(nextConversationResult(rows, 'one', 1), 'three');
  assert.equal(nextConversationResult([], '', 1), null);
});

test('markup escapa nomes, autores, texto, query e identificadores e nunca incorpora URLs/player', () => {
  const { ui, snapshot } = setup();
  snapshot(conversation({ messages: [message('id" onclick="bad()', { text: '<script>bad()</script>', senderName: '<b>Autor</b>', attachments: [file('file" onclick="bad()', {
    name: '<img src=x onerror=bad()>', caption: '<iframe src=x>', url: 'https://external.invalid/file', thumbnail: 'javascript:bad()' })] })] }));
  ui.open();
  let markup = ui.panel();
  assert.match(markup, /&lt;script&gt;/); assert.match(markup, /&lt;b&gt;Autor/); assert.match(markup, /id&amp;quot;|id&quot;/);
  ui.setQuery('" onfocus="bad()'); markup = ui.panel(); assert.match(markup, /value="&quot; onfocus=&quot;bad\(\)"/);
  ui.setQuery(''); ui.open('gallery'); markup = ui.panel();
  assert.match(markup, /&lt;img src=x onerror=bad\(\)&gt;/); assert.match(markup, /&lt;iframe src=x&gt;/);
  assert.doesNotMatch(markup, /<script|<img |<iframe |<audio|<video|https:\/\/external|javascript:|onclick="bad|onfocus="bad/);
});

test('abrir, filtrar e buscar não acessam fetch, mídia, storage ou DOM global', t => {
  const blocked = () => { throw new Error('A busca não pode acessar rede, storage ou timeline.'); };
  t.mock.method(globalThis, 'fetch', blocked);
  t.mock.method(URL, 'createObjectURL', blocked);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: blocked, querySelectorAll: blocked } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: blocked });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;
  });
  const { ui, media } = setup();
  assert.equal(ui.open(), true); assert.equal(ui.handleInput(input(ui, 'informação')), true);
  assert.equal(ui.handleAction(action(ui, 'filter', { value: 'all' })), true);
  assert.match(ui.results(), /1 mensagem encontrada/); ui.setQuery(''); assert.equal(ui.open('gallery'), true); assert.match(ui.panel(), /Nenhum arquivo/);
  assert.equal(media.length, 0);
});

test('contextos guardam somente preferências em RAM e não reaproveitam corpos entre conversas/canais', () => {
  const { ui, snapshot } = setup();
  ui.open('gallery'); ui.setQuery('preferência um'); ui.handleAction(action(ui, 'filter', { value: 'audio' }));
  snapshot(conversation({ id: 'two', messages: [message('second', { text: 'Corpo da segunda conversa' })] }));
  ui.syncContext(actor({ conversationId: 'two' }));
  assert.equal(ui.opened, false); assert.equal(ui.query, ''); assert.equal(ui.filter, 'all');
  ui.open(); assert.doesNotMatch(ui.panel(), /Pedido de informação/); assert.match(ui.panel(), /Corpo da segunda/);
  snapshot(conversation()); ui.syncContext(actor());
  assert.equal(ui.opened, false); assert.equal(ui.query, 'preferência um'); assert.equal(ui.filter, 'audio'); assert.equal(ui.mode, 'gallery');
  snapshot(conversation({ channelId: 'other' })); ui.syncContext(actor({ channelId: 'other' })); assert.equal(ui.query, '');
  snapshot(conversation()); ui.syncContext(actor()); assert.equal(ui.query, 'preferência um');
});

test('troca de empresa/workspace, permissão e saída do inbox apagam preferências e fecham painel', () => {
  for (const change of [{ tenantId: 'other' }, { workspaceId: 'other' }, { authorityKey: 'permission-revoked' }, { active: false }]) {
    const { ui } = setup(); ui.open(); ui.setQuery('privado'); ui.syncContext(actor(change));
    assert.equal(ui.opened, false); assert.equal(ui.query, ''); assert.equal(ui.panel(), '');
    ui.syncContext(actor()); assert.equal(ui.query, '');
  }
});

test('retainConversations remove contexto revogado e preferências não voltam com nova concessão', () => {
  const { ui } = setup(); ui.open(); ui.setQuery('preferência revogada');
  assert.equal(ui.retainConversations(['two']), false); assert.equal(ui.contextKey, ''); assert.equal(ui.opened, false);
  assert.equal(ui.syncContext(actor()), false); assert.equal(ui.open(), false);
  assert.equal(ui.syncContext(actor(), ['one']), true); assert.equal(ui.query, '');
});

test('callback de conversa divergente invalida índice e bloqueia cliques do painel antigo', () => {
  const { ui, snapshot, media, navigations } = setup(); ui.open();
  const key = ui.contextKey, oldJump = action(ui, 'jump', { id: 'first' });
  snapshot(conversation({ id: 'two', messages: [message('first', { attachments: [file()] })] }));
  assert.equal(ui.handleAction(oldJump), false); assert.equal(ui.contextKey, ''); assert.equal(ui.opened, false);
  ui.syncContext(actor({ conversationId: 'two' })); ui.open('gallery');
  assert.equal(ui.handleAction({ dataset: { conversationTool: 'download-media', contextKey: key, id: 'photo', messageId: 'first' } }), false);
  assert.equal(navigations.length, 0); assert.equal(media.length, 0);
});

test('mídia exige clique autorizado com par anexo/mensagem, contexto atual e arquivo pronto', async () => {
  const { ui, snapshot, media } = setup();
  snapshot(conversation({ messages: [message('first', { attachments: [file('ready'), file('pending', { status: 'pending' }),
    file('document', { kind: 'document', mime: 'application/pdf', preview: false })] }), message('second', { attachments: [file('second-file')] })] }));
  ui.open('gallery');
  assert.equal(ui.handleAction(action(ui, 'download-media', { id: 'ready', messageId: 'second' })), false);
  assert.equal(ui.handleAction(action(ui, 'download-media', { id: 'pending', messageId: 'first' })), false);
  assert.equal(ui.handleAction(action(ui, 'open-media', { id: 'document', messageId: 'first' })), false);
  assert.equal(ui.handleAction({ ...action(ui, 'download-media', { id: 'ready', messageId: 'first' }), disabled: true }), false);
  assert.equal(ui.handleAction({ dataset: { conversationTool: 'download-media', id: 'ready', messageId: 'first' } }), false);
  const open = action(ui, 'open-media', { id: 'ready', messageId: 'first' });
  assert.equal(await ui.handleAction(open), true); assert.equal(media.length, 1);
  assert.deepEqual(media[0], { action: 'open', id: 'ready', messageId: 'first', contextKey: ui.contextKey, origin: open });
  assert.equal(await ui.handleAction(action(ui, 'download-media', { id: 'document', messageId: 'first' })), true);
  assert.equal(media[1].action, 'download');
});

test('remoção ou indisponibilidade no snapshot atual bloqueia ação que antes era válida', () => {
  const { ui, snapshot, media, navigations } = setup(); snapshot(conversation({ messages: [message('first', { attachments: [file()] })] }));
  ui.open('gallery'); const oldFile = action(ui, 'download-media', { id: 'photo', messageId: 'first' }); const oldJump = action(ui, 'jump', { id: 'first' });
  snapshot(conversation({ messages: [message('first', { attachments: [file('photo', { status: 'unavailable' })] })] }));
  assert.equal(ui.handleAction(oldFile), false); assert.equal(media.length, 0);
  snapshot(conversation({ messages: [] })); assert.equal(ui.handleAction(oldJump), false); assert.equal(navigations.length, 0);
});

test('query/filter/jump atualizam apenas resultados; input e compositor continuam intactos', () => {
  let snapshot = conversation();
  const field = { value: 'Meu rascunho', selectionStart: 4, selectionEnd: 8 }, search = { value: '', selectionStart: 0, selectionEnd: 0 };
  const player = { currentTime: 4, playbackRate: 1.5, paused: false }, timeline = { scrollTop: 52 }, updates = [];
  let ui;
  ui = createConversationTools({ conversation: () => snapshot, navigateToMessage: () => true, onChange: event => {
    updates.push(event); if (event.resultsOnly) ui.results(); else ui.panel();
  } });
  ui.syncContext(actor(), ['one']); ui.open();
  const inputTarget = input(ui, 'informação'); search.value = inputTarget.value; search.selectionStart = 3; search.selectionEnd = 5;
  assert.equal(ui.handleInput(inputTarget), true); assert.equal(ui.handleAction(action(ui, 'filter', { value: 'all' })), true);
  assert.equal(ui.handleAction(action(ui, 'jump', { id: 'first' })), true);
  assert.deepEqual(updates.map(event => [event.event, event.resultsOnly]), [['open', false], ['query', true], ['filter', true], ['navigate', true]]);
  assert.deepEqual(field, { value: 'Meu rascunho', selectionStart: 4, selectionEnd: 8 });
  assert.deepEqual(search, { value: 'informação', selectionStart: 3, selectionEnd: 5 });
  assert.deepEqual(player, { currentTime: 4, playbackRate: 1.5, paused: false }); assert.equal(timeline.scrollTop, 52);
  snapshot = conversation({ messages: [message(), message('new', { text: 'Informação nova' })] }); ui.syncContext(actor());
  assert.equal(ui.query, 'informação'); assert.equal(ui.opened, true); assert.match(ui.results(), /2 mensagens encontradas/);
});

test('jump/next/previous chamam só navegação atual, seguem ordem e rejeitam mensagem inexistente', () => {
  const { ui, snapshot, navigations } = setup();
  snapshot(conversation({ messages: [message('first'), message('second'), message('third')] })); ui.open();
  assert.equal(ui.handleAction(action(ui, 'next')), true); assert.equal(ui.handleAction(action(ui, 'next')), true);
  assert.equal(ui.handleAction(action(ui, 'previous')), true); assert.equal(ui.handleAction(action(ui, 'jump', { id: 'foreign' })), false);
  assert.deepEqual(navigations, ['third', 'second', 'third']);
  assert.match(ui.results(), /conversation-tool-result is-current/);
  const failing = setup({ navigateToMessage: () => false }); failing.ui.open(); assert.equal(failing.ui.jump('first'), false);
});

test('close permite Escape pelo root e ações de input antigo não alteram contexto seguinte', () => {
  const { ui, snapshot, notifications } = setup(); ui.open(); const oldInput = input(ui, 'segredo');
  assert.equal(ui.close(), true); assert.equal(ui.opened, false); assert.equal(ui.panel(), ''); assert.equal(ui.close(), false);
  assert.equal(notifications.at(-1).event, 'close');
  snapshot(conversation({ id: 'two' })); ui.syncContext(actor({ conversationId: 'two' }));
  assert.equal(ui.handleInput(oldInput), false); assert.equal(ui.query, '');
  ui.open(); ui.handleInput(input(ui, 'a'.repeat(240))); assert.equal(ui.query.length, 200);
  ui.reset(); assert.equal(ui.panel(), ''); assert.equal(ui.contextKey, '');
});
