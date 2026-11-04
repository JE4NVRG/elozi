import makeWASocket, { Browsers, DisconnectReason, jidNormalizedUser, generateMessageIDV2, proto, getMediaKeys } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { effectiveTenantDataSql } from './conversation-journal.js';
import { prepareSelectedGroupConversations } from './group-conversations.js';
import { providerHistoryCursor } from './group-history-import.js';
import { randomUUID, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { encryptedAuthState, loadLocalKey } from './wa-auth.js';
import { fail, text } from './store.js';
import { installProtocolLogGuard } from './protocol-logging.js';
import { syncConversationContact, syncIncomingConversationContact, boundConversationContact } from './contacts.js';
import { noteStatus, clearConversationParticipants } from './operations.js';
import { attachmentIds, outgoingText, MAX_MEDIA_BYTES, readLimitedMedia } from './media.js';
import { isOggOpus } from './audio.js';
import { readAvatarResponse } from './avatars.js';
import { resolveReply } from './replies.js';
import { automatedAttribution } from './outbox.js';
import { ensureAgendaSchema, rememberAgenda, agendaNames, applyAgendaNames, savedName, agendaCount, agendaRows } from './whatsapp-agenda.js';
import { createReadSyncLogger, readJid, providerReadMilliseconds, afterManualUnread } from './whatsapp-read-state.js';
import { decryptPollSelection, incomingPollUpdate, normalizePoll, pollSecret, pollText } from './whatsapp-polls.js';

export const normalizeNumber = value => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  if (!/^55\d{10,11}$/.test(digits)) fail(400, 'Informe o número brasileiro com DDD.');
  return digits;
};
/** WhatsApp can retain the Brazilian mobile JID from before the ninth digit.
 * Keep country/DDD and all eight subscriber digits exact; never compare suffixes. */
export const brazilianMobileAliases = value => {
  const digits = normalizeNumber(value);
  if (/^55[1-9]\d9[6-9]\d{7}$/.test(digits)) return [digits, digits.slice(0, 4) + digits.slice(5)];
  if (/^55[1-9]\d[6-9]\d{7}$/.test(digits)) return [digits, digits.slice(0, 4) + '9' + digits.slice(4)];
  return [digits];
};
export const whatsappNumbersMatch = (expected, observed) => {
  try { return brazilianMobileAliases(expected).includes(normalizeNumber(observed)); } catch { return false; }
};
const maskNumber = digits => `Número de teste · final ${digits.slice(-4)}`;
const deliveryRank = { pending: 0, unconfirmed: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
const providerReadTs = (value, now) => Number.isSafeInteger(value) && value > 0 && value * 1000 <= now + 300000 ? value : null;
const receiptJid = readJid;
function receiptMatches(conversation, message, key) {
  if (typeof key?.id !== 'string' || message.externalId !== key.id || message.transport !== 'whatsapp') return false;
  const jid = receiptJid(key.remoteJid);
  if (key.remoteJid !== undefined && (!jid || ![conversation.remoteJid, ...(conversation.remoteAliases || [])].map(receiptJid).includes(jid))) return false;
  // Outgoing legacy updates may contain only the id. They never attest that our device read an inbound message.
  if (key.fromMe === undefined) return ['human', 'agent'].includes(message.kind);
  if (key.fromMe === true) return ['human', 'agent'].includes(message.kind);
  if (key.fromMe !== false || !jid || message.kind !== 'customer') return false;
  if (jid.endsWith('@g.us')) return Boolean(receiptJid(key.participant) && [message.senderJid, message.senderJidAlt].map(receiptJid).includes(receiptJid(key.participant)));
  return key.participant === undefined;
}
function deviceReadCovers(conversation, message, now, mark = conversation.whatsappDeviceRead) {
  const cutoff = providerReadTs(mark?.providerTs, now), stamp = providerReadTs(message.providerTs, now);
  if (cutoff === null || stamp === null) return false;
  if (stamp !== cutoff) return stamp < cutoff;
  const anchorIndex = conversation.messages.findIndex(item => item.id === mark.messageId), index = conversation.messages.indexOf(message);
  return anchorIndex >= 0 && index >= 0 && index <= anchorIndex;
}
function reconcileDeviceRead(conversation, anchor, now, source, readAtMs = null) {
  const stamp = providerReadTs(anchor.providerTs, now);
  if (stamp === null || anchor.imported || anchor.transport !== 'whatsapp' || !afterManualUnread(conversation, readAtMs)) return false;
  const previous = conversation.whatsappDeviceRead, cutoff = providerReadTs(previous?.providerTs, now);
  const index = conversation.messages.indexOf(anchor), previousIndex = conversation.messages.findIndex(message => message.id === previous?.messageId);
  if (index < 0) return false;
  const advances = cutoff === null || stamp > cutoff || stamp === cutoff && index > previousIndex;
  const freshManualRead = Number.isFinite(Date.parse(conversation.whatsappManualUnreadAt)) && readAtMs !== null;
  if (!advances && !freshManualRead) return false;
  const mark = { providerTs: stamp, messageId: anchor.id, source, observedAt: new Date(now).toISOString(), ...(readAtMs !== null ? { readAt: new Date(readAtMs).toISOString() } : {}) };
  const remaining = conversation.messages.filter(message => message.kind === 'customer' && message.transport === 'whatsapp' && !message.imported && !deviceReadCovers(conversation, message, now, mark)).length;
  // unread is shared panel state. A provider receipt can reduce it; it cannot recreate unread after a person cleared it.
  const unread = Math.min(Math.max(0, Number(conversation.unread) || 0), remaining);
  if (advances) conversation.whatsappDeviceRead = mark;
  const changed = advances || unread !== conversation.unread;
  conversation.unread = unread;
  return changed;
}
function unwrapMessage(message) {
  let inner = message, viewOnce = false;
  for (let depth = 0; depth < 5; depth++) {
    const wrapper = inner?.ephemeralMessage || inner?.viewOnceMessage || inner?.viewOnceMessageV2 || inner?.viewOnceMessageV2Extension || inner?.documentWithCaptionMessage;
    if (!wrapper?.message) break;
    if (inner.viewOnceMessage || inner.viewOnceMessageV2 || inner.viewOnceMessageV2Extension) viewOnce = true;
    inner = wrapper.message;
  }
  return { inner, viewOnce };
}
const extractText = message => {
  const { inner } = unwrapMessage(message);
  return inner?.conversation || inner?.extendedTextMessage?.text || inner?.imageMessage?.caption || inner?.videoMessage?.caption || inner?.documentMessage?.caption || '';
};
// Conteúdo vindo do provedor: remove controles e limita antes de compor textos legíveis.
const clean = (value, max) => typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max) : '';
const timestampSeconds = value => { const seconds = Number(value?.toNumber?.() ?? value); return Number.isFinite(seconds) && seconds > 0 ? seconds : null; };
const coordinates = (latitude, longitude) => { const lat = Number(latitude), lng = Number(longitude); return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng) ? `(${lat.toFixed(6)}, ${lng.toFixed(6)})` : ''; };
const describe = (label, details, suffix = '') => [label, details.map(item => clean(item, 1000)).filter(Boolean).join(' · '), suffix].filter(Boolean).join(' ');
const contactLine = contact => [clean(contact?.displayName, 80), clean(typeof contact?.vcard === 'string' ? /(?:^|\n)(?:item\d+\.)?TEL[^:\n]*:([^\n]+)/i.exec(contact.vcard)?.[1] : '', 40)].filter(Boolean).join(' · ');
/** Tipos sem mídia própria viram um texto legível em vez de sumirem do atendimento. */
function unsupportedText(message) {
  const { inner, viewOnce } = unwrapMessage(message?.message);
  const location = inner?.locationMessage || inner?.liveLocationMessage;
  if (location) return describe(inner.liveLocationMessage || location.isLive ? '[Localização em tempo real]' : '[Localização]', [location.name, location.address, location.caption, location.comment], coordinates(location.degreesLatitude, location.degreesLongitude));
  const contacts = inner?.contactMessage ? [inner.contactMessage] : inner?.contactsArrayMessage ? (Array.isArray(inner.contactsArrayMessage.contacts) ? inner.contactsArrayMessage.contacts : []) : null;
  if (contacts) {
    const lines = contacts.slice(0, 5).map(contactLine).filter(Boolean);
    if (!lines.length && clean(inner.contactsArrayMessage?.displayName, 80)) lines.push(clean(inner.contactsArrayMessage.displayName, 80));
    return ['[Contato]', lines.join(' | '), contacts.length > 5 ? `| +${contacts.length - 5}` : ''].filter(Boolean).join(' ');
  }
  const pollVersion = inner?.pollCreationMessageV4?.message;
  const poll = inner?.pollCreationMessage || inner?.pollCreationMessageV2 || inner?.pollCreationMessageV3 || inner?.pollCreationMessageV5 || pollVersion?.pollCreationMessage || pollVersion?.pollCreationMessageV3;
  if (poll) return describe('[Enquete]', [poll.name, (Array.isArray(poll.options) ? poll.options : []).slice(0, 12).map(option => clean(option?.optionName, 80)).filter(Boolean).join(' / ')]);
  if (inner?.lottieStickerMessage) return '[Figurinha]';
  // Aparelhos vinculados recebem visualização única sem conteúdo (key.isViewOnce) ou com mídia não armazenável.
  if (message?.key?.isViewOnce || viewOnce) return '[Visualização única] Abra no celular para ver o conteúdo.';
  return '';
}
// Reação legítima traz só emoji (tom de pele, ZWJ, bandeira, keycap); texto livre do remetente não vira nota com cara de sistema.
const reactionEmoji = value => typeof value === 'string' && value.length <= 32 && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣#*0-9\u{E0020}-\u{E007F}]+$/u.test(value) && /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u.test(value) ? value : '';
// Texto de terceiros citado numa nota: sem aspas nem controles bidi, para não fechar a citação nem reordenar o aviso.
const cite = (value, max) => clean(value, max).replace(/[\p{Bidi_Control}“”"]/gu, '').trim();
function incomingReaction(message) {
  const reaction = unwrapMessage(message?.message).inner?.reactionMessage;
  return reaction ? { emoji: reactionEmoji(reaction.text), targetId: typeof reaction.key?.id === 'string' ? reaction.key.id : null } : null;
}
// Sessão já vinculada: QR escaneado grava creds.me; pareamento por código marca registered.
const linkedCreds = creds => Boolean(creds?.me?.id || creds?.registered);
const BACKLOG_MEDIA_CONCURRENCY = 4;
function outgoingReply(conversation, input) {
  const reply = resolveReply(conversation, input);
  if (!reply) return null;
  if (typeof reply.externalId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(reply.externalId)) fail(409, 'A mensagem original não tem uma referência válida no WhatsApp.');
  if (conversation.remoteJid.endsWith('@g.us') && reply.kind !== 'human' && !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(reply.senderJid || '')) fail(409, 'O participante da mensagem original não está disponível.');
  return reply;
}
function incomingReplyId(conversation, message) {
  const { inner } = unwrapMessage(message);
  const context = Object.values(inner || {}).find(node => node && typeof node === 'object' && node.contextInfo?.stanzaId)?.contextInfo;
  if (typeof context?.stanzaId !== 'string') return null;
  if (context.remoteJid && ![conversation.remoteJid, ...(conversation.remoteAliases || [])].includes(context.remoteJid)) return null;
  return conversation.messages.find(item => item.externalId === context.stanzaId && ['customer', 'human'].includes(item.kind))?.id || null;
}
function incomingMedia(message) {
  const { inner, viewOnce } = unwrapMessage(message);
  for (const [property, kind, mime] of [['imageMessage', 'image', 'image/jpeg'], ['audioMessage', 'audio', 'audio/ogg'], ['videoMessage', 'video', 'video/mp4'], ['documentMessage', 'document', 'application/octet-stream'], ['stickerMessage', 'image', 'image/webp'], ['ptvMessage', 'video', 'video/mp4']]) {
    const node = inner?.[property];
    if (node) return { node, type: property === 'stickerMessage' ? 'sticker' : kind, viewOnce: viewOnce || Boolean(node.viewOnce), descriptor: { kind, mime: node.mimetype || mime, name: node.fileName || (kind === 'document' ? 'Documento' : undefined), size: Number(node.fileLength?.toString?.() ?? node.fileLength ?? 0) } };
  }
  return null;
}
export async function downloadWhatsAppMedia(item, { fetchImpl = fetch } = {}) {
  const node = item.node;
  if (item.viewOnce) fail(400, 'Arquivo de visualização única não armazenado.');
  if (Number(node.fileLength?.toString?.() ?? node.fileLength ?? 0) > MAX_MEDIA_BYTES) fail(413, 'Arquivo acima do limite.');
  // Provider metadata may contain a URL, but only the fixed WhatsApp media origin is accepted.
  const directPath = typeof node.directPath === 'string' && node.directPath.startsWith('/') && !node.directPath.startsWith('//') && !/[\r\n\\]/.test(node.directPath) ? node.directPath : undefined;
  let url;
  if (!directPath && typeof node.url === 'string') {
    const parsed = new URL(node.url);
    if (parsed.origin !== 'https://mmg.whatsapp.net' || parsed.username || parsed.password) fail(400, 'Origem de arquivo inválida.');
    url = parsed.href;
  }
  if (!directPath && !url) fail(400, 'Origem de arquivo inválida.');
  const response = await fetchImpl(directPath ? `https://mmg.whatsapp.net${directPath}` : url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) fail(502, 'Arquivo indisponível.');
  const encryptedLimit = MAX_MEDIA_BYTES + 26;
  if (Number(response.headers?.get('content-length') || 0) > encryptedLimit) { await response.body?.cancel?.().catch(() => {}); fail(413, 'Arquivo acima do limite.'); }
  const encrypted = await readLimitedMedia(response.body, encryptedLimit);
  if (encrypted.length < 26 || (encrypted.length - 10) % 16) fail(400, 'Arquivo inválido.');
  const { cipherKey, iv, macKey } = await getMediaKeys(node.mediaKey, item.type), ciphertext = encrypted.subarray(0, -10);
  const mac = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, encrypted.subarray(-10))) fail(400, 'Integridade do arquivo inválida.');
  const matchHash = (bytes, expected) => !expected || Buffer.from(expected).length === 32 && timingSafeEqual(createHash('sha256').update(bytes).digest(), Buffer.from(expected));
  if (!matchHash(encrypted, node.fileEncSha256)) fail(400, 'Integridade do arquivo inválida.');
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv), bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (bytes.length > MAX_MEDIA_BYTES) fail(413, 'Arquivo acima do limite.');
  if (!matchHash(bytes, node.fileSha256)) fail(400, 'Integridade do arquivo inválida.');
  return bytes;
}

export class WhatsAppGateway {
  constructor(store, { socketFactory = makeWASocket, authKey, reconnectDelay = 1500, slowRetryDelay = 5 * 60_000, slowRetryLimit = 288, backlogWindowMs = 72 * 3600_000, backlogAutomationMs = 10 * 60_000, now = Date.now, downloadMediaImpl, fetchImpl = fetch, planQuota = null } = {}) {
    installProtocolLogGuard();
    // Optional plan quota guard (commercial-usage.js PlanQuotaGuard); null keeps the historical behaviour.
    this.planQuota = planQuota;
    this.store = store; this.socketFactory = socketFactory; this.authKey = authKey; this.reconnectDelay = reconnectDelay; this.downloadMedia = downloadMediaImpl || (item => downloadWhatsAppMedia(item, { fetchImpl })); this.avatarFetch = fetchImpl;
    // Quedas transitórias: 5 tentativas rápidas e depois uma tentativa lenta a cada slowRetryDelay (padrão ~24h no total).
    // Backlog offline: entra se tiver até backlogWindowMs; automações só disparam até backlogAutomationMs de atraso.
    Object.assign(this, { slowRetryDelay, slowRetryLimit, backlogWindowMs, backlogAutomationMs, now });
    this.entries = new Map(); this.mediaTasks = new Set(); this.historyTasks = new Set(); this.closing = false;
    this.store.db.exec('CREATE TABLE IF NOT EXISTS wa_seen (channel_id TEXT NOT NULL, remote_jid TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(channel_id,remote_jid,message_id))');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS wa_number_bindings (number TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL)');
    ensureAgendaSchema(this.store.db); this.agendaTimers = new Map();
    for (const row of this.store.db.prepare('SELECT id,data FROM tenants').all()) for (const channel of JSON.parse(row.data).channels) {
      if (channel.transport === 'baileys' && channel.expectedNumber) this.store.db.prepare('INSERT OR IGNORE INTO wa_number_bindings VALUES (?,?,?)').run(channel.expectedNumber, channel.id, row.id);
    }
  }
  reserveNumber(channel, tenantId) {
    const aliases = brazilianMobileAliases(channel.expectedNumber);
    const bindings = this.store.db.prepare(`SELECT channel_id,tenant_id FROM wa_number_bindings WHERE number IN (${aliases.map(() => '?').join(',')})`).all(...aliases);
    if (bindings.some(binding => binding.channel_id !== channel.id || binding.tenant_id !== tenantId)) fail(409, 'Este número já está reservado em outra conexão.');
    // Only a NEW channel (not yet persisted) consumes a plan number; re-pairing an existing channel is never blocked.
    this.planQuota?.assertWhatsAppNumber?.({ tenantId, channelId: channel.id });
    if (!bindings.length) this.store.db.prepare('INSERT INTO wa_number_bindings VALUES (?,?,?)').run(channel.expectedNumber, channel.id, tenantId);
  }
  actor(resellerId) { return { role: 'reseller', resellerId, name: 'Gateway WhatsApp' }; }
  applyDeviceReadSync(entry, evidence, current) {
    if (!current() || !entry.matched || entry.state !== 'connected') return;
    const apply = (tenant, mutate) => {
      const channel = tenant.channels.find(item => item.id === entry.channelId);
      if (channel?.kind !== 'whatsapp_qr' || channel.transport !== 'baileys' || channel.enabled === false) return false;
      const conversations = tenant.conversations.filter(conversation => conversation.channelId === entry.channelId && [conversation.remoteJid, ...(conversation.remoteAliases || [])].map(receiptJid).includes(evidence.chatJid));
      if (conversations.length !== 1) return false;
      const conversation = conversations[0], anchors = [];
      for (const proof of evidence.anchors) {
        const matches = conversation.messages.filter(message => !message.imported && receiptMatches(conversation, message, proof.key) && providerReadTs(message.providerTs, this.now()) === proof.providerTs);
        if (matches.length === 1) anchors.push(matches[0]);
      }
      anchors.sort((a, b) => a.providerTs - b.providerTs || conversation.messages.indexOf(a) - conversation.messages.indexOf(b));
      const anchor = anchors.at(-1);
      return anchor && reconcileDeviceRead(mutate ? conversation : { ...conversation }, anchor, this.now(), evidence.initialSync ? 'app-state-snapshot' : 'app-state-read', evidence.readAtMs) ? conversation.id : false;
    };
    if (!apply(this.store.tenant(entry.actor, entry.tenantId), false)) return;
    const updated = this.store.mutate(entry.actor, entry.tenantId, 'WhatsApp: leitura sincronizada do aparelho', tenant => {
      if (current() && entry.matched && entry.state === 'connected') return apply(tenant, true);
    });
    if (updated) entry.deviceReadStateSync?.updatedConversations.add(updated);
  }
  /** Explicit administrative refresh of the read collection; credentials, QR and message history are retained. */
  async syncDeviceReadState(session, tenantId, channelId, { reauthorize = () => {}, timeoutMs = 30000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail(400, 'Informe um prazo válido para consultar as leituras.');
    const identity = { userId: session.userId, resellerId: session.resellerId };
    let captured, expired = false;
    const fresh = () => {
      if (expired) fail(409, 'A confirmação das leituras ainda não chegou.');
      const result = reauthorize();
      if (result?.then) { Promise.resolve(result).catch(() => {}); fail(400, 'A validação das leituras precisa ser síncrona.'); }
      this.store.admin(session);
      if (!identity.userId || session.userId !== identity.userId || session.resellerId !== identity.resellerId || session.supportGrantId || session.kind === 'service') fail(403, 'Somente a administração da empresa pode consultar as leituras do aparelho.');
      const entry = this.connectedEntry(session, tenantId, channelId), { channel } = this.channel(session, tenantId, channelId);
      const socketNumber = jidNormalizedUser(entry.socket.user?.id || entry.socket.authState?.creds?.me?.id || '').split('@')[0];
      if (this.closing || channel.enabled === false || !whatsappNumbersMatch(channel.expectedNumber, entry.expectedNumber) || !whatsappNumbersMatch(channel.expectedNumber, socketNumber)) fail(409, 'O número desta conexão mudou. Confira antes de consultar as leituras.');
      if (captured && (entry !== captured.entry || entry.socket !== captured.socket || entry.generation !== captured.generation || entry.expectedNumber !== captured.expectedNumber)) fail(409, 'A conexão mudou durante a consulta das leituras.');
      return entry;
    };
    const entry = fresh();
    if (typeof entry.socket.resyncAppState !== 'function' || typeof entry.socket.authState?.keys?.set !== 'function' || typeof entry.socket.authState.keys.get !== 'function') return { channelId, state: 'pending', updatedConversations: 0 };
    if (entry.deviceReadStateSync || entry.panelReadPending?.size || entry.agendaSync) fail(409, 'Esta conexão já está sincronizando. Aguarde a conclusão antes de consultar as leituras.');
    const operation = { updatedConversations: new Set() };
    captured = { entry, socket: entry.socket, generation: entry.generation, expectedNumber: entry.expectedNumber };
    entry.deviceReadStateSync = operation;
    let timer;
    const report = state => ({ channelId, state, updatedConversations: operation.updatedConversations.size });
    const deadline = new Promise(resolve => { timer = setTimeoutImpl(() => { expired = true; resolve(report('pending')); }, timeoutMs); });
    const execute = (async () => {
      try {
        fresh(); await captured.socket.authState.keys.set({ 'app-state-sync-version': { regular_low: null } });
        fresh(); await captured.socket.resyncAppState(['regular_low'], true);
        fresh(); const rebuilt = await captured.socket.authState.keys.get('app-state-sync-version', ['regular_low']);
        fresh();
        const value = rebuilt?.regular_low?.version, version = typeof value === 'number' ? value : value && typeof value.toNumber === 'function' ? value.toNumber() : NaN;
        return report(Number.isSafeInteger(version) && version > 0 ? 'synced' : 'pending');
      } catch { return report('pending'); }
    })().finally(() => { if (entry.deviceReadStateSync === operation) delete entry.deviceReadStateSync; });
    try { return await Promise.race([execute, deadline]); }
    finally { clearTimeoutImpl(timer); }
  }
  /** Explicit panel command only. Capture a prefix once; no new inbound or provider retry enters this operation. */
  async syncReadToDevice(session, tenantId, conversationId, input, { reauthorize = () => {}, timeoutMs = 8000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (!input || !Number.isSafeInteger(input.version) || input.version < 1 || typeof input.channelId !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) fail(400, 'Informe a versão e a conexão atuais para sincronizar a leitura.');
    const actor = { userId: session.userId, resellerId: session.resellerId }, inbound = conversation => conversation.messages.filter(message => message.kind === 'customer' && message.transport === 'whatsapp' && !message.imported);
    let captured, expired = false;
    const fresh = () => {
      if (expired) fail(409, 'A confirmação da leitura não chegou a tempo.');
      const check = reauthorize();
      if (check?.then) { Promise.resolve(check).catch(() => {}); fail(400, 'A validação da leitura precisa ser síncrona.'); }
      if (!actor.userId || session.userId !== actor.userId || session.resellerId !== actor.resellerId || session.supportGrantId || session.kind === 'service') fail(403, 'Somente o responsável atual pode sincronizar a leitura.');
      const tenant = this.store.tenant(session, tenantId), conversation = this.store.getConversation(tenant, conversationId), channel = tenant.channels.find(item => item.id === conversation.channelId), entry = this.entries.get(conversation.channelId);
      if (conversation.owner !== 'human' || conversation.assignedUserId !== actor.userId) fail(403, 'Somente o responsável atual pode sincronizar a leitura.');
      if (this.operations?.auth && !this.operations.auth.can(session, 'inbox.read', { tenantId, channelId: conversation.channelId, departmentId: conversation.departmentId || this.operations.currentDepartment(tenant, conversation)?.id || 'unassigned' })) fail(403, 'Seu acesso não permite sincronizar a leitura.');
      if (this.closing || conversation.channelId !== input.channelId || channel?.kind !== 'whatsapp_qr' || channel.transport !== 'baileys' || channel.enabled === false || !entry || entry.tenantId !== tenantId || !entry.matched || entry.state !== 'connected') fail(409, 'A conexão mudou. Confira antes de sincronizar a leitura.');
      if (entry.deviceReadStateSync) fail(409, 'As leituras deste WhatsApp já estão sendo consultadas. Aguarde a conclusão.');
      if (conversation.remoteJid?.endsWith('@g.us') && !(channel.allowedGroups || []).includes(conversation.remoteJid)) fail(409, 'Este grupo não está selecionado no atendimento.');
      if (captured) {
        if (entry !== captured.entry || entry.generation !== captured.generation || entry.socket !== captured.socket || conversation.remoteJid !== captured.remoteJid || conversation.whatsappManualUnreadAt !== captured.manualUnreadAt || inbound(conversation).at(-1)?.id !== captured.lastInboundId) fail(409, 'A conversa mudou durante a sincronização da leitura.');
        for (const proof of captured.messages) {
          const message = conversation.messages.find(value => value.id === proof.id);
          if (!message || message.imported || message.externalId !== proof.key.id || message.providerTs !== proof.providerTs || !receiptMatches(conversation, message, proof.key)) fail(409, 'A referência de leitura mudou.');
        }
      } else this.store.getConversation(tenant, conversationId, input.version);
      return { conversation, entry };
    };
    const { conversation, entry } = fresh();
    if (typeof entry.socket?.readMessages !== 'function' || typeof entry.socket?.chatModify !== 'function') return { state: 'pending', reason: 'unavailable' };
    const messages = inbound(conversation).flatMap(message => {
      const remoteJid = receiptJid(message.providerJid || conversation.remoteJid), participant = message.senderJid ? receiptJid(message.senderJid) : null, providerTs = providerReadTs(message.providerTs, this.now());
      const key = { id: message.externalId, remoteJid, fromMe: false, ...(participant ? { participant } : {}) };
      return remoteJid && providerTs !== null && typeof key.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(key.id) && receiptMatches(conversation, message, key) && (!remoteJid.endsWith('@g.us') || participant) ? [{ id: message.id, key, providerTs }] : [];
    }).slice(-256);
    if (!messages.length) return { state: 'pending', reason: 'unavailable' };
    const anchor = messages.reduce((latest, message) => message.providerTs >= latest.providerTs ? message : latest);
    captured = { entry, socket: entry.socket, generation: entry.generation, remoteJid: conversation.remoteJid, manualUnreadAt: conversation.whatsappManualUnreadAt, lastInboundId: inbound(conversation).at(-1)?.id, messages };
    entry.panelReadPending ||= new Set();
    if (entry.panelReadPending.has(conversationId)) return { state: 'pending', reason: 'unconfirmed' };
    entry.panelReadPending.add(conversationId);
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeoutImpl(() => { expired = true; resolve({ state: 'pending', reason: 'timeout' }); }, timeoutMs); });
    const execute = (async () => {
      try {
        fresh(); await captured.socket.readMessages(messages.map(message => ({ ...message.key })));
        fresh(); await captured.socket.chatModify({ markRead: true, lastMessages: [{ key: { ...anchor.key }, messageTimestamp: anchor.providerTs, timestamp: anchor.providerTs }] }, anchor.key.remoteJid);
        fresh(); return { state: 'synced' };
      } catch { return { state: 'pending', reason: 'unconfirmed' }; }
    })().finally(() => entry.panelReadPending.delete(conversationId));
    try { return await Promise.race([execute, deadline]); }
    finally { clearTimeoutImpl(timer); }
  }
  /**
   * "Digitando…" for an already authorized private conversation (ServiceTyping): one chatstate node (composing/paused)
   * to the contact through the live socket of this tenant's QR line. No message, no store write; a missing or changed
   * connection answers sent:false instead of failing. The first composing for a contact also subscribes to its presence,
   * as WhatsApp clients expect before showing the indicator; that subscription is best effort.
   */
  async sendTyping({ tenantId, channel, conversation, state, reauthorize = () => true }) {
    if (channel?.kind !== 'whatsapp_qr' || channel.transport !== 'baileys') return { supported: false, sent: false, reason: 'channel' };
    if (!['composing', 'paused'].includes(state)) fail(400, 'Use state composing ou paused.');
    const jid = conversation?.remoteJid;
    if (typeof jid !== 'string' || !/^[^@\s]{1,80}@(s\.whatsapp\.net|lid)$/.test(jid)) return { supported: false, sent: false, reason: 'conversation' };
    const entry = this.entries.get(channel.id), live = () => !this.closing && this.entries.get(channel.id) === entry && entry?.tenantId === tenantId && entry.matched === true && entry.state === 'connected' && typeof entry.socket?.sendPresenceUpdate === 'function';
    if (channel.enabled === false || !live()) return { supported: true, sent: false, reason: 'disconnected' };
    const socket = entry.socket, generation = entry.generation;
    reauthorize();
    if (state === 'composing' && typeof socket.presenceSubscribe === 'function') {
      const subscribed = entry.typingSubscriptions ||= new Map(), at = subscribed.get(jid);
      if (!at || this.now() - at > 10 * 60_000) {
        if (!subscribed.has(jid) && subscribed.size >= 500) subscribed.delete(subscribed.keys().next().value);
        subscribed.set(jid, this.now());
        try { await socket.presenceSubscribe(jid); } catch { subscribed.delete(jid); }
      }
    }
    if (!live() || entry.socket !== socket || entry.generation !== generation) return { supported: true, sent: false, reason: 'disconnected' };
    reauthorize();
    await socket.sendPresenceUpdate(state, jid);
    return { supported: true, sent: true };
  }
  rememberHistoryCursor(entry, message, generation = entry.generation) {
    if (this.closing || this.entries.get(entry.channelId) !== entry || entry.generation !== generation || entry.matched !== true || entry.state !== 'connected') return;
    const cursor = providerHistoryCursor(message);
    if (!cursor) return;
    const channel = this.store.tenant(entry.actor, entry.tenantId).channels.find(item => item.id === entry.channelId);
    if (channel?.kind !== 'whatsapp_qr' || channel.transport !== 'baileys' || channel.enabled === false || !(channel.allowedGroups || []).includes(cursor.key.remoteJid)) return;
    const cursors = entry.historyCursors ||= new Map(), previous = cursors.get(cursor.key.remoteJid);
    if (previous && previous.timestampMs > cursor.timestampMs) return;
    if (!cursors.has(cursor.key.remoteJid) && cursors.size >= 100) cursors.delete(cursors.keys().next().value);
    cursors.set(cursor.key.remoteJid, cursor);
  }
  channel(session, tenantId, channelId) {
    const tenant = this.store.tenant(session, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    if (channel.kind !== 'whatsapp_qr' || channel.transport !== 'baileys') fail(400, 'Este canal não é uma conexão QR real.');
    return { tenant, channel };
  }
  conversationTenant(actor, tenantId, conversationId) {
    const read = typeof this.store.readonlyConversationTenant === 'function' ? this.store.readonlyConversationTenant : this.store.conversationTenant;
    return typeof conversationId === 'string' && conversationId.length > 0 && typeof read === 'function'
      ? read.call(this.store, actor, tenantId, conversationId)
      : this.store.tenant(actor, tenantId);
  }
  // Only callbacks whose writes are confined to this conversation may use this adapter.
  mutateConversation(actor, tenantId, conversationId, action, change) {
    if (typeof conversationId !== 'string' || !conversationId || typeof this.store.mutateConversation !== 'function') return this.store.mutate(actor, tenantId, action, change);
    return this.store.mutateConversation(actor, tenantId, conversationId, action,
      (conversation, metadata) => change({ ...metadata, conversations: [conversation] }));
  }
  lookupConversationIds(entry, kind, values) {
    const model = this.store.serviceReadModel;
    if (typeof model?.lookupConversationIds !== 'function') return null;
    const ids = model.lookupConversationIds({ tenantId: entry.tenantId, workspaceId: entry.actor.resellerId, channelId: entry.channelId, kind, values });
    // Only an array proves complete coverage. null (or an older read model) retains the canonical lookup below.
    return Array.isArray(ids) ? ids : null;
  }
  incomingConversationRecord(entry, aliases) {
    const ids = this.lookupConversationIds(entry, 'address', aliases);
    if (ids !== null) return ids.length ? { id: ids[0] } : undefined;
    return this.store.db.prepare(`SELECT json_extract(c.value,'$.id') AS id FROM tenants t,json_each(${effectiveTenantDataSql(this.store.db, 't')},'$.conversations') c
      WHERE t.id=? AND t.reseller_id=? AND json_extract(c.value,'$.channelId')=?
      AND (json_extract(c.value,'$.remoteJid') IN (SELECT value FROM json_each(?))
        OR EXISTS(SELECT 1 FROM json_each(c.value,'$.remoteAliases') a WHERE a.value IN (SELECT value FROM json_each(?))))
      ORDER BY CAST(c.key AS INTEGER) LIMIT 1`).get(entry.tenantId, entry.actor.resellerId, entry.channelId, JSON.stringify(aliases), JSON.stringify(aliases));
  }
  status(session, tenantId, channelId) {
    this.store.admin(session); const { channel } = this.channel(session, tenantId, channelId), entry = this.entries.get(channelId);
    return { state: entry?.state || 'disconnected', qr: entry?.qr || null, error: entry?.error || null, label: channel.label, expectedNumberMatched: entry?.matched || false, historySync: false, failureReason: entry?.failureReason || null, nextRetryAt: entry?.nextRetryAt || null };
  }
  async avatar(session, tenantId, channelId, { peer, signal, fetchImpl = this.avatarFetch } = {}) {
    try {
      const { channel } = this.channel(session, tenantId, channelId), entry = this.entries.get(channelId);
      const active = () => !this.closing && this.entries.get(channelId) === entry && entry?.tenantId === tenantId && entry.matched && entry.state === 'connected' && !signal?.aborted;
      if (!active() || typeof entry.socket?.profilePictureUrl !== 'function') return null;
      const jid = peer || jidNormalizedUser(entry.socket.user?.id || '');
      if (!/^(?:\d+(?::\d+)?@(s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(jid)) return null;
      if (jid.endsWith('@g.us') && !(channel.allowedGroups || []).includes(jid)) return null;
      if (!peer && !whatsappNumbersMatch(entry.expectedNumber, jid.split('@')[0])) return null;
      const url = await entry.socket.profilePictureUrl(jid, 'preview', 5000);
      if (!active() || typeof url !== 'string' || url.length > 16000 || /[\r\n\\]/.test(url)) return null;
      const parsed = new URL(url);
      if (parsed.origin !== 'https://pps.whatsapp.net' || parsed.username || parsed.password || parsed.hash) return null;
      const boundedSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10000)]);
      const response = await fetchImpl(parsed.href, { method: 'GET', redirect: 'error', signal: boundedSignal });
      const image = await readAvatarResponse(response, boundedSignal);
      return active() ? image : null;
    } catch { return null; }
  }
  groupAuthority(session, tenantId, channelId, reauthorize = () => {}) {
    if (typeof reauthorize !== 'function') fail(400, 'Informe uma validação de sessão válida.');
    const identity = [session?.userId, session?.resellerId, session?.supportGrantId || null, session?.kind || null];
    let observed;
    return () => {
      const result = reauthorize();
      if (result?.then) { Promise.resolve(result).catch(() => {}); fail(400, 'A validação de sessão precisa ser síncrona.'); }
      const currentIdentity = [session?.userId, session?.resellerId, session?.supportGrantId || null, session?.kind || null];
      if (identity.some((value, index) => value !== currentIdentity[index])) fail(403, 'O contexto de administração mudou.');
      if (session?.kind === 'service') fail(403, 'Um serviço não administra a seleção de grupos.');
      this.store.admin(session); this.operations?.admin(session);
      const { tenant, channel } = this.channel(session, tenantId, channelId), entry = this.entries.get(channelId);
      if (this.closing || !entry?.matched || entry.state !== 'connected' || channel.state !== 'connected') fail(409, 'Conecte o número antes de escolher os grupos.');
      if (entry.tenantId !== tenantId || entry.channelId !== channelId || entry.actor?.resellerId !== tenant.resellerId || entry.expectedNumber !== channel.expectedNumber || observed && (entry !== observed.entry || entry.generation !== observed.generation || channel.expectedNumber !== observed.expectedNumber)) fail(409, 'A conexão mudou. Atualize e tente novamente.');
      observed ||= { entry, generation: entry.generation, expectedNumber: channel.expectedNumber };
      return { tenant, channel, entry };
    };
  }
  async groups(session, tenantId, channelId, { reauthorize = () => {} } = {}) {
    const fresh = this.groupAuthority(session, tenantId, channelId, reauthorize);
    const { entry } = fresh();
    let groups;
    try { groups = await entry.socket.groupFetchAllParticipating(); } catch { fresh(); fail(502, 'Não foi possível consultar os grupos deste número.'); }
    const { channel } = fresh();
    for (const group of Object.values(groups)) entry.groupCache.set(group.id, group);
    return { tenantId, channelId, version: channel.whatsappGroupsVersion || 0, groups: Object.values(groups).map(group => ({ id: group.id, name: group.subject || 'Grupo WhatsApp', selected: (channel.allowedGroups || []).includes(group.id), announcement: Boolean(group.announce) })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) };
  }
  async setGroups(session, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    const fresh = this.groupAuthority(session, tenantId, channelId, reauthorize);
    fresh();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['version', 'groupIds'].includes(key)) || !Number.isSafeInteger(input.version) || input.version < 0 || input.version >= Number.MAX_SAFE_INTEGER || !Array.isArray(input.groupIds) || input.groupIds.length > 100 || input.groupIds.some(id => typeof id !== 'string')) fail(400, 'Informe a versão e até 100 grupos desta conexão.');
    const { groups, version } = await this.groups(session, tenantId, channelId, { reauthorize }), selected = [...new Set(input.groupIds)];
    fresh();
    if (version !== input.version) fail(409, 'A seleção mudou. Atualize antes de salvar.');
    if (selected.some(id => !groups.some(group => group.id === id))) fail(400, 'Um grupo não pertence a este número.');
    this.store.mutate(session, tenantId, 'WhatsApp: grupos de atendimento atualizados', state => {
      fresh();
      const channel = state.channels.find(item => item.id === channelId);
      if (!channel || channel.kind !== 'whatsapp_qr' || channel.transport !== 'baileys') fail(409, 'O canal mudou. Atualize a seleção.');
      if ((channel.whatsappGroupsVersion || 0) !== input.version) fail(409, 'A seleção mudou. Atualize antes de salvar.');
      channel.allowedGroups = selected; channel.groupNames = Object.fromEntries(groups.filter(group => selected.includes(group.id)).map(group => [group.id, group.name])); channel.whatsappGroupsVersion = input.version + 1;
      prepareSelectedGroupConversations(state,channel);
    });
    const cursors = this.entries.get(channelId)?.historyCursors;
    for (const id of cursors?.keys() || []) if (!selected.includes(id)) cursors.delete(id);
    return { tenantId, channelId, version: input.version + 1, enabledGroups: selected.length };
  }
  updateChannel(entry, state, detail = {}, { persist = true } = {}) {
    entry.state = state;
    if (!['failed', 'reconnecting'].includes(state)) { entry.failureReason = null; entry.nextRetryAt = null; }
    // Transições internas da retentativa lenta ficam só em memória (status() lê a entrada), sem regravar empresa/auditoria.
    if (!persist) return;
    // failureReason espelha a entrada; nextRetryAt muda a cada rodada e só existe no status(). null remove o campo persistido.
    const changes = { failureReason: entry.failureReason || null, nextRetryAt: null, ...detail };
    this.store.mutate(entry.actor, entry.tenantId, `WhatsApp: ${state}`, tenant => {
      const channel = tenant.channels.find(item => item.id === entry.channelId);
      if (channel) { channel.state = state; channel.lastStateAt = new Date().toISOString(); for (const [key, value] of Object.entries(changes)) { if (value === null || value === undefined) delete channel[key]; else channel[key] = value; } }
    });
  }
  /** Depois das tentativas rápidas, mantém uma tentativa lenta e limitada; nunca para 401/440/403. */
  scheduleSlowRetry(entry, code) {
    clearTimeout(entry.timer);
    if (this.closing || this.entries.get(entry.channelId) !== entry) return;
    const badSession = code === DisconnectReason.badSession, minutes = Math.max(1, Math.round(this.slowRetryDelay / 60_000));
    const exhausted = !entry.expected || (entry.slowAttempts || 0) >= this.slowRetryLimit, previousReason = entry.failureReason;
    entry.failureReason = badSession ? 'bad_session' : 'unstable';
    entry.nextRetryAt = exhausted ? null : new Date(this.now() + this.slowRetryDelay).toISOString();
    entry.error = badSession
      ? exhausted ? 'O WhatsApp recusou a sessão salva (erro 500). Remova este aparelho em Aparelhos conectados no celular e gere um novo QR.' : `O WhatsApp recusou a sessão salva (erro 500). Nova tentativa automática em ${minutes} min; se persistir, gere um novo QR.`
      : exhausted ? 'A conexão não estabilizou. Tente novamente.' : `A conexão não estabilizou. Nova tentativa automática em ${minutes} min.`;
    // Grava a entrada na retentativa lenta, a troca de motivo e o esgotamento; rodadas repetidas não regravam a empresa.
    const persist = !entry.slowAttempts || exhausted || previousReason !== entry.failureReason;
    try { this.updateChannel(entry, 'failed', {}, { persist }); } catch { /* O estado em memória continua válido para o painel. */ }
    if (exhausted) return;
    entry.timer = setTimeout(() => {
      if (this.closing || this.entries.get(entry.channelId) !== entry || entry.state !== 'failed') return;
      entry.slowAttempts = (entry.slowAttempts || 0) + 1; entry.attempts = 0; entry.nextRetryAt = null;
      this.updateChannel(entry, 'reconnecting', {}, { persist: false });
      this.openSocket(entry).catch(() => this.scheduleSlowRetry(entry));
    }, this.slowRetryDelay);
    entry.timer.unref?.();
  }
  async start(session, tenantId, channelId) {
    this.store.admin(session); const { tenant, channel } = this.channel(session, tenantId, channelId);
    this.reserveNumber(channel, tenantId);
    const existing = this.entries.get(channelId);
    if (existing && ['starting', 'qr', 'connecting', 'connected', 'reconnecting'].includes(existing.state)) return this.status(session, tenantId, channelId);
    if (existing) { clearTimeout(existing.timer); existing.socket?.end(new Error('Nova tentativa solicitada.')); }
    const wipe = ['logged_out', 'wrong_number'].includes(existing?.state || channel.state);
    if (wipe) {
      this.store.db.exec('CREATE TABLE IF NOT EXISTS wa_auth (channel_id TEXT NOT NULL, category TEXT NOT NULL, item_id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(channel_id,category,item_id))');
      this.store.db.prepare('DELETE FROM wa_auth WHERE channel_id=?').run(channelId);
    }
    // expected vem da sessão salva (openSocket) ou do open: um QR novo nunca escaneado não entra na retentativa lenta.
    const entry = { channelId, tenantId, actor: this.actor(tenant.resellerId), expectedNumber: channel.expectedNumber, state: 'starting', qr: null, qrVersion: 0, error: null, matched: false, attempts: 0, slowAttempts: 0, failureReason: null, nextRetryAt: null, expected: false, generation: 0, groupCache: new Map(), historyCursors: new Map() };
    this.entries.set(channelId, entry);
    // Sessão apagada: o vínculo anterior deixa de valer e o restore não retoma o QR pendente no boot.
    this.updateChannel(entry, 'starting', wipe ? { linkedAt: null } : {});
    try { this.authKey ||= await loadLocalKey(); await this.openSocket(entry); }
    catch { entry.error = 'Não foi possível iniciar a conexão. Tente novamente.'; this.updateChannel(entry, 'failed'); }
    return this.status(session, tenantId, channelId);
  }
  async openSocket(entry) {
    if (this.closing || this.entries.get(entry.channelId) !== entry) return;
    const generation = ++entry.generation;
    entry.matched = false;
    entry.historyCursors = new Map();
    entry.historyTail = Promise.resolve(); this.historyImporter?.connectionChanged?.(entry);
    const current = () => !this.closing && this.entries.get(entry.channelId) === entry && entry.generation === generation;
    const auth = encryptedAuthState(this.store.db, entry.channelId, this.authKey);
    auth.saveCreds();
    if (linkedCreds(auth.state.creds)) entry.expected = true;
    const socket = this.socketFactory({ auth: auth.state, logger: createReadSyncLogger({ now: this.now, onRead: evidence => this.applyDeviceReadSync(entry, evidence, current) }), browser: Browsers.macOS('Chrome'), syncFullHistory: false, shouldSyncHistoryMessage: notification => current() && entry.matched === true && this.historyImporter?.acceptsHistory(entry, notification) === true, markOnlineOnConnect: false, generateHighQualityLinkPreview: false, connectTimeoutMs: 20000, defaultQueryTimeoutMs: 20000, shouldIgnoreJid: jid => jid.endsWith('@broadcast') || jid.endsWith('@newsletter'), cachedGroupMetadata: async jid => entry.groupCache.get(jid), getMessage: async () => undefined });
    entry.socket = socket;
    socket.ev.on('groups.update', groups => {
      if (!current()) return;
      for (const group of groups) {
        entry.groupCache.delete(group.id);
        if (group.subject) this.store.mutate(entry.actor, entry.tenantId, 'WhatsApp: título do grupo atualizado', tenant => {
          const channel = tenant.channels.find(item => item.id === entry.channelId);
          if ((channel.allowedGroups || []).includes(group.id)) { channel.groupNames ||= {}; channel.groupNames[group.id] = group.subject; }
          for (const conversation of tenant.conversations) if (conversation.channelId === entry.channelId && conversation.remoteJid === group.id) conversation.contact = group.subject.slice(0, 80);
        });
      }
    });
    socket.ev.on('group-participants.update', event => { if (current()) entry.groupCache.delete(event.id); });
    // Saved names of the phone's address book (whatsapp-agenda.js); push names in contacts.update carry no `name` and are ignored.
    const onContacts = contacts => { if (current() && entry.matched) this.agenda(entry, contacts); };
    socket.ev.on('contacts.upsert', onContacts); socket.ev.on('contacts.update', onContacts);
    socket.ev.on('creds.update', () => { if (current()) { try { auth.saveCreds(); } catch { entry.error = 'Falha ao preservar a sessão local.'; socket.end(new Error('Persistência de sessão falhou.')); } } });
    socket.ev.on('connection.update', async update => {
      if (!current()) return;
      try {
        if (update.qr && !entry.matched) {
          const qrVersion = ++entry.qrVersion;
          const qr = await QRCode.toDataURL(update.qr, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
          if (current() && !entry.matched && entry.qrVersion === qrVersion) { entry.qr = qr; entry.error = null; this.updateChannel(entry, 'qr'); }
        }
        if (update.connection === 'open') {
          const ownNumber = jidNormalizedUser(socket.user?.id || auth.state.creds.me?.id || '').split('@')[0];
          entry.qr = null; entry.qrVersion++;
          if (!whatsappNumbersMatch(entry.expectedNumber, ownNumber)) {
            entry.error = 'O WhatsApp escaneado não corresponde ao número de teste cadastrado.';
            entry.matched = false; entry.generation++; entry.historyCursors.clear(); this.historyImporter?.connectionChanged?.(entry);
            try { await socket.logout('Número diferente do esperado'); } catch { socket.end(new Error('Número diferente do esperado')); }
            this.updateChannel(entry, 'wrong_number'); return;
          }
          entry.matched = true; entry.expected = true; entry.attempts = 0; entry.slowAttempts = 0; entry.failureReason = null; entry.nextRetryAt = null; entry.error = null; auth.saveCreds();
          this.updateChannel(entry, 'connected', { label: maskNumber(ownNumber), linkedAt: new Date().toISOString() });
        }
        if (update.connection === 'close') {
          entry.generation++; entry.qrVersion++; entry.historyCursors.clear(); this.historyImporter?.connectionChanged?.(entry); clearTimeout(entry.timer);
          entry.qr = null; entry.matched = false;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) { entry.error = 'O aparelho foi desconectado no WhatsApp. Gere um novo QR.'; this.updateChannel(entry, 'logged_out'); return; }
          if (code === DisconnectReason.connectionReplaced) { entry.error = 'Esta sessão foi aberta em outro local. Reconecte manualmente.'; this.updateChannel(entry, 'disconnected'); return; }
          if (code === DisconnectReason.forbidden) {
            // Conta restrita/banida: repetir só agrava a situação. A sessão salva é preservada para reconexão manual.
            entry.error = 'O WhatsApp restringiu ou bloqueou este número (403). Resolva no aplicativo do WhatsApp e reconecte manualmente.';
            entry.failureReason = 'restricted'; entry.nextRetryAt = null; this.updateChannel(entry, 'failed'); return;
          }
          if (entry.attempts >= 5) { this.scheduleSlowRetry(entry, code); return; }
          entry.attempts++; this.updateChannel(entry, 'reconnecting', {}, { persist: !entry.slowAttempts });
          const delay = code === DisconnectReason.restartRequired ? 200 : Math.min(this.reconnectDelay * 2 ** (entry.attempts - 1), 30000);
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => { this.openSocket(entry).catch(() => this.scheduleSlowRetry(entry)); }, delay);
        }
      } catch { if (current()) { entry.error = 'Falha ao atualizar a conexão.'; this.updateChannel(entry, 'failed'); } }
    });
    socket.ev.on('messages.upsert', async event => {
      if (!current() || !entry.matched || !['notify', 'append'].includes(event.type)) return;
      // O Baileys entrega como 'append' o que chegou com o socket offline (deploy, reinício, queda) e já confirmou ao
      // WhatsApp. Histórico chega por messaging-history.set; o append recente segue o mesmo dedupe de wa_seen.
      const backlog = event.type === 'append', media = backlog ? [] : null;
      for (const message of event.messages) {
        if (backlog && !this.recentBacklog(message)) continue;
        try { await this.receive(entry, message, { backlog, media }); } catch { entry.error = 'Uma mensagem não pôde ser registrada.'; }
      }
      // Backlog chega em rajada: todo o texto é registrado antes e a mídia é capturada em lotes, sem lotar a fila de captura
      // (o excedente viraria arquivo indisponível). Encerrando, o restante fica pendente e o boot o reconcilia.
      for (const capture of media || []) {
        while (!this.closing && this.mediaTasks.size >= BACKLOG_MEDIA_CONCURRENCY) await Promise.race(this.mediaTasks);
        if (this.closing) return;
        capture();
      }
    });
    socket.ev.on('messaging-history.set', event => {
      if (!current() || !entry.matched || !this.historyImporter) return;
      const task = (entry.historyTail || Promise.resolve()).then(() => {
        if (current() && entry.matched && this.historyImporter?.acceptsHistory(entry, event)) return this.historyImporter.receive(entry, event);
      }).catch(() => { if (current()) entry.error = 'Não foi possível concluir a importação deste histórico.'; });
      entry.historyTail = task; this.historyTasks.add(task); task.finally(() => this.historyTasks.delete(task));
    });
    socket.ev.on('messages.update', updates => {
      if (!current() || !entry.matched) return;
      for (const { key, update } of updates) {
        if (update.status == null || !key?.id) continue;
        const statuses = proto.WebMessageInfo.Status;
        const delivery = update.status === statuses.ERROR ? 'failed' : update.status >= statuses.READ ? 'read' : update.status >= statuses.DELIVERY_ACK ? 'delivered' : update.status >= statuses.SERVER_ACK ? 'sent' : 'pending';
        const ids = typeof key.id === 'string' ? this.lookupConversationIds(entry, 'external', [key.id]) : null;
        const candidates = ids !== null ? ids.map(id => ({ id, occurrences: 1 })) : this.store.db.prepare(`SELECT json_extract(c.value,'$.id') AS id,count(*) AS occurrences
          FROM tenants t,json_each(${effectiveTenantDataSql(this.store.db, 't')},'$.conversations') c
          WHERE t.id=? AND t.reseller_id=? GROUP BY json_extract(c.value,'$.id')
          HAVING max(CASE WHEN json_extract(c.value,'$.channelId')=?
            AND EXISTS(SELECT 1 FROM json_each(c.value,'$.messages') m WHERE json_extract(m.value,'$.externalId')=?) THEN 1 ELSE 0 END)=1`)
          .all(entry.tenantId, entry.actor.resellerId, entry.channelId, key?.id);
        const applyReceipt = tenant => {
          if (!current() || !entry.matched || entry.state !== 'connected') return;
          const liveChannel = tenant.channels.find(item => item.id === entry.channelId);
          if (liveChannel?.kind !== 'whatsapp_qr' || liveChannel.transport !== 'baileys' || liveChannel.enabled === false) return;
          for (const conversation of tenant.conversations) if (conversation.channelId === entry.channelId) for (const message of conversation.messages) {
            if (!receiptMatches(conversation, message, key)) continue;
            // The installed Baileys emits read-self as READ with fromMe=false. READ of our outgoing text is the customer's receipt.
            // Group user receipts identify the reader, not necessarily the inbound author; do not infer group device reads.
            if (key.fromMe === false && message.kind === 'customer' && !key.remoteJid.endsWith('@g.us') && update.status >= statuses.READ) reconcileDeviceRead(conversation, message, this.now(), 'inbound-receipt', providerReadMilliseconds(update.messageTimestamp, this.now(), { seconds: true }));
            const previous = deliveryRank[message.delivery] || 0, next = deliveryRank[delivery] || 0;
            if (delivery === 'failed') {
              if (previous < deliveryRank.delivered) {
                message.delivery = 'failed';
                const code = update.messageStubParameters?.[0];
                if (typeof code === 'string' && /^\d{1,6}$/.test(code)) message.deliveryErrorCode = code;
              }
            }
            else if (message.delivery === 'failed' && next < deliveryRank.delivered) continue;
            else if (next >= previous) { message.delivery = delivery; if (next >= deliveryRank.delivered) delete message.deliveryErrorCode; }
          }
        };
        const reconcileFullReceipt = () => {
          try {
            const before = this.store.tenant(entry.actor, entry.tenantId), channel = before.channels.find(item => item.id === entry.channelId);
            if (channel?.kind === 'whatsapp_qr' && channel.transport === 'baileys' && channel.enabled !== false
              && before.conversations.some(conversation => conversation.channelId === entry.channelId && conversation.messages.some(message => receiptMatches(conversation, message, key)))) this.store.mutate(entry.actor, entry.tenantId, 'WhatsApp: recibo de mensagem', applyReceipt);
          } catch (error) { if (error?.status !== 404) throw error; }
        };
        if (candidates.some(candidate => typeof candidate.id !== 'string' || !candidate.id || candidate.occurrences > 1)) {
          // Legacy rows may have missing/duplicate IDs. A scoped id cannot address the same set of occurrences.
          reconcileFullReceipt();
          continue;
        }
        for (const candidate of candidates) {
          try {
            const before = this.conversationTenant(entry.actor, entry.tenantId, candidate.id), channel = before.channels.find(item => item.id === entry.channelId);
            if (channel?.kind !== 'whatsapp_qr' || channel.transport !== 'baileys' || channel.enabled === false) continue;
            if (!before.conversations.some(conversation => conversation.channelId === entry.channelId && conversation.messages.some(message => receiptMatches(conversation, message, key)))) continue;
            this.mutateConversation(entry.actor, entry.tenantId, candidate.id, 'WhatsApp: recibo de mensagem', applyReceipt);
          } catch (error) {
            if (error?.status !== 404) throw error;
            // A canonical writer may remove/reindex a conversation after discovery. Reconcile the current receipt once.
            reconcileFullReceipt(); break;
          }
        }
      }
    });
  }
  async beginConversation(session, tenantId, input) {
    const { channel } = this.channel(session, tenantId, input.channelId), entry = this.entries.get(channel.id);
    if (!entry?.matched || entry.state !== 'connected') fail(409, 'O número de origem não está conectado.');
    const number = normalizeNumber(input.number), name = input.name ? text(input.name, 80) : `Contato · ${number.slice(-4)}`;
    let account;
    try { account = (await entry.socket.onWhatsApp(number))?.find(item => item.exists); }
    catch { fail(502, 'Não foi possível conferir o contato no WhatsApp. Tente novamente.'); }
    if (!account?.jid || !account.jid.endsWith('@s.whatsapp.net')) fail(400, 'Este contato não foi encontrado no WhatsApp.');
    if (this.entries.get(channel.id) !== entry || !entry.matched || entry.state !== 'connected') fail(409, 'A conexão mudou. Atualize antes de abrir a conversa.');
    const remoteJid = jidNormalizedUser(account.jid), aliases = [remoteJid, number + '@s.whatsapp.net'];
    return this.store.mutate(session, tenantId, 'WhatsApp: conversa aberta pelo atendente', tenant => {
      let conversation = tenant.conversations.find(item => item.channelId === channel.id && [item.remoteJid, ...(item.remoteAliases || [])].some(jid => aliases.includes(jid)));
      if(conversation&&input.contactId&&conversation.contactId&&conversation.contactId!==input.contactId)fail(409,'Esta conversa já está vinculada a outro contato. Revise o vínculo no CRM.');
      if(conversation){if(this.operations?.auth&&!this.operations.auth.can(session,'inbox.read',{tenantId,channelId:channel.id,departmentId:conversation.departmentId||this.operations.currentDepartment(tenant,conversation)?.id||'unassigned'}))fail(403,'Seu acesso não permite abrir este atendimento.');if(conversation.status==='closed'){const previous=conversation.status;conversation.status='open';clearConversationParticipants(conversation,session,{origin:'contact',reason:'Atendimento reaberto pelo contato.'});conversation.owner='queue';conversation.assignedUserId=null;conversation.assignedUserName=null;conversation.agentId=null;noteStatus(conversation,session,previous,{origin:'contact'});conversation.version++;conversation.updatedAt=new Date().toISOString();}if(input.contactId)conversation.contactId=input.contactId;syncConversationContact(tenant,conversation,channel);return conversation;}
      const department=(tenant.departments||[]).find(d=>d.active!==false&&d.id===tenant.defaultDepartmentId);
      if(this.operations?.auth&&!this.operations.auth.can(session,'inbox.reply',{tenantId,channelId:channel.id,departmentId:department?.id||'unassigned'}))fail(403,'Seu acesso não permite abrir um atendimento neste departamento.');
      conversation = { id: randomUUID(), contact: name, initials: name.slice(0, 2).toUpperCase(), channelId: channel.id, remoteJid, remoteAliases: [...new Set(aliases)], conversationKind:'direct',department: department?.name||'Suporte',departmentId:department?.id||null, owner: 'queue',assignedUserId:null, status: 'open', version: 1, unread: 0, agentId: null, tags: ['WhatsApp real'], messages: [], updatedAt: new Date().toISOString(),...(input.contactId?{contactId:input.contactId}:{}) };
      tenant.conversations.unshift(conversation);syncConversationContact(tenant,conversation,channel);return conversation;
    });
  }
  /** Opaque command authority is minted by ServiceNotifications; never by HTTP input.
   * Product notices preserve attendant ownership and never invoke a model. */
  async sendNotification(command,providerStarting) {
    const authorize=()=>{if(typeof this.notificationAuthority!=='function')fail(403,'Envio transacional indisponível.');return this.notificationAuthority(command);};
    const initial=authorize(),{actor,tenantId,channelId,number}=initial,{channel}=this.channel(actor,tenantId,channelId),entry=this.entries.get(channelId);
    const connected=()=>{const fresh=authorize(),current=this.channel(fresh.actor,tenantId,channelId).channel;
      if(this.closing||this.entries.get(channelId)!==entry||!entry?.matched||entry.state!=='connected'||current.expectedNumber!==channel.expectedNumber||entry.expectedNumber!==current.expectedNumber)fail(409,'O canal exclusivo não está conectado.');return fresh;};
    connected();
    const account=(await entry.socket.onWhatsApp(number))?.find(item=>item.exists);
    if(!account?.jid?.endsWith('@s.whatsapp.net')||!whatsappNumbersMatch(number,account.jid.split('@')[0])||whatsappNumbersMatch(number,channel.expectedNumber))fail(400,'Destinatário WhatsApp inválido para este aviso.');
    connected();
    const remoteJid=jidNormalizedUser(account.jid),aliases=[remoteJid,...brazilianMobileAliases(number).map(n=>n+'@s.whatsapp.net')],messageId=randomUUID(),externalId=generateMessageIDV2(entry.socket.user.id);
    let conversationId;
    this.store.mutate(actor,tenantId,'WhatsApp: aviso transacional solicitado',tenant=>{
      const fresh=connected();
      let c=tenant.conversations.find(c=>c.channelId===channelId&&c.conversationKind!=='group'&&[c.remoteJid,...(c.remoteAliases||[])].some(j=>aliases.includes(j)));
      if(!c){c={id:randomUUID(),contact:`Contato · ${number.slice(-4)}`,initials:'CT',channelId,remoteJid,remoteAliases:aliases,conversationKind:'direct',department:'Suporte',departmentId:null,owner:'queue',assignedUserId:null,status:'open',version:1,unread:0,agentId:null,tags:['WhatsApp real'],messages:[]};tenant.conversations.unshift(c);}
      conversationId=c.id;
      c.messages.push({id:messageId,externalId,kind:'agent',text:fresh.text,authorName:fresh.actor.name,authorServiceId:fresh.actor.serviceId,agentId:fresh.actor.agentId,notificationRequestId:fresh.requestId,notificationReceiptId:fresh.receiptId,createdAt:new Date(this.now()).toISOString(),delivery:'pending',transport:'whatsapp'});
      this.store.db.prepare('INSERT OR IGNORE INTO wa_seen VALUES (?,?,?)').run(channelId,remoteJid,externalId);
      c.version++;c.updatedAt=new Date(this.now()).toISOString();
    });
    let started=false;
    try{
      const fresh=connected();providerStarting();started=true;
      const sent=await entry.socket.sendMessage(remoteJid,{text:fresh.text},{messageId:externalId});
      if(!sent?.key?.id)throw Error('missing provider ACK');
      this.store.mutate(actor,tenantId,'WhatsApp: aviso aceito pelo provedor',tenant=>{const m=this.store.getConversation(tenant,conversationId).messages.find(m=>m.id===messageId);m.externalId=sent.key.id;if(m.delivery==='pending'||m.delivery==='unconfirmed')m.delivery='sent';this.store.db.prepare('INSERT OR IGNORE INTO wa_seen VALUES (?,?,?)').run(channelId,remoteJid,sent.key.id);});
      return {conversationId,messageId,externalId:sent.key.id};
    }catch(error){
      this.store.mutate(actor,tenantId,'WhatsApp: resultado do aviso pendente',tenant=>{const m=this.store.getConversation(tenant,conversationId).messages.find(m=>m.id===messageId);if(m.delivery==='pending')m.delivery=started?'unconfirmed':'failed';});
      throw error;
    }
  }
  /**
   * Channel default agent (channel.defaultAgentId): a new or reopened direct attendance starts owned by a connected MCP
   * copilot agent instead of the queue. A reopened one returns to the agent that owned it when it closed, when still valid.
   * Late backlog, messages sent from the phone and attendances with a person keep the ordinary queue and routing.
   */
  assignChannelAgent(tenant, channel, conversation, closingAgentId, actor, tenantId = tenant.id) {
    if (!channel?.defaultAgentId || typeof this.operations?.applyAssignment !== 'function' || conversation.assignedUserId || conversation.participants?.length) return;
    const usable = id => id ? (tenant.agents || []).find(agent => agent.id === id && agent.provider === 'mcp' && agent.mode === 'copilot' && agent.configured === true) : null;
    const returning = usable(closingAgentId), agent = returning || usable(channel.defaultAgentId);
    if (!agent) return;
    // Another line of this operation already answered by an agent: leave this side to the team (own-lines.js).
    if (this.ownLines?.blocksAgent(tenantId, conversation, { action: 'default-agent', state: tenant })) return;
    this.operations.applyAssignment(conversation, actor, { owner: 'agent', agent, origin: 'channel-default-agent',
      reason: returning ? 'Atendimento reaberto com o agente que o encerrou.' : 'Agente padrão do canal.' });
  }
  recentBacklog(message) { const sentAt = timestampSeconds(message?.messageTimestamp); return sentAt !== null && this.now() - sentAt * 1000 <= this.backlogWindowMs; }
  /**
   * Decrypted vote of a poll this line sent in this conversation: { pollMessageId (Elozi id), selectedOptions }, or null.
   * The creator is this line and the voter is the contact, each by phone JID or LID (whatsapp-polls.js tries the pairs).
   */
  pollVote(entry, conversation, update, key, aliases) {
    const pollId = update.pollCreationMessageKey.id;
    const poll = conversation?.messages?.find(item => item?.externalId === pollId && item.transport === 'whatsapp' && ['agent', 'human'].includes(item.kind) && Array.isArray(item.poll?.options));
    if (!poll || !this.authKey) return null;
    const me = entry.socket?.authState?.creds?.me, creatorJids = [entry.socket?.user?.id, entry.socket?.user?.lid, me?.id, me?.lid, update.pollCreationMessageKey.remoteJid];
    const voterJids = [key.remoteJid, key.remoteJidAlt, ...aliases, conversation.remoteJid, ...(conversation.remoteAliases || [])];
    try {
      const result = decryptPollSelection(update, { secret: pollSecret(this.authKey, entry.channelId, poll.id), pollMessageId: pollId, options: poll.poll.options, creatorJids, voterJids });
      return result.state === 'ok' ? { pollMessageId: poll.id, selectedOptions: result.selectedOptions } : null;
    } catch { return null; }
  }
  async receive(entry, message, { backlog = false, media = null } = {}) {
    if (this.closing || this.entries.get(entry.channelId) !== entry || !entry.matched) return;
    const key = message.key, observedJid = key?.remoteJid, generation = entry.generation;
    const group = observedJid?.endsWith('@g.us');
    if (!key?.id || !observedJid || !['@s.whatsapp.net', '@lid', '@g.us'].some(suffix => observedJid.endsWith(suffix))) return;
    // Header only (no conversation histories; parse reused by header token): this runs for every group message, also of groups that are not allowed.
    if (group && !(this.store.readonlyTenantHeader(entry.actor, entry.tenantId).channels.find(item => item.id === entry.channelId).allowedGroups || []).includes(observedJid)) return;
    // Âncora de histórico continua exclusiva do tráfego ao vivo; o backlog offline não a reposiciona.
    if (group && !backlog) this.rememberHistoryCursor(entry, message, generation);
    const reaction = incomingReaction(message);
    if (reaction && !reaction.emoji) return; // Reação removida ou texto que não é emoji: não há conteúdo novo confiável.
    // Voto numa enquete enviada por esta linha (whatsapp-polls.js): só do contato de uma conversa direta que já existe.
    const vote = reaction ? null : incomingPollUpdate(message.message);
    if (vote && (group || key.fromMe)) return;
    const mediaItem = reaction || vote ? null : incomingMedia(message.message), content = reaction || vote ? '' : extractText(message.message) || unsupportedText(message);
    if (!reaction && !vote && !content && !mediaItem) return;
    const aliases = group ? [observedJid] : [observedJid, key.remoteJidAlt].filter(jid => typeof jid === 'string' && ['@s.whatsapp.net', '@lid'].some(suffix => jid.endsWith(suffix))).map(jidNormalizedUser);
    if (!group && observedJid.endsWith('@lid') && !aliases.some(jid => jid.endsWith('@s.whatsapp.net'))) {
      try {
        const mapped = await entry.socket.signalRepository?.lidMapping?.getPNForLID(jidNormalizedUser(observedJid));
        if (typeof mapped === 'string' && mapped.endsWith('@s.whatsapp.net')) aliases.push(jidNormalizedUser(mapped));
      } catch { /* Sem vínculo conhecido, preserva a mensagem pela identidade LID. */ }
      if (this.closing || this.entries.get(entry.channelId) !== entry || entry.generation !== generation || !entry.matched) return;
    }
    const remoteJid = group ? observedJid : aliases.find(jid => jid.endsWith('@s.whatsapp.net')) || jidNormalizedUser(observedJid);
    // Replays e ecos dos próprios envios (emitOwnEvents chega como 'append') saem sem regravar a empresa. O envio grava
    // wa_seen pelo JID da conversa (que pode ser o LID), então a consulta cobre todos os aliases desta mensagem.
    const seen = this.store.db.prepare('SELECT 1 FROM wa_seen WHERE channel_id=? AND remote_jid=? AND message_id=?');
    if ([...new Set([remoteJid, ...aliases])].some(jid => seen.get(entry.channelId, jid, key.id))) return;
    // Reação só vira nota em conversa existente; sem conversa, sai sem regravar a empresa nem a auditoria.
    const existing = this.incomingConversationRecord(entry, aliases), existingId = existing?.id;
    if ((reaction || vote) && !existing) return;
    const sentAt = timestampSeconds(message.messageTimestamp), date = new Date((sentAt ?? Math.floor(this.now() / 1000)) * 1000).toISOString();
    // Backlog com mais de backlogAutomationMs entra na fila humana sem fluxo automático fora de contexto.
    const late = backlog && (sentAt === null || this.now() - sentAt * 1000 > this.backlogAutomationMs);
    const fallback = Symbol('incoming-needs-tenant');
    let scoped = false;
    const register = tenant => {
      const channel = tenant.channels.find(item => item.id === entry.channelId);
      if (scoped) {
        const existing = tenant.conversations[0];
        // Creation/reopening can assign an agent through own-lines and CRM can change the tenant's contacts.
        // The read-only identity proof below makes syncIncomingConversationContact an exact no-op for WhatsApp.
        if (!channel || group || existing.channelId !== entry.channelId || existing.status === 'closed'
          || ![existing.remoteJid, ...(existing.remoteAliases || [])].some(jid => aliases.includes(jid))) throw fallback;
        if (!reaction) {
          if (existing.contactSyncStatus !== 'linked') throw fallback;
          try { if (!boundConversationContact(tenant, existing)) throw fallback; }
          catch { throw fallback; }
        }
      }
      if (group && !(channel.allowedGroups || []).includes(remoteJid)) return;
      const inserted = this.store.db.prepare('INSERT OR IGNORE INTO wa_seen VALUES (?,?,?)').run(entry.channelId, remoteJid, key.id);
      if (!inserted.changes) return;
      let conversation = tenant.conversations.find(item => item.channelId === entry.channelId && [item.remoteJid, ...(item.remoteAliases || [])].some(jid => aliases.includes(jid)));
      if (reaction) {
        // Reação vira nota curta na conversa existente: não cria atendimento, não reabre, não conta como não lida nem dispara automação.
        // Também não muda conversation.version: não é contexto novo e não invalida rascunho do Hermes, aprovação MCP nem envio em curso.
        if (!conversation || conversation.messages.some(item => item.externalId === key.id)) return null;
        const target = reaction.targetId ? conversation.messages.find(item => item.externalId === reaction.targetId && ['customer', 'human', 'agent'].includes(item.kind)) : null;
        const name = group && !key.fromMe ? cite(message.pushName, 40) : '', excerpt = cite(target?.text, 80);
        const author = key.fromMe ? 'equipe' : group ? `participante${name ? ` “${name}”` : ''}` : 'contato';
        conversation.messages.push({ id: randomUUID(), externalId: key.id, kind: 'system', text: `Reação ${reaction.emoji} de ${author}${excerpt ? ` em “${excerpt}”` : ''}`, reaction: { emoji: reaction.emoji, ...(target ? { messageId: target.id } : {}) }, createdAt: date, transport: 'whatsapp' });
        return null;
      }
      // O voto vira entrada do contato com a opção como texto. Sem decifrar para uma opção de enquete desta conversa (outra
      // enquete, conversa ou empresa, voto retirado ou adulterado), sai sem registro.
      const pollVote = vote ? this.pollVote(entry, conversation, vote, key, aliases) : null;
      if (vote && !pollVote) return null;
      const newConversation = !conversation;
      // A direct conversation starts with the name saved in the phone when the address book knows it, else the profile name.
      const saved = !conversation && !group ? savedName(agendaNames(this.store.db, entry.channelId), aliases) : null;
      if (!conversation) {
        const name = group ? channel.groupNames?.[remoteJid]?.slice(0, 80) || 'Grupo WhatsApp' : saved || (typeof message.pushName === 'string' ? message.pushName.slice(0, 80) : `Contato · ${remoteJid.split('@')[0].slice(-4)}`);
        const department=(tenant.departments||[]).find(d=>d.active!==false&&d.id===tenant.defaultDepartmentId);
        conversation = { id: randomUUID(), contact: name, initials: name.slice(0, 2).toUpperCase(), channelId: entry.channelId, remoteJid, conversationKind: group ? 'group' : 'direct', department: department?.name||'Suporte',departmentId:department?.id||null, owner: 'queue',assignedUserId:null, status: 'open', version: 1, unread: 0, agentId: null, tags: [group ? 'Grupo WhatsApp' : 'WhatsApp real'], messages: [] };
        if (!group) conversation.contactNameSource = saved ? 'whatsapp-agenda' : 'whatsapp-profile';
        tenant.conversations.unshift(conversation);
      }
      conversation.remoteAliases = [...new Set([conversation.remoteJid, ...(conversation.remoteAliases || []), ...aliases])];
      if (conversation.messages.some(item => item.externalId === key.id)) return;
      const reopened = !key.fromMe && conversation.status === 'closed';
      // Owner at closing time: with a channel default agent, a reopened attendance returns to the connected agent that had it.
      let reopenedEvent = null, closingAgentId = null;
      if(!key.fromMe&&conversation.status==='closed'){closingAgentId=conversation.owner==='agent'?conversation.agentId||null:null;const previous=conversation.status;conversation.status='open';clearConversationParticipants(conversation,entry.actor,{origin:'whatsapp',reason:'Novo atendimento após encerramento.'});conversation.owner='queue';conversation.assignedUserId=null;conversation.assignedUserName=null;conversation.agentId=null;reopenedEvent=noteStatus(conversation,entry.actor,previous,{origin:'whatsapp'});}
      const messageId = randomUUID(), context = { tenantId: entry.tenantId, conversationId: conversation.id, channelId: entry.channelId };
      const attachment = mediaItem ? this.media ? this.media.placeholder(context, mediaItem.descriptor) : { id: randomUUID(), ...mediaItem.descriptor, name: 'Arquivo', status: 'unavailable', preview: false, reason: 'unavailable' } : null;
      const replyToMessageId = incomingReplyId(conversation, message.message);
      // providerJid/providerTs: the provider key this message arrived with, where a later search for older messages can start.
      conversation.messages.push({ id: messageId, externalId: key.id, providerJid: observedJid, ...(sentAt !== null ? { providerTs: sentAt } : {}), kind: key.fromMe ? 'human' : 'customer', text: (pollVote ? pollVote.selectedOptions.join(', ') : content).slice(0, 4000), ...(pollVote ? { pollVote } : {}), ...(attachment ? { attachments: [attachment] } : {}), ...(replyToMessageId ? { replyToMessageId } : {}), ...(group ? { senderName: typeof message.pushName === 'string' ? message.pushName.slice(0, 80) : 'Participante', senderJid: key.participant, senderJidAlt: key.participantAlt } : {}), createdAt: date, delivery: key.fromMe ? 'sent' : 'received', ...(late ? { deliveredLate: true } : {}), transport: 'whatsapp' });
      // Backlog atrasado não passa pela automação de entrada, mas o novo ciclo de SLA (atendimento novo ou reaberto) continua
      // marcado como a automação faria; sem isso a reabertura após uma queda ficaria sem SLA.
      if (late && !key.fromMe && (newConversation || reopenedEvent)) conversation.slaCycle = { startedAt: new Date(this.now()).toISOString(), incomingMessageId: messageId, reopenedEventId: reopenedEvent?.id || null, source: reopenedEvent ? 'gateway-reopened' : 'gateway-new-conversation' };
      if (!group && !key.fromMe && !late && (newConversation || reopened)) this.assignChannelAgent(tenant, channel, conversation, closingAgentId, entry.actor, entry.tenantId);
      // Carimbo do provedor pode ser antigo (backlog): updatedAt nunca recua, como no canal Meta.
      conversation.version++; conversation.updatedAt = new Date(Math.max(Date.parse(conversation.updatedAt) || 0, Date.parse(date))).toISOString();
      const registered = conversation.messages.at(-1);
      if (!key.fromMe && !deviceReadCovers(conversation, registered, this.now())) conversation.unread++;
      if (key.fromMe === true && !backlog && !this.closing && this.entries.get(entry.channelId) === entry && entry.generation === generation
        && entry.matched && entry.state === 'connected' && channel.kind === 'whatsapp_qr' && channel.transport === 'baileys' && channel.enabled !== false) reconcileDeviceRead(conversation, registered, this.now(), 'own-reply', providerReadMilliseconds(registered.providerTs, this.now(), { seconds: true }));
      if (!scoped) syncIncomingConversationContact(tenant,conversation,channel);
      return { conversationId: conversation.id, messageId, newConversation, reopened, conversationVersion: conversation.version, attachment };
    };
    let received;
    if (typeof existingId === 'string' && existingId.length > 0 && !group && typeof this.store.mutateConversation === 'function') {
      scoped = true;
      try { received = this.mutateConversation(entry.actor, entry.tenantId, existingId, 'WhatsApp: mensagem recebida', register); }
      catch (error) { if (error !== fallback && error?.status !== 404) throw error; scoped = false; received = this.store.mutate(entry.actor, entry.tenantId, 'WhatsApp: mensagem recebida', register); }
    } else received = this.store.mutate(entry.actor, entry.tenantId, 'WhatsApp: mensagem recebida', register);
    if(received && !key.fromMe) {
      if (!late) { try { await this.onIncoming?.(entry, received.conversationId, received.messageId, { newConversation: received.newConversation, reopened: received.reopened, conversationVersion: received.conversationVersion }); } catch { entry.error = 'Uma automação não pôde ser aplicada.'; } }
      if(this.operations)this.operations.routeIncoming(entry.tenantId,received.conversationId);
    }
    if (received?.attachment && this.media && mediaItem) {
      const context = { tenantId: entry.tenantId, conversationId: received.conversationId, channelId: entry.channelId };
      const capture = () => {
        const task = this.media.capture(received.attachment.id, context, () => { if (this.closing || this.entries.get(entry.channelId) !== entry || entry.generation !== generation || !entry.matched) fail(409, 'A conexão mudou.'); if (mediaItem.viewOnce) fail(400, 'Arquivo de visualização única não armazenado.'); return this.downloadMedia(mediaItem, entry); }).then(metadata => {
          this.mutateConversation(entry.actor, entry.tenantId, received.conversationId, 'WhatsApp: arquivo registrado', tenant => {
            const current = this.store.getConversation(tenant, received.conversationId), item = current.messages.find(item => item.id === received.messageId);
            if (item) { item.attachments = [metadata]; current.version++; }
          });
        }).catch(() => { entry.error = 'Um arquivo está indisponível.'; }).finally(() => this.mediaTasks.delete(task));
        this.mediaTasks.add(task);
      };
      // No backlog, o handler do upsert captura depois de registrar o texto de toda a rajada.
      if (media) media.push(capture); else capture();
    }
  }
  async send(session, tenantId, conversationId, input, {reauthorize=()=>{}, attribution=null}={}) {
    reauthorize();
    const tenant = this.conversationTenant(session, tenantId, conversationId), conversation = this.store.getConversation(tenant, conversationId, input.version);
    const service = session?.kind === 'service' && session.serviceId && !session.userId;
    // The autopilot answers only conversations owned by its agent; canReply decides through its live execution.
    const autopilot = session?.kind === 'service' && session.autopilot === true && !session.userId && !session.serviceId;
    if ((service || autopilot) && !this.operations?.canReply) fail(403, 'O envio do serviço precisa de autorização explícita.');
    if (autopilot && !automatedAttribution(attribution)) fail(403, 'O envio automático precisa da tarefa e do agente que o autorizaram.');
    this.operations?.canReply(session,tenantId,conversation);
    const channel = tenant.channels.find(item => item.id === conversation.channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    if (channel.kind !== 'whatsapp_qr' || channel.transport !== 'baileys') fail(400, 'Este canal não é uma conexão QR real.');
    const entry = this.entries.get(channel.id);
    if (!entry?.matched || entry.state !== 'connected') fail(409, 'O número não está conectado.');
    if (autopilot ? conversation.owner !== 'agent' : conversation.owner !== 'human' && !service) fail(409, 'Assuma a conversa antes de responder.');
    if (input.channelId !== conversation.channelId) fail(400, 'A resposta precisa usar o canal de origem.');
    if (!conversation.remoteJid) fail(400, 'A conversa não pertence a um WhatsApp real.');
    if (conversation.remoteJid.endsWith('@g.us') && !(channel.allowedGroups || []).includes(conversation.remoteJid)) fail(409, 'Este grupo foi desativado no atendimento.');
    let reply = outgoingReply(conversation, input);
    const ids = attachmentIds(input);
    // Native poll of a connected agent (whatsapp-polls.js): alone, in a direct conversation; its timeline text is the readable line.
    const poll = input.poll === undefined ? null : normalizePoll(input.poll);
    if (poll && (!service || ids.length || reply || conversation.remoteJid.endsWith('@g.us'))) fail(400, 'A enquete vai sozinha, numa conversa direta, pelo agente conectado.');
    const messageText = poll ? pollText(poll) : outgoingText(input, ids.length > 0);
    if (ids.length && !this.media) fail(503, 'Armazenamento de arquivos indisponível.');
    const files = ids.length ? await this.media.resolve(ids, { tenantId, conversationId, channelId: channel.id }) : [];
    reauthorize();
    const file = files[0];
    if (file?.metadata.kind === 'audio' && messageText) fail(400, 'Áudio no WhatsApp deve ser enviado sem legenda.');
    if (this.entries.get(channel.id) !== entry || !entry.matched || entry.state !== 'connected') fail(409, 'A conexão mudou. Atualize antes de enviar.');
    const generation = entry.generation, providerSocket = entry.socket, id = randomUUID(), externalId = generateMessageIDV2(entry.socket.user.id);
    const messageSecret = poll ? pollSecret(this.authKey, channel.id, id) : null;
    this.mutateConversation(session, tenantId, conversationId, 'WhatsApp: envio solicitado', state => {
      const current = this.store.getConversation(state, conversationId, input.version);
      this.operations?.canReply(session,tenantId,current);
      const currentChannel = state.channels.find(item => item.id === current.channelId);
      if (!currentChannel || currentChannel.kind !== 'whatsapp_qr' || currentChannel.transport !== 'baileys' || current.channelId !== channel.id || current.remoteJid !== conversation.remoteJid) fail(409, 'A origem da conversa mudou. Atualize antes de enviar.');
      if (current.remoteJid.endsWith('@g.us') && !(currentChannel.allowedGroups || []).includes(current.remoteJid)) fail(409, 'Este grupo foi desativado no atendimento.');
      reply = outgoingReply(current, input);
      if (autopilot && current.owner !== 'agent') fail(409, 'O atendimento saiu do agente antes do envio automático.');
      current.messages.push({ id, externalId, kind: service || autopilot ? 'agent' : 'human', text: messageText, ...(poll ? { poll } : {}), ...(file ? { attachments: [file.metadata] } : {}), ...(reply ? { replyToMessageId: reply.messageId } : {}), authorUserId:session.userId||null,authorName:session.name, ...(service ? { authorServiceId: session.serviceId, agentId: session.agentId, serviceCommandId: input.idempotencyKey } : {}), ...(autopilot ? { agentId: attribution.agentId, autopilotJobId: attribution.autopilotJobId } : {}), createdAt: new Date().toISOString(), delivery: 'pending', transport: 'whatsapp' });
      this.store.db.prepare('INSERT OR IGNORE INTO wa_seen VALUES (?,?,?)').run(channel.id, conversation.remoteJid, externalId);
      current.version++; current.updatedAt = new Date().toISOString();
    });
    try {
      const voice = file?.metadata.kind === 'audio' && file.metadata.mime === 'audio/ogg' && isOggOpus(file.bytes);
      const payload = poll ? { poll: { name: poll.question, values: poll.options, selectableCount: poll.selectableCount, messageSecret } } : file ? { [file.metadata.kind]: file.bytes, mimetype: voice ? 'audio/ogg; codecs=opus' : file.metadata.mime, ...(voice ? { ptt: true } : {}), ...(file.metadata.kind === 'document' ? { fileName: file.metadata.name } : {}), ...(messageText && file.metadata.kind !== 'audio' ? { caption: messageText } : {}) } : { text: messageText };
      const quoted = reply ? { key: { remoteJid: conversation.remoteJid, id: reply.externalId, fromMe: ['human','agent'].includes(reply.kind), ...(conversation.remoteJid.endsWith('@g.us') && reply.senderJid ? { participant: reply.senderJid } : {}) }, message: { conversation: reply.text || '[Foto/Áudio/Vídeo/Arquivo]' } } : null;
      const sent = await entry.socket.sendMessage(conversation.remoteJid, payload, { messageId: externalId, ...(file ? { mediaUploadTimeoutMs: 20000 } : {}), ...(quoted ? { quoted } : {}) });
      if (entry.socket === providerSocket) this.rememberHistoryCursor(entry, sent, generation);
      this.mutateConversation(session, tenantId, conversationId, 'WhatsApp: envio aceito', state => {
        const current = this.store.getConversation(state, conversationId), item = current.messages.find(item => item.id === id);
        item.externalId = sent.key.id; if (item.delivery === 'pending') item.delivery = 'sent';
        this.store.db.prepare('INSERT OR IGNORE INTO wa_seen VALUES (?,?,?)').run(channel.id, conversation.remoteJid, sent.key.id);
      });
      if (this.store.getConversation(this.conversationTenant(session, tenantId, conversationId), conversationId).messages.find(item => item.id === id).delivery === 'failed') fail(502, 'O WhatsApp rejeitou este envio. Confira a conversa antes de tentar novamente.');
    } catch {
      const current = this.store.getConversation(this.conversationTenant(session, tenantId, conversationId), conversationId), item = current.messages.find(item => item.id === id);
      if (item.delivery === 'failed') fail(502, 'O WhatsApp rejeitou este envio. Confira a conversa antes de tentar novamente.');
      if ((deliveryRank[item.delivery] || 0) > 0) return current;
      this.mutateConversation(session, tenantId, conversationId, 'WhatsApp: envio não confirmado', state => { this.store.getConversation(state, conversationId).messages.find(item => item.id === id).delivery = 'unconfirmed'; });
      fail(502, 'O envio não foi confirmado. Confira o WhatsApp antes de tentar novamente.');
    }
    return this.store.getConversation(this.conversationTenant(session, tenantId, conversationId), conversationId);
  }
  async restore() {
    const rows = this.store.db.prepare('SELECT id,reseller_id,data FROM tenants').all();
    const hasAuth = Boolean(this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wa_auth'").get());
    for (const row of rows) {
      for (const channel of JSON.parse(row.data).channels) {
        // Falha transitória (rede, 5xx, sessão instável) volta a tentar no boot; ação humana pendente não.
        if (channel.transport !== 'baileys' || ['logged_out', 'wrong_number', 'disconnected'].includes(channel.state) || channel.state === 'failed' && channel.failureReason === 'restricted') continue;
        const saved = hasAuth && this.store.db.prepare("SELECT 1 FROM wa_auth WHERE channel_id=? AND category='creds' AND item_id='main'").get(channel.id);
        if (!channel.linkedAt && !saved) continue;
        this.authKey ||= await loadLocalKey();
        let linked = false;
        if (saved) try { linked = linkedCreds(encryptedAuthState(this.store.db, channel.id, this.authKey).state.creds); } catch { /* Sessão ilegível não é retomada sozinha nem interrompe os demais canais. */ }
        // 'failed' só volta com sessão vinculada salva: QR nunca escaneado (ou recriado após logout) espera ação humana.
        if (channel.state === 'failed' ? linked : channel.linkedAt || linked) await this.start(this.actor(row.reseller_id), row.id, channel.id);
      }
    }
  }
  connectedCount() { return [...this.entries.values()].filter(entry => entry.state === 'connected').length; }
  /** Conexões vinculadas que o gateway mantém ou ainda retoma sozinho; falha esgotada, restrita ou à espera de QR não conta. */
  expectedCount() { return [...this.entries.values()].filter(entry => entry.expected && (['starting', 'connected', 'reconnecting'].includes(entry.state) || entry.state === 'failed' && Boolean(entry.nextRetryAt))).length; }
  // ---- Address book (whatsapp-agenda.js) --------------------------------------------------------------------------
  agenda(entry, contacts) {
    if (!rememberAgenda(this.store.db, entry.channelId, contacts, this.now())) return;
    clearTimeout(this.agendaTimers.get(entry.channelId));
    const timer = setTimeout(() => { this.agendaTimers.delete(entry.channelId); try { this.applyAgenda(entry); } catch { entry.error = 'Os nomes da agenda não puderam ser aplicados.'; } }, 1500);
    timer.unref?.(); this.agendaTimers.set(entry.channelId, timer);
  }
  /** Renames, in one change of the tenant, the conversations that still carry a WhatsApp name; returns how many. */
  applyAgenda(entry) {
    if (this.closing || this.entries.get(entry.channelId) !== entry) return 0;
    const names = agendaNames(this.store.db, entry.channelId);
    if (!names.size || !applyAgendaNames(JSON.parse(JSON.stringify(this.store.tenant(entry.actor, entry.tenantId))), entry.channelId, names, this.now())) return 0;
    return this.store.mutate(entry.actor, entry.tenantId, 'WhatsApp: nomes da agenda aplicados', tenant => applyAgendaNames(tenant, entry.channelId, names, this.now()));
  }
  connectedEntry(session, tenantId, channelId) {
    this.channel(session, tenantId, channelId);
    const entry = this.entries.get(channelId);
    if (!entry || entry.tenantId !== tenantId || entry.state !== 'connected' || !entry.matched || !entry.socket) fail(409, 'Conecte este WhatsApp antes de usar a agenda.');
    return entry;
  }
  /**
   * Asks WhatsApp again for the whole contacts collection of the app state ("critical_unblock_low", where contactAction
   * lives): only its stored version is cleared, so the snapshot comes back and every saved name is emitted again.
   * Administrators only; one sync per channel at a time.
   */
  async syncAddressBook(session, tenantId, channelId, { reauthorize = () => {}, timeoutMs = 60000, flushMs = 400 } = {}) {
    reauthorize(); this.store.admin(session);
    const entry = this.connectedEntry(session, tenantId, channelId);
    if (typeof entry.socket.resyncAppState !== 'function' || typeof entry.socket.authState?.keys?.set !== 'function') fail(409, 'Esta conexão não permite sincronizar a agenda.');
    if (entry.agendaSync) fail(409, 'A agenda deste WhatsApp já está sincronizando.');
    entry.agendaSync = true;
    let timer;
    try {
      await entry.socket.authState.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
      await Promise.race([entry.socket.resyncAppState(['critical_unblock_low'], true), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('O WhatsApp não respondeu à sincronização da agenda.'), { status: 504 })), timeoutMs); })]);
      // resyncAppState is a buffered Baileys function: its contacts.upsert events are flushed about 100 ms after it returns.
      await new Promise(resolve => { const wait = setTimeout(resolve, flushMs); wait.unref?.(); });
      reauthorize(); this.store.admin(session);
      clearTimeout(this.agendaTimers.get(channelId)); this.agendaTimers.delete(channelId);
      const renamed = this.applyAgenda(entry);
      return { channelId, contacts: agendaCount(this.store.db, channelId), renamed };
    } catch (error) {
      if (error.status) throw error;
      fail(502, 'O WhatsApp não concluiu a sincronização da agenda.');
    } finally { clearTimeout(timer); entry.agendaSync = false; }
  }
  /** Saved contacts with a phone number, as JSON rows for the CRM import. Administrators only. */
  addressBook(session, tenantId, channelId, { reauthorize = () => {} } = {}) {
    reauthorize(); this.store.admin(session); this.channel(session, tenantId, channelId);
    const rows = agendaRows(this.store.db, channelId);
    return { channelId, contacts: agendaCount(this.store.db, channelId), rows };
  }
  async close() {
    this.closing = true;
    for (const timer of this.agendaTimers.values()) clearTimeout(timer); this.agendaTimers.clear();
    for (const entry of this.entries.values()) { clearTimeout(entry.timer); entry.generation++; entry.historyCursors?.clear(); this.historyImporter?.connectionChanged?.(entry); entry.socket?.end(new Error('Servidor local encerrado.')); }
    await Promise.allSettled([...this.mediaTasks, ...this.historyTasks]);
  }
}
