import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fail, text } from './store.js';
import { allowedFields } from './access.js';
import { clearConversationParticipants, noteStatus } from './operations.js';
import { resolveReply } from './replies.js';
import { attachmentIds, MAX_MEDIA_BYTES, outgoingText } from './media.js';
import { validateWebchatMedia } from './webchat-media.js';
import { syncIncomingConversationContact } from './contacts.js';
import { automatedSender, automatedAttribution, automatedFields } from './outbox.js';
import { discoverSiteIcon } from './site-icon.js';
import { normalizeWidgetConfiguration, publicWidgetConfiguration, visitorEmail, visitorLocale } from './webchat-config.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
const tokenHash = token => { if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(403, 'Sessão de webchat indisponível.'); return hash(token); };
const messageText = value => {
  const result = text(value, 4000);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result) || Buffer.byteLength(result) > 16_000) fail(400, 'Mensagem de webchat inválida.');
  return result;
};
const publicMessage = item => item.kind === 'customer' || ['human', 'agent'].includes(item.kind) && ['sent', 'delivered', 'read'].includes(item.delivery);
const verifiedIdentityFields = identity => ({ externalId: identity.externalId, ...(identity.v === 2 ? { v: 2, accountId: identity.accountId, userId: identity.subject } : {}) });
const sameVerifiedIdentity = (visitor, identity) => visitor?.verified === true && visitor.externalId === identity.externalId
  && (visitor.v ?? 1) === (identity.v ?? 1) && visitor.accountId === identity.accountId && (identity.v !== 2 || visitor.userId === identity.subject);
const safeAttachment = item => ({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size,
  status: item.status, preview: item.preview === true,
  ...(typeof item.reason === 'string' && ['unavailable', 'too_large', 'quota', 'busy'].includes(item.reason) ? { reason: item.reason } : {}) });
export function webchatOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'Informe uma origem válida para o webchat.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (typeof value !== 'string' || value.length > 240 || url.hostname.includes('*') || url.origin !== value || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) fail(400, 'Use uma origem HTTPS exata ou HTTP no computador local.');
  return url.origin;
}

/** Public visitors have their own narrow capability, never an operator session. */
export class WebchatGateway {
  constructor(store, { operations, onIncoming, media, identity, assistantState, now = Date.now, sessionTtlMs = 24 * 3600_000, siteIcon = discoverSiteIcon,
    challengeTtlMs = 120_000, maxPendingChallenges = 1000, maxActiveSessions = 5000 } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 24 * 3600_000
      || !Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 1000 || challengeTtlMs > 300_000
      || !Number.isSafeInteger(maxPendingChallenges) || maxPendingChallenges < 1 || maxPendingChallenges > 10_000
      || !Number.isSafeInteger(maxActiveSessions) || maxActiveSessions < 1 || maxActiveSessions > 10_000) fail(400, 'Limites de webchat inválidos.');
    this.store = store; this.operations = operations; this.onIncoming = onIncoming; this.media = media; this.now = now;
    this.identity = identity; this.assistantState = assistantState;
    this.siteIcon = siteIcon; this.siteIconPending = new Set();
    this.sessionTtlMs = sessionTtlMs; this.challengeTtlMs = challengeTtlMs;
    this.maxPendingChallenges = maxPendingChallenges; this.maxActiveSessions = maxActiveSessions;
    this.challenges = new Map(); this.rates = new Map(); this.mediaTasks = new Map(); this.closed = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS webchat_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      origin TEXT NOT NULL, channel_revision INTEGER NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
      visitor_name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS webchat_session_expiry ON webchat_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS webchat_inbound_receipts (
      session_id TEXT NOT NULL, client_message_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      message_id TEXT NOT NULL, conversation_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,client_message_id));
      CREATE TABLE IF NOT EXISTS webchat_visitor_profiles (
      session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), channel_id TEXT NOT NULL,
      email TEXT NOT NULL, locale TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS webchat_visitor_profiles_scope ON webchat_visitor_profiles(tenant_id,channel_id,session_id);`);
  }
  actor(resellerId) { return { role: 'reseller', resellerId, name: 'Gateway webchat' }; }
  capabilities(channel) {
    const media = Boolean(this.media) && channel?.webchat?.widget?.attachmentsEnabled !== false;
    return { identityHistorySupported: true, mediaSupported: media, mediaKinds: media ? ['image', 'audio', 'video', 'document'] : [],
      mediaMaxBytes: media ? MAX_MEDIA_BYTES : 0, captionMaxLength: media ? 1024 : 0, voiceSupported: media && channel?.webchat?.widget?.voiceEnabled !== false };
  }
  channel(actor, tenantId, channelId) {
    const tenant = this.store.tenant(actor, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    if (!channel || channel.kind !== 'webchat') fail(404, 'Canal de webchat indisponível nesta empresa.');
    return { tenant, channel };
  }
  configure(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['origins', 'enabled', 'version']); reauthorize();
    if (!this.operations?.admin) fail(503, 'Autorização do canal indisponível.');
    this.operations.admin(actor); this.store.admin(actor);
    const { channel } = this.channel(actor, tenantId, channelId), revision = channel.webchat?.version || 0;
    if (input.version !== undefined && input.version !== revision) fail(409, 'A configuração do webchat mudou.');
    const supplied = input.origins ?? channel.webchat?.origins ?? [];
    if (!Array.isArray(supplied) || supplied.length > 8 || (input.enabled !== false && !supplied.length)) fail(400, 'Informe entre uma e oito origens para o webchat.');
    const origins = [...new Set(supplied.map(webchatOrigin))], enabled = input.enabled ?? true;
    if (typeof enabled !== 'boolean') fail(400, 'Informe o estado do webchat.');
    reauthorize(); this.operations.admin(actor);
    this.store.mutate(actor, tenantId, 'Webchat: configuração atualizada', tenant => {
      const current = tenant.channels.find(item => item.id === channelId);
      if (!current || current.kind !== 'webchat' || (current.webchat?.version || 0) !== revision) fail(409, 'A configuração do webchat mudou.');
      current.transport = 'elozi-webchat'; current.state = enabled ? 'connected' : 'disconnected';
      current.label = enabled ? 'Webchat por origens autorizadas' : 'Webchat desativado';
      current.webchat = { ...current.webchat, version: revision + 1, enabled, origins };
    });
    return this.status(actor, tenantId, channelId);
  }
  widgetConfiguration(actor, tenantId, channelId, input, {reauthorize = () => {}} = {}) {
    reauthorize(); this.operations?.admin?.(actor); this.store.admin(actor);
    const {channel} = this.channel(actor, tenantId, channelId), version = channel.webchat?.widgetVersion || 0;
    if (input !== undefined) {
      allowedFields(input, ['version','widget']);
      if (input.version !== version) fail(409,'A aparência do webchat mudou.');
      const widget = normalizeWidgetConfiguration(input.widget);
      this.store.mutate(actor,tenantId,'Webchat: aparência e atendimento configurados',tenant => {
        reauthorize(); this.operations?.admin?.(actor); this.store.admin(actor);
        const current = tenant.channels.find(item => item.id === channelId);
        if (!current || current.kind !== 'webchat' || (current.webchat?.widgetVersion || 0) !== version) fail(409,'A aparência do webchat mudou.');
        current.webchat = {...current.webchat,widget,widgetVersion:version + 1};
      });
    }
    const current = this.channel(actor,tenantId,channelId).channel;
    return {version:current.webchat?.widgetVersion || 0, widget:current.webchat?.widget || {}};
  }
  identityContext({actor,tenantId,channelId,origin}) {
    if (actor) { this.operations?.admin?.(actor); this.store.admin(actor); return this.channel(actor,tenantId,channelId); }
    return this.#publicChannel(tenantId,channelId,origin);
  }
  /**
   * Logo of the site of the channel's first https origin (site-icon.js), kept in channel.siteIcon = { origin, src, checkedAt }
   * for the cards of Canais. Administrators only; a found logo is kept for 7 days and a miss is retried after 24 hours,
   * unless the origin changed. One discovery per channel at a time.
   */
  async refreshSiteIcon(actor, tenantId, channelId, { reauthorize = () => {} } = {}) {
    reauthorize();
    if (!this.operations?.admin) fail(503, 'Autorização do canal indisponível.');
    this.operations.admin(actor); this.store.admin(actor);
    const { channel } = this.channel(actor, tenantId, channelId);
    const origin = (channel.webchat?.origins || []).find(value => typeof value === 'string' && value.startsWith('https://')) || null, known = channel.siteIcon || null;
    if (!origin) return { siteIcon: null };
    const age = this.now() - Date.parse(known?.checkedAt || 0), fresh = known?.origin === origin && age >= 0 && age < (known.src ? 7 * 86400_000 : 86400_000);
    if (fresh || this.siteIconPending.has(channelId)) return { siteIcon: known };
    this.siteIconPending.add(channelId);
    try {
      let found = null; try { found = await this.siteIcon(origin); } catch { found = null; }
      const src = typeof found?.src === 'string' && /^data:image[/](png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(found.src) ? found.src : null;
      const siteIcon = { origin, src, checkedAt: new Date(this.now()).toISOString() };
      reauthorize(); this.operations.admin(actor);
      this.store.mutate(actor, tenantId, 'Webchat: ícone do site', tenant => {
        const current = tenant.channels.find(item => item.id === channelId);
        if (current?.kind === 'webchat') current.siteIcon = siteIcon;
      });
      return { siteIcon };
    } finally { this.siteIconPending.delete(channelId); }
  }
  status(actor, tenantId, channelId) {
    this.operations?.admin?.(actor); this.store.admin(actor);
    const { channel } = this.channel(actor, tenantId, channelId);
    return { state: channel.webchat?.enabled && !this.closed ? 'connected' : 'disconnected',
      version: channel.webchat?.version || 0, origins: [...(channel.webchat?.origins || [])], ...this.capabilities(channel) };
  }
  #publicChannel(tenantId, channelId, origin) {
    if (this.closed) fail(503, 'Webchat indisponível.');
    const row = this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId);
    if (!row) fail(404, 'Webchat indisponível.');
    const actor = this.actor(row.reseller_id), { tenant, channel } = this.channel(actor, tenantId, channelId);
    const exact = webchatOrigin(origin);
    if (channel.transport !== 'elozi-webchat' || !channel.webchat?.enabled || !Number.isSafeInteger(channel.webchat.version) || channel.webchat.version < 1
      || channel.state !== 'connected' || !Array.isArray(channel.webchat.origins)) fail(403, 'Webchat indisponível para esta origem.');
    // A live channel opened from a site outside its list: the code (and the CORS header the server adds for it) lets the
    // widget tell the site owner what to fix instead of a generic failure.
    if (!channel.webchat.origins.includes(exact)) throw Object.assign(new Error('Webchat indisponível para esta origem.'), { status: 403, code: 'webchat_origin_denied', origin: exact });
    return { actor, tenant, channel, origin: exact };
  }
  #limit(key, maximum) {
    const now = this.now();
    for (const [id, value] of this.rates) if (value.until <= now) this.rates.delete(id);
    const entry = this.rates.get(key) || { count: 0, until: now + 60_000 };
    if (entry.count >= maximum || (!this.rates.has(key) && this.rates.size >= 1000)) fail(429, 'Aguarde um minuto para continuar no webchat.');
    entry.count++; this.rates.set(key, entry);
  }
  publicAccess(tenantId, channelId, origin) {
    const { tenant, channel } = this.#publicChannel(tenantId, channelId, origin), brand = tenant.brand || {};
    return { allowed: true, name: typeof channel.name === 'string' ? channel.name.slice(0, 80) : 'Atendimento',
      brand: { name: (typeof brand.name === 'string' && brand.name.trim() ? brand.name : typeof tenant.name === 'string' ? tenant.name : '').slice(0, 80),
        accent: typeof brand.accent === 'string' && /^#[0-9a-f]{6}$/i.test(brand.accent) ? brand.accent : '#27644b' },
      ...(publicWidgetConfiguration(channel) ? {widget:publicWidgetConfiguration(channel)} : {}), ...this.capabilities(channel) };
  }
  challenge({ tenantId, channelId, origin }) {
    const context = this.#publicChannel(tenantId, channelId, origin), now = this.now();
    for (const [id, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(id);
    this.#limit(JSON.stringify([tenantId, channelId, context.origin]), 60);
    if (this.challenges.size >= this.maxPendingChallenges) fail(429, 'Há muitas aberturas de webchat pendentes.');
    const challenge = secret(), expiresAt = now + this.challengeTtlMs;
    this.challenges.set(hash(challenge), { tenantId, channelId, origin: context.origin, revision: context.channel.webchat.version, expiresAt });
    return { challenge, expiresAt: new Date(expiresAt).toISOString(), ...this.capabilities(context.channel) };
  }
  openSession(input) {
    return this.identity ? this.identity.transaction(() => this.#openSession(input)) : this.#openSession(input);
  }
  #openSession(input) {
    allowedFields(input,['tenantId','channelId','origin','challenge','name','email','locale','identityToken']);
    const {tenantId,channelId,origin,challenge,name='Visitante',email='',locale='pt-BR',identityToken} = input;
    const context = this.#publicChannel(tenantId, channelId, origin), now = this.now(), id = tokenHash(challenge);
    const pending = this.challenges.get(id);
    if (!pending || pending.expiresAt <= now || pending.tenantId !== tenantId || pending.channelId !== channelId || pending.origin !== context.origin || pending.revision !== context.channel.webchat.version) fail(403, 'A abertura do webchat expirou. Solicite uma nova.');
    this.challenges.delete(id);
    const claims = this.identity?.verifyAndConsume({tenantId,channelId,origin,identityToken});
    const visitorName = text(claims?.name ? claims.name.slice(0,80) : name, 80), returnEmail = claims?.email || visitorEmail(email);
    if (/[\x00-\x1f\x7f]/.test(visitorName)) fail(400, 'Nome de visitante inválido.');
    const active = this.store.db.prepare('SELECT count(*) AS count FROM webchat_sessions WHERE expires_at>?').get(now).count;
    const channelActive = this.store.db.prepare('SELECT count(*) AS count FROM webchat_sessions WHERE tenant_id=? AND channel_id=? AND channel_revision=? AND expires_at>?').get(tenantId, channelId, context.channel.webchat.version, now).count;
    if (active >= this.maxActiveSessions || channelActive >= 500) fail(429, 'Limite de sessões de webchat atingido.');
    const token = secret(), sessionId = randomUUID(), conversationId = randomUUID(), expiresAt = now + this.sessionTtlMs;
    const persist = () => {
      this.store.db.prepare('INSERT INTO webchat_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run(sessionId, hash(token), tenantId, channelId, context.origin, context.channel.webchat.version, conversationId, visitorName, now, expiresAt);
      this.store.db.prepare('INSERT INTO webchat_visitor_profiles VALUES (?,?,?,?,?,?)').run(sessionId,tenantId,channelId,returnEmail,visitorLocale(claims?.locale || locale),now);
      if (claims) this.identity.bindSession(sessionId,claims,{tenantId,channelId,origin});
    };
    // The verifier's SAVEPOINT prevents partially inserted sessions/bindings.
    if (this.identity) this.identity.transaction(persist); else persist();
    return { token, expiresAt: new Date(expiresAt).toISOString(), ...this.publicAccess(tenantId,channelId,origin), ...this.#visitorState({row:{id:sessionId,conversation_id:conversationId},...context,identity:claims}) };
  }
  #session(token, origin, { tenantId, channelId, allowExpiredIdentity = false } = {}) {
    const row = this.store.db.prepare('SELECT * FROM webchat_sessions WHERE token_hash=?').get(tokenHash(token));
    if (!row || row.expires_at <= this.now()) fail(403, 'Sessão de webchat indisponível.');
    if (tenantId !== undefined && tenantId !== row.tenant_id || channelId !== undefined && channelId !== row.channel_id) fail(403, 'Sessão de webchat indisponível para este canal.');
    const context = this.#publicChannel(row.tenant_id, row.channel_id, origin);
    if (context.origin !== row.origin || context.channel.webchat.version !== row.channel_revision) fail(403, 'Sessão de webchat indisponível.');
    const conversation = context.tenant.conversations.find(item => item.id === row.conversation_id);
    if (conversation && (conversation.channelId !== row.channel_id || conversation.remoteSessionId !== row.id)) fail(403, 'Sessão de webchat indisponível neste atendimento.');
    const identity = this.identity?.sessionIdentity(row.id,{tenantId:row.tenant_id,channelId:row.channel_id,origin:context.origin,allowExpired:allowExpiredIdentity});
    return { row, ...context, identity };
  }
  #visitorState({row,tenant,channel,identity}) {
    const profile = this.store.db.prepare('SELECT email,locale FROM webchat_visitor_profiles WHERE session_id=? AND tenant_id=? AND channel_id=?').get(row.id,tenant.id,channel.id);
    const conversation = tenant.conversations.find(item => item.id === row.conversation_id);
    const email = identity?.email || profile?.email || '';
    const assistant = conversation && this.assistantState?.(tenant.id,channel.id,row.conversation_id) || {state:'idle',typing:false};
    return {contact:{name:identity?.name || '',email,verified:Boolean(identity),...(identity ? {...verifiedIdentityFields(identity),ctx:identity.ctx || {}} : {})},
      assistant:{...assistant,requestEmail:assistant.state === 'handoff' && !email && !identity},
      ...(publicWidgetConfiguration(channel) ? {widget:publicWidgetConfiguration(channel)} : {}),
      conversationStatus:conversation?.status || 'waiting',...(conversation?.webchatFeedback ? {feedback:{rating:conversation.webchatFeedback.rating}} : {})};
  }
  updateContact(input) {
    allowedFields(input,['token','origin','tenantId','channelId','email']);
    const context = this.#session(input.token,input.origin,input);
    if (context.identity) fail(409,'O e-mail verificado vem do aplicativo de origem.');
    const email = visitorEmail(input.email);
    this.store.db.prepare('UPDATE webchat_visitor_profiles SET email=? WHERE session_id=? AND tenant_id=? AND channel_id=?').run(email,context.row.id,context.row.tenant_id,context.row.channel_id);
    this.store.mutate(context.actor,context.row.tenant_id,'Webchat: contato de retorno atualizado',tenant => {
      const conversation = tenant.conversations.find(item => item.id === context.row.conversation_id);
      if (conversation) { conversation.webchatVisitor = {...conversation.webchatVisitor,email}; syncIncomingConversationContact(tenant,conversation,tenant.channels.find(item => item.id === context.row.channel_id)); }
    });
    return this.#visitorState(this.#session(input.token,input.origin,input));
  }
  renewIdentity(input) {
    allowedFields(input,['token','origin','tenantId','channelId','identityToken']);
    return this.#visitorState(this.#renewIdentityContext(input));
  }
  #renewIdentityContext(input, context = this.#session(input.token,input.origin,{...input,allowExpiredIdentity:true})) {
    if (!context.identity || !this.identity) fail(403,'Esta sessão não tem uma identidade verificada.');
    this.identity.renewSession(context.row.id,{tenantId:context.row.tenant_id,channelId:context.row.channel_id,origin:context.origin,identityToken:input.identityToken});
    const renewed = this.#session(input.token,input.origin,input);
    const conversation = renewed.tenant.conversations.find(item=>item.id===context.row.conversation_id);
    const visitor = {name:renewed.identity.name,email:renewed.identity.email,locale:renewed.identity.locale,ctx:renewed.identity.ctx || {},verified:true,...verifiedIdentityFields(renewed.identity)};
    // The binding and replay guard still renew on every call. Only avoid rewriting
    // the whole tenant and its audit/bridge event when the visitor values match.
    if(conversation && !isDeepStrictEqual(conversation.webchatVisitor,visitor)) this.store.mutate(context.actor,context.row.tenant_id,'Webchat: identidade renovada',tenant=>{
      const current = tenant.conversations.find(item=>item.id===context.row.conversation_id);
      if(current) current.webchatVisitor=visitor;
    });
    return this.#session(input.token,input.origin,input);
  }
  verifiedConversationCurrent(tenantId,conversationId) {
    try {
      const row = this.store.db.prepare('SELECT * FROM webchat_sessions WHERE tenant_id=? AND conversation_id=?').get(tenantId,conversationId);
      if(!row || row.expires_at<=this.now())return false;
      const context = this.#publicChannel(tenantId,row.channel_id,row.origin);
      if(row.channel_revision!==context.channel.webchat.version)return false;
      const claims = this.identity?.sessionIdentity(row.id,{tenantId,channelId:row.channel_id,origin:row.origin});
      const conversation = context.tenant.conversations.find(item=>item.id===conversationId);
      return Boolean(claims && sameVerifiedIdentity(conversation?.webchatVisitor,claims)
        && conversation.webchatVisitor.email===claims.email && conversation.webchatVisitor.name===claims.name
        && isDeepStrictEqual(conversation.webchatVisitor.ctx || {},claims.ctx || {}));
    }catch{return false;}
  }
  logout(input) {
    allowedFields(input,['token','origin','tenantId','channelId']);
    const {row} = this.#session(input.token,input.origin,{...input,allowExpiredIdentity:true});
    this.identity?.revokeSession(row.id,{tenantId:row.tenant_id,channelId:row.channel_id,origin:row.origin});
    this.store.db.prepare('UPDATE webchat_sessions SET expires_at=? WHERE id=?').run(this.now(),row.id);
    return {loggedOut:true};
  }
  feedback(input) {
    allowedFields(input,['token','origin','tenantId','channelId','rating']);
    const {row,actor,channel} = this.#session(input.token,input.origin,input);
    if (channel.webchat?.widget?.feedbackEnabled !== true || !['useful','not_useful'].includes(input.rating)) fail(400,'Avaliação indisponível.');
    this.store.mutate(actor,row.tenant_id,'Webchat: avaliação recebida',tenant => {
      const conversation = this.store.getConversation(tenant,row.conversation_id);
      if (conversation.status !== 'closed') fail(409,'Avalie depois de encerrar o atendimento.');
      conversation.webchatFeedback = {rating:input.rating,createdAt:new Date(this.now()).toISOString()};
    });
    return {feedback:{rating:input.rating}};
  }
  async receive(input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['token', 'origin', 'clientMessageId', 'text', 'tenantId', 'channelId']);
    this.#session(input.token, input.origin, input);
    const content = messageText(input.text);
    return this.#receive(input, content, null, hash(content), reauthorize);
  }
  async receiveMedia(input, { reauthorize = () => {}, originalContentHash } = {}) {
    allowedFields(input, ['token', 'origin', 'clientMessageId', 'text', 'attachment', 'tenantId', 'channelId']);
    const {channel} = this.#session(input.token, input.origin, input); this.#fresh(reauthorize);
    if (!this.capabilities(channel).mediaSupported || input.attachment?.voice && !this.capabilities(channel).voiceSupported) fail(403,'Este canal não aceita anexos ou gravações.');
    if (!this.media) fail(503, 'Armazenamento de arquivos indisponível.');
    const validated = validateWebchatMedia({ clientMessageId: input.clientMessageId, text: input.text, attachment: input.attachment });
    const { bytes, kind, name, mime, voice } = validated.attachment;
    // The trusted HTTP adapter hashes the whole original frame (header + file)
    // before normalization. OGG bytes, names and sizes may change on a retry.
    if (originalContentHash !== undefined && (typeof originalContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(originalContentHash))) fail(500, 'Identidade interna do arquivo inválida.');
    const contentHash = hash(JSON.stringify(originalContentHash === undefined
      ? ['media', validated.text, kind, name, mime, voice, hash(bytes)] : ['media-original', originalContentHash]));
    try { return await this.#receive(input, validated.text, validated.attachment, contentHash, reauthorize); }
    finally { bytes.fill(0); }
  }
  #fresh(reauthorize) {
    if (typeof reauthorize !== 'function') fail(500, 'A autorização interna do webchat é inválida.');
    const result = reauthorize();
    if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail(500, 'A autorização interna do webchat precisa ser síncrona.'); }
    if (result === false) fail(403, 'O acesso ao webchat mudou.');
  }
  visitorAccess(input, { allowExpiredIdentity = false } = {}) {
    allowedFields(input, ['token', 'origin', 'tenantId', 'channelId']);
    const identity = { ...input }, { row } = this.#session(identity.token, identity.origin, {...identity,allowExpiredIdentity});
    return { tenantId: row.tenant_id, channelId: row.channel_id, conversationId: row.conversation_id,
      reauthorize: () => { this.#session(identity.token, identity.origin, identity); return true; } };
  }
  mediaAccess(input) {
    const context = this.visitorAccess(input);
    const {channel} = this.#session(input.token,input.origin,input);
    if (!this.media) fail(503,'Armazenamento de arquivos indisponível.');
    if (!this.capabilities(channel).mediaSupported) fail(403, 'Arquivos desativados neste canal.');
    return context;
  }
  async readMedia(input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['token', 'origin', 'tenantId', 'channelId', 'attachmentId']);
    const identity = { token: input.token, origin: input.origin, tenantId: input.tenantId, channelId: input.channelId };
    const context = this.mediaAccess(identity), id = input.attachmentId;
    let targetConversationId;
    const authorize = () => {
      this.#fresh(reauthorize);
      const { row, tenant, identity:verified, channel } = this.#session(identity.token, identity.origin, identity);
      if(!this.capabilities(channel).mediaSupported)fail(403,'Arquivos desativados neste canal.');
      const accessible=tenant.conversations.filter(item=>item.channelId===row.channel_id && (item.id===row.conversation_id && item.remoteSessionId===row.id || verified && sameVerifiedIdentity(item.webchatVisitor,verified)));
      const candidates=accessible.filter(conversation=>conversation.messages.some(item=>publicMessage(item)&&item.attachments?.some(attachment=>attachment.id===id)));
      if(candidates.length!==1 || targetConversationId && targetConversationId!==candidates[0].id)fail(404,'Arquivo indisponível neste chat.');
      targetConversationId=candidates[0].id;
      return true;
    };
    authorize();
    const result = await this.media.read(id, { ...context, conversationId:targetConversationId, reauthorize: authorize });
    try { authorize(); return { metadata: safeAttachment(result.metadata), bytes: result.bytes }; }
    catch (error) { result.bytes.fill(0); throw error; }
  }
  async #receive(input, content, attachment, contentHash, reauthorize = () => {}) {
    input = { ...input };
    const { row, actor, identity:verified } = this.#session(input.token, input.origin, input);
    this.#fresh(reauthorize);
    if (!opaque(input.clientMessageId)) fail(400, 'Identificador de mensagem do webchat inválido.');
    const replay = this.store.db.prepare('SELECT * FROM webchat_inbound_receipts WHERE session_id=? AND client_message_id=?').get(row.id, input.clientMessageId);
    if (replay) {
      if (replay.content_hash !== contentHash) fail(409, 'Identificador já usado por outra mensagem do webchat.');
      if (attachment) await this.mediaTasks.get(replay.message_id);
      this.#session(input.token, input.origin, input); this.#fresh(reauthorize);
      return { messageId: replay.message_id, conversationVersion: replay.conversation_version, replayed: true };
    }
    if (this.store.db.prepare('SELECT count(*) AS count FROM webchat_inbound_receipts WHERE session_id=? AND created_at>?').get(row.id, this.now() - 60_000).count >= 20) fail(429, 'Aguarde um minuto antes de enviar mais mensagens.');
    const receipt = this.store.mutate(actor, row.tenant_id, 'Webchat: mensagem recebida', tenant => {
      this.#session(input.token, input.origin, input); this.#fresh(reauthorize);
      const identity = tenant.conversations.find(item => item.id === row.conversation_id);
      if (identity && (identity.channelId !== row.channel_id || identity.remoteSessionId !== row.id)) fail(409, 'A origem deste atendimento de webchat mudou.');
      let conversation = tenant.conversations.find(item => item.id === row.conversation_id && item.channelId === row.channel_id && item.remoteSessionId === row.id);
      const newConversation = !conversation, date = new Date(this.now()).toISOString();
      if (!conversation) {
        const department = (tenant.departments || []).find(item => item.active !== false && item.id === tenant.defaultDepartmentId);
        conversation = { id: row.conversation_id, channelId: row.channel_id, remoteSessionId: row.id, contact: row.visitor_name,
          initials: row.visitor_name.slice(0, 2).toUpperCase(), conversationKind: 'direct', department: department?.name || 'Suporte', departmentId: department?.id || null,
          owner: 'queue', assignedUserId: null, status: 'open', version: 1, unread: 0, agentId: null, tags: ['Webchat'], messages: [] };
        tenant.conversations.unshift(conversation);
      }
      const profile = this.store.db.prepare('SELECT email,locale FROM webchat_visitor_profiles WHERE session_id=? AND tenant_id=? AND channel_id=?').get(row.id,row.tenant_id,row.channel_id);
      conversation.webchatVisitor = {name:verified?.name || row.visitor_name,email:verified?.email || profile?.email || '',locale:verified?.locale || profile?.locale || 'pt-BR',verified:Boolean(verified),...(verified ? {...verifiedIdentityFields(verified),ctx:verified.ctx || {}} : {})};
      const reopened = conversation.status === 'closed';
      if (reopened) {
        conversation.status = 'open'; clearConversationParticipants(conversation, actor, { origin: 'webchat', reason: 'Nova mensagem após encerramento.' });
        conversation.owner = 'queue'; conversation.assignedUserId = null; conversation.assignedUserName = null; conversation.agentId = null;
        delete conversation.assignedSupportGrantId; noteStatus(conversation, actor, 'closed', { origin: 'webchat' });
      }
      const contact = syncIncomingConversationContact(tenant, conversation, tenant.channels.find(item => item.id === row.channel_id));
      const messageId = randomUUID();
      const metadata = attachment ? this.media.placeholder({ tenantId: row.tenant_id, channelId: row.channel_id, conversationId: conversation.id }, attachment) : null;
      conversation.messages.push({ id: messageId, externalId: input.clientMessageId, kind: 'customer', text: content,
        ...(metadata ? { attachments: [safeAttachment(metadata)] } : {}), createdAt: date, delivery: 'received', transport: 'webchat' });
      conversation.version++; conversation.updatedAt = date; conversation.unread++;
      this.store.db.prepare('INSERT INTO webchat_inbound_receipts VALUES (?,?,?,?,?,?)').run(row.id, input.clientMessageId, contentHash, messageId, conversation.version, this.now());
      return { conversationId: conversation.id, messageId, conversationVersion: conversation.version, newConversation, reopened,
        ...(contact?.code === 'CONTACT_CAPACITY' ? { contactSync: { code: contact.code, limit: contact.limit } } : {}), ...(metadata ? { attachmentId: metadata.id } : {}) };
    });
    if (attachment) {
      const context = { tenantId: row.tenant_id, channelId: row.channel_id, conversationId: row.conversation_id,
        reauthorize: () => { this.#session(input.token, input.origin, input); this.#fresh(reauthorize); return true; } };
      const task = this.media.capture(receipt.attachmentId, context, async () => attachment.bytes).catch(() =>
        this.media.captureUnavailable(this.media.record(receipt.attachmentId, context), 'unavailable')).then(metadata => {
        this.store.mutate(actor, row.tenant_id, 'Webchat: arquivo recebido processado', tenant => {
          const conversation = this.store.getConversation(tenant, row.conversation_id), message = conversation.messages.find(item => item.id === receipt.messageId);
          if (conversation.channelId !== row.channel_id || conversation.remoteSessionId !== row.id || !message?.attachments?.some(item => item.id === metadata.id)) fail(409, 'A origem do arquivo mudou.');
          message.attachments = [safeAttachment(metadata)]; conversation.version++;
        });
      }).finally(() => this.mediaTasks.delete(receipt.messageId));
      this.mediaTasks.set(receipt.messageId, task); await task;
    }
    const entry = { actor, tenantId: row.tenant_id, channelId: row.channel_id };
    try { await this.onIncoming?.(entry, receipt.conversationId, receipt.messageId, receipt); } catch { /* The received message stays committed. */ }
    try { this.operations?.routeIncoming?.(row.tenant_id, receipt.conversationId); } catch { /* Routing can be retried by the operator. */ }
    this.#session(input.token, input.origin, input); this.#fresh(reauthorize);
    return { messageId: receipt.messageId, conversationVersion: receipt.conversationVersion, replayed: false };
  }
  history(input) {
    allowedFields(input, ['token', 'origin', 'after', 'limit', 'tenantId', 'channelId', 'identityToken']);
    const limit = input.limit ?? 50, renew = Object.hasOwn(input,'identityToken');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.after !== undefined && !opaque(input.after))) fail(400, 'Página de webchat inválida.');
    let context = this.#session(input.token, input.origin, {...input,allowExpiredIdentity:renew});
    const {row,tenant,identity} = context;
    const conversation = tenant.conversations.find(item => item.id === row.conversation_id && item.channelId === row.channel_id && item.remoteSessionId === row.id);
    const histories = identity ? tenant.conversations.filter(item => item.channelId === row.channel_id && sameVerifiedIdentity(item.webchatVisitor, identity)) : conversation ? [conversation] : [];
    const messages = histories.flatMap(item => item.messages || []).filter(publicMessage);
    if(identity) messages.sort((a,b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const index = input.after ? messages.findIndex(item => item.id === input.after) : -1;
    if (input.after && index < 0) fail(400, 'Página de webchat indisponível.');
    const selected = messages.slice(index + 1, index + 1 + limit);
    // Validate the cursor in this identity's history before consuming a JWT.
    // Renewal and selection are synchronous; no history or identity is cached.
    if(renew) context=this.#renewIdentityContext({token:input.token,origin:input.origin,tenantId:input.tenantId,channelId:input.channelId,identityToken:input.identityToken},context);
    const {channel} = context;
    return { messages: selected.map(item => ({ id: item.id, kind: item.kind, text: typeof item.text === 'string' ? item.text.slice(0, 4000) : '', createdAt: item.createdAt, delivery: item.delivery,
      ...(this.capabilities(channel).mediaSupported && item.attachments?.length ? { attachments: item.attachments.map(safeAttachment) } : {}) })),
      hasMore: messages.length > index + 1 + limit, nextCursor: selected.at(-1)?.id || null,
      status: conversation?.status || 'waiting', ...this.capabilities(channel), ...this.#visitorState(context) };
  }
  #replyContext(actor, tenantId, conversationId, input) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a versão atual do atendimento.');
    if (!this.operations?.canReply) fail(503, 'Autorização do atendimento indisponível.');
    const { tenant, channel } = this.channel(actor, tenantId, input.channelId), conversation = this.store.getConversation(tenant, conversationId, input.version);
    this.operations.canReply(actor, tenantId, conversation);
    // Automated senders (a service principal or the autopilot) answer only conversations owned by their agent; canReply decides.
    const { service, autopilot } = automatedSender(actor);
    if (conversation.owner !== (service || autopilot ? 'agent' : 'human') || conversation.channelId !== channel.id || channel.transport !== 'elozi-webchat' || !channel.webchat?.enabled || channel.state !== 'connected' || this.closed) fail(409, 'Use o canal de origem ativo e assuma o atendimento.');
    const session = this.store.db.prepare('SELECT * FROM webchat_sessions WHERE id=? AND tenant_id=? AND channel_id=? AND conversation_id=?').get(conversation.remoteSessionId, tenantId, channel.id, conversationId);
    if (!session || session.expires_at <= this.now() || session.channel_revision !== channel.webchat.version || !channel.webchat.origins.includes(session.origin)) fail(409, 'A sessão deste visitante expirou.');
    return { conversation, channel, session };
  }
  assertReplySession(actor, tenantId, conversationId, input) {
    allowedFields(input, ['channelId', 'version']);
    const identity = { ...input }, { session, channel } = this.#replyContext(actor, tenantId, conversationId, identity);
    return { tenantId, conversationId, channelId: channel.id, expiresAt: new Date(session.expires_at).toISOString(),
      reauthorize: () => { this.#replyContext(actor, tenantId, conversationId, identity); return true; } };
  }
  validateOutgoing(actor, tenantId, conversationId, input) {
    allowedFields(input, ['channelId', 'version', 'text', 'idempotencyKey', 'replyToMessageId', 'attachmentIds']);
    const { conversation, channel } = this.#replyContext(actor, tenantId, conversationId, input);
    const ids = attachmentIds(input), content = ids.length ? outgoingText(input, true) : messageText(input.text);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail(400, 'Mensagem de webchat inválida.');
    resolveReply(conversation, input);
    if (ids.length) {
      if (!this.media) fail(503, 'Armazenamento de arquivos indisponível.');
      const record = this.media.record(ids[0], { tenantId, conversationId, channelId: channel.id }, { uploadOnly: true });
      if (record.metadata.status !== 'ready') fail(409, 'O arquivo ainda não está pronto para enviar.');
    }
    return { content, attachmentIds: ids };
  }
  validateSchedule(actor, tenantId, conversationId, { text, dueAt }) {
    const tenant = this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId);
    const input = { text, channelId: conversation.channelId, version: conversation.version };
    const { session } = this.#replyContext(actor, tenantId, conversationId, input);
    messageText(text);
    const due = typeof dueAt === 'string' ? Date.parse(dueAt) : NaN;
    if (!Number.isFinite(due) || due >= session.expires_at) fail(409, 'O agendamento precisa ocorrer antes de a sessão do visitante expirar.');
    return true;
  }
  async send(actor, tenantId, conversationId, input, { reauthorize = () => {}, attribution = null } = {}) {
    input = { ...input, ...(Array.isArray(input.attachmentIds) ? { attachmentIds: [...input.attachmentIds] } : {}) };
    const { autopilot } = automatedSender(actor), automated = automatedFields(actor, input, attribution);
    if (autopilot && !automatedAttribution(attribution)) fail(403, 'O envio automático precisa da tarefa e do agente que o autorizaram.');
    this.#fresh(reauthorize);
    const { content, attachmentIds: ids } = this.validateOutgoing(actor, tenantId, conversationId, input);
    const context = this.assertReplySession(actor, tenantId, conversationId, { channelId: input.channelId, version: input.version });
    const fresh = () => { this.#fresh(reauthorize); context.reauthorize(); return true; };
    // resolve verifies purpose=upload and decrypts only after synchronous scope checks.
    const files = ids.length ? await this.media.resolve(ids, { ...context, reauthorize: fresh }) : [];
    fresh(); this.validateOutgoing(actor, tenantId, conversationId, input);
    this.store.mutate(actor, tenantId, 'Webchat: resposta disponibilizada', state => {
      fresh();
      const current = this.store.getConversation(state, conversationId, input.version); this.operations.canReply(actor, tenantId, current);
      const reply = resolveReply(current, input), date = new Date(this.now()).toISOString();
      current.messages.push({ id: randomUUID(), kind: Object.keys(automated).length ? 'agent' : 'human', text: content, authorUserId: actor.userId || null, authorName: actor.name, ...automated,
        ...(files.length ? { attachments: [safeAttachment(files[0].metadata)] } : {}),
        ...(reply ? { replyToMessageId: reply.messageId } : {}), createdAt: date, delivery: 'sent', transport: 'webchat' });
      current.version++; current.updatedAt = date; current.unread = 0;
    });
    return this.store.getConversation(this.store.tenant(actor, tenantId), conversationId);
  }
  sendAssistant(input) {
    if (typeof this.authorizeAssistant !== 'function' || input?.actor?.kind !== 'service' || input.actor.userId || input.actor.serviceId || !input.actor.supportAssistantId || input.actor.supportAssistantId !== input.jobId) fail(403, 'Envio interno de suporte indisponível.');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || Buffer.byteLength(input.text) > 16000 || !Number.isSafeInteger(input.version) || typeof input.reauthorize !== 'function' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.jobId || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(input.agentId || '') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) fail(400, 'Resposta de suporte inválida.');
    const fresh = () => {
      if (this.closed || input.signal?.aborted) fail(409, 'A resposta do suporte foi interrompida.');
      const allowed = this.authorizeAssistant(input), current = input.reauthorize();
      if (allowed !== true || current !== true || allowed?.then || current?.then) fail(403, 'A autorização da resposta mudou.');
      return true;
    };
    fresh();
    const messageId = 'assistant_' + createHash('sha256').update(input.jobId).digest('hex').slice(0, 32);
    this.store.mutate(input.actor, input.tenantId, 'Webchat: resposta do assistente de suporte disponibilizada', tenant => {
      fresh();
      const conversation = this.store.getConversation(tenant, input.conversationId, input.version), channel = tenant.channels.find(item => item.id === input.channelId);
      if (conversation.channelId !== input.channelId || conversation.status === 'closed' || conversation.owner === 'human' || conversation.assignedUserId || conversation.participants?.length || conversation.supportAssistantHandoff?.active && conversation.supportAssistantHandoff.pauseAutomation !== false || channel?.transport !== 'elozi-webchat' || channel.state !== 'connected' || !channel.webchat?.enabled) fail(409, 'Este atendimento está sob controle da equipe ou mudou.');
      const session = this.store.db.prepare('SELECT * FROM webchat_sessions WHERE id=? AND tenant_id=? AND channel_id=? AND conversation_id=?').get(conversation.remoteSessionId, input.tenantId, input.channelId, input.conversationId);
      if (!session || session.expires_at <= this.now() || session.channel_revision !== channel.webchat.version || !channel.webchat.origins.includes(session.origin)) fail(409, 'A sessão do visitante expirou.');
      if (conversation.messages.some(message => message.id === messageId)) fail(409, 'Esta resposta já foi disponibilizada.');
      const reply = conversation.messages.find(message => message.id === input.replyToMessageId && message.kind === 'customer' && message.transport === 'webchat');
      if (!reply || conversation.messages.filter(message => message.kind === 'customer').at(-1)?.id !== reply.id) fail(409, 'Uma nova mensagem substituiu esta preparação.');
      const date = new Date(this.now()).toISOString();
      conversation.messages.push({ id: messageId, kind: 'agent', text: input.text.trim(), agentId: input.agentId, authorName: channel.webchat?.widget?.displayName || 'Assistente virtual Elozi',
        replyToMessageId: reply.id, createdAt: date, delivery: 'sent', transport: 'webchat', supportAssistantJobId: input.jobId });
      conversation.version++; conversation.updatedAt = date;
    });
    return { confirmed: true, messageId };
  }
  publishHandoff(input) {
    if (typeof this.authorizeHandoff !== 'function' || typeof input.reauthorize !== 'function') fail(403,'Transferência interna indisponível.');
    const fresh = () => {
      if (this.closed || input.signal?.aborted || this.authorizeHandoff(input) !== true || input.reauthorize() !== true) fail(403,'A autorização da transferência mudou.');
    };
    fresh(); const messageId = 'handoff_' + hash(input.idempotencyKey || input.jobId).slice(0,32); let skipped = false;
    this.store.mutate(input.actor,input.tenantId,'Webchat: visitante avisado da transferência',tenant => {
      fresh();
      const conversation = this.store.getConversation(tenant,input.conversationId), channel = tenant.channels.find(item => item.id === input.channelId);
      if (conversation.channelId !== channel?.id || !conversation.supportAssistantHandoff?.active || conversation.status === 'closed') fail(409,'Esta transferência mudou.');
      const session = this.store.db.prepare('SELECT * FROM webchat_sessions WHERE id=? AND tenant_id=? AND channel_id=? AND conversation_id=?').get(conversation.remoteSessionId,input.tenantId,input.channelId,input.conversationId);
      if (!session || session.expires_at <= this.now() || session.channel_revision !== channel.webchat?.version || !channel.webchat.origins.includes(session.origin)) fail(409,'A sessão do visitante expirou.');
      const locale = visitorLocale(conversation.webchatVisitor?.locale), continuing = conversation.supportAssistantHandoff.pauseAutomation === false;
      const reference = conversation.id.slice(0, 8);
      // The system, not model prose, confirms a persisted support request. Queueing email is not delivery.
      const copy = continuing ? (locale === 'en'
        ? `Your request #${reference} is recorded for the support team. I can continue helping here while that point is reviewed.`
        : `Sua solicitação #${reference} ficou registrada para a equipe de suporte. Posso continuar ajudando por aqui enquanto esse ponto é revisado.`)
        : channel.webchat?.widget?.handoffMessage?.[locale] || channel.webchat?.widget?.handoffMessage?.['pt-BR'];
      if (!copy) { skipped = true; return; }
      if (!conversation.messages.some(item => item.id === messageId)) {
        const createdAt = new Date(this.now()).toISOString();
        conversation.messages.push({id:messageId,kind:'agent',text:copy,authorName:channel.webchat.widget.displayName || 'Atendimento',createdAt,delivery:'sent',transport:'webchat',supportAssistantJobId:input.jobId});
        conversation.version++; conversation.updatedAt = createdAt;
      }
    });
    return skipped ? {skipped:true} : {confirmed:true,messageId};
  }
  close() { this.closed = true; this.challenges.clear(); this.rates.clear(); return Promise.allSettled(this.mediaTasks.values()); }
}
