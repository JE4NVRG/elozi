import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail, text } from './store.js';
import { allowedFields } from './access.js';
import { encryptedChannelSecrets } from './channel-secrets.js';
import { loadLocalKey } from './wa-auth.js';
import { clearConversationParticipants, noteStatus } from './operations.js';
import { resolveReply } from './replies.js';
import { syncIncomingConversationContact } from './contacts.js';
import { automatedSender, automatedAttribution, automatedFields } from './outbox.js';

const PROVIDER_URL = 'https://api-mepmail.je4ndev.com/emails';
const digest = value => createHash('sha256').update(value).digest('hex');
const date = value => new Date(value).toISOString();
export function channelEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim() || /[\s<>\x00-\x1f\x7f]/.test(value)
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
    || value.startsWith('.') || value.split('@')[0].endsWith('.') || value.includes('..')) fail(400, 'Informe um endereço de e-mail válido.');
  return value.toLowerCase();
}
function plainText(value, max, label) {
  const result = text(value, max);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) fail(400, `${label} inválido.`);
  return result;
}
function senderAddress(value) {
  if (typeof value !== 'string' || value.length > 340 || /[\r\n\x00-\x1f\x7f]/.test(value)) fail(400, 'Remetente MepMail inválido.');
  const display = value.match(/^([^<>]{1,80})\s<([^<>]+)>$/);
  return channelEmailAddress(display ? display[2] : value);
}
const privateId = (tenantId, channelId, epoch) => `elozi:email-channel:${tenantId}:${channelId}:${epoch}`;

/** MepMail outbound + an explicit Elozi signed-relay contract; no IMAP claim. */
export class EmailChannelGateway {
  #secretsPromise;
  constructor(store, { operations, onIncoming, fetchImpl = fetch, now = Date.now,
    getDeliveryConfiguration = async () => null, loadSecrets, maxMessagesPerMinute = 120 } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof getDeliveryConfiguration !== 'function'
      || (loadSecrets !== undefined && typeof loadSecrets !== 'function') || !Number.isSafeInteger(maxMessagesPerMinute)
      || maxMessagesPerMinute < 1 || maxMessagesPerMinute > 1000) fail(400, 'Configuração do canal de e-mail inválida.');
    this.store = store; this.operations = operations; this.onIncoming = onIncoming;
    this.fetch = fetchImpl; this.now = now; this.getDeliveryConfiguration = getDeliveryConfiguration;
    this.loadSecrets = loadSecrets || (async () => encryptedChannelSecrets(store.db, await loadLocalKey()));
    this.closed = false; this.controllers = new Set(); this.tasks = new Set(); this.maxMessagesPerMinute = maxMessagesPerMinute;
    store.db.exec(`CREATE TABLE IF NOT EXISTS channel_email_seen (
      tenant_id TEXT NOT NULL, channel_id TEXT NOT NULL, event_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      conversation_version INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,channel_id,event_id));
      CREATE INDEX IF NOT EXISTS channel_email_seen_time ON channel_email_seen(tenant_id,channel_id,created_at);`);
  }
  async #secrets() {
    this.#secretsPromise ||= this.loadSecrets();
    const secrets = await this.#secretsPromise;
    if (typeof secrets?.get !== 'function' || typeof secrets?.set !== 'function') fail(503, 'Cofre do canal de e-mail indisponível.');
    return secrets;
  }
  actor(resellerId) { return { role: 'reseller', resellerId, name: 'Gateway e-mail' }; }
  channel(actor, tenantId, channelId) {
    const tenant = this.store.tenant(actor, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    if (!channel || channel.kind !== 'email') fail(404, 'Canal de e-mail indisponível nesta empresa.');
    return { tenant, channel };
  }
  #admin(actor) {
    if (!this.operations?.admin) fail(503, 'Autorização do canal indisponível.');
    this.operations.admin(actor); this.store.admin(actor);
  }
  async configure(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['address', 'enabled', 'version', 'ingressSecret']); reauthorize(); this.#admin(actor);
    const { channel } = this.channel(actor, tenantId, channelId), revision = channel.email?.version || 0;
    if (input.version !== undefined && input.version !== revision) fail(409, 'A configuração do e-mail mudou.');
    const address = channelEmailAddress(input.address ?? channel.email?.address), enabled = input.enabled ?? true;
    if (typeof enabled !== 'boolean') fail(400, 'Informe o estado do canal de e-mail.');
    if (input.ingressSecret !== undefined && (typeof input.ingressSecret !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(input.ingressSecret))) fail(400, 'Informe um segredo de relay com pelo menos 32 caracteres.');
    const secrets = await this.#secrets(), existing = channel.email?.epoch ? await secrets.get(privateId(tenantId, channelId, channel.email.epoch)) : null;
    reauthorize(); this.#admin(actor);
    const current = this.channel(actor, tenantId, channelId).channel;
    if ((current.email?.version || 0) !== revision) fail(409, 'A configuração do e-mail mudou.');
    const ingressSecret = input.ingressSecret ?? existing?.ingressSecret;
    if (enabled && !ingressSecret) fail(400, 'Configure o segredo do relay de entrada.');
    const epoch = randomUUID();
    // Each epoch has its own encrypted record. A stale asynchronous write can
    // neither activate itself nor overwrite the currently active relay secret.
    await secrets.set(privateId(tenantId, channelId, epoch), { ingressSecret: ingressSecret || null, epoch });
    reauthorize(); this.#admin(actor);
    this.store.mutate(actor, tenantId, 'E-mail: configuração atualizada', tenant => {
      const item = tenant.channels.find(channel => channel.id === channelId);
      if (!item || item.kind !== 'email' || (item.email?.version || 0) !== revision) fail(409, 'A configuração do e-mail mudou.');
      item.transport = 'mepmail-channel'; item.state = enabled ? 'configured' : 'disconnected';
      item.label = enabled ? 'MepMail e relay assinado; caixa postal externa necessária' : 'Canal de e-mail desativado';
      item.email = { address, enabled, version: revision + 1, epoch, ingress: 'elozi-signed-relay', mediaSupported: false };
    });
    return this.status(actor, tenantId, channelId);
  }
  async status(actor, tenantId, channelId) {
    this.#admin(actor);
    const { channel } = this.channel(actor, tenantId, channelId), revision = channel.email?.version || 0;
    const secrets = await this.#secrets(), stored = channel.email?.epoch ? await secrets.get(privateId(tenantId, channelId, channel.email.epoch)) : null;
    this.#admin(actor);
    const current = this.channel(actor, tenantId, channelId).channel;
    if ((current.email?.version || 0) !== revision) fail(409, 'A configuração do e-mail mudou.');
    return { state: this.closed || !current.email?.enabled ? 'disconnected' : 'configured', version: revision,
      address: current.email?.address || null, ingress: 'elozi-signed-relay',
      ingressConfigured: Boolean(current.email?.enabled && stored?.ingressSecret && stored.epoch === current.email.epoch),
      mailboxConnected: false, mediaSupported: false };
  }
  #source(tenantId, channelId, epoch) {
    if (this.closed) fail(503, 'Canal de e-mail indisponível.');
    const row = this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId);
    if (!row) fail(404, 'Canal de e-mail indisponível.');
    const actor = this.actor(row.reseller_id), { tenant, channel } = this.channel(actor, tenantId, channelId);
    if (channel.transport !== 'mepmail-channel' || !channel.email?.enabled || typeof channel.email.epoch !== 'string' || !Number.isSafeInteger(channel.email.version) || channel.email.version < 1 || channel.state !== 'configured'
      || epoch !== undefined && channel.email.epoch !== epoch) fail(409, 'A configuração do canal de e-mail mudou.');
    return { actor, tenant, channel };
  }
  async receiveWebhook({ tenantId, channelId, rawBody, timestamp, signature }) {
    if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > 65_536 || !rawBody.byteLength) fail(413, 'O relay aceita até 64 KiB de texto.');
    const source = this.#source(tenantId, channelId), epoch = source.channel.email.epoch;
    if (typeof timestamp !== 'string' || !/^\d{10,13}$/.test(timestamp) || Math.abs(this.now() - Number(timestamp) * 1000) > 300_000
      || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) fail(403, 'Assinatura do relay indisponível ou expirada.');
    const secrets = await this.#secrets(), stored = await secrets.get(privateId(tenantId, channelId, epoch));
    const current = this.#source(tenantId, channelId, epoch);
    if (!stored?.ingressSecret || stored.epoch !== epoch) fail(403, 'Assinatura do relay indisponível.');
    const expected = createHmac('sha256', stored.ingressSecret).update(`${timestamp}.`).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail(403, 'Assinatura do relay inválida.');
    let input;
    try { input = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { fail(400, 'Envelope de relay inválido.'); }
    allowedFields(input, ['id', 'from', 'to', 'fromName', 'subject', 'text'], 'O relay aceita somente texto, sem anexos ou HTML.');
    const eventId = text(input.id, 160);
    if (/[\x00-\x20\x7f]/.test(eventId)) fail(400, 'Identificador de e-mail inválido.');
    const from = channelEmailAddress(input.from), to = channelEmailAddress(input.to);
    if (to !== current.channel.email.address) fail(403, 'O destinatário não pertence a este canal.');
    const subject = plainText(input.subject, 200, 'Assunto');
    if (/[\r\n]/.test(subject)) fail(400, 'Assunto de e-mail inválido.');
    const content = plainText(input.text, 4000, 'Mensagem'), name = input.fromName === undefined ? from : plainText(input.fromName, 80, 'Nome');
    if (/[\r\n]/.test(name)) fail(400, 'Nome de remetente inválido.');
    const contentHash = digest(JSON.stringify([from, to, subject, content, name]));
    const replay = this.store.db.prepare('SELECT * FROM channel_email_seen WHERE tenant_id=? AND channel_id=? AND event_id=?').get(tenantId, channelId, eventId);
    if (replay) {
      if (replay.content_hash !== contentHash) fail(409, 'Identificador já usado por outro e-mail.');
      return { conversationId: replay.conversation_id, messageId: replay.message_id, conversationVersion: replay.conversation_version, replayed: true };
    }
    const recent = this.store.db.prepare('SELECT count(*) AS count FROM channel_email_seen WHERE tenant_id=? AND channel_id=? AND created_at>?').get(tenantId, channelId, date(this.now() - 60_000)).count;
    if (recent >= this.maxMessagesPerMinute) fail(429, 'Aguarde um minuto antes de registrar mais e-mails neste canal.');
    const receipt = this.store.mutate(current.actor, tenantId, 'E-mail: mensagem recebida pelo relay', tenant => {
      this.#source(tenantId, channelId, epoch);
      let conversation = tenant.conversations.find(item => item.channelId === channelId && item.remoteEmail === from);
      const newConversation = !conversation, createdAt = date(this.now());
      if (!conversation) {
        const department = (tenant.departments || []).find(item => item.active !== false && item.id === tenant.defaultDepartmentId);
        conversation = { id: randomUUID(), channelId, remoteEmail: from, contact: name, initials: name.slice(0, 2).toUpperCase(), conversationKind: 'direct',
          department: department?.name || 'Suporte', departmentId: department?.id || null, owner: 'queue', assignedUserId: null,
          status: 'open', version: 1, unread: 0, agentId: null, tags: ['E-mail'], messages: [] };
        tenant.conversations.unshift(conversation);
      }
      const reopened = conversation.status === 'closed';
      if (reopened) {
        conversation.status = 'open'; clearConversationParticipants(conversation, current.actor, { origin: 'email', reason: 'Novo e-mail após encerramento.' });
        conversation.owner = 'queue'; conversation.assignedUserId = null; conversation.assignedUserName = null; conversation.agentId = null;
        delete conversation.assignedSupportGrantId; noteStatus(conversation, current.actor, 'closed', { origin: 'email' });
      }
      syncIncomingConversationContact(tenant, conversation, tenant.channels.find(item => item.id === channelId));
      const messageId = randomUUID(); conversation.emailSubject = subject;
      conversation.messages.push({ id: messageId, externalId: eventId, kind: 'customer', text: content, emailSubject: subject, senderName: name, createdAt, delivery: 'received', transport: 'email' });
      conversation.version++; conversation.updatedAt = createdAt; conversation.unread++;
      this.store.db.prepare('INSERT INTO channel_email_seen VALUES (?,?,?,?,?,?,?,?)').run(tenantId, channelId, eventId, contentHash, conversation.id, messageId, conversation.version, createdAt);
      return { conversationId: conversation.id, messageId, conversationVersion: conversation.version, newConversation, reopened };
    });
    const entry = { actor: current.actor, tenantId, channelId };
    try { await this.onIncoming?.(entry, receipt.conversationId, receipt.messageId, receipt); } catch { /* The e-mail is already committed. */ }
    try { this.operations?.routeIncoming?.(tenantId, receipt.conversationId); } catch { /* Routing stays available to the operator. */ }
    return { conversationId: receipt.conversationId, messageId: receipt.messageId, conversationVersion: receipt.conversationVersion, replayed: false };
  }
  send(actor, tenantId, conversationId, input, options = {}) {
    const task = this.#send(actor, tenantId, conversationId, input, options); this.tasks.add(task);
    task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }
  async #send(actor, tenantId, conversationId, input, { reauthorize = () => {}, attribution = null } = {}) {
    allowedFields(input, ['channelId', 'version', 'text', 'idempotencyKey', 'replyToMessageId','attachmentIds'], 'Este canal de e-mail aceita somente texto.');
    if(input.attachmentIds!==undefined&&(!Array.isArray(input.attachmentIds)||input.attachmentIds.length))fail(400,'Este canal de e-mail aceita somente texto.');
    if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a versão atual do atendimento.');
    const content = plainText(input.text, 4000, 'Mensagem');
    if (!this.operations?.canReply) fail(503, 'Autorização do atendimento indisponível.');
    // Automated senders (a service principal or the autopilot) answer only conversations owned by their agent; canReply decides.
    const { service, autopilot } = automatedSender(actor);
    if (autopilot && !automatedAttribution(attribution)) fail(403, 'O envio automático precisa da tarefa e do agente que o autorizaram.');
    const authorize = () => {
      reauthorize();
      const { tenant, channel } = this.channel(actor, tenantId, input.channelId), conversation = this.store.getConversation(tenant, conversationId, input.version);
      this.operations.canReply(actor, tenantId, conversation);
      if (conversation.owner !== (service || autopilot ? 'agent' : 'human') || conversation.channelId !== channel.id || this.closed) fail(409, 'Assuma o atendimento e use o canal de origem.');
      this.#source(tenantId, channel.id);
      return { tenant, channel, conversation };
    };
    let { tenant, channel, conversation } = authorize();
    const epoch = channel.email.epoch, address = channel.email.address, recipient = channelEmailAddress(conversation.remoteEmail);
    const config = await this.getDeliveryConfiguration({ actor, tenantId, channelId: channel.id, address });
    ({ tenant, channel, conversation } = authorize());
    if (channel.email.epoch !== epoch || channel.email.address !== address || conversation.remoteEmail !== recipient) fail(409, 'O canal ou destinatário do e-mail mudou.');
    if (!config || typeof config.apiKey !== 'string' || !/^ms_[A-Za-z0-9_-]{12,509}$/.test(config.apiKey) || senderAddress(config.from) !== address) fail(503, 'Configure o MepMail para o remetente deste canal.');
    const key = input.idempotencyKey || randomUUID();
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) fail(400, 'Identificador de envio inválido.');
    // Without a subject of its own the reply is titled with the company's brand, never the platform's.
    const subject = plainText(conversation.emailSubject || `Atendimento ${tenant.brand?.name || tenant.name}`, 200, 'Assunto');
    if (/[\r\n]/.test(subject)) fail(400, 'Assunto de e-mail inválido.');
    const id = randomUUID(), createdAt = date(this.now());
    this.store.mutate(actor, tenantId, 'E-mail: envio solicitado', tenant => {
      const current = this.store.getConversation(tenant, conversationId, input.version); this.operations.canReply(actor, tenantId, current);
      if ((service || autopilot) && current.owner !== 'agent') fail(409, 'O atendimento saiu do agente antes do envio.');
      const reply = resolveReply(current, input);
      current.messages.push({ id, kind: service || autopilot ? 'agent' : 'human', text: content, authorUserId: actor.userId || null, authorName: actor.name,
        ...automatedFields(actor, input, attribution), ...(reply ? { replyToMessageId: reply.messageId } : {}), createdAt, delivery: 'pending', transport: 'email' });
      current.version++; current.updatedAt = createdAt;
    });
    const controller = new AbortController(); this.controllers.add(controller);
    let state = 'unconfirmed', providerId = null, attempted = false, definite = false;
    try {
      reauthorize(); this.#source(tenantId, channel.id, epoch);
      this.operations.canReply(actor, tenantId, this.store.getConversation(this.store.tenant(actor, tenantId), conversationId));
      attempted = true;
      const response = await this.fetch(PROVIDER_URL, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': digest(JSON.stringify([tenantId, channel.id, key])) },
        body: JSON.stringify({ from: config.from, to: [recipient], subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text: content }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (response.ok) {
        const result = await response.json();
        if (typeof result?.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(result.id)) { state = 'sent'; providerId = result.id; }
      } else if (response.status >= 400 && response.status < 500) { state = 'failed'; definite = true; }
    } catch (error) {
      if (!attempted) { state = 'failed'; definite = true; }
      if (!attempted && error.status) {
        this.#settle(tenantId, channel.id, conversationId, id, state, providerId); throw error;
      }
    } finally { this.controllers.delete(controller); }
    try { this.#settle(tenantId, channel.id, conversationId, id, state, providerId); }
    catch (error) {
      if (!attempted) throw error;
      fail(502, 'O e-mail foi solicitado; o recibo local não pôde ser registrado. Confira o destino antes de reenviar.');
    }
    if (state !== 'sent') fail(definite ? 400 : 502, definite ? 'O MepMail recusou o envio. Confira a configuração.' : 'Envio de e-mail sem confirmação. Confira o destinatário antes de reenviar.');
    try {
      reauthorize();
      const latest = this.store.getConversation(this.store.tenant(actor, tenantId), conversationId);
      this.operations.canReply(actor, tenantId, latest);
      this.#source(tenantId, channel.id, epoch);
      if (latest.channelId !== channel.id || latest.remoteEmail !== recipient) fail(409, 'A origem do atendimento mudou durante o envio. Confira o recibo.');
      return latest;
    } catch {
      fail(502, 'MepMail aceitou o envio; o acesso ou destino mudou antes da resposta local. Atualize a sessão e confira o atendimento.');
    }
  }
  #settle(tenantId, channelId, conversationId, messageId, delivery, providerId) {
    const row = this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId);
    if (!row) fail(404, 'Empresa de origem indisponível.');
    this.store.mutate(this.actor(row.reseller_id), tenantId, 'E-mail: recibo do transporte registrado', tenant => {
      const conversation = this.store.getConversation(tenant, conversationId);
      if (conversation.channelId !== channelId) fail(409, 'A origem do atendimento mudou.');
      const message = conversation.messages.find(item => item.id === messageId);
      if (!message || message.transport !== 'email') fail(409, 'Mensagem de origem indisponível.');
      message.delivery = delivery;
      if (providerId) message.externalId = providerId;
      if (delivery === 'sent') conversation.unread = 0;
    });
  }
  async close() {
    this.closed = true; for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }
}
