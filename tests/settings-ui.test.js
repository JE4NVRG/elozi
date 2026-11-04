// P8 (FRONTEND-V2 §8.9): hubs with tabs in the hash, contrast report from brand-theme.js, Saúde e
// versão only for the platform owner, no customer-facing "Elozi" outside the platform workspace and
// the legacy aliases still opening the same screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setLocale } from '../public/i18n.js';
import { parseHash } from '../public/router.js';
import * as nav from '../public/nav-config.js';
import { deriveBrandTokens, contrast, SURFACES } from '../public/brand-theme.js';
import { activeTab, hubModel, screenFrame, tabCrumb, brandContrast, brandReport, brandPreviews, healthModel, activityDays, slaModel, createSettings } from '../public/settings-ui.js';
import { createGuideMarkup } from '../public/guide-ui.js';
import { settingsTranslations } from '../public/locales-settings.js';
import { managementTranslations } from '../public/locales-management.js';
import { platformUsersTranslations } from '../public/locales-platform-users.js';

const OWNER = { userId: 'owner-qa', role: 'reseller', platformOwner: true, permissions: null };
const ADMIN = { userId: 'admin-qa', role: 'reseller', platformOwner: false, permissions: null };
const OPERATOR = { userId: 'operator-qa', role: 'operator', permissions: ['inbox.read', 'metrics.read'] };
const ctxOf = (session, { supportGrantId = null, hasTenant = true, accountKind = 'reseller' } = {}) => nav.navContext({ session, supportGrantId, hasTenant, accountKind });
const route = hash => parseHash(hash);
const ids = model => model.items.map(item => item.id);
const inLocale = (context, locale) => { setLocale(locale, { persist: false, notify: false }); context.after(() => setLocale('pt-BR', { persist: false, notify: false })); };
const stateOf = (session, extra = {}) => ({ view: 'brand', workspaceId: 'workspace-qa', supportGrantId: null, boot: { session, reseller: { name: 'Acme Revenda', accountKind: session.platformOwner ? 'platform' : 'reseller', brand: { name: 'Acme', accent: '#e11d48' } } }, tenant: { id: 'tenant-qa', name: 'Loja Centro', brand: { name: 'Loja Centro', accent: '#3157d5' }, audit: [] }, ...extra });
const health = (extra = {}) => ({ level: 'degraded', version: '0.48.0', mode: 'hosted-pilot', checks: { whatsapp: { expected: 2, connected: 1 }, telegram: { expected: 0, connected: 0 }, storage: { state: 'online', pending: 3, syncedAt: '2026-10-06T12:00:00Z', local: 'ok' }, scheduler: { state: 'running', lastTickAt: '2026-10-06T12:01:00Z' } }, ...extra });

test('hubs: cada aba tem hash próprio, a aba aberta fica marcada e as abas extras respeitam o público', () => {
  const settings = hubModel('team', ctxOf(ADMIN), route('#settings/team'));
  assert.equal(settings.active, 'team');
  assert.deepEqual(ids(settings), ['companies', 'team', 'brand', 'support', 'billing', 'activity']);
  assert.deepEqual(settings.items.map(item => item.href), ['#settings/companies', '#settings/team', '#settings/brand', '#settings/support', '#settings/billing', '#settings/activity']);
  assert.deepEqual(ids(hubModel('team', ctxOf(OPERATOR), route('#settings/team'))), ['team', 'support'], 'atendente: sem Empresas, Marca, Financeiro nem Registro de atividades');

  assert.equal(activeTab('tenants', route('#settings/activity')), 'activity');
  assert.equal(activeTab('tenants', route('#settings/companies')), 'companies');
  const frame = screenFrame('tenants', ctxOf(ADMIN), '<p>conteúdo</p>', route('#settings/activity'));
  assert.match(frame, /^<div class="ui-hub" data-hub="settings"><div class="ui-tabs" role="tablist"/);
  assert.match(frame, /aria-selected="true" aria-controls="hub-settings-panel-activity" tabindex="0" data-tab="activity" href="#settings\/activity" aria-current="page">Registro de atividades<\/a>/);
  assert.equal((frame.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(frame, /<div class="ui-tabpanel" role="tabpanel" id="hub-settings-panel-activity" aria-labelledby="hub-settings-tab-activity"><p>conteúdo<\/p><\/div>/);
  assert.equal(tabCrumb('tenants', ctxOf(ADMIN), route('#settings/activity')), 'Registro de atividades');

  const owner = ctxOf(OWNER, { accountKind: 'platform' });
  const platform = hubModel('platform', owner, route('#platform/overview'));
  assert.equal(platform.active, 'overview');
  assert.deepEqual(platform.items.map(item => item.href), ['#platform/overview', '#platform/accounts', '#platform/products', '#platform/users', '#platform/billing', '#platform/integrations', '#platform/health']);
  assert.equal(activeTab('platform', route('#platform')), 'accounts', 'Plataforma sem aba abre Contas');
  assert.ok(!ids(hubModel('platform', ctxOf(OWNER, { accountKind: 'platform', supportGrantId: 'grant-qa' }), route('#platform/accounts'))).includes('overview'), 'Visão não aparece em suporte temporário');

  const clients = hubModel('accounts', ctxOf(ADMIN), route('#accounts/plans'));
  assert.equal(clients.active, 'plans');
  assert.deepEqual(clients.items.map(item => item.href), ['#accounts', '#accounts/plans', '#accounts/billing']);
  assert.equal(activeTab('accounts', route('#accounts/acc-1')), 'accounts', '#accounts/<id> abre o detalhe sobre Contas');
  assert.deepEqual(ids(hubModel('accounts', ctxOf(ADMIN, { accountKind: 'business' }), route('#accounts'))), ['accounts'], 'conta direta: sem Planos nem Financeiro de clientes');
  assert.deepEqual(ids(hubModel('accounts', owner, route('#accounts'))), ['accounts', 'plans'], 'plataforma: Planos sem Financeiro de revenda');

  assert.deepEqual(hubModel('metrics', ctxOf(OPERATOR), route('#metrics/sla')).items.map(item => item.href), ['#metrics', '#metrics/sla', '#metrics/agents']);
  assert.deepEqual(ids(hubModel('metrics', ctxOf({ ...OPERATOR, permissions: ['metrics.read'] }), route('#metrics'))), ['attendance', 'agents'], 'sem inbox.read não há SLA');
  assert.equal(hubModel('inbox', ctxOf(ADMIN), route('#inbox')), null, 'outras telas seguem o hubFrame de nav-config');
});

test('aliases legados abrem as mesmas telas e as rotas novas das abas são canônicas', () => {
  for (const [hash, view] of [['#tenants', 'tenants'], ['#team', 'team'], ['#brand', 'brand'], ['#support', 'support'], ['#billing', 'billing'], ['#platform-users', 'platform-users'], ['#platform-billing', 'platform-billing'], ['#integrations', 'integrations'], ['#architecture', 'architecture'], ['#guide', 'guide']]) {
    const parsed = parseHash(hash);
    assert.equal(parsed.alias, hash.slice(1), hash);
    assert.equal(nav.viewForRoute(parsed), view, hash);
  }
  for (const [hash, view, tab] of [['#settings/activity', 'tenants', 'activity'], ['#platform/overview', 'platform', 'overview'], ['#platform/health', 'architecture', 'health'], ['#accounts/plans', 'accounts', 'plans'], ['#accounts/billing', 'accounts', 'billing'], ['#metrics/sla', 'metrics', 'sla'], ['#metrics/agents', 'metrics', 'agents']]) {
    const parsed = parseHash(hash);
    assert.equal(parsed.alias, null, hash);
    assert.equal(nav.viewForRoute(parsed), view, hash);
    assert.equal(activeTab(view, parsed), tab, hash);
  }
  assert.equal(nav.hashForView('guide'), '#help');
  assert.deepEqual({ ...parseHash('#help/api').params }, { topic: 'api' });
  assert.equal(nav.viewForRoute(parseHash('#help/api')), 'guide');
});

test('Marca: prévias clara e escura lado a lado, pintadas e medidas com brand-theme.js', () => {
  const tokens = deriveBrandTokens('#3157d5'), { tokens: measured, rows } = brandContrast('#3157d5');
  assert.deepEqual(measured, tokens);
  assert.equal(rows.length, 8);
  for (const theme of ['light', 'dark']) {
    const set = tokens[theme], surface = SURFACES[theme].s1, row = kind => rows.find(item => item.theme === theme && item.kind === kind);
    assert.equal(row('button-text').ratio, contrast(set.onAccent, set.accent));
    assert.equal(row('links').ratio, contrast(set.accentText, surface));
    assert.equal(row('focus').ratio, contrast(set.focus, surface));
    assert.equal(row('solid').ratio, contrast(set.accent, surface));
    assert.ok(row('button-text').ratio >= 4.5 && row('links').ratio >= 4.5 && row('focus').ratio >= 3, theme);
  }
  const report = String(brandReport('#3157d5'));
  assert.equal((report.match(/data-contrast="[a-z-]+" data-contrast-theme="(?:light|dark)"/g) || []).length, 8);
  assert.match(report, /<strong class="pg-settings__strong">Tema claro<\/strong>[\s\S]*<strong class="pg-settings__strong">Tema escuro<\/strong>/);
  assert.match(report, /data-contrast="button-text" data-contrast-theme="light"><span>Texto dos botões<\/span><span class="pg-settings__cluster"><span class="pg-settings__num">6,1:1<\/span><span class="ui-badge ui-badge--success">AA ✓<\/span>/);

  const pale = brandContrast('#f5f5f5').rows.find(row => row.theme === 'light' && row.kind === 'solid');
  assert.ok(pale.ratio < 3 && pale.edge && pale.passes, 'cor clara demais: o contorno de brand-theme.js mantém o botão visível');
  assert.match(String(brandReport('#f5f5f5')), /data-contrast="solid" data-contrast-theme="light"><span>Botão sobre o fundo<\/span><span class="pg-settings__cluster"><span class="pg-settings__num">1,0:1<\/span><span class="ui-badge ui-badge--info">Contorno ativado<\/span>/);
  assert.match(String(brandReport('#f5f5f5')), /Os botões ganham um contorno para continuar visíveis no fundo claro/, 'texto do relatório de brand-theme.js');
  assert.match(String(brandReport('nope')), /Cor inválida: usamos a cor padrão até você escolher outra\./);

  const previews = brandPreviews({ name: 'Loja <A>', accent: '#e11d48' }, { entity: 'Loja <A>' }).join('');
  const derived = deriveBrandTokens('#e11d48');
  assert.deepEqual([...previews.matchAll(/data-preview-theme="(light|dark)"/g)].map(match => match[1]), ['light', 'dark']);
  assert.ok(previews.includes(`--pv-bg:${SURFACES.light.bg};--pv-surface:${SURFACES.light.s1};`) && previews.includes(`--pv-accent:${derived.light.accent};`));
  assert.ok(previews.includes(`--pv-bg:${SURFACES.dark.bg};--pv-surface:${SURFACES.dark.s1};`) && previews.includes(`--pv-accent-text:${derived.dark.accentText};`));
  assert.match(previews, /Olá! Aqui é a equipe Loja &lt;A&gt;\./); assert.doesNotMatch(previews, /<A>/);
});

test('Marca e domínio desenha o formulário, as duas prévias e o relatório na mesma tela', () => {
  const state = stateOf(ADMIN);
  const settings = createSettings({ state, brandDraft: () => ({ name: 'Loja Centro', accent: '#3157d5', key: 'k' }) });
  const page = String(settings.view(route('#settings/brand')));
  assert.match(page, /^<div class="pg-settings pg-settings--brand">/);
  assert.match(page, /<form id="brand-form"/);
  assert.match(page, /data-brand-previews[\s\S]*data-preview-theme="light"[\s\S]*data-preview-theme="dark"/);
  assert.match(page, /data-brand-report/);
  assert.match(page, /data-brand-scope="tenant" aria-pressed="true"/);
});

test('Saúde e versão: só o dono da plataforma consulta GET /api/health; os demais recebem aviso sem requisição', async () => {
  for (const [session, extra] of [[ADMIN, {}], [OPERATOR, {}], [OWNER, { supportGrantId: 'grant-qa' }]]) {
    const calls = [], settings = createSettings({ state: stateOf(session, { view: 'architecture', ...extra }), request: async path => { calls.push(path); return health(); } });
    assert.match(String(settings.view(route('#platform/health'))), /Esta área é exclusiva do dono da plataforma\./);
    assert.match(String(settings.view(route('#platform/overview'))), /Esta área é exclusiva do dono da plataforma\./);
    assert.equal(settings.loadHealth({ force: true }), null);
    assert.deepEqual(calls, [], `${session.role}${extra.supportGrantId ? ' em suporte' : ''}: nenhuma consulta de saúde`);
  }
  const calls = [], renders = [], state = stateOf(OWNER, { view: 'architecture' });
  const settings = createSettings({ state, request: async path => { calls.push(path); return health(); }, render: () => renders.push(state.view) });
  assert.match(String(settings.view(route('#platform/health'))), /Consultando a saúde da plataforma…/);
  await settings.loadHealth({ force: true });
  assert.deepEqual(calls, ['/api/health']); assert.deepEqual(renders, ['architecture']);
  const page = String(settings.view(route('#platform/health')));
  assert.match(page, /Operação com atenção/); assert.match(page, /1 de 2 conectados/); assert.match(page, /0\.48\.0/); assert.match(page, /Implantação hospedada/);
  assert.doesNotMatch(page, /Esta área é exclusiva/);

  const broken = createSettings({ state: stateOf(OWNER, { view: 'architecture' }), request: async () => ({ level: 'unknown' }) });
  await broken.loadHealth({ force: true });
  assert.match(String(broken.view(route('#platform/health'))), /A resposta de saúde não veio no formato esperado\./);
  assert.equal(healthModel({ level: 'ok' }), null); assert.equal(healthModel(null), null);
  assert.deepEqual(healthModel(health()).whatsapp, { expected: 2, connected: 1 });
  assert.equal(healthModel(health({ checks: { storage: { local: 'missing' } } })).storage.local, 'unavailable');
});

test('Registro de atividades agrupa o audit por dia e o SLA só lê com metrics.read e inbox.read', async () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const days = activityDays([{ action: 'Canal criado', actor: 'Ana', createdAt: '2026-10-06T14:00:00Z' }, { action: 'Marca alterada', actor: 'Bia', createdAt: '2026-10-05T14:00:00Z' }, { action: 'sem data' }, null], { now });
  assert.deepEqual(days.map(day => day.label), ['Hoje', 'Ontem']); assert.deepEqual(days.map(day => day.events.map(event => event.actor)), [['Ana'], ['Bia']]);
  const state = stateOf(ADMIN, { view: 'tenants' }); state.tenant.audit = [{ action: 'Canal <criado>', actor: 'Ana <QA>', createdAt: new Date().toISOString() }];
  const activity = String(createSettings({ state }).view(route('#settings/activity')));
  assert.match(activity, /Registro de atividades/); assert.match(activity, /Canal &lt;criado&gt;/); assert.match(activity, /Ana &lt;QA&gt;/); assert.doesNotMatch(activity, /<criado>|<QA>/);

  const calls = [], sla = { asOf: '2026-10-06T12:00:00Z', policy: { enabled: true, firstReplyMinutes: 15, resolutionMinutes: 240 }, totals: { tracked: 1, firstReplyPending: 1 }, conversations: [{ conversationId: 'c-1', contact: 'Cliente <1>', firstReply: { state: 'pending', dueAt: '2026-10-06T12:15:00Z' }, resolution: { state: 'pending', dueAt: '2026-10-06T16:00:00Z' } }] };
  const operator = createSettings({ state: stateOf(OPERATOR, { view: 'metrics' }), request: async path => { calls.push(path); return sla; } });
  await operator.loadSla({ force: true });
  assert.deepEqual(calls, ['/api/tenants/tenant-qa/sla']);
  assert.match(String(operator.view(route('#metrics/sla'))), /Cliente &lt;1&gt;/);
  const blind = createSettings({ state: stateOf({ ...OPERATOR, permissions: ['metrics.read'] }, { view: 'metrics' }), request: async () => assert.fail('sem inbox.read não consulta o SLA') });
  assert.equal(blind.loadSla({ force: true }), null);
  assert.equal(slaModel({ policy: {}, totals: {} }), null);
  assert.equal(slaModel(sla).conversations[0].firstReply.state, 'pending');
});

test('Indicadores › Agentes reutiliza o consumo de agent-usage-ui somente para leitura', () => {
  const data = { from: '2026-10-01', to: '2026-10-06', days: 7, limit: 1000, limitVersion: 3, today: { runs: 2, promptTokens: 100, completionTokens: 50, totalTokens: 150, blocked: false }, daily: [{ day: '2026-10-06', agentId: 'a-1', agentName: 'Hermes', runs: 2, promptTokens: 100, completionTokens: 50, totalTokens: 150 }], agents: [{ agentId: 'a-1', agentName: 'Hermes', runs: 2, totalTokens: 150 }], totals: { runs: 2, totalTokens: 150 } };
  const mcp = { usageSnapshot: () => ({ data, error: null, loading: false }), loadUsage: async () => {} };
  const page = String(createSettings({ state: stateOf(ADMIN, { view: 'metrics' }), mcp: () => mcp }).view(route('#metrics/agents')));
  assert.match(page, /Hermes/); assert.match(page, /Somente leitura\. A cota diária é ajustada em Agentes › Uso\./);
  assert.doesNotMatch(page, /Ajustar cota|data-action="agents:usage-limit"/);
  const operator = String(createSettings({ state: stateOf(OPERATOR, { view: 'metrics' }), mcp: () => mcp }).view(route('#metrics/agents')));
  assert.match(operator, /O consumo de IA é visível para a administração do workspace\./); assert.doesNotMatch(operator, /Hermes/);
});

test('nenhum "Elozi" em texto voltado ao cliente fora do workspace da plataforma (catálogos, templates e telas)', context => {
  for (const [name, dictionary] of [['settings', settingsTranslations], ['platform-users', platformUsersTranslations]]) for (const [pt, en] of Object.entries(dictionary)) assert.ok(!/Elozi/.test(pt) && !/Elozi/.test(en), `${name}: ${pt}`);
  // The only management key with the name is the server's requirement text, shown as "aplicação do painel".
  assert.deepEqual(Object.keys(managementTranslations).filter(key => /Elozi/.test(key)), ['Proxy configurado para este hostname e para a aplicação Elozi.']);
  for (const [pt, en] of Object.entries(managementTranslations)) assert.ok(!/Elozi/.test(en), pt);
  assert.match(readFileSync(new URL('../public/workspace-domains-ui.js', import.meta.url), 'utf8'), /'Proxy configurado para este hostname e para a aplicação Elozi\.': 'Proxy configurado para este hostname e para a aplicação do painel\.'/);

  // Templates of the P8 modules: protocol names (X-Elozi-* headers, elozi_* tools, ELOZI_* variables,
  // the elozi-webchat transport, lowercase hosts) are not product copy.
  const files = ['settings-ui', 'workspace-ui', 'units-ui', 'accounts-ui', 'billing-ui', 'plans-ui', 'commercial-usage-ui', 'platform-users-ui', 'integrations-ui', 'workspace-domains-ui', 'support-ui', 'account-invitations-ui', 'account-security-ui', 'guide-ui', 'contact-import-ui', 'avatar-ui', 'app'];
  for (const file of files) {
    const source = readFileSync(new URL(`../public/${file}.js`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      .replace(/X-Elozi-[A-Za-z-]+|elozi_[a-z_]+|ELOZI_[A-Z_]+|elozi-webchat/g, '')
      .replace("'Proxy configurado para este hostname e para a aplicação Elozi.'", '');
    assert.doesNotMatch(source, /Elozi/, `${file}.js`);
  }

  // Rendered screens of a reseller workspace, in Portuguese and English.
  for (const locale of ['pt-BR', 'en']) {
    inLocale(context, locale);
    const state = stateOf(ADMIN, { view: 'tenants' }), settings = createSettings({ state, brandDraft: () => ({ name: 'Acme', accent: '#e11d48' }) });
    const screens = [settings.view(route('#settings/brand')), settings.view(route('#settings/activity')), settings.view(route('#platform/health')), settings.view(route('#metrics/sla')), settings.view(route('#metrics/agents')),
      createGuideMarkup({ session: ADMIN, accountKind: 'reseller' }), createGuideMarkup({ session: OPERATOR, accountKind: 'business' })];
    for (const markup of screens) assert.doesNotMatch(String(markup).replace(/elozi_[a-z_]+|ELOZI_[A-Z_]+/g, ''), /Elozi/i, locale);
  }
});

test('folhas aposentadas por P8 saíram no P10 (arquivo, link e baseline) e as regras ainda usadas vivem em screen-settings.css', () => {
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const sheet of ['integrations.css', 'accounts.css', 'commercial-usage.css', 'platform-users.css', 'guide.css', 'product-review.css']) {
    assert.equal(existsSync(new URL(`../public/${sheet}`, import.meta.url)), false, sheet);
    assert.equal(existsSync(new URL(`./css-baseline/${sheet}.json`, import.meta.url)), false, sheet);
    assert.ok(!index.includes(`href="/${sheet}"`), sheet);
  }
  // Hooks of screens owned by others (flow draft guard of flow-workspace-ui.js, connector dialog of
  // channel-connectors-ui.js) and the wide dialogs moved here until their owners migrate (P10).
  const css = readFileSync(new URL('../public/screen-settings.css', import.meta.url), 'utf8');
  for (const hook of ['[data-flow-draft-guard] .modal-actions {', '.accounts-dialog .modal-actions {', '.accounts-review > div {', '#modal:has([data-commercial-usage-panel])', '#modal:has([data-platform-users-panel])']) assert.ok(css.includes(hook), hook);
});
