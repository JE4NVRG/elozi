import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, h, raw, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
import { billingLabels, parseBillingCents, formatBillingMoney } from './billing-ui.js';
import { button as uiButton, badge as uiBadge, banner, emptyState, skeleton } from './ui.js';
import { glyph } from './icons.js';
import { pageHeader } from './settings-ui.js';

// Planos e adicionais (FRONTEND-V2 §8.9, P8): the commercial catalog of the workspace (a reseller's
// plans for its clients, the platform's plans for resellers and companies). Revenda › Clientes ›
// Planos draws it as a page (page(), settings:plan-* actions); Plataforma › Cobrança keeps the dialog
// (open()). Editing and "Usar em contrato" always open a dialog bound to a token; saving never creates
// a contract: the draft goes to the financial editor for review (onDraft).
const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0 ? formatBillingMoney(value) : i18nT('Revisar valor');
const price = value => `${BigInt(value) / 100n},${String(BigInt(value) % 100n).padStart(2, '0')}`;

export function createPlansUI({ state, api, openModal, escape: e = fallbackEscape, toast = () => {}, onDraft, render = () => {}, getModal = () => globalThis.document?.querySelector('#modal') }) {
  let modal = null, snapshot = null, busy = false, sequence = 0, readController = null, pickerController = null, pageState = { key: '', loading: false, error: '' };
  let filters = { q: '', state: 'all', targetKind: 'all', offset: 0, limit: 25 };
  const pending = new Map();
  const kind = () => state.boot?.reseller?.accountKind;
  const workspace = () => state.view === 'platform-billing' ? 'mep-demo' : state.workspaceId;
  const allowed = () => !state.supportGrantId && state.boot?.session?.role === 'reseller' && (state.view === 'platform-billing' ? state.boot?.session?.platformOwner : ['platform', 'reseller'].includes(kind()));
  const key = () => JSON.stringify([state.workspaceId, workspace(), state.boot?.session?.userId, state.boot?.csrfToken, state.view, kind(), state.boot?.session?.role, Boolean(state.boot?.session?.platformOwner), state.supportGrantId]);
  const headers = () => ({ 'X-Elozi-Workspace': state.workspaceId });
  const valid = record => allowed() && record?.key === key() && getModal()?.open !== false && getModal()?.querySelector?.('[data-plans-panel]')?.dataset.plansToken === record.token;
  const button = (action, label, id = '') => i18nHtml`<button class="ui-btn ui-btn--secondary ui-btn--md" type="button" data-plans-action="${action}" data-plans-token="${modal?.token || ''}" ${id ? `data-id="${e(id)}"` : ''}><span class="ui-btn__label">${label}</span></button>`;
  const input = (label, name, value = '', extra = '') => i18nHtml`<label class="pg-settings__field">${label}<input class="pg-settings__input" name="${name}" value="${e(value)}" ${extra}/></label>`;
  const options = (entries, selected) => entries.map(([id, label]) => i18nHtml`<option value="${e(id)}" ${String(id) === String(selected) ? 'selected' : ''}>${e(label)}</option>`).join('');
  function show(type, title, html, more = {}) {
    modal = { type, key: key(), token: String(++sequence), ...more };
    html = html.replace(/data-plans-token="\d*"/g, `data-plans-token="${modal.token}"`).replace(/<form data-plans-form="([a-z-]+)"/g, `<form data-plans-form="$1" data-plans-token="${modal.token}"`);
    openModal(title, i18nT('Catálogo da sua gestão comercial'), i18nHtml`<div class="pg-settings__dialog" data-plans-panel data-plans-token="${modal.token}">${html}<p class="form-error pg-settings__error" role="alert"></p></div>`);
  }
  function planDTO(plan) {
    if (!plan || !identity(plan.id) || !Number.isSafeInteger(plan.version) || plan.version < 1 || typeof plan.name !== 'string' || !['active', 'archived'].includes(plan.state) || !['business', 'reseller'].includes(plan.targetKind) || !Array.isArray(plan.items) || plan.items.length > 20 || !plan.quotas || plan.currency !== 'BRL' || !Number.isInteger(plan.periodMonths) || plan.periodMonths < 1 || plan.periodMonths > 12) throw new Error('O servidor não confirmou o plano.');
    if (plan.items.some(item => !Object.hasOwn(billingLabels, item.kind) || typeof item.label !== 'string' || !Number.isSafeInteger(item.unitCents) || item.unitCents < 0 || !Number.isSafeInteger(item.units) || item.units < 0 || typeof item.metered !== 'boolean')) throw new Error('Os itens do plano exigem revisão.');
    return structuredClone(plan);
  }
  async function load() {
    const origin = key(), currentWorkspace = workspace(); if (!allowed()) throw new Error('O catálogo pertence ao administrador comercial.');
    pickerController?.abort();
    readController?.abort(); readController = new AbortController(); const ticket = ++sequence;
    const result = await api('/api/commercial/plans?' + new URLSearchParams({ workspaceId: currentWorkspace, ...filters }), { headers: headers(), signal: readController.signal });
    if (origin !== key() || ticket !== sequence || !allowed()) return false;
    if (result.workspaceId !== currentWorkspace || !Number.isSafeInteger(result.accountVersion) || result.accountVersion < 1 || !Array.isArray(result.plans) || !Number.isSafeInteger(result.total) || result.total < 0 || result.offset !== filters.offset || result.limit !== filters.limit || result.canManage !== true) throw new Error('O servidor não confirmou este catálogo.');
    const plans = result.plans.map(planDTO); if (new Set(plans.map(plan => plan.id)).size !== plans.length) throw new Error('A consulta trouxe planos repetidos.');
    snapshot = { ...result, plans, key: origin }; return true;
  }
  const planLines = plan => plan.items.map(item => `${item.label} · ${money(item.unitCents)} × ${item.metered ? i18nT('uso registrado') : item.units}`);
  const planSummary = plan => `${plan.targetKind === 'reseller' ? i18nT('Revendas') : i18nT('Empresas')} · ${i18nT('ciclo de {months} {unit}', { months: plan.periodMonths, unit: plan.periodMonths === 1 ? i18nT('mês') : i18nT('meses') })}`;
  function directory() {
    if (snapshot?.key !== key()) throw new Error('Atualize o catálogo neste acesso.');
    const cards = snapshot.plans.map(plan => i18nHtml`<article class="pg-settings__card"><div class="pg-settings__card-head"><strong class="pg-settings__strong">${e(plan.name)}</strong><span class="ui-badge ui-badge--${plan.state === 'active' ? 'success' : 'neutral'}">${plan.state === 'active' ? i18nT('Ativo') : i18nT('Arquivado')}</span></div><p class="pg-settings__muted">${e(planSummary(plan))}</p>${planLines(plan).map(line => i18nHtml`<span class="pg-settings__sub">${e(line)}</span>`).join('')}<div class="pg-settings__cluster">${button('edit', i18nT('Editar'), plan.id)}${plan.state === 'active' ? button('use', i18nT('Usar em contrato'), plan.id) : ''}</div></article>`).join('');
    show('directory', i18nT('Planos e adicionais'), i18nHtml`<p class="pg-settings__text">Guarde preços e limites acordados para reutilizar nos contratos. Cada contrato será revisado antes de ser criado.</p><form data-plans-form="filter" class="pg-settings__form"><div class="pg-settings__cluster">${input(i18nT('Buscar plano'), 'q', filters.q, 'maxlength="160"')}<label class="pg-settings__field">Estado<select class="pg-settings__input" name="state">${options([['all', i18nT('Todos')], ['active', i18nT('Ativos')], ['archived', i18nT('Arquivados')]], filters.state)}</select></label><button class="ui-btn ui-btn--secondary ui-btn--md" type="submit"><span class="ui-btn__label">Filtrar</span></button></div></form><div class="pg-settings__cluster">${button('new', i18nT('Novo plano'))}${button('refresh', i18nT('Atualizar'))}</div><div class="pg-settings__stack">${cards || i18nMarkup('<p class="pg-settings__muted">Nenhum plano neste filtro. Cadastre os preços que você definiu.</p>')}</div><div class="pg-settings__cluster"><span class="pg-settings__muted">${snapshot.total} planos</span>${snapshot.offset ? button('previous', i18nT('Anterior')) : ''}${snapshot.hasMore ? button('next', i18nT('Próxima')) : ''}</div>`);
    // Buttons were composed before the new modal token was allocated.
    const panel = getModal()?.querySelector?.('[data-plans-panel]'); panel?.querySelectorAll?.('[data-plans-action]').forEach(node => { node.dataset.plansToken = modal.token; });
  }
  const itemRow = (item = {}, id) => i18nHtml`<fieldset class="pg-settings__fieldset" data-plan-item="${id}"><legend>Item ${id + 1}</legend><label class="pg-settings__field">Tipo<select class="pg-settings__input" name="kind-${id}">${options(Object.entries(billingLabels), item.kind || 'subscription')}</select></label>${input(i18nT('Descrição'), `label-${id}`, item.label || '', 'maxlength="160" required')}${input(i18nT('Preço unitário em R$'), `price-${id}`, item.unitCents === undefined ? '' : price(item.unitCents), 'inputmode="decimal" required placeholder="0,00"')}${input(i18nT('Quantidade fixa'), `units-${id}`, item.units ?? 1, 'type="number" min="0" max="1000000" step="1" required')}<label class="pg-settings__check"><input type="checkbox" name="metered-${id}" value="yes" ${item.metered ? 'checked' : ''}/>Cobrar uso registrado na competência</label></fieldset>`;
  function editor(plan = null, origin = 'modal') {
    const platformCatalogue = workspace() === 'mep-demo';
    show('editor', plan ? i18nT('Editar plano') : i18nT('Novo plano'), i18nHtml`<form data-plans-form="editor" class="pg-settings__form">${input(i18nT('Nome do plano'), 'name', plan?.name || '', 'maxlength="160" required')}<label class="pg-settings__field">Público<select class="pg-settings__input" name="targetKind">${options(platformCatalogue ? [['business', i18nT('Empresas')], ['reseller', i18nT('Revendas')]] : [['business', i18nT('Empresas')]], plan?.targetKind || 'business')}</select></label><label class="pg-settings__field">Estado<select class="pg-settings__input" name="state">${options([['active', i18nT('Ativo')], ['archived', i18nT('Arquivado')]], plan?.state || 'active')}</select></label><label class="pg-settings__field">Periodicidade<select class="pg-settings__input" name="periodMonths">${options(Array.from({ length: 12 }, (_, index) => [index + 1, `${index + 1} ${index === 0 ? i18nT('mês') : i18nT('meses')}`]), plan?.periodMonths || 1)}</select></label><div data-plan-items class="pg-settings__stack">${(plan?.items || [{}]).map(itemRow).join('')}</div><div class="pg-settings__cluster">${button('add-item', i18nT('Adicionar item'))}${button('remove-item', i18nT('Remover último item'))}</div><fieldset class="pg-settings__fieldset"><legend>Limites de uso</legend><p class="pg-settings__muted">Deixe em branco quando não houver limite acordado.</p>${Object.entries(billingLabels).filter(([id]) => id !== 'subscription').map(([id, label]) => input(label, `quota-${id}`, plan?.quotas[id] ?? '', 'type="number" min="0" max="1000000000" step="1"')).join('')}</fieldset>${input(i18nT('Motivo / acordo'), 'reason', '', 'maxlength="500" required')}<p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions">${button('back', origin === 'page' ? i18nT('Cancelar') : i18nT('Voltar'))}<button class="ui-btn ui-btn--primary ui-btn--md" type="submit"><span class="ui-btn__label">${plan ? i18nT('Salvar revisão') : i18nT('Criar plano')}</span></button></div></form>`, { plan, accountVersion: snapshot.accountVersion, origin });
    getModal()?.querySelectorAll?.('[data-plans-action]').forEach(node => { node.dataset.plansToken = modal.token; });
  }
  async function open() { if (!allowed()) throw new Error('Catálogo indisponível neste acesso.'); if (pending.has(key())) return showPending(pending.get(key())); if (await load()) directory(); }
  function showPending(intent) { show('pending', i18nT('Verificar plano'), i18nHtml`<p class="pg-settings__text">A confirmação da gravação não chegou. A verificação repetirá a mesma operação, sem criar outra revisão.</p><div class="pg-settings__dialog-actions">${button('verify', i18nT('Verificar resultado'))}</div>`, { intent, origin: intent.origin }); getModal()?.querySelectorAll?.('[data-plans-action]').forEach(node => { node.dataset.plansToken = modal.token; }); }
  async function commit(intent) {
    if (busy || intent.key !== key() || !allowed()) return; busy = true; pending.set(intent.key, intent); const record = modal;
    try {
      const result = await api(intent.path, { method: intent.method, headers: headers(), body: JSON.stringify(intent.body) });
      const plan = planDTO(result.plan); if (result.workspaceId !== workspace() || result.canManage !== true || plan.name !== intent.body.name || !Number.isSafeInteger(result.accountVersion) || result.accountVersion <= intent.body.accountVersion) throw new Error('O servidor não confirmou a gravação.');
      pending.delete(intent.key); if (!valid(record)) return; toast(i18nT('Plano salvo. Os contratos anteriores foram preservados.'));
      if (await load()) { if (intent.origin === 'page') { modal = null; getModal()?.close?.(); render(); } else directory(); }
    } catch (error) { if (error.status >= 400 && error.status < 500) pending.delete(intent.key); if (!valid(record)) return; if (error.status >= 400 && error.status < 500) { const target = getModal()?.querySelector?.('.form-error'); if (target) target.textContent = translateError(error.message); } else showPending(intent); }
    finally { busy = false; }
  }
  function pickerValues(record) {
    const values = { targetWorkspaceId: '', startsAt: new Date().toISOString().slice(0, 10), graceDays: '0', ...(record?.values || {}) };
    const form = record?.type === 'use' && getModal()?.querySelector?.('[data-plans-form="use"]');
    if (form) { const fd = new FormData(form); for (const field of Object.keys(values)) { const value = fd.get(field); if (typeof value === 'string') values[field] = value; } }
    return values;
  }
  /** "Usar em contrato": from the catalog dialog (record) or from the Planos page (origin 'page', no dialog yet). */
  async function use(plan, page = { q: '', offset: 0, limit: 100 }, origin = 'modal') {
    const record = modal, fromDialog = origin !== 'page' || valid(record) && record.origin === 'page';
    if (fromDialog ? !valid(record) : !allowed()) return;
    const start = key(), owner = workspace(), accountVersion = fromDialog && record.type === 'use' ? record.accountVersion : snapshot.accountVersion;
    const values = pickerValues(fromDialog ? record : null), selected = (fromDialog ? record.accounts || [] : []).find(account => account.id === values.targetWorkspaceId);
    pickerController?.abort(); const controller = pickerController = new AbortController(), ticket = ++sequence;
    const current = () => start === key() && (fromDialog ? modal === record && valid(record) : allowed()) && ticket === sequence && !controller.signal.aborted;
    const query = { view: owner === 'mep-demo' ? 'platform' : 'account', kind: plan.targetKind, q: page.q, offset: page.offset, limit: 100 };
    let result;
    try { result = await api('/api/accounts?' + new URLSearchParams(query), { headers: headers(), signal: controller.signal }); }
    catch (error) { if (!current()) return; throw error; }
    if (!current()) return;
    if (!Array.isArray(result.accounts) || result.accounts.length > query.limit || !Number.isSafeInteger(result.total) || result.total < 0 || result.offset !== query.offset || result.limit !== query.limit || typeof result.hasMore !== 'boolean'
      || result.hasMore !== (result.offset + result.limit < result.total) || result.accounts.some(account => !identity(account.id) || typeof account.name !== 'string' || account.accountKind !== plan.targetKind || owner !== 'mep-demo' && account.parentWorkspaceId !== owner)
      || new Set(result.accounts.map(account => account.id)).size !== result.accounts.length) throw new Error('O servidor não confirmou a página de contratantes.');
    const accounts = result.accounts.map(account => ({ id: account.id, name: account.name }));
    if (selected && !accounts.some(account => account.id === selected.id)) accounts.unshift(selected);
    if (!accounts.some(account => account.id === values.targetWorkspaceId)) values.targetWorkspaceId = '';
    const summary = result.total ? i18nTxt`${result.offset + 1}–${Math.min(result.offset + result.limit, result.total)} de ${result.total} contas` : i18nT('Nenhuma conta neste filtro.');
    const mode = fromDialog ? record.origin || 'modal' : 'page';
    show('use', i18nT('Usar plano em contrato'), i18nHtml`<p class="pg-settings__text">${e(plan.name)} · os valores serão abertos para sua revisão.</p><form data-plans-form="use-filter" class="pg-settings__form"><div class="pg-settings__cluster">${input(i18nT('Buscar conta contratante'), 'q', query.q, 'maxlength="200"')}<button class="ui-btn ui-btn--secondary ui-btn--md" type="submit"><span class="ui-btn__label">Buscar</span></button></div></form><div class="pg-settings__cluster"><span class="pg-settings__muted">${summary}</span>${result.offset ? button('use-previous', i18nT('Anterior')) : ''}${result.hasMore ? button('use-next', i18nT('Próxima')) : ''}</div><form data-plans-form="use" class="pg-settings__form"><label class="pg-settings__field">Conta contratante<select class="pg-settings__input" name="targetWorkspaceId" required>${options([['', i18nT('Selecione')], ...accounts.map(account => [account.id, account.name])], values.targetWorkspaceId)}</select></label>${input(i18nT('Início da vigência'), 'startsAt', values.startsAt, 'type="date" required')}${input(i18nT('Carência em dias'), 'graceDays', values.graceDays, 'type="number" min="0" max="90" step="1" required')}<p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions">${button('back', mode === 'page' ? i18nT('Cancelar') : i18nT('Voltar'))}<button class="ui-btn ui-btn--primary ui-btn--md" type="submit"><span class="ui-btn__label">Revisar contrato</span></button></div></form>`, { plan, accountVersion, targets: accounts.map(account => account.id), accounts, values, page: { ...query, hasMore: result.hasMore }, origin: mode });
    getModal()?.querySelectorAll?.('[data-plans-action]').forEach(node => { node.dataset.plansToken = modal.token; });
  }
  async function action(node) {
    const name = node?.dataset?.plansAction; if (!name) return false; const record = modal;
    if (!valid(record) || node.dataset.plansToken !== record.token || busy) return true;
    try {
      if (name === 'verify') await commit(record.intent);
      else if (name === 'back' && record.origin === 'page') { modal = null; getModal()?.close?.(); }
      else if (name === 'refresh' || name === 'back') await open();
      else if (name === 'previous' || name === 'next') { filters.offset = name === 'previous' ? Math.max(0, filters.offset - filters.limit) : filters.offset + filters.limit; await open(); }
      else if ((name === 'use-previous' || name === 'use-next') && record.type === 'use') { if (name === 'use-next' && !record.page.hasMore || name === 'use-previous' && !record.page.offset) return true; await use(record.plan, { ...record.page, offset: name === 'use-previous' ? Math.max(0, record.page.offset - 100) : record.page.offset + 100 }); }
      else if (name === 'new') editor();
      else if (name === 'add-item' || name === 'remove-item') { const list = getModal()?.querySelector?.('[data-plan-items]'), rows = list?.querySelectorAll?.('[data-plan-item]'); if (!rows) return true; if (name === 'add-item') { if (rows.length >= 20) throw new Error('Limite de 20 itens por plano.'); list.insertAdjacentHTML('beforeend', itemRow({}, rows.length)); } else { if (rows.length <= 1) throw new Error('Mantenha pelo menos um item.'); rows[rows.length - 1].remove(); } }
      else { const plan = snapshot?.key === key() && snapshot.plans.find(item => item.id === node.dataset.id); if (!plan) throw new Error('Atualize o plano antes de continuar.'); if (name === 'edit') editor(plan); else if (name === 'use') await use(plan); }
    } catch (error) { if (valid(record)) toast(translateError(error.message), true); } return true;
  }
  async function submit(form) {
    const type = form?.dataset?.plansForm; if (!type) return false; const record = modal; if (!valid(record) || form.dataset.plansToken !== record.token || busy) return true;
    const fd = new FormData(form); try {
      if (type === 'filter') { filters = { ...filters, q: String(fd.get('q') || ''), state: String(fd.get('state') || 'all'), offset: 0 }; await open(); }
      if (type === 'use-filter' && record.type === 'use') { const q = String(fd.get('q') || '').trim(); if (q.length > 200 || /\p{Cc}/u.test(q)) throw new Error('Informe uma busca de até 200 caracteres.'); await use(record.plan, { q, offset: 0, limit: 100 }); }
      if (type === 'editor' && record.type === 'editor') {
        const items = [...form.querySelectorAll('[data-plan-item]')].map(row => { const id = row.dataset.planItem; return { kind: fd.get(`kind-${id}`), label: fd.get(`label-${id}`), unitCents: parseBillingCents(fd.get(`price-${id}`)), units: Number(fd.get(`units-${id}`)), metered: fd.get(`metered-${id}`) === 'yes' }; });
        const quotas = {...(record.plan?.quotas||{})}; for (const metric of Object.keys(billingLabels).filter(id => id !== 'subscription')) { const value = fd.get(`quota-${metric}`); if (value !== null && String(value).trim()) quotas[metric] = Number(value);else delete quotas[metric]; }
        const body = { requestId: globalThis.crypto.randomUUID(), accountVersion: record.accountVersion, name: String(fd.get('name') || '').trim(), targetKind: fd.get('targetKind'), state: fd.get('state'), currency: 'BRL', periodMonths: Number(fd.get('periodMonths')), items, quotas, reason: String(fd.get('reason') || '').trim(), ...(record.plan ? { version: record.plan.version } : {}) };
        if (!body.name || !body.reason) throw new Error('Informe o nome e o acordo do plano.');
        await commit({ key: record.key, origin: record.origin, path: `/api/accounts/${encodeURIComponent(workspace())}/plans${record.plan ? '/' + encodeURIComponent(record.plan.id) : ''}`, method: record.plan ? 'PATCH' : 'POST', body });
      }
      if (type === 'use' && record.type === 'use') {
        const targetWorkspaceId = fd.get('targetWorkspaceId'); if (!record.targets.includes(targetWorkspaceId)) throw new Error('Escolha a conta contratante.');
        const result = await api(`/api/accounts/${encodeURIComponent(workspace())}/plans/${encodeURIComponent(record.plan.id)}/contract-draft`, { method: 'POST', headers: headers(), body: JSON.stringify({ accountVersion: record.accountVersion, version: record.plan.version, targetWorkspaceId, startsAt: fd.get('startsAt'), graceDays: Number(fd.get('graceDays')) }) });
        if (!valid(record)) return true; if (result.requiresReview !== true || result.source?.workspaceId !== workspace() || result.source?.planId !== record.plan.id || result.draft?.targetWorkspaceId !== targetWorkspaceId) throw new Error('O servidor não confirmou o rascunho do contrato.');
        await onDraft(result); modal = null;
      }
    } catch (error) { if (valid(record)) { const target = form.querySelector?.('.form-error'); if (target) target.textContent = translateError(error.message); toast(translateError(error.message), true); } } return true;
  }

  // ---------- Revenda › Clientes › Planos (page) ----------
  /** Loads the catalog for the page once per access (force reloads: Atualizar, filters, pages). */
  async function ensurePage({ force = false } = {}) {
    if (!allowed()) return false;
    const expected = key();
    if (!force && (snapshot?.key === expected || pageState.key === expected && (pageState.loading || pageState.error))) return false;
    pageState = { key: expected, loading: true, error: '' };
    try { await load(); } catch (error) { if (pageState.key === expected && error?.name !== 'AbortError') pageState.error = translateError(error?.message || ''); }
    finally { if (pageState.key === expected) { pageState.loading = false; render(); } }
    return true;
  }
  function page() {
    const header = actions => pageHeader({ title: i18nT('Planos e adicionais'), lead: i18nT('Guarde preços e limites acordados para reutilizar nos contratos. Cada contrato é revisado antes de ser criado.'), actions });
    if (!allowed()) return String(h`<div class="pg-settings pg-settings--plans">${header('')}${emptyState({ icon: 'document', title: i18nT('O catálogo pertence ao administrador comercial.'), body: i18nT('Planos ficam disponíveis para revendas e para a plataforma.') })}</div>`);
    const data = snapshot?.key === key() ? snapshot : null, loading = pageState.key === key() && pageState.loading, error = pageState.key === key() ? pageState.error : '';
    const actions = h`${uiButton({ label: i18nT('Atualizar'), action: 'settings:plans-refresh', icon: 'refresh', busy: loading })}${uiButton({ label: i18nT('Novo plano'), action: 'settings:plan-new', variant: 'primary', icon: 'plus', disabled: !data })}`;
    const select = h`<label class="pg-settings__field pg-settings__field--narrow">${i18nT('Estado')}<select class="pg-settings__input" name="state">${[['all', i18nT('Todos')], ['active', i18nT('Ativos')], ['archived', i18nT('Arquivados')]].map(([id, label]) => h`<option value="${id}"${raw(filters.state === id ? ' selected' : '')}>${label}</option>`)}</select></label>`;
    const cards = data?.plans.map(plan => h`<li class="pg-settings__card"><div class="pg-settings__card-head"><strong class="pg-settings__strong">${plan.name}</strong>${uiBadge(plan.state === 'active' ? i18nT('Ativo') : i18nT('Arquivado'), plan.state === 'active' ? 'success' : 'neutral')}</div><p class="pg-settings__muted">${planSummary(plan)}</p><ul class="pg-settings__list">${planLines(plan).map(line => h`<li class="pg-settings__sub">${line}</li>`)}</ul><div class="pg-settings__cluster">${uiButton({ label: i18nT('Editar'), action: 'settings:plan-edit', size: 'sm', attrs: { 'data-id': plan.id } })}${plan.state === 'active' ? uiButton({ label: i18nT('Usar em contrato'), action: 'settings:plan-use', size: 'sm', variant: 'primary', attrs: { 'data-id': plan.id } }) : ''}</div></li>`) || [];
    const body = data ? cards.length ? h`<ul class="pg-settings__cards">${cards}</ul>` : emptyState({ icon: 'document', title: i18nT('Nenhum plano neste filtro.'), body: i18nT('Cadastre os preços que você definiu para reutilizar nos contratos.'), level: 3 })
      : error ? banner({ tone: 'warning', title: i18nT('Não foi possível carregar o catálogo.'), body: error, action: { label: i18nT('Tentar novamente'), action: 'settings:plans-refresh' } }) : skeleton({ lines: 3, label: i18nT('Carregando o catálogo…') });
    return String(h`<div class="pg-settings pg-settings--plans">
      ${header(actions)}
      <section class="pg-settings__section pg-settings__section--flush" aria-label="${i18nT('Filtros do catálogo')}"><form class="pg-settings__toolbar" data-form="settings:plans-filter" role="search"><label class="pg-settings__search">${glyph('search')}<span class="sr-only">${i18nT('Buscar plano')}</span><input class="pg-settings__input" name="q" value="${filters.q}" maxlength="160" placeholder="${i18nT('Buscar plano')}" autocomplete="off"/></label>${select}${uiButton({ label: i18nT('Filtrar'), type: 'submit' })}<p class="pg-settings__total" role="status">${data ? i18nT('{count} planos', { count: data.total }) : ''}</p></form></section>
      ${body}
      ${data && (data.offset || data.hasMore) ? h`<nav class="pg-settings__pager" aria-label="${i18nT('Páginas do catálogo')}"><span>${i18nT('{count} planos', { count: data.total })}</span><div class="pg-settings__cluster">${uiButton({ label: i18nT('Anterior'), action: 'settings:plans-page', size: 'sm', disabled: !data.offset, attrs: { 'data-id': String(Math.max(0, data.offset - filters.limit)) } })}${uiButton({ label: i18nT('Próxima'), action: 'settings:plans-page', size: 'sm', disabled: !data.hasMore, attrs: { 'data-id': String(data.offset + filters.limit) } })}</div></nav>` : ''}
    </div>`);
  }
  /** settings:plan-* actions of the page (registered by settings-ui.js through app.js). */
  async function pageAction(name, id) {
    if (!allowed() || busy) return true;
    if (name === 'settings:plans-refresh') { await ensurePage({ force: true }); return true; }
    if (name === 'settings:plans-page') { const offset = Number(id); if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return true; filters.offset = offset; await ensurePage({ force: true }); return true; }
    if (pending.has(key())) { showPending(pending.get(key())); return true; }
    if (snapshot?.key !== key()) throw new Error('Atualize o catálogo neste acesso.');
    if (name === 'settings:plan-new') { editor(null, 'page'); return true; }
    const plan = snapshot.plans.find(item => item.id === id);
    if (!plan) throw new Error('Atualize o plano antes de continuar.');
    if (name === 'settings:plan-edit') { editor(plan, 'page'); return true; }
    if (name === 'settings:plan-use' && plan.state === 'active') { await use(plan, undefined, 'page'); return true; }
    return false;
  }
  async function pageSubmit(form) {
    if (form?.dataset?.form !== 'settings:plans-filter' || !allowed()) return false;
    const values = new FormData(form), q = String(values.get('q') || '').trim().slice(0, 160), next = String(values.get('state') || 'all');
    filters = { ...filters, q, state: ['all', 'active', 'archived'].includes(next) ? next : 'all', offset: 0 };
    await ensurePage({ force: true }); return true;
  }
  function reset() { readController?.abort(); pickerController?.abort(); if (valid(modal)) getModal()?.close?.(); sequence++; modal = null; snapshot = null; pageState = { key: '', loading: false, error: '' }; filters = { q: '', state: 'all', targetKind: 'all', offset: 0, limit: 25 }; }
  return { open, action, submit, reset, page, ensurePage, pageAction, pageSubmit };
}
