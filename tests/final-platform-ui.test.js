import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { SupportAccess } from '../src/support-access.js';
import { createServicePrincipalsUI } from '../public/service-principals-ui.js';
import { createSupportUI } from '../public/support-ui.js';
import { createBillingUI } from '../public/billing-ui.js';
import { createSubscriptionUI } from '../public/subscription-ui.js';
import { createServiceHandoffsUI } from '../public/service-handoffs-ui.js';
import { createAccountInvitationsUI } from '../public/account-invitations-ui.js';
import { createAccountsUI } from '../public/accounts-ui.js';
import { createCommercialUsageUI } from '../public/commercial-usage-ui.js';
import { createUnitsUI } from '../public/units-ui.js';
import { createPlansUI } from '../public/plans-ui.js';
import { createChannelConnectorsUI } from '../public/channel-connectors-ui.js';
import { createWorkspaceDomainsUI } from '../public/workspace-domains-ui.js';
import { createSendIntent } from '../public/send-intent.js';
import { createTelegramGroupsUi } from '../public/telegram-groups-ui.js';
import { createTelegramAccountUI } from '../public/telegram-account-ui.js';
import { createForwarding, forwardMessageContent, forwardingFingerprint } from '../public/forwarding.js';
import { channelCapabilities, assertChannelText, textLength } from '../public/channel-capabilities.js';
import { attendanceReplyAccess } from '../public/participants-ui.js';
import { createFlowDraftGuard } from '../public/flow-workspace-ui.js';
import { PANEL_STATIC_FILES } from '../src/panel-assets.js';
import { excerpt } from './helpers/app-source.js';
import { createJsonRead } from '../public/json-read.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const token = 'elozi_svc_' + 'S'.repeat(43);
const apiSource = excerpt('api');
const factories = excerpt('support-factories');
const panelLoader = excerpt('view-panels');
const clickSource = excerpt('app-click');
const submitSource = excerpt('app-submit');
const modalSubmitSource = excerpt('modal-submit');
const actSource = excerpt('act');
const channelHelpers = excerpt('channel-helpers');
const whatsappGroupsSource = excerpt('whatsapp-groups-ui');

test('módulos usados pelas factories estão registrados como arquivos servidos e disponíveis no artefato', async () => {
  // src/panel-assets.js is the single allowlist served by src/server.js and verified by scripts/verify.mjs.
  const files = PANEL_STATIC_FILES;
  for (const name of ['support-ui.js', 'service-principals-ui.js', 'billing-ui.js', 'service-handoffs-ui.js', 'account-invitations-ui.js', 'accounts-ui.js', 'units-ui.js', 'plans-ui.js', 'channel-connectors-ui.js', 'workspace-domains-ui.js', 'send-intent.js', 'telegram-groups-ui.js', 'channel-capabilities.js']) { assert.equal(files['/' + name], name); assert.ok(source.includes(`from './${name}'`)); assert.ok((await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).length > 0); }
});

class FormDataAdapter {
  constructor(form) { this.fields = form.fields; }
  getAll(name) { const value = this.fields[name]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
  get(name) { return this.getAll(name)[0] ?? null; }
  has(name) { return this.getAll(name).length > 0; }
  *[Symbol.iterator]() { for (const name of Object.keys(this.fields)) for (const value of this.getAll(name)) yield [name, value]; }
}
function fixture(t, respond) {
  const previous = { document: globalThis.document, FormData: globalThis.FormData };
  const calls = [], opened = [], messages = [], renders = [], handlers = {}, changes = [], handoffs = { actions: [], forms: [] }, listeners = new Map();
  const modal = { open: false, html: '', error: { textContent: '' }, secret: null,
    querySelector(selector) { return selector === '[data-service-secret]' ? this.secret : selector.includes('error') ? this.error : null; },
    addEventListener(event, callback) { const callbacks = listeners.get(event) || []; callbacks.push(callback); listeners.set(event, callbacks); },
    close() { this.open = false; for (const callback of listeners.get('close') || []) callback(); }
  };
  const app = { innerHTML: '', addEventListener(event, callback) { handlers[event] = callback; } };
  const elements = { '#app': app, '#modal': modal };
  const state = { view: 'service-agents', workspaceId: 'workspace-a', supportGrantId: null, conversation: 'conversation-a', inboxSelecting: false, busy: false, flows: [], flowId: null, flowDraft: null, flowDirty: false, flowSaving: false,
    boot: { csrfToken: 'csrf-a', session: { userId: 'admin-a', resellerId: 'workspace-a', name: 'Administrador QA', role: 'reseller', platformOwner: true, permissions: null }, tenants: [{ id: 'tenant-a', name: 'Empresa QA' }] },
    tenant: { id: 'tenant-a', name: 'Empresa QA', agents: [{ id: 'hermes', name: 'Hermes', configured: true, provider: 'hermes', mode: 'copilot' }], channels: [{ id: 'wa', name: 'WhatsApp QA', transport: 'baileys', state: 'connected' }], departments: [{ id: 'support', name: 'Suporte', active: true }], conversations: [{ id: 'conversation-a', contact: 'Cliente QA', status: 'open', version: 1, channelId: 'wa', departmentId: 'support', assignedUserId: 'admin-a', owner: 'human', messages: [] }] }
  };
  const service = { id: 'service-a', name: 'Hermes conectado', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft'], channelIds: null, departmentIds: null, dailyRequests: 100, dailyBudgetMicros: 0, estimatedRequestMicros: 0, budgetEnabled: false, maxConcurrent: 1, state: 'active', revision: 1, keyRevision: 1, expiresAt: '2027-01-01T00:00:00Z', usage: { requests: 0, budgetMicros: 0 } };
  const defaultResponse = (path, init) => path.includes('service-principals') ? init.method === 'POST' ? { principal: service, token } : { principals: [service] } : path === '/api/support/available' || path === '/api/support/grants' ? { grants: [] } : path.startsWith('/api/billing?') ? { contracts: [], invoices: [], targets: [{ id: 'tenant-a', name: 'Empresa QA' }] } : path === '/api/billing/contracts' ? { id: 'contract-a', version: 1 } : path.startsWith('/api/tenants/') ? structuredClone(state.tenant) : {};
  const globals = {
    ...i18n,
    state, escape, icon: () => '', createServicePrincipalsUI, createSupportUI, createBillingUI, createSubscriptionUI, registerScreen: () => {}, createAccountInvitationsUI, createAccountsUI, createCommercialUsageUI, createUnitsUI, createPlansUI, createChannelConnectorsUI, createWorkspaceDomainsUI, createSendIntent, createTelegramGroupsUi, createTelegramAccountUI, channelCapabilities, assertChannelText, textLength, FormData: FormDataAdapter,
    canReplyTo: conversation => attendanceReplyAccess(conversation, { userId: state.boot.session.userId, hasPermission: state.boot.session.permissions === null || state.boot.session.permissions.includes('inbox.reply'), selecting: state.inboxSelecting }),
    $: selector => elements[selector] || null, document: { querySelector: selector => elements[selector] || null },
    location: { assign() { assert.fail('não deve expirar a sessão sintética'); }, hash: '' }, window: { scrollTo() {} },
    fetch: async (path, init = {}) => { calls.push({ path, init }); const result = respond ? await respond(path, init, defaultResponse) : defaultResponse(path, init); return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } }); },
    openModal(title, subtitle, html) { modal.open = true; modal.html = html; modal.error = { textContent: '' }; const secret = html.match(/data-service-secret value="([^"]+)"/); modal.secret = secret ? { value: secret[1], removeAttribute() { this.attributeCleared = true; } } : null; opened.push({ title, subtitle, html }); },
    toast: (message, failure) => messages.push({ message, failure }), render: () => renders.push(true), changeWorkspace: async (...args) => changes.push(args),
    formModal() { assert.fail('este cenário não deve abrir o editor de unidades'); }, refresh: async () => {}, navigate: view => { state.view = view; },
    accountSecurityUI: { action: async () => false, submit: async () => false }, platformUsersUI: { action: async () => false }, teamChatUI: { submit: async () => false }, mediaUI: { sending: false }, currentConversation: () => state.tenant?.conversations[0], canCoordinate: () => true, canManageAttendance: () => true,
    serviceHandoffsUI: { handleAction: async node => handoffs.actions.push(node), submit: async form => handoffs.forms.push(form), sync() {}, reset() {} },
    crypto: globalThis.crypto, AbortController,
    contactLinksUI: { reset() {}, action: async () => false, submit: async () => false }, contactRefresh: { reset() {} },
    memoryUI: { reset() {}, syncContext() {}, action: async () => false, submit: async () => false }
  };
  globals.readJsonResponse = createJsonRead({ fetch: (...args) => globals.fetch(...args) });
  // Exercise the real clean-draft guard rather than bypassing its async contract.
  globals.flowDraftGuard = runInNewContext(excerpt('flow-draft-guard') + '\nflowDraftGuard', {
    ...globals, createFlowDraftGuard,
    saveFlow: () => assert.fail('Nenhum fluxo precisa ser salvo neste cenário de troca de concessão.'),
    selectFlow: () => assert.fail('Nenhum rascunho pode ser descartado neste cenário sem alterações.')
  });
  globalThis.document = globals.document; globalThis.FormData = FormDataAdapter;
  t.after(() => { globalThis.document = previous.document; globalThis.FormData = previous.FormData; });
  const loaded = runInNewContext(channelHelpers + '\n' + whatsappGroupsSource + '\n' + apiSource + '\n' + factories + '\n' + panelLoader + '\n' + actSource + '\n' + clickSource + '\n' + submitSource + '\n' + modalSubmitSource + '\n({api,supportUI,servicePrincipalsUI,billingUI,plansUI,telegramGroupsUI,telegramAccountUI,whatsappGroupsUI,channelConnectorsUI,workspaceDomainsUI,accountInvitationsUI,accountsUI,unitsUI,loadViewPanels,capabilitiesFor,windowOpen,groupOpen,canSendTo,channelFor})', globals);
  for (const name of ['capabilitiesFor','windowOpen','groupOpen','canSendTo','channelFor']) globals[name] = loaded[name];
  const click = async (selector, dataset) => handlers.click({ target: { closest: query => query === selector ? { dataset, isConnected: true } : null } });
  const clickModal = async (selector, dataset) => { for (const callback of listeners.get('click') || []) await callback({ target: { closest: query => query === selector ? { dataset, isConnected: true } : null } }); };
  const form = (kind, fields = {}) => {
    const token = modal.html.match(new RegExp(`data-${kind}-token="([^"]+)"`))?.[1];
    const selector = `[data-${kind}-form]`, feedback = { textContent: '' }, button = { disabled: false };
    return { dataset: kind === 'service-principal' ? { servicePrincipalForm: 'editor', servicePrincipalToken: token } : kind === 'billing' ? { billingForm: 'contract', billingToken: token } : { supportForm: 'revoke', supportToken: token }, fields, feedback, elements: { namedItem: name => ({ value: fields[name] || '' }) }, matches: query => query === selector, querySelector: query => query.includes('error') ? feedback : button, querySelectorAll: () => [], isConnected: true };
  };
  const submit = async form => { let prevented = false; await handlers.submit({ target: form, preventDefault() { prevented = true; } }); assert.equal(prevented, true); };
  const submitModal = async form => { let prevented = false; for (const callback of listeners.get('submit') || []) await callback({ target: form, preventDefault() { prevented = true; } }); assert.equal(prevented, true); };
  return { ...loaded, state, service, globals, calls, opened, messages, renders, modal, elements, changes, handoffs, click, clickModal, form, submit, submitModal };
}

test('pedido dos agentes usa a factory de atendimento e os dispatchers de ação e formulário da tela e do modal', async t => {
  const f = fixture(t); f.state.view = 'inbox';
  const handoffUI = runInNewContext(excerpt('attendance-context') + '\n' + excerpt('service-handoffs') + '\nserviceHandoffsUI', { ...i18n, ...f.globals, createServiceHandoffsUI, canReplyTo: () => true, $: () => null });
  assert.match(handoffUI.markup(), /data-service-handoff-action="open"/);
  f.state.inboxSelecting = true; assert.equal(handoffUI.markup(), ''); f.state.inboxSelecting = false;
  await f.click('[data-service-handoff-action]', { serviceHandoffAction: 'open' });
  await f.clickModal('[data-service-handoff-action]', { serviceHandoffAction: 'decide', id: 'proposal-qa', token: 'view-qa' });
  const makeForm = () => ({ matches: selector => selector === '[data-service-handoff-form]', fields: { decision: 'reject', reason: 'Revisão sintética' }, isConnected: true });
  const pageForm = makeForm(), modalForm = makeForm(); await f.submit(pageForm); await f.submitModal(modalForm);
  assert.deepEqual(f.handoffs.actions.map(node => node.dataset.serviceHandoffAction), ['open', 'decide']);
  assert.deepEqual(f.handoffs.forms, [pageForm, modalForm]); assert.equal(f.calls.length, 0); assert.equal(f.state.busy, false);
});

test('factory e dispatcher reais completam cadastro de serviço com chave única, escopo e header do workspace', async t => {
  const f = fixture(t); await f.loadViewPanels(); await f.click('[data-service-principal-action]', { servicePrincipalAction: 'create' });
  const form = f.form('service-principal', { name: 'Hermes QA', agentId: 'hermes', capabilities: ['conversation.read', 'reply.draft'], 'channelIds-all': 'all', 'departmentIds-all': 'all', dailyRequests: '100', dailyBudgetUSD: '0', estimatedRequestUSD: '0', maxConcurrent: '1', ttlHours: '168', active: 'yes', reviewAccess:'yes' });
  await f.submit(form); const write = f.calls.find(call => call.init.method === 'POST'); assert.equal(write.path, '/api/tenants/tenant-a/service-principals'); assert.equal(write.init.headers['X-Elozi-Workspace'], 'workspace-a'); assert.equal(write.init.headers['X-CSRF-Token'], 'csrf-a'); assert.equal(f.opened.at(-1).title, 'Chave criada'); assert.equal(f.modal.secret.value, token); assert.equal(f.state.busy, false);
});

test('factory de financeiro passa pelo dispatcher comum e usa contrato em centavos com resultado confirmado', async t => {
  const f = fixture(t); f.state.view = 'billing'; await f.loadViewPanels(); await f.click('[data-action]', { action: 'billing-new-contract' });
  const index = f.modal.html.match(/name="itemKind-([^" ]+)"/)[1];
  const form = f.form('billing', { targetId: 'tenant-a', name: 'Contrato QA', ['itemKind-' + index]: 'subscription', ['itemLabel-' + index]: 'Mensalidade', ['itemPrice-' + index]: '49,90', ['itemUnits-' + index]: '1', periodMonths: '1', startsAt: '2026-10-03', endsAt: '', graceDays: '0', state: 'active', reason: 'Acordo sintético conferido' });
  await f.submit(form); const write = f.calls.find(call => call.path === '/api/billing/contracts'); assert.equal(JSON.parse(write.init.body).items[0].unitCents, 4990); assert.equal(JSON.parse(write.init.body).tenantId, 'tenant-a'); assert.equal(write.init.headers['X-Elozi-Workspace'], 'workspace-a'); assert.equal(f.modal.open, false); assert.match(f.messages.at(-1).message, /registrada/);
});

test('dispatcher financeiro mostra validação e preserva inputs antes de qualquer mutação', async t => {
  const f = fixture(t); f.state.view = 'billing'; await f.loadViewPanels(); await f.click('[data-action]', { action: 'billing-new-contract' }); const index = f.modal.html.match(/name="itemKind-([^" ]+)"/)[1];
  const form = f.form('billing', { targetId: 'tenant-a', name: 'Contrato preservado', ['itemKind-' + index]: 'subscription', ['itemLabel-' + index]: 'Mensalidade', ['itemPrice-' + index]: '', ['itemUnits-' + index]: '1', periodMonths: '1', startsAt: '2026-10-03', endsAt: '', graceDays: '0', state: 'active', reason: 'Acordo sintético conferido' });
  await assert.doesNotReject(f.submit(form)); assert.match(form.feedback.textContent, /valor em reais/); assert.equal(form.fields.name, 'Contrato preservado'); assert.equal(f.calls.some(call => call.init.method), false); assert.equal(f.modal.open, true); assert.equal(f.state.busy, false);
});

test('dispatcher modal financeiro mostra a falha sem fechar nem perder formulário', async t => {
  const f = fixture(t); f.state.view = 'billing'; await f.loadViewPanels(); await f.click('[data-action]', { action: 'billing-new-contract' }); const index = f.modal.html.match(/name="itemKind-([^" ]+)"/)[1];
  const form = f.form('billing', { targetId: 'tenant-a', name: 'Contrato preservado no modal', ['itemKind-' + index]: 'subscription', ['itemLabel-' + index]: 'Mensalidade', ['itemPrice-' + index]: '', ['itemUnits-' + index]: '1', reason: 'Acordo sintético' });
  await assert.doesNotReject(f.submitModal(form)); assert.match(form.feedback.textContent, /valor em reais/); assert.equal(f.modal.open, true); assert.equal(form.fields.name, 'Contrato preservado no modal'); assert.equal(f.calls.some(call => call.init.method), false);
});

test('suporte delegado não recebe gestão de agentes ou faturamento no menu nem na factory', async t => {
  const f = fixture(t); f.state.supportGrantId = 'grant-a'; Object.assign(f.state.boot.session, { role: 'operator', platformOwner: false, permissions: ['inbox.read'], supportGrantId: 'grant-a' });
  await f.servicePrincipalsUI.load(); assert.equal(f.servicePrincipalsUI.markup(), ''); await f.click('[data-service-principal-action]', { servicePrincipalAction: 'create' }); assert.equal(f.calls.length, 0); assert.match(f.messages.at(-1).message, /administrador/);
  const navigation = excerpt('navigation-render');
  const html = runInNewContext(navigation + '\nnavigationMarkup()', { ...i18n, ...nav, ...shell, ...f.globals, hasPermission: permission => f.state.boot.session.permissions.includes(permission), consolidatedInbox: { data: { counts: {} } }, activeConversations: () => [] });
  for (const page of ['service-agents', 'billing', 'platform-billing', 'team', 'tenants', 'brand']) assert.equal(html.includes(`data-view="${page}"`), false, page);
  // Shell menu (§2.1): temporary support keeps the operation (reading automation and channels) and
  // leaves the support context through the banner of the shell instead of a Configurações item.
  for (const page of ['overview', 'inbox', 'automation', 'channels']) assert.ok(html.includes(`data-view="${page}"`), page);
  // The render() guard is nav-config's routeAllowed/resolveView (tests/navigation-matrix.test.js holds the literal oracle).
  const guard = source.split('\n').find(line => line.trim() === 'state.view=resolveView(state.view,navigationContext());');
  assert.ok(guard);
  for (const page of ['service-agents', 'billing', 'platform-billing', 'team', 'tenants', 'brand', 'knowledge', 'accounts', 'platform-users']) {
    f.state.view = page;
    const served = runInNewContext(navigation + '\n' + guard + '\n({navigationContext})', { ...i18n, ...nav, ...f.globals, hasPermission: () => false, consolidatedInbox: { data: { counts: {} } }, activeConversations: () => [] });
    assert.equal(nav.legacyRouteAllowed(page, served.navigationContext()), false, page); assert.equal(f.state.view, 'overview', page);
  }
});

test('API fixa origem de suporte para upload binário e preserva headers de arquivo', async t => {
  const f = fixture(t); f.state.supportGrantId = 'grant-a'; const body = new Blob(['synthetic-image'], { type: 'image/png' });
  await f.api('/api/tenants/tenant-a/conversations/conversation-a/attachments', { method: 'POST', body, headers: { 'Content-Type': 'image/png', 'X-Elozi-Filename': 'qa.png', 'X-Elozi-Conversation-Version': '1' } });
  const { init } = f.calls[0]; assert.equal(init.body, body); assert.equal(init.headers['X-Elozi-Workspace'], 'workspace-a'); assert.equal(init.headers['X-Elozi-Support-Grant'], 'grant-a'); assert.equal(init.headers['Content-Type'], 'image/png'); assert.equal(init.headers['X-Elozi-Filename'], 'qa.png');
});

test('factory encaminha referências com headers de sessão e preserva download original privado', async t => {
  const base = '/api/tenants/tenant-a', forwardPath = `${base}/conversations/conversation-a/forward`;
  const f = fixture(t, (path, init, fallback) => {
    if (path === forwardPath && init.method === 'POST') return { id: 'conversation-b', channelId: 'wa', version: 5, messages: [] };
    const result = fallback(path, init);
    if (path === base) { result.conversations[0].version = 3; result.conversations[1].version = 4; }
    return result;
  });
  f.state.view = 'inbox'; f.state.supportGrantId = 'grant-a';
  const original = f.state.tenant.conversations[0];
  original.messages = [{ id: 'message-a', kind: 'customer', text: 'Documento recebido', attachments: [{ id: 'file-a', messageId: 'message-a', kind: 'document', name: 'qa.pdf', mime: 'application/pdf', size: 14, status: 'ready', url: 'https://private.invalid/file-a' }] }];
  f.state.tenant.conversations.push({ ...original, id: 'conversation-b', contact: 'Destino QA', version: 2, messages: [] });
  const downloads = [], captured = {};
  const globals = { ...f.globals, api: f.api, fetch: async (path, init) => { downloads.push({ path, init }); return new Response('synthetic-file'); }, createMediaUI: options => { captured.media = options; return {}; }, createForwarding: options => { captured.forwarding = options; return createForwarding(options); }, updateForwardingStatus() {} };
  const forwarding = runInNewContext(excerpt('media-ui') + '\n' + excerpt('current-conversation') + '\n' + excerpt('forwarding') + '\nforwarding', globals);
  const downloadPath = `${base}/conversations/conversation-a/attachments/file-a`, signal = new AbortController().signal;
  assert.equal(await (await captured.media.download(downloadPath, signal)).text(), 'synthetic-file');
  assert.equal(downloads[0].path, downloadPath); assert.equal(downloads[0].init.signal, signal);
  assert.equal(downloads[0].init.headers['X-Elozi-Workspace'], 'workspace-a'); assert.equal(downloads[0].init.headers['X-Elozi-Support-Grant'], 'grant-a');
  assert.equal(captured.forwarding.request, f.api); assert.equal(Object.hasOwn(captured.forwarding, 'download'), false);
  forwarding.prepare('message-a'); forwarding.selectTarget('conversation-b');
  assert.equal((await forwarding.execute()).id, 'conversation-b');
  assert.equal(downloads.length, 1, 'encaminhar não baixa o arquivo no cliente');
  assert.deepEqual(f.calls.map(call => [call.path, call.init.method]), [[base, 'GET'], [forwardPath, 'POST']]);
  const { init } = f.calls[1], body = JSON.parse(init.body);
  assert.deepEqual({ ...init.headers }, { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-a', 'X-Elozi-Workspace': 'workspace-a', 'X-Elozi-Support-Grant': 'grant-a' });
  assert.match(body.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(body, { messageId: 'message-a', sourceVersion: 3, sourceChannelId: 'wa', fingerprint: forwardingFingerprint(forwardMessageContent(original.messages[0], original, captured.forwarding.getContext())), destinationId: 'conversation-b', destinationVersion: 4, destinationChannelId: 'wa', idempotencyKey: body.idempotencyKey });
  assert.equal(init.body.includes('https://private.invalid'), false);
});

test('troca de grant na mesma empresa muda autoridade de rascunhos e encaminhamento', async t => {
  const f = fixture(t); f.state.view = 'inbox'; f.state.supportGrantId = 'grant-a'; f.state.boot.session.supportGrantId = 'grant-a';
  const context = runInNewContext(excerpt('attendance-context') + '\nattendanceContext', { ...i18n, ...f.globals, canReplyTo: () => true });
  const before = context(); f.state.supportGrantId = 'grant-b'; f.state.boot.session.supportGrantId = 'grant-b';
  assert.notEqual(context().authorityKey, before.authorityKey, 'grant diferente não pode compartilhar a autoridade dos drafts/forwarding');
});

test('changeWorkspace real limpa painéis, drafts e chave quando somente grant muda', async t => {
  const f = fixture(t); await f.loadViewPanels(); await f.click('[data-service-principal-action]', { servicePrincipalAction: 'create' });
  await f.submit(f.form('service-principal', { name: 'Hermes QA', agentId: 'hermes', capabilities: ['conversation.read'], 'channelIds-all': 'all', 'departmentIds-all': 'all', dailyRequests: '10', dailyBudgetUSD: '0', estimatedRequestUSD: '0', maxConcurrent: '1', ttlHours: '168', active: 'yes', reviewAccess:'yes' }));
  const input = f.modal.secret, resets = [], stubs = {};
  for (const name of ['brandDrafts', 'contactLinksUI', 'contactRefresh', 'memoryUI', 'accountSecurityUI', 'teamChatUI', 'consolidatedInbox', 'contactImportUI', 'platformUsersUI', 'commercialUsageUI','groupsWorkspaceUI', 'conversationTools', 'noteDrafts', 'forwarding', 'participantsUI', 'serviceHandoffsUI', 'customerContextUI', 'chatLayout', 'repliesUI', 'voiceRecorder', 'inboxTimeline', 'mediaUI', 'automationUI', 'avatarUI', 'mcpUI', 'knowledgeUI', 'subscriptionUI']) stubs[name] = { reset: () => resets.push(name) };
  stubs.workspaceUI = { resetPeople: () => resets.push('people'), resetContacts: () => resets.push('contacts') };
  stubs.inboxReadAttempts = new Map([['old-scope', { anchor: 'old-message', pending: false }]]);
  stubs.resetScreens = () => resets.push('screens');
  const globals = { ...f.globals, ...stubs,blockPendingSend:()=>false, servicePrincipalsUI: f.servicePrincipalsUI, supportUI: f.supportUI, billingUI: f.billingUI, plansUI: f.plansUI, telegramGroupsUI: f.telegramGroupsUI, telegramAccountUI: f.telegramAccountUI, whatsappGroupsUI: f.whatsappGroupsUI, channelConnectorsUI: f.channelConnectorsUI, workspaceDomainsUI: f.workspaceDomainsUI, accountInvitationsUI: f.accountInvitationsUI, accountsUI: f.accountsUI, unitsUI: f.unitsUI, clearTimeout, refresh: async () => { f.state.tenant = { id: 'tenant-a', conversations: [] }; } };
  const change = runInNewContext(excerpt('workspace-selection-reset') + '\n' + excerpt('change-workspace') + '\nchangeWorkspace', globals);
  await change('workspace-a', 'grant-b'); assert.equal(f.state.supportGrantId, 'grant-b'); assert.equal(input.value, ''); assert.equal(input.attributeCleared, true); assert.equal(f.state.conversation, null); assert.equal(f.state.billing, null); assert.equal(f.state.supportTenants.length, 0); assert.ok(resets.includes('forwarding')); assert.ok(resets.includes('subscriptionUI'), 'subscription panel resets on workspace/grant change'); assert.ok(resets.includes('noteDrafts')); assert.ok(resets.includes('mediaUI')); assert.ok(resets.includes('serviceHandoffsUI')); assert.ok(resets.includes('customerContextUI')); assert.ok(resets.includes('commercialUsageUI')); assert.ok(resets.includes('screens'), 'agent rail e telas delegadas também esquecem o contexto'); assert.equal(f.state.busy, false);
  assert.equal(resets.filter(name=>name==='groupsWorkspaceUI').length,1,'Mudar somente a concessão também encerra o contexto de grupos.');
  assert.equal(stubs.inboxReadAttempts.size,0,'As leituras automáticas também esquecem a autoridade anterior.');
});

test('metadata de suporte só expõe labels do grant e preview usa nomes fora do workspace original', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const admin = auth.actor(auth.insertUser({ username: 'final.ui.owner', name: 'Admin QA' }, Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo'));
  const support = auth.actor(auth.insertUser({ username: 'final.ui.support', name: 'Suporte QA' }, Buffer.alloc(16, 2), Buffer.alloc(64, 2), 'operator', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Empresa autorizada <QA>', segment: 'Teste' });
  store.mutate(admin, tenant.id, 'Fixture labels', state => { state.channels = [{ id: 'wa', name: 'WhatsApp autorizado <QA>', token: 'do-not-expose-secret' }, { id: 'tg', name: 'Canal fora do escopo' }]; state.departments = [{ id: 'support', name: 'Departamento autorizado <QA>', active: true, memberIds: ['do-not-expose-members'] }, { id: 'sales', name: 'Departamento fora do escopo', active: true }]; state.secret = 'do-not-expose-secret'; });
  store.createTenant(admin, { name: 'Empresa fora do escopo', segment: 'Teste' }); const manager = new SupportAccess(store, auth);
  const grant = manager.create(admin, { supportUserId: support.userId, tenantIds: [tenant.id], permissions: ['inbox.read'], scopeRules: { [tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } }, reason: 'Suporte sintético autorizado', ttlMinutes: 60 });
  assert.deepEqual(grant.tenants, [{ id: tenant.id, name: 'Empresa autorizada <QA>', channels: [{ id: 'wa', name: 'WhatsApp autorizado <QA>' }], departments: [{ id: 'support', name: 'Departamento autorizado <QA>' }] }]);
  const serialized = JSON.stringify(grant); for (const value of ['fora do escopo', 'do-not-expose-secret', 'do-not-expose-members']) assert.equal(serialized.includes(value), false);
  const f = fixture(t, (path, _init, fallback) => path === '/api/support/available' ? { grants: [grant] } : path === '/api/support/grants/' + grant.id ? { grant } : fallback(path, _init));
  f.state.boot.session.role = 'operator'; f.state.tenant = { id: 'home-company', name: 'Empresa original', channels: [], departments: [] }; await f.supportUI.load(); await f.click('[data-action]', { action: 'support-access', id: grant.id });
  const html = f.opened.at(-1).html; for (const label of ['Empresa autorizada &lt;QA&gt;', 'WhatsApp autorizado &lt;QA&gt;', 'Departamento autorizado &lt;QA&gt;']) assert.ok(html.includes(label), label); assert.equal(f.changes.length, 0); assert.equal(f.calls.some(call => call.init.method), false);
});

test('suporte directory real usa busca exata e csrf/origem pelo dispatcher sem abrir administração delegada', async t => {
  const f = fixture(t, (path, init, fallback) => path.startsWith('/api/support/directory?') ? { users: [{ id: 'person-a', name: 'Pessoa QA', username: 'support.qa' }] } : fallback(path, init));
  await f.click('[data-action]', { action: 'support-new' }); const target = { innerHTML: '' }, form = { elements: { namedItem: () => ({ value: 'support.qa' }) }, querySelector: () => target };
  f.elements['[data-support-form="create"]'] = form; await f.click('[data-action]', { action: 'support-find-person' });
  const request = f.calls.at(-1); assert.equal(request.path, '/api/support/directory?q=support.qa'); assert.equal(request.init.headers['X-Elozi-Workspace'], 'workspace-a'); assert.equal(request.init.headers['X-CSRF-Token'], 'csrf-a'); assert.ok(target.innerHTML.includes('value="person-a"'));
  f.state.boot.session.role = 'operator'; f.state.boot.session.supportGrantId = 'grant-a'; f.state.supportGrantId = 'grant-a'; const count = f.opened.length; await f.click('[data-action]', { action: 'support-new' }); assert.equal(f.opened.length, count);
});
