import { t, html, txt } from './i18n.js';
import './locales-customer-context.js';

const text = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value : [];
const revision = value => Number.isSafeInteger(value) && value > 0;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const kind = conversation => conversation?.conversationKind === 'group' ? 'group' : 'person';
const scoped = (value, c) => value && (!value.tenantId || value.tenantId === c.tenantId) && (!value.workspaceId || value.workspaceId === c.workspaceId);
const unique = (items, id) => { const matches = items.filter(item => item?.id === id); return matches.length === 1 ? matches[0] : null; };
const actions = { takeover: 'Assumir atendimento', transfer: 'Transferir com contexto', participants: 'Colaborar com a equipe', handoffs: 'Revisar pedidos dos agentes', prepareDraft: 'Preparar rascunho com agente' };
const handlers = { takeover: 'takeover', transfer: 'transfer-conversation', participants: 'conversation-participants', handoffs: 'service-handoffs', prepareDraft: 'run-agent' };
const statusLabel = status => ({ open: t('Atendimento aberto'), pending: t('Atendimento pendente'), closed: t('Atendimento encerrado') })[status] || t('Situação não carregada');
const ownerLabel = owner => ({ human: t('Pessoa responsável'), agent: t('Agente responsável'), queue: t('Fila da equipe') })[owner] || t('Responsável não carregado');
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

function available(c, now = Date.now()) {
  if (c?.supportGrantId && (!Number.isFinite(Date.parse(c.supportExpiresAt)) || Date.parse(c.supportExpiresAt) <= now)) return false;
  const current = c?.conversation;
  return Boolean(c?.active === true && !c.selecting && c.canReadInbox === true && text(c.workspaceId) && text(c.tenantId) && text(c.userId) && text(c.authorityKey)
    && current && text(current.id) && text(current.channelId) && revision(current.version) && scoped(current, c)
    && unique(list(c.channels).filter(item => scoped(item, c)), current.channelId));
}
function contextKey(c) {
  const current = c.conversation;
  // The authority key may contain session material. It stays in memory only.
  return JSON.stringify([c.workspaceId, c.tenantId, c.userId, c.authorityKey, c.supportGrantId || '', c.supportExpiresAt || '', current.id, current.channelId, current.contactId || '', current.version]);
}

/** Only a permission-projected snapshot of one company is accepted. No I/O or identity inference. */
export function buildCustomerContext(c = {}, { now = Date.now() } = {}) {
  if (!available(c, now)) return null;
  const current = c.conversation, channels = list(c.channels).filter(item => scoped(item, c));
  const channel = unique(channels, current.channelId), contactId = text(current.contactId);
  const contactCandidate = contactId && c.canReadContacts === true ? unique(list(c.contacts).filter(item => scoped(item, c)), contactId) : null;
  const contact = contactCandidate && (contactCandidate.type === 'group' ? 'group' : 'person') === kind(current) ? contactCandidate : null;
  const validConversations = list(c.conversations).filter(item => text(item?.id) && scoped(item, c) && unique(channels, item.channelId));
  const byId = new Map();
  for (const item of validConversations) {
    if (byId.has(item.id)) byId.set(item.id, null); else byId.set(item.id, item);
  }
  // Current detail wins only for its own ID. Duplicate related IDs are withheld.
  byId.set(current.id, current);
  const related = [...byId.values()].filter(item => item && (item.id === current.id || contactId && item.contactId === contactId && kind(item) === kind(current)))
    .sort((a, b) => a.id === current.id ? -1 : b.id === current.id ? 1 : timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.id.localeCompare(b.id));
  const rows = related.map(item => {
    const origin = unique(channels, item.channelId), hasMessages = Array.isArray(item.messages);
    return { id: item.id, channelId: item.channelId, version: revision(item.version) ? item.version : null, current: item.id === current.id,
      name: text(item.contact), channelName: text(origin.name), status: text(item.status), owner: text(item.owner), responsibleName: text(item.assignedUserName),
      messagesLoaded: hasMessages, publicMessageCount: hasMessages ? item.messages.filter(message => ['customer', 'human', 'agent'].includes(message?.kind)).length : null };
  });
  const notes = related.flatMap(item => list(item.messages).filter(message => message?.kind === 'internal' && text(message.text)).map(message => ({ conversationId: item.id, channelName: text(unique(channels, item.channelId)?.name), text: message.text, authorName: text(message.authorName), createdAt: text(message.createdAt) })))
    .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
  const assignee = text(current.assignedUserId) ? unique(list(c.assignees).filter(item => scoped(item, c)), current.assignedUserId) : null;
  const agent = text(current.agentId) ? unique(list(c.agents).filter(item => scoped(item, c)), current.agentId) : null;
  const handoffsLoaded = Array.isArray(c.handoffs);
  const handoffs = list(c.handoffs).filter(item => scoped(item, c) && item.conversationId === current.id && text(item.id) && ['pending', 'acknowledged', 'declined'].includes(item.state));
  return { workspaceId: c.workspaceId, tenantId: c.tenantId, conversationId: current.id, version: current.version, tenantName: text(c.tenantName), channelName: text(channel.name),
    name: text(contact?.name) || text(current.contact), linked: Boolean(contactId), contactAvailable: Boolean(contact), contactNotes: text(contact?.notes), contactTags: list(contact?.tags).filter(value => typeof value === 'string').slice(0, 20),
    owner: text(current.owner), responsibleName: text(current.assignedUserId) ? text(current.assignedUserName) || text(assignee?.name) : '', agentName: text(agent?.name),
    rows, conversationsLoaded: Array.isArray(c.conversations), pendingCount: related.filter(item => item.status === 'pending').length,
    notes: notes.slice(0, 6), loadedNoteCount: notes.length, notesCoverageKnown: related.every(item => Array.isArray(item.messages)),
    handoffsLoaded, pendingHandoffCount: handoffs.filter(item => item.state === 'pending').length,
    capabilities: Object.fromEntries(Object.keys(actions).map(action => [action, c.capabilities?.[action] === true && (action === 'handoffs' || current.status !== 'closed')])) };
}

export function customerContextMarkup(model, { escape = escapeHTML, icon = () => '', token = '', busy = false } = {}) {
  if (!model) return '';
  const button = (action, label, id = model.conversationId) => html`<button type="button" class="button customer-context-action" data-customer-context-action="${action}" data-customer-context-token="${escape(token)}" data-conversation-id="${escape(id)}" ${busy ? 'disabled' : ''}>${escape(t(label))}</button>`;
  return html`<section class="customer-context" aria-label="Contexto do cliente" data-customer-context-panel>
    <header class="customer-context-heading"><span class="customer-context-symbol" aria-hidden="true">${icon('users')}</span><div><p class="customer-context-kicker">CONTEXTO DO CLIENTE</p><h3 data-pii>${escape(model.name || t('Atendimento atual'))}</h3></div></header>
    <p class="customer-context-scope">${escape(model.tenantName || t('Empresa atual'))} · ${escape(model.channelName || t('Conexão atual'))}</p>
    <p class="customer-context-description">Resumo dos dados carregados e autorizados nesta empresa.</p>
    ${model.linked ? html`<p class="customer-context-link">${t('Vínculo explícito do cadastro.')} ${model.contactAvailable ? '' : t('O cadastro completo não está disponível no seu acesso atual.')}</p>` : html`<p class="customer-context-link">Este atendimento ainda não tem vínculo explícito. Nomes e telefones parecidos não reúnem históricos.</p>`}
    ${model.contactTags.length ? html`<ul class="customer-context-tags" aria-label="Etiquetas do cadastro">${model.contactTags.map(tag => html`<li>${escape(tag)}</li>`).join('')}</ul>` : ''}
    <dl class="customer-context-facts"><div><dt>Atendimentos carregados</dt><dd>${model.rows.length}</dd></div><div><dt>Pendentes carregados</dt><dd>${model.pendingCount}</dd></div></dl>
    <details class="customer-context-details" open><summary>Atendimentos e canais vinculados</summary><ul class="customer-context-conversations">${model.rows.slice(0, 20).map(row => html`<li><div><strong>${escape(row.channelName || t('Conexão atual'))}</strong><small>${escape(statusLabel(row.status))} · ${escape(ownerLabel(row.owner))}</small><small>${row.messagesLoaded ? escape(txt`${row.publicMessageCount} mensagens carregadas`) : t('Histórico não carregado')}</small></div>${row.current ? html`<span class="customer-context-current">Atual</span>` : button('open', 'Abrir atendimento', row.id)}</li>`).join('')}</ul>${model.rows.length > 20 ? html`<p>Exibindo os 20 atendimentos carregados mais recentes.</p>` : ''}<p class="customer-context-coverage">Outros históricos podem não estar carregados. Este resumo não consulta outras empresas.</p></details>
    <section class="customer-context-collaboration" aria-label="Colaboração interna"><h4>Equipe e agente</h4><dl class="customer-context-ownership"><div><dt>Condução do atendimento</dt><dd>${escape(ownerLabel(model.owner))}</dd></div><div><dt>Pessoa responsável</dt><dd>${escape(model.responsibleName || t('Nenhuma pessoa carregada'))}</dd></div><div><dt>Agente vinculado</dt><dd>${escape(model.agentName || t('Nenhum agente carregado'))}</dd></div></dl>
      <p>${model.handoffsLoaded ? escape(txt`${model.pendingHandoffCount} pedidos de apoio pendentes carregados`) : t('Pedidos dos agentes ainda não consultados.')}</p>
      <div class="customer-context-actions">${Object.entries(actions).filter(([action]) => model.capabilities[action]).map(([action, label]) => button(action, label)).join('')}</div>
      <p class="customer-context-privacy">A equipe assume, transfere e colabora pelas ações deste atendimento. O agente prepara rascunhos; você revisa antes de enviar.</p><p class="customer-context-privacy">Transferir mantém o contexto interno do atendimento. Este resumo não envia mensagens nem publica notas.</p>
    </section>
    <details class="customer-context-details customer-context-notes"><summary>Notas internas carregadas</summary><p class="customer-context-privacy">Somente para a equipe autorizada. Notas e rascunhos não são copiados para mensagens ou enviados ao agente por este resumo.</p>
      ${model.contactNotes ? html`<article class="customer-context-note"><strong>Anotações do cadastro</strong><p>${escape(model.contactNotes)}</p></article>` : ''}
      ${model.notes.map(note => html`<article class="customer-context-note"><strong>${escape(note.authorName || t('Equipe'))} · ${escape(note.channelName || t('Conexão atual'))}</strong><p>${escape(note.text)}</p></article>`).join('')}
      ${!model.contactNotes && !model.notes.length ? html`<p>${model.notesCoverageKnown ? t('Nenhuma nota interna nos históricos carregados.') : t('Notas indisponíveis nos históricos não carregados.')}</p>` : ''}
      ${!model.notesCoverageKnown && (model.notes.length || model.contactNotes) ? html`<p>Parte dos históricos não está carregada. Outras notas podem existir.</p>` : ''}
      ${model.loadedNoteCount > 6 ? html`<p>Exibindo as seis notas carregadas mais recentes. Abra o atendimento para consultar o restante.</p>` : ''}
    </details>
  </section>`;
}

/** Dispatches IDs only to existing handlers; never constructs messages, notes or mutations. */
export function createCustomerContextUI({ getContext = () => ({}), onOpenConversation = () => {}, onAction = () => {}, onUpdate = () => {}, escape = escapeHTML, icon = () => '', now = Date.now } = {}) {
  let sequence = 0, view = null, pending = false;
  const stale = () => Object.assign(new Error(t('O contexto do cliente mudou. Atualize o atendimento antes de continuar.')), { status: 409, code: 'customer-context-stale' });
  function markup() {
    const c = getContext() || {}, model = buildCustomerContext(c, { now: now() });
    view = model ? { key: contextKey(c), model, token: String(++sequence) } : null;
    return customerContextMarkup(model, { escape, icon, token: view?.token || '', busy: pending || c.busy === true });
  }
  async function handleAction(element) {
    const action = element?.dataset?.customerContextAction;
    if (action !== 'open' && !Object.hasOwn(actions, action)) return false;
    const candidate = view, c = getContext() || {}, current = buildCustomerContext(c, { now: now() });
    if (!candidate || !current || candidate.token !== element.dataset.customerContextToken || candidate.key !== contextKey(c)) throw stale();
    if (pending || c.busy === true || element.disabled) return true;
    const targetId = element.dataset.conversationId;
    const selected = current.rows.find(row => row.id === targetId), original = candidate.model.rows.find(row => row.id === targetId);
    if (!selected || !original || selected.channelId !== original.channelId || selected.version !== original.version) throw stale();
    if (action !== 'open' && (targetId !== current.conversationId || current.capabilities[action] !== true)) throw stale();
    pending = true;
    try {
      if (action === 'open') await onOpenConversation({ workspaceId: current.workspaceId, tenantId: current.tenantId, conversationId: targetId });
      else await onAction(handlers[action], { workspaceId: current.workspaceId, tenantId: current.tenantId, conversationId: current.conversationId, version: current.version });
      return true;
    } finally { pending = false; onUpdate(); }
  }
  return { markup, handleAction, reset() { view = null; sequence++; }, get busy() { return pending; } };
}
