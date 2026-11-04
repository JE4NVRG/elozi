import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, h, raw, getLocale, translateError, registerTranslations } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
import { button as uiButton, badge as uiBadge, banner, emptyState, progress, skeleton } from './ui.js';
import { glyph } from './icons.js';
import { formatHash } from './router.js';
import { pageHeader } from './settings-ui.js';
import { peekHomeData, portfolioKey } from './onboarding-ui.js';
import { portfolioModel } from './operation-readiness.js';

// Revenda › Clientes › Contas and Plataforma › Contas (FRONTEND-V2 §8.9, P8). The directory comes from
// GET /api/accounts (or /api/platform/accounts for the platform owner) with filters and pages on the
// server; the detail, the creation wizard, the commercial state and the rename keep their dialogs,
// each bound to a token so a late answer never lands in another account or access. "Clientes que
// precisam de você" reads the portfolio that Visão geral already loads (onboarding-ui.js cache).
// This fallback labels only a server-confirmed filtered total, never an inferred access total.
registerTranslations({ 'Contas neste filtro': 'Accounts in this filter' });
const kindNames = i18nLabels({ platform: 'Plataforma', reseller: 'Revenda', business: 'Empresa' });
const lifecycleNames = i18nLabels({ active: 'Ativa', trial: 'Em teste', paused: 'Pausada', archived: 'Arquivada' });
const reasonNames = i18nLabels({ 'admin-inactive': 'Administrador não ativou o acesso', 'no-channel': 'Sem canal há 7 dias', 'no-connection': 'Nenhum canal com conexão ativa' });
const steps = [
  ['companyCreated', 'Empresa inicial criada', 'Matriz e filiais mantêm canais e dados próprios.'],
  ['administratorActive', 'Administrador ativo', 'O responsável precisa aceitar o acesso e ativar a conta.'],
  ['channelConnected', 'Canal conectado', 'Uma conexão cadastrada ainda precisa estar conectada.'],
  ['teamReady', 'Equipe preparada', 'Pessoas reais, com acesso definido para a operação.'],
  ['contractConfigured', 'Contrato configurado', 'Preços e limites são definidos na gestão financeira.']
].map(row => i18nLabels(row));
const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString(getLocale()) : '—';
const date = value => { if (typeof value !== 'string' || !value.trim()) return i18nT('Data indisponível'); const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(getLocale()) : i18nT('Data indisponível'); };
const accountHash = id => { try { return formatHash({ section: 'accounts', params: { accountId: id }, query: {} }); } catch { return '#accounts'; } };
const lifecycleTone = state => state === 'active' ? 'success' : 'warning';

export function createAccountsUI({ state, api, escape: e = fallbackEscape, icon = () => '', openModal, render = () => {}, toast = () => {}, changeWorkspace, onInvite, onFinance, onUsage, onSupport, onDomains, onOperationalAccess, onDelete, getModal = () => globalThis.document?.querySelector('#modal') } = {}) {
  let platform = false, scope = '', pageToken = 0, modalToken = 0, sequence = 0, busy = false, loading = false, error = '', loaded = '', snapshot = null, view = null;
  let filters = { q: '', kind: 'all', state: 'all', offset: 0, limit: 25 };
  const controllers = new Map(), pending = new Map();
  const context = () => {
    const session = state.boot?.session || {}, workspaceId = state.workspaceId || session.resellerId || '';
    const accountKind = state.boot?.reseller?.accountKind || session.accountKind || (workspaceId === 'mep-demo' ? 'platform' : 'reseller');
    return { workspaceId, userId: session.userId, accountKind, support: state.supportGrantId || session.supportGrantId, admin: session.role === 'reseller', global: Boolean(session.platformOwner || session.platformAdmin), authority: state.boot?.csrfToken || session.csrfToken || '', route: state.view || '' };
  };
  const key = () => { const c = context(); return JSON.stringify([c.workspaceId, c.userId, c.authority, c.accountKind, c.admin, c.global, c.support || null, c.route, platform]); };
  const allowed = () => { const c = context(); return Boolean(c.userId && c.workspaceId && c.admin && !c.support && (!platform || c.global)); };
  const current = expected => allowed() && key() === expected;
  const canCreate = () => allowed() && (platform || context().accountKind === 'reseller');
  const platformId = () => state.boot?.workspaces?.find(item => item.platformWorkspace)?.id || 'mep-demo';
  const ownOperation = account => allowed() && (account.id === context().workspaceId || (state.boot?.workspaces || []).some(item => item.id === account.id && !item.supportGrantId));
  const canRequestOperationalAccess = account => allowed() && state.boot?.session?.platformOwner === true && !ownOperation(account) && typeof onOperationalAccess === 'function';
  const canRename = account => allowed() && (platform || account.id === context().workspaceId);
  const inScope = account => platform || account.id === context().workspaceId || account.parentWorkspaceId === context().workspaceId;
  const modalPanel = () => getModal()?.querySelector?.('[data-accounts-panel]');
  const shown = record => Boolean(record && current(record.key) && getModal()?.open !== false && modalPanel()?.dataset?.accountsToken === record.token);
  const headers = () => ({ 'X-Elozi-Workspace': context().workspaceId });
  function abortReads() { for (const controller of controllers.values()) controller.abort(); controllers.clear(); }
  function closeOwn() { if (view && modalPanel()?.dataset?.accountsToken === view.token) getModal()?.close?.(); view = null; }
  function reset() { sequence++; abortReads(); closeOwn(); snapshot = null; loaded = ''; error = ''; loading = false; scope = ''; pageToken++; filters = { q: '', kind: 'all', state: 'all', offset: 0, limit: 25 }; }
  function sync(mode = platform) {
    if (platform !== Boolean(mode)) { reset(); platform = Boolean(mode); }
    const expected = key();
    if (scope !== expected) { reset(); scope = expected; }
    return expected;
  }
  getModal()?.addEventListener?.('close', () => { view = null; controllers.get('detail')?.abort(); controllers.get('parents')?.abort(); });
  function controller(kind) { controllers.get(kind)?.abort(); const value = new AbortController(); controllers.set(kind, value); return value; }
  function options(kind) { return { method: 'GET', headers: headers(), signal: controller(kind).signal }; }
  function accountDTO(value) {
    if (!value || !idValid(value.id) || !Object.hasOwn(kindNames, value.accountKind) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || !Number.isSafeInteger(value.version) || value.version < 1 || value.parentWorkspaceId !== null && value.parentWorkspaceId !== undefined && !idValid(value.parentWorkspaceId)) throw new Error('O servidor não confirmou os dados da conta.');
    const lifecycle = value.lifecycle || { state: 'active', canManage: false };
    if (!Object.hasOwn(lifecycleNames, lifecycle.state) || typeof lifecycle.canManage !== 'boolean') throw new Error('O servidor não confirmou o estado comercial da conta.');
    return { id: value.id, name: value.name, accountKind: value.accountKind, parentWorkspaceId: value.parentWorkspaceId ?? null, version: value.version, createdAt: value.createdAt, counts: { ...value.counts }, onboarding: { ...value.onboarding }, lifecycle: { ...lifecycle } };
  }
  function listDTO(result) {
    if (!Array.isArray(result?.accounts) || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.offset) || result.offset < 0 || !Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 100 || result.accounts.length > result.limit) throw new Error('O servidor não confirmou a página de contas.');
    const accounts = result.accounts.map(accountDTO);
    if (new Set(accounts.map(account => account.id)).size !== accounts.length || accounts.some(account => !inScope(account))) throw new Error('A resposta trouxe contas repetidas ou fora deste acesso.');
    return { accounts, total: result.total, offset: result.offset, limit: result.limit, summary: { ...result.summary } };
  }
  function failAccess(failure) { if (![401, 403].includes(failure.status)) return false; snapshot = null; loaded = ''; closeOwn(); error = failure.message || 'Este acesso não permite consultar as contas.'; return true; }
  async function load(mode = platform) {
    const expected = sync(mode); if (!allowed()) { reset(); return false; }
    const ticket = ++sequence; loading = true; error = '';
    const query = new URLSearchParams({ q: filters.q, kind: filters.kind, state: filters.state || 'all', offset: String(filters.offset), limit: String(filters.limit) });
    try {
      const result = await api(`${platform ? '/api/platform/accounts' : '/api/accounts'}?${query}`, options('list'));
      if (!current(expected) || ticket !== sequence) return false;
      snapshot = listDTO(result); filters.offset = snapshot.offset; loaded = expected; return true;
    } catch (failure) { if (current(expected) && ticket === sequence) { if (!failAccess(failure)) { snapshot = null; loaded = ''; error = failure.message || 'Não foi possível consultar as contas.'; } } return false; }
    finally { if (ticket === sequence) { loading = false; if (current(expected)) render(); } }
  }
  /** Summary of the loaded directory (Plataforma › Visão): {summary, total, loading, error} or null. */
  function summary(mode = true) {
    if (Boolean(mode) !== platform || !allowed()) return null;
    const data = loaded === key() ? snapshot : null;
    return { summary: data ? { ...data.summary } : null, total: data?.total ?? null, loading, error: error ? translateError(error) : '' };
  }
  const button = (action, label, { id = '', primary = false, disabled = false, modal = false, variant = '' } = {}) => i18nHtml`<button type="button" class="ui-btn ui-btn--${variant || (primary ? 'primary' : 'secondary')} ui-btn--md" data-accounts-action="${action}" ${id ? `data-id="${e(id)}"` : ''} ${modal ? `data-accounts-token="${view?.token || ''}"` : `data-accounts-page-token="${pageToken}"`} ${disabled ? 'disabled' : ''}><span class="ui-btn__label">${label}</span></button>`;
  function attention(c) {
    if (platform || c.accountKind !== 'reseller') return '';
    const entry = peekHomeData(portfolioKey(c.workspaceId, c.userId));
    if (!entry) return '';
    const head = h`<div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="accounts-attention-title">${glyph('bell')}${i18nT('Clientes que precisam de você')}</h2><p class="pg-settings__muted">${i18nT('Clientes com o administrador inativo ou sem canal conectado.')}</p></div></div>`;
    if (!entry.value) return entry.state === 'error' ? '' : h`<section class="pg-settings__section" aria-labelledby="accounts-attention-title">${head}${skeleton({ lines: 2, label: i18nT('Carregando a carteira…') })}</section>`;
    const model = portfolioModel(entry.value, c.workspaceId, { now: Date.now() });
    const body = model.attention.length ? h`<ul class="pg-settings__attention">${model.attention.slice(0, 6).map(client => h`<li><a class="pg-settings__attention-link" href="${accountHash(client.id)}"><strong class="pg-settings__strong">${client.name || i18nT('Conta sem nome')}</strong><span class="pg-settings__muted">${client.reasons.map(reason => reasonNames[reason]).join(' · ')}</span></a></li>`)}</ul>`
      : h`<p class="pg-settings__text">${glyph('check')} ${model.partial ? i18nT('Nenhum dos clientes carregados precisa de você agora.') : i18nT('Nenhum cliente precisa de você agora.')}</p>`;
    return h`<section class="pg-settings__section" data-tone="${model.attention.length ? 'warning' : ''}" aria-labelledby="accounts-attention-title">${head}${body}${model.partial ? h`<p class="pg-settings__muted">${i18nT('Leitura parcial: {loaded} de {total} contas carregadas.', { loaded: number(model.loaded), total: number(model.total) })}</p>` : ''}</section>`;
  }
  function markup(mode = false) {
    const expected = sync(mode); if (!allowed()) return '';
    const c = context(), data = loaded === expected ? snapshot : null, rows = data?.accounts || [];
    // summary.total is computed over the authorized access before search, kind and state filters.
    const accessTotal = data?.summary?.total, hasAccessTotal = Number.isSafeInteger(accessTotal) && accessTotal >= 0;
    const metrics = [[i18nT(hasAccessTotal || !data ? 'Contas neste acesso' : 'Contas neste filtro'), hasAccessTotal ? accessTotal : data?.total], [i18nT('Pessoas ativas'), data?.summary?.activeUsers], [i18nT('Canais conectados'), data?.summary?.connectedChannels], [i18nT('Agentes ativos'), data?.summary?.activeAgents]];
    const start = rows.length ? data.offset + 1 : 0, end = data ? data.offset + rows.length : 0;
    const title = platform ? i18nT('Contas da plataforma') : c.accountKind === 'business' ? i18nT('Sua empresa') : i18nT('Sua conta e seus clientes');
    const lead = platform ? i18nT('Revendas e empresas, com cada operação independente.') : i18nT('O vínculo comercial mantém cada workspace e seus acessos separados.');
    const actions = h`${raw(button('refresh', i18nT('Atualizar')))}${canCreate() ? raw(button('create', i18nT('Criar conta'), { primary: true })) : ''}`;
    const select = (label, name, entries, value) => h`<label class="pg-settings__field pg-settings__field--narrow">${label}<select class="pg-settings__input" name="${name}">${entries.map(([id, text]) => h`<option value="${id}"${raw(value === id ? ' selected' : '')}>${text}</option>`)}</select></label>`;
    const parentName = account => account.parentWorkspaceId ? rows.find(parent => parent.id === account.parentWorkspaceId)?.name || (account.parentWorkspaceId === c.workspaceId ? state.boot?.reseller?.name || i18nT('Sua conta') : i18nT('Conta comercial vinculada')) : account.accountKind === 'platform' ? i18nT('Conta da plataforma') : i18nT('Vínculo não registrado');
    const body = rows.map(account => {
      const done = steps.filter(([field]) => account.onboarding[field] === true).length;
      return h`<tr><th scope="row"><div class="pg-settings__identity"><span class="pg-settings__monogram" aria-hidden="true">${account.name.slice(0, 2).toLocaleUpperCase(getLocale())}</span><div class="pg-settings__identity-text"><strong>${account.name}</strong><span class="pg-settings__sub">${account.createdAt && String(account.createdAt).trim() ? i18nT('Criada em ') + date(account.createdAt) : i18nT('Cadastro anterior')}</span></div></div></th><td data-label="${i18nT('Tipo e vínculo')}">${uiBadge(kindNames[account.accountKind], account.accountKind === 'reseller' ? 'accent' : 'neutral')} ${uiBadge(lifecycleNames[account.lifecycle.state] + (account.lifecycle.trialExpired ? i18nT(' · teste encerrado') : ''), lifecycleTone(account.lifecycle.state))}<span class="pg-settings__sub">${parentName(account)}</span></td><td data-label="${i18nT('Operação')}"><strong>${number(account.counts.tenants)} ${account.counts.tenants === 1 ? i18nT('unidade') : i18nT('unidades')}</strong><span class="pg-settings__sub">${number(account.counts.users)} ${account.counts.users === 1 ? i18nT('pessoa') : i18nT('pessoas')} · ${number(account.counts.connectedChannels)} ${account.counts.connectedChannels === 1 ? i18nT('canal conectado') : i18nT('canais conectados')}</span></td><td data-label="${i18nT('Configuração')}"><div class="pg-settings__progress">${progress({ value: done, max: 5, label: i18nT('Etapas confirmadas') })}<span>${i18nT('{done}/5 etapas confirmadas', { done })}</span></div></td><td class="pg-settings__cell-actions"><div class="pg-settings__row-actions">${raw(button('detail', i18nT('Gerenciar'), { id: account.id }))}${typeof onUsage === 'function' ? raw(button('usage', i18nT('Ver consumo'), { id: account.id, variant: 'ghost' })) : ''}${ownOperation(account) ? raw(button('operation', i18nT('Abrir operação'), { id: account.id, variant: 'ghost' })) : ''}</div></td></tr>`;
    });
    const empty = h`<tr><td colspan="5" class="pg-settings__empty-cell">${emptyState({ icon: 'briefcase', title: loading ? i18nT('Carregando contas…') : error ? i18nT('Consulta não confirmada') : i18nT('Nenhuma conta neste filtro'), body: loading || error ? i18nT('Os registros aparecem após a confirmação do servidor.') : canCreate() ? i18nT('Crie uma conta e convide o responsável para preparar a operação.') : i18nT('A conta comercial da sua empresa aparecerá aqui.'), level: 3 })}</td></tr>`;
    return String(h`<div class="pg-settings pg-settings--accounts">
      ${pageHeader({ title, lead, actions, eyebrow: platform ? i18nT('Administração da plataforma') : '' })}
      <dl class="pg-settings__stats">${metrics.map(([label, value], index) => h`<div class="pg-settings__stat"${raw(index ? '' : ' data-tone="accent"')}><dt class="pg-settings__stat-label">${label}</dt><dd class="pg-settings__stat-value">${number(value)}</dd></div>`)}</dl>
      ${attention(c)}
      <section class="pg-settings__section pg-settings__section--flush" aria-label="${i18nT('Contas comerciais')}" aria-busy="${loading ? 'true' : 'false'}">
        <form class="pg-settings__toolbar" data-accounts-form="filter" data-accounts-page-token="${pageToken}" role="search"><label class="pg-settings__search">${glyph('search')}<span class="sr-only">${i18nT('Buscar contas por nome')}</span><input class="pg-settings__input" name="q" value="${filters.q}" maxlength="200" placeholder="${i18nT('Buscar conta por nome')}" autocomplete="off"/></label>${select(i18nT('Tipo da conta'), 'kind', [['all', i18nT('Todos os tipos')], ['reseller', i18nT('Revendas')], ['business', i18nT('Empresas')]], filters.kind)}${select(i18nT('Estado comercial'), 'state', [['all', i18nT('Todos os estados')], ...Object.entries(lifecycleNames)], filters.state)}${uiButton({ label: i18nT('Filtrar'), type: 'submit' })}<p class="pg-settings__total" role="status">${data ? data.total === 1 ? `${number(data.total)} ${i18nT('Conta').toLocaleLowerCase(getLocale())}` : i18nT('{count} contas', { count: number(data.total) }) : loading ? i18nT('Consultando…') : i18nT('Consulta pendente')}</p></form>
        ${error ? h`<div class="pg-settings__section-head">${banner({ tone: 'warning', title: translateError(error), live: 'assertive' })}${raw(button('refresh', i18nT('Tentar novamente')))}</div>` : ''}
        ${loading ? h`<p class="pg-settings__pager" role="status">${i18nT('Consultando contas deste acesso…')}</p>` : ''}
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><caption class="sr-only">${i18nT('Contas comerciais')}</caption><thead><tr><th scope="col">${i18nT('Conta')}</th><th scope="col">${i18nT('Tipo e vínculo')}</th><th scope="col">${i18nT('Operação')}</th><th scope="col">${i18nT('Configuração')}</th><th scope="col"><span class="sr-only">${i18nT('Ações')}</span></th></tr></thead><tbody>${rows.length ? body : empty}</tbody></table></div>
        <nav class="pg-settings__pager" aria-label="${i18nT('Páginas de contas')}"><span role="status">${data?.total === 1 ? `${i18nT('{start}–{end} de {total}', { start: number(start), end: number(end), total: number(data.total) })} ${i18nT('Conta').toLocaleLowerCase(getLocale())}` : i18nT('{start}–{end} de {total} contas', { start: number(start), end: number(end), total: number(data?.total) })}</span><div class="pg-settings__cluster">${raw(button('previous', i18nT('Anterior'), { disabled: !data || data.offset === 0 || loading }))}${raw(button('next', i18nT('Próxima'), { disabled: !data || data.offset + data.accounts.length >= data.total || loading }))}</div></nav>
      </section>
    </div>`);
  }
  function show(title, subtitle, html) { openModal(title, subtitle, i18nHtml`<div class="pg-settings__dialog" data-accounts-panel data-accounts-token="${view.token}">${html}</div>`); }
  function lifecycleMarkup(account) {
    const value = account.lifecycle;
    return i18nHtml`<section class="pg-settings__stack"><div class="pg-settings__card-head"><h3 class="pg-settings__h3">Estado comercial</h3><span class="ui-badge ui-badge--${lifecycleTone(value.state)}">${lifecycleNames[value.state]}${value.trialExpired ? i18nT(' · teste encerrado') : ''}</span></div>${value.state === 'trial' ? i18nHtml`<p class="pg-settings__text">Teste até ${e(value.trialEndsAt || '—')}.</p>` : ''}<p class="pg-settings__muted">Organiza a carteira comercial. O acesso, os canais e as cobranças seguem suas próprias configurações.</p>${value.canManage ? i18nHtml`<details class="pg-settings__details"><summary>Alterar estado comercial</summary><form class="pg-settings__form" data-accounts-form="lifecycle" data-accounts-token="${view.token}"><label class="pg-settings__field">Estado<select class="pg-settings__input" name="state">${Object.entries(lifecycleNames).map(([id, label]) => i18nHtml`<option value="${id}" ${value.state === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="pg-settings__field">Fim do teste<input class="pg-settings__input" name="trialEndsAt" type="date" value="${e(value.trialEndsAt || '')}"/><span class="pg-settings__hint">Preencha somente quando escolher “Em teste”.</span></label><label class="pg-settings__field">Motivo<input class="pg-settings__input" name="reason" maxlength="500" required placeholder="Registre o acordo ou a mudança"/></label><p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--primary ui-btn--md" type="submit"><span class="ui-btn__label">Salvar estado</span></button>${button('detail-refresh', i18nT('Atualizar dados'), { modal: true })}</div></form></details>` : ''}</section>`;
  }
  function detailMarkup(account, notice = '') {
    const counts = [['Unidades', 'tenants'], ['Pessoas', 'users'], ['Canais', 'channels'], ['Conectados', 'connectedChannels'], ['Agentes', 'agents'], ['Agentes ativos', 'activeAgents']].map(row => i18nLabels(row));
    const done = steps.filter(([key]) => account.onboarding[key] === true).length;
    const actions = `${typeof onInvite === 'function' ? button('invite', i18nT('Convidar administrador'), { modal: true, primary: account.onboarding.administratorActive !== true }) : ''}${typeof onFinance === 'function' ? button('finance', i18nT('Financeiro'), { modal: true }) : ''}${typeof onUsage === 'function' ? button('usage', i18nT('Ver consumo'), { modal: true }) : ''}${typeof onSupport === 'function' ? button('support', i18nT('Suporte com prazo'), { modal: true }) : ''}${typeof onDomains === 'function' ? button('domains', i18nT('Domínio e HTTPS'), { modal: true }) : ''}${typeof onDelete === 'function' && platform && account.accountKind !== 'platform' ? button('delete', i18nT('Excluir conta'), { modal: true }) : ''}`;
    const operation = ownOperation(account) ? button('operation', i18nT('Abrir operação'), { id: account.id, modal: true }) : i18nHtml`${canRequestOperationalAccess(account) ? i18nHtml`<div class="pg-settings__note">${button('operational-access', i18nT('Acessar como administrador'), { modal: true })}<span>Revise o acesso à sua própria conta de administrador. A concessão será registrada na auditoria.</span></div>` : ''}<p class="pg-settings__muted">O vínculo comercial não concede acesso ao atendimento deste workspace.</p>`;
    return i18nHtml`<div class="pg-settings__context"><span class="ui-badge ui-badge--${account.accountKind === 'reseller' ? 'accent' : 'neutral'}">${kindNames[account.accountKind]}</span><span>${account.parentWorkspaceId ? i18nT('Vínculo comercial · operação independente') : account.accountKind === 'platform' ? i18nT('Administração da plataforma') : i18nT('Vínculo não registrado')} · versão ${account.version}</span></div>${notice ? i18nHtml`<p class="pg-settings__status" role="status">${e(notice)}</p>` : ''}<dl class="pg-settings__counts">${counts.map(([label, field]) => i18nHtml`<div><dt><span>${label}</span></dt><dd><strong>${number(account.counts[field])}</strong></dd></div>`).join('')}</dl><section class="pg-settings__stack" aria-label="Preparação da conta"><div class="pg-settings__card-head"><h3 class="pg-settings__h3">Preparar a operação</h3><span class="pg-settings__muted">${done}/5 confirmadas</span></div><ol class="pg-settings__checklist">${steps.map(([field, label, help]) => i18nHtml`<li class="pg-settings__step-row" data-complete="${account.onboarding[field] === true}"><span class="pg-settings__step-symbol" aria-hidden="true">${account.onboarding[field] === true ? '✓' : '·'}</span><div><strong class="pg-settings__strong">${label}</strong><span class="pg-settings__muted">${help}</span></div><span class="pg-settings__step-state">${account.onboarding[field] === true ? i18nT('Confirmado') : account.onboarding[field] === false ? i18nT('Pendente') : i18nT('A confirmar')}</span></li>`).join('')}</ol></section><div class="pg-settings__cluster">${actions}${operation}</div>${lifecycleMarkup(account)}${canRename(account) ? i18nHtml`<details class="pg-settings__details"><summary>Editar nome da conta</summary><form class="pg-settings__form" data-accounts-form="rename" data-accounts-token="${view.token}"><label class="pg-settings__field">Nome da conta<input class="pg-settings__input" name="name" value="${e(account.name)}" maxlength="80" required/></label><p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--primary ui-btn--md" type="submit"><span class="ui-btn__label">Salvar nome</span></button>${button('detail-refresh', i18nT('Atualizar dados'), { modal: true })}</div></form></details>` : ''}<p class="pg-settings__muted">Filiais são unidades dentro desta empresa. Criar vínculos não amplia os acessos das pessoas ou dos agentes.</p><p class="form-error pg-settings__error" role="alert"></p>`;
  }
  function showDetail(account, notice = '') { view = { type: 'detail', key: key(), token: String(++modalToken), account }; show(account.name, i18nT('Conta comercial e preparação da operação'), detailMarkup(account, notice)); }
  async function detail(id, notice = '') {
    const expected = sync(); if (!allowed()) return;
    view = { type: 'loading', key: expected, token: String(++modalToken), id };
    const record = view; show(i18nT('Conta comercial'), i18nT('Consultando dados deste acesso'), i18nMarkup('<p class="pg-settings__muted" role="status">Carregando a conta…</p>'));
    try {
      const result = await api('/api/accounts/' + encodeURIComponent(id), options('detail'));
      if (!shown(record)) return;
      const account = accountDTO(result.account); if (account.id !== id || !inScope(account)) throw new Error('A resposta não corresponde à conta escolhida.');
      showDetail(account, notice);
    } catch (failure) { if (shown(record)) { if (!failAccess(failure)) show(i18nT('Consulta não confirmada'), i18nT('Conta comercial'), i18nHtml`<p class="form-error pg-settings__error" role="alert">${e(translateError(failure.message))}</p>${button('detail-retry', i18nT('Tentar novamente'), { id, modal: true })}`); } }
  }
  /** Detail of an account opened by a link (#accounts/<accountId>): same checks as the Gerenciar button. */
  async function open(id) {
    if (!idValid(id)) throw new Error('Abra uma conta disponível neste acesso.');
    sync(); if (!allowed()) throw new Error('Este acesso não permite consultar as contas.');
    await detail(id);
  }
  function field(label, name, value, help = '') { return i18nHtml`<label class="pg-settings__field">${label}<input class="pg-settings__input" name="${name}" value="${e(value)}" maxlength="80" autocomplete="off" required/>${help ? i18nHtml`<span class="pg-settings__hint">${help}</span>` : ''}</label>`; }
  function wizardMarkup() {
    const record = view, draft = record.draft, titles = [i18nT('Tipo de conta'), i18nT('Identidade e empresa'), i18nT('Revisar e criar')];
    const platformName = draft.accountKind === 'reseller' || !platform ? i18nT('Plataforma') : i18nT('Plataforma · cliente direto');
    let body;
    if (record.step === 0) body = i18nHtml`<div class="pg-settings__options">${(platform ? ['business', 'reseller'] : ['business']).map(kind => i18nHtml`<label class="pg-settings__option"><input type="radio" name="accountKind" value="${kind}" ${draft.accountKind === kind ? 'checked' : ''} required/><span><strong class="pg-settings__strong">${kind === 'business' ? i18nT('Empresa') : i18nT('Revenda white label')}</strong><span class="pg-settings__muted">${kind === 'business' ? i18nT('Uma empresa com matriz, filiais, equipe e canais próprios.') : i18nT('Uma revenda com marca própria e contas de clientes independentes.')}</span></span></label>`).join('')}</div><p class="pg-settings__muted">A conta terá workspace próprio. O vínculo comercial não libera conversas ou credenciais de outra conta.</p>`;
    else if (record.step === 1) body = `${field(i18nT('Nome da conta'), 'name', draft.name)}${platform && draft.accountKind === 'business' ? i18nHtml`<label class="pg-settings__field">Conta responsável<select class="pg-settings__input" name="parentWorkspaceId">${[{ id: platformId(), name: i18nT('Plataforma · cliente direto') }, ...record.parents].map(parent => i18nHtml`<option value="${e(parent.id)}" ${draft.parentWorkspaceId === parent.id ? 'selected' : ''}>${e(parent.name)}</option>`).join('')}</select><span class="pg-settings__hint">A empresa mantém seus próprios dados e acessos.</span></label>${record.parentsMore ? i18nMarkup('<p class="pg-settings__muted">As primeiras 100 revendas estão disponíveis. Para outra revenda, abra a criação no workspace autorizado dela.</p>') : ''}${record.parentsError ? i18nHtml`<p class="pg-settings__status" role="status">${e(translateError(record.parentsError))} O vínculo direto com a plataforma continua disponível.</p>` : ''}` : i18nHtml`<div class="pg-settings__note"><span>Conta responsável</span><strong>${e(platform ? platformName : state.boot?.reseller?.name || i18nT('Sua revenda'))}</strong></div>`}${field(i18nT('Empresa inicial / matriz'), 'initialTenantName', draft.initialTenantName, i18nT('Depois você poderá adicionar filiais dentro deste workspace.'))}${field(i18nT('Segmento'), 'segment', draft.segment)}`;
    else body = i18nHtml`<dl class="pg-settings__facts">${[[i18nT('Tipo'), kindNames[draft.accountKind]], [i18nT('Conta'), draft.name], [i18nT('Responsável comercial'), platform ? draft.parentWorkspaceId === platformId() ? platformName : record.parents.find(parent => parent.id === draft.parentWorkspaceId)?.name : state.boot?.reseller?.name || i18nT('Sua revenda')], [i18nT('Empresa inicial'), draft.initialTenantName], [i18nT('Segmento'), draft.segment]].map(([label, value]) => i18nHtml`<div><dt>${label}</dt><dd>${e(value)}</dd></div>`).join('')}</dl><div class="pg-settings__note"><strong>O próximo passo é convidar o responsável.</strong><span>A criação não cadastra pessoas, senhas ou preços. Canais, filiais, agentes e contrato serão configurados na conta criada.</span></div>`;
    return i18nHtml`<ol class="pg-settings__steps" aria-label="Etapas do cadastro">${titles.map((label, index) => i18nHtml`<li ${record.step === index ? 'aria-current="step"' : ''} data-done="${index < record.step}"><span>${index + 1}</span>${label}</li>`).join('')}</ol><form class="pg-settings__form" data-accounts-form="wizard" data-accounts-token="${record.token}">${body}<p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions">${record.step > 0 ? button('wizard-back', i18nT('Voltar'), { modal: true }) : button('close', i18nT('Cancelar'), { modal: true })}<button class="ui-btn ui-btn--primary ui-btn--md" type="submit" ${busy ? 'disabled' : ''}><span class="ui-btn__label">${record.step === 2 ? i18nT('Criar conta e empresa') : i18nT('Continuar')}</span></button></div></form>`;
  }
  function showWizard() { show(i18nT('Criar conta'), i18nT('Configure a estrutura antes de convidar pessoas'), wizardMarkup()); }
  async function create() {
    if (!canCreate()) throw new Error('Este acesso não permite criar contas comerciais.');
    if (pending.has(key())) { showPending(pending.get(key())); return; }
    view = { type: 'wizard', key: key(), token: String(++modalToken), step: 0, parents: [], parentsLoading: platform, parentsMore: false, parentsError: '', draft: { accountKind: 'business', parentWorkspaceId: platform ? platformId() : context().workspaceId, name: '', initialTenantName: '', segment: 'Atendimento' } };
    const record = view; showWizard(); if (!platform) return;
    try {
      const result = await api('/api/platform/accounts?kind=reseller&offset=0&limit=100', options('parents'));
      if (!shown(record)) return;
      const list = listDTO(result); if (list.accounts.some(account => account.accountKind !== 'reseller')) throw new Error('A consulta não confirmou as revendas disponíveis.');
      record.parents = list.accounts.map(account => ({ id: account.id, name: account.name })); record.parentsMore = list.total > list.accounts.length;
    } catch (failure) { if (shown(record)) { if (failAccess(failure)) return; record.parentsError = failure.message; } }
    finally { record.parentsLoading = false; }
    // The parent selector is rendered when the user advances; never replace typed input.
  }
  function cleanName(value, label) { const name = String(value ?? '').trim(); if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error(i18nTxt`Informe ${label} com até 80 caracteres.`); return name; }
  function capture(form, validate = false) {
    const values = new FormData(form), draft = view.draft;
    if (view.step === 0) {
      const kind = values.get('accountKind'); if (!['business', 'reseller'].includes(kind) || !platform && kind !== 'business') throw new Error('Escolha um tipo de conta permitido.');
      draft.accountKind = kind; if (kind === 'reseller') draft.parentWorkspaceId = platformId();
    }
    if (view.step === 1) {
      for (const name of ['name', 'initialTenantName', 'segment']) draft[name] = String(values.get(name) ?? '').trim();
      if (platform && draft.accountKind === 'business') draft.parentWorkspaceId = String(values.get('parentWorkspaceId') ?? '');
      if (validate) {
        draft.name = cleanName(draft.name, i18nT('o nome da conta')); draft.initialTenantName = cleanName(draft.initialTenantName, i18nT('a empresa inicial')); draft.segment = cleanName(draft.segment, i18nT('o segmento'));
        const permitted = platform ? [platformId(), ...view.parents.map(parent => parent.id)] : [context().workspaceId];
        if (!permitted.includes(draft.parentWorkspaceId)) throw new Error('Escolha uma conta responsável disponível neste acesso.');
      }
    }
  }
  function showPending(intent) {
    view = { type: 'pending', key: key(), token: String(++modalToken), intent };
    show(i18nT('Verificar alteração'), i18nT('A resposta não confirmou a operação'), i18nHtml`<div class="pg-settings__note"><strong>${e(intent.payload.name)}</strong><span>${intent.type === 'create' ? i18nT('Vamos verificar a mesma criação, com o mesmo identificador. Nenhuma segunda conta será criada.') : i18nT('Vamos consultar o cadastro para conferir se o nome foi salvo. A alteração não será enviada novamente.')}</span></div><p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions">${button('close', i18nT('Fechar'), { modal: true })}${button('verify-write', i18nT('Verificar resultado'), { modal: true, primary: true })}</div>`);
  }
  async function write(intent) {
    if (busy || !current(intent.key)) return;
    busy = true; pending.set(intent.key, intent); const record = view;
    try {
      const result = await api(intent.type === 'create' ? '/api/accounts' : '/api/accounts/' + encodeURIComponent(intent.account.id) + (intent.type === 'lifecycle' ? '/lifecycle' : ''), { method: intent.type === 'create' ? 'POST' : 'PATCH', headers: headers(), body: JSON.stringify(intent.payload) });
      const account = accountDTO(result.account);
      if (intent.type === 'lifecycle' ? account.id !== intent.account.id || account.lifecycle.state !== intent.payload.state || intent.payload.state === 'trial' && account.lifecycle.trialEndsAt !== intent.payload.trialEndsAt || account.version < intent.account.version : account.name !== intent.payload.name || intent.type === 'create' && (account.accountKind !== intent.payload.accountKind || account.parentWorkspaceId !== intent.payload.parentWorkspaceId || account.onboarding.companyCreated !== true || !Number.isSafeInteger(account.counts.tenants) || account.counts.tenants < 1) || intent.type === 'rename' && (account.id !== intent.account.id || account.version <= intent.account.version || account.accountKind !== intent.account.accountKind || account.parentWorkspaceId !== intent.account.parentWorkspaceId)) throw new Error('A resposta não confirmou a alteração solicitada.');
      pending.delete(intent.key);
      if (!current(intent.key) || !shown(record)) return;
      const notice = intent.type === 'create' ? i18nT('Conta criada. Convide o responsável para continuar.') : intent.type === 'lifecycle' ? i18nT('Estado comercial confirmado.') : i18nT('Nome atualizado.');
      showDetail(account, notice); toast(notice);
      await load(platform);
    } catch (failure) {
      const definitive = Number.isInteger(failure.status) && failure.status >= 400 && failure.status < 500;
      if (definitive) pending.delete(intent.key);
      if (!current(intent.key) || !shown(record)) return;
      if (failAccess(failure)) { render(); toast(translateError(failure.message), true); return; }
      if (definitive) { const target = modalPanel()?.querySelector?.('.form-error') || getModal()?.querySelector?.('.form-error'); if (target) target.textContent = failure.status === 409 ? translateError(failure.message) + i18nT(' Atualize os dados antes de tentar novamente.') : translateError(failure.message); toast(translateError(failure.message), true); }
      else showPending(intent);
    } finally { busy = false; }
  }
  async function verify() {
    const record = view, intent = record?.intent;
    if (!intent || pending.get(intent.key) !== intent || !current(intent.key)) throw new Error('Retome a verificação no acesso e na conta de origem.');
    if (intent.type === 'create') { await write(intent); return; }
    if (busy) return; busy = true;
    try {
      const result = await api('/api/accounts/' + encodeURIComponent(intent.account.id), options('detail')); if (!shown(record)) return;
      const account = accountDTO(result.account); if (account.id !== intent.account.id || !inScope(account)) throw new Error('A resposta não corresponde à conta alterada.');
      const confirmed = intent.type === 'lifecycle' ? account.lifecycle.state === intent.payload.state && (intent.payload.state !== 'trial' || account.lifecycle.trialEndsAt === intent.payload.trialEndsAt) && account.version >= intent.account.version : account.name === intent.payload.name && account.version > intent.account.version;
      pending.delete(intent.key); showDetail(account, confirmed ? intent.type === 'lifecycle' ? i18nT('Estado comercial confirmado.') : i18nT('Nome atualizado e confirmado.') : i18nT('Os dados atuais estão abaixo. Revise antes de alterar novamente.'));
    } catch (failure) { if (shown(record)) { if (failAccess(failure)) render(); else { const target = getModal()?.querySelector?.('.form-error'); if (target) target.textContent = translateError(failure.message); } } }
    finally { busy = false; }
  }
  async function handleAction(node) {
    const action = node?.dataset?.accountsAction; if (!action) return false;
    sync(); if (!allowed() || node.disabled || busy) return true;
    const modal = ['close', 'wizard-back', 'detail-refresh', 'detail-retry', 'invite', 'finance', 'support', 'domains', 'delete', 'operational-access', 'verify-write'].includes(action) || ['operation', 'usage'].includes(action) && node.dataset.accountsToken;
    if (modal ? !shown(view) || node.dataset.accountsToken !== view.token : node.dataset.accountsPageToken !== String(pageToken)) return true;
    const expected = key();
    try {
      if (action === 'close') { closeOwn(); return true; }
      if (action === 'refresh') { await load(platform); return true; }
      if (action === 'create') { await create(); return true; }
      if (action === 'previous' || action === 'next') { if (loaded !== expected || !snapshot) return true; filters.offset = action === 'previous' ? Math.max(0, snapshot.offset - snapshot.limit) : snapshot.offset + snapshot.limit; await load(platform); return true; }
      if (action === 'wizard-back') { if (view.type !== 'wizard' || view.step < 1) return true; const form = node.closest?.('form'); if (form) capture(form); view.step--; showWizard(); return true; }
      if (action === 'verify-write') { await verify(); return true; }
      if (action === 'detail-refresh' || action === 'detail-retry') { const id = view.account?.id || view.id; if (id) await detail(id); return true; }
      const account = modal ? view.account : loaded === expected && snapshot?.accounts.find(item => item.id === node.dataset.id);
      if (!account || !inScope(account)) throw new Error('Atualize as contas antes de abrir esta ação.');
      if (action === 'detail') { await detail(account.id); return true; }
      if (action === 'operation') { if (!ownOperation(account) || typeof changeWorkspace !== 'function') throw new Error('Este acesso comercial não permite entrar no atendimento da conta.'); closeOwn(); await changeWorkspace(account.id, null); return true; }
      if (action === 'operational-access') { if (!canRequestOperationalAccess(account)) throw new Error('Somente o administrador da plataforma pode revisar seu próprio acesso à operação.'); closeOwn(); await onOperationalAccess({ ...account, counts: { ...account.counts }, onboarding: { ...account.onboarding } }); return true; }
      const callback = { invite: onInvite, finance: onFinance, usage: onUsage, support: onSupport, domains:onDomains, delete:onDelete }[action];
      if (typeof callback === 'function') { closeOwn(); await callback({ ...account, counts: { ...account.counts }, onboarding: { ...account.onboarding } }); return true; }
      return false;
    } catch (failure) { if (current(expected)) { const target = getModal()?.querySelector?.('.form-error'); if (target && shown(view)) target.textContent = translateError(failure.message); toast(translateError(failure.message), true); } return true; }
  }
  async function submit(form) {
    const type = form?.dataset?.accountsForm; if (!type) return false;
    sync(); if (!allowed() || busy) return true;
    if (type === 'filter') {
      if (form.dataset.accountsPageToken !== String(pageToken)) return true;
      const values = new FormData(form), q = String(values.get('q') || '').trim(), kind = String(values.get('kind') || 'all'), commercialState = String(values.get('state') || 'all');
      if (q.length > 200 || /[\x00-\x1f\x7f]/.test(q) || !['all', 'business', 'reseller'].includes(kind) || !['all', ...Object.keys(lifecycleNames)].includes(commercialState)) { toast(i18nT('Informe filtros válidos para as contas.'), true); return true; }
      filters = { ...filters, q, kind, state: commercialState, offset: 0 }; await load(platform); return true;
    }
    if (!shown(view) || form.dataset.accountsToken !== view.token) return true;
    const record = view, target = form.querySelector?.('.form-error'), submitButton = form.querySelector?.('[type="submit"]');
    if (target) target.textContent = '';
    try {
      if (type === 'wizard' && record.type === 'wizard') {
        if (!canCreate()) throw new Error('Este acesso não permite criar contas.');
        if (record.step === 0 && record.parentsLoading) throw new Error('Aguarde a consulta das revendas antes de continuar.');
        if (record.step < 2) { capture(form, true); record.step++; showWizard(); return true; }
        if (pending.has(record.key)) { showPending(pending.get(record.key)); return true; }
        const payload = { ...record.draft, requestId: globalThis.crypto.randomUUID() };
        if (submitButton) submitButton.disabled = true;
        await write({ type: 'create', key: record.key, payload }); return true;
      }
      if (type === 'rename' && record.type === 'detail') {
        if (!canRename(record.account)) throw new Error('O nome desta conta pertence ao administrador responsável.');
        if (pending.has(record.key)) { showPending(pending.get(record.key)); return true; }
        const payload = { name: cleanName(new FormData(form).get('name'), i18nT('o nome da conta')), version: record.account.version };
        if (submitButton) submitButton.disabled = true;
        await write({ type: 'rename', key: record.key, account: record.account, payload }); return true;
      }
      if (type === 'lifecycle' && record.type === 'detail') {
        if (!record.account.lifecycle.canManage) throw new Error('O estado desta conta pertence ao responsável comercial.');
        if (pending.has(record.key)) { showPending(pending.get(record.key)); return true; }
        const values = new FormData(form), next = String(values.get('state') || ''), reason = String(values.get('reason') || '').trim();
        if (!Object.hasOwn(lifecycleNames, next) || !reason || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error('Informe o estado e o motivo da alteração.');
        const payload = { state: next, reason, version: record.account.version, ...(next === 'trial' ? { trialEndsAt: String(values.get('trialEndsAt') || '') } : {}) };
        if (next === 'trial' && !/^\d{4}-\d{2}-\d{2}$/.test(payload.trialEndsAt)) throw new Error('Informe a data final do teste.');
        if (submitButton) submitButton.disabled = true;
        await write({ type: 'lifecycle', key: record.key, account: record.account, payload }); return true;
      }
    } catch (failure) { if (shown(record)) { if (target) target.textContent = translateError(failure.message); toast(translateError(failure.message), true); } }
    finally { if (submitButton && !busy) submitButton.disabled = false; }
    return true;
  }
  return { markup, load, summary, open, handleAction, submit, reset, get loading() { return loading; }, get busy() { return busy; } };
}
