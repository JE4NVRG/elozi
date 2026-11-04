import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { fail } from './store.js';
import { publicAddress } from './mcp-transport.js';
import { SERVICE_EVENT_TYPES } from './service-api.js';
import { scopeEvent, visibleTo } from './events.js';
import { isTelegramAccountChannel } from './telegram-account-policy.js';

/**
 * Signed push of service event pointers (the same DTO as /api/service/v1/events/wait) to one HTTPS endpoint per service
 * identity. Deliveries are persisted before sending, retried with the same deliveryId and never carry text, contacts or
 * media: the receiver re-reads through the API. The long wait stays available for reconciliation.
 */
export const WEBHOOK_EVENT = 'elozi.service.events';
export const WEBHOOK_BACKOFF_MS = Object.freeze([5000, 30000, 120000, 600000, 1800000]);
const PUBLIC_KINDS = new Set(['customer', 'human', 'agent']);
const MAX_BODY_BYTES = 16384, MAX_EVENTS = 50, MAX_PENDING = 1000, RESPONSE_BYTES = 4096;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const secretKey = principalId => `service-webhook:${principalId}`;
const fingerprint = secret => createHash('sha256').update(secret).digest('hex').slice(0, 12);
/** A receiver-provided secret (write-only) or a generated one; only its 12-hex SHA-256 fingerprint is ever shown again. */
function webhookSecret(value) {
  if (value === undefined) return { secret: 'elozi_whsec_' + randomBytes(32).toString('base64url'), generated: true };
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+/=-]{32,256}$/.test(value)) fail(400, 'Use um segredo de 32 a 256 caracteres seguros.');
  return { secret: value, generated: false };
}

/** HTTPS only, public host, no credentials, query, fragment or non-default port: the receiver is a product backend. */
export function webhookUrl(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x20\x7f]/.test(value)) fail(400, 'Informe a URL HTTPS do webhook.');
  let url; try { url = new URL(value); } catch { fail(400, 'Informe a URL HTTPS do webhook.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || url.href !== value
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)\.?$/i.test(host) || isIP(host) && !publicAddress(host)) fail(400, 'Use uma URL HTTPS pública, sem credenciais, porta, query ou fragmento.');
  return url.href;
}

/** One total deadline includes DNS, connection and response; a late DNS result never opens a request. */
export function pinnedWebhookPost({ lookupImpl = lookup, requestImpl = https.request, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Informe um prazo válido para o webhook.');
  return async (target, headers, body, { reauthorize = () => true } = {}) => {
    const url = new URL(target), host = url.hostname.replace(/^\[|\]$/g, '');
    return await new Promise(resolve => {
      const deadline = performance.now() + timeoutMs;
      let settled = false, request, response, timer;
      const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const stop = error => { if (settled) return; done({ status: 0, error }); request?.destroy?.(); response?.destroy?.(); };
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      Promise.resolve().then(async () => {
        const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupImpl(host, { all: true, verbatim: true });
        if (settled) return;
        if (performance.now() >= deadline) { stop('timeout'); return; }
        if (!records.length || records.some(record => !isIP(record.address) || !publicAddress(record.address))) { done({ status: 0, error: 'address-not-public' }); return; }
        const record = records[0];
        if (!reauthorize()) { done({ status: 0, error: 'authorization' }); return; }
        if (performance.now() >= deadline) { stop('timeout'); return; }
        request = requestImpl(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, agent: false, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
          lookup: (_host, options, callback) => options?.all ? callback(null, [record]) : callback(null, record.address, record.family) }, incoming => {
          response = incoming;
          let bytes = 0, ended = false;
          response.on('data', chunk => { bytes += chunk.length; if (bytes > RESPONSE_BYTES) stop('response-size'); });
          response.on('end', () => { ended = true; done({ status: response.statusCode || 0 }); });
          response.on('close', () => { if (!ended) done({ status: 0, error: 'response' }); });
          response.on('error', () => done({ status: 0, error: 'response' }));
        });
        request.on('timeout', () => stop('timeout'));
        request.on('error', () => done({ status: 0, error: 'network' }));
        request.end(body);
      }).catch(() => stop('network'));
    });
  };
}

export class ServiceWebhooks {
  /**
   * principals: ServicePrincipals; api: ServiceApi (eventScope/eventDTO); bus: events bus with subscribe();
   * loadSecrets(): encrypted secret store with get/set; post(url, headers, body, { reauthorize }) -> { status }.
   */
  constructor({ store, principals, api, bus = null, loadSecrets, post = pinnedWebhookPost(), now = Date.now, flushMs = 250, pollMs = 2000, backoffMs = WEBHOOK_BACKOFF_MS, concurrency = 4 }) {
    if (typeof loadSecrets !== 'function' || typeof post !== 'function' || typeof now !== 'function') throw new TypeError('Configuração de webhook inválida.');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new TypeError('Informe concorrência de webhook entre 1 e 16.');
    Object.assign(this, { store, principals, api, bus, loadSecrets, post, now, flushMs, pollMs, backoffMs, concurrency });
    this.buffers = new Map(); this.inFlight = new Set(); this.busyPrincipals = new Set(); this.active = new Set(); this.timer = null; this.unsubscribe = null; this.closed = false; this.cleanupAt = 0;
    store.db.exec(`CREATE TABLE IF NOT EXISTS service_webhooks (
      principal_id TEXT PRIMARY KEY REFERENCES service_principals(id), tenant_id TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL,
      revision INTEGER NOT NULL, secret_fingerprint TEXT NOT NULL, resync_pending INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_status INTEGER,
      last_attempt_at INTEGER, last_delivered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS service_webhook_deliveries (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, last_status INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS service_webhook_due ON service_webhook_deliveries(state, next_at);`);
  }
  row(principalId) { return this.store.db.prepare('SELECT * FROM service_webhooks WHERE principal_id=?').get(principalId); }
  dto(row) {
    if (!row) return { configured: false, enabled: false };
    const pending = this.store.db.prepare("SELECT count(*) n FROM service_webhook_deliveries WHERE principal_id=? AND state='pending'").get(row.principal_id).n;
    const iso = value => value ? new Date(value).toISOString() : null;
    return { configured: true, enabled: Boolean(row.enabled), url: row.url, revision: row.revision, event: WEBHOOK_EVENT, secretFingerprint: row.secret_fingerprint, signature: 'sha256=HMAC(secret, timestamp + "." + deliveryId + "." + body)',
      lastStatus: row.last_status ?? null, lastAttemptAt: iso(row.last_attempt_at), lastDeliveredAt: iso(row.last_delivered_at), failures: row.failures, pending, resyncPending: Boolean(row.resync_pending) };
  }
  /** Own identity view (GET /api/service/v1/me): never the secret. */
  describe(principalId) { const row = this.row(principalId); return row ? { ...this.dto(row), url: new URL(row.url).origin } : { configured: false, enabled: false }; }
  principal(actor, tenantId, principalId) {
    if (!id(principalId)) fail(400, 'Identidade de serviço inválida.');
    const row = this.store.db.prepare('SELECT * FROM service_principals WHERE id=? AND tenant_id=? AND reseller_id=?').get(principalId, tenantId, actor.resellerId);
    if (!row) fail(404, 'Identidade de serviço não encontrada nesta empresa.');
    const metadata = this.principals.metadata(row);
    if (!metadata.capabilities.includes('events.read')) fail(409, 'O webhook exige uma identidade com events.read.');
    return { row, metadata };
  }
  /**
   * Human administrator only. A generated secret is returned once; a provided one is never returned. Both are stored
   * encrypted; a new secret on an existing webhook is a rotation.
   */
  async configure(actor, tenantId, principalId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'enabled', 'revision', 'secret'].includes(key))) fail(400, 'Informe somente url, enabled, revision e secret.');
    const { metadata } = this.principal(actor, tenantId, principalId), current = this.row(principalId);
    if (!Number.isSafeInteger(input.revision) || input.revision !== (current?.revision ?? 0)) fail(409, 'A configuração do webhook mudou. Leia de novo antes de salvar.');
    const url = input.url === undefined && current ? current.url : webhookUrl(input.url), enabled = input.enabled === undefined ? true : input.enabled;
    if (typeof enabled !== 'boolean') fail(400, 'Use enabled verdadeiro ou falso.');
    if (enabled && metadata.state !== 'active') fail(409, 'Ative a identidade de serviço antes de ligar o webhook.');
    const at = this.now(), next = !current || input.secret !== undefined ? webhookSecret(input.secret) : null;
    if (next) (await this.loadSecrets()).set(secretKey(principalId), { secret: next.secret });
    if (!current) {
      this.store.db.prepare('INSERT INTO service_webhooks (principal_id,tenant_id,url,enabled,revision,secret_fingerprint,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)').run(principalId, tenantId, url, enabled ? 1 : 0, fingerprint(next.secret), at, at);
    } else {
      this.store.db.prepare('UPDATE service_webhooks SET url=?,enabled=?,revision=revision+1,secret_fingerprint=coalesce(?,secret_fingerprint),updated_at=? WHERE principal_id=? AND revision=?').run(url, enabled ? 1 : 0, next ? fingerprint(next.secret) : null, at, principalId, current.revision);
      if (!enabled) this.store.db.prepare("UPDATE service_webhook_deliveries SET state='cancelled',updated_at=? WHERE principal_id=? AND state='pending'").run(at, principalId);
    }
    return { webhook: this.dto(this.row(principalId)), ...(next?.generated ? { secret: next.secret } : {}) };
  }
  async rotate(actor, tenantId, principalId, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'revision')) fail(400, 'Informe somente revision.');
    this.principal(actor, tenantId, principalId);
    const current = this.row(principalId);
    if (!current) fail(404, 'Configure o webhook antes de trocar o segredo.');
    if (input.revision !== current.revision) fail(409, 'A configuração do webhook mudou. Leia de novo antes de trocar o segredo.');
    const { secret } = webhookSecret();
    (await this.loadSecrets()).set(secretKey(principalId), { secret });
    this.store.db.prepare('UPDATE service_webhooks SET revision=revision+1,secret_fingerprint=?,updated_at=? WHERE principal_id=?').run(fingerprint(secret), this.now(), principalId);
    return { webhook: this.dto(this.row(principalId)), secret };
  }
  read(actor, tenantId, principalId) { this.principal(actor, tenantId, principalId); return { webhook: this.dto(this.row(principalId)) }; }

  start() {
    if (this.bus && !this.unsubscribe) this.unsubscribe = this.bus.subscribe(event => { try { this.collect(event); } catch { /* A pointer that cannot be scoped is skipped; the long wait reconciles. */ } });
    if (!this.timer) { this.timer = setInterval(() => { this.drain().catch(() => {}); }, this.pollMs); this.timer.unref?.(); }
    return this;
  }
  async close() {
    this.closed = true; this.unsubscribe?.(); this.unsubscribe = null; clearInterval(this.timer); this.timer = null;
    for (const buffer of this.buffers.values()) clearTimeout(buffer.timer);
    this.buffers.clear(); await Promise.allSettled([...this.active]);
  }
  /** One committed pointer -> every enabled webhook of that company whose identity may see it. */
  collect(event) {
    if (this.closed || !event?.tenantId || !SERVICE_EVENT_TYPES.includes(event.type) || event.type === 'conversation.message' && !PUBLIC_KINDS.has(event.kind)) return;
    const hooks = this.store.db.prepare('SELECT w.principal_id, p.* FROM service_webhooks w JOIN service_principals p ON p.id=w.principal_id WHERE w.tenant_id=? AND w.enabled=1').all(event.tenantId);
    for (const row of hooks) {
      const metadata = this.principals.metadata(row);
      if (metadata.state !== 'active' || !metadata.capabilities.includes('events.read')) continue;
      const actor = { principalId: row.id, tenantId: row.tenant_id, workspaceId: row.reseller_id, agentId: row.agent_id };
      const scope = this.api.eventScope(actor, metadata);
      if (!visibleTo(event, scope)) continue;
      const scoped = scopeEvent(event, scope);
      if (scoped) this.enqueue(actor, this.api.eventDTO(actor, scoped));
    }
  }
  enqueue(actor, dto) {
    const buffer = this.buffers.get(actor.principalId) || { actor, events: [], timer: null };
    buffer.events.push(dto); this.buffers.set(actor.principalId, buffer);
    if (buffer.events.length >= MAX_EVENTS) this.flush(actor.principalId);
    else if (!buffer.timer) { buffer.timer = setTimeout(() => this.flush(actor.principalId), this.flushMs); buffer.timer.unref?.(); }
  }
  /** Persists the buffered pointers as deliveries before any attempt; an overflowing queue becomes a resync signal. */
  flush(principalId) {
    const buffer = this.buffers.get(principalId);
    if (!buffer) return [];
    clearTimeout(buffer.timer); this.buffers.delete(principalId);
    const created = [], at = this.now(), { actor } = buffer;
    const pending = this.store.db.prepare("SELECT count(*) n FROM service_webhook_deliveries WHERE principal_id=? AND state='pending'").get(principalId).n;
    if (pending >= MAX_PENDING) { this.store.db.prepare('UPDATE service_webhooks SET resync_pending=1 WHERE principal_id=?').run(principalId); return created; }
    const resync = Boolean(this.row(principalId)?.resync_pending);
    let events = buffer.events;
    while (events.length) {
      let count = Math.min(events.length, MAX_EVENTS), body, deliveryId;
      do {
        deliveryId = 'whd_' + randomUUID().replaceAll('-', '');
        body = JSON.stringify({ schemaVersion: 1, type: WEBHOOK_EVENT, deliveryId, principalId, tenantId: actor.tenantId, createdAt: new Date(at).toISOString(),
          ...(resync && !created.length ? { resync: true } : {}), events: events.slice(0, count) });
      } while (Buffer.byteLength(body) > MAX_BODY_BYTES && count > 1 && (count = Math.ceil(count / 2)));
      if (Buffer.byteLength(body) <= MAX_BODY_BYTES) {
        this.store.db.prepare("INSERT INTO service_webhook_deliveries (id,principal_id,tenant_id,body,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'pending',0,?,?,?)").run(deliveryId, principalId, actor.tenantId, body, at, at, at);
        created.push(deliveryId);
      }
      events = events.slice(count);
    }
    if (resync && created.length) this.store.db.prepare('UPDATE service_webhooks SET resync_pending=0 WHERE principal_id=?').run(principalId);
    if (created.length) this.drain().catch(() => {});
    return created;
  }
  /** Current authority for every persisted pointer, including deliveries buffered before a grant changed. */
  deliveryCurrent(delivery, principal, metadata) {
    let body, tenant;
    try {
      body = JSON.parse(delivery.body);
      if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS || body.events.some(event => typeof event?.conversationId !== 'string')) return false;
      tenant = this.store.serviceTenant(principal.reseller_id, principal.tenant_id, { conversationIds: [...new Set(body.events.map(event => event.conversationId))] });
    } catch { return false; }
    if (!tenant || !tenant.agents.some(agent => agent.id === principal.agent_id && agent.configured === true)
      || delivery.tenant_id !== principal.tenant_id || body.principalId !== principal.id || body.tenantId !== principal.tenant_id
      || body.deliveryId !== delivery.id || !Array.isArray(body.events) || body.events.length > MAX_EVENTS || !body.events.length && body.resync !== true) return false;
    const scope = { tenantId: principal.tenant_id, agentId: principal.agent_id, includeGroups: false, departmentIds: metadata.departmentIds,
      channelIds: (tenant.channels || []).filter(channel => !isTelegramAccountChannel(channel) && (metadata.channelIds === null || metadata.channelIds.includes(channel.id))).map(channel => channel.id) };
    const conversations = new Map((tenant.conversations || []).map(conversation => [conversation.id, conversation]));
    return body.events.every(event => {
      const conversation = conversations.get(event?.conversationId);
      if (!conversation || !visibleTo({ ...conversation, tenantId: principal.tenant_id }, scope)) return false;
      // A minimal left pointer has no old route to disclose. Full pointers must still describe an authorized route and
      // may not attribute another agent's historical ownership to the current identity. Cancel the whole immutable lot.
      if (event.left === true) return true;
      return event.channelId === conversation.channelId && (event.departmentId || 'unassigned') === (conversation.departmentId || 'unassigned')
        && (event.owner !== 'agent' || event.assignedToMe === true && conversation.owner === 'agent' && conversation.agentId === principal.agent_id);
    });
  }
  /** A safe new resync envelope wakes an idle receiver; never rewrite/retry the obsolete delivery under a new id. */
  queueResync(principalId) {
    const hook = this.row(principalId), principal = this.store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(principalId);
    const metadata = principal && this.principals.metadata(principal);
    if (principal && !this.store.serviceTenant(principal.reseller_id, principal.tenant_id, { conversationId: null }).agents.some(agent => agent.id === principal.agent_id && agent.configured === true)) return;
    if (!hook?.enabled || !hook.resync_pending || metadata?.state !== 'active' || !metadata.capabilities.includes('events.read')
      || this.store.db.prepare("SELECT 1 FROM service_webhook_deliveries WHERE principal_id=? AND state='pending' LIMIT 1").get(principalId)) return;
    const at = this.now(), deliveryId = 'whd_' + randomUUID().replaceAll('-', '');
    const body = JSON.stringify({ schemaVersion: 1, type: WEBHOOK_EVENT, deliveryId, principalId, tenantId: principal.tenant_id, createdAt: new Date(at).toISOString(), resync: true, events: [] });
    this.store.db.prepare("INSERT INTO service_webhook_deliveries (id,principal_id,tenant_id,body,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'pending',0,?,?,?)").run(deliveryId, principalId, principal.tenant_id, body, at, at, at);
    this.store.db.prepare('UPDATE service_webhooks SET resync_pending=0 WHERE principal_id=?').run(principalId);
  }
  /** Admit FIFO heads fairly before limiting the batch. Unrelated identities can finish while another awaits its host. */
  async drain() {
    if (this.closed) return;
    const existing = [...this.active];
    await this.drainOnce();
    await Promise.allSettled(existing);
  }
  async drainOnce() {
    const at = this.now();
    const available = this.concurrency - this.active.size;
    if (this.closed || available <= 0) return;
    if (at >= this.cleanupAt) {
      this.store.db.prepare("DELETE FROM service_webhook_deliveries WHERE (state='delivered' AND updated_at<?) OR (state IN ('abandoned','cancelled') AND updated_at<?)").run(at - 86400000, at - 7 * 86400000);
      this.cleanupAt = at + 60000;
    }
    const busy = [...this.busyPrincipals], excluded = busy.length ? `AND d.principal_id NOT IN (${busy.map(() => '?').join(',')})` : '';
    const due = this.store.db.prepare(`WITH heads AS (SELECT min(rowid) AS head FROM service_webhook_deliveries WHERE state='pending' GROUP BY principal_id)
      SELECT d.* FROM service_webhook_deliveries d JOIN heads h ON d.rowid=h.head WHERE d.next_at<=? ${excluded} ORDER BY d.next_at,d.created_at,d.rowid LIMIT ?`).all(at, ...busy, available);
    const tasks = [];
    for (const delivery of due) {
      if (this.busyPrincipals.has(delivery.principal_id) || this.inFlight.has(delivery.id)) continue;
      const task = this.attempt(delivery); this.active.add(task); tasks.push(task);
      task.finally(() => { this.active.delete(task); }).catch(() => {});
    }
    await Promise.allSettled(tasks);
  }
  async attempt(delivery) {
    if (this.closed || this.busyPrincipals.has(delivery.principal_id) || this.inFlight.has(delivery.id)) return;
    this.inFlight.add(delivery.id);
    this.busyPrincipals.add(delivery.principal_id);
    let interrupted = false;
    try {
      const hook = this.row(delivery.principal_id), principal = this.store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(delivery.principal_id);
      const metadata = principal && this.principals.metadata(principal), at = this.now();
      if (!hook?.enabled || metadata?.state !== 'active' || !metadata.capabilities.includes('events.read')) {
        this.store.db.prepare("UPDATE service_webhook_deliveries SET state='cancelled',updated_at=? WHERE id=?").run(at, delivery.id); return;
      }
      const cancelObsolete = () => {
        this.store.db.prepare("UPDATE service_webhook_deliveries SET state='cancelled',updated_at=? WHERE id=?").run(this.now(), delivery.id);
        this.store.db.prepare('UPDATE service_webhooks SET resync_pending=1 WHERE principal_id=? AND enabled=1').run(delivery.principal_id);
        this.queueResync(delivery.principal_id);
      };
      if (!this.deliveryCurrent(delivery, principal, metadata)) { cancelObsolete(); return; }
      const secret = (await this.loadSecrets()).get(secretKey(delivery.principal_id))?.secret;
      if (typeof secret !== 'string' || !secret) { this.store.db.prepare("UPDATE service_webhook_deliveries SET state='cancelled',updated_at=? WHERE id=?").run(at, delivery.id); return; }
      // Secret loading and public DNS both await: an administrator may revoke the grant, narrow its scope, or change
      // the endpoint meanwhile. Bind this attempt to the exact configuration observed before either await.
      let authorityLost = false;
      const reauthorize = () => {
        const latestHook = this.row(delivery.principal_id), latestPrincipal = this.store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(delivery.principal_id);
        const latestMetadata = latestPrincipal && this.principals.metadata(latestPrincipal);
        authorityLost ||= !latestHook?.enabled || latestMetadata?.state !== 'active' || !latestMetadata.capabilities.includes('events.read')
          || latestHook.revision !== hook.revision || latestPrincipal.revision !== principal.revision || latestPrincipal.key_revision !== principal.key_revision
          || !this.deliveryCurrent(delivery, latestPrincipal, latestMetadata);
        return !authorityLost;
      };
      if (!reauthorize()) { cancelObsolete(); return; }
      const timestamp = String(Math.floor(at / 1000));
      const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${delivery.id}.${delivery.body}`).digest('hex');
      const result = await this.post(hook.url, { 'Content-Type': 'application/json', 'User-Agent': 'Elozi-Webhook/1', 'X-Elozi-Timestamp': timestamp, 'X-Elozi-Signature': signature,
        'Idempotency-Key': delivery.id, 'X-Webhook-Id': delivery.id, 'X-Webhook-Event': WEBHOOK_EVENT }, delivery.body, { reauthorize }).catch(() => ({ status: 0 }));
      if (authorityLost) { cancelObsolete(); return; }
      const status = Number.isSafeInteger(result?.status) ? result.status : 0, after = this.now(), attempts = delivery.attempts + 1;
      if (status >= 200 && status < 300) {
        this.store.db.prepare("UPDATE service_webhook_deliveries SET state='delivered',attempts=?,last_status=?,updated_at=? WHERE id=?").run(attempts, status, after, delivery.id);
        this.store.db.prepare('UPDATE service_webhooks SET failures=0,last_status=?,last_attempt_at=?,last_delivered_at=? WHERE principal_id=?').run(status, after, after, delivery.principal_id);
        this.queueResync(delivery.principal_id);
        return;
      }
      const abandoned = attempts > this.backoffMs.length;
      this.store.db.prepare('UPDATE service_webhook_deliveries SET state=?,attempts=?,last_status=?,next_at=?,updated_at=? WHERE id=?')
        .run(abandoned ? 'abandoned' : 'pending', attempts, status, abandoned ? after : after + this.backoffMs[attempts - 1], after, delivery.id);
      this.store.db.prepare(`UPDATE service_webhooks SET failures=failures+1,last_status=?,last_attempt_at=?${abandoned ? ',resync_pending=1' : ''} WHERE principal_id=?`).run(status, after, delivery.principal_id);
    } catch (error) { interrupted = true; throw error; }
    finally {
      this.inFlight.delete(delivery.id); this.busyPrincipals.delete(delivery.principal_id);
      if (!this.closed && !interrupted) setImmediate(() => this.drain().catch(() => {}));
    }
  }
}
