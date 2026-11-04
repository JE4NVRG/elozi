import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail } from './store.js';

/** Private operator policy: exact tenant/principal/channel, never a client-supplied grant. */
export const DEFAULT_SERVICE_REPLY_LIMIT_PER_HOUR = 6;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
/** Highest private override: a loop guard for one conversation, even for an operator's own administrative agent. */
export const MAX_SERVICE_REPLY_LIMIT_PER_HOUR = 300;
const invalid = () => { throw new TypeError(`Configure limites privados de resposta por empresa, identidade e canal exatos, entre 6 e ${MAX_SERVICE_REPLY_LIMIT_PER_HOUR}.`); };

/** Startup only. Explicit environment wins; otherwise read one fixed file beside the existing SQLite. */
export function loadPrivateServiceReplyLimits(databasePath, environment = process.env) {
  if (Object.hasOwn(environment, 'MEPCHAT_PRIVATE_REPLY_LIMITS')) {
    const value = environment.MEPCHAT_PRIVATE_REPLY_LIMITS;
    if (typeof value !== 'string' || value.length > 65536) invalid();
    return value;
  }
  if (databasePath === ':memory:') return [];
  const path = resolve(dirname(databasePath), 'private-service-reply-limits.json');
  let fd, observed = false;
  try {
    const before = lstatSync(path); observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536) invalid();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 65536) invalid();
    // A concurrent grow cannot turn a bounded configuration read into an unbounded allocation.
    const bytes = Buffer.alloc(65537); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length > 65536 || after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) invalid();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (!observed && error?.code === 'ENOENT') return [];
    invalid();
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function privateServiceReplyLimits(store, raw = []) {
  let values = raw;
  if (typeof raw === 'string') {
    if (raw.length > 65536) invalid();
    try { values = JSON.parse(raw); } catch { invalid(); }
  }
  if (!Array.isArray(values) || values.length > 64) invalid();
  const seen = new Set();
  return Object.freeze(values.map(value => {
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).length !== 4 || Object.keys(value).some(key => !['tenantId', 'principalId', 'channelId', 'replyLimitPerHour'].includes(key)) ||
        ![value.tenantId, value.principalId, value.channelId].every(identifier) ||
        !Number.isSafeInteger(value.replyLimitPerHour) || value.replyLimitPerHour < 6 || value.replyLimitPerHour > MAX_SERVICE_REPLY_LIMIT_PER_HOUR) invalid();
    const key = JSON.stringify([value.tenantId, value.principalId, value.channelId]);
    if (seen.has(key)) invalid();
    seen.add(key);
    const principal = store.db.prepare('SELECT tenant_id,channel_ids,capabilities FROM service_principals WHERE id=?').get(value.principalId);
    const tenant = store.db.prepare('SELECT data FROM tenants WHERE id=?').get(value.tenantId);
    if (!principal || principal.tenant_id !== value.tenantId || !tenant ||
        !JSON.parse(principal.capabilities).includes('reply.send') ||
        (principal.channel_ids !== null && !JSON.parse(principal.channel_ids).includes(value.channelId)) ||
        !JSON.parse(tenant.data).channels?.some(channel => channel.id === value.channelId)) invalid();
    return Object.freeze({ tenantId: value.tenantId, principalId: value.principalId, channelId: value.channelId, replyLimitPerHour: value.replyLimitPerHour });
  }));
}

/** Only this pre-reservation guardrail may advertise an operation as not admitted. */
export class ServiceReplyRateLimitError extends Error {
  constructor(limit, retryAfter, { window = 'hour', notice = '' } = {}) {
    super(window === 'minute' ? `O agente já enviou ${limit} respostas nesta conversa no último minuto. Aguarde ou transfira para a equipe.`
      : `O agente já enviou ${limit} respostas nesta conversa na última hora. Transfira para a equipe ou aguarde.`);
    this.name = 'ServiceReplyRateLimitError';
    Object.defineProperties(this, {
      status: { value: 429, enumerable: true },
      code: { value: 'SERVICE_REPLY_RATE_LIMIT', enumerable: true },
      admissionRejected: { value: true, enumerable: true },
      retryAfter: { value: retryAfter, enumerable: true },
      rateLimit: { value: Object.freeze({ window, max: limit }), enumerable: true },
      notice: { value: notice, enumerable: false }
    });
    this.noticeSent = false;
  }
}

/**
 * Channel reply policy, a product setting of the company administrator. 'attendance' keeps the support default (and the
 * private operator overrides); 'assistant' is a product assistant: a per-conversation hourly limit chosen by the channel
 * owner, a per-minute burst guard and an optional short notice the platform sends once per window when the limit is hit.
 * Conversations the administrator marks as team/QA skip the hourly limit and keep only the loop guard.
 */
export const REPLY_PROFILES = Object.freeze(['attendance', 'assistant']);
export const SERVICE_REPLY_LOOP_GUARD_PER_MINUTE = 60;
export function channelReplyPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['profile', 'perHour', 'perMinute', 'notice'].includes(key))) fail(400, 'Informe somente profile, perHour, perMinute e notice.');
  if (!REPLY_PROFILES.includes(input.profile)) fail(400, 'Escolha o perfil atendimento ou assistente de produto.');
  if (input.profile === 'attendance') {
    if (Object.keys(input).length !== 1) fail(400, 'O perfil de atendimento usa os limites padrão; não informe outros campos.');
    return null;
  }
  const perHour = input.perHour ?? 120, perMinute = input.perMinute ?? 12, notice = input.notice ?? '';
  if (!Number.isSafeInteger(perHour) || perHour < 6 || perHour > 1000) fail(400, 'Use de 6 a 1000 respostas por hora.');
  if (!Number.isSafeInteger(perMinute) || perMinute < 1 || perMinute > SERVICE_REPLY_LOOP_GUARD_PER_MINUTE || perMinute > perHour) fail(400, `Use de 1 a ${SERVICE_REPLY_LOOP_GUARD_PER_MINUTE} respostas por minuto, sem passar do limite por hora.`);
  if (typeof notice !== 'string' || notice.length > 280 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notice)) fail(400, 'Use um aviso de até 280 caracteres.');
  return Object.freeze({ profile: 'assistant', perHour, perMinute, notice: notice.trim() });
}
