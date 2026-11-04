import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
import { createDraftsStore } from './drafts-store.js';

const empty = () => ({ items: [], total: 0, offset: 0, limit: 50, hasMore: false, tenants: [], channels: [], departments: [], assignees: [], countTabs: {}, counts: {} });
export const inboxIdentity = ref => ref?.workspaceId && ref?.tenantId && (ref.conversationId || ref.id) ? JSON.stringify([ref.workspaceId, ref.tenantId, ref.conversationId || ref.id]) : '';
export function inboxChoice(value) {
  if (!value || value === 'all') return null;
  try { const pair = JSON.parse(value); if (Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string' && v)) return { tenantId: pair[0], id: pair[1] }; } catch {}
  return { id: value };
}
export function inboxQuery(filters = {}, offset = 0, limit = 50) {
  const q = new URLSearchParams(), channel = inboxChoice(filters.channel), department = inboxChoice(filters.department);
  const tenantIds = [filters.inboxCompany !== 'all' && filters.inboxCompany, channel?.tenantId, department?.tenantId].filter(Boolean);
  if (new Set(tenantIds).size > 1) throw Error(i18nText('Escolha canal e departamento da mesma empresa.'));
  const values = { tenantId: tenantIds[0], q: filters.search, status: filters.status || 'active', tab: filters.filter || 'all', assignedUserId: filters.assignedUser !== 'all' && filters.assignedUser, channelId: channel?.id, departmentId: department?.id, unread: filters.unread ? 'true' : '', kind: filters.kind !== 'all' && filters.kind, sort: filters.sort || 'recent', offset, limit };
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== false && value !== '') q.set(key, String(value));
  return '/api/inbox?' + q;
}

/**
 * Summaries and drafts are kept apart from the tenant that owns the open chat.
 * Seams of FRONTEND-V2 §8.1 (commit 1f, owned by P2): draftsStore is the factory of drafts-store.js,
 * called once per scope (person, workspace, access) and cleared wherever the drafts were dropped
 * before; dataSource.inboxPage (data-source.js) fetches the page when given, else request() as before.
 */
export function createConsolidatedInboxUI({ request, context, draftLimit = 200, draftsStore = createDraftsStore, dataSource = null }) {
  let scope = '', sequence = 0, selectionSequence = 0, data = empty(), loading = false, error = '', store = null, pageLimit = 50;
  const authorizedIds = new Map();
  const scopeOf = c => JSON.stringify([c.userId || '', c.workspaceId || '', c.authorityKey || '']);
  const drafts = () => store || (store = draftsStore({ userId: context().userId || '', workspaceId: context().workspaceId || '', limit: draftLimit }));
  const draftRef = ref => ({ tenantId: ref.tenantId, conversationId: ref.conversationId || ref.id });
  const page = (path, workspaceId) => dataSource ? dataSource.inboxPage(path, { workspaceId }) : request(path, { headers: { 'X-Elozi-Workspace': workspaceId } });
  function sync() {
    const next = scopeOf(context());
    if (next !== scope) { reset(); scope = next; }
    return context();
  }
  function reset() { sequence++; selectionSequence++; data = empty(); loading = false; error = ''; store?.clear(); store = null; authorizedIds.clear(); scope = ''; pageLimit = 50; }
  async function load(filters, { offset = 0 } = {}) {
    const c = sync(), key = scope, ticket = ++sequence;
    loading = true; error = '';
    try {
      let next = await page(inboxQuery(filters, offset, pageLimit), c.workspaceId);
      if (ticket === sequence && key === scope && key === scopeOf(context()) && offset > 0 && !next.items.length) {
        const previousPage = Math.floor(Math.max(0, next.total - 1) / next.limit) * next.limit;
        if (previousPage !== offset) next = await page(inboxQuery(filters, previousPage, next.limit), c.workspaceId);
      }
      if (ticket !== sequence || key !== scope || key !== scopeOf(context())) return null;
      if (next.workspaceId !== c.workspaceId) throw Error(i18nText('A caixa recebida pertence a outro workspace.'));
      data = next; return next;
    } catch (cause) {
      if (ticket !== sequence || key !== scope || key !== scopeOf(context())) return null;
      if ([401, 403].includes(cause.status)) reset();
      error = translateError(cause.message) || i18nText('Não foi possível atualizar a caixa.'); throw cause;
    } finally { if (ticket === sequence) loading = false; }
  }
  async function select(ref, loader) {
    const c = sync(), key = scope, ticket = ++selectionSequence;
    const target = { workspaceId: c.workspaceId, tenantId: ref.tenantId, conversationId: ref.conversationId || ref.id };
    if (!inboxIdentity(target) || ref.workspaceId && ref.workspaceId !== c.workspaceId) throw Error(i18nText('Escolha um atendimento deste workspace.'));
    const detail = await loader(target);
    if (ticket !== selectionSequence || key !== scope || key !== scopeOf(context())) return null;
    if (detail.tenant?.id !== target.tenantId || !detail.tenant.conversations?.some(item => item.id === target.conversationId)) throw Object.assign(Error(i18nText('Este atendimento não está no seu acesso atual.')), { status: 403 });
    retainConversations(target.tenantId, detail.tenant.conversations.map(item => item.id));
    return { ...detail, ref: target };
  }
  function saveDraft(ref, text) {
    sync(); const key = inboxIdentity(ref); if (!key || ref.workspaceId !== context().workspaceId) return true;
    if (authorizedIds.has(ref.tenantId) && !authorizedIds.get(ref.tenantId).has(ref.conversationId || ref.id)) return true;
    return drafts().set(draftRef(ref), String(text || '').slice(0, 4000));
  }
  // IDs must come from a complete authorized tenant snapshot, never a filtered inbox page.
  function retainConversations(tenantId, ids) {
    sync(); const allowed = new Set(ids); authorizedIds.set(tenantId, allowed);
    store?.retain(tenantId, ids);
    data = { ...data, items: data.items.filter(row => row.tenantId !== tenantId || allowed.has(row.conversationId || row.id)) };
  }
  function forgetTenant(id) { store?.retain(id, []); data = { ...data, items: data.items.filter(row => row.tenantId !== id) }; }
  // A reference of another workspace never reads or clears the drafts of the current one.
  // drafts() opens the session store on demand, so a reload shows the saved text before any list load.
  const ownRef = ref => Boolean(inboxIdentity(ref)) && ref.workspaceId === drafts().workspaceId;
  // Rows asked per page: 50, and "Carregar mais" (inbox-list-ui.js) asks 50 more at a time up to 200.
  function setLimit(value) { pageLimit = Math.min(200, Math.max(1, Math.round(Number(value) || 50))); return pageLimit; }
  return { load, select, sync, reset, setLimit, saveDraft, forgetTenant, retainConversations, cancelLoad() { sequence++; loading = false; }, cancelSelection() { selectionSequence++; }, getDraft(ref) { sync(); return ownRef(ref) ? drafts().get(draftRef(ref)) : ''; }, clearDraft(ref) { if (ownRef(ref)) drafts().delete(draftRef(ref)); }, get data() { return data; }, get loading() { return loading; }, get error() { return error; }, get draftCount() { return store?.size || 0; } };
}

export function consolidatedListMarkup({ data, filters, selection, focus, workspaceId, userId, tenants, loading, error, escape: e, icon, badge, avatar }) {
  const options = (values, selected) => values.map(([value, label]) => `<option value="${e(value)}" ${value === selected ? 'selected' : ''}>${e(label)}</option>`).join('');
  const catalog = values => values.filter(item => filters.inboxCompany === 'all' || item.tenantId === filters.inboxCompany).map(item => [JSON.stringify([item.tenantId, item.id]), `${item.tenantName} · ${item.name}`]);
  const people = [...new Map((data.assignees || []).map(person => [person.id, person])).values()];
  const rowMarkup = item => {
    const selected = inboxIdentity(selection) === inboxIdentity({ workspaceId, ...item });
    const responsible = item.assignedUserId === userId ? i18nText('Com você') : item.assignedUserName || (item.owner === 'agent' ? i18nText('Copiloto') : i18nText('Na fila'));
    const preview = item.preview?.text || (item.preview?.attachmentName ? `${{ image: i18nText('Foto'), audio: i18nText('Áudio'), video: i18nText('Vídeo') }[item.preview.attachmentKind] || i18nText('Arquivo')} · ${item.preview.attachmentName}` : i18nText('Sem mensagem'));
    const stamp = item.updatedAt && !Number.isNaN(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '';
    return `<button type="button" class="conversation-item ${selected ? 'selected' : ''}" data-inbox-tenant="${e(item.tenantId)}" data-conversation="${e(item.id)}" ${selected ? 'aria-current="true"' : ''}>${avatar(item.contact, null, item.owner === 'agent' ? 'lavender' : 'mint')}<span class="conversation-copy"><span class="conversation-name"><strong>${e(item.contact)}</strong><time class="conversation-time" datetime="${e(item.updatedAt)}">${e(stamp)}</time></span><span class="conversation-origin">${icon('building')}<strong>${e(item.tenantName)}</strong><span>· ${e(item.channelName)}</span></span><span class="conversation-last">${e(preview)}</span><span class="conversation-tags">${badge({ open: i18nText('Aberta'), pending: i18nText('Pendente'), closed: i18nText('Encerrada') }[item.status] || item.status, item.status === 'pending' ? 'amber' : 'neutral')}${badge(responsible, item.assignedUserId === userId ? 'blue' : 'neutral')}</span><span class="conversation-department">${e(item.department || i18nText('Sem departamento'))}${item.channelState !== 'connected' && item.channelTransport ? i18nText(' · Canal desconectado') : ''}</span></span>${item.unread ? i18nMarkup('<span class="unread-dot" aria-label="Não lida"></span>') : ''}</button>`;
  };
  const rows = (data.items || []).map(rowMarkup).join('');
  const focused = focus && inboxIdentity({workspaceId,...focus})===inboxIdentity(selection) && !(data.items||[]).some(item=>inboxIdentity({workspaceId,...item})===inboxIdentity(selection))
    ? i18nHtml`<section aria-label="Atendimento aberto pelo contato"><div class="consolidated-list-status"><strong>Atendimento aberto pelo contato</strong><p>Fora desta página ou dos filtros atuais.</p><button type="button" class="text-button" data-action="clear-contact-inbox-focus">Remover foco do contato</button></div>${rowMarkup(focus)}</section>` : '';
  const start = data.total ? data.offset + 1 : 0, end = data.offset + data.items.length;
  return i18nHtml`<section class="conversation-list" aria-label="Caixa das empresas autorizadas"><div class="list-title"><h2>Conversas</h2><button type="button" class="icon-button" data-action="refresh-attendance" aria-label="Atualizar atendimentos">${icon('refresh')}</button></div><label class="sr-only" for="inbox-company-filter">Empresas da caixa</label><select id="inbox-company-filter">${options([['all', i18nText('Todas as empresas')], ...(tenants || data.tenants).map(t => [t.id, t.name])], filters.inboxCompany)}</select><label class="search-field">${icon('search')}<input id="conversation-search" maxlength="200" placeholder="Nome, número ou mensagem" value="${e(filters.search)}" aria-label="Buscar no histórico autorizado"/></label><label class="sr-only" for="channel-filter">Filtrar por conexão</label><select id="channel-filter">${options([['all', i18nText('Todos os números e canais')], ...catalog(data.channels || [])], filters.channel)}</select><div class="inbox-tabs" role="group" aria-label="Filtrar responsável">${[['all',i18nText('Todos')],['mine',i18nText('Comigo')],['queue',i18nText('Fila')],['agent',i18nText('Agentes')]].map(([key,title]) => `<button type="button" class="${filters.filter === key ? 'selected' : ''}" data-filter="${key}" aria-pressed="${filters.filter === key}">${title} <span data-inbox-count="${key}">${data.countTabs[key] || 0}</span></button>`).join('')}</div><div class="attendance-list-actions"><label class="checkbox-label"><input type="checkbox" id="unread-filter" ${filters.unread ? 'checked' : ''}/>Não lidos</label><details class="attendance-filters"><summary>${icon('activity')} Filtros</summary><label>Atendente<select id="assigned-user-filter">${options([['all',i18nText('Toda a equipe')], ...people.map(p => [p.id,p.name])], filters.assignedUser)}</select></label><label>Status<select id="conversation-status-filter">${options([['active',i18nText('Abertas e pendentes')],['all',i18nText('Todos os status')],['open',i18nText('Abertas')],['pending',i18nText('Pendentes')],['closed',i18nText('Encerradas')]],filters.status)}</select></label><label>Departamento<select id="department-filter">${options([['all',i18nText('Todos os departamentos')],['unassigned',i18nText('Sem departamento')],...catalog(data.departments || [])],filters.department)}</select></label><label>Conversas<select id="kind-filter">${options([['all',i18nText('Individuais e grupos')],['direct',i18nText('Individuais')],['group',i18nText('Grupos')]],filters.kind)}</select></label><label>Ordenação<select id="sort-filter">${options([['recent',i18nText('Mais recentes')],['oldest',i18nText('Mais antigas')],['unread',i18nText('Não lidas primeiro')]],filters.sort)}</select></label><button type="button" class="text-button" data-action="clear-inbox-filters">Limpar filtros</button></details></div><div class="consolidated-list-status" role="status" aria-live="polite">${e(error || (loading ? i18nText('Atualizando atendimentos…') : ''))}</div>${focused}<div id="conversation-items" aria-busy="${Boolean(loading)}">${rows || i18nMarkup('<div class="empty-state list-empty"><h3>Nenhum atendimento encontrado.</h3><p>Revise o termo e os filtros.</p><button type="button" class="text-button" data-action="clear-inbox-filters">Limpar filtros</button></div>')}</div><div class="attendance-list-footer"><span data-list-count>${start}–${end} de ${data.total}</span><div class="inbox-pagination"><button type="button" class="icon-button" data-action="inbox-previous" aria-label="Página anterior" ${data.offset === 0 || loading ? 'disabled' : ''}>‹</button><button type="button" class="icon-button" data-action="inbox-next" aria-label="Próxima página" ${!data.hasMore || loading ? 'disabled' : ''}>›</button></div><button type="button" class="text-button" data-action="show-closed">Encerrados <span data-attendance-count="closed">${data.counts.closed || 0}</span></button></div></section>`;
}
