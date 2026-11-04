import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy} from './i18n.js';
import './locales-operations.js';

import { channelCapabilities, validateAttachmentSelection } from './channel-capabilities.js';
const MAX_BYTES = 16 * 1024 * 1024;
const CACHE_LIMIT = 4;
// Downloaded previews (blob URLs) kept in RAM, and how many of the newest load when a conversation opens; the others
// load when they scroll into view (IntersectionObserver), so a conversation shows its photos without a click.
const PREVIEW_CACHE_LIMIT = 40, PREVIEW_ON_OPEN = 12;
const DRAFT_LIMIT = 200;
const MEDIA_NAMES = i18nLabels({ image: 'Foto', audio: 'Áudio', video: 'Vídeo', document: 'Arquivo' });
const PREVIEW_MIMES = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime'])
};

export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return i18nText('Tamanho não informado');
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toLocaleString(getLocale(), { maximumFractionDigits: 1 })} KB` : `${(value / (1024 * 1024)).toLocaleString(getLocale(), { maximumFractionDigits: 1 })} MB`;
}

function previewType(mime) {
  const normalized = String(mime || '').toLowerCase().split(';')[0].trim();
  return Object.keys(PREVIEW_MIMES).find(type => PREVIEW_MIMES[type].has(normalized)) || 'document';
}

export function createMediaUI({ escape, icon, download, getCapabilities = () => channelCapabilities({transport:'telegram-bot'}), getPendingSend = () => false, previewCacheLimit = PREVIEW_CACHE_LIMIT, previewOnOpen = PREVIEW_ON_OPEN }) {
  let lazy = null, lazyObserver = null;
  let context = '', scope = '', selected = null, draft = '', error = '', sending = false, status = '', audioCaptionAllowed = true;
  let viewer = null;
  const cache = new Map(), drafts = new Map(), allowedConversations = new Map(), boundPlayers = new WeakSet(), boundRates = new WeakSet();
  const revoke = entry => { entry?.controller?.abort(); if (entry?.url) URL.revokeObjectURL(entry.url); };
  const pendingSend = () => Boolean(context && getPendingSend());
  const contextKey = () => context ? JSON.stringify([...JSON.parse(scope), ...JSON.parse(context).slice(1)]) : '';
  function discardSelection(entry) { revoke(entry); if (entry) { entry.url = null; entry.uploadedId = null; delete entry.kind; } }
  function pendingError() { error = i18nText('Confira o envio pendente antes de alterar o rascunho ou trocar de atendimento.'); }
  const cards = id => typeof document === 'undefined' ? [] : [...document.querySelectorAll('.message-attachment[data-attachment-id]')].filter(card => card.dataset.attachmentId === id);
  function stopPlayers(root) {
    for (const player of root?.querySelectorAll('audio,video') || []) { player.pause(); player.removeAttribute('src'); player.load(); }
  }

  function closeViewer() {
    if (!viewer) return;
    const current = viewer; viewer = null;
    const video = current.dialog.querySelector('video');
    if (video && current.inlinePlayer?.isConnected && Number.isFinite(video.currentTime)) {
      current.inlinePlayer.currentTime = video.currentTime;
      current.inlinePlayer.playbackRate = video.playbackRate;
    }
    stopPlayers(current.dialog);
    if (current.dialog.open) current.dialog.close();
    current.dialog.remove();
    if (current.origin?.isConnected) current.origin.focus();
  }

  function releaseContext() {
    closeViewer();
    if (typeof document !== 'undefined') { stopPlayers(document.querySelector('#messages')); stopPlayers(document.querySelector('#attachment-selection')); }
    revoke(selected); if (selected) selected.url = null;
    selected = null; draft = ''; error = ''; status = ''; sending = false;
    for (const entry of cache.values()) revoke(entry);
    cache.clear();
  }

  function reset() {
    const current = selected;
    releaseContext(); discardSelection(current);
    for (const saved of drafts.values()) discardSelection(saved.selected);
    drafts.clear(); allowedConversations.clear(); context = ''; scope = '';
  }

  function syncContext(next = {}, currentText) {
    const nextScope = typeof next.userId === 'string' && next.userId && typeof next.workspaceId === 'string' && next.workspaceId && typeof next.authorityKey === 'string' && next.authorityKey ? JSON.stringify([next.userId, next.workspaceId, next.authorityKey]) : '';
    // An old text area and upload receipt must never cross an identity or authority boundary.
    if (!nextScope) { reset(); return true; }
    if (scope && nextScope !== scope) reset();
    const allowed = allowedConversations.get(next.tenantId);
    const nextContext = next.active && typeof next.tenantId === 'string' && next.tenantId && typeof next.conversationId === 'string' && next.conversationId && (!allowed || allowed.has(next.conversationId)) ? JSON.stringify([next.workspaceId, next.tenantId, next.conversationId]) : '';
    if (nextContext !== context) {
      if (pendingSend()) { pendingError(); if (typeof document !== 'undefined') updateComposer(); return false; }
      if (context) {
        const text = currentText === undefined ? draft : currentText;
        if ((text || selected) && !drafts.has(context) && drafts.size >= DRAFT_LIMIT) {
          error = i18nText('Há 200 rascunhos guardados neste workspace. Envie ou limpe um rascunho antes de trocar de conversa.');
          if (typeof document !== 'undefined') updateComposer();
          return false;
        }
        // The upload receipt stays with this exact company's conversation, for an exact retry.
        if (text || selected) drafts.set(context, { text, selected }); else drafts.delete(context);
      }
      releaseContext(); context = nextContext;
      const saved = drafts.get(context);
      if (saved) {
        draft = saved.text; selected = saved.selected;
        if (selected && previewType(selected.file.type) !== 'document') selected.url = URL.createObjectURL(selected.file);
      }
    } else if (context && currentText !== undefined && !pendingSend()) draft = currentText;
    scope = nextScope;
    return true;
  }

  function previewMarkup(type, url, filename, local = false, id = '') {
    const reference = local ? 'data-media-local="true"' : `data-id="${escape(id)}"`;
    if (type === 'image') return i18nHtml`<button type="button" class="attachment-image-button" data-media-action="open" ${reference} aria-label="Ampliar foto: ${escape(filename)}"><img class="attachment-image" src="${escape(url)}" alt="${escape(local ? i18nText('Prévia de ') + filename : filename)}" loading="lazy"/><span class="attachment-image-hint" aria-hidden="true">Ampliar foto ↗</span></button>`;
    if (type === 'audio') return i18nHtml`<div class="attachment-audio-player"><audio class="attachment-audio" src="${escape(url)}" controls preload="metadata" aria-label="Ouvir ${escape(filename)}"></audio><div class="attachment-rate" role="group" aria-label="Velocidade de reprodução">${[1, 1.5, 2].map(rate => i18nHtml`<button type="button" data-media-rate="${rate}" aria-pressed="${rate === 1}" aria-label="Reproduzir a ${rate.toLocaleString(getLocale())} vezes">${rate.toLocaleString(getLocale())}×</button>`).join('')}</div></div>`;
    if (type === 'video') return i18nHtml`<div class="attachment-video-player"><video class="attachment-video" src="${escape(url)}" controls preload="metadata" playsinline aria-label="Reproduzir ${escape(filename)}"></video><button type="button" class="text-button attachment-expand" data-media-action="open" ${reference}>Ampliar vídeo ↗</button></div>`;
    return `<span class="attachment-document-icon" aria-hidden="true">${icon('document')}</span>`;
  }

  function selectedMarkup(disabled) {
    if (!selected) return '';
    const type = previewType(selected.file.type);
    const note = !getCapabilities().captionMaxLength ? i18nText('Envie o arquivo sem legenda nesta conexão.') : type === 'audio' && !audioCaptionAllowed ? i18nText('Áudio no WhatsApp é enviado sem legenda. Remova o texto ou envie-o em outra mensagem.') : i18nText('Legenda opcional, até 1.024 caracteres. Um arquivo por envio.');
    return i18nHtml`<div class="attachment-selection ${type === 'audio' ? 'audio-selection' : ''}" role="group" aria-label="Arquivo selecionado"><div class="attachment-selection-preview">${previewMarkup(type, selected.url, selected.file.name, true)}</div><div class="attachment-selection-info"><strong>${escape(selected.file.name)}</strong><span>${formatFileSize(selected.file.size)} · ${MEDIA_NAMES[type]}</span><small id="attachment-caption-note">${note}</small></div><button type="button" class="icon-button" data-media-action="remove" aria-label="Remover arquivo selecionado" ${disabled || sending || pendingSend() ? 'disabled' : ''}>${icon('close')}</button></div>`;
  }

  function composer(disabled = false, options = {}) {
    audioCaptionAllowed = options.audioCaptionAllowed !== false;
    const mimes=getCapabilities().uploadMimes;
    return i18nHtml`<input id="message-file" class="sr-only" type="file" tabindex="-1" aria-label="Escolher arquivo para enviar" ${Array.isArray(mimes)&&mimes.length?`accept="${escape(mimes.join(','))}"`:''} ${disabled || sending || pendingSend() ? 'disabled' : ''}/><div id="attachment-selection" data-selection-key="${escape(selectionKey())}">${selectedMarkup(disabled)}</div><div id="message-media-error" class="form-error message-media-error" role="alert">${escape(translateError(error))}</div><span id="message-media-status" class="media-status" role="status" aria-live="polite">${escape(translateCopy(status))}</span>`;
  }

  function selectionKey() { return selected ? JSON.stringify([selected.url, selected.file.name, selected.file.size, selected.file.type, audioCaptionAllowed]) : ''; }

  function fileButton(disabled = false) {
    return i18nHtml`<button type="button" class="text-button attach-file-button" data-media-action="choose" aria-label="Anexar" title="Anexar" aria-describedby="attachment-limit" ${disabled || sending || pendingSend() ? 'disabled' : ''}>${icon('paperclip')}<span class="pg-inbox__tool-label">Anexar</span><span id="attachment-limit" class="sr-only">Um arquivo por envio, até 16 MB.</span></button>`;
  }

  function attachmentMarkup(attachment) {
      const filename = String(attachment.name || i18nText('Arquivo'));
      const id = String(attachment.id || '');
      const ready = attachment.status === 'ready' && id;
      const entry = cache.get(id);
      const type = attachment.preview ? previewType(attachment.mime) : 'document';
      const hasPreview = ready && entry?.url && entry.previewType === type && type !== 'document';
      const historical = !ready && attachment.reason === 'historical_not_downloaded';
      const reason = historical ? i18nText('O histórico trouxe a referência deste arquivo, mas não seu conteúdo. Não há uma cópia disponível na Elozi para exibir ou baixar.') : attachment.status === 'pending' ? i18nText('O arquivo ainda está sendo preparado.') : attachment.reason === 'too_large' ? i18nText('Este arquivo ultrapassa o limite de 16 MB desta versão.') : attachment.reason === 'expired' ? i18nText('O arquivo expirou no canal de origem e não pôde ser recuperado.') : i18nText('Este arquivo não está disponível para download.');
      const state = !ready ? historical ? i18nText('Arquivo do histórico · conteúdo não importado') : attachment.status === 'pending' ? i18nText('Preparando arquivo') : i18nText('Indisponível') : entry?.loading ? i18nText('Carregando arquivo…') : entry?.error ? i18nText('Falha ao carregar') : hasPreview ? { image: i18nText('Clique na foto para ampliar'), audio: i18nText('Pronto para ouvir'), video: i18nText('Pronto para reproduzir') }[type] : entry?.url && type !== 'document' ? i18nText('Prévia indisponível neste formato') : type === 'document' ? i18nText('Disponível para baixar') : i18nText('Prévia disponível');
      return `<div class="message-attachment attachment-${type} ${ready ? '' : 'unavailable'}" data-attachment-id="${escape(id)}" aria-busy="${Boolean(entry?.loading)}"><div class="attachment-content">${hasPreview ? previewMarkup(type, entry.url, filename, false, id) : `<div class="attachment-placeholder"><span class="attachment-document-icon" aria-hidden="true">${icon(ready ? type === 'audio' ? 'activity' : type === 'video' ? 'code' : 'document' : 'shield')}</span><span>${MEDIA_NAMES[type]}</span></div>`}</div><div class="attachment-heading"><span class="attachment-kicker">${MEDIA_NAMES[type]}</span><strong>${escape(filename)}</strong><span>${formatFileSize(attachment.size)}</span></div><p class="attachment-state" role="status">${state}</p>${ready ? i18nHtml`<div class="attachment-actions">${type !== 'document' && !entry?.url ? `<button type="button" class="text-button" data-media-action="preview" data-id="${escape(id)}" ${entry?.loading ? 'disabled' : ''}>${entry?.loading ? i18nText('Carregando…') : entry?.error ? i18nText('Tentar novamente') : i18nText('Carregar ') + { image: i18nText('foto'), audio: i18nText('áudio'), video: i18nText('vídeo') }[type]}</button>` : ''}<button type="button" class="text-button" data-media-action="download" data-id="${escape(id)}" ${entry?.loading ? 'disabled' : ''}>${icon('download')} Baixar</button></div><p class="attachment-error" data-player-error role="alert">${escape(entry?.error || entry?.playbackError || '')}</p>` : `<p class="attachment-unavailable">${escape(reason)}</p>`}</div>`;
  }

  function messageAttachments(message) {
    return (Array.isArray(message.attachments) ? message.attachments : []).map(attachmentMarkup).join('');
  }

  function updateAttachment(attachment, renderMessages) {
    const elements = cards(String(attachment.id));
    for (const card of elements) {
      const entry = cache.get(String(attachment.id));
      // A cached download must not replace a playing audio or video element.
      if (entry?.url && card.querySelector('audio,video,img')?.getAttribute('src') === entry.url) continue;
      stopPlayers(card);
      card.outerHTML = attachmentMarkup(attachment);
    }
    if (typeof document !== 'undefined') bindPlayers();
  }

  function updateComposer(disabled = false) {
    const form = document.querySelector('#message-form');
    if (!form) return;
    form.setAttribute('aria-busy', String(sending));
    const pending = pendingSend();
    for (const control of form.querySelectorAll('button,input,textarea')) control.disabled = disabled || sending || pending;
    // A readonly textarea still participates in FormData for an exact retry.
    const text = form.querySelector('#message-text');
    if (text) { text.readOnly = pending; text.disabled = disabled || sending; }
    if (pending) {
      for (const control of form.querySelectorAll('[type="submit"],[data-action="verify-send"]')) control.disabled = disabled || sending;
      // Discarding a local draft never sends to the channel, even after its reply window closes.
      for (const control of form.querySelectorAll('[data-action="discard-send"]')) control.disabled = sending;
    }
    if (form.dataset.mediaEnabled !== 'true') for (const control of form.querySelectorAll('#message-file,[data-media-action]')) control.disabled = true;
    if (getCapabilities().voice !== true) for (const control of form.querySelectorAll('[data-voice-action]')) control.disabled = true;
    const capabilities = getCapabilities();
    if (!capabilities.uploadKinds.length) for (const control of form.querySelectorAll('#message-file,[data-media-action="choose"]')) control.disabled = true;
    const textBlocked = !selected && capabilities.textSupported === false;
    let selectionError = '';
    if (selected) try { validateAttachmentSelection(selected.file, capabilities, { voice: selected.voice === true }); } catch (failure) { selectionError = translateError(failure.message); }
    if (textBlocked) for (const control of form.querySelectorAll('#message-text,[data-reply-action="open"],[data-action="composer-emoji"]')) control.disabled = true;
    if (textBlocked || selectionError) for (const control of form.querySelectorAll('[type="submit"]')) control.disabled = true;
    const agentButton = form.querySelector('[data-action="run-agent"]');
    if (agentButton?.dataset.unconfigured === 'true') agentButton.disabled = true;
    const selection = form.querySelector('#attachment-selection'), key = selectionKey();
    if (selection.dataset.selectionKey !== key) { stopPlayers(selection); selection.innerHTML = selectedMarkup(disabled); selection.dataset.selectionKey = key; }
    form.querySelector('#message-media-error').textContent = selectionError || error;
    form.querySelector('#message-media-status').textContent = status;
    bindPlayers(form);
  }

  function choose(file, text = draft) {
    if (sending || !context) return;
    if (pendingSend()) { pendingError(); return; }
    draft = text; error = '';
    if (!file) return;
    try { validateAttachmentSelection(file,getCapabilities()); } catch(failure) { error=translateError(failure.message); return; }
    const otherFiles = [...drafts.entries()].filter(([key, value]) => key !== context && value.selected);
    if (otherFiles.length >= CACHE_LIMIT || otherFiles.reduce((sum, [, value]) => sum + value.selected.file.size, 0) + file.size > CACHE_LIMIT * MAX_BYTES) { error = i18nText('Há quatro arquivos guardados em outras conversas. Envie ou remova um deles antes de anexar outro.'); return; }
    if (viewer?.local) closeViewer();
    if (typeof document !== 'undefined') stopPlayers(document.querySelector('#attachment-selection'));
    revoke(selected);
    selected = { file, url: previewType(file.type) !== 'document' ? URL.createObjectURL(file) : null, uploadedId: null };
  }

  function remove() { if (sending) return; if (pendingSend()) { pendingError(); return; } if (viewer?.local) closeViewer(); revoke(selected); selected = null; error = ''; status = ''; }

  function retainConversations(ids = [], tenantId = context ? JSON.parse(context)[1] : '') {
    if (typeof tenantId !== 'string' || !tenantId) return true;
    const allowed = new Set([...ids].map(String));
    allowedConversations.set(tenantId, allowed);
    for (const [key, saved] of drafts) {
      const [, owner, id] = JSON.parse(key);
      if (owner === tenantId && !allowed.has(id)) { discardSelection(saved.selected); drafts.delete(key); }
    }
    if (context) {
      const [, owner, id] = JSON.parse(context);
      if (owner === tenantId && !allowed.has(id)) { const current = selected; releaseContext(); discardSelection(current); context = ''; return false; }
    }
    return true;
  }

  function forgetTenant(tenantId) { return retainConversations([], tenantId); }

  function protectedIds() {
    const ids = new Set();
    if (viewer?.id) ids.add(viewer.id);
    if (typeof document !== 'undefined') for (const player of document.querySelectorAll('.message-attachment audio,.message-attachment video')) {
      const id = player.closest('.message-attachment')?.dataset.attachmentId;
      if (id && !player.paused && cache.has(id)) ids.add(id);
    }
    return ids;
  }

  function trimCache(keepId) {
    const protectedEntries = protectedIds();
    while (cache.size > previewCacheLimit) {
      const oldest = [...cache.keys()].find(key => key !== keepId && !protectedEntries.has(key)) || [...cache.keys()].find(key => key !== keepId);
      if (viewer?.id === oldest) closeViewer();
      const entry = cache.get(oldest);
      for (const card of cards(oldest)) stopPlayers(card);
      revoke(entry); cache.delete(oldest);
      if (entry.attachment) updateAttachment(entry.attachment);
    }
  }

  async function loadAttachment(attachment, path) {
    const id = String(attachment.id), prior = cache.get(id);
    if (prior?.url) { cache.delete(id); cache.set(id, prior); return prior; }
    if (prior?.promise) return prior.promise;
    const requestContext = context;
    const entry = { loading: true, attachment, controller: new AbortController() };
    cache.set(id, entry);
    trimCache(id);
    entry.promise = (async () => {
      try {
        const blob = await download(path, entry.controller.signal);
        if (!blob.size) throw new Error(i18nText('O arquivo recebido está vazio. Tente novamente.'));
        if (blob.size > MAX_BYTES) throw new Error(i18nText('Este arquivo ultrapassa o limite de download desta versão.'));
        if (context !== requestContext || cache.get(id) !== entry) return null;
        // Only our authenticated binary endpoint can create these preview URLs.
        entry.previewType = attachment.preview && previewType(blob.type) === previewType(attachment.mime) ? previewType(blob.type) : 'document';
        entry.url = URL.createObjectURL(blob); entry.loading = false;
        if (attachment.preview && previewType(attachment.mime) !== 'document' && entry.previewType === 'document') entry.playbackError = i18nText('O formato recebido não permite prévia. Baixe o arquivo para abrir.');
        return entry;
      } catch (caught) {
        if (context !== requestContext || cache.get(id) !== entry || caught.name === 'AbortError') return null;
        entry.loading = false; entry.error = translateError(caught.message) || i18nText('Não foi possível carregar o arquivo. Tente novamente.');
        throw caught;
      } finally { delete entry.promise; }
    })();
    return entry.promise;
  }

  function downloadFile(url, filename) {
    const link = document.createElement('a'); link.href = url; link.download = filename || i18nText('arquivo'); link.hidden = true;
    document.body.append(link); link.click(); link.remove();
  }

  function openViewer({ type, url, filename, id = '', local = false, origin }) {
    if (!['image', 'video'].includes(type) || typeof document === 'undefined') return;
    closeViewer();
    const dialog = document.createElement('dialog'); dialog.className = 'media-viewer'; dialog.setAttribute('aria-labelledby', 'media-viewer-title');
    const inlinePlayer = origin?.closest('.message-attachment, .attachment-selection')?.querySelector('video');
    const initialTime = inlinePlayer?.currentTime || 0, initialRate = inlinePlayer?.playbackRate || 1;
    inlinePlayer?.pause();
    dialog.innerHTML = i18nHtml`<div class="media-viewer-heading"><div><span class="attachment-kicker">${MEDIA_NAMES[type]}</span><h2 id="media-viewer-title">${escape(filename)}</h2></div><button type="button" class="icon-button" data-viewer-close autofocus aria-label="Fechar visualização">${icon('close')}</button></div><div class="media-viewer-stage">${type === 'image' ? `<img src="${escape(url)}" alt="${escape(filename)}"/>` : i18nHtml`<video src="${escape(url)}" controls playsinline preload="metadata" aria-label="Reproduzir ${escape(filename)}"></video>`}</div><div class="media-viewer-toolbar">${type === 'image' ? i18nMarkup('<div class="media-viewer-zoom" role="group" aria-label="Zoom da foto"><button type="button" data-viewer-zoom="out" aria-label="Diminuir zoom">−</button><button type="button" data-viewer-zoom="reset" aria-label="Restaurar zoom">100%</button><button type="button" data-viewer-zoom="in" aria-label="Aumentar zoom">+</button></div>') : i18nMarkup('<span class="media-viewer-help">Use os controles para reproduzir o vídeo.</span>')}<button type="button" class="text-button" data-viewer-download>${icon('download')} Baixar ${type === 'image' ? i18nText('foto') : i18nText('vídeo')}</button></div><p class="media-viewer-error" role="alert"></p>`;
    viewer = { dialog, id, local, origin, inlinePlayer };
    let scale = 1;
    dialog.addEventListener('click', event => {
      event.stopPropagation();
      const button = event.target.closest('button');
      if (event.target === dialog || button?.hasAttribute('data-viewer-close')) { closeViewer(); return; }
      if (button?.hasAttribute('data-viewer-download')) downloadFile(url, filename);
      if (button?.dataset.viewerZoom) {
        scale = button.dataset.viewerZoom === 'reset' ? 1 : Math.min(3, Math.max(1, scale + (button.dataset.viewerZoom === 'in' ? 0.5 : -0.5)));
        const stage = dialog.querySelector('.media-viewer-stage'), image = stage.querySelector('img');
        image.style.width = `${scale * 100}%`; image.style.maxWidth = scale === 1 ? '100%' : 'none'; image.style.maxHeight = scale === 1 ? '' : 'none';
        dialog.querySelector('[data-viewer-zoom="reset"]').textContent = `${scale * 100}%`;
        stage.classList.toggle('is-zoomed', scale > 1);
      }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
    dialog.addEventListener('close', () => { if (viewer?.dialog === dialog) closeViewer(); });
    const media = dialog.querySelector('img,video');
    media.addEventListener('error', () => { dialog.querySelector('.media-viewer-error').textContent = type === 'image' ? i18nText('Não foi possível exibir esta foto. Você ainda pode baixar o arquivo.') : i18nText('Este navegador não conseguiu reproduzir o vídeo. Baixe o arquivo para abrir.'); });
    if (type === 'video') media.addEventListener('loadedmetadata', () => { media.currentTime = initialTime; media.playbackRate = initialRate; }, { once: true });
    document.body.append(dialog); dialog.showModal();
  }

  function bindPlayers(root = document) {
    observeLazy(root === document ? null : root);
    for (const player of root.querySelectorAll('.attachment-audio,.attachment-video,.attachment-image')) {
      if (boundPlayers.has(player)) continue;
      boundPlayers.add(player);
      const card = player.closest('.message-attachment');
      player.addEventListener('error', () => {
        const text = player.tagName === 'IMG' ? i18nText('Não foi possível exibir a foto. Baixe o arquivo para abrir.') : i18nText('Este navegador não conseguiu reproduzir o arquivo. Baixe para abrir em outro aplicativo.');
        const entry = cache.get(card?.dataset.attachmentId);
        if (entry) entry.playbackError = text;
        const output = card?.querySelector('[data-player-error]'); if (output) output.textContent = text;
      });
      if (player.tagName === 'IMG') continue;
      player.addEventListener('play', () => {
        for (const other of document.querySelectorAll('.attachment-audio,.attachment-video')) if (other !== player && !other.paused) other.pause();
      });
      player.addEventListener('ratechange', () => {
        for (const button of player.closest('.attachment-audio-player')?.querySelectorAll('[data-media-rate]') || []) button.setAttribute('aria-pressed', String(Number(button.dataset.mediaRate) === player.playbackRate));
      });
    }
    for (const button of root.querySelectorAll('[data-media-rate]')) {
      if (boundRates.has(button)) continue;
      boundRates.add(button);
      button.addEventListener('click', event => {
        event.stopPropagation();
        const rate = Number(button.dataset.mediaRate), player = button.closest('.attachment-audio-player')?.querySelector('audio');
        if (player && [1, 1.5, 2].includes(rate)) player.playbackRate = rate;
      });
    }
  }

  async function hydrate(conversation, base, renderMessages) {
    if (!context || !conversation) return;
    const requestContext = context;
    lazy = { context, base, renderMessages, attachments: new Map((conversation.messages || []).flatMap(message => message.attachments || []).filter(attachment => attachment.id && attachment.status === 'ready' && attachment.preview && previewType(attachment.mime) !== 'document').map(attachment => [String(attachment.id), attachment])) };
    const protectedEntries = protectedIds();
    const candidates = [...new Map((conversation.messages || []).flatMap(message => message.attachments || []).filter(attachment => attachment.id && attachment.status === 'ready' && attachment.preview && previewType(attachment.mime) !== 'document').map(attachment => [String(attachment.id), attachment])).values()];
    const slots = Math.max(0, Math.min(previewOnOpen, previewCacheLimit - protectedEntries.size));
    const latest = slots ? candidates.filter(item => !protectedEntries.has(String(item.id))).slice(-slots) : [];
    await Promise.allSettled(latest.map(async attachment => {
      const existing = cache.get(String(attachment.id));
      // Failed automatic previews retry only after an explicit user action.
      if (existing?.error || existing?.url) return;
      const pending = loadAttachment(attachment, `${base}/attachments/${encodeURIComponent(attachment.id)}`);
      updateAttachment(attachment, renderMessages);
      try { await pending; }
      finally { if (context === requestContext) updateAttachment(attachment, renderMessages); }
    }));
    if (typeof document !== 'undefined' && context === requestContext) bindPlayers();
  }

  // Older previews of the open conversation load as their card scrolls into view (200 px ahead), one download each.
  function observeLazy(root) {
    if (!lazy || typeof IntersectionObserver !== 'function' || typeof document === 'undefined') return;
    const timeline = document.querySelector('#messages');
    if (!timeline) return;
    if (!lazyObserver || lazyObserver.root !== timeline) {
      lazyObserver?.disconnect();
      lazyObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          lazyObserver.unobserve(entry.target);
          const job = lazy, id = entry.target.dataset?.attachmentId, attachment = id && job?.attachments.get(id), existing = id && cache.get(id);
          if (!job || !attachment || job.context !== context || existing?.url || existing?.promise || existing?.error) continue;
          const pending = loadAttachment(attachment, `${job.base}/attachments/${encodeURIComponent(attachment.id)}`);
          updateAttachment(attachment, job.renderMessages);
          // loadAttachment keeps the error on the card for an explicit retry; observer jobs have no caller to catch it.
          pending.catch(() => {}).finally(() => { if (job.context === context) { updateAttachment(attachment, job.renderMessages); bindPlayers(); } });
        }
      }, { root: timeline, rootMargin: '200px 0px' });
    }
    for (const card of (root || timeline).querySelectorAll?.('.message-attachment[data-attachment-id]') || []) {
      const id = card.dataset.attachmentId, entry = cache.get(id);
      if (lazy.attachments.has(id) && !entry?.url && !entry?.promise && !entry?.error) lazyObserver.observe(card);
    }
  }

  async function handleAction(element, { conversation, base, canReply, renderMessages }) {
    const action = element.dataset.mediaAction;
    if (action === 'choose') { if (canReply && !sending && !pendingSend()) document.querySelector('#message-file')?.click(); return; }
    if (action === 'remove') { if (canReply) { remove(); updateComposer(false); document.querySelector('#message-text')?.focus(); } return; }
    if (action === 'open' && element.dataset.mediaLocal === 'true') {
      if (selected?.url) openViewer({ type: previewType(selected.file.type), url: selected.url, filename: selected.file.name, local: true, origin: element });
      return;
    }
    if (!['preview', 'download', 'open'].includes(action) || !context) return;
    const attachment = (conversation?.messages || []).flatMap(message => message.attachments || []).find(item => String(item.id) === element.dataset.id);
    if (!attachment || attachment.status !== 'ready') throw new Error(i18nText('Este arquivo não está disponível.'));
    const requestContext = context;
    const pending = loadAttachment(attachment, `${base}/attachments/${encodeURIComponent(attachment.id)}`);
    updateAttachment(attachment, renderMessages);
    try {
      const entry = await pending;
      if (!entry || requestContext !== context || cache.get(String(attachment.id)) !== entry) return;
      if (action === 'download') {
        downloadFile(entry.url, attachment.name);
      }
      if (action === 'open') openViewer({ type: entry.previewType, url: entry.url, filename: attachment.name || i18nText('Arquivo'), id: String(attachment.id), origin: element });
    } finally { if (requestContext === context) updateAttachment(attachment, renderMessages); }
  }

  return {
    composer, fileButton, messageAttachments, handleAction, syncContext, reset, choose, updateComposer, hydrate, bindPlayers, closeViewer, retainConversations, forgetTenant,
    get contextKey() { return contextKey(); },
    get draft() { return draft; }, set draft(text) { draft = text; },
    get selected() { return selected; }, get sending() { return sending; },
    startSending(text) { draft = text; error = ''; sending = true; status = selected ? i18nText('Preparando o arquivo…') : i18nText('Enviando a resposta…'); updateComposer(); },
    finishSending(disabled) { sending = false; status = ''; updateComposer(disabled); },
    fail(message) { error = message; },
    clearSent() { if (viewer?.local) closeViewer(); revoke(selected); selected = null; draft = ''; error = ''; status = ''; drafts.delete(context); },
    uploaded(attachment) { if (selected) { selected.uploadedId = attachment.id; selected.kind = attachment.kind; } status = i18nText('Enviando arquivo e mensagem…'); },
    resetUploaded() { if (selected) selected.uploadedId = null; }
  };
}
