import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy, h} from './i18n.js';
import './locales-operations.js';
import { button, badge, emptyState, attributes } from './ui.js';
import { glyph } from './icons.js';

const DRAFT_LIMIT = 200;
const DEFAULT_LIMITS = { shortcut: 32, title: 80, text: 4000 };
const MEDIA_LABELS = i18nLabels({ image: 'Foto', audio: 'Áudio', video: 'Vídeo', document: 'Arquivo' });

function normalizeSearch(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

// ---- management (Automação › Respostas rápidas, FRONTEND-V2 §2.2; P8-B) ------------------------
// Pure builders of the management screen, drawn by automation-ui.js on the design tokens
// (.pg-automation__*, public/automation.css). Its actions are 'automation:reply-*' and its editor is
// the data-form="automation:reply" form of the actions registry. The composer integration below
// (picker, quotes, insertion) and the modal manager of the inbox keep their data-reply-* hooks.

/** Field limits of a quick reply (same as the server: src/quick-replies.js). */
export const QUICK_REPLY_LIMITS = Object.freeze({ ...DEFAULT_LIMITS });

/** Replies whose shortcut, title or text contain the query (accents ignored); inactive only for admins. */
export function filterQuickReplies(items, query = '', { admin = false } = {}) {
  const search = normalizeSearch(query).replace(/^\//, '');
  return (Array.isArray(items) ? items : []).filter(item => item && (admin || item.active === true) && normalizeSearch(`${item.shortcut || ''} ${item.title || ''} ${item.text || ''}`).includes(search));
}

/** Editor values as the API takes them: version kept for CAS, shortcut without "/" and in lowercase. */
export function readQuickReplyForm(form) {
  const value = name => String(form?.elements?.namedItem(name)?.value || '');
  return { id: value('id'), ...(value('version') ? { version: Number(value('version')) } : {}), shortcut: value('shortcut').trim().replace(/^\//, '').toLowerCase(), title: value('title').trim(), text: value('text').trim() };
}

const shortcutOf = item => String(item?.shortcut || '').replace(/^\//, '');

/** Preview of the text exactly as it will be inserted in the composer (escaped, line breaks kept by CSS). */
export function quickReplyPreview(text) {
  return String(text || '').trim() ? h`<p class="pg-automation__preview-text">${text}</p>` : h`<p class="pg-automation__muted">O texto da resposta aparecerá aqui.</p>`;
}

/** Count line of the list: "12 respostas · 2 desativadas" (or the matches of a search). */
export function quickRepliesCount(items, query = '') {
  const all = Array.isArray(items) ? items : [], visible = filterQuickReplies(all, query, { admin: true });
  const inactive = all.filter(item => item && item.active !== true).length;
  if (String(query || '').trim()) return visible.length === 1 ? i18nText('1 resposta encontrada') : i18nText('{count} respostas encontradas', { count: visible.length });
  const total = all.length === 1 ? i18nText('1 resposta') : i18nText('{count} respostas', { count: all.length });
  return inactive ? `${total} · ${inactive === 1 ? i18nText('1 desativada') : i18nText('{count} desativadas', { count: inactive })}` : total;
}

/** Results of the management list (also patched in place while the person types in the search). */
export function quickRepliesResults(items, { query = '' } = {}) {
  const all = Array.isArray(items) ? items : [], visible = filterQuickReplies(all, query, { admin: true });
  if (!all.length) return emptyState({ icon: 'document', title: i18nText('Nenhuma resposta rápida ainda'), body: i18nText('Crie textos que a equipe insere no compositor pelo botão Respostas rápidas e revisa antes de enviar.'), action: { label: i18nText('Criar a primeira resposta'), action: 'automation:reply-new', icon: 'plus', attrs: { 'data-automation-focus': 'reply-new', 'aria-haspopup': 'dialog' } } });
  if (!visible.length) return emptyState({ icon: 'search', title: i18nText('Nenhuma resposta encontrada'), body: i18nText('Tente outro atalho, título ou trecho da mensagem.'), action: { label: i18nText('Limpar busca'), action: 'automation:replies-clear-search', attrs: { 'data-automation-focus': 'replies-clear' } } });
  return h`<ul class="pg-automation__replies">${visible.map(item => {
    const active = item.active === true, title = String(item.title || '');
    return h`<li class="pg-automation__reply"${attributes({ 'data-state': active ? 'active' : 'inactive' })}><div class="pg-automation__reply-main"><p class="pg-automation__reply-head"><code class="pg-automation__shortcut">/${shortcutOf(item)}</code>${badge(active ? i18nText('Ativa') : i18nText('Desativada'), active ? 'success' : 'neutral')}</p><h3 class="pg-automation__reply-title">${title}</h3><p class="pg-automation__reply-text">${item.text}</p><p class="pg-automation__meta">${i18nText('Versão {version}', { version: item.version })}</p></div><div class="pg-automation__reply-actions">${button({ label: i18nText('Editar'), action: 'automation:reply-edit', variant: 'secondary', size: 'sm', icon: 'document', attrs: { 'data-id': item.id, 'aria-label': i18nText('Editar {title}', { title }), 'aria-haspopup': 'dialog', 'data-automation-focus': `reply-edit:${item.id}` } })}${button({ label: active ? i18nText('Desativar') : i18nText('Reativar'), action: 'automation:reply-toggle', variant: 'ghost', size: 'sm', attrs: { 'data-id': item.id, 'aria-label': active ? i18nText('Desativar {title}', { title }) : i18nText('Reativar {title}', { title }), 'data-automation-focus': `reply-toggle:${item.id}` } })}</div></li>`;
  })}</ul>`;
}

/** Search and list of the management screen (the header and the states around it are automation-ui's). */
export function quickRepliesScreen(items, { query = '' } = {}) {
  const all = Array.isArray(items) ? items : [];
  const search = all.length ? h`<div class="pg-automation__list-toolbar"><div class="pg-automation__search"><label class="sr-only" for="automation-replies-search">${i18nText('Buscar respostas')}</label><span class="pg-automation__search-icon" aria-hidden="true">${glyph('search')}</span><input class="pg-automation__search-input" type="search" id="automation-replies-search" data-automation-search="replies" data-automation-focus="replies-search" autocomplete="off" spellcheck="false" aria-controls="automation-replies-results"${attributes({ value: query, placeholder: i18nText('Buscar por atalho, título ou texto…') })}/></div><p class="pg-automation__meta" role="status" aria-live="polite" data-automation-replies-count>${quickRepliesCount(all, query)}</p></div>` : '';
  return h`${search}<div id="automation-replies-results" data-automation-results="replies">${quickRepliesResults(all, { query })}</div>`;
}

/** Editor of the management screen (inside the automation dialog); version is the CAS token. */
export function quickReplyEditorForm(item = {}, { limits = DEFAULT_LIMITS } = {}) {
  const text = String(item.text || ''), max = Number(limits.text);
  return h`<form class="pg-automation__form" data-form="automation:reply"><input type="hidden" name="id"${attributes({ value: item.id || '' })}/><input type="hidden" name="version"${attributes({ value: item.version ?? '' })}/><div class="pg-automation__field"><label class="pg-automation__label" for="automation-reply-shortcut">Atalho</label><div class="pg-automation__prefix-field"><span aria-hidden="true">/</span><input class="pg-automation__control" id="automation-reply-shortcut" name="shortcut" required minlength="2" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" autocomplete="off" spellcheck="false" aria-describedby="automation-reply-shortcut-hint"${attributes({ value: shortcutOf(item), maxlength: limits.shortcut })}/></div><p class="pg-automation__hint" id="automation-reply-shortcut-hint">${i18nText('De 2 a {max} letras, números, hífen ou sublinhado. Ex.: boas-vindas.', { max: limits.shortcut })}</p></div><div class="pg-automation__field"><label class="pg-automation__label" for="automation-reply-title">Título</label><input class="pg-automation__control" id="automation-reply-title" name="title" required placeholder="Boas-vindas"${attributes({ value: item.title || '', maxlength: limits.title })}/></div><div class="pg-automation__field"><label class="pg-automation__label" for="automation-reply-text">Mensagem</label><textarea class="pg-automation__control pg-automation__textarea" id="automation-reply-text" name="text" required rows="6" placeholder="Olá! Como podemos ajudar?" aria-describedby="automation-reply-text-hint automation-reply-counter" data-automation-counted${attributes({ maxlength: max })}>${text}</textarea><div class="pg-automation__field-foot"><p class="pg-automation__hint" id="automation-reply-text-hint">${i18nText('Até {max} caracteres. A equipe pode ajustar o texto antes de enviar.', { max: max.toLocaleString(getLocale()) })}</p><p class="pg-automation__counter" id="automation-reply-counter" data-automation-counter${attributes({ hidden: text.length < max * .8, 'data-state': text.length >= max ? 'full' : null })}>${text.length.toLocaleString(getLocale())} / ${max.toLocaleString(getLocale())}</p></div></div><section class="pg-automation__preview" aria-labelledby="automation-reply-preview-title"><p class="pg-automation__eyebrow" id="automation-reply-preview-title">Prévia para revisão</p><div data-automation-preview>${quickReplyPreview(text)}</div></section><p class="pg-automation__form-error" role="alert" data-automation-error></p><div class="pg-automation__dialog-actions">${button({ label: i18nText('Cancelar'), action: 'automation:close-dialog', variant: 'ghost' })}${button({ label: i18nText('Salvar resposta'), type: 'submit', variant: 'primary', icon: 'check' })}</div></form>`;
}

export function createRepliesUI({ escape, icon = () => '', limits: configuredLimits = {}, onChange } = {}) {
  const e = escape || (value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])));
  const limits = { ...DEFAULT_LIMITS, ...configuredLimits };
  const drafts = new Map(), composerSnapshots = new WeakMap();
  let scope = '', context = '', conversationId = '', quoteId = '', error = '', status = '';
  let messages = new Map(), allowed = null;

  const messageInConversation = message => message && message.id && ['customer', 'human'].includes(message.kind) && (!message.conversationId || String(message.conversationId) === conversationId);
  const validMessage = message => messageInConversation(message) && !['pending', 'failed', 'unconfirmed'].includes(message.delivery);
  const author = message => message.kind === 'human' ? String(message.authorName || i18nText('Atendente')) : String(message.senderName || i18nText('Contato'));
  function excerpt(message) {
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const attachment = attachments[0];
    const media = attachment ? `${MEDIA_LABELS[attachment.kind || attachment.type] || MEDIA_LABELS[String(attachment.mime || '').split('/')[0]] || i18nText('Arquivo')}${attachment.name ? ' · ' + attachment.name : ''}` : '';
    return (text || media || i18nText('Mensagem sem texto')).slice(0, 180);
  }
  function notify() {
    updateQuoteComposer();
    onChange?.({ replyToMessageId: quoteId || null, error, status });
  }
  function reset() {
    drafts.clear(); messages.clear(); allowed = null;
    scope = ''; context = ''; conversationId = ''; quoteId = ''; error = ''; status = '';
  }
  function retainConversations(ids) {
    allowed = new Set((ids || []).map(String));
    for (const key of drafts.keys()) if (!allowed.has(JSON.parse(key)[2])) drafts.delete(key);
    if (context && !allowed.has(conversationId)) {
      context = ''; conversationId = ''; quoteId = ''; messages.clear(); error = ''; status = '';
      notify();
      return false;
    }
    return true;
  }
  function syncContext(next = {}, allowedConversationIds) {
    const nextScope = next.workspaceId && next.tenantId ? JSON.stringify([next.workspaceId, next.tenantId]) : '';
    if (scope && nextScope !== scope) reset();
    scope = nextScope;
    if (allowedConversationIds !== undefined) retainConversations(allowedConversationIds);
    const id = String(next.conversationId || '');
    const nextContext = nextScope && id && next.active !== false ? JSON.stringify([next.workspaceId, next.tenantId, id]) : '';
    if (nextContext && allowed && !allowed.has(id)) {
      context = ''; conversationId = ''; quoteId = ''; messages.clear(); error = ''; status = '';
      notify();
      return false;
    }
    if (nextContext !== context) { context = nextContext; quoteId = drafts.get(context) || ''; error = ''; status = ''; }
    conversationId = nextContext ? id : '';
    messages = new Map((nextContext && Array.isArray(next.messages) ? next.messages : []).filter(validMessage).map(message => [String(message.id), message]));
    if (quoteId && !messages.has(quoteId)) {
      drafts.delete(context); quoteId = '';
      status = i18nText('A mensagem referenciada não está mais disponível. Escolha outra antes de enviar.');
    }
    return true;
  }
  function selectQuote(id) {
    const target = String(id || '');
    if (!context || !messages.has(target)) {
      error = i18nText('Esta mensagem não está disponível para responder nesta conversa.'); notify(); return false;
    }
    if (!drafts.has(context) && drafts.size >= DRAFT_LIMIT) {
      error = i18nText('Há 200 referências guardadas nesta empresa. Remova ou envie uma delas antes de selecionar outra.'); notify(); return false;
    }
    quoteId = target; drafts.set(context, target); error = '';
    status = i18nText('Referência selecionada. Revise a resposta antes de enviar.');
    notify(); return true;
  }
  function clearQuote(options = {}) {
    const existed = Boolean(quoteId);
    drafts.delete(context); quoteId = ''; error = '';
    status = options.silent ? '' : existed ? i18nText('Referência removida. Seu texto foi preservado.') : '';
    notify();
  }
  function quoteInner(disabled = false) {
    const message = messages.get(quoteId);
    return `${message ? i18nHtml`<div class="reply-composer-quote" role="group" aria-label="Mensagem que você está respondendo"><div class="reply-composer-reference"><span class="reply-quote-kicker">Respondendo à mensagem</span><button type="button" class="reply-quote-preview" data-reply-action="jump" data-id="${e(quoteId)}" aria-label="Ver mensagem original de ${e(author(message))}"><strong>${e(author(message))}</strong><span>${e(excerpt(message))}</span></button></div><button type="button" class="icon-button reply-clear-quote" data-reply-action="clear" aria-label="Remover referência sem apagar o texto" ${disabled ? 'disabled' : ''}>${icon('close')}</button></div>` : ''}<div id="message-reply-error" class="reply-composer-error" role="alert">${e(translateError(error))}</div><span class="reply-composer-status sr-only" role="status" aria-live="polite">${e(translateCopy(status))}</span>`;
  }
  function quoteComposer(disabled = false) { return `<div id="message-quote">${quoteInner(disabled)}</div>`; }
  function updateQuoteComposer(disabled) {
    if (typeof document === 'undefined') return;
    const target = document.querySelector('#message-quote');
    if (!target) return;
    const locked = disabled ?? Boolean(document.querySelector('#message-text')?.disabled);
    const markup = quoteInner(locked), snapshot = composerSnapshots.get(target);
    if (target.innerHTML === markup || snapshot?.markup === markup && snapshot.html === target.innerHTML) return;
    target.innerHTML = markup;
    composerSnapshots.set(target, { markup, html: target.innerHTML });
  }
  function messageQuote(message) {
    if (!messageInConversation(message) || !message?.replyToMessageId) return '';
    const id = String(message.replyToMessageId), original = messages.get(id);
    if (!original) return i18nMarkup('<div class="message-quote is-unavailable"><span>Mensagem referenciada indisponível nesta conversa.</span></div>');
    return i18nHtml`<button type="button" class="message-quote" data-reply-action="jump" data-id="${e(id)}" aria-label="Ver mensagem original de ${e(author(original))}"><strong>${e(author(original))}</strong><span>${e(excerpt(original))}</span></button>`;
  }
  function messageReplyButton(message, disabled = false) {
    if (!validMessage(message)) return '';
    return i18nHtml`<button type="button" class="message-reply-button" data-reply-action="quote" data-id="${e(message.id)}" aria-label="Responder à mensagem de ${e(author(message))}" ${disabled ? 'disabled' : ''}>${icon('arrow')}<span>Responder</span></button>`;
  }
  function quickButton(disabled = false) {
    return i18nHtml`<button type="button" class="text-button quick-replies-button" data-reply-action="open" aria-haspopup="dialog" ${disabled ? 'disabled' : ''}>${icon('document')} Respostas rápidas</button>`;
  }
  function filterItems(items, query = '', { admin = false } = {}) {
    return filterQuickReplies(items, query, { admin });
  }
  function pickerItems(items, { query = '', disabled = false } = {}) {
    const visible = filterItems(items, query);
    if (!visible.length) return `<div class="quick-replies-empty" role="status">${icon(query ? 'search' : 'document')}<strong>${query ? i18nText('Nenhuma resposta encontrada') : i18nText('Nenhuma resposta ativa')}</strong><p>${query ? i18nText('Tente outro atalho, título ou trecho da mensagem.') : i18nText('O administrador pode criar respostas para esta empresa.')}</p></div>`;
    return `<ul class="quick-replies-list">${visible.map(item => i18nHtml`<li><button type="button" class="quick-reply-option" data-reply-action="insert" data-id="${e(item.id)}" ${disabled ? 'disabled' : ''}><span class="quick-reply-option-heading"><code>/${e(String(item.shortcut || '').replace(/^\//, ''))}</code><strong>${e(item.title)}</strong>${icon('plus')}</span><span class="quick-reply-option-text">${e(item.text)}</span><span class="quick-reply-option-hint">Inserir no rascunho</span></button></li>`).join('')}</ul>`;
  }
  function picker(items, options = {}) {
    const { admin = false, query = '', disabled = false } = options;
    return i18nHtml`<section class="quick-replies-picker" aria-label="Respostas rápidas desta empresa"><div class="quick-replies-intro"><span class="quick-replies-mark" aria-hidden="true">${icon('document')}</span><p>Escolha um texto, ajuste a resposta e envie quando estiver pronto.</p></div><label class="quick-replies-search" for="quick-reply-search">${icon('search')}<span class="sr-only">Buscar por atalho, título ou texto</span><input id="quick-reply-search" type="search" data-reply-search="picker" placeholder="Buscar por atalho, título ou texto…" value="${e(query)}" autocomplete="off"/></label><div id="quick-reply-results" data-reply-results>${pickerItems(items, options)}</div><div class="quick-replies-footer"><small>Seu rascunho e os anexos são preservados.</small>${admin ? i18nMarkup('<button type="button" class="text-button" data-reply-action="manage">Gerenciar respostas</button>') : ''}</div><p class="quick-replies-feedback" data-reply-feedback role="alert"></p></section>`;
  }
  function manager(items, { query = '', busy = false, error: formError = '' } = {}) {
    const visible = filterItems(items, query, { admin: true });
    return i18nHtml`<section class="quick-replies-manager" aria-label="Gerenciar respostas da empresa"><div class="quick-replies-manager-heading"><p>Textos reutilizáveis para sua equipe. Cada resposta continua sendo revisada antes do envio.</p><button type="button" class="button primary" data-reply-action="new" ${busy ? 'disabled' : ''}>${icon('plus')} Nova resposta</button></div><label class="quick-replies-search" for="quick-replies-manager-search">${icon('search')}<span class="sr-only">Buscar respostas ativas e desativadas</span><input id="quick-replies-manager-search" type="search" data-reply-search="manager" value="${e(query)}" placeholder="Buscar respostas…" autocomplete="off"/></label><div class="quick-replies-admin-list" data-reply-results>${visible.length ? visible.map(item => i18nHtml`<article class="quick-reply-admin-card ${item.active ? '' : 'is-inactive'}"><div class="quick-reply-admin-heading"><code>/${e(String(item.shortcut || '').replace(/^\//, ''))}</code><span class="quick-reply-state ${item.active ? 'is-active' : ''}">${item.active ? i18nText('Ativa') : i18nText('Desativada')}</span></div><h3>${e(item.title)}</h3><p>${e(item.text)}</p><div class="quick-reply-admin-actions"><small>Versão ${e(item.version)}</small><button type="button" class="text-button" data-reply-action="edit" data-id="${e(item.id)}" ${busy ? 'disabled' : ''}>Editar</button><button type="button" class="text-button" data-reply-action="toggle" data-id="${e(item.id)}" data-version="${e(item.version)}" data-active="${!item.active}" ${busy ? 'disabled' : ''}>${item.active ? i18nText('Desativar') : i18nText('Reativar')}</button></div></article>`).join('') : `<div class="quick-replies-empty" role="status">${icon('document')}<strong>${query ? i18nText('Nenhuma resposta encontrada') : i18nText('Sua equipe ainda não tem respostas rápidas')}</strong><p>${query ? i18nText('Tente outra busca.') : i18nText('Crie o primeiro texto para usar no atendimento.')}</p></div>`}</div><p class="form-error" role="alert">${e(translateError(formError))}</p></section>`;
  }
  function editor(item = {}, { busy = false, error: formError = '' } = {}) {
    return i18nHtml`<form class="quick-reply-editor" data-reply-form="editor" aria-busy="${busy}"><input type="hidden" name="id" value="${e(item.id || '')}"/><input type="hidden" name="version" value="${e(item.version || '')}"/><div class="quick-reply-editor-fields"><label for="quick-reply-shortcut">Atalho<div class="quick-reply-shortcut-field"><span aria-hidden="true">/</span><input id="quick-reply-shortcut" name="shortcut" value="${e(String(item.shortcut || '').replace(/^\//, ''))}" required minlength="2" maxlength="${e(limits.shortcut)}" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" autocomplete="off" aria-describedby="quick-reply-shortcut-help" ${busy ? 'disabled' : ''}/></div><small id="quick-reply-shortcut-help">De 2 a ${e(limits.shortcut)} letras, números, hífen ou sublinhado. Ex.: boas-vindas.</small></label><label for="quick-reply-title">Título<input id="quick-reply-title" name="title" value="${e(item.title || '')}" required maxlength="${e(limits.title)}" placeholder="Boas-vindas" ${busy ? 'disabled' : ''}/></label><label for="quick-reply-text">Mensagem<textarea id="quick-reply-text" name="text" required maxlength="${e(limits.text)}" rows="6" aria-describedby="quick-reply-text-help" placeholder="Olá! Como podemos ajudar?" ${busy ? 'disabled' : ''}>${e(item.text || '')}</textarea><small id="quick-reply-text-help">Até ${Number(limits.text).toLocaleString(getLocale())} caracteres. A equipe pode ajustar o texto antes de enviar.</small></label></div><div class="quick-reply-preview" aria-label="Prévia da resposta"><span class="reply-quote-kicker">Prévia para revisão</span><div data-reply-preview>${preview(item.text)}</div></div><p class="form-error" role="alert">${e(translateError(formError))}</p><div class="modal-actions"><button type="button" class="button" data-reply-action="manage" ${busy ? 'disabled' : ''}>Voltar</button><button type="submit" class="button primary" ${busy ? 'disabled' : ''}>${icon('check')} ${busy ? i18nText('Salvando…') : i18nText('Salvar resposta')}</button></div></form>`;
  }
  function preview(text) { return String(text || '').trim() ? `<p>${e(text)}</p>` : i18nMarkup('<p class="quick-reply-preview-empty">O texto da resposta aparecerá aqui.</p>'); }
  function updatePreview(form) {
    const textarea = form?.querySelector('[name="text"]'), target = form?.querySelector('[data-reply-preview]');
    if (target) target.innerHTML = preview(textarea?.value || '');
  }
  function readEditor(form) {
    return readQuickReplyForm(form);
  }
  function insert(item, textarea) {
    const fail = message => { error = message; status = ''; notify(); return { ok: false, error: message }; };
    if (!context || !textarea || textarea.disabled || textarea.readOnly) return fail(i18nText('Assuma uma conversa disponível para inserir a resposta.'));
    if (!item || item.active !== true || typeof item.text !== 'string' || !item.text.trim()) return fail(i18nText('Esta resposta está desativada ou indisponível. Atualize o catálogo.'));
    const current = String(textarea.value || ''), maximum = Number(textarea.maxLength) >= 0 ? Number(textarea.maxLength) : limits.text;
    if (current.length + item.text.length > maximum) return fail(i18nTemplate`Esta resposta ultrapassa o limite de ${maximum.toLocaleString(getLocale())} caracteres do campo. Seu rascunho foi preservado.`);
    const start = Number.isInteger(textarea.selectionStart) ? Math.max(0, Math.min(current.length, textarea.selectionStart)) : current.length;
    // Insert at the cursor; an existing selection is also preserved rather than overwritten.
    textarea.value = current.slice(0, start) + item.text + current.slice(start);
    const cursor = start + item.text.length;
    textarea.focus?.(); textarea.setSelectionRange?.(cursor, cursor);
    error = ''; status = i18nText('Resposta inserida no rascunho. Revise antes de enviar.');
    textarea.dispatchEvent?.(new Event('input', { bubbles: true }));
    notify();
    return { ok: true, value: textarea.value, cursor, inserted: item.text.length };
  }
  function jumpToMessage(id) {
    if (!messages.has(String(id)) || typeof document === 'undefined') return false;
    const target = [...(document.querySelector('#messages')?.querySelectorAll('[data-message-id]') || [])].find(node => node.dataset.messageId === String(id));
    if (!target) return false;
    const focusTarget = target.querySelector('.message') || target;
    focusTarget.setAttribute('tabindex', '-1'); focusTarget.focus({ preventScroll: true });
    focusTarget.scrollIntoView({ block: 'center', behavior: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.classList.add('reply-jump-target');
    focusTarget.addEventListener('blur', () => target.classList.remove('reply-jump-target'), { once: true });
    return true;
  }
  function handleAction(target, { canReply = true, textarea, items = [] } = {}) {
    if (target?.disabled) return false;
    const action = target?.dataset?.replyAction;
    if (action === 'jump') return jumpToMessage(target.dataset.id);
    if (!canReply) return false;
    if (action === 'quote') return selectQuote(target.dataset.id);
    if (action === 'clear') { clearQuote(); return true; }
    if (action === 'insert') return insert(items.find(item => String(item.id) === String(target.dataset.id)), textarea);
    return false;
  }
  return {
    reset, syncContext, retainConversations, selectQuote, clearQuote, clearSent() { clearQuote({ silent: true }); },
    quoteComposer, updateQuoteComposer, messageQuote, messageReplyButton, quickButton,
    filterItems, pickerItems, picker, manager, editor, readEditor, updatePreview, insert, jumpToMessage, handleAction,
    get replyToMessageId() { return quoteId || null; }, get error() { return error; }, get status() { return status; }, get draftCount() { return drafts.size; }
  };
}
