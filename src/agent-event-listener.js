import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serviceResponsePolicy } from './service-response-policy.js';

const EVENT_TYPES = ['conversation.created', 'conversation.message', 'conversation.updated', 'conversation.removed'];
// These are metadata bounds, not model/receiver concurrency or throughput guarantees.
const MAX_PENDING = 10000, MAX_COMPLETED = 20000, MAX_STATE_BYTES = 32 * 1048576;
const INBOX_LIMIT = 50, MAX_INBOX_PAGES = 2000, MAX_INBOX_IDS = 100000, INBOX_TTL_MS = 120000, WORK_BATCH = 50;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const messageId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const cursorOk = value => typeof value === 'string' && /^[0-9a-f]{12}-[0-9a-z]{1,11}\.[A-Za-z0-9_-]{32}$/.test(value);
const inboxCursorOk = value => typeof value === 'string' && value.length > 0 && value.length <= 2400 && !/[\x00-\x20\x7f]/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setOwn = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });

/** Errors/logs contain only local codes, never remote bodies, URLs, tokens or provider exceptions. */
export class AgentEventListenerError extends Error {
  constructor(code, { status = 0, retryAfterMs = 0, fatal = true } = {}) {
    super(code); this.name = 'AgentEventListenerError'; this.code = code;
    this.status = status; this.retryAfterMs = retryAfterMs; this.fatal = fatal;
  }
}
const failure = (code, options) => new AgentEventListenerError(code, options);
const keys = (value, allowed) => plain(value) && Reflect.ownKeys(value).every(key => allowed.includes(key));
function privatePath(path) {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)
    || /^(?:\\\\|\/\/)/.test(path) || path.split(/[\\/]/).includes('..') || !path.endsWith('.json')
    || path.slice(/^[A-Za-z]:/.test(path) ? 2 : 0).includes(':')) throw failure('CONFIG_PATH_INVALID');
  return resolve(path);
}
function endpointUrl(value, { allowLoopback = false, service = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw failure('CONFIG_ENDPOINT_INVALID');
  let url; try { url = new URL(value); } catch { throw failure('CONFIG_ENDPOINT_INVALID'); }
  const literalLoopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  const localName = /(?:^|\.)localhost\.?$/i.test(url.hostname) || /\.local\.?$/i.test(url.hostname);
  const alternateLoopback = /^127\./.test(url.hostname) && !literalLoopback || url.hostname.startsWith('[::ffff:');
  // Loopback must be operator-explicit and literal: no localhost DNS, redirects or auto-discovered endpoints.
  if (localName || alternateLoopback || literalLoopback && !allowLoopback || !['https:', 'http:'].includes(url.protocol)
    || url.protocol === 'http:' && (!literalLoopback || !allowLoopback) || url.username || url.password || url.search || url.hash
    || value !== url.href || service && url.pathname !== '/api/service/v1') throw failure('CONFIG_ENDPOINT_INVALID');
  return value;
}

/** Private operator configuration. No secrets or arbitrary headers/commands can be supplied here or by events. */
export function validateAgentEventConfig(value) {
  if (!keys(value, ['endpoint', 'tokenEnv', 'checkpointPath', 'allowLoopback', 'activation'])
    || !keys(value.activation, ['url', 'secretEnv', 'allowLoopback', 'timeoutMs'])
    || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value.tokenEnv ?? '')
    || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value.activation.secretEnv ?? '')
    || value.tokenEnv === value.activation.secretEnv
    || value.allowLoopback !== undefined && typeof value.allowLoopback !== 'boolean'
    || value.activation.allowLoopback !== undefined && typeof value.activation.allowLoopback !== 'boolean') throw failure('CONFIG_INVALID');
  const timeoutMs = value.activation.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) throw failure('CONFIG_INVALID');
  return Object.freeze({ endpoint: endpointUrl(value.endpoint, { allowLoopback: value.allowLoopback === true, service: true }),
    tokenEnv: value.tokenEnv, checkpointPath: privatePath(value.checkpointPath), allowLoopback: value.allowLoopback === true,
    activation: Object.freeze({ url: endpointUrl(value.activation.url, { allowLoopback: value.activation.allowLoopback === true }),
      secretEnv: value.activation.secretEnv, allowLoopback: value.activation.allowLoopback === true, timeoutMs }) });
}
async function boundedFile(path, max, { optional = false, privateMode = false } = {}) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max || privateMode && process.platform !== 'win32' && (info.mode & 0o077)) throw failure('PRIVATE_FILE_INVALID');
    const data = await readFile(path);
    if (data.length > max) throw failure('PRIVATE_FILE_INVALID');
    return JSON.parse(data.toString('utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw failure('PRIVATE_FILE_INVALID');
  }
}
export async function loadAgentEventConfig(path) {
  return validateAgentEventConfig(await boundedFile(privatePath(path), 16384, { privateMode: true }));
}
function retryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) return 0;
  // Never shorten a provider's long Retry-After and then retry early.
  if (delay > 300000) throw failure('RETRY_AFTER_OUT_OF_BOUNDS');
  return Math.ceil(delay);
}
async function boundedJson(response, max) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel().catch(() => {}); throw failure('RESPONSE_INVALID'); }
  const reader = response.body?.getReader();
  if (!reader) throw failure('RESPONSE_INVALID');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw failure('RESPONSE_INVALID'); chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!plain(data)) throw failure('RESPONSE_INVALID');
    return data;
  } catch { await reader.cancel().catch(() => {}); throw failure('RESPONSE_INVALID'); }
  finally { reader.releaseLock(); }
}
async function requestJson(fetchImpl, url, init, timeoutMs, signal, max, prefix) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    if (!response.ok) {
      const status = response.status, delay = retryAfter(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => {});
      throw failure(`${prefix}_HTTP_${status}`, { status, retryAfterMs: delay, fatal: status < 500 && status !== 429 });
    }
    return await boundedJson(response, max);
  } catch (error) {
    if (error instanceof AgentEventListenerError) throw error;
    if (signal?.aborted) throw failure('STOPPED');
    throw failure(`${prefix}_UNCONFIRMED`, { fatal: false });
  } finally { clearTimeout(timer); }
}

/** REST read-only client: exact allowlist; intentionally no claim, send, draft or model method. */
export function createAgentEventService(config, { env = process.env, fetchImpl = fetch } = {}) {
  config = validateAgentEventConfig(config);
  const token = env[config.tokenEnv];
  if (typeof token !== 'string' || !/^elozi_svc_[A-Za-z0-9_-]{43}$/.test(token)) throw failure('CREDENTIAL_UNAVAILABLE');
  const call = (route, body, signal, timeoutMs = 10000) => {
    if (!['/me', '/company', '/inbox', '/events/wait'].includes(route) && !/^\/(conversations|receipts)\/[A-Za-z0-9_-]{1,120}$/.test(route)) throw failure('REQUEST_INVALID');
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    else if (route !== '/me') headers['X-Elozi-Request-Id'] = 'listen_' + randomUUID().replaceAll('-', '');
    return requestJson(fetchImpl, config.endpoint + route, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, timeoutMs, signal, 2097152, 'SERVICE');
  };
  return Object.freeze({
    me: signal => call('/me', undefined, signal), company: signal => call('/company', undefined, signal),
    inbox: (signal, cursor) => {
      if (cursor !== undefined && !inboxCursorOk(cursor)) throw failure('REQUEST_INVALID');
      return call('/inbox', { requestId: 'listen_' + randomUUID().replaceAll('-', ''), status: 'all', limit: INBOX_LIMIT, ...(cursor === undefined ? {} : { cursor }) }, signal);
    },
    wait: (cursor, signal) => call('/events/wait', { timeoutMs: 20000, ...(cursor ? { cursor } : {}) }, signal, 30000),
    read: (conversationId, signal) => { if (!id(conversationId)) throw failure('REQUEST_INVALID'); return call('/conversations/' + conversationId, undefined, signal); },
    readReceipt: (receiptId, signal) => { if (!id(receiptId)) throw failure('REQUEST_INVALID'); return call('/receipts/' + receiptId, undefined, signal); }
  });
}

/**
 * Receiver contract: verify HMAC over timestamp + '.' + Idempotency-Key + '.' + raw JSON bytes; enforce freshness;
 * durably deduplicate by Idempotency-Key BEFORE invoking its agent and acknowledge duplicates with the same key.
 * Compatibility: X-Hub-Signature-256 signs the exact body; X-Webhook-Id is the same stable key;
 * X-Webhook-Event equals body.type ('elozi.agent.wakeup'). No native client activation is assumed or configured.
 * Reply {accepted:true,idempotencyKey:<key>}. Timeout is UNCERTAIN, so retries keep that key, never create a new run.
 * Re-read Elozi identity/scope/owner/version again before using the wakeup. Metadata is a hint, NOT action authority.
 * All downstream MCP actions retain their original requestId and reconcile elozi_get_receipt; this adapter never sends.
 */
export function createSignedActivation(config, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  config = validateAgentEventConfig(config);
  const secret = env[config.activation.secretEnv];
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || /[\x00-\x1f\x7f]/.test(secret) || secret === env[config.tokenEnv]) throw failure('SIGNING_CREDENTIAL_UNAVAILABLE');
  const secrets = [secret, env[config.tokenEnv]].filter(Boolean), target = config.activation.url;
  return async (metadata, key, { signal } = {}) => {
    if (!keys(metadata, ['schemaVersion', 'type', 'principalId', 'workspaceId', 'tenantId', 'agentId', 'conversationId', 'customerMessageId', 'version', 'channelId', 'departmentId'])
      || metadata.schemaVersion !== 1 || metadata.type !== 'elozi.agent.wakeup' || !/^wake_[a-f0-9]{64}$/.test(key)
      || ['principalId', 'workspaceId', 'tenantId', 'agentId', 'conversationId', 'channelId'].some(field => !id(metadata[field]))
      || !messageId(metadata.customerMessageId) || !positive(metadata.version) || metadata.departmentId !== null && !id(metadata.departmentId)) throw failure('ACTIVATION_METADATA_INVALID');
    const body = JSON.stringify(metadata), timestamp = String(Math.floor(now() / 1000));
    if (Buffer.byteLength(body) > 4096 || secrets.some(secretValue => body.includes(secretValue))) throw failure('ACTIVATION_METADATA_INVALID');
    const signature = createHmac('sha256', secret).update(timestamp + '.' + key + '.' + body).digest('hex');
    const ack = await requestJson(fetchImpl, target, { method: 'POST', body, headers: { 'Content-Type': 'application/json',
      'Idempotency-Key': key, 'X-Webhook-Id': key, 'X-Webhook-Event': metadata.type,
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
      'X-Elozi-Timestamp': timestamp, 'X-Elozi-Signature': 'sha256=' + signature } }, config.activation.timeoutMs, signal, 4096, 'ACTIVATION');
    if (!keys(ack, ['accepted', 'idempotencyKey']) || ack.accepted !== true || ack.idempotencyKey !== key) throw failure('ACTIVATION_UNCONFIRMED', { fatal: false });
    return { accepted: true, idempotencyKey: key };
  };
}

export function stableWakeupKey(identity, conversationId, customerMessageId) {
  if (!id(conversationId) || !messageId(customerMessageId)) throw failure('RESPONSE_INVALID');
  return 'wake_' + digest(JSON.stringify([identity.workspaceId, identity.principalId, identity.tenantId, identity.agentId, identity.revision, identity.keyRevision, conversationId, customerMessageId]));
}
function projectIdentity(me, company) {
  if (me?.apiVersion !== undefined && ![1, 2].includes(me.apiVersion)) throw failure('IDENTITY_UNAUTHORIZED');
  const p = me?.principal;
  if (!plain(p) || ['id', 'workspaceId', 'tenantId', 'agentId'].some(field => !id(p[field])) || !positive(p.revision) || !positive(p.keyRevision)
    || !Array.isArray(p.capabilities) || p.capabilities.length > 20 || !['conversation.read', 'events.read'].every(cap => p.capabilities.includes(cap))) throw failure('IDENTITY_UNAUTHORIZED');
  if (p.active !== true || p.state !== 'active') throw failure('IDENTITY_REVOKED');
  const scope = value => value === null ? null : Array.isArray(value) && value.length <= 100 && value.every(id) ? [...new Set(value)].sort() : undefined;
  const channelIds = scope(p.channelIds), departmentIds = scope(p.departmentIds);
  const agent = company?.agents?.find(item => item.id === p.agentId);
  if (me.apiVersion === 2) {
    // Effective mode is descriptive, never a substitute for adapter/grants/scope.
    // v2 must supply its own explicit adapter; never fall back to company mode.
    const cp = p.conversationPolicy;
    if (cp !== undefined && (!plain(cp) || typeof cp.allowGroups !== 'boolean'
      || !Array.isArray(cp.excludedChannelIds) || cp.excludedChannelIds.length > 100 || !cp.excludedChannelIds.every(id)
      || cp.customerMessagesAfter !== null && (typeof cp.customerMessagesAfter !== 'string'
        || !Number.isFinite(Date.parse(cp.customerMessagesAfter))))) throw failure('IDENTITY_UNAUTHORIZED');
    if (!plain(me.agent) || me.agent !== agent || agent.adapterMode !== 'copilot'
      || !plain(me.responsePolicy) || !isDeepStrictEqual(me.responsePolicy, serviceResponsePolicy(p, agent))
      || agent.mode !== me.responsePolicy.effectiveMode
      || me.humanApprovalRequired !== me.responsePolicy.requiresHumanConversationAuthorization) throw failure('IDENTITY_UNAUTHORIZED');
  }
  if (channelIds === undefined || departmentIds === undefined || company?.company?.id !== p.tenantId || !agent
    || agent.provider !== 'mcp' || (me.apiVersion === 2 ? agent.adapterMode : agent.mode) !== 'copilot'
    || agent.configured !== true || !positive(agent.version)) throw failure('IDENTITY_UNAUTHORIZED');
  return { principalId: p.id, workspaceId: p.workspaceId, tenantId: p.tenantId, agentId: p.agentId, revision: p.revision, keyRevision: p.keyRevision,
    channelIds, departmentIds, capabilities: [...new Set(p.capabilities)].sort(), agentVersion: agent.version };
}
function pendingProjection(conversation, identity, expectedId) {
  if (!plain(conversation) || conversation.id !== expectedId || !positive(conversation.version) || !id(conversation.channelId)
    || conversation.departmentId !== null && conversation.departmentId !== undefined && !id(conversation.departmentId)
    || !Array.isArray(conversation.messages) || conversation.messages.length > 100) throw failure('RESPONSE_INVALID');
  const departmentId = conversation.departmentId ?? null;
  if (conversation.owner !== 'agent' || conversation.agentId !== identity.agentId || !['open', 'pending'].includes(conversation.status)
    || identity.channelIds !== null && !identity.channelIds.includes(conversation.channelId)
    || identity.departmentIds !== null && !identity.departmentIds.includes(departmentId ?? 'unassigned')) return null;
  // A vote in the agent's WhatsApp poll (kind poll_vote) is the contact's entry too.
  const latest = conversation.messages.filter(message => ['customer', 'poll_vote', 'human', 'agent'].includes(message?.kind)).at(-1);
  if (!['customer', 'poll_vote'].includes(latest?.kind)) return null;
  if (!messageId(latest.id)) throw failure('RESPONSE_INVALID');
  return { conversationId: conversation.id, customerMessageId: latest.id, version: conversation.version, channelId: conversation.channelId, departmentId,
    key: stableWakeupKey(identity, conversation.id, latest.id) };
}
const pause = (ms, signal) => new Promise((resolvePromise, reject) => {
  if (signal?.aborted) { reject(failure('STOPPED')); return; }
  const onAbort = () => { clearTimeout(timer); reject(failure('STOPPED')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** One opt-in local consumer, durable metadata only. No second server queue, auto-claim, reply or model invocation. */
export class AgentEventListener {
  #config; #service; #activate; #now; #sleep; #minPollMs; #state; #lock; #closed = false; #busy = false; #secrets; #binding;
  #stop = new AbortController(); #waiter = null; #cycleDone = null;
  constructor(config, { env = process.env, fetchImpl = fetch, now = Date.now, sleep = pause, minPollMs = 1000 } = {}) {
    this.#config = validateAgentEventConfig(config); this.#now = now; this.#sleep = sleep; this.#minPollMs = minPollMs;
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleep !== 'function' || !Number.isSafeInteger(minPollMs) || minPollMs < 0 || minPollMs > 20000) throw failure('CONFIG_INVALID');
    this.#service = createAgentEventService(this.#config, { env, fetchImpl });
    this.#activate = createSignedActivation(this.#config, { env, fetchImpl, now });
    this.#secrets = [env[this.#config.tokenEnv], env[this.#config.activation.secretEnv]];
    this.#binding = digest(JSON.stringify([this.#config.endpoint, this.#config.activation.url, this.#config.tokenEnv, this.#config.activation.secretEnv]));
  }
  get snapshot() { return this.#state ? structuredClone(this.#state) : null; }
  async #persist(state = this.#state) {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > MAX_STATE_BYTES || this.#secrets.some(secret => body.includes(secret))) throw failure('CHECKPOINT_INVALID');
    const tmp = this.#config.checkpointPath + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await open(tmp, 'wx', 0o600); await handle.writeFile(body); await handle.sync(); await handle.close(); handle = null;
      await rename(tmp, this.#config.checkpointPath);
      // Flush directory entry where supported. Windows does not expose portable directory fsync.
      if (process.platform !== 'win32') { const directory = await open(dirname(tmp), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } catch { throw failure('CHECKPOINT_WRITE_FAILED'); }
    finally { await handle?.close().catch(() => {}); await unlink(tmp).catch(() => {}); }
  }
  async #acquireLock() {
    const parent = dirname(this.#config.checkpointPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    // Reject symlink directories, not only the final checkpoint leaf.
    for (let current = parent;; current = dirname(current)) {
      if ((await lstat(current)).isSymbolicLink()) throw failure('CHECKPOINT_PATH_INVALID');
      if (dirname(current) === current) break;
    }
    const path = this.#config.checkpointPath + '.lock';
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const handle = await open(path, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); this.#lock = { handle, path }; return; }
      catch (error) {
        if (error.code !== 'EEXIST') throw failure('CHECKPOINT_LOCK_FAILED');
        // Serialize stale-lock recovery. Re-read under the recovery guard so another consumer's NEW lock cannot be deleted.
        let recovery; const recoveryPath = path + '.recovery';
        try {
          recovery = await open(recoveryPath, 'wx', 0o600);
          const info = await boundedFile(path, 1024, { privateMode: true });
          if (!keys(info, ['pid']) || !positive(info.pid)) throw failure('CHECKPOINT_LOCKED');
          try { process.kill(info.pid, 0); throw failure('CHECKPOINT_LOCKED'); }
          catch (aliveError) { if (aliveError.code !== 'ESRCH') throw failure('CHECKPOINT_LOCKED'); }
          await unlink(path);
        } catch { throw failure('CHECKPOINT_LOCKED'); }
        finally { if (recovery) { await recovery.close().catch(() => {}); await unlink(recoveryPath).catch(() => {}); } }
      }
    }
    throw failure('CHECKPOINT_LOCKED');
  }
  async #identity(signal) {
    const me = await this.#service.me(signal);
    if (!me.agent && !me.principal?.capabilities?.includes('company.read')) throw failure('AGENT_METADATA_UPGRADE_REQUIRED');
    const company = me.agent ? { company: { id: me.principal?.tenantId }, agents: [me.agent] } : await this.#service.company(signal);
    const identity = projectIdentity(me, company);
    if (this.#state && !same(this.#state.identity, identity)) throw failure('IDENTITY_CHANGED');
    return identity;
  }
  #validateCheckpoint(state) {
    if (!keys(state, ['format', 'binding', 'identity', 'cursor', 'needsReconcile', 'pending', 'completed', 'readQueue', 'coverage', 'stopped'])
      || state.format !== 1 || state.binding !== this.#binding || !plain(state.identity) || state.cursor !== null && !cursorOk(state.cursor)
      || typeof state.needsReconcile !== 'boolean' || !plain(state.pending) || !plain(state.completed)
      || Object.keys(state.pending).length > MAX_PENDING || Object.keys(state.completed).length > MAX_COMPLETED) throw failure('CHECKPOINT_INVALID');
    if (state.readQueue !== undefined && (!plain(state.readQueue) || Object.keys(state.readQueue).length > MAX_PENDING
      || Object.entries(state.readQueue).some(([cid, value]) => !id(cid) || value !== true))) throw failure('CHECKPOINT_INVALID');
    for (const [cid, item] of Object.entries(state.pending)) {
      if (!id(cid) || !keys(item, ['conversationId', 'customerMessageId', 'version', 'channelId', 'departmentId', 'key', 'attempts', 'nextAt'])
        || item.conversationId !== cid || !messageId(item.customerMessageId) || !positive(item.version) || !id(item.channelId)
        || item.departmentId !== null && !id(item.departmentId) || item.key !== stableWakeupKey(state.identity, cid, item.customerMessageId)
        || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > 3 || !Number.isSafeInteger(item.nextAt) || item.nextAt < 0) throw failure('CHECKPOINT_INVALID');
    }
    for (const [cid, item] of Object.entries(state.completed)) if (!id(cid) || !keys(item, ['key', 'customerMessageId'])
      || !messageId(item.customerMessageId) || item.key !== stableWakeupKey(state.identity, cid, item.customerMessageId)) throw failure('CHECKPOINT_INVALID');
  }
  async initialize({ signal } = {}) {
    if (this.#closed) throw failure('STOPPED'); if (this.#state) return;
    signal = this.#operationSignal(signal);
    try {
      await this.#acquireLock();
      const stored = await boundedFile(this.#config.checkpointPath, MAX_STATE_BYTES, { optional: true, privateMode: true });
      if (stored) this.#validateCheckpoint(stored);
      this.#state = stored;
      const identity = await this.#identity(signal);
      this.#state ??= { format: 1, binding: this.#binding, identity, cursor: null, needsReconcile: true, pending: {}, completed: {}, readQueue: {}, coverage: null };
      this.#state.readQueue ??= {};
      if (this.#state.stopped) throw failure(this.#state.stopped);
      this.#state.needsReconcile = true; await this.#persist();
    } catch (error) {
      // initialize may run inside cycle: do not wait for that same cycle while unwinding it.
      this.#closed = true; this.#stop.abort(); await this.#releaseLock();
      throw error instanceof AgentEventListenerError ? error : failure('CHECKPOINT_INVALID');
    }
  }
  async #read(cid, signal, attempt = 0) {
    try {
      const result = await this.#service.read(cid, signal);
      // A receipt is checked AFTER the awaited read; it binds scope and identity revision and costs no extra quota.
      if (!id(result.receipt)) throw failure('RESPONSE_INVALID');
      const { receipt } = await this.#service.readReceipt(result.receipt, signal), identity = await this.#identity(signal);
      if (!plain(receipt) || receipt.state !== 'confirmed' || receipt.stale !== false || receipt.capability !== 'conversation.read'
        || receipt.principalId !== identity.principalId || receipt.workspaceId !== identity.workspaceId || receipt.tenantId !== identity.tenantId
        || receipt.agentId !== identity.agentId || receipt.revision !== identity.revision || receipt.keyRevision !== identity.keyRevision
        || receipt.context?.conversationId !== cid || receipt.context?.conversationVersion !== result.conversation?.version
        || receipt.context?.channelId !== result.conversation?.channelId || receipt.context?.departmentId !== (result.conversation?.departmentId ?? 'unassigned')) throw failure('IDENTITY_CHANGED');
      if (receipt.context?.conversationKind === 'group') return null;
      // Identity/receipt awaits can overlap a human takeover. Finish with a fresh conversation read and check it synchronously.
      const current = await this.#service.read(cid, signal);
      if (!id(current.receipt)) throw failure('RESPONSE_INVALID');
      const currentIdentity = await this.#identity(signal), { receipt: proof } = await this.#service.readReceipt(current.receipt, signal);
      // conversation.read receipts revalidate the exact version on the server, after every intervening await.
      if (!plain(proof) || proof.state !== 'confirmed' || proof.stale !== false || proof.capability !== 'conversation.read'
        || proof.principalId !== currentIdentity.principalId || proof.workspaceId !== currentIdentity.workspaceId || proof.tenantId !== currentIdentity.tenantId
        || proof.agentId !== currentIdentity.agentId || proof.revision !== currentIdentity.revision || proof.keyRevision !== currentIdentity.keyRevision
        || proof.context?.conversationId !== cid || proof.context?.conversationVersion !== current.conversation?.version
        || proof.context?.channelId !== current.conversation?.channelId || proof.context?.departmentId !== (current.conversation?.departmentId ?? 'unassigned')) throw failure('IDENTITY_CHANGED');
      if (proof.context?.conversationKind === 'group') return null;
      return pendingProjection(current.conversation, currentIdentity, cid);
    } catch (error) {
      if (error.status === 409 && /^SERVICE_HTTP_/.test(error.code)) {
        await this.#identity(signal);
        if (attempt >= 2) throw failure('CONVERSATION_READ_UNCONFIRMED', { fatal: false });
        return this.#read(cid, signal, attempt + 1);
      }
      if ([403, 404].includes(error.status) && /^SERVICE_HTTP_/.test(error.code)) {
        // Distinguish a conversation leaving scope from global revocation/capability loss.
        await this.#identity(signal); return null;
      }
      throw error;
    }
  }
  #coalesce(cid, projected, state = this.#state) {
    const old = Object.hasOwn(state.pending, cid) ? state.pending[cid] : undefined;
    const completed = Object.hasOwn(state.completed, cid) ? state.completed[cid] : undefined;
    if (!projected || completed?.key === projected.key) { delete state.pending[cid]; return; }
    setOwn(state.pending, cid, { ...projected, attempts: old?.key === projected.key ? old.attempts : 0, nextAt: old?.key === projected.key ? old.nextAt : 0 });
    if (Object.keys(state.pending).length > MAX_PENDING) throw failure('PENDING_COVERAGE_EXCEEDED');
  }
  async #reconcile(signal, state) {
    const seen = new Set(), cursors = new Set(), candidates = [], started = this.#now(), monotonic = performance.now();
    let next, snapshot, pages = 0;
    const fresh = () => {
      const elapsed = this.#now() - started;
      if (elapsed < 0 || Math.max(elapsed, performance.now() - monotonic) >= INBOX_TTL_MS) throw failure('INBOX_SNAPSHOT_EXPIRED', { fatal: false });
    };
    // Buffer only safe inventory metadata. No conversation reads, work or checkpoint mutation before EOF is proven.
    do {
      fresh(); await this.#identity(signal); fresh();
      let inventory;
      try { inventory = await this.#service.inbox(signal, next); }
      catch (error) {
        if (error.status === 409 && /^SERVICE_HTTP_/.test(error.code)) {
          await this.#identity(signal);
          // An expired/restarted server snapshot is not identity revocation. Restart from page one on the next bounded attempt.
          throw failure('INBOX_SNAPSHOT_EXPIRED', { fatal: false });
        }
        throw error;
      }
      await this.#identity(signal); fresh(); pages++;
      if (!Array.isArray(inventory.conversations) || inventory.conversations.length > INBOX_LIMIT) throw failure('RESPONSE_INVALID');
      const hasSnapshot = Object.hasOwn(inventory, 'snapshot'), hasNext = Object.hasOwn(inventory, 'nextCursor');
      if (!hasSnapshot && !hasNext && pages === 1) {
        if (inventory.conversations.length === INBOX_LIMIT) throw failure('INBOX_COVERAGE_UNPROVEN_50');
        next = null;
      } else {
        if (!hasSnapshot || !hasNext || typeof inventory.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(inventory.snapshot)
          || snapshot !== undefined && inventory.snapshot !== snapshot
          || inventory.nextCursor !== null && !inboxCursorOk(inventory.nextCursor)) throw failure('RESPONSE_INVALID');
        snapshot ??= inventory.snapshot; next = inventory.nextCursor;
        if (next !== null) {
          if (cursors.has(next) || inventory.conversations.length === 0) throw failure('RESPONSE_INVALID');
          cursors.add(next);
        }
      }
      for (const item of inventory.conversations) {
        if (!plain(item) || !id(item.id) || seen.has(item.id) || !positive(item.version)
          || !['agent', 'human', 'queue'].includes(item.owner) || !['open', 'pending', 'closed'].includes(item.status)) throw failure('RESPONSE_INVALID');
        seen.add(item.id);
        if (seen.size > MAX_INBOX_IDS) throw failure('INBOX_COVERAGE_EXCEEDED');
        if (item.owner === 'agent' && item.status !== 'closed') candidates.push(item.id);
      }
      // EOF at exactly the bound is valid; a continuation beyond it is not silently truncated.
      if (next !== null && pages >= MAX_INBOX_PAGES) throw failure('INBOX_COVERAGE_EXCEEDED');
    } while (next !== null);
    await this.#identity(signal); fresh();
    if (candidates.length > MAX_PENDING) throw failure('PENDING_COVERAGE_EXCEEDED');
    const eligible = new Set(candidates), readQueue = {};
    // A restart must not put already queued work behind every previously completed conversation again.
    for (const cid of Object.keys(state.readQueue)) if (eligible.has(cid)) setOwn(readQueue, cid, true);
    for (const cid of candidates) setOwn(readQueue, cid, true);
    state.readQueue = readQueue;
    for (const cid of Object.keys(state.pending)) if (!Object.hasOwn(readQueue, cid)) delete state.pending[cid];
    state.coverage = { complete: true, visibleCount: seen.size, inboxLimit: INBOX_LIMIT, pages, ...(snapshot ? { snapshot } : {}) };
    state.needsReconcile = false;
  }
  async #readQueued(signal, state, limit) {
    const batch = Object.keys(state.readQueue).slice(0, limit);
    for (const cid of batch) {
      this.#coalesce(cid, await this.#read(cid, signal), state);
      delete state.readQueue[cid];
    }
    return batch.length;
  }
  async #ingest(result, signal, materializeLimit) {
    if (!plain(result) || !cursorOk(result.cursor) || !Array.isArray(result.events) || result.events.length > 50
      || typeof result.resync !== 'boolean' || typeof result.timedOut !== 'boolean') throw failure('RESPONSE_INVALID');
    // /me returns the current own adapter quota-free; old servers retain the conservative company fallback.
    await this.#identity(signal);
    const state = structuredClone(this.#state);
    if (result.resync || state.needsReconcile) await this.#reconcile(signal, state);
    const changes = new Map();
    for (const event of result.events) {
      if (!plain(event) || !EVENT_TYPES.includes(event.type) || !id(event.conversationId)) throw failure('RESPONSE_INVALID');
      const cancel = event.left === true || event.type === 'conversation.removed' || event.status === 'closed'
        || event.owner === 'human' || event.owner === 'queue' || event.assignedToMe === false;
      changes.set(event.conversationId, cancel);
    }
    for (const [cid, cancel] of changes) {
      if (cancel) { delete state.pending[cid]; delete state.readQueue[cid]; }
      else {
        setOwn(state.readQueue, cid, true);
        if (Object.keys(state.readQueue).length > MAX_PENDING) throw failure('PENDING_COVERAGE_EXCEEDED');
      }
    }
    const readCount = await this.#readQueued(signal, state, materializeLimit);
    // Single fsync + atomic rename commits coalesced work AND cursor. No cursor can skip unpersisted pending work.
    state.cursor = result.cursor;
    await this.#persist(state); this.#state = state;
    return readCount;
  }
  async #drain(signal) {
    let processed = 0;
    for (const cid of Object.keys(this.#state.pending)) {
      let item = this.#state.pending[cid];
      if (item.nextAt > this.#now()) continue;
      if (processed++ >= WORK_BATCH) break;
      if (item.attempts >= 3) throw failure('ACTIVATION_RETRIES_EXHAUSTED');
      this.#coalesce(cid, await this.#read(cid, signal)); item = this.#state.pending[cid];
      if (!item) { await this.#persist(); continue; }
      // Attempts are durable BEFORE dispatch, so kill/restart cannot reset the retry bound.
      item.attempts++; await this.#persist();
      // Read once more after the persistence await; check the CURRENT owner, scope, latest customer and version.
      const latest = await this.#read(cid, signal);
      if (!latest) { delete this.#state.pending[cid]; await this.#persist(); continue; }
      if (latest.key !== item.key || latest.version !== item.version || latest.channelId !== item.channelId || latest.departmentId !== item.departmentId) {
        this.#coalesce(cid, latest); await this.#persist(); continue;
      }
      if (signal?.aborted || this.#closed) throw failure('STOPPED');
      const p = this.#state.identity;
      const metadata = { schemaVersion: 1, type: 'elozi.agent.wakeup', principalId: p.principalId, workspaceId: p.workspaceId, tenantId: p.tenantId, agentId: p.agentId,
        conversationId: cid, customerMessageId: item.customerMessageId, version: item.version, channelId: item.channelId, departmentId: item.departmentId };
      if (!Object.hasOwn(this.#state.completed, cid) && Object.keys(this.#state.completed).length >= MAX_COMPLETED) throw failure('DEDUP_COVERAGE_EXCEEDED');
      try {
        await this.#activate(metadata, item.key, { signal });
        setOwn(this.#state.completed, cid, { key: item.key, customerMessageId: item.customerMessageId }); delete this.#state.pending[cid];
        await this.#persist();
      } catch (error) {
        if (error.fatal || signal?.aborted) throw error;
        item.nextAt = this.#now() + Math.max(error.retryAfterMs ?? 0, Math.min(30000, 1000 * 2 ** (item.attempts - 1)));
        await this.#persist();
        if (item.attempts >= 3) throw failure('ACTIVATION_RETRIES_EXHAUSTED');
      }
    }
  }
  #operationSignal(signal) { return signal ? AbortSignal.any([this.#stop.signal, signal]) : this.#stop.signal; }
  #hasLocalWork() { return Object.keys(this.#state.readQueue).length > 0 || Object.keys(this.#state.pending).length > 0; }
  #startWait(signal) {
    if (this.#waiter) return;
    if (this.#closed || signal?.aborted) throw failure('STOPPED');
    const controller = new AbortController(), waiter = { controller, ready: false, result: null, promise: null };
    // The rejection handler is attached immediately. At most one request OR buffered result exists until its cursor commits.
    waiter.promise = this.#service.wait(this.#state.cursor, AbortSignal.any([controller.signal, signal])).then(
      value => { waiter.result = { value }; waiter.ready = true; },
      error => { waiter.result = { error }; waiter.ready = true; },
    );
    this.#waiter = waiter;
  }
  async #consumeWait(signal, limit) {
    const waiter = this.#waiter;
    await waiter.promise;
    if (this.#closed || signal.aborted) throw failure('STOPPED');
    if (waiter.result.error) { this.#waiter = null; throw waiter.result.error; }
    const result = waiter.result.value, readCount = await this.#ingest(result, signal, limit);
    // A failed read/fsync leaves the same one-result buffer intact, never another wait or an advanced cursor.
    this.#waiter = null;
    return { result, readCount };
  }
  async cycle({ signal } = {}) {
    if (this.#busy) throw failure('LISTENER_BUSY');
    this.#busy = true; signal = this.#operationSignal(signal);
    let finished; this.#cycleDone = new Promise(resolvePromise => { finished = resolvePromise; });
    try {
      await this.initialize({ signal });
      const started = this.#now(); let result = null, remaining = WORK_BATCH;
      this.#startWait(signal);
      if (!this.#hasLocalWork() || this.#waiter.ready) {
        const consumed = await this.#consumeWait(signal, remaining);
        result = consumed.result; remaining -= consumed.readCount;
      }
      // Local metadata never waits for the remote 20-second long poll, and remains bounded to 50 reads per cycle.
      if (remaining && Object.keys(this.#state.readQueue).length) {
        const state = structuredClone(this.#state);
        remaining -= await this.#readQueued(signal, state, remaining);
        await this.#persist(state); this.#state = state;
      }
      // A result that arrived during local reads (including a human takeover/revocation) wins before activation.
      if (this.#waiter?.ready) {
        const consumed = await this.#consumeWait(signal, remaining);
        result = consumed.result;
      }
      if (signal.aborted || this.#closed) throw failure('STOPPED');
      await this.#drain(signal);
      if (this.#hasLocalWork()) this.#startWait(signal);
      await this.#sleep(Math.max(0, this.#minPollMs - (this.#now() - started)), signal);
      return { eventCount: result?.events.length ?? 0, pendingCount: Object.keys(this.#state.pending).length, readQueueCount: Object.keys(this.#state.readQueue).length, resync: result?.resync ?? false, timedOut: result?.timedOut ?? false };
    } catch (error) {
      if (this.#state && (['IDENTITY_CHANGED', 'IDENTITY_REVOKED', 'IDENTITY_UNAUTHORIZED'].includes(error.code) || [401, 403, 409].includes(error.status) && /^SERVICE_HTTP_/.test(error.code))) {
        this.#state.pending = {}; this.#state.readQueue = {}; this.#state.stopped = 'IDENTITY_REVOKED_OR_CHANGED'; await this.#persist();
      }
      throw error instanceof AgentEventListenerError ? error : failure('LISTENER_FAILED');
    } finally { this.#busy = false; this.#cycleDone = null; finished(); }
  }
  async run({ signal, maxCycles = Infinity } = {}) {
    if (maxCycles !== Infinity && (!positive(maxCycles) || maxCycles > 10000)) throw failure('ARGUMENT_INVALID');
    signal = this.#operationSignal(signal);
    let cycles = 0, failures = 0;
    try {
      while (!signal?.aborted && cycles < maxCycles) {
        try { await this.cycle({ signal }); cycles++; failures = 0; }
        catch (error) {
          if (signal?.aborted || error.code === 'STOPPED') break;
          if (error.fatal || ++failures >= 3) throw error;
          await this.#sleep(Math.max(error.retryAfterMs, Math.min(30000, 1000 * 2 ** (failures - 1))), signal);
        }
      }
      return { cycles, pendingCount: this.#state ? Object.keys(this.#state.pending).length : 0, readQueueCount: this.#state ? Object.keys(this.#state.readQueue).length : 0 };
    } finally { await this.close(); }
  }
  async close() {
    this.#closed = true; this.#stop.abort(); this.#waiter?.controller.abort();
    // Settle the captured rejection and current fsync/dispatch before releasing the single-consumer lock.
    await this.#waiter?.promise; await this.#cycleDone; this.#waiter = null;
    await this.#releaseLock();
  }
  async #releaseLock() {
    if (this.#lock) { const lock = this.#lock; this.#lock = null; await lock.handle.close().catch(() => {}); await unlink(lock.path).catch(() => {}); }
  }
}
