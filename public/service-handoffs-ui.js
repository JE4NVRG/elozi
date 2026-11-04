import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, t as connectT, markup as connectMarkup } from './i18n.js';
import './locales-management.js';
// Copy added by P6 (Pendências, FRONTEND-V2 §5.3.4) lives in its own catalog and goes through connectT/connectMarkup.
import './locales-agent-connect.js';
const text = value => String(value ?? '');
const escape = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const revision = value => Number.isSafeInteger(value) && value > 0;
const states = i18nLabels({ pending: 'Aguardando revisão', acknowledged: 'Reconhecida', declined: 'Recusada' });
// "Marcar como visto" (acknowledge) records the review and never transfers the conversation (P6).
const stateLabel = state => state === 'acknowledged' ? connectT('Marcado como visto') : states[state];
const date = value => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(getLocale()) : i18nT('Data indisponível'); };

export function serviceHandoffsContextKey(c = {}) {
  if (c.supportGrantId && c.supportExpiresAt && (!Number.isFinite(Date.parse(c.supportExpiresAt)) || Date.parse(c.supportExpiresAt) <= Date.now())) return '';
  return c.active === true && !c.selecting && c.workspaceId && c.tenantId && c.conversationId && c.userId && c.canRead !== false
    ? JSON.stringify([c.workspaceId,c.tenantId,c.conversationId,c.userId,c.authorityKey || '',c.supportGrantId || '',c.channelId || '',c.departmentId || '',c.assignedUserId || '',c.assignedSupportGrantId || '',c.status || '',c.canDecide === true]) : '';
}

function normalize(item, conversationId) {
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.serviceId !== 'string' || !item.serviceId
    || item.conversationId !== conversationId || !revision(item.version) || !revision(item.conversationVersion)
    || !Object.hasOwn(states,item.state) || typeof item.reason !== 'string') throw new Error('A resposta não confirmou as solicitações deste atendimento. Atualize a lista.');
  return { id:item.id,serviceId:item.serviceId,serviceName:text(item.serviceName || i18nT('Serviço')),conversationId,
    conversationVersion:item.conversationVersion,version:item.version,state:item.state,reason:item.reason,
    createdAt:item.createdAt,updatedAt:item.updatedAt,decidedBy:item.decidedBy || null,decisionReason:text(item.decisionReason) };
}

export function createServiceHandoffsUI({ getContext, request, openModal, getModal = () => document.querySelector('#modal'), toast = () => {}, onUpdate = () => {}, onError = message => toast(message,true) } = {}) {
  let view = null, sequence = 0;
  // "Assumir" (P6, FRONTEND-V2 §5.3.4) reuses the take-over control of the open conversation drawn by
  // app.js: it exists and is enabled only when the person may take the conversation, so this modal never
  // offers a take-over the server would refuse. "Marcar como visto" (acknowledge) never transfers.
  const takeover = () => { const node = (getModal()?.ownerDocument || globalThis.document)?.querySelector?.('#app [data-action="takeover"]'); return node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' ? node : null; };
  const context = () => getContext() || {};
  const panel = () => getModal()?.querySelector?.('[data-service-handoffs-panel]');
  const owns = candidate => Boolean(candidate && getModal()?.open !== false && panel()?.dataset?.serviceHandoffToken === candidate.token);
  const current = candidate => Boolean(candidate && candidate === view && owns(candidate) && candidate.key === serviceHandoffsContextKey(context()));
  const button = (action,label,candidate,id = '',disabled = false) => i18nHtml`<button type="button" class="button" data-service-handoff-action="${action}" data-service-handoff-token="${escape(candidate?.token || '')}" data-id="${escape(id)}" ${disabled ? 'disabled' : ''} style="min-height:44px">${label}</button>`;
  function dismiss() { const previous = view; view = null; sequence++; previous?.controller.abort(); if (owns(previous)) getModal()?.close?.(); }
  getModal()?.addEventListener?.('close',() => { const previous = view; view = null; sequence++; previous?.controller.abort(); });
  function options(candidate,extra = {}) {
    return { ...extra,signal:candidate.controller.signal,headers:{'X-Elozi-Workspace':candidate.context.workspaceId,
      ...(candidate.context.supportGrantId ? {'X-Elozi-Support-Grant':candidate.context.supportGrantId} : {}),...extra.headers} };
  }
  function markup() {
    if (!serviceHandoffsContextKey(context())) return '';
    return i18nMarkup('<button type="button" class="button" data-service-handoff-action="open" style="min-height:44px" title="Revisar pedidos de apoio dos serviços">Pedidos dos agentes</button>');
  }
  function body(candidate) {
    const disabled = candidate.loading || candidate.saving, c = context();
    const intro = connectMarkup('<p class="muted">Os agentes pedem apoio à equipe. Marcar como visto registra a sua revisão e não transfere a conversa. Para atender, use Assumir.</p>');
    const feedback = i18nHtml`<p class="form-error" role="alert">${escape(translateError(candidate.error))}</p><p role="status" aria-live="polite">${escape(candidate.status)}</p>`;
    if (candidate.editor) {
      const editor = candidate.editor, item = editor.item;
      const lead = editor.action === 'acknowledge' ? intro + connectMarkup('<p class="muted">Marcar como visto não transfere a conversa.</p>') : intro;
      return i18nHtml`${lead}<section class="dialog-detail"><h3>${editor.action === 'acknowledge' ? connectT('Marcar pedido como visto') : i18nT('Recusar solicitação')}</h3><strong>${escape(item.serviceName)}</strong><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(item.reason)}</p><small>Solicitação v${item.version} · atendimento v${item.conversationVersion}</small><form data-service-handoff-form="decision" data-service-handoff-token="${escape(candidate.token)}" data-service-handoff-editor="${escape(editor.token)}"><label>Motivo da sua decisão<textarea name="reason" rows="3" maxlength="500" required ${disabled || candidate.requireRefresh ? 'disabled' : ''} style="width:100%;min-height:88px">${escape(editor.reason)}</textarea></label>${feedback}<div class="modal-actions">${button('back',i18nT('Voltar'),candidate,'',disabled)}<button type="submit" class="button primary" ${disabled || candidate.requireRefresh || c.canDecide !== true ? 'disabled' : ''} style="min-height:44px">${candidate.saving ? 'Registrando…' : editor.action === 'acknowledge' ? connectT('Marcar como visto') : i18nT('Recusar pedido')}</button></div></form></section>`;
    }
    const take = takeover() && candidate.items.some(item=>item.state === 'pending') ? button('take',connectT('Assumir atendimento'),candidate,'',disabled) : '';
    return i18nHtml`${intro}<div class="row-actions">${take}${button('refresh',i18nT('Atualizar'),candidate,'',disabled)}<button type="button" class="button" data-close-modal style="min-height:44px">Fechar</button></div>${feedback}${candidate.loading ? i18nMarkup('<p role="status">Consultando pedidos…</p>') : ''}${c.canDecide === true ? '' : i18nMarkup('<p class="muted">Somente o responsável atual pode decidir. Você está consultando o histórico.</p>')}<div class="table-scroll"><table><thead><tr><th>Serviço e pedido</th><th>Estado</th><th>Revisão</th></tr></thead><tbody>${candidate.items.map(item=>i18nHtml`<tr><td><strong>${escape(item.serviceName)}</strong><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(item.reason)}</p><small>${escape(date(item.createdAt))} · atendimento v${item.conversationVersion}</small></td><td>${escape(stateLabel(item.state))}${item.decisionReason ? i18nHtml`<p style="white-space:pre-wrap">${escape(item.decisionReason)}</p>` : ''}</td><td>${item.state === 'pending' && c.canDecide === true ? i18nHtml`<div class="row-actions">${button('acknowledge',connectT('Marcar como visto'),candidate,item.id,disabled || candidate.requireRefresh)}${button('decline',i18nT('Recusar'),candidate,item.id,disabled || candidate.requireRefresh)}</div>` : i18nMarkup('<span class="muted">Histórico preservado</span>')}</td></tr>`).join('') || i18nHtml`<tr><td colspan="3" class="empty">${candidate.loaded ? i18nT('Nenhuma solicitação de apoio neste atendimento.') : i18nT('Consulte os pedidos para começar.')}</td></tr>`}</tbody></table></div>`;
  }
  function render(candidate = view) {
    if (!current(candidate)) return false;
    const field = panel()?.querySelector?.('textarea[name="reason"]');
    if (candidate.editor && !candidate.clearDraft && field) candidate.editor.reason = field.value;
    candidate.clearDraft = false;
    const target = panel()?.querySelector?.('[data-service-handoffs-body]');
    if (!target) return false;
    target.innerHTML = body(candidate); return true;
  }
  async function load(candidate = view) {
    if (!current(candidate) || candidate.saving) return false;
    const ticket = ++candidate.generation; candidate.loading = true; candidate.error = ''; render(candidate);
    try {
      const result = await request(candidate.path,options(candidate,{method:'GET'}));
      if (!current(candidate) || ticket !== candidate.generation) return false;
      if (!Array.isArray(result?.requests) || result.requests.length > 30) throw new Error('Não foi possível confirmar a lista de solicitações.');
      const items = result.requests.map(item=>normalize(item,candidate.context.conversationId));
      if (new Set(items.map(item=>item.id)).size !== items.length) throw new Error('A resposta contém solicitações repetidas. Atualize a lista.');
      candidate.items = items; candidate.loaded = true; candidate.requireRefresh = false; candidate.editor = null; candidate.error = ''; return true;
    } catch (failure) {
      if (!current(candidate) || ticket !== candidate.generation) return false;
      if ([401,403,404].includes(failure.status)) { dismiss(); onError(translateError(failure.message)); return false; }
      candidate.error = failure.message || 'Não foi possível consultar os pedidos.'; candidate.requireRefresh = true; return false;
    } finally { if (ticket === candidate.generation) { candidate.loading = false; render(candidate); } }
  }
  async function open() {
    const c = context(), key = serviceHandoffsContextKey(c);
    if (!key) { onError(i18nT('Selecione um atendimento autorizado antes de consultar os pedidos.')); return false; }
    dismiss();
    const candidate = { context:{...c},key,token:String(++sequence),controller:new AbortController(),generation:0,
      path:`/api/tenants/${encodeURIComponent(c.tenantId)}/conversations/${encodeURIComponent(c.conversationId)}/service-handoffs`,items:[],loaded:false,loading:false,saving:false,editor:null,requireRefresh:false,error:'',status:'',clearDraft:false };
    view = candidate;
    openModal(i18nT('Pedidos dos agentes'),c.contact || i18nT('Revisão da equipe neste atendimento'),i18nHtml`<section data-service-handoffs-panel data-service-handoff-token="${escape(candidate.token)}"><div data-service-handoffs-body>${body(candidate)}</div></section>`);
    return load(candidate);
  }
  async function action(name,id) {
    if (!['open','refresh','acknowledge','decline','back','take'].includes(name)) return false;
    if (name === 'open') { await open(); return true; }
    if (name === 'take') {
      const node = takeover();
      if (!current(view)) return true;
      if (!node) { view.error = 'Este atendimento não pode ser assumido por você agora.'; render(view); return true; }
      dismiss(); node.click(); return true;
    }
    const candidate = view;
    if (!current(candidate)) { if (owns(candidate)) dismiss(); return true; }
    if (candidate.loading || candidate.saving) return true;
    if (name === 'refresh') { const ok = await load(candidate); if (ok && current(candidate)) { candidate.status = i18nT('Pedidos atualizados.'); render(candidate); } return true; }
    if (name === 'back') { candidate.editor = null; candidate.clearDraft = true; render(candidate); return true; }
    if (context().canDecide !== true) { candidate.error = 'Somente o responsável atual pode decidir este pedido.'; render(candidate); return true; }
    const item = candidate.items.find(item=>item.id === id);
    if (!candidate.loaded || candidate.requireRefresh || !item || item.state !== 'pending') { candidate.error = 'Atualize os pedidos antes de escolher uma solicitação pendente.'; render(candidate); return true; }
    candidate.editor = {item:{...item},action:name,token:String(++sequence),reason:''}; candidate.clearDraft = true; candidate.error = ''; candidate.status = ''; render(candidate); return true;
  }
  async function handleAction(node) {
    const name = node?.dataset?.serviceHandoffAction;
    if (!name) return false;
    if (node.disabled) return true;
    if (name !== 'open' && (!current(view) || node.dataset.serviceHandoffToken !== view.token || !panel()?.contains?.(node))) return true;
    return action(name,node.dataset.id);
  }
  async function submit(form) {
    if (form?.dataset?.serviceHandoffForm !== 'decision') return false;
    const candidate = view, editor = candidate?.editor;
    if (!current(candidate) || !editor || candidate.loading || candidate.saving || candidate.requireRefresh
      || form.dataset.serviceHandoffToken !== candidate.token || form.dataset.serviceHandoffEditor !== editor.token || !panel()?.contains?.(form)) return true;
    if (context().canDecide !== true) { candidate.error = 'Somente o responsável atual pode decidir este pedido.'; render(candidate); return true; }
    const reason = text(form.elements?.namedItem?.('reason')?.value).trim();
    editor.reason = reason;
    if (!reason || reason.length > 500) { candidate.error = 'Escreva um motivo entre 1 e 500 caracteres.'; render(candidate); return true; }
    candidate.saving = true; candidate.error = ''; candidate.status = ''; render(candidate);
    try {
      const result = await request(candidate.path+'/'+encodeURIComponent(editor.item.id),options(candidate,{method:'POST',body:JSON.stringify({version:editor.item.version,action:editor.action,reason})}));
      if (!current(candidate) || candidate.editor !== editor) return true;
      const item = normalize(result?.request,candidate.context.conversationId), expectedState = editor.action === 'acknowledge' ? 'acknowledged' : 'declined';
      if (item.id !== editor.item.id || item.serviceId !== editor.item.serviceId || item.version !== editor.item.version+1 || item.state !== expectedState || item.decidedBy !== candidate.context.userId || item.decisionReason !== reason) throw new Error('A resposta não confirmou esta decisão. Atualize a lista antes de tentar novamente.');
      candidate.items = candidate.items.map(existing=>existing.id === item.id ? {...item,serviceName:existing.serviceName} : existing);
      candidate.editor = null; candidate.clearDraft = true; candidate.status = editor.action === 'acknowledge' ? connectT('Pedido marcado como visto. A conversa não foi transferida; use Assumir para atender.') : i18nT('Solicitação recusada com seu motivo.');
      toast(candidate.status); onUpdate({request:item,conversationId:candidate.context.conversationId,tenantId:candidate.context.tenantId});
    } catch (failure) {
      if (!current(candidate)) return true;
      if ([401,403,404].includes(failure.status)) { dismiss(); onError(translateError(failure.message)); return true; }
      if (failure.status === 409) { candidate.saving = false; candidate.editor = null; await load(candidate); if (current(candidate)) candidate.status = i18nT('O pedido mudou. A lista foi atualizada; revise antes de decidir novamente.'); }
      else {
        candidate.error = failure.status ? failure.message : 'Não foi possível confirmar a decisão. Atualize a lista e confira o histórico antes de tentar novamente.';
        if (!failure.status) { candidate.editor = null; candidate.requireRefresh = true; candidate.clearDraft = true; }
      }
    } finally { candidate.saving = false; render(candidate); }
    return true;
  }
  function sync() { if (view && !current(view)) dismiss(); return Boolean(view && current(view)); }
  return { markup,render:markup,open,load,refresh:load,action,handleAction,submit,sync,dismiss,reset:dismiss,get opened(){return current(view);},get busy(){return Boolean(view?.loading || view?.saving);} };
}
