import { t, h, raw, labels, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-platform-users.js';
import './locales-settings.js';
import { button, badge, banner, emptyState, avatar } from './ui.js';
import { glyph } from './icons.js';
import { pageHeader } from './settings-ui.js';

// Plataforma › Usuários (FRONTEND-V2 §8.9, P8): the global directory of people, for the platform owner
// only (outside temporary support). Search, state and pages are answered by the server; the same
// panel opens as a dialog from Configurações › Equipe. Reading it never grants access to an operation.
const STATES = new Set(['all', 'active', 'disabled']);
const LIMIT = 50;
const scopeKey = context => JSON.stringify([context?.userId || '', context?.workspaceId || '', Boolean(context?.platformOwner), context?.supportGrantId || '', context?.kind || '', context?.authorityKey || '']);
const canRead = context => Boolean(context?.platformOwner) && !context?.supportGrantId && context?.kind !== 'service';
const number = value => Number(value || 0).toLocaleString(getLocale());
// Signup (password and Google) generates exactly u_ + a UUID without hyphens.
// Do not treat every u_ prefix as generated: legacy/manual usernames remain readable identities.
const identityText = value => typeof value === 'string' ? value.trim() : '';
function directoryIdentity(user) {
  const name = identityText(user.name), username = identityText(user.username), email = identityText(user.email);
  const generated = /^u_[0-9a-f]{32}$/i.test(username);
  const primary = name || email || (!generated && username) || t('Pessoa');
  const secondary = generated ? email : username || email;
  return { primary, secondary: secondary === primary ? '' : secondary };
}

export function platformUsersQuery({ q = '', state = 'all', offset = 0 } = {}) {
  if (!STATES.has(state) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new TypeError('Invalid directory query');
  return '/api/platform/users?' + new URLSearchParams({ q: String(q).slice(0, 120), state, offset: String(offset), limit: String(LIMIT) });
}

/** The directory panel (page and dialog). Values are escaped by h``; `escape` is kept for callers. */
export function platformUsersMarkup(data, _options, filters = {}, { loading = false, error = '', forbidden = false } = {}) {
  const users = data?.users || [], total = data?.total || 0, offset = data?.offset || 0;
  const names = labels({ reseller: 'Administrador da conta', operator: 'Atendente' });
  const filtered = Boolean(filters.q || filters.state && filters.state !== 'all');
  const blocked = loading || forbidden;
  const clear = button({ label: t('Limpar filtros'), action: 'platform-users-clear', variant: 'ghost', disabled: blocked });
  const rows = users.map(user => { const identity = directoryIdentity(user); return h`<tr><th scope="row"><div class="pg-settings__identity">${avatar({ kind: 'person', name: identity.primary, src: user.avatar, size: 32, presence: user.disabled ? null : user.presence })}<div class="pg-settings__identity-text"><strong>${identity.primary}</strong>${identity.secondary ? h`<span class="pg-settings__sub">${identity.secondary}</span>` : ''}</div></div></th><td data-label="${t('Revenda')}">${user.reseller?.name || t('Revenda')}</td><td data-label="${t('Empresas')}">${(user.tenants || []).map(tenant => tenant.name).join(', ') || t('Nenhuma empresa')}${user.tenantCount > (user.tenants || []).length ? h`<span class="pg-settings__sub">${t('+{count} outras empresas', { count: number(user.tenantCount - user.tenants.length) })}</span>` : ''}</td><td data-label="${t('Papel e estado')}">${user.platformAdmin ? t('Administrador da plataforma') : names[user.role] || user.role}<span class="pg-settings__sub">${badge(user.disabled ? t('Desativado') : t('Ativo'), user.disabled ? 'neutral' : 'success')}</span></td></tr>`; });
  const table = data ? h`<div class="pg-settings__table-wrap" tabindex="0" role="region" aria-label="${t('Pessoas cadastradas na plataforma')}"><table class="pg-settings__table pg-settings__table--cards"><caption class="sr-only">${t('Diretório de pessoas, revendas, empresas e responsabilidades')}</caption><thead><tr><th scope="col">${t('Pessoa')}</th><th scope="col">${t('Revenda')}</th><th scope="col">${t('Empresas')}</th><th scope="col">${t('Papel e estado')}</th></tr></thead><tbody>${users.length ? rows : h`<tr><td colspan="4" class="pg-settings__empty-cell">${emptyState({ icon: 'users', title: t('Nenhuma pessoa encontrada.'), body: filtered ? t('Tente outro nome, usuário ou revenda, ou limpe os filtros.') : t('As pessoas cadastradas na plataforma aparecerão aqui.'), secondary: filtered ? { label: t('Limpar filtros'), action: 'platform-users-clear', disabled: loading } : null, level: 3 })}</td></tr>`}</tbody></table></div>
    <nav class="pg-settings__pager" aria-label="${t('Paginação do diretório')}"><span>${t('Página {page} de {pages}', { page: number(Math.floor(offset / LIMIT) + 1), pages: number(Math.max(1, Math.ceil(total / LIMIT))) })}</span><div class="pg-settings__cluster">${button({ label: t('Anterior'), action: 'platform-users-page', size: 'sm', disabled: !(offset && !blocked), attrs: { 'data-id': String(Math.max(0, offset - LIMIT)) } })}${button({ label: t('Próxima'), action: 'platform-users-page', size: 'sm', disabled: !(data.hasMore && !blocked), attrs: { 'data-id': String(offset + LIMIT) } })}</div></nav>`
    : !loading && !error ? h`<div class="pg-settings__empty-cell">${emptyState({ icon: 'users', title: t('Consulte o diretório global'), body: t('Busque pessoas e confira a revenda, as empresas e a responsabilidade de cada cadastro.'), action: { label: t('Carregar diretório'), action: 'platform-users-refresh' }, level: 3 })}</div>` : '';
  const notice = error ? banner({ tone: 'danger', title: error, body: data ? t('Os resultados abaixo são da última consulta concluída.') : forbidden ? t('Confirme seu acesso de administrador da plataforma antes de consultar novamente.') : '', action: forbidden ? null : { label: t('Tentar novamente'), action: 'platform-users-retry', disabled: loading }, live: 'assertive' }) : '';
  return String(h`<section class="pg-settings__section pg-settings__section--flush" data-platform-users-panel aria-busy="${loading ? 'true' : 'false'}" aria-label="${t('Diretório da plataforma')}">
    <form data-platform-users-form class="pg-settings__toolbar" role="search"><label class="pg-settings__field pg-settings__field--grow">${t('Buscar pessoa ou revenda')}<input class="pg-settings__input" name="q" value="${filters.q || ''}" maxlength="120" placeholder="${t('Nome, usuário ou revenda')}" autocomplete="off"/></label><label class="pg-settings__field pg-settings__field--narrow">${t('Estado')}<select class="pg-settings__input" name="state">${[['all', t('Todos')], ['active', t('Ativos')], ['disabled', t('Desativados')]].map(([value, name]) => h`<option value="${value}"${raw((filters.state || 'all') === value ? ' selected' : '')}>${name}</option>`)}</select></label>${button({ label: t('Buscar'), type: 'submit', variant: 'primary', disabled: blocked })}${filtered ? clear : ''}</form>
    <div class="pg-settings__pager"><strong class="pg-settings__strong">${data ? t('{count} pessoas encontradas', { count: number(total) }) : t('Consulta administrativa')}</strong>${data && users.length ? h`<span>${t('Exibindo {start}–{end} de {total}', { start: number(offset + 1), end: number(offset + users.length), total: number(total) })}</span>` : ''}${button({ label: t('Atualizar'), action: 'platform-users-refresh', size: 'sm', icon: 'refresh', disabled: blocked })}</div>
    ${notice ? h`<div class="pg-settings__section-head">${notice}</div>` : ''}
    ${loading ? h`<p class="pg-settings__pager" role="status">${t('Consultando pessoas na plataforma…')}</p>` : ''}
    ${table}
    <p class="pg-settings__pager">${glyph('shield')} ${t('Consultar este diretório não concede acesso aos atendimentos de outras revendas.')}</p>
  </section>`);
}

function validResponse(data) {
  return data && Array.isArray(data.users) && Number.isSafeInteger(data.total) && data.total >= 0 &&
    (data.offset === undefined || Number.isSafeInteger(data.offset) && data.offset >= 0) &&
    data.users.every(user => user && typeof user.name === 'string' && typeof user.username === 'string' &&
      (!user.tenants || Array.isArray(user.tenants) && user.tenants.every(tenant => tenant && typeof tenant.name === 'string')));
}

export function createPlatformUsersUI({ request, openModal, escape, getContext, toast = () => {}, onRender = () => {}, getModal = () => null }) {
  let sequence = 0, active = false, scope = '', mode = 'page', filters = { q: '', state: 'all' }, snapshot = null, loading = false, error = '', forbidden = false, offset = 0, controller;
  const listened = new WeakSet();
  function reset() { sequence++; controller?.abort(); controller = null; active = false; scope = ''; snapshot = null; loading = false; error = ''; forbidden = false; offset = 0; filters = { q: '', state: 'all' }; }
  function current(ticket, key) { const context = getContext(); return active && ticket === sequence && key === scope && key === scopeKey(context) && canRead(context) && (mode !== 'page' || context.active !== false); }
  function panel() { return platformUsersMarkup(snapshot, { escape }, filters, { loading, error: error ? translateError(error) : '', forbidden }); }
  function paint() {
    if (mode === 'page') { onRender(); return; }
    if (!snapshot && !error && !getModal()?.open) return;
    openModal(t('Usuários da plataforma'), t('Pessoas cadastradas em todas as revendas, com empresa e responsabilidade identificadas.'), panel());
    const modal = getModal();
    if (modal?.addEventListener && !listened.has(modal)) {
      listened.add(modal);
      modal.addEventListener('close', () => { if (mode === 'modal' && !modal.open) reset(); });
    }
  }
  async function fetchPage(nextOffset) {
    const context = getContext(), key = scopeKey(context);
    if (!canRead(context)) { reset(); throw Error(t('Este diretório é reservado ao administrador da plataforma.')); }
    if (mode === 'page' && context.active === false) return false;
    if (!active || scope !== key) { reset(); active = true; scope = key; }
    platformUsersQuery({ ...filters, offset: nextOffset });
    controller?.abort(); controller = new AbortController();
    const ticket = ++sequence; offset = nextOffset; loading = true; error = ''; forbidden = false;
    paint();
    try {
      const data = await request(platformUsersQuery({ ...filters, offset }), { headers: { 'X-Elozi-Workspace': context.workspaceId }, signal: controller.signal });
      if (!current(ticket, key)) return false;
      if (!validResponse(data)) throw Error(t('Não foi possível conferir os dados do diretório.'));
      snapshot = { ...data, offset: data.offset ?? offset }; loading = false; paint(); return true;
    } catch (failure) {
      if (!current(ticket, key)) return false;
      loading = false; forbidden = [401, 403, 404].includes(Number(failure?.status));
      if (forbidden) snapshot = null;
      error = failure?.message || 'Não foi possível carregar o diretório.'; paint();
      if (mode === 'modal') toast(translateError(error), true);
      return false;
    }
  }
  function view() {
    const context = getContext();
    const header = lead => pageHeader({ title: t('Usuários globais'), lead });
    if (!canRead(context)) { reset(); return String(h`<div class="pg-settings pg-settings--users">${header(t('Este diretório é reservado ao administrador da plataforma.'))}</div>`); }
    if (scope && scope !== scopeKey(context)) reset();
    return String(h`<div class="pg-settings pg-settings--users">${header(t('Pessoas cadastradas em todas as revendas, com empresa e responsabilidade identificadas.'))}${raw(panel())}</div>`);
  }
  async function load(nextOffset = offset) { mode = 'page'; return fetchPage(nextOffset); }
  async function open() { reset(); mode = 'modal'; return fetchPage(0); }
  async function submit(form) {
    if (!form.matches('[data-platform-users-form]')) return false;
    if (!active || scope !== scopeKey(getContext()) || !canRead(getContext())) { reset(); return true; }
    if (loading) return true;
    const state = form.elements.namedItem('state').value;
    if (!STATES.has(state)) return true;
    filters = { q: String(form.elements.namedItem('q').value).slice(0, 120), state };
    const button = form.querySelector('[type="submit"]'); if (button) button.disabled = true;
    try { await fetchPage(0); } finally { if (button?.isConnected) button.disabled = false; }
    return true;
  }
  async function action(action, id) {
    if (action === 'platform-users') { await open(); return true; }
    if (!['platform-users-page', 'platform-users-refresh', 'platform-users-retry', 'platform-users-clear'].includes(action)) return false;
    if (!canRead(getContext()) || scope && scope !== scopeKey(getContext())) { reset(); return true; }
    if (loading || forbidden) return true;
    let nextOffset = offset;
    if (action === 'platform-users-clear') { filters = { q: '', state: 'all' }; nextOffset = 0; }
    if (action === 'platform-users-page') { nextOffset = Number(id); if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > 100000) return true; }
    await fetchPage(nextOffset); return true;
  }
  return { view, load, open, submit, action, reset };
}
