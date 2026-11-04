import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createCommercialUsageUI } from '../public/commercial-usage-ui.js';

const account = (more = {}) => ({ id: 'reseller-a', name: 'Revenda QA', accountKind: 'reseller', parentWorkspaceId: 'mep-demo', version: 2, ...more });
const typeRows = ['baileys', 'telegram-bot', 'telegram-user', 'webchat', 'email', 'instagram', 'messenger', 'other'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const line = (metric, quantity, limit) => ({ metric, quantity, limit, excess: quantity === null || limit === null ? null : Math.max(0, quantity - limit), remaining: quantity === null || limit === null ? null : Math.max(0, limit - quantity), quantityBasis: ({ subscription: 'unavailable', connections: 'registered-whatsapp-qr-telegram', users: 'active-users-own-workspace', agent_service: 'active-unexpired-service-identities', email: 'unavailable' })[metric] });
function report(target = account(), scope = 'own', more = {}) {
  const byTransport = typeRows.map(transport => ({ transport, registered: transport === 'baileys' ? 2 : transport === 'telegram-bot' ? 1 : 0, connected: transport === 'baileys' || transport === 'telegram-bot' ? 1 : 0, disconnected: transport === 'baileys' ? 1 : 0, disabled: 0, unknown: 0 }));
  return { account: { id: target.id, name: target.name, kind: target.accountKind, version: target.version }, scope, measuredAt: '2026-10-05T03:04:05.000Z', includedAccounts: { count: scope === 'portfolio' ? 2 : 1, ids: scope === 'portfolio' ? [target.id, 'business-a'] : [target.id] }, inventory: { tenants: 2, channels: { registered: 3, connected: 2, disconnected: 1, disabled: 0, unknown: 0, byTransport }, users: { active: 2, memberships: 3 }, agents: { registered: 2, configured: 1 }, servicePrincipals: { active: 1 } }, quotas: [{ id: 'contract-a', name: 'Equipe QA', revision: 3, status: 'active', target: { kind: 'reseller', workspaceId: target.id, tenantId: null, name: target.name, workspaceName: target.name }, lines: [line('subscription', null, null), line('connections', 3, 2), line('users', 2, 5), line('agent_service', 1, null), line('email', null, 0)] }], definitions: { channelState: 'stored', memberships: 'distinct-user-workspace', quotaPreviewOnly: true }, ...more };
}
function fixture({ target = account(), intercept, queuedCloseEvents = false } = {}) {
  const state = { view: 'accounts', workspaceId: 'reseller-a', supportGrantId: null, scopedRunsEpoch: 0, boot: { csrfToken: 'csrf-qa', session: { userId: 'person-qa', role: 'reseller', platformOwner: false, permissions: null, scopeRules: null }, reseller: { accountKind: 'reseller', name: 'Revenda QA' } } };
  const calls = [], opened = [], messages = [], listeners = new Map(), closeEvents = [];
  let closing = 0, panel = null;
  const modal = { open: false, html: '', querySelector(selector) { return selector === '[data-commercial-usage-panel]' ? panel : null; }, addEventListener(event, handler) { listeners.set(event, handler); }, close() { this.open = false; closing++; if (queuedCloseEvents) closeEvents.push(() => listeners.get('close')?.()); else listeners.get('close')?.(); } };
  const api = async (path, init) => { calls.push({ path, init }); const scope = new URL(path, 'https://fixture.invalid').searchParams.get('scope'); return intercept ? intercept(path, init, () => report(target, scope)) : report(target, scope); };
  const ui = createCommercialUsageUI({ state, api, getModal: () => modal, toast: (message, failed) => messages.push({ message, failed }), openModal(title, subtitle, html) {
    modal.open = true; modal.html = html; const token = html.match(/data-commercial-usage-token="([^"]+)"/)?.[1];
    panel = { dataset: { commercialUsageToken: token }, innerHTML: html, contains: node => node?.owner === panel, setAttribute(name, value) { this[name] = value; }, querySelector() { return null; } };
    opened.push({ title, subtitle, html });
  } });
  const node = (action, scope, more = {}) => ({ isConnected: true, owner: panel, dataset: { commercialUsageAction: action, commercialUsageToken: panel?.dataset.commercialUsageToken, usageScope: scope, ...more } });
  return { state, ui, target, calls, opened, messages, modal, node,
    openOtherPanel() { modal.open = true; panel = { dataset: { accountsToken: 'account-detail-qa' }, innerHTML: '<p>Detalhe da conta</p>' }; },
    flushCloseEvents() { for (const dispatch of closeEvents.splice(0)) dispatch(); },
    get html() { return panel?.innerHTML || ''; }, get panel() { return panel; }, get closing() { return closing; } };
}

function modelRefreshFocus(env, document) {
  const host = env.panel; let html = host.innerHTML;
  Object.defineProperty(host, 'innerHTML', { get() { return html; }, set(value) {
    // Replacing a focused DOM child sends focus to BODY; disabled buttons cannot take it back.
    if (host.contains(document.activeElement)) { document.activeElement.isConnected = false; document.activeElement = document.body; }
    html = value;
  } });
  host.querySelector = selector => {
    if (selector !== '[data-commercial-usage-action="refresh"]') return null;
    const button = html.match(/<button[^>]*data-commercial-usage-action="refresh"[^>]*>/)?.[0];
    if (!button) return null;
    return { owner: host, isConnected: true, disabled: /\sdisabled(?:\s|>)/.test(button),
      dataset: { commercialUsageAction: 'refresh', commercialUsageToken: host.dataset.commercialUsageToken },
      focus() { if (!this.disabled) document.activeElement = this; } };
  };
}

test('relatório readonly separa inventário, estados registrados e franquias de cada contrato', async () => {
  const env = fixture(); assert.equal(await env.ui.open(env.target), true);
  assert.equal(env.calls.length, 1); assert.equal(env.calls[0].path, '/api/accounts/reseller-a/usage?scope=own'); assert.equal(env.calls[0].init.method, 'GET'); assert.deepEqual(env.calls[0].init.headers, { 'X-Elozi-Workspace': 'reseller-a' }); assert.equal('body' in env.calls[0].init, false);
  for (const label of ['WhatsApp QR', 'Telegram', 'Webchat', 'E-mail', 'Instagram', 'Messenger', 'Outros canais', 'Estado registrado', 'Pessoas únicas ativas', 'vínculos de pessoa', 'Equipe QA', 'REVISÃO 3', '1 acima do limite', 'Não medido', 'Não definido', 'não criam fatura', 'não bloqueiam acessos']) assert.ok(env.html.includes(label), label);
  assert.ok(env.html.includes('Limite não definido não significa uso ilimitado')); assert.ok(!env.html.includes('Criar fatura')); assert.equal(env.opened.length, 1); assert.equal(env.panel['aria-busy'], 'false');
});
test('marcadores de conferência estão somente nos números e franquias visíveis', async () => {
  const env = fixture(); await env.ui.open(env.target);
  for (const [metric, value] of Object.entries({ 'includedAccounts.count': 1, tenants: 2, 'users.active': 2, 'users.memberships': 3, 'agents.registered': 2, 'agents.configured': 1, 'servicePrincipals.active': 1, 'channels.registered': 3, 'channels.connected': 2, 'channels.disconnected': 1, 'channels.disabled': 0, 'channels.unknown': 0, 'channels.byTransport.baileys.registered': 2, 'channels.byTransport.baileys.connected': 1, 'channels.byTransport.baileys.disconnected': 1 })) assert.ok(env.html.includes(`data-usage-metric="${metric}" data-usage-value="${value}">${value}</span>`), metric);
  assert.ok(env.html.includes('data-usage-contract="contract-a" data-usage-metric="quotas.connections.excess" data-usage-value="1"><strong>1 acima do limite</strong>'));
  assert.ok(env.html.includes('data-usage-metric="quotas.email.quantity" data-usage-value="null">Não medido'));
  assert.ok(!env.html.includes('data-usage-metric="undefined"')); assert.ok(!env.html.includes('data-report=')); assert.ok(!env.html.includes('type="hidden"'));
});
test('zero é apresentado como zero, separado de medição/limite ausentes', async () => {
  const env = fixture({ intercept: (path, init, fallback) => { const r = fallback(); r.inventory = { tenants: 0, channels: { registered: 0, connected: 0, disconnected: 0, disabled: 0, unknown: 0, byTransport: typeRows.map(transport => ({ transport, registered: 0, connected: 0, disconnected: 0, disabled: 0, unknown: 0 })) }, users: { active: 0, memberships: 0 }, agents: { registered: 0, configured: 0 }, servicePrincipals: { active: 0 } }; r.quotas[0].lines[1] = line('connections', 0, 0); return r; } });
  await env.ui.open(env.target); assert.ok(env.html.includes('data-usage-metric="channels.registered" data-usage-value="0">0</span>')); assert.ok(env.html.includes('data-usage-metric="quotas.connections.limit" data-usage-value="0">0</td>')); assert.ok(env.html.includes('Não medido')); assert.ok(!env.html.includes('acima do limite'));
});
test('sem contrato não vira franquia ilimitada nem muda o inventário', async () => {
  const env = fixture({ intercept: (path, init, fallback) => ({ ...fallback(), quotas: [] }) }); await env.ui.open(env.target);
  assert.ok(env.html.includes('Nenhum contrato vigente disponível')); assert.ok(env.html.includes('franquia fica não definida')); assert.ok(env.html.includes('WhatsApp QR')); assert.ok(!env.html.includes('Equipe QA'));
});
test('contratos coexistentes conservam limites individuais em vez de somar franquias', async () => {
  const env = fixture({ intercept: (path, init, fallback) => { const r = fallback(); r.quotas.push({ ...structuredClone(r.quotas[0]), id: 'contract-b', name: 'Outro acordo', revision: 8, lines: [line('subscription', null, null), line('connections', 3, 1), line('users', 2, 1), line('agent_service', 1, 0), line('email', null, null)] }); return r; } }); await env.ui.open(env.target);
  assert.ok(env.html.includes('Equipe QA')); assert.ok(env.html.includes('Outro acordo')); assert.ok(env.html.includes('REVISÃO 8')); assert.ok(env.html.includes('2 acima do limite')); assert.equal((env.html.match(/<article class="pg-settings__card" data-usage-contract-card>/g) || []).length, 2);
});
test('escopo da carteira é explícito e não reaproveita resposta própria', async () => {
  const env = fixture(); await env.ui.open(env.target); await env.ui.handleAction(env.node('scope', 'portfolio'));
  assert.equal(env.calls.at(-1).path, '/api/accounts/reseller-a/usage?scope=portfolio'); assert.ok(env.html.includes('USO AGREGADO')); assert.ok(env.html.includes('clientes empresariais diretos')); assert.ok(env.html.includes('aria-pressed="true"')); assert.equal(env.opened.length, 1);
});
test('empresa própria não recebe opção carteira; toggle forjado não consulta', async () => {
  const target = account({ id: 'business-a', accountKind: 'business', parentWorkspaceId: 'reseller-a' }), env = fixture({ target }); env.state.workspaceId = target.id; env.state.boot.reseller.accountKind = 'business'; await env.ui.open(target);
  assert.ok(!env.html.includes('data-usage-scope="portfolio"')); await env.ui.handleAction(env.node('scope', 'portfolio')); assert.equal(env.calls.length, 1); assert.equal(env.messages.at(-1).failed, true);
});
test('revenda pode consultar cliente empresarial direto, mas não outra revenda ou empresa externa', async () => {
  const client = account({ id: 'business-a', accountKind: 'business', parentWorkspaceId: 'reseller-a' }), env = fixture({ target: client }); await env.ui.open(client); assert.equal(env.calls.length, 1);
  assert.equal(await env.ui.open(account({ id: 'external', accountKind: 'business', parentWorkspaceId: 'other' })), false); assert.equal(await env.ui.open(account({ id: 'reseller-b' })), false); assert.equal(env.calls.length, 1);
});
test('principal da plataforma pode consultar carteira global somente no contexto platform', async () => {
  const target = account({ id: 'mep-demo', accountKind: 'platform', parentWorkspaceId: null }), env = fixture({ target }); env.state.workspaceId = target.id; env.state.boot.reseller.accountKind = 'platform'; env.state.boot.session.platformOwner = true;
  await env.ui.open(target); await env.ui.handleAction(env.node('scope', 'portfolio')); assert.ok(env.html.includes('USO AGREGADO')); assert.ok(env.html.includes('Plataforma e contas vinculadas'));
  env.ui.reset(); env.state.boot.reseller.accountKind = 'reseller'; env.state.workspaceId = 'reseller-a'; assert.equal(await env.ui.open(target), false); assert.equal(env.calls.length, 2);
});
for (const [name, change] of [
  ['operador', state => { state.boot.session.role = 'operator'; }],
  ['suporte do workspace', state => { state.supportGrantId = 'support-qa'; }],
  ['suporte da sessão', state => { state.boot.session.supportGrantId = 'support-qa'; }],
  ['sem pessoa', state => { state.boot.session.userId = ''; }],
  ['sem workspace', state => { state.workspaceId = ''; }],
  ['tipo desconhecido', state => { state.boot.reseller.accountKind = 'unknown'; }]
]) test(`ACL cliente recusa ${name} antes de consultar`, async () => { const env = fixture(); change(env.state); assert.equal(await env.ui.open(env.target), false); assert.equal(env.calls.length, 0); assert.equal(env.opened.length, 0); });

for (const [name, mutate] of [
  ['conta divergente', r => { r.account.id = 'other'; }],
  ['tipo divergente', r => { r.account.kind = 'business'; }],
  ['versão antiga', r => { r.account.version = 1; }],
  ['escopo divergente', r => { r.scope = 'portfolio'; }],
  ['data impossível', r => { r.measuredAt = '2026-02-30T03:00:00.000Z'; }],
  ['carteira forjada', r => { r.includedAccounts.ids.push('other'); r.includedAccounts.count++; }],
  ['campo privado', r => { r.apiToken = 'synthetic-secret-not-valid'; }],
  ['estado de gateway presumido', r => { r.definitions.channelState = 'health'; }],
  ['número negativo', r => { r.inventory.tenants = -1; }],
  ['número inseguro', r => { r.inventory.users.active = Number.MAX_SAFE_INTEGER + 1; }],
  ['pessoas sem vínculo', r => { r.inventory.users.active = 4; }],
  ['agentes inconsistentes', r => { r.inventory.agents.configured = 3; }],
  ['estado faltante', r => { delete r.inventory.channels.unknown; }],
  ['transporte repetido', r => { r.inventory.channels.byTransport[6] = structuredClone(r.inventory.channels.byTransport[5]); }],
  ['somas divergentes', r => { r.inventory.channels.connected = 3; }],
  ['estado extra', r => { r.inventory.channels.byTransport[0].health = 'healthy'; }],
  ['contrato duplicado', r => { r.quotas.push(structuredClone(r.quotas[0])); }],
  ['contrato encerrado', r => { r.quotas[0].status = 'expired'; }],
  ['revisão inválida', r => { r.quotas[0].revision = 0; }],
  ['alvo externo', r => { r.quotas[0].target.workspaceId = 'external'; }],
  ['unidade ausente', r => { r.quotas[0].target.kind = 'tenant'; }],
  ['métrica extra', r => { r.quotas[0].lines[4].metric = 'tokens'; }],
  ['base presumida', r => { r.quotas[0].lines[1].quantityBasis = 'active-whatsapp'; }],
  ['excesso errado', r => { r.quotas[0].lines[1].excess = 2; }],
  ['saldo errado', r => { r.quotas[0].lines[2].remaining = 9; }],
  ['limite ausente calculado', r => { r.quotas[0].lines[3].remaining = 0; }],
  ['medição indisponível inventada', r => { r.quotas[0].lines[4] = line('email', 0, 0); }]
]) test(`DTO recusa ${name}, sem exibir uma medição parcial`, async () => {
  const env = fixture({ intercept: (path, init, fallback) => { const r = fallback(); mutate(r); return r; } }); await env.ui.open(env.target);
  assert.ok(env.html.includes('Não foi possível confirmar o relatório')); assert.ok(env.html.includes('relatório de uso consistente')); assert.ok(!env.html.includes('commercial-usage-channel-grid')); assert.ok(!env.html.includes('synthetic-secret'));
});

test('texto recebido é escapado em conta, contrato e alvo sem virar HTML ativo', async () => {
  const env = fixture({ intercept: (path, init, fallback) => { const r = fallback(); r.account.name = '<script>alert(1)</script>'; r.quotas[0].name = '<img src=x onerror=alert(1)>'; r.quotas[0].target.name = 'Cliente <svg onload=1>'; return r; } }); await env.ui.open(env.target);
  assert.ok(env.html.includes('&lt;script&gt;')); assert.ok(env.html.includes('&lt;img')); assert.ok(env.html.includes('&lt;svg')); assert.ok(!env.html.includes('<script>')); assert.ok(!env.html.includes('<img'));
});
test('erros de transporte não imprimem payload; tentativa nova é GET sem criar cobrança', async () => {
  let failed = true; const env = fixture({ intercept: (path, init, fallback) => { if (failed) throw new Error('raw provider key and customer payload'); return fallback(); } }); await env.ui.open(env.target);
  assert.ok(env.html.includes('Não foi possível consultar o uso agora')); assert.ok(!env.html.includes('raw provider')); failed = false; await env.ui.handleAction(env.node('refresh')); assert.ok(env.html.includes('Equipe QA')); assert.ok(env.calls.every(c => c.init.method === 'GET' && !c.init.body));
});
test('escopo mais novo cancela anterior e resposta atrasada não substitui a carteira', async () => {
  const pending = deferred(); const env = fixture({ intercept: (path, init, fallback) => path.endsWith('scope=own') ? pending.promise : fallback() }); const opening = env.ui.open(env.target), first = env.calls[0];
  await env.ui.handleAction(env.node('scope', 'portfolio')); const html = env.html; assert.equal(first.init.signal.aborted, true); pending.resolve(report()); await opening; assert.equal(env.html, html); assert.ok(env.html.includes('USO AGREGADO'));
});
test('ABA de escopos conserva somente a resposta da última própria', async () => {
  const a = deferred(), b = deferred(); let own = 0; const env = fixture({ intercept: (path, init, fallback) => path.endsWith('scope=portfolio') ? b.promise : own++ === 0 ? a.promise : { ...fallback(), account: { ...fallback().account, name: 'Leitura própria atualizada', version: 3 } } });
  const first = env.ui.open(env.target), second = env.ui.handleAction(env.node('scope', 'portfolio')); await env.ui.handleAction(env.node('scope', 'own')); const html = env.html; a.resolve(report()); b.resolve(report(account(), 'portfolio')); await Promise.all([first, second]); assert.equal(env.html, html); assert.ok(env.html.includes('Leitura própria atualizada')); assert.equal(env.calls[0].init.signal.aborted, true); assert.equal(env.calls[1].init.signal.aborted, true);
});
for (const [name, change] of [
  ['pessoa', env => { env.state.boot.session.userId = 'person-b'; }],
  ['workspace', env => { env.state.workspaceId = 'reseller-b'; }],
  ['CSRF', env => { env.state.boot.csrfToken = 'changed'; }],
  ['papel', env => { env.state.boot.session.role = 'operator'; }],
  ['ACL', env => { env.state.boot.session.permissions = []; }],
  ['regras', env => { env.state.boot.session.scopeRules = { channels: [] }; }],
  ['suporte', env => { env.state.supportGrantId = 'grant'; }],
  ['rota', env => { env.state.view = 'inbox'; }],
  ['boot substituído', env => { env.state.boot = structuredClone(env.state.boot); }],
  ['sessão substituída', env => { env.state.boot.session = { ...env.state.boot.session }; }],
  ['reset', env => { env.ui.reset(); }],
  ['fechamento', env => { env.modal.close(); }],
  ['modal substituído', env => { env.panel.dataset.commercialUsageToken = 'other-modal'; env.panel.innerHTML = '<p>Outro fluxo</p>'; }]
]) test(`resposta atrasada é ignorada após ${name}`, async () => {
  const pending = deferred(), env = fixture({ intercept: () => pending.promise }); const opening = env.ui.open(env.target); change(env); const html = env.html, opened = env.opened.length; pending.resolve(report()); await opening; assert.equal(env.html, html); assert.equal(env.opened.length, opened);
  if (['reset', 'fechamento'].includes(name)) assert.equal(env.calls[0].init.signal.aborted, true);
});
test('render inofensivo da lista de contas não invalida leitura nem ações do relatório', async () => {
  const pending = deferred(), env = fixture({ intercept: () => pending.promise });
  const opening = env.ui.open(env.target); env.state.scopedRunsEpoch++; assert.equal(env.ui.syncContext(), true); assert.equal(env.closing, 0);
  pending.resolve(report()); await opening; assert.ok(env.html.includes('Equipe QA')); assert.ok(!env.html.includes('Consultando o uso registrado'));
  env.state.scopedRunsEpoch++; assert.equal(env.ui.syncContext(), true); await env.ui.handleAction(env.node('close')); assert.equal(env.closing, 1);
});
for (const [name, change] of [
  ['autoridade CSRF', env => { env.state.boot.csrfToken = 'other-authority'; }],
  ['workspace', env => { env.state.workspaceId = 'another-workspace'; }],
  ['boot', env => { env.state.boot = structuredClone(env.state.boot); }],
  ['sessão', env => { env.state.boot.session = { ...env.state.boot.session }; }],
  ['pessoa', env => { env.state.boot.session.userId = 'another-person'; }],
  ['suporte', env => { env.state.supportGrantId = 'grant'; }],
  ['rota', env => { env.state.view = 'inbox'; }]
]) test(`syncContext fecha modal próprio e cancela leitura ao trocar ${name}`, async () => {
  const pending = deferred(), env = fixture({ intercept: () => pending.promise }); const opening = env.ui.open(env.target); change(env);
  assert.equal(env.ui.syncContext(), false); assert.equal(env.closing, 1); assert.equal(env.modal.open, false); assert.equal(env.calls[0].init.signal.aborted, true);
  const html = env.html; pending.resolve(report()); await opening; assert.equal(env.html, html); assert.equal(env.closing, 1);
});
test('resposta tardia fecha modal próprio quando autoridade mudou sem sync de render', async () => {
  const pending = deferred(), env = fixture({ intercept: () => pending.promise }); const opening = env.ui.open(env.target); env.state.boot.csrfToken = 'changed';
  pending.resolve(report()); await opening; assert.equal(env.closing, 1); assert.equal(env.modal.open, false); assert.equal(env.calls[0].init.signal.aborted, true); assert.ok(!env.html.includes('Equipe QA'));
});
test('mudança de contexto não fecha modal substituto nem pinta leitura antiga', async () => {
  const pending = deferred(), env = fixture({ intercept: () => pending.promise }); const opening = env.ui.open(env.target); env.panel.dataset.commercialUsageToken = 'other-flow'; env.panel.innerHTML = '<p>Outro fluxo</p>'; env.state.boot.session.userId = 'another-person';
  assert.equal(env.ui.syncContext(), false); assert.equal(env.closing, 0); assert.equal(env.modal.open, true); assert.equal(env.calls[0].init.signal.aborted, true); pending.resolve(report()); await opening; assert.equal(env.html, '<p>Outro fluxo</p>');
});
test('ABA de autoridade com reset aborta leitura velha mesmo quando os campos voltam ao original', async () => {
  const pending = deferred(); let first = true; const env = fixture({ intercept: (path, init, fallback) => first ? (first = false, pending.promise) : fallback() });
  const opening = env.ui.open(env.target); env.state.boot.csrfToken = 'second-authority'; env.ui.reset(); env.state.boot.csrfToken = 'csrf-qa'; await env.ui.open(env.target); const html = env.html; pending.resolve({ ...report(), account: { ...report().account, name: 'Leitura velha' } }); await opening; assert.equal(env.html, html); assert.ok(!env.html.includes('Leitura velha')); assert.equal(env.calls[0].init.signal.aborted, true);
});
test('reset fecha somente seu modal e não fecha uma janela substituta', async () => {
  const env = fixture(); await env.ui.open(env.target); env.panel.dataset.commercialUsageToken = 'other-modal'; env.ui.reset(); assert.equal(env.closing, 0); assert.equal(env.modal.open, true);
});
test('ações desconectadas, fora do modal e com token antigo não consultam nem fecham', async () => {
  const env = fixture(); await env.ui.open(env.target); const stale = env.node('refresh'); await env.ui.open(env.target); const count = env.calls.length;
  await env.ui.handleAction(stale); const detached = env.node('refresh'); detached.isConnected = false; await env.ui.handleAction(detached); const outside = env.node('close'); outside.owner = {}; await env.ui.handleAction(outside); await env.ui.handleAction(env.node('scope', 'invalid')); assert.equal(env.calls.length, count); assert.equal(env.closing, 0); assert.equal(await env.ui.handleAction({ dataset: { action: 'billing-create' } }), false);
});
test('Fechar relatório cancela leitura própria pendente sem abrir outra janela', async () => {
  const pending = deferred(), env = fixture({ intercept: () => pending.promise }); const opening = env.ui.open(env.target); await env.ui.handleAction(env.node('close')); assert.equal(env.closing, 1); assert.equal(env.calls[0].init.signal.aborted, true); const html = env.html; pending.resolve(report()); await opening; assert.equal(env.html, html);
});

test('close nativo do detalhe de contas entregue após abrir consumo não cancela o novo relatório', async () => {
  const pending = deferred(); let first = true;
  const env = fixture({ queuedCloseEvents: true, intercept: (path, init, fallback) => first ? (first = false, pending.promise) : fallback() });
  env.openOtherPanel(); env.modal.close(); // Accounts closes its panel before the shared dialog is reused.
  const opening = env.ui.open(env.target), request = env.calls[0];
  env.flushCloseEvents();
  assert.equal(env.modal.open, true); assert.equal(request.init.signal.aborted, false);
  pending.resolve(report()); await opening;
  assert.ok(env.html.includes('Equipe QA')); assert.ok(!env.html.includes('Consultando o uso registrado')); assert.equal(env.panel['aria-busy'], 'false');
  await env.ui.handleAction(env.node('scope', 'portfolio')); assert.ok(env.html.includes('USO AGREGADO')); assert.equal(env.calls.length, 2);
});

test('close atrasado de um relatório aposentado não cancela a nova abertura nem restaura foco antigo', async t => {
  const oldDocument = globalThis.document, focused = [];
  globalThis.document = { activeElement: { isConnected: true, focus() { focused.push('trigger'); } } };
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  const oldRead = deferred(), newRead = deferred(); let calls = 0;
  const env = fixture({ queuedCloseEvents: true, intercept: () => calls++ === 0 ? oldRead.promise : newRead.promise });
  const retired = env.ui.open(env.target); await env.ui.handleAction(env.node('close'));
  assert.equal(env.calls[0].init.signal.aborted, true); assert.equal(focused.length, 1);
  const reopened = env.ui.open(env.target); env.flushCloseEvents();
  assert.equal(env.calls[1].init.signal.aborted, false); assert.equal(focused.length, 1);
  oldRead.resolve({ ...report(), account: { ...report().account, name: 'Relatório aposentado' } }); await retired;
  assert.ok(!env.html.includes('Relatório aposentado')); assert.ok(env.html.includes('Consultando o uso registrado'));
  newRead.resolve(report()); await reopened; assert.ok(env.html.includes('Equipe QA')); assert.equal(env.modal.open, true);
});

test('close nativo atual entregue com diálogo realmente fechado aborta a leitura e permite reabrir', async () => {
  const pending = deferred(); let first = true;
  const env = fixture({ queuedCloseEvents: true, intercept: (path, init, fallback) => first ? (first = false, pending.promise) : fallback() });
  const opening = env.ui.open(env.target); env.modal.close(); env.flushCloseEvents();
  assert.equal(env.modal.open, false); assert.equal(env.calls[0].init.signal.aborted, true);
  const html = env.html; pending.resolve(report()); await opening; assert.equal(env.html, html);
  await env.ui.open(env.target); assert.equal(env.modal.open, true); assert.ok(env.html.includes('Equipe QA'));
});

for (const failure of [false, true]) test(`Atualizar devolve foco ao botão habilitado após ${failure ? 'erro' : 'resposta'}, se BODY continuou ativo`, async t => {
  const oldDocument = globalThis.document, body = { nodeName: 'BODY' }, document = { body, activeElement: body };
  globalThis.document = document; t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  const pending = deferred(); let first = true;
  const env = fixture({ intercept: (path, init, fallback) => first ? (first = false, fallback()) : pending.promise });
  await env.ui.open(env.target); modelRefreshFocus(env, document);
  const trigger = env.node('refresh'); document.activeElement = trigger; const refreshing = env.ui.handleAction(trigger);
  assert.equal(document.activeElement, body); assert.equal(trigger.isConnected, false);
  if (failure) pending.reject(new Error('synthetic transport failure')); else pending.resolve(report());
  await refreshing; assert.notEqual(document.activeElement, trigger); assert.equal(document.activeElement.dataset.commercialUsageAction, 'refresh');
  assert.equal(document.activeElement.owner, env.panel); assert.equal(document.activeElement.disabled, false);
});

test('Atualizar não toma o foco que a pessoa moveu para outro controle durante a leitura', async t => {
  const oldDocument = globalThis.document, body = { nodeName: 'BODY' }, document = { body, activeElement: body };
  globalThis.document = document; t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  const pending = deferred(); let first = true;
  const env = fixture({ intercept: (path, init, fallback) => first ? (first = false, fallback()) : pending.promise });
  await env.ui.open(env.target); modelRefreshFocus(env, document);
  const trigger = env.node('refresh'); document.activeElement = trigger; const refreshing = env.ui.handleAction(trigger);
  const chosen = { nodeName: 'INPUT', isConnected: true }; document.activeElement = chosen;
  pending.resolve(report()); await refreshing; assert.equal(document.activeElement, chosen);
});
test('fechamento próprio devolve foco ao controle ainda conectado sem interferir em outra janela', async t => {
  const oldDocument = globalThis.document, focused = [];
  const trigger = { isConnected: true, focus(options) { focused.push(options); } };
  globalThis.document = { activeElement: trigger }; t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  const env = fixture(); await env.ui.open(env.target); await env.ui.handleAction(env.node('close')); assert.equal(focused.length, 1); assert.deepEqual(focused[0], { preventScroll: true });
  await env.ui.open(env.target); env.panel.dataset.commercialUsageToken = 'other-flow'; env.ui.reset(); assert.equal(focused.length, 1); assert.equal(env.modal.open, true);
});
// P8 (§8.9): the report uses the shared sheet of the settings screens (commercial-usage.css, emptied by P8, left in P10).
test('CSS deixa a rolagem de franquias dentro do relatório e organiza cards em375px', () => {
  assert.equal(existsSync(new URL('../public/commercial-usage.css', import.meta.url)), false);
  const css = readFileSync(new URL('../public/screen-settings.css', import.meta.url), 'utf8');
  assert.match(css, /#modal:has\(\[data-commercial-usage-panel\]\)[^{]*\{[^}]*1100px/);
  assert.match(css, /\.pg-settings__usage-channels \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/, 'uma coluna no celular');
  assert.match(css, /\.pg-settings__table-wrap \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-x: auto;/, 'a tabela rola dentro do relatório');
  assert.match(css, /@media \(max-width: 899\.98px\)|min-height: var\(--target-touch\)/, 'alvo de toque');
  assert.ok(!css.replace(/\/\*[\s\S]*?\*\//g, '').includes('!important'));
});
