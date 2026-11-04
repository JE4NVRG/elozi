import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createOperationReadinessModel, operationChannelState, deriveSetup, brandCustomized, portfolioModel } from '../public/operation-readiness.js';
import { createOverviewMarkup } from '../public/overview-ui.js';
import { setLocale } from '../public/i18n.js';
import { operationReadinessTranslations } from '../public/locales-operation-readiness.js';

const tenant = { id: 'tenant-a', name: 'Empresa selecionada' };
const session = { role: 'reseller', userId: 'human-a' };
const access = { inboxRead: true, contactsRead: true, contactsWrite: true, manageCompany: true, manageChannels: true, manageTeam: true, manageAgents: true, manageServices: true, metricsRead: true };
const channel = { id: 'wa-a', tenantId: tenant.id, state: 'connected', kind: 'whatsapp_qr', transport: 'baileys', name: 'Conectado' };
const conversation = (id, more = {}) => ({ id, tenantId: tenant.id, channelId: channel.id, status: 'open', owner: 'queue', ...more });
const props = more => ({ tenant, workspaceId: 'workspace-a', session, access, conversations: [], channels: [channel], contacts: [], assignees: [], agents: [], runs: [], servicePrincipals: [], accountKind: 'business', brand: null, setupPrefs: {}, noMount: true, ...more });
const agent = (id = 'agent-a', more = {}) => ({ id, tenantId: tenant.id, name: 'Configuração salva', provider: 'hermes', mode: 'copilot', configured: true, version: 2, ...more });
const identity = (id = 'identity-a', more = {}) => ({ id, tenantId: tenant.id, workspaceId: 'workspace-a', agentId: 'agent-a', active: true, state: 'active', usage: { requests: 2 }, ...more });
const count = (html, key) => html.match(new RegExp(`data-overview-count="${key}"[^>]*>([^<]+)</strong>`))?.[1];
const locale = value => setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));

test('responsabilidades formam partição da seleção ativa e não contam duplicados ou escopos alheios', () => {
  const model = createOperationReadinessModel(props({ conversations: [
    conversation('queue', { unread: 4 }), conversation('queue'), conversation('human', { assignedUserId: session.userId, owner: 'human' }),
    conversation('agent', { owner: 'agent' }), conversation('mixed', { owner: 'agent', assignedUserId: 'human-b', unread: 2 }),
    conversation('closed', { status: 'closed', unread: 7 }), conversation('foreign', { tenantId: 'tenant-b' }),
    conversation('wrong-workspace', { workspaceId: 'workspace-b' }),
  ] }));
  assert.deepEqual(model.operation, { active: 4, queue: 1, mine: 1, unread: 2, humans: 2, agents: 1, approvals: 0, myApprovals: 0, agentUnanswered: 0 });
  assert.equal(model.operation.queue + model.operation.humans + model.operation.agents, model.operation.active);
  assert.equal(model.nextAction.reason, 'queue');
});

test('erro e loading descartam caches recebidos; lista vazia carregada é distinta da leitura parcial', () => {
  for (const state of ['loading', 'error', 'unavailable', 'invalid']) {
    const model = createOperationReadinessModel(props({ conversations: [conversation('stale')], channels: [channel], loadState: { conversations: state, channels: state } }));
    assert.equal(model.operation.active, null, state); assert.equal(model.connections.connected, null, state);
    assert.equal(model.nextAction.reason, 'load-inbox');
  }
  const loaded = createOperationReadinessModel(props({ channels: [] }));
  assert.equal(loaded.operation.active, 0); assert.equal(loaded.nextAction.reason, 'connect-channel');
  const partial = createOperationReadinessModel(props({ channels: [], loadState: { conversations: 'partial', channels: 'partial', contacts: 'partial' } }));
  assert.equal(partial.operation.active, 0); assert.equal(partial.data.conversations.state, 'partial');
  assert.equal(partial.nextAction.reason, 'inbox'); assert.ok(!partial.nextAction.title.includes('primeiro'));
  assert.equal(createOperationReadinessModel(props({ channels: null, loadState: { channels: 'loaded' } })).connections.registered, null);
});

test('disabled prevalece sobre connected; configuração e estados não confirmados nunca viram conexão', () => {
  const channels = [channel, { ...channel, id: 'disabled', enabled: false }, { ...channel, id: 'disabled-state', state: 'disabled' },
    { ...channel, id: 'configured', state: 'configured' }, { ...channel, id: 'failed', state: 'failed' },
    { ...channel, id: 'qr', state: 'qr' }, { ...channel, id: 'unknown', state: 'future' }, { ...channel, id: 'demo', state: 'sandbox' }];
  const model = createOperationReadinessModel(props({ channels }));
  assert.deepEqual(model.connections, { registered: 8, connected: 1, configured: 1, disabled: 2, problem: 1, pending: 1, unknown: 2 });
  assert.equal(operationChannelState(channels[1]), 'disabled'); assert.equal(model.nextAction.reason, 'connection-problem');
  const html = createOverviewMarkup(props({ channels }));
  assert.equal(count(html, 'channels'), '1', 'só o canal com falha conta como problema'); assert.ok(html.includes('1 de 8 ativos'), 'configurado e demonstração não contam como conectados');
  assert.equal(model.receiving, 1, 'configurado sem conversa ainda não provou recebimento');
  const received = createOperationReadinessModel(props({ channels, conversations: [{ id: 'mail-1', tenantId: tenant.id, channelId: 'configured', status: 'open' }] }));
  assert.equal(received.receiving, 2, 'configurado (e-mail) com conversa recebida conta como ativo'); assert.equal(received.connections.connected, 1, 'mas não vira conexão');
  assert.equal(deriveSetup(received).steps.find(step => step.id === 'channel').state, 'done', 'o primeiro uso conclui o canal de e-mail que já recebe');
  assert.equal(deriveSetup(createOperationReadinessModel(props({ channels: [{ ...channel, state: 'configured' }] }))).steps.find(step => step.id === 'channel').state, 'todo');
});

test('a ação de recuperação acompanha configured, QR e disabled sem ativar ou cadastrar nada', () => {
  for (const [state, reason] of [['configured', 'validate-channel'], ['qr', 'finish-channel'], ['disabled', 'disabled-channel'], ['logged_out', 'connection-problem']]) {
    const model = createOperationReadinessModel(props({ channels: [{ ...channel, state }] }));
    assert.equal(model.nextAction.reason, reason); assert.equal(model.nextAction.view, 'channels');
  }
});

test('gestão exige role e capability explícita; operador e suporte não ganham CTAs por booleans incoerentes', () => {
  for (const more of [{ session: { ...session, role: 'operator' } }, { supportMode: true }, { session: { ...session, supportGrantId: 'support-a' } }, { session: { ...session, kind: 'service' } }]) {
    const fixture = props({ ...more, agents: [agent()], servicePrincipals: [identity()] });
    const model = createOperationReadinessModel(fixture), html = createOverviewMarkup(fixture);
    assert.equal(model.manager, false); assert.equal(model.permissions.manageServices, false);
    assert.equal(model.data.servicePrincipals.state, 'denied');
    for (const view of ['team', 'tenants', 'service-agents']) assert.ok(!html.includes(`data-view="${view}"`));
    assert.ok(!html.includes('Identidade ativa autorizada')); assert.ok(!html.includes('data-home-section="setup"'));
  }
  const limited = createOperationReadinessModel(props({ access: { inboxRead: true } }));
  assert.equal(limited.manager, true); assert.deepEqual(limited.setup.map(step => step.id), ['company', 'test']);
  assert.equal(limited.setup[0].view, null);
});

test('primeiro uso aparece sem oferta de trial e não inventa documento, prazo ou percentual', () => {
  const fixture = props({ accountOnboarding: null, agents: [agent()], assignees: [{ id: 'human-a', presence: 'available' }] });
  const model = createOperationReadinessModel(fixture), html = createOverviewMarkup(fixture);
  assert.deepEqual(model.setup.map(step => step.id), ['company', 'channel', 'team', 'agent', 'test']);
  assert.equal(model.setup.find(step => step.id === 'agent').optional, true);
  assert.equal(model.setup.find(step => step.id === 'agent').view, 'inbox');
  const setup = deriveSetup(model, { accountKind: 'business' });
  assert.deepEqual(setup.steps.map(step => [step.id, step.state]), [['company', 'done'], ['channel', 'done'], ['team', 'todo'], ['agent', 'done'], ['test', 'todo']]);
  assert.match(html, /<strong class="pg-home__strip-count">2\/4<\/strong>/);
  for (const absent of ['CPF/CNPJ', 'pg-home__trial', 'dias restantes', '100%', 'AGENT READY']) assert.ok(!html.includes(absent));
  const recorded = createOverviewMarkup({ ...fixture, conversations: [conversation('tested', { messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'sent' }] })] });
  assert.match(recorded, /<strong class="pg-home__strip-count">3\/4<\/strong>/, 'entrada e resposta concluem o registro do atendimento manual');
  assert.equal(deriveSetup(createOperationReadinessModel({ ...fixture, assignees: [{ id: 'a' }] }), { prefs: { solo: true } }).steps.find(step => step.id === 'team').state, 'done', 'vou atender sozinho conclui a equipe');
});

test('entrada e resposta só registram a troca na mesma origem habilitada, sem prometer entrega no aparelho', () => {
  const messages = [{ kind: 'customer', text: 'Privado' }, { kind: 'human', delivery: 'sent', text: 'Resposta privada' }];
  const fixture = props({ conversations: [conversation('exchange', { messages })], loadState: { conversations: 'partial' } });
  assert.equal(createOperationReadinessModel(fixture).exchangeRecorded, true);
  const html = createOverviewMarkup(fixture);
  assert.equal(deriveSetup(createOperationReadinessModel(fixture)).steps.find(step => step.id === 'test').state, 'done');
  assert.ok(!html.includes('Privado')); assert.ok(!html.includes('Resposta privada'));
  for (const more of [{ channels: [{ ...channel, enabled: false }] }, { conversations: [conversation('different', { channelId: 'different', messages })] }, { conversations: [conversation('not-sent', { messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'pending' }] })] }]) assert.equal(createOperationReadinessModel(props(more)).exchangeRecorded, false);
});

test('atendimento manual conclui sem agente; configuração de agente não conclui o atendimento', () => {
  const exchange = conversation('manual', { messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'sent' }] });
  const manual = deriveSetup(createOperationReadinessModel(props({ agents: null, conversations: [exchange] })), { prefs: { solo: true } });
  assert.deepEqual([manual.done, manual.total, manual.complete], [4, 4, true]);
  assert.deepEqual(manual.steps.find(step => step.id === 'agent'), { id: 'agent', group: 'company', state: 'unknown', optional: true });
  const configured = deriveSetup(createOperationReadinessModel(props({ agents: [agent()] })), { prefs: { solo: true } });
  assert.deepEqual([configured.done, configured.total, configured.complete], [3, 4, false]);
  assert.equal(configured.steps.find(step => step.id === 'test').state, 'todo');
});

test('etapa manual só observa ausência no retrato completo; fonte ausente, parcial ou sem mensagens é desconhecida', () => {
  const state = more => deriveSetup(createOperationReadinessModel(props(more))).steps.find(step => step.id === 'test').state;
  for (const more of [
    { conversations: null },
    { channels: null },
    { conversations: [], loadState: { conversations: 'partial' } },
    { channels: [channel], loadState: { channels: 'partial' } },
    { conversations: [conversation('summary', { messageCount: 3, lastMessage: { kind: 'human' } })] },
    { conversations: [conversation('partial-incoming', { messages: [{ kind: 'customer' }] })], loadState: { conversations: 'partial' } }
  ]) assert.equal(state(more), 'unknown');
  assert.equal(state({ conversations: [] }), 'todo', 'leitura completa sem mensagens observa a ausência');
  assert.equal(state({ conversations: [conversation('no-reply', { messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'pending' }] })] }), 'todo');
  assert.equal(state({ conversations: [conversation('sent', { messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'sent' }] })], loadState: { conversations: 'partial', channels: 'partial' } }), 'done', 'o registro positivo não depende da completude da leitura');
});

test('conferência por canal usa somente entradas e recibos da mesma conversa autorizada; parcial não vira ausência', () => {
  const extra = { ...channel, id: 'wa-b', name: 'Outro número', state: 'configured' };
  const fixture = props({ channels: [channel, extra, { ...channel, id: 'foreign', tenantId: 'tenant-b', name: 'Segredo alheio' }],
    conversations: [conversation('manual', { messages: [{ kind: 'customer', text: 'Texto privado' }, { kind: 'human', delivery: 'sent' }] }),
      conversation('foreign-entry', { tenantId: 'tenant-b', channelId: extra.id, messages: [{ kind: 'customer' }, { kind: 'human', delivery: 'delivered' }] })],
    loadState: { conversations: 'partial' } });
  const model = createOperationReadinessModel(fixture);
  assert.deepEqual(model.channelChecks, [
    { id: channel.id, name: channel.name, connection: 'connected', incomingRecorded: true, responseRecorded: true, deliveryValidated: null },
    { id: extra.id, name: extra.name, connection: 'configured', incomingRecorded: null, responseRecorded: null, deliveryValidated: null }
  ]);
  assert.equal(model.exchangeRecorded, true);
  assert.ok(!JSON.stringify(model).includes('Texto privado')); assert.ok(!JSON.stringify(model).includes('Segredo alheio'));
  const split = createOperationReadinessModel(props({ conversations: [conversation('in', { messages: [{ kind: 'customer' }] }), conversation('out', { messages: [{ kind: 'human', delivery: 'sent' }] })] }));
  assert.equal(split.channelChecks[0].incomingRecorded, true); assert.equal(split.channelChecks[0].responseRecorded, false); assert.equal(split.exchangeRecorded, false);
  const summary = createOperationReadinessModel(props({ conversations: [conversation('summary', { messageCount: 50, lastMessage: { kind: 'human' } })] }));
  assert.equal(summary.channelChecks[0].incomingRecorded, null); assert.equal(summary.channelChecks[0].responseRecorded, null);
  const denied = createOperationReadinessModel({ ...fixture, access: { ...access, inboxRead: false } });
  assert.equal(denied.channelChecks[0].incomingRecorded, null); assert.equal(denied.channelChecks[0].responseRecorded, null); assert.equal(denied.exchangeRecorded, false);
  const failed = createOperationReadinessModel({ ...fixture, loadState: { conversations: 'error' } });
  assert.equal(failed.channelChecks[0].incomingRecorded, null); assert.equal(failed.exchangeRecorded, false);
  const disabled = createOperationReadinessModel({ ...fixture, channels: [{ ...channel, enabled: false }] });
  assert.equal(disabled.channelChecks[0].responseRecorded, true, 'o registro histórico permanece visível'); assert.equal(disabled.exchangeRecorded, false, 'o histórico não habilita a origem');
});

test('identidade e uso não comprovam conexão de cliente ou inferência; secrets não entram no modelo nem markup', () => {
  const fixture = props({ agents: [agent('agent-a', { endpoint: 'https://private.example', token: 'private-token', serviceCheckedAt: '2026-10-05T13:00:00Z' })],
    servicePrincipals: [identity('identity-a', { secret: 'private-key' })],
    conversations: [conversation('one')], runs: [{ id: 'run-a', tenantId: tenant.id, conversationId: 'one', agentId: 'agent-a', agentVersion: 2, provider: 'hermes', providerCalled: true, state: 'draft', draft: 'private-draft', rawProvider: 'private-provider' }],
  });
  const model = createOperationReadinessModel(fixture), signal = model.agentSignals[0], html = createOverviewMarkup(fixture);
  assert.equal(signal.configured, true); assert.equal(signal.serviceVerified, true); assert.equal(signal.authorizedIdentity, 'recorded');
  assert.equal(signal.authorizedRequestsObserved, true); assert.equal(signal.internalDraftRecorded, true);
  assert.equal(signal.clientConnected, null); assert.equal(signal.inferenceValidated, null);
  for (const value of ['private.example', 'private-token', 'private-key', 'private-draft', 'private-provider']) { assert.ok(!JSON.stringify(model).includes(value)); assert.ok(!html.includes(value)); }
});

test('recibos externos e internos permanecem distintos; versões e conversas fora do acesso não validam sinal', () => {
  const external = agent('mcp-a', { provider: 'mcp' });
  const runs = [{ id: 'old-version', conversationId: 'one', agentId: 'agent-a', agentVersion: 1, provider: 'hermes', providerCalled: true, state: 'draft' },
    { id: 'outside', conversationId: 'inaccessible', agentId: 'agent-a', agentVersion: 2, provider: 'hermes', providerCalled: true, state: 'draft' },
    { id: 'external', conversationId: 'one', agentId: 'mcp-a', agentVersion: 2, provider: 'mcp', externalDraft: true, state: 'draft' }];
  const model = createOperationReadinessModel(props({ conversations: [conversation('one')], agents: [agent(), external], runs }));
  assert.equal(model.agentSignals[0].internalDraftRecorded, false);
  assert.equal(model.agentSignals[1].externalDraftRecorded, true); assert.equal(model.agentSignals[1].internalDraftRecorded, false);
  assert.equal(model.agentSignals[1].inferenceValidated, null);
});

test('um rascunho externo histórico compatível não depende do flag de runtime interno configurado', () => {
  const external = agent('mcp-a', { provider: 'mcp', configured: undefined });
  const run = { id: 'external', conversationId: 'one', agentId: 'mcp-a', agentVersion: 2, provider: 'mcp', externalDraft: true, state: 'draft' };
  const fixture = props({ conversations: [conversation('one')], agents: [external], runs: [run] });
  const model = createOperationReadinessModel(fixture), html = createOverviewMarkup(fixture);
  assert.equal(model.agentSignals[0].configured, false); assert.equal(model.agentSignals[0].externalDraftRecorded, true);
  assert.equal(model.agentSignals[0].clientConnected, null); assert.equal(model.agentSignals[0].inferenceValidated, null);
  for (const changed of [{ ...run, agentVersion: 1 }, { ...run, provider: 'hermes' }, { ...run, state: 'running' }]) assert.equal(createOperationReadinessModel({ ...fixture, runs: [changed] }).agentSignals[0].externalDraftRecorded, false);
});

test('identidades revogadas, expiradas, pausadas e de outra empresa não autorizam o agente', () => {
  const principals = ['revoked', 'expired', 'paused'].map(state => identity(state, { state }));
  principals.push(identity('foreign', { tenantId: 'tenant-b' }), identity('workspace', { workspaceId: 'workspace-b' }), identity('inactive', { active: false }));
  const loaded = createOperationReadinessModel(props({ agents: [agent()], servicePrincipals: principals }));
  assert.equal(loaded.agentSignals[0].authorizedIdentity, 'absent'); assert.equal(loaded.agentSignals[0].authorizedRequestsObserved, false);
  const partial = createOperationReadinessModel(props({ agents: [agent()], servicePrincipals: principals, loadState: { servicePrincipals: 'partial', runs: 'error' } }));
  assert.equal(partial.agentSignals[0].authorizedIdentity, 'unknown'); assert.equal(partial.agentSignals[0].authorizedRequestsObserved, null);
  assert.equal(partial.agentSignals[0].internalDraftRecorded, null);
});

test('transferências exigem permissão, agregados e período válido, sem contar unread como pedido de transferência', () => {
  const metrics = { period: { from: '2026-10-01T10:00:00Z', to: '2026-10-05T10:00:00Z' }, totals: { transfers: 3 } };
  const fixture = props({ metrics, conversations: [conversation('one', { unread: 100 })] });
  const model = createOperationReadinessModel(fixture);
  assert.equal(model.transfers.count, 3); assert.deepEqual(model.transfers.period, metrics.period);
  for (const invalid of [{ ...metrics, period: null }, { ...metrics, tenantId: 'tenant-b' }, { ...metrics, totals: { transfers: -1 } }, { ...metrics, totals: { transfers: '3' } }]) assert.equal(createOperationReadinessModel(props({ metrics: invalid })).transfers.count, null);
  const denied = createOperationReadinessModel(props({ metrics, access: { inboxRead: true } })); assert.equal(denied.transfers.count, null); assert.equal(denied.transfers.state, 'denied');
});

test('partial vazio e erro são visíveis; nenhuma linha do cache falhado ou ausência total é inferida', () => {
  const partial = createOverviewMarkup(props({ channels: [], loadState: { conversations: 'partial', contacts: 'partial', channels: 'partial', assignees: 'partial' } }));
  assert.ok(partial.includes('de 0 carregadas'), 'leitura parcial vira o rótulo discreto de N carregadas');
  const failed = createOverviewMarkup(props({ conversations: [conversation('stale', { contact: 'stale-name' })], loadState: { conversations: 'error' } }));
  assert.equal(count(failed, 'queue'), '—'); assert.ok(failed.includes('Não conseguimos carregar agora.'));
  assert.ok(!failed.includes('stale-name'));
});

test('troca de contexto exclui cache antigo; PT/EN/PT preserva nomes, drafts e fixtures congeladas sem IO', () => {
  const fixture = props({ agents: [agent()], conversations: [conversation('one', { contact: 'Conectado', messages: [{ kind: 'customer', text: 'Guardar rascunho' }] })], servicePrincipals: [identity()] });
  const before = structuredClone(fixture);
  const freeze = value => { if (!value || typeof value !== 'object') return; Object.values(value).forEach(freeze); Object.freeze(value); };
  freeze(fixture); locale('pt-BR'); const pt = createOverviewMarkup(fixture); locale('en'); const en = createOverviewMarkup(fixture); locale('pt-BR');
  assert.equal(createOverviewMarkup(fixture), pt); assert.deepEqual(fixture, before);
  assert.ok(en.includes('>Overview</p>')); assert.ok(en.includes('Priority now')); assert.ok(en.includes('<strong data-pii>Conectado</strong>'));
  assert.ok(!en.includes('Prioridade agora')); assert.ok(!en.includes('Guardar rascunho'));
  const changed = createOverviewMarkup({ ...fixture, tenant: { id: 'tenant-b', name: 'Other company' } });
  assert.ok(!changed.includes('data-overview-conversation="one"'));
  assert.equal(createOperationReadinessModel(props({ tenant: null })).nextAction, null);
});

test('projeção não possui fetch, writes ou global clock; catálogo usa apenas slots presentes e CSS oferece alvos mobile', async () => {
  const source = await readFile(new URL('../public/operation-readiness.js', import.meta.url), 'utf8');
  assert.ok(!/\b(?:fetch|localStorage|setInterval|setTimeout)\s*\(|Date\.now\s*\(/.test(source));
  for (const [pt, en] of Object.entries(operationReadinessTranslations)) {
    const slots = new Set([...pt.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
    for (const match of en.matchAll(/\{(\w+)\}/g)) assert.ok(slots.has(match[1]), pt);
  }
  // overview.css was emptied by P7 and removed in P10; Visão geral lives in screen-home.css (tokens, 44 px targets, 4 breakpoints).
  assert.equal(existsSync(new URL('../public/overview.css', import.meta.url)), false);
  const css = await readFile(new URL('../public/screen-home.css', import.meta.url), 'utf8');
  assert.match(css, /\.pg-home__row \{[^}]*min-height: var\(--target-touch\)/); assert.match(css, /\.pg-home__setup-step \{[^}]*min-height: var\(--target-touch\)/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.pg-home__grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /font-variant-numeric: tabular-nums/); assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|!important/i);
});

test('primeiro uso da revenda e carteira: marca, cliente e motivos derivados do DTO, sem relógio próprio', () => {
  assert.equal(brandCustomized({ name: 'Elozi', accent: '#3157d5' }), false); assert.equal(brandCustomized({ name: 'Loja', accent: '#3157D5' }), true);
  assert.equal(brandCustomized({ name: 'Elozi', accent: '#3157d5', logo: 'data:image/png;base64,AA==' }), true); assert.equal(brandCustomized(null), false);
  const model = createOperationReadinessModel(props());
  const unknown = deriveSetup(model, { accountKind: 'reseller', brand: { name: 'Elozi', accent: '#3157d5' }, portfolio: null });
  assert.deepEqual(unknown.steps.filter(step => step.group === 'reseller').map(step => [step.id, step.state, step.optional]), [['brand', 'todo', false], ['domain', 'info', true], ['client', 'unknown', false], ['plan', 'info', true], ['help', 'info', true]]);
  assert.equal(unknown.kind, 'reseller'); assert.equal(unknown.total, 6);
  const now = Date.parse('2026-10-06T12:00:00Z'), old = '2026-09-20T12:00:00Z';
  const result = { accounts: [{ id: 'workspace-a', accountKind: 'reseller' }, { id: 'c-1', name: 'Cliente', accountKind: 'business', parentWorkspaceId: 'workspace-a', createdAt: old, onboarding: { companyCreated: true, administratorActive: false, channelConnected: false, teamReady: false, contractConfigured: false }, counts: { channels: 0, connectedChannels: 0, activeAgents: 0 } }] };
  const portfolio = portfolioModel(result, 'workspace-a', { now });
  assert.deepEqual(portfolio.clients[0].reasons, ['admin-inactive', 'no-channel']); assert.equal(portfolio.clients[0].done, 1);
  assert.deepEqual(portfolioModel(result, 'workspace-a').clients[0].reasons, ['admin-inactive'], 'sem relógio informado não infere 7 dias');
  assert.deepEqual([portfolio.loaded, portfolio.total, portfolio.partial], [2, 2, false]);
  assert.equal(portfolioModel({ ...result, total: 140 }, 'workspace-a', { now }).partial, true, 'total maior que a página: leitura parcial');
  assert.equal(portfolioModel({ ...result, hasMore: true }, 'workspace-a', { now }).partial, true);
  const counted = counts => portfolioModel({ accounts: [{ ...result.accounts[1], onboarding: { administratorActive: true }, counts }] }, 'workspace-a', { now }).clients[0].reasons;
  assert.deepEqual(counted({ channels: 1, connectedChannels: 0 }), ['no-connection'], 'canais cadastrados e nenhum conectado');
  assert.deepEqual(counted({ channels: 2, connectedChannels: 1 }), [], 'um conectado entre outros: o DTO não separa e-mail configurado de número caído');
  assert.equal(deriveSetup(model, { accountKind: 'reseller', portfolio: portfolio.clients }).steps.find(step => step.id === 'client').state, 'done');
  assert.equal(deriveSetup(createOperationReadinessModel(props({ session: { ...session, role: 'operator' } }))).kind, 'attendant');
  assert.equal(deriveSetup(createOperationReadinessModel(props({ tenant: null }))).kind, null);
});
