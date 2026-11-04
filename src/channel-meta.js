import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { encryptedChannelSecrets } from './channel-secrets.js';
import { loadLocalKey } from './wa-auth.js';
import { clearConversationParticipants, noteStatus } from './operations.js';
import { attachmentIds, outgoingText, MAX_MEDIA_BYTES } from './media.js';
import { createMetaMediaDownloader, metaMediaURL, META_RECEIVE_KINDS, META_SEND_KINDS, MESSENGER_UPLOAD_MIMES, messengerUploadDescriptor, validateMessengerUpload } from './meta-media.js';
import { allowedFields } from './access.js';
import { fail } from './store.js';
import { syncIncomingConversationContact } from './contacts.js';
import { automatedSender, automatedAttribution, automatedFields } from './outbox.js';

const kinds = Object.freeze(['instagram', 'messenger']);
const transport = kind => `meta-${kind}`;
const remoteId = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\p{Cc}]/u.test(value);
const apiVersion = value => typeof value === 'string' && /^v[1-9]\d{0,2}\.0$/.test(value);
const secretValue = value => typeof value === 'string' && value.length >= 8 && value.length <= 8192 && value === value.trim() && !/\p{Cc}/u.test(value);
const sync = (fn, ...args) => { const value = fn(...args); if (value && typeof value.then === 'function') { value.catch?.(() => {}); fail(500, 'A autorização e persistência Meta precisam ser síncronas.'); } return value; };
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const sameSecret = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
const publicMedia = (attachments, reference) => {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > 10) fail(400, 'Referências de mídia Meta inválidas.');
  return attachments.map((item, index) => ({ id: randomUUID(), kind: ['image', 'audio', 'video'].includes(item?.type) ? item.type : 'document', name: 'Mídia recebida na rede social',
    mime: 'application/octet-stream', size: 0, status: 'unavailable', preview: false, reason: 'external_reference', remoteReference: { ...reference, index } }));
};

/** Official Meta messaging endpoints; configuration is not proof of account acceptance. */
export class MetaGateway {
  constructor(store, { operations, onIncoming, authKey, secretLoader, fetchImpl = fetch, now = Date.now, media = null,
    mediaDownloader = createMetaMediaDownloader(),
    maxEventAgeMs = 48 * 3600_000, maxBodyBytes = 256_000, maxEvents = 100, timeoutMs = 15_000, mediaTimeoutMs = 180_000 } = {}) {
    if (!store?.db || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof mediaDownloader !== 'function' || (secretLoader !== undefined && typeof secretLoader !== 'function')
      || media !== null && ['placeholder', 'capture'].some(name => typeof media[name] !== 'function')
      || !Number.isSafeInteger(maxEventAgeMs) || maxEventAgeMs < 60_000 || maxEventAgeMs > 7 * 24 * 3600_000
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1_000_000
      || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
      || !Number.isSafeInteger(mediaTimeoutMs) || mediaTimeoutMs < 100 || mediaTimeoutMs > 180_000) throw new Error('Configuração do adaptador Meta inválida.');
    Object.assign(this, { store, operations, onIncoming, authKey, secretLoader, fetch: fetchImpl, now, media, mediaDownloader, maxEventAgeMs, maxBodyBytes, maxEvents, timeoutMs, mediaTimeoutMs });
    this.closed = false; this.pending = new Set(); this.mediaTasks = new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS meta_channel_bindings (
      kind TEXT NOT NULL CHECK(kind IN ('instagram','messenger')), resource_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id), channel_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
      PRIMARY KEY(kind,resource_id));
      CREATE TABLE IF NOT EXISTS meta_inbound_receipts (
      tenant_id TEXT NOT NULL REFERENCES tenants(id), channel_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL, sender_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id,channel_id,resource_id,provider_message_id));
      CREATE INDEX IF NOT EXISTS meta_reply_window ON meta_inbound_receipts(tenant_id,channel_id,resource_id,sender_id,conversation_id,source_timestamp);`);
  }

  time() { const value = sync(this.now); if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail(500, 'Relógio Meta inválido.'); return value; }
  actor(resellerId) { return { role: 'reseller', resellerId, name: 'Gateway Meta' }; }
  async secrets(context) {
    if (this.secretLoader) return this.secretLoader(context);
    this.authKey ||= await loadLocalKey();
    return encryptedChannelSecrets(this.store.db, this.authKey);
  }
  secretData(storage, channelId) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') fail(503, 'Armazenamento cifrado do canal indisponível.');
    const all = sync(storage.get.bind(storage), channelId) || {}, meta = all.meta;
    return { all, meta };
  }
  channel(actor, tenantId, channelId) {
    const tenant = this.store.tenant(actor, tenantId), channel = tenant.channels.find(channel => channel.id === channelId);
    if (!channel || !kinds.includes(channel.kind)) fail(404, 'Canal Meta indisponível nesta empresa.');
    return { actor, tenant, channel };
  }
  admin(actor) {
    if (this.closed) fail(503, 'Adaptador Meta encerrado.');
    if (!this.operations?.admin) fail(503, 'Autorização do canal indisponível.');
    sync(this.operations.admin.bind(this.operations), actor); this.store.admin(actor);
  }
  authority(actor, reauthorize, identity) {
    if (typeof reauthorize !== 'function') fail(400, 'Informe uma validação de sessão válida.');
    if (sync(reauthorize) === false) fail(403, 'A sessão do canal foi revogada.');
    if (identity && (actor.userId !== identity.userId || actor.resellerId !== identity.resellerId || (actor.supportGrantId || null) !== identity.supportGrantId)) fail(403, 'A sessão do canal mudou.');
  }

  async configure(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'resourceId', 'apiVersion', 'enabled', 'accessToken', 'appSecret', 'verifyToken']);
    this.authority(actor, reauthorize); this.admin(actor);
    const first = this.channel(actor, tenantId, channelId), revision = first.channel.meta?.version || 0;
    if (!Number.isSafeInteger(input.version) || input.version !== revision || input.version < 0 || input.version >= Number.MAX_SAFE_INTEGER) fail(409, 'A configuração Meta mudou. Atualize antes de salvar.');
    const settings = { resourceId: input.resourceId ?? first.channel.meta?.resourceId, apiVersion: input.apiVersion ?? first.channel.meta?.apiVersion,
      enabled: input.enabled ?? first.channel.meta?.enabled ?? true };
    if (!remoteId(settings.resourceId) || !apiVersion(settings.apiVersion) || typeof settings.enabled !== 'boolean') fail(400, 'Informe o recurso Meta, uma versão explícita vN.0 e o estado do canal.');
    const identity = { userId: actor.userId, resellerId: actor.resellerId, supportGrantId: actor.supportGrantId || null };
    const storage = await this.secrets({ tenantId, channelId });
    this.authority(actor, reauthorize, identity); this.admin(actor);
    const current = this.channel(actor, tenantId, channelId);
    if (current.channel.kind !== first.channel.kind || (current.channel.meta?.version || 0) !== revision) fail(409, 'A configuração Meta mudou.');
    const { all, meta: previous } = this.secretData(storage, channelId);
    const credentials = { ...previous, accessToken: input.accessToken ?? previous?.accessToken, appSecret: input.appSecret ?? previous?.appSecret,
      verifyToken: input.verifyToken ?? previous?.verifyToken };
    if (!Object.values({ accessToken: credentials.accessToken, appSecret: credentials.appSecret, verifyToken: credentials.verifyToken }).every(secretValue)) fail(400, 'Cadastre token de acesso, segredo do app e token de verificação válidos pelo formulário do canal.');
    this.store.mutate(actor, tenantId, 'Meta: configuração atualizada', tenant => {
      this.authority(actor, reauthorize, identity); this.admin(actor);
      const channel = tenant.channels.find(channel => channel.id === channelId);
      if (!channel || channel.kind !== first.channel.kind || (channel.meta?.version || 0) !== revision) fail(409, 'A configuração Meta mudou.');
      const binding = this.store.db.prepare('SELECT tenant_id,channel_id FROM meta_channel_bindings WHERE kind=? AND resource_id=?').get(channel.kind, settings.resourceId);
      if (binding && (binding.tenant_id !== tenantId || binding.channel_id !== channelId)) fail(409, 'Este recurso Meta já pertence a outro canal.');
      this.store.db.prepare('DELETE FROM meta_channel_bindings WHERE channel_id=? AND tenant_id=?').run(channelId, tenantId);
      this.store.db.prepare('INSERT INTO meta_channel_bindings VALUES (?,?,?,?,?)').run(channel.kind, settings.resourceId, tenantId, channelId, revision + 1);
      sync(storage.set.bind(storage), channelId, { ...all, meta: credentials });
      channel.meta = { ...settings, version: revision + 1, credentialsConfigured: true };
      channel.transport = transport(channel.kind); channel.state = settings.enabled ? 'configured' : 'disconnected';
      channel.label = settings.enabled ? 'Meta configurada · aceite da conta pendente' : 'Meta desativada';
    });
    return this.status(actor, tenantId, channelId);
  }

  status(actor, tenantId, channelId) {
    this.admin(actor);
    const { channel } = this.channel(actor, tenantId, channelId), config = channel.meta;
    return { state: config?.enabled ? channel.state || 'configured' : 'disconnected', kind: channel.kind, version: config?.version || 0,
      resourceId: config?.resourceId || null, apiVersion: config?.apiVersion || null, enabled: config?.enabled === true,
      configured: config?.credentialsConfigured === true, lastWebhookAt: config?.lastWebhookAt || null, ...this.mediaCapabilities(channel.kind) };
  }

  mediaCapabilities(kind) {
    const available = this.media && ['record', 'resolve'].every(name => typeof this.media[name] === 'function'), supported = Boolean(available && META_SEND_KINDS[kind]?.length);
    return { mediaSupported: supported, mediaKinds: supported ? [...META_SEND_KINDS[kind]] : [], mediaMimes: supported ? [...MESSENGER_UPLOAD_MIMES] : [],
      mediaMaxBytes: MAX_MEDIA_BYTES, mediaCaptionSupported: false, voiceSupported: false, inboundMediaSupported: Boolean(this.media),
      inboundMediaKinds: this.media ? [...(META_RECEIVE_KINDS[kind] || [])] : [] };
  }

  validateOutgoing(kind, input) {
    const ids = attachmentIds(input);
    if (input.replyToMessageId) fail(400, 'A citação Meta ainda não está disponível neste adaptador.');
    if (ids.length && kind !== null && !this.mediaCapabilities(kind).mediaSupported) fail(400, 'Upload privado de mídia não está disponível para este canal Meta.');
    const content = outgoingText(input, ids.length > 0);
    if (ids.length && content) fail(400, 'Envie o arquivo Messenger sem legenda nesta conexão.');
    if ([...content].length > 1000 || Buffer.byteLength(content) > 4000) fail(400, 'A resposta Meta aceita até 1000 caracteres neste adaptador.');
    return { ids, content };
  }

  incomingMedia(attachments, input, reference, jobs, context) {
    if (!this.media) return attachments;
    return attachments.map((fallback, index) => {
      const source = input[index], kind = source?.type === 'file' ? 'document' : source?.type;
      if (!META_RECEIVE_KINDS[reference.kind].includes(kind)) return fallback;
      try { metaMediaURL(source?.payload?.url); } catch { return fallback; }
      const size = Number.isSafeInteger(source.payload?.size) && source.payload.size >= 0 ? source.payload.size : 0;
      const mime = { image: 'image/jpeg', audio: 'audio/mpeg', video: 'video/mp4', document: 'application/octet-stream' }[kind];
      const metadata = this.media.placeholder(context, { kind, mime, size, name: 'Mídia Meta recebida' });
      if (metadata.status === 'pending') jobs.push({ context, id: metadata.id, url: source.payload.url, kind, reference: fallback.remoteReference });
      return { ...metadata, remoteReference: fallback.remoteReference };
    });
  }

  captureIncoming(job, storage, credentials, revision) {
    const controller = new AbortController(); this.pending.add(controller);
    const reauthorize = () => {
      const current = this.publicContext(job.context.tenantId, job.context.channelId, revision), secrets = this.secretData(storage, job.context.channelId).meta;
      if (current.config.resourceId !== job.reference.resourceId || current.channel.kind !== job.reference.kind || !sameSecret(secrets?.appSecret, credentials.appSecret)) fail(409, 'A autorização da captura Meta mudou.');
    };
    const context = { ...job.context, reauthorize };
    // Only this closure/queue knows the signed CDN URL. DTOs, agents and history do not.
    const task = this.media.capture(job.id, context, async () => {
      reauthorize();
      const result = await this.mediaDownloader({ url: job.url, kind: job.kind, signal: controller.signal, reauthorize });
      reauthorize();
      return result;
    }).then(metadata => {
      reauthorize();
      this.store.mutate(this.actor(this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(context.tenantId).reseller_id), context.tenantId, 'Meta: captura privada processada', tenant => {
        reauthorize(); const conversation = this.store.getConversation(tenant, context.conversationId), message = conversation.messages.find(item => item.id === context.messageId);
        if (!message || message.providerResourceId !== job.reference.resourceId || message.providerMessageId !== job.reference.messageId || conversation.channelId !== context.channelId) fail(409, 'O atendimento da captura Meta mudou.');
        message.attachments = message.attachments.map(item => item.id === job.id ? { ...metadata, remoteReference: job.reference } : item);
        conversation.version++;
      });
    }).catch(() => {
      // A disabled/replaced binding cannot publish bytes. Preserve the original
      // scoped receipt as unavailable without inheriting access from the new binding.
      try { this.store.mutate(this.actor(this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(context.tenantId).reseller_id), context.tenantId, 'Meta: captura privada indisponível', tenant => {
        const conversation = this.store.getConversation(tenant, context.conversationId), message = conversation.messages.find(item => item.id === context.messageId);
        if (!message || conversation.channelId !== context.channelId || message.providerResourceId !== job.reference.resourceId || message.providerMessageId !== job.reference.messageId) return;
        message.attachments = message.attachments.map(item => item.id === job.id ? { ...item, status: 'unavailable', preview: false, reason: 'unavailable' } : item);
        conversation.version++;
      }); } catch { /* Keep committed receipt; never redownload it. */ }
    }).finally(() => {
      job.url = null; this.pending.delete(controller); this.mediaTasks.delete(task);
    });
    this.mediaTasks.add(task);
  }

  publicContext(tenantId, channelId, expectedRevision) {
    if (this.closed) fail(503, 'Adaptador Meta encerrado.');
    const row = this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId);
    if (!row) fail(404, 'Canal Meta indisponível.');
    const context = this.channel(this.actor(row.reseller_id), tenantId, channelId), config = context.channel.meta;
    const binding = this.store.db.prepare('SELECT kind,resource_id,tenant_id,version FROM meta_channel_bindings WHERE channel_id=?').get(channelId);
    if (context.channel.transport !== transport(context.channel.kind) || !config?.enabled || !config.credentialsConfigured
      || !remoteId(config.resourceId) || !apiVersion(config.apiVersion) || !binding || binding.tenant_id !== tenantId
      || binding.kind !== context.channel.kind || binding.resource_id !== config.resourceId || binding.version !== config.version
      || (expectedRevision !== undefined && config.version !== expectedRevision)) fail(409, 'A conexão Meta está desativada ou mudou.');
    return { ...context, config };
  }

  async verifyWebhook(tenantId, channelId, query) {
    allowedFields(query, ['hub.mode', 'hub.verify_token', 'hub.challenge']);
    const context = this.publicContext(tenantId, channelId), storage = await this.secrets({ tenantId, channelId });
    this.publicContext(tenantId, channelId, context.config.version);
    const { meta } = this.secretData(storage, channelId);
    if (query['hub.mode'] !== 'subscribe' || !secretValue(meta?.verifyToken) || !sameSecret(query['hub.verify_token'], meta.verifyToken)
      || typeof query['hub.challenge'] !== 'string' || !/^\d{1,128}$/.test(query['hub.challenge'])) fail(403, 'Verificação Meta recusada.');
    return query['hub.challenge'];
  }

  async receiveWebhook(tenantId, channelId, rawBody, signature) {
    if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > this.maxBodyBytes) fail(413, 'Corpo Meta inválido ou acima do limite.');
    const context = this.publicContext(tenantId, channelId), storage = await this.secrets({ tenantId, channelId });
    this.publicContext(tenantId, channelId, context.config.version);
    const { meta } = this.secretData(storage, channelId);
    if (!secretValue(meta?.appSecret) || typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)
      || !timingSafeEqual(createHmac('sha256', meta.appSecret).update(rawBody).digest(), Buffer.from(signature.slice(7), 'hex'))) fail(403, 'Assinatura Meta inválida.');
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { fail(400, 'JSON Meta inválido.'); }
    if (!payload || payload.object !== (context.channel.kind === 'messenger' ? 'page' : 'instagram') || !Array.isArray(payload.entry)
      || payload.entry.length > this.maxEvents) fail(400, 'Evento Meta incompatível com este canal.');
    const events = [];
    for (const entry of payload.entry) {
      if (entry?.id !== context.config.resourceId || (entry.messaging !== undefined && !Array.isArray(entry.messaging))) fail(403, 'O evento pertence a outro recurso Meta.');
      for (const event of entry.messaging || []) {
        events.push(event);
        if (events.length > this.maxEvents) fail(413, 'Quantidade de eventos Meta acima do limite.');
      }
    }
    const mediaJobs = [];
    const received = this.store.mutate(context.actor, tenantId, 'Meta: webhook verificado', tenant => {
      const fresh = this.publicContext(tenantId, channelId, context.config.version), receipts = [], now = this.time();
      for (const event of events) {
        const message = event?.message;
        if (!message || message.is_echo === true || message.is_deleted === true || message.is_unsupported === true) continue;
        if (event.recipient?.id !== fresh.config.resourceId || !remoteId(event.sender?.id) || !messageId(message.mid)) fail(403, 'Origem da mensagem Meta inválida.');
        if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > now + 300_000) fail(400, 'Horário da mensagem Meta inválido.');
        const hash = fingerprint(event), previous = this.store.db.prepare('SELECT * FROM meta_inbound_receipts WHERE tenant_id=? AND channel_id=? AND resource_id=? AND provider_message_id=?').get(tenantId, channelId, fresh.config.resourceId, message.mid);
        if (previous) {
          if (previous.content_hash !== hash) fail(409, 'O identificador Meta já foi recebido com outro conteúdo.');
          receipts.push({ conversationId: previous.conversation_id, messageId: previous.message_id, replayed: true }); continue;
        }
        if (event.timestamp < now - this.maxEventAgeMs) fail(400, 'A mensagem Meta está fora do prazo de entrada configurado.');
        if (message.text !== undefined && (typeof message.text !== 'string' || message.text.length > 4000 || Buffer.byteLength(message.text) > 16_000
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message.text))) fail(400, 'Texto Meta inválido ou acima do limite.');
        const attachments = publicMedia(message.attachments, { kind: fresh.channel.kind, resourceId: fresh.config.resourceId, messageId: message.mid }), content = message.text || '';
        if (!content && !attachments.length) continue;
        const resource = fresh.config.resourceId, sender = event.sender.id;
        let conversation = tenant.conversations.find(item => item.channelId === channelId && item.remoteSocialId === sender && item.socialResourceId === resource && item.socialKind === fresh.channel.kind);
        const newConversation = !conversation, date = new Date(event.timestamp).toISOString();
        if (!conversation) {
          const department = (tenant.departments || []).find(item => item.active !== false && item.id === tenant.defaultDepartmentId), name = fresh.channel.kind === 'instagram' ? 'Contato Instagram' : 'Contato Messenger';
          conversation = { id: randomUUID(), channelId, remoteSocialId: sender, socialResourceId: resource, socialKind: fresh.channel.kind,
            contact: name, initials: fresh.channel.kind === 'instagram' ? 'IG' : 'FB', conversationKind: 'direct', department: department?.name || 'Suporte', departmentId: department?.id || null,
            owner: 'queue', assignedUserId: null, status: 'open', version: 1, unread: 0, agentId: null, tags: [fresh.channel.kind === 'instagram' ? 'Instagram' : 'Messenger'], messages: [] };
          tenant.conversations.unshift(conversation);
        }
        const reopened = conversation.status === 'closed';
        if (reopened) {
          conversation.status = 'open'; clearConversationParticipants(conversation, context.actor, { origin: fresh.channel.kind, reason: 'Nova mensagem após encerramento.' });
          conversation.owner = 'queue'; conversation.assignedUserId = null; conversation.assignedUserName = null; conversation.agentId = null;
          delete conversation.assignedSupportGrantId; noteStatus(conversation, context.actor, 'closed', { origin: fresh.channel.kind });
        }
        syncIncomingConversationContact(tenant, conversation, tenant.channels.find(item => item.id === channelId));
        const localId = randomUUID();
        const mediaAttachments = this.incomingMedia(attachments, message.attachments, { kind: fresh.channel.kind }, mediaJobs,
          { tenantId, channelId, conversationId: conversation.id, messageId: localId });
        conversation.messages.push({ id: localId, externalId: `${fresh.channel.kind}:${resource}:${sender}:${message.mid}`, providerMessageId: message.mid,
          providerResourceId: resource, providerSenderId: sender, kind: 'customer', text: content, ...(mediaAttachments.length ? { attachments: mediaAttachments } : {}),
          senderId: sender, senderName: conversation.contact, createdAt: date, delivery: 'received', transport: fresh.channel.kind });
        conversation.version++; conversation.unread++; conversation.updatedAt = new Date(Math.max(Date.parse(conversation.updatedAt) || 0, event.timestamp)).toISOString();
        this.store.db.prepare('INSERT INTO meta_inbound_receipts VALUES (?,?,?,?,?,?,?,?,?,?)').run(tenantId, channelId, resource, message.mid, sender, hash, conversation.id, localId, event.timestamp, now);
        receipts.push({ conversationId: conversation.id, messageId: localId, conversationVersion: conversation.version, newConversation, reopened, replayed: false });
      }
      const channel = tenant.channels.find(item => item.id === channelId);
      channel.state = 'connected'; channel.label = 'Webhook Meta recebido'; channel.meta.lastWebhookAt = new Date(now).toISOString();
      return receipts;
    });
    for (const job of mediaJobs) this.captureIncoming(job, storage, meta, context.config.version);
    for (const receipt of received.filter(receipt => !receipt.replayed)) {
      try {
        this.publicContext(tenantId, channelId, context.config.version);
        await this.onIncoming?.({ actor: context.actor, tenantId, channelId }, receipt.conversationId, receipt.messageId, receipt);
      } catch { /* Preserve committed inbound. */ }
      try {
        this.publicContext(tenantId, channelId, context.config.version);
        this.operations?.routeIncoming?.(tenantId, receipt.conversationId);
      } catch { /* Operator can retry routing after the connection is restored. */ }
    }
    return { accepted: true, received: received.filter(item => !item.replayed).length, replayed: received.filter(item => item.replayed).length };
  }

  sendContext(actor, tenantId, conversationId, input, revision) {
    if (this.closed) fail(503, 'Adaptador Meta encerrado.');
    if (!this.operations?.canReply) fail(503, 'Autorização de resposta indisponível.');
    const tenant = this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId, input.version);
    sync(this.operations.canReply.bind(this.operations), actor, tenantId, conversation);
    const context = this.channel(actor, tenantId, conversation.channelId), config = context.channel.meta;
    this.publicContext(tenantId, context.channel.id, revision);
    // Automated senders (a service principal or the autopilot) answer only conversations owned by their agent; canReply decides.
    const { service, autopilot } = automatedSender(actor);
    if (input.channelId !== context.channel.id || conversation.owner !== (service || autopilot ? 'agent' : 'human') || conversation.status === 'closed'
      || !remoteId(conversation.remoteSocialId) || conversation.socialResourceId !== config.resourceId || conversation.socialKind !== context.channel.kind) fail(409, 'A resposta precisa usar o atendimento e recurso Meta de origem.');
    if (!this.replyWindow(actor, tenantId, conversationId).open) fail(409, 'A janela padrão de resposta Meta de 24 horas expirou. Aguarde nova mensagem do contato.');
    return { ...context, config, conversation };
  }

  /** Transport policy only: caller authorizes inbox visibility; no owner/key access. */
  replyWindow(actor, tenantId, conversationId, { tenant: loaded } = {}) {
    // A panel listing passes the tenant it read in this same synchronous tick instead of re-reading it per conversation.
    const reuse = loaded && loaded.id === tenantId && loaded.resellerId === actor.resellerId && Array.isArray(loaded.conversations);
    if (reuse && actor.role === 'operator' && !(actor.tenantIds || [actor.tenantId]).includes(tenantId)) fail(403, 'Esta empresa não está no seu acesso.');
    const tenant = reuse ? loaded : this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId);
    const channel = tenant.channels.find(item => item.id === conversation.channelId);
    if (!channel || !kinds.includes(channel.kind) || !remoteId(conversation.remoteSocialId)) return { open: false, expiresAt: null };
    let context; try { context = this.publicContext(tenantId, channel.id); } catch { return { open: false, expiresAt: null }; }
    if (conversation.socialKind !== channel.kind || conversation.socialResourceId !== context.config.resourceId) return { open: false, expiresAt: null };
    const latest = this.store.db.prepare('SELECT max(source_timestamp) AS last FROM meta_inbound_receipts WHERE tenant_id=? AND channel_id=? AND resource_id=? AND sender_id=? AND conversation_id=?').get(tenantId, channel.id, context.config.resourceId, conversation.remoteSocialId, conversationId).last;
    const now = this.time(), expires = latest + 24 * 3600_000;
    if (!Number.isSafeInteger(latest) || latest > now + 300_000 || !Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime())) return { open: false, expiresAt: null };
    return { open: now < expires, expiresAt: new Date(expires).toISOString() };
  }

  validateSchedule(actor, tenantId, conversationId, { text, dueAt }) {
    const tenant = this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId);
    const input = { text, version: conversation.version, channelId: conversation.channelId };
    const context = this.sendContext(actor, tenantId, conversationId, input);
    this.validateOutgoing(context.channel.kind, input);
    const due = typeof dueAt === 'string' ? Date.parse(dueAt) : NaN, expires = Date.parse(this.replyWindow(actor, tenantId, conversationId).expiresAt);
    if (!Number.isFinite(due) || due >= expires) fail(409, 'O agendamento precisa ocorrer dentro da janela padrão Meta de 24 horas.');
    return true;
  }

  async responseJSON(response) {
    const limit = 64_000, declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail(502, 'Confirmação Meta acima do limite.');
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) fail(502, 'Confirmação Meta acima do limite.');
          chunks.push(Buffer.from(value));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } finally { try { await reader.cancel(); } catch { /* Release provider body. */ } }
    }
    const body = await response.json();
    if (Buffer.byteLength(JSON.stringify(body)) > limit) fail(502, 'Confirmação Meta acima do limite.');
    return body;
  }

  async send(actor, tenantId, conversationId, input, { reauthorize = () => {}, attribution = null } = {}) {
    const validated = this.validateOutgoing(null, input), content = validated.content, ids = [...validated.ids];
    if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a revisão do atendimento.');
    const { autopilot } = automatedSender(actor), automated = automatedFields(actor, input, attribution);
    if (autopilot && !automatedAttribution(attribution)) fail(403, 'O envio automático precisa da tarefa e do agente que o autorizaram.');
    // Freeze the reviewed request before any asynchronous credential/media access.
    input = { version: input.version, channelId: input.channelId, text: content, attachmentIds: [...ids] };
    this.authority(actor, reauthorize);
    const identity = { userId: actor.userId, resellerId: actor.resellerId, supportGrantId: actor.supportGrantId || null };
    let context = this.sendContext(actor, tenantId, conversationId, input);
    this.validateOutgoing(context.channel.kind, input);
    const revision = context.config.version, origin = { channelId: context.channel.id, kind: context.channel.kind, resourceId: context.config.resourceId,
      apiVersion: context.config.apiVersion, recipientId: context.conversation.remoteSocialId };
    const scope = { tenantId, conversationId, channelId: context.channel.id };
    const descriptor = ids.length ? messengerUploadDescriptor(this.media.record(ids[0], scope, { uploadOnly: true }).metadata) : null;
    const mediaHash = descriptor ? fingerprint(descriptor.metadata) : null;
    const storage = await this.secrets({ tenantId, channelId: context.channel.id });
    this.authority(actor, reauthorize, identity);
    context = this.sendContext(actor, tenantId, conversationId, input, revision);
    const { meta } = this.secretData(storage, context.channel.id);
    if (!secretValue(meta?.accessToken)) fail(503, 'Token de acesso Meta indisponível.');
    const accessToken = meta.accessToken;
    let liveVersion = input.version;
    const fresh = () => {
      this.authority(actor, reauthorize, identity);
      context = this.sendContext(actor, tenantId, conversationId, { ...input, version: liveVersion }, revision);
      if (context.channel.id !== origin.channelId || context.channel.kind !== origin.kind || context.config.resourceId !== origin.resourceId
        || context.config.apiVersion !== origin.apiVersion || context.conversation.remoteSocialId !== origin.recipientId
        || !sameSecret(this.secretData(storage, origin.channelId).meta?.accessToken, accessToken)) fail(409, 'O destino ou a autorização Meta mudou.');
      if (ids.length && fingerprint(messengerUploadDescriptor(this.media.record(ids[0], scope, { uploadOnly: true }).metadata).metadata) !== mediaHash) fail(409, 'O arquivo Messenger mudou. Selecione o arquivo novamente.');
    };
    fresh();
    const resolved = ids.length ? await this.media.resolve(ids, { ...scope, reauthorize: fresh }) : [];
    fresh();
    const upload = ids.length ? validateMessengerUpload(resolved[0]) : null;
    if (upload && fingerprint(upload.metadata) !== mediaHash) fail(409, 'O arquivo Messenger mudou.');
    const id = randomUUID(), date = new Date(this.time()).toISOString();
    this.store.mutate(actor, tenantId, 'Meta: resposta solicitada', tenant => {
      fresh();
      const current = this.store.getConversation(tenant, conversationId, input.version);
      current.messages.push({ id, kind: Object.keys(automated).length ? 'agent' : 'human', text: content, authorUserId: actor.userId || null, authorName: actor.name, ...automated,
        createdAt: date, delivery: 'pending', transport: context.channel.kind, ...(upload ? { attachments: [upload.metadata] } : {}) });
      current.version++; current.updatedAt = date;
    });
    liveVersion++;
    const controller = new AbortController(); this.pending.add(controller);
    let confirmed = false;
    try {
      const host = origin.kind === 'messenger' ? 'graph.facebook.com' : 'graph.instagram.com';
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(upload ? this.mediaTimeoutMs : this.timeoutMs)]);
      let message = { text: content };
      if (upload) {
        fresh();
        const form = new FormData();
        form.set('message', JSON.stringify({ attachment: { type: upload.type, payload: { is_reusable: true } } }));
        form.set('filedata', new Blob([resolved[0].bytes], { type: upload.metadata.mime }), upload.filename);
        const response = await this.fetch(`https://graph.facebook.com/${origin.apiVersion}/${origin.resourceId}/message_attachments`, {
          method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${accessToken}` }, body: form, signal });
        fresh();
        if (!response.ok) fail(response.status >= 400 && response.status < 500 ? 503 : 502, 'Meta recusou o upload privado.');
        const body = await this.responseJSON(response);
        fresh();
        if (!remoteId(body?.attachment_id)) fail(502, 'Meta não confirmou o identificador do upload privado.');
        message = { attachment: { type: upload.type, payload: { attachment_id: body.attachment_id } } };
      }
      fresh();
      if (signal.aborted) fail(502, 'Envio Meta interrompido sem confirmação.');
      const response = await this.fetch(`https://${host}/${origin.apiVersion}/${origin.resourceId}/messages`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: origin.recipientId }, message, ...(origin.kind === 'messenger' ? { messaging_type: 'RESPONSE' } : {}) }), signal });
      if (!response.ok) {
        const error = Object.assign(new Error('Meta recusou a resposta.'), { status: response.status >= 400 && response.status < 500 ? 503 : 502 });
        throw error;
      }
      const body = await this.responseJSON(response);
      if (!messageId(body?.message_id) || !remoteId(body?.recipient_id) || body.recipient_id !== origin.recipientId) fail(502, 'Meta não confirmou o destino e o identificador da resposta.');
      confirmed = true;
      this.store.mutate(this.actor(context.tenant.resellerId), tenantId, 'Meta: resposta aceita', tenant => {
        const current = this.store.getConversation(tenant, conversationId), item = current.messages.find(item => item.id === id);
        if (!item) fail(502, 'Resposta local indisponível após a confirmação Meta.');
        item.externalId = `${context.channel.kind}:${context.config.resourceId}:${body.recipient_id}:${body.message_id}`;
        item.providerMessageId = body.message_id; item.providerResourceId = context.config.resourceId; item.delivery = 'sent'; current.unread = 0;
      });
    } catch (error) {
      const definite = !confirmed && [400, 401, 403, 404, 409, 503].includes(error.status);
      try { this.store.mutate(this.actor(context.tenant.resellerId), tenantId, 'Meta: resposta sem confirmação local', tenant => {
        const item = this.store.getConversation(tenant, conversationId).messages.find(item => item.id === id);
        if (item) item.delivery = definite ? 'failed' : 'unconfirmed';
      }); } catch { /* Outbox retains uncertain transport result; never resend blindly. */ }
      fail(definite ? error.status : 502, definite ? 'Meta recusou o envio; confira o atendimento, as permissões e a configuração do canal.' : 'Envio Meta sem confirmação. Confira o destino antes de tentar novamente.');
    } finally { controller.abort(); this.pending.delete(controller); }
    try {
      this.authority(actor, reauthorize, identity);
      const current = this.store.getConversation(this.store.tenant(actor, tenantId), conversationId);
      sync(this.operations.canReply.bind(this.operations), actor, tenantId, current);
      return current;
    } catch {
      fail(502, 'Meta aceitou o envio; o acesso mudou antes da resposta local. Atualize a sessão e confira o atendimento.');
    }
  }

  async close() { this.closed = true; for (const controller of this.pending) controller.abort(); this.pending.clear(); }
}
