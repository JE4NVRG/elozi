import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { encryptedChannelSecrets } from './channel-secrets.js';
import { loadLocalKey } from './wa-auth.js';
import { fail } from './store.js';
import { allowedFields } from './access.js';
import { attachmentIds, outgoingText, MAX_MEDIA_BYTES, readLimitedMedia } from './media.js';
import { avatarImage } from './avatars.js';
import { syncIncomingConversationContact } from './contacts.js';
import { clearConversationParticipants, noteStatus } from './operations.js';
import { resolveReply } from './replies.js';
import { automatedSender, automatedAttribution, automatedFields } from './outbox.js';

const peerId = value => typeof value === 'string' && /^-?[1-9]\d{0,18}$/.test(value);
const clean = (value, limit = 120) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').slice(0, limit) : '';
const privateKey = (tenantId, channelId) => `telegram-user:${tenantId}:${channelId}`;
const config = channel => channel.telegramUser || { version: 0, selectedPeerIds: [], dialogs: [] };
const ownerKey = actor => JSON.stringify([actor?.userId, actor?.resellerId, actor?.role, actor?.supportGrantId, actor?.kind, actor?.serviceId]);
const authErrorCode = error => {
  const code = error?.errorMessage || error?.code;
  if (['PHONE_CODE_INVALID', 'PHONE_CODE_EXPIRED', 'PASSWORD_HASH_INVALID'].includes(code)) return code;
  if (code === 'LOGIN_EMAIL_REQUIRED') return 'EMAIL_AUTH_UNSUPPORTED';
  if (typeof code === 'string' && code.startsWith('FLOOD_WAIT')) return 'AUTH_RATE_LIMITED';
  return 'AUTH_FAILED';
};
const authError = error => {
  const code = error?.errorMessage || error?.code;
  if (code === 'PHONE_CODE_INVALID') return 'Código inválido. Confira o código recebido no Telegram.';
  if (code === 'PHONE_CODE_EXPIRED') return 'O código expirou. Cancele e inicie uma nova conexão.';
  if (code === 'PASSWORD_HASH_INVALID') return 'Senha de verificação em duas etapas inválida.';
  if (code === 'LOGIN_EMAIL_REQUIRED') return 'O Telegram exige verificação por e-mail. Use o login por QR nesta versão.';
  if (typeof code === 'string' && code.startsWith('FLOOD_WAIT')) return 'O Telegram limitou as tentativas. Aguarde antes de tentar novamente.';
  return 'Não foi possível concluir a conexão. Confira a conta e tente novamente.';
};

/** Native MTProto transport. No stdout logging, disk sessions or automatic signup. */
export async function createTelegramUserClient({ apiId, apiHash, session = '', onUpdate, signal, nativeClient }) {
  const [{ TelegramClient, Api, utils }, { StringSession }, { NewMessage }, { Raw }, { Logger }, { default: bigInt }] = await Promise.all([
    import('teleproto'), import('teleproto/sessions'), import('teleproto/events'), import('teleproto/events/Raw'), import('teleproto/extensions/Logger'), import('big-integer')
  ]);
  const client = nativeClient || new TelegramClient(new StringSession(session), apiId, apiHash, {
    baseLogger: new Logger('none'), requestRetries: 1, connectionRetries: 2, floodSleepThreshold: 0, retryDelay: 1000, autoReconnect: true,
    deviceModel: 'Elozi', appVersion: '1.0', systemVersion: process.platform
  });
  client.setLogLevel('none');
  client.setParseMode(undefined);
  const credentials = { apiId, apiHash };
  const toPeer = peer => peer.type === 'private'
    ? new Api.InputPeerUser({ userId: bigInt(peer.rawId), accessHash: bigInt(peer.accessHash) })
    : peer.peerType === 'channel' ? new Api.InputPeerChannel({ channelId: bigInt(peer.rawId), accessHash: bigInt(peer.accessHash) })
      : new Api.InputPeerChat({ chatId: bigInt(peer.rawId) });
  const describe = message => {
    if (!(message instanceof Api.Message) || !message.peerId || !Number.isSafeInteger(message.id) || message.id <= 0 || message.ttlPeriod) return null;
    const id = String(utils.getPeerId(message.peerId));
    const file = message.file;
    let media = null;
    if (file) {
      const mime = clean(file.mimeType || 'application/octet-stream', 120), size = Number(file.size || 0);
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document';
      media = { kind, mime, size: Number.isSafeInteger(size) && size > 0 ? size : MAX_MEDIA_BYTES + 1, name: clean(file.name || 'Arquivo Telegram', 180), voice: Boolean(message.voice) };
    }
    const reply = message.replyTo;
    return { chatId: id, id: String(message.id), date: Number(message.date), text: clean(message.message || (message.media ? '[Conteúdo Telegram não suportado]' : ''), 4000), outgoing: message.out === true,
      senderId: message.senderId ? String(message.senderId) : null, senderName: clean(message.sender ? utils.getDisplayName(message.sender) : '', 80),
      ...(reply?.forumTopic && reply.replyToTopId ? { threadId: reply.replyToTopId } : {}),
      replyToId: reply?.replyToMsgId ? String(reply.replyToMsgId) : null, media, native: message };
  };
  const eventBuilder = new NewMessage({});
  const handler = event => { const normalized = describe(event.message); if (normalized) return onUpdate(normalized); };
  client.addEventHandler(handler, eventBuilder);
  const publicMe = user => ({ id: String(user.id), bot: user.bot === true, name: clean(utils.getDisplayName(user), 80), username: clean(user.username, 80) || null });
  return {
    connect: () => client.connect(), authorized: () => client.checkAuthorization(), getMe: async () => publicMe(await client.getMe()), exportSession: () => client.session.save(),
    async sendCode(phone) { const result = await client.sendCode(credentials, phone); if (result.emailRequired || result.emailCodeSent) { const error = new Error(); error.code = 'LOGIN_EMAIL_REQUIRED'; throw error; } return result; },
    async signInCode(phone, phoneCodeHash, code) { const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code })); if (!(result instanceof Api.auth.Authorization)) throw new Error('Unsupported signup'); return publicMe(result.user); },
    async signInPassword(password) { const user = await client.signInWithPassword(credentials, { password: async () => password, onError: error => { throw error; } }); return publicMe(user); },
    async loginQr({ qrCode, password, signal: authSignal }) {
      // Own refresh timer: cancellation removes the callback/timer immediately, without the library's sleeping refresh loop.
      return new Promise((resolve, reject) => {
        const raw = new Raw({}); let timer, busy = false, settled = false, rerun = false;
        const finish = (error, user) => { if (settled) return; settled = true; clearTimeout(timer); client.removeEventHandler(update, raw); authSignal.removeEventListener('abort', abort); error ? reject(error) : resolve(user); };
        const abort = () => finish(new Error('Login cancelled'));
        const refresh = async () => {
          if (busy || settled || authSignal.aborted) return; busy = true; clearTimeout(timer);
          try {
            let result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
            if (settled || authSignal.aborted) return;
            if (result instanceof Api.auth.LoginTokenMigrateTo) { await client._switchDC(result.dcId); result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token })); }
            if (settled || authSignal.aborted) return;
            if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) finish(null, publicMe(result.authorization.user));
            else if (result instanceof Api.auth.LoginToken) { await qrCode({ token: result.token, expires: result.expires }); if (!settled) timer = setTimeout(refresh, Math.max(1000, Math.min(25000, result.expires * 1000 - Date.now()))); }
            else finish(new Error('Unsupported login'));
          } catch (error) {
            if (error?.errorMessage === 'SESSION_PASSWORD_NEEDED' && !settled) {
              try { const secret = await password(); if (settled || authSignal.aborted) return; const user = await client.signInWithPassword(credentials, { password: async () => secret, onError: error => { throw error; } }); finish(null, publicMe(user)); } catch (failure) { finish(failure); }
            } else finish(error);
          } finally { busy = false; if (rerun && !settled) { rerun = false; void refresh(); } }
        };
        const update = item => { if (item instanceof Api.UpdateLoginToken) { if (busy) rerun = true; else return refresh(); } };
        client.addEventHandler(update, raw); authSignal.addEventListener('abort', abort, { once: true });
        if (authSignal.aborted) abort(); else void refresh();
      });
    },
    async dialogs(limit) {
      const dialogs = await client.getDialogs({ limit });
      return dialogs.flatMap(dialog => {
        const entity = dialog.entity, privateChat = entity instanceof Api.User;
        if (!privateChat && !(entity instanceof Api.Chat) && !(entity instanceof Api.Channel && entity.megagroup)) return [];
        if (entity.deleted || entity.left || entity.kicked || !entity.id) return [];
        const type = privateChat ? 'private' : 'group';
        const cannotSend = entity.bannedRights?.sendMessages === true || entity.defaultBannedRights?.sendMessages === true && !entity.creator && !entity.adminRights;
        return [{ id: String(utils.getPeerId(entity)), name: clean(dialog.title || utils.getDisplayName(entity), 80), type, canSend: cannotSend ? false : null,
          privatePeer: { type, peerType: entity instanceof Api.Channel ? 'channel' : privateChat ? 'user' : 'chat', rawId: String(entity.id), accessHash: String(entity.accessHash || '0') } }];
      });
    },
    async history(peer, limit) { return (await client.getMessages(toPeer(peer), { limit })).map(describe).filter(Boolean).reverse(); },
    async send(peer, { text, file, replyTo, threadId }) {
      const common = { parseMode: undefined, replyTo: replyTo ? Number(replyTo) : threadId || undefined, linkPreview: false };
      const result = file ? await client.sendFile(toPeer(peer), { ...common, file: Object.assign(Buffer.from(file.bytes), { name: file.metadata.name }), caption: text, forceDocument: file.metadata.kind === 'document', voiceNote: file.metadata.voice === true })
        : await client.sendMessage(toPeer(peer), { ...common, message: text });
      return { id: String(result.id) };
    },
    download: (message, downloadSignal) => client.downloadMedia(message.native, { signal: downloadSignal, requestTimeout: 15000 }),
    avatar: peer => client.downloadProfilePhoto(peer ? toPeer(peer) : 'me', { isBig: false }),
    async disconnect() { client.removeEventHandler(handler, eventBuilder); await client.disconnect(); }
  };
}

/** A personal account belongs to one channel. Selection is empty until the owner explicitly chooses chats. */
export class TelegramUserGateway {
  constructor(store, { authKey, clientFactory = createTelegramUserClient, now = Date.now, timeoutMs = 20000, loginTimeoutMs = 5 * 60000 } = {}) {
    this.store = store; this.authKey = authKey; this.clientFactory = clientFactory; this.now = now;
    this.timeoutMs = Math.max(50, Math.min(30000, timeoutMs)); this.loginTimeoutMs = Math.max(50, Math.min(5 * 60000, loginTimeoutMs));
    this.entries = new Map(); this.starting = new Set(); this.closing = false; this.mediaTasks = new Set();
    // TelegramGateway provisions these operational tables before this adapter. No schema mutation here.
    // 'user:' identities cannot collide with numeric Bot API IDs.
    if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_bindings','telegram_seen')").all().length !== 2) fail(503, 'O armazenamento Telegram existente precisa estar provisionado antes da conexão pessoal.');
  }
  actor(resellerId) { return { role: 'reseller', resellerId, name: 'Gateway Telegram pessoal' }; }
  async secrets() { this.authKey ||= await loadLocalKey(); return encryptedChannelSecrets(this.store.db, this.authKey); }
  channel(actor, tenantId, channelId) {
    const tenant = this.store.tenant(actor, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    if (channel.kind !== 'telegram_user' || channel.transport !== 'telegram-user') fail(400, 'Este canal não é uma conta pessoal Telegram.');
    return { tenant, channel };
  }
  admin(actor, tenantId, channelId) {
    if (actor?.kind === 'service' || actor?.supportGrantId) fail(403, 'Somente o administrador da empresa conecta esta conta.');
    this.store.admin(actor); const result = this.channel(actor, tenantId, channelId), entry = this.entries.get(channelId);
    if (entry && entry.tenantId !== tenantId) fail(409, 'Esta conexão não pertence à empresa selecionada.');
    return result;
  }
  authority(actor, reauthorize, identity) {
    const result = reauthorize();
    if (result?.then) { Promise.resolve(result).catch(() => {}); fail(400, 'A validação de sessão precisa ser síncrona.'); }
    if (result !== undefined && result !== true && (!result || typeof result !== 'object')) fail(403, 'O acesso perdeu a autorização.');
    const current = result && result !== true ? result : actor;
    if (identity !== ownerKey(actor) || identity !== ownerKey(current)) fail(403, 'O contexto de autorização mudou.');
    return current;
  }
  guard(actor, tenantId, channelId, reauthorize = () => {}) {
    const identity = ownerKey(actor);
    return () => this.admin(this.authority(actor, reauthorize, identity), tenantId, channelId);
  }
  active(entry) { return Boolean(entry?.abort && !this.closing && !entry.stopped && !entry.abort.signal.aborted && this.entries.get(entry.channelId) === entry); }
  live(entry) {
    if (!this.active(entry) || entry.state !== 'connected') fail(409, 'A conta Telegram não está conectada.');
    const result = this.channel(entry.actor, entry.tenantId, entry.channelId);
    if (result.channel.state !== 'connected' || config(result.channel).accountId !== entry.accountId) fail(409, 'A conexão Telegram mudou.');
    return result;
  }
  enqueue(entry, work) { const task = entry.queue.then(work); entry.queue = task.catch(() => {}); return task; }
  async bounded(entry, task, limit = this.timeoutMs) {
    let timer, abort;
    const stopped = new Promise((_, reject) => { abort = () => reject(new Error('Connection cancelled')); entry.abort.signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => { reject(new Error('Connection timeout')); entry.state = 'failed'; entry.authState = 'error'; entry.error = 'A conexão não respondeu no prazo. Reconecte pelo painel.'; entry.errorCode = 'AUTH_TIMEOUT'; void this.stop(entry); }, limit); });
    try { if (!this.active(entry)) fail(409, 'A conexão mudou.'); const result = await Promise.race([task, stopped]); if (!this.active(entry)) fail(409, 'A conexão mudou.'); return result; }
    finally { clearTimeout(timer); entry.abort.signal.removeEventListener('abort', abort); }
  }
  assertVersion(channel, version) { if (!Number.isSafeInteger(version) || version !== (config(channel).version || 0)) fail(409, 'A configuração mudou. Atualize antes de continuar.'); }
  status(actor, tenantId, channelId) {
    const { channel } = this.admin(actor, tenantId, channelId), cfg = config(channel), entry = this.entries.get(channelId);
    const owner = entry && entry.owner === ownerKey(actor), pending = owner && entry.authState !== 'authenticated';
    return { tenantId, channelId, version: cfg.version || 0, configured: cfg.configured === true,
      state: entry?.state || 'disconnected', authState: owner ? entry.authState : entry?.state === 'connected' ? 'authenticated' : 'idle',
      account: cfg.accountId ? { id: cfg.accountId, name: cfg.accountName || '', username: cfg.username || null } : null, selectedCount: (cfg.selectedPeerIds || []).length,
      ...(pending ? { attemptId: entry.attemptId, ...(entry.qrDataUrl && entry.qrExpiresAt > this.now() ? { qrDataUrl: entry.qrDataUrl, qrExpiresAt: new Date(entry.qrExpiresAt).toISOString() } : {}), error: entry.error || null, errorCode: entry.errorCode || null } : {}) };
  }
  async configure(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'apiId', 'apiHash']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    if (!Number.isSafeInteger(input.apiId) || input.apiId < 1 || input.apiId > 2147483647 || input.apiHash !== undefined && input.apiHash !== '' && !/^[a-fA-F0-9]{32}$/.test(input.apiHash)) fail(400, 'Informe API ID e API hash válidos do Telegram.');
    const entry = this.entries.get(channelId); if (entry && !entry.stopped) fail(409, 'Cancele a tentativa ou desconecte a conta antes de mudar as credenciais.');
    const storage = await this.secrets(); fresh(); this.assertVersion(this.channel(actor, tenantId, channelId).channel, input.version);
    const previous = storage.get(privateKey(tenantId, channelId)), apiHash = input.apiHash || previous?.apiHash;
    if (!apiHash || previous && previous.apiId !== input.apiId && !input.apiHash) fail(400, 'Informe o API hash correspondente ao API ID.');
    if (previous?.session && (previous.apiId !== input.apiId || apiHash !== previous.apiHash)) fail(409, 'Preserve as credenciais da conta já vinculada.');
    this.store.mutate(actor, tenantId, 'Telegram pessoal: API configurada', tenant => { fresh(); const current = tenant.channels.find(item => item.id === channelId); this.assertVersion(current, input.version); storage.set(privateKey(tenantId, channelId), { ...previous, apiId: input.apiId, apiHash }); current.telegramUser = { ...config(current), configured: true, version: input.version + 1 }; });
    return this.status(actor, tenantId, channelId);
  }
  async newEntry(actor, tenantId, channelId, fresh) {
    const storage = await this.secrets(); fresh(); const saved = storage.get(privateKey(tenantId, channelId));
    if (!saved?.apiId || !saved.apiHash) fail(409, 'Configure o API ID e API hash antes de conectar.');
    const entry = { tenantId, channelId, actor: this.actor(this.channel(actor, tenantId, channelId).tenant.resellerId), owner: ownerKey(actor), attemptId: randomUUID(), state: 'connecting', authState: 'connecting', stopped: false,
      abort: new AbortController(), queue: Promise.resolve(), dialogs: new Map(), peers: new Map(Object.entries(saved.peers || {})), storage, saved, fresh };
    this.entries.set(channelId, entry);
    try { entry.client = await this.bounded(entry, this.clientFactory({ apiId: saved.apiId, apiHash: saved.apiHash, session: saved.session || '', signal: entry.abort.signal, onUpdate: message => this.receive(entry, message).catch(() => {}) })); fresh();
      await this.bounded(entry, entry.client.connect()); fresh(); return entry; }
    catch (error) { await this.stop(entry); throw error; }
  }
  notify(entry) { const listeners = entry.listeners || []; entry.listeners = []; for (const resolve of listeners) resolve(); }
  async waitState(entry, actor) { if (entry.authState === 'connecting') await new Promise(resolve => { const timer = setTimeout(() => { entry.listeners = (entry.listeners || []).filter(item => item !== done); resolve(); }, Math.min(this.timeoutMs, 10000)); const done = () => { clearTimeout(timer); resolve(); }; (entry.listeners ||= []).push(done); }); return this.status(actor, entry.tenantId, entry.channelId); }
  async startLogin(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'method', 'phoneNumber']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    if (!['qr', 'phone'].includes(input.method) || input.method === 'phone' && !/^\+\d{7,15}$/.test(input.phoneNumber || '')) fail(400, 'Escolha QR ou informe o telefone com código do país.');
    if (this.starting.has(channelId) || this.entries.get(channelId) && !this.entries.get(channelId).stopped) fail(409, 'Esta conexão já tem uma tentativa ativa.');
    this.starting.add(channelId); let entry;
    try {
      entry = await this.newEntry(actor, tenantId, channelId, fresh); this.assertVersion(fresh().channel, input.version);
      entry.timer = setTimeout(() => { entry.state = 'failed'; entry.authState = 'expired'; entry.error = 'A tentativa expirou. Cancele e inicie novamente.'; entry.errorCode = 'AUTH_EXPIRED'; this.notify(entry); void this.stop(entry); }, this.loginTimeoutMs);
      const authorized = await this.bounded(entry, entry.client.authorized()); fresh();
      if (authorized) await this.authenticated(entry, await this.bounded(entry, entry.client.getMe()));
      else if (input.method === 'phone') { entry.phone = input.phoneNumber; const sent = await this.bounded(entry, entry.client.sendCode(entry.phone)); fresh(); entry.phoneCodeHash = sent.phoneCodeHash; entry.authState = 'code'; this.notify(entry); }
      else {
        entry.authTask = entry.client.loginQr({ signal: entry.abort.signal,
          qrCode: async ({ token, expires }) => { fresh(); if (!this.active(entry)) throw new Error('Cancelled'); const data = await QRCode.toDataURL(`tg://login?token=${Buffer.from(token).toString('base64url')}`, { width: 320, margin: 2 }); fresh(); if (!this.active(entry)) throw new Error('Cancelled'); entry.qrDataUrl = data; entry.qrExpiresAt = expires * 1000; entry.authState = 'qr'; this.notify(entry); },
          password: () => { fresh(); if (!this.active(entry)) throw new Error('Cancelled'); entry.authState = 'password'; entry.qrDataUrl = null; this.notify(entry); return new Promise((resolve, reject) => { entry.passwordChallenge = { resolve, reject }; }); }
        }).then(user => this.authenticated(entry, user)).catch(error => { if (this.active(entry)) { entry.error = authError(error); entry.errorCode = authErrorCode(error); entry.authState = 'error'; entry.state = 'failed'; entry.qrDataUrl = null; this.notify(entry); void this.stop(entry); } });
      }
      return await this.waitState(entry, actor);
    } catch (error) { if (entry && this.active(entry)) { entry.error = authError(error); entry.errorCode = authErrorCode(error); entry.authState = 'error'; entry.state = 'failed'; this.notify(entry); await this.stop(entry); if (error.status) throw error; return this.status(actor, tenantId, channelId); } if (error.status) throw error; fail(502, authError(error)); }
    finally { this.starting.delete(channelId); }
  }
  async authenticated(entry, user) {
    entry.fresh(); if (!this.active(entry)) fail(409, 'A tentativa foi cancelada.');
    if (!peerId(user?.id) || user.id.startsWith('-') || user.bot) fail(400, 'Conecte uma conta pessoal, não um bot.');
    const prior = this.store.db.prepare('SELECT * FROM telegram_bindings WHERE bot_id=?').get(`user:${user.id}`), channelBinding = this.store.db.prepare('SELECT * FROM telegram_bindings WHERE channel_id=?').get(entry.channelId);
    if (prior && (prior.channel_id !== entry.channelId || prior.tenant_id !== entry.tenantId) || channelBinding && channelBinding.bot_id !== `user:${user.id}`) fail(409, 'Esta conta já pertence a outra conexão, ou este canal pertence a outra conta.');
    const session = entry.client.exportSession(); if (typeof session !== 'string' || !session || session.length > 10000) fail(502, 'O Telegram não forneceu uma sessão válida.');
    this.store.mutate(entry.actor, entry.tenantId, 'Telegram pessoal: conta vinculada', tenant => {
      entry.fresh(); const current = tenant.channels.find(item => item.id === entry.channelId);
      const binding = this.store.db.prepare('SELECT * FROM telegram_bindings WHERE bot_id=? OR channel_id=?').all(`user:${user.id}`, entry.channelId);
      if (binding.some(item => item.bot_id !== `user:${user.id}` || item.channel_id !== entry.channelId || item.tenant_id !== entry.tenantId)) fail(409, 'A conta já pertence a outra conexão.');
      this.store.db.prepare('INSERT OR IGNORE INTO telegram_bindings VALUES (?,?,?)').run(`user:${user.id}`, entry.channelId, entry.tenantId);
      entry.storage.set(privateKey(entry.tenantId, entry.channelId), { ...entry.saved, session, peers: Object.fromEntries(entry.peers) });
      current.telegramUser = { ...config(current), configured: true, accountId: user.id, accountName: clean(user.name, 80), username: clean(user.username, 80) || null, selectedPeerIds: config(current).selectedPeerIds || [], dialogs: config(current).dialogs || [] };
      current.state = 'connected'; current.label = 'Conta pessoal Telegram conectada';
    });
    entry.accountId = user.id; entry.state = 'connected'; entry.authState = 'authenticated'; entry.qrDataUrl = null; entry.phone = null; entry.phoneCodeHash = null; entry.fresh = () => this.channel(entry.actor, entry.tenantId, entry.channelId);
    clearTimeout(entry.timer); this.notify(entry);
  }
  async submitLogin(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['attemptId', 'version', 'code', 'password']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    const entry = this.entries.get(channelId);
    if (!entry || !this.active(entry) || entry.owner !== ownerKey(actor) || entry.attemptId !== input.attemptId) fail(403, 'Esta tentativa não pertence ao seu acesso.');
    if (entry.authSubmitting) fail(409, 'A confirmação está em andamento.');
    const code = input.code, password = input.password;
    if (entry.authState === 'code' ? typeof code !== 'string' || !/^\d{3,12}$/.test(code) || password !== undefined : entry.authState === 'password' ? typeof password !== 'string' || !password || password.length > 256 || code !== undefined : true) fail(400, 'Informe somente a confirmação solicitada pela tentativa atual.');
    entry.authSubmitting = true;
    try {
      entry.error = null; entry.errorCode = null;
      if (entry.passwordChallenge) { const challenge = entry.passwordChallenge; entry.passwordChallenge = null; entry.authState = 'connecting'; challenge.resolve(password); await this.waitState(entry, actor); }
      else {
        try { const user = await this.bounded(entry, entry.authState === 'code' ? entry.client.signInCode(entry.phone, entry.phoneCodeHash, code) : entry.client.signInPassword(password)); fresh(); await this.authenticated(entry, user); }
        catch (error) { fresh(); if (error?.errorMessage === 'SESSION_PASSWORD_NEEDED' || error?.code === 'SESSION_PASSWORD_NEEDED') entry.authState = 'password'; else { entry.error = authError(error); entry.errorCode = authErrorCode(error); if (error.status) { entry.state = 'failed'; entry.authState = 'error'; await this.stop(entry); } } }
      }
      fresh(); return this.status(actor, tenantId, channelId);
    } finally { entry.authSubmitting = false; }
  }
  async cancelLogin(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['attemptId', 'version']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    const entry = this.entries.get(channelId); if (!entry || entry.owner !== ownerKey(actor) || input.attemptId && input.attemptId !== entry.attemptId) fail(403, 'Esta tentativa não pertence ao seu acesso.');
    if (entry.state === 'connected') fail(409, 'Use Desconectar para encerrar uma conta já conectada.');
    await this.stop(entry); fresh(); this.entries.delete(channelId); return this.status(actor, tenantId, channelId);
  }
  async disconnect(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    const entry = this.entries.get(channelId); if (entry) await this.stop(entry); fresh(); this.assertVersion(fresh().channel, input.version);
    this.store.mutate(actor, tenantId, 'Telegram pessoal: conexão local encerrada', tenant => { fresh(); const current = tenant.channels.find(item => item.id === channelId); this.assertVersion(current, input.version); current.state = 'disconnected'; current.telegramUser = { ...config(current), version: input.version + 1 }; current.label = 'Conta pessoal Telegram desconectada'; });
    this.entries.delete(channelId); return this.status(actor, tenantId, channelId);
  }
  async stop(entry) {
    entry.stopped = true; entry.abort.abort(); clearTimeout(entry.timer); entry.qrDataUrl = null; entry.phone = null; entry.phoneCodeHash = null;
    entry.passwordChallenge?.reject(new Error('Cancelled')); entry.passwordChallenge = null; this.notify(entry);
    await Promise.race([Promise.resolve(entry.client?.disconnect()).catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); })]);
  }
  selected(entry, id, sending = false) {
    const { channel } = this.live(entry), cfg = config(channel), known = (cfg.dialogs || []).find(item => item.id === id);
    if (!peerId(id) || !(cfg.selectedPeerIds || []).includes(id) || !known || !entry.peers.has(id)) fail(403, 'Esta conversa não foi selecionada para atendimento.');
    if (sending && (known.canSend === false || entry.dialogs.get(id)?.canSend === false)) fail(409, 'O Telegram não permite responder nesta conversa.');
    return known;
  }
  async dialogs(actor, tenantId, channelId, { reauthorize = () => {} } = {}) {
    const fresh = this.guard(actor, tenantId, channelId, reauthorize); fresh(); const entry = this.entries.get(channelId); this.live(entry || {});
    return this.enqueue(entry, async () => { const result = await this.bounded(entry, entry.client.dialogs(100)); fresh(); this.live(entry);
      entry.dialogs = new Map(result.filter(item => peerId(item.id) && ['private', 'group'].includes(item.type) && item.privatePeer).slice(0, 100).map(item => [item.id, item]));
      const cfg = config(fresh().channel);
      for (const saved of cfg.dialogs || []) if (!entry.dialogs.has(saved.id) && entry.peers.has(saved.id)) entry.dialogs.set(saved.id, { id: saved.id, name: saved.title, type: saved.type, canSend: saved.canSend, privatePeer: entry.peers.get(saved.id) });
      return { tenantId, channelId, version: cfg.version || 0, state: entry.state, selectedPeerIds: [...(cfg.selectedPeerIds || [])], dialogs: [...entry.dialogs.values()].map(item => ({ id: item.id, name: clean(item.name, 80), type: item.type, selected: (cfg.selectedPeerIds || []).includes(item.id), canSend: item.canSend !== false })) };
    });
  }
  async setDialogs(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'peerIds']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    if (!Array.isArray(input.peerIds) || input.peerIds.length > 100 || input.peerIds.some(id => !peerId(id))) fail(400, 'Escolha até 100 conversas conhecidas desta conta.');
    const entry = this.entries.get(channelId); this.live(entry || {}); const ids = [...new Set(input.peerIds)];
    return this.enqueue(entry, async () => { fresh(); this.live(entry); this.assertVersion(fresh().channel, input.version);
      if (ids.some(id => !entry.dialogs.has(id))) fail(400, 'Atualize a lista e escolha somente conversas conhecidas.');
      const known = ids.map(id => { const item = entry.dialogs.get(id); return { id, title: clean(item.name, 80), type: item.type, canSend: item.canSend ?? null }; });
      this.store.mutate(actor, tenantId, 'Telegram pessoal: conversas selecionadas', tenant => { fresh(); const current = tenant.channels.find(item => item.id === channelId); this.assertVersion(current, input.version); current.telegramUser = { ...config(current), version: input.version + 1, selectedPeerIds: ids, dialogs: known };
        const peers = new Map(ids.map(id => [id, entry.dialogs.get(id).privatePeer])); const saved = entry.storage.get(privateKey(tenantId, channelId)); entry.storage.set(privateKey(tenantId, channelId), { ...saved, peers: Object.fromEntries(peers) }); entry.peers = peers;
      });
      return { tenantId, channelId, version: input.version + 1, state: entry.state, selectedPeerIds: ids, dialogs: [...entry.dialogs.values()].map(item => ({ id: item.id, name: clean(item.name, 80), type: item.type, selected: ids.includes(item.id), canSend: item.canSend !== false })) };
    });
  }
  receive(entry, message, { imported = false } = {}) { return this.enqueue(entry, () => this.ingest(entry, message, { imported })); }
  async ingest(entry, message, { imported = false } = {}) {
    if (!this.active(entry) || entry.state !== 'connected' || !peerId(message?.chatId) || !/^[1-9]\d{0,11}$/.test(message?.id || '') || !Number.isSafeInteger(message.date) || message.date <= 0 || message.date * 1000 > this.now() + 300000) return { imported: 0, duplicates: 0 };
    let known; try { known = this.selected(entry, message.chatId); } catch { return { imported: 0, duplicates: 0 }; }
    if (this.store.db.prepare('SELECT 1 FROM telegram_seen WHERE channel_id=? AND chat_id=? AND message_id=?').get(entry.channelId, message.chatId, message.id)) return { imported: 0, duplicates: 1 };
    const content = clean(message.text, 4000); if (!content && !message.media) return { imported: 0, duplicates: 0 };
    const date = new Date(message.date * 1000).toISOString(), media = message.media, jobs = []; let receipt;
    this.store.mutate(entry.actor, entry.tenantId, imported ? 'Telegram pessoal: histórico selecionado importado' : 'Telegram pessoal: mensagem selecionada recebida', tenant => {
      this.selected(entry, message.chatId);
      const duplicate = this.store.db.prepare('INSERT OR IGNORE INTO telegram_seen VALUES (?,?,?)').run(entry.channelId, message.chatId, message.id); if (!duplicate.changes) return;
      const channel = tenant.channels.find(item => item.id === entry.channelId); let conversation = tenant.conversations.find(item => item.channelId === entry.channelId && item.remoteChatId === message.chatId && (item.threadId || null) === (message.threadId || null));
      if (!conversation) { const department = tenant.departments?.find(item => item.name === 'Suporte') || tenant.departments?.[0]; conversation = { id: randomUUID(), contact: known.title, initials: known.title.slice(0, 2).toUpperCase(), channelId: entry.channelId, remoteChatId: message.chatId, conversationKind: known.type === 'group' ? 'group' : 'direct', ...(message.threadId ? { threadId: message.threadId } : {}), department: department?.name || 'Suporte', departmentId: department?.id || null, owner: 'queue', assignedUserId: null, status: 'open', version: 1, unread: 0, agentId: null, tags: ['Telegram pessoal'], messages: [] }; tenant.conversations.unshift(conversation); }
      if (!imported && !message.outgoing && conversation.status === 'closed') { const previous = conversation.status; conversation.status = 'open'; clearConversationParticipants(conversation, entry.actor, { origin: 'telegram-user', reason: 'Novo atendimento recebido.' }); conversation.owner = 'queue'; conversation.assignedUserId = null; conversation.agentId = null; noteStatus(conversation, entry.actor, previous, { origin: 'telegram-user' }); }
      const id = randomUUID(), context = { tenantId: entry.tenantId, channelId: entry.channelId, conversationId: conversation.id };
      const downloadable = !imported && this.media && Number.isSafeInteger(media?.size) && media.size > 0 && media.size <= MAX_MEDIA_BYTES;
      const attachment = media ? downloadable ? this.media.placeholder(context, { kind: media.kind, mime: media.mime, name: clean(media.name, 180), size: media.size, voice: media.voice === true }) : { id: randomUUID(), kind: media.kind, mime: clean(media.mime, 120), name: clean(media.name, 180), size: Math.max(0, Math.min(MAX_MEDIA_BYTES, Number(media.size) || 0)), status: 'unavailable', preview: false, reason: imported ? 'historical' : 'unavailable' } : null;
      const reply = message.replyToId ? conversation.messages.find(item => item.externalId === `${message.chatId}:${message.replyToId}`)?.id : null;
      conversation.messages.push({ id, externalId: `${message.chatId}:${message.id}`, kind: message.outgoing ? 'human' : 'customer', text: content, createdAt: date, ...(known.type === 'group' ? { senderName: clean(message.senderName, 80) || 'Participante', senderId: clean(message.senderId, 24) } : {}), ...(reply ? { replyToMessageId: reply } : {}), ...(attachment ? { attachments: [attachment] } : {}), ...(imported ? { imported: true } : {}), ...(message.outgoing ? { delivery: 'sent', authorName: config(channel).accountName || 'Conta pessoal Telegram' } : {}) });
      conversation.messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); conversation.version++; if (!imported && !message.outgoing) conversation.unread++;
      conversation.updatedAt = [conversation.updatedAt || '', date].sort().at(-1); syncIncomingConversationContact(tenant, conversation, channel);
      receipt = { conversationId: conversation.id, messageId: id }; if (downloadable) jobs.push({ ...context, id: attachment.id });
    });
    for (const job of jobs) { const fresh = () => { this.selected(entry, message.chatId); }; const task = this.media.capture(job.id, { tenantId: job.tenantId, channelId: job.channelId, conversationId: job.conversationId, reauthorize: fresh }, async () => { fresh(); const bytes = await this.bounded(entry, entry.client.download(message, entry.abort.signal)); fresh(); return readLimitedMedia(bytes); }).then(metadata => {
      fresh(); this.store.mutate(entry.actor, entry.tenantId, 'Telegram pessoal: arquivo registrado', tenant => { fresh(); const conversation = this.store.getConversation(tenant, job.conversationId), item = conversation.messages.find(item => item.id === receipt.messageId); if (item) { item.attachments = [metadata]; conversation.version++; } });
    }).catch(() => {}); this.mediaTasks.add(task); task.finally(() => this.mediaTasks.delete(task)); }
    if (receipt && !imported && !message.outgoing) { try { await this.onIncoming?.(entry, receipt.conversationId, receipt.messageId, { personalTelegram: true, autoReplyEligible: false }); } catch { /* Received data stays committed. */ } try { this.operations?.routeIncoming?.(entry.tenantId, receipt.conversationId); } catch { /* Routing is available for the team. */ } }
    return { imported: receipt ? 1 : 0, duplicates: receipt ? 0 : 1, conversationId: receipt?.conversationId };
  }
  async importHistory(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'limitPerConversation']); const fresh = this.guard(actor, tenantId, channelId, reauthorize), { channel } = fresh(); this.assertVersion(channel, input.version);
    if (!Number.isSafeInteger(input.limitPerConversation) || input.limitPerConversation < 1 || input.limitPerConversation > 100) fail(400, 'Escolha de 1 a 100 mensagens por conversa.');
    const ids = [...(config(channel).selectedPeerIds || [])]; if (!ids.length || ids.length > 20) fail(400, 'Selecione de 1 a 20 conversas para esta importação limitada.');
    const entry = this.entries.get(channelId); this.live(entry || {});
    return this.enqueue(entry, async () => { let imported = 0, duplicates = 0; const conversations = new Set();
      for (const id of ids) { fresh(); this.assertVersion(fresh().channel, input.version); this.selected(entry, id); const rows = await this.bounded(entry, entry.client.history(entry.peers.get(id), input.limitPerConversation)); fresh(); this.assertVersion(fresh().channel, input.version); this.selected(entry, id);
        for (const message of rows.slice(0, input.limitPerConversation)) { if (message.chatId !== id) continue; const receipt = await this.ingest(entry, message, { imported: true }); imported += receipt.imported; duplicates += receipt.duplicates; if (receipt.conversationId) conversations.add(receipt.conversationId); }
      }
      return { tenantId, channelId, version: input.version, imported, duplicates, conversations: conversations.size, limitPerConversation: input.limitPerConversation, attachmentsAnalyzed: false };
    });
  }
  replyPolicy(actor, tenantId, conversationId) {
    const tenant = this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId), entry = this.entries.get(conversation.channelId);
    let allowed = false; try { this.channel(actor, tenantId, conversation.channelId); allowed = entry?.tenantId === tenantId && Boolean(this.selected(entry, conversation.remoteChatId, true)); } catch { /* Deny stale or deselected channels. */ }
    return { allowed, sendPermissions: Object.fromEntries(['text', 'photos', 'audios', 'documents', 'videos', 'videoNotes', 'voiceNotes'].map(key => [key, allowed])) };
  }
  validateOutgoing(actor, tenantId, conversationId, input) {
    allowedFields(input, ['channelId', 'version', 'text', 'attachmentIds', 'replyToMessageId', 'idempotencyKey']); const tenant = this.store.tenant(actor, tenantId), conversation = this.store.getConversation(tenant, conversationId, input.version);
    if (!this.operations?.canReply) fail(503, 'Autorização de resposta indisponível.'); this.operations.canReply(actor, tenantId, conversation);
    const { channel } = this.channel(actor, tenantId, conversation.channelId), entry = this.entries.get(channel.id);
    if (input.channelId !== channel.id || entry?.tenantId !== tenantId) fail(400, 'A resposta precisa usar o canal e a conversa de origem.'); this.selected(entry, conversation.remoteChatId, true);
    const ids = attachmentIds(input), content = outgoingText(input, ids.length > 0); const reply = resolveReply(conversation, input);
    if (reply && !new RegExp(`^${conversation.remoteChatId}:\\d+$`).test(reply.externalId || '')) fail(409, 'A mensagem citada não pertence a este chat Telegram.');
    if (ids.length) { if (!this.media) fail(503, 'Armazenamento de arquivos indisponível.'); if (this.media.record(ids[0], { tenantId, channelId: channel.id, conversationId }, { uploadOnly: true }).metadata.status !== 'ready') fail(409, 'O arquivo não está pronto para enviar.'); }
    return { content, attachmentIds: ids, replyTo: reply?.externalId?.split(':').at(-1) || null };
  }
  async send(actor, tenantId, conversationId, input, { reauthorize = () => {}, attribution = null } = {}) {
    const identity = ownerKey(actor), authorized = () => this.authority(actor, reauthorize, identity);
    const reviewed = { ...input, attachmentIds: input.attachmentIds ? [...input.attachmentIds] : undefined }; const current = this.store.getConversation(this.store.tenant(authorized(), tenantId), conversationId, input.version), entry = this.entries.get(current.channelId);
    this.validateOutgoing(authorized(), tenantId, conversationId, reviewed);
    return this.enqueue(entry, async () => {
      const fresh = () => this.validateOutgoing(authorized(), tenantId, conversationId, reviewed); let prepared = fresh();
      const files = prepared.attachmentIds.length ? await this.media.resolve(prepared.attachmentIds, { tenantId, channelId: entry.channelId, conversationId, reauthorize: fresh }) : []; prepared = fresh();
      const { service, autopilot } = automatedSender(actor); if (autopilot && !automatedAttribution(attribution)) fail(403, 'A tarefa automática não está autorizada.');
      const id = randomUUID(), origin = this.store.getConversation(this.store.tenant(actor, tenantId), conversationId, reviewed.version), targetId = origin.remoteChatId;
      this.store.mutate(actor, tenantId, 'Telegram pessoal: envio solicitado', tenant => { fresh(); const conversation = this.store.getConversation(tenant, conversationId, reviewed.version); conversation.messages.push({ id, kind: service || autopilot ? 'agent' : 'human', text: prepared.content, createdAt: new Date(this.now()).toISOString(), delivery: 'pending', authorUserId: actor.userId || null, authorName: actor.name, ...automatedFields(actor, reviewed, attribution), ...(files[0] ? { attachments: [files[0].metadata] } : {}), ...(reviewed.replyToMessageId ? { replyToMessageId: reviewed.replyToMessageId } : {}), transport: 'telegram-user' }); conversation.version++; });
      try {
        // Once requested, CAS moves to the pending message. Authority, scope and account are still checked immediately before transport.
        const latest = authorized(), sending = this.store.getConversation(this.store.tenant(latest, tenantId), conversationId); this.operations.canReply(latest, tenantId, sending); this.selected(entry, targetId, true);
        if (sending.remoteChatId !== targetId || sending.channelId !== entry.channelId) fail(409, 'O destino mudou.');
        const sent = await this.bounded(entry, entry.client.send(entry.peers.get(targetId), { text: prepared.content, file: files[0], replyTo: prepared.replyTo, threadId: origin.threadId }));
        if (!/^\d{1,12}$/.test(sent?.id || '')) throw new Error('Missing provider receipt');
        this.store.mutate(entry.actor, tenantId, 'Telegram pessoal: envio aceito', tenant => { const conversation = this.store.getConversation(tenant, conversationId), item = conversation.messages.find(item => item.id === id); if (!item) fail(409, 'O atendimento mudou.'); item.externalId = `${targetId}:${sent.id}`; item.delivery = 'sent'; conversation.unread = 0; this.store.db.prepare('INSERT OR IGNORE INTO telegram_seen VALUES (?,?,?)').run(entry.channelId, targetId, sent.id); });
      } catch {
        this.store.mutate(entry.actor, tenantId, 'Telegram pessoal: envio não confirmado', tenant => { const item = this.store.getConversation(tenant, conversationId).messages.find(item => item.id === id); if (item) item.delivery = 'unconfirmed'; });
        fail(502, 'Envio sem confirmação. Confira o Telegram antes de iniciar outra intenção.');
      }
      return this.store.getConversation(this.store.tenant(authorized(), tenantId), conversationId);
    });
  }
  async avatar(actor, tenantId, channelId, { peer, signal } = {}) {
    try { this.channel(actor, tenantId, channelId); const entry = this.entries.get(channelId); this.live(entry || {}); if (entry.tenantId !== tenantId || signal?.aborted) return null; if (peer) this.selected(entry, peer);
      const bytes = await this.bounded(entry, entry.client.avatar(peer ? entry.peers.get(peer) : null), 10000); this.channel(actor, tenantId, channelId); if (peer) this.selected(entry, peer); return signal?.aborted ? null : avatarImage(bytes || []);
    } catch { return null; }
  }
  async restore() {
    for (const row of this.store.db.prepare('SELECT id,reseller_id,data FROM tenants').all()) for (const channel of JSON.parse(row.data).channels || []) {
      if (channel.kind !== 'telegram_user' || channel.transport !== 'telegram-user' || channel.state !== 'connected' || this.entries.has(channel.id) || this.closing) continue;
      let entry;
      try { const actor = this.actor(row.reseller_id); entry = await this.newEntry(actor, row.id, channel.id, () => this.channel(actor, row.id, channel.id)); if (!await this.bounded(entry, entry.client.authorized())) { await this.stop(entry); entry.state = 'disconnected'; continue; } await this.authenticated(entry, await this.bounded(entry, entry.client.getMe())); }
      catch { if (entry) { entry.state = 'failed'; entry.authState = 'error'; await this.stop(entry); } }
    }
  }
  connectedCount() { return [...this.entries.values()].filter(entry => this.active(entry) && entry.state === 'connected').length; }
  async close() { this.closing = true; await Promise.allSettled([...this.entries.values()].map(entry => this.stop(entry))); await Promise.allSettled([...this.entries.values()].map(entry => entry.queue)); await Promise.allSettled([...this.mediaTasks]); }
}
