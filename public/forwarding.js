import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

export const FORWARD_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const TRANSPORTS = new Set(['baileys', 'telegram-bot']);
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/webm', 'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf', 'application/zip', 'application/octet-stream', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const string = value => String(value ?? '');
const mimeType = value => string(value).split(';')[0].trim().toLowerCase();
function reject(message, code = 'unavailable', status = 409) { throw Object.assign(new Error(message), { code, status }); }
function inScope(record, context) {
  return record && ['workspaceId', 'tenantId'].every(key => record[key] == null || string(record[key]) === string(context[key]))
    && (record.resellerId == null || string(record.resellerId) === string(context.workspaceId));
}
function channelFor(conversation, context) { return context.channels?.find(channel => string(channel.id) === string(conversation.channelId)); }
function ownConversation(conversation, context) {
  return inScope(conversation, context) && conversation.id && conversation.channelId && conversation.status !== 'closed'
    && conversation.owner === 'human' && string(conversation.assignedUserId) === string(context.userId) && conversation.canReply !== false;
}

export function forwardingContextKey(context = {}) {
  return context.active === true && context.canReply === true && context.workspaceId && context.tenantId && context.userId && context.conversationId
    && (!Array.isArray(context.permissions) || context.permissions.includes('inbox.reply'))
    ? JSON.stringify([string(context.workspaceId), string(context.tenantId), string(context.userId), string(context.conversationId), string(context.authorityKey)]) : '';
}

export function forwardMessageContent(message, source, context = {}) {
  if (!forwardingContextKey(context) || !ownConversation(source, context) || string(source.id) !== string(context.conversationId)) reject(i18nText('Assuma a conversa de origem para encaminhar.'), 'source-authority', 403);
  if (!message?.id || !inScope(message, context) || message.conversationId != null && string(message.conversationId) !== string(source.id)
    || message.channelId != null && string(message.channelId) !== string(source.channelId)) reject(i18nText('A mensagem não está disponível nesta conversa.'), 'source-message', 404);
  if (!['customer', 'human'].includes(message.kind) || message.internal === true || message.private === true || message.draft === true
    || message.visibility === 'internal' || ['draft', 'pending', 'failed', 'unconfirmed', 'unknown'].includes(message.delivery)) reject(i18nText('Somente mensagens recebidas ou enviadas podem ser encaminhadas. Notas e rascunhos são privados.'), 'private-message', 400);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 1) reject(i18nText('Encaminhe uma mensagem com até um arquivo.'), 'attachment-count', 400);
  let attachment = null;
  if (attachments.length) {
    const original = attachments[0], mime = mimeType(original?.mime), size = Number(original?.size);
    if (!original?.id || !inScope(original, context) || original.conversationId != null && string(original.conversationId) !== string(source.id)
      || original.channelId != null && string(original.channelId) !== string(source.channelId) || original.messageId != null && string(original.messageId) !== string(message.id)) reject(i18nText('O arquivo não pertence a esta mensagem.'), 'attachment-scope', 404);
    if (original.status !== 'ready') reject(i18nText('O arquivo de origem ainda não está disponível.'), 'attachment-unavailable', 409);
    if (!Number.isSafeInteger(size) || size < 1 || size > FORWARD_MEDIA_MAX_BYTES) reject(i18nText('O arquivo precisa ter conteúdo e respeitar o limite de 16 MiB.'), 'attachment-size', 413);
    if (!MEDIA_TYPES.has(mime)) reject(i18nText('O formato deste arquivo não permite encaminhamento.'), 'attachment-type', 400);
    attachment = { id: string(original.id), messageId: string(message.id), kind: ['image', 'audio', 'video', 'document'].includes(original.kind) ? original.kind : 'document',
      name: string(original.name || i18nText('Arquivo')), mime, size, status: original.status, preview: original.preview === true, voice: original.voice === true && original.kind === 'audio' };
  }
  const text = string(typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '').trim();
  if (!text && !attachment) reject(i18nText('Esta mensagem não tem texto ou arquivo para encaminhar.'), 'empty-message', 400);
  if (text.length > (attachment ? 1024 : 4000)) reject(attachment ? i18nText('A legenda ultrapassa o limite de 1.024 caracteres.') : i18nText('O texto ultrapassa o limite de 4.000 caracteres.'), 'text-limit', 400);
  return { messageId: string(message.id), kind: message.kind, text, author: string(message.authorName || message.senderName || (message.kind === 'human' ? i18nText('Atendente') : i18nText('Contato'))), attachment };
}

export function eligibleForwardTargets(conversations, context = {}, sourceId = context.conversationId, content) {
  if (!forwardingContextKey(context)) return [];
  const seen = new Set();
  return (Array.isArray(conversations) ? conversations : []).flatMap(conversation => {
    if (!ownConversation(conversation, context) || string(conversation.id) === string(sourceId) || seen.has(string(conversation.id))) return [];
    const channel = channelFor(conversation, context);
    if (!channel || !inScope(channel, context) || !TRANSPORTS.has(channel.transport) || channel.state !== 'connected'
      || !Number.isSafeInteger(conversation.version) || conversation.version < 1 || content?.attachment?.kind === 'audio' && content.text && channel.transport === 'baileys') return [];
    seen.add(string(conversation.id));
    return [{ id: string(conversation.id), contact: string(conversation.contact || i18nText('Conversa')), channelId: string(conversation.channelId), channelName: string(channel.name || i18nText('Canal')), transport: channel.transport, version: conversation.version }];
  });
}

export function forwardingFingerprint(content) {
  const file = content.attachment;
  return JSON.stringify([content.messageId, content.kind, content.text, file ? [file.id, file.messageId, file.kind, file.name, file.mime, file.size, file.status, file.preview, file.voice] : null]);
}

export function createForwarding({ getContext = () => ({}), getConversation = () => null, getTargets = () => [],
  request, onChange = () => {} } = {}) {
  const attempts = new Map();
  let view = null, opened = false, running = null, status = '', error = '';
  function notify(event) { onChange({ event, busy: Boolean(running), opened, status, error }); }
  function captureContext() {
    const context = getContext() || {};
    if (!forwardingContextKey(context)) reject(i18nText('Seu acesso ou a conversa ativa mudou. Abra o encaminhamento novamente.'), 'context', 403);
    const basePath = `/api/tenants/${encodeURIComponent(context.tenantId)}`;
    if (context.basePath != null && context.basePath !== basePath) reject(i18nText('O destino da API não corresponde à empresa ativa.'), 'api-scope', 400);
    return { ...context, basePath };
  }
  function sourceContent(context, messageId, source = getConversation()) {
    const matches = (source?.messages || []).filter(message => string(message.id) === string(messageId));
    if (matches.length !== 1) reject(i18nText('A mensagem de origem não está mais disponível.'), 'source-message', 404);
    return forwardMessageContent(matches[0], source, context);
  }
  function guard(candidate = view, checkVersion = true) {
    if (!opened || !candidate || view !== candidate) reject(i18nText('O encaminhamento foi fechado. Confira o destino antes de tentar novamente.'), 'closed');
    const context = captureContext();
    if (forwardingContextKey(context) !== candidate.contextKey) reject(i18nText('O contexto mudou. Abra o encaminhamento novamente.'), 'context', 403);
    const source = getConversation();
    if (string(source?.channelId) !== candidate.sourceChannelId) reject(i18nText('O canal da conversa de origem mudou.'), 'source-channel');
    const content = sourceContent(context, candidate.content.messageId, source);
    if (forwardingFingerprint(content) !== candidate.fingerprint) reject(i18nText('A mensagem de origem mudou. Revise uma nova prévia.'), 'source-changed');
    const attempt = candidate.attempt;
    if (checkVersion && attempt?.freshSourceVersion && !attempt.postStarted && source.version > attempt.freshSourceVersion) reject(i18nText('A conversa de origem mudou. Atualize a prévia antes de encaminhar.'), 'source-version');
    let target;
    if (candidate.destination) {
      target = eligibleForwardTargets(getTargets(), context, source.id, content).find(item => item.id === candidate.destination.id);
      if (!target || target.channelId !== candidate.destination.channelId || target.transport !== candidate.destination.transport) reject(i18nText('Seu acesso, o responsável ou o canal do destino mudou.'), 'destination-authority', 403);
      if (checkVersion && attempt?.freshVersion && !attempt.postStarted && target.version > attempt.freshVersion) reject(i18nText('A conversa de destino mudou. Atualize a prévia antes de encaminhar.'), 'destination-version');
    }
    return { context, source, content, target };
  }
  function preview() {
    if (!opened || !view) return null;
    try { guard(view, false); } catch { return null; }
    return { source: { messageId: view.content.messageId, text: view.content.text, author: view.content.author,
      attachment: view.content.attachment ? { ...view.content.attachment } : null }, destination: view.destination ? { ...view.destination } : null,
      busy: Boolean(running), status, error, confirmed: view.attempt?.state === 'confirmed', uncertain: view.attempt?.state === 'uncertain' };
  }
  function prepare(messageId) {
    if (running) reject(i18nText('Aguarde o encaminhamento em andamento.'), 'busy');
    const context = captureContext(), source = getConversation(), content = sourceContent(context, messageId, source);
    view = { contextKey: forwardingContextKey(context), scope: { workspaceId: string(context.workspaceId), tenantId: string(context.tenantId), userId: string(context.userId),
      conversationId: string(context.conversationId), authorityKey: string(context.authorityKey), basePath: context.basePath }, sourceChannelId: string(source.channelId), content,
      fingerprint: forwardingFingerprint(content), destination: null, attempt: null };
    opened = true; status = i18nText('Escolha uma conversa de destino e confira a prévia.'); error = ''; notify('prepare'); return preview();
  }
  function targets() {
    if (!opened || !view) return [];
    try { const { context, source, content } = guard(view, false); return eligibleForwardTargets(getTargets(), context, source.id, content); } catch { return []; }
  }
  function selectTarget(id) {
    if (running) reject(i18nText('Aguarde o encaminhamento em andamento.'), 'busy');
    const { context, source, content } = guard(view, false);
    const target = eligibleForwardTargets(getTargets(), context, source.id, content).find(item => item.id === string(id));
    if (!target) reject(i18nText('Escolha outra conversa, já assumida por você e com canal conectado.'), 'destination-authority', 403);
    const signature = JSON.stringify([view.scope.workspaceId, view.scope.tenantId, view.scope.userId, view.scope.conversationId, view.sourceChannelId, view.fingerprint, target.id, target.channelId]);
    let attempt = attempts.get(signature);
    if (!attempt) {
      if (attempts.size >= 100) reject(i18nText('Há 100 encaminhamentos guardados nesta sessão. Confira os envios antes de iniciar outro.'), 'attempt-limit');
      attempt = { idempotencyKey: crypto.randomUUID(), freshSourceVersion: null, freshVersion: null, payload: null, postStarted: false, state: 'prepared', result: null };
      attempts.set(signature, attempt);
    }
    view.destination = target; view.attempt = attempt; error = '';
    status = attempt.state === 'confirmed' ? i18nText('Este encaminhamento já foi aceito. Uma nova tentativa não fará outro envio.') : attempt.state === 'uncertain'
      ? i18nText('O envio anterior não foi confirmado. Confira o destino; a tentativa usará o mesmo identificador.') : i18nText('Confira o texto, o arquivo e a conversa antes de encaminhar.');
    notify('destination'); return preview();
  }
  function close() {
    if (!opened) return false;
    opened = false; running?.controller.abort(); notify('close'); return true;
  }
  function reset() { opened = false; view = null; status = ''; error = ''; attempts.clear(); running?.controller.abort(); notify('reset'); }
  function options(candidate, controller, extra = {}) {
    return { ...extra, signal: controller.signal, headers: { 'X-Elozi-Workspace': candidate.scope.workspaceId, ...extra.headers } };
  }
  function validateFresh(tenant, candidate) {
    const { context } = guard(candidate);
    if (!tenant || string(tenant.id) !== candidate.scope.tenantId || !inScope(tenant, context) || !Array.isArray(tenant.conversations) || !Array.isArray(tenant.channels)) reject(i18nText('A atualização não pertence à empresa de origem.'), 'fresh-scope', 403);
    const source = tenant.conversations.find(item => string(item.id) === candidate.scope.conversationId);
    if (string(source?.channelId) !== candidate.sourceChannelId || forwardingFingerprint(sourceContent(context, candidate.content.messageId, source)) !== candidate.fingerprint) reject(i18nText('A mensagem de origem mudou. Atualize a prévia.'), 'source-changed');
    if (!Number.isSafeInteger(source.version) || source.version < 1) reject(i18nText('A revisão da conversa de origem não está disponível. Atualize a prévia.'), 'source-version');
    const targets = eligibleForwardTargets(tenant.conversations, { ...context, channels: tenant.channels }, source.id, candidate.content);
    const target = targets.find(item => item.id === candidate.destination.id);
    if (!target || target.channelId !== candidate.destination.channelId || target.transport !== candidate.destination.transport) reject(i18nText('A conversa de destino não está disponível com seu acesso.'), 'fresh-destination', 403);
    if (!candidate.attempt.postStarted) {
      candidate.attempt.freshSourceVersion = source.version;
      candidate.attempt.freshVersion = target.version;
    }
    guard(candidate);
    return target;
  }
  async function execute() {
    if (running) reject(i18nText('Aguarde o encaminhamento em andamento.'), 'busy');
    const candidate = view;
    guard(candidate, false);
    if (!candidate?.destination || !candidate.attempt) reject(i18nText('Escolha a conversa de destino antes de encaminhar.'), 'destination-required', 400);
    if (typeof request !== 'function') reject(i18nText('O encaminhamento não está disponível.'), 'request-unavailable', 503);
    if (candidate.attempt.state === 'blocked') reject(i18nText('Este encaminhamento perdeu autorização e foi interrompido nesta sessão.'), 'blocked', 403);
    const operation = { controller: new AbortController(), candidate }; running = operation; error = ''; status = i18nText('Conferindo origem e destino…'); notify('busy');
    const attempt = candidate.attempt;
    try {
      if (!attempt.postStarted) { attempt.freshSourceVersion = null; attempt.freshVersion = null; }
      const fresh = await request(candidate.scope.basePath, options(candidate, operation.controller, { method: 'GET' }));
      guard(candidate, false); validateFresh(fresh, candidate);
      if (attempt.state === 'confirmed') {
        status = i18nText('Este encaminhamento já foi aceito.');
        // Return the freshly authorized destination, never a cached conversation.
        return fresh.conversations.find(item => string(item.id) === candidate.destination.id);
      }
      guard(candidate);
      // The server derives content and privately copies media. An uncertain POST
      // keeps the same reviewed fingerprint, both revisions and idempotency key.
      if (!attempt.payload) attempt.payload = Object.freeze({ messageId: candidate.content.messageId, sourceVersion: attempt.freshSourceVersion,
        sourceChannelId: candidate.sourceChannelId, fingerprint: candidate.fingerprint, destinationId: candidate.destination.id,
        destinationVersion: attempt.freshVersion, destinationChannelId: candidate.destination.channelId, idempotencyKey: attempt.idempotencyKey });
      attempt.postStarted = true; attempt.state = 'uncertain'; status = i18nText('Encaminhando para a conversa escolhida…'); notify('busy');
      const result = await request(`${candidate.scope.basePath}/conversations/${encodeURIComponent(candidate.scope.conversationId)}/forward`, options(candidate, operation.controller, { method: 'POST', body: JSON.stringify(attempt.payload) }));
      if (!result || string(result.id) !== candidate.destination.id || string(result.channelId) !== candidate.destination.channelId) reject(i18nText('Não foi possível confirmar o encaminhamento no destino escolhido.'), 'send-result', 502);
      attempt.result = { id: result.id, channelId: result.channelId }; attempt.state = 'confirmed';
      guard(candidate, false);
      status = i18nText('Encaminhamento aceito. Acompanhe o status na conversa de destino.'); return result;
    } catch (caught) {
      const confirmed = attempt.state === 'confirmed';
      if ([401, 403, 404].includes(caught.status) && !confirmed) attempt.state = 'blocked';
      if (confirmed) caught.confirmed = true;
      error = translateError(caught.message) || i18nText('Não foi possível confirmar o encaminhamento.');
      status = attempt.state === 'uncertain' ? i18nText('Confira o destino antes de tentar novamente. O identificador deste envio foi preservado.') : '';
      throw caught;
    } finally {
      if (running === operation) running = null;
      notify(attempt.state === 'confirmed' ? 'confirmed' : 'settled');
    }
  }
  return { prepare, selectTarget, targets, preview, execute, close, reset,
    get busy() { return Boolean(running); }, get opened() { return opened; }, get status() { return status; }, get error() { return error; } };
}
