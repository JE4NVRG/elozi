import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy} from './i18n.js';
// White label of the agent copy (P5): the engine name stays out of customer workspaces.
import './locales-agents-hub.js';
import './locales-operations.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const iso = value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const scopes = i18nLabels({ contact: 'De cliente', operation: 'Da operação' });
const permission = (session, name) => session?.role === 'reseller' || session?.permissions == null || session.permissions.includes(name);
function localDate(value) {
  if (!value) return '';
  const date = new Date(value), pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function expiration(value) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error(i18nText('Informe uma data e hora válidas para a validade.'));
  const date = new Date(value);
  const instant = Date.now();
  if (!Number.isFinite(date.getTime()) || localDate(date.toISOString()) !== value || date.getTime() <= instant || date.getTime() > instant + 365 * 86400000) throw Error(i18nText('Escolha uma validade futura de até 365 dias, no horário local.'));
  return date.toISOString();
}

/** Human-curated facts only. Private content stays in this controller and its owned modal. */
export function createAgentMemoryUI(ctx) {
  const { state, api, tenantApi, escape: e, formModal, closeModal, toast, icon } = ctx, attr = ctx.attr || e;
  const modal = () => globalThis.document?.querySelector('#modal');
  const conversation = () => state.tenant?.conversations?.find(c => c.id === state.conversation);
  const agents = () => (state.tenant?.agents || []).filter(a => a.provider === 'hermes' && a.mode === 'copilot' && a.configured === true);
  let active = null, sequence = 0;
  const controllers = new Set();
  const eligible = () => Boolean(state.boot?.session?.userId && state.tenant?.id && state.workspaceId && !state.inboxSelecting
    && !state.supportGrantId && !state.boot.session.supportGrantId && !state.boot.session.serviceId
    && ['reseller', 'operator'].includes(state.boot.session.role) && permission(state.boot.session, 'inbox.read'));
  function contextKey(agentId) {
    const s = state.boot?.session || {}, c = conversation(), a = agents().find(item => item.id === agentId);
    // Polling version advances do not close an editor. The captured CAS is reviewed separately.
    return JSON.stringify([state.workspaceId, state.tenant?.id, s.userId, s.resellerId, s.role, s.permissions, s.scopeRules,
      s.platformOwner, state.supportGrantId || s.supportGrantId || null, state.boot?.csrfToken || '', state.view,
      c?.id, c?.contactId || null, c?.channelId, c?.departmentId || null, c?.status, c?.owner, c?.assignedUserId || null, c?.agentId || null,
      a?.id, a?.version, a?.configured, a?.provider, a?.mode]);
  }
  function owns(task) {
    const m = modal();
    return Boolean(task?.form?.isConnected !== false && m?.querySelector('[data-dialog-form]') === task?.form && task?.form?.dataset.memoryToken === task.token);
  }
  function erase(task, close = true) {
    if (!owns(task)) return;
    task.form.replaceChildren?.(); if (!task.form.replaceChildren) task.form.innerHTML = '';
    if (close) closeModal();
  }
  function reset() {
    const old = active; active = null; sequence++; for (const c of controllers) c.abort(); controllers.clear(); erase(old);
  }
  function current(task, requireForm = true) {
    if (!task || active !== task) return false;
    if (!eligible() || task.key !== contextKey(task.agentId) || !agents().some(a => a.id === task.agentId)) { reset(); return false; }
    if (requireForm && (!owns(task) || modal()?.open === false)) { active = null; sequence++; for (const c of controllers) c.abort(); controllers.clear(); return false; }
    return true;
  }
  function syncContext() { return active ? current(active) : false; }
  const button = (label, action, id = '', style = '') => `<button type="button" class="${style === 'primary' ? 'button primary' : style === 'text' ? 'text-button' : 'button'}" data-action="${attr(action)}" data-id="${attr(id)}">${e(label)}</button>`;
  const date = value => value ? new Date(value).toLocaleString(getLocale()) : i18nText('Sem prazo definido');
  function dto(value, agentId) {
    if (!object(value) || !identity(value.id) || value.agentId !== agentId || !Object.hasOwn(scopes, value.scope)
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100 || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 1500
      || !positive(value.version) || !['active', 'archived'].includes(value.status) || !iso(value.expiresAt) || typeof value.expired !== 'boolean'
      || !object(value.origin) || !identity(value.origin.conversationId) || !identity(value.origin.channelId)
      || value.origin.contactId !== null && !identity(value.origin.contactId) || value.origin.departmentId !== null && !identity(value.origin.departmentId)) throw Error(i18nText('O servidor não confirmou os fatos deste agente. Atualize a consulta.'));
    return { id: value.id, agentId, title: value.title, content: value.content, scope: value.scope, version: value.version, status: value.status,
      expiresAt: value.expiresAt, expired: value.expired, origin: { conversationId: value.origin.conversationId, channelId: value.origin.channelId, departmentId: value.origin.departmentId, contactId: value.origin.contactId },
      createdBy: typeof value.createdBy === 'string' ? value.createdBy : '', reviewedBy: typeof value.reviewedBy === 'string' ? value.reviewedBy : '' };
  }
  function receive(task, value) {
    if (!object(value) || !Array.isArray(value.items) || value.items.length > 500 || typeof value.canWrite !== 'boolean' || typeof value.canManageOperation !== 'boolean') throw Error(i18nText('A consulta não confirmou a memória deste agente.'));
    const items = value.items.map(item => dto(item, task.agentId)); if (new Set(items.map(i => i.id)).size !== items.length) throw Error(i18nText('A consulta retornou fatos repetidos.'));
    task.items = items; task.canWrite = value.canWrite; task.canManageOperation = value.canManageOperation && state.boot.session.role === 'reseller';
    if (task.editor && !mayWrite(task, task.editor.scope)) { task.editor = null; task.mode = 'list'; }
  }
  async function request(task, options, suffix = '') {
    if (!current(task)) return null;
    const ticket = ++sequence, controller = new AbortController(); controllers.add(controller);
    try {
      const value = await api(task.path + suffix, { ...options, signal: controller.signal, headers: { ...options?.headers, 'X-Elozi-Workspace': task.workspaceId } });
      return current(task) && ticket === sequence ? value : null;
    } catch (error) {
      if (!current(task) || ticket !== sequence) return null;
      if ([401, 403, 404].includes(error.status)) reset(); throw error;
    } finally { controllers.delete(controller); }
  }
  function agentSelect(task) {
    return i18nHtml`<label class="memory-agent-choice">Copiloto<select name="memoryAgent" data-memory-agent>${agents().map(a => `<option value="${attr(a.id)}" ${task.agentId === a.id ? 'selected' : ''}>${e(a.name || i18nText('Copiloto'))}</option>`).join('')}</select></label>`;
  }
  function origin(item) {
    const channel = state.tenant?.channels?.find(c => c.id === item.origin.channelId), department = state.tenant?.departments?.find(d => d.id === item.origin.departmentId);
    return [channel?.name || i18nText('Atendimento autorizado'), department?.name].filter(Boolean).map(e).join(' · ');
  }
  const mayWrite = (task, scope) => scope === 'operation' ? task.canManageOperation : task.canWrite;
  function card(task, item) {
    const status = item.status === 'archived' ? i18nText('Arquivado') : item.expired ? i18nText('Validade encerrada') : i18nText('Ativo');
    const manage = mayWrite(task, item.scope);
    return `<article class="memory-card"><div class="memory-card-meta"><span class="memory-scope">${e(scopes[item.scope])}</span><span class="memory-status ${item.status === 'archived' || item.expired ? 'memory-muted' : ''}">${e(translateCopy(status))}</span><span class="memory-revision">v${item.version}</span></div><h3>${e(item.title)}</h3><p class="memory-card-content">${e(item.content)}</p><div class="memory-card-origin">${icon('building')}<span>${origin(item)}<br/>${e(date(item.expiresAt))}</span></div>${manage ? `<div class="memory-card-actions">${item.status === 'active' ? button(item.expired ? i18nText('Revisar validade') : i18nText('Editar fato'), 'memory-edit', item.id) + button(i18nText('Arquivar'), 'memory-archive', item.id) : item.expired ? i18nMarkup('<span class="memory-help">Validade encerrada. Edite a validade antes de reativar.</span>') + button(i18nText('Revisar validade'), 'memory-edit', item.id) : button(i18nText('Reativar'), 'memory-reactivate', item.id)}</div>` : ''}</article>`;
  }
  function mount(task, kind, html, submitLabel) {
    if (!current(task, false)) return;
    const agent = agents().find(a => a.id === task.agentId);
    formModal(i18nText('Memória do agente'), `${agent.name || i18nText('Copiloto')} · ${state.tenant.name || i18nText('Empresa atual')}`, kind, `<section class="agent-memory" data-memory-mode="${attr(task.mode)}">${html}</section>`, submitLabel);
    task.form = modal()?.querySelector('[data-dialog-form]'); task.token = `memory-${++sequence}`;
    if (task.form) task.form.dataset.memoryToken = task.token;
    const submit = task.form?.querySelector('[type="submit"]'); if (submit) { submit.disabled = task.mode === 'list' || task.pending; submit.hidden = task.mode === 'list'; }
  }
  function library(task, loading = false) {
    task.mode = 'list'; task.editor = null;
    mount(task, 'memory-create', i18nHtml`<div class="memory-library-head">${agentSelect(task)}<div class="memory-library-tools">${button(i18nText('Atualizar'), 'memory-refresh')}${(task.canWrite || task.canManageOperation) && !loading ? button(i18nText('Adicionar fato'), 'memory-new', '', 'primary') : ''}</div></div><p class="memory-governance">Fatos revisados por pessoas, disponíveis a este copiloto dentro da empresa. Notas internas e fontes de conhecimento continuam separadas.</p>${loading ? i18nMarkup('<p class="memory-empty" role="status">Consultando os fatos autorizados…</p>') : task.items.length ? `<div class="memory-list">${task.items.map(item => card(task, item)).join('')}</div>` : i18nHtml`<div class="memory-empty"><span>${icon('document')}</span><h3>Nenhum fato salvo para este contexto.</h3><p>Adicione apenas o que a equipe confirmou e quer reutilizar no atendimento.</p></div>`}<p class="memory-help">Arquivar interrompe o uso pelo copiloto e conserva o texto para revisão.</p>`, i18nText('Autorizar uso pelo copiloto'));
  }
  async function load(task, keepEditor = false) {
    const value = await request(task, { method: 'GET' }, `?agentId=${encodeURIComponent(task.agentId)}`);
    if (!value || !current(task)) return false;
    const hadEditor = task.editor; receive(task, value);
    if (!keepEditor || hadEditor && !task.editor) library(task);
    return true;
  }
  async function open(selected) {
    reset(); const c = conversation();
    if (!eligible() || !c || !identity(c.id) || selected?.id !== c.id || !positive(c.version)) throw Error(i18nText('Escolha um atendimento autorizado para consultar a memória.'));
    const choices = agents(); if (!choices.length) throw Error(i18nText('Configure um copiloto gerenciado nesta empresa.'));
    const agentId = choices.some(a => a.id === c.agentId) ? c.agentId : choices[0].id;
    const task = active = { agentId, workspaceId: state.workspaceId, key: contextKey(agentId), path: tenantApi(`conversations/${encodeURIComponent(c.id)}/memories`), items: [], canWrite: false, canManageOperation: false, pending: false };
    library(task, true); await load(task); return true;
  }
  function editor(task, item = null, operation = 'create', preserved = null) {
    if (item ? !mayWrite(task, item.scope) : !task.canWrite && !task.canManageOperation) throw Error(i18nText('Seu acesso não permite alterar este fato.'));
    const data = preserved || { scope: item?.scope || (task.canWrite ? 'contact' : 'operation'), title: item?.title || '', content: item?.content || '', expiresAt: localDate(item?.expiresAt), reviewed: false };
    task.mode = operation; task.editor = { ...data, operation, id: item?.id, version: item?.version, conversationVersion: conversation().version, conflicted: false, latest: null };
    const decision = ['archive', 'reactivate'].includes(operation);
    const controls = decision ? `<div class="memory-decision"><span class="memory-scope">${e(scopes[item.scope])}</span><h3>${e(item.title)}</h3><p>${e(item.content)}</p><small>${e(date(item.expiresAt))}</small></div><p class="memory-governance">${operation === 'archive' ? i18nText('Arquivar interrompe o uso deste fato. O conteúdo e a autoria permanecem guardados.') : i18nText('Revise o fato e sua validade antes de autorizar o uso novamente.')}</p>`
      : i18nHtml`<label>Título<input name="title" value="${attr(data.title)}" maxlength="100" required placeholder="Ex.: Preferência de atendimento"/></label><label>Escopo<select name="scope" ${operation === 'update' ? 'disabled' : ''}>${task.canWrite ? i18nHtml`<option value="contact" ${data.scope === 'contact' ? 'selected' : ''}>De cliente · cadastro vinculado</option>` : ''}${task.canManageOperation ? i18nHtml`<option value="operation" ${data.scope === 'operation' ? 'selected' : ''}>Da operação · empresa atual</option>` : ''}</select></label><label>Fato confirmado<textarea name="content" maxlength="1500" rows="5" required placeholder="Registre somente o que foi confirmado e pode orientar um próximo atendimento.">${e(data.content)}</textarea></label><label>Validade opcional<input name="expiresAt" type="datetime-local" value="${attr(data.expiresAt)}"/></label><p class="memory-help">Horário local deste dispositivo. Prazo futuro de até 365 dias. Deixe vazio para não definir prazo; revise ou arquive quando o fato mudar.</p>`;
    const reviewed = operation === 'archive' ? '' : i18nMarkup('<label class="memory-review"><input type="checkbox" name="reviewed" required/><span>Revisei o fato e autorizo seu uso pelo copiloto.</span></label>');
    mount(task, `memory-${operation}`, `${button(i18nText('Voltar aos fatos'), 'memory-back', '', 'text')}<div class="memory-editor">${controls}${reviewed}<div class="memory-conflict" hidden role="status" aria-live="polite"></div></div>`, operation === 'archive' ? i18nText('Arquivar fato') : i18nText('Autorizar uso pelo copiloto'));
  }
  const value = (data, name) => typeof data?.get === 'function' ? data.get(name) : data?.[name];
  function draft(data, base) {
    const title = value(data, 'title'), content = value(data, 'content'), expiresAt = value(data, 'expiresAt') ?? '';
    const scope = base.operation === 'create' ? value(data, 'scope') : base.scope;
    if (typeof title !== 'string' || !title.trim() || title.length > 100 || /[\t\r\n]/.test(title) || typeof content !== 'string' || !content.trim() || content.length > 1500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(title + content)) throw Error(i18nText('Informe um título de até 100 caracteres e um fato de até 1.500 caracteres.'));
    if (!Object.hasOwn(scopes, scope)) throw Error(i18nText('Escolha um escopo válido.'));
    return { title: title.trim(), content: content.trim(), scope, expiresAt, reviewed: value(data, 'reviewed') === 'on' || value(data, 'reviewed') === true };
  }
  function feedback(task, text, latest = null) {
    const node = task.form?.querySelector('.memory-conflict'); if (!node) return;
    node.hidden = false; node.innerHTML = `<strong>${e(text)}</strong>${latest ? i18nHtml`<div class="memory-current"><span>Versão atual · v${latest.version}</span><h4>${e(latest.title)}</h4><p>${e(latest.content)}</p><small>${e(date(latest.expiresAt))}</small></div>${button(i18nText('Conferi a versão atual · manter meu texto'), 'memory-review')}` : button(i18nText('Consultar versão atual'), 'memory-refresh')}`;
  }
  async function reconcile(task) {
    const original = task.editor;
    if (!original || !await load(task, true) || !current(task) || task.editor !== original) return;
    original.latest = original.id ? task.items.find(item => item.id === original.id) || null : null;
    original.latestConversationVersion = conversation().version;
    if (original.id && !original.latest) feedback(task, i18nText('O fato não está mais disponível. Volte à lista; seu texto não foi reenviado.'));
    else if (original.operation === 'create') {
      original.reconciled = true;
      feedback(task, i18nText('Consulta atualizada. Confira a lista antes de cadastrar para evitar um fato repetido.'));
      const node = task.form?.querySelector('.memory-conflict'); node?.insertAdjacentHTML?.('beforeend', button(i18nText('Conferi a lista · manter meu texto'), 'memory-review'));
    } else feedback(task, i18nText('O fato ou atendimento mudou. Seu rascunho foi preservado; confira a versão atual antes de continuar.'), original.latest);
  }
  async function action(name, el) {
    if (!name.startsWith('memory-')) return false;
    if (name === 'memory-open') return open(conversation());
    const id = typeof el === 'string' ? el : el?.dataset?.id;
    const task = active; if (!current(task)) throw Error(i18nText('O contexto mudou. Abra a memória novamente.'));
    if (el?.closest && el.closest('[data-dialog-form]') !== task.form) throw Error(i18nText('Esta ação pertence a outra janela.'));
    if (task.pending) return true;
    if (name === 'memory-agent') {
      const chosen = el?.value || id; if (!agents().some(a => a.id === chosen)) throw Error(i18nText('Escolha um copiloto configurado.'));
      const c = conversation(); reset(); const next = active = { ...task, agentId: chosen, key: contextKey(chosen), path: tenantApi(`conversations/${encodeURIComponent(c.id)}/memories`), items: [], editor: null, form: null, canWrite: false, canManageOperation: false };
      library(next, true); await load(next); return true;
    }
    if (name === 'memory-refresh') { if (task.editor?.conflicted) await reconcile(task); else { library(task, true); await load(task); } return true; }
    if (name === 'memory-back') { library(task); return true; }
    if (name === 'memory-new') { editor(task); return true; }
    if (name === 'memory-review') {
      const entry = task.editor; if (!entry?.conflicted || !entry.latest && !entry.reconciled) throw Error(i18nText('Consulte e confira a versão atual primeiro.'));
      const latest = entry.latest;
      if (latest && (entry.operation === 'archive' && latest.status !== 'active' || entry.operation === 'reactivate' && (latest.status !== 'archived' || latest.expired))) throw Error(i18nText('A situação do fato mudou. Volte à lista para escolher uma ação.'));
      editor(task, latest, entry.operation, entry); task.editor.conversationVersion = entry.latestConversationVersion; return true;
    }
    if (!['memory-edit', 'memory-archive', 'memory-reactivate'].includes(name)) return false;
    const item = task.items.find(i => i.id === id); if (!item) throw Error(i18nText('Atualize a lista para encontrar este fato.'));
    if (name === 'memory-archive' && item.status !== 'active') throw Error(i18nText('Este fato já está arquivado.'));
    if (name === 'memory-reactivate' && (item.status !== 'archived' || item.expired)) throw Error(i18nText('Revise a validade antes de reativar este fato.'));
    editor(task, item, name === 'memory-edit' ? 'update' : name.slice(7)); return true;
  }
  async function submit(kind, formData, sourceForm) {
    if (!['memory-create', 'memory-update', 'memory-archive', 'memory-reactivate'].includes(kind)) return false;
    const task = active;
    if (!sourceForm || sourceForm !== task?.form || sourceForm.isConnected !== true || !owns(task) || sourceForm.dataset.dialogForm !== kind) throw Error(i18nText('A janela mudou. Abra o fato novamente antes de confirmar.'));
    if (!current(task) || !task.editor || kind !== `memory-${task.editor.operation}`) throw Error(i18nText('Abra este editor novamente antes de salvar.'));
    if (task.pending) return true;
    const entry = task.editor;
    if (entry.conflicted) throw Error(i18nText('Confira a versão atual antes de confirmar novamente. Seu texto permanece no editor.'));
    if (!mayWrite(task, entry.scope)) throw Error(i18nText('Seu acesso não permite salvar este fato.'));
    const decision = ['archive', 'reactivate'].includes(entry.operation);
    const data = decision ? { ...entry, reviewed: value(formData, 'reviewed') === 'on' || value(formData, 'reviewed') === true } : draft(formData, entry);
    if (data.scope === 'operation' && !task.canManageOperation) throw Error(i18nText('Somente a gestão pode autorizar fatos da operação.'));
    if (data.scope === 'contact' && !task.canWrite) throw Error(i18nText('Seu acesso não permite autorizar fatos deste cliente.'));
    if (entry.operation !== 'archive' && !data.reviewed) throw Error(i18nText('Revise o fato e autorize seu uso pelo copiloto.'));
    const expiresAt = decision ? null : expiration(data.expiresAt);
    Object.assign(entry, data);
    const body = { conversationVersion: entry.conversationVersion };
    if (entry.operation === 'create') Object.assign(body, { agentId: task.agentId, scope: data.scope, title: data.title, content: data.content, expiresAt, reviewed: true });
    else { body.version = entry.version; if (!decision) Object.assign(body, { title: data.title, content: data.content, expiresAt, reviewed: true }); else if (entry.operation === 'reactivate') body.reviewed = true; }
    task.pending = true; const submitButton = task.form?.querySelector('[type="submit"]'); if (submitButton) submitButton.disabled = true;
    try {
      const suffix = entry.operation === 'create' ? '' : `/${encodeURIComponent(entry.id)}${decision ? '/' + entry.operation : ''}`;
      const result = await request(task, { method: entry.operation === 'update' ? 'PATCH' : 'POST', body: JSON.stringify(body) }, suffix);
      if (!result || !current(task)) return true;
      const item = dto(result, task.agentId);
      if (entry.id && (item.id !== entry.id || item.version <= entry.version) || item.scope !== entry.scope || item.status !== (entry.operation === 'archive' ? 'archived' : entry.operation === 'update' ? task.items.find(i => i.id === entry.id).status : 'active')
        || !decision && (item.title !== data.title || item.content !== data.content || Date.parse(item.expiresAt) !== Date.parse(expiresAt) && item.expiresAt !== expiresAt)) throw Error(i18nText('O recibo não corresponde ao fato. Consulte a lista antes de reenviar.'));
      task.items = [...task.items.filter(i => i.id !== item.id), item]; library(task);
      toast(entry.operation === 'archive' ? i18nText('Fato arquivado. O texto foi preservado.') : i18nText('Fato revisado e salvo para este copiloto.')); await load(task); return true;
    } catch (error) {
      if (!current(task) || task.editor !== entry) return true;
      if (![400, 401, 403, 404].includes(error.status)) {
        entry.conflicted = true; entry.reconciled = false;
        feedback(task, error.status === 409 ? i18nText('A versão mudou. Seu texto permanece no editor.') : i18nText('Não foi possível confirmar o resultado. Consulte a versão atual antes de reenviar.'));
        if (error.status === 409) { try { await reconcile(task); } catch (refreshError) { if (!current(task)) return true; feedback(task, i18nText('Seu texto foi preservado. A consulta atual não foi confirmada; tente consultar novamente.')); } }
      }
      throw error;
    } finally { if (active === task) task.pending = false; if (submitButton?.isConnected && current(task) && task.form.querySelector('[type="submit"]') === submitButton) submitButton.disabled = entry.conflicted; }
  }
  function runReferences(run) {
    if (run?.memoryUnavailable) return i18nMarkup('<div class="memory-run-unavailable" role="status">A memória desta execução não está mais disponível. Prepare um novo rascunho com o contexto atual.</div>');
    if (!Array.isArray(run?.memoryReferences) || !run.memoryReferences.length) return '';
    const references = run.memoryReferences.filter(r => object(r) && identity(r.id) && (r.title === undefined || typeof r.title === 'string' && r.title.length <= 100) && Object.hasOwn(scopes, r.scope) && positive(r.version)).slice(0, 12);
    if (!references.length) return '';
    return i18nHtml`<details class="memory-run-references"><summary>${icon('document')} Memória revisada no contexto · ${references.length}</summary><ul>${references.map(r => `<li><strong>${e(r.title || (r.scope === 'contact' ? i18nText('Fato de cliente') : i18nText('Fato da operação')))}</strong><span>${e(scopes[r.scope])} · v${r.version}</span><small>${e(r.id)}</small></li>`).join('')}</ul><p>Fatos recuperados para esta execução. O conteúdo fica no editor autorizado.</p></details>`;
  }
  globalThis.document?.addEventListener('change', event => { if (event.target.matches?.('[data-memory-agent]')) action('memory-agent', event.target).catch(error => { if (active) toast(translateError(error.message), true); }); });
  modal()?.addEventListener('close', () => { if (active && modal()?.open === false) reset(); });
  return { open, action, submit, reset, syncContext, runReferences };
}
