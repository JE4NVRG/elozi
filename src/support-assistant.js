import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { allowedFields } from './access.js';
import { webchatOrigin } from './channel-webchat.js';
import { agentImageAttachments, AGENT_IMAGE_MAX_COUNT } from './agent-runtime.js';
import { untrustedContact } from './agent-autopilot.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Keep the same configuration fields as AgentRuntime's accepted run snapshot.
const agentHash = agent => hash({ provider: agent.provider, mode: agent.mode, description: agent.description ?? '', tools: agent.tools ?? [], version: agent.version ?? 1,
  ...(agent.instructions ? { instructions: agent.instructions } : {}), ...(agent.toolPolicy !== undefined ? { toolPolicy: agent.toolPolicy } : {}) });
const live = new Set(['pending', 'running', 'sending']);
// A failed handoff precheck is not re-evaluated until its tenant inputs change; the retry bound
// still revisits session/callback state that lives outside the tenant JSON.
const NOTIFICATION_RETRY_MS = 60000, NOTIFICATION_FAILURES_MAX = 1000;
const safeTimings = job => job.timingsMs ? Object.fromEntries(['queue', 'precheck', 'knowledge', 'runtime', 'send', 'total'].map(key => [key, Number.isFinite(job.timingsMs[key]) ? Math.max(0, job.timingsMs[key]) : 0])) : null;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const summary = job => ({ id: job.id, conversationId: job.conversationId, messageId: job.messageId, channelId: job.channelId,
  state: job.state, runId: job.runId, reason: job.reason || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
  timingsMs: safeTimings(job), handoffNotification: job.handoffNotification ? { state: job.handoffNotification.state, updatedAt: job.handoffNotification.updatedAt } : null });
const strict = (fn, ...args) => {
  const result = fn(...args);
  if (result?.then) { Promise.resolve(result).catch(() => {}); fail(500, 'A autorização do suporte precisa ser síncrona.'); }
  if (result !== true) fail(403, 'O suporte não está autorizado neste contexto.');
};
const humanTaken = (conversation, config) => conversation.owner === 'human' || Boolean(conversation.assignedUserId)
  || Boolean(conversation.participants?.length) || conversation.supportAssistantHandoff?.active === true && (conversation.supportAssistantHandoff.pauseAutomation !== false
    || conversation.supportAssistantHandoff.reason !== 'agent_requested_human' || config?.handoffMode !== 'continue');
// The precheck ranks knowledge only by the visitor's words (300 code points, controls as spaces), with the scope's
// product names as generic terms: a question that only repeats the product name never authorizes a reply.
const customerQuery = text => Array.from(typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').toWellFormed().trim() : '').slice(0, 300).join('').trimEnd();
const referenceKey = reference => JSON.stringify([reference.sourceId, reference.publicationHash, reference.chunkId]);
const supportInstructions = channel => {
  const value = channel?.webchat?.assistantInstructions ?? channel?.webchat?.widget?.assistantInstructions ?? '';
  if (typeof value !== 'string' || value.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(409, 'As instruções da conexão de suporte são inválidas.');
  return value.trim();
};
// Only after knowledge.current(): retrieved publication excerpts and approved instructions authorize contacts.
// Provider/profile/memory, visitor text and private notification/tenant metadata never enter this allowlist.
const trustedContacts = (context, run) => [...(run.knowledgeReferences || []).map(reference => typeof reference?.excerpt === 'string' ? reference.excerpt : ''),
  typeof context.agent.instructions === 'string' ? context.agent.instructions : '', supportInstructions(context.channel)].join('\n');
const allJobs = tenant => [...(tenant.supportAssistantJobs || []), ...(tenant.conversations || []).flatMap(conversation => conversation.supportAssistantHandoff?.overflowJob ? [conversation.supportAssistantHandoff.overflowJob] : [])];
const failureReason = (error, timedOut) => timedOut || error?.code === 'timeout' || error?.code === 'preparation_timeout' ? 'preparation_timeout'
  : error?.code === 'quiet_hours' || error?.reason === 'quiet_hours' ? 'quiet_hours'
  : error?.status === 429 || error?.code === 'ai_quota_exceeded' ? 'limit_reached' : 'preparation_failed';
function validatedScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length > 64) throw new TypeError('Configuração do assistente de suporte inválida.');
  const seen = new Set();
  return scopes.map(scope => {
    if (!scope || !id(scope.resellerId) || !id(scope.tenantId) || !id(scope.channelId)
      || !Array.isArray(scope.origins) || !scope.origins.length || scope.origins.length > 8
      || !Array.isArray(scope.products) || !scope.products.length || scope.products.length > 8
      || scope.products.some(value => typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))) throw new TypeError('Escopo próprio de suporte inválido.');
    const key = JSON.stringify([scope.tenantId, scope.channelId]);
    if (seen.has(key)) throw new TypeError('Conexão de suporte duplicada.');
    seen.add(key);
    const result = { resellerId: scope.resellerId, tenantId: scope.tenantId, channelId: scope.channelId,
      origins: [...new Set(scope.origins.map(webchatOrigin))].sort(), products: [...new Set(scope.products.map(value => value.trim()))].sort() };
    return Object.freeze({ ...result, origins: Object.freeze(result.origins), products: Object.freeze(result.products), hash: hash(result) });
  });
}

/** A visitor's explicit request pauses automation until a human clears the pause. */
export function requestsHumanSupport(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().slice(0, 4000);
  const jeanRequested = normalized.split(/[.!?\n]/).some(sentence => {
    const request = sentence.match(/(?:\b(?:(?:quero|preciso|gostaria)(?:\s+de)?\s+(?:mais\s+)?|(?:posso|pode|poderia)\s+)|^\s*(?:por\s+favor[,\s]+)?)(?:falar|conversar)\s+com\s+(?:o\s+)?jean\b/);
    return Boolean(request && !/\b(?:nao|nunca|nem)(?:\s+e)?\s+$/.test(sentence.slice(0, request.index)));
  });
  return /\b(?:atendimento|suporte)\s+(?:humano|humana)\b/.test(normalized)
    || /\b(?:falar|conversar|atendido|atendida|quero|preciso|chame|chamar|transfira|transferir|encaminhe)\b[^.!?\n]{0,65}\b(?:humano|humana|pessoa|atendente|operador|operadora)\b/.test(normalized)
    || jeanRequested
    || /(?:^|[.!?\n]\s*|\b(?:i\s+(?:want|need|would\s+like)\s+to|i['’]d\s+like\s+to|(?:can|could|may)\s+i|please|let\s+me))\s*(?:talk|speak|chat)\s+(?:to|with)\s+(?:(?:a|an|the|your|real|actual|live|support|human)\s+){0,4}(?:human|person|agent|operator|jean)\b/.test(normalized)
    || /(?:^|[.!?\n]\s*|\b(?:please|(?:can|could|would)\s+you(?:\s+please)?))\s*(?:(?:connect|transfer)\s+me\s+(?:to|with)|put\s+me\s+through\s+to)\s+(?:(?:a|an|the|your|real|live|support|human)\s+){0,4}(?:human|person|agent|operator|jean)\b/.test(normalized)
    || /^\s*human\s+support[\s.!?]*$/.test(normalized)
    || /\b(?:i\s+(?:want|need|would\s+like)|i['’]d\s+like|(?:can|could|may)\s+i\s+(?:get|have)|please(?:\s+(?:provide|get))?)\s+(?:(?:some|live|your)\s+)?human\s+support\b/.test(normalized);
}

/**
 * Server-owned scopes restrict this worker to our own webchat connections.
 * Jobs/configuration use existing tenant JSON, not a new operational database.
 * receive() only commits a job; the application owns polling via drain().
 * sendReply must use the narrow internal gateway and return {confirmed:true}.
 */
export class SupportAssistant {
  constructor(store, { runtime, knowledge, operations = null, scopes = [], authorize = () => false,
    authorizeAdmin = () => false, actorFactory, sendReply = null, onHandoff = null, handoffEnabled = () => false, now = Date.now,
    timeoutMs = 35000, concurrency = 2, maxJobsPerTenant = 10000, ownKnowledge = () => false, imageInput = () => false } = {}) {
    if (!runtime?.start || !knowledge?.snapshot || !knowledge?.search || !knowledge?.current
      || typeof authorize !== 'function' || typeof authorizeAdmin !== 'function' || typeof now !== 'function'
      || actorFactory !== undefined && typeof actorFactory !== 'function' || sendReply !== null && typeof sendReply !== 'function'
      || onHandoff !== null && typeof onHandoff !== 'function' || typeof handoffEnabled !== 'function' || typeof ownKnowledge !== 'function' || typeof imageInput !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
      || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10
      || !Number.isSafeInteger(maxJobsPerTenant) || maxJobsPerTenant < 1 || maxJobsPerTenant > 100000
      || !Array.isArray(scopes) || scopes.length > 64) throw new TypeError('Configuração do assistente de suporte inválida.');
    this.scopes = validatedScopes(scopes);
    this.store = store.sync ?? store; this.runtime = runtime; this.knowledge = knowledge; this.operations = operations;
    this.authorize = authorize; this.authorizeAdmin = authorizeAdmin; this.sendReply = sendReply; this.now = now;
    this.onHandoff = onHandoff; this.handoffEnabled = handoffEnabled; this.handoffActive = new Map();
    // A full Hermes profile (operator-declared origin) carries the company knowledge itself: a turn such as
    // a greeting or a follow-up may not match a published passage and still deserves an answer.
    this.ownKnowledge = agent => { try { return ownKnowledge(agent) === true; } catch { return false; } };
    // A vision-capable profile sees screenshots itself; any other media still goes to the team.
    this.imageInput = agent => { try { return imageInput(agent) === true; } catch { return false; } };
    this.timeoutMs = timeoutMs; this.concurrency = concurrency; this.maxJobsPerTenant = maxJobsPerTenant;
    this.actorFactory = actorFactory || ((scope, job) => ({ kind: 'service', role: 'reseller', resellerId: scope.resellerId,
      name: 'Assistente interno de suporte', supportAssistantId: job?.id || null }));
    this.active = new Map(); this.pendingTasks = new Set(); this.closed = false; this.notificationFailures = new Map();
  }
  /** Internal server API: only load scopes registered by the platform owner. */
  replaceScopes(scopes) {
    const next = validatedScopes(scopes), changed = this.scopes.filter(previous => !next.some(scope => scope.hash === previous.hash));
    for (const scope of changed) {
      const actor = this._actor(scope), tenant = this.store.tenant(actor, scope.tenantId);
      if ((tenant.supportAssistantJobs || []).some(job => job.channelId === scope.channelId && (live.has(job.state) || job.state === 'draft'))) {
        this.store.mutate(actor, scope.tenantId, 'Escopo próprio do suporte atualizado', current => {
          for (const job of current.supportAssistantJobs || []) if (job.channelId === scope.channelId && (live.has(job.state) || job.state === 'draft')) {
            job.state = job.state === 'sending' ? 'unknown' : 'skipped'; job.reason = 'scope_changed'; job.updatedAt = new Date(this.now()).toISOString(); delete job.leaseUntil;
          }
        });
      }
      this._abortChannel(scope.tenantId, scope.channelId);
    }
    this.scopes = next;
    return this.scopes.map(scope => ({ tenantId: scope.tenantId, channelId: scope.channelId, products: [...scope.products], origins: [...scope.origins] }));
  }
  _scope(tenantId, channelId, resellerId) {
    const scope = this.scopes.find(item => item.tenantId === tenantId && item.channelId === channelId && (!resellerId || item.resellerId === resellerId));
    if (!scope) fail(403, 'Esta conexão não pertence à central própria de suporte.');
    return scope;
  }
  _actor(scope, job) {
    const actor = this.actorFactory(scope, job);
    if (actor?.kind !== 'service' || !['reseller', 'operator'].includes(actor.role) || actor.resellerId !== scope.resellerId
      || actor.role === 'operator' && !(actor.tenantIds || [actor.tenantId]).includes(scope.tenantId)
      || actor.userId || actor.supportGrantId || actor.serviceId || job && actor.supportAssistantId !== job.id) fail(403, 'Identidade interna de suporte inválida.');
    return actor;
  }
  _admin(actor, tenantId, channelId, reauthorize) {
    if (typeof reauthorize !== 'function') fail(400, 'Autorização administrativa inválida.');
    const result = reauthorize();
    if (result?.then) { Promise.resolve(result).catch(() => {}); fail(500, 'A autorização administrativa precisa ser síncrona.'); }
    if (result === false) fail(403, 'O acesso administrativo mudou.');
    this._scope(tenantId, channelId, actor?.resellerId); this.store.admin(actor);
    strict(this.authorizeAdmin, actor, tenantId, channelId);
  }
  configure(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'agentId', 'enabled', 'autoReply', 'handoffMode']);
    const handoffMode = input.handoffMode ?? 'pause';
    if (!['pause', 'continue'].includes(handoffMode)) fail(400, 'Escolha se o assistente continua após abrir um chamado ou aguarda a equipe.');
    if (!Number.isSafeInteger(input.version) || input.version < 0 || typeof input.enabled !== 'boolean'
      || typeof input.autoReply !== 'boolean' || !id(input.agentId) || input.autoReply && !input.enabled) fail(400, 'Informe agente, revisão e os dois estados explícitos do suporte.');
    if (input.autoReply && !this.sendReply) fail(503, 'Envio interno de suporte indisponível.');
    this._admin(actor, tenantId, channelId, reauthorize);
    this.store.mutate(actor, tenantId, 'Assistente próprio de suporte configurado', tenant => {
      this._admin(actor, tenantId, channelId, reauthorize);
      const channel = tenant.channels.find(item => item.id === channelId);
      if (!channel || channel.kind !== 'webchat' || channel.transport !== 'elozi-webchat') fail(409, 'Configure a conexão própria de webchat antes do suporte.');
      if ((channel.supportAssistant?.version || 0) !== input.version || input.version === Number.MAX_SAFE_INTEGER) fail(409, 'A configuração do suporte mudou.');
      if (input.enabled) this._agent(tenant, input.agentId);
      channel.supportAssistant = { version: input.version + 1, agentId: input.agentId, enabled: input.enabled,
        autoReply: input.autoReply, handoffMode, configuredAt: new Date(this.now()).toISOString(), configuredBy: actor.userId || null };
      for (const job of tenant.supportAssistantJobs || []) if (job.channelId === channelId && live.has(job.state)) {
        job.state = job.state === 'sending' ? 'unknown' : 'skipped'; job.reason = 'configuration_changed'; job.updatedAt = new Date(this.now()).toISOString();
      }
    });
    this._abortChannel(tenantId, channelId);
    return this.status(actor, tenantId, channelId);
  }
  status(actor, tenantId, channelId) {
    this._admin(actor, tenantId, channelId, () => {});
    const scope = this._scope(tenantId, channelId), tenant = this.store.tenant(actor, tenantId);
    const channel = tenant.channels.find(item => item.id === channelId);
    if (!channel || channel.kind !== 'webchat') fail(404, 'Conexão própria de suporte indisponível.');
    const config = channel.supportAssistant || { version: 0, enabled: false, autoReply: false, agentId: null };
    return { channelId, products: [...scope.products], origins: [...scope.origins], ...structuredClone(config),
      workerAvailable: !this.closed, sendAvailable: Boolean(this.sendReply),
      jobs: (tenant.supportAssistantJobs || []).filter(job => job.channelId === channelId).slice(-40).reverse().map(summary) };
  }
  _agent(tenant, agentId, { requireKnowledge = true } = {}) {
    const agent = tenant.agents.find(item => item.id === agentId);
    if (!agent || agent.provider !== 'hermes' || agent.mode !== 'copilot' || agent.configured !== true) fail(409, 'Configure o Hermes interno em modo copiloto.');
    if (requireKnowledge && !this.knowledge.snapshot(tenant, agent).length) fail(409, 'Publique e autorize conhecimento revisado para o suporte.');
    return agent;
  }
  _context(scope, job, { version = job?.conversationVersion, checkLatest = true, allowPaused = false, requireKnowledge = true, tenant: preread = null } = {}) {
    if (this.closed) fail(503, 'Assistente de suporte encerrado.');
    // A pre-read tenant only saves the parse; every check below still runs against it.
    const actor = this._actor(scope, job), tenant = preread ?? this.store.tenant(actor, scope.tenantId);
    const channel = tenant.channels.find(item => item.id === scope.channelId), config = channel?.supportAssistant;
    if (!config?.enabled || !Number.isSafeInteger(config.version) || !['queue', 'agent', 'human'].includes(tenant.conversations.find(item => item.id === job.conversationId)?.owner)
      || channel.kind !== 'webchat' || channel.transport !== 'elozi-webchat' || channel.state !== 'connected'
      || channel.webchat?.enabled !== true || !Number.isSafeInteger(channel.webchat.version)) fail(409, 'A configuração da conexão de suporte mudou.');
    if (job.scopeHash !== scope.hash || config.version !== job.configurationVersion || config.agentId !== job.agentId
      || channel.webchat.version !== job.webchatRevision || typeof config.autoReply !== 'boolean') fail(409, 'A autorização do suporte mudou.');
    if (job.supportInstructionsHash !== undefined && job.supportInstructionsHash !== hash(supportInstructions(channel))) fail(409, 'As instruções da conexão de suporte mudaram.');
    const conversation = this.store.getConversation(tenant, job.conversationId, version);
    if (conversation.channelId !== scope.channelId || conversation.status === 'closed' || conversation.owner === 'agent' && conversation.agentId !== config.agentId
      || !allowPaused && humanTaken(conversation, config)) fail(409, 'Atendimento encaminhado para a equipe humana.');
    const message = conversation.messages.find(item => item.id === job.messageId && item.kind === 'customer' && item.transport === 'webchat');
    if (!message || checkLatest && conversation.messages.filter(item => item.kind === 'customer').at(-1)?.id !== message.id) fail(409, 'Outra mensagem substituiu esta preparação de suporte.');
    const session = this.store.db.prepare('SELECT * FROM webchat_sessions WHERE id=? AND tenant_id=? AND channel_id=? AND conversation_id=?').get(conversation.remoteSessionId, scope.tenantId, scope.channelId, conversation.id);
    if (!session || session.expires_at <= this.now() || session.channel_revision !== channel.webchat.version
      || !scope.origins.includes(session.origin) || !channel.webchat.origins?.includes(session.origin)) fail(403, 'A origem ou sessão do visitante perdeu autorização.');
    const agent = this._agent(tenant, config.agentId, { requireKnowledge });
    if (job.agentConfigHash !== agentHash(agent)) fail(409, 'A configuração do Hermes de suporte mudou.');
    strict(this.authorize, { actor, scope, job: structuredClone(job), tenant, channel, conversation, phase: 'current' });
    return { actor, tenant, channel, config, conversation, message, agent, session };
  }
  _handoffEnabled(context) {
    if (!this.onHandoff) return false;
    const enabled = this.handoffEnabled({ ...context, tenantId: context.tenant.id, channelId: context.channel.id, conversationId: context.conversation.id });
    if (enabled?.then) { Promise.resolve(enabled).catch(() => {}); fail(500, 'A configuração de encaminhamento precisa ser síncrona.'); }
    return enabled === true;
  }
  /** The caller authenticates the visitor session; this projection never includes messages or job identities. */
  publicState(tenantId, channelId, conversationId) {
    const idle = { typing: false, state: 'idle', handoffReason: null };
    try {
      const scope = this._scope(tenantId, channelId), tenant = this.store.tenant(this._actor(scope), tenantId);
      const conversation = this.store.getConversation(tenant, conversationId);
      const latest = conversation.messages.filter(message => message.kind === 'customer').at(-1);
      const job = allJobs(tenant).filter(item => item.channelId === channelId && item.conversationId === conversationId && item.messageId === latest?.id).at(-1);
      if (!job) return idle;
      const context = this._context(scope, job, { version: conversation.version, allowPaused: true, checkLatest: false, requireKnowledge: false });
      const marker = context.conversation.supportAssistantHandoff, paused = marker?.active === true && humanTaken(context.conversation, context.config);
      return { typing: live.has(job.state) && !humanTaken(context.conversation, context.config),
        state: paused ? 'handoff' : marker?.active && job.state === 'handoff' ? 'idle' : job.state,
        handoffReason: paused ? marker.reason : null };
    } catch { return idle; }
  }
  // Dispatch/authorization paths call this without a tenant and always read fresh state; drain() passes its own read.
  _notificationContext(scope, job, preread = null) {
    const actor = this._actor(scope, job), tenant = preread ?? this.store.tenant(actor, scope.tenantId), conversation = this.store.getConversation(tenant, job.conversationId);
    if (conversation.supportAssistantHandoff?.active !== true || conversation.supportAssistantHandoff.messageId !== job.messageId) fail(409, 'O encaminhamento de suporte mudou.');
    const context = this._context(scope, job, { version: conversation.version, allowPaused: true, checkLatest: false, requireKnowledge: false, ...(preread ? { tenant: preread } : {}) });
    if (!this._handoffEnabled(context)) fail(403, 'Esta conexão não habilitou a confirmação de encaminhamento.');
    return context;
  }
  authorizeHandoff(input) {
    if (input.signal?.aborted) fail(409, 'A confirmação de encaminhamento foi interrompida.');
    const scope = this._scope(input.tenantId, input.channelId, input.actor?.resellerId);
    const tenant = this.store.tenant(this._actor(scope), scope.tenantId), job = allJobs(tenant).find(item => item.id === input.jobId);
    if (!job || input.actor?.kind !== 'service' || input.actor.userId || input.actor.serviceId || input.actor.supportGrantId
      || input.actor.supportAssistantId !== job.id || input.conversationId !== job.conversationId || input.replyToMessageId !== job.messageId
      || input.agentId !== job.agentId || job.handoffNotification?.state !== 'dispatched'
      || input.idempotencyKey !== job.handoffNotification.idempotencyKey || input.reason !== job.handoffNotification.reason
      || input.version !== job.handoffNotification.version) fail(403, 'Confirmação não pertence ao encaminhamento autorizado.');
    this._notificationContext(scope, job);
    return true;
  }
  async _notifyHandoff(scope, original) {
    if (!this.onHandoff || this.closed || this.handoffActive.has(original.id) || this.handoffActive.size >= this.concurrency) return null;
    const controller = new AbortController(); this.handoffActive.set(original.id, { scope, controller });
    let input, timer, onAbort;
    try {
      const actor = this._actor(scope, original);
      input = this.store.mutate(actor, scope.tenantId, 'Confirmação de encaminhamento preparada', tenant => {
        const job = allJobs(tenant).find(item => item.id === original.id);
        if (!job || job.handoffNotification) return null;
        const context = this._notificationContext(scope, job), reason = context.conversation.supportAssistantHandoff.reason;
        const idempotencyKey = `support_handoff_${hash([scope.tenantId, scope.channelId, job.conversationId, job.messageId])}`;
        job.handoffNotification = { state: 'dispatched', idempotencyKey, reason, version: context.conversation.version, updatedAt: new Date(this.now()).toISOString() };
        return { actor, tenantId: scope.tenantId, channelId: scope.channelId, conversationId: job.conversationId,
          jobId: job.id, agentId: job.agentId, reason, replyToMessageId: job.messageId, version: context.conversation.version, idempotencyKey, signal: controller.signal };
      });
      if (!input) return null;
      const fresh = () => this.authorizeHandoff(input); input.authorize = fresh; input.reauthorize = fresh;
      const interrupted = new Promise((_, reject) => { onAbort = () => reject(new Error('handoff_interrupted')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let state = 'unknown', notified;
      try {
        fresh();
        const receipt = await Promise.race([Promise.resolve().then(() => { fresh(); return this.onHandoff(input); }), interrupted]);
        if (receipt?.confirmed === true) state = 'confirmed';
        else if (receipt?.skipped === true) state = 'skipped';
        if (typeof receipt?.metadata?.notified === 'boolean') notified = receipt.metadata.notified;
      } catch { /* A dispatched callback is never replayed after an ambiguous response. */ }
      this.store.mutate(actor, scope.tenantId, 'Recibo de confirmação de encaminhamento preservado', tenant => {
        const job = allJobs(tenant).find(item => item.id === original.id);
        // Receipt reconciliation cannot authorize another dispatch, even if access changed during the callback.
        if (job?.handoffNotification?.state === 'dispatched' && job.handoffNotification.idempotencyKey === input.idempotencyKey) {
          Object.assign(job.handoffNotification, { state, updatedAt: new Date(this.now()).toISOString(), ...(notified === undefined ? {} : { notified }) });
        }
      });
      return { state };
    } catch { return null; }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); this.handoffActive.delete(original.id); }
  }
  _measure(job, name, fn) {
    const began = this.now();
    const done = () => { job.timingsMs ??= {}; job.timingsMs[name] = (job.timingsMs[name] || 0) + Math.max(0, this.now() - began); };
    try { const result = fn(); if (result?.then) return Promise.resolve(result).finally(done); done(); return result; }
    catch (error) { done(); throw error; }
  }
  _timings(scope, job) {
    job.timingsMs ??= {}; job.timingsMs.total = Math.max(0, this.now() - Date.parse(job.createdAt));
    this.store.mutate(this._actor(scope, job), scope.tenantId, 'Tempos de suporte registrados', tenant => {
      const current = (tenant.supportAssistantJobs || []).find(item => item.id === job.id);
      if (current && (!job.executionId || current.executionId === job.executionId)) current.timingsMs = safeTimings(job);
    });
  }
  receive(entry, conversationId, messageId) {
    if (this.closed) return null;
    const scope = this.scopes.find(item => item.tenantId === entry?.tenantId && item.channelId === entry?.channelId && item.resellerId === entry?.actor?.resellerId);
    if (!scope || !id(conversationId) || !id(messageId)) return null;
    const actor = this._actor(scope), tenant = this.store.tenant(actor, scope.tenantId), channel = tenant.channels.find(item => item.id === scope.channelId), config = channel?.supportAssistant;
    if (!config?.enabled) return null;
    const jobId = `support_${hash([scope.tenantId, scope.channelId, conversationId, messageId])}`;
    const existing = (tenant.supportAssistantJobs || []).find(item => item.id === jobId);
    if (existing) return summary(existing);
    const conversation = this.store.getConversation(tenant, conversationId), date = new Date(this.now()).toISOString(), agent = this._agent(tenant, config.agentId, { requireKnowledge: false });
    const job = { id: jobId, runId: jobId, idempotencyKey: jobId, tenantId: scope.tenantId, channelId: scope.channelId,
      conversationId, messageId, conversationVersion: conversation.version, configurationVersion: config.version,
      webchatRevision: channel.webchat?.version, agentId: config.agentId, agentConfigHash: agentHash(agent), supportInstructionsHash: hash(supportInstructions(channel)), scopeHash: scope.hash, state: 'pending', createdAt: date, updatedAt: date };
    const context = this._context(scope, job, { allowPaused: true, checkLatest: false, requireKnowledge: false });
    const handoffEnabled = this._handoffEnabled(context);
    if (!handoffEnabled) this._agent(tenant, config.agentId);
    const humanRequested = requestsHumanSupport(context.message.text), paused = humanTaken(context.conversation, context.config);
    this.store.mutate(context.actor, scope.tenantId, 'Mensagem registrada na fila de suporte próprio', current => {
      this._context(scope, job, { allowPaused: true, checkLatest: false, requireKnowledge: !handoffEnabled });
      current.supportAssistantJobs ??= [];
      if (current.supportAssistantJobs.some(item => item.id === jobId)) return;
      if (current.supportAssistantJobs.length >= this.maxJobsPerTenant) {
        if (!handoffEnabled) fail(429, 'Limite de recibos do suporte atingido; a mensagem recebida foi preservada.');
        job.state = 'handoff'; job.reason = 'limit_reached';
        this._handoff(current, context.actor, conversationId, messageId, job.reason);
        const marker = this.store.getConversation(current, conversationId).supportAssistantHandoff;
        if (marker.messageId === messageId) marker.overflowJob = job;
        return;
      }
      if (humanRequested || paused) { job.state = 'handoff'; job.reason = humanRequested ? 'visitor_requested_human' : 'human_in_charge'; }
      current.supportAssistantJobs.push(job);
      if (humanRequested) this._handoff(current, context.actor, conversationId, messageId, 'visitor_requested_human');
    });
    if (humanRequested || job.reason === 'limit_reached') this._abortConversation(scope.tenantId, conversationId);
    return summary(job);
  }
  _handoff(tenant, actor, conversationId, messageId, reason) {
    const conversation = this.store.getConversation(tenant, conversationId), date = new Date(this.now()).toISOString();
    // One active handoff is one notification episode. Preserve the gateway's acknowledgement and original message.
    const channel = tenant.channels.find(item => item.id === conversation.channelId);
    // A ticket is not a transfer: only an agent's explicit request can keep the assistant attending.
    // Visitor requests, media/runtime failures and a human taking over still stop all automation.
    const pauseAutomation = reason !== 'agent_requested_human' || channel?.supportAssistant?.handoffMode !== 'continue';
    const previous = conversation.supportAssistantHandoff;
    if (previous?.active !== true || previous.pauseAutomation === false && pauseAutomation) conversation.supportAssistantHandoff = { active: true, reason, messageId, requestedAt: date, pauseAutomation };
    if (conversation.owner === 'agent' && !conversation.assignedUserId && this.operations?.applyAssignment) this.operations.applyAssignment(conversation, actor, { owner: 'queue', reason: 'Atendimento humano solicitado.', origin: 'support-assistant' });
    else { if (conversation.owner === 'agent' && !conversation.assignedUserId) { conversation.owner = 'queue'; conversation.agentId = null; }
      conversation.version++; conversation.updatedAt = date; }
    for (const job of tenant.supportAssistantJobs || []) if (job.conversationId === conversationId && live.has(job.state)) {
      job.state = job.state === 'sending' ? 'unknown' : 'handoff'; job.reason = reason; job.updatedAt = date;
    }
  }
  runCurrent(run) {
    try {
      const scope = this._scope(run.tenantId, run.channelIdAtStart), actor = this._actor(scope);
      const job = (this.store.tenant(actor, scope.tenantId).supportAssistantJobs || []).find(item => item.runId === run.id);
      if (!job || !['running', 'sending', 'draft'].includes(job.state) || run.actorUserId || run.serviceId || run.supportGrantId
        || run.agentId !== job.agentId || run.conversationId !== job.conversationId || run.conversationVersion !== job.conversationVersion) return false;
      this._context(scope, job);
      return true;
    } catch { return false; }
  }
  authorizeSend(input) {
    const scope = this._scope(input.tenantId, input.channelId, input.actor?.resellerId), actor = this._actor(scope);
    const job = (this.store.tenant(actor, scope.tenantId).supportAssistantJobs || []).find(item => item.id === input.jobId || item.idempotencyKey === input.idempotencyKey);
    if (!job || job.state !== 'sending' || input.actor?.kind !== 'service' || input.actor.userId || input.actor.serviceId || input.actor.supportGrantId
      || input.actor.supportAssistantId !== job.id || input.conversationId !== job.conversationId || input.replyToMessageId !== job.messageId
      || input.version !== job.conversationVersion || input.idempotencyKey !== job.idempotencyKey || input.agentId !== job.agentId) fail(403, 'Envio não pertence à execução de suporte autorizada.');
    const context = this._context(scope, job), run = (context.tenant.runs || []).find(item => item.id === job.runId);
    if (context.config.autoReply !== true || !run || run.state !== 'draft' || run.draft !== input.text || !this.runCurrent(run)
      || !this.knowledge.current(context.tenant, run) || !this.ownKnowledge(context.agent) && (run.knowledgeState !== 'matched' || !run.knowledgeReferences?.length)) fail(409, 'A resposta perdeu sua autorização de suporte.');
    if (untrustedContact(run.draft, trustedContacts(context, run)) !== null) fail(409, 'A resposta contém contato não autorizado para este suporte.');
    return true;
  }
  _abortConversation(tenantId, conversationId) {
    for (const task of this.active.values()) if (task.scope.tenantId === tenantId && task.job.conversationId === conversationId) {
      task.controller.abort();
      try { this.runtime.cancel(task.actor, tenantId, task.job.runId); } catch { /* A run may not have been accepted yet. */ }
    }
  }
  _abortChannel(tenantId, channelId) {
    for (const task of this.active.values()) if (task.scope.tenantId === tenantId && task.scope.channelId === channelId) this._abortConversation(tenantId, task.job.conversationId);
    for (const task of this.handoffActive.values()) if (task.scope.tenantId === tenantId && task.scope.channelId === channelId) task.controller.abort();
  }
  _fallback(scope, job, reason, attemptedSend = false) {
    try {
      const context = this._context(scope, job, { requireKnowledge: false });
      if (!this._handoffEnabled(context)) return null;
      return this.store.mutate(context.actor, scope.tenantId, 'Suporte indisponível encaminhado à equipe humana', tenant => {
        const fresh = this._context(scope, job, { requireKnowledge: false });
        if (!this._handoffEnabled(fresh)) return null;
        const current = (tenant.supportAssistantJobs || []).find(item => item.id === job.id);
        if (!current || !live.has(current.state) || current.executionId !== job.executionId) return null;
        this._handoff(tenant, fresh.actor, job.conversationId, job.messageId, reason);
        current.state = attemptedSend ? 'unknown' : 'handoff'; current.reason = reason;
        current.updatedAt = new Date(this.now()).toISOString(); delete current.leaseUntil;
        return summary(current);
      });
    } catch { return null; }
  }
  _finish(scope, job, state, reason = null) {
    return this.store.mutate(this._actor(scope, job), scope.tenantId, 'Execução de suporte próprio finalizada', tenant => {
      const current = (tenant.supportAssistantJobs || []).find(item => item.id === job.id);
      if (!current || current.executionId !== job.executionId || !['running', 'sending'].includes(current.state)) return current ? summary(current) : null;
      if (state === 'handoff') this._handoff(tenant, this._actor(scope, job), job.conversationId, job.messageId, reason || 'draft_needs_human');
      current.state = state; current.reason = reason; current.updatedAt = new Date(this.now()).toISOString(); delete current.leaseUntil;
      return summary(current);
    });
  }
  /** Returns true when it may have written, so the caller re-reads the tenant it passed in. */
  _recover(scope, preread = null) {
    const actor = this._actor(scope), jobs = (preread ?? this.store.tenant(actor, scope.tenantId)).supportAssistantJobs || [];
    let changed = false;
    for (const job of jobs) if (job.channelId === scope.channelId && ['running', 'sending'].includes(job.state) && job.leaseUntil <= this.now() && !this.active.has(job.id)) { changed = true; this._fallback(scope, job, 'preparation_interrupted', job.state === 'sending'); }
    if (!jobs.some(job => job.channelId === scope.channelId && ['running', 'sending'].includes(job.state) && job.leaseUntil <= this.now() && !this.active.has(job.id))) return changed;
    this.store.mutate(actor, scope.tenantId, 'Execuções interrompidas do suporte reconciliadas', tenant => {
      for (const job of tenant.supportAssistantJobs || []) if (job.channelId === scope.channelId && ['running', 'sending'].includes(job.state) && job.leaseUntil <= this.now() && !this.active.has(job.id)) {
        job.state = job.state === 'sending' ? 'unknown' : 'failed'; job.reason = 'interrupted'; job.updatedAt = new Date(this.now()).toISOString(); delete job.leaseUntil;
      }
    });
    return true;
  }
  // Fingerprint of every tenant field the notification precheck reads (job, channel, agent, conversation header and message).
  _notificationSignature(scope, job, tenant, conversation) {
    const channel = (tenant.channels || []).find(item => item.id === scope.channelId) ?? null;
    const agent = (tenant.agents || []).find(item => item.id === channel?.supportAssistant?.agentId) ?? null;
    const { messages = [], ...header } = conversation;
    return hash([scope.hash, job, channel, agent, header, messages.length, messages.find(item => item.id === job.messageId) ?? null]);
  }
  _notificationFailed(jobId, signature) {
    this.notificationFailures.delete(jobId); this.notificationFailures.set(jobId, { signature, at: this.now() });
    while (this.notificationFailures.size > NOTIFICATION_FAILURES_MAX) this.notificationFailures.delete(this.notificationFailures.keys().next().value);
  }
  async drain() {
    if (this.closed) return [];
    const pending = [], notifications = [], conversations = new Set([...this.active.values()].map(task => JSON.stringify([task.scope.tenantId, task.job.conversationId])));
    for (const scope of this.scopes) {
      try {
        // One tenant read per scope; re-read only when recovery may have written.
        const actor = this._actor(scope); let tenant = this.store.tenant(actor, scope.tenantId);
        if (this._recover(scope, tenant)) tenant = this.store.tenant(actor, scope.tenantId);
        if (this.onHandoff) for (const job of allJobs(tenant)) if (job.channelId === scope.channelId && !job.handoffNotification
          && !this.handoffActive.has(job.id) && notifications.length + this.handoffActive.size < this.concurrency
          && tenant.conversations.some(conversation => conversation.id === job.conversationId && conversation.supportAssistantHandoff?.active === true && conversation.supportAssistantHandoff.messageId === job.messageId)) {
          // An expired/revoked episode cannot reserve every slot ahead of a current visitor, nor be re-checked every tick.
          const signature = this._notificationSignature(scope, job, tenant, this.store.getConversation(tenant, job.conversationId)), failure = this.notificationFailures.get(job.id);
          if (failure?.signature === signature && this.now() - failure.at < NOTIFICATION_RETRY_MS) continue;
          try { this._notificationContext(scope, job, tenant); } catch { this._notificationFailed(job.id, signature); continue; }
          this.notificationFailures.delete(job.id);
          notifications.push({ scope, job });
        }
        for (const job of tenant.supportAssistantJobs || []) if (job.channelId === scope.channelId && job.state === 'pending'
          && pending.length + this.active.size < this.concurrency && !conversations.has(JSON.stringify([scope.tenantId, job.conversationId]))) {
          conversations.add(JSON.stringify([scope.tenantId, job.conversationId])); pending.push({ scope, job });
        }
      } catch { /* An absent/revoked own connection cannot cause a send. */ }
    }
    return Promise.all([...pending.map(({ scope, job }) => this._process(scope, job)), ...notifications.map(({ scope, job }) => this._notifyHandoff(scope, job))].map(task => {
      this.pendingTasks.add(task);
      task.then(() => this.pendingTasks.delete(task), () => this.pendingTasks.delete(task)); return task;
    }));
  }
  async _process(scope, original) {
    if (this.active.has(original.id) || this.closed) return null;
    const job = structuredClone(original), actor = this._actor(scope, job), controller = new AbortController();
    const task = { scope, job, actor, controller }; this.active.set(job.id, task);
    let timer, onAbort, attemptedSend = false, timedOut = false;
    job.timingsMs = { queue: Math.max(0, this.now() - Date.parse(job.createdAt)) };
    const signal = controller.signal;
    const interrupted = new Promise((_, reject) => { onAbort = () => reject(new Error('support_interrupted')); signal.addEventListener('abort', onAbort, { once: true }); });
    try {
      const context = this._measure(job, 'precheck', () => this._context(scope, job, { requireKnowledge: false }));
      if (!this._handoffEnabled(context)) this._agent(context.tenant, job.agentId);
      const query = customerQuery(context.message.text);
      let references;
      try { references = this._measure(job, 'knowledge', () => this.knowledge.search(context.tenant, context.agent, query, { generic: [...scope.products] })); }
      catch (error) { const fallback = this._fallback(scope, job, 'knowledge_unavailable'); if (fallback) return fallback; throw error; }
      const own = this.ownKnowledge(context.agent), attachments = context.message.attachments || [], images = agentImageAttachments(context.message);
      const mediaNeedsHuman = attachments.length > 0 && !(this.imageInput(context.agent) && images.length === attachments.length && images.length <= AGENT_IMAGE_MAX_COUNT);
      if (!own && (references.state !== 'matched' || !references.references.length) || mediaNeedsHuman) {
        this.store.mutate(actor, scope.tenantId, 'Suporte encaminhado à equipe humana', tenant => {
          this._context(scope, job, { requireKnowledge: false }); this._handoff(tenant, actor, job.conversationId, job.messageId, mediaNeedsHuman ? 'media_needs_human' : 'knowledge_unavailable');
        });
        return summary({ ...job, state: 'handoff', reason: mediaNeedsHuman ? 'media_needs_human' : 'knowledge_unavailable' });
      }
      const claimed = this.store.mutate(actor, scope.tenantId, 'Preparação de suporte próprio iniciada', tenant => {
        this._context(scope, job);
        const current = (tenant.supportAssistantJobs || []).find(item => item.id === job.id);
        if (current?.state !== 'pending') return false;
        job.executionId = randomUUID(); job.state = 'running'; job.leaseUntil = this.now() + this.timeoutMs + 1000;
        job.updatedAt = new Date(this.now()).toISOString(); Object.assign(current, job); return true;
      });
      if (!claimed) return null;
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      const check = () => { if (signal.aborted) fail(409, 'A execução de suporte foi interrompida.'); this._context(scope, job); return true; };
      const run = await this._measure(job, 'runtime', () => Promise.race([this.runtime.start(actor, scope.tenantId, job.conversationId, {
        runId: job.runId, idempotencyKey: job.idempotencyKey, agentId: job.agentId, version: job.conversationVersion,
        instruction: `Prepare uma resposta curta de suporte para ${scope.products.join(', ')}. Use somente fatos das fontes publicadas autorizadas e do perfil dedicado autorizado. Não invente preços, permissões ou disponibilidade. Não prometa chamar uma pessoa pelo nome, nem que alguém responderá agora. Se faltar confirmação, delimite o que sabe e peça somente a informação útil para o suporte. Abrir chamado não significa abandonar o atendimento. Nunca afirme que um e-mail foi enviado ou um chamado aberto sem recibo do sistema.`
      }, { authorize: check, responseLanguage: 'match_customer', supportInstructions: supportInstructions(context.channel), knowledge: { query, generic: [...scope.products] } }), interrupted]));
      check();
      const current = this._context(scope, job), persisted = (current.tenant.runs || []).find(item => item.id === job.runId);
      if (run.state === 'failed') {
        const fallback = this._fallback(scope, job, 'preparation_failed');
        if (fallback) return fallback;
      }
      // The run ranks with the same customer-only query as the precheck; the draft must still have seen a passage the precheck found.
      const grounded = new Set(references.references.map(referenceKey));
      if (run.state !== 'draft' || !run.draft || !persisted || !this.knowledge.current(current.tenant, persisted)
        || !own && (persisted.knowledgeState !== 'matched' || !persisted.knowledgeReferences?.some(reference => grounded.has(referenceKey(reference))))) return this._finish(scope, job, 'handoff', 'draft_needs_human');
      if (run.draft.length > 4000 || Buffer.byteLength(run.draft) > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(run.draft)) return this._finish(scope, job, 'handoff', 'invalid_draft');
      if (untrustedContact(run.draft, trustedContacts(current, persisted)) !== null) return this._finish(scope, job, 'handoff', 'invalid_draft');
      if (current.config.autoReply !== true) return this._finish(scope, job, 'draft');
      if (!this.sendReply) return this._finish(scope, job, 'handoff', 'sender_unavailable');
      const input = { actor, tenantId: scope.tenantId, conversationId: job.conversationId, channelId: scope.channelId,
        version: job.conversationVersion, text: run.draft, idempotencyKey: job.idempotencyKey, replyToMessageId: job.messageId,
        agentId: job.agentId, jobId: job.id, signal };
      const fresh = () => { check(); return this.authorizeSend(input); };
      input.authorize = fresh; input.reauthorize = fresh;
      const sending = this.store.mutate(actor, scope.tenantId, 'Resposta do suporte preparada para envio interno', tenant => {
        check();
        const currentJob = (tenant.supportAssistantJobs || []).find(item => item.id === job.id);
        if (currentJob?.state !== 'running' || currentJob.executionId !== job.executionId) return false;
        currentJob.state = 'sending'; currentJob.updatedAt = new Date(this.now()).toISOString(); return true;
      });
      if (!sending) return null;
      fresh(); attemptedSend = true;
      const receipt = await this._measure(job, 'send', () => Promise.race([Promise.resolve().then(() => { fresh(); return this.sendReply(input); }), interrupted]));
      if (receipt?.confirmed !== true) return this._fallback(scope, job, 'send_unconfirmed', true) || this._finish(scope, job, 'unknown', 'send_unconfirmed');
      // The agent answered and asked for a person in the same turn: the answer is out, the team takes over.
      if (persisted.handoffRequest) return this._finish(scope, job, 'handoff', 'agent_requested_human');
      return this._finish(scope, job, 'completed');
    } catch (error) {
      const fallback = this._fallback(scope, job, attemptedSend ? 'send_unconfirmed' : failureReason(error, timedOut), attemptedSend);
      if (fallback) return fallback;
      if (job.executionId) return this._finish(scope, job, attemptedSend ? 'unknown' : 'failed', attemptedSend ? 'send_unconfirmed' : 'preparation_interrupted');
      return this.store.mutate(actor, scope.tenantId, 'Preparação obsoleta de suporte preservada', tenant => {
        const current = (tenant.supportAssistantJobs || []).find(item => item.id === job.id);
        if (current?.state === 'pending') { current.state = humanTaken(this.store.getConversation(tenant, job.conversationId)) ? 'handoff' : 'skipped'; current.reason = 'context_changed'; current.updatedAt = new Date(this.now()).toISOString(); }
        return current ? summary(current) : null;
      });
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.active.delete(job.id);
      if (signal.aborted) { try { this.runtime.cancel(actor, scope.tenantId, job.runId); } catch { /* Preserve interrupted state without retry. */ } }
      try { this._timings(scope, job); } catch { /* Timing metadata cannot change the preparation outcome. */ }
      await this._notifyHandoff(scope, job);
    }
  }
  close() {
    this.closed = true; this.notificationFailures.clear();
    for (const task of this.active.values()) {
      task.controller.abort();
      try { this.runtime.cancel(task.actor, task.scope.tenantId, task.job.runId); } catch { /* The durable job still prevents a second dispatch. */ }
    }
    for (const task of this.handoffActive.values()) task.controller.abort();
    return Promise.allSettled(this.pendingTasks);
  }
}
