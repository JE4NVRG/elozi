import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy} from './i18n.js';
import './locales-operations.js';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const identity = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120 && !/\p{Cc}/u.test(value);
const groupId = value => typeof value === 'string' && /^-[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const membership = Object.freeze({get unknown() { return i18nText('Presença ainda não confirmada'); }, get creator() { return i18nText('Bot proprietário'); }, get administrator() { return i18nText('Bot administrador'); }, get member() { return i18nText('Bot presente'); }, get restricted() { return i18nText('Bot com restrições'); }, get left() { return i18nText('Bot saiu do grupo'); }, get kicked() { return i18nText('Bot removido do grupo'); }});
const permissionLabels = Object.freeze({get text() { return i18nText('texto'); }, get photos() { return i18nText('fotos'); }, get audios() { return i18nText('áudio'); }, get documents() { return i18nText('documentos'); }, get videos() { return i18nText('vídeos'); }, get voiceNotes() { return i18nText('voz'); }});
const permissionFields = [...Object.keys(permissionLabels), 'videoNotes'];
function permissions(value) {
  if (value !== undefined && (!value || Object.getPrototypeOf(value) !== Object.prototype || permissionFields.some(key => value[key] !== undefined && ![null, true, false].includes(value[key])))) throw new Error(i18nText('O servidor não confirmou as permissões de envio deste grupo.'));
  return Object.fromEntries(permissionFields.map(key => [key, value?.[key] ?? null]));
}
function permissionNote(group) {
  if (group.migrationConflict) return i18nText('Envio bloqueado por conflito de migração.');
  if (group.joined === false) return i18nText('Envio indisponível: o bot não está no grupo.');
  const entries = Object.entries(permissionLabels), allowed = entries.filter(([key]) => group.sendPermissions[key] === true).map(([, label]) => label), blocked = entries.filter(([key]) => group.sendPermissions[key] === false).map(([, label]) => label), unknown = entries.filter(([key]) => group.sendPermissions[key] === null).map(([, label]) => label);
  if (unknown.length === entries.length) return i18nText('Permissões de envio ainda não confirmadas.');
  return [blocked.length ? i18nTemplate`Bloqueados: ${blocked.join(', ')}.` : '', allowed.length ? i18nTemplate`Permitidos: ${allowed.join(', ')}.` : '', unknown.length ? i18nTemplate`Não confirmados: ${unknown.join(', ')}.` : ''].filter(Boolean).join(' ');
}

export function createTelegramGroupsUi({ state, api, openModal, escape: e = escapeHTML, toast = () => {}, getModal = () => globalThis.document?.querySelector('#modal'), onUpdate = () => {} } = {}) {
  let view = null, sequence = 0, controller = null, writing = false;
  const pending = new Map();
  const context = () => {
    const s = state.boot?.session || {};
    return { workspaceId: state.workspaceId || s.resellerId || '', tenantId: state.tenant?.id || '', userId: s.userId || '', authority: state.boot?.csrfToken || s.csrfToken || '',
      role: s.role, support: state.supportGrantId || s.supportGrantId || null, service: s.kind === 'service', permissions: s.permissions, scopeRules: s.scopeRules,
      route: state.view || '', platform: Boolean(s.platformOwner || s.platformAdmin), workspaces: (state.boot?.workspaces || []).map(w => [w.id, w.supportGrantId || null]), tenants: (state.boot?.tenants || []).map(t => t.id) };
  };
  const key = () => JSON.stringify(context());
  const allowed = () => { const c = context(); return identity(c.workspaceId) && identity(c.tenantId) && identity(c.userId) && c.role === 'reseller' && !c.support && !c.service && (!state.tenant?.resellerId || state.tenant.resellerId === c.workspaceId); };
  const current = record => allowed() && record?.key === key() && state.tenant?.channels?.some(c => c.id === record.channelId && c.kind === 'telegram');
  const panel = () => getModal()?.querySelector?.('[data-telegram-groups-panel]');
  const shown = record => view === record && current(record) && getModal()?.open !== false && panel()?.dataset.telegramGroupsToken === record.token;
  const headers = record => ({ 'X-Elozi-Workspace': record.workspaceId, ...(typeof record.authority === 'string' && record.authority ? { 'X-CSRF-Token': record.authority } : {}) });
  const endpoint = record => `/api/tenants/${encodeURIComponent(record.tenantId)}/channels/${encodeURIComponent(record.channelId)}/telegram/groups`;
  const pendingKey = record => JSON.stringify([record.key, record.channelId]);
  const button = (record, action, label) => `<button class="button" type="button" data-telegram-groups-action="${action}" data-telegram-groups-token="${record.token}">${label}</button>`;
  const feedback = text => { const node = panel()?.querySelector?.('.form-error'); if (node) node.textContent = text; };
  const disable = value => panel()?.querySelectorAll?.('[type="submit"]').forEach(node => { node.disabled = value; });
  function reset() { controller?.abort(); controller = null; view = null; sequence++; }
  function closeOwn() { const owns = view && panel()?.dataset.telegramGroupsToken === view.token; reset(); if (owns) getModal()?.close?.(); }
  getModal()?.addEventListener?.('close', () => { if (getModal()?.open === true) return; reset(); });
  function show(record, html) { if (!current(record)) return; openModal(i18nText('Grupos do Telegram'), i18nText('Seleção de atendimento deste bot e desta empresa'), `<div data-telegram-groups-panel data-telegram-groups-token="${record.token}">${html}</div>`); }
  function dto(result, record) {
    if (!result || result.tenantId !== record.tenantId || result.channelId !== record.channelId || !Number.isSafeInteger(result.version) || result.version < 0
        || !['all', 'selected'].includes(result.mode) || !Array.isArray(result.groupIds) || result.groupIds.length > 1000 || result.groupIds.some(id => !groupId(id))
        || !Array.isArray(result.groups) || ![null, 'all', 'mentions'].includes(result.groupReadMode) || typeof result.connectionState !== 'string') throw new Error(i18nText('O servidor não confirmou os grupos deste canal.'));
    const conflicts = result.migrationConflicts ?? [];
    if (!Array.isArray(conflicts) || conflicts.some(conflict => !conflict || !groupId(conflict.fromGroupId) || !groupId(conflict.toGroupId) || conflict.fromGroupId === conflict.toGroupId)) throw new Error(i18nText('O servidor não confirmou o estado de migração dos grupos.'));
    const groups = result.groups.map(group => {
      if (!group || !groupId(group.id) || typeof group.name !== 'string' || group.name.length > 80 || !['group', 'supergroup'].includes(group.type) || !Object.hasOwn(membership, group.memberStatus)
          || ![null, true, false].includes(group.joined) || ![null, true, false].includes(group.canSend) || group.migrationConflict !== undefined && typeof group.migrationConflict !== 'boolean') throw new Error(i18nText('O servidor não confirmou os grupos deste canal.'));
      return { id: group.id, name: group.name, type: group.type, memberStatus: group.memberStatus, joined: group.joined, canSend: group.canSend, sendPermissions: permissions(group.sendPermissions), migrationConflict: group.migrationConflict === true || conflicts.some(c => c.fromGroupId === group.id || c.toGroupId === group.id) };
    });
    if (new Set(groups.map(g => g.id)).size !== groups.length || result.groupIds.some(id => !groups.some(g => g.id === id))) throw new Error(i18nText('O servidor não confirmou a seleção deste canal.'));
    return { tenantId: result.tenantId, channelId: result.channelId, version: result.version, mode: result.mode, groupIds: [...new Set(result.groupIds)], groups, groupReadMode: result.groupReadMode, connectionState: result.connectionState, migrationConflicts: conflicts.map(c => ({ fromGroupId: c.fromGroupId, toGroupId: c.toGroupId })) };
  }
  function summary(value) {
    const conflictNotice = value.groups.some(g => g.migrationConflict) ? i18nMarkup('<p role="alert">Uma migração encontrou históricos ou contatos distintos. Os vínculos e históricos foram preservados. Novas mensagens e respostas nesses grupos estão bloqueadas até revisão administrativa; mudar a seleção não resolve o conflito.</p>') : '';
    return i18nHtml`<p>Revisão ${value.version}: ${value.mode === 'all' ? i18nText('todos os grupos conhecidos e futuros') : i18nTemplate`${value.groupIds.length} grupo(s) selecionado(s)`}. Conexão: ${e(value.connectionState)}.</p>${conflictNotice}`;
  }
  function editor(record, notice = '') {
    const value = record.status;
    const privacy = value.groupReadMode === 'all' ? i18nText('O bot informa acesso a todas as mensagens permitidas pelo Telegram nos grupos.') : value.groupReadMode === 'mentions' ? i18nText('Privacidade do bot ativa: o Telegram entrega comandos, menções e respostas permitidas. Selecionar um grupo não amplia essa permissão.') : i18nText('O estado de privacidade será informado após conectar o bot.');
    const rows = value.groups.map(g => `<label class="checkbox-label" style="align-items:flex-start"><input type="checkbox" name="groupIds" value="${e(g.id)}" ${value.groupIds.includes(g.id) ? 'checked' : ''}/><span><strong>${e(g.name)}</strong><small style="display:block">${g.type === 'supergroup' ? i18nText('Supergrupo') : i18nText('Grupo')} · ${e(membership[g.memberStatus])}${g.migrationConflict ? i18nText(' · Migração com conflito; atendimento bloqueado') : g.canSend === false && g.joined !== false ? i18nText(' · Sem permissão de resposta') : ''}</small><small style="display:block" data-telegram-group-permissions="${e(g.id)}">${e(permissionNote(g))}</small></span></label>`).join('');
    show(record, i18nHtml`${summary(value)}<p>${privacy}</p><p>São exibidos apenas grupos conhecidos por eventos do bot ou pelo histórico deste canal. Adicione o bot ao grupo e envie uma mensagem que ele possa receber para descobri-lo.</p><form data-telegram-groups-form data-telegram-groups-token="${record.token}"><fieldset class="person-scope"><legend>Recepção e respostas em grupos</legend><label class="checkbox-label"><input type="radio" name="mode" value="all" ${value.mode === 'all' ? 'checked' : ''}/>Todos os grupos conhecidos e futuros</label><label class="checkbox-label"><input type="radio" name="mode" value="selected" ${value.mode === 'selected' ? 'checked' : ''}/>Somente os grupos selecionados abaixo</label><small>No modo selecionado, uma lista vazia bloqueia todos os grupos. Conversas diretas continuam disponíveis; o histórico existente é preservado.</small></fieldset><fieldset class="person-scope"><legend>Grupos conhecidos</legend>${rows || i18nMarkup('<p>Nenhum grupo conhecido neste canal.</p>')}</fieldset><p class="form-error" role="alert">${e(translateCopy(notice))}</p><div data-telegram-groups-current></div><div class="modal-actions">${button(record, 'refresh', i18nText('Atualizar grupos'))}<button class="button primary" type="submit">Salvar seleção</button></div></form>`);
  }
  function uncertain(record) { show(record, i18nHtml`<p>A confirmação da seleção não chegou. Consulte a revisão no servidor antes de tentar salvar novamente.</p>${button(record, 'verify', i18nText('Verificar seleção no servidor'))}<p class="form-error" role="alert"></p>`); }
  const matches = (value, expected) => value.mode === expected.mode && JSON.stringify([...value.groupIds].sort()) === JSON.stringify([...expected.groupIds].sort());
  async function read(record, { preserve = false, verify = false } = {}) {
    if (!shown(record)) return false;
    controller?.abort(); controller = new AbortController(); const ticket = ++sequence, signal = controller.signal;
    try {
      const result = await api(endpoint(record), { method: 'GET', headers: headers(record), signal });
      if (!shown(record) || ticket !== sequence) { if (view === record && !current(record)) closeOwn(); return false; }
      const value = dto(result, record), previousGroups = record.status?.groups || []; record.status = value;
      if (verify) {
        const attempt = pending.get(pendingKey(record)); pending.delete(pendingKey(record)); record.uncertain = false;
        editor(record, attempt && value.version === attempt.version + 1 && matches(value, attempt) ? i18nText('A seleção enviada foi confirmada no servidor.') : i18nText('Confira a revisão atual; uma nova alteração exige salvar explicitamente.'));
        try { await onUpdate(value); } catch { if (shown(record)) toast(i18nText('Seleção consultada; atualize a tela para conferir.'), true); }
      } else if (preserve) {
        record.conflict = false; feedback(i18nText('Revisão atual consultada. Sua seleção foi mantida; confira os grupos antes de salvar.'));
        const slot = panel()?.querySelector?.('[data-telegram-groups-current]'); if (slot) slot.innerHTML = summary(value);
        for (const previous of previousGroups) {
          const node = panel()?.querySelector?.(`[data-telegram-group-permissions="${previous.id}"]`), group = value.groups.find(item => item.id === previous.id);
          if (node) node.textContent = group ? permissionNote(group) : i18nText('Grupo não confirmado nesta revisão. Atualize a seleção.');
        }
        disable(false);
      } else editor(record);
      return true;
    } catch (failure) {
      if (!shown(record) || ticket !== sequence || failure.name === 'AbortError') return false;
      if ([401, 403, 404].includes(failure.status)) { closeOwn(); toast(i18nText('Seu acesso ou o canal mudou. Abra novamente pelo acesso autorizado.'), true); }
      else feedback(i18nText('Não foi possível confirmar os grupos deste canal. Atualize e tente novamente.'));
      return false;
    }
  }
  async function open(channel) {
    if (channel?.kind !== 'telegram') return false;
    if (!allowed() || !state.tenant?.channels?.some(c => c.id === channel.id && c.kind === 'telegram')) { toast(i18nText('A seleção de grupos pertence ao administrador desta empresa.'), true); return false; }
    controller?.abort(); const c = context(), record = { ...c, key: key(), channelId: channel.id, token: String(++sequence), status: null, conflict: false };
    record.uncertain = pending.has(pendingKey(record)); view = record;
    show(record, i18nHtml`<p role="status">Consultando grupos deste canal…</p><p class="form-error" role="alert"></p>${button(record, 'refresh', i18nText('Tentar novamente'))}`);
    return read(record, { verify: record.uncertain });
  }
  async function action(node) {
    if (!['refresh', 'verify'].includes(node?.dataset?.telegramGroupsAction)) return false;
    const record = view;
    if (!record || node.dataset.telegramGroupsToken !== record.token || !shown(record)) { if (!current(record)) closeOwn(); return true; }
    if (writing) { feedback(i18nText('Aguarde a confirmação da gravação atual.')); return true; }
    await read(record, { preserve: record.conflict, verify: record.uncertain || node.dataset.telegramGroupsAction === 'verify' }); return true;
  }
  async function submit(form) {
    if (!form?.dataset || !Object.hasOwn(form.dataset, 'telegramGroupsForm')) return false;
    const record = view;
    if (!record || form.dataset.telegramGroupsToken !== record.token || !shown(record)) throw new Error(i18nText('Abra a seleção novamente na empresa e no canal atuais.'));
    if (writing || record.conflict || record.uncertain || !record.status) throw new Error(i18nText('Atualize a revisão e aguarde a confirmação antes de salvar.'));
    const values = new FormData(form), mode = values.get('mode'), groupIds = [...new Set(values.getAll('groupIds'))];
    if (!['all', 'selected'].includes(mode) || groupIds.length > 1000 || groupIds.some(id => !groupId(id) || !record.status.groups.some(g => g.id === id))) throw new Error(i18nText('Selecione somente grupos conhecidos desta revisão.'));
    const body = { version: record.status.version, mode, groupIds }; writing = true; disable(true); let accepted = false;
    try {
      const result = await api(endpoint(record), { method: 'POST', headers: headers(record), body: JSON.stringify(body) });
      if (!shown(record)) { if (view === record && !current(record)) closeOwn(); return true; }
      const value = dto(result, record); if (value.version !== body.version + 1 || !matches(value, body)) throw new Error(i18nText('A seleção enviada ainda não foi confirmada.'));
      accepted = true; pending.delete(pendingKey(record)); record.status = value; await onUpdate(value);
      if (shown(record)) { closeOwn(); toast(i18nText('Seleção de grupos salva.')); }
    } catch (failure) {
      if (!shown(record)) { if (view === record && !current(record)) closeOwn(); return true; }
      if (accepted) { closeOwn(); toast(i18nText('Seleção salva; atualize a tela para conferir.'), true); }
      else if ([401, 403, 404].includes(failure.status)) { closeOwn(); toast(i18nText('Seu acesso ou o canal mudou. Abra novamente pelo acesso autorizado.'), true); }
      else if ([400, 409, 413, 422, 429].includes(failure.status)) { record.conflict = failure.status === 409; feedback(record.conflict ? i18nText('A seleção mudou. Sua escolha foi mantida; atualize a revisão antes de salvar.') : i18nText('Não foi possível salvar. Confira os grupos e os campos.')); }
      else { pending.set(pendingKey(record), body); record.uncertain = true; uncertain(record); }
    } finally { writing = false; if (shown(record)) disable(record.conflict || record.uncertain); }
    return true;
  }
  return { open, action, submit, reset };
}
