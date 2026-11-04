import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 600, CLOCK_TOLERANCE_SECONDS = 60, PREVIOUS_KEY_MS = 660_000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,160}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (code, status = 401) => Object.assign(new Error({ identity_expired: 'A identidade expirou. Solicite um novo token.', identity_replay: 'Este token de identidade já foi utilizado.',
  identity_origin_denied: 'A origem não está autorizada para este canal.', identity_revoked: 'A identidade perdeu validade.', identity_configchanged: 'A configuração da identidade mudou.',
  identity_account_changed: 'A conta mudou. Encerre a sessão antes de iniciar outra.', identity_storage_unavailable: 'O armazenamento de identidade está indisponível.',
  identity_authority_changed: 'A autorização administrativa mudou.', identity_rotation_pending: 'A chave anterior ainda está válida. Aguarde ou revogue essa chave.' }[code] || 'A identidade ou configuração informada é inválida.'), { code, status });
const deny = (code, status) => { throw error(code, status); };
const fields = (input, allowed) => { if (!plain(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key))) deny('identity_invalid_configuration', 400); };
const sync = value => { if (value?.then) { Promise.resolve(value).catch(() => {}); deny('identity_storage_unavailable', 503); } return value; };
const label = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && value === value.toWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const pagePath = value => typeof value === 'string' && value.length <= 512 && /^\/[A-Za-z0-9._~/-]*$/.test(value) && !value.includes('//')
  && !value.split('/').some(segment => segment === '.' || segment === '..')
  && !/(?:^|\/)(?:token|secret|password|passwd|senha|segredo|reset-password|verify-email|accept-invite|oauth|callback)(?:\/|$)/i.test(value);
const publicContext = value => plain(value) && !Object.keys(value).some(key => !['teamId', 'teamName', 'plan', 'mailboxes', 'accountName', 'product', 'pagePath'].includes(key))
  && (value.teamId === undefined || opaque(value.teamId)) && (value.teamName === undefined || label(value.teamName, 160))
  && (value.plan === undefined || label(value.plan, 80)) && (value.mailboxes === undefined || Number.isSafeInteger(value.mailboxes) && value.mailboxes >= 0 && value.mailboxes <= 100_000)
  && (value.accountName === undefined || label(value.accountName, 160)) && (value.product === undefined || label(value.product, 80))
  && (value.pagePath === undefined || pagePath(value.pagePath));
// The v2 marker contains '~', which a legacy subject can never contain. The
// domain-separated tuple also prevents account/subject delimiter collisions.
const externalIdOf = (config, version, accountId, subject) => version === 2
  ? `${config.externalIdPrefix}:v2~${hash('elozi:webchat:account-user:v2\0' + JSON.stringify([config.externalIdPrefix, accountId, subject]))}`
  : `${config.externalIdPrefix}:${subject}`;
const persistedClaims = proof => ({ externalId: proof.externalId, verified: true, email: proof.email, email_verified: true, name: proof.name, locale: proof.locale, ctx: proof.ctx,
  issuer: proof.issuer, subject: proof.subject, v: proof.v, ...(proof.v === 2 ? { accountId: proof.accountId } : {}) });
const originOf = value => {
  let parsed; try { parsed = new URL(value); } catch { deny('identity_origin_denied', 403); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (typeof value !== 'string' || value.length > 240 || parsed.origin !== value || parsed.username || parsed.password || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && local)) deny('identity_origin_denied', 403);
  return value;
};

// Reject duplicate members before using a JWT: all claims have exactly one interpretation.
function jsonSegment(segment, max) {
  try {
    if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) throw 0;
    const bytes = Buffer.from(segment, 'base64url');
    if (!bytes.length || bytes.length > max || bytes.toString('base64url') !== segment) throw 0;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed = JSON.parse(source);
    let position = 0;
    const whitespace = () => { while (/\s/.test(source[position] || '') && position < source.length) position++; };
    const string = () => { const start = position++; while (position < source.length) { if (source[position] === '\\') { position += 2; continue; } if (source[position++] === '"') return JSON.parse(source.slice(start, position)); } throw 0; };
    const scan = depth => {
      if (depth > 8) throw 0; whitespace();
      if (source[position] === '{') {
        position++; whitespace(); const names = new Set();
        while (source[position] !== '}') {
          if (source[position] !== '"') throw 0; const name = string(); if (names.has(name)) throw 0; names.add(name); whitespace();
          if (source[position++] !== ':') throw 0; scan(depth + 1); whitespace(); if (source[position] !== ',') break; position++; whitespace();
        }
        if (source[position++] !== '}') throw 0;
      } else if (source[position] === '[') {
        position++; whitespace(); while (source[position] !== ']') { scan(depth + 1); whitespace(); if (source[position] !== ',') break; position++; }
        if (source[position++] !== ']') throw 0;
      } else if (source[position] === '"') string();
      else { while (position < source.length && !/[\s,}\]]/.test(source[position])) position++; }
    };
    scan(0); whitespace(); if (position !== source.length || !plain(parsed)) throw 0;
    return parsed;
  } catch { deny('identity_invalid'); }
}

/** JWT proofs and bindings are private operational data; signing keys only enter the encrypted channel envelope. */
export class WebchatIdentity {
  #store; #db; #secrets; #channelContext; #now; #proofs = new WeakMap(); #savepoint = 0;
  constructor(store, { secrets, channelContext, now = Date.now } = {}) {
    if (!store?.db || typeof store.mutate !== 'function' || typeof secrets?.get !== 'function' || typeof secrets?.set !== 'function' || typeof channelContext !== 'function' || typeof now !== 'function') deny('identity_invalid_configuration', 400);
    this.#store = store; this.#db = store.db; this.#secrets = secrets; this.#channelContext = channelContext; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS webchat_identity_jti (
      tenant_id TEXT NOT NULL REFERENCES tenants(id), channel_id TEXT NOT NULL, jti_hash TEXT NOT NULL,
      kid TEXT NOT NULL, identity_version INTEGER NOT NULL, external_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id,channel_id,jti_hash));
      CREATE INDEX IF NOT EXISTS webchat_identity_jti_expiry ON webchat_identity_jti(expires_at);
      CREATE TABLE IF NOT EXISTS webchat_identity_sessions (
      session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), channel_id TEXT NOT NULL,
      origin TEXT NOT NULL, issuer TEXT NOT NULL, external_id TEXT NOT NULL, kid TEXT NOT NULL, jti_hash TEXT NOT NULL,
      identity_version INTEGER NOT NULL, claims TEXT NOT NULL, verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      revoked_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS webchat_identity_session_jti ON webchat_identity_sessions(tenant_id,channel_id,jti_hash);
      CREATE INDEX IF NOT EXISTS webchat_identity_session_scope ON webchat_identity_sessions(tenant_id,channel_id,session_id);
      CREATE INDEX IF NOT EXISTS webchat_identity_session_contact ON webchat_identity_sessions(tenant_id,channel_id,external_id);
      CREATE INDEX IF NOT EXISTS webchat_identity_session_expiry ON webchat_identity_sessions(expires_at);`);
  }
  transaction(action) {
    if (typeof action !== 'function') deny('identity_invalid_configuration', 400);
    const name = `webchat_identity_${++this.#savepoint}`; this.#db.exec(`SAVEPOINT ${name}`);
    try { const result = sync(action()); this.#db.exec(`RELEASE ${name}`); return result; }
    catch (failure) { this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`); throw failure; }
  }
  #context(input) {
    if (!id(input.tenantId) || !id(input.channelId)) deny('identity_invalid');
    const result = sync(this.#channelContext(input));
    if (!plain(result) || result.tenant?.id !== input.tenantId || result.channel?.id !== input.channelId || result.channel.kind !== 'webchat'
      || !result.tenant.channels?.some(channel => channel.id === input.channelId && channel.kind === 'webchat')) deny('identity_invalid');
    if (input.origin !== undefined) {
      const origin = originOf(input.origin);
      if (result.origin !== undefined && result.origin !== origin || result.channel.transport !== 'elozi-webchat' || result.channel.state !== 'connected' || result.channel.webchat?.enabled !== true
        || !result.channel.webchat.origins?.includes(origin)) deny('identity_origin_denied', 403);
      return { ...result, origin };
    }
    return result;
  }
  #config(context) {
    const config = context.channel.webchat?.identity;
    return plain(config) ? { ...config, scope: config.scope ?? 'user' } : { version: 0, identityVersion: 0, enabled: false, issuer: null, externalIdPrefix: 'mepmail', scope: 'user', keys: [] };
  }
  #envelope(context) {
    let envelope; try { envelope = sync(this.#secrets.get(context.channel.id)) ?? {}; } catch { deny('identity_storage_unavailable', 503); }
    if (!plain(envelope) || envelope.webchatIdentity !== undefined && (!plain(envelope.webchatIdentity) || envelope.webchatIdentity.tenantId !== context.tenant.id || envelope.webchatIdentity.channelId !== context.channel.id)) deny('identity_storage_unavailable', 503);
    return envelope;
  }
  #keys(context) {
    const privateConfig = this.#envelope(context).webchatIdentity;
    const config = this.#config(context);
    if (!privateConfig) return [];
    if (!Array.isArray(privateConfig.keys) || privateConfig.keys.length > 64 || privateConfig.identityVersion !== config.identityVersion || privateConfig.version !== config.version) deny('identity_configchanged', 409);
    return privateConfig.keys;
  }
  #active(key, at = this.#now()) { return plain(key) && key.revokedAt === null && (key.validUntil === null || Number.isSafeInteger(key.validUntil) && key.validUntil > at) && typeof key.secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.secret); }
  #key(context, kid) {
    const key = this.#keys(context).find(value => value.kid === kid);
    if (!key || !this.#active(key)) deny('identity_revoked', 403);
    return key;
  }
  #metadata(config, keys) {
    return { version: config.version, identityVersion: config.identityVersion, enabled: config.enabled, issuer: config.issuer, externalIdPrefix: config.externalIdPrefix, scope: config.scope,
      keys: keys.map(key => ({ kid: key.kid, createdAt: key.createdAt, validUntil: key.validUntil, revokedAt: key.revokedAt,
        state: key.revokedAt !== null ? 'revoked' : this.#active(key) ? 'active' : 'expired', current: key.kid === config.currentKid })), currentKid: config.currentKid ?? null };
  }
  #authority(actor, reauthorize) {
    if (typeof reauthorize !== 'function' || actor?.kind === 'service' || actor?.supportGrantId) deny('identity_authority_changed', 403);
    const result = reauthorize(); if (result?.then) { Promise.resolve(result).catch(() => {}); deny('identity_authority_changed', 403); }
    const current = plain(result) ? result : actor;
    if (result !== undefined && result !== true && !plain(result) || current?.userId !== actor?.userId || current?.resellerId !== actor?.resellerId || current?.role !== actor?.role) deny('identity_authority_changed', 403);
    try { this.#store.admin(current); } catch { deny('identity_authority_changed', 403); }
    return current;
  }
  status(actor, tenantId, channelId, input = {}, { reauthorize } = {}) {
    fields(input, []); const current = this.#authority(actor, reauthorize), context = this.#context({ actor: current, tenantId, channelId }), config = this.#config(context), keys = this.#keys(context);
    return { tenantId, channelId, ...this.#metadata(config, keys), configured: keys.some(key => this.#active(key)), audience: `elozi:webchat:${channelId}`, maxTokenAgeSeconds: MAX_AGE_SECONDS, clockToleranceSeconds: CLOCK_TOLERANCE_SECONDS };
  }
  #change(actor, tenantId, channelId, input, reauthorize, change) {
    const current = this.#authority(actor, reauthorize), context = this.#context({ actor: current, tenantId, channelId }), previous = this.#config(context);
    if (!Number.isSafeInteger(input.version) || input.version !== previous.version) deny('identity_configchanged', 409);
    let revealed;
    this.#store.mutate(current, tenantId, 'Webchat: identidade verificada atualizada', tenant => {
      this.#authority(actor, reauthorize);
      const channel = tenant.channels.find(item => item.id === channelId && item.kind === 'webchat');
      if (!channel || (channel.webchat?.identity?.version ?? 0) !== previous.version) deny('identity_configchanged', 409);
      const fresh = { tenant, channel }, envelope = this.#envelope(fresh), config = { ...this.#config(fresh) }, keys = this.#keys(fresh).map(key => ({ ...key }));
      revealed = change(config, keys, fresh); config.version++;
      channel.webchat ||= {}; channel.webchat.identity = this.#metadata(config, keys);
      try { sync(this.#secrets.set(channelId, { ...envelope, webchatIdentity: { tenantId, channelId, version: config.version, identityVersion: config.identityVersion, keys } })); }
      catch { deny('identity_storage_unavailable', 503); }
    });
    const result = this.status(actor, tenantId, channelId, {}, { reauthorize });
    return revealed ? { ...result, ...revealed } : result;
  }
  configure(actor, tenantId, channelId, input, { reauthorize } = {}) {
    fields(input, ['version', 'enabled', 'issuer', 'externalIdPrefix', 'scope']);
    return this.#change(actor, tenantId, channelId, input, reauthorize, (config, keys, context) => {
      const issuer = input.issuer ?? config.issuer, enabled = input.enabled ?? config.enabled, prefix = input.externalIdPrefix ?? config.externalIdPrefix, scope = Object.hasOwn(input, 'scope') ? input.scope : config.scope;
      if (typeof enabled !== 'boolean' || typeof prefix !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(prefix) || !['user', 'account-user'].includes(scope)) deny('identity_invalid_configuration', 400);
      try { originOf(issuer); } catch { deny('identity_invalid_configuration', 400); }
      if (!context.channel.webchat?.origins?.includes(issuer)) deny('identity_invalid_configuration', 400);
      if (issuer !== config.issuer || prefix !== config.externalIdPrefix || enabled !== config.enabled || scope !== config.scope) config.identityVersion++;
      Object.assign(config, { issuer, enabled, externalIdPrefix: prefix, scope });
    });
  }
  #newKey(config, keys, rotate) {
    if (!config.issuer || !Number.isSafeInteger(config.identityVersion) || config.identityVersion < 1) deny('identity_invalid_configuration', 400);
    const now = this.#now(), active = keys.filter(key => this.#active(key, now));
    if (rotate && active.length !== 1 || !rotate && active.length !== 0) deny('identity_rotation_pending', 409);
    if (keys.length >= 64) deny('identity_invalid_configuration', 400);
    if (rotate) active[0].validUntil = Math.min(active[0].validUntil ?? now + PREVIOUS_KEY_MS, now + PREVIOUS_KEY_MS);
    const kid = randomUUID(), secret = randomBytes(32).toString('base64url');
    keys.push({ kid, secret, createdAt: now, validUntil: null, revokedAt: null }); config.currentKid = kid;
    return { kid, secret };
  }
  createKey(actor, tenantId, channelId, input, { reauthorize } = {}) { fields(input, ['version']); return this.#change(actor, tenantId, channelId, input, reauthorize, (config, keys) => this.#newKey(config, keys, false)); }
  rotateKey(actor, tenantId, channelId, input, { reauthorize } = {}) { fields(input, ['version']); return this.#change(actor, tenantId, channelId, input, reauthorize, (config, keys) => this.#newKey(config, keys, true)); }
  revokeKey(actor, tenantId, channelId, input, { reauthorize } = {}) {
    fields(input, ['version', 'kid']); if (!id(input.kid)) deny('identity_invalid_configuration', 400);
    return this.#change(actor, tenantId, channelId, input, reauthorize, (config, keys) => {
      const key = keys.find(value => value.kid === input.kid); if (!key) deny('identity_invalid_configuration', 400);
      key.revokedAt ??= this.#now(); delete key.secret;
      this.#db.prepare('UPDATE webchat_identity_sessions SET revoked_at=? WHERE tenant_id=? AND channel_id=? AND kid=? AND revoked_at IS NULL').run(this.#now(), tenantId, channelId, input.kid);
    });
  }
  #claims(payload, config, channelId) {
    if (!plain(payload) || Object.keys(payload).some(key => !['iss', 'aud', 'sub', 'email', 'email_verified', 'name', 'locale', 'iat', 'exp', 'jti', 'ctx', 'v', 'accountId'].includes(key))
      || payload.iss !== config.issuer || payload.aud !== `elozi:webchat:${channelId}` || !opaque(payload.sub) || !opaque(payload.jti) || payload.jti.length < 8
      || payload.email_verified !== true || !label(payload.name, 120) || !['pt-BR', 'en'].includes(payload.locale)
      || typeof payload.email !== 'string' || payload.email.length > 254 || !/^[^\s@<>"\\]+@[^\s@<>"\\]+\.[^\s@<>"\\]+$/.test(payload.email)
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat < 0 || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_AGE_SECONDS) deny('identity_invalid');
    const version = Object.hasOwn(payload, 'v') ? payload.v : 1;
    if (![1, 2].includes(version) || version === 2 && !opaque(payload.accountId) || version === 1 && Object.hasOwn(payload, 'accountId')
      || !['user', 'account-user'].includes(config.scope) || config.scope === 'account-user' && version !== 2) deny('identity_invalid');
    const seconds = Math.floor(this.#now() / 1000);
    if (payload.iat > seconds + CLOCK_TOLERANCE_SECONDS) deny('identity_invalid');
    if (payload.exp <= seconds - CLOCK_TOLERANCE_SECONDS) deny('identity_expired');
    const ctx = payload.ctx ?? {};
    if (!publicContext(ctx)) deny('identity_invalid');
    return { externalId: externalIdOf(config, version, payload.accountId, payload.sub), v: version, ...(version === 2 ? { accountId: payload.accountId } : {}), verified: true, email: payload.email.toLowerCase(), email_verified: true, name: payload.name, locale: payload.locale,
      ctx: { ...ctx }, issuer: payload.iss, subject: payload.sub, issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000, identityVersion: config.identityVersion, jtiHash: hash(`${payload.iss}\0${payload.jti}`) };
  }
  #verify({ tenantId, channelId, origin, identityToken }) {
    if (typeof identityToken !== 'string' || identityToken.length > 8192 || identityToken.length < 60) deny('identity_invalid');
    const context = this.#context({ tenantId, channelId, origin }), config = this.#config(context);
    if (config.enabled !== true) deny('identity_revoked', 403);
    const parts = identityToken.split('.'); if (parts.length !== 3) deny('identity_invalid');
    const header = jsonSegment(parts[0], 512), payload = jsonSegment(parts[1], 5000);
    if (Object.keys(header).some(key => !['alg', 'kid', 'typ'].includes(key)) || header.alg !== 'HS256' || !id(header.kid) || header.typ !== undefined && header.typ !== 'JWT'
      || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) deny('identity_invalid');
    const key = this.#key(context, header.kid), signature = Buffer.from(parts[2], 'base64url'), expected = createHmac('sha256', key.secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (signature.length !== expected.length || signature.toString('base64url') !== parts[2] || !timingSafeEqual(signature, expected)) deny('identity_invalid');
    const claims = this.#claims(payload, config, channelId);
    return { ...claims, kid: header.kid, tenantId, channelId, origin: context.origin };
  }
  #consume(verified) {
    const inserted = this.#db.prepare('INSERT INTO webchat_identity_jti VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,channel_id,jti_hash) DO NOTHING')
      .run(verified.tenantId, verified.channelId, verified.jtiHash, verified.kid, verified.identityVersion, verified.externalId, verified.issuedAt, verified.expiresAt + CLOCK_TOLERANCE_SECONDS * 1000, this.#now());
    if (inserted.changes !== 1) deny('identity_replay', 409);
    const result = { ...verified, ctx: Object.freeze({ ...verified.ctx }) }; Object.freeze(result); this.#proofs.set(result, { ...verified }); return result;
  }
  verifyAndConsume(input) {
    fields(input, ['tenantId', 'channelId', 'origin', 'identityToken']);
    if (input.identityToken === undefined || input.identityToken === null || input.identityToken === '') return null;
    return this.transaction(() => this.#consume(this.#verify(input)));
  }
  bindSession(sessionId, verifiedClaims, { tenantId, channelId, origin, expiresAt } = {}) {
    if (!id(sessionId)) deny('identity_invalid');
    const proof = this.#proofs.get(verifiedClaims);
    if (!proof || proof.tenantId !== tenantId || proof.channelId !== channelId || proof.origin !== origin) deny('identity_invalid');
    return this.transaction(() => {
      const context = this.#context({ tenantId, channelId, origin }), config = this.#config(context); this.#key(context, proof.kid);
      if (config.enabled !== true || proof.identityVersion !== config.identityVersion || proof.issuer !== config.issuer) deny('identity_configchanged', 409);
      if (proof.expiresAt <= this.#now() - CLOCK_TOLERANCE_SECONDS * 1000) deny('identity_expired');
      const consumed = this.#db.prepare('SELECT external_id,kid,identity_version FROM webchat_identity_jti WHERE tenant_id=? AND channel_id=? AND jti_hash=?').get(tenantId, channelId, proof.jtiHash);
      if (!consumed || consumed.external_id !== proof.externalId || consumed.kid !== proof.kid || consumed.identity_version !== proof.identityVersion) deny('identity_invalid');
      const until = Math.min(expiresAt ?? proof.expiresAt + CLOCK_TOLERANCE_SECONDS * 1000, proof.expiresAt + CLOCK_TOLERANCE_SECONDS * 1000);
      if (!Number.isSafeInteger(until) || until <= this.#now() || until > this.#now() + 24 * 3600_000) deny('identity_invalid');
      const prior = this.#db.prepare('SELECT 1 FROM webchat_identity_sessions WHERE session_id=?').get(sessionId); if (prior) deny('identity_replay', 409);
      if (this.#db.prepare('SELECT 1 FROM webchat_identity_sessions WHERE tenant_id=? AND channel_id=? AND jti_hash=?').get(tenantId, channelId, proof.jtiHash)) deny('identity_replay', 409);
      this.#db.prepare('INSERT INTO webchat_identity_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)').run(sessionId, tenantId, channelId, origin, proof.issuer, proof.externalId, proof.kid, proof.jtiHash, proof.identityVersion,
        JSON.stringify(persistedClaims(proof)), this.#now(), until);
      return this.sessionIdentity(sessionId, { tenantId, channelId, origin });
    });
  }
  sessionIdentity(sessionId, { tenantId, channelId, origin, allowExpired = false } = {}) {
    if (!id(sessionId) || typeof allowExpired !== 'boolean') deny('identity_invalid');
    const row = this.#db.prepare('SELECT * FROM webchat_identity_sessions WHERE session_id=?').get(sessionId); if (!row) return null;
    if (row.tenant_id !== tenantId || row.channel_id !== channelId || row.origin !== origin) deny('identity_invalid');
    if (row.revoked_at !== null) deny('identity_revoked', 403);
    const context = this.#context({ tenantId, channelId, origin }), config = this.#config(context);
    if (config.enabled !== true) deny('identity_revoked', 403);
    if (row.identity_version !== config.identityVersion || row.issuer !== config.issuer) deny('identity_configchanged', 409);
    this.#key(context, row.kid);
    if (!allowExpired && row.expires_at <= this.#now()) deny('identity_expired');
    let claims; try { claims = JSON.parse(row.claims); } catch { deny('identity_storage_unavailable', 503); }
    if (!plain(claims) || claims.externalId !== row.external_id || claims.issuer !== row.issuer || claims.verified !== true || claims.email_verified !== true || !opaque(claims.subject)
      || !label(claims.email, 254) || !label(claims.name, 120) || !['pt-BR', 'en'].includes(claims.locale) || !publicContext(claims.ctx)) deny('identity_storage_unavailable', 503);
    const version = Object.hasOwn(claims, 'v') ? claims.v : 1;
    if (![1, 2].includes(version) || version === 2 && !opaque(claims.accountId) || version === 1 && Object.hasOwn(claims, 'accountId')
      || !['user', 'account-user'].includes(config.scope) || config.scope === 'account-user' && version !== 2
      || externalIdOf(config, version, claims.accountId, claims.subject) !== row.external_id) deny('identity_storage_unavailable', 503);
    return { externalId: row.external_id, verified: true, email: claims.email, email_verified: true, name: claims.name, locale: claims.locale, ctx: { ...claims.ctx }, issuer: row.issuer, subject: claims.subject,
      v: version, ...(version === 2 ? { accountId: claims.accountId } : {}), kid: row.kid, jtiHash: row.jti_hash, identityVersion: row.identity_version, verifiedAt: row.verified_at, expiresAt: row.expires_at };
  }
  renewSession(sessionId, input, { expiresAt } = {}) {
    fields(input, ['tenantId', 'channelId', 'origin', 'identityToken']);
    return this.transaction(() => {
      const previous = this.sessionIdentity(sessionId, { ...input, allowExpired: true }); if (!previous) deny('identity_invalid');
      const fresh = this.#verify(input); if (fresh.v !== previous.v || fresh.accountId !== previous.accountId || fresh.subject !== previous.subject || fresh.externalId !== previous.externalId) deny('identity_account_changed', 409);
      const verified = this.#consume(fresh), until = Math.min(expiresAt ?? fresh.expiresAt + CLOCK_TOLERANCE_SECONDS * 1000, fresh.expiresAt + CLOCK_TOLERANCE_SECONDS * 1000);
      if (!Number.isSafeInteger(until) || until <= this.#now() || until > this.#now() + 24 * 3600_000) deny('identity_invalid');
      this.#db.prepare('UPDATE webchat_identity_sessions SET kid=?,jti_hash=?,claims=?,verified_at=?,expires_at=? WHERE session_id=? AND tenant_id=? AND channel_id=? AND revoked_at IS NULL')
        .run(verified.kid, verified.jtiHash, JSON.stringify(persistedClaims(verified)), this.#now(), until, sessionId, input.tenantId, input.channelId);
      return this.sessionIdentity(sessionId, input);
    });
  }
  revokeSession(sessionId, { tenantId, channelId, origin } = {}) {
    if (!id(sessionId)) deny('identity_invalid');
    const row = this.#db.prepare('SELECT tenant_id,channel_id,origin FROM webchat_identity_sessions WHERE session_id=?').get(sessionId); if (!row) return { revoked: false };
    if (row.tenant_id !== tenantId || row.channel_id !== channelId || row.origin !== origin) deny('identity_invalid');
    return { revoked: this.#db.prepare('UPDATE webchat_identity_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL').run(this.#now(), sessionId).changes === 1 };
  }
}

export const createWebchatIdentity = (store, options) => new WebchatIdentity(store, options);
