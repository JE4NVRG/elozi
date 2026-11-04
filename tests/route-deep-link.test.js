// Served route wiring (FRONTEND-V2 §2.4, §8.2 P1d): start(), the hashchange handler and the ?w=
// dialog of public/app.js run unchanged here; bootstrap, render and the conversation selection are
// recorded so the test shows which existing entry point each route uses. The selection itself
// (authorization, drafts, race tickets) is exercised in inbox-selection.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import * as nav from '../public/nav-config.js';
import { parseHash } from '../public/router.js';
import { inboxIdentity } from '../public/consolidated-inbox-ui.js';
import { inboxRouteFilters } from '../public/inbox-route-filters.js';
import { defaultLens, INBOX_PAGE } from '../public/inbox-list-ui.js';
import '../public/locales-inbox-route-recovery.js';
import { excerpt } from './helpers/app-source.js';

const executable = [excerpt('permissions'), excerpt('inbox-selection-state'), excerpt('navigation-render'), excerpt('navigate'), excerpt('route-sync'), excerpt('start')].join('\n')
  + '\n({start,routeChanged,switchRouteWorkspace,currentRouteHash})';
const settle = () => new Promise(resolve => setImmediate(resolve));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function fixture({ hash = '', role = 'operator', platformOwner = false, permissions = null, workspaces = [{ id: 'workspace-a', name: 'Conta A' }], deny = false, request = null } = {}) {
  const tenantsByWorkspace = { 'workspace-a': [{ id: 'company-a', name: 'Empresa A' }, { id: 'company-c', name: 'Empresa C' }], 'workspace-b': [{ id: 'company-b', name: 'Empresa B' }] };
  const state = { boot: null, tenant: null, workspaceId: null, supportGrantId: null, view: 'overview', conversation: null, sendIntent: null };
  const location = { hash }, replaced = [], toasts = [], renders = [], selections = [], switches = [], effects = [], handlers = {}, modalListeners = {}, requests = [];
  const modal = { open: false, title: '', description: '', content: '', close() { if (!this.open) return; this.open = false; modalListeners.close?.(); }, addEventListener(name, callback) { modalListeners[name] = callback; } };
  const bootFor = workspaceId => ({ csrfToken: 'csrf-qa', workspaces, reseller: { id: workspaceId, accountKind: 'business', brand: { name: 'Marca QA' } }, tenants: tenantsByWorkspace[workspaceId],
    session: { userId: 'person-qa', resellerId: workspaceId, role, platformOwner, permissions } });
  const load = (workspaceId, grant = null) => { const boot = bootFor(workspaceId); Object.assign(state, { boot, workspaceId, supportGrantId: grant, tenant: { id: boot.tenants[0].id, conversations: [] }, conversation: null }); };
  const reset = name => ({ reset() { effects.push(name + '-reset'); }, refresh() { effects.push(name + '-refresh'); } });
  const views = Object.fromEntries(nav.LEGACY_KEYS.map(key => [key, () => `<section>${key}</section>`]));
  const globals = {
    ...i18n, ...nav, parseHash, inboxIdentity, inboxRouteFilters, defaultLens, INBOX_PAGE, URLSearchParams, clearTimeout, escape, icon: () => '', state, views, location,
    inboxContactAuthority: () => JSON.stringify([state.workspaceId, state.supportGrantId, state.boot?.session]),
    consolidatedInbox: { cancelLoad() { effects.push('cancel-list'); }, setLimit(value) { effects.push('limit:' + value); } },
    api: async path => { requests.push(path); return request ? request(path, state) : { workspaceId: state.workspaceId, tenants: state.boot.tenants, channels: [{ tenantId: 'company-a', id: 'personal' }, { tenantId: 'company-c', id: 'sales' }] }; },
    history: { state: null, replaceState(_state, _title, url) { replaced.push(url); location.hash = url; } },
    window: { addEventListener(name, callback) { handlers[name] = callback; }, scrollTo() {} },
    $: selector => selector === '#modal' ? modal : null,
    refresh: async () => { load('workspace-a'); return true; },
    // Same guard as render() (resolveView over the served navigationContext rules).
    render() { state.view = nav.resolveView(state.view, nav.navContext({ session: state.boot.session, supportGrantId: state.supportGrantId, hasTenant: Boolean(state.tenant) })); renders.push(state.view); },
    loadViewPanels: async () => effects.push('panels'), loadNavigatedPanels: () => effects.push('navigated-panels'), focusViewContent: () => effects.push('focus'),
    refreshInboxList: async () => effects.push('inbox-list'),
    selectInboxConversation: async (tenantId, conversationId) => {
      selections.push([tenantId, conversationId]);
      if (deny) { toasts.push(['Acesso negado pelo servidor', true]); return undefined; }
      state.tenant = { id: tenantId, conversations: [{ id: conversationId }] }; state.conversation = conversationId; return state.tenant.conversations[0];
    },
    changeWorkspace: async (workspaceId, grant) => { switches.push([workspaceId, grant]); if (state.sendIntent) return; load(workspaceId, grant); },
    openModal: (title, description, content) => { Object.assign(modal, { open: true, title, description, content: String(content) }); },
    toast: (message, error) => toasts.push([message, Boolean(error)]),
    mediaUI: { sending: false }, voiceRecorder: { busy: false }, blockPendingSend: () => { if (!state.sendIntent) return false; toasts.push(['pendente', true]); return true; },
    contactLinksUI: reset('contact-links'), platformUsersUI: reset('platform-users'), commercialUsageUI: reset('usage'), groupsWorkspaceUI: reset('groups'),
    contactRefresh: reset('contacts'), memoryUI: reset('memory'), teamChatUI: reset('team-chat')
  };
  const app = runInNewContext(executable, globals);
  return { ...app, state, location, replaced, toasts, renders, selections, switches, effects, requests, modal, hashchange: async next => { location.hash = next; await handlers.hashchange(); await settle(); } };
}

test('advanced list filters restore from fresh department and assignee catalogs, then reset completely', async () => {
  const catalog={workspaceId:'workspace-a',tenants:[{id:'company-a'}],channels:[],departments:[{tenantId:'company-a',id:'support'}],assignees:[{tenantId:'company-a',id:'operator-a'}]};
  const f=fixture({hash:'#inbox?tenant=company-a&department=support&assignedUser=operator-a&status=closed&sort=oldest',request:async()=>catalog});
  await f.start();assert.equal(f.state.department,'["company-a","support"]');assert.equal(f.state.assignedUser,'operator-a');
  assert.equal(f.state.status,'closed');assert.equal(f.state.sort,'oldest');assert.equal(f.requests.length,1);
  const canonical=parseHash(f.currentRouteHash());assert.equal(canonical.query.department,'support');assert.equal(canonical.query.assignedUser,'operator-a');
  await f.hashchange('#inbox');assert.equal(f.state.department,'all');assert.equal(f.state.assignedUser,'all');assert.equal(f.state.status,'active');assert.equal(f.state.sort,'recent');
});
test('status/sort and unassigned need no extra catalog and remain synchronous',async()=>{
  const f=fixture({hash:'#inbox?status=pending&sort=unread&department=unassigned'});await f.start();
  assert.equal(f.state.status,'pending');assert.equal(f.state.sort,'unread');assert.equal(f.state.department,'unassigned');assert.deepEqual(f.requests,[]);
});
for(const hash of ['#inbox?status=unknown','#inbox?assignedUser=x&assignedUser=y','#inbox?department=bad%ZZ'])test('invalid advanced raw inbox intent is rejected without broad fallback: '+hash,async()=>{
  const f=fixture({hash});await f.start();assert.equal(f.state.view,'overview');assert.deepEqual(f.requests,[]);assert.equal(f.effects.includes('inbox-list'),false);assert.ok(f.toasts.length);
});
for(const reject of [false,true])test('department/assignee catalog ABA retains latest authorized list, rejected='+reject,async()=>{
  const pending=[],hash='#inbox?tenant=company-a&department=support&assignedUser=operator-a&status=closed&sort=oldest';
  const f=fixture({hash:'#overview',request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});await f.start();
  const old=f.hashchange(hash);await settle();await f.hashchange('#contacts');const latest=f.hashchange(hash);await settle();
  const dto={workspaceId:'workspace-a',tenants:[{id:'company-a'}],departments:[{tenantId:'company-a',id:'support'}],assignees:[{tenantId:'company-a',id:'operator-a'}]};
  pending[1].resolve(dto);await latest;
  if(reject)pending[0].reject(Error('obsolete'));else pending[0].resolve({...dto,departments:[]});await old;
  assert.equal(f.state.view,'inbox');assert.equal(f.state.department,'["company-a","support"]');assert.equal(f.state.assignedUser,'operator-a');assert.deepEqual(f.toasts,[]);
});

test('rota real de canal faz leitura autorizada e limpa filtros ao voltar para lista simples', async () => {
  const f = fixture({ hash: '#inbox?tenant=company-a&channel=personal&q=Jean&unread=1' });
  await f.start();
  assert.equal(f.state.inboxCompany, 'company-a'); assert.equal(f.state.channel, '["company-a","personal"]');
  assert.equal(f.state.search, 'Jean'); assert.equal(f.state.unread, true);
  assert.deepEqual(f.requests, ['/api/inbox?limit=1&tenantId=company-a']);
  await f.hashchange('#inbox?tenant=company-c');
  assert.equal(f.state.inboxCompany, 'company-c'); assert.equal(f.state.channel, 'all');
  assert.equal(f.state.search, ''); assert.equal(f.state.unread, false); assert.equal(f.state.filter, 'mine');
  await f.hashchange('#inbox?tenant=company-a&channel=personal&q=Jean&unread=1');
  assert.equal(f.state.channel, '["company-a","personal"]'); assert.equal(f.state.search, 'Jean');
});

for (const hash of ['#inbox?channel=unknown', '#inbox?tenant=company-a&channel=sales', '#inbox?channel=bad%20value', '#inbox?channel=personal&channel=sales', '#inbox?tenant=foreign']) test('rota não amplia silenciosamente escopo inválido: ' + hash, async () => {
  const f = fixture({ hash }); await f.start();
  assert.equal(f.state.view, 'overview'); assert.equal(f.state.channel, undefined);
  assert.match(f.toasts.at(-1)[0], /não está no seu acesso/);
  assert.equal(f.effects.includes('inbox-list'), false, 'nenhuma consulta ampla de fallback');
});

test('catálogo falho não aplica filtro parcial; workspace explícito é confirmado antes do catálogo', async () => {
  const f = fixture({ hash: '#inbox?tenant=company-a&channel=personal', request: async () => { throw Error('network'); } });
  await f.start(); assert.equal(f.state.channel, undefined); assert.equal(f.state.view, 'overview');
  assert.match(f.toasts.at(-1)[0], /Não foi possível conferir/);
  const other = fixture({ hash: '#inbox?channel=personal&w=workspace-b', workspaces: [{ id: 'workspace-a', name: 'A' }, { id: 'workspace-b', name: 'B' }] });
  await other.start(); assert.equal(other.modal.open, true); assert.deepEqual(other.requests, []);
});

for (const rejected of [false, true]) test('catálogo antigo após navegação não aplica estado, aviso ou redirecionamento: rejected=' + rejected, async () => {
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const f = fixture({ hash: '#overview', request: () => pending }); await f.start();
  const old = f.hashchange('#inbox?tenant=company-a&channel=personal'); await settle();
  await f.hashchange('#contacts');
  if (rejected) reject(Error('stale')); else resolve({ workspaceId: 'workspace-a', tenants: [{ id: 'company-a' }], channels: [{ tenantId: 'company-a', id: 'personal' }] });
  await old; assert.equal(f.state.view, 'contacts'); assert.equal(f.state.channel, undefined);
  assert.deepEqual(f.toasts, []); assert.equal(f.location.hash, '#contacts');
});

for (const rejected of [false, true]) test('ABA do mesmo hash: catálogo anterior não altera ou rejeita rota mais recente: rejected=' + rejected, async () => {
  const pending = [];
  const f = fixture({ hash: '#overview', request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  await f.start();
  const same = '#inbox?tenant=company-a&channel=personal';
  const old = f.hashchange(same); await settle();
  await f.hashchange('#contacts');
  const latest = f.hashchange(same); await settle();
  assert.equal(pending.length, 2);
  pending[1].resolve({ workspaceId: 'workspace-a', tenants: [{ id: 'company-a' }], channels: [{ tenantId: 'company-a', id: 'personal' }] });
  await latest; const refreshes = f.effects.filter(effect => effect === 'inbox-list').length;
  if (rejected) pending[0].reject(Error('obsolete network failure'));
  else pending[0].resolve({ workspaceId: 'workspace-a', tenants: [{ id: 'company-a' }], channels: [] });
  await old;
  assert.equal(f.state.view, 'inbox'); assert.equal(f.state.channel, '["company-a","personal"]');
  assert.equal(f.location.hash, same); assert.deepEqual(f.toasts, []);
  assert.equal(f.effects.filter(effect => effect === 'inbox-list').length, refreshes);
});

test('recarregar em #inbox/<t>/<c> abre a conversa pela seleção existente depois do primeiro render', async () => {
  const f = fixture({ hash: '#inbox/company-a/case-a' });
  await f.start();
  assert.equal(f.state.view, 'inbox'); assert.deepEqual(f.renders, ['inbox']);
  assert.deepEqual(f.selections, [['company-a', 'case-a']]); assert.equal(f.state.conversation, 'case-a');
  assert.deepEqual(f.toasts, []); assert.deepEqual(f.replaced, [], 'o deep link permanece no endereço'); assert.equal(f.modal.open, false);
  assert.equal(f.currentRouteHash(), '#inbox/company-a/case-a');
  const other = fixture({ hash: '#inbox/company-c/case-c' }); await other.start(); assert.deepEqual(other.selections, [['company-c', 'case-c']], 'outra empresa autorizada também abre');
});

test('empresa fora de boot.tenants não chama a seleção: avisa e volta para #inbox', async () => {
  const f = fixture({ hash: '#inbox/company-b/case-b' });
  await f.start();
  assert.deepEqual(f.selections, []); assert.equal(f.state.view, 'inbox'); assert.equal(f.state.conversation, null);
  assert.deepEqual(f.toasts, [['Você não tem acesso a esta conversa.', true]]); assert.deepEqual(f.replaced, ['#inbox']);
  i18n.setLocale('en', { persist: false, notify: false });
  try { const english = fixture({ hash: '#inbox/company-b/case-b' }); await english.start(); assert.deepEqual(english.toasts, [['You do not have access to this conversation.', true]]); }
  finally { i18n.setLocale('pt-BR', { persist: false, notify: false }); }
});

test('seleção recusada pelo servidor mantém o aviso da seleção e corrige o endereço', async () => {
  const f = fixture({ hash: '#inbox/company-a/case-a', deny: true });
  await f.start();
  assert.deepEqual(f.selections, [['company-a', 'case-a']]); assert.deepEqual(f.toasts, [['Acesso negado pelo servidor', true]]); assert.deepEqual(f.replaced, ['#inbox']);
});

test('?w= de outro workspace pergunta antes; Trocar usa changeWorkspace e só então abre a conversa', async () => {
  const workspaces = [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Conta <B>' }];
  const f = fixture({ hash: '#inbox/company-b/case-b?w=workspace-b', workspaces });
  await f.start();
  assert.equal(f.state.workspaceId, 'workspace-a', 'nunca troca sozinho'); assert.deepEqual(f.switches, []); assert.deepEqual(f.selections, []);
  assert.equal(f.modal.open, true); assert.equal(f.modal.title, 'Abrir link de outro workspace'); assert.equal(f.modal.description, 'Conta <B>');
  assert.match(f.modal.content, /<p>Este link é do workspace Conta &lt;B&gt;\. Trocar de workspace\?<\/p>/);
  assert.match(f.modal.content, /data-close-modal>Ficar aqui<\/button><button type="button" class="button primary" data-action="route-workspace-switch">Trocar<\/button>/);
  await f.switchRouteWorkspace();
  assert.deepEqual(f.switches, [['workspace-b', null]]); assert.equal(f.state.workspaceId, 'workspace-b'); assert.equal(f.modal.open, false);
  assert.deepEqual(f.selections, [['company-b', 'case-b']]); assert.equal(f.currentRouteHash(), '#inbox/company-b/case-b?w=workspace-b', 'com mais de um workspace o deep link leva ?w=');
  await f.switchRouteWorkspace(); assert.deepEqual(f.switches, [['workspace-b', null]], 'a intenção vale uma vez');
});

test('Ficar aqui (ou Esc) descarta a intenção e devolve o endereço da tela atual', async () => {
  const f = fixture({ hash: '#settings/team?w=workspace-b', role: 'reseller', workspaces: [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Conta B' }] });
  await f.start();
  assert.equal(f.modal.open, true); assert.equal(f.state.view, 'team');
  f.modal.close();
  assert.deepEqual(f.replaced, ['#settings/team']); await f.switchRouteWorkspace(); assert.deepEqual(f.switches, []);
});

test('?w= ausente da lista avisa sem abrir diálogo; ?w= do workspace atual segue direto; concessão de suporte vai junto', async () => {
  const unknown = fixture({ hash: '#inbox/company-a/case-a?w=workspace-z' });
  await unknown.start();
  assert.equal(unknown.modal.open, false); assert.deepEqual(unknown.selections, []); assert.deepEqual(unknown.toasts, [['Este link é de um workspace que não está disponível para você.', true]]);
  assert.deepEqual(unknown.replaced, ['#inbox']);
  const same = fixture({ hash: '#inbox/company-a/case-a?w=workspace-a' }); await same.start();
  assert.equal(same.modal.open, false); assert.deepEqual(same.selections, [['company-a', 'case-a']]);
  const support = fixture({ hash: '#inbox/company-b/case-b?w=workspace-b', workspaces: [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Cliente B', supportGrantId: 'grant-b' }] });
  await support.start(); await support.switchRouteWorkspace();
  assert.deepEqual(support.switches, [['workspace-b', 'grant-b']]); assert.deepEqual(support.selections, [['company-b', 'case-b']]);
  const changed = fixture({ hash: '#inbox/company-b/case-b?w=workspace-b', workspaces: [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Conta B' }] });
  await changed.start(); changed.state.workspaceId = 'workspace-c'; await changed.switchRouteWorkspace();
  assert.deepEqual(changed.switches, [], 'contexto mudou depois do diálogo: nada é trocado');
  const blocked = fixture({ hash: '#inbox/company-b/case-b?w=workspace-b', workspaces: [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Conta B' }] });
  await blocked.start(); blocked.state.sendIntent = { id: 'pending' }; await blocked.switchRouteWorkspace();
  assert.deepEqual(blocked.selections, [], 'a guarda do changeWorkspace vale'); assert.equal(blocked.state.workspaceId, 'workspace-a'); assert.equal(blocked.location.hash, '#inbox', 'endereço volta para a tela atual');
});

test('hash legado vira a rota canônica e rota proibida cai no destino do guard, com o endereço corrigido', async () => {
  const admin = fixture({ hash: '#knowledge', role: 'reseller' }); await admin.start();
  assert.equal(admin.state.view, 'knowledge'); assert.deepEqual(admin.replaced, ['#agents/knowledge']);
  const operator = fixture({ hash: '#settings/team', permissions: [] }); await operator.start();
  assert.equal(operator.state.view, 'overview'); assert.deepEqual(operator.replaced, ['#overview']);
  const canonical = fixture({ hash: '#automation/flows', permissions: ['flows.read'] }); await canonical.start();
  assert.equal(canonical.state.view, 'flows'); assert.deepEqual(canonical.replaced, []);
  const pending = fixture({ hash: '#pending' }); await pending.start();
  assert.equal(pending.state.view, 'overview', 'tela anunciada para o P1f ainda não existe'); assert.deepEqual(pending.replaced, ['#overview']);
});

test('hashchange troca de tela, abre deep link e mantém as guardas de envio pendente', async () => {
  const f = fixture({ hash: '#inbox', role: 'reseller', platformOwner: true });
  await f.start(); assert.deepEqual(f.selections, []);
  await f.hashchange('#inbox/company-a/case-b');
  assert.deepEqual(f.selections, [['company-a', 'case-b']]); assert.equal(f.state.view, 'inbox');
  await f.hashchange('#inbox/company-a/case-b'); assert.equal(f.selections.length, 1, 'mesma conversa não é selecionada de novo');
  await f.hashchange('#platform/users'); assert.equal(f.state.view, 'platform-users'); assert.ok(f.effects.includes('navigated-panels'));
  await f.hashchange('#tenants'); assert.equal(f.state.view, 'tenants'); assert.equal(f.replaced.at(-1), '#settings/companies');
  f.state.sendIntent = { id: 'pending' };
  await f.hashchange('#contacts');
  assert.equal(f.state.view, 'tenants'); assert.equal(f.location.hash, '#settings/companies'); assert.deepEqual(f.toasts.at(-1), ['pendente', true]);
  await f.hashchange('#guide-overview'); assert.equal(f.state.view, 'tenants', 'âncora do guia não é rota');
  f.state.sendIntent = null; f.state.boot.workspaces = [{ id: 'workspace-a', name: 'Conta A' }, { id: 'workspace-b', name: 'Conta B' }];
  await f.hashchange('#inbox/company-b/case-b?w=workspace-b');
  assert.equal(f.modal.open, true, 'link colado com a tela aberta também pergunta'); assert.equal(f.state.view, 'tenants'); assert.deepEqual(f.switches, []); assert.equal(f.selections.length, 1);
});
