import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { createMediaUI } from '../public/media-ui.js';
import { createRepliesUI } from '../public/replies-ui.js';
import { createSendIntent } from '../public/send-intent.js';
import { excerpt } from './helpers/app-source.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const actionSource = excerpt('reply-action');
const replyContextSource = source.split('\n').find(line => line.startsWith('const replyContextKey='));
const pendingGuardSource = source.split('\n').find(line => line.startsWith('function blockPendingSend('));
assert.ok(replyContextSource && pendingGuardSource, 'Exercitar as guardas atuais do app servido.');

function fixture() {
  const conversation = id => ({ id, channelId: 'channel-A', version: 1, status: 'open', owner: 'human', assignedUserId: 'owner' });
  const state = { workspaceId: 'workspace', tenant: { id: 'A', conversations: [conversation('conv-A')] }, conversation: 'conv-A', boot: { session: { role: 'reseller', userId: 'owner' } }, busy: false, sendIntent: null };
  const textarea = { value: 'Rascunho preservado. ', focus() {}, disabled: false }, modal = { closes: 0, open: true, close() { this.closes++; this.open = false; } };
  const target = { dataset: { replyAction: 'insert', id: 'reply-A' }, isConnected: true };
  const calls = [], inserts = [], toasts = [];
  const mediaUI = createMediaUI({ escape: String, icon: () => '', getPendingSend: () => Boolean(state.sendIntent), download: () => assert.fail('Resposta rápida não baixa anexos.') });
  mediaUI.syncContext({ userId: 'owner', workspaceId: 'workspace', authorityKey: 'synthetic-authority', tenantId: 'A', conversationId: 'conv-A', active: true }); mediaUI.draft = textarea.value;
  const repliesUI = createRepliesUI();
  repliesUI.syncContext({ workspaceId: 'workspace', tenantId: 'A', conversationId: 'conv-A', active: true, messages: [] });
  const insert = repliesUI.insert;
  repliesUI.insert = (item, field) => { const result = insert(item, field); if (result.ok) inserts.push({ item, tenantId: state.tenant.id, conversationId: state.conversation }); return result; };
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const canReplyTo = item => Boolean(item && item.status !== 'closed' && item.owner === 'human' && item.assignedUserId === state.boot.session.userId);
  const context = createContext({
    ...i18n,
    state, mediaUI, voiceRecorder: { busy: false }, canReplyTo,
    tenantApi: action => `/api/tenants/${state.tenant.id}/${action}`,
    api: (path, options) => { calls.push({ path, options }); return pending; },
    $: selector => selector === '#message-text' ? textarea : selector === '#modal' ? modal : null,
    repliesUI,
    loadQuickReplies() { throw new Error('Carregamento inesperado neste fluxo.'); },
    showQuickReplies() {}, toast: (...args) => toasts.push(args), openModal() {}
  });
  const { replyAction, replyContextKey: contextKey } = new Script(`${replyContextSource}\n${pendingGuardSource}\n${actionSource}\n({replyAction,replyContextKey});`).runInContext(context);
  state.repliesModalContext = contextKey();
  return { state, target, textarea, modal, calls, inserts, mediaUI, conversation, contextKey, replyAction, toasts, finish: () => finish({ replies: [{ id: 'reply-A', active: true, text: 'Texto da empresa A.' }] }) };
}

test('retorno atrasado da empresa A não insere no compositor da empresa B após novo modal', async () => {
  const c = fixture(), pending = c.replyAction(c.target), before = c.textarea.value;
  assert.equal(c.calls[0].path, '/api/tenants/A/quick-replies');
  c.target.isConnected = false;
  c.state.tenant = { id: 'B', conversations: [c.conversation('conv-B')] };
  c.state.conversation = 'conv-B'; c.state.repliesModalContext = c.contextKey();
  c.finish();
  await assert.rejects(pending);
  assert.equal(c.inserts.length, 0); assert.equal(c.textarea.value, before); assert.equal(c.mediaUI.draft, before); assert.equal(c.modal.closes, 0);
});

test('retorno do catálogo não reutiliza botão de modal fechado no mesmo atendimento', async () => {
  const c = fixture(), pending = c.replyAction(c.target), before = c.textarea.value;
  c.target.isConnected = false; c.modal.open = false;
  c.finish();
  await pending;
  assert.equal(c.inserts.length, 0); assert.equal(c.textarea.value, before); assert.equal(c.modal.closes, 0);
});

test('inserção revalida o responsável após aguardar o catálogo', async () => {
  const c = fixture(), pending = c.replyAction(c.target), before = c.textarea.value;
  c.state.tenant.conversations[0].assignedUserId = 'outro-atendente';
  c.finish();
  await assert.rejects(pending);
  assert.equal(c.inserts.length, 0); assert.equal(c.textarea.value, before); assert.equal(c.modal.closes, 0);
});

test('contexto e responsável preservados inserem no rascunho sem enviar mensagem', async () => {
  const c = fixture(), pending = c.replyAction(c.target), before = c.textarea.value;
  c.finish(); await pending;
  assert.equal(c.inserts.length, 1); assert.equal(c.inserts[0].tenantId, 'A'); assert.equal(c.inserts[0].conversationId, 'conv-A');
  assert.equal(c.textarea.value, `${before}Texto da empresa A.`); assert.equal(c.mediaUI.draft, c.textarea.value);
  assert.equal(c.state.sendIntent, null); assert.equal(c.modal.closes, 1); assert.equal(c.calls.length, 1);
});

test('intenção real pendente bloqueia alteração de respostas antes de buscar ou escrever no catálogo', async () => {
  const c = fixture(), before = c.textarea.value;
  const intent = createSendIntent(null, { workspaceId: c.state.workspaceId, tenantId: 'A', conversationId: 'conv-A', channelId: 'channel-A', version: 1, text: before, attachmentIds: [] }, { randomUUID: () => 'synthetic-pending-quick-reply' });
  c.state.sendIntent = intent; c.state.quickReplies = [{ id: 'reply-A', version: 3, active: true }];
  for (const action of ['insert', 'open', 'toggle', 'clear', 'quote']) { c.target.dataset.replyAction = action; await c.replyAction(c.target); }
  assert.equal(c.calls.length, 0); assert.equal(c.inserts.length, 0); assert.equal(c.modal.closes, 0);
  assert.equal(c.textarea.value, before); assert.equal(c.mediaUI.draft, before); assert.equal(c.state.sendIntent, intent);
  assert.equal(c.toasts.length, 5); assert.ok(c.toasts.every(([message, error]) => /envio pendente/.test(message) && error === true));
});

test('toggle concluído na empresa A não recarrega nem reabre o catálogo da empresa B', async () => {
  const c = fixture();
  c.state.quickReplies = [{ id: 'reply-A', version: 3, active: true }];
  c.target.dataset.replyAction = 'toggle';
  const pending = c.replyAction(c.target), before = c.textarea.value;
  assert.equal(c.calls[0].path, '/api/tenants/A/quick-replies/reply-A');
  assert.equal(c.calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(c.calls[0].options.body), { version: 3, active: false });
  c.state.tenant = { id: 'B', conversations: [c.conversation('conv-B')] };
  c.state.conversation = 'conv-B'; c.state.repliesModalContext = c.contextKey();
  c.target.isConnected = false;
  c.finish(); await pending;
  assert.equal(c.calls.length, 1); assert.equal(c.modal.closes, 0); assert.equal(c.textarea.value, before); assert.equal(c.inserts.length, 0);
});
