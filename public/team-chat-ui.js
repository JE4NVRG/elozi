import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, raw} from './i18n.js';
import './locales-operations.js';

import { rasterAvatar } from './avatar-ui.js';
import './locales-live.js';
import { registerAction } from './actions.js';
import { CADENCE, liveDrawer, publishLiveCount, registerLiveTask } from './live.js';
import { clearDraftsStorage } from './drafts-store.js';

const string = value => String(value ?? '');
const photo = value => rasterAvatar(value, 24 * 1024) ? value : null;
const escapeHTML = value => string(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const stale = () => Object.assign(new Error(i18nText('O contexto da sala mudou. Revise antes de continuar.')), { status: 409, code: 'team-chat-context' });
const isAdmin = context => context?.canManage === true || context?.isAdmin === true;
const initials = name => string(name).trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase('pt-BR');
const date = value => { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }); };
const day = value => { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleDateString(getLocale(), { day: '2-digit', month: 'short', year: 'numeric' }); };
const glyphs = { chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8 10h8M8 14h5"/>', plus: '<path d="M12 5v14M5 12h14"/>', users: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.9"/>', search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>', send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>', shield: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z"/><path d="m8 12 3 3 5-6"/>', link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>', back: '<path d="M19 12H5m6-6-6 6 6 6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>' };
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] || glyphs.chat}</svg>`;

export function teamChatContextKey(context = {}) {
  return context.active === true && context.workspaceId && context.tenantId && context.userId
    ? JSON.stringify([string(context.workspaceId), string(context.tenantId), string(context.userId), string(context.authorityKey), isAdmin(context)]) : '';
}
function draftScope(context) { return JSON.stringify([string(context.workspaceId), string(context.tenantId), string(context.userId)]); }
export function normalizeTeamChatRoom(input, tenantId, { summary = false } = {}) {
  if (!input?.id || !positive(input.version) || !Array.isArray(input.members) && !(summary && Number.isSafeInteger(input.memberCount) && input.memberCount >= 0) || typeof input.canManage !== 'boolean' || input.tenantId && string(input.tenantId) !== string(tenantId)) throw stale();
  const known = new Set(), members = [];
  for (const member of input.members || []) if (member?.id && !known.has(string(member.id))) {
    known.add(string(member.id)); members.push({ id: string(member.id), name: string(member.name || i18nText('Pessoa da equipe')), eligible: member.eligible !== false, avatar: member.eligible !== false ? photo(member.avatar) : null });
  }
  return { id: string(input.id), name: string(input.name || i18nText('Sala da equipe')), version: input.version, canManage: input.canManage,
    members, memberCount: Array.isArray(input.members) ? members.length : count(input.memberCount), createdById: string(input.createdBy?.id), lastSequence: count(input.lastSequence), readSequence: count(input.readSequence), unreadCount: count(input.unreadCount) };
}
export function normalizeTeamChatMessages(input, { tenantId, roomId } = {}) {
  if (!Array.isArray(input?.messages)) throw stale();
  const known = new Set(), messages = [];
  for (const message of input.messages) {
    if (!message?.id || !positive(message.sequence) || !message.author?.id || typeof message.text !== 'string' || message.tenantId && string(message.tenantId) !== string(tenantId) || message.roomId && string(message.roomId) !== string(roomId)) throw stale();
    if (known.has(string(message.id))) continue;
    known.add(string(message.id));
    const reference = message.reference?.unavailable ? { unavailable: true } : message.reference?.conversationId ? { conversationId: string(message.reference.conversationId), contact: string(message.reference.contact || i18nText('Atendimento')), channelId: string(message.reference.channelId) } : null;
    messages.push({ id: string(message.id), sequence: message.sequence, text: message.text, createdAt: string(message.createdAt), author: { id: string(message.author.id), name: string(message.author.name || i18nText('Pessoa da equipe')) }, ...(reference ? { reference } : {}) });
  }
  messages.sort((a, b) => a.sequence - b.sequence);
  return { messages, hasMore: input.hasMore === true, before: positive(input.before) ? input.before : messages[0]?.sequence || null, lastSequence: count(input.lastSequence), readSequence: count(input.readSequence) };
}

export function createTeamChatUI({ getContext: readContext = () => ({}), request, openModal, getModal = () => null, getConversations,
  onOpenConversation = () => {}, avatarHTML, onRender = () => {}, onError = () => {}, document: doc = globalThis.document } = {}) {
  let view = null, root = null, modalView = null, sequence = 0, drawerOpen = false, drawerKey = '', badgeTicket = 0;
  // Drawer mode (FRONTEND-V2 §8.3): the rooms and the conversation open in a drawer from the Equipe
  // button on every screen; while it is open the context counts as active, like the page.
  const getContext = () => { const value = readContext() || {}; return drawerOpen && value.active !== true ? { ...value, active: true } : value; };
  const drafts = new Map(), selections = new Map();
  function current(candidate = view, roomTicket) { return Boolean(candidate && candidate === view && candidate.key === teamChatContextKey(getContext()) && (roomTicket === undefined || roomTicket === candidate.roomTicket)); }
  function guard(candidate, roomTicket) { if (!current(candidate, roomTicket)) throw stale(); return getContext(); }
  function ownRoot(candidate = view) { return Boolean(current(candidate) && root?.dataset.teamChatKey === candidate.key); }
  function avatar(person) { const name = person?.name || i18nText('Pessoa da equipe'); return typeof avatarHTML === 'function' ? avatarHTML({ name, avatar: person?.eligible !== false ? photo(person?.avatar) : null }) : `<span class="team-chat-avatar" aria-hidden="true">${escapeHTML(initials(name))}</span>`; }
  function draft(candidate = view, roomId = candidate?.selectedId) {
    if (!candidate || !roomId) return { text: '', referenceId: '', intent: null, version: null };
    const key = JSON.stringify([candidate.scope, string(roomId)]);
    if (!drafts.has(key)) drafts.set(key, { text: '', referenceId: '', intent: null, version: null });
    return drafts.get(key);
  }
  function capture() {
    if (!root || !view || root.dataset.teamChatKey !== view.key || root.dataset.teamChatRoom !== view.selectedId) return;
    const field = root.querySelector('[data-team-chat-draft]'), reference = root.querySelector('[data-team-chat-reference]'), value = draft();
    if (field) {
      value.text = field.value;
      if (value.text.trim() && !positive(value.version) && view.room) value.version = view.room.version;
      if (!value.text.trim() && !value.intent?.uncertain) { value.version = null; value.intent = null; }
    }
    if (reference) value.referenceId = reference.value;
  }
  function ownsModal(candidate = modalView) {
    return Boolean(candidate && getModal()?.open && getModal().querySelector('[data-team-chat-modal]')?.dataset.teamChatToken === candidate.token);
  }
  function closeModal() { const candidate = modalView; modalView = null; candidate?.controller.abort(); if (ownsModal(candidate)) getModal().close(); }
  function reset({ clearDrafts = false } = {}) {
    capture(); view?.controller.abort(); view?.roomController.abort(); closeModal(); view = null; root = null; sequence++;
    // clearDrafts is the logout of app.js: the reply drafts of the inbox (drafts-store.js) go too, also
    // when the inbox store was never created on this page (FRONTEND-V2 §7.2).
    if (clearDrafts) { drafts.clear(); selections.clear(); clearDraftsStorage(); }
    if (drawerOpen && (clearDrafts || teamChatContextKey(getContext()) !== drawerKey)) closeDrawer();
  }
  function ensure() {
    const context = getContext(), key = teamChatContextKey(context);
    if (view?.key === key && key) return view;
    reset(); if (!key) return null;
    const scope = draftScope(context);
    view = { key, scope, context: { ...context }, controller: new AbortController(), roomController: new AbortController(), token: ++sequence, rooms: [], selectedId: selections.get(scope) || '', room: null, roomTicket: 0,
      messages: [], loaded: false, hasMore: false, before: null, after: null, search: '', roomSearch: '', error: '', status: '', revoked: false, loadingRoom: false, sending: false, polling: false, mobileOpen: false };
    return view;
  }
  function base(candidate) { return `/api/tenants/${encodeURIComponent(candidate.context.tenantId)}/team-chat`; }
  function options(candidate, extra = {}) { return { ...extra, signal: candidate.controller.signal, headers: { 'X-Elozi-Workspace': candidate.context.workspaceId, ...extra.headers } }; }
  function roomOptions(candidate, extra = {}) { return { ...options(candidate, extra), signal: candidate.roomController.signal }; }
  function allowed(candidate) { return Boolean(current(candidate) && candidate.room && !candidate.revoked && candidate.room.members.some(person => person.id === string(candidate.context.userId) && person.eligible)); }
  function needsReview(candidate = view) { const value = draft(candidate); return Boolean(value.text.trim() && positive(value.version) && candidate?.room && value.version !== candidate.room.version); }
  function uncertain(candidate = view) { return draft(candidate).intent?.uncertain === true; }
  function reviewMarkup(candidate) { return uncertain(candidate) ? i18nHtml`<div class="team-chat-recipient-review" role="status"><span>O resultado do envio ainda não foi confirmado. Verifique antes de enviar outro texto.</span><button type="button" class="button" data-team-chat-action="verify-send" ${candidate.sending || !allowed(candidate) ? 'disabled' : ''}>Verificar envio</button></div>` : needsReview(candidate) ? i18nHtml`<div class="team-chat-recipient-review" role="status"><span>Os membros mudaram desde o início deste texto.</span><button type="button" class="button" data-team-chat-action="review-members">Revisar membros</button></div>` : ''; }
  function conversations(candidate = view) {
    const values = typeof getConversations === 'function' ? getConversations() : getContext().conversations || [];
    return Array.isArray(values) && current(candidate) ? values.filter(item => item?.id && (!item.tenantId || string(item.tenantId) === string(candidate.context.tenantId))).map(item => ({ id: string(item.id), contact: string(item.contact || i18nText('Atendimento')) })) : [];
  }
  function roomsMarkup(candidate) {
    const rooms = candidate.rooms.filter(room => room.name.toLocaleLowerCase('pt-BR').includes(candidate.roomSearch.toLocaleLowerCase('pt-BR')));
    return rooms.length ? rooms.map(room => `<button type="button" class="team-chat-room ${candidate.selectedId === room.id ? 'selected' : ''}" data-team-chat-action="select" data-room-id="${escapeHTML(room.id)}" aria-pressed="${candidate.selectedId === room.id}"><span class="team-chat-room-symbol">${icon('chat')}</span><span class="team-chat-room-copy"><strong>${escapeHTML(room.name)}</strong><small>${room.memberCount} ${room.memberCount === 1 ? i18nText('pessoa') : i18nText('pessoas')} · ${room.unreadCount ? i18nText('Novas mensagens') : i18nText('Sala da equipe')}</small></span>${room.unreadCount ? i18nHtml`<span class="team-chat-unread" aria-label="${room.unreadCount} mensagens não lidas">${room.unreadCount > 99 ? '99+' : room.unreadCount}</span>` : ''}</button>`).join('') : `<div class="team-chat-list-empty">${candidate.loaded ? candidate.roomSearch ? i18nText('Nenhuma sala com esse nome.') : i18nText('Suas salas aparecerão aqui.') : i18nText('Conferindo suas salas…')}</div>`;
  }
  function headerMarkup(candidate) {
    const room = candidate.room;
    return i18nHtml`<div class="team-chat-heading-copy"><button type="button" class="icon-button team-chat-back" data-team-chat-action="back" aria-label="Voltar às salas">${icon('back')}</button><span class="team-chat-heading-symbol">${icon('chat')}</span><div><h2>${escapeHTML(room?.name || (candidate.revoked ? i18nText('Acesso à sala alterado') : i18nText('Uma conversa com a sua equipe')))}</h2><p>${room ? i18nTemplate`${room.members.length} pessoas · ${escapeHTML(room.members.slice(0, 3).map(person => person.name.split(' ')[0]).join(', '))}${room.members.length > 3 ? '…' : ''}` : i18nText('Selecione uma sala para conversar.')}</p></div></div><div class="team-chat-heading-actions"><span class="team-chat-private">${icon('shield')} Somente equipe</span>${room ? `<button type="button" class="icon-button" data-team-chat-action="members" aria-label="${room.canManage ? i18nText('Gerir membros da sala') : i18nText('Ver membros da sala')}" ${candidate.loadingRoom || candidate.revoked ? 'disabled' : ''}>${icon('users')}</button>` : ''}</div>`;
  }
  function messagesMarkup(candidate) {
    if (candidate.revoked) return i18nHtml`<div class="team-chat-empty"><span class="team-chat-empty-icon">${icon('shield')}</span><h3>Seu acesso a esta sala mudou</h3><p>A conversa foi fechada. Seu texto continua guardado nesta sessão.</p></div>`;
    if (!candidate.room) return i18nHtml`<div class="team-chat-empty"><span class="team-chat-empty-icon">${icon('chat')}</span><h3>${candidate.loadingRoom ? i18nText('Abrindo a sala…') : i18nText('A equipe, no mesmo lugar')}</h3><p>Combine o próximo passo com as pessoas da sala.<br>As mensagens ficam dentro da equipe.</p></div>`;
    const query = candidate.search.toLocaleLowerCase('pt-BR'), messages = candidate.messages.filter(message => !query || message.text.toLocaleLowerCase('pt-BR').includes(query));
    let previousDay = '';
    return `${candidate.hasMore ? i18nHtml`<button type="button" class="team-chat-older" data-team-chat-action="older" ${candidate.loadingRoom ? 'disabled' : ''}>Carregar mensagens anteriores</button>` : ''}${query ? i18nHtml`<p class="team-chat-search-note">${messages.length} resultado${messages.length === 1 ? '' : 's'} no histórico carregado</p>` : ''}${messages.map(message => {
      const label = day(message.createdAt), divider = label && label !== previousDay ? `<div class="team-chat-day"><span>${escapeHTML(label)}</span></div>` : ''; previousDay = label;
      const own = message.author.id === string(candidate.context.userId), reference = message.reference;
      const author = candidate.room.members.find(person => person.id === message.author.id);
      return `${divider}<article class="team-chat-message ${own ? 'own' : ''}" data-team-chat-message="${escapeHTML(message.id)}">${own ? '' : avatar({ name: message.author.name, avatar: author?.avatar, eligible: author?.eligible })}<div class="team-chat-bubble"><div class="team-chat-message-meta"><strong>${escapeHTML(own ? i18nText('Você') : message.author.name)}</strong><time datetime="${escapeHTML(message.createdAt)}" title="${escapeHTML(label)}">${escapeHTML(date(message.createdAt))}</time></div><p>${escapeHTML(message.text)}</p>${reference ? reference.unavailable ? i18nMarkup('<span class="team-chat-reference-unavailable">Atendimento indisponível para o seu acesso</span>') : i18nHtml`<button type="button" class="team-chat-message-reference" data-team-chat-action="open-reference" data-message-id="${escapeHTML(message.id)}">${icon('link')} Atendimento · ${escapeHTML(reference.contact)}</button>` : ''}</div></article>`;
    }).join('') || (query ? `<div class="team-chat-empty"><h3>${escapeHTML(i18nText('Nenhuma mensagem encontrada'))}</h3><p>${escapeHTML(i18nText('Limpe a busca ou tente outro termo no histórico carregado.'))}</p></div>` : i18nMarkup('<div class="team-chat-empty"><h3>Comece a conversa</h3><p>Envie uma mensagem para as pessoas desta sala.</p></div>'))}`;
  }
  function referenceOptions(candidate) {
    const selected = draft(candidate).referenceId, items = conversations(candidate);
    return i18nHtml`<option value="">Sem referência de atendimento</option>${items.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHTML(item.contact)}</option>`).join('')}${selected && !items.some(item => item.id === selected) ? i18nMarkup('<option value="" selected>Referência indisponível</option>') : ''}`;
  }
  function composerMarkup(candidate) {
    const value = draft(candidate), disabled = !allowed(candidate) || candidate.loadingRoom || candidate.sending;
    return i18nHtml`<form class="team-chat-composer" data-team-chat-form="message" data-team-chat-compose data-team-chat-version="${candidate.room?.version || 0}" aria-label="Mensagem interna"><div data-team-chat-review>${reviewMarkup(candidate)}</div><label class="sr-only" for="team-chat-draft">Mensagem para a equipe</label><textarea id="team-chat-draft" data-team-chat-draft name="text" rows="2" maxlength="4000" placeholder="Escreva para a equipe desta sala…" ${disabled ? 'disabled' : ''}>${escapeHTML(value.text)}</textarea><div class="team-chat-composer-footer"><div class="team-chat-composer-tools"><label class="team-chat-reference-label">${icon('link')}<span class="sr-only">Referenciar um atendimento autorizado</span><select data-team-chat-reference name="conversationId" aria-label="Referenciar um atendimento autorizado" ${disabled || !conversations(candidate).length ? 'disabled' : ''}>${referenceOptions(candidate)}</select></label><small>Texto interno · anexos indisponíveis</small></div><button type="submit" class="button primary" data-team-chat-send ${disabled || uncertain(candidate) || needsReview(candidate) || !value.text.trim() ? 'disabled' : ''}>${icon('send')}<span>Enviar</span></button></div><p class="team-chat-composer-hint">Enter envia · Shift + Enter cria uma nova linha</p></form>`;
  }
  function render({ drawer = false } = {}) {
    // The page and the drawer never show the same rooms at once: the page wins.
    if (!drawer && drawerOpen) closeDrawer();
    capture(); const candidate = ensure();
    if (!candidate) return i18nMarkup('<div class="team-chat-unavailable">Selecione uma empresa autorizada para acessar o chat da equipe.</div>');
    if (drawer) return i18nHtml`<section class="team-chat-page" data-team-chat data-team-chat-mode="drawer" data-team-chat-key="${escapeHTML(candidate.key)}" data-team-chat-room="${escapeHTML(candidate.selectedId)}" data-mobile-open="${candidate.mobileOpen}"><div class="team-chat-layout"><aside class="team-chat-rooms-panel" aria-label="Salas da equipe"><label class="team-chat-search">${icon('search')}<span class="sr-only">Buscar sala pelo nome</span><input data-team-chat-room-search value="${escapeHTML(candidate.roomSearch)}" maxlength="80" placeholder="Buscar sala"/></label><div class="team-chat-rooms" data-team-chat-rooms>${roomsMarkup(candidate)}</div><div class="team-chat-rooms-footnote"><span aria-hidden="true">${icon('shield')}</span><span>Visível só para os membros</span></div></aside><section class="team-chat-conversation" aria-label="Conversa interna"><header class="team-chat-header" data-team-chat-header>${headerMarkup(candidate)}</header><label class="team-chat-history-search">${icon('search')}<span class="sr-only">Buscar no histórico carregado</span><input data-team-chat-search value="${escapeHTML(candidate.search)}" placeholder="Buscar no histórico carregado" maxlength="120" ${candidate.room ? '' : 'disabled'}/></label><div class="team-chat-messages" data-team-chat-messages aria-live="polite" aria-relevant="additions text">${messagesMarkup(candidate)}</div><p class="team-chat-status" data-team-chat-status role="status">${escapeHTML(candidate.error || candidate.status)}</p>${composerMarkup(candidate)}</section></div></section>`;
    return i18nHtml`<section class="team-chat-page" data-team-chat data-team-chat-key="${escapeHTML(candidate.key)}" data-team-chat-room="${escapeHTML(candidate.selectedId)}" data-mobile-open="${candidate.mobileOpen}"><div class="team-chat-page-heading"><div><span class="eyebrow">CONVERSAS INTERNAS</span><h1>Chat da equipe</h1><p>${escapeHTML(getContext().tenantName || i18nText('Equipe da empresa selecionada'))} · próximos passos, entre pessoas.</p></div>${isAdmin(getContext()) ? i18nHtml`<button type="button" class="button primary" data-team-chat-action="create">${icon('plus')} Nova sala</button>` : ''}</div><div class="team-chat-layout"><aside class="team-chat-rooms-panel" aria-label="Salas da equipe"><div class="team-chat-rooms-heading"><h2>Suas salas</h2><span data-team-chat-room-count>${candidate.rooms.length}</span></div><label class="team-chat-search">${icon('search')}<span class="sr-only">Buscar sala pelo nome</span><input data-team-chat-room-search value="${escapeHTML(candidate.roomSearch)}" maxlength="80" placeholder="Buscar sala"/></label><div class="team-chat-rooms" data-team-chat-rooms>${roomsMarkup(candidate)}</div><div class="team-chat-rooms-footnote">${icon('shield')} Visível só para os membros</div></aside><section class="team-chat-conversation" aria-label="Conversa interna"><header class="team-chat-header" data-team-chat-header>${headerMarkup(candidate)}</header><label class="team-chat-history-search">${icon('search')}<span class="sr-only">Buscar no histórico carregado</span><input data-team-chat-search value="${escapeHTML(candidate.search)}" placeholder="Buscar no histórico carregado" maxlength="120" ${candidate.room ? '' : 'disabled'}/><small>Histórico carregado</small></label><div class="team-chat-messages" data-team-chat-messages aria-live="polite" aria-relevant="additions text">${messagesMarkup(candidate)}</div><p class="team-chat-status" data-team-chat-status role="status">${escapeHTML(candidate.error || candidate.status)}</p>${composerMarkup(candidate)}</section></div></section>`;
  }
  function replace(selector, html) { const node = root?.querySelector(selector); if (node && node.innerHTML !== html) node.innerHTML = html; }
  function focusPanel(candidate, conversation, origin, roomTicket) {
    if (!current(candidate, roomTicket) || !ownRoot(candidate) || root.isConnected === false || candidate.mobileOpen !== conversation || getModal()?.open) return;
    if (root.dataset.teamChatMode !== 'drawer' && doc?.defaultView?.matchMedia?.('(max-width: 899.98px)')?.matches !== true) return;
    const active = doc?.activeElement;
    if (active && active !== doc.body && active !== origin) return;
    const textarea = root.querySelector('[data-team-chat-draft]');
    const selected = [...(root.querySelectorAll?.('[data-team-chat-action="select"]') || [])].find(button => button.dataset.roomId === candidate.selectedId);
    const target = conversation ? textarea && !textarea.disabled ? textarea : root.querySelector('[data-team-chat-action="back"]') : selected || root.querySelector('[data-team-chat-room-search]');
    target?.focus?.({ preventScroll: true });
  }
  function paint(candidate = view, { switchRoom = false, keepScroll = false } = {}) {
    if (!ownRoot(candidate)) return;
    const list = root.querySelector('[data-team-chat-messages]'), atBottom = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 80 : true;
    const oldHeight = list?.scrollHeight, oldTop = list?.scrollTop;
    replace('[data-team-chat-rooms]', roomsMarkup(candidate)); replace('[data-team-chat-header]', headerMarkup(candidate)); replace('[data-team-chat-messages]', messagesMarkup(candidate));
    const badge = root.querySelector('[data-team-chat-room-count]'); if (badge) badge.textContent = string(candidate.rooms.length);
    const status = root.querySelector('[data-team-chat-status]'); if (status) status.textContent = candidate.error || candidate.status;
    const textarea = root.querySelector('[data-team-chat-draft]'), reference = root.querySelector('[data-team-chat-reference]'), form = root.querySelector('[data-team-chat-compose]');
    if (switchRoom) { root.dataset.teamChatRoom = candidate.selectedId; if (textarea) textarea.value = draft(candidate).text; }
    const disabled = !allowed(candidate) || candidate.loadingRoom || candidate.sending;
    if (textarea) textarea.disabled = disabled;
    if (reference) { const value = draft(candidate).referenceId; if (reference.innerHTML !== referenceOptions(candidate)) reference.innerHTML = referenceOptions(candidate); reference.value = conversations(candidate).some(item => item.id === value) ? value : ''; reference.disabled = disabled || !conversations(candidate).length; }
    replace('[data-team-chat-review]', reviewMarkup(candidate));
    const send = root.querySelector('[data-team-chat-send]'); if (send) send.disabled = disabled || uncertain(candidate) || needsReview(candidate) || !draft(candidate).text.trim();
    if (form) form.dataset.teamChatVersion = string(candidate.room?.version || 0);
    const search = root.querySelector('[data-team-chat-search]'); if (search) search.disabled = !candidate.room;
    root.dataset.mobileOpen = string(candidate.mobileOpen);
    publishBadge(candidate.rooms);
    if (list) { if (keepScroll) list.scrollTop = (oldTop || 0) + list.scrollHeight - (oldHeight || 0); else if (switchRoom || atBottom) list.scrollTop = list.scrollHeight; }
    onRender();
  }
  function revoke(candidate, message = i18nText('Seu acesso a esta sala mudou. O texto foi preservado.')) {
    capture(); candidate.roomTicket++; candidate.roomController.abort(); candidate.roomController = new AbortController(); candidate.revoked = true; candidate.room = null; candidate.messages = []; candidate.after = null; candidate.hasMore = false; candidate.error = message; closeModal(); paint(candidate);
  }
  function report(candidate, error, roomTicket) {
    if (!current(candidate, roomTicket) || error.name === 'AbortError') return false;
    if ([401, 403, 404].includes(error.status) && candidate.selectedId) revoke(candidate, translateError(error.message));
    else { candidate.error = translateError(error.message) || i18nText('Não foi possível atualizar o chat da equipe.'); paint(candidate); }
    onError(candidate.error); return false;
  }
  function updateRoom(candidate, input) {
    const room = normalizeTeamChatRoom(input, candidate.context.tenantId);
    if (room.id !== candidate.selectedId || candidate.room && room.version < candidate.room.version) throw stale();
    if (!room.members.some(person => person.id === string(candidate.context.userId) && person.eligible)) { revoke(candidate); return false; }
    candidate.room = room; candidate.revoked = false;
    const index = candidate.rooms.findIndex(item => item.id === room.id); if (index !== -1) candidate.rooms[index] = room;
    return true;
  }
  function merge(candidate, values) { const byId = new Map(candidate.messages.map(message => [message.id, message])); values.forEach(message => byId.set(message.id, message)); candidate.messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence); }
  async function read(candidate, roomTicket) {
    if (!allowed(candidate) || !positive(candidate.after)) return;
    const sequence = candidate.after; if (sequence <= candidate.room.readSequence) return;
    const result = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}/read`, roomOptions(candidate, { method: 'POST', body: JSON.stringify({ sequence }) }));
    guard(candidate, roomTicket);
    if (string(result.roomId) !== candidate.selectedId) throw stale();
    candidate.room.readSequence = count(result.readSequence); candidate.room.unreadCount = count(result.unreadCount);
  }
  async function loadRoom(candidate, roomTicket, initial = false) {
    const id = candidate.selectedId;
    const room = await request(`${base(candidate)}/rooms/${encodeURIComponent(id)}`, roomOptions(candidate, { method: 'GET' }));
    guard(candidate, roomTicket); if (!updateRoom(candidate, room)) return false;
    const after = initial ? null : candidate.after ?? 0;
    const result = await request(`${base(candidate)}/rooms/${encodeURIComponent(id)}/messages?${new URLSearchParams({ limit: '50', ...(after !== null ? { after: string(after) } : {}) })}`, roomOptions(candidate, { method: 'GET' }));
    guard(candidate, roomTicket);
    const data = normalizeTeamChatMessages(result, { tenantId: candidate.context.tenantId, roomId: id }); merge(candidate, data.messages); if (data.messages.length) candidate.after = data.messages.at(-1).sequence; else if (initial) candidate.after = 0;
    if (initial) { candidate.hasMore = data.hasMore; candidate.before = data.before; }
    candidate.error = ''; await read(candidate, roomTicket); guard(candidate, roomTicket); return true;
  }
  async function poll() {
    const candidate = ensure(); if (!candidate || candidate.polling || candidate.loadingRoom) return false;
    candidate.polling = true; const roomTicket = candidate.roomTicket;
    try {
      const result = await request(`${base(candidate)}/rooms`, options(candidate, { method: 'GET' })); guard(candidate);
      if (!Array.isArray(result?.rooms)) throw stale();
      candidate.rooms = result.rooms.map(room => normalizeTeamChatRoom(room, candidate.context.tenantId, { summary: true })); candidate.loaded = true; publishBadge(candidate.rooms);
      if (candidate.selectedId && !candidate.rooms.some(room => room.id === candidate.selectedId)) { revoke(candidate); return false; }
      if (candidate.selectedId) await loadRoom(candidate, roomTicket, !candidate.room);
      guard(candidate, candidate.selectedId ? roomTicket : undefined); paint(candidate); return true;
    } catch (error) { return report(candidate, error, candidate.selectedId ? roomTicket : undefined); }
    finally { candidate.polling = false; paint(candidate); }
  }
  async function select(roomId) {
    const candidate = ensure(); if (!candidate || !candidate.rooms.some(room => room.id === roomId)) return false;
    const focusOrigin = doc?.activeElement;
    capture(); closeModal(); candidate.roomController.abort(); candidate.roomController = new AbortController(); candidate.roomTicket++; const roomTicket = candidate.roomTicket;
    candidate.selectedId = roomId; selections.set(candidate.scope, roomId); candidate.room = null; candidate.messages = []; candidate.hasMore = false; candidate.before = null; candidate.after = null; candidate.revoked = false; candidate.error = ''; candidate.status = ''; candidate.search = ''; candidate.mobileOpen = true; candidate.loadingRoom = true;
    const search = root?.querySelector('[data-team-chat-search]'); if (search) search.value = '';
    paint(candidate, { switchRoom: true });
    try { await loadRoom(candidate, roomTicket, true); guard(candidate, roomTicket); return true; }
    catch (error) {
      const selected = current(candidate, roomTicket), result = report(candidate, error, roomTicket);
      if (selected && current(candidate) && candidate.revoked) { candidate.loadingRoom = false; paint(candidate, { switchRoom: true }); focusPanel(candidate, true, focusOrigin, candidate.roomTicket); }
      return result;
    }
    finally { if (current(candidate, roomTicket)) { candidate.loadingRoom = false; paint(candidate, { switchRoom: true }); focusPanel(candidate, true, focusOrigin, roomTicket); } }
  }
  async function older() {
    const candidate = ensure(), ticket = candidate?.roomTicket; if (!allowed(candidate) || !candidate.hasMore || !positive(candidate.before) || candidate.loadingRoom) return false;
    candidate.loadingRoom = true; paint(candidate);
    try {
      const result = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}/messages?${new URLSearchParams({ before: string(candidate.before), limit: '50' })}`, roomOptions(candidate, { method: 'GET' })); guard(candidate, ticket);
      const data = normalizeTeamChatMessages(result, { tenantId: candidate.context.tenantId, roomId: candidate.selectedId }); merge(candidate, data.messages); candidate.hasMore = data.hasMore; candidate.before = data.before; paint(candidate, { keepScroll: true }); return true;
    } catch (error) { return report(candidate, error, ticket); }
    finally { if (current(candidate, ticket)) { candidate.loadingRoom = false; paint(candidate); } }
  }
  async function send(form) {
    const candidate = ensure(), ticket = candidate?.roomTicket;
    if (!allowed(candidate) || candidate.sending || candidate.loadingRoom || uncertain(candidate) || !ownRoot(candidate) || !root.contains(form)) return false;
    capture(); const value = draft(candidate), text = value.text.trim(), referenceId = value.referenceId, version = candidate.room.version;
    if (!text || text.length > 4000 || value.version !== version || Number(form.dataset.teamChatVersion) !== version) return false;
    if (referenceId && !conversations(candidate).some(item => item.id === referenceId)) { candidate.error = i18nText('A referência não está mais disponível para o seu acesso.'); paint(candidate); return false; }
    candidate.sending = true; candidate.error = ''; paint(candidate);
    try {
      const fresh = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}`, roomOptions(candidate, { method: 'GET' })); guard(candidate, ticket);
      if (!updateRoom(candidate, fresh)) return false;
      if (candidate.room.version !== version) { candidate.status = i18nText('Os membros da sala mudaram. Revise antes de enviar.'); value.intent = null; return false; }
      if (!value.intent || value.intent.text !== text || value.intent.conversationId !== referenceId) value.intent = { version, text, requestId: globalThis.crypto.randomUUID(), conversationId: referenceId };
      const intent = value.intent;
      intent.uncertain = true;
      const result = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}/messages`, roomOptions(candidate, { method: 'POST', body: JSON.stringify({ version: intent.version, text: intent.text, requestId: intent.requestId, ...(intent.conversationId ? { conversationId: intent.conversationId } : {}) }) }));
      guard(candidate, ticket); if (!allowed(candidate)) return false;
      acknowledge(candidate, intent, result); await read(candidate, ticket); return true;
    } catch (error) {
      if (current(candidate, ticket) && error.status === 409 && !error.code) { value.intent = null; candidate.status = i18nText('A sala foi atualizada. Revise antes de tentar novamente.'); try { await loadRoom(candidate, ticket); } catch (refreshError) { return report(candidate, refreshError, ticket); } }
      return report(candidate, error, ticket);
    } finally { candidate.sending = false; paint(candidate); }
  }
  function acknowledge(candidate, intent, result) {
    const data = normalizeTeamChatMessages({ messages: [result] }, { tenantId: candidate.context.tenantId, roomId: candidate.selectedId });
    if (data.messages[0].author.id !== string(candidate.context.userId) || data.messages[0].text !== intent.text) throw stale();
    merge(candidate, data.messages); const value = draft(candidate);
    // An edited draft survives acknowledgement of the earlier immutable payload.
    const same = value.text.trim() === intent.text && value.referenceId === intent.conversationId;
    if (same) { value.text = ''; value.referenceId = ''; value.version = null; const field = root?.querySelector('[data-team-chat-draft]'); if (ownRoot(candidate) && field) field.value = ''; }
    value.intent = null; candidate.error = ''; candidate.status = same ? i18nText('Mensagem enviada para a equipe.') : i18nText('Envio anterior confirmado. O texto em edição foi preservado.');
  }
  async function verifySend() {
    const candidate = ensure(), ticket = candidate?.roomTicket;
    if (!allowed(candidate) || candidate.sending || candidate.loadingRoom || !uncertain(candidate)) return false;
    capture(); const value = draft(candidate), intent = value.intent; candidate.sending = true; candidate.error = ''; paint(candidate);
    try {
      const room = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}`, roomOptions(candidate, { method: 'GET' })); guard(candidate, ticket); if (!updateRoom(candidate, room)) return false;
      const result = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}/messages`, roomOptions(candidate, { method: 'POST', body: JSON.stringify({ version: intent.version, text: intent.text, requestId: intent.requestId, ...(intent.conversationId ? { conversationId: intent.conversationId } : {}) }) }));
      guard(candidate, ticket); if (!allowed(candidate)) return false; acknowledge(candidate, intent, result); await read(candidate, ticket); return true;
    } catch (error) {
      // A definitive CAS rejection proves this exact command was not accepted;
      // transport failures and context changes keep the original request key.
      if (current(candidate, ticket) && error.status === 409 && !error.code) { value.intent = null; candidate.status = i18nText('O envio anterior não foi aceito. Confira os membros antes de enviar.'); }
      return report(candidate, error, ticket);
    } finally { candidate.sending = false; paint(candidate); }
  }
  function modalCurrent(candidate = modalView) { return Boolean(candidate && candidate === modalView && ownsModal(candidate) && current(candidate.view, candidate.kind !== 'create' ? candidate.roomTicket : undefined)); }
  function modalBody(candidate, html) { if (modalCurrent(candidate)) { const node = getModal().querySelector('[data-team-chat-modal]')?.querySelector('[data-team-chat-modal-body]'); if (node) { node.innerHTML = html; onRender(); } } }
  function modalFeedback(candidate, message) { if (modalCurrent(candidate)) { const field = getModal().querySelector('[data-team-chat-modal]')?.querySelector('[data-team-chat-modal-error]'); if (field) field.textContent = message; } }
  function directory(input) { if (!Array.isArray(input?.users)) throw stale(); const known = new Set(); return input.users.filter(person => person?.id && !known.has(string(person.id)) && known.add(string(person.id))).map(person => ({ id: string(person.id), name: string(person.name || i18nText('Pessoa da equipe')), avatar: photo(person.avatar) })); }
  function createMarkup(candidate) {
    const self = string(candidate.view.context.userId), users = candidate.users.filter(person => person.id !== self);
    return i18nHtml`<form data-team-chat-form="create" data-team-chat-token="${candidate.token}" class="team-chat-room-form"><label>Nome da sala<input name="name" maxlength="80" required autocomplete="off" placeholder="Ex.: Operação e suporte"/></label><fieldset class="team-chat-member-picker"><legend>Quem participa</legend><p>Você participa da sala. Escolha até 29 outras pessoas.</p>${users.map(person => `<label class="team-chat-member-choice"><input type="checkbox" name="memberIds" value="${escapeHTML(person.id)}"/>${avatar(person)}<span>${escapeHTML(person.name)}</span></label>`).join('') || i18nMarkup('<p class="team-chat-modal-note">Nenhuma outra pessoa disponível nesta empresa.</p>')}</fieldset><p data-team-chat-modal-error class="team-chat-modal-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close-modal>Cancelar</button><button type="submit" class="button primary">Criar sala</button></div></form>`;
  }
  function membersMarkup(candidate) {
    const room = candidate.view.room, members = room.members, eligible = candidate.users.filter(person => !members.some(member => member.id === person.id));
    return i18nHtml`<div class="team-chat-member-roster"><p class="team-chat-modal-note">${members.length} de 30 pessoas · mensagens visíveis só para os membros.</p>${members.map(person => `<div class="team-chat-member-row">${avatar(person)}<span><strong>${escapeHTML(person.name)}</strong><small>${person.eligible ? person.id === room.createdById ? i18nText('Criou esta sala') : person.id === string(candidate.view.context.userId) ? i18nText('Você') : i18nText('Membro da sala') : i18nText('Acesso indisponível')}</small></span>${room.canManage && person.id !== string(candidate.view.context.userId) ? i18nHtml`<button type="button" class="icon-button" data-team-chat-action="remove-member" data-user-id="${escapeHTML(person.id)}" data-team-chat-token="${candidate.token}" data-team-chat-version="${room.version}" aria-label="Remover ${escapeHTML(person.name)}">${icon('close')}</button>` : ''}</div>`).join('')}</div>${room.canManage ? i18nHtml`<form data-team-chat-form="add-member" data-team-chat-token="${candidate.token}" data-team-chat-version="${room.version}" class="team-chat-add-member"><label>Adicionar uma pessoa<select name="userId" required ${members.length >= 30 || !eligible.length ? 'disabled' : ''}><option value="">Escolha uma pessoa com acesso</option>${eligible.map(person => `<option value="${escapeHTML(person.id)}">${escapeHTML(person.name)}</option>`).join('')}</select></label><button type="submit" class="button primary" ${members.length >= 30 || !eligible.length ? 'disabled' : ''}>Adicionar</button></form>` : i18nMarkup('<p class="team-chat-modal-note">A gestão da empresa pode alterar os membros.</p>')}<p data-team-chat-modal-error class="team-chat-modal-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close-modal>Fechar</button></div>`;
  }
  function recipientsMarkup(candidate) {
    const room = candidate.view.room;
    candidate.confirmVersion = room.version;
    return i18nHtml`<p class="team-chat-modal-note">Seu texto foi iniciado com outra lista de membros. Confira quem poderá ler a mensagem antes de enviar.</p><div class="team-chat-member-roster">${room.members.map(person => `<div class="team-chat-member-row">${avatar(person)}<span><strong>${escapeHTML(person.name)}</strong><small>${person.eligible ? i18nText('Membro da sala') : i18nText('Acesso indisponível')}</small></span></div>`).join('')}</div><p data-team-chat-modal-error class="team-chat-modal-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close-modal>Cancelar</button><button type="button" class="button primary" data-team-chat-action="confirm-members" data-team-chat-token="${candidate.token}" data-team-chat-version="${room.version}">Confirmar destinatários</button></div>`;
  }
  async function confirmRecipients(target) {
    const candidate = modalView;
    if (!modalCurrent(candidate) || candidate.kind !== 'review' || candidate.saving || uncertain(candidate.view) || target.dataset.teamChatToken !== candidate.token || Number(target.dataset.teamChatVersion) !== candidate.confirmVersion) return false;
    candidate.saving = true; target.disabled = true;
    try {
      const result = await request(`${base(candidate.view)}/rooms/${encodeURIComponent(candidate.view.selectedId)}`, { ...options(candidate.view, { method: 'GET' }), signal: candidate.controller.signal });
      if (!modalCurrent(candidate) || !updateRoom(candidate.view, result)) return false;
      if (candidate.view.room.version !== candidate.confirmVersion) { modalBody(candidate, recipientsMarkup(candidate)); modalFeedback(candidate, i18nText('Os membros mudaram novamente. Confira esta lista e confirme quando estiver pronta.')); paint(candidate.view); return false; }
      capture(); const value = draft(candidate.view); value.version = candidate.confirmVersion; value.intent = null; candidate.view.status = i18nText('Destinatários conferidos. Seu texto está pronto para enviar.'); closeModal(); paint(candidate.view); return true;
    } catch (error) { if (modalCurrent(candidate)) { if ([401, 403, 404].includes(error.status)) { closeModal(); report(candidate.view, error, candidate.roomTicket); } else modalFeedback(candidate, translateError(error.message)); } return false; }
    finally { candidate.saving = false; if (modalCurrent(candidate) && target.isConnected !== false) target.disabled = false; }
  }
  async function openRoomModal(kind) {
    const candidateView = ensure(); if (!candidateView || kind === 'create' && !isAdmin(getContext()) || kind !== 'create' && !allowed(candidateView) || kind === 'review' && uncertain(candidateView)) return false;
    closeModal(); const candidate = { kind, view: candidateView, roomTicket: candidateView.roomTicket, token: string(++sequence), controller: new AbortController(), users: [], saving: false }; modalView = candidate;
    openModal(kind === 'create' ? i18nText('Nova sala da equipe') : kind === 'review' ? i18nText('Revisar destinatários') : i18nText('Membros da sala'), kind === 'create' ? i18nText('Uma conversa interna, na empresa selecionada.') : candidateView.room.name, i18nHtml`<section data-team-chat-modal data-team-chat-token="${candidate.token}"><div data-team-chat-modal-body><p class="team-chat-modal-note">Conferindo pessoas autorizadas…</p></div></section>`);
    try {
      if (kind !== 'create') {
        const room = await request(`${base(candidateView)}/rooms/${encodeURIComponent(candidateView.selectedId)}`, { ...options(candidateView, { method: 'GET' }), signal: candidate.controller.signal }); if (!modalCurrent(candidate)) return false; if (!updateRoom(candidateView, room)) return false;
      }
      if (kind === 'create' || kind === 'members' && candidateView.room.canManage) {
        const result = await request(`${base(candidateView)}/directory`, { ...options(candidateView, { method: 'GET' }), signal: candidate.controller.signal }); if (!modalCurrent(candidate)) return false; candidate.users = directory(result);
      }
      if (!modalCurrent(candidate)) return false; modalBody(candidate, kind === 'create' ? createMarkup(candidate) : kind === 'review' ? recipientsMarkup(candidate) : membersMarkup(candidate)); paint(candidateView); return true;
    } catch (error) { if (modalCurrent(candidate)) { if ([401, 403, 404].includes(error.status)) { closeModal(); report(candidateView, error, candidate.roomTicket); } else modalBody(candidate, i18nHtml`<p class="team-chat-modal-error" role="alert">${escapeHTML(translateError(error.message))}</p><button type="button" class="button" data-close-modal>Fechar</button>`); } return false; }
  }
  async function createRoom(form) {
    const candidate = modalView; if (!modalCurrent(candidate) || candidate.kind !== 'create' || candidate.saving || !isAdmin(getContext()) || form.dataset.teamChatToken !== candidate.token) return false;
    const name = string(form.elements.namedItem('name')?.value).trim(), ids = [...form.querySelectorAll('input[name="memberIds"]:checked')].map(field => field.value);
    if (!name || name.length > 80 || new Set(ids).size > 29 || ids.some(id => !candidate.users.some(person => person.id === id))) { modalFeedback(candidate, i18nText('Informe o nome e escolha até 29 pessoas autorizadas.')); return false; }
    candidate.saving = true; const button = form.querySelector('[type="submit"]'); if (button) button.disabled = true;
    try {
      const result = await request(`${base(candidate.view)}/rooms`, { ...options(candidate.view, { method: 'POST', body: JSON.stringify({ name, memberIds: ids }) }), signal: candidate.controller.signal }); if (!modalCurrent(candidate)) return false;
      const room = normalizeTeamChatRoom(result, candidate.view.context.tenantId); candidate.view.rooms.push(room); closeModal(); await select(room.id); return true;
    } catch (error) { modalFeedback(candidate, translateError(error.message)); return false; }
    finally { candidate.saving = false; if (modalCurrent(candidate) && button?.isConnected !== false) button.disabled = false; }
  }
  async function changeMember(action, userId, target) {
    const candidate = modalView; if (!modalCurrent(candidate) || candidate.kind !== 'members' || candidate.saving || !allowed(candidate.view) || !candidate.view.room.canManage || target.dataset.teamChatToken !== candidate.token) return false;
    const room = candidate.view.room;
    if (Number(target.dataset.teamChatVersion) !== room.version) { modalBody(candidate, membersMarkup(candidate)); modalFeedback(candidate, i18nText('Os membros mudaram. Revise a lista antes de continuar.')); return false; }
    if (!userId || action === 'add' && (room.members.length >= 30 || !candidate.users.some(person => person.id === userId) || room.members.some(person => person.id === userId)) || action === 'remove' && (userId === string(candidate.view.context.userId) || !room.members.some(person => person.id === userId))) return false;
    candidate.saving = true; target.disabled = true;
    try {
      const result = await request(`${base(candidate.view)}/rooms/${encodeURIComponent(room.id)}/members`, { ...options(candidate.view, { method: 'POST', body: JSON.stringify({ version: room.version, action, userId }) }), signal: candidate.controller.signal }); if (!modalCurrent(candidate)) return false;
      if (!updateRoom(candidate.view, result)) return false; modalBody(candidate, membersMarkup(candidate)); paint(candidate.view); return true;
    } catch (error) {
      if (modalCurrent(candidate) && [401, 403, 404].includes(error.status)) { closeModal(); report(candidate.view, error, candidate.roomTicket); }
      else if (modalCurrent(candidate)) { if (error.status === 409) { try { const result = await request(`${base(candidate.view)}/rooms/${encodeURIComponent(room.id)}`, options(candidate.view, { method: 'GET' })); if (modalCurrent(candidate) && updateRoom(candidate.view, result)) modalBody(candidate, membersMarkup(candidate)); } catch (refreshError) { report(candidate.view, refreshError, candidate.roomTicket); } } modalFeedback(candidate, translateError(error.message)); }
      return false;
    } finally { candidate.saving = false; if (modalCurrent(candidate) && target.isConnected !== false) target.disabled = false; }
  }
  async function handleAction(target) {
    const action = target?.dataset.teamChatAction; if (!action) return false; if (target.disabled) return true;
    const candidate = ensure(); if (!candidate) return true;
    if (action === 'remove-member' || action === 'confirm-members') { if (getModal()?.querySelector('[data-team-chat-modal]')?.contains(target)) { if (action === 'remove-member') await changeMember('remove', string(target.dataset.userId), target); else await confirmRecipients(target); } return true; }
    if (!ownRoot(candidate) || !root.contains(target)) return true;
    if (action === 'select') await select(string(target.dataset.roomId));
    else if (action === 'older') await older();
    else if (action === 'create') await openRoomModal('create');
    else if (action === 'members') await openRoomModal('members');
    else if (action === 'review-members') await openRoomModal('review');
    else if (action === 'verify-send') await verifySend();
    else if (action === 'back') { const focusOrigin = doc?.activeElement; capture(); candidate.mobileOpen = false; paint(candidate); focusPanel(candidate, false, focusOrigin, candidate.roomTicket); }
    else if (action === 'open-reference' && allowed(candidate)) {
      const ticket = candidate.roomTicket, message = candidate.messages.find(item => item.id === string(target.dataset.messageId));
      if (message?.reference?.conversationId && !message.reference.unavailable) try {
        const result = await request(`${base(candidate)}/rooms/${encodeURIComponent(candidate.selectedId)}/messages?${new URLSearchParams({ before: string(message.sequence + 1), limit: '50' })}`, roomOptions(candidate, { method: 'GET' })); guard(candidate, ticket);
        const fresh = normalizeTeamChatMessages(result, { tenantId: candidate.context.tenantId, roomId: candidate.selectedId }).messages.find(item => item.id === message.id);
        if (fresh) { merge(candidate, [fresh]); paint(candidate); if (fresh.reference?.conversationId && !fresh.reference.unavailable && allowed(candidate)) onOpenConversation(fresh.reference.conversationId, candidate.context.tenantId); }
      } catch (error) { report(candidate, error, ticket); }
    }
    return true;
  }
  async function submit(form) {
    const kind = form?.dataset.teamChatForm; if (!kind) return false;
    if (kind === 'message') await send(form);
    else if (getModal()?.querySelector('[data-team-chat-modal]')?.contains(form)) { if (kind === 'create') await createRoom(form); else if (kind === 'add-member') await changeMember('add', string(form.elements.namedItem('userId')?.value), form); }
    return true;
  }
  function bind(element = globalThis.document?.querySelector('[data-team-chat]')) {
    const candidate = ensure(); root = element; if (!candidate || !ownRoot(candidate)) return false;
    if (!element.__teamChatBound) {
      element.__teamChatBound = true;
      element.addEventListener('input', event => {
        if (!ownRoot()) return;
        if (event.target.matches('[data-team-chat-draft], [data-team-chat-reference]')) { capture(); replace('[data-team-chat-review]', reviewMarkup(view)); const send = root.querySelector('[data-team-chat-send]'); if (send) send.disabled = !allowed(view) || view.sending || uncertain(view) || needsReview(view) || !draft().text.trim(); }
        else if (event.target.matches('[data-team-chat-search]')) { view.search = string(event.target.value).slice(0, 120); paint(); }
        else if (event.target.matches('[data-team-chat-room-search]')) { view.roomSearch = string(event.target.value).slice(0, 80); replace('[data-team-chat-rooms]', roomsMarkup(view)); }
      });
      element.addEventListener('change', event => { if (ownRoot() && event.target.matches('[data-team-chat-reference]')) capture(); });
      element.addEventListener('keydown', event => {
        if (event.target.matches('[data-team-chat-draft]') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); const form = root?.querySelector('[data-team-chat-compose]'); if (form) void submit(form); }
      });
    }
    paint(candidate); if (!candidate.loaded) void poll(); return true;
  }
  // ---- Drawer and global badge (FRONTEND-V2 §2.3, §7.1, §8.3) ----
  function publishBadge(rooms) {
    const total = Array.isArray(rooms) ? rooms.reduce((sum, room) => sum + count(room.unreadCount), 0) : null;
    publishLiveCount('team', total);
    return total;
  }
  const panel = () => doc?.body ? liveDrawer('team', { doc }) : null;
  const teamButton = () => [...(doc?.querySelectorAll?.('[data-action="shell:team"]') || [])].find(node => !node.closest?.('[hidden]')) || null;
  /** Unread messages of the rooms of the open company for the Equipe badge, only where the button is offered. */
  async function pollBadge() {
    if (drawerOpen) return poll();
    if (readContext().active === true) return false;
    const context = readContext(), ticket = ++badgeTicket;
    if (!context.workspaceId || !context.tenantId || !context.userId || !teamButton()) { publishLiveCount('team', null); return false; }
    try {
      const result = await request(`/api/tenants/${encodeURIComponent(context.tenantId)}/team-chat/rooms`, { method: 'GET', headers: { 'X-Elozi-Workspace': context.workspaceId } });
      const latest = readContext();
      if (ticket !== badgeTicket || latest.workspaceId !== context.workspaceId || latest.tenantId !== context.tenantId || !Array.isArray(result?.rooms)) return false;
      publishBadge(result.rooms.map(room => normalizeTeamChatRoom(room, context.tenantId, { summary: true })));
      return true;
    } catch (error) { if ([401, 403, 404].includes(error?.status)) publishLiveCount('team', null); return false; }
  }
  function closeDrawer() {
    if (!drawerOpen) return false;
    capture();
    drawerOpen = false; drawerKey = '';
    if (root?.closest?.('[data-live-drawer]')) { view?.controller.abort(); view?.roomController.abort(); closeModal(); view = null; root = null; sequence++; }
    panel()?.close();
    return true;
  }
  /** Opens (or closes) the Equipe drawer; on the team chat page it only brings the focus there. */
  function openDrawer(trigger) {
    const drawer = panel();
    if (!drawer) return false;
    if (drawer.isOpen) { drawer.close(); return true; }
    const page = doc.querySelector?.('#main-content [data-team-chat]');
    if (page && readContext().active === true) { (page.querySelector('[data-team-chat-draft]:not([disabled])') || page.querySelector('[data-team-chat-room-search]'))?.focus?.(); return true; }
    reset();
    drawerOpen = true;
    const key = teamChatContextKey(getContext());
    if (!key) { drawerOpen = false; onError(i18nText('Selecione uma empresa autorizada para acessar o chat da equipe.')); return false; }
    drawerKey = key;
    const create = isAdmin(getContext()) ? i18nHtml`<button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-team-chat-action="create">${icon('plus')}<span class="ui-btn__label">Nova sala</span></button>` : '';
    const element = drawer.open({ title: i18nText('Equipe'), actions: raw(create), body: raw(render({ drawer: true })), trigger, onClose: () => { if (drawerOpen) closeDrawer(); } });
    if (!element.__teamChatDrawer) {
      element.__teamChatDrawer = true;
      element.addEventListener('click', event => {
        const target = event.target?.closest?.('[data-team-chat-action]');
        if (!target || !element.contains(target)) return;
        event.preventDefault();
        // "Nova sala" sits in the drawer header, outside the rooms root.
        if (target.dataset.teamChatAction === 'create' && !target.closest('[data-team-chat]')) void openRoomModal('create'); else void handleAction(target);
      });
      element.addEventListener('submit', event => { const form = event.target?.closest?.('[data-team-chat-form]'); if (form) { event.preventDefault(); void submit(form); } });
    }
    bind(element.querySelector('[data-team-chat]'));
    return true;
  }
  if (doc?.body) {
    registerLiveTask({ name: 'team-badge', run: pollBadge, cadence: env => env.visible && env.view !== 'team-chat' ? (drawerOpen ? CADENCE.teamOpen : CADENCE.teamClosed) : null, events: ['teamchat.message'] });
    // P1 registers its shell:* defaults after this module is created: the drawer goes in afterwards.
    queueMicrotask(() => registerAction('shell:team', ({ element }) => { openDrawer(element); }));
  }
  return { render, bind, handleAction, submit, poll, reset, openDrawer, closeDrawer, pollBadge, get drawerOpen() { return drawerOpen; }, get busy() { return Boolean(view?.sending || modalView?.saving); }, get opened() { return ownsModal(); } };
}
