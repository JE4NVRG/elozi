import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy} from './i18n.js';
import './locales-operations.js';

import { rasterAvatar } from './avatar-ui.js';

const id = value => String(value ?? '');
const photo = value => rasterAvatar(value, 24 * 1024) ? value : null;
const escapeHTML = value => id(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const revision = value => Number.isSafeInteger(value) && value > 0;
function stale(message = i18nText('O atendimento mudou. Abra os participantes novamente.')) { return Object.assign(new Error(message), { code: 'participants-context', status: 409 }); }

// Server-projected access wins over the legacy owner check. Raw participant
// arrays describe the roster and never grant a capability in the browser.
export function attendanceReplyAccess(conversation, { userId, hasPermission = false, selecting = false } = {}) {
  if (selecting || !conversation || conversation.status === 'closed') return false;
  if (typeof conversation.attendanceAccess?.canReply === 'boolean') return conversation.attendanceAccess.canReply;
  return Boolean(userId && conversation.owner === 'human' && id(conversation.assignedUserId) === id(userId) && hasPermission);
}
export function attendanceParticipantRole(conversation, { userId } = {}) {
  if (!conversation) return 'observer';
  if (userId && conversation.owner === 'human' && id(conversation.assignedUserId) === id(userId)) return 'responsible';
  return conversation.status !== 'closed' && conversation.attendanceAccess?.canReply === true ? 'collaborator' : 'observer';
}
export function attendanceManagementAccess(conversation, { userId, role, hasPermission = false } = {}) {
  return Boolean(conversation && hasPermission && (role === 'reseller' || !conversation.assignedUserId || userId && id(conversation.assignedUserId) === id(userId)));
}
export function participantsContextKey(context = {}) {
  return context.active === true && !context.selecting && context.workspaceId && context.tenantId && context.userId && context.conversationId && context.channelId
    ? JSON.stringify([id(context.workspaceId), id(context.tenantId), id(context.userId), id(context.conversationId), id(context.channelId), id(context.authorityKey)]) : '';
}
export function normalizeParticipantsSnapshot(input = {}) {
  if (!revision(input.version) || typeof input.canManage !== 'boolean' || !Array.isArray(input.participants) || !Array.isArray(input.eligible)) throw stale(i18nText('Não foi possível conferir os participantes deste atendimento.'));
  const responsible = input.responsible?.id ? { id: id(input.responsible.id), name: id(input.responsible.name || i18nText('Responsável')), avatar: input.responsible.eligible !== false ? photo(input.responsible.avatar) : null } : null;
  const known = new Set(responsible ? [responsible.id] : []), participants = [];
  for (const item of input.participants) {
    if (!item?.userId || known.has(id(item.userId))) continue;
    const userId = id(item.userId); known.add(userId);
    participants.push({ userId, name: id(item.name || i18nText('Colaborador')), avatar: item.eligible !== false ? photo(item.avatar) : null, addedAt: id(item.addedAt), addedByUserId: id(item.addedByUserId), ...(item.eligible === false ? { eligible: false } : {}) });
  }
  const eligible = [];
  if (input.canManage) for (const item of input.eligible) {
    if (!item?.id || known.has(id(item.id))) continue;
    known.add(id(item.id)); eligible.push({ id: id(item.id), name: id(item.name || i18nText('Pessoa da equipe')), avatar: photo(item.avatar) });
  }
  return { responsible, participants, eligible, canManage: input.canManage, version: input.version };
}
export function participantsMarkup(snapshot, { escape = escapeHTML, icon = () => '', avatarHTML, busy = false, error = '', status = '', selectedUserId = '', reason = '', token = '' } = {}) {
  if (!snapshot) return error ? i18nHtml`<p class="participants-feedback" role="alert">${escape(translateError(error))}</p><div class="participants-footer"><small>Feche e abra a lista para consultar novamente.</small><button type="button" class="button" data-close-modal>Fechar</button></div>` : i18nHtml`<div class="participants-loading" role="status" aria-live="polite">${icon('refresh')} Conferindo acesso e participantes…</div>`;
  const initials = name => id(name).trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase('pt-BR');
  const person = (item, kind, eligible = true) => `${typeof avatarHTML === 'function' ? avatarHTML({ name: item.name, avatar: eligible ? photo(item.avatar) : null, kind }) : `<span class="participants-avatar ${kind}" aria-hidden="true">${escape(initials(item.name))}</span>`}<span class="participants-person-copy"><strong>${escape(item.name)}</strong><small>${kind === 'responsible' ? i18nText('Responsável pelo atendimento') : eligible ? i18nText('Colaborador deste atendimento') : i18nText('Acesso indisponível')}</small></span>`;
  const attributes = `data-participants-token="${escape(token)}" data-version="${snapshot.version}"`;
  return i18nHtml`<div class="participants-intro">${icon('users')}<p>Colaboradores podem responder e adicionar notas. O responsável continua cuidando da organização do atendimento.</p></div><section class="participants-section" aria-labelledby="participants-responsible"><h3 id="participants-responsible">Responsável</h3><div class="participants-person participants-responsible">${snapshot.responsible ? person(snapshot.responsible, 'responsible') : i18nMarkup('<span class="participants-empty">Este atendimento ainda não tem uma pessoa responsável.</span>')}<span class="participants-role">Responsável</span></div></section><section class="participants-section" aria-labelledby="participants-collaborators"><div class="participants-section-heading"><h3 id="participants-collaborators">Colaboradores</h3><span>${snapshot.participants.length}</span></div><ul class="participants-list">${snapshot.participants.length ? snapshot.participants.map(item => `<li class="participants-person">${person(item, 'collaborator', item.eligible !== false)}${snapshot.canManage ? i18nHtml`<button type="button" class="icon-button participants-remove" data-participants-action="remove" data-user-id="${escape(item.userId)}" ${attributes} aria-label="Remover ${escape(item.name)} deste atendimento" ${busy ? 'disabled' : ''}>${icon('close')}</button>` : ''}</li>`).join('') : i18nMarkup('<li class="participants-empty">Nenhum colaborador neste atendimento.</li>')}</ul></section>${snapshot.canManage ? i18nHtml`<form class="participants-add" data-participants-form ${attributes} aria-busy="${busy}"><label for="participant-user">Adicionar colaborador<select id="participant-user" name="userId" data-participant-user required ${busy || !snapshot.eligible.length ? 'disabled' : ''}><option value="">Escolha uma pessoa com acesso</option>${snapshot.eligible.map(item => `<option value="${escape(item.id)}" ${item.id === selectedUserId ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></label>${snapshot.eligible.length ? '' : i18nMarkup('<small class="participants-empty">Todas as pessoas elegíveis já estão neste atendimento.</small>')}<label for="participant-reason">Contexto para a equipe <span>(opcional)</span><input id="participant-reason" data-participant-reason name="reason" maxlength="240" value="${escape(reason)}" placeholder="Ex.: apoio na dúvida técnica" ${busy ? 'disabled' : ''}/></label><button type="submit" class="button primary" ${busy || !snapshot.eligible.length ? 'disabled' : ''}>${icon('plus')} Adicionar ao atendimento</button></form>` : i18nMarkup('<p class="participants-readonly">Você está consultando os participantes. Somente o responsável ou a gestão pode alterar esta lista.</p>')}<p class="participants-feedback" data-participants-feedback role="alert">${escape(translateError(error))}</p><p class="participants-status" role="status" aria-live="polite">${escape(translateCopy(status))}</p><div class="participants-footer"><small>A colaboração vale somente para este atendimento.</small><button type="button" class="button" data-close-modal>Fechar</button></div>`;
}

export function createParticipantsUI({ getContext = () => ({}), request, openModal, getModal = () => null, escape = escapeHTML, icon = () => '', avatarHTML, onRender = () => {},
  applyConversation = () => {}, onError = () => {} } = {}) {
  let sequence = 0, view = null;
  function owns(candidate = view) {
    const modal = getModal(), panel = modal?.querySelector('[data-participants-panel]');
    return Boolean(candidate && modal?.open && panel?.dataset.participantsToken === candidate.token && panel.dataset.participantsContextKey === candidate.key);
  }
  function current(candidate = view) {
    return Boolean(candidate && view === candidate && owns(candidate) && participantsContextKey(getContext()) === candidate.key);
  }
  function guard(candidate = view) { if (!current(candidate)) throw stale(); return getContext(); }
  function dismiss() {
    const candidate = view, own = owns(candidate), modal = getModal(); view = null; sequence++;
    candidate?.controller?.abort();
    if (own) modal.close();
  }
  function render(candidate = view) {
    if (!current(candidate)) return false;
    const panel = getModal().querySelector('[data-participants-panel]'), body = panel.querySelector('[data-participants-body]');
    if (!body) return false;
    const selected = panel.querySelector('[data-participant-user]'), reason = panel.querySelector('[data-participant-reason]');
    if (!candidate.clearDraft && selected) candidate.draft.userId = selected.value;
    if (!candidate.clearDraft && reason) candidate.draft.reason = reason.value;
    candidate.clearDraft = false;
    const active = getModal().ownerDocument?.activeElement, focusId = panel.contains?.(active) ? active?.id : '';
    const selectionStart = active?.selectionStart, selectionEnd = active?.selectionEnd;
    const waitingForVersion = candidate.snapshot && candidate.snapshot.version !== getContext().version;
    body.innerHTML = participantsMarkup(candidate.snapshot, { escape, icon, avatarHTML, busy: candidate.loading || candidate.saving || waitingForVersion, error: candidate.error, status: waitingForVersion ? i18nText('O atendimento está sendo atualizado. Aguarde antes de alterar a lista.') : candidate.status,
      selectedUserId: candidate.draft.userId, reason: candidate.draft.reason, token: candidate.token });
    const field = focusId ? panel.querySelector(`#${focusId}`) : null;
    if (field && !field.disabled) { field.focus?.({ preventScroll: true }); if (typeof selectionStart === 'number' && field.setSelectionRange) field.setSelectionRange(selectionStart, selectionEnd); }
    onRender(); return true;
  }
  function options(candidate, extra = {}) { return { ...extra, signal: candidate.controller.signal, headers: { 'X-Elozi-Workspace': candidate.context.workspaceId, ...extra.headers } }; }
  async function load(candidate) {
    if (!current(candidate)) return false;
    candidate.loading = true; render(candidate);
    try {
      const result = await request(candidate.path, options(candidate, { method: 'GET' }));
      const context = guard(candidate), snapshot = normalizeParticipantsSnapshot(result);
      if (candidate.context.canReply === true && context.canReply === false || snapshot.canManage && context.canManageParticipants === false) throw Object.assign(new Error(i18nText('Seu acesso a este atendimento mudou. Abra a lista novamente.')), { status: 403 });
      if (!revision(context.version) || snapshot.version < context.version) throw stale(i18nText('O atendimento mudou durante a consulta. Abra os participantes novamente.'));
      candidate.snapshot = snapshot; candidate.error = ''; return true;
    } catch (error) {
      if (!current(candidate)) return false;
      if ([401, 403, 404].includes(error.status)) { dismiss(); onError(translateError(error.message)); return false; }
      candidate.error = translateError(error.message) || i18nText('Não foi possível consultar os participantes.'); return false;
    } finally { candidate.loading = false; render(candidate); }
  }
  async function open() {
    const context = getContext(), key = participantsContextKey(context);
    if (!key || !revision(context.version)) throw stale();
    dismiss();
    const candidate = { context: { ...context }, key, token: String(++sequence), path: `/api/tenants/${encodeURIComponent(context.tenantId)}/conversations/${encodeURIComponent(context.conversationId)}/participants`,
      controller: new AbortController(), snapshot: null, loading: false, saving: false, error: '', status: '', draft: { userId: '', reason: '' } };
    view = candidate;
    openModal(i18nText('Participantes do atendimento'), context.contact || i18nText('Equipe desta conversa'), `<section class="participants-panel" data-participants-panel data-participants-token="${escape(candidate.token)}" data-participants-context-key="${escape(key)}"><div data-participants-body>${participantsMarkup(null, { escape, icon })}</div></section>`);
    return load(candidate);
  }
  async function mutate(action, userId, reason, target) {
    const candidate = view, context = guard(candidate), snapshot = candidate.snapshot;
    if (candidate.loading || candidate.saving) return false;
    if (!snapshot?.canManage || context.canManageParticipants === false) throw Object.assign(new Error(i18nText('Seu acesso permite apenas consultar os participantes.')), { status: 403 });
    if (!['add', 'remove'].includes(action) || !userId || action === 'add' && !snapshot.eligible.some(item => item.id === userId)
      || action === 'remove' && !snapshot.participants.some(item => item.userId === userId)) throw stale(i18nText('Escolha uma pessoa disponível neste atendimento.'));
    if (target?.dataset.participantsToken !== candidate.token || Number(target.dataset.version) !== snapshot.version || context.version !== snapshot.version) {
      await load(candidate); candidate.status = i18nText('A lista foi atualizada. Revise antes de tentar novamente.'); render(candidate); return false;
    }
    candidate.saving = true; candidate.error = ''; candidate.status = ''; render(candidate);
    try {
      const result = await request(candidate.path, options(candidate, { method: 'POST', body: JSON.stringify({ version: snapshot.version, action, userId, ...(reason.trim() ? { reason: reason.trim().slice(0, 240) } : {}) }) }));
      const latest = guard(candidate);
      if (latest.canManageParticipants === false || candidate.context.canReply === true && latest.canReply === false) throw Object.assign(new Error(i18nText('Seu acesso a este atendimento mudou. A lista foi fechada.')), { status: 403 });
      if (id(result?.id) !== id(candidate.context.conversationId) || id(result?.channelId) !== id(candidate.context.channelId) || !revision(result?.version)
        || result.version < snapshot.version || result.version < latest.version) throw stale(i18nText('O retorno não corresponde à revisão atual do atendimento.'));
      applyConversation(result);
      if (!current(candidate)) return false;
      candidate.draft = { userId: '', reason: '' }; candidate.clearDraft = true; candidate.status = action === 'add' ? i18nText('Colaborador adicionado ao atendimento.') : i18nText('Colaborador removido do atendimento.');
      await load(candidate); return true;
    } catch (error) {
      if (!current(candidate)) return false;
      if ([401, 403, 404].includes(error.status)) { dismiss(); onError(translateError(error.message)); return false; }
      candidate.error = translateError(error.message) || i18nText('Não foi possível alterar os participantes.');
      if (error.status === 409) { await load(candidate); candidate.status = i18nText('A lista foi atualizada. Revise antes de tentar novamente.'); }
      render(candidate); return false;
    } finally { candidate.saving = false; render(candidate); }
  }
  async function handleAction(target) {
    if (!target?.dataset.participantsAction) return false;
    if (target.disabled) return true;
    const candidate = view;
    if (!current(candidate) || !getModal().querySelector('[data-participants-panel]')?.contains(target)) return true;
    try { await mutate(target.dataset.participantsAction, id(target.dataset.userId), '', target); }
    catch (error) { if (current(candidate)) { candidate.error = translateError(error.message); render(candidate); } }
    return true;
  }
  async function submit(form) {
    if (!form?.hasAttribute('data-participants-form')) return false;
    const candidate = view;
    if (!current(candidate) || !getModal().querySelector('[data-participants-panel]')?.contains(form)) return true;
    try { await mutate('add', id(form.elements.namedItem('userId')?.value), id(form.elements.namedItem('reason')?.value), form); }
    catch (error) { if (current(candidate)) { candidate.error = translateError(error.message); render(candidate); } }
    return true;
  }
  function sync() {
    const candidate = view;
    if (!candidate) return false;
    if (!current(candidate)) { dismiss(); return false; }
    const context = getContext();
    if (candidate.context.canReply === true && context.canReply === false || candidate.snapshot?.canManage && context.canManageParticipants === false) { dismiss(); return false; }
    if (!candidate.loading && !candidate.saving && candidate.snapshot?.version !== context.version) void load(candidate);
    return true;
  }
  return { open, handleAction, submit, sync, dismiss, reset: dismiss, get opened() { return owns(); }, get busy() { return Boolean(view?.loading || view?.saving); } };
}
