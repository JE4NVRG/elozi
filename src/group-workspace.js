import { fail } from './store.js';

const groupJid = value => typeof value === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(value);
const telegramId = value => typeof value === 'string' && /^-[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const participantId = value => typeof value === 'string' && /^(?:\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)|-?[1-9]\d{0,15})$/.test(value) ? value : null;
const safeText = (value, max = 80) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').replace(/(?:https?:\/\/|tg:\/\/|www\.)\S+/gi, '[link]').slice(0, max) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const identity = actor => JSON.stringify([actor?.userId, actor?.resellerId, actor?.kind || null, actor?.supportGrantId || null]);

/** Read selection only; text/media send restrictions never grant or remove directory access. */
export function selectedGroup(channel, conversation) {
  if (!channel || channel.id !== conversation?.channelId) return false;
  if (channel.transport === 'baileys') return groupJid(conversation.remoteJid) && (channel.allowedGroups || []).includes(conversation.remoteJid);
  if(channel.transport==='telegram-user')return /^-[1-9]\d{0,18}$/.test(conversation.remoteChatId||'')&&(channel.telegramUser?.selectedPeerIds||[]).includes(conversation.remoteChatId);
  if (channel.transport !== 'telegram-bot' || !telegramId(conversation.remoteChatId)) return false;
  const config = channel.telegramGroups || {}, id = conversation.remoteChatId;
  const group = (config.known || []).find(item => item.id === id || (item.aliases || []).includes(id));
  const aliases = [id, ...(conversation.chatAliases || []), group?.id, ...(group?.aliases || [])].filter(Boolean);
  if ((config.migrationConflicts || []).some(item => aliases.includes(item.fromGroupId) || aliases.includes(item.toGroupId)) || group?.joined === false) return false;
  return config.mode !== 'selected' || (config.groupIds || []).includes(group?.id || id);
}

function summary(conversation, channel) {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const lastMessageAt = messages.reduce((latest, message) => {
    if (!['customer', 'human','agent'].includes(message.kind)) return latest;
    const timestamp = date(message.createdAt);
    return timestamp && (!latest || timestamp > latest) ? timestamp : latest;
  }, null);
  return { conversationId: conversation.id, version: count(conversation.version) || 1, title: safeText(conversation.contact) || 'Grupo', channelId: channel.id, channelName: safeText(channel.name) || 'Conexão', transport: channel.transport, state: safeText(channel.state, 32) || 'unknown', lastMessageAt, unread: count(conversation.unread) || 0, historyCount: messages.filter(item=>['customer','human','agent'].includes(item.kind)).length,aiAllowed:channel.transport!=='telegram-user'&&channel.kind!=='telegram_user' };
}

/** Human-only, read-only group context. Provider objects never become public DTOs. */
export class GroupWorkspace {
  constructor(store, { gateway, telegram, telegramUser, authorize, now = Date.now, timeoutMs = 10000, maxParticipants = 40, maxPending = 4 } = {}) {
    if (typeof store?.tenant !== 'function' || typeof authorize !== 'function' || typeof now !== 'function') throw Error('Configuração de contexto de grupos inválida.');
    this.store = store; this.gateway = gateway; this.telegram = telegram;this.telegramUser=telegramUser; this.authorize = authorize; this.now = now;
    this.timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 10000) : 10000;
    this.maxParticipants = Number.isInteger(maxParticipants) && maxParticipants > 0 ? Math.min(maxParticipants, 100) : 40;
    this.maxPending = Number.isInteger(maxPending) && maxPending > 0 ? Math.min(maxPending, 8) : 4;
    this.pending = 0;
  }
  human(actor) { if (!actor?.userId || actor.kind === 'service') fail(403, 'O contexto de grupos exige acesso humano.'); }
  authorizeSync(actor, tenantId, conversation) {
    const result = this.authorize(actor, tenantId, conversation);
    if (result?.then) { Promise.resolve(result).catch(() => {}); fail(500, 'A autorização de grupos precisa ser síncrona.'); }
    if (result === false) fail(403, 'Seu acesso não permite consultar este grupo.');
  }
  directory(actor, tenantId) {
    this.human(actor);
    const tenant = this.store.tenant(actor, tenantId), groups = [];
    for (const conversation of tenant.conversations || []) {
      const channel = tenant.channels.find(item => item.id === conversation.channelId);
      if (conversation.conversationKind !== 'group' || !selectedGroup(channel, conversation)) continue;
      try { this.authorizeSync(actor, tenantId, conversation); }
      catch (error) { if ([403, 404].includes(error.status)) continue; throw error; }
      groups.push(summary(conversation, channel));
    }
    return { tenantId, groups: groups.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || '') || a.title.localeCompare(b.title, 'pt-BR') || a.conversationId.localeCompare(b.conversationId)) };
  }
  resolve(actor, tenantId, conversationId) {
    this.human(actor);
    const tenant = this.store.tenant(actor, tenantId), conversation = tenant.conversations.find(item => item.id === conversationId);
    if (!conversation) fail(404, 'Conversa não encontrada nesta empresa.');
    this.authorizeSync(actor, tenantId, conversation);
    const channel = tenant.channels.find(item => item.id === conversation.channelId);
    if (conversation.conversationKind !== 'group') fail(400, 'Esta conversa não é um grupo.');
    if (!selectedGroup(channel, conversation)) fail(409, 'Este grupo não está habilitado nesta conexão.');
    const gateway = channel.transport === 'baileys' ? this.gateway : channel.transport==='telegram-user'?this.telegramUser:this.telegram;
    const entry = gateway?.entries?.get(channel.id);
    return { tenant, conversation, channel, gateway, entry };
  }
  observedParticipants(conversation, transport) {
    const observed = new Map();
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.kind !== 'customer' || message.conversationId && message.conversationId !== conversation.id) continue;
      const id = participantId(transport === 'baileys' ? message.senderJid : message.senderId);
      if (id && !observed.has(id)) observed.set(id, { id, name: safeText(message.senderName) || 'Participante', role: 'unknown' });
      if (observed.size > this.maxParticipants) break;
    }
    return { items: [...observed.values()].slice(0, this.maxParticipants), total: null, complete: false, source: observed.size ? 'observed' : 'unavailable', availability: observed.size ? 'available' : 'unavailable', limit: this.maxParticipants, truncated: observed.size > this.maxParticipants };
  }
  async context(actor, tenantId, conversationId, { reauthorize = () => {} } = {}) {
    if (typeof reauthorize !== 'function') fail(400, 'Informe uma validação de sessão válida.');
    const initialIdentity = identity(actor);
    const fresh = () => {
      const result = reauthorize();
      if (result?.then) { Promise.resolve(result).catch(() => {}); fail(500, 'A validação de sessão precisa ser síncrona.'); }
      if (result === false || identity(actor) !== initialIdentity) fail(403, 'O acesso ao grupo mudou. Abra novamente o contexto.');
      return this.resolve(actor, tenantId, conversationId);
    };
    const origin = current => JSON.stringify([current.channel.id, current.channel.transport, current.conversation.remoteJid || current.conversation.remoteChatId, current.conversation.threadId || null, current.channel.transport === 'baileys' ? current.channel.whatsappGroupsVersion || 0 : (current.channel.transport==='telegram-user'?current.channel.telegramUser?.version:current.channel.telegramGroups?.version)||0]);
    const initial = fresh(), original = origin(initial);
    const recheck = () => {
      const current = fresh();
      if (origin(current) !== original) fail(409, 'A origem ou seleção do grupo mudou. Abra novamente o contexto.');
      if (current.entry !== initial.entry || current.entry?.generation !== initial.entryGeneration) fail(409, 'A conexão mudou. Abra novamente o contexto.');
      return current;
    };
    initial.entryGeneration = initial.entry?.generation;
    const connected = value => !value.gateway?.closing && value.entry?.tenantId === tenantId && value.entry?.channelId === value.channel.id && value.entry.state === 'connected' && value.channel.state === 'connected' && !value.entry.stopped && (value.channel.transport !== 'baileys' || value.entry.matched);
    const known = (initial.channel.telegramGroups?.known || []).find(item => item.id === initial.conversation.remoteChatId || (item.aliases || []).includes(initial.conversation.remoteChatId));
    let group = { title: safeText(initial.conversation.contact) || 'Grupo', description: null, type: known?.type === 'supergroup' ? 'supergroup' : 'group', announcement: null, forum: null, source: 'observed', availability: 'unavailable', observedAt: null };
    let participants = this.observedParticipants(initial.conversation, initial.channel.transport);
    if (connected(initial) && this.pending < this.maxPending) {
      this.pending++;
      const controller = new AbortController(); let timer;
      const expired = Symbol('expired');
      const read = async operation => {
        const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(expired); }, this.timeoutMs); });
        try {
          const result = await Promise.race([Promise.resolve().then(operation).catch(() => expired), timeout]);
          const current = recheck();
          if (!connected(current)) fail(409, 'A conexão mudou. Abra novamente o contexto.');
          return result === expired ? null : result;
        } finally { clearTimeout(timer); }
      };
      try {
        if (initial.channel.transport === 'baileys') {
          const peer = initial.conversation.remoteJid, cached = initial.entry.groupCache?.get(peer);
          const source = cached?.id === peer ? 'cache' : 'provider';
          const metadata = source === 'cache' ? cached : typeof initial.entry.socket?.groupMetadata === 'function' ? await read(() => initial.entry.socket.groupMetadata(peer)) : null;
          recheck();
          if (metadata?.id === peer) {
            group = { title: safeText(metadata.subject) || group.title, description: safeText(metadata.desc, 1024) || null, type: 'group', announcement: typeof metadata.announce === 'boolean' ? metadata.announce : null, forum: null, source, availability: 'available', observedAt: source === 'provider' ? new Date(this.now()).toISOString() : null };
            const members = new Map();
            for (const member of Array.isArray(metadata.participants) ? metadata.participants : []) {
              const id = participantId(member.id); if (!id || members.has(id)) continue;
              members.set(id, { id, name: safeText(member.name || member.notify) || 'Participante', role: member.admin === 'superadmin' || member.isSuperAdmin === true ? 'owner' : member.admin === 'admin' || member.isAdmin === true ? 'admin' : 'member' });
              if (members.size > this.maxParticipants) break;
            }
            const total = count(metadata.size);
            participants = { items: [...members.values()].slice(0, this.maxParticipants), total, complete: false, source, availability: Array.isArray(metadata.participants) ? 'available' : 'unavailable', limit: this.maxParticipants, truncated: members.size > this.maxParticipants || total !== null && total > members.size };
          }
        } else if (typeof initial.gateway?.call === 'function') {
          const peer = initial.conversation.remoteChatId;
          const metadata = await read(() => initial.gateway.call(initial.entry, 'getChat', { chat_id: peer }, controller.signal));
          if (String(metadata?.id) === peer && ['group', 'supergroup'].includes(metadata.type)) {
            group = { title: safeText(metadata.title) || group.title, description: safeText(metadata.description, 1024) || null, type: metadata.type, announcement: null, forum: typeof metadata.is_forum === 'boolean' ? metadata.is_forum : null, source: 'provider', availability: 'available', observedAt: new Date(this.now()).toISOString() };
            const total = await read(() => initial.gateway.call(initial.entry, 'getChatMemberCount', { chat_id: peer }, controller.signal));
            participants.total = count(total);
            participants.truncated ||= participants.total !== null && participants.total > participants.items.length;
          }
        }
      } finally { controller.abort(); clearTimeout(timer); this.pending--; }
    }
    const current = recheck();
    return { tenantId, ...summary(current.conversation, current.channel), group, topic: Number.isSafeInteger(current.conversation.threadId) && current.conversation.threadId > 0 ? { id: current.conversation.threadId, title: null, source: 'observed' } : null, participants };
  }
}
