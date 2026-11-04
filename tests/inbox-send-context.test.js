import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import '../public/locales-send-recovery.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createSendIntent } from '../public/send-intent.js';
import { channelCapabilities, validateAttachmentSelection, assertChannelText } from '../public/channel-capabilities.js';
import { excerpt } from './helpers/app-source.js';
import { createDataSource } from '../public/data-source.js';

const [source, mediaSource] = await Promise.all(['app.js', 'media-ui.js'].map(name => readFile(new URL('../public/' + name, import.meta.url), 'utf8')));
const listenerSource = excerpt('app-submit-listener');
const helperSource = excerpt('current-conversation-participants');
const actionSource = excerpt('act');
const listSource = excerpt('refresh-inbox-list');
const scopedRunSource = excerpt('scoped-runs');
const authoritySource = source.split('\n').find(line => line.startsWith('const inboxContactAuthority='));
assert.ok(authoritySource);
const mediaExecutable = mediaSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const file = (name = 'proprio.pdf') => new File(['arquivo sintetico proprio'], name, { type: 'application/pdf' });

function fixture({ attachment = true, steps = [] } = {}) {
  const conversation = { id: 'case-a', channelId: 'channel-a', version: 3, owner: 'human', messages: [] };
  const state = { workspaceId: 'workspace-a', supportGrantId: null, view: 'inbox', conversation: conversation.id, tenant: { id: 'company-a', channels: [{ id: 'channel-a', transport: 'telegram-bot' }], conversations: [conversation] }, boot: { csrfToken: 'synthetic-authority-a', session: { userId: 'person-a', role: 'operator', platformOwner: false, permissions: ['inbox.read', 'inbox.reply'] } }, sendIntent: null, busy: false };
  const calls = [], notices = [], effects = [], events = new Map(), revoked = [], navigation = [];
  const submit = { disabled: false, isConnected: true }, errorElement = { textContent: '' }, text = { value: 'Legenda original', focus() {} };
  const form = { id: 'message-form', isConnected: true, matches: () => false, querySelector: selector => selector === '[type="submit"]' ? submit : selector === '.form-error' ? errorElement : null, elements: { namedItem: name => name === 'text' ? text : null } };
  const modal = { close() { effects.push(['close-modal']); } }, discard = { addEventListener(type, callback) { events.set('discard-' + type, callback); } };
  const fields = { '#app': { addEventListener(type, callback) { events.set(type, callback); } }, '#message-form': form, '#message-text': text, '#messages': { scrollHeight: 10, scrollTop: 0 }, '#modal': modal, '#confirm-discard-send': discard };
  const api = async (path, options = {}) => {
    calls.push({ path, options, payload: typeof options.body === 'string' ? JSON.parse(options.body) : null });
    const next = steps.shift();
    assert.ok(next, 'Nenhuma chamada HTTP extra: ' + path);
    if (next.path) assert.equal(path, next.path);
    if (next.suffix) assert.ok(path.endsWith(next.suffix), path + ' deve terminar em ' + next.suffix);
    if (next.error) throw next.error;
    return next.pending ? next.pending : next.data || {};
  };
  const tool = { reset() {}, action: async () => false, act: async () => false, submit: async () => false };
  const repliesUI = { ...tool, replyToMessageId: 'quote-original', clearSent() { effects.push(['clear-quote']); this.replyToMessageId = null; } };
  const consolidatedInbox = { data: { offset: 0 }, load: async () => ({ items: [] }), clearDraft(ref) { effects.push(['clear-draft', ref]); }, reset() {}, forgetTenant(id) { effects.push(['forget-tenant', id]); } };
  const context = vm.createContext({ ...i18n, i18nText: i18n.t, i18nTemplate: i18n.txt, i18nHtml: i18n.html, i18nMarkup: i18n.markup, i18nLabels: i18n.labels, state, api, createSendIntent, channelCapabilities, validateAttachmentSelection, assertChannelText,
    document: { querySelector: () => null, querySelectorAll: () => [] }, URL: { createObjectURL: () => 'blob:synthetic-own-file', revokeObjectURL: value => revoked.push(value) },
    $: selector => fields[selector] || null, icon: () => '', escape: value => String(value), crypto: { randomUUID: () => 'synthetic-command-0001' },
    FormData: class { constructor(target) { this.target = target; } get(name) { return this.target.elements.namedItem(name)?.value ?? null; } },
    voiceRecorder: { ...tool, busy: false }, repliesUI, consolidatedInbox, composerBridge: { sourceRunId: null, clearSource() {} },
    canReplyTo: value => Boolean(value), canCoordinate: () => true, canManageAttendance: () => true,
    groupOpen: () => true, windowOpen: () => true, capabilitiesFor: () => channelCapabilities({ transport: 'telegram-bot' }),
    channelFor: () => ({ transport: 'telegram-bot' }), tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail,
    selectedInboxRef: () => ({ workspaceId: state.workspaceId, tenantId: state.tenant.id, conversationId: state.conversation }),
    toast: message => notices.push(message), render: () => effects.push(['render']), refresh: async () => effects.push(['refresh']),
    isRealConversation: () => true, transportName: () => 'Telegram', updateAttendanceAccess: () => effects.push(['access-update']), updateVoiceControls: () => effects.push(['voice-update']),
    openModal: (title, _description, body) => effects.push(['open-modal', title, body]), location: { assign: path => navigation.push(path) },
    resetWorkspaceSelection: () => effects.push(['reset-workspace']), updateConsolidatedList: () => effects.push(['list-update']), attendanceAction: async () => false,
    accountSecurityUI: tool, workspaceUI: tool, automationUI: tool, supportUI: tool, billingUI: tool, unitsUI: tool, knowledgeUI: tool, memoryUI: { ...tool, syncContext() {} }, mcpUI: tool, integrationsUI: tool,
    teamChatUI: tool, participantsUI: tool, contactImportUI: tool, platformUsersUI: tool, commercialUsageUI: tool, groupsWorkspaceUI: { reset: () => effects.push(['reset-groups-workspace']) }, chatLayout: tool, inboxTimeline: tool, avatarUI: tool,
    channelVisitorTestUI: { reset: () => effects.push(['reset-channel-visitor']) },
    // Seleção de grupos não é exercitada nesta fixture de uploads; só o reset do logout.
    whatsappGroupsUI: { reset: () => effects.push(['reset-whatsapp-groups']) },
    contactLinksUI: { reset() {}, action: async () => false, submit: async () => false }, contactRefresh: { reset: () => effects.push(['reset-contact-refresh']) },
    Promise, JSON, AbortController, setTimeout, clearTimeout
  });
  // The scoped runs GET goes through data-source.js (FRONTEND-V2 §8.1, P1 commit 1f) over the same fixture api.
  context.dataSource = createDataSource({ request: api });
  const makeMedia = new vm.Script(mediaExecutable + '\ncreateMediaUI', { filename: 'public/media-ui.js' }).runInContext(context);
  const mediaUI = makeMedia({ escape: value => String(value), icon: () => '', download: async () => { throw Error('Nenhum download recebido nesta fixture'); }, getPendingSend: () => Boolean(state.sendIntent) });
  for (const method of ['uploaded', 'clearSent', 'fail', 'finishSending']) {
    const original = mediaUI[method]; mediaUI[method] = (...args) => { effects.push([method, mediaUI.contextKey, ...args]); return original(...args); };
  }
  context.mediaUI = mediaUI;
  new vm.Script(helperSource + '\n' + authoritySource + '\n' + scopedRunSource + '\n' + actionSource + '\n' + listSource + '\n' + listenerSource, { filename: 'public/app.js' }).runInContext(context);
  const helpers = new vm.Script('({ attendanceContext, blockPendingSend, validatePendingSend, pendingSendMarkup, changeTenant, act, refreshInboxList })').runInContext(context);
  mediaUI.syncContext(helpers.attendanceContext()); mediaUI.retainConversations([conversation.id], state.tenant.id);
  if (attachment) mediaUI.choose(file(), text.value);
  return { state, conversation, mediaUI, repliesUI, form, submit, text, errorElement, calls, notices, effects, steps, revoked, navigation, helpers, consolidatedInbox,
    send: () => events.get('submit')({ target: form, preventDefault() {} }),
    confirmDiscard: () => events.get('discard-click')(),
    newContext({ userId = 'person-b', workspaceId = 'workspace-b', tenantId = 'company-b', authority = 'synthetic-authority-b', supportGrantId = null } = {}) {
      form.isConnected = false; submit.isConnected = false;
      state.boot = { ...state.boot, csrfToken: authority, session: { ...state.boot.session, userId } }; state.workspaceId = workspaceId; state.supportGrantId = supportGrantId;
      state.tenant = { id: tenantId, channels: [{ id: 'channel-b', transport: 'telegram-bot' }], conversations: [{ id: 'case-b', channelId: 'channel-b', version: 1, messages: [] }] }; state.conversation = 'case-b'; state.sendIntent = null;
      mediaUI.syncContext(helpers.attendanceContext()); mediaUI.retainConversations(['case-b'], tenantId); mediaUI.choose(file('nova-empresa.pdf'), 'Novo rascunho'); text.value = 'Novo rascunho';
      return mediaUI.selected;
    },
    done() { mediaUI.reset(); assert.equal(steps.length, 0, 'Todas as respostas sintéticas foram usadas'); }
  };
}

async function loseResponse(f) {
  f.steps.push({ suffix: '/attachments', data: { id: 'private-upload-a', kind: 'document' } }, { suffix: '/messages', error: new TypeError('Resposta HTTP perdida') });
  await f.send();
  assert.ok(f.state.sendIntent, 'Resposta perdida mantém o comando original');
  assert.equal(f.mediaUI.selected.uploadedId, 'private-upload-a');
  assert.equal(f.mediaUI.selected.file.name, 'proprio.pdf');
}

// Using a prepared draft is the agent rail's rail:insert-draft (agent-rail-ui.js and its tests); the
// legacy use-run-draft action left app.js in P10.

test('resposta perdida conserva payload/chave/versão e retry exato não repete upload', async () => {
  const f = fixture(); await loseResponse(f);
  const intent = f.state.sendIntent, original = f.calls.find(call => call.path.endsWith('/messages')).payload;
  f.conversation.version = 9;
  f.steps.push({ suffix: '/messages', data: { id: 'case-a' } }); await f.send();
  assert.equal(f.calls.filter(call => call.path.endsWith('/attachments')).length, 1);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/messages')).map(call => call.payload), [original, original]);
  assert.equal(original.version, intent.version); assert.equal(original.version, 3);
  assert.deepEqual(original.attachmentIds, ['private-upload-a']); assert.equal(original.replyToMessageId, 'quote-original');
  assert.equal(f.state.sendIntent, null); assert.equal(f.mediaUI.selected, null); assert.equal(f.text.value, ''); f.done();
});

for (const change of ['texto', 'citação', 'arquivo']) {
  test('retry com alteração de ' + change + ' é recusado antes de upload ou messages', async () => {
    const f = fixture(); await loseResponse(f); const intent = f.state.sendIntent, before = f.calls.length;
    if (change === 'texto') f.text.value = 'Texto substituído';
    if (change === 'citação') f.repliesUI.replyToMessageId = 'quote-other';
    if (change === 'arquivo') { f.mediaUI.selected.file = file('substituido.pdf'); f.mediaUI.selected.uploadedId = null; }
    await f.send();
    assert.equal(f.calls.length, before); assert.equal(f.state.sendIntent, intent);
    assert.match(f.notices.at(-1) || f.errorElement.textContent, /Confira o envio anterior/); f.done();
  });
}

for (const language of ['pt-BR', 'en']) {
  test('pending describes an exact-command retry, not a receipt-only read: ' + language, () => {
    const previous = i18n.getLocale(), f = fixture({ attachment: false });
    try {
      i18n.setLocale(language, { persist: false, notify: false });
      f.state.sendIntent = { idempotencyKey: 'synthetic-command-0001' };
      const panel = f.helpers.pendingSendMarkup();
      assert.match(panel, language === 'en' ? /Retry the same send/ : /Repetir o mesmo envio/);
      assert.match(panel, language === 'en' ? /same command/ : /mesmo comando/);
      assert.doesNotMatch(panel, />Conferir envio<|>Check receipt</);
      assert.equal(f.calls.length, 0, 'rendering the recovery notice never sends or checks anything');
    } finally { i18n.setLocale(previous, { persist: false, notify: false }); f.done(); }
  });
}

test('pending bloqueia troca de empresa e markup oferece conferir/descarte sem liberar comando', async () => {
  const f = fixture(); await loseResponse(f); const intent = f.state.sendIntent;
  assert.equal(await f.helpers.changeTenant('company-b'), false); assert.equal(f.state.tenant.id, 'company-a');
  assert.match(f.helpers.pendingSendMarkup(), /data-action="verify-send"/); assert.match(f.helpers.pendingSendMarkup(), /data-action="discard-send"/);
  assert.equal(f.state.sendIntent, intent); assert.equal(f.calls.length, 2); f.done();
});

test('conferir envio usa o listener novamente; descartar exige confirmação e nunca faz POST', async () => {
  const f = fixture(); await loseResponse(f); const intent = f.state.sendIntent, count = f.calls.length;
  let submits = 0; f.form.requestSubmit = () => { submits++; };
  await f.helpers.act('verify-send'); assert.equal(submits, 1); assert.equal(f.state.sendIntent, intent);
  await f.helpers.act('discard-send'); assert.equal(f.state.sendIntent, intent); assert.equal(f.calls.length, count);
  f.confirmDiscard(); assert.equal(f.state.sendIntent, null); assert.equal(f.mediaUI.selected, null); assert.equal(f.text.value, '');
  assert.equal(f.calls.length, count); assert.match(f.notices.at(-1), /Nenhuma mensagem reenviada/); f.done();
});

test('confirmação de descarte antiga não remove arquivo/intenção da nova autoridade', async () => {
  const f = fixture(); await loseResponse(f); await f.helpers.act('discard-send');
  const selected = f.newContext(), intent = { intent: 'nova-intencao' }; f.state.sendIntent = intent;
  f.confirmDiscard(); assert.equal(f.mediaUI.selected, selected); assert.equal(f.state.sendIntent, intent); assert.equal(f.text.value, 'Novo rascunho'); f.done();
});

for (const boundary of ['usuário', 'workspace', 'grant', 'autoridade']) {
  test('mudança de ' + boundary + ' durante upload não aplica recibo nem chama messages', async () => {
    const pending = deferred(), f = fixture({ steps: [{ suffix: '/attachments', pending: pending.promise }] });
    const send = f.send(); await settle(); assert.equal(f.calls.length, 1);
    const values = { userId: 'person-a', workspaceId: 'workspace-a', tenantId: 'company-a', authority: 'synthetic-authority-a' };
    if (boundary === 'usuário') values.userId = 'person-other';
    if (boundary === 'workspace') values.workspaceId = 'workspace-other';
    if (boundary === 'grant') values.supportGrantId = 'grant-other';
    if (boundary === 'autoridade') values.authority = 'synthetic-authority-other';
    const selected = f.newContext(values); pending.resolve({ id: 'old-private-upload', kind: 'document' }); await send;
    assert.equal(f.calls.length, 1); assert.equal(f.effects.filter(([name]) => name === 'uploaded').length, 0);
    assert.equal(f.mediaUI.selected, selected); assert.equal(selected.uploadedId, null); assert.equal(f.text.value, 'Novo rascunho'); f.done();
  });
}

test('logout real durante upload limpa contexto e resposta tardia não envia mensagem', async () => {
  const pending = deferred(), f = fixture({ steps: [{ suffix: '/attachments', pending: pending.promise }] });
  const send = f.send(); await settle(); f.steps.push({ path: '/api/auth/logout', data: {} }); await f.helpers.act('logout');
  assert.equal(f.effects.filter(([name]) => name === 'reset-channel-visitor').length, 1);
  assert.equal(f.effects.filter(([name]) => name === 'reset-groups-workspace').length, 1);
  assert.equal(f.effects.filter(([name]) => name === 'reset-whatsapp-groups').length, 1);
  assert.equal(f.mediaUI.contextKey, ''); pending.resolve({ id: 'old-private-upload' }); await send;
  assert.equal(f.calls.some(call => call.path.endsWith('/messages')), false); assert.equal(f.effects.filter(([name]) => name === 'uploaded').length, 0);
  assert.deepEqual(f.navigation, ['/login']); f.done();
});

test('iniciar logout invalida upload imediatamente enquanto a resposta do logout aguarda', async () => {
  const upload = deferred(), logout = deferred(), f = fixture({ steps: [{ suffix: '/attachments', pending: upload.promise }] });
  const send = f.send(); await settle();
  f.steps.push({ path: '/api/auth/logout', pending: logout.promise });
  const leaving = f.helpers.act('logout'); await settle();
  assert.equal(f.effects.filter(([name]) => name === 'reset-channel-visitor').length, 1, 'o visitante fecha antes da resposta de logout');
  assert.equal(f.effects.filter(([name]) => name === 'reset-groups-workspace').length, 1);
  assert.equal(f.effects.filter(([name]) => name === 'reset-whatsapp-groups').length, 1);
  assert.equal(f.calls.some(call => call.path === '/api/auth/logout'), true);
  upload.resolve({ id: 'private-upload-old' }); await send;
  logout.resolve({}); await leaving;
  assert.equal(f.calls.some(call => call.path.endsWith('/messages')), false, 'Logout iniciado não pode encadear messages antes de sua resposta');
  assert.equal(f.effects.some(([name]) => name === 'uploaded'), false, 'Recibo tardio não pertence mais a um compositor ativo'); f.done();
});

for (const outcome of ['confirmado', 'falha']) {
  test('callback messages antigo ' + outcome + ' não limpa/falha arquivo ou intenção novos', async () => {
    const pending = deferred(), f = fixture({ steps: [{ suffix: '/attachments', data: { id: 'private-upload-a' } }, { suffix: '/messages', pending: pending.promise }] });
    const send = f.send(); await settle(); assert.equal(f.calls.length, 2);
    const selected = f.newContext(), intent = { intent: 'novo-envio' }; f.state.sendIntent = intent;
    const before = f.effects.length;
    if (outcome === 'confirmado') pending.resolve({ id: 'case-a' }); else pending.reject(Object.assign(Error('Falha do contexto antigo'), { status: 409 }));
    await send;
    assert.equal(f.mediaUI.selected, selected); assert.equal(f.state.sendIntent, intent); assert.equal(f.text.value, 'Novo rascunho');
    assert.equal(f.effects.slice(before).some(([name]) => ['uploaded', 'clearSent', 'fail', 'finishSending', 'clear-draft', 'clear-quote'].includes(name)), false); f.done();
  });
}

test('finally do envio antigo não encerra busy nem atualiza acesso do novo envio em andamento', async () => {
  const pending = deferred(), f = fixture({ steps: [{ suffix: '/attachments', data: { id: 'private-upload-a' } }, { suffix: '/messages', pending: pending.promise }] });
  const oldSend = f.send(); await settle();
  const selected = f.newContext(); f.mediaUI.startSending('Novo rascunho'); f.state.busy = true;
  const before = f.effects.length; pending.resolve({ id: 'case-a' }); await oldSend;
  assert.equal(f.mediaUI.selected, selected); assert.equal(f.mediaUI.sending, true);
  assert.equal(f.state.busy, true, 'O novo envio conserva seu próprio lock de operação');
  assert.equal(f.effects.slice(before).some(([name]) => name === 'access-update'), false, 'Callback antigo não atualiza controles da autoridade nova'); f.done();
});

test('403 do filtro agregado não infere perda da empresa/conversa aberta', async () => {
  const f = fixture(); const selected = f.mediaUI.selected; f.state.inboxCompany = 'company-revoked';
  f.consolidatedInbox.load = async () => { throw Object.assign(Error('Filtro sem acesso'), { status: 403 }); };
  await assert.rejects(f.helpers.refreshInboxList(), error => error.status === 403);
  assert.equal(f.state.inboxCompany, 'all'); assert.equal(f.state.tenant.id, 'company-a'); assert.equal(f.state.conversation, 'case-a');
  assert.equal(f.mediaUI.selected, selected); assert.equal(f.effects.some(([name]) => name === 'forget-tenant'), false); f.done();
});
