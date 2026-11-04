// Visão geral (FRONTEND-V2 §5.4, §8.8): KPIs by role as deep links, a single count-up per session,
// the reseller portfolio from the commercial-accounts DTO, the first-use checklist derived from the
// data and honest unavailable/partial states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../public/i18n.js';
import { createOverviewMarkup, overviewModel, countUp, resetCountUp, slaAtRisk } from '../public/overview-ui.js';
import { forgetHomeData, readSetupPrefs } from '../public/onboarding-ui.js';
import { dispatchAction } from '../public/actions.js';

const locale = value => setLocale(value, { persist: false, notify: false });
test.afterEach(() => { locale('pt-BR'); forgetHomeData(); resetCountUp(); });

const NOW = Date.parse('2026-10-06T09:30:00');
const tenant = { id: 'company-a', name: 'Empresa de teste' };
const session = { userId: 'jean-qa', name: 'Jean QA', role: 'reseller' };
const access = { inboxRead: true, contactsRead: true, contactsWrite: true, metricsRead: true, manageChannels: true, manageTeam: true, manageAgents: true, manageCompany: true, teamChatRead: true };
const channel = { id: 'whatsapp-a', kind: 'whatsapp_qr', transport: 'baileys', name: 'WhatsApp de teste', state: 'connected' };
const conversation = (id, more = {}) => ({ id, contact: `Contato ${id}`, status: 'open', owner: 'queue', channelId: channel.id, department: 'Suporte', updatedAt: '2026-10-04T10:00:00Z', ...more });
const props = more => ({ tenant, session, access, workspaceId: 'w-a', conversations: [], channels: [channel], contacts: [], assignees: [], agents: [], runs: [], accountKind: 'business', brand: null, setupPrefs: { dismissed: false, solo: false, completedAt: null }, now: NOW, noMount: true, ...more });
const count = (html, key) => html.match(new RegExp(`data-overview-count="${key}"[^>]*>([^<]+)</strong>`))?.[1];
const kpiHref = (html, key) => html.match(new RegExp(`<a class="pg-home__kpi" href="([^"]+)" data-home-kpi="${key}"`))?.[1];
const ids = html => [...html.matchAll(/data-overview-conversation="([^"]*)"/g)].map(match => match[1]);

test('CTA principal conserva empresa anunciada por papel e locale', () => {
  for (const language of ['pt-BR', 'en']) {
    locale(language);
    for (const roleProps of [{}, { session: { ...session, role: 'operator' }, access: { inboxRead: true } }, { supportMode: true }, { accountKind: 'reseller', portfolio: { accounts: [] } }]) {
      const html = createOverviewMarkup(props(roleProps));
      const header = html.slice(html.indexOf('<header class="pg-home__header">'), html.indexOf('</header>'));
      const expected = roleProps.session ? '#inbox?lens=mine&amp;tenant=company-a' : '#inbox?tenant=company-a';
      assert.ok(header.includes(`href="${expected}"`), `${language}: ${JSON.stringify(roleProps)}`);
    }
    const denied = createOverviewMarkup(props({ session: { ...session, role: 'operator' }, access: {} }));
    assert.ok(!denied.includes('href="#inbox'));
  }
});

const minutes = value => new Date(Date.parse('2026-10-06T12:30:00Z') + value * 60000).toISOString();
const slaReport = { asOf: '2026-10-06T12:30:00Z', policy: { enabled: true }, conversations: [
  { conversationId: 'queue', status: 'open', firstReply: { state: 'pending', dueAt: minutes(10), completedAt: null }, resolution: { state: 'pending', dueAt: minutes(240), completedAt: null } },
  { conversationId: 'mine', status: 'open', firstReply: { state: 'met', dueAt: minutes(-60), completedAt: minutes(-70) }, resolution: { state: 'breached', dueAt: minutes(-5), completedAt: null } },
  { conversationId: 'calm', status: 'pending', firstReply: { state: 'pending', dueAt: minutes(60), completedAt: null }, resolution: { state: 'insufficient-data', dueAt: null, completedAt: null } },
  { conversationId: 'late-reply', status: 'open', firstReply: { state: 'breached', dueAt: minutes(-30), completedAt: minutes(-10) }, resolution: { state: 'pending', dueAt: minutes(300), completedAt: null } },
  { conversationId: 'closed', status: 'closed', firstReply: { state: 'breached', dueAt: minutes(-30), completedAt: null }, resolution: { state: 'met', dueAt: minutes(-1), completedAt: minutes(-2) } }
] };

test('admin: cada KPI é um link para a lente filtrada da empresa, com o valor final no nome acessível', () => {
  const html = createOverviewMarkup(props({ sla: slaReport,
    conversations: [conversation('queue'), conversation('mine', { owner: 'human', assignedUserId: session.userId }), conversation('agent', { owner: 'agent', unread: 2 }), conversation('agent-read', { owner: 'agent' }), conversation('closed', { status: 'closed' })],
    runs: [{ id: 'r-1', conversationId: 'mine', state: 'waiting_approval' }, { id: 'r-2', conversationId: 'queue', state: 'draft' }, { id: 'r-3', conversationId: 'outside', state: 'waiting_approval' }],
    channels: [channel, { id: 'down', kind: 'whatsapp_qr', transport: 'baileys', name: 'Atacado', state: 'logged_out' }, { id: 'new', kind: 'telegram', transport: 'telegram-bot', name: 'Novo', state: 'disconnected' }]
  }));
  assert.match(html, /data-home-role="admin"/); assert.match(html, /<p class="pg-home__eyebrow">Visão geral<\/p><h1 id="overview-title" class="pg-home__title">Bom dia, Jean<\/h1>/);
  assert.deepEqual([...html.matchAll(/data-home-kpi="([a-z]+)"/g)].map(match => match[1]), ['queue', 'sla', 'approvals', 'channels', 'agent'], 'os KPIs do admin no §5.4');
  assert.deepEqual({ queue: kpiHref(html, 'queue'), sla: kpiHref(html, 'sla'), approvals: kpiHref(html, 'approvals'), channels: kpiHref(html, 'channels'), agent: kpiHref(html, 'agent') },
    { queue: '#inbox?lens=queue&amp;tenant=company-a', sla: '#metrics/sla', approvals: '#pending', channels: '#channels', agent: '#inbox?lens=agent&amp;unread=1&amp;tenant=company-a' });
  assert.deepEqual(['queue', 'sla', 'approvals', 'channels', 'agent'].map(key => count(html, key)), ['1', '2', '1', '1', '1'], 'aprovação fora das conversas visíveis e canal nunca conectado não contam');
  assert.match(html, /href="#inbox\?tenant=company-a"><span class="ui-btn__label">Ver tudo/, 'Ver tudo abre a mesma empresa');
  assert.match(html, /aria-label="Na fila: 1\. Abrir fila"/); assert.match(html, /data-count-to="1"/);
  assert.match(html, /data-home-kpi="channels" data-tone="danger"[\s\S]*?<span class="pg-home__kpi-detail">Atacado<\/span>/);
  assert.match(html, /<h2 id="overview-queue-title" class="pg-home__panel-title">Prioridade agora<\/h2>/);
  assert.deepEqual(ids(html), ['queue', 'agent', 'mine', 'agent-read'], 'fila primeiro, depois não lidas e as suas');
  assert.match(html, /aria-label="Abrir atendimento de Contato queue, WhatsApp de teste, Na fila"/);
  assert.ok(!html.includes('data-action="channels:'), 'Visão geral só leva a Canais');
});

test('atendente: "Meu dia" com Comigo, Fila, Aprovações nas minhas conversas, Menções em breve e "Continuar de onde parou"', () => {
  const html = createOverviewMarkup(props({ session: { ...session, role: 'operator' }, access: { inboxRead: true },
    conversations: [conversation('a', { owner: 'human', assignedUserId: session.userId, updatedAt: '2026-10-06T08:00:00Z' }), conversation('b', { owner: 'human', assignedUserId: session.userId, updatedAt: '2026-10-06T09:00:00Z' }),
      conversation('c', { owner: 'human', assignedUserId: session.userId, updatedAt: '2026-10-05T09:00:00Z' }), conversation('d', { owner: 'human', assignedUserId: session.userId, updatedAt: '2026-10-01T09:00:00Z' }), conversation('queue')],
    runs: [{ id: 'r', conversationId: 'b', state: 'waiting_approval' }, { id: 'q', conversationId: 'queue', state: 'waiting_approval' }] }));
  assert.match(html, /data-home-role="attendant"/); assert.match(html, /<p class="pg-home__eyebrow">Meu dia<\/p>/);
  assert.equal(kpiHref(html, 'mine'), '#inbox?lens=mine&amp;tenant=company-a'); assert.equal(count(html, 'mine'), '4');
  assert.equal(kpiHref(html, 'queue'), '#inbox?lens=queue&amp;tenant=company-a'); assert.equal(count(html, 'approvals'), '1', 'só nas conversas dele');
  assert.ok(!html.includes('data-home-kpi="sla"'), 'SLA em risco é do admin');
  assert.match(html, /<div class="pg-home__kpi" data-home-kpi="mentions" data-tone="neutral" data-state="soon">[\s\S]*?—[\s\S]*?Em breve/);
  assert.match(html, /Continuar de onde parou/); assert.deepEqual(ids(html), ['b', 'a', 'c'], 'as 3 últimas com ele');
  for (const absent of ['data-home-section="setup"', 'Carteira de clientes', 'Gerenciar canais', 'data-home-kpi="channels"']) assert.ok(!html.includes(absent), absent);
});

test('revenda: carteira a partir do DTO de contas, com "Clientes que precisam de você"', () => {
  const day = 86400000, created = days => new Date(NOW - days * day).toISOString();
  const account = (id, onboarding, counts, more = {}) => ({ id, name: `Cliente ${id}`, accountKind: 'business', parentWorkspaceId: 'w-a', createdAt: created(10), onboarding: { companyCreated: true, administratorActive: true, channelConnected: true, teamReady: true, contractConfigured: true, ...onboarding }, counts: { tenants: 1, users: 3, admins: 1, channels: 1, connectedChannels: 1, agents: 1, activeAgents: 1, ...counts }, ...more });
  const portfolio = { accounts: [
    { id: 'w-a', name: 'Minha revenda', accountKind: 'reseller', parentWorkspaceId: null, onboarding: {}, counts: {} },
    account('pronto', {}, {}), account('inativo', { administratorActive: false, teamReady: false }, { admins: 0 }),
    account('sem-canal', { channelConnected: false }, { channels: 0, connectedChannels: 0 }), account('novo', { channelConnected: false }, { channels: 0, connectedChannels: 0 }, { createdAt: created(2) }),
    account('caido', { channelConnected: false }, { channels: 1, connectedChannels: 0 }), account('email', {}, { channels: 2, connectedChannels: 1 }),
    account('novo-canal', { channelConnected: false }, { channels: 1, connectedChannels: 0 }, { createdAt: created(1) }), { ...account('de-outro', {}, {}), parentWorkspaceId: 'w-z' }
  ], total: 9, offset: 0, limit: 100 };
  const html = createOverviewMarkup(props({ accountKind: 'reseller', portfolio }));
  assert.match(html, /data-home-role="reseller"/); assert.match(html, /<h2 id="home-portfolio-title" class="pg-home__panel-title">Carteira de clientes<\/h2>/);
  const attention = html.match(/<div class="pg-home__attention">([\s\S]*?)<\/div>/)[1];
  assert.match(attention, /Cliente inativo[\s\S]*Administrador não ativou o acesso/); assert.match(attention, /Cliente sem-canal[\s\S]*Sem canal há 7 dias/); assert.match(attention, /Cliente caido[\s\S]*Nenhum canal com conexão ativa/);
  assert.ok(!attention.includes('Cliente pronto') && !attention.includes('Cliente novo') && !attention.includes('Cliente novo-canal'), 'conta nova ainda não pede ação');
  assert.ok(!attention.includes('Cliente email'), 'um canal conectado entre outros (e-mail configurado) não é "canal caído": o DTO não distingue');
  assert.ok(!html.includes('Leitura parcial'), 'todas as contas vieram');
  assert.ok(!html.includes('Cliente de-outro') && !html.includes('Minha revenda'), 'só os clientes desta revenda');
  assert.match(html, /href="#accounts\/pronto"/); assert.match(html, /aria-valuenow="5" aria-valuetext="Empresa inicial criada, Administrador ativo, Canal conectado, Equipe preparada, Contrato configurado"/);
  assert.match(html, /1 de 2 canais conectados/);
  const loading = createOverviewMarkup(props({ accountKind: 'reseller' }));
  assert.match(loading, /data-home-section="portfolio"[\s\S]*?class="ui-skeleton" role="status"><span class="sr-only">Carregando a carteira…/);
  const failed = createOverviewMarkup(props({ accountKind: 'reseller', portfolio: null }));
  assert.match(failed, /Não conseguimos carregar a carteira agora\.[\s\S]*data-action="home:retry" data-id="portfolio"/);
  const empty = createOverviewMarkup(props({ accountKind: 'reseller', portfolio: { accounts: [] } }));
  assert.match(empty, /Nenhum cliente ainda[\s\S]*?<div class="ui-empty__actions"><button type="button" class="ui-btn ui-btn--primary ui-btn--md" data-view="accounts">/);
  assert.ok(!createOverviewMarkup(props({ portfolio })).includes('Carteira de clientes'), 'conta direta não tem carteira');
  const page = createOverviewMarkup(props({ accountKind: 'reseller', portfolio: { accounts: [account('pronto', {}, {})], total: 250, offset: 0, limit: 100 } }));
  assert.match(page, /Leitura parcial: 1 de 250 contas carregadas\. A lista completa fica em Clientes\./); assert.match(page, /Nenhum dos clientes carregados precisa de você agora\./);
});

test('count-up: uma vez por sessão, na primeira pintura com números, e só com movimento permitido', () => {
  const node = value => ({ dataset: { countTo: String(value) }, textContent: String(value), isConnected: true });
  const frames = [], storage = new Map(), store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const nodes = [node(12), node(1250)], root = { querySelectorAll: () => nodes };
  assert.equal(countUp({ querySelectorAll: () => [] }, { storage: store, raf: fn => frames.push(fn) }), false, 'sem números não gasta o count-up');
  assert.equal(countUp(root, { motion: true, storage: store, raf: fn => frames.push(fn), clock: () => 0, ms: 600 }), true);
  assert.deepEqual(nodes.map(item => item.textContent), ['0', '0']);
  frames.shift()(300); assert.ok(Number(nodes[1].textContent.replace(/\D/g, '')) > 0 && nodes[1].textContent !== '1.250');
  frames.shift()(600); assert.deepEqual(nodes.map(item => item.textContent), ['12', '1.250']); assert.equal(frames.length, 0);
  assert.equal(countUp(root, { motion: true, storage: store, raf: fn => frames.push(fn) }), false, 'segunda pintura não anima');
  resetCountUp(); storage.clear();
  const reduced = [node(7)];
  assert.equal(countUp({ querySelectorAll: () => reduced }, { motion: false, storage: store, raf: fn => frames.push(fn) }), false);
  assert.equal(reduced[0].textContent, '7', 'movimento reduzido mostra o valor final'); assert.equal(storage.get('elozi:home:counted'), '1');
  resetCountUp();
  assert.equal(countUp({ querySelectorAll: () => [node(3)] }, { motion: true, storage: store, raf: fn => frames.push(fn) }), false, 'a sessão já contou');
});

test('primeiro uso derivado dos dados: checklist em destaque sem canal, faixa compacta depois e some 7 dias após concluir', () => {
  const firstUse = createOverviewMarkup(props({ channels: [{ ...channel, state: 'disconnected' }], assignees: [{ id: session.userId, name: 'Jean', presence: 'available' }] }));
  assert.match(firstUse, /<section class="pg-home__first-use" data-home-section="setup"/);
  assert.match(firstUse, /Agente <small>opcional<\/small>/, 'o agente continua visível como etapa opcional do primeiro uso');
  assert.match(firstUse, /data-state="done"[\s\S]*?Empresa/); assert.match(firstUse, /data-state="todo"[\s\S]*?Canal[\s\S]*?href="#channels\/new\/whatsapp_qr"/);
  assert.match(firstUse, /Equipe[\s\S]*?href="#settings\/team"[\s\S]*?data-action="home:solo" data-id="on"/);
  assert.match(firstUse, /href="#setup"><span class="ui-btn__label">Abrir o guia de primeiro uso/); assert.match(firstUse, /data-action="home:dismiss"/);
  const email = { id: 'mail', kind: 'email', name: 'E-mail', state: 'configured' };
  assert.ok(!createOverviewMarkup(props({ channels: [email], conversations: [conversation('m', { channelId: 'mail' })] })).includes('pg-home__first-use'), 'e-mail configurado que já recebeu não é primeiro uso');
  assert.match(createOverviewMarkup(props({ channels: [email] })), /pg-home__first-use/, 'configurado sem nenhuma conversa ainda não provou recebimento');
  const strip = createOverviewMarkup(props({ assignees: [{ id: session.userId, name: 'Jean' }] }));
  assert.match(strip, /<a class="pg-home__strip" data-home-section="setup" href="#setup">[\s\S]*?<strong class="pg-home__strip-count">2\/4<\/strong>/);
  const ready = props({ assignees: [{ id: 'a' }, { id: 'b' }], agents: [{ id: 'ag', name: 'Assistente', configured: true }], conversations: [conversation('t', { messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'sent' }] })] });
  assert.match(createOverviewMarkup(ready), /data-state="complete" href="#setup">[\s\S]*?Preparação do atendimento manual concluída/);
  assert.ok(!createOverviewMarkup({ ...ready, setupPrefs: { completedAt: new Date(NOW - 8 * 86400000).toISOString() } }).includes('data-home-section="setup"'));
  const dismissed = createOverviewMarkup(props({ setupPrefs: { dismissed: true } }));
  assert.match(dismissed, /data-home-section="setup" data-state="dismissed"><a class="ui-btn ui-btn--link ui-btn--sm" href="#setup">/, 'dispensado: só um link discreto para o guia');
  assert.ok(!dismissed.includes('pg-home__checklist') && !dismissed.includes('pg-home__strip'));
  assert.ok(!createOverviewMarkup(props({ session: { ...session, role: 'operator' } })).includes('data-home-section="setup"'));
});

test('sem permissão, suporte e listas indisponíveis: nada de números falsos nem ações proibidas', () => {
  const denied = createOverviewMarkup(props({ access: {}, session: { ...session, role: 'operator' }, conversations: [conversation('hidden', { contact: 'Nome confidencial' })] }));
  for (const key of ['mine', 'queue', 'approvals']) assert.equal(count(denied, key), '—');
  assert.ok(!denied.includes('Nome confidencial')); assert.ok(!denied.includes('href="#inbox')); assert.match(denied, /Atendimento fora do seu acesso/);
  const support = createOverviewMarkup(props({ supportMode: true }));
  assert.match(support, /data-home-role="support"/); assert.match(support, /Acesso de suporte/);
  for (const absent of ['data-home-section="setup"', 'Carteira de clientes', 'Gerenciar canais', 'Equipe agora']) assert.ok(!support.includes(absent), absent);
  const unavailable = createOverviewMarkup(props({ conversations: null, channels: null, assignees: null }));
  for (const key of ['queue', 'sla', 'approvals', 'channels', 'agent']) assert.equal(count(unavailable, key), '—', key);
  const empty = unavailable.match(/<h3 class="ui-empty__title">Não conseguimos carregar agora\.<\/h3>[\s\S]*?<\/div><\/div>/)[0];
  assert.equal((empty.match(/ui-btn--primary/g) || []).length, 1, 'erro de carga com uma ação');
  assert.match(unavailable, /Conexões não disponíveis nesta atualização\./); assert.match(unavailable, /Responsáveis não disponíveis nesta atualização\./);
  const partial = createOverviewMarkup(props({ conversations: [conversation('one')], loadState: { conversations: 'partial' } }));
  assert.match(partial, /de 1 carregadas/);
  const zero = createOverviewMarkup(props({ conversations: [] }));
  assert.equal(count(zero, 'queue'), '0'); assert.match(zero, /Nenhum atendimento ativo/);
});

test('escopo, duplicados e conteúdo externo: escapado, sem outra empresa e sem fotos fora da allowlist', () => {
  const attack = '"><img src=x onerror=alert(1)>';
  const html = createOverviewMarkup(props({
    tenant: { id: 'company-a', name: attack }, conversations: [conversation('own', { contact: attack, department: attack }), conversation('own'), conversation('foreign', { tenantId: 'company-b', contact: 'Cliente proibido' })],
    channels: [{ ...channel, name: attack }, { ...channel, id: 'x', tenantId: 'company-b', name: 'Canal proibido' }],
    assignees: [{ id: 'p', name: attack, avatar: 'https://unexpected.example/photo.png', presence: 'available' }, { id: 'q', tenantId: 'company-b', name: 'Pessoa proibida' }]
  }));
  assert.ok(!html.includes('<img src=x')); assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  for (const secret of ['Cliente proibido', 'Canal proibido', 'Pessoa proibida', 'unexpected.example']) assert.ok(!html.includes(secret), secret);
  assert.deepEqual(ids(html), ['own']); assert.equal(count(html, 'queue'), '1');
});

test('período de teste servido pelo servidor continua visível ao admin, sem documento bruto', () => {
  const onboarding = (more = {}) => ({ publicTrialEnabled: true, documentRegistered: true, fiscalDocument: '111.444.777-35', lifecycle: { state: 'trial', trialExpiresAt: '2026-10-11T10:15:00.000Z', trialExpired: false, daysRemaining: 7, serverTime: '2026-10-04T10:15:00.000Z' }, ...more });
  const html = createOverviewMarkup(props({ accountOnboarding: onboarding() }));
  assert.match(html, /7 dias restantes no período de teste/); assert.match(html, /datetime="2026-10-11T10:15:00.000Z"/); assert.match(html, /CPF\/CNPJ registrado para esta conta/);
  assert.ok(!html.includes('111.444.777-35'));
  assert.match(createOverviewMarkup(props({ accountOnboarding: onboarding({ lifecycle: { ...onboarding().lifecycle, trialExpired: true, daysRemaining: 0 } }) })), /Período de teste encerrado/);
  assert.match(createOverviewMarkup(props({ accountOnboarding: onboarding({ lifecycle: { state: 'trial' } }) })), /O prazo do teste não está disponível nesta atualização/);
  assert.ok(!createOverviewMarkup(props({ session: { ...session, role: 'operator' }, accountOnboarding: onboarding() })).includes('dias restantes'));
});

test('agentes hoje: uso do dia com cota, indisponível honesto e sem bloco quando não há agentes', () => {
  const agents = [{ id: 'ag', name: 'Assistente', configured: true }];
  const html = createOverviewMarkup(props({ agents, usage: { limit: 1000, today: { runs: 41, totalTokens: 360 } } }));
  assert.match(html, /<h2 id="home-agents-title" class="pg-home__panel-title">Agentes hoje<\/h2><a class="ui-btn ui-btn--ghost ui-btn--sm" href="#agents\/usage">/);
  assert.match(html, /Execuções hoje<\/dt><dd>41/); assert.match(html, /Cota diária<\/dt><dd>36%/);
  assert.match(createOverviewMarkup(props({ agents, usage: { limit: null, today: { runs: 2, totalTokens: 10 } } })), /Sem limite/);
  const zero = createOverviewMarkup(props({ agents, usage: { limit: 0, today: { runs: 0, totalTokens: 0, blocked: true } } }));
  assert.match(zero, /Cota diária<\/dt><dd>IA bloqueada \(limite 0\)/); assert.ok(!zero.includes('Sem limite'), 'limite 0 bloqueia, não libera');
  assert.match(zero, /data-home-quota="blocked">Com o limite em 0, nenhuma execução de IA roda nesta empresa\./);
  const full = createOverviewMarkup(props({ agents, usage: { limit: 1000, today: { runs: 9, totalTokens: 1200, blocked: true } } }));
  assert.match(full, /Cota diária<\/dt><dd>100%/); assert.match(full, /Limite diário atingido: novas execuções de IA ficam bloqueadas até a virada do dia\./);
  assert.match(createOverviewMarkup(props({ agents, usage: null })), /Uso indisponível agora\.[\s\S]*data-action="home:retry" data-id="usage"/);
  assert.ok(!createOverviewMarkup(props({ agents: [] })).includes('Agentes hoje'));
  assert.ok(!createOverviewMarkup(props({ agents, session: { ...session, role: 'operator' } })).includes('Agentes hoje'), 'uso é do admin');
});

test('EN, sem empresa, entrada congelada e sem IO no Node', () => {
  const realFetch = globalThis.fetch; let fetched = 0; globalThis.fetch = async () => { fetched++; return {}; };
  try {
    const input = props({ conversations: [conversation('one')] });
    const before = structuredClone(input); Object.freeze(input.conversations); Object.freeze(input.conversations[0]);
    locale('en');
    const en = createOverviewMarkup(input);
    assert.match(en, /<p class="pg-home__eyebrow">Overview<\/p><h1 id="overview-title" class="pg-home__title">Good morning, Jean<\/h1>/);
    assert.match(en, /aria-label="In queue: 1\. Open queue"/); assert.match(en, /Priority now/);
    assert.deepEqual(structuredClone(input), before);
    locale('pt-BR');
    const none = createOverviewMarkup(props({ tenant: null, conversations: [conversation('secret')] }));
    assert.match(none, /Selecione uma empresa para acompanhar a operação\./); assert.deepEqual(ids(none), []);
    assert.equal(fetched, 0);
    assert.equal(overviewModel(props({ supportMode: true })).role, 'support');
    assert.equal(overviewModel(props({ session: { ...session, kind: 'service' } })).role, 'attendant');
  } finally { globalThis.fetch = realFetch; }
});

test('SLA em risco: só conversas ativas com prazo estourado ou a 15 minutos, no relógio do servidor; desligado e sem acesso honestos', () => {
  assert.deepEqual(slaAtRisk(slaReport), { enabled: true, count: 2 });
  assert.deepEqual(slaAtRisk({ ...slaReport, policy: { enabled: false } }), { enabled: false, count: null });
  assert.equal(slaAtRisk({ nope: true }), null);
  const off = createOverviewMarkup(props({ sla: { ...slaReport, policy: { enabled: false } } }));
  assert.equal(kpiHref(off, 'sla'), '#automation'); assert.equal(count(off, 'sla'), '—'); assert.match(off, /SLA desligado/);
  const failed = createOverviewMarkup(props({ sla: null }));
  assert.equal(count(failed, 'sla'), '—'); assert.match(failed, /data-home-kpi="sla"[\s\S]*?Indisponível agora/);
  const denied = createOverviewMarkup(props({ access: { ...access, metricsRead: false }, sla: slaReport }));
  assert.match(denied, /<div class="pg-home__kpi" data-home-kpi="sla" data-home-section="sla"[\s\S]*?Sem acesso/, 'sem metrics.read não há link nem número');
});

test('equipe agora: a 1ª resposta diz o período de Indicadores', () => {
  const metrics = { firstReply: { averageSeconds: 112, samples: 27 }, period: { from: '2026-09-06T03:00:00.000Z', to: '2026-10-06T03:00:00.000Z' }, totals: { transfers: 0 } };
  assert.match(createOverviewMarkup(props({ metrics })), /<span>1ª resposta média \(30 dias\)<\/span><strong class="pg-home__metric-value">01:52<\/strong>/);
  assert.match(createOverviewMarkup(props({ metrics: { ...metrics, period: { from: '2026-10-05T03:00:00.000Z', to: '2026-10-06T03:00:00.000Z' } } })), /1ª resposta média \(1 dia\)/);
});

test('"vou atender sozinho" e "Dispensar" na Visão geral redesenham o bloco no lugar e guardam só a preferência', async () => {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  const saved = { document: globalThis.document, localStorage: globalThis.localStorage };
  const replaced = [];
  const section = { replaceWith: fresh => replaced.push(fresh.html), remove: () => replaced.push(null), focus() {} };
  globalThis.document = {
    querySelector: selector => selector === '.pg-home[data-home-overview]' ? { querySelector: inner => inner === '[data-home-section="setup"]' ? section : null } : null,
    createElement: () => {
      const template = { content: { querySelector: selector => {
        const name = /data-home-section="([a-z]+)"/.exec(selector)?.[1], html = template.html || '';
        const start = html.indexOf(`data-home-section="${name}"`);
        return start < 0 ? null : { html: html.slice(html.lastIndexOf('<', start), html.indexOf('</section>', start) + 10 || undefined) };
      } } };
      Object.defineProperty(template, 'innerHTML', { set(value) { template.html = value; } });
      return template;
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    const input = { ...props({ channels: [{ ...channel, state: 'disconnected' }], assignees: [{ id: session.userId, name: 'Jean' }] }), setupPrefs: undefined, noMount: false };
    const html = createOverviewMarkup(input);
    assert.match(html, /data-action="home:solo" data-id="on"/);
    await Promise.resolve();
    await dispatchAction('home:solo', null, null, 'on');
    assert.equal(readSetupPrefs(session.userId, tenant.id, storage).solo, true);
    assert.equal(replaced.length, 1); assert.match(replaced[0], /pg-home__check" data-state="done"><span class="pg-home__check-mark" aria-hidden="true">[\s\S]*?Equipe/, 'a etapa Equipe aparece concluída sem trocar de rota');
    assert.ok(!replaced[0].includes('home:solo'));
    await dispatchAction('home:dismiss');
    assert.equal(readSetupPrefs(session.userId, tenant.id, storage).dismissed, true);
    assert.match(replaced[1], /data-state="dismissed"[\s\S]*href="#setup"/, 'o bloco vira o link para o guia');
    assert.deepEqual([...store.keys()], [`elozi:setup:${session.userId}`]);
  } finally {
    globalThis.document = saved.document;
    Object.defineProperty(globalThis, 'localStorage', { value: saved.localStorage, configurable: true, writable: true });
  }
});
