import './locales-telegram-account.js';
import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
const kinds = i18nLabels({ platform: 'Plataforma', reseller: 'Revenda', business: 'Empresa' });
const transports = i18nLabels({ baileys: 'WhatsApp QR', 'telegram-bot': 'Telegram', 'telegram-user':'Telegram pessoal', webchat: 'Webchat', email: 'E-mail', instagram: 'Instagram', messenger: 'Messenger', other: 'Outros canais' });
const states = i18nLabels({ connected: 'Conectados', disconnected: 'Sem conexão registrada', disabled: 'Desativados', unknown: 'Não identificado' });
const metrics = i18nLabels({ subscription: 'Mensalidade', connections: 'Conexões WhatsApp + Telegram', users: 'Pessoas próprias do workspace', agent_service: 'Identidades de serviço', email: 'E-mails' });
const bases = { subscription: 'unavailable', connections: 'registered-whatsapp-qr-telegram', users: 'active-users-own-workspace', agent_service: 'active-unexpired-service-identities', email: 'unavailable' };
const explanations = i18nLabels({ subscription: 'A mensalidade não possui uma quantidade operacional medida aqui.', connections: 'Conexões de WhatsApp QR e Telegram configuradas no alvo deste contrato, incluindo as desconectadas. Cadastros apenas planejados ficam fora desta franquia.', users: 'Pessoas ativas próprias do workspace. Pode diferir das pessoas únicas da carteira.', agent_service: 'Identidades de serviço ativas e dentro da validade. Não mede tokens nem chamadas de IA.', email: 'A medição de e-mails ainda não está disponível neste relatório.' });
const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const invalid = () => { throw new Error('A resposta não confirmou um relatório de uso consistente. Atualize e tente novamente.'); };
const text = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\p{Cc}]/u.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, required, optional = []) => {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
};
const sum = values => { let total = 0; for (const value of values) { if (!count(value) || !Number.isSafeInteger(total + value)) invalid(); total += value; } return total; };
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

function validateReport(value, account, scope) {
  fields(value, ['account', 'scope', 'measuredAt', 'includedAccounts', 'inventory', 'quotas', 'definitions']);
  fields(value.account, ['id', 'name', 'kind', 'version']);
  if (value.account.id !== account.id || value.account.kind !== account.accountKind || !text(value.account.name, 80) || !count(value.account.version) || value.account.version < account.version || value.scope !== scope || !dateValid(value.measuredAt)) invalid();
  fields(value.includedAccounts, ['count', 'ids']);
  const ids = value.includedAccounts.ids;
  if (!Array.isArray(ids) || !count(value.includedAccounts.count) || value.includedAccounts.count !== ids.length || ids.length < 1 || ids.some(id => !text(id, 120)) || new Set(ids).size !== ids.length || !ids.includes(account.id) || scope === 'own' && (ids.length !== 1 || ids[0] !== account.id)) invalid();
  fields(value.definitions, ['channelState', 'memberships', 'quotaPreviewOnly']);
  if (value.definitions.channelState !== 'stored' || value.definitions.memberships !== 'distinct-user-workspace' || value.definitions.quotaPreviewOnly !== true) invalid();
  const inventory = value.inventory;
  fields(inventory, ['tenants', 'channels', 'users', 'agents', 'servicePrincipals']);
  if (!count(inventory.tenants)) invalid();
  fields(inventory.users, ['active', 'memberships']);
  if (!count(inventory.users.active) || !count(inventory.users.memberships) || inventory.users.active > inventory.users.memberships) invalid();
  fields(inventory.agents, ['registered', 'configured']);
  if (!count(inventory.agents.registered) || !count(inventory.agents.configured) || inventory.agents.configured > inventory.agents.registered) invalid();
  fields(inventory.servicePrincipals, ['active']);
  if (!count(inventory.servicePrincipals.active)) invalid();
  const channelFields = ['registered', ...Object.keys(states)];
  fields(inventory.channels, [...channelFields, 'byTransport']);
  const channels = inventory.channels, rows = channels.byTransport;
  if (!Array.isArray(rows) || rows.length !== Object.keys(transports).length) invalid();
  if (channelFields.some(key => !count(channels[key])) || sum(Object.keys(states).map(key => channels[key])) !== channels.registered) invalid();
  const found = new Set();
  for (const row of rows) {
    fields(row, ['transport', ...channelFields]);
    if (!Object.hasOwn(transports, row.transport) || found.has(row.transport) || channelFields.some(key => !count(row[key])) || sum(Object.keys(states).map(key => row[key])) !== row.registered) invalid();
    found.add(row.transport);
  }
  if (channelFields.some(key => sum(rows.map(row => row[key])) !== channels[key])) invalid();
  if (!Array.isArray(value.quotas) || value.quotas.length > 10000) invalid();
  const contracts = new Set();
  for (const quota of value.quotas) {
    fields(quota, ['id', 'name', 'revision', 'status', 'target', 'lines']);
    if (!text(quota.id, 120) || !text(quota.name) || contracts.has(quota.id) || !count(quota.revision) || quota.revision < 1 || quota.status !== 'active') invalid();
    contracts.add(quota.id);
    fields(quota.target, ['kind', 'workspaceId', 'tenantId', 'name', 'workspaceName']);
    if (!['reseller', 'tenant'].includes(quota.target.kind) || !ids.includes(quota.target.workspaceId) || !text(quota.target.name) || !text(quota.target.workspaceName, 80) || quota.target.kind === 'tenant' && !text(quota.target.tenantId, 120) || quota.target.kind === 'reseller' && quota.target.tenantId !== null) invalid();
    if (!Array.isArray(quota.lines) || quota.lines.length !== Object.keys(metrics).length) invalid();
    const lineMetrics = new Set();
    for (const line of quota.lines) {
      fields(line, ['metric', 'quantity', 'limit', 'excess', 'remaining', 'quantityBasis']);
      if (!Object.hasOwn(metrics, line.metric) || lineMetrics.has(line.metric) || line.quantityBasis !== bases[line.metric] || ['quantity', 'limit', 'excess', 'remaining'].some(key => line[key] !== null && !count(line[key]))) invalid();
      lineMetrics.add(line.metric);
      if (line.quantityBasis === 'unavailable' && line.quantity !== null) invalid();
      if (line.quantity === null || line.limit === null) { if (line.excess !== null || line.remaining !== null) invalid(); }
      else if (line.excess !== Math.max(0, line.quantity - line.limit) || line.remaining !== Math.max(0, line.limit - line.quantity)) invalid();
    }
  }
  return value;
}

export function createCommercialUsageUI({ state, api, escape: e = fallbackEscape, icon = () => '', openModal, toast = () => {}, getModal = () => globalThis.document?.querySelector('#modal') } = {}) {
  let current = null, sequence = 0, controller = null, observedModal = null;
  const context = () => {
    const session = state.boot?.session || {};
    return { userId: session.userId, workspaceId: state.workspaceId, role: session.role, kind: state.boot?.reseller?.accountKind || state.boot?.reseller?.kind || session.accountKind, global: Boolean(session.platformOwner || session.platformAdmin), support: state.supportGrantId || session.supportGrantId || null, csrf: state.boot?.csrfToken || session.csrfToken || '', route: state.view, permissions: session.permissions, scopeRules: session.scopeRules };
  };
  const contextKey = () => JSON.stringify(context());
  const allowed = () => { const c = context(); return Boolean(text(c.userId, 120) && text(c.workspaceId, 120) && c.role === 'reseller' && Object.hasOwn(kinds, c.kind) && !c.support); };
  const globalAccess = () => allowed() && context().kind === 'platform' && context().global;
  const accountAllowed = account => allowed() && (account.id === context().workspaceId && account.accountKind === context().kind || context().kind === 'reseller' && account.accountKind === 'business' && account.parentWorkspaceId === context().workspaceId || globalAccess());
  const portfolioAllowed = account => accountAllowed(account) && (account.accountKind === 'reseller' || account.accountKind === 'platform' && globalAccess());
  const panel = () => getModal()?.querySelector?.('[data-commercial-usage-panel]');
  const ownsPanel = item => Boolean(item && getModal()?.open !== false && panel()?.dataset?.commercialUsageToken === item.token);
  const currentContext = item => Boolean(item && current === item && allowed() && contextKey() === item.key && state.boot === item.boot && state.boot?.session === item.session && accountAllowed(item.account));
  function shown(item) {
    if (!currentContext(item)) {
      if (item && current === item) release({ close: true });
      return false;
    }
    return ownsPanel(item);
  }
  const number = value => value.toLocaleString(getLocale());
  const metricValue = (value, unavailable) => value === null ? unavailable : number(value);
  const when = value => new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
  const button = (item, action, label, { scope, selected = false, disabled = false } = {}) => i18nHtml`<button type="button" class="ui-btn ui-btn--${selected ? 'primary' : 'secondary'} ui-btn--md" data-commercial-usage-action="${action}" data-commercial-usage-token="${item.token}"${scope ? ` data-usage-scope="${scope}" aria-pressed="${selected}"` : ''}${disabled ? ' disabled' : ''}><span class="ui-btn__label">${label}</span></button>`;
  function release({ close = false, restore = false } = {}) {
    const previous = current, owned = ownsPanel(previous), canRestore = restore && previous && currentContext(previous);
    sequence++; controller?.abort(); controller = null; current = null;
    if (close && owned) getModal()?.close?.();
    if (canRestore && previous.returnFocus?.isConnected) previous.returnFocus.focus?.({ preventScroll: true });
  }
  function observeDialog() {
    const modal = getModal();
    if (!modal || modal === observedModal) return;
    observedModal = modal;
    modal.addEventListener?.('close', () => {
      // Native close is queued; a different panel may have reopened this shared dialog meanwhile.
      if (modal === getModal() && modal.open === false && current && panel()?.dataset?.commercialUsageToken === current.token) release({ restore: true });
    });
  }
  function reset() { release({ close: true }); }
  function syncContext() {
    if (!current) return false;
    if (!currentContext(current)) { release({ close: true }); return false; }
    if (!ownsPanel(current)) { release(); return false; }
    return true;
  }
  // Uso e franquias da conta (FRONTEND-V2 §8.9, P8): the report keeps its data-usage-* attributes (the
  // counters the tests read) on the tokens of screen-settings.css.
  function controls(item) {
    return i18nHtml`<div class="pg-settings__cluster"><div class="pg-settings__cluster" role="group" aria-label="Abrangência do relatório">${button(item, 'scope', i18nT('Só esta conta'), { scope: 'own', selected: item.scope === 'own' })}${portfolioAllowed(item.account) ? button(item, 'scope', item.account.accountKind === 'platform' ? i18nT('Plataforma e contas vinculadas') : i18nT('Conta e clientes diretos'), { scope: 'portfolio', selected: item.scope === 'portfolio' }) : ''}</div>${button(item, 'refresh', i18nT('Atualizar relatório'), { disabled: item.loading })}</div>`;
  }
  const measured = (metric, value, label) => i18nHtml`<span data-usage-metric="${metric}" data-usage-value="${value}">${label || number(value)}</span>`;
  const statistic = (label, value, detail, metric) => i18nHtml`<article class="pg-settings__stat"><span class="pg-settings__stat-label">${label}</span><strong class="pg-settings__stat-value">${measured(metric, value)}</strong><p class="pg-settings__stat-hint">${detail}</p></article>`;
  function content(item) {
    const top = controls(item);
    if (item.loading) return top + i18nMarkup('<div class="pg-settings__note" role="status"><strong>Consultando o uso registrado…</strong><span>Conferindo canais, acessos e contratos desta seleção.</span></div>');
    if (item.error) return top + i18nHtml`<div class="pg-settings__note" role="alert"><strong>Não foi possível confirmar o relatório</strong><span>${e(translateError(item.error))}</span><span>${button(item, 'refresh', i18nT('Tentar novamente'))}</span></div>`;
    const report = item.report, i = report.inventory;
    const quotaBlocks = report.quotas.map(quota => i18nHtml`<article class="pg-settings__card" data-usage-contract-card><div class="pg-settings__card-head"><div class="pg-settings__stack"><span class="pg-settings__eyebrow">CONTRATO VIGENTE · REVISÃO ${quota.revision}</span><strong class="pg-settings__strong">${e(quota.name)}</strong><span class="pg-settings__muted">${e(quota.target.name)}${quota.target.kind === 'tenant' ? ` · ${e(quota.target.workspaceName)}` : ''}</span></div><span class="ui-badge ui-badge--success">Vigente</span></div><div class="pg-settings__table-wrap"><table class="pg-settings__table"><thead><tr><th scope="col">Franquia e base de contagem</th><th scope="col">Uso atual</th><th scope="col">Limite</th><th scope="col">Disponível</th><th scope="col">Excedente</th></tr></thead><tbody>${Object.keys(metrics).map(metric => { const line = quota.lines.find(value => value.metric === metric), attr = field => ` data-usage-contract="${e(quota.id)}" data-usage-metric="quotas.${metric}.${field}" data-usage-value="${line[field]}"`; return i18nHtml`<tr${line.excess > 0 ? ' data-tone="warning"' : ''}><th scope="row"><strong>${metrics[metric]}</strong><span class="pg-settings__sub">${explanations[metric]}</span></th><td${attr('quantity')}>${metricValue(line.quantity, i18nT('Não medido'))}</td><td${attr('limit')}>${metricValue(line.limit, i18nT('Não definido'))}</td><td${attr('remaining')}>${metricValue(line.remaining, i18nT('Não calculado'))}</td><td${attr('excess')}>${line.excess === null ? i18nT('Não calculado') : line.excess > 0 ? i18nHtml`<strong>${number(line.excess)} acima do limite</strong>` : '0'}</td></tr>`; }).join('')}</tbody></table></div><details class="pg-settings__details"><summary>Referência do contrato</summary><p class="pg-settings__muted">Contrato <code class="pg-settings__code">${e(quota.id)}</code> · revisão ${quota.revision}</p></details></article>`).join('');
    return i18nHtml`${top}<header class="pg-settings__section-head"><div><span class="pg-settings__eyebrow">${kinds[report.account.kind]} · ${item.scope === 'own' ? i18nT('USO PRÓPRIO') : i18nT('USO AGREGADO')}</span><h3 class="pg-settings__section-title">${e(report.account.name)}</h3><p class="pg-settings__muted">${item.scope === 'own' ? i18nT('Somente os registros próprios desta conta.') : report.account.kind === 'platform' ? i18nT('A conta da plataforma e as contas comerciais vinculadas incluídas pelo servidor.') : i18nT('Sua conta e seus clientes empresariais diretos. Pessoas repetidas são contadas uma vez.')}</p></div><div class="pg-settings__stack"><time class="pg-settings__strong pg-settings__num" datetime="${e(report.measuredAt)}">${e(when(report.measuredAt))}</time><span class="pg-settings__hint">Horário deste navegador · versão da conta ${report.account.version}</span></div></header><section class="pg-settings__stats" aria-label="Resumo da seleção">${statistic(i18nT('Contas incluídas'), report.includedAccounts.count, item.scope === 'own' ? i18nT('A conta selecionada.') : i18nT('Cada conta mantém sua operação separada.'), 'includedAccounts.count')}${statistic(i18nT('Empresas e filiais'), i.tenants, i18nT('Unidades cadastradas nesta seleção.'), 'tenants')}${statistic(i18nT('Pessoas únicas ativas'), i.users.active, i18nTxt`${measured('users.memberships', i.users.memberships)} vínculos de pessoa com workspace. Uma pessoa pode ter vários vínculos.`, 'users.active')}${statistic(i18nT('Agentes cadastrados'), i.agents.registered, i18nTxt`${measured('agents.configured', i.agents.configured)} com configuração registrada.`, 'agents.registered')}${statistic(i18nT('Serviços ativos'), i.servicePrincipals.active, i18nT('Identidades ativas dentro da validade. Não mede execução do agente.'), 'servicePrincipals.active')}</section><section class="pg-settings__stack" aria-labelledby="commercial-usage-channels-title"><div class="pg-settings__section-head"><div><h3 class="pg-settings__section-title" id="commercial-usage-channels-title">Canais por plataforma</h3><p class="pg-settings__muted">${measured('channels.registered', i.channels.registered)} cadastrados · ${measured('channels.connected', i.channels.connected)} com estado conectado registrado.</p></div><span class="ui-badge ui-badge--neutral">Estado registrado</span></div><p class="pg-settings__muted">O inventário inclui cadastros planejados e lê o estado salvo no painel. Não testa a conexão, o QR ou a saúde do gateway neste momento.</p><dl class="pg-settings__summary-list" aria-label="Estado registrado de todos os canais">${Object.entries(states).map(([key, label]) => i18nHtml`<div><dt>${label}</dt><dd>${measured("channels." + key, i.channels[key])}</dd></div>`).join("")}</dl><ul class="pg-settings__usage-channels" data-usage-channels>${Object.entries(transports).map(([transport, label]) => { const row = i.channels.byTransport.find(value => value.transport === transport); return i18nHtml`<li class="pg-settings__card"><div class="pg-settings__card-head"><strong class="pg-settings__strong">${label}</strong><span class="pg-settings__muted">${measured('channels.byTransport.' + transport + '.registered', row.registered)} cadastrados</span></div><dl class="pg-settings__facts">${Object.entries(states).map(([key, name]) => i18nHtml`<div><dt>${name}</dt><dd>${measured('channels.byTransport.' + transport + '.' + key, row[key])}</dd></div>`).join('')}</dl></li>`; }).join('')}</ul></section><section class="pg-settings__stack" aria-labelledby="commercial-usage-quotas-title"><div class="pg-settings__section-head"><div><h3 class="pg-settings__section-title" id="commercial-usage-quotas-title">Franquias dos contratos vigentes</h3><p class="pg-settings__muted">Uma referência por contrato e revisão. Limites de contratos diferentes não são somados.</p></div></div>${quotaBlocks || i18nMarkup('<div class="pg-settings__note"><strong>Nenhum contrato vigente disponível nesta seleção</strong><span>As contagens acima continuam disponíveis. Sem contrato ou limite informado, a franquia fica não definida.</span></div>')}</section><aside class="pg-settings__note"><strong>Consulta de uso, sem cobrança automática.</strong><span>Excedentes são uma prévia da contagem atual: não criam fatura, não alteram preço e não bloqueiam acessos. Limite não definido não significa uso ilimitado. Tokens, armazenamento e custos do provedor de IA não são medidos aqui.</span></aside><div class="pg-settings__dialog-actions">${button(item, 'close', i18nT('Fechar relatório'))}</div>`;
  }
  function paint(item) {
    if (!shown(item)) return;
    const host = panel(), active = globalThis.document?.activeElement;
    const focus = active && host.contains?.(active) && ['scope', 'refresh', 'close'].includes(active.dataset?.commercialUsageAction) && (!active.dataset?.usageScope || ['own', 'portfolio'].includes(active.dataset.usageScope)) ? { action: active.dataset.commercialUsageAction, scope: active.dataset.usageScope } : null;
    host.setAttribute?.('aria-busy', String(item.loading));
    host.innerHTML = content(item);
    if (focus?.action) host.querySelector?.(`[data-commercial-usage-action="${focus.action}"]${focus.scope ? `[data-usage-scope="${focus.scope}"]` : ''}`)?.focus?.({ preventScroll: true });
  }
  async function load(item, scope) {
    if (!shown(item) || scope === 'portfolio' && !portfolioAllowed(item.account)) return;
    const active = globalThis.document?.activeElement;
    const restoreRefreshFocus = active && panel()?.contains?.(active) && active.dataset?.commercialUsageAction === 'refresh' && active.dataset.commercialUsageToken === item.token;
    controller?.abort(); const ownController = new AbortController(); controller = ownController;
    const ticket = ++sequence; item.scope = scope; item.loading = true; item.report = null; item.error = ''; paint(item);
    try {
      const response = await api(`/api/accounts/${encodeURIComponent(item.account.id)}/usage?scope=${scope}`, { method: 'GET', headers: { 'X-Elozi-Workspace': context().workspaceId }, signal: ownController.signal });
      if (!shown(item) || ticket !== sequence || ownController.signal.aborted) return;
      item.report = validateReport(response, item.account, scope);
    } catch (failure) {
      if (!shown(item) || ticket !== sequence || ownController.signal.aborted) return;
      item.error = failure?.status === 403 ? 'Este acesso não permite consultar o uso desta conta.' : failure?.status === 404 ? 'A conta não está disponível neste acesso. Atualize a lista de contas.' : failure?.status ? 'A consulta não foi concluída. Confira sua conexão e tente novamente.' : failure?.message === 'A resposta não confirmou um relatório de uso consistente. Atualize e tente novamente.' ? failure.message : 'Não foi possível consultar o uso agora. Tente novamente.';
    } finally {
      if (controller === ownController) controller = null;
      if (shown(item) && ticket === sequence && !ownController.signal.aborted) {
        item.loading = false; paint(item);
        const document = globalThis.document;
        if (restoreRefreshFocus && document?.body && document.activeElement === document.body && shown(item)) panel()?.querySelector?.('[data-commercial-usage-action="refresh"]')?.focus?.({ preventScroll: true });
      }
    }
  }
  async function open(account) {
    syncContext();
    if (!record(account) || !text(account.id, 120) || !text(account.name, 80) || !Object.hasOwn(kinds, account.accountKind) || !count(account.version) || account.version < 1 || account.parentWorkspaceId !== null && account.parentWorkspaceId !== undefined && !text(account.parentWorkspaceId, 120) || !accountAllowed(account)) {
      toast(i18nT('Atualize as contas e use um acesso administrativo autorizado para abrir este relatório.'), true); return false;
    }
    release(); observeDialog();
    const item = { account: { id: account.id, name: account.name, accountKind: account.accountKind, version: account.version, parentWorkspaceId: account.parentWorkspaceId ?? null }, key: contextKey(), boot: state.boot, session: state.boot.session, token: String(++sequence), scope: 'own', loading: true, error: '', report: null, returnFocus: globalThis.document?.activeElement };
    current = item;
    openModal(i18nT('Uso e franquias da conta'), account.name, i18nHtml`<div class="pg-settings__dialog pg-settings__usage" data-commercial-usage-panel data-commercial-usage-token="${item.token}" aria-busy="true">${content(item)}</div>`);
    await load(item, 'own');
    return true;
  }
  async function handleAction(node) {
    const action = node?.dataset?.commercialUsageAction;
    if (!['scope', 'refresh', 'close'].includes(action)) return false;
    const item = current;
    if (!shown(item) || node.isConnected === false || node.dataset.commercialUsageToken !== item.token || panel()?.contains?.(node) === false) return true;
    if (action === 'close') { release({ close: true, restore: true }); return true; }
    if (action === 'scope') {
      const scope = node.dataset.usageScope;
      if (!['own', 'portfolio'].includes(scope) || scope === 'portfolio' && !portfolioAllowed(item.account)) { toast(i18nT('Escolha uma abrangência permitida para esta conta.'), true); return true; }
      if (scope === item.scope && item.loading) return true;
      await load(item, scope); return true;
    }
    if (!item.loading) await load(item, item.scope);
    return true;
  }
  return { open, handleAction, reset, syncContext };
}
