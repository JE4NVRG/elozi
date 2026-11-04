import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import { createAgentMemoryUI } from '../public/agent-memory-ui.js';
import { createMcpUI } from '../public/mcp-ui.js';
// Run cards and approval decisions moved from mcp-ui.js to the agent rail (FRONTEND-V2 §8.2, P1 commit 1f);
// the poll GETs go through data-source.js (P2). The fixture uses the real modules.
import { createAgentRail, activeRunStates } from '../public/agent-rail-ui.js';
import { createDataSource } from '../public/data-source.js';
import { excerpt } from './helpers/app-source.js';
import { applyBrandTokens, deriveBrandTokens } from '../public/brand-theme.js';
import { syncThemePrefs } from '../public/theme-prefs.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';
// render() frames each view with the hub of settings-ui.js (P8: Configurações, Plataforma, Clientes, Indicadores).
import { screenFrame } from '../public/settings-ui.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const authority = source.split('\n').find(line => line.startsWith('const inboxContactAuthority='));
assert.ok(authority);
const helpers = excerpt('scoped-runs-context');
const poll = excerpt('inbox-polling');
const render = excerpt('navigation-heading');
const navigate = excerpt('navigate');
const modalSubmit = excerpt('modal-submit');
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const deferred = () => { let resolve, reject; return { promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve: v => resolve(v), reject: e => reject(e) }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const refs = [{ id: 'fact-own-contact', scope: 'contact', version: 1 }, { id: 'fact-own-operation', scope: 'operation', version: 2 }];
const run = changes => ({ id: 'run-own', conversationId: 'case-a', conversationVersion: 1, version: 1, state: 'draft', draft: 'Resposta sintética para revisão', agentName: 'Hermes próprio', requestedByName: 'Atendente sintético', memoryReferences: refs.map(r => ({ ...r })), ...changes });

function fixture({ steps = [] } = {}) {
  const conversation = { id: 'case-a', channelId: 'channel-a', departmentId: 'support', contactId: 'contact-own', version: 1, status: 'open', owner: 'human', assignedUserId: 'person-a', contact: 'Contato próprio sintético', messages: [{ id: 'own-message', text: 'Contexto sintético', kind: 'customer' }] };
  const brand = { initials: 'QA', name: 'Elozi sintética', accent: '#123456', logo: '' };
  const state = { view: 'inbox', workspaceId: 'workspace-a', supportGrantId: null, conversation: conversation.id, busy: false, inboxSelecting: false, refreshSequence: 0, inboxSelectionSequence: 0,
    boot: { version: '0.36.1', csrfToken: 'synthetic-csrf', session: { userId: 'person-a', resellerId: 'workspace-a', role: 'operator', name: 'Pessoa sintética', permissions: ['inbox.read', 'inbox.reply', 'contacts.read'], platformOwner: false }, tenants: [{ id: 'company-a', name: 'Empresa sintética' }], reseller: { name: 'Empresa sintética', accountKind: 'business', brand } },
    tenant: { id: 'company-a', name: 'Empresa sintética', brand, channels: [{ id: 'channel-a', transport: 'telegram-bot', state: 'connected' }], agents: [], conversations: [conversation], runs: [run({ memoryReferences: undefined })] },
    account: { google: { enabled: false }, user: { googleLinked: false } }, sendIntent: null };
  const calls = [], notices = [], effects = [], listeners = new Map();
  const text = { value: 'Texto digitado ainda não enviado', selectionStart: 4, selectionEnd: 12 }, note = { value: 'Nota ainda não salva' }, player = { currentTime: 17, paused: false };
  const attachment = { id: 'file-own', name: 'arquivo-sintético.txt' }, quote = { id: 'quote-own' };
  let panelHTML = '<div id="copilot-runs">Painel anterior</div>', appHTML = '', fullRenders = 0;
  const panel = { get outerHTML() { return panelHTML; }, set outerHTML(value) { panelHTML = value; } };
  const app = { get innerHTML() { return appHTML; }, set innerHTML(value) { appHTML = value; fullRenders++; } };
  const modal = { open: false, addEventListener(name, fn) { listeners.set(name, fn); }, querySelector: () => null };
  const elements = { '#app': app, '#modal': modal, '#message-text': text, '#internal-note-text': note, '#copilot-runs': panel, '#messages': player };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    const next = steps.shift(); assert.ok(next, 'Nenhum request inesperado: ' + path);
    if (next.path) assert.equal(path, next.path);
    if (next.suffix) assert.ok(path.endsWith(next.suffix), path);
    if (options.method === 'POST') assert.match(path, /\/tool\/approve$/, 'Somente decisão sintética MCP permitida; nenhum envio/provider');
    else assert.equal(options.method, undefined);
    assert.equal(options.headers?.['X-Elozi-Workspace'] ?? state.workspaceId, 'workspace-a');
    if (next.error) throw next.error;
    return next.pending ?? structuredClone(next.data ?? {});
  };
  let real;
  const noop = { reset() {}, syncContext() {}, submit: async () => false };
  let groupResets=0,groupSyncs=0,visitorSyncs=0;
  const groupsWorkspaceUI={reset(){groupResets++;},syncContext(){groupSyncs++;}};
  const channelVisitorTestUI={reset(){},syncContext(){visitorSyncs++;}};
  const memoryUI = createAgentMemoryUI({ state, escape, icon: () => '', api, tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail, toast: (message, error) => notices.push({ message, error }) });
  // Editor ownership is covered by agent-memory-ui.test; this fixture uses its real reference renderer without a native document/modal.
  memoryUI.reset = () => {};
  const mcpUI = createMcpUI({ state, escape, icon: () => '', badge: escape, api, tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail,
    formModal() { assert.fail('Teste de decisão não cria formulário'); }, toast: (message, error) => notices.push({ message, error }) });
  const agentRail = createAgentRail({ state, escape, icon: () => '', badge: escape, api, tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail,
    canReplyTo: c => c?.assignedUserId === state.boot.session.userId, runNames: { draft: 'Rascunho pronto', waiting_approval: 'Aguardando aprovação', invalidated: 'Contexto mudou' },
    renderRuns: () => real.renderConversationRuns(), captureRuns: () => real.captureScopedRuns(), loadRuns: (...args) => real.refreshScopedConversationRuns(...args),
    knowledgeReferences: run => globals.knowledgeUI.runReferences(run), memoryReferences: run => memoryUI.runReferences(run),
    formModal() { assert.fail('Teste de decisão não cria formulário'); }, toast: (message, error) => notices.push({ message, error }) });
  const mediaUI = { sending: false, selected: attachment, draft: text.value, syncContext(_context, value) { if (typeof value === 'string') this.draft = value; return true; }, retainConversations() {}, bindPlayers() {}, hydrate() {} };
  const globals = { ...i18n, state, api, activeRunStates, memoryUI, mcpUI, agentRail, dataSource: createDataSource({ request: api }), afterRender() {}, escape, icon: () => '', badge: escape, AbortController,
    currentConversation: () => state.tenant?.conversations.find(c => c.id === state.conversation),
    $: selector => elements[selector] || null, document: { title: '', documentElement: { style: { setProperty() {} }, setAttribute() {}, removeAttribute() {} } },
    applyBrandTokens, deriveBrandTokens, syncThemePrefs, ...nav, ...shell, screenFrame,
    selectedInboxRef: () => state.conversation ? { workspaceId: state.workspaceId, tenantId: state.tenant.id, conversationId: state.conversation } : null,
    inboxIdentity: ref => ref ? JSON.stringify(ref) : '', attendanceContext: () => ({}), hasPermission: name => state.boot.session.permissions.includes(name),
    roleLabel: () => 'Atendente', avatarMarkup: () => '', matchMedia: () => ({ matches: false }), presenceNames: { available: 'Disponível' },
    consolidatedInbox: { data: { offset: 0, counts: { active: 1 } }, retainConversations() {}, saveDraft: () => true, getDraft: () => text.value },
    noteDrafts: { key: null }, forwarding: { close() {} }, mediaUI,
    repliesUI: { quote, retainConversations() {}, syncContext() {}, updateQuoteComposer() {} }, voiceRecorder: { busy: false, syncContext() {}, reset() {} },
    syncAttendanceTools() {}, chatLayout: { sync() {} }, avatarUI: { bind() {} }, integrationsUI: { bind() {} }, teamChatUI: noop,
    canSendTo: () => false, canReplyTo: () => true, isRealConversation: () => true, canCoordinate: () => true,
    bindInboxMedia() {}, composerStatus() {}, activeConversations: () => [], updateVoiceControls() {},
    participantsUI: { busy: false, opened: false }, updateAttendanceAccess() {}, updateAttendanceSummary() {}, updateClientRecord() {}, conversationTools: { opened: false },
    inboxTimeline: { update: () => ({ added: false }) }, updateInboxList() {}, refreshMessageAttachments() {},markConversationRead:async()=>false,
    refreshInboxList: async () => effects.push('refresh-list'), dropInboxDetail: id => { effects.push(['drop-detail', id]); state.tenant.runs = []; },
    knowledgeUI: { ...noop, runReferences: () => '' }, contactLinksUI: noop, platformUsersUI: noop, commercialUsageUI: noop, groupsWorkspaceUI, channelVisitorTestUI, contactRefresh: noop, accountSecurityUI: noop, workspaceUI: noop, automationUI: noop,
    // Navigation focus and unrelated panels are outside this metadata/draft lifecycle fixture.
    toast: (message, error) => notices.push({ message, error }), loadViewPanels() {}, loadNavigatedPanels() {}, focusViewContent() { effects.push('view-focus'); }, blockPendingSend: () => false,
    tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail, location: { hash: '#inbox' }, window: { scrollTo() {} },
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.values?.[name] ?? null; } } };
  globals.views = { inbox: () => globals.currentConversation() ? real.conversationRuns(globals.currentConversation()) : '<section>Escolha um atendimento</section>', channels: () => '<section>Conexões</section>', overview: () => '<section>Visão geral</section>', contacts: () => '<section>Agenda</section>' };
  real = runInNewContext([authority, helpers, poll, render, navigate, modalSubmit, '({captureScopedRuns,currentScopedRuns,readScopedRuns,refreshScopedConversationRuns,conversationRuns,renderConversationRuns,pollInbox,render,navigate})'].join('\n'), globals);
  return { ...real, state, conversation, calls, notices, effects, steps, text, note, player, attachment, quote, mediaUI, memoryUI, mcpUI, agentRail,
    refuseDraftSave() { state.renderedInboxRef = { workspaceId: state.workspaceId, tenantId: state.tenant.id, conversationId: state.conversation };globals.consolidatedInbox.saveDraft=()=>false; },
    get panelHTML() { return panelHTML; }, get fullRenders() { return fullRenders; },get groupResets(){return groupResets;},get groupSyncs(){return groupSyncs;},get visitorSyncs(){return visitorSyncs;},
    general(runs = [run({ memoryReferences: undefined })]) { return structuredClone({ ...state.tenant, runs }); },
    submit: form => listeners.get('submit')({ target: form, preventDefault() {} }),
    form(kind = 'memory-update') { return { dataset: { dialogForm: kind }, values: {}, matches: () => false, querySelector: selector => selector === '[type="submit"]' ? { disabled: false } : { textContent: '' }, isConnected: true }; },
    done() { assert.equal(steps.length, 0); assert.equal(calls.filter(c => /\/messages|\/attachments|\/run$/.test(c.path)).length, 0, 'Sem envio, arquivo ou chamada ao provedor'); } };
}

test('render real carrega refs somente do endpoint específico e conserva o compositor', async () => {
  const f = fixture({ steps: [{ suffix: '/runs', data: { runs: [run()] } }] });
  f.render(); await settle();
  assert.match(f.panelHTML, /Memória revisada no contexto · 2/); assert.equal(f.calls.length, 1);
  // The host keeps the rail of P4 (§5.2.3): the draft card inserts through composerBridge, never the legacy action.
  assert.match(f.panelHTML, /<div class="pg-rail" data-rail-root data-conversation-id="case-a"><section class="ui-draft"/);
  assert.match(f.panelHTML, /data-action="rail:insert-draft" data-id="run-own">/); assert.doesNotMatch(f.panelHTML, /use-run-draft|mcp-approve/);
  assert.equal(f.calls[0].path, '/api/tenants/company-a/conversations/case-a/runs');
  assert.equal(f.text.value, 'Texto digitado ainda não enviado'); assert.equal(f.text.selectionStart, 4); assert.equal(f.note.value, 'Nota ainda não salva');
  assert.strictEqual(f.mediaUI.selected, f.attachment); assert.equal(f.player.currentTime, 17); f.done();
});

test('poll real repetido não perde refs quando o DTO geral as remove e o trilho mostra o estado scoped', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.steps.push({ path: '/api/tenants/company-a', data: f.general([run({ state: 'running', memoryReferences: undefined })]) }, { suffix: '/runs', data: { runs: [run()] } });
    await f.pollInbox(); assert.match(f.panelHTML, /Memória revisada no contexto · 2/);
  }
  assert.equal(f.calls.length, 4); assert.equal(f.fullRenders, 0); assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
});

test('scoped fresh invalidado substitui rascunho e refs visuais sem reanexar cache e sem tocar texto/mídia', async () => {
  const f = fixture();
  f.steps.push({ suffix: '/runs', data: { runs: [run()] } }); await f.refreshScopedConversationRuns(); assert.match(f.panelHTML, /Memória revisada/);
  f.steps.push({ path: '/api/tenants/company-a', data: f.general() }, { suffix: '/runs', data: { runs: [run({ state: 'invalidated', draft: null, memoryReferences: [], memoryUnavailable: true })] } });
  await f.pollInbox();
  assert.doesNotMatch(f.panelHTML, /fact-own-contact|fact-own-operation|Resposta sintética para revisão|memória desta execução não está mais disponível/);
  assert.match(f.panelHTML, /data-state="invalidated"/); assert.match(f.panelHTML, /O contexto mudou\. Prepare um novo rascunho\./);
  assert.match(f.panelHTML, /data-action="rail:regenerate"/);
  assert.equal(f.text.value, 'Texto digitado ainda não enviado'); assert.equal(f.note.value, 'Nota ainda não salva'); assert.equal(f.player.currentTime, 17);
  assert.strictEqual(f.mediaUI.selected, f.attachment); assert.strictEqual(f.state.sendIntent, null); assert.equal(f.fullRenders, 0); f.done();
});

for (const [boundary, change] of [
  ['workspace', f => { f.state.workspaceId = 'workspace-b'; }], ['tenant', f => { f.state.tenant = { ...f.state.tenant, id: 'company-b' }; }],
  ['actor', f => { f.state.boot.session.userId = 'person-b'; }], ['grant', f => { f.state.supportGrantId = 'grant-b'; }],
  ['csrf', f => { f.state.boot.csrfToken = 'other-authority'; }], ['permissions', f => { f.state.boot.session.permissions = ['inbox.read']; }],
  ['view', f => { f.state.view = 'channels'; }], ['conversation', f => { f.state.conversation = 'case-b'; }],
  ['channel', f => { f.conversation.channelId = 'channel-b'; }], ['department', f => { f.conversation.departmentId = 'sales'; }],
  ['contact', f => { f.conversation.contactId = 'contact-b'; }], ['version', f => { f.conversation.version++; }],
  ['refresh sequence', f => { f.state.refreshSequence++; }], ['selection sequence', f => { f.state.inboxSelectionSequence++; }]
]) test('resposta metadata tardia após ' + boundary + ' não reaplica refs nem muda rascunho', async () => {
  const pending = deferred(), f = fixture({ steps: [{ suffix: '/runs', pending: pending.promise }] });
  const loading = f.refreshScopedConversationRuns(), oldRuns = f.state.tenant.runs, oldPanel = f.panelHTML;
  change(f); pending.resolve({ runs: [run()] }); assert.equal(await loading, false);
  assert.strictEqual(f.state.tenant.runs, oldRuns); assert.equal(f.panelHTML, oldPanel); assert.equal(f.notices.length, 0);
  assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
});

for (const kind of ['view', 'conversation']) test('render real invalida ABA de ' + kind + ' mesmo quando volta à mesma chave', async () => {
  const pending = deferred(), f = fixture({ steps: [{ suffix: '/runs', pending: pending.promise }] });
  const old = f.refreshScopedConversationRuns();
  if (kind === 'view') { f.navigate('channels'); f.steps.push({ suffix: '/runs', data: { runs: [] } }); f.navigate('inbox');assert.equal(f.groupResets,2); }
  else { f.state.conversation = null; f.render(); f.state.conversation = 'case-a'; f.steps.push({ suffix: '/runs', data: { runs: [] } }); f.render(); }
  await settle(); pending.resolve({ runs: [run()] }); assert.equal(await old, false);
  assert.ok(f.groupSyncs>=2,'Render verifica o contexto dos grupos também durante troca de view/conversa.');
  assert.ok(f.visitorSyncs>=2,'Render revalida o visitante também durante troca de view/conversa.');
  assert.equal(f.state.tenant.runs.length, 0); assert.doesNotMatch(f.panelHTML, /fact-own-contact/); assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
});

test('consulta mais nova vence a anterior no mesmo contexto e aborta o request antigo', async () => {
  const first = deferred(), second = deferred(), f = fixture({ steps: [{ suffix: '/runs', pending: first.promise }, { suffix: '/runs', pending: second.promise }] });
  const old = f.refreshScopedConversationRuns(), latest = f.refreshScopedConversationRuns();
  assert.equal(f.calls[0].options.signal.aborted, true);
  second.resolve({ runs: [] }); assert.equal(await latest, true); first.resolve({ runs: [run()] }); assert.equal(await old, false);
  assert.equal(f.state.tenant.runs.length, 0); f.done();
});

test('render recusado pelo limite de rascunhos invalida leitura antiga e conserva todos os campos', async () => {
  const pending=deferred(),f=fixture({steps:[{suffix:'/runs',pending:pending.promise}]});
  const reading=f.refreshScopedConversationRuns(),oldPanel=f.panelHTML;f.refuseDraftSave();f.render();
  pending.resolve({runs:[run()]});assert.equal(await reading,false);assert.equal(f.fullRenders,0);assert.equal(f.panelHTML,oldPanel);
  assert.equal(f.calls.length,1);assert.match(f.notices[0].message,/Limite de rascunhos/);assert.equal(f.text.value,'Texto digitado ainda não enviado');
  assert.strictEqual(f.mediaUI.selected,f.attachment);assert.equal(f.note.value,'Nota ainda não salva');f.done();
});

for(const boundary of ['conversation-version','run-version','memory-revoked'])test('poll geral mais novo por '+boundary+' não é sobrescrito por scoped antigo e faz uma única leitura corretiva',async()=>{
  const fresh=deferred(),f=fixture(),invalid=run({state:'invalidated',draft:null,memoryReferences:undefined,memoryUnavailable:true,version:2}),general=f.general([invalid]);
  if(boundary==='conversation-version')general.conversations[0].version=2;
  if(boundary==='run-version')general.runs[0].memoryUnavailable=undefined;
  if(boundary==='memory-revoked')general.runs[0].version=1;
  f.steps.push({path:'/api/tenants/company-a',data:general},{suffix:'/runs',data:{runs:[run()]}},{suffix:'/runs',pending:fresh.promise});
  await f.pollInbox();assert.equal(f.calls.length,3);assert.doesNotMatch(f.panelHTML,/fact-own-contact|Resposta sintética para revisão/);
  if(boundary==='conversation-version')assert.equal(f.conversation.version,1,'A referência antiga não pode ser mutada');
  fresh.resolve({runs:[invalid]});await settle();assert.equal(f.calls.length,3);assert.equal(f.state.tenant.runs[0].state,'invalidated');
  assert.equal(f.text.value,'Texto digitado ainda não enviado');f.done();
});

test('DTO scoped inválido no poll retira somente painel de runs e informa erro sem fallback metadata',async()=>{
  const f=fixture();f.state.tenant.runs=[run()];f.renderConversationRuns();
  f.steps.push({path:'/api/tenants/company-a',data:f.general()},{suffix:'/runs',data:{runs:[run({memoryReferences:[{...refs[0],content:'SOURCE_PRIVATE_NOT_RENDERED'}]})]}});
  await f.pollInbox();assert.equal(f.state.tenant.runs.length,0);assert.equal(f.notices.length,1);assert.doesNotMatch(f.panelHTML,/fact-own-contact|SOURCE_PRIVATE_NOT_RENDERED/);
  assert.equal(f.effects.some(e=>Array.isArray(e)&&e[0]==='drop-detail'),false);assert.equal(f.text.value,'Texto digitado ainda não enviado');f.done();
});

for (const status of [403, 404]) test('recusa atual ' + status + ' permanece visível e retira apenas runs selecionados', async () => {
  const f = fixture({ steps: [{ suffix: '/runs', error: Object.assign(Error('Acesso scoped recusado'), { status }) }] });
  f.state.tenant.runs.push(run({ id: 'other-run', conversationId: 'case-b' }));
  assert.equal(await f.refreshScopedConversationRuns(), false); assert.deepEqual(Array.from(f.state.tenant.runs, r => r.id), ['other-run']);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].error, true); assert.equal(f.text.value, 'Texto digitado ainda não enviado'); assert.equal(f.fullRenders, 0); f.done();
});

test('recusa tardia de poll após render ABA não derruba detalhe novo nem rascunhos', async () => {
  const pending = deferred(), f = fixture();
  f.steps.push({ path: '/api/tenants/company-a', data: f.general() }, { suffix: '/runs', pending: pending.promise });
  const polling = f.pollInbox(); await settle();
  f.navigate('channels'); f.steps.push({ suffix: '/runs', data: { runs: [] } }); f.navigate('inbox'); await settle();
  pending.reject(Object.assign(Error('Recusa obsoleta'), { status: 403 })); await polling;
  assert.equal(f.effects.some(e => Array.isArray(e) && e[0] === 'drop-detail'), false); assert.equal(f.notices.length, 0);
  assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
});

for (const [label, invalid] of [
  ['conversation errada', { runs: [run({ conversationId: 'case-b' })] }], ['run duplicada', { runs: [run(), run()] }],
  ['snapshot privado', { runs: [run({ memorySnapshot: { pins: refs } })] }], ['ref duplicada', { runs: [run({ memoryReferences: [refs[0], refs[0]] })] }],
  ['texto source', { runs: [run({ memoryReferences: [{ ...refs[0], content: 'SOURCE_PRIVATE_NOT_RENDERED' }] })] }],
  ['título source', { runs: [run({ memoryReferences: [{ ...refs[0], title: 'SOURCE_PRIVATE_NOT_RENDERED' }] })] }]
]) test('DTO scoped rejeita ' + label + ' sem mostrar literal nem reaproveitar metadata velha', async () => {
  const f = fixture({ steps: [{ suffix: '/runs', data: invalid }] });
  assert.equal(await f.refreshScopedConversationRuns(), false); assert.equal(f.state.tenant.runs.length, 0);
  assert.doesNotMatch(f.panelHTML, /SOURCE_PRIVATE_NOT_RENDERED|fact-own-contact/); assert.equal(f.notices.length, 1);
  assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
});

test('submit real de memória atualiza apenas runs após o retorno confirmado', async () => {
  const f = fixture({ steps: [{ suffix: '/runs', data: { runs: [run({ state: 'invalidated', draft: null, memoryReferences: [], memoryUnavailable: true })] } }] }), form = f.form();
  f.memoryUI.submit = async (_kind, _data, actualForm) => { assert.strictEqual(actualForm, form); return true; };
  await f.submit(form); assert.match(f.panelHTML, /Prepare um novo rascunho/); assert.equal(f.fullRenders, 0);
  assert.equal(f.text.value, 'Texto digitado ainda não enviado'); assert.equal(f.player.currentTime, 17); f.done();
});

test('submit de memória antigo não busca outro cid nem depois de ABA com mesmo cid', async () => {
  for (const boundary of ['other', 'aba']) {
    const waiting = deferred(), f = fixture(), form = f.form(); f.memoryUI.submit = async () => waiting.promise;
    const saving = f.submit(form); await settle();
    f.state.conversation = null; f.render();
    if (boundary === 'other') f.state.conversation = 'case-b'; else f.state.conversation = 'case-a';
    // A render of the second context is intentionally absent: this test isolates the obsolete submit's effects.
    waiting.resolve(true); await saving;
    assert.equal(f.calls.length, 0); assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
  }
});

test('decisão MCP usa loader compartilhado com origin capturado e mostra refs frescos', async () => {
  const f = fixture({ steps: [{ suffix: '/tool/approve', data: {} }, { suffix: '/runs', data: { runs: [run()] } }] });
  f.state.tenant.runs = [run({ state: 'waiting_approval', draft: null, toolProposal: { id: 'proposal-own', serverName: 'Consulta própria', toolName: 'elozi_channel_status', version: 1, arguments: {}, readonly: true } })];
  f.renderConversationRuns(); assert.match(f.panelHTML, /<section class="ui-approval" data-rail-approval[\s\S]*data-action="rail:approve" data-id="run-own">/);
  await f.agentRail.act('mcp-approve', 'run-own'); assert.equal(f.calls.length, 2); assert.match(f.panelHTML, /Memória revisada no contexto · 2/); f.done();
});

test('recusa do GET scoped após aprovação MCP não é ocultada por toast de sucesso',async()=>{
  const f=fixture({steps:[{suffix:'/tool/approve',data:{}},{suffix:'/runs',error:Object.assign(Error('Sem acesso atual à execução'),{status:403})}]});
  f.state.tenant.runs=[run({state:'waiting_approval',draft:null,toolProposal:{id:'proposal-own',toolName:'elozi_channel_status',arguments:{}}})];
  await f.agentRail.act('mcp-approve','run-own');assert.equal(f.notices.length,1);assert.equal(f.notices[0].error,true);assert.match(f.notices[0].message,/Sem acesso atual/);
  assert.equal(f.state.tenant.runs.length,0);assert.equal(f.text.value,'Texto digitado ainda não enviado');f.done();
});

test('POST MCP obsoleto após mudar ator ou ABA não inicia outro GET de runs', async () => {
  for (const boundary of ['actor', 'aba', 'other-conversation']) {
    const pending = deferred(), f = fixture({ steps: [{ suffix: '/tool/approve', pending: pending.promise }] });
    f.state.tenant.runs = [run({ state: 'waiting_approval', draft: null, toolProposal: { id: 'proposal-own', toolName: 'elozi_channel_status', arguments: {} } })];
    const deciding = f.agentRail.act('mcp-approve', 'run-own'); await settle();
    if (boundary === 'actor') f.state.boot.session.userId = 'person-b';
    if (boundary === 'other-conversation') f.state.conversation = 'case-b';
    if (boundary === 'aba') { f.state.conversation = null; f.render(); f.state.conversation = 'case-a'; }
    pending.resolve({}); await deciding; assert.equal(f.calls.length, 1); assert.equal(f.text.value, 'Texto digitado ainda não enviado'); f.done();
  }
});
