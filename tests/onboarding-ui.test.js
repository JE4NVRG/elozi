// First use (#setup, FRONTEND-V2 §5.6, §8.8): progress derived from the data, reseller steps, the
// invited attendant page and the only stored choices ("dispensar", "vou atender sozinho").
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../public/i18n.js';
import { createOnboarding, readSetupPrefs, saveSetupPrefs, loadPortfolio, forgetHomeData, homeData } from '../public/onboarding-ui.js';
import { provideAppServices } from '../public/channel-connect-flow.js';

const locale = value => setLocale(value, { persist: false, notify: false });
const memory = () => { const data = new Map(), keys = []; return { keys, getItem: key => data.get(key) ?? null, setItem: (key, value) => { keys.push(key); data.set(key, String(value)); }, removeItem: key => data.delete(key) }; };
let storage;
test.beforeEach(() => { storage = memory(); Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true }); });
test.afterEach(() => { locale('pt-BR'); provideAppServices(null); forgetHomeData(); });

const channel = (more = {}) => ({ id: 'wa-1', kind: 'whatsapp_qr', transport: 'baileys', name: 'Vendas', state: 'disconnected', ...more });
function appState({ role = 'reseller', accountKind = 'business', brand = { name: 'Elozi', initials: 'E', accent: '#3157d5' }, channels = [], conversations = [], agents = [], assignees = null, presence = 'available', tenant = true } = {}) {
  return {
    boot: { session: { userId: 'u-1', name: 'Jean', role, presence }, reseller: { accountKind, brand }, tenants: [{ id: 't-1' }] }, workspaceId: 'w-1', supportGrantId: null,
    tenant: tenant ? { id: 't-1', name: 'Loja QA', channels, conversations, agents, runs: [] } : null,
    overviewLoaded: { contacts: false, assignees: Array.isArray(assignees) }, assignees: assignees || []
  };
}
const steps = html => [...html.matchAll(/<li class="pg-home__setup-item" data-state="([a-z]+)"><button type="button" class="pg-home__setup-step" data-action="setup:select" data-id="([a-z]+)"/g)].map(match => [match[2], match[1]]);

test('primeiro uso configura assistente, sem sugerir ativação ou resposta automática', async () => {
  const ui=createOnboarding({state:appState()});await ui.act('setup:select','agent');
  assert.match(ui.view(),/href="#agents"[^>]*><span class="ui-btn__label">Configurar/);
  assert.doesNotMatch(ui.view(),/>Ligar</);
  locale('en');assert.match(ui.view(),/href="#agents"[^>]*><span class="ui-btn__label">(?:Configure|Set up)/);
  assert.doesNotMatch(ui.view(),/>Turn on</);
});

test('sem dados do painel, #setup mantém o aviso honesto e leva à Visão geral', () => {
  const html = createOnboarding({ pageHeading: (eyebrow, title) => `<h1>${title}</h1>` }).view();
  assert.match(html, /<h1>Primeiro uso<\/h1>[\s\S]*O guia de primeiro uso ainda não está disponível nesta versão\./); assert.match(html, /data-view="overview"/);
});

test('admin de empresa: etapas derivadas dos dados, a primeira pendente aberta e o canal inline', async () => {
  const ui = createOnboarding({ state: appState({ assignees: [{ id: 'u-1', name: 'Jean' }] }) });
  const html = ui.view();
  assert.deepEqual(steps(html), [['company', 'done'], ['channel', 'todo'], ['team', 'todo'], ['agent', 'todo'], ['test', 'unknown']]);
  assert.match(html, /aria-valuenow="1" aria-valuetext="1 de 4 etapas"/);
  assert.match(html, /data-id="channel" aria-current="step"/);
  for (const kind of ['whatsapp_qr', 'telegram', 'webchat', 'email', 'instagram', 'messenger']) assert.match(html, new RegExp(`href="#channels/new/${kind}"`), kind);
  assert.match(html, /Pronto agora: um código no seu site\.[\s\S]*?ui-btn--primary ui-btn--md" href="#channels\/new\/webchat"><span class="ui-btn__label">Instalar/);
  const connected = createOnboarding({ state: appState({ channels: [channel({ state: 'connected' })], assignees: [{ id: 'a' }, { id: 'b' }], agents: [{ id: 'ag', name: 'Assistente', configured: true }], conversations: [{ id: 'c', channelId: 'wa-1', status: 'open', messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'sent' }] }] }) }).view();
  assert.deepEqual(steps(connected), [['company', 'done'], ['channel', 'done'], ['team', 'done'], ['agent', 'done'], ['test', 'done']]);
  assert.match(connected, /<h1 class="pg-home__title">Preparação do atendimento manual concluída<\/h1>/);
  const unknown = createOnboarding({ state: appState() }).view();
  assert.deepEqual(steps(unknown)[2], ['team', 'unknown'], 'equipe não carregada não vira pendência inventada');
  // E-mail stays 'configured' (src/channel-email.js): a conversation it received proves the channel.
  const mail = { id: 'mail', kind: 'email', name: 'Atendimento', state: 'configured' };
  const email = createOnboarding({ state: appState({ channels: [mail], conversations: [{ id: 'm-1', channelId: 'mail', status: 'open' }] }) });
  assert.deepEqual(steps(email.view())[1], ['channel', 'done']);
  await email.act('setup:select', 'channel'); assert.match(email.view(), /<strong>Atendimento<\/strong> · Configurado · conferir entrada/);
  await email.act('setup:select', 'test'); assert.match(email.view(), /href="#channels\/mail"><span class="ui-btn__label">Começar/, 'o teste abre o canal no passo Testar');
  assert.deepEqual(steps(createOnboarding({ state: appState({ channels: [mail] }) }).view())[1], ['channel', 'todo'], 'configurado sem conversa ainda não provou recebimento');
});

test('guia prioriza atendimento manual e mostra a conferência individual dos canais sem prometer entrega', async () => {
  const state = appState({ channels: [channel({ state: 'connected', name: 'Canal pessoal' }), channel({ id: 'wa-2', state: 'connected', name: 'Agência' }), channel({ id: 'foreign', tenantId: 'other', name: 'Fora do acesso' })],
    assignees: [{ id: 'a' }, { id: 'b' }], conversations: [{ id: 'c', channelId: 'wa-1', status: 'open', messages: [{ kind: 'customer', text: 'Mensagem privada' }, { kind: 'human', delivery: 'sent' }] }] });
  const pendingState = { ...state, tenant: { ...state.tenant, conversations: [] } };
  const pending = createOnboarding({ state: pendingState }).view();
  assert.match(pending, /data-id="test" aria-current="step"/);
  assert.match(pending, /Agente <small>opcional<\/small>/);
  assert.match(pending, /Você pode começar sem agente\./);
  const ui = createOnboarding({ state }), html = ui.view();
  assert.match(html, /aria-valuenow="4" aria-valuetext="4 de 4 etapas"/);
  assert.match(html, /data-id="test" aria-current="step"/, 'depois de preparar o manual, o guia mantém a conferência acessível');
  const rows = [...html.matchAll(/<li class="pg-home__choice" data-setup-channel="([^"]+)">([\s\S]*?)<\/div><\/li>/g)];
  assert.deepEqual(rows.map(row => row[1]), ['wa-1', 'wa-2']);
  assert.match(rows[0][2], /Canal pessoal[\s\S]*Conectado[\s\S]*Entrada registrada[\s\S]*Resposta registrada/);
  assert.match(rows[1][2], /Agência[\s\S]*Conectado[\s\S]*Entrada: conferir no Atendimento[\s\S]*Resposta: conferir no Atendimento/);
  assert.match(html, /Leitura parcial: a conferência mostra apenas os registros disponíveis para seu acesso\./);
  assert.match(html, /O registro de envio não confirma o recebimento no destino\./);
  for (const absent of ['Fora do acesso', 'Mensagem privada', 'Peça um rascunho ao agente', 'A resposta chega ao cliente']) assert.ok(!html.includes(absent), absent);
  await ui.act('setup:select', 'agent'); assert.match(ui.view(), /O agente é opcional\./);
  state.tenant.agents = [{ id: 'ag', name: 'Assistente', configured: true }];
  assert.match(ui.view(), /Assistente: configuração salva/); assert.ok(!ui.view().includes('pronto para rascunhar'));
});

test('etapa Empresa aponta configurações existentes e o idioma pessoal no menu da conta', async () => {
  const ui = createOnboarding({ state: appState() });
  await ui.act('setup:select', 'company');
  assert.match(ui.view(), /Nome, segmento e estrutura ficam em Configurações › Empresas e filiais\./);
  assert.match(ui.view(), /O idioma do painel fica no menu da sua conta\./);
  assert.match(ui.view(), /href="#settings\/companies"/);
  assert.doesNotMatch(ui.view(), /Nome, fuso e idioma/);
  locale('en');
  assert.match(ui.view(), /Name, segment and structure are in Settings › Companies and branches\./);
  assert.match(ui.view(), /The panel language is in your account menu\./);
  assert.match(ui.view(), /href="#settings\/companies"/);
});

test('selecionar, "vou atender sozinho" e dispensar: só a preferência local é guardada', async () => {
  const state = appState({ assignees: [{ id: 'u-1' }] }), ui = createOnboarding({ state });
  ui.view();
  assert.equal(await ui.act('setup:select', 'team'), true);
  let html = ui.view();
  assert.match(html, /data-id="team" aria-current="step"/); assert.match(html, /href="#settings\/team"[\s\S]*data-action="setup:solo" data-id="on"/);
  await ui.act('setup:solo', 'on');
  html = ui.view();
  assert.deepEqual(steps(html)[2], ['team', 'done']); assert.match(html, /Você vai atender sozinho por enquanto\./); assert.match(html, /data-action="setup:solo" data-id="off"/);
  assert.deepEqual(readSetupPrefs('u-1', 't-1', storage), { dismissed: false, solo: true, completedAt: null, attendanceMode: 'solo' });
  await ui.act('setup:dismiss');
  assert.match(ui.view(), /Guia dispensado[\s\S]*data-action="setup:restore"/);
  assert.deepEqual([...new Set(storage.keys)], ['elozi:setup:u-1'], 'nada além da preferência de primeiro uso');
  assert.ok(!JSON.parse(storage.getItem('elozi:setup:u-1'))['t-1'].name, 'nenhum dado da empresa no storage');
  await ui.act('setup:restore'); assert.equal(readSetupPrefs('u-1', 't-1', storage).dismissed, false);
  assert.equal(await ui.act('setup:anything'), false);
  const operator = createOnboarding({ state: appState({ role: 'operator' }) });
  await operator.act('setup:solo', 'on'); assert.equal(readSetupPrefs('u-1', 't-1', storage).solo, true, 'o admin já tinha escolhido');
  saveSetupPrefs('u-1', 't-2', { solo: true }, storage); assert.equal(readSetupPrefs('u-1', 't-2', storage).solo, true); assert.equal(readSetupPrefs('u-1', 't-3', storage).solo, false);
});

test('revenda: marca com prévia clara e escura e relatório, domínio, primeiro cliente pela carteira e "Ajudar seu cliente"', async () => {
  const state = appState({ accountKind: 'reseller', brand: { name: 'Acme', initials: 'A', accent: '#f2a900' } });
  const calls = [];
  const api = async path => { calls.push(path); return { accounts: [{ id: 'w-1', accountKind: 'reseller' }, { id: 'c-1', name: 'Cliente', accountKind: 'business', parentWorkspaceId: 'w-1', onboarding: {}, counts: {} }], total: 2, offset: 0, limit: 100 }; };
  provideAppServices({ state, api });
  const ui = createOnboarding();
  let html = ui.view();
  assert.match(html, /<p class="pg-home__eyebrow">Sua revenda<\/p>/);
  assert.deepEqual(steps(html).slice(5), [['brand', 'done'], ['domain', 'info'], ['client', 'unknown'], ['plan', 'info'], ['help', 'info']]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(calls[0], /^\/api\/accounts\?view=account&/);
  html = ui.view(); assert.deepEqual(steps(html)[7], ['client', 'done'], 'a carteira conclui o primeiro cliente');
  await ui.act('setup:select', 'brand');
  html = ui.view();
  assert.match(html, /data-theme-sample="light"[\s\S]*data-theme-sample="dark"/); assert.match(html, /Usaremos texto escuro nos botões/); assert.match(html, /href="#settings\/brand"/);
  await ui.act('setup:select', 'domain'); assert.match(ui.view(), /data-action="workspace-domain"/);
  await ui.act('setup:select', 'help'); html = ui.view();
  assert.match(html, /O vínculo comercial não dá acesso ao atendimento do cliente\./); assert.match(html, /href="#settings\/support"><span class="ui-btn__label">Ver acessos de suporte recebidos/);
  assert.match(html, /peça ao administrador dele que conceda um suporte com prazo/); assert.ok(!html.includes('Solicitar suporte'), 'o painel não tem fluxo de solicitação: nenhum botão promete um');
  assert.equal(calls.length, 1, 'a carteira é consultada uma vez a cada 5 minutos');
});

test('atendente convidado: 6 atalhos, disponibilidade inicial e alertas só quando a pessoa pede', async () => {
  const state = appState({ role: 'operator', presence: 'away' });
  const calls = [], refreshed = [];
  let requested = 0;
  const NotificationStub = function () {}; NotificationStub.permission = 'default'; NotificationStub.requestPermission = async () => { requested++; return 'granted'; };
  const saved = globalThis.Notification; globalThis.Notification = NotificationStub;
  try {
    provideAppServices({ state, api: async (path, options) => { calls.push([path, options.method, JSON.parse(options.body)]); return { user: {} }; }, refresh: async () => refreshed.push(true), toast: () => {} });
    const ui = createOnboarding();
    const html = ui.view();
    assert.match(html, /<h1 class="pg-home__title">Boas-vindas ao atendimento<\/h1>/);
    assert.equal((html.match(/<div><dt>/g) || []).length, 6, 'seis atalhos essenciais'); assert.match(html, /<kbd class="ui-kbd">/);
    assert.match(html, /name="presence" value="away" checked/); assert.equal((html.match(/name="presence"/g) || []).length, 4);
    assert.match(html, /<div data-setup-alerts><button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-action="setup:alerts"/); assert.equal(requested, 0, 'nunca pede permissão sozinho');
    assert.match(html, /<h2 id="setup-alerts-title" class="pg-home__panel-title" tabindex="-1">/); assert.match(html, /role="status" data-setup-alerts-status><\/p>/);
    for (const absent of ['setup:dismiss', 'Sua revenda', 'href="#channels/new']) assert.ok(!html.includes(absent), absent);
    const form = { dataset: { form: 'setup:presence' }, elements: { namedItem: name => name === 'presence' ? { value: 'available' } : null } };
    assert.equal(await ui.submit(form), true);
    assert.deepEqual(calls, [['/api/auth/presence', 'PATCH', { presence: 'available' }]]); assert.equal(refreshed.length, 1);
    await ui.submit({ dataset: { form: 'setup:presence' }, elements: { namedItem: () => ({ value: 'invisible' }) } }); assert.equal(calls.length, 1, 'valor fora da lista não é enviado');
    // In the page only the alerts block changes: the same role="status" node receives the result.
    const status = { textContent: '' }, focused = [];
    const box = { contains: () => true, querySelector: () => null, replaceChildren(...nodes) { this.nodes = nodes; } };
    const savedDocument = globalThis.document;
    globalThis.document = { activeElement: {}, querySelector: selector => selector === '[data-setup-alerts]' ? box : selector === '[data-setup-alerts-status]' ? status : null,
      getElementById: id => ({ focus: () => focused.push(id) }), createElement: () => ({ set innerHTML(value) { this.html = value; }, content: { get childNodes() { return ['granted'] } } }) };
    NotificationStub.requestPermission = async () => { requested++; NotificationStub.permission = 'granted'; return 'granted'; };
    try { await ui.act('setup:alerts'); } finally { globalThis.document = savedDocument; }
    assert.equal(requested, 1);
    assert.equal(status.textContent, 'Alertas permitidos. Escolha som e prévia no menu da conta.'); assert.deepEqual(box.nodes, ['granted']);
    assert.deepEqual(focused, ['setup-alerts-title'], 'o botão some: o foco vai para o título do bloco');
    assert.equal(await ui.submit({ dataset: { form: 'setup:other' } }), false);
  } finally { globalThis.Notification = saved; }
});

test('sem empresa e EN: estado vazio com uma ação; textos traduzidos', async () => {
  const empty = createOnboarding({ state: appState({ tenant: false }) }).view();
  const actions = empty.match(/<div class="ui-empty__actions">([\s\S]*?)<\/div>/)[1];
  assert.equal((actions.match(/<button/g) || []).length, 1); assert.match(empty, /Nenhuma empresa selecionada/);
  locale('en');
  const html = createOnboarding({ state: appState({ assignees: [{ id: 'u-1' }] }) }).view();
  assert.match(html, /<p class="pg-home__eyebrow">First steps<\/p><h1 class="pg-home__title">Set up your operation<\/h1>/);
  assert.match(html, /Ready now: a snippet on your website\./);
  const entry = homeData('k', async () => 1, { now: 0 }); assert.equal(entry.state, 'loading');
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(entry.state, 'loaded');
  assert.equal(homeData('k', async () => 2, { now: 1000 }), entry, 'cache de 5 minutos');
  const failing = loadPortfolio(async () => ({ nope: true }), { workspaceId: 'w', userId: 'u' });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(failing.state, 'error');
});
