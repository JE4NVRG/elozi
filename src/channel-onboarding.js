import { createHash } from 'node:crypto';
import { fail } from './store.js';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const transports = Object.freeze({ baileys: ['whatsapp'], 'telegram-bot': ['telegram'], 'telegram-user': ['telegram-user', null],
  'elozi-webchat': ['webchat'], 'mepmail-channel': ['email'], 'meta-instagram': ['instagram'], 'meta-messenger': ['messenger'] });
const sent = new Set(['sent', 'delivered', 'read']);

/** Only connectivity revisions and identities: runtime state, appearance and customer data never enter the receipt. */
export function channelConfigurationHash(channel) {
  const base = [channel.id, channel.kind, channel.transport, channel.enabled !== false];
  switch (channel.transport) {
    case 'baileys': base.push(channel.expectedNumber || null); break;
    case 'telegram-bot': base.push(channel.botAccountId || null, channel.telegramGroups?.version || 0); break;
    case 'telegram-user': base.push(channel.telegramUser?.version || 0, channel.telegramUser?.accountId || null, channel.telegramUser?.configured === true); break;
    case 'elozi-webchat': base.push(channel.webchat?.version || 0, channel.webchat?.enabled === true, [...(channel.webchat?.origins || [])].sort()); break;
    case 'mepmail-channel': base.push(channel.email?.version || 0, channel.email?.epoch || null, channel.email?.address || null, channel.email?.enabled === true); break;
    case 'meta-instagram': case 'meta-messenger': base.push(channel.meta?.version || 0, channel.meta?.resourceId || null, channel.meta?.apiVersion || null, channel.meta?.enabled === true, channel.meta?.credentialsConfigured === true); break;
    default: base.push(channel.version || 0);
  }
  return fingerprint(base);
}

function messageKey(message) { return fingerprint([message.id, message.externalId || null, message.createdAt, message.kind]); }
function eligible(message, channel, startedAt, now) {
  const createdAt = stamp(message?.createdAt);
  return typeof message?.id === 'string' && message.id.length > 0 && message.imported !== true && message.historical !== true
    && Number.isFinite(createdAt) && createdAt > startedAt && createdAt <= now
    && transports[channel.transport]?.includes(message.transport || null);
}
function candidate(tenant, channel, receipt, now) {
  const baseline = stamp(receipt.startedAt), rows = [];
  for (const conversation of tenant.conversations || []) {
    if (conversation.channelId !== channel.id) continue;
    if (channel.transport === 'telegram-user' && !(channel.telegramUser?.selectedPeerIds || []).includes(conversation.remoteChatId)) continue;
    const messages = conversation.messages || [];
    // The cursor also excludes pre-existing messages carrying a future provider timestamp; elapsed time never turns a replay into a new test.
    const cursor = receipt.baselineCounts?.[conversation.id] || 0;
    for (let index = cursor; index < messages.length; index++) {
      const incoming = messages[index];
      if (incoming?.kind !== 'customer' || !eligible(incoming, channel, baseline, now)
        || incoming.delivery && incoming.delivery !== 'received') continue;
      if (receipt.conversationId && (conversation.id !== receipt.conversationId || messageKey(incoming) !== receipt.incomingMessageHash)) continue;
      const incomingAt = stamp(incoming.createdAt);
      const reply = messages.slice(index + 1).find(message => ['human', 'agent'].includes(message?.kind) && sent.has(message.delivery)
        && eligible(message, channel, baseline, now) && stamp(message.createdAt) > incomingAt
        && (!receipt.replyMessageHash || messageKey(message) === receipt.replyMessageHash));
      rows.push({ conversationId: conversation.id, incoming, reply });
    }
  }
  rows.sort((a, b) => stamp(a.incoming.createdAt) - stamp(b.incoming.createdAt) || a.conversationId.localeCompare(b.conversationId)
    || a.incoming.id.localeCompare(b.incoming.id));
  return rows[0] || null;
}

/** Durable metadata in the existing tenant JSON. GET pins the observed exchange so a later conversation cannot replace it. */
export class ChannelOnboarding {
  constructor(store, { auth, available = () => false, now = Date.now } = {}) {
    this.store = store; this.auth = auth; this.available = available; this.now = now;
  }
  time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) fail(500, 'Relógio da validação indisponível.');
    return now;
  }
  authorize(actor, tenantId, reauthorize) {
    if (typeof reauthorize !== 'function') fail(400, 'Informe a autorização da validação.');
    if (reauthorize() === false) fail(403, 'O acesso à validação mudou.');
    if (!actor?.userId || actor.supportGrantId || actor.kind === 'service') fail(403, 'Somente o administrador da empresa valida o canal.');
    this.auth.admin(actor); this.store.admin(actor);
  }
  channel(tenant, channelId) {
    const channel = (tenant.channels || []).find(item => item.id === channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    return channel;
  }
  receipt(channel) {
    const value = channel.onboarding;
    return value?.schema === 1 && Number.isSafeInteger(value.version) && value.version > 0 ? value : null;
  }
  evaluate(tenant, channel, now) {
    const receipt = this.receipt(channel), channelAvailable = this.available(tenant, channel) === true;
    if (!receipt) return { channelAvailable, receipt: null, state: 'not_started', exchange: null };
    let stale = Boolean(receipt.staleAt) || receipt.configurationHash !== channelConfigurationHash(channel) || !Number.isFinite(stamp(receipt.startedAt));
    const exchange = stale ? null : candidate(tenant, channel, receipt, now);
    if (receipt.conversationId && (!exchange || receipt.replyMessageHash && !exchange.reply)) stale = true;
    const state = stale ? 'stale' : receipt.recipientConfirmed && receipt.validatedAt ? 'validated'
      : exchange?.reply ? 'waiting_confirmation' : exchange ? 'waiting_reply' : 'waiting_incoming';
    return { receipt, channelAvailable, state, exchange: stale ? null : exchange };
  }
  dto(tenantId, channelId, evaluation) {
    const { receipt, state, exchange, channelAvailable } = evaluation;
    return { tenantId, channelId, version: receipt?.version || 0, state, startedAt: receipt?.startedAt || null,
      validatedAt: state === 'validated' ? receipt.validatedAt : null,
      conversationId: exchange?.conversationId || null, incomingRecorded: Boolean(exchange), replyRecorded: Boolean(exchange?.reply),
      recipientConfirmed: state === 'validated', channelAvailable };
  }
  reconcile(channel, evaluation, now) {
    const receipt = evaluation.receipt;
    if (!receipt) return false;
    if (evaluation.state === 'stale') {
      if (receipt.staleAt) return false;
      receipt.staleAt = new Date(now).toISOString(); return true;
    }
    const { exchange } = evaluation;
    if (!exchange) return false;
    let changed = false;
    if (!receipt.conversationId) {
      Object.assign(receipt, { conversationId: exchange.conversationId, incomingMessageHash: messageKey(exchange.incoming), incomingAt: exchange.incoming.createdAt });
      changed = true;
    }
    if (exchange.reply && !receipt.replyMessageHash) {
      Object.assign(receipt, { replyMessageHash: messageKey(exchange.reply), replyAt: exchange.reply.createdAt }); changed = true;
    }
    return changed;
  }
  get(actor, tenantId, channelId, { reauthorize = () => {} } = {}) {
    this.authorize(actor, tenantId, reauthorize);
    const now = this.time(), tenant = this.store.tenant(actor, tenantId), channel = this.channel(tenant, channelId), evaluation = this.evaluate(tenant, channel, now);
    if (this.reconcile(channel, evaluation, now)) {
      this.store.mutate(actor, tenantId, 'Canal: prova de validação reconciliada', state => {
        this.authorize(actor, tenantId, reauthorize);
        const current = this.channel(state, channelId); this.reconcile(current, this.evaluate(state, current, now), now);
      });
    }
    this.authorize(actor, tenantId, reauthorize);
    const current = this.store.tenant(actor, tenantId);
    return this.dto(tenantId, channelId, this.evaluate(current, this.channel(current, channelId), now));
  }
  list(actor, tenantId, { reauthorize = () => {} } = {}) {
    this.authorize(actor, tenantId, reauthorize);
    const now = this.time(), tenant = this.store.tenant(actor, tenantId), channels = (tenant.channels || []).slice(0, 20), ids = channels.map(channel => channel.id);
    const changed = channels.map(channel => this.reconcile(channel, this.evaluate(tenant, channel, now), now)).some(Boolean);
    if (changed) this.store.mutate(actor, tenantId, 'Canais: provas de validação reconciliadas', state => {
      this.authorize(actor, tenantId, reauthorize);
      for (const channelId of ids) { const channel = this.channel(state, channelId); this.reconcile(channel, this.evaluate(state, channel, now), now); }
    });
    this.authorize(actor, tenantId, reauthorize);
    const current = changed ? this.store.tenant(actor, tenantId) : tenant;
    return { tenantId, items: ids.map(channelId => this.dto(tenantId, channelId, this.evaluate(current, this.channel(current, channelId), now))) };
  }
  update(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    this.authorize(actor, tenantId, reauthorize);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'version'].includes(key))
      || !['start', 'confirm'].includes(input.action) || !Number.isSafeInteger(input.version) || input.version < 0 || input.version >= Number.MAX_SAFE_INTEGER)
      fail(400, 'Informe somente a ação e a versão da validação.');
    // Reconcile observed invalidation independently of a refused confirmation: reverting an identity never revives an observed stale receipt.
    this.get(actor, tenantId, channelId, { reauthorize });
    const now = this.time();
    this.store.mutate(actor, tenantId, input.action === 'start' ? 'Canal: validação iniciada' : 'Canal: destino confirmado pelo administrador', tenant => {
      this.authorize(actor, tenantId, reauthorize);
      const channel = this.channel(tenant, channelId), evaluation = this.evaluate(tenant, channel, now), version = evaluation.receipt?.version || 0;
      if (version !== input.version) fail(409, 'A validação mudou. Atualize antes de continuar.');
      if (!evaluation.channelAvailable) fail(409, 'O canal está indisponível. Confira a conexão antes de validar.');
      if (input.action === 'start') {
        if (evaluation.receipt && evaluation.state !== 'stale') { this.reconcile(channel, evaluation, now); return; }
        const baselineCounts = Object.fromEntries((tenant.conversations || []).filter(conversation => conversation.channelId === channel.id)
          .map(conversation => [conversation.id, (conversation.messages || []).length]));
        channel.onboarding = { schema: 1, version: version + 1, configurationHash: channelConfigurationHash(channel), startedAt: new Date(now).toISOString(), baselineCounts,
          conversationId: null, incomingMessageHash: null, incomingAt: null, replyMessageHash: null, replyAt: null,
          recipientConfirmed: false, confirmedBy: null, validatedAt: null, staleAt: null };
        return;
      }
      if (evaluation.state === 'validated') return;
      if (evaluation.state !== 'waiting_confirmation') fail(409, evaluation.state === 'stale' ? 'A configuração mudou. Inicie uma nova validação.' : 'Receba uma mensagem nova e envie uma resposta antes de confirmar o destino.');
      this.reconcile(channel, evaluation, now);
      // This flag is the administrator's explicit destination confirmation, never provider proof of recipient delivery.
      Object.assign(channel.onboarding, { version: version + 1, recipientConfirmed: true, confirmedBy: actor.userId, validatedAt: new Date(now).toISOString() });
    });
    return this.get(actor, tenantId, channelId, { reauthorize });
  }
}
