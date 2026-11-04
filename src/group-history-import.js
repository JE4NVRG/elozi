import { createHash, randomUUID } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { fail } from './store.js';

export const GROUP_HISTORY_IMPORT_LIMITS = Object.freeze({ page: 50, total: 200, jobs: 50, timeoutMs: 20000 });
const ON_DEMAND = proto.HistorySync.HistorySyncType.ON_DEMAND;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const group = value => typeof value === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(value);
// A person's chat (phone JID or LID), the device suffix dropped: direct conversations import their older messages the same way.
const person = value => typeof value === 'string' && /^\d{5,20}(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(value);
const chatJid = value => typeof value === 'string' ? value.replace(/:\d+@/, '@') : value;
const terminal = state => ['completed', 'unavailable', 'failed', 'cancelled'].includes(state);
const identity = actor => JSON.stringify([actor?.userId, actor?.resellerId, actor?.role, actor?.kind || null, actor?.supportGrantId || null]);
const safe = (value, length) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').replace(/(?:https?:\/\/|www\.)\S+/gi, '[link]').slice(0, length) : '';
const seconds = value => { try { const number = Number(value?.toString?.() ?? value); return Number.isSafeInteger(number) && number > 0 && number <= 8640000000000 ? number : null; } catch { return null; } };
const synchronous = (callback, ...args) => { const value = callback(...args); if (value?.then) { Promise.resolve(value).catch(() => {}); fail(500, 'A validação da importação precisa ser síncrona.'); } return value; };

/**
 * The oldest message of a conversation that kept its provider key when it arrived or was imported (providerJid, providerTs,
 * externalId): the next search for older messages starts there, also after a restart. Messages from before the key was kept
 * have none and are never reconstructed.
 */
export function storedHistoryCursor(conversation) {
  let oldest = null;
  for (const message of conversation?.messages || []) {
    if (!['customer', 'human'].includes(message?.kind) || typeof message.externalId !== 'string' || typeof message.providerJid !== 'string' || !Number.isSafeInteger(message.providerTs)) continue;
    if (!oldest || message.providerTs < oldest.providerTs) oldest = message;
  }
  return oldest ? providerHistoryCursor({ key: { remoteJid: oldest.providerJid, id: oldest.externalId, fromMe: oldest.kind === 'human' }, messageTimestamp: oldest.providerTs }) : null;
}

/** Capture only actual provider WebMessageInfo; never reconstruct from a local message ID/date. */
export function providerHistoryCursor(message) {
  const key = message?.key, timestampSeconds = seconds(message?.messageTimestamp);
  if (!(group(key?.remoteJid) || person(key?.remoteJid)) || typeof key?.id !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(key.id) || typeof key?.fromMe !== 'boolean' || timestampSeconds === null) return null;
  return Object.freeze({ key: Object.freeze({ remoteJid: key.remoteJid, id: key.id, fromMe: key.fromMe }), timestampSeconds, timestampMs: timestampSeconds * 1000 });
}

function cursor(value, chatIds) {
  if (!value || !chatIds.has(chatJid(value.key?.remoteJid)) || !Number.isSafeInteger(value.timestampSeconds) || value.timestampMs !== value.timestampSeconds * 1000) return null;
  return providerHistoryCursor({ key: value.key, messageTimestamp: value.timestampSeconds });
}
function privateContent(message) {
  const body = message?.message;
  return !body || body.ephemeralMessage || body.viewOnceMessage || body.viewOnceMessageV2 || body.viewOnceMessageV2Extension
    || Number(body.messageContextInfo?.ephemeralExpiration || body.extendedTextMessage?.contextInfo?.expiration || 0) > 0;
}
function importedMessage(message, rawCursor, job, now) {
  if (privateContent(message)) return null;
  const body = message.message.documentWithCaptionMessage?.message || message.message;
  if (privateContent({ message: body })) return null;
  const candidates = [['imageMessage', 'image', 'image/jpeg'], ['audioMessage', 'audio', 'audio/ogg'], ['videoMessage', 'video', 'video/mp4'], ['documentMessage', 'document', 'application/octet-stream'], ['stickerMessage', 'image', 'image/webp']];
  const media = candidates.find(([field]) => body[field]);
  const text = typeof body.conversation === 'string' ? body.conversation : body.extendedTextMessage?.text ?? (media ? body[media[0]].caption : '');
  if (typeof text !== 'string' || !text && !media) return null;
  const attachments = [];
  if (media) {
    const [field, kind, fallback] = media, node = body[field], size = Number(node.fileLength?.toString?.() ?? node.fileLength ?? 0);
    if (node.viewOnce || Number(node.contextInfo?.expiration || 0) > 0) return null;
    attachments.push({ id: randomUUID(), kind, name: safe(node.fileName, 160) || 'Arquivo histórico', mime: typeof node.mimetype === 'string' && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(node.mimetype) ? node.mimetype.slice(0, 100) : fallback,
      size: Number.isSafeInteger(size) && size >= 0 ? size : 0, status: 'unavailable', preview: false, reason: 'historical_not_downloaded' });
  }
  return { id: randomUUID(), externalId: rawCursor.key.id, kind: rawCursor.key.fromMe ? 'human' : 'customer', text: text.slice(0, 4000), ...(text.length > 4000 ? { textTruncated: true } : {}),
    ...(attachments.length ? { attachments } : {}), senderName: safe(message.pushName, 80) || (rawCursor.key.fromMe ? 'WhatsApp · histórico' : 'Participante'),
    ...(typeof message.key.participant === 'string' && /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(message.key.participant) ? { senderJid: message.key.participant } : {}),
    createdAt: new Date(rawCursor.timestampMs).toISOString(), providerJid: rawCursor.key.remoteJid, providerTs: rawCursor.timestampSeconds, delivery: rawCursor.key.fromMe ? 'sent' : 'received', transport: 'whatsapp', imported: true, historySource: 'whatsapp-on-demand', importedAt: new Date(now).toISOString(), historyImportJobId: job.id };
}

/** RAM jobs; wa_seen and existing externalId keep committed imports deduplicated across restarts.
 * Gateway integration: acceptsHistory(entry, notification) is the ON_DEMAND-only socket predicate;
 * await receive(entry, event) from messaging-history.set. resolveCursor/onCursor use a private,
 * generation-bound entry.historyCursors Map. No cursor/provider request ID belongs in HTTP DTOs.
 * rc14 README/Example pass original seconds to fetchMessageHistory despite the internal Ms name.
 * requestHistory can explicitly adapt units after a verified provider contract, without losing raw seconds.
 */
export class GroupHistoryImporter {
  constructor(store, { authorize, resolveConnection, resolveCursor, onCursor = () => {}, requestHistory = ({ entry, count, cursor }) => entry.socket.fetchMessageHistory(count, cursor.key, cursor.timestampSeconds), now = Date.now, timeoutMs = GROUP_HISTORY_IMPORT_LIMITS.timeoutMs } = {}) {
    if (!store?.tenant || !store?.mutate || [authorize, resolveConnection, resolveCursor, onCursor, requestHistory, now].some(value => typeof value !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Configure a autoridade, conexão e cursor privados da importação.');
    Object.assign(this, { store, authorize, resolveConnection, resolveCursor, onCursor, requestHistory, now, timeoutMs });
    this.jobs = new Map(); this.commands = new Map(); this.active = new Map(); this.closed = false;
  }
  scope(actor, tenantId, conversationId, reauthorize = () => {}) {
    if (!actor?.userId || actor.kind === 'service' || actor.supportGrantId || actor.role !== 'reseller') fail(403, 'A importação exige um administrador humano desta empresa.');
    if (typeof reauthorize !== 'function') fail(400, 'Informe uma validação de sessão válida.');
    if (synchronous(reauthorize) === false) fail(403, 'O acesso desta importação mudou.');
    const tenant = this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId), channel = tenant.channels.find(item => item.id === conversation.channelId);
    if (synchronous(this.authorize, actor, tenantId, conversation, channel) !== true) fail(403, 'Seu acesso não permite importar este histórico.');
    const direct = conversation.conversationKind !== 'group' && person(conversation.remoteJid);
    if (channel?.kind !== 'whatsapp_qr' || channel.transport !== 'baileys' || channel.enabled === false || !(direct || group(conversation.remoteJid) && conversation.conversationKind === 'group' && (channel.allowedGroups || []).includes(conversation.remoteJid))) fail(409, 'Escolha um grupo WhatsApp habilitado nesta conexão.');
    const entry = synchronous(this.resolveConnection, actor, tenantId, channel.id);
    if (!entry || entry.tenantId !== tenantId || entry.channelId !== channel.id || entry.state !== 'connected' || entry.matched !== true || !Number.isSafeInteger(entry.generation) || !entry.socket || typeof entry.socket.fetchMessageHistory !== 'function') fail(409, 'A conexão do grupo não está disponível.');
    if (!direct && !Object.hasOwn(channel.groupNames || {}, conversation.remoteJid) && !entry.groupCache?.has(conversation.remoteJid)) fail(409, 'Escolha somente um grupo conhecido desta conexão.');
    // Every JID WhatsApp may use for this chat: a direct conversation answers by phone JID or LID.
    const chatIds = new Set([conversation.remoteJid, ...(direct ? conversation.remoteAliases || [] : [])].map(chatJid));
    return { tenant, conversation, channel, entry, groupId: conversation.remoteJid, chatIds };
  }
  fresh(job) {
    if (this.closed || terminal(job.state) || this.active.get(job.channelId) !== job || identity(job.actor) !== job.authority) fail(409, 'A importação não está mais ativa neste contexto.');
    const value = this.scope(job.actor, job.tenantId, job.conversationId, job.reauthorize);
    if (value.entry !== job.entry || value.entry.generation !== job.generation || value.groupId !== job.groupId || value.channel.id !== job.channelId) fail(409, 'A conexão ou origem do histórico mudou.');
    return value;
  }
  commandKey(actor, tenantId, commandId) { return JSON.stringify([actor.userId, actor.resellerId, tenantId, commandId]); }
  anchor(scope) {
    const value = cursor(synchronous(this.resolveCursor, scope.entry, { tenantId: scope.tenant.id, channelId: scope.channel.id, conversationId: scope.conversation.id, groupId: scope.groupId, conversation: scope.conversation }), scope.chatIds);
    // A millisecond value mistakenly supplied as provider seconds is invalid, not auto-converted.
    return value && value.timestampMs <= this.now() + 300000 ? value : null;
  }
  finish(job, state, interruption = Object.assign(new Error('A importação não está mais ativa neste contexto.'), { status: 409 })) {
    clearTimeout(job.timer); job.timer = null; job.state = state; job.updatedAt = new Date(this.now()).toISOString(); job.requestId = null;
    job.chunks?.clear();
    const reject = job.rejectPending; job.rejectPending = null; reject?.(interruption);
    if (this.active.get(job.channelId) === job) this.active.delete(job.channelId);
    job.signal?.removeEventListener('abort', job.abort);
  }
  projection(scope, job = null) {
    const available = Boolean(this.anchor(scope));
    return { tenantId: scope.tenant.id, conversationId: scope.conversation.id, channelId: scope.channel.id, version: scope.conversation.version || 1, anchor: { available }, state: job?.state || (available ? 'idle' : 'need_anchor'),
      job: job ? { id: job.id, commandId: job.commandId, requestedLimit: job.limit, state: job.state, counters: { ...job.counters }, createdAt: job.createdAt, updatedAt: job.updatedAt } : null };
  }
  status(actor, tenantId, conversationId, { commandId } = {}, options = {}) {
    if (commandId !== undefined && !uuid(commandId)) fail(400, 'Informe um identificador válido da importação.');
    const scope = this.scope(actor, tenantId, conversationId, options.reauthorize);
    const job = commandId ? this.commands.get(this.commandKey(actor, tenantId, commandId)) : [...this.jobs.values()].reverse().find(value => value.tenantId === tenantId && value.conversationId === conversationId && value.authority === identity(actor));
    if (job && (job.conversationId !== conversationId || job.channelId !== scope.channel.id || job.authority !== identity(actor))) fail(403, 'A importação pertence a outro contexto.');
    if (job && !terminal(job.state)) { try { this.fresh(job); } catch { this.finish(job, 'cancelled'); } }
    return this.projection(scope, job);
  }
  async start(actor, tenantId, conversationId, input, { reauthorize = () => {}, signal } = {}) {
    if (this.closed) fail(503, 'A importação não está disponível.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).some(key => !['version', 'limit', 'commandId'].includes(key)) || !Number.isSafeInteger(input.version) || ![50, 100, 200].includes(input.limit) || !uuid(input.commandId)) fail(400, 'Informe versão, limite de 50/100/200 e identificador da importação.');
    const scope = this.scope(actor, tenantId, conversationId, reauthorize), commandKey = this.commandKey(actor, tenantId, input.commandId), existing = this.commands.get(commandKey);
    if (existing) {
      if (existing.authority !== identity(actor) || existing.conversationId !== conversationId || existing.version !== input.version || existing.limit !== input.limit) fail(409, 'Este identificador pertence a outra importação.');
      return this.projection(scope, existing);
    }
    if (scope.conversation.version !== input.version) fail(409, 'A conversa mudou. Atualize antes de importar.');
    if (this.active.has(scope.channel.id)) fail(409, 'Já existe uma importação ativa nesta conexão.');
    const anchor = this.anchor(scope);
    if (!anchor) fail(409, 'Ainda não há uma mensagem real do provedor como ponto de partida.');
    if (signal?.aborted) fail(409, 'A importação foi cancelada.');
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail(400, 'Informe um cancelamento válido.');
    while (this.jobs.size >= GROUP_HISTORY_IMPORT_LIMITS.jobs) {
      const oldest = [...this.jobs.values()].find(value => terminal(value.state));
      if (!oldest) fail(429, 'A fila de importações atingiu o limite.');
      this.jobs.delete(oldest.id); this.commands.delete(oldest.commandKey);
    }
    const instant = new Date(this.now()).toISOString(), job = { id: randomUUID(), commandId: input.commandId, commandKey, actor, authority: identity(actor), tenantId, conversationId, channelId: scope.channel.id, groupId: scope.groupId, chatIds: scope.chatIds, entry: scope.entry, generation: scope.entry.generation,
      version: input.version, limit: input.limit, cursor: anchor, state: 'requesting', counters: { imported: 0, duplicates: 0, excluded: 0, requested: 0 }, processed: 0, createdAt: instant, updatedAt: instant, reauthorize, signal, abort: null, timer: null, requestId: null };
    job.abort = () => this.finish(job, 'cancelled'); signal?.addEventListener('abort', job.abort, { once: true });
    this.jobs.set(job.id, job); this.commands.set(commandKey, job); this.active.set(job.channelId, job);
    await this.request(job); return this.projection(this.scope(actor, tenantId, conversationId, reauthorize), job);
  }
  async request(job) {
    this.fresh(job); job.state = 'requesting'; job.requestId = null; job.batch = Math.min(GROUP_HISTORY_IMPORT_LIMITS.page, job.limit - job.processed); job.counters.requested += job.batch;
    job.chunks = new Map(); job.chunkMessages = 0; job.finalChunk = null;
    job.updatedAt = new Date(this.now()).toISOString();
    const interrupted = new Promise((_resolve, reject) => { job.rejectPending = reject; });
    job.timer = setTimeout(() => this.finish(job, 'unavailable', Object.assign(new Error('O provedor não respondeu dentro do prazo da importação.'), { status: 504 })), this.timeoutMs); job.timer.unref?.();
    try {
      const requestId = await Promise.race([Promise.resolve().then(() => { this.fresh(job); return this.requestHistory({ entry: job.entry, count: job.batch, cursor: job.cursor }); }), interrupted]); job.rejectPending = null;
      this.fresh(job);
      if (typeof requestId !== 'string' || !requestId || requestId.length > 180 || /[\x00-\x20]/.test(requestId)) fail(502, 'O provedor não confirmou o pedido de histórico.');
      job.requestId = requestId; job.state = 'pending'; job.updatedAt = new Date(this.now()).toISOString();
    } catch (error) {
      if (!terminal(job.state)) this.finish(job, error.status === 401 || error.status === 403 || error.status === 409 ? 'cancelled' : 'failed');
      if (error.status) throw error;
      fail(502, 'O pedido de histórico não foi confirmado pelo provedor.');
    }
  }
  acceptsHistory(entry, notification) {
    const job = this.active.get(entry?.channelId);
    if (!job || job.entry !== entry || job.state !== 'pending' || notification?.syncType !== ON_DEMAND || notification.peerDataRequestSessionId !== job.requestId) return false;
    try { this.fresh(job); return true; } catch { this.finish(job, 'cancelled'); return false; }
  }
  async receive(entry, event) {
    if (!this.acceptsHistory(entry, event)) return false;
    const job = this.active.get(entry.channelId);
    try {
      this.fresh(job);
      if (!Array.isArray(event.messages) || event.messages.length > job.batch) fail(502, 'O provedor devolveu uma página fora do limite autorizado.');
      if (event.progress != null && (!Number.isFinite(event.progress) || event.progress < 0 || event.progress > 100) || event.chunkOrder != null && (!Number.isSafeInteger(event.chunkOrder) || event.chunkOrder < 0 || event.chunkOrder >= GROUP_HISTORY_IMPORT_LIMITS.page)) fail(502, 'O provedor devolveu uma sequência inválida do histórico.');
      const fingerprint = createHash('sha256').update(JSON.stringify(event.messages, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
      const chunkKey = event.chunkOrder ?? fingerprint, previous = job.chunks.get(chunkKey);
      if (previous && previous.fingerprint !== fingerprint) fail(502, 'O provedor alterou uma parte já recebida do histórico.');
      if (!previous) {
        if (job.chunks.size >= GROUP_HISTORY_IMPORT_LIMITS.page || job.chunkMessages + event.messages.length > job.batch) fail(502, 'O provedor devolveu uma página fora do limite autorizado.');
        job.chunks.set(chunkKey, { fingerprint, messages: event.messages }); job.chunkMessages += event.messages.length;
      }
      if (event.progress === 100) job.finalChunk = event.chunkOrder ?? 'unordered';
      const complete = event.progress == null || job.finalChunk === 'unordered' || Number.isInteger(job.finalChunk) && Array.from({ length: job.finalChunk + 1 }, (_unused, index) => index).every(index => job.chunks.has(index));
      job.updatedAt = new Date(this.now()).toISOString();
      if (!complete) return this.projection(this.fresh(job), job);
      const messages = [...job.chunks.values()].flatMap(chunk => chunk.messages);
      clearTimeout(job.timer); job.timer = null; job.state = 'importing';
      const values = [], page = new Set(); let oldest = null, excluded = 0, duplicates = 0;
      for (const raw of messages) {
        const anchor = providerHistoryCursor(raw);
        if (!anchor || !job.chatIds.has(chatJid(anchor.key.remoteJid)) || anchor.timestampMs > job.cursor.timestampMs || anchor.timestampMs > this.now() + 300000) { excluded++; continue; }
        if (!oldest || anchor.timestampMs < oldest.timestampMs || anchor.timestampMs === oldest.timestampMs && anchor.key.id !== job.cursor.key.id) oldest = anchor;
        if (page.has(anchor.key.id)) { duplicates++; continue; } page.add(anchor.key.id);
        const value = importedMessage(raw, anchor, job, this.now());
        if (!value) { excluded++; continue; } values.push(value);
      }
      const counts = this.store.mutate(job.actor, job.tenantId, 'WhatsApp: histórico importado pelo administrador', tenant => {
        this.fresh(job); const conversation = this.store.getConversation(tenant, job.conversationId);
        let imported = 0, duplicate = duplicates;
        for (const value of values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.externalId.localeCompare(b.externalId))) {
          if (conversation.messages.some(message => message.externalId === value.externalId) || this.store.db.prepare('SELECT 1 FROM wa_seen WHERE channel_id=? AND remote_jid=? AND message_id=?').get(job.channelId, job.groupId, value.externalId)) { duplicate++; continue; }
          this.store.db.prepare('INSERT INTO wa_seen VALUES (?,?,?)').run(job.channelId, job.groupId, value.externalId);
          const position = conversation.messages.findIndex(message => typeof message.createdAt === 'string' && message.createdAt > value.createdAt);
          if (position < 0) conversation.messages.push(value); else conversation.messages.splice(position, 0, value);
          imported++;
        }
        if (imported) conversation.version++; return { imported, duplicates: duplicate, excluded };
      });
      job.processed += messages.length; for (const key of ['imported', 'duplicates', 'excluded']) job.counters[key] += counts[key];
      job.updatedAt = new Date(this.now()).toISOString(); this.fresh(job);
      const progressed = oldest && (oldest.timestampMs < job.cursor.timestampMs || oldest.key.id !== job.cursor.key.id);
      if (progressed) synchronous(this.onCursor, entry, job.groupId, oldest);
      if (!progressed || messages.length < job.batch || job.processed >= job.limit) this.finish(job, 'completed');
      else { job.cursor = oldest; await this.request(job); }
      return this.projection(this.scope(job.actor, job.tenantId, job.conversationId, job.reauthorize), job);
    } catch (error) {
      if (!terminal(job.state)) this.finish(job, [401, 403, 409].includes(error.status) ? 'cancelled' : 'failed');
      if (error.status) throw error;
      fail(502, 'Não foi possível concluir esta página do histórico.');
    }
  }
  cancel(actor, tenantId, conversationId, commandId, options = {}) {
    if (!uuid(commandId)) fail(400, 'Informe um identificador válido da importação.');
    const dto = this.status(actor, tenantId, conversationId, { commandId }, options), job = this.commands.get(this.commandKey(actor, tenantId, commandId));
    if (job && !terminal(job.state)) this.finish(job, 'cancelled');
    return job ? this.status(actor, tenantId, conversationId, { commandId }, options) : dto;
  }
  connectionChanged(entry) {
    const job = this.active.get(entry?.channelId);
    if (job && job.entry === entry && job.generation !== entry.generation) this.finish(job, 'cancelled');
  }
  close() { this.closed = true; for (const job of this.active.values()) this.finish(job, 'cancelled'); }
}
