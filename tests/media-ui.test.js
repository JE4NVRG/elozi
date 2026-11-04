import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaUI, formatFileSize } from '../public/media-ui.js';
import { channelCapabilities } from '../public/channel-capabilities.js';
import { getLocale, setLocale } from '../public/i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const attachment = (id, mime = 'audio/ogg', extra = {}) => ({ id, name: `${id}.ogg`, mime, size: 128, preview: true, status: 'ready', ...extra });
const conversation = attachments => ({ messages: [{ attachments }] });
const actor = (conversationId = 'one', tenantId = 'tenant', active = true) => ({ userId: 'operator', workspaceId: 'workspace', authorityKey: 'access-v1', tenantId, conversationId, active });
function setup(t, download = async () => new Blob(['synthetic'], { type: 'audio/ogg' }), options = {}) {
  const created = [], revoked = [];
  t.mock.method(URL, 'createObjectURL', blob => { const url = `blob:synthetic-${created.length}`; created.push({ url, blob }); return url; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const ui = createMediaUI({ escape, icon: name => `<svg data-icon="${name}"></svg>`, download, ...options });
  ui.syncContext(actor());
  t.after(() => ui.reset());
  return { ui, created, revoked };
}
function mockDocument(t, document) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
}
const action = (ui, item, options = {}) => ui.handleAction({ dataset: { mediaAction: 'preview', id: item.id } }, { conversation: conversation([item]), base: '/authenticated/conversation', canReply: true, renderMessages() { throw new Error('A mídia não pode recriar a conversa.'); }, ...options });

test('tamanho de arquivo trata valores ausentes e negativos', () => {
  assert.equal(formatFileSize(-1), 'Tamanho não informado');
  assert.equal(formatFileSize(undefined), 'Tamanho não informado');
  assert.equal(formatFileSize(128), '128 B');
  assert.equal(formatFileSize(1024), '1 KB');
});

test('cards escapam nomes, ignoram URLs externas e mostram preparação/expiração', t => {
  const { ui } = setup(t);
  const markup = ui.messageAttachments({ attachments: [attachment('one', 'image/jpeg', { name: '<img src=x onerror=bad()>', url: 'https://untrusted.invalid/photo', thumbnail: 'javascript:bad()' }), attachment('two', 'audio/ogg', { status: 'pending' }), attachment('three', 'video/mp4', { status: 'unavailable', reason: 'expired' })] });
  assert.match(markup, /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.doesNotMatch(markup, /https:|javascript:|<img /);
  assert.match(markup, /Preparando arquivo/);
  assert.match(markup, /expirou no canal/);
  assert.match(ui.fileButton(), /Anexar/);
  assert.doesNotMatch(ui.fileButton(), /Gravar/);
});

test('Anexar mantém nome acessível em PT/EN, limites e bloqueio quando compactado', t => {
  const { ui } = setup(t), previous = getLocale();
  t.after(() => setLocale(previous));
  for (const [locale, label] of [['pt-BR', 'Anexar'], ['en', 'Attach']]) {
    setLocale(locale);
    const markup = String(ui.fileButton());
    assert.match(markup, new RegExp(`aria-label="${label}" title="${label}"`));
    assert.match(markup, new RegExp(`<span class="pg-inbox__tool-label">${label}</span>`));
    assert.match(markup, /data-icon="paperclip"/);
    assert.match(markup, /aria-describedby="attachment-limit"/);
    assert.match(markup, /id="attachment-limit" class="sr-only"/);
    assert.match(String(ui.fileButton(true)), /\sdisabled(?:\s|>)/);
  }
});

test('arquivo histórico sem conteúdo explica a limitação em PT/EN sem oferecer download ou recuperação', t => {
  const { ui } = setup(t), previous = getLocale();
  t.after(() => setLocale(previous));
  const item = attachment('old-photo', 'image/jpeg', { status: 'unavailable', preview: false, reason: 'historical_not_downloaded' });
  for (const [locale, title, detail] of [['pt-BR', 'conteúdo não importado', 'Não há uma cópia disponível'], ['en', 'content not imported', 'Elozi has no copy available']]) {
    setLocale(locale);
    const markup = ui.messageAttachments({ attachments: [item] });
    assert.ok(markup.includes(title)); assert.ok(markup.includes(detail));
    assert.doesNotMatch(markup, /data-media-action|<img /);
  }
});

test('seleção inválida mantém o arquivo anterior e o texto', t => {
  const { ui } = setup(t);
  const file = new File(['audio'], 'voz.ogg', { type: 'audio/ogg' });
  ui.choose(file, 'Legenda preservada');
  ui.choose({ size: 0, name: 'empty' }, ui.draft);
  assert.equal(ui.selected.file, file);
  assert.match(ui.composer(), /arquivo está vazio/);
  ui.choose({ size: 16 * 1024 * 1024 + 1 }, ui.draft);
  assert.equal(ui.selected.file, file);
  assert.equal(ui.draft, 'Legenda preservada');
});

test('rascunhos por conversa preservam texto e File/voice, recriando somente sua URL', t => {
  const { ui, revoked } = setup(t);
  const file = new File(['voice'], 'gravacao.ogg', { type: 'audio/ogg' });
  ui.choose(file, 'texto um'); ui.selected.voice = true;
  const firstURL = ui.selected.url;
  assert.equal(ui.syncContext(actor('two'), 'texto um editado'), true);
  assert.equal(ui.draft, ''); assert.equal(ui.selected, null);
  ui.draft = 'texto dois';
  ui.syncContext(actor('one'), 'texto dois');
  assert.equal(ui.draft, 'texto um editado');
  assert.equal(ui.selected.file, file); assert.equal(ui.selected.voice, true);
  assert.notEqual(ui.selected.url, firstURL); assert.ok(revoked.includes(firstURL));
  ui.syncContext(actor('two'), ui.draft);
  assert.equal(ui.draft, 'texto dois');
});

test('sair do atendimento e trocar empresa conservam rascunhos, reset elimina contexto antigo', t => {
  const { ui } = setup(t);
  ui.draft = 'guardado'; ui.syncContext(actor('one', 'tenant', false), 'guardado');
  assert.equal(ui.draft, ''); ui.syncContext(actor()); assert.equal(ui.draft, 'guardado');
  ui.syncContext(actor('one', 'other'), 'texto da empresa anterior');
  assert.equal(ui.draft, ''); ui.syncContext(actor()); assert.equal(ui.draft, 'texto da empresa anterior');
  ui.draft = 'antigo'; ui.reset(); ui.syncContext(actor(), 'textarea antigo');
  assert.equal(ui.draft, '');
});

test('clearSent limpa só a conversa atual, sem apagar outro rascunho', t => {
  const { ui } = setup(t);
  ui.draft = 'um'; ui.syncContext(actor('two'), 'um'); ui.draft = 'dois';
  ui.clearSent(); ui.syncContext(actor('one'), ''); assert.equal(ui.draft, 'um');
  ui.syncContext(actor('two'), 'um'); assert.equal(ui.draft, '');
});

test('retainConversations descarta rascunhos revogados e impede restaurar conversa sem acesso', t => {
  const { ui, revoked } = setup(t);
  ui.choose(new File(['voice'], 'private.ogg', { type: 'audio/ogg' }), 'texto privado');
  ui.syncContext(actor('two'), ui.draft); ui.draft = 'outro texto';
  assert.equal(ui.retainConversations(['two']), true);
  ui.syncContext(actor('one'), 'outro texto'); assert.equal(ui.draft, ''); assert.equal(ui.selected, null);
  ui.syncContext(actor('two'), ''); assert.equal(ui.draft, 'outro texto');
  ui.choose(new File(['voice'], 'second.ogg', { type: 'audio/ogg' }));
  const currentURL = ui.selected.url;
  assert.equal(ui.retainConversations([]), false); assert.equal(ui.draft, ''); assert.equal(ui.selected, null); assert.ok(revoked.includes(currentURL));
  ui.syncContext(actor('two'), 'textarea anterior'); assert.equal(ui.draft, '');
});

test('empresas com o mesmo ID de conversa preservam File/voz/legenda e upload apenas na origem', t => {
  const { ui, revoked } = setup(t);
  const voice = new File(['voice A'], 'voz-a.ogg', { type: 'audio/ogg' });
  const photo = new File(['photo B'], 'foto-b.png', { type: 'image/png' });
  ui.choose(voice, 'Legenda A'); ui.selected.voice = true;
  ui.uploaded({ id: 'upload-A', kind: 'audio' });
  const first = ui.selected, firstURL = first.url, firstContext = ui.contextKey;
  ui.syncContext(actor('one', 'other'), 'Legenda A editada');
  assert.equal(ui.selected, null); assert.equal(ui.draft, '');
  assert.ok(revoked.includes(firstURL)); assert.equal(first.url, null);
  assert.notEqual(ui.contextKey, firstContext);
  ui.choose(photo, 'Legenda B'); ui.uploaded({ id: 'upload-B', kind: 'image' });
  const second = ui.selected;
  ui.syncContext(actor(), 'Legenda B editada');
  assert.equal(ui.contextKey, firstContext);
  assert.equal(ui.selected, first); assert.equal(ui.selected.file, voice); assert.equal(ui.selected.voice, true);
  assert.equal(ui.draft, 'Legenda A editada'); assert.equal(ui.selected.uploadedId, 'upload-A'); assert.equal(ui.selected.kind, 'audio');
  assert.notEqual(ui.selected.url, firstURL);
  ui.syncContext(actor('one', 'other'), ui.draft);
  assert.equal(ui.selected, second); assert.equal(ui.selected.file, photo); assert.equal(ui.selected.uploadedId, 'upload-B'); assert.equal(ui.draft, 'Legenda B editada');
});

test('snapshot e revogação de uma empresa preservam outra e não ressuscitam texto ou arquivo revogado', t => {
  const { ui, revoked } = setup(t);
  const voice = new File(['voice A'], 'voz-a.ogg', { type: 'audio/ogg' });
  const photo = new File(['photo B'], 'foto-b.png', { type: 'image/png' });
  ui.choose(voice, 'Empresa A'); ui.syncContext(actor('one', 'other'), ui.draft);
  ui.choose(photo, 'Empresa B');
  assert.equal(ui.retainConversations(['one'], 'tenant'), true);
  assert.equal(ui.selected.file, photo); assert.equal(ui.draft, 'Empresa B');
  ui.syncContext(actor(), ui.draft); assert.equal(ui.selected.file, voice);
  ui.uploaded({ id: 'revoked-upload', kind: 'audio' }); const revokedSelection = ui.selected;
  const activeURL = ui.selected.url;
  assert.equal(ui.forgetTenant('tenant'), false);
  assert.equal(ui.selected, null); assert.equal(ui.draft, ''); assert.ok(revoked.includes(activeURL));
  assert.equal(revokedSelection.uploadedId, null); assert.equal(revokedSelection.kind, undefined);
  ui.syncContext(actor(), 'textarea revogado'); ui.choose(voice, 'arquivo revogado');
  assert.equal(ui.selected, null); assert.equal(ui.draft, '');
  ui.syncContext(actor('one', 'other'), 'textarea revogado');
  assert.equal(ui.selected.file, photo); assert.equal(ui.draft, 'Empresa B');
  ui.retainConversations(['one'], 'tenant'); ui.syncContext(actor(), ui.draft);
  assert.equal(ui.selected, null); assert.equal(ui.draft, '');
});

test('envio incerto trava contexto e payload; retry mantém texto readonly presente no formulário', async t => {
  let pending = false;
  const { ui } = setup(t, undefined, { getPendingSend: () => pending });
  ui.choose(new File(['voice'], 'voz.ogg', { type: 'audio/ogg' }), 'Payload original');
  ui.uploaded({ id: 'same-upload', kind: 'audio' });
  const selected = ui.selected, key = ui.contextKey;
  const text = { tagName: 'TEXTAREA', value: 'Payload original', disabled: false, readOnly: false };
  const [file, voice, quote, emoji, remove, submit, verify, discard] = Array.from({ length: 8 }, () => ({ disabled: false }));
  const selection = { dataset: {}, innerHTML: '', querySelectorAll: () => [] }, output = { textContent: '' };
  const controls = [text, file, voice, quote, emoji, remove, submit, verify, discard];
  const form = { dataset: { mediaEnabled: 'true' }, setAttribute() {}, querySelectorAll: selector => selector === 'button,input,textarea' ? controls : selector === '[type="submit"],[data-action="verify-send"]' ? [submit, verify] : selector === '[data-action="discard-send"]' ? [discard] : [], querySelector: selector => selector === '#message-text' ? text : selector === '#attachment-selection' ? selection : selector === '#message-media-error' || selector === '#message-media-status' ? output : null };
  mockDocument(t, { querySelector: selector => selector === '#message-form' ? form : null, querySelectorAll: () => [] });
  pending = true; ui.updateComposer();
  assert.equal(text.readOnly, true); assert.equal(text.disabled, false); assert.equal(text.value, 'Payload original');
  assert.deepEqual([file, voice, quote, emoji, remove].map(control => control.disabled), [true, true, true, true, true]);
  assert.deepEqual([submit, verify, discard].map(control => control.disabled), [false, false, false]);
  ui.updateComposer(true);assert.equal(submit.disabled,true);assert.equal(verify.disabled,true);assert.equal(discard.disabled,false,'Canal sem resposta permite descarte local sem envio');ui.updateComposer();
  assert.equal(ui.syncContext(actor('one', 'other'), 'Texto adulterado'), false);
  assert.equal(ui.syncContext(actor('one', 'tenant', false), 'Texto adulterado'), false);
  ui.syncContext(actor(), 'Texto adulterado');
  ui.choose(new File(['new'], 'outro.png', { type: 'image/png' }), 'Novo payload');
  await ui.handleAction({ dataset: { mediaAction: 'remove' } }, { canReply: true });
  assert.equal(ui.selected, selected); assert.equal(ui.selected.uploadedId, 'same-upload'); assert.equal(ui.draft, 'Payload original'); assert.equal(ui.contextKey, key);
  assert.match(ui.composer(), /Confira o envio pendente/);
  pending = false; ui.updateComposer(); assert.equal(text.readOnly, false);
  assert.equal(ui.syncContext(actor('one', 'other'), ui.draft), true);
  assert.equal(ui.selected, null); ui.syncContext(actor()); assert.equal(ui.selected, selected);
  pending = true; ui.syncContext({ ...actor(), authorityKey: 'access-revoked' }, 'Texto antigo');
  assert.equal(ui.selected, null); assert.equal(ui.draft, ''); assert.equal(selected.uploadedId, null); assert.notEqual(ui.contextKey, key);
});

test('trocar identidade, workspace ou autoridade elimina todos os arquivos e não importa textarea antigo', t => {
  const { ui, revoked } = setup(t);
  for (const change of [{ userId: 'another' }, { workspaceId: 'another' }, { authorityKey: 'support-expired' }, { userId: '' }]) {
    ui.reset(); ui.syncContext(actor());
    ui.choose(new File(['private'], 'primeiro.ogg', { type: 'audio/ogg' }), 'Empresa A');
    const firstURL = ui.selected.url;
    ui.syncContext(actor('one', 'other'), ui.draft);
    ui.choose(new File(['private'], 'segundo.ogg', { type: 'audio/ogg' }), 'Empresa B');
    const secondURL = ui.selected.url;
    ui.syncContext({ ...actor('one', 'other'), ...change }, 'textarea antigo');
    assert.equal(ui.selected, null); assert.equal(ui.draft, '');
    assert.ok(revoked.includes(firstURL)); assert.ok(revoked.includes(secondURL));
    ui.syncContext(actor(), 'outro textarea antigo');
    assert.equal(ui.selected, null); assert.equal(ui.draft, '');
  }
});

test('quinto arquivo em RAM é recusado e os quatro anteriores ficam preservados', t => {
  const { ui } = setup(t);
  for (let index = 0; index < 4; index++) {
    ui.syncContext(actor(`file-${index}`, index % 2 ? 'other' : 'tenant'));
    ui.choose(new File(['audio'], `${index}.ogg`, { type: 'audio/ogg' }), `texto ${index}`);
  }
  ui.syncContext(actor('fifth'), 'texto 3');
  ui.choose(new File(['audio'], 'quinto.ogg', { type: 'audio/ogg' }), 'texto quinto');
  assert.equal(ui.selected, null); assert.equal(ui.draft, 'texto quinto');
  assert.match(ui.composer(), /quatro arquivos guardados/);
  ui.syncContext(actor('file-0'), ui.draft); assert.equal(ui.selected.file.name, '0.ogg');
});

test('autoridade ausente não restaura nem importa arquivo, recibo ou textarea antigo',t=>{
 const {ui}=setup(t);ui.syncContext(actor('own'));ui.choose(new File(['original'],'own.txt',{type:'text/plain'}),'legenda privada');ui.uploaded({id:'own-upload',kind:'document'});
 assert.equal(ui.syncContext({...actor('own'),authorityKey:undefined},'texto antigo'),true);assert.equal(ui.contextKey,'');assert.equal(ui.selected,null);assert.equal(ui.draft,'');
 ui.syncContext(actor('own'),'texto antigo');assert.equal(ui.selected,null);assert.equal(ui.draft,'');
});

test('limite de 200 rascunhos bloqueia a troca sem descartar texto', t => {
  const { ui } = setup(t);
  for (let index = 0; index < 200; index++) { ui.draft = `texto ${index}`; assert.equal(ui.syncContext(actor(`draft-${index + 1}`, index % 2 ? 'other' : 'tenant'), ui.draft), true); }
  ui.draft = 'texto 201';
  assert.equal(ui.syncContext(actor('next'), ui.draft), false);
  assert.equal(ui.draft, 'texto 201'); assert.match(ui.composer(), /200 rascunhos guardados/);
  ui.clearSent(); assert.equal(ui.syncContext(actor('one'), ''), true); assert.equal(ui.draft, 'texto 0');
});

test('hydrate carrega somente quatro previews recentes, por endpoint autenticado e id codificado', async t => {
  const paths = [];
  const { ui } = setup(t, async path => { paths.push(path); return new Blob(['audio'], { type: 'audio/ogg' }); }, { previewCacheLimit: 4, previewOnOpen: 4 });
  const items = [attachment('old'), attachment('a'), attachment('b'), attachment('c'), attachment('d /?'), attachment('document', 'text/plain', { preview: false }), attachment('pending', 'audio/ogg', { status: 'pending' })];
  await ui.hydrate(conversation(items), '/private/conversation');
  assert.equal(paths.length, 4); assert.ok(paths.every(path => path.startsWith('/private/conversation/attachments/')));
  assert.ok(paths.includes('/private/conversation/attachments/d%20%2F%3F')); assert.ok(!paths.some(path => path.endsWith('/old')));
  const markup = ui.messageAttachments({ attachments: [items[4]] });
  assert.match(markup, /<audio .*src="blob:synthetic-/); assert.match(markup, /data-media-rate="1.5"/); assert.match(markup, /Pronto para ouvir/);
});

test('downloads simultâneos se deduplicam e trocar conversa aborta resultado tardio', async t => {
  let resolve, requests = 0, signal;
  const { ui, created } = setup(t, (_path, requestSignal) => { requests++; signal = requestSignal; return new Promise(done => { resolve = done; }); });
  const item = attachment('audio');
  const first = action(ui, item), second = action(ui, item);
  assert.equal(requests, 1); ui.syncContext(actor('two'), ''); assert.equal(signal.aborted, true);
  resolve(new Blob(['audio'], { type: 'audio/ogg' })); await Promise.all([first, second]);
  assert.equal(created.length, 0); assert.doesNotMatch(ui.messageAttachments({ attachments: [item] }), /<audio /);
});

test('trocar empresa cancela download e players sem perder voz; voltar não aceita resultado tardio', async t => {
  const pending = [];
  const { ui, created } = setup(t, (_path, signal) => new Promise(resolve => pending.push({ resolve, signal })));
  const file = new File(['voice'], 'rascunho.ogg', { type: 'audio/ogg' });
  ui.choose(file, 'Legenda'); ui.selected.voice = true;
  const counters = [];
  const roots = ['#messages', '#attachment-selection'].map(selector => {
    const count = { selector, pause: 0, clear: 0, load: 0 }; counters.push(count);
    return { querySelectorAll: () => [{ pause() { count.pause++; }, removeAttribute(name) { assert.equal(name, 'src'); count.clear++; }, load() { count.load++; } }] };
  });
  mockDocument(t, { querySelector: selector => selector === '#messages' ? roots[0] : selector === '#attachment-selection' ? roots[1] : null, querySelectorAll: () => [] });
  const item = attachment('same-id'), oldRequest = action(ui, item);
  ui.syncContext(actor('one', 'other'), ui.draft);
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(counters.map(({ pause, clear, load }) => [pause, clear, load]), [[1, 1, 1], [1, 1, 1]]);
  ui.syncContext(actor()); assert.equal(ui.selected.file, file); assert.equal(ui.selected.voice, true); assert.equal(ui.draft, 'Legenda');
  const freshRequest = action(ui, item);
  pending[0].resolve(new Blob(['old'], { type: 'audio/ogg' })); await oldRequest;
  assert.equal(created.length, 2); assert.doesNotMatch(ui.messageAttachments({ attachments: [item] }), /<audio /);
  pending[1].resolve(new Blob(['fresh'], { type: 'audio/ogg' })); await freshRequest;
  assert.equal(created.length, 3); assert.match(ui.messageAttachments({ attachments: [item] }), /<audio /);
});

test('falha de preview não dispara retries automáticos, ação explícita permite tentar novamente', async t => {
  let attempts = 0;
  const { ui } = setup(t, async () => { if (++attempts === 1) throw new Error('Falha sintética'); return new Blob(['audio'], { type: 'audio/ogg' }); });
  const item = attachment('audio'), c = conversation([item]);
  await ui.hydrate(c, '/private'); await ui.hydrate(c, '/private'); assert.equal(attempts, 1);
  assert.match(ui.messageAttachments({ attachments: [item] }), /Falha sintética/);
  await action(ui, item); assert.equal(attempts, 2); assert.match(ui.messageAttachments({ attachments: [item] }), /<audio /);
});

test('falha ao carregar mídia antiga visível é consumida pelo observer e permite retry explícito', async t => {
  let attempts = 0, observer;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback, options) { observer = this; this.callback = callback; this.root = options.root; }
    observe() {} unobserve() {} disconnect() {}
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'IntersectionObserver', descriptor); else delete globalThis.IntersectionObserver; });
  const item = attachment('old-photo', 'image/jpeg');
  const card = { dataset: { attachmentId: item.id }, querySelector: () => null, querySelectorAll: () => [], set outerHTML(_markup) {} };
  const timeline = { querySelectorAll: selector => selector === '.message-attachment[data-attachment-id]' ? [card] : [] };
  mockDocument(t, { querySelector: selector => selector === '#messages' ? timeline : null, querySelectorAll: selector => selector === '.message-attachment[data-attachment-id]' ? [card] : [] });
  const { ui } = setup(t, async () => { if (++attempts === 1) throw new Error('Falha antiga sintética'); return new Blob(['photo'], { type: 'image/jpeg' }); }, { previewOnOpen: 0 });
  await ui.hydrate(conversation([item]), '/private');
  observer.callback([{ target: card, isIntersecting: true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1); assert.match(ui.messageAttachments({ attachments: [item] }), /Falha antiga sintética|Tentar novamente/);
  observer.callback([{ target: card, isIntersecting: true }]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(attempts, 1);
  await action(ui, item); assert.equal(attempts, 2); assert.match(ui.messageAttachments({ attachments: [item] }), /<img /);
});

test('cache mantém quatro blobs, revoga os antigos e respeita uso recente', async t => {
  const { ui, created, revoked } = setup(t, undefined, { previewCacheLimit: 4, previewOnOpen: 4 });
  for (const id of ['a', 'b', 'c', 'd']) await action(ui, attachment(id));
  await action(ui, attachment('a')); await action(ui, attachment('e'));
  assert.equal(created.length, 5); assert.deepEqual(revoked, ['blob:synthetic-1']);
  assert.match(ui.messageAttachments({ attachments: [attachment('a')] }), /<audio /);
  assert.doesNotMatch(ui.messageAttachments({ attachments: [attachment('b')] }), /<audio /);
  ui.reset(); assert.equal(revoked.length, 5);
});

test('previews automáticos reservam espaço ao áudio em reprodução e evitam churn de downloads', async t => {
  const calls = [];
  const { ui } = setup(t, async path => { calls.push(path); return new Blob(['audio'], { type: 'audio/ogg' }); }, { previewCacheLimit: 4, previewOnOpen: 4 });
  await action(ui, attachment('playing'));
  const player = { paused: false, closest: () => ({ dataset: { attachmentId: 'playing' } }) };
  mockDocument(t, { querySelector: () => null, querySelectorAll: selector => selector === '.message-attachment audio,.message-attachment video' ? [player] : [] });
  const c = conversation(['playing', 'a', 'b', 'c', 'd'].map(id => attachment(id)));
  await ui.hydrate(c, '/private'); await ui.hydrate(c, '/private');
  assert.equal(calls.length, 4);
  assert.match(ui.messageAttachments({ attachments: [attachment('playing')] }), /<audio /);
});

test('MIME binário divergente nunca vira preview ativo, mas permanece disponível para baixar', async t => {
  const { ui } = setup(t, async () => new Blob(['<script>synthetic</script>'], { type: 'text/html' }));
  const item = attachment('photo', 'image/jpeg'); await action(ui, item);
  const markup = ui.messageAttachments({ attachments: [item] });
  assert.doesNotMatch(markup, /<img /); assert.match(markup, /não permite prévia/); assert.match(markup, /data-media-action="download"/);
});

test('binário vazio ou acima de 16 MiB falha sem criar blobURL', async t => {
  const { ui, created } = setup(t, async path => path.endsWith('/empty') ? { size: 0 } : { size: 16 * 1024 * 1024 + 1 });
  await assert.rejects(action(ui, attachment('empty')), /está vazio/);
  await assert.rejects(action(ui, attachment('large')), /limite de download/);
  assert.equal(created.length, 0);
});

test('baixar um áudio já carregado preserva o player e não renderiza a conversa', async t => {
  const { ui, created } = setup(t); const item = attachment('audio'); await action(ui, item);
  let replaced = 0, clicked = 0;
  const player = { getAttribute: () => created[0].url };
  const card = { dataset: { attachmentId: item.id }, querySelector: () => player, set outerHTML(_markup) { replaced++; } };
  mockDocument(t, { querySelector: () => null, querySelectorAll: selector => selector.startsWith('.message-attachment') ? [card] : [], body: { append() {} }, createElement: () => ({ click() { clicked++; }, remove() {} }) });
  await ui.handleAction({ dataset: { mediaAction: 'download', id: item.id } }, { conversation: conversation([item]), base: '/private', renderMessages() { throw new Error('Não deveria renderizar tudo.'); } });
  assert.equal(replaced, 0); assert.equal(clicked, 1); assert.equal(created.length, 1);
});

test('bindPlayers aplica velocidades e estado acessível sem duplicar listeners', t => {
  const { ui } = setup(t);
  const buttons = [1, 1.5, 2].map(rate => Object.assign(new EventTarget(), { dataset: { mediaRate: String(rate) }, states: [], setAttribute(_key, value) { this.states.push(value); } }));
  const container = { querySelector: () => player, querySelectorAll: () => buttons };
  let assignments = 0, rate = 1;
  const player = Object.assign(new EventTarget(), { tagName: 'AUDIO', closest: selector => selector === '.message-attachment' ? null : container });
  Object.defineProperty(player, 'playbackRate', { get: () => rate, set(value) { assignments++; rate = value; player.dispatchEvent(new Event('ratechange')); } });
  for (const button of buttons) button.closest = () => container;
  const root = { querySelectorAll: selector => selector === '[data-media-rate]' ? buttons : [player] };
  mockDocument(t, { querySelector: () => null, querySelectorAll: () => [] });
  ui.bindPlayers(root); ui.bindPlayers(root); buttons[1].dispatchEvent(new Event('click'));
  assert.equal(assignments, 1); assert.equal(player.playbackRate, 1.5);
  assert.deepEqual(buttons.map(button => button.states.at(-1)), ['false', 'true', 'false']);
});

test('updateComposer preserva o player selecionado ao alterar só erro/status/disabled', t => {
  const { ui } = setup(t);
  ui.choose(new File(['voice'], 'voice.ogg', { type: 'audio/ogg' }), 'texto');
  const markup = ui.composer();
  const key = markup.match(/data-selection-key="([^"]*)"/)[1].replace(/&quot;/g, '"');
  let replaced = 0;
  const selection = { dataset: { selectionKey: key }, set innerHTML(_markup) { replaced++; } };
  const output = { textContent: '' };
  const form = { dataset: { mediaEnabled: 'true' }, setAttribute() {}, querySelectorAll: () => [], querySelector: selector => selector === '#attachment-selection' ? selection : selector === '[data-action="run-agent"]' ? null : output };
  mockDocument(t, { querySelector: selector => selector === '#message-form' ? form : null, querySelectorAll: () => [] });
  ui.fail('Falha sintética'); ui.updateComposer(true); ui.updateComposer(false);
  assert.equal(replaced, 0);
});

test('compositor permite anexo sem texto e preserva arquivo/rascunho ao revogar e restaurar fotos', t => {
  setup(t);
  let permissions={text:false,photos:true,audios:false,documents:false,videos:false,voiceNotes:false};
  const ui=createMediaUI({escape,icon:()=>'',download:async()=>assert.fail('Este ensaio não lê mídia'),getCapabilities:()=>channelCapabilities({transport:'telegram-bot'},{},{group:{canSend:true,sendPermissions:permissions}})});
  ui.syncContext(actor());t.after(()=>ui.reset());
  const [field,submit,file,voice,quick,emoji]=Array.from({length:6},()=>({disabled:false}));
  const selection={dataset:{},innerHTML:'',querySelectorAll:()=>[]},failure={textContent:''},status={textContent:''};
  const form={dataset:{mediaEnabled:'true'},setAttribute(){},querySelectorAll:selector=>selector==='button,input,textarea'?[field,submit,file,voice,quick,emoji]:selector==='[data-voice-action]'?[voice]:selector==='#message-file,[data-media-action="choose"]'?[file]:selector==='#message-text,[data-reply-action="open"],[data-action="composer-emoji"]'?[field,quick,emoji]:selector==='[type="submit"]'?[submit]:[],querySelector:selector=>selector==='#attachment-selection'?selection:selector==='#message-media-error'?failure:selector==='#message-media-status'?status:null};
  mockDocument(t,{querySelector:selector=>selector==='#message-form'?form:selector==='#attachment-selection'?selection:null,querySelectorAll:()=>[]});
  ui.updateComposer();assert.equal(field.disabled,true);assert.equal(submit.disabled,true);assert.equal(file.disabled,false);assert.equal(voice.disabled,true);
  ui.choose(new File(['png'],'foto.png',{type:'image/png'}),'Legenda preservada');ui.updateComposer();
  const selected=ui.selected;assert.equal(field.disabled,false);assert.equal(submit.disabled,false);
  permissions={...permissions,photos:false};ui.updateComposer();assert.equal(submit.disabled,true);assert.match(failure.textContent,/permissão/);assert.equal(ui.selected,selected);assert.equal(ui.draft,'Legenda preservada');
  permissions={...permissions,photos:true};ui.updateComposer();assert.equal(submit.disabled,false);assert.equal(failure.textContent,'');assert.equal(ui.selected,selected);
  ui.clearSent();ui.updateComposer();assert.equal(field.disabled,true);assert.equal(submit.disabled,true);assert.equal(file.disabled,false);
});

test('padrão: abrir a conversa carrega até 12 prévias recentes sem clique; o cache guarda 40', async t => {
  const paths = [];
  const { ui } = setup(t, async path => { paths.push(path); return new Blob(['image'], { type: 'image/png' }); });
  const items = Array.from({ length: 15 }, (_, index) => attachment('foto-' + index, 'image/png'));
  await ui.hydrate(conversation(items), '/private/conversation');
  assert.equal(paths.length, 12, 'as 12 mais recentes');
  assert.ok(!paths.some(path => /foto-(0|1|2)$/.test(path)), 'as mais antigas esperam aparecer na tela');
});
