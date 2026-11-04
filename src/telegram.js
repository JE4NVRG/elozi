import { randomUUID } from 'node:crypto';
import { prepareSelectedGroupConversations } from './group-conversations.js';
import { syncIncomingConversationContact } from './contacts.js';
import { noteStatus, clearConversationParticipants } from './operations.js';
import { encryptedChannelSecrets } from './channel-secrets.js';
import { loadLocalKey } from './wa-auth.js';
import { fail, text } from './store.js';
import { attachmentIds, outgoingText, MAX_MEDIA_BYTES } from './media.js';
import { AVATAR_MAX_BYTES, readAvatarResponse } from './avatars.js';
import { resolveReply } from './replies.js';
import { allowedFields } from './access.js';
import { automatedAttribution } from './outbox.js';

const validToken = token => typeof token === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,80}$/.test(token);
const displayName = user => user?.title?.slice(0, 80) || [user?.first_name, user?.last_name].filter(Boolean).join(' ').slice(0, 80) || user?.username?.slice(0, 80) || 'Participante';
const ordinaryMessage = message => Boolean(message && typeof message === 'object'
  && Number.isSafeInteger(message.message_id) && message.message_id > 0
  && !Object.hasOwn(message, 'receiver_user') && !Object.hasOwn(message, 'ephemeral_message_id'));
const groupId = value => typeof value === 'string' && /^-[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const groupName = value => String(value || 'Grupo Telegram').replace(/\p{Cc}/gu, '').slice(0, 80);
const memberStates = new Set(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']);
const permissionFields = { text: 'can_send_messages', photos: 'can_send_photos', audios: 'can_send_audios', documents: 'can_send_documents', videos: 'can_send_videos', videoNotes: 'can_send_video_notes', voiceNotes: 'can_send_voice_notes' };
const methodPermissions = { sendMessage: 'text', sendPhoto: 'photos', sendAudio: 'audios', sendDocument: 'documents', sendVideo: 'videos', sendVoice: 'voiceNotes' };
const permissionLabels = { text: 'texto', photos: 'fotos', audios: 'áudio', documents: 'documentos', videos: 'vídeo', voiceNotes: 'mensagens de voz' };
const allPermissions = value => Object.fromEntries(Object.keys(permissionFields).map(key => [key, value]));
const booleanPermission = value => typeof value === 'boolean' ? value : null;
function sendPermissions(group) {
  if (group?.joined === false) return allPermissions(false);
  if (group?.sendPermissions) return Object.fromEntries(Object.keys(permissionFields).map(key => [key, booleanPermission(group.sendPermissions[key])]));
  if (['creator', 'administrator'].includes(group?.memberStatus)) return allPermissions(true);
  // Legacy metadata only recorded the text restriction. Other methods remain unknown.
  return { ...allPermissions(null), text: group?.memberStatus === 'restricted' ? booleanPermission(group.canSend) : null };
}
function summarizePermissions(permissions) {
  const supported = [...new Set(Object.values(methodPermissions))].map(key => permissions[key]);
  return supported.includes(true) ? true : supported.every(value => value === false) ? false : null;
}
function permissionsFor(tenant, channel, chatId) {
  if (!groupId(chatId)) return allPermissions(true);
  return sendPermissions(knownGroups(tenant, channel).find(group => group.id === chatId || group.aliases.includes(chatId)));
}
function methodAllowed(tenant, channel, chatId, method) { return permissionsFor(tenant, channel, chatId)[methodPermissions[method]] !== false; }
function outgoingMediaMethod(file) {
  const { metadata } = file;
  switch (metadata.kind) {
    case 'image': return ['image/jpeg', 'image/png'].includes(metadata.mime) && metadata.size <= 10_000_000 ? ['sendPhoto', 'photo'] : ['sendDocument', 'document'];
    case 'audio':
      if (metadata.mime === 'audio/ogg' && file.bytes?.subarray(0, 128).includes(Buffer.from('OpusHead'))) return ['sendVoice', 'voice'];
      return ['audio/mpeg', 'audio/mp4'].includes(metadata.mime) ? ['sendAudio', 'audio'] : ['sendDocument', 'document'];
    case 'video': return metadata.mime === 'video/mp4' ? ['sendVideo', 'video'] : ['sendDocument', 'document'];
    case 'document': return ['sendDocument', 'document'];
    default: fail(400, 'Este tipo de arquivo não é suportado no Telegram.');
  }
}
function possibleMediaMethods(metadata) {
  // Resolving encrypted bytes is asynchronous. OGG needs its codec checked again before a pending message.
  return metadata.kind === 'audio' && metadata.mime === 'audio/ogg' ? ['sendVoice', 'sendDocument'] : [outgoingMediaMethod({ metadata })[0]];
}
const policy = channel => ({ version: channel.telegramGroups?.version || 0, mode: channel.telegramGroups?.mode === 'selected' ? 'selected' : 'all', groupIds: channel.telegramGroups?.groupIds || [] });
const migrationConflicts = channel => channel.telegramGroups?.migrationConflicts || [];
const conflictingGroup = (channel, id) => migrationConflicts(channel).some(item => item.fromGroupId === id || item.toGroupId === id);
function knownGroups(tenant, channel) {
  const known = new Map((channel.telegramGroups?.known || []).filter(item => groupId(item.id)).map(item => [item.id, { ...item, aliases: [...(item.aliases || [])] }]));
  for (const conversation of tenant.conversations) {
    if (conversation.channelId !== channel.id || !groupId(conversation.remoteChatId)) continue;
    const id = conversation.remoteChatId;
    if (!known.has(id)) known.set(id, { id, name: groupName(conversation.contact), type: 'group', memberStatus: 'unknown', joined: null, canSend: null, aliases: [...(conversation.chatAliases || [])] });
  }
  return [...known.values()];
}
function discoverGroup(tenant, channel, chat, member) {
  if (!['group', 'supergroup'].includes(chat?.type) || !groupId(String(chat.id))) return;
  const known = knownGroups(tenant, channel), id = String(chat.id);
  let group = known.find(item => item.id === id || item.aliases.includes(id));
  if (!group) { group = { id, name: 'Grupo Telegram', type: chat.type, memberStatus: 'unknown', joined: null, canSend: null, aliases: [] }; known.push(group); }
  group.name = groupName(chat.title || group.name);
  if (group.id === id) group.type = chat.type;
  if (memberStates.has(member?.status)) {
    group.memberStatus = member.status;
    group.joined = ['left', 'kicked'].includes(member.status) ? false : member.status === 'restricted' ? booleanPermission(member.is_member) : true;
    group.sendPermissions = group.joined === false ? allPermissions(false) : member.status === 'restricted'
      ? Object.fromEntries(Object.entries(permissionFields).map(([key, field]) => [key, booleanPermission(member[field])]))
      : allPermissions(['creator', 'administrator'].includes(member.status) ? true : null);
    group.canSend = summarizePermissions(group.sendPermissions);
  }
  channel.telegramGroups = { ...channel.telegramGroups, known };
}
function migrateGroup(tenant, channel, oldId, newId, name) {
  if (!groupId(oldId) || !groupId(newId) || oldId === newId) return;
  const known = knownGroups(tenant, channel), previous = known.find(item => item.id === oldId || item.aliases.includes(oldId));
  const destination = known.find(item => item.id === newId);
  const affected = tenant.conversations.filter(item => item.channelId === channel.id && item.remoteChatId !== newId && [item.remoteChatId, ...(item.chatAliases || [])].includes(oldId));
  const targetOwners = (tenant.contacts || []).filter(contact => (contact.identities || []).some(identity => identity.channelId === channel.id && identity.kind === 'group' && identity.externalId === newId));
  const sourceOwners = (tenant.contacts || []).filter(contact => (contact.identities || []).some(identity => identity.channelId === channel.id && identity.kind === 'group' && identity.externalId === oldId));
  const historyCollision = affected.length && tenant.conversations.some(item => item.channelId === channel.id && item.remoteChatId === newId);
  const identityCollision = targetOwners.length > 1 || targetOwners.some(owner => affected.some(item => item.contactId !== owner.id) || sourceOwners.some(source => source.id !== owner.id));
  if (historyCollision || identityCollision || conflictingGroup(channel, oldId) || conflictingGroup(channel, newId) || previous?.aliases.some(id => conflictingGroup(channel, id))) {
    // A provider migration is explicit, but it does not authorize merging two existing contacts/histories.
    // Keep the mappings intact and quarantine both IDs while still acknowledging the update offset.
    const conflicts = migrationConflicts(channel), exists = conflicts.some(item => item.fromGroupId === oldId && item.toGroupId === newId), config = policy(channel);
    for (const [id, type] of [[oldId, 'group'], [newId, 'supergroup']]) if (!known.some(item => item.id === id)) known.push({ id, name: groupName(name), type, memberStatus: 'unknown', joined: null, canSend: null, aliases: [] });
    channel.telegramGroups = { ...channel.telegramGroups, known, ...config, version: config.version + (exists ? 0 : 1), migrationConflicts: exists ? conflicts : [...conflicts, { fromGroupId: oldId, toGroupId: newId }] };
    return false;
  }
  const membership = destination?.memberStatus && destination.memberStatus !== 'unknown' ? destination : previous || destination || { memberStatus: 'unknown', joined: null, canSend: null };
  const permissions = sendPermissions(membership);
  const group = { id: newId, name: groupName(name || destination?.name || previous?.name), type: 'supergroup', memberStatus: membership.memberStatus, joined: membership.joined, canSend: summarizePermissions(permissions), sendPermissions: permissions, aliases: [...new Set([oldId, ...(previous?.aliases || []), ...(destination?.aliases || [])])] };
  const config = policy(channel), ids = [...new Set(config.groupIds.map(id => id === oldId || previous?.aliases.includes(id) ? newId : id))];
  const selectionChanged = JSON.stringify(ids) !== JSON.stringify(config.groupIds);
  channel.telegramGroups = { ...channel.telegramGroups, ...(selectionChanged ? { ...config, version: config.version + 1, groupIds: ids } : {}), known: [...known.filter(item => item !== previous && item !== destination), group] };
  for (const conversation of tenant.conversations.filter(item => item.channelId === channel.id && [item.remoteChatId, ...(item.chatAliases || [])].includes(oldId))) {
    conversation.chatAliases = [...new Set([oldId, newId, ...(conversation.chatAliases || [])])]; conversation.remoteChatId = newId; conversation.contact = group.name; conversation.version++; syncIncomingConversationContact(tenant, conversation, channel);
  }
  return true;
}
function groupAllowed(tenant, channel, id, sending = false) {
  if (!groupId(id)) return true;
  const config = policy(channel), group = knownGroups(tenant, channel).find(item => item.id === id || item.aliases.includes(id));
  if (conflictingGroup(channel, id) || group && [group.id, ...group.aliases].some(alias => conflictingGroup(channel, alias))) return false;
  return group?.joined !== false && (!sending || summarizePermissions(sendPermissions(group)) !== false) && (config.mode === 'all' || config.groupIds.includes(group?.id || id));
}
function outgoingReply(conversation, input) {
  const reply = resolveReply(conversation, input);
  if (!reply) return null;
  const external = typeof reply.externalId === 'string' ? /^(-?\d+):(\d+)$/.exec(reply.externalId) : null;
  if (!external || external[1] !== conversation.remoteChatId || !Number.isSafeInteger(Number(external[2])) || Number(external[2]) <= 0) fail(409, 'A mensagem original não tem uma referência válida neste chat do Telegram.');
  return { ...reply, providerMessageId: Number(external[2]) };
}
const clean = (value, max) => typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max) : '';
const coordinates = (latitude, longitude) => { const lat = Number(latitude), lng = Number(longitude); return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng) ? `(${lat.toFixed(6)}, ${lng.toFixed(6)})` : ''; };
const describe = (label, details, suffix = '') => [label, details.map(item => clean(item, 1000)).filter(Boolean).join(' · '), suffix].filter(Boolean).join(' ');
/** Figurinha, local, contato e enquete viram texto legível; a captura de mídia continua só para os tipos de arquivo. */
function unsupportedText(message) {
  if (message?.sticker) return ['[Figurinha]', clean(message.sticker.emoji, 16)].filter(Boolean).join(' ');
  if (message?.venue) return describe('[Localização]', [message.venue.title, message.venue.address], coordinates(message.venue.location?.latitude, message.venue.location?.longitude));
  if (message?.location) return describe(message.location.live_period ? '[Localização em tempo real]' : '[Localização]', [], coordinates(message.location.latitude, message.location.longitude));
  if (message?.contact) return describe('[Contato]', [[message.contact.first_name, message.contact.last_name].filter(value => typeof value === 'string').join(' '), message.contact.phone_number]);
  if (message?.poll) return describe('[Enquete]', [message.poll.question, (Array.isArray(message.poll.options) ? message.poll.options : []).slice(0, 12).map(option => clean(option?.text, 80)).filter(Boolean).join(' / ')]);
  return '';
}
// O Telegram sorteia o próximo update_id após uma semana sem atualizações; um offset salvo antigo confirmaria e
// descartaria esses updates. Sem atividade recente, o poll volta a pedir sem offset (o dedupe por chat/mensagem continua).
const OFFSET_IDLE_MS = 6 * 24 * 3600_000;
function incomingMedia(message) {
  const photo = Array.isArray(message?.photo) ? [...message.photo].sort((a, b) => Number(b.file_size || b.width * b.height || 0) - Number(a.file_size || a.width * a.height || 0))[0] : null;
  for (const [node, kind, mime] of [[photo, 'image', 'image/jpeg'], [message?.voice || message?.audio, 'audio', message?.voice ? 'audio/ogg' : 'audio/mpeg'], [message?.video || message?.video_note || message?.animation, 'video', 'video/mp4'], [message?.document, 'document', 'application/octet-stream']]) {
    if (node?.file_id) return { fileId: node.file_id, descriptor: { kind, mime: node.mime_type || mime, name: node.file_name, size: Number(node.file_size || 0) } };
  }
  return null;
}

export class TelegramGateway {
  constructor(store, { fetchImpl = fetch, authKey, polling = true, retryDelay = 3000, now = Date.now } = {}) {
    this.store = store; this.fetch = fetchImpl; this.authKey = authKey; this.polling = polling; this.retryDelay = retryDelay; this.now = now;
    this.entries = new Map(); this.mediaTasks = new Set(); this.starting = new Set(); this.closing = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_bindings (bot_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_offsets (channel_id TEXT PRIMARY KEY, next_offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_offset_activity (channel_id TEXT PRIMARY KEY, active_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_seen (channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(channel_id,chat_id,message_id));`);
  }
  async secrets() { this.authKey ||= await loadLocalKey(); return encryptedChannelSecrets(this.store.db, this.authKey); }
  actor(resellerId) { return { role: 'reseller', resellerId, name: 'Gateway Telegram' }; }
  channel(session, tenantId, channelId) {
    const tenant = this.store.tenant(session, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    if (channel.kind !== 'telegram' || channel.transport !== 'telegram-bot') fail(400, 'Este canal não é um bot Telegram.');
    return { tenant, channel };
  }
  status(session, tenantId, channelId) {
    this.store.admin(session); const { channel } = this.channel(session, tenantId, channelId), entry = this.entries.get(channelId);
    return { state: entry?.state || 'disconnected', label: channel.label, username: channel.botUsername || null, groupReadMode: channel.groupReadMode || null, error: entry?.error || null };
  }
  groups(session, tenantId, channelId) {
    if (!this.operations) fail(503, 'A autorização de administração está indisponível.');
    if (session?.kind === 'service') fail(403, 'Um serviço não administra a seleção de grupos.');
    this.operations.admin(session);
    const { tenant, channel } = this.channel(session, tenantId, channelId), config = policy(channel);
    return { tenantId, channelId, ...config, groupReadMode: channel.groupReadMode || null, connectionState: this.entries.get(channelId)?.state || 'disconnected', migrationConflicts: migrationConflicts(channel).map(item => ({ fromGroupId: item.fromGroupId, toGroupId: item.toGroupId })),
      groups: knownGroups(tenant, channel).map(group => { const conflict = [group.id, ...group.aliases].some(id => conflictingGroup(channel, id)), permissions = conflict ? allPermissions(false) : sendPermissions(group); return { id: group.id, name: groupName(group.name), type: group.type, memberStatus: group.memberStatus || 'unknown', joined: group.joined ?? null, canSend: summarizePermissions(permissions), sendPermissions: permissions, selected: config.mode === 'all' || config.groupIds.includes(group.id), migrationConflict: conflict }; }) };
  }
  setGroups(session, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    if (typeof reauthorize !== 'function') fail(400, 'Informe uma validação de sessão válida.');
    const identity = JSON.stringify([session?.userId, session?.resellerId, session?.supportGrantId, session?.kind]);
    const fresh = () => { const result = reauthorize(); if (result?.then) { Promise.resolve(result).catch(() => {}); fail(400, 'A validação de sessão precisa ser síncrona.'); } if (identity !== JSON.stringify([session?.userId, session?.resellerId, session?.supportGrantId, session?.kind])) fail(403, 'O contexto de administração mudou.'); };
    fresh(); this.groups(session, tenantId, channelId);
    allowedFields(input, ['version', 'mode', 'groupIds']);
    if (!Number.isSafeInteger(input.version) || input.version < 0 || !['all', 'selected'].includes(input.mode) || !Array.isArray(input.groupIds) || input.groupIds.length > 1000 || input.groupIds.some(id => !groupId(id))) fail(400, 'Informe modo, versão e IDs de grupos válidos.');
    const ids = [...new Set(input.groupIds)];
    this.store.mutate(session, tenantId, 'Telegram: seleção de grupos atualizada', tenant => {
      fresh(); this.operations.admin(session);
      const channel = tenant.channels.find(item => item.id === channelId);
      if (!channel || channel.kind !== 'telegram' || channel.transport !== 'telegram-bot') fail(409, 'O canal mudou. Atualize a seleção.');
      const current = policy(channel), known = knownGroups(tenant, channel);
      if (current.version !== input.version) fail(409, 'A seleção mudou. Atualize antes de salvar.');
      if (ids.some(id => !known.some(group => group.id === id))) fail(400, 'Escolha somente grupos conhecidos deste canal.');
      channel.telegramGroups = { ...channel.telegramGroups, known, version: current.version + 1, mode: input.mode, groupIds: ids };
      prepareSelectedGroupConversations(tenant,channel);
    });
    return this.groups(session, tenantId, channelId);
  }
  replyPolicy(session, tenantId, conversationId) {
    const tenant = this.store.tenant(session, tenantId), conversation = this.store.getConversation(tenant, conversationId);
    const { channel } = this.channel(session, tenantId, conversation.channelId), allowed = groupAllowed(tenant, channel, conversation.remoteChatId, true);
    return { allowed, sendPermissions: allowed ? permissionsFor(tenant, channel, conversation.remoteChatId) : allPermissions(false) };
  }
  assertGroupAllowed(session, tenantId, channelId, chatId, { method } = {}) {
    if (method !== undefined && !Object.hasOwn(methodPermissions, method)) fail(400, 'Informe um método de envio suportado no Telegram.');
    const { tenant, channel } = this.channel(session, tenantId, channelId);
    if (!groupAllowed(tenant, channel, chatId, true)) fail(409, 'Este grupo não está habilitado para atendimento neste canal ou o bot não pode responder.');
    if (method && !methodAllowed(tenant, channel, chatId, method)) fail(409, `O bot não tem permissão para enviar ${permissionLabels[methodPermissions[method]]} neste grupo.`);
    return true;
  }
  validateOutgoing(session, tenantId, conversationId, input) {
    allowedFields(input, ['channelId', 'version', 'text', 'attachmentIds', 'replyToMessageId', 'idempotencyKey']);
    const tenant = this.store.tenant(session, tenantId), conversation = this.store.getConversation(tenant, conversationId, input.version);
    const service = session?.kind === 'service' && session.serviceId && !session.userId;
    const autopilot = session?.kind === 'service' && session.autopilot === true && !session.userId && !session.serviceId;
    if ((service || autopilot) && !this.operations?.canReply) fail(403, 'O envio do serviço precisa de autorização explícita.');
    this.operations?.canReply(session, tenantId, conversation);
    const { channel } = this.channel(session, tenantId, conversation.channelId);
    if (autopilot ? conversation.owner !== 'agent' : conversation.owner !== 'human' && !service) fail(409, 'Assuma a conversa antes de responder.');
    if (input.channelId !== channel.id || !/^-?\d+$/.test(conversation.remoteChatId || '')) fail(400, 'A resposta precisa usar o chat e canal de origem.');
    const ids = attachmentIds(input), content = outgoingText(input, ids.length > 0);
    outgoingReply(conversation, input);
    this.assertGroupAllowed(session, tenantId, channel.id, conversation.remoteChatId, ids.length ? {} : { method: 'sendMessage' });
    if (ids.length) {
      if (!this.media) fail(503, 'Armazenamento de arquivos indisponível.');
      const { metadata } = this.media.record(ids[0], { tenantId, conversationId, channelId: channel.id }, { uploadOnly: true });
      if (metadata.status !== 'ready') fail(409, 'O arquivo ainda não está pronto para enviar.');
      if (!possibleMediaMethods(metadata).some(method => methodAllowed(tenant, channel, conversation.remoteChatId, method))) fail(409, 'O bot não tem permissão para enviar este tipo de arquivo neste grupo.');
    }
    return { content, attachmentIds: ids };
  }
  async avatar(session, tenantId, channelId, { peer, signal, fetchImpl = this.fetch } = {}) {
    try {
      this.channel(session, tenantId, channelId);
      const entry = this.entries.get(channelId);
      const active = () => !this.closing && this.entries.get(channelId) === entry && entry?.tenantId === tenantId && entry.state === 'connected' && !entry.stopped && !signal?.aborted;
      if (!active() || !validToken(entry.token)) return null;
      const target = peer || entry.botId;
      if (typeof target !== 'string' || !/^-?[1-9]\d{0,15}$/.test(target) || !Number.isSafeInteger(Number(target))) return null;
      const boundedSignal = AbortSignal.any([signal || new AbortController().signal, entry.abort?.signal || new AbortController().signal, AbortSignal.timeout(10000)]);
      let fileId;
      if (target.startsWith('-')) {
        const chat = await this.call(entry, 'getChat', { chat_id: target }, boundedSignal, fetchImpl);
        if (String(chat?.id) !== target) return null;
        fileId = chat.photo?.small_file_id;
      } else {
        const photos = await this.call(entry, 'getUserProfilePhotos', { user_id: Number(target), limit: 1 }, boundedSignal, fetchImpl);
        const sizes = Array.isArray(photos?.photos?.[0]) ? photos.photos[0].filter(photo => typeof photo?.file_id === 'string' && Number(photo.file_size || 0) <= AVATAR_MAX_BYTES) : [];
        sizes.sort((a, b) => Number(a.width || 0) * Number(a.height || 0) - Number(b.width || 0) * Number(b.height || 0));
        fileId = sizes[0]?.file_id;
      }
      if (!active() || typeof fileId !== 'string' || fileId.length > 512) return null;
      const file = await this.call(entry, 'getFile', { file_id: fileId }, boundedSignal, fetchImpl);
      if (!active() || Number(file?.file_size || 0) > AVATAR_MAX_BYTES || typeof file?.file_path !== 'string'
          || !/^[A-Za-z0-9_./-]{1,512}$/.test(file.file_path) || file.file_path.startsWith('/') || file.file_path.split('/').includes('..')) return null;
      const response = await fetchImpl(`https://api.telegram.org/file/bot${entry.token}/${file.file_path}`, { method: 'GET', signal: boundedSignal, redirect: 'error' });
      const image = await readAvatarResponse(response, boundedSignal);
      return active() ? image : null;
    } catch { return null; }
  }
  update(entry, state, error = null) {
    entry.state = state; entry.error = error;
    this.store.mutate(entry.actor, entry.tenantId, `Telegram: ${state}`, tenant => { tenant.channels.find(item => item.id === entry.channelId).state = state; });
  }
  async call(entry, method, payload = {}, signal, fetchImpl = this.fetch) {
    let response, result;
    try {
      const multipart = payload instanceof FormData;
      response = await fetchImpl(`https://api.telegram.org/bot${entry.token}/${method}`, { method: 'POST', ...(multipart ? {} : { headers: { 'Content-Type': 'application/json' } }), body: multipart ? payload : JSON.stringify(payload), signal: signal || AbortSignal.timeout(15000), redirect: 'error' });
      result = await response.json();
    } catch { throw Object.assign(new Error('O Telegram não confirmou a operação.'), { status: 502 }); }
    if (!response.ok || !result.ok) {
      const code = Number(result.error_code || response.status);
      throw Object.assign(new Error(code === 401 ? 'Token do bot inválido ou revogado.' : code === 409 ? 'Este bot está sendo usado por outra conexão ou webhook.' : code === 403 ? 'O bot não tem permissão neste chat.' : 'O Telegram recusou a operação.'), { status: code === 401 ? 400 : code === 409 ? 409 : 502, providerCode: code, retryAfter: Number(result.parameters?.retry_after || 0), migrateToChatId: result.parameters?.migrate_to_chat_id });
    }
    return result.result;
  }
  async downloadMedia(entry, item) {
    if (typeof item.fileId !== 'string' || item.fileId.length > 512) fail(400, 'Arquivo inválido.');
    if (item.descriptor.size > MAX_MEDIA_BYTES) fail(413, 'Arquivo acima do limite.');
    const result = await this.call(entry, 'getFile', { file_id: item.fileId });
    if (Number(result.file_size || 0) > MAX_MEDIA_BYTES) fail(413, 'Arquivo acima do limite.');
    if (typeof result.file_path !== 'string' || !/^[A-Za-z0-9_./-]{1,512}$/.test(result.file_path) || result.file_path.startsWith('/') || result.file_path.split('/').includes('..')) fail(502, 'Origem de arquivo inválida.');
    const response = await this.fetch(`https://api.telegram.org/file/bot${entry.token}/${result.file_path}`, { method: 'GET', signal: AbortSignal.any([entry.abort?.signal || new AbortController().signal, AbortSignal.timeout(15000)]), redirect: 'error' });
    if (!response.ok) fail(502, 'O arquivo não está disponível para download.');
    if (Number(response.headers?.get('content-length') || 0) > MAX_MEDIA_BYTES) { await response.body?.cancel?.().catch(() => {}); fail(413, 'Arquivo acima do limite.'); }
    return response.body;
  }
  async start(session, tenantId, channelId, token) {
    this.store.admin(session); this.channel(session, tenantId, channelId);
    if (this.starting.has(channelId)) fail(409, 'Este bot está conectando. Aguarde a confirmação.');
    this.starting.add(channelId);
    try { return await this.connect(session, tenantId, channelId, token); }
    finally { this.starting.delete(channelId); }
  }
  async connect(session, tenantId, channelId, token) {
    this.store.admin(session); const { tenant } = this.channel(session, tenantId, channelId);
    const existing = this.entries.get(channelId);
    if (existing && ['connected', 'reconnecting'].includes(existing.state)) return this.status(session, tenantId, channelId);
    token ||= (await this.secrets()).get(channelId)?.token;
    if (!validToken(token)) fail(400, 'Cadastre o token do BotFather no campo protegido.');
    const entry = { channelId, tenantId, token, actor: this.actor(tenant.resellerId), state: 'starting', error: null, abort: new AbortController(), stopped: false };
    const bot = await this.call(entry, 'getMe');
    if (!bot.is_bot || !Number.isSafeInteger(bot.id)) fail(400, 'A identidade retornada não é um bot válido.');
    const info = await this.call(entry, 'getWebhookInfo');
    if (info.url) fail(409, 'Este bot possui um webhook ativo. Use um bot exclusivo para o MEPChat.');
    const binding = this.store.db.prepare('SELECT channel_id,tenant_id FROM telegram_bindings WHERE bot_id=?').get(String(bot.id));
    if (binding && (binding.channel_id !== channelId || binding.tenant_id !== tenantId)) fail(409, 'Este bot já pertence a outra conexão.');
    const previous = this.store.db.prepare('SELECT bot_id FROM telegram_bindings WHERE channel_id=?').get(channelId);
    if (previous && previous.bot_id !== String(bot.id)) fail(409, 'O token pertence a outro bot. Crie uma conexão separada.');
    this.channel(session, tenantId, channelId); // Confere novamente após chamadas externas.
    existing?.abort.abort(); if (existing) existing.stopped = true;
    entry.botId = String(bot.id); this.entries.set(channelId, entry);
    try {
      const secrets = await this.secrets();
      this.store.mutate(session, tenantId, 'Telegram: bot cadastrado', state => {
        const currentBinding = this.store.db.prepare('SELECT channel_id,tenant_id FROM telegram_bindings WHERE bot_id=?').get(entry.botId);
        const currentChannel = this.store.db.prepare('SELECT bot_id FROM telegram_bindings WHERE channel_id=?').get(channelId);
        if (currentBinding && (currentBinding.channel_id !== channelId || currentBinding.tenant_id !== tenantId) || currentChannel && currentChannel.bot_id !== entry.botId) fail(409, 'Este bot já pertence a outra conexão.');
        this.store.db.prepare('INSERT OR IGNORE INTO telegram_bindings VALUES (?,?,?)').run(entry.botId, channelId, tenantId);
        secrets.set(channelId, { token });
        const channel = state.channels.find(item => item.id === channelId);
        Object.assign(channel, { botUsername: bot.username, botAccountId:entry.botId, label: `@${bot.username}`, groupReadMode: bot.can_read_all_group_messages ? 'all' : 'mentions', state: 'connected' });
      });
      entry.state = 'connected';
    } catch (error) { if (this.entries.get(channelId) === entry) this.entries.delete(channelId); if (error.status) throw error; fail(500, 'Não foi possível preservar a conexão do bot.'); }
    if (this.polling) entry.task = this.poll(entry).catch(() => { entry.state = 'failed'; entry.error = 'Recebimento interrompido. Reconecte pelo painel.'; });
    return this.status(session, tenantId, channelId);
  }
  async poll(entry) {
    while (!this.closing && !entry.stopped && this.entries.get(entry.channelId) === entry) {
      try {
        const offset = this.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get(entry.channelId)?.next_offset || 0;
        const activeAt = this.store.db.prepare('SELECT active_at FROM telegram_offset_activity WHERE channel_id=?').get(entry.channelId)?.active_at;
        const idle = !Number.isSafeInteger(activeAt) || this.now() - activeAt > OFFSET_IDLE_MS;
        const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(35000)]);
        const updates = await this.call(entry, 'getUpdates', { ...(idle ? {} : { offset }), timeout: 25, limit: 100, allowed_updates: ['message', 'my_chat_member'] }, signal);
        const first = idle && Array.isArray(updates) ? Math.min(...updates.map(update => update?.update_id).filter(Number.isSafeInteger)) : Infinity;
        // Sem offset o Telegram devolve só o que ainda não foi confirmado; realinha o offset local antes de gravar.
        if (Number.isSafeInteger(first) && first < offset) this.store.db.prepare('UPDATE telegram_offsets SET next_offset=? WHERE channel_id=?').run(first, entry.channelId);
        for (const update of updates) {
          if (this.closing || entry.stopped) return;
          await this.receive(entry, update); // Dados e offset confirmados na mesma transação local.
        }
        if (idle && Array.isArray(updates) && updates.length) this.store.db.prepare('INSERT INTO telegram_offset_activity VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET active_at=excluded.active_at').run(entry.channelId, this.now());
        if (entry.state !== 'connected') this.update(entry, 'connected');
      } catch (error) {
        if (this.closing || entry.stopped) return;
        if ([401, 409].includes(error.providerCode)) { this.update(entry, 'failed', error.message); return; }
        // Durante uma queda longa grava a transição uma vez, sem regravar a empresa e a auditoria a cada tentativa.
        if (entry.state !== 'reconnecting') this.update(entry, 'reconnecting', 'Recebimento interrompido. Retomando sem reenviar mensagens.');
        await new Promise(resolve => { entry.wake = resolve; entry.timer = setTimeout(resolve, Math.max(this.retryDelay, Math.min(error.retryAfter || 0, 300) * 1000)); });
        entry.wake = null;
      }
    }
  }
  receive(entry, update) {
    if (this.closing || entry.stopped || this.entries.get(entry.channelId) !== entry) return;
    if (!Number.isSafeInteger(update.update_id)) return;
    const received=this.store.mutate(entry.actor, entry.tenantId, 'Telegram: atualização recebida', tenant => {
      let receivedId=null;
      const currentOffset = this.store.db.prepare('SELECT next_offset FROM telegram_offsets WHERE channel_id=?').get(entry.channelId)?.next_offset || 0;
      if (update.update_id < currentOffset) return;
      const channel = tenant.channels.find(item => item.id === entry.channelId);
      if (!channel || channel.kind !== 'telegram' || channel.transport !== 'telegram-bot') fail(409, 'O canal mudou.');
      const membership = update.my_chat_member;
      if (String(membership?.new_chat_member?.user?.id) === entry.botId) discoverGroup(tenant, channel, membership.chat, membership.new_chat_member);
      const message = update.message, chat = message?.chat;
      if (ordinaryMessage(message) && chat && ['private', 'group', 'supergroup'].includes(chat.type) && Number.isSafeInteger(chat.id)) {
        const chatId = String(chat.id);
        if (Number.isSafeInteger(message.migrate_to_chat_id) || Number.isSafeInteger(message.migrate_from_chat_id)) {
          const oldId = Number.isSafeInteger(message.migrate_to_chat_id) ? chatId : String(message.migrate_from_chat_id);
          const newId = Number.isSafeInteger(message.migrate_to_chat_id) ? String(message.migrate_to_chat_id) : chatId;
          migrateGroup(tenant, channel, oldId, newId, chat.title);
        }
        discoverGroup(tenant, channel, chat, String(message.left_chat_member?.id) === entry.botId ? { status: 'left' } : (message.new_chat_members || []).some(member => String(member.id) === entry.botId) ? { status: 'member' } : null);
        const content = message.text || message.caption || unsupportedText(message), mediaItem = incomingMedia(message);
        if (groupAllowed(tenant, channel, chatId) && (content || mediaItem)) {
          const inserted = this.store.db.prepare('INSERT OR IGNORE INTO telegram_seen VALUES (?,?,?)').run(entry.channelId, chatId, String(message.message_id));
          if (inserted.changes) {
            const threadId = Number.isSafeInteger(message.message_thread_id) && message.message_thread_id > 0 ? message.message_thread_id : null;
            let conversation = tenant.conversations.find(item => item.channelId === entry.channelId && [item.remoteChatId, ...(item.chatAliases || [])].includes(chatId) && (item.threadId || null) === threadId);
            const newConversation = !conversation;
            if (!conversation) {
              const group = chat.type !== 'private', name = group ? chat.title?.slice(0, 80) || 'Grupo Telegram' : displayName(chat);
              const department=(tenant.departments||[]).find(d=>d.active!==false&&d.id===tenant.defaultDepartmentId);
              conversation = { id: randomUUID(), contact: name, initials: name.slice(0, 2).toUpperCase(), channelId: entry.channelId, remoteChatId: chatId, chatAliases: [chatId], threadId, conversationKind: group ? 'group' : 'direct', department: department?.name||'Suporte',departmentId:department?.id||null, owner: 'queue',assignedUserId:null, status: 'open', version: 1, unread: 0, agentId: null, tags: [group ? 'Grupo Telegram' : 'Telegram real'], messages: [] };
              tenant.conversations.unshift(conversation);
            }
            const date = new Date(Number(message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
            const reopened = conversation.status === 'closed';
            if(conversation.status==='closed'){const previous=conversation.status;conversation.status='open';clearConversationParticipants(conversation,entry.actor,{origin:'telegram',reason:'Novo atendimento após encerramento.'});conversation.owner='queue';conversation.assignedUserId=null;conversation.assignedUserName=null;conversation.agentId=null;noteStatus(conversation,entry.actor,previous,{origin:'telegram'});}
            const messageId = randomUUID(), context = { tenantId: entry.tenantId, conversationId: conversation.id, channelId: entry.channelId };
            const attachment = mediaItem ? this.media ? this.media.placeholder(context, mediaItem.descriptor) : { id: randomUUID(), kind: mediaItem.descriptor.kind, name: 'Arquivo', mime: 'application/octet-stream', size: 0, status: 'unavailable', preview: false, reason: 'unavailable' } : null;
            const original = message.reply_to_message;
            const replyToMessageId = Number.isSafeInteger(original?.message_id) && (!original.chat || String(original.chat.id) === chatId) ? conversation.messages.find(item => item.externalId === `${chatId}:${original.message_id}` && ['customer', 'human'].includes(item.kind))?.id : null;
            conversation.messages.push({ id: messageId, externalId: `${chatId}:${message.message_id}`, kind: 'customer', text: String(content).slice(0, 4000), ...(attachment ? { attachments: [attachment] } : {}), ...(replyToMessageId ? { replyToMessageId } : {}), senderName: displayName(message.sender_chat || message.from), senderId: String(message.sender_chat?.id || message.from?.id || ''), createdAt: date, delivery: 'received', transport: 'telegram' });
            conversation.version++; conversation.updatedAt = date; conversation.unread++;
            const channel=tenant.channels.find(c=>c.id===entry.channelId);syncIncomingConversationContact(tenant,conversation,channel);receivedId={ conversationId:conversation.id, messageId, newConversation, reopened, conversationVersion: conversation.version, attachment, mediaItem };
          }
        }
      }
      this.store.db.prepare('INSERT INTO telegram_offsets VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET next_offset=max(next_offset,excluded.next_offset)').run(entry.channelId, update.update_id + 1);
      this.store.db.prepare('INSERT INTO telegram_offset_activity VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET active_at=excluded.active_at').run(entry.channelId, this.now());
      return receivedId;
    });
    if (!received) return;
    let incomingTask;
    try { incomingTask = this.onIncoming?.(entry, received.conversationId, received.messageId, { newConversation: received.newConversation, reopened: received.reopened, conversationVersion: received.conversationVersion }); }
    catch { entry.error = 'Uma automação não pôde ser aplicada.'; }
    const route = () => { if (this.operations) this.operations.routeIncoming(entry.tenantId, received.conversationId); };
    if (incomingTask?.then) incomingTask = incomingTask.catch(() => { entry.error = 'Uma automação não pôde ser aplicada.'; }).then(route);
    else route();
    if (received.attachment && this.media) {
      const context = { tenantId: entry.tenantId, conversationId: received.conversationId, channelId: entry.channelId };
      const task = this.media.capture(received.attachment.id, context, () => { if (this.closing || entry.stopped || this.entries.get(entry.channelId) !== entry) fail(409, 'A conexão mudou.'); return this.downloadMedia(entry, received.mediaItem); }).then(metadata => {
        this.store.mutate(entry.actor, entry.tenantId, 'Telegram: arquivo registrado', tenant => {
          const conversation = this.store.getConversation(tenant, received.conversationId), item = conversation.messages.find(item => item.id === received.messageId);
          if (item) { item.attachments = [metadata]; conversation.version++; }
        });
      }).catch(() => { entry.error = 'Um arquivo está indisponível.'; }).finally(() => this.mediaTasks.delete(task));
      this.mediaTasks.add(task);
    }
    return incomingTask;
  }
  /**
   * "Digitando…" for an already authorized private conversation (ServiceTyping): sendChatAction typing, which Telegram
   * shows for about five seconds or until the next message. There is no explicit stop, so paused is a no-op.
   */
  async sendTyping({ tenantId, channel, conversation, state, reauthorize = () => true }) {
    if (channel?.transport !== 'telegram-bot') return { supported: false, sent: false, reason: 'channel' };
    if (!['composing', 'paused'].includes(state)) fail(400, 'Use state composing ou paused.');
    if (!/^-?\d+$/.test(conversation?.remoteChatId || '')) return { supported: false, sent: false, reason: 'conversation' };
    if (state === 'paused') return { supported: true, sent: false, reason: 'expires' };
    const entry = this.entries.get(channel.id);
    if (channel.enabled === false || !entry || entry.tenantId !== tenantId || entry.state !== 'connected' || entry.stopped) return { supported: true, sent: false, reason: 'disconnected' };
    reauthorize();
    const threadId = Number(conversation.threadId);
    await this.call(entry, 'sendChatAction', { chat_id: conversation.remoteChatId, action: 'typing', ...(Number.isSafeInteger(threadId) && threadId > 0 ? { message_thread_id: threadId } : {}) }, AbortSignal.timeout(4000));
    return { supported: true, sent: true };
  }
  async send(session, tenantId, conversationId, input, {reauthorize=()=>{}, attribution=null}={}) {
    reauthorize();
    const tenant = this.store.tenant(session, tenantId), conversation = this.store.getConversation(tenant, conversationId, input.version);
    const service = session?.kind === 'service' && session.serviceId && !session.userId;
    // The autopilot answers only conversations owned by its agent; canReply decides through its live execution.
    const autopilot = session?.kind === 'service' && session.autopilot === true && !session.userId && !session.serviceId;
    if ((service || autopilot) && !this.operations?.canReply) fail(403, 'O envio do serviço precisa de autorização explícita.');
    if (autopilot && !automatedAttribution(attribution)) fail(403, 'O envio automático precisa da tarefa e do agente que o autorizaram.');
    this.operations?.canReply(session,tenantId,conversation);
    const { channel } = this.channel(session, tenantId, conversation.channelId), entry = this.entries.get(channel.id);
    if (!entry || entry.state !== 'connected') fail(409, 'O bot não está conectado.');
    if (autopilot ? conversation.owner !== 'agent' : conversation.owner !== 'human' && !service) fail(409, 'Assuma a conversa antes de responder.');
    if (input.channelId !== channel.id || !/^-?\d+$/.test(conversation.remoteChatId || '')) fail(400, 'A resposta precisa usar o chat e canal de origem.');
    let reply = outgoingReply(conversation, input);
    const ids = attachmentIds(input), messageText = outgoingText(input, ids.length > 0);
    this.assertGroupAllowed(session, tenantId, channel.id, conversation.remoteChatId, ids.length ? {} : { method: 'sendMessage' });
    if (ids.length && !this.media) fail(503, 'Armazenamento de arquivos indisponível.');
    const files = ids.length ? await this.media.resolve(ids, { tenantId, conversationId, channelId: channel.id, reauthorize: () => {
      reauthorize(); const current = this.store.getConversation(this.store.tenant(session, tenantId), conversationId, input.version);
      this.operations?.canReply(session, tenantId, current); this.assertGroupAllowed(session, tenantId, channel.id, current.remoteChatId);
    } }) : [];
    reauthorize();
    const file = files[0], selected = file ? outgoingMediaMethod(file) : ['sendMessage', null], [method] = selected;
    this.assertGroupAllowed(session, tenantId, channel.id, conversation.remoteChatId, { method });
    if (this.entries.get(channel.id) !== entry || entry.state !== 'connected') fail(409, 'A conexão mudou. Atualize antes de enviar.');
    const id = randomUUID();
    this.store.mutate(session, tenantId, 'Telegram: envio solicitado', state => {
      const current = this.store.getConversation(state, conversationId, input.version);
      this.operations?.canReply(session,tenantId,current);
      const currentChannel = state.channels.find(item => item.id === channel.id);
      if (!currentChannel || currentChannel.transport !== 'telegram-bot' || current.channelId !== channel.id || !groupAllowed(state, currentChannel, current.remoteChatId, true)) fail(409, 'Este grupo não está habilitado para atendimento neste canal ou o bot não pode responder.');
      if (!methodAllowed(state, currentChannel, current.remoteChatId, method)) fail(409, `O bot não tem permissão para enviar ${permissionLabels[methodPermissions[method]]} neste grupo.`);
      reply = outgoingReply(current, input);
      if (autopilot && current.owner !== 'agent') fail(409, 'O atendimento saiu do agente antes do envio automático.');
      current.messages.push({ id, kind: service || autopilot ? 'agent' : 'human', text: messageText, ...(file ? { attachments: [file.metadata] } : {}), ...(reply ? { replyToMessageId: reply.messageId } : {}), authorUserId:session.userId||null,authorName:session.name, ...(service ? { authorServiceId: session.serviceId, agentId: session.agentId, serviceCommandId: input.idempotencyKey } : {}), ...(autopilot ? { agentId: attribution.agentId, autopilotJobId: attribution.autopilotJobId } : {}), createdAt: new Date().toISOString(), delivery: 'pending', transport: 'telegram' });
      current.version++; current.updatedAt = new Date().toISOString();
    });
    try {
      let payload;
      if (file) {
        payload = new FormData();
        payload.set('chat_id', conversation.remoteChatId);
        if (conversation.threadId) payload.set('message_thread_id', String(conversation.threadId));
        if (reply) payload.set('reply_parameters', JSON.stringify({ message_id: reply.providerMessageId, allow_sending_without_reply: false }));
        if (messageText) payload.set('caption', messageText);
        payload.set(selected[1], new Blob([file.bytes], { type: file.metadata.mime }), file.metadata.name);
      } else { payload = { chat_id: conversation.remoteChatId, ...(conversation.threadId ? { message_thread_id: conversation.threadId } : {}), text: messageText, ...(reply ? { reply_parameters: { message_id: reply.providerMessageId, allow_sending_without_reply: false } } : {}) }; }
      const sent = await this.call(entry, method, payload);
      this.store.mutate(session, tenantId, 'Telegram: envio aceito', state => {
        const current = this.store.getConversation(state, conversationId), item = current.messages.find(item => item.id === id);
        item.externalId = `${sent.chat.id}:${sent.message_id}`; item.delivery = 'sent'; current.unread = 0;
        this.store.db.prepare('INSERT OR IGNORE INTO telegram_seen VALUES (?,?,?)').run(channel.id, String(sent.chat.id), String(sent.message_id));
      });
    } catch (error) {
      const definite = error.providerCode >= 400 && error.providerCode < 500;
      const migration = definite && Number.isSafeInteger(error.migrateToChatId) && error.migrateToChatId < 0;
      let migrationApplied = false;
      this.store.mutate(session, tenantId, 'Telegram: envio não confirmado', state => {
        this.store.getConversation(state, conversationId).messages.find(item => item.id === id).delivery = definite ? 'failed' : 'unconfirmed';
        if (migration) migrationApplied = migrateGroup(state, state.channels.find(c => c.id === channel.id), conversation.remoteChatId, String(error.migrateToChatId));
      });
      if (migration) fail(409, migrationApplied ? 'O grupo virou um supergrupo. Destino atualizado; confira e envie novamente.' : 'A migração tem vínculos conflitantes. Históricos preservados; atendimento bloqueado para revisão administrativa.');
      fail(502, definite ? error.message : 'Envio sem confirmação. Confira o chat antes de tentar novamente.');
    }
    return this.store.tenant(session, tenantId).conversations.find(item => item.id === conversationId);
  }
  async setProfile(session, tenantId, channelId, input) {
    this.store.admin(session); this.channel(session, tenantId, channelId);
    const entry = this.entries.get(channelId);
    if (entry?.state !== 'connected') fail(409, 'Conecte o bot antes de personalizar.');
    const profile = { name: text(input.name, 64), about: text(input.about, 120), description: text(input.description, 512) };
    await this.call(entry, 'setMyName', { name: profile.name });
    await this.call(entry, 'setMyShortDescription', { short_description: profile.about });
    await this.call(entry, 'setMyDescription', { description: profile.description });
    await this.call(entry, 'setMyCommands', { commands: [{ command: 'start', description: 'Iniciar atendimento' }, { command: 'ajuda', description: 'Pedir ajuda à equipe' }, { command: 'atendente', description: 'Solicitar atendimento humano' }] });
    this.store.mutate(session, tenantId, 'Telegram: identidade do bot personalizada', tenant => { tenant.channels.find(item => item.id === channelId).botProfile = profile; });
    return { profile, configured: true };
  }
  async restore() {
    clearTimeout(this.restoreTimer);
    let failed = false;
    for (const row of this.store.db.prepare('SELECT id,reseller_id,data FROM tenants').all()) {
      for (const channel of JSON.parse(row.data).channels) {
        if (channel.transport !== 'telegram-bot' || !['connected', 'reconnecting'].includes(channel.state)) continue;
        try { await this.start(this.actor(row.reseller_id), row.id, channel.id); } catch { failed = true; }
      }
    }
    if (failed && !this.closing) {
      this.restoreTimer = setTimeout(() => this.restore().catch(() => {}), Math.max(30000, this.retryDelay));
      this.restoreTimer.unref();
    }
  }
  connectedCount() { return [...this.entries.values()].filter(entry => entry.state === 'connected').length; }
  async close() {
    this.closing = true;
    clearTimeout(this.restoreTimer);
    for (const entry of this.entries.values()) { entry.stopped = true; entry.abort.abort(); clearTimeout(entry.timer); entry.wake?.(); }
    await Promise.allSettled([...this.entries.values()].map(entry => entry.task));
    await Promise.allSettled([...this.mediaTasks]);
  }
}
