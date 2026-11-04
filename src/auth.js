import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ensureProfileSchema, profileOf, updateUserProfile, validateProfileAvatar } from './profile.js';
import { BUSINESS_PERMISSIONS, accessOf, allowedFields, effectivePermissions, ensureAccessSchema,
  normalizePermissions, normalizePresence, normalizeScopeRules, scopeAllows } from './access.js';

const derive = promisify(scrypt);
const passwordOptions = { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16, 90), dummyHash = Buffer.alloc(64);
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const passwordFingerprint = row => createHash('sha256').update(row.password_version).update(Buffer.from(row.password_salt)).update(Buffer.from(row.password_hash)).digest('hex');
const canonical = value => JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const fail = (status, message, detail = {}) => { throw Object.assign(new Error(message), { status, ...detail }); };
const unauthenticated = () => fail(401, 'Sessão inválida ou expirada. Entre novamente.');
// Signup locale chosen on the public page; anything else keeps the historical pt-BR default.
const signupLocale = value => value === 'en' ? 'en' : null;

function username(value) {
  if (typeof value !== 'string') fail(400, 'Informe seu usuário.');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) fail(400, 'Use de 3 a 64 letras, números, pontos, traços ou sublinhados no usuário.');
  return normalized;
}
function password(value, creating = false) {
  if (typeof value !== 'string' || value.length < (creating ? 8 : 1) || value.length > 128) fail(400, creating ? 'Escolha uma senha entre 8 e 128 caracteres.' : 'Informe uma senha válida.');
  if (creating && (!/\p{Lu}/u.test(value) || !/[^\p{L}\p{N}\s]/u.test(value))) fail(400, 'Inclua uma letra maiúscula e um caractere especial na senha.');
  return value; // Espaços e caracteres escolhidos pelo usuário são preservados.
}
function email(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, 'Informe seu e-mail.');
    return null;
  }
  if (typeof value !== 'string') fail(400, 'Informe um e-mail válido.');
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(normalized) || normalized.startsWith('.') || normalized.split('@')[0].endsWith('.') || normalized.includes('..')) fail(400, 'Informe um e-mail válido.');
  return normalized;
}
function displayName(value, field = 'nome') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail(400, `Informe um ${field} entre 1 e 80 caracteres.`);
  return value.trim();
}
function userInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Informe os dados do usuário.');
  return { username: username(input.username), password: password(input.password, true), name: displayName(input.name), email: email(input.email) };
}
function googleProfile(profile) {
  // Esta interface recebe somente claims já verificados criptograficamente pelo servidor.
  if (!profile || typeof profile !== 'object' || typeof profile.sub !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,255}$/.test(profile.sub) || profile.email_verified !== true) fail(401, 'Não foi possível confirmar sua conta Google.');
  return { sub: profile.sub, email: email(profile.email, true), name: displayName(profile.name) };
}
function memberships(value, role) {
  if (value === undefined) value = [];
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 120 || /[\x00-\x1f\x7f]/.test(id))) fail(400, 'Informe uma lista válida de empresas.');
  const ids = [...new Set(value)];
  if (role === 'operator' && !ids.length) fail(400, 'Vincule o atendente a pelo menos uma empresa.');
  if (role === 'reseller' && ids.length) fail(400, 'O administrador da revenda não usa uma lista de empresas restritas.');
  return ids;
}

export class Auth {
  constructor(db, { allowSetup = true, resellerId = 'mep-demo', sessionTtlMs = 8 * 3600000, now = Date.now, maxAttempts = 3, backoffMs = 1000, maxBackoffMs = 60000, validateTenant, invitationKey, registrationTrial, planQuota = null } = {}) {
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 30 * 86400000) throw new Error('Prazo de sessão inválido.');
    if (typeof now !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(backoffMs) || backoffMs < 1 || !Number.isFinite(maxBackoffMs) || maxBackoffMs < backoffMs) throw new Error('Configuração de autenticação inválida.');
    if (validateTenant !== undefined && (typeof validateTenant !== 'function' || validateTenant.constructor?.name === 'AsyncFunction')) throw new Error('A validação de empresas precisa ser síncrona.');
    this.db = db; this.allowSetup = allowSetup; this.resellerId = resellerId; this.sessionTtlMs = sessionTtlMs; this.now = now;
    this.validateTenant = validateTenant;
    this.invitationKey = invitationKey;
    // Optional plan quota guard (commercial-usage.js PlanQuotaGuard); null keeps the historical behaviour.
    this.planQuota = planQuota;
    if (registrationTrial !== undefined && (!registrationTrial || ['prepare', 'reserve'].some(method => typeof registrationTrial[method] !== 'function'))) throw new Error('O cadastro público exige um serviço de teste válido.');
    this.registrationTrial = registrationTrial;
    this.maxAttempts = maxAttempts; this.backoffMs = backoffMs; this.maxBackoffMs = maxBackoffMs;
    this.attempts = new Map(); this.loggingIn = new Set();
    db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('reseller','operator')), reseller_id TEXT NOT NULL,
      tenant_ids TEXT NOT NULL, password_salt BLOB NOT NULL, password_hash BLOB NOT NULL,
      password_version TEXT NOT NULL DEFAULT 'scrypt-v1', created_at INTEGER NOT NULL, disabled_at INTEGER
    ); CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    ); CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);`);
    const columns = new Set(db.prepare('PRAGMA table_info(auth_users)').all().map(column => column.name));
    if (!columns.has('email')) db.exec('ALTER TABLE auth_users ADD COLUMN email TEXT');
    if (!columns.has('email_verified')) db.exec('ALTER TABLE auth_users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1))');
    if (!columns.has('platform_admin')) {
      db.exec('ALTER TABLE auth_users ADD COLUMN platform_admin INTEGER NOT NULL DEFAULT 0 CHECK(platform_admin IN (0,1))');
      db.prepare("UPDATE auth_users SET platform_admin=1 WHERE id=(SELECT id FROM auth_users WHERE reseller_id=? AND role='reseller' ORDER BY created_at,rowid LIMIT 1)").run(this.resellerId);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS auth_platform_admin_unique ON auth_users(platform_admin) WHERE platform_admin=1;
      CREATE TABLE IF NOT EXISTS auth_workspace_access (
        user_id TEXT NOT NULL REFERENCES auth_users(id), reseller_id TEXT NOT NULL REFERENCES resellers(id),
        created_at INTEGER NOT NULL, PRIMARY KEY(user_id,reseller_id)
      );`);
    ensureProfileSchema(db);
    ensureAccessSchema(db);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email ON auth_users(email COLLATE NOCASE) WHERE email IS NOT NULL;
      CREATE TABLE IF NOT EXISTS auth_google_identities (
        provider TEXT NOT NULL DEFAULT 'google' CHECK(provider='google'), subject TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES auth_users(id), created_at INTEGER NOT NULL
      ); CREATE TABLE IF NOT EXISTS auth_email_challenges (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), email TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose='verify'), created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, consumed_at INTEGER
      ); CREATE INDEX IF NOT EXISTS auth_email_challenges_user ON auth_email_challenges(user_id);`);
    const googleColumns = new Set(db.prepare('PRAGMA table_info(auth_google_identities)').all().map(column => column.name));
    if (!googleColumns.has('email')) {
      db.exec('ALTER TABLE auth_google_identities ADD COLUMN email TEXT');
      // Vínculos anteriores exigiam o mesmo e-mail da conta; preserve essa reserva ao migrar.
      db.exec('UPDATE auth_google_identities SET email=(SELECT email FROM auth_users WHERE auth_users.id=auth_google_identities.user_id)');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS auth_google_email ON auth_google_identities(email COLLATE NOCASE) WHERE email IS NOT NULL');
    db.exec(`CREATE TABLE IF NOT EXISTS auth_session_ids (
        token_hash TEXT PRIMARY KEY REFERENCES auth_sessions(token_hash), id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS auth_invitations (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_secret TEXT NOT NULL, reseller_id TEXT NOT NULL,
        creator_id TEXT NOT NULL REFERENCES auth_users(id), creator_access TEXT NOT NULL,
        request_id TEXT NOT NULL, request_payload TEXT NOT NULL, name TEXT, email TEXT, role TEXT NOT NULL CHECK(role IN ('reseller','operator')),
        tenant_ids TEXT NOT NULL, permissions TEXT, scope_rules TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
        accepted_at INTEGER, accepted_user_id TEXT REFERENCES auth_users(id)
      ); CREATE INDEX IF NOT EXISTS auth_invitations_workspace ON auth_invitations(reseller_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS auth_invitations_request ON auth_invitations(creator_id,reseller_id,request_id);
      CREATE TABLE IF NOT EXISTS auth_password_resets (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), email TEXT NOT NULL,
        password_snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      ); CREATE INDEX IF NOT EXISTS auth_password_resets_user ON auth_password_resets(user_id,created_at);`);
    if(!db.prepare('PRAGMA table_info(auth_invitations)').all().some(column=>column.name==='issuer_workspace_id'))db.exec('ALTER TABLE auth_invitations ADD COLUMN issuer_workspace_id TEXT');
    for (const row of db.prepare('SELECT token_hash FROM auth_sessions WHERE NOT EXISTS (SELECT 1 FROM auth_session_ids WHERE auth_session_ids.token_hash=auth_sessions.token_hash)').all()) this.db.prepare('INSERT OR IGNORE INTO auth_session_ids VALUES (?,?)').run(row.token_hash,randomUUID());
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: auth_(users|google_identities)/.test(error.message)) fail(409, 'Este usuário, e-mail ou vínculo Google já está cadastrado.');
      throw error;
    }
  }
  status() { return { setupRequired: !this.db.prepare('SELECT 1 FROM auth_users WHERE platform_admin=1 LIMIT 1').get() }; }
  actor(row) {
    const tenantIds = JSON.parse(row.tenant_ids);
    return { userId: row.id, role: row.role, name: row.name, email: row.email, emailVerified: Boolean(row.email_verified), platformAdmin: Boolean(row.platform_admin), avatar: row.avatar ?? null, locale: profileOf(row).locale, resellerId: row.reseller_id, tenantIds, ...accessOf(row), ...(row.supportGrantId?{supportGrantId:row.supportGrantId,supportExpiresAt:row.supportExpiresAt,supportReason:row.supportReason}:{}), ...(row.role === 'operator' && tenantIds.length === 1 ? { tenantId: tenantIds[0] } : {}) };
  }
  metadata(row) {
    return { id: row.id, username: row.username, name: row.name, email: row.email, emailVerified: Boolean(row.email_verified), googleLinked: Boolean(this.db.prepare('SELECT 1 FROM auth_google_identities WHERE user_id=?').get(row.id)), role: row.role, platformAdmin: Boolean(row.platform_admin), ...profileOf(row), ...accessOf(row), resellerId: row.reseller_id, tenantIds: JSON.parse(row.tenant_ids), disabled: row.disabled_at !== null, createdAt: new Date(row.created_at).toISOString() };
  }
  currentActor(actor) {
    const row = typeof actor?.userId === 'string' && typeof actor?.resellerId === 'string' ? this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(actor.userId) : null;
    if (!row || row.disabled_at !== null) fail(403, 'Seu acesso não está disponível.');
    if (actor.supportGrantId!==undefined && actor.supportGrantId!==null && actor.supportGrantId!=='') {
      if (!this.supportAccess) fail(403,'O suporte delegado não está disponível.');
      return this.supportAccess.resolve(actor,row);
    }
    if (actor.resellerId !== row.reseller_id && !(row.platform_admin && this.db.prepare('SELECT 1 FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(row.id,actor.resellerId))) fail(403, 'Este workspace não está no seu acesso.');
    return row;
  }
  admin(actor) {
    if (actor?.supportGrantId) fail(403,'O suporte delegado não administra o workspace.');
    const row = this.currentActor(actor);
    if (row.role !== 'reseller') fail(403, 'Acesso reservado ao administrador da revenda.');
    return { ...row, reseller_id: actor.resellerId };
  }
  me(actor) { return this.metadata(this.currentActor(actor)); }
  isPlatformAdmin(actor) { return Boolean(actor?.userId && this.currentActor(actor).platform_admin); }
  listPlatformUsers(actor, options = {}) {
    // A reseller role or a browser-supplied platformAdmin field never grants this directory.
    if (!this.isPlatformAdmin(actor)) fail(403, 'O diretório global é reservado ao administrador da plataforma.');
    allowedFields(options, ['q', 'offset', 'limit', 'state', 'role']);
    const { q = '', offset = 0, limit = 50, state = 'all', role = 'all' } = options;
    if (typeof q !== 'string' || q.trim().length > 200 || /[\x00-\x1f\x7f]/.test(q)
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !['all', 'active', 'disabled'].includes(state) || !['all', 'operator', 'reseller'].includes(role)) fail(400, 'Informe filtros e página válidos para o diretório.');
    const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
    const search = normalize(q.trim());
    // Only directory metadata is selected; tenant snapshots and auth credentials stay in SQLite.
    const companies = this.db.prepare("SELECT id,reseller_id,json_extract(data,'$.name') AS name FROM tenants ORDER BY id").all();
    const users = this.db.prepare(`SELECT u.id,u.name,u.username,u.email,u.role,u.created_at,u.disabled_at,u.presence,u.platform_admin,u.reseller_id,u.tenant_ids,
      json_extract(r.data,'$.name') AS reseller_name FROM auth_users u LEFT JOIN resellers r ON r.id=u.reseller_id
      ORDER BY u.created_at DESC,u.id`).all().flatMap(row => {
      if (state === 'active' && row.disabled_at !== null || state === 'disabled' && row.disabled_at === null || role !== 'all' && row.role !== role) return [];
      const assignedIds = row.role === 'operator' ? new Set(JSON.parse(row.tenant_ids)) : null;
      const linked = companies.filter(company => company.reseller_id === row.reseller_id && (!assignedIds || assignedIds.has(company.id)));
      if (search && ![row.name, row.username, row.email, row.role, row.reseller_name, ...linked.map(company => company.name)].some(value => normalize(value).includes(search))) return [];
      return [{ id: row.id, name: row.name, username: row.username, email: row.email || null, role: row.role,
        createdAt: new Date(row.created_at).toISOString(), disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at).toISOString(), disabled: row.disabled_at !== null,
        presence: ['available', 'busy', 'away', 'offline'].includes(row.presence) ? row.presence : 'available', platformAdmin: Boolean(row.platform_admin),
        reseller: { id: row.reseller_id, name: row.reseller_name || '' }, tenantIds: linked.map(company => company.id),
        tenants: linked.slice(0, 5).map(company => ({ id: company.id, name: company.name || '' })), tenantCount: linked.length }];
    });
    // Photos are read only for this bounded page, after platform authority and filters.
    // An invalid legacy value cannot turn the directory into an external-image loader.
    const readPhoto = this.db.prepare('SELECT avatar FROM auth_users WHERE id=?');
    const page = users.slice(offset, offset + limit).map(user => {
      let avatar = null;
      try { avatar = validateProfileAvatar(readPhoto.get(user.id)?.avatar ?? null); }
      catch (error) { if (error.status !== 400) throw error; }
      return { ...user, avatar };
    });
    return { users: page, total: users.length, offset, limit, hasMore: offset + limit < users.length };
  }
  resolveActor(actor) { return { ...this.actor(this.currentActor(actor)),resellerId:actor.resellerId }; }
  workspaceActor(actor, requestedResellerId, supportGrantId) {
    const row = this.currentActor(actor);
    if(supportGrantId===undefined&&actor.supportGrantId&&(requestedResellerId===undefined||requestedResellerId===actor.resellerId))supportGrantId=actor.supportGrantId;
    let selected = requestedResellerId;
    if (selected === undefined) selected = row.platform_admin && this.db.prepare('SELECT 1 FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(row.id,this.resellerId) ? this.resellerId : row.reseller_id;
    if (typeof selected !== 'string' || !selected || selected.length > 120) fail(400, 'Escolha um workspace válido.');
    const base = this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id);
    const scoped = { ...this.actor(base), resellerId: selected,...(supportGrantId?{supportGrantId}:{}) };
    return this.resolveActor(scoped);
  }
  workspaces(actor) {
    const current = this.currentActor(actor), row = this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(current.id);
    const ids = [row.reseller_id];
    if (row.platform_admin) ids.push(...this.db.prepare('SELECT reseller_id FROM auth_workspace_access WHERE user_id=?').all(row.id).map(item=>item.reseller_id));
    const own = [...new Set(ids)].map(id=>{const workspace=this.db.prepare('SELECT data FROM resellers WHERE id=?').get(id);return workspace?{id,name:JSON.parse(workspace.data).name,platformWorkspace:id===this.resellerId}:null;}).filter(Boolean);
    return [...own,...(this.supportAccess?.available({userId:row.id,resellerId:row.reseller_id})||[]).map(grant=>({id:grant.workspaceId,name:grant.workspaceName,platformWorkspace:false,supportGrantId:grant.id,supportExpiresAt:grant.expiresAt,supportReason:grant.reason}))];
  }
  promoteFirstPlatformAdmin({ userId, expectedEmail, expectedResellerId, workspaceId = this.resellerId } = {}) {
    return this.transaction(() => {
      if (!this.status().setupRequired) fail(409, 'O administrador da plataforma já foi definido.');
      const row = typeof userId==='string' ? this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId) : null;
      if (!row || row.disabled_at!==null || row.role!=='reseller' || row.email!==email(expectedEmail,true) || row.reseller_id!==expectedResellerId) fail(403,'A conta administrativa não corresponde à identidade confirmada.');
      if (workspaceId!==this.resellerId || !this.db.prepare('SELECT 1 FROM resellers WHERE id=?').get(workspaceId)) fail(400,'Workspace da plataforma não encontrado.');
      this.db.prepare('INSERT INTO auth_workspace_access(user_id,reseller_id,created_at) VALUES (?,?,?)').run(row.id,workspaceId,this.now());
      this.db.prepare('UPDATE auth_users SET platform_admin=1 WHERE id=?').run(row.id);
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
  updateProfile(actor,input) { return this.transaction(()=>this.metadata(updateUserProfile(this.db,this.currentActor(actor).id,input))); }
  updatePresence(actor, presence) {
    const value = normalizePresence(presence);
    return this.transaction(() => {
      const row = this.currentActor(actor);
      this.db.prepare('UPDATE auth_users SET presence=? WHERE id=?').run(value,row.id);
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
  tenantState(actor, tenantId) {
    if (!this.validateTenant) return undefined;
    const state = this.validateTenant(actor,tenantId);
    if (state && typeof state.then === 'function') fail(500,'A validação de empresas precisa concluir na mesma operação.');
    if (!state || typeof state!=='object' || Array.isArray(state)) fail(500,'A validação de empresas precisa retornar a empresa autorizada.');
    return state;
  }
  validateAccess(actor, tenantIds, scopeRules) {
    for (const tenantId of tenantIds) {
      const state = this.tenantState(actor,tenantId), rule = scopeRules?.[tenantId];
      if (!state || !rule) continue;
      const channels = new Set((state.channels || []).map(channel=>channel.id));
      const departments = new Set(['unassigned', ...(state.departments || []).map(department=>department.id)]);
      if (rule.channelIds?.some(id=>!channels.has(id))) fail(400,'O canal do escopo não pertence à empresa selecionada.');
      if (rule.departmentIds?.some(id=>!departments.has(id))) fail(400,'O departamento do escopo não pertence à empresa selecionada.');
    }
  }
  validContext(state, context) {
    if (!state) return true;
    if (context.channelId!==undefined && !(state.channels||[]).some(channel=>channel.id===context.channelId)) return false;
    if (context.departmentId!==undefined && context.departmentId!=='unassigned' && !(state.departments||[]).some(department=>department.id===context.departmentId)) return false;
    return true;
  }
  createTenantPermissionChecker(actor, permission, tenantId) {
    if (!BUSINESS_PERMISSIONS.includes(permission) || typeof tenantId !== 'string' || !tenantId || tenantId !== tenantId.trim() || tenantId.length > 120) fail(403, 'Seu acesso não permite esta operação.');
    const row = this.currentActor(actor), scoped = { ...this.actor(row), resellerId: actor.resellerId };
    if (row.role !== 'reseller' && (!scoped.tenantIds.includes(tenantId) || !effectivePermissions(row).includes(permission))) fail(403, 'Seu acesso não permite esta operação.');
    const state = this.tenantState(scoped, tenantId), rules = scoped.scopeRules;
    // A fresh, synchronous read operation owns this snapshot. Never retain it across requests or awaits.
    const can = (context = {}) => {
      if (!context || typeof context !== 'object' || Array.isArray(context) || context.tenantId !== tenantId) return false;
      if (!this.validContext(state, context)) return false;
      return row.role === 'reseller' || scopeAllows(rules, tenantId, context);
    };
    return { state, can };
  }
  can(actor, permission, context = {}) {
    try {
      if (!BUSINESS_PERMISSIONS.includes(permission) || !context || typeof context !== 'object' || Array.isArray(context)) return false;
      const row = this.currentActor(actor), tenantId = context.tenantId;
      if (tenantId !== undefined && (typeof tenantId !== 'string' || !tenantId || tenantId !== tenantId.trim() || tenantId.length > 120)) return false;
      const scoped = { ...this.actor(row), resellerId: actor.resellerId };
      if (row.role === 'reseller') {
        if (tenantId === undefined) return context.channelId===undefined && context.departmentId===undefined;
        return this.validContext(this.tenantState(scoped,tenantId),context);
      }
      if (typeof tenantId !== 'string' || !JSON.parse(row.tenant_ids).includes(tenantId) || !effectivePermissions(row).includes(permission)) return false;
      if (!this.validContext(this.tenantState(scoped,tenantId),context)) return false;
      return scopeAllows(accessOf(row).scopeRules,tenantId,context);
    } catch { return false; }
  }
  assignees(actor, tenantId, context = {}) {
    if (!this.can(actor,'inbox.read',{ ...context, tenantId })) fail(403,'Seu acesso não permite consultar a equipe deste atendimento.');
    const rows = this.db.prepare(`SELECT * FROM auth_users WHERE disabled_at IS NULL AND
      (reseller_id=? OR (platform_admin=1 AND EXISTS(SELECT 1 FROM auth_workspace_access WHERE user_id=auth_users.id AND reseller_id=?)))
      ORDER BY name COLLATE NOCASE,id`).all(actor.resellerId,actor.resellerId);
    const regular = rows.filter(row=>this.can({ ...this.actor(row), resellerId: actor.resellerId },'inbox.reply',{ ...context, tenantId }))
      .map(row=>({id:row.id,name:row.name,role:row.role,avatar:row.avatar??null,presence:accessOf(row).presence}));
    const delegated = this.supportAccess?.assignees(actor.resellerId,tenantId,context)||[];
    if(actor.supportGrantId&&this.can(actor,'inbox.reply',{...context,tenantId})){
      const own=this.currentActor(actor);delegated.push({id:own.id,name:own.name,role:'operator',avatar:own.avatar??null,presence:accessOf(own).presence,supportGrantId:own.supportGrantId,supportExpiresAt:own.supportExpiresAt});
    }
    const people = new Map(regular.map(person=>[person.id,person]));
    for (const person of delegated) if (!people.has(person.id) || person.id===actor.userId && person.supportGrantId===actor.supportGrantId) people.set(person.id,person);
    return [...people.values()];
  }
  session(row) {
    const token = randomBytes(32).toString('base64url'), date = this.now();
    this.db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,NULL)').run(tokenHash(token), row.id, date, date + this.sessionTtlMs);
    this.db.prepare('INSERT INTO auth_session_ids VALUES (?,?)').run(tokenHash(token),randomUUID());
    return { token, actor: this.actor(row) };
  }
  insertUser(input, salt, hash, role, tenantIds, resellerId = this.resellerId, { passwordVersion = 'scrypt-v1', emailVerified = false, platformAdmin = false } = {}) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO auth_users (id,username,name,email,email_verified,role,reseller_id,tenant_ids,password_salt,password_hash,password_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.username, input.name, input.email ?? null, Number(emailVerified), role, resellerId, JSON.stringify(tenantIds), salt, hash, passwordVersion, this.now());
    if(platformAdmin)this.db.prepare('UPDATE auth_users SET platform_admin=1 WHERE id=?').run(id);
    return this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(id);
  }
  /** New accounts only: the locale of the signup page becomes the profile locale. */
  withSignupLocale(row, locale) {
    const chosen = signupLocale(locale);
    if (!chosen) return row;
    this.db.prepare('UPDATE auth_users SET locale=? WHERE id=?').run(chosen, row.id);
    return this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id);
  }
  /** Re-authentication for destructive actions. Throttled like login; never reveals whether the account exists. */
  async verifyPassword(actor, secret) {
    const row = this.currentActor(actor), name = 'reauth:' + row.id;
    if (row.password_version !== 'scrypt-v1') fail(409, 'Sua conta entra com Google e não tem senha. Use "Esqueci minha senha" para criar uma e tente novamente.', { code: 'account_delete_password_unavailable' });
    if (typeof secret !== 'string' || !secret || secret.length > 128) fail(403, 'Senha atual incorreta.', { code: 'account_delete_password_invalid' });
    this.throttle(name); this.loggingIn.add(name);
    try {
      const actual = await derive(secret, Buffer.from(row.password_salt), 64, passwordOptions), expected = Buffer.from(row.password_hash);
      const current = this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id);
      if (!current || current.disabled_at !== null || expected.length !== actual.length || !timingSafeEqual(expected, actual) || passwordFingerprint(current) !== passwordFingerprint(row)) {
        this.failedLogin(name); fail(403, 'Senha atual incorreta.', { code: 'account_delete_password_invalid' });
      }
      this.attempts.delete(name);
      return true;
    } finally { this.loggingIn.delete(name); }
  }
  available(input) {
    if (this.db.prepare('SELECT 1 FROM auth_users WHERE username=?').get(input.username)) fail(409, 'Este usuário já está cadastrado.');
    if (input.email && this.emailOwner(input.email)) fail(409, 'Este e-mail já está cadastrado.');
  }
  emailOwner(value, excludingId = '') {
    return this.db.prepare('SELECT id FROM auth_users WHERE email=? COLLATE NOCASE AND id<>? UNION SELECT user_id AS id FROM auth_google_identities WHERE email=? COLLATE NOCASE AND user_id<>?').get(value,excludingId,value,excludingId);
  }
  provision(provision, profile) {
    if (typeof provision !== 'function' || provision.constructor?.name === 'AsyncFunction') fail(500, 'O cadastro de empresas não está disponível.');
    const result = provision(profile);
    if (result && typeof result.then === 'function') fail(500, 'O cadastro de empresas precisa concluir na mesma transação.');
  }
  async setup(input) {
    if (!this.allowSetup) fail(403, 'O primeiro acesso está desabilitado neste ambiente.');
    if (!this.status().setupRequired) fail(409, 'O primeiro acesso já foi configurado. Entre com seu usuário.');
    const data = userInput(input), salt = randomBytes(16), hash = await derive(data.password, salt, 64, passwordOptions);
    return this.transaction(() => {
      if (!this.status().setupRequired) fail(409, 'O primeiro acesso já foi configurado. Entre com seu usuário.');
      this.available(data);
      return this.session(this.insertUser(data, salt, hash, 'reseller', [],this.resellerId,{platformAdmin:true}));
    });
  }
  async register(input, { provision } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Informe os dados do cadastro.');
    if (['role', 'platformAdmin', 'platform_admin', 'resellerId', 'reseller_id', 'tenantId', 'tenantIds', 'permissions', 'scopeRules', 'presence', 'userId', 'workspaceId', 'workspaceIds', 'workspaces', 'workspaceAccess','parentWorkspaceId','parentAccountId'].some(key => Object.hasOwn(input, key))) fail(400, 'A empresa e as permissões são definidas pelo cadastro.');
    const data = { name: displayName(input.name), email: email(input.email, true), password: password(input.password, true), username: 'u_' + randomUUID().replaceAll('-', '') };
    const company = input.company === undefined || input.company === '' ? 'Minha empresa' : displayName(input.company, 'nome de empresa');
    const accountKind=input.accountKind??'business';
    if(!['business','reseller'].includes(accountKind))fail(400,'Escolha empresa ou revenda para sua conta.');
    const preparedTrial = this.registrationTrial ? await this.registrationTrial.prepare(input.fiscalDocument) : null;
    const salt = randomBytes(16), hash = await derive(data.password, salt, 64, passwordOptions);
    const resellerId = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID();
    return this.transaction(() => {
      this.available(data);
      this.provision(provision, { resellerId, tenantId, name: company, email: data.email,accountKind,parentWorkspaceId:this.resellerId, ...(preparedTrial ? { onboardingTrial: preparedTrial.onboardingTrial } : {}) });
      if (preparedTrial) this.registrationTrial.reserve(resellerId, preparedTrial);
      return this.session(this.withSignupLocale(this.insertUser(data, salt, hash, 'reseller', [], resellerId), input.locale));
    });
  }
  async googleLogin(profile, { provision,accountKind='business',allowRegistration=true,fiscalDocument,locale } = {}) {
    const data = googleProfile(profile);
    if(!['business','reseller'].includes(accountKind))fail(400,'Escolha empresa ou revenda para sua conta.');
    const known = this.db.prepare("SELECT 1 FROM auth_google_identities WHERE provider='google' AND subject=?").get(data.sub);
    if (!known && allowRegistration && this.emailOwner(data.email)) fail(409, 'Este e-mail já tem uma conta. Entre com sua senha e vincule o Google.');
    const preparedTrial = !known && allowRegistration && this.registrationTrial ? await this.registrationTrial.prepare(fiscalDocument) : null;
    return this.transaction(() => {
      const identity = this.db.prepare("SELECT user_id FROM auth_google_identities WHERE provider='google' AND subject=?").get(data.sub);
      if (identity) {
        const row = this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(identity.user_id);
        if (!row || row.disabled_at !== null) unauthenticated();
        return this.session(row); // O subject estável é a identidade, nunca o e-mail recebido agora.
      }
      if (!allowRegistration) fail(403, 'O cadastro está fechado neste ambiente. Entre com uma conta já vinculada.');
      if (this.emailOwner(data.email)) fail(409, 'Este e-mail já tem uma conta. Entre com sua senha e vincule o Google.');
      const resellerId = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID();
      this.provision(provision, { resellerId, tenantId, name: 'Minha empresa', email: data.email,accountKind,parentWorkspaceId:this.resellerId, ...(preparedTrial ? { onboardingTrial: preparedTrial.onboardingTrial } : {}) });
      if (this.registrationTrial) {
        if (!preparedTrial) fail(409, 'O vínculo Google mudou. Tente entrar novamente.');
        this.registrationTrial.reserve(resellerId, preparedTrial);
      }
      const row = this.withSignupLocale(this.insertUser({ ...data, username: 'u_' + randomUUID().replaceAll('-', '') }, randomBytes(16), randomBytes(64), 'reseller', [], resellerId, { passwordVersion: 'google-only', emailVerified: true }), locale);
      this.db.prepare('INSERT INTO auth_google_identities (subject,user_id,created_at,email) VALUES (?,?,?,?)').run(data.sub, row.id, this.now(),data.email);
      return this.session(row);
    });
  }
  linkGoogle(actor, profile) {
    const data = googleProfile(profile);
    return this.transaction(() => {
      const row = this.currentActor(actor);
      const identity = this.db.prepare('SELECT user_id FROM auth_google_identities WHERE subject=?').get(data.sub);
      const existing = this.db.prepare('SELECT subject FROM auth_google_identities WHERE user_id=?').get(row.id);
      if ((identity && identity.user_id !== row.id) || (existing && existing.subject !== data.sub)) fail(409, 'Esta conta Google já possui um vínculo diferente.');
      if (this.emailOwner(data.email,row.id)) fail(409, 'Este e-mail já está cadastrado em outra conta.');
      // Prova do Google verifica somente seu e-mail; não verifica outro e-mail principal.
      if (row.email === null || row.email === data.email) this.db.prepare('UPDATE auth_users SET email=?,email_verified=1 WHERE id=?').run(data.email, row.id);
      if (!identity) this.db.prepare('INSERT INTO auth_google_identities (subject,user_id,created_at,email) VALUES (?,?,?,?)').run(data.sub, row.id, this.now(),data.email);
      else this.db.prepare('UPDATE auth_google_identities SET email=? WHERE subject=?').run(data.email,data.sub);
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
  emailChallenge(userId, purpose = 'verify') {
    if (purpose !== 'verify') fail(400, 'Finalidade de verificação inválida.');
    return this.transaction(() => {
      const row = typeof userId === 'string' ? this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId) : null;
      if (!row || row.disabled_at !== null || !row.email) fail(404, 'Conta indisponível para verificação.');
      const token = randomBytes(32).toString('base64url'), date = this.now();
      this.db.prepare('UPDATE auth_email_challenges SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL').run(date, row.id, purpose);
      this.db.prepare('INSERT INTO auth_email_challenges VALUES (?,?,?,?,?,?,NULL)').run(tokenHash(token), row.id, row.email, purpose, date, date + 3600000);
      return token;
    });
  }
  consumeEmailChallenge(token) {
    if (!validToken(token)) fail(400, 'Verificação inválida ou expirada.');
    return this.transaction(() => {
      const challenge = this.db.prepare("SELECT * FROM auth_email_challenges WHERE token_hash=? AND purpose='verify' AND consumed_at IS NULL AND expires_at>?").get(tokenHash(token), this.now());
      const row = challenge ? this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(challenge.user_id) : null;
      if (!row || row.disabled_at !== null || row.email !== challenge.email) fail(400, 'Verificação inválida ou expirada.');
      this.db.prepare('UPDATE auth_email_challenges SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(this.now(), challenge.token_hash);
      this.db.prepare('UPDATE auth_users SET email_verified=1 WHERE id=?').run(row.id);
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
  throttle(name) {
    const attempt = this.attempts.get(name);
    if (attempt && this.now() - attempt.lastFailure > 15 * 60000) this.attempts.delete(name);
    else if (attempt?.lockedUntil > this.now()) fail(429, 'Aguarde um momento antes de tentar novamente.', { retryAfter: Math.ceil((attempt.lockedUntil - this.now()) / 1000) });
    if (this.loggingIn.has(name)) fail(429, 'Uma tentativa de acesso já está em andamento.', { retryAfter: 1 });
  }
  failedLogin(name) {
    const date = this.now(), previous = this.attempts.get(name), failures = (previous?.failures || 0) + 1;
    const delay = failures < this.maxAttempts ? 0 : Math.min(this.backoffMs * 2 ** Math.min(failures - this.maxAttempts, 20), this.maxBackoffMs);
    if (!previous && this.attempts.size >= 512) this.attempts.delete(this.attempts.keys().next().value);
    this.attempts.set(name, { failures, lastFailure: date, lockedUntil: date + delay });
  }
  async login(input = {}) {
    const identifier = input?.username ?? input?.email;
    const name = typeof identifier === 'string' && identifier.includes('@') ? email(identifier, true) : username(identifier), secret = password(input?.password);
    this.throttle(name); this.loggingIn.add(name);
    try {
      const row = name.includes('@') ? this.db.prepare('SELECT * FROM auth_users WHERE email=? COLLATE NOCASE').get(name) : this.db.prepare('SELECT * FROM auth_users WHERE username=?').get(name);
      const salt = row ? Buffer.from(row.password_salt) : dummySalt;
      const expected = row ? Buffer.from(row.password_hash) : dummyHash;
      const actual = await derive(secret, salt, 64, passwordOptions);
      if (!row || row.disabled_at !== null || row.password_version !== 'scrypt-v1' || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        this.failedLogin(name); fail(401, 'Usuário ou senha incorretos.');
      }
      return this.transaction(() => {
        const current = this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id);
        if (!current || current.disabled_at !== null || passwordFingerprint(current)!==passwordFingerprint(row)) { this.failedLogin(name); fail(401, 'Usuário ou senha incorretos.'); }
        this.attempts.delete(name);
        return this.session(current);
      });
    } finally { this.loggingIn.delete(name); }
  }
  authenticate(token) {
    if (!validToken(token)) unauthenticated();
    const session = this.db.prepare('SELECT user_id FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(tokenHash(token), this.now());
    if (!session) unauthenticated();
    const row = this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(session.user_id);
    if (!row || row.disabled_at !== null) unauthenticated();
    return this.actor(row);
  }
  logout(token) {
    if (validToken(token)) this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(this.now(), tokenHash(token));
  }
  invitationAuthority(actor,targetWorkspaceId=actor.resellerId) {
    const row = this.currentActor(actor);
    if(targetWorkspaceId!==actor.resellerId){
      if(!this.commercialAuthority||actor.supportGrantId)fail(403,'Esta conta não está na sua gestão comercial.');
      const {account}=this.commercialAuthority(actor,targetWorkspaceId);
      if(row.role!=='reseller')fail(403,'Somente um administrador pode convidar o responsável.');
      return {admin:{...row,reseller_id:targetWorkspaceId},stamp:canonical({commercial:true,issuerWorkspaceId:actor.resellerId,targetWorkspaceId,accountKind:account.accountKind,parentWorkspaceId:account.parentWorkspaceId,role:row.role,platformAdmin:Boolean(row.platform_admin),homeWorkspaceId:row.reseller_id})};
    }
    const admin = this.admin(actor);
    const workspaceGrant = row.reseller_id===actor.resellerId ? null : this.db.prepare('SELECT created_at FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(row.id,actor.resellerId)?.created_at;
    return { admin, stamp: canonical({ role:row.role,resellerId:row.reseller_id,tenantIds:JSON.parse(row.tenant_ids).sort(),permissions:accessOf(row).permissions,scopeRules:accessOf(row).scopeRules,platformAdmin:Boolean(row.platform_admin),workspaceGrant }) };
  }
  invitationGrants(actor, tenantIds, scopeRules) {
    const workspace = this.db.prepare('SELECT data FROM resellers WHERE id=?').get(actor.resellerId);
    if (!workspace) fail(400,'Workspace do convite indisponível.');
    const tenants = tenantIds.map(id => {
      const row = this.db.prepare('SELECT reseller_id,data FROM tenants WHERE id=?').get(id);
      if (!row || row.reseller_id!==actor.resellerId) fail(400,'A empresa do convite não pertence a este workspace.');
      return { id, name:JSON.parse(row.data).name };
    });
    this.validateAccess(actor,tenantIds,scopeRules);
    return { workspace:{id:actor.resellerId,name:JSON.parse(workspace.data).name},tenants };
  }
  invitationMetadata(row) {
    const state = row.accepted_at!==null ? 'accepted' : row.revoked_at!==null ? 'revoked' : row.expires_at<=this.now() ? 'expired' : 'pending';
    const creator = this.db.prepare('SELECT name FROM auth_users WHERE id=?').get(row.creator_id);
    return { id:row.id,name:row.name,email:row.email,role:row.role,tenantIds:JSON.parse(row.tenant_ids),permissions:row.permissions===null?null:JSON.parse(row.permissions),scopeRules:row.scope_rules===null?null:JSON.parse(row.scope_rules),
      createdBy:{id:row.creator_id,name:creator?.name||''},createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),state,canRevoke:state==='pending',
      acceptedAt:row.accepted_at===null?null:new Date(row.accepted_at).toISOString(),acceptedUserId:row.accepted_user_id };
  }
  async invitationCipherKey() {
    const key = typeof this.invitationKey==='function' ? await this.invitationKey() : this.invitationKey;
    if (!Buffer.isBuffer(key) || key.length!==32) fail(503,'A chave de convites não está disponível.');
    return key;
  }
  invitationSecret(token, key, id, workspaceId) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from(canonical({id,workspaceId})));
    const ciphertext = Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64');
  }
  invitationToken(row, key) {
    try {
      const secret = Buffer.from(row.token_secret,'base64'), decipher = createDecipheriv('aes-256-gcm',key,secret.subarray(0,12));
      decipher.setAAD(Buffer.from(canonical({id:row.id,workspaceId:row.reseller_id}))); decipher.setAuthTag(secret.subarray(12,28));
      const token = Buffer.concat([decipher.update(secret.subarray(28)),decipher.final()]).toString('utf8');
      if (!validToken(token) || tokenHash(token)!==row.token_hash) throw new Error('Invalid invitation secret');
      return token;
    } catch { fail(503,'Não foi possível recuperar este convite. Revogue e gere outro link.'); }
  }
  async createInvitation(actor, input,{targetWorkspaceId=actor.resellerId}={}) {
    allowedFields(input,['requestId','name','email','role','tenantIds','permissions','scopeRules','expiresInHours'],'Informe somente identidade e acesso do convite.');
    this.invitationAuthority(actor,targetWorkspaceId);
    if (typeof input.requestId!=='string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.requestId)) fail(400,'Informe a identificação deste convite.');
    const role = input.role ?? 'operator';
    if (!['operator','reseller'].includes(role)) fail(400,'Escolha administrador da revenda ou atendente.');
    const tenantIds = memberships(input.tenantIds,role).sort(), permissions = normalizePermissions(input.permissions), scopeRules = normalizeScopeRules(input.scopeRules,tenantIds,role);
    if(targetWorkspaceId!==actor.resellerId&&(role!=='reseller'||tenantIds.length||permissions!==null||scopeRules!==null))fail(400,'A gestão comercial convida somente o administrador do painel do cliente.');
    const name = input.name===undefined || input.name===null || input.name==='' ? null : displayName(input.name), address = email(input.email);
    const expiresInHours = input.expiresInHours ?? 72;
    if (!Number.isInteger(expiresInHours) || expiresInHours<1 || expiresInHours>168) fail(400,'Escolha validade entre 1 e 168 horas.');
    const payload = canonical({name,email:address,role,tenantIds,permissions,scopeRules,expiresInHours}), key = await this.invitationCipherKey();
    return this.transaction(() => {
      const { admin,stamp } = this.invitationAuthority(actor,targetWorkspaceId);
      this.invitationGrants({ ...this.actor(admin),resellerId:admin.reseller_id },tenantIds,scopeRules);
      const previous = this.db.prepare('SELECT * FROM auth_invitations WHERE creator_id=? AND reseller_id=? AND request_id=?').get(admin.id,admin.reseller_id,input.requestId);
      if (previous) {
        if (previous.request_payload!==payload) fail(409,'A identificação do convite já foi usada com outros dados.');
        if (previous.creator_access!==stamp || this.invitationMetadata(previous).state!=='pending') fail(409,'Este convite não está mais disponível. Gere um novo.');
        return { invitation:this.invitationMetadata(previous),token:this.invitationToken(previous,key) };
      }
      if (address && this.db.prepare('SELECT 1 FROM auth_users WHERE email=? COLLATE NOCASE').get(address)) fail(409,'Este e-mail já está cadastrado. Gerencie o acesso da conta existente.');
      this.planQuota?.assertUser?.(admin.reseller_id,{ now:this.now() });
      const id = randomUUID(), token = randomBytes(32).toString('base64url'), date = this.now();
      this.db.prepare(`INSERT INTO auth_invitations (id,token_hash,token_secret,reseller_id,creator_id,creator_access,request_id,request_payload,name,email,role,tenant_ids,permissions,scope_rules,created_at,expires_at,issuer_workspace_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,tokenHash(token),this.invitationSecret(token,key,id,admin.reseller_id),admin.reseller_id,admin.id,stamp,input.requestId,payload,name,address,role,JSON.stringify(tenantIds),permissions===null?null:JSON.stringify(permissions),scopeRules===null?null:JSON.stringify(scopeRules),date,date+expiresInHours*3600000,actor.resellerId);
      return { invitation:this.invitationMetadata(this.db.prepare('SELECT * FROM auth_invitations WHERE id=?').get(id)),token };
    });
  }
  listInvitations(actor,{targetWorkspaceId=actor.resellerId}={}) {
    const {admin} = this.invitationAuthority(actor,targetWorkspaceId);
    return this.db.prepare('SELECT * FROM auth_invitations WHERE reseller_id=? ORDER BY created_at DESC,id LIMIT 100').all(admin.reseller_id).map(row=>this.invitationMetadata(row));
  }
  revokeInvitation(actor, id,{targetWorkspaceId=actor.resellerId}={}) {
    return this.transaction(() => {
      const {admin} = this.invitationAuthority(actor,targetWorkspaceId), row = typeof id==='string' ? this.db.prepare('SELECT * FROM auth_invitations WHERE id=? AND reseller_id=?').get(id,admin.reseller_id) : null;
      if (!row) fail(404,'Convite não encontrado neste workspace.');
      if (row.accepted_at!==null) fail(409,'O convite já foi aceito. Gerencie o acesso do usuário.');
      if (row.revoked_at===null) this.db.prepare('UPDATE auth_invitations SET revoked_at=? WHERE id=?').run(this.now(),id);
      return this.invitationMetadata(this.db.prepare('SELECT * FROM auth_invitations WHERE id=?').get(id));
    });
  }
  invitationForToken(token) {
    const invalid = () => fail(400,'Convite inválido, expirado ou sem acesso disponível.');
    if (!validToken(token)) invalid();
    const row = this.db.prepare('SELECT * FROM auth_invitations WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').get(tokenHash(token),this.now());
    if (!row) invalid();
    try {
      const actor = { userId:row.creator_id,resellerId:row.issuer_workspace_id||row.reseller_id }, { stamp } = this.invitationAuthority(actor,row.reseller_id);
      if (stamp!==row.creator_access) invalid();
      const metadata = this.invitationMetadata(row), grants = this.invitationGrants({...actor,resellerId:row.reseller_id},metadata.tenantIds,metadata.scopeRules);
      return { row,metadata,grants };
    } catch (error) { if (error.status>=400 && error.status<500) invalid(); throw error; }
  }
  previewInvitation(token) {
    const { metadata,grants } = this.invitationForToken(token);
    return { id:metadata.id,name:metadata.name,email:metadata.email,role:metadata.role,tenantIds:metadata.tenantIds,permissions:metadata.permissions,scopeRules:metadata.scopeRules,expiresAt:metadata.expiresAt,...grants };
  }
  async acceptInvitation(token, input) {
    allowedFields(input,['name','username','password','email'],'Defina somente sua identidade e senha para aceitar o convite.');
    const first = this.invitationForToken(token), data = userInput(input);
    if (first.row.email && data.email && data.email!==first.row.email) fail(400,'Use o e-mail definido no convite.');
    data.email = first.row.email ?? data.email;
    const salt = randomBytes(16), hash = await derive(data.password,salt,64,passwordOptions);
    return this.transaction(() => {
      const { row,metadata } = this.invitationForToken(token);
      if (row.id!==first.row.id) fail(400,'Convite inválido.');
      this.available(data);
      if (row.email===null && data.email && this.db.prepare('SELECT 1 FROM auth_invitations WHERE email=? COLLATE NOCASE AND id<>? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').get(data.email,row.id,this.now())) {
        fail(409,'Este e-mail está indisponível para este convite. Use outro endereço ou deixe o campo em branco.');
      }
      const user = this.insertUser(data,salt,hash,row.role,metadata.tenantIds,row.reseller_id);
      this.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(row.permissions,row.scope_rules,user.id);
      const consumed = this.db.prepare('UPDATE auth_invitations SET accepted_at=?,accepted_user_id=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').run(this.now(),user.id,row.id,this.now());
      if (consumed.changes!==1) fail(400,'Convite inválido ou expirado.');
      return this.session(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(user.id));
    });
  }
  passwordResetChallenge(address) {
    const normalized = email(address,true);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM auth_users WHERE email=? COLLATE NOCASE AND disabled_at IS NULL').get(normalized);
      if (!row) return null;
      const date = this.now(), recent = this.db.prepare('SELECT created_at FROM auth_password_resets WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(row.id);
      if (recent && recent.created_at>date-60000) return null;
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('UPDATE auth_password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(date,row.id);
      this.db.prepare('INSERT INTO auth_password_resets VALUES (?,?,?,?,?,?,NULL)').run(tokenHash(token),row.id,row.email,passwordFingerprint(row),date,date+1800000);
      return { token,email:row.email,userId:row.id,name:row.name,expiresAt:new Date(date+1800000).toISOString() };
    });
  }
  resetForToken(token) {
    if (!validToken(token)) fail(400,'Recuperação inválida ou expirada. Solicite um novo link.');
    const challenge = this.db.prepare('SELECT * FROM auth_password_resets WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?').get(tokenHash(token),this.now());
    const row = challenge ? this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(challenge.user_id) : null;
    if (!row || row.disabled_at!==null || row.email!==challenge.email || passwordFingerprint(row)!==challenge.password_snapshot) fail(400,'Recuperação inválida ou expirada. Solicite um novo link.');
    return { challenge,row };
  }
  async consumePasswordReset(token, input) {
    allowedFields(input,['password']);
    this.resetForToken(token);
    const secret = password(input.password,true), salt = randomBytes(16), hash = await derive(secret,salt,64,passwordOptions);
    return this.transaction(() => {
      const { row } = this.resetForToken(token);
      this.db.prepare("UPDATE auth_users SET password_salt=?,password_hash=?,password_version='scrypt-v1' WHERE id=?").run(salt,hash,row.id);
      this.revokeUserSessions(row.id);
      this.db.prepare('UPDATE auth_password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(this.now(),row.id);
      return { changed:true };
    });
  }
  ownSession(row, token) {
    const session = validToken(token) ? this.db.prepare('SELECT s.*,i.id FROM auth_sessions s JOIN auth_session_ids i ON i.token_hash=s.token_hash WHERE s.token_hash=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>?').get(tokenHash(token),row.id,this.now()) : null;
    if (!session) unauthenticated();
    return session;
  }
  async changePassword(actor, input, {sessionToken} = {}) {
    allowedFields(input,['currentPassword','password']);
    const row = this.currentActor(actor); this.ownSession(row,sessionToken);
    const current = password(input.currentPassword), next = password(input.password,true), attempt = 'password:'+row.id;
    this.throttle(attempt); this.loggingIn.add(attempt);
    try {
      const expected = Buffer.from(row.password_hash), actual = await derive(current,Buffer.from(row.password_salt),64,passwordOptions);
      if (row.password_version!=='scrypt-v1' || expected.length!==actual.length || !timingSafeEqual(expected,actual)) { this.failedLogin(attempt); fail(401,'Senha atual incorreta.'); }
      const salt = randomBytes(16), hash = await derive(next,salt,64,passwordOptions);
      return this.transaction(() => {
        const fresh = this.currentActor(actor), active = this.ownSession(fresh,sessionToken);
        if (passwordFingerprint(fresh)!==passwordFingerprint(row)) fail(409,'A senha foi alterada. Entre novamente antes de tentar.');
        this.db.prepare("UPDATE auth_users SET password_salt=?,password_hash=?,password_version='scrypt-v1' WHERE id=?").run(salt,hash,row.id);
        const revoked = this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND token_hash<>? AND revoked_at IS NULL').run(this.now(),row.id,active.token_hash);
        this.db.prepare('UPDATE auth_password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(this.now(),row.id);
        this.attempts.delete(attempt);
        return { changed:true,revokedSessions:revoked.changes };
      });
    } finally { this.loggingIn.delete(attempt); }
  }
  sessions(actor, sessionToken) {
    const row = this.currentActor(actor), current = this.ownSession(row,sessionToken);
    return { sessions:this.db.prepare('SELECT i.id,s.created_at,s.expires_at FROM auth_sessions s JOIN auth_session_ids i ON i.token_hash=s.token_hash WHERE s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? ORDER BY s.created_at DESC,i.id LIMIT 100').all(row.id,this.now())
      .map(item=>({id:item.id,createdAt:new Date(item.created_at).toISOString(),expiresAt:new Date(item.expires_at).toISOString(),current:item.id===current.id})) };
  }
  revokeSession(actor, id, sessionToken) {
    return this.transaction(() => {
      const row = this.currentActor(actor), current = this.ownSession(row,sessionToken);
      const target = typeof id==='string' ? this.db.prepare('SELECT i.id,s.token_hash FROM auth_sessions s JOIN auth_session_ids i ON i.token_hash=s.token_hash WHERE i.id=? AND s.user_id=?').get(id,row.id) : null;
      if (!target) fail(404,'Sessão não encontrada nesta conta.');
      this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND user_id=? AND revoked_at IS NULL').run(this.now(),target.token_hash,row.id);
      return { revoked:true,current:target.id===current.id };
    });
  }
  async createUser(actor, input) {
    const admin = this.admin(actor);
    allowedFields(input,['username','password','name','email','role','tenantIds','permissions','scopeRules'],'Edite somente identidade de cadastro e acesso da equipe.');
    const data = userInput(input), role = input.role === undefined ? 'operator' : input.role;
    if (!['reseller', 'operator'].includes(role)) fail(400, 'Escolha administrador da revenda ou atendente.');
    const tenantIds = memberships(input.tenantIds, role), permissions = normalizePermissions(input.permissions), scopeRules = normalizeScopeRules(input.scopeRules,tenantIds,role);
    this.validateAccess({ ...this.actor(admin), resellerId: admin.reseller_id },tenantIds,scopeRules);
    const salt = randomBytes(16), hash = await derive(data.password, salt, 64, passwordOptions);
    return this.transaction(() => {
      const admin = this.admin(actor); // Revalida autorização após o hash assíncrono.
      this.validateAccess({ ...this.actor(admin), resellerId: admin.reseller_id },tenantIds,scopeRules);
      this.available(data);
      this.planQuota?.assertUser?.(admin.reseller_id,{ now:this.now() });
      const row = this.insertUser(data, salt, hash, role, tenantIds, admin.reseller_id);
      this.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions===null?null:JSON.stringify(permissions),scopeRules===null?null:JSON.stringify(scopeRules),row.id);
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
  managedUser(actor,id) {
    const admin = this.admin(actor);
    if (id === admin.id) fail(409,'Edite seu próprio perfil em Minha conta; mantenha seu acesso administrativo.');
    const row = typeof id==='string' ? this.db.prepare('SELECT * FROM auth_users WHERE id=? AND reseller_id=?').get(id,admin.reseller_id) : null;
    if (!row) fail(404,'Usuário não encontrado nesta revenda.');
    if (row.platform_admin) fail(403,'O administrador da plataforma não pode ser alterado pela equipe.');
    return { admin, row };
  }
  keepAdministrator(row) {
    if (row.role === 'reseller' && row.disabled_at === null && this.db.prepare("SELECT count(*) AS n FROM auth_users WHERE reseller_id=? AND role='reseller' AND disabled_at IS NULL").get(row.reseller_id).n<=1) fail(409,'Mantenha pelo menos um administrador ativo.');
  }
  revokeUserSessions(id) { this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(this.now(),id); }
  revokeUserChallenges(id) {
    this.db.prepare('UPDATE auth_password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(this.now(),id);
    this.db.prepare('UPDATE auth_invitations SET revoked_at=? WHERE creator_id=? AND revoked_at IS NULL AND accepted_at IS NULL').run(this.now(),id);
    this.supportAccess?.invalidateUser(id);
  }
  updateUser(actor,id,input) {
    allowedFields(input,['name','role','tenantIds','permissions','scopeRules'],'Edite somente nome, papel e acesso da equipe.');
    return this.transaction(() => {
      const { admin, row } = this.managedUser(actor,id), originalAccess = accessOf(row);
      const name = Object.hasOwn(input,'name') ? displayName(input.name) : row.name;
      const role = Object.hasOwn(input,'role') ? input.role : row.role;
      if (!['reseller','operator'].includes(role)) fail(400,'Escolha administrador da revenda ou atendente.');
      const tenantIds = memberships(Object.hasOwn(input,'tenantIds') ? input.tenantIds : role==='reseller'?[]:JSON.parse(row.tenant_ids),role);
      const permissions = Object.hasOwn(input,'permissions') ? normalizePermissions(input.permissions) : originalAccess.permissions;
      const retainedRules = role==='reseller'?null:originalAccess.scopeRules===null?null:Object.fromEntries(Object.entries(originalAccess.scopeRules).filter(([tenantId])=>tenantIds.includes(tenantId)));
      const scopeRules = normalizeScopeRules(Object.hasOwn(input,'scopeRules') ? input.scopeRules : retainedRules,tenantIds,role);
      this.validateAccess({ ...this.actor(admin), resellerId: admin.reseller_id },tenantIds,scopeRules);
      if (row.role==='reseller' && role!=='reseller') this.keepAdministrator(row);
      const changedAccess = row.role!==role || JSON.stringify([...JSON.parse(row.tenant_ids)].sort())!==JSON.stringify([...tenantIds].sort())
        || JSON.stringify(originalAccess.permissions)!==JSON.stringify(permissions) || JSON.stringify(originalAccess.scopeRules)!==JSON.stringify(scopeRules);
      this.db.prepare('UPDATE auth_users SET name=?,role=?,tenant_ids=?,permissions=?,scope_rules=? WHERE id=?').run(name,role,JSON.stringify(tenantIds),permissions===null?null:JSON.stringify(permissions),scopeRules===null?null:JSON.stringify(scopeRules),row.id);
      if (changedAccess) { this.revokeUserSessions(row.id); this.revokeUserChallenges(row.id); }
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
  listUsers(actor) {
    const admin = this.admin(actor);
    return this.db.prepare('SELECT * FROM auth_users WHERE reseller_id=? OR (id=? AND platform_admin=1) ORDER BY created_at,id').all(admin.reseller_id,admin.id).map(row => this.metadata(row));
  }
  disableUser(actor, id) {
    return this.transaction(() => {
      const { row } = this.managedUser(actor,id);
      if (row.disabled_at !== null) return this.metadata(row);
      this.keepAdministrator(row);
      const date = this.now();
      this.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(date, id);
      this.revokeUserSessions(id);
      this.revokeUserChallenges(id);
      this.db.prepare('UPDATE auth_email_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(date, id);
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(id));
    });
  }
  reactivateUser(actor,id) {
    return this.transaction(() => {
      const { row } = this.managedUser(actor,id);
      const tenantIds = JSON.parse(row.tenant_ids), scopeRules = accessOf(row).scopeRules;
      const admin = this.admin(actor);
      this.validateAccess({ ...this.actor(admin), resellerId: admin.reseller_id },tenantIds,scopeRules);
      if (row.disabled_at!==null) {
        this.planQuota?.assertUser?.(row.reseller_id,{ now:this.now() });
        this.revokeUserSessions(row.id);
        this.db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(row.id);
      }
      return this.metadata(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
    });
  }
}
