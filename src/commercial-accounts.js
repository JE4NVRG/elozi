import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { CommercialLifecycle, COMMERCIAL_STATES } from './commercial-lifecycle.js';
import { materializeTenant } from './conversation-journal.js';

export const ACCOUNT_KINDS = ['platform', 'reseller', 'business'];
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/\p{Cc}/u.test(value);
const fields = (input, allowed) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos desta operação comercial.'); };
const label = (value, name, max = 80) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /\p{Cc}/u.test(value)) fail(400, `${name} inválido.`); return value.trim(); };
const sync = (fn, ...args) => { const result = fn(...args); if (result && typeof result.then === 'function') { result.catch?.(() => {}); fail(500, 'A operação comercial exige validadores e persistência síncronos.'); } return result; };
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const publicBrand = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(['name', 'initials', 'accent', 'domain', 'logo'].filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
};

/** Commercial metadata never grants an operational workspace, tenant or session. */
export class CommercialAccounts {
  constructor(store, { validateActor, isPlatformAdmin, platformWorkspaceId = 'mep-demo', now = Date.now } = {}) {
    if (!store?.db || typeof store.provisionReseller !== 'function' || [validateActor, isPlatformAdmin, now].some(fn => typeof fn !== 'function') || !identity(platformWorkspaceId)) throw new Error('Contas comerciais exigem Store e autorização síncrona.');
    Object.assign(this, { store, db: store.db, validateActor, isPlatformAdmin, platformWorkspaceId, now });
    this.lifecycle = new CommercialLifecycle(this);
    this.db.exec(`CREATE TABLE IF NOT EXISTS commercial_account_requests (
      actor_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES resellers(id), request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, created_workspace_id TEXT NOT NULL REFERENCES resellers(id), created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id,workspace_id,request_id)
    ); CREATE TABLE IF NOT EXISTS commercial_account_audit (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES resellers(id), actor_id TEXT NOT NULL,
      actor_workspace_id TEXT NOT NULL, action TEXT NOT NULL, previous_version INTEGER,
      version INTEGER NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS commercial_account_audit_workspace ON commercial_account_audit(workspace_id,created_at);`);
  }
  timestamp() { const value = sync(this.now); if (!Number.isFinite(value)) fail(500, 'Relógio comercial inválido.'); return new Date(value).toISOString(); }
  actor(input, { admin = true } = {}) {
    const actor = sync(this.validateActor, input);
    if (!actor || !identity(actor.userId) || !identity(actor.resellerId) || actor.supportGrantId || actor.kind === 'service' || admin && actor.role !== 'reseller') fail(403, 'A gestão comercial pertence ao administrador desta conta.');
    return actor;
  }
  platform(actor) { return !actor.supportGrantId && sync(this.isPlatformAdmin, actor) === true; }
  accountRow(id) {
    if (!identity(id)) fail(400, 'Conta comercial inválida.');
    const row = this.db.prepare('SELECT id,data FROM resellers WHERE id=?').get(id);
    if (!row) fail(404, 'Conta comercial não encontrada neste acesso.');
    const data = JSON.parse(row.data), accountKind = ACCOUNT_KINDS.includes(data.accountKind) ? data.accountKind : id === this.platformWorkspaceId ? 'platform' : 'reseller';
    return { id, data, rawData: row.data, accountKind, parentWorkspaceId: identity(data.parentWorkspaceId) ? data.parentWorkspaceId : null, version: Number.isSafeInteger(data.version) && data.version > 0 ? data.version : 1 };
  }
  permitted(actor, account, { platform = this.platform(actor), own = this.accountRow(actor.resellerId) } = {}) {
    return platform || account.id === own.id || ['platform', 'reseller'].includes(own.accountKind) && account.parentWorkspaceId === own.id && (own.accountKind === 'platform' || account.accountKind === 'business');
  }
  visible(actor, id) {
    const account = this.accountRow(id);
    if (!this.permitted(actor, account)) fail(404, 'Conta comercial não encontrada neste acesso.');
    return account;
  }
  table(name) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  platformAccessCounters() { return this.table('auth_workspace_access') && this.db.prepare('PRAGMA table_info(auth_users)').all().some(column => column.name === 'platform_admin'); }
  counts(id) {
    // Extract numbers in SQL; messages, contacts, user identities and provider credentials are never loaded.
    // The on-demand demo company (tenant.demo) is fictitious and never counted.
    const tenants = count(this.db.prepare("SELECT count(*) AS n FROM tenants WHERE reseller_id=? AND json_extract(data,'$.demo') IS NULL").get(id).n);
    const channels = this.db.prepare(`SELECT count(*) AS n,coalesce(sum(CASE WHEN json_extract(c.value,'$.state')='connected' THEN 1 ELSE 0 END),0) AS connected
      FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.channels')='array' THEN json_extract(t.data,'$.channels') ELSE '[]' END) c WHERE t.reseller_id=? AND json_extract(t.data,'$.demo') IS NULL AND c.type='object'`).get(id);
    const agents = this.db.prepare(`SELECT count(*) AS n,coalesce(sum(CASE WHEN json_type(a.value,'$.configured')='true' THEN 1 ELSE 0 END),0) AS active
      FROM tenants t,json_each(CASE WHEN json_type(t.data,'$.agents')='array' THEN json_extract(t.data,'$.agents') ELSE '[]' END) a WHERE t.reseller_id=? AND json_extract(t.data,'$.demo') IS NULL AND a.type='object'`).get(id);
    const users = this.table('auth_users') ? this.platformAccessCounters()
      ? this.db.prepare("SELECT count(*) AS n,coalesce(sum(CASE WHEN role='reseller' THEN 1 ELSE 0 END),0) AS admins FROM auth_users u WHERE disabled_at IS NULL AND (reseller_id=? OR (platform_admin=1 AND EXISTS(SELECT 1 FROM auth_workspace_access a WHERE a.user_id=u.id AND a.reseller_id=?)))").get(id,id)
      : this.db.prepare("SELECT count(*) AS n,coalesce(sum(CASE WHEN role='reseller' THEN 1 ELSE 0 END),0) AS admins FROM auth_users WHERE disabled_at IS NULL AND reseller_id=?").get(id)
      : { n: 0, admins: 0 };
    return { tenants, users: count(users.n), admins: count(users.admins), channels: count(channels.n), connectedChannels: count(channels.connected), agents: count(agents.n), activeAgents: count(agents.active) };
  }
  dto(actor, account) {
    const counts = this.counts(account.id), contractConfigured = this.table('billing_contracts') && Boolean(this.db.prepare("SELECT 1 FROM billing_contracts WHERE target_workspace_id=? AND state='active' LIMIT 1").get(account.id));
    return { id: account.id, name: typeof account.data.name === 'string' ? account.data.name : '', accountKind: account.accountKind, parentWorkspaceId: account.parentWorkspaceId, version: account.version,
      brand: publicBrand(account.data.brand), createdAt: typeof account.data.createdAt === 'string' && Number.isFinite(Date.parse(account.data.createdAt)) ? account.data.createdAt : null, counts,
      onboarding: { companyCreated: counts.tenants > 0, administratorActive: counts.admins > 0, channelConnected: counts.connectedChannels > 0, teamReady: counts.users > counts.admins, contractConfigured },
      lifecycle: { ...this.lifecycle.describe(account), canManage: this.lifecycle.canManage(actor, account) },
      canRename: this.permitted(actor, account), canInviteAdministrator: this.permitted(actor, account) };
  }
  current(input) { const actor = this.actor(input); return this.dto(actor, this.accountRow(actor.resellerId)); }
  overview(input, id = input?.resellerId) { const actor = this.actor(input); return this.dto(actor, this.visible(actor, id)); }
  list(input, options = {}) {
    const actor = this.actor(input); fields(options, ['view', 'q', 'kind', 'state', 'offset', 'limit']);
    const { view = 'account', q = '', kind = 'all', state = 'all', offset = 0, limit = 50 } = options;
    if (!['all', ...COMMERCIAL_STATES].includes(state)) fail(400, 'Estado comercial inválido para o filtro.');
    if (!['platform', 'account'].includes(view) || typeof q !== 'string' || q.trim().length > 200 || /\p{Cc}/u.test(q) || !['all', ...ACCOUNT_KINDS].includes(kind) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Informe filtros e página válidos para as contas.');
    const platform = this.platform(actor), own = this.accountRow(actor.resellerId);
    if (view === 'platform' && !platform) fail(403, 'A visão global pertence ao administrador da plataforma.');
    // Project only public account metadata. Scope filtering happens before counts or pagination.
    const all = this.db.prepare(`SELECT id,json_extract(data,'$.name') AS name,json_extract(data,'$.brand') AS brand,json_extract(data,'$.accountKind') AS kind,
      json_extract(data,'$.parentWorkspaceId') AS parent,json_extract(data,'$.version') AS version,json_extract(data,'$.createdAt') AS created,
      json_extract(data,'$.commercialLifecycle') AS lifecycle FROM resellers`).all().map(row => {
      const data = { name: row.name, brand: row.brand ? JSON.parse(row.brand) : null, accountKind: row.kind, parentWorkspaceId: row.parent, version: row.version, createdAt: row.created,
        ...(row.lifecycle ? { commercialLifecycle: JSON.parse(row.lifecycle) } : {}) };
      return { id: row.id, data, accountKind: ACCOUNT_KINDS.includes(row.kind) ? row.kind : row.id === this.platformWorkspaceId ? 'platform' : 'reseller', parentWorkspaceId: identity(row.parent) ? row.parent : null, version: Number.isSafeInteger(row.version) && row.version > 0 ? row.version : 1 };
    }).filter(account => view === 'platform' || account.id === own.id || ['platform', 'reseller'].includes(own.accountKind) && account.parentWorkspaceId === own.id && (own.accountKind === 'platform' || account.accountKind === 'business'));
    const summary = { total: all.length, platform: 0, reseller: 0, business: 0 };
    for (const account of all) summary[account.accountKind]++;
    const totals=all.map(account=>this.counts(account.id));
    summary.connectedChannels=totals.reduce((sum,item)=>sum+item.connectedChannels,0);summary.activeAgents=totals.reduce((sum,item)=>sum+item.activeAgents,0);
    const ids=all.map(account=>account.id),visibleIds=JSON.stringify(ids);
    summary.activeUsers = this.table('auth_users') && ids.length ? this.platformAccessCounters()
      ? this.db.prepare('SELECT count(*) AS n FROM auth_users u WHERE disabled_at IS NULL AND (reseller_id IN (SELECT value FROM json_each(?)) OR (platform_admin=1 AND EXISTS(SELECT 1 FROM auth_workspace_access a WHERE a.user_id=u.id AND a.reseller_id IN (SELECT value FROM json_each(?)))))').get(visibleIds,visibleIds).n
      : this.db.prepare('SELECT count(*) AS n FROM auth_users WHERE disabled_at IS NULL AND reseller_id IN (SELECT value FROM json_each(?))').get(visibleIds).n
      : 0;
    const search = normalize(q.trim()), filtered = all.filter(account => (kind === 'all' || account.accountKind === kind) && (state === 'all' || this.lifecycle.metadata(account).state === state) && (!search || normalize(account.data.name).includes(search) || normalize(account.id).includes(search)))
      .sort((a, b) => normalize(a.data.name).localeCompare(normalize(b.data.name), 'pt-BR') || a.id.localeCompare(b.id));
    return { accounts: filtered.slice(offset, offset + limit).map(account => this.dto(actor, account)), total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length, summary };
  }
  creationTarget(actor, input) {
    const own = this.accountRow(actor.resellerId), parent = this.accountRow(input.parentWorkspaceId);
    if (input.accountKind === 'reseller') {
      if (!this.platform(actor)) fail(403, 'Somente a plataforma cria uma revenda.');
      if (parent.id !== this.platformWorkspaceId || parent.accountKind !== 'platform') fail(400, 'Uma revenda deve pertencer à plataforma.');
    } else if (this.platform(actor)) {
      if (!['platform', 'reseller'].includes(parent.accountKind)) fail(400, 'Escolha a plataforma ou uma revenda responsável.');
    } else if (own.accountKind !== 'reseller' || parent.id !== own.id) fail(403, 'A revenda só cria clientes sob sua própria conta.');
    return parent;
  }
  audit(actor, account, action, previousVersion = null) {
    this.db.prepare('INSERT INTO commercial_account_audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), account.id, actor.userId, actor.resellerId, action, previousVersion, account.version, this.timestamp());
  }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = sync(callback); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(inputActor, input) {
    fields(input, ['requestId', 'name', 'accountKind', 'parentWorkspaceId', 'initialTenantName', 'segment']);
    if (!identity(input.requestId) || !identity(input.parentWorkspaceId) || !['reseller', 'business'].includes(input.accountKind)) fail(400, 'Informe o identificador, tipo e responsável da conta.');
    const payload = { name: label(input.name, 'Nome da conta'), accountKind: input.accountKind, parentWorkspaceId: input.parentWorkspaceId,
      initialTenantName: label(input.initialTenantName ?? input.name, 'Nome da empresa'), segment: label(input.segment ?? 'Atendimento', 'Segmento') };
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    this.creationTarget(this.actor(inputActor), payload);
    return this.transaction(() => {
      const actor = this.actor(inputActor); this.creationTarget(actor, payload);
      const previous = this.db.prepare('SELECT * FROM commercial_account_requests WHERE actor_id=? AND workspace_id=? AND request_id=?').get(actor.userId, actor.resellerId, input.requestId);
      if (previous) {
        if (previous.payload_hash !== payloadHash) fail(409, 'Este identificador já foi usado para outra criação.');
        return { account: this.dto(actor, this.visible(actor, previous.created_workspace_id)), replayed: true };
      }
      const id = 'reseller_' + randomUUID(), tenantId = 'tenant_' + randomUUID(), timestamp = this.timestamp();
      const provisioned = sync(this.store.provisionReseller.bind(this.store), { resellerId: id, tenantId, ...payload });
      if (provisioned?.resellerId !== id || provisioned?.tenantId !== tenantId) fail(500, 'O cadastro comercial não retornou as identidades solicitadas.');
      materializeTenant(this.db, tenantId, { workspaceId: id });
      const account = this.accountRow(id), tenant = this.db.prepare('SELECT data FROM tenants WHERE id=? AND reseller_id=?').get(tenantId, id);
      if (!tenant) fail(500, 'O cadastro comercial não criou a empresa solicitada.');
      Object.assign(account.data, { accountKind: payload.accountKind, parentWorkspaceId: payload.parentWorkspaceId, version: 1, createdAt: timestamp });
      this.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(account.data), id);
      this.db.prepare('UPDATE tenants SET data=? WHERE id=? AND reseller_id=?').run(JSON.stringify({ ...JSON.parse(tenant.data), name: payload.initialTenantName, segment: payload.segment }), tenantId, id);
      if (this.store.queuePostgres) sync(this.store.queuePostgres.bind(this.store), tenantId);
      const final = this.accountRow(id); this.audit(actor, final, 'account.created');
      this.db.prepare('INSERT INTO commercial_account_requests VALUES (?,?,?,?,?,?)').run(actor.userId, actor.resellerId, input.requestId, payloadHash, id, timestamp);
      return { account: this.dto(actor, final), replayed: false };
    });
  }
  update(inputActor, id, input) {
    fields(input, ['version', 'name']);
    if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a revisão atual da conta.');
    const name = label(input.name, 'Nome da conta'); this.visible(this.actor(inputActor), id);
    return this.transaction(() => {
      const actor = this.actor(inputActor), previous = this.visible(actor, id);
      if (previous.version !== input.version) fail(409, 'A conta mudou. Atualize antes de salvar.');
      if (previous.data.name === name) return { account: this.dto(actor, previous) };
      const data = { ...previous.data, name, version: previous.version + 1 };
      const result = this.db.prepare('UPDATE resellers SET data=? WHERE id=? AND data=?').run(JSON.stringify(data), id, previous.rawData);
      if (result.changes !== 1) fail(409, 'A conta mudou. Atualize antes de salvar.');
      for (const tenant of this.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(id)) if (this.store.queuePostgres) sync(this.store.queuePostgres.bind(this.store), tenant.id);
      const account = this.accountRow(id); this.audit(actor, account, 'account.renamed', previous.version);
      return { account: this.dto(actor, account) };
    });
  }
  /** Permission to invite an administrator, without granting or impersonating their operational account. */
  authorizeAdministration(input, targetWorkspaceId) {
    const actor = this.actor(input), account = this.visible(actor, targetWorkspaceId);
    return { actor, account: this.dto(actor, account) };
  }
}
