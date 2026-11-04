import { t, h, labels, getLocale, translateError } from './i18n.js';
import './locales-operations.js';
import { button, iconButton, badge, banner, emptyState, skeleton, companyMark, attributes } from './ui.js';
import { parseHash } from './router.js';
import { viewForRoute, routeForView } from './nav-config.js';
import { registerScreen } from './actions.js';
import { motionOK } from './theme-prefs.js';
import { automationChannelSupported, automationChannelConnected } from './automation-channels.js';
import { createFlowWorkspace } from './flow-workspace-ui.js';
import { QUICK_REPLY_LIMITS, quickRepliesScreen, quickRepliesResults, quickRepliesCount, quickReplyEditorForm, quickReplyPreview, readQuickReplyForm } from './replies-ui.js';

// Automação (FRONTEND-V2 §2.1, §2.2, §8.9; P8-B): the hub with the tabs Regras e SLA · Fluxos ·
// Respostas rápidas, on the design tokens (.pg-automation__*, public/automation.css).
//
// - app.js merges createAutomationUI(ctx).views into its views: 'automation' draws #automation
//   (Regras e SLA), 'quick-replies' draws #automation/replies (Respostas rápidas, a tab of the hub in
//   nav-config.js since P10) and 'flows' draws #automation/flows[/<id>] through flow-workspace-ui.js.
//   Each view records its route in state.screenRoutes, so a hash change inside the view re-renders it
//   (the same seam app.js offers the delegated screens).
// - 'automation:*' actions and the data-form="automation:…" forms reach act/submit through the
//   registry of actions.js. The legacy names of act ('refresh-automation', …) still work.
// - Behaviour and authorization are the ones of the legacy screens: the configuration (rules and SLA)
//   loads and saves only for the administration (role reseller) with the CAS version of the server;
//   the SLA snapshot needs metrics.read and inbox.read; quick replies are managed by the
//   administration only; responses of another workspace or company never touch the open one.
// - Dialogs are a native <dialog> inside the view (top layer): focus goes to the first field (or the
//   title), Esc closes (asks before discarding a changed form) and focus returns to the trigger.

const LEGACY_ACTIONS = Object.freeze({
  'refresh-automation': 'automation:refresh', 'new-automation-binding': 'automation:new-binding', 'edit-automation-binding': 'automation:edit-binding',
  'remove-automation-binding': 'automation:remove-binding', 'confirm-remove-automation-binding': 'automation:confirm-remove-binding'
});
const DAY_NAMES = () => [t('Dom'), t('Seg'), t('Ter'), t('Qua'), t('Qui'), t('Sex'), t('Sáb')];
const cssEscape = value => typeof globalThis.CSS?.escape === 'function' ? globalThis.CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');

/** Focus that survives the full renders of app.js: the last control used, or the one an action asks for. */
export function createFocusMemory() {
  let remembered = null, wanted = null;
  const find = (main, key) => {
    if (!key || !main?.querySelector) return null;
    if (key.startsWith('tab:')) return main.ownerDocument?.querySelector?.(`.ui-hub[data-hub="automation"] [role="tab"][data-tab="${cssEscape(key.slice(4))}"]`) || null;
    return main.querySelector(`[data-automation-focus="${cssEscape(key)}"]`);
  };
  return {
    remember(key) { remembered = key || null; },
    want(key) { wanted = key || null; },
    get wanted() { return wanted; },
    /** After a render: the asked control, else the remembered one when the focus fell to the body. */
    restore(main) {
      const doc = main?.ownerDocument;
      if (!doc) return false;
      const active = doc.activeElement, lost = !active || active === doc.body || active === doc.documentElement || active.isConnected === false;
      const key = wanted || (lost ? remembered : null);
      wanted = null;
      if (!key || doc.querySelector?.('dialog[open]')) return false;
      const target = find(main, key);
      if (!target || target.disabled) return false;
      target.focus({ preventScroll: true });
      if (/^(?:text|search)$/.test(target.type || '') && typeof target.setSelectionRange === 'function') { const end = String(target.value || '').length; try { target.setSelectionRange(end, end); } catch { /* not a text field */ } }
      return true;
    }
  };
}

/**
 * Dialog of the screens: the <dialog id="automation-dialog"> each view renders (empty and closed).
 * open() fills and shows it; a full render of app.js replaces it, and reconcile() (after the render)
 * gives the focus back to the trigger. Tests inject their own host with the same methods.
 */
export function createDialogHost({ focus } = {}) {
  let current = null;
  const bound = new WeakSet();
  const element = () => globalThis.document?.getElementById?.('automation-dialog') || null;
  const fields = dialog => dialog.querySelector('[data-automation-dialog-body] :is(input:not([type="hidden"]), select, textarea):not([disabled])');
  function giveBack(info) {
    if (!info) return;
    if (info.returnElement?.isConnected && typeof info.returnElement.focus === 'function') { info.returnElement.focus({ preventScroll: true }); return; }
    if (info.returnKey) focus?.want?.(info.returnKey);
    const main = globalThis.document?.getElementById?.('main-content');
    if (main) focus?.restore?.(main);
  }
  function confirmDiscard(dialog) {
    const prompt = dialog.querySelector('[data-automation-discard]');
    if (!prompt) return false;
    prompt.hidden = false; dialog.dataset.confirming = 'true';
    prompt.querySelector('button')?.focus();
    return true;
  }
  function bind(dialog) {
    if (bound.has(dialog)) return;
    bound.add(dialog);
    dialog.addEventListener('close', () => { if (dialog.open || element() !== dialog) return; const info = current; current = null; giveBack(info); });
    dialog.addEventListener('cancel', event => { if (dialog.dataset.dirty === 'true' && confirmDiscard(dialog)) event.preventDefault(); });
    const dirty = event => { if (!event.target?.closest?.('[data-automation-discard]')) dialog.dataset.dirty = 'true'; };
    dialog.addEventListener('input', dirty); dialog.addEventListener('change', dirty);
  }
  return {
    open({ title, description = '', body, kind = '', returnElement = null, returnKey = null, size = 'md' } = {}) {
      const dialog = element();
      if (!dialog || typeof dialog.showModal !== 'function') return false;
      if (dialog.open) { current = null; dialog.close(); }
      dialog.innerHTML = String(h`<div class="pg-automation__dialog-head"><div class="pg-automation__dialog-heading"><h2 class="pg-automation__dialog-title" id="automation-dialog-title" tabindex="-1">${title}</h2>${description ? h`<p class="pg-automation__dialog-desc" id="automation-dialog-desc">${description}</p>` : ''}</div>${iconButton({ label: t('Fechar'), icon: 'close', action: 'automation:close-dialog' })}</div><div class="pg-automation__dialog-body" data-automation-dialog-body>${body}</div><div class="pg-automation__discard" data-automation-discard hidden><p class="pg-automation__dialog-text" id="automation-discard-title"><strong>${t('Descartar alterações?')}</strong> ${t('O que você preencheu neste formulário ainda não foi salvo.')}</p><div class="pg-automation__dialog-actions">${button({ label: t('Continuar editando'), action: 'automation:dialog-keep', variant: 'secondary' })}${button({ label: t('Descartar'), action: 'automation:dialog-discard', variant: 'danger' })}</div></div>`);
      if (description) dialog.setAttribute('aria-describedby', 'automation-dialog-desc'); else dialog.removeAttribute('aria-describedby');
      dialog.dataset.size = size; dialog.dataset.kind = kind;
      delete dialog.dataset.dirty; delete dialog.dataset.confirming;
      bind(dialog);
      current = { kind, returnElement, returnKey };
      dialog.showModal();
      (fields(dialog) || dialog.querySelector('#automation-dialog-title'))?.focus();
      return true;
    },
    close() {
      const dialog = element();
      if (dialog?.open) { dialog.close(); return; }
      const info = current; current = null; giveBack(info);
    },
    requestClose() {
      const dialog = element();
      if (dialog?.open && dialog.dataset.dirty === 'true' && confirmDiscard(dialog)) return;
      this.close();
    },
    keep() {
      const dialog = element();
      if (!dialog?.open) return;
      const prompt = dialog.querySelector('[data-automation-discard]');
      if (prompt) prompt.hidden = true;
      delete dialog.dataset.confirming;
      (fields(dialog) || dialog.querySelector('#automation-dialog-title'))?.focus();
    },
    discard() { const dialog = element(); if (dialog) delete dialog.dataset.dirty; this.close(); },
    /** After a render: a dialog replaced by the new markup is closed; its trigger gets the focus back. */
    reconcile() { if (current && !element()?.open) { const info = current; current = null; if (info.returnKey) focus?.want?.(info.returnKey); } },
    isOpen() { return Boolean(element()?.open); },
    get kind() { return current?.kind || null; }
  };
}

const installed = new WeakSet();

export function createAutomationUI(ctx) {
  const { state, api, tenantApi, render, toast, hasPermission = () => false } = ctx;
  const doc = () => globalThis.document;
  const admin = () => state.boot?.session?.role === 'reseller';
  const key = () => state.tenant ? `${state.workspaceId}/${state.tenant.id}` : '';
  const focus = ctx.focusMemory || createFocusMemory();
  const dialogs = ctx.dialogHost || createDialogHost({ focus });
  const flows = createFlowWorkspace({ state, render: () => render(), request: (path, options) => api(path, options), tenantPath: path => tenantApi(path), toast, dialogs, focus });
  let config = null, snapshot = null, error = '', contextKey = '', sequence = 0, loading = false;
  // Quick replies of the open company (management screen); scope: the company of the open editor.
  const replies = { key: '', items: null, error: '', loading: null, sequence: 0, query: '', scope: '' };

  const wireBinding = b => Object.fromEntries(['id', 'name', 'enabled', 'channelId', 'flowId', 'flowVersion', 'trigger', 'command', 'calendar'].filter(field => Object.hasOwn(b, field)).map(field => [field, b[field]]));
  const readCalendar = (form, prefix = '') => { const f = new FormData(form); return f.has(prefix + 'calendarEnabled') ? { timezone: String(f.get(prefix + 'timezone') || '').trim(), days: f.getAll(prefix + 'days').map(Number), start: f.get(prefix + 'start'), end: f.get(prefix + 'end') } : null; };

  async function refresh() {
    const localKey = key(), localSequence = ++sequence;
    if (!localKey) { reset(); return; }
    if (contextKey !== localKey) { config = null; snapshot = null; error = ''; contextKey = localKey; }
    const request = path => api(tenantApi(path)).catch(err => { if (err.status === 403) return null; throw err; });
    loading = true;
    try {
      const [nextConfig, nextSnapshot] = await Promise.all([admin() ? request('automation') : null, hasPermission('metrics.read') && hasPermission('inbox.read') ? request('sla') : null]);
      if (localSequence !== sequence || key() !== localKey) return;
      config = nextConfig; snapshot = nextSnapshot; error = '';
    } catch (err) { if (localSequence === sequence && key() === localKey) { config = null; snapshot = null; error = translateError(err.message) || t('Não foi possível carregar as automações.'); } }
    finally { if (localSequence === sequence) loading = false; }
  }
  function reset() {
    sequence++; config = null; snapshot = null; error = ''; contextKey = ''; loading = false;
    replies.sequence++; Object.assign(replies, { key: '', items: null, error: '', loading: null, query: '', scope: '' });
    flows.reset();
  }

  // ---- shared markup --------------------------------------------------------------------------

  const scopeLine = () => state.tenant ? h`<p class="pg-automation__scope">${companyMark(state.tenant)}</p>` : '';
  const heading = (title, lead, actions = '') => h`<header class="pg-automation__head"><div class="pg-automation__head-text">${scopeLine()}<h1 class="pg-automation__title">${title}</h1><p class="pg-automation__lead">${lead}</p></div>${actions ? h`<div class="pg-automation__head-actions">${actions}</div>` : ''}</header>`;
  const refreshButton = () => button({ label: t('Atualizar'), action: 'automation:refresh', variant: 'ghost', icon: 'refresh', attrs: { 'data-automation-focus': 'refresh' } });
  const dialogShell = () => h`<dialog class="pg-automation__dialog" id="automation-dialog" aria-labelledby="automation-dialog-title"></dialog>`;
  const field = ({ id, label, control, hint, hintId }) => h`<div class="pg-automation__field"><label class="pg-automation__label"${attributes({ for: id })}>${label}</label>${control}${hint ? h`<p class="pg-automation__hint"${attributes({ id: hintId || null })}>${hint}</p>` : ''}</div>`;
  const switchControl = ({ id, name, checked, label, attrs }) => h`<label class="pg-automation__switch"${attributes({ for: id })}><input class="pg-automation__switch-input" type="checkbox" role="switch"${attributes({ id, name, checked: Boolean(checked), ...attrs })}/><span class="pg-automation__switch-track" aria-hidden="true"></span><span class="pg-automation__switch-label">${label}</span></label>`;
  const options = (items, value) => items.map(([id, label]) => h`<option${attributes({ value: id, selected: id === value })}>${label}</option>`);

  function calendarFields(calendar, idPrefix) {
    const days = calendar?.days || [1, 2, 3, 4, 5];
    return h`<fieldset class="pg-automation__fieldset" data-automation-calendar${attributes({ 'data-state': calendar ? 'on' : 'off' })}><legend class="pg-automation__legend">${t('Horário de funcionamento')}</legend>${switchControl({ id: `${idPrefix}-calendar`, name: 'calendarEnabled', checked: Boolean(calendar), label: t('Contar somente neste horário'), attrs: { 'data-automation-calendar-toggle': 'true' } })}<div class="pg-automation__grid pg-automation__grid--calendar">${field({ id: `${idPrefix}-timezone`, label: t('Fuso horário'), control: h`<input class="pg-automation__control"${attributes({ id: `${idPrefix}-timezone`, name: 'timezone', value: calendar?.timezone || 'America/Sao_Paulo', maxlength: 80, autocomplete: 'off', spellcheck: 'false' })}/>` })}${field({ id: `${idPrefix}-start`, label: t('Início'), control: h`<input class="pg-automation__control" type="time"${attributes({ id: `${idPrefix}-start`, name: 'start', value: calendar?.start || '09:00' })}/>` })}${field({ id: `${idPrefix}-end`, label: t('Fim'), control: h`<input class="pg-automation__control" type="time"${attributes({ id: `${idPrefix}-end`, name: 'end', value: calendar?.end || '18:00' })}/>` })}</div><fieldset class="pg-automation__days"><legend class="pg-automation__label">${t('Dias da semana')}</legend><div class="pg-automation__day-list">${DAY_NAMES().map((day, index) => h`<label class="pg-automation__day"><input class="pg-automation__day-input" type="checkbox" name="days"${attributes({ value: index, checked: days.includes(index) })}/><span>${day}</span></label>`)}</div></fieldset><p class="pg-automation__hint">${t('Janela semanal no mesmo dia; feriados não são descontados.')}</p></fieldset>`;
  }

  // ---- Regras e SLA ---------------------------------------------------------------------------

  const date = value => value ? new Date(value).toLocaleString(getLocale(), { timeZone: snapshot?.policy?.calendar?.timezone || 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—';
  const stateLabels = labels({ pending: 'No prazo', met: 'Cumprido', breached: 'Prazo excedido', 'insufficient-data': 'Sem marco suficiente', disabled: 'Desativado' });
  const stateTones = { pending: 'info', met: 'success', breached: 'danger' };
  const triggerLabel = trigger => ({ incoming: t('Toda entrada na fila'), new_conversation: t('Nova conversa'), command: t('Comando') })[trigger] || trigger;
  const publishedFlows = () => (state.flows || []).filter(f => f.publishedVersion && f.state !== 'archived');
  const connectedChannels = () => (state.tenant?.channels || []).filter(automationChannelConnected);

  function ruleItem(b) {
    const channel = (state.tenant?.channels || []).find(c => c.id === b.channelId);
    const flow = (state.flows || []).find(f => f.id === b.flowId), archived = !flow && (state.tenant?.flows || []).find(f => f.id === b.flowId);
    const flowName = flow?.name || archived?.name || t('Fluxo indisponível');
    const when = `${triggerLabel(b.trigger)}${b.command ? ' ' + b.command : ''}`;
    const hours = b.calendar ? `${b.calendar.start}–${b.calendar.end} (${b.calendar.timezone})` : t('Qualquer horário');
    const notes = [
      channel && automationChannelSupported(channel) && !automationChannelConnected(channel) ? badge(t('Canal desconectado'), 'warning') : '',
      archived ? badge(t('Fluxo arquivado'), 'warning') : '',
      flow?.publishedVersion > b.flowVersion ? badge(t('v{version} disponível', { version: flow.publishedVersion }), 'info') : ''
    ];
    return h`<li class="pg-automation__rule"${attributes({ 'data-state': b.enabled ? 'enabled' : 'disabled' })}><div class="pg-automation__rule-main"><h3 class="pg-automation__rule-name">${b.name}</h3><p class="pg-automation__rule-route"><span>${channel?.name || t('Canal indisponível')}</span><span class="pg-automation__arrow" aria-hidden="true">→</span><span>${flowName}</span> <span class="pg-automation__version">${t('versão v{version}', { version: b.flowVersion })}</span></p><p class="pg-automation__meta">${when} · ${hours}</p></div><div class="pg-automation__rule-side"><div class="pg-automation__badges">${badge(b.enabled ? t('Ativa') : t('Desativada'), b.enabled ? 'success' : 'neutral')}${notes}</div><div class="pg-automation__actions">${button({ label: t('Editar'), action: 'automation:edit-binding', variant: 'secondary', size: 'sm', attrs: { 'data-id': b.id, 'aria-label': t('Editar {name}', { name: b.name }), 'aria-haspopup': 'dialog', 'data-automation-focus': `rule-edit:${b.id}` } })}${button({ label: t('Remover'), action: 'automation:remove-binding', variant: 'ghost', size: 'sm', className: 'pg-automation__danger', attrs: { 'data-id': b.id, 'aria-label': t('Remover {name}', { name: b.name }), 'aria-haspopup': 'dialog', 'data-automation-focus': `rule-remove:${b.id}` } })}</div></div></li>`;
  }

  function rulesEmpty() {
    if (!publishedFlows().length) return emptyState({ icon: 'workflow', level: 3, title: t('Nenhuma regra de entrada'), body: t('Publique um fluxo para vinculá-lo a um canal.'), action: { label: t('Abrir Fluxos'), action: 'automation:open-flows', attrs: { 'data-automation-focus': 'rules-open-flows' } } });
    if (!connectedChannels().length) return emptyState({ icon: 'plug', level: 3, title: t('Nenhuma regra de entrada'), body: t('Conecte um canal WhatsApp QR, Telegram ou Webchat para criar a primeira regra.'), action: { label: t('Abrir Canais'), action: 'automation:open-channels', attrs: { 'data-automation-focus': 'rules-open-channels' } } });
    return emptyState({ icon: 'workflow', level: 3, title: t('Nenhuma regra de entrada'), body: t('Escolha um canal, um fluxo publicado e quando a regra entra em ação.'), action: { label: t('Adicionar regra'), action: 'automation:new-binding', icon: 'plus', attrs: { 'data-automation-focus': 'rules-add', 'aria-haspopup': 'dialog' } } });
  }

  function rulesCard() {
    const bindings = config.bindings || [];
    const add = bindings.length ? button({ label: t('Adicionar regra'), action: 'automation:new-binding', variant: 'primary', icon: 'plus', attrs: { 'data-automation-focus': 'rules-add', 'aria-haspopup': 'dialog' } }) : '';
    return h`<section class="pg-automation__card" aria-labelledby="automation-rules-title"><div class="pg-automation__card-head"><div><h2 class="pg-automation__card-title" id="automation-rules-title">${t('Regras de entrada')} <span class="pg-automation__count">${bindings.length}</span></h2><p class="pg-automation__card-lead">${t('A primeira regra que corresponder organiza cada nova entrada ainda sem responsável.')}</p></div>${add}</div>${bindings.length ? h`<ul class="pg-automation__rules">${bindings.map(ruleItem)}</ul>` : rulesEmpty()}<p class="pg-automation__note">${t('As regras alteram etiquetas, departamento e fila. Conversas já assumidas continuam com o responsável. Nenhuma mensagem é enviada por esta automação.')}</p></section>`;
  }

  function slaCard() {
    const sla = config.sla;
    return h`<form id="automation-sla-form" class="pg-automation__card pg-automation__form" data-form="automation:sla" aria-labelledby="automation-sla-title"><div class="pg-automation__card-head"><div><h2 class="pg-automation__card-title" id="automation-sla-title">${t('Prazos de atendimento')}</h2><p class="pg-automation__card-lead">${t('As metas valem para os marcos registrados em cada ciclo de atendimento.')}</p></div>${badge(sla.enabled ? t('SLA ativo') : t('SLA desativado'), sla.enabled ? 'success' : 'neutral')}</div><input type="hidden" name="version"${attributes({ value: config.version })}/>${switchControl({ id: 'automation-sla-enabled', name: 'enabled', checked: sla.enabled, label: t('Acompanhar os prazos desta empresa'), attrs: { 'data-automation-focus': 'sla-enabled' } })}<div class="pg-automation__grid pg-automation__grid--2">${field({ id: 'automation-sla-first', label: t('Primeira resposta (minutos)'), hint: t('De 1 a 43.200 minutos (30 dias).'), hintId: 'automation-sla-first-hint', control: h`<input class="pg-automation__control" type="number" inputmode="numeric" min="1" max="43200" required aria-describedby="automation-sla-first-hint"${attributes({ id: 'automation-sla-first', name: 'firstReplyMinutes', value: sla.firstReplyMinutes })}/>` })}${field({ id: 'automation-sla-resolution', label: t('Resolução (minutos)'), hint: t('De 1 a 43.200 minutos (30 dias).'), hintId: 'automation-sla-resolution-hint', control: h`<input class="pg-automation__control" type="number" inputmode="numeric" min="1" max="43200" required aria-describedby="automation-sla-resolution-hint"${attributes({ id: 'automation-sla-resolution', name: 'resolutionMinutes', value: sla.resolutionMinutes })}/>` })}</div>${calendarFields(sla.calendar, 'automation-sla')}<div class="pg-automation__form-foot"><p class="pg-automation__form-error" role="alert" data-automation-error></p>${button({ label: t('Salvar prazos'), type: 'submit', variant: 'primary', icon: 'check', attrs: { 'data-automation-focus': 'sla-submit' } })}</div></form>`;
  }

  function slaCell(item, label) {
    const detail = item?.dueAt ? t('Até {date}', { date: date(item.dueAt) }) : item?.completedAt ? date(item.completedAt) : '—';
    return h`<td class="pg-automation__cell" role="cell"${attributes({ 'data-label': label })}>${badge(stateLabels[item?.state] || t('Sem dados'), stateTones[item?.state] || 'neutral')}<span class="pg-automation__cell-detail">${detail}</span></td>`;
  }

  function monitorCard() {
    const policy = config?.sla || snapshot?.policy, totals = snapshot?.totals || {};
    const lead = policy?.enabled ? t('Prazos da política atual, por conversa e ciclo registrado.') : t('Ative o SLA para acompanhar os compromissos desta empresa.');
    let body;
    if (snapshot && policy?.enabled) {
      const kpi = (label, value, tone) => h`<div class="pg-automation__kpi"${attributes({ 'data-tone': tone && value > 0 ? tone : null })}><dt>${label}</dt><dd>${value}</dd></div>`;
      const heads = [t('Contato'), t('Canal / responsável'), t('Primeira resposta'), t('Resolução')];
      const rows = (snapshot.conversations || []).map(c => h`<tr role="row"><td class="pg-automation__cell" role="cell"${attributes({ 'data-label': heads[0] })}><strong>${c.contact}</strong><span class="pg-automation__cell-detail">${({ open: t('Aberta'), pending: t('Pendente'), closed: t('Encerrada') })[c.status] || c.status}</span></td><td class="pg-automation__cell" role="cell"${attributes({ 'data-label': heads[1] })}><span>${(state.tenant?.channels || []).find(ch => ch.id === c.channelId)?.name || t('Canal')}</span><span class="pg-automation__cell-detail">${c.assignedUserId ? (state.users || []).find(u => u.id === c.assignedUserId)?.name || t('Pessoa responsável') : t('Na fila')}</span></td>${slaCell(c.firstReply, heads[2])}${slaCell(c.resolution, heads[3])}</tr>`);
      body = h`<dl class="pg-automation__kpis">${kpi(t('Ciclos acompanhados'), totals.tracked || 0)}${kpi(t('Primeira resposta excedida'), totals.firstReplyBreached || 0, 'danger')}${kpi(t('Resolução excedida'), totals.resolutionBreached || 0, 'danger')}${kpi(t('Sem marco suficiente'), totals.insufficient || 0, 'warning')}</dl>${rows.length ? h`<div class="pg-automation__table-wrap"><table class="pg-automation__table" role="table"><caption class="sr-only">${t('Prazos por conversa')}</caption><thead role="rowgroup"><tr role="row">${heads.map(head => h`<th role="columnheader" scope="col">${head}</th>`)}</tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>` : emptyState({ icon: 'inbox', level: 3, title: t('Nenhuma conversa visível para este acesso.') })}<p class="pg-automation__note">${t('Históricos reabertos sem marco de ciclo ou sem evento de encerramento aparecem sem dados suficientes. O horário semanal não inclui feriados.')}</p>`;
    } else if (snapshot) {
      body = emptyState({ icon: 'clock', level: 3, title: t('Acompanhamento desativado'), body: t('Acompanhamento desativado para esta empresa.'), action: admin() && config ? { label: t('Ativar prazos'), action: 'automation:focus-sla' } : undefined });
    } else body = emptyState({ icon: 'chart', level: 3, title: t('Indicadores indisponíveis'), body: t('Seu acesso não inclui os indicadores desta fila.') });
    return h`<section class="pg-automation__card" aria-labelledby="automation-monitor-title"><div class="pg-automation__card-head"><div><h2 class="pg-automation__card-title" id="automation-monitor-title">${t('Acompanhamento da fila')}</h2><p class="pg-automation__card-lead">${lead}</p></div>${badge(t('Horários e marcos reais'), 'info')}</div>${body}</section>`;
  }

  function rulesView() {
    const failure = error ? banner({ tone: 'danger', title: t('Não foi possível carregar as automações.'), body: error !== t('Não foi possível carregar as automações.') ? translateError(error) : '', action: { label: t('Tentar novamente'), action: 'automation:refresh' } }) : '';
    const configuration = admin() ? config ? h`${rulesCard()}${slaCard()}` : loading && !error ? h`<section class="pg-automation__card">${skeleton({ lines: 4, label: t('Carregando regras e prazos…') })}</section>` : '' : h`<p class="pg-automation__note">${t('As regras de entrada e os prazos são configurados pela administração da empresa.')}</p>`;
    return h`<div class="pg-automation pg-automation--rules">${heading(t('Regras e SLA'), t('Vincule fluxos publicados aos canais e acompanhe os prazos de atendimento desta empresa.'), refreshButton())}${failure}${configuration}${monitorCard()}</div>`;
  }

  function bindingForm(current, channels, flowsList) {
    const channelOptions = options(channels.map(c => [c.id, `${c.name}${automationChannelConnected(c) ? '' : t(' · desconectado')}`]), current.channelId);
    const publication = `${current.flowId}/${current.flowVersion}`;
    const groups = flowsList.map(f => h`<optgroup${attributes({ label: f.name })}>${(f.versions || []).map(v => { const value = `${f.id}/${v.version}`; return h`<option${attributes({ value, selected: value === publication })}>${`${f.name} · v${v.version}${f.state === 'archived' ? t(' · arquivado') : v.version === f.publishedVersion ? t(' · mais recente') : ''}`}</option>`; })}</optgroup>`);
    const command = current.trigger === 'command';
    return h`<form class="pg-automation__form" data-form="automation:binding"><input type="hidden" name="bindingId"${attributes({ value: current.id || '' })}/><input type="hidden" name="version"${attributes({ value: config.version })}/>${field({ id: 'automation-binding-name', label: t('Nome'), control: h`<input class="pg-automation__control" required autocomplete="off"${attributes({ id: 'automation-binding-name', name: 'name', maxlength: 80, value: current.name })}/>` })}<div class="pg-automation__grid pg-automation__grid--2">${field({ id: 'automation-binding-channel', label: t('Canal'), hint: t('WhatsApp QR, Telegram ou Webchat conectados.'), control: h`<select class="pg-automation__control" id="automation-binding-channel" name="channelId" required>${channelOptions}</select>` })}${field({ id: 'automation-binding-publication', label: t('Fluxo e versão publicada'), hint: t('A regra fica nesta versão até você escolher outra.'), control: h`<select class="pg-automation__control" id="automation-binding-publication" name="publication" required>${groups}</select>` })}${field({ id: 'automation-binding-trigger', label: t('Quando executar'), control: h`<select class="pg-automation__control" id="automation-binding-trigger" name="trigger" data-automation-trigger>${options([['new_conversation', t('Ao iniciar nova conversa')], ['incoming', t('Toda entrada ainda na fila')], ['command', t('Ao receber um comando')]], current.trigger)}</select>` })}${field({ id: 'automation-binding-command', label: t('Comando'), hint: t('Usado somente quando a regra é de comando.'), hintId: 'automation-binding-command-hint', control: h`<input class="pg-automation__control" placeholder="/ajuda" autocomplete="off" spellcheck="false" aria-describedby="automation-binding-command-hint" data-automation-command${attributes({ id: 'automation-binding-command', name: 'command', maxlength: 64, value: current.command || '', disabled: !command })}/>` })}</div>${switchControl({ id: 'automation-binding-enabled', name: 'enabled', checked: current.enabled, label: t('Regra ativa') })}${calendarFields(current.calendar, 'automation-binding')}<p class="pg-automation__form-error" role="alert" data-automation-error></p><div class="pg-automation__dialog-actions">${button({ label: t('Cancelar'), action: 'automation:close-dialog', variant: 'ghost' })}${button({ label: t('Salvar regra'), type: 'submit', variant: 'primary', icon: 'check' })}</div></form>`;
  }

  async function editor(binding, element) {
    const flowsList = publishedFlows();
    const historical = binding && (state.tenant.flows || []).find(f => f.id === binding.flowId); if (historical && !flowsList.some(f => f.id === historical.id)) flowsList.push(historical);
    if (!flowsList.length) { toast(t('Publique um fluxo antes de vincular uma regra.')); return; }
    const channels = connectedChannels();
    const historicalChannel = binding && state.tenant.channels.find(c => c.id === binding.channelId && automationChannelSupported(c));
    if (historicalChannel && !channels.some(c => c.id === historicalChannel.id)) channels.push(historicalChannel);
    if (!channels.length) { toast(t('Conecte um canal WhatsApp QR, Telegram ou Webchat antes de vincular uma regra.')); return; }
    const current = binding || { name: '', enabled: true, channelId: channels[0].id, flowId: flowsList[0].id, flowVersion: flowsList[0].publishedVersion, trigger: 'new_conversation', command: '', calendar: null };
    dialogs.open({ title: binding ? t('Editar regra') : t('Adicionar regra'), description: t('A rota atua somente em entradas ainda na fila. Para atualizar uma rota, escolha explicitamente outra publicação.'), body: bindingForm(current, channels, flowsList), kind: 'binding', returnElement: element || null, returnKey: binding ? `rule-edit:${binding.id}` : 'rules-add', size: 'md' });
  }

  function openRemove(binding, element) {
    const body = h`<div class="pg-automation__dialog-section"><p class="pg-automation__dialog-text">${t('As próximas entradas deixarão de usar esta regra. O fluxo e o histórico serão preservados.')}</p></div><div class="pg-automation__dialog-actions">${button({ label: t('Cancelar'), action: 'automation:close-dialog', variant: 'ghost' })}${button({ label: t('Remover regra'), action: 'automation:confirm-remove-binding', variant: 'danger', attrs: { 'data-id': binding.id } })}</div>`;
    dialogs.open({ title: t('Remover regra'), description: binding.name, body, kind: 'remove', returnElement: element || null, returnKey: 'rules-add', size: 'sm' });
  }

  async function save(input, expectedKey = key()) {
    await api(tenantApi('automation'), { method: 'PUT', body: JSON.stringify({ ...input, bindings: input.bindings.map(wireBinding) }) });
    if (key() !== expectedKey) return;
    await refresh(); if (key() !== expectedKey) return; render(); toast(t('Automações e prazos atualizados.'));
  }

  // ---- Respostas rápidas ----------------------------------------------------------------------

  /** Loads the catalog of the open company once (or again with force); resolves when it settles. */
  function loadReplies({ force = false } = {}) {
    const localKey = key();
    if (!localKey || !admin()) return Promise.resolve(false);
    if (replies.key !== localKey) Object.assign(replies, { key: localKey, items: null, error: '', loading: null, query: '' });
    if (replies.loading) return replies.loading;
    if (!force && (replies.items || replies.error)) return Promise.resolve(true);
    const ticket = ++replies.sequence;
    const settle = () => { if (ticket === replies.sequence) replies.loading = null; };
    replies.loading = Promise.resolve().then(() => api(tenantApi('quick-replies'))).then(result => {
      if (ticket !== replies.sequence || key() !== localKey) return false;
      replies.items = Array.isArray(result?.replies) ? result.replies : []; replies.error = '';
      return true;
    }, failure => {
      if (ticket !== replies.sequence || key() !== localKey) return false;
      replies.error = failure?.message || t('Não foi possível carregar as respostas rápidas.');
      return false;
    }).finally(settle);
    return replies.loading;
  }
  const repliesOpen = () => state.view === 'quick-replies';

  function repliesView() {
    const isAdmin = admin();
    if (!isAdmin) return h`<div class="pg-automation pg-automation--replies">${heading(t('Respostas rápidas'), t('Textos reutilizáveis da equipe desta empresa. Cada resposta é revisada no compositor antes do envio.'))}<section class="pg-automation__card">${emptyState({ icon: 'document', title: t('Gerenciadas pela administração'), body: t('A administração cria as respostas rápidas desta empresa. No Atendimento, use o botão Respostas rápidas do compositor.'), action: { label: t('Abrir Atendimento'), action: 'automation:open-inbox' } })}</section></div>`;
    if (replies.key !== key() || !replies.items && !replies.error && !replies.loading) {
      const localKey = key();
      void loadReplies().then(changed => { if (changed !== undefined && key() === localKey && repliesOpen()) render(); });
    }
    const items = replies.key === key() ? replies.items : null;
    const actions = h`${refreshButton()}${items?.length ? button({ label: t('Nova resposta'), action: 'automation:reply-new', variant: 'primary', icon: 'plus', attrs: { 'data-automation-focus': 'reply-new', 'aria-haspopup': 'dialog' } }) : ''}`;
    const failed = replies.error && replies.key === key();
    const body = failed && !items ? banner({ tone: 'danger', title: t('Não foi possível carregar as respostas rápidas.'), body: replies.error !== t('Não foi possível carregar as respostas rápidas.') ? translateError(replies.error) : '', action: { label: t('Tentar novamente'), action: 'automation:replies-retry' } }) : !items ? skeleton({ lines: 4, label: t('Carregando respostas rápidas…') }) : quickRepliesScreen(items, { query: replies.query });
    return h`<div class="pg-automation pg-automation--replies">${heading(t('Respostas rápidas'), t('Textos reutilizáveis da equipe desta empresa. Cada resposta é revisada no compositor antes do envio.'), actions)}<section class="pg-automation__card" aria-labelledby="automation-replies-title"><h2 class="sr-only" id="automation-replies-title">${t('Respostas desta empresa')}</h2>${body}</section></div>`;
  }

  function replyAdmin() { if (!admin()) throw new Error(t('Somente administradores gerenciam respostas rápidas.')); }

  function openReplyEditor(item, element) {
    replies.scope = key();
    dialogs.open({ title: item?.id ? t('Editar resposta rápida') : t('Nova resposta rápida'), description: state.tenant?.name || '', body: quickReplyEditorForm(item || {}, { limits: QUICK_REPLY_LIMITS }), kind: 'reply', returnElement: element || null, returnKey: item?.id ? `reply-edit:${item.id}` : 'reply-new', size: 'md' });
  }

  async function saveReply(form) {
    replyAdmin();
    const localKey = key();
    if (!localKey || replies.scope !== localKey) throw new Error(t('O acesso ou a empresa mudou. Abra o catálogo novamente.'));
    const { id, version, ...input } = readQuickReplyForm(form);
    await api(tenantApi(id ? `quick-replies/${encodeURIComponent(id)}` : 'quick-replies'), { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ ...input, ...(id ? { version } : {}) }) });
    if (key() !== localKey) throw new Error(t('Salvo na empresa de origem. Reabra o catálogo atual.'));
    await loadReplies({ force: true });
    if (key() !== localKey) return true;
    dialogs.close(); render(); toast(t('Resposta rápida salva.'));
    return true;
  }

  async function toggleReply(id) {
    replyAdmin();
    const item = (replies.key === key() ? replies.items || [] : []).find(reply => reply.id === id);
    if (!item) throw new Error(t('Resposta indisponível.'));
    const localKey = key();
    await api(tenantApi(`quick-replies/${encodeURIComponent(item.id)}`), { method: 'PATCH', body: JSON.stringify({ version: item.version, active: !item.active }) });
    if (key() !== localKey) return true;
    await loadReplies({ force: true });
    if (key() !== localKey) return true;
    focus.want(`reply-toggle:${item.id}`); render(); toast(item.active ? t('Resposta desativada.') : t('Resposta reativada.'));
    return true;
  }

  function patchReplies(input) {
    replies.query = input.value;
    const root = input.closest('.pg-automation'), results = root?.querySelector('[data-automation-results="replies"]'), count = root?.querySelector('[data-automation-replies-count]');
    if (results) results.innerHTML = String(quickRepliesResults(replies.items || [], { query: replies.query }));
    if (count) count.textContent = quickRepliesCount(replies.items || [], replies.query);
  }

  function updateReplyEditor(textarea) {
    const form = textarea.closest('form'), max = Number(textarea.maxLength) > 0 ? Number(textarea.maxLength) : QUICK_REPLY_LIMITS.text, length = textarea.value.length;
    const target = form?.querySelector('[data-automation-preview]'), counter = form?.querySelector('[data-automation-counter]');
    if (target) target.innerHTML = String(quickReplyPreview(textarea.value));
    if (counter) {
      counter.hidden = length < max * .8;
      counter.textContent = `${length.toLocaleString(getLocale())} / ${max.toLocaleString(getLocale())}`;
      if (length >= max) counter.dataset.state = 'full'; else delete counter.dataset.state;
    }
  }

  // ---- routes, hub strip and after-render --------------------------------------------------------

  /** Route on screen for a view of this hub (the hash when it opens the view), recorded for app.js. */
  function routeFor(view) {
    const parsed = parseHash(globalThis.location?.hash || '');
    const route = parsed && viewForRoute(parsed) === view ? parsed : routeForView(view) || { section: 'automation', params: {} };
    if (state && typeof state === 'object') (state.screenRoutes ||= {})[view] = JSON.stringify([route.section || null, route.params || {}]);
    return route;
  }

  let rendered = null, scheduled = false;
  function afterRender() {
    const info = rendered, main = doc()?.getElementById?.('main-content');
    if (!info || !main?.querySelector?.('.pg-automation')) return;
    if (info.view === 'flows') flows.afterRender();
    dialogs.reconcile?.();
    focus.restore(main);
  }
  function schedule(info) {
    rendered = info;
    if (scheduled || typeof globalThis.queueMicrotask !== 'function' || !doc()?.getElementById) return;
    scheduled = true;
    globalThis.queueMicrotask(() => { scheduled = false; afterRender(); });
  }

  const noCompany = () => String(h`<div class="pg-automation">${emptyState({ icon: 'workflow', level: 1, title: t('Escolha uma empresa'), body: t('A automação é configurada por empresa.') })}</div>`);
  function automationView() {
    routeFor('automation');
    schedule({ view: 'automation', tab: 'rules' });
    if (!state.tenant) return noCompany();
    return String(h`${rulesView()}${dialogShell()}`);
  }
  // Respostas rápidas (#automation/replies): its own view and tab of the hub (nav-config.js).
  function quickRepliesView() {
    routeFor('quick-replies');
    schedule({ view: 'quick-replies', tab: 'replies' });
    if (!state.tenant) return noCompany();
    return String(h`${repliesView()}${dialogShell()}`);
  }
  function flowsView() {
    const route = routeFor('flows');
    schedule({ view: 'flows', tab: 'flows' });
    return String(h`${flows.view(route)}${dialogShell()}`);
  }

  // ---- actions and forms ----------------------------------------------------------------------

  const go = hash => { if (globalThis.location) globalThis.location.hash = hash; return true; };

  async function act(action, id, element) {
    const name = LEGACY_ACTIONS[action] || action;
    if (typeof name !== 'string' || !name.startsWith('automation:')) return false;
    switch (name) {
      case 'automation:refresh':
        if (repliesOpen() && admin()) { await loadReplies({ force: true }); render(); return true; }
        await refresh(); render(); return true;
      case 'automation:close-dialog': (dialogs.requestClose || dialogs.close).call(dialogs); return true;
      case 'automation:dialog-keep': dialogs.keep?.(); return true;
      case 'automation:dialog-discard': dialogs.discard?.(); return true;
      case 'automation:open-flows': return go('#automation/flows');
      case 'automation:open-channels': return go('#channels');
      case 'automation:open-inbox': return go('#inbox');
      case 'automation:focus-sla': {
        const target = doc()?.getElementById?.('automation-sla-enabled');
        target?.scrollIntoView?.({ block: 'center', behavior: motionOK() ? 'smooth' : 'auto' });
        target?.focus?.({ preventScroll: true });
        return true;
      }
      case 'automation:new-binding': case 'automation:edit-binding': case 'automation:remove-binding': case 'automation:confirm-remove-binding': {
        if (!admin() || !config) throw Error(t('Este acesso não permite alterar regras.'));
        const binding = config.bindings.find(b => b.id === id);
        if (name === 'automation:new-binding') await editor(undefined, element);
        else if (name === 'automation:edit-binding') { if (!binding) throw Error(t('A regra mudou. Atualize a tela.')); await editor(binding, element); }
        else if (name === 'automation:remove-binding') { if (!binding) throw Error(t('A regra mudou. Atualize a tela.')); openRemove(binding, element); }
        else { const expectedKey = key(); await save({ version: config.version, bindings: config.bindings.filter(b => b.id !== id), sla: config.sla }, expectedKey); if (key() === expectedKey) dialogs.close(); }
        return true;
      }
      case 'automation:reply-new': replyAdmin(); openReplyEditor(null, element); return true;
      case 'automation:reply-edit': {
        replyAdmin();
        const item = (replies.key === key() ? replies.items || [] : []).find(reply => reply.id === id);
        if (!item) throw new Error(t('Resposta indisponível. Reabra o catálogo.'));
        openReplyEditor(item, element); return true;
      }
      case 'automation:reply-toggle': return toggleReply(id);
      case 'automation:replies-retry': replies.error = ''; await loadReplies({ force: true }); render(); return true;
      case 'automation:replies-clear-search': replies.query = ''; focus.want('replies-search'); render(); return true;
      default: return flows.act(name, id, element);
    }
  }

  async function submit(form) {
    const name = form?.dataset?.form || '';
    if (name === 'automation:simulate') return flows.submit(form);
    if (name === 'automation:reply') return saveReply(form);
    if (name !== 'automation:sla' && name !== 'automation:binding') return false;
    if (!config || !admin()) throw Error(t('Este acesso não permite configurar automações.'));
    const f = new FormData(form), version = Number(f.get('version')), expectedKey = key();
    if (name === 'automation:sla') await save({ version, bindings: config.bindings, sla: { enabled: f.has('enabled'), firstReplyMinutes: Number(f.get('firstReplyMinutes')), resolutionMinutes: Number(f.get('resolutionMinutes')), calendar: readCalendar(form) } }, expectedKey);
    else {
      const [flowId, versionText] = String(f.get('publication') || '').split('/'), flowVersion = Number(versionText), flow = state.flows.find(item => item.id === flowId) || (state.tenant.flows || []).find(item => item.id === flowId);
      if (!flow?.versions?.some(v => v.version === flowVersion)) throw Error(t('Escolha uma versão publicada do fluxo.'));
      if (flow.state === 'archived' && f.has('enabled')) throw Error(t('Este fluxo foi arquivado. Desative a regra ou escolha outra publicação.'));
      const bindingId = String(f.get('bindingId') || ''), binding = { ...(bindingId ? { id: bindingId } : {}), name: String(f.get('name') || ''), channelId: f.get('channelId'), flowId: flow.id, flowVersion, trigger: f.get('trigger'), enabled: f.has('enabled'), calendar: readCalendar(form), ...(f.get('trigger') === 'command' ? { command: String(f.get('command') || '') } : {}) };
      const channel = state.tenant.channels.find(c => c.id === binding.channelId), previous = config.bindings.find(b => b.id === bindingId);
      if (!automationChannelSupported(channel) || !automationChannelConnected(channel) && (binding.enabled || previous?.channelId !== binding.channelId)) throw Error(t('Conecte o canal antes de ativar esta regra. Uma regra existente pode ser desativada enquanto o canal está desconectado.'));
      const bindings = bindingId ? config.bindings.map(b => b.id === bindingId ? binding : b) : [...config.bindings, binding];
      await save({ version, bindings, sla: config.sla }, expectedKey); if (key() === expectedKey) dialogs.close();
    }
    return true;
  }

  // Forms sent through the registry: busy submit button, errors next to the form (role=alert).
  function setBusy(control, busy) {
    if (!control) return;
    if (busy) {
      control.setAttribute('aria-busy', 'true'); control.setAttribute('aria-disabled', 'true');
      if (!control.querySelector('.ui-spinner')) control.insertAdjacentHTML('afterbegin', '<span class="ui-spinner ui-btn__spinner--overlay" aria-hidden="true"></span>');
    } else {
      control.removeAttribute('aria-busy'); control.removeAttribute('aria-disabled');
      control.querySelector('.ui-spinner')?.remove();
    }
  }
  async function submitScreen(form) {
    if (form?.dataset?.automationBusy === 'true') return;
    const errorBox = form.querySelector?.('[data-automation-error]'), control = form.querySelector?.('[type="submit"]');
    form.dataset.automationBusy = 'true'; setBusy(control, true);
    if (errorBox) errorBox.textContent = '';
    try { await submit(form); }
    catch (failure) {
      const message = translateError(failure?.message) || t('Não foi possível concluir. Tente novamente.');
      if (form.isConnected && errorBox) errorBox.textContent = message; else toast(message, true);
    } finally { if (form.isConnected !== false) { delete form.dataset.automationBusy; setBusy(control, false); } }
  }

  registerScreen('automation', { act: (name, id, element) => act(name, id, element), submit: form => submitScreen(form) });

  // Delegated listeners of the screens (once per document): focus memory, search and editor previews,
  // the step fields of the flow and the dependent fields of the rule and calendar forms.
  const d = doc();
  if (d?.addEventListener && !installed.has(d)) {
    installed.add(d);
    d.addEventListener('focusin', event => {
      const target = event.target, keyed = target?.closest?.('[data-automation-focus]');
      if (keyed?.closest?.('.pg-automation')) { focus.remember(keyed.dataset.automationFocus); return; }
      const tab = target?.closest?.('.ui-hub[data-hub="automation"] [role="tab"]');
      if (tab?.dataset?.tab) focus.remember(`tab:${tab.dataset.tab}`);
    });
    d.addEventListener('input', event => {
      const target = event.target;
      if (target?.matches?.('[data-automation-search="replies"]')) { patchReplies(target); return; }
      if (target?.matches?.('[data-form="automation:reply"] textarea[name="text"]')) { updateReplyEditor(target); return; }
      flows.handleInput(event);
    });
    d.addEventListener('change', event => {
      const target = event.target;
      if (target?.matches?.('[data-automation-calendar-toggle]')) { target.closest('[data-automation-calendar]')?.setAttribute('data-state', target.checked ? 'on' : 'off'); return; }
      if (target?.matches?.('[data-automation-trigger]')) {
        const command = target.closest('form')?.querySelector('[data-automation-command]');
        if (command) { command.disabled = target.value !== 'command'; if (!command.disabled) command.focus(); }
        return;
      }
      flows.handleInput(event);
    });
  }

  return { views: { automation: automationView, flows: flowsView, 'quick-replies': quickRepliesView }, act, submit, refresh, reset };
}
