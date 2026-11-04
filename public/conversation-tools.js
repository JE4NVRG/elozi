import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';
import './locales-conversation-coverage.js';

import { formatFileSize } from './media-ui.js';

const FILTERS = () => [['all', i18nText('Todas')], ['image', i18nText('Fotos')], ['video', i18nText('Vídeos')], ['audio', i18nText('Áudios')], ['document', i18nText('Documentos')]];
const MEDIA_LABELS = i18nLabels({ image: 'Foto', video: 'Vídeo', audio: 'Áudio', document: 'Documento' });
const MEDIA_ICONS = { image: 'grid', video: 'maximize', audio: 'activity', document: 'document' };
const STATES_LIMIT = 100;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const idOf = value => String(value ?? '');
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const validFilter = filter => FILTERS().some(([value]) => value === filter) ? filter : 'all';

export function normalizeConversationSearch(value) {
  return compact(value).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

export function conversationContextKey(context = {}) {
  return context.active !== false && context.tenantId && context.channelId && context.conversationId
    ? JSON.stringify([idOf(context.workspaceId), idOf(context.tenantId), idOf(context.channelId), idOf(context.conversationId)]) : '';
}

function belongsToContext(record, context, messageId) {
  return record && ['workspaceId', 'tenantId', 'channelId', 'conversationId'].every(key => record[key] == null || idOf(record[key]) === idOf(context[key]))
    && (messageId === undefined || record.messageId == null || idOf(record.messageId) === messageId);
}

function mediaKind(attachment) {
  const declared = attachment.kind || attachment.type;
  if (Object.hasOwn(MEDIA_LABELS, declared)) return declared;
  const type = String(attachment.mime || '').toLowerCase().split('/')[0];
  return Object.hasOwn(MEDIA_LABELS, type) ? type : 'document';
}

// Index only the supplied authorized snapshot. The rows deliberately omit URLs,
// binaries and raw records; opening media always goes through the app callback.
export function buildConversationIndex(conversation, context = {}) {
  if (!conversationContextKey(context) || !conversation || idOf(conversation.id) !== idOf(context.conversationId)
    || idOf(conversation.channelId) !== idOf(context.channelId) || !belongsToContext(conversation, context)) return [];
  const seen = new Set();
  return (Array.isArray(conversation.messages) ? conversation.messages : []).flatMap((message, position) => {
    const id = idOf(message?.id);
    if (!id.trim() || seen.has(id) || !belongsToContext(message, context)) return [];
    seen.add(id);
    const attachmentIds = new Set();
    const attachments = (Array.isArray(message.attachments) ? message.attachments : []).flatMap((attachment, attachmentPosition) => {
      const attachmentId = idOf(attachment?.id);
      if (!attachmentId.trim() || attachmentIds.has(attachmentId) || !belongsToContext(attachment, context, id)) return [];
      attachmentIds.add(attachmentId);
      return [{ id: attachmentId, messageId: id, kind: mediaKind(attachment), name: compact(attachment.name || attachment.filename || i18nText('Arquivo')),
        caption: compact(attachment.caption), mime: compact(attachment.mime), size: Number.isFinite(Number(attachment.size)) && attachment.size != null ? Number(attachment.size) : null,
        status: compact(attachment.status), preview: attachment.preview === true, attachmentPosition }];
    });
    const text = compact(message.text), caption = compact(message.caption);
    const author = compact(message.authorName || message.senderName || (message.kind === 'human' ? i18nText('Atendente') : message.kind === 'system' ? i18nText('Sistema') : i18nText('Contato')));
    return [{ id, messageId: id, position, createdAt: compact(message.createdAt), text, caption, author, attachments,
      searchText: normalizeConversationSearch([text, caption, author, ...attachments.flatMap(attachment => [attachment.name, attachment.caption])].join(' ')) }];
  });
}

// Most recent loaded message first, using timeline position rather than remote
// timestamps. Sorting copies the index and never changes the conversation.
export function filterConversationIndex(index, { query = '', filter = 'all', mode = 'search' } = {}) {
  const term = normalizeConversationSearch(query), type = validFilter(filter);
  const ordered = [...(Array.isArray(index) ? index : [])].sort((first, second) => second.position - first.position);
  if (mode === 'gallery') return ordered.flatMap(message => message.attachments.filter(attachment => (type === 'all' || attachment.kind === type)
    && normalizeConversationSearch([message.text, message.caption, message.author, attachment.name, attachment.caption].join(' ')).includes(term))
    .map(attachment => ({ ...attachment, author: message.author, createdAt: message.createdAt, text: message.text, messageCaption: message.caption, position: message.position })));
  return ordered.filter(message => message.searchText.includes(term) && (type === 'all' || message.attachments.some(attachment => attachment.kind === type)));
}

export function conversationExcerpt(value, query = '', limit = 180) {
  const text = compact(value);
  if (!text) return i18nText('Mensagem sem texto');
  const maximum = Math.max(24, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 180);
  if (text.length <= maximum) return text;
  const term = normalizeConversationSearch(query), normalized = normalizeConversationSearch(text);
  const match = term ? normalized.indexOf(term) : -1;
  let sourceMatch = Math.max(0, match);
  if (match > 0) {
    let normalizedLength = 0, sourceOffset = 0;
    for (const character of text) {
      if (normalizedLength >= match) { sourceMatch = sourceOffset; break; }
      normalizedLength += character.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').length;
      sourceOffset += character.length;
    }
  }
  let start = Math.max(0, sourceMatch - Math.floor(maximum / 3));
  if (start + maximum > text.length) start = Math.max(0, text.length - maximum);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  let end = Math.min(text.length, start + maximum);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function nextConversationResult(results, selectedId, direction = 1) {
  if (!Array.isArray(results) || !results.length) return null;
  const ids = [...new Set(results.map(result => idOf(result.messageId || result.id)))];
  const position = ids.indexOf(idOf(selectedId));
  return ids[position < 0 ? direction < 0 ? ids.length - 1 : 0 : (position + (direction < 0 ? -1 : 1) + ids.length) % ids.length];
}

export function createConversationTools({ escape = escapeHTML, icon = () => '', conversation = () => null,
  navigateToMessage = () => false, mediaAction, getHistoryCoverage, onChange = () => {} } = {}) {
  const states = new Map();
  let current = {}, contextKey = '', scopeKey = '', authorityKey = '', allowed = null, opened = false;
  let state = freshState();
  function freshState() { return { mode: 'search', query: '', filter: 'all', selectedId: '' }; }
  function notify(reason, resultsOnly = false) { onChange({ event: reason, reason, resultsOnly, opened, contextKey }); }
  function reset() { states.clear(); current = {}; contextKey = ''; scopeKey = ''; authorityKey = ''; allowed = null; opened = false; state = freshState(); }
  function save() {
    if (!contextKey) return;
    states.delete(contextKey); states.set(contextKey, { ...state });
    while (states.size > STATES_LIMIT) states.delete(states.keys().next().value);
  }
  function retainConversations(ids) {
    allowed = new Set((ids || []).map(idOf));
    for (const key of states.keys()) if (!allowed.has(JSON.parse(key)[3])) states.delete(key);
    if (contextKey && !allowed.has(idOf(current.conversationId))) {
      states.delete(contextKey); contextKey = ''; current = {}; opened = false; state = freshState(); return false;
    }
    return true;
  }
  function syncContext(next = {}, allowedConversationIds) {
    const nextScope = next.tenantId ? JSON.stringify([idOf(next.workspaceId), idOf(next.tenantId)]) : '';
    const nextAuthority = idOf(next.authorityKey);
    if (nextScope !== scopeKey || nextAuthority !== authorityKey || next.active === false) reset();
    scopeKey = nextScope; authorityKey = nextAuthority;
    if (allowedConversationIds !== undefined) retainConversations(allowedConversationIds);
    const nextKey = conversationContextKey(next);
    if (!nextKey || allowed && !allowed.has(idOf(next.conversationId))) {
      contextKey = ''; current = {}; opened = false; state = freshState(); return false;
    }
    if (nextKey !== contextKey) {
      save(); contextKey = nextKey; opened = false; state = { ...(states.get(nextKey) || freshState()), selectedId: '' };
    }
    current = { workspaceId: next.workspaceId, tenantId: next.tenantId, channelId: next.channelId, conversationId: next.conversationId, active: true };
    return true;
  }
  function authorizedSnapshot() {
    if (!contextKey || allowed && !allowed.has(idOf(current.conversationId))) return null;
    const snapshot = conversation();
    if (!snapshot || idOf(snapshot.id) !== idOf(current.conversationId) || idOf(snapshot.channelId) !== idOf(current.channelId) || !belongsToContext(snapshot, current)) {
      reset(); return null;
    }
    return snapshot;
  }
  function index() { return buildConversationIndex(authorizedSnapshot(), current); }
  // The app keeps cursor/hasMore in inboxMessagePages, NOT on the conversation.
  // messageCount is also supplied on the authorized conversation by loadInboxOpening.
  // Neither a missing flag nor an empty local index proves global absence.
  function coverage(snapshot, loaded) {
    let page;
    try { page = typeof getHistoryCoverage === 'function' ? getHistoryCoverage({ ...current, contextKey }) : null; } catch { /* Unknown coverage is safe. */ }
    const validCount = value => Number.isSafeInteger(value) && value >= loaded;
    const total = validCount(page?.messageCount) ? page.messageCount : validCount(snapshot?.messageCount) ? snapshot.messageCount : null;
    const partial = page?.hasMore === true || total !== null && total > loaded;
    const complete = !partial && (page?.hasMore === false || total === loaded);
    const count = total === null
      ? i18nText('{loaded} mensagens carregadas.', { loaded: loaded.toLocaleString(getLocale()) })
      : i18nText('{loaded} de {total} mensagens carregadas.', { loaded: loaded.toLocaleString(getLocale()), total: total.toLocaleString(getLocale()) });
    const note = partial ? i18nText('Há mensagens anteriores ainda não carregadas.') : complete
      ? i18nText('Todo o histórico disponível desta conversa está carregado.') : i18nText('A cobertura total do histórico não foi confirmada.');
    const help = complete ? '' : i18nText('Use Carregar anteriores no histórico da conversa para ampliar a busca quando disponível.');
    return `<p class="conversation-tool-scope-note" role="status" aria-live="polite" aria-atomic="true" data-conversation-tool-coverage="${partial ? 'partial' : complete ? 'complete' : 'unknown'}">${escape(count)} ${escape(note)}${help ? ` ${escape(help)}` : ''}</p>`;
  }
  function open(mode = 'search') {
    index();
    if (!contextKey) return false;
    state.mode = mode === 'gallery' ? 'gallery' : 'search'; opened = true; save(); notify('open'); return true;
  }
  function close() {
    if (!opened) return false;
    opened = false; save(); notify('close'); return true;
  }
  function dateLabel(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : i18nText('Data não informada');
  }
  function actionAttributes(action, extra = '') { return `data-conversation-tool="${action}" data-context-key="${escape(contextKey)}" ${extra}`; }
  function snippet(message) {
    const candidates = [message.text, message.caption || message.messageCaption, ...(message.attachments || []).flatMap(attachment => [attachment.caption, attachment.name])].filter(Boolean);
    const query = normalizeConversationSearch(state.query);
    return conversationExcerpt(candidates.find(candidate => query && normalizeConversationSearch(candidate).includes(query)) || candidates[0] || message.name || '', state.query);
  }
  function results() {
    const snapshot = authorizedSnapshot();
    if (!contextKey) return '';
    const loaded = buildConversationIndex(snapshot, current), rows = filterConversationIndex(loaded, state);
    const coverageNote = coverage(snapshot, loaded.length);
    const gallery = state.mode === 'gallery', count = rows.length;
    const label = `${count.toLocaleString(getLocale())} ${gallery ? count === 1 ? i18nText('arquivo encontrado') : i18nText('arquivos encontrados') : count === 1 ? i18nText('mensagem encontrada') : i18nText('mensagens encontradas')}`;
    const filters = i18nHtml`<div class="conversation-tool-filters" role="group" aria-label="Filtrar por tipo">${FILTERS().map(([value, title]) => `<button type="button" class="conversation-tool-filter ${state.filter === value ? 'is-active' : ''}" ${actionAttributes('filter', `data-value="${value}"`)} aria-pressed="${state.filter === value}">${title}</button>`).join('')}</div>`;
    const heading = `<div class="conversation-tool-results-heading"><span role="status" aria-live="polite" aria-atomic="true">${escape(label)} · ${escape(i18nText('no histórico carregado'))}</span>${!gallery ? i18nHtml`<div class="conversation-tool-navigation" aria-label="Navegar pelos resultados"><button type="button" class="icon-button conversation-tool-previous" ${actionAttributes('previous')} aria-label="Resultado anterior" ${count ? '' : 'disabled'}>${icon('chevron')}</button><button type="button" class="icon-button conversation-tool-next" ${actionAttributes('next')} aria-label="Próximo resultado" ${count ? '' : 'disabled'}>${icon('chevron')}</button></div>` : ''}</div>`;
    if (!count) return `${filters}${heading}${coverageNote}<div class="conversation-tool-empty">${icon(gallery ? 'document' : 'search')}<strong>${state.query || state.filter !== 'all' ? i18nText('Nenhum resultado nas mensagens carregadas') : gallery ? i18nText('Nenhum arquivo nas mensagens carregadas') : i18nText('Nenhuma mensagem carregada')}</strong><p>${state.query || state.filter !== 'all' ? i18nText('Tente outro termo ou escolha Todas.') : i18nText('Novas mensagens aparecerão aqui quando forem recebidas.')}</p></div>`;
    return `${filters}${heading}${coverageNote}<ul class="conversation-tool-list ${gallery ? 'conversation-tool-gallery' : 'conversation-tool-search-results'}">${rows.map(row => {
      const metadata = `<span class="conversation-tool-result-meta"><strong>${escape(row.author)}</strong><time>${escape(dateLabel(row.createdAt))}</time></span>`;
      const ids = `data-id="${escape(row.messageId)}" data-message-id="${escape(row.messageId)}"`;
      if (!gallery) return i18nHtml`<li class="conversation-tool-result ${state.selectedId === row.messageId ? 'is-current' : ''}"><button type="button" class="conversation-tool-jump" ${actionAttributes('jump', ids)} aria-label="Ir à mensagem de ${escape(row.author)}">${metadata}<span class="conversation-tool-excerpt">${escape(snippet(row))}</span>${row.attachments.length ? `<span class="conversation-tool-file-count">${icon('paperclip')}${row.attachments.length} ${row.attachments.length === 1 ? i18nText('arquivo') : i18nText('arquivos')}</span>` : ''}</button></li>`;
      const ready = row.status === 'ready', preview = ready && row.preview && row.kind !== 'document';
      const mediaIds = `data-id="${escape(row.id)}" data-message-id="${escape(row.messageId)}"`;
      return i18nHtml`<li class="conversation-tool-file"><span class="conversation-tool-file-symbol" aria-hidden="true">${icon(MEDIA_ICONS[row.kind])}</span><div class="conversation-tool-file-copy"><strong class="conversation-tool-filename">${escape(row.name)}</strong><span class="conversation-tool-file-detail">${MEDIA_LABELS[row.kind]} · ${escape(formatFileSize(row.size ?? undefined))}${ready ? '' : i18nText(' · Indisponível')}</span>${metadata}${row.caption || row.messageCaption || row.text ? `<span class="conversation-tool-excerpt">${escape(conversationExcerpt(row.caption || row.messageCaption || row.text, state.query, 110))}</span>` : ''}</div><div class="conversation-tool-file-actions"><button type="button" class="text-button" ${actionAttributes('jump', ids)}>Ver mensagem</button>${preview && row.kind!=='audio' ? i18nHtml`<button type="button" class="text-button" ${actionAttributes('open-media', mediaIds)} ${mediaAction ? '' : 'disabled'}>Abrir</button>` : ''}<button type="button" class="icon-button" ${actionAttributes('download-media', mediaIds)} aria-label="Baixar ${escape(row.name)}" ${ready && mediaAction ? '' : 'disabled'}>${icon('download')}</button></div></li>`;
    }).join('')}</ul>`;
  }
  function panel() {
    if (!opened) return '';
    const content = results();
    if (!contextKey) return '';
    return i18nHtml`<section class="conversation-tools conversation-tools-panel" aria-labelledby="conversation-tools-title"><div class="conversation-tool-heading"><div><span class="conversation-tool-kicker">Nesta conversa</span><h3 id="conversation-tools-title">${state.mode === 'gallery' ? i18nText('Mídias e arquivos') : i18nText('Buscar no histórico carregado')}</h3></div><button type="button" class="icon-button" ${actionAttributes('close')} aria-label="Fechar busca e arquivos">${icon('close')}</button></div><div class="conversation-tool-modes" role="group" aria-label="Ferramentas da conversa"><button type="button" class="text-button ${state.mode === 'search' ? 'is-active' : ''}" ${actionAttributes('mode', 'data-value="search"')} aria-pressed="${state.mode === 'search'}">${icon('search')} Mensagens</button><button type="button" class="text-button ${state.mode === 'gallery' ? 'is-active' : ''}" ${actionAttributes('mode', 'data-value="gallery"')} aria-pressed="${state.mode === 'gallery'}">${icon('document')} Mídias e arquivos</button></div><label class="conversation-tool-search" for="conversation-tool-search-input">${icon('search')}<span class="sr-only">Buscar texto, nome do arquivo, legenda ou autor nas mensagens carregadas</span><input id="conversation-tool-search-input" type="search" data-conversation-tool-search data-context-key="${escape(contextKey)}" value="${escape(state.query)}" placeholder="Texto, arquivo, legenda ou autor…" autocomplete="off" maxlength="200"/></label><small class="conversation-tool-scope-note">Somente o histórico carregado desta conversa.</small><div data-conversation-tool-results>${content}</div></section>`;
  }
  function setQuery(query) {
    if (!contextKey) return false;
    state.query = String(query ?? '').slice(0, 200); state.selectedId = ''; save(); notify('query', true); return true;
  }
  function handleInput(target) {
    if (!target || !Object.hasOwn(target.dataset || {}, 'conversationToolSearch') || target.dataset.contextKey !== contextKey) return false;
    index(); return contextKey ? setQuery(target.value) : false;
  }
  function jump(id) {
    const key = contextKey, rows = index(), messageId = idOf(id);
    if (!key || key !== contextKey || !rows.some(row => row.messageId === messageId)) return false;
    if (navigateToMessage(messageId) === false) return false;
    if (key !== contextKey) return false;
    state.selectedId = messageId; save(); notify('navigate', true); return true;
  }
  function handleAction(target) {
    if (!target || target.disabled) return false;
    const { conversationTool: action, contextKey: targetContext, id, messageId, value } = target.dataset || {};
    if (action === 'open-search' || action === 'open-gallery') return (!targetContext || targetContext === contextKey) && open(action === 'open-gallery' ? 'gallery' : 'search');
    if (!contextKey || targetContext !== contextKey) return false;
    if (action === 'close') return close();
    const rows = index();
    if (!contextKey || targetContext !== contextKey) { notify('revoked'); return false; }
    if (action === 'mode') { state.mode = value === 'gallery' ? 'gallery' : 'search'; state.selectedId = ''; save(); notify('mode'); return true; }
    if (action === 'filter') { state.filter = validFilter(value); state.selectedId = ''; save(); notify('filter', true); return true; }
    if (action === 'jump') return jump(messageId || id);
    if (action === 'previous' || action === 'next') return jump(nextConversationResult(filterConversationIndex(rows, state), state.selectedId, action === 'previous' ? -1 : 1));
    if (!['open-media', 'download-media'].includes(action) || !mediaAction) return false;
    const attachment = rows.find(row => row.messageId === idOf(messageId))?.attachments.find(item => item.id === idOf(id));
    if (!attachment || attachment.status !== 'ready' || action === 'open-media' && (!attachment.preview || attachment.kind === 'document')) return false;
    return Promise.resolve(mediaAction({ action: action === 'open-media' ? 'open' : 'download', id: attachment.id, messageId: attachment.messageId, contextKey, origin: target })).then(() => true);
  }
  return { syncContext, retainConversations, reset, open, close, panel, results, setQuery, handleInput, handleAction, jump,
    get opened() { return opened; }, get contextKey() { return contextKey; }, get mode() { return state.mode; }, get query() { return state.query; }, get filter() { return state.filter; } };
}
