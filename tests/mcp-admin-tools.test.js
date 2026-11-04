// Correção MCP (FRONTEND-V2 §5.3.1 and §8.2, P1 commit 1g). The Ferramentas tab of the agents hub
// (#agents/tools, view 'agent-tools' of nav-config.js) mounts the MCP panel of mcp-ui.js for the
// workspace admin. Before 1g "Gerenciar ferramentas" (action mcp-settings) navigated to Integrações,
// which only the platform owner opens: the admin of a reseller landed on the overview and never
// reached servers, catalog or grants. The tests run the real modules and the served excerpts of
// app.js (delegated-screens, agent-card, navigate, route-sync, start and render() with the shell) for
// the admin of a reseller without platformOwner, an attendant and temporary support.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import '../public/locales-operations.js';
import * as nav from '../public/nav-config.js';
import * as shell from '../public/shell-ui.js';
import { parseHash } from '../public/router.js';
import { icon } from '../public/icons.js';
import { createMcpUI } from '../public/mcp-ui.js';
import { createAgentsHub } from '../public/agents-hub-ui.js';
import { createChannelsUI } from '../public/channels-ui.js';
import { createChannelVisitorTestUI } from '../public/channel-visitor-test-ui.js';
import { createAgentConnectWizard } from '../public/agent-connect-wizard.js';
import { createPending } from '../public/pending-ui.js';
import { createOnboarding } from '../public/onboarding-ui.js';
// render() frames each view with the hub of settings-ui.js (P8); outside its hubs it is nav-config's hubFrame.
import { createSettings, screenFrame } from '../public/settings-ui.js';
import { createAttention } from '../public/attention.js';
import { inboxIdentity } from '../public/consolidated-inbox-ui.js';
import { navigationDescriptions } from '../public/nav-config.js';
import { applyBrandTokens, deriveBrandTokens } from '../public/brand-theme.js';
import { syncThemePrefs } from '../public/theme-prefs.js';
import { OPERATOR_DEFAULT_PERMISSIONS } from '../src/access.js';
import { excerpt, publicSource } from './helpers/app-source.js';

const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// Same helpers as public/app.js (badge, button and pageHeading are plain functions outside the anchors).
const badge = (text, type = 'neutral') => i18n.html`<span class="badge ${type}">${escape(text)}</span>`;
const button = (label, action, variant = '', glyph = '') => i18n.html`<button class="button ${variant}" data-action="${action}">${glyph ? icon(glyph) : ''}${escape(label)}</button>`;
const pageHeading = (eyebrow, title, description, actions = '') => i18n.html`<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
const roleLabel = publicSource('app.js').split('\n').find(line => line.startsWith('const roleLabel = '));

const RESELLER_ADMIN = { userId: 'admin-revenda', role: 'reseller', platformOwner: false, permissions: null, name: 'Admin da Revenda' };
const OPERATOR = { userId: 'atendente', role: 'operator', platformOwner: false, permissions: [...OPERATOR_DEFAULT_PERMISSIONS], name: 'Atendente' };
const SUPPORT = { userId: 'suporte', role: 'operator', platformOwner: false, permissions: ['inbox.read'], name: 'Suporte' };
const OWNER = { userId: 'dono', role: 'reseller', platformOwner: true, permissions: null, name: 'Dono' };
const ctxOf = (session, { supportGrantId = null, hasTenant = true, accountKind = 'reseller' } = {}) => nav.navContext({ session, supportGrantId, hasTenant, accountKind });

const INTERNAL = { id: 'elozi-internal', kind: 'internal', name: 'Consultas internas', enabled: true, state: 'ready', version: 2, checkedAt: '2026-10-06T12:00:00.000Z',
  tools: [{ name: 'elozi_contact_profile', title: 'Perfil do contato', description: 'Ficha do contato da conversa.', hash: 'hash-perfil', inputSchema: {} }] };
const EXTERNAL = { id: 'erp', kind: 'remote', name: 'ERP <Loja>', enabled: true, state: 'ready', version: 5, endpoint: 'https://erp.exemplo/mcp', tokenConfigured: true,
  tools: [{ name: 'lookup_order', title: 'Consultar pedido', description: 'Pedido pelo número.', hash: 'hash-pedido', inputSchema: { type: 'object' } }] };
const tenantOf = () => ({ id: 'loja-centro', name: 'Loja Centro', channels: [], conversations: [], runs: [],
  agents: [{ id: 'hermes-a', name: 'Assistente Loja', description: 'Copiloto da loja.', provider: 'hermes', configured: true, mcpGrants: [{ serverId: 'erp', toolName: 'lookup_order' }], knowledgeGrants: [] }] });

// mcp-ui.js submit() reads the dialog with FormData and closes #modal, as in the browser.
class FakeFormData { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } getAll(name) { return [].concat(this.fields[name] ?? []); } has(name) { return Object.hasOwn(this.fields, name); } }
function dialogGlobals(t) {
  const modal = { closed: 0, close() { this.closed++; } }, previous = { FormData: globalThis.FormData, document: globalThis.document };
  globalThis.FormData = FakeFormData; globalThis.document = { querySelector: selector => selector === '#modal' ? modal : null };
  t.after(() => { globalThis.FormData = previous.FormData; globalThis.document = previous.document; });
  return modal;
}

// ---------------------------------------------------------------------------------------------
// 1. Route, access and hub tab (nav-config.js)

test('#agents/tools é a aba Ferramentas do admin do workspace, inclusive da revenda sem platformOwner; atendente e suporte caem no guard', () => {
  assert.equal(nav.viewForRoute(parseHash('#agents/tools')), 'agent-tools');
  assert.equal(nav.hashForView('agent-tools'), '#agents/tools');
  assert.equal(nav.LEGACY_KEYS.includes('agent-tools'), false, 'as 25 views legadas (e o oráculo da matriz) não mudam');
  const admin = ctxOf(RESELLER_ADMIN);
  // The cause of the bug: Integrações stays the platform owner's page.
  assert.equal(nav.legacyRouteAllowed('integrations', admin), false);
  assert.equal(nav.resolveView('integrations', admin), 'overview', 'antes do 1g, Gerenciar ferramentas levava a revenda para a Visão geral');
  for (const [person, label] of [[admin, 'revenda'], [ctxOf(RESELLER_ADMIN, { accountKind: 'business' }), 'conta direta'], [ctxOf(OWNER, { accountKind: 'platform' }), 'dono']]) {
    assert.equal(nav.legacyRouteAllowed('agent-tools', person), true, label);
    assert.equal(nav.legacyVisible('agent-tools', person), true, `${label}: aba no hub e item da busca`);
    assert.equal(nav.resolveView('agent-tools', person), 'agent-tools', label);
  }
  const denied = [[ctxOf(OPERATOR), 'atendente'], [ctxOf({ ...OPERATOR, permissions: [] }), 'atendente sem permissões'],
    [ctxOf(SUPPORT, { supportGrantId: 'grant-qa' }), 'suporte temporário'], [ctxOf(RESELLER_ADMIN, { supportGrantId: 'grant-qa' }), 'papel de admin dentro do suporte']];
  for (const [person, label] of denied) {
    assert.equal(nav.legacyRouteAllowed('agent-tools', person), false, label);
    assert.equal(nav.legacyVisible('agent-tools', person), false, label);
    assert.equal(nav.resolveView('agent-tools', person), 'overview', label);
  }
  assert.equal(nav.resolveView('agent-tools', ctxOf(RESELLER_ADMIN, { hasTenant: false })), 'accounts', 'sem empresa: o mesmo destino das outras abas do hub');
  const agents = nav.NAV_ITEMS.find(item => item.key === 'agents');
  assert.deepEqual(agents.views, ['agents', 'knowledge', 'agent-tools', 'service-agents']);
  assert.equal(nav.navItemOf('agent-tools'), agents, 'o menu marca Agentes na aba Ferramentas');
  assert.equal(agents.route, '#agents', 'o item do menu continua abrindo a lista');
});

test('hub Agentes: Ferramentas entre Conhecimento e Agentes conectados, ativa em #agents/tools, ausente para atendente e suporte', () => {
  const legacy = '<section>conteúdo</section>';
  const tools = nav.hubFrame('agent-tools', ctxOf(RESELLER_ADMIN), legacy);
  assert.ok(tools.includes(legacy));
  assert.deepEqual([...tools.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]), ['agents', 'knowledge', 'tools', 'connect']);
  assert.deepEqual([...tools.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['#agents', '#agents/knowledge', '#agents/tools', '#agents/connect']);
  assert.match(tools, /<a class="ui-tabs__tab" role="tab" id="hub-agents-tab-tools" aria-selected="true" aria-controls="hub-agents-panel-tools" tabindex="0" data-tab="tools" href="#agents\/tools" aria-current="page">Ferramentas<\/a>/);
  assert.match(tools, /<div class="ui-tabpanel" role="tabpanel" id="hub-agents-panel-tools" aria-labelledby="hub-agents-tab-tools">/);
  assert.match(nav.hubFrame('agents', ctxOf(RESELLER_ADMIN), legacy), /aria-selected="false"[^>]*data-tab="tools" href="#agents\/tools">Ferramentas<\/a>/);
  assert.equal(nav.hubFrame('agents', ctxOf(OPERATOR), legacy), legacy, 'atendente: só a lista, sem faixa de abas');
  assert.equal(nav.hubFrame('agents', ctxOf(SUPPORT, { supportGrantId: 'grant-qa' }), legacy), legacy);
  assert.deepEqual(shell.shellCrumbs({ view: 'agent-tools', viewLabel: 'Ferramentas', brandName: 'Acme' }), { brand: 'Acme', section: 'Agentes', tab: 'Ferramentas', screen: 'Ferramentas' });
  assert.equal(navigationDescriptions['agent-tools'], 'Servidores MCP e ferramentas dos copilotos', 'a busca do painel acha a aba pelo nome e por "MCP"');
  // The served catalog of the finder (anchor navigation-render): Ferramentas for the admin only.
  const served = session => runInNewContext(excerpt('permissions') + '\n' + excerpt('navigation-render') + '\n({navigation,allowedNavigation})',
    { ...i18n, ...nav, icon: () => '', escape, state: { boot: { session, reseller: { accountKind: 'reseller' } }, supportGrantId: null, tenant: { id: 'loja-centro' } } });
  const admin = served(RESELLER_ADMIN);
  assert.deepEqual(JSON.parse(JSON.stringify(admin.navigation.find(([key]) => key === 'agent-tools'))), ['agent-tools', 'Ferramentas', 'code']);
  assert.equal(admin.allowedNavigation('agent-tools'), true); assert.equal(served(OPERATOR).allowedNavigation('agent-tools'), false);
  locale('en');
  assert.match(nav.hubFrame('agent-tools', ctxOf(RESELLER_ADMIN), legacy), /data-tab="tools" href="#agents\/tools" aria-current="page">Tools<\/a>/);
  assert.equal(i18n.t(navigationDescriptions['agent-tools']), 'MCP servers and copilot tools');
});

test('nenhum link do painel leva a revenda para Integrações: os atalhos das ferramentas MCP abrem Agentes › Ferramentas', () => {
  const modules = readdirSync(new URL('../public/', import.meta.url)).filter(file => file.endsWith('.js') && !file.startsWith('locales-'));
  assert.ok(modules.length > 50);
  for (const file of modules) assert.doesNotMatch(publicSource(file), /data-view=\\?["']integrations\\?["']|navigate\(\s*["']integrations["']\s*\)/, `${file}: Integrações é só do dono da plataforma`);
  assert.match(publicSource('service-principals-ui.js'), /data-view="agent-tools">Ferramentas de outras plataformas<\/button>/, 'atalho da jornada de Agentes conectados');
  assert.doesNotMatch(publicSource('mcp-ui.js'), /Central de Integrações/, 'o painel e as concessões não mandam a revenda para Integrações');
});

// ---------------------------------------------------------------------------------------------
// 2. The tab on screen (anchor delegated-screens + real agents-hub-ui.js and mcp-ui.js)

function screens({ session = RESELLER_ADMIN, supportGrantId = null, servers = [INTERNAL, EXTERNAL] } = {}) {
  const requests = [], forms = [], navigations = [], toasts = [];
  const state = { view: 'agent-tools', workspaceId: 'acme', supportGrantId, boot: { session: { ...session, supportGrantId }, reseller: { id: 'acme', name: 'Acme Revenda', accountKind: 'reseller' } },
    tenant: tenantOf(), mcpServers: structuredClone(servers), mcpLoaded: true };
  const grantData = { version: 7, toolPolicy: 'approve_all', grants: [{ serverId: 'erp', toolName: 'lookup_order', toolHash: 'hash-pedido', serverVersion: 5 }] };
  const api = async (path, options = {}) => {
    const method = options.method || 'GET', tail = path.replace('/api/tenants/loja-centro/', '');
    requests.push({ method, tail, body: options.body ? JSON.parse(options.body) : undefined });
    if (method !== 'GET') return { ok: true };
    if (tail === 'mcp/servers') return { servers: structuredClone(servers) };
    if (tail === 'agents/hermes-a/mcp-grants') return structuredClone(grantData);
    return assert.fail('requisição inesperada: ' + path);
  };
  const mcpUI = createMcpUI({ state, escape, icon, badge, api, tenantApi: tail => `/api/tenants/${state.tenant.id}/${tail}`,
    formModal: (title, description, type, fields, submit) => forms.push({ title, description, type, fields: String(fields), submit }),
    refresh: async () => {}, render: () => {}, toast: message => toasts.push(message), navigate: view => navigations.push(view) });
  const sandbox = {
    ...i18n, ...nav, parseHash, state, location: { hash: '#agents/tools' }, escape, icon, badge, button, pageHeading, mcpUI,
    renderAgentAdminProposals: () => '', renderSupportAssistant: () => '', channels: () => [], servicePrincipalsUI: { markup: () => '' },
    views: { overview: () => '<section>visão</section>' }, createAgentsHub, createChannelsUI, createChannelVisitorTestUI, channelVisitorTestUI: null, reauthPending: () => false, createAgentConnectWizard, createPending, createOnboarding, createSettings, createAttention,
    createNotify: () => ({ apply() {} }), createConnectionStatus: () => ({ apply() {} }), keyboard: { setScope() {} }, registerScreen() {},
    agentRail: { reset() {}, act: async () => false, submit: async () => false }, api, document: { getElementById: () => null }
  };
  const real = runInNewContext(excerpt('delegated-screens') + '\n({views,SCREENS})', sandbox);
  return { ...real, state, mcpUI, requests, forms, navigations, toasts };
}

test('revenda sem platformOwner: a aba Ferramentas mostra o painel MCP, Gerenciar ferramentas leva a #agents/tools e as concessões abrem e salvam', async t => {
  const modal = dialogGlobals(t), f = screens();
  const page = f.views['agent-tools']();
  assert.match(page, /^<div class="page-heading"><div><div class="eyebrow">FERRAMENTAS DOS AGENTES<\/div><h1>Ferramentas para os copilotos desta empresa\.<\/h1>/);
  assert.match(page, /<section id="mcp-settings" class="mcp-settings" aria-labelledby="mcp-settings-title">/, 'o painel do mcp-ui.js');
  assert.match(page, /<h3>Consultas internas<\/h3>[\s\S]*<code>elozi_contact_profile<\/code>/);
  assert.match(page, /<h3>ERP &lt;Loja&gt;<\/h3>[\s\S]*<code>https:\/\/erp\.exemplo\/mcp<\/code>[\s\S]*<code>lookup_order<\/code>/, 'dados do servidor escapados');
  assert.match(page, /data-action="mcp-new-server"/); assert.match(page, /data-action="mcp-discover" data-id="erp"/); assert.match(page, /data-action="mcp-toggle-server" data-id="erp"/);
  assert.doesNotMatch(page, /data-action="mcp-activate-internal"/, 'as consultas internas já estão ativas');
  assert.match(page, /data-view="agents">Gerenciar agentes/, 'as concessões de cada copiloto ficam na aba Agentes');
  // Agentes (P5): Ferramentas is a tab of the hub (#agents/tools) and the grants of each managed copilot
  // open from its detail (#agents/<id>/tools → "Escolher ferramentas" → mcp-grants of mcp-ui.js).
  const list = f.views.agents();
  assert.match(list, /href="#agents\/hermes-a">Assistente Loja<\/a>/); assert.doesNotMatch(list, /Hermes/, 'sem o motor fora do workspace da plataforma');
  // The detail's "Escolher ferramentas" (agents:tool-grants) calls mcp-ui's mcp-grants below (tests/agent-detail-ui.test.js).
  await f.mcpUI.act('mcp-settings');
  assert.deepEqual(f.navigations, ['agent-tools'], 'Gerenciar ferramentas não passa mais por Integrações');
  assert.equal(nav.hashForView(f.navigations[0]), '#agents/tools');
  await f.mcpUI.act('mcp-grants', 'hermes-a');
  assert.deepEqual(f.requests.map(request => [request.method, request.tail]), [['GET', 'mcp/servers'], ['GET', 'agents/hermes-a/mcp-grants']]);
  const grants = f.forms.at(-1);
  assert.equal(grants.type, 'mcp-grants'); assert.equal(grants.title, 'Ferramentas autorizadas'); assert.match(grants.description, /^Assistente Loja · Loja Centro\./);
  assert.match(grants.fields, /name="toolPolicy" value="approve_all" checked/, 'política salva no servidor');
  assert.match(grants.fields, /name="mcpTool" value="0" {2}\/>[\s\S]*elozi_contact_profile/); assert.match(grants.fields, /name="mcpTool" value="1" checked \/>[\s\S]*lookup_order/);
  assert.equal(await f.mcpUI.submit({ dataset: { dialogForm: 'mcp-grants' }, fields: { mcpTool: ['0', '1'], toolPolicy: 'auto_readonly' } }), true);
  assert.deepEqual(f.requests.at(-1), { method: 'PUT', tail: 'agents/hermes-a/mcp-grants', body: { version: 7, toolPolicy: 'auto_readonly',
    grants: [{ serverId: 'elozi-internal', toolName: 'elozi_contact_profile', toolHash: 'hash-perfil', serverVersion: 2 }, { serverId: 'erp', toolName: 'lookup_order', toolHash: 'hash-pedido', serverVersion: 5 }] } });
  assert.equal(modal.closed, 1); assert.deepEqual(f.toasts, ['Ferramentas autorizadas atualizadas.']);
  await f.mcpUI.act('mcp-new-server');
  assert.equal(f.forms.at(-1).type, 'mcp-server'); assert.equal(f.forms.at(-1).title, 'Adicionar servidor MCP');
});

test('sem servidores: a aba oferece ativar as consultas internas e as concessões apontam para Agentes › Ferramentas, em PT e EN', async () => {
  const f = screens({ servers: [] });
  assert.match(f.views['agent-tools'](), /data-action="mcp-activate-internal"[\s\S]*data-action="mcp-new-server"/);
  await f.mcpUI.act('mcp-grants', 'hermes-a');
  assert.match(f.forms.at(-1).fields, /<p class="mcp-form-note">Ative um servidor e descubra suas ferramentas em Agentes › Ferramentas\.<\/p>/);
  assert.doesNotMatch(f.forms.at(-1).fields, /Integra[çc]/, 'a revenda não abre Integrações');
  locale('en');
  assert.match(f.views['agent-tools'](), /<div class="eyebrow">AGENT TOOLS<\/div><h1>Tools for this company's copilots\.<\/h1><p>MCP servers, catalog and grants apply only to this company\. Only the workspace administration changes this setup\.<\/p>/);
  await f.mcpUI.act('mcp-grants', 'hermes-a');
  assert.match(f.forms.at(-1).fields, /Enable a server and discover its tools in Agents › Tools\./);
});

test('atendente e suporte temporário não veem o painel nem abrem concessões; nenhuma requisição sai', async t => {
  dialogGlobals(t);
  for (const [session, supportGrantId, label] of [[OPERATOR, null, 'atendente'], [SUPPORT, 'grant-qa', 'suporte temporário']]) {
    const f = screens({ session, supportGrantId });
    assert.equal(f.mcpUI.panel(), '', label);
    const page = f.views['agent-tools']();
    assert.doesNotMatch(page, /mcp-settings|data-action="mcp-/, `${label}: sem painel nem ações`);
    assert.match(page, /<section class="panel empty">A configuração de ferramentas pertence ao administrador do workspace\.<\/section>$/, `${label}: aviso honesto se a tela for alcançada`);
    const list = f.views.agents();
    assert.doesNotMatch(list, /data-action="mcp-settings"|data-action="mcp-grants"|agents:tool-grants|agents:new/, label);
    assert.match(list, /Somente a administração do workspace altera os agentes\./, `${label}: lista em leitura (o Guia fica no menu da conta, §2.2)`);
    await assert.rejects(f.mcpUI.act('mcp-grants', 'hermes-a'), /administrador do workspace/);
    await assert.rejects(f.mcpUI.act('mcp-settings'), /administrador do workspace/);
    await assert.rejects(f.mcpUI.submit({ dataset: { dialogForm: 'mcp-grants' }, fields: { mcpTool: ['0'] } }), /administrador do workspace/);
    assert.deepEqual([f.requests.length, f.forms.length, f.navigations.length], [0, 0, 0], label);
  }
  locale('en');
  assert.match(screens({ session: OPERATOR }).views['agent-tools'](), /Tool configuration is managed by workspace administrators\./);
});

// ---------------------------------------------------------------------------------------------
// 3. Served routing (anchors permissions, inbox-selection-state, navigation-render, navigate,
//    route-sync and start) and the served render() with the shell (anchor navigation-heading)

function routing({ hash = '', session = RESELLER_ADMIN, supportGrantId = null } = {}) {
  const state = { boot: null, tenant: null, workspaceId: null, supportGrantId: null, view: 'overview', conversation: null, sendIntent: null };
  const location = { hash }, replaced = [], renders = [], handlers = {}, modal = { open: false, addEventListener() {}, close() {} };
  const load = () => Object.assign(state, { boot: { workspaces: [{ id: 'acme', name: 'Acme Revenda' }], reseller: { id: 'acme', accountKind: 'reseller', brand: { name: 'Acme Atendimento' } },
    tenants: [{ id: 'loja-centro', name: 'Loja Centro' }], session: { ...session, resellerId: 'acme', supportGrantId } }, workspaceId: 'acme', supportGrantId, tenant: { id: 'loja-centro', conversations: [] } });
  const idle = { reset() {}, refresh() {} };
  const globals = {
    ...i18n, ...nav, parseHash, inboxIdentity, escape, icon: () => '', state, location,
    views: Object.fromEntries([...nav.LEGACY_KEYS, ...Object.keys(nav.SCREEN_VIEWS)].map(key => [key, () => ''])),
    history: { state: null, replaceState(_state, _title, url) { replaced.push(url); location.hash = url; } },
    window: { addEventListener(name, callback) { handlers[name] = callback; }, scrollTo() {} }, $: selector => selector === '#modal' ? modal : null,
    refresh: async () => { load(); return true; },
    render() { state.view = nav.resolveView(state.view, nav.navContext({ session: state.boot.session, supportGrantId: state.supportGrantId, hasTenant: Boolean(state.tenant), accountKind: 'reseller' })); renders.push(state.view); },
    loadViewPanels: async () => {}, loadNavigatedPanels() {}, focusViewContent() {}, refreshInboxList: async () => {}, selectInboxConversation: async () => assert.fail('nenhuma conversa'),
    changeWorkspace: async () => assert.fail('nenhuma troca de workspace'), openModal: () => assert.fail('nenhum diálogo'), toast: message => assert.fail('nenhum aviso: ' + message),
    mediaUI: { sending: false }, voiceRecorder: { busy: false }, blockPendingSend: () => false,
    contactLinksUI: idle, platformUsersUI: idle, commercialUsageUI: idle, groupsWorkspaceUI: idle, contactRefresh: idle, memoryUI: idle, teamChatUI: idle
  };
  const served = runInNewContext([excerpt('permissions'), excerpt('inbox-selection-state'), excerpt('navigation-render'), excerpt('navigate'), excerpt('route-sync'), excerpt('start')].join('\n')
    + '\n({start,navigate,currentRouteHash})', globals);
  return { ...served, state, location, replaced, renders, hashchange: async next => { location.hash = next; await handlers.hashchange(); } };
}

test('rotas servidas: Gerenciar ferramentas grava #agents/tools; o deep link abre a aba da revenda e leva atendente e suporte à Visão geral', async () => {
  const admin = routing({ hash: '#agents' });
  await admin.start();
  assert.equal(admin.state.view, 'agents');
  await createMcpUI({ state: admin.state, navigate: admin.navigate }).act('mcp-settings');
  assert.equal(admin.state.view, 'agent-tools'); assert.equal(admin.location.hash, '#agents/tools'); assert.deepEqual(admin.renders, ['agents', 'agent-tools']);
  await admin.hashchange('#agents/tools');
  assert.deepEqual(admin.renders, ['agents', 'agent-tools'], 'o hashchange do próprio navigate não redesenha');
  await admin.hashchange('#agents');
  assert.equal(admin.state.view, 'agents', 'a aba Agentes volta pela faixa do hub');
  const reload = routing({ hash: '#agents/tools' });
  await reload.start();
  assert.equal(reload.state.view, 'agent-tools'); assert.deepEqual(reload.replaced, [], 'recarregar mantém a aba'); assert.equal(reload.currentRouteHash(), '#agents/tools');
  for (const [session, supportGrantId] of [[OPERATOR, null], [SUPPORT, 'grant-qa']]) {
    const denied = routing({ hash: '#agents/tools', session, supportGrantId });
    await denied.start();
    assert.equal(denied.state.view, 'overview'); assert.deepEqual(denied.replaced, ['#overview'], 'o endereço é corrigido');
  }
});

function rendered({ session = RESELLER_ADMIN } = {}) {
  const app = { innerHTML: '' }, documentStub = { title: '', documentElement: { style: { setProperty() {} }, setAttribute() {}, removeAttribute() {} }, getElementById: () => null };
  const state = { view: 'agent-tools', workspaceId: 'acme', supportGrantId: null, conversation: null, sendIntent: null, menuOpen: false, mcpServers: [INTERNAL], mcpLoaded: true,
    boot: { version: '0.47.0', tenants: [{ id: 'loja-centro', name: 'Loja Centro' }], workspaces: [{ id: 'acme', name: 'Acme Revenda' }],
      reseller: { id: 'acme', name: 'Acme Revenda', accountKind: 'reseller', brand: { name: 'Acme Atendimento', initials: 'AC', accent: '#e11d48', logo: '' } },
      session: { resellerId: 'acme', presence: 'available', ...session } },
    tenant: tenantOf(), account: { google: { enabled: false }, user: { googleLinked: false } } };
  const mcpUI = createMcpUI({ state, escape, icon, badge, api: async () => assert.fail('render não consulta'), tenantApi: tail => tail, navigate() {} });
  const queries = { [shell.SHELL_MOBILE_QUERY]: false, [shell.SHELL_WIDE_QUERY]: true, [shell.SHELL_XWIDE_QUERY]: true };
  const idle = { syncContext() {}, bind() {} };
  const globals = {
    ...i18n, ...nav, ...shell, screenFrame, parseHash, state, location: { hash: '#agents/tools' }, escape, icon, badge, button, pageHeading, document: documentStub, applyBrandTokens, deriveBrandTokens, syncThemePrefs, mcpUI,
    views: Object.fromEntries(nav.LEGACY_KEYS.map(key => [key, () => `<section data-rendered-view="${key}"><h1>Tela legada ${key}</h1></section>`])),
    $: selector => selector === '#app' ? app : null, matchMedia: query => ({ matches: Boolean(queries[query]) }),
    hasPermission: permission => state.boot.session.role === 'reseller' || state.boot.session.permissions == null || state.boot.session.permissions.includes(permission),
    commercialUsageUI: idle, memoryUI: idle, groupsWorkspaceUI: { syncContext() {}, bind: async () => {} }, consolidatedInbox: { saveDraft: () => true, getDraft: () => '' }, noteDrafts: { key: null },
    mediaUI: { syncContext: () => true, draft: '' }, forwarding: { close() {} }, syncAttendanceTools() {}, repliesUI: { retainConversations() {}, syncContext() {} }, voiceRecorder: idle,
    canSendTo: () => false, supportsVoice: () => false, selectedInboxRef: () => null, inboxIdentity, attendanceContext: () => ({}), chatLayout: { sync() {}, collapsed: false },
    avatarUI: idle, integrationsUI: idle, teamChatUI: idle, bindAgentAdminProposals() {}, bindSupportAssistant() {}, bindInboxMedia() {}, composerStatus() {}, refreshScopedConversationRuns: async () => false,
    renderAgentAdminProposals: () => '', renderSupportAssistant: () => '', channels: () => [], servicePrincipalsUI: { markup: () => '' },
    createAgentsHub, createChannelsUI, createChannelVisitorTestUI, channelVisitorTestUI: null, reauthPending: () => false, createAgentConnectWizard, createPending, createOnboarding, createSettings, createAttention,
    createNotify: () => ({ apply() {} }), createConnectionStatus: () => ({ apply() {} }), keyboard: { setScope() {} }, registerScreen() {},
    agentRail: { reset() {}, act: async () => false, submit: async () => false }, api: async () => assert.fail('render não consulta'), refresh: async () => {},
    toast: message => assert.fail('render não deve avisar: ' + message)
  };
  const served = runInNewContext(roleLabel + '\n' + excerpt('navigation-heading') + '\n' + excerpt('delegated-screens') + '\n({render})', globals);
  served.render();
  return { state, document: documentStub, html: app.innerHTML };
}

test('render servido em #agents/tools: faixa do hub com Ferramentas ativa, painel no <main>, menu, trilha e título; atendente cai na Visão geral', () => {
  for (const language of ['pt-BR', 'en']) {
    locale(language);
    const f = rendered(), en = language === 'en', tab = en ? 'Tools' : 'Ferramentas';
    assert.equal(f.state.view, 'agent-tools');
    assert.match(f.html, /<div class="app-shell sh-app" data-view="agent-tools"/);
    assert.match(f.html, new RegExp(`<main id="main-content" tabindex="-1" class="content"><div class="ui-hub" data-hub="agents">[\\s\\S]*data-tab="tools" href="#agents/tools" aria-current="page">${tab}</a>[\\s\\S]*<div class="ui-tabpanel" role="tabpanel" id="hub-agents-panel-tools" aria-labelledby="hub-agents-tab-tools"><div class="page-heading">[\\s\\S]*<section id="mcp-settings" class="mcp-settings"`));
    assert.match(f.html, en ? /<h1>Tools for this company's copilots\.<\/h1>/ : /<h1>Ferramentas para os copilotos desta empresa\.<\/h1>/);
    assert.match(f.html, /<a class="sh-nav__item" href="#agents" data-view="agents" aria-current="page">/, 'Agentes marcado no menu');
    assert.match(f.html, new RegExp(`<li class="sh-crumbs__item">${en ? 'Agents' : 'Agentes'}</li><li class="sh-crumbs__item" aria-current="page">${tab}</li>`));
    assert.equal(f.document.title, `${tab} · Acme Atendimento`);
  }
  locale('pt-BR');
  const operator = rendered({ session: OPERATOR });
  assert.equal(operator.state.view, 'overview', 'o guard de render() leva o atendente para a Visão geral');
  assert.doesNotMatch(operator.html, /mcp-settings|data-hub="agents"/);
});
