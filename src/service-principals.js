import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { assertTelegramAccountAiAllowed, telegramAccountAiAllowed } from './telegram-account-policy.js';
import { normalizeServiceConversationPolicy, serviceConversationDecision } from './service-conversation-policy.js';

export const SERVICE_CAPABILITIES = ['conversation.read', 'reply.draft', 'reply.submit', 'handoff.request', 'company.read', 'company.propose', 'reply.send', 'message.schedule', 'events.read', 'conversation.manage', 'presence.typing', 'contact.read', 'notification.send', 'notification.read', 'notification.recipient.manage'];
/** Actions whose effect changes the conversation version: replays and completed receipts are checked without the version. */
const VERSIONED_ACTIONS = new Set(['reply.send', 'message.schedule', 'conversation.manage']);
const capabilitySet = new Set(SERVICE_CAPABILITIES);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const instant = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const encoded = value => JSON.stringify(canonical(value));
const SEEN_WRITE_INTERVAL_MS = 60000;
/** The channel's existing group selection is authority, never an implicit service grant. */
export function serviceGroupContext(tenant, conversation) {
  assertTelegramAccountAiAllowed(tenant, conversation);
  const channel = tenant.channels?.find(item => item.id === conversation.channelId);
  const groupId = channel?.transport === 'baileys' ? conversation.remoteJid : channel?.transport === 'telegram-bot' ? conversation.remoteChatId : null;
  if (conversation.conversationKind !== 'group' || typeof groupId !== 'string' || (channel.transport === 'baileys' ? !/^\d+(?:-\d+)?@g\.us$/.test(groupId) : !/^-[1-9]\d{0,15}$/.test(groupId))) fail(403, 'Este atendimento não é um grupo disponível para o serviço.');
  if (channel.enabled === false || (channel.transport === 'baileys' ? !(channel.allowedGroups || []).includes(groupId) : channel.telegramGroups?.mode === 'selected' && !(channel.telegramGroups.groupIds || []).includes(groupId))) fail(403, 'Este grupo não está selecionado na conexão.');
  return { conversationKind: 'group', groupId, channelId: channel.id, channelTransport: channel.transport };
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos autorizados do serviço.');
}
function ids(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some(id => !identity(id))) fail(400, `Escolha ${label} válidos ou acesso a todos explicitamente.`);
  return [...new Set(value)].sort();
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(400, `${label} fora do limite permitido.`);
  return value;
}

/** Private SQLite authority. It deliberately never produces a human role or auth_user. */
export class ServicePrincipals {
  constructor(store, auth, { now = Date.now, validateManager, onChange, reservationTtlMs = 300000 } = {}) {
    this.store = store; this.db = store.db; this.auth = auth; this.now = now; this.validateManager = validateManager; this.onChange = onChange;
    this.reservationTtlMs = integer(reservationTtlMs, 1000, 3600000, 'Validade da reserva');
    this.proofs = new WeakMap();
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS service_principal_tenant_scope ON tenants(reseller_id,id);
      CREATE TABLE IF NOT EXISTS service_principals (
        id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        name TEXT NOT NULL, capabilities TEXT NOT NULL, channel_ids TEXT, department_ids TEXT,
        daily_requests INTEGER NOT NULL CHECK(daily_requests>0), daily_budget_micros INTEGER NOT NULL CHECK(daily_budget_micros>=0),
        max_concurrent INTEGER NOT NULL CHECK(max_concurrent>0), estimated_request_micros INTEGER NOT NULL DEFAULT 0 CHECK(estimated_request_micros>=0), expires_at INTEGER NOT NULL,
        revision INTEGER NOT NULL, key_revision INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL, revoked_at INTEGER, created_by TEXT NOT NULL REFERENCES auth_users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY(reseller_id,tenant_id) REFERENCES tenants(reseller_id,id)
      );
      CREATE TABLE IF NOT EXISTS service_principal_conversation_policies (
        principal_id TEXT PRIMARY KEY REFERENCES service_principals(id), policy TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_principal_usage (
        principal_id TEXT NOT NULL REFERENCES service_principals(id), day TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0), budget_micros INTEGER NOT NULL DEFAULT 0 CHECK(budget_micros>=0),
        PRIMARY KEY(principal_id,day)
      );
      CREATE TABLE IF NOT EXISTS service_principal_receipts (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES service_principals(id), request_id TEXT NOT NULL,
        reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_revision INTEGER NOT NULL,
        key_revision INTEGER NOT NULL, adapter_hash TEXT NOT NULL, capability TEXT NOT NULL, context TEXT NOT NULL,
        payload_hash TEXT NOT NULL, day TEXT NOT NULL, units INTEGER NOT NULL, reserved_cost_micros INTEGER NOT NULL,
        charged_cost_micros INTEGER NOT NULL, state TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
        result TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        UNIQUE(principal_id,request_id), FOREIGN KEY(reseller_id,tenant_id) REFERENCES tenants(reseller_id,id)
      );
      CREATE INDEX IF NOT EXISTS service_principal_receipt_scope ON service_principal_receipts(principal_id,state);
      CREATE TABLE IF NOT EXISTS service_principal_audit (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES service_principals(id), reseller_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES auth_users(id), action TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_principal_presence (
        principal_id TEXT PRIMARY KEY REFERENCES service_principals(id), last_seen_at INTEGER NOT NULL
      );`);
    // principal id → last presence write (ms), so an active service writes at most once a minute.
    this.seenWrites = new Map();
  }
  /**
   * Last authenticated call of a service (REST or MCP, elozi_me included), kept apart from the principal row so it never
   * changes its revision or audit. Written at most once a minute per principal; a failed write never fails the call.
   */
  markSeen(principalId) {
    const at = this.now(), last = this.seenWrites.get(principalId);
    if (last !== undefined && at - last < SEEN_WRITE_INTERVAL_MS) return;
    this.seenWrites.delete(principalId); this.seenWrites.set(principalId, at);
    while (this.seenWrites.size > 10000) this.seenWrites.delete(this.seenWrites.keys().next().value);
    try { this.db.prepare('INSERT INTO service_principal_presence VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET last_seen_at=excluded.last_seen_at WHERE excluded.last_seen_at>last_seen_at').run(principalId, at); }
    catch { this.seenWrites.delete(principalId); }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  scope(actor, tenantId) {
    if (!identity(tenantId)) fail(400, 'Escolha uma empresa válida.');
    const manager = this.auth.admin(actor);
    if (this.validateManager) {
      const allowed = this.validateManager(actor, tenantId);
      if (allowed?.then) throw new TypeError('A autorização de gestão precisa ser síncrona.');
      if (allowed === false) fail(403, 'Seu acesso não permite gerir serviços nesta empresa.');
    }
    const row = this.db.prepare('SELECT data FROM tenants WHERE reseller_id=? AND id=?').get(actor.resellerId, tenantId);
    if (!row) fail(404, 'Empresa não encontrada neste workspace.');
    return { manager, tenant: { id: tenantId, ...JSON.parse(row.data) }, workspaceId: actor.resellerId, tenantId };
  }
  principal(scope, id) {
    const row = identity(id) ? this.db.prepare('SELECT * FROM service_principals WHERE id=? AND reseller_id=? AND tenant_id=?').get(id, scope.workspaceId, scope.tenantId) : null;
    if (!row) fail(404, 'Serviço não encontrado nesta empresa.');
    return row;
  }
  adapter(row, { conversationId } = {}) {
    const tenant = this.store.serviceTenant(row.reseller_id, row.tenant_id, { conversationId }), agent = tenant?.agents?.find(item => item.id === row.agent_id);
    if (!agent || agent.configured !== true) fail(409, 'O adaptador deste serviço precisa estar configurado.');
    const fingerprint = hash(encoded({ id: agent.id, version: agent.version || 1, provider: agent.provider, mode: agent.mode,
      configured: agent.configured, description: agent.description || '', tools: agent.tools || [], endpoint: agent.endpoint || '' }));
    return { tenant, agent, fingerprint };
  }
  config(input, scope, previous) {
    fields(input, ['name', 'agentId', 'capabilities', 'channelIds', 'departmentIds', 'dailyRequests', 'dailyBudgetMicros', 'estimatedRequestMicros', 'maxConcurrent', 'ttlHours', 'active', 'revision', 'conversationPolicy']);
    const prior = previous ? this.metadata(previous) : {}, value = { ...prior, ...input };
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value.name)) fail(400, 'Use um nome de serviço com até 80 caracteres.');
    if (!identity(value.agentId) || !scope.tenant.agents?.some(agent => agent.id === value.agentId && agent.configured === true)) fail(400, 'Escolha um adaptador configurado nesta empresa.');
    const agent = scope.tenant.agents.find(item => item.id === value.agentId);
    const capabilities = value.capabilities ?? ['conversation.read', agent.provider === 'mcp' ? 'reply.submit' : 'reply.draft'];
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(capability => !capabilitySet.has(capability))) fail(400, 'Escolha capacidades implementadas explicitamente.');
    if (capabilities.some(capability => ['reply.draft','reply.submit','handoff.request','reply.send','message.schedule','events.read','conversation.manage','presence.typing','contact.read'].includes(capability)) && !capabilities.includes('conversation.read')) fail(400, 'Mantenha leitura do atendimento para autorizar suas ações.');
    if (capabilities.includes('company.propose') && !capabilities.includes('company.read')) fail(400, 'Mantenha leitura da empresa para propor alterações.');
    if (capabilities.includes('reply.submit') && (agent.provider !== 'mcp' || agent.mode !== 'copilot')) fail(400, 'Receber rascunhos exige um agente via MCP em modo copiloto.');
    if (capabilities.includes('reply.draft') && (agent.provider !== 'hermes' || agent.mode !== 'copilot')) fail(400, 'Preparar rascunhos exige um Hermes em modo copiloto.');
    const channelIds = ids(value.channelIds === undefined ? null : value.channelIds, 'canais'), departmentIds = ids(value.departmentIds === undefined ? null : value.departmentIds, 'departamentos');
    if(capabilities.some(c=>c.startsWith('notification.'))){
      const channel=channelIds?.length===1&&scope.tenant.channels?.find(c=>c.id===channelIds[0]);
      if(!channel||channel.kind!=='whatsapp_qr'||channel.transport!=='baileys'||departmentIds!==null||agent.provider!=='mcp'||agent.mode!=='copilot')fail(400,'Notificações exigem um serviço MCP e um único canal QR próprio, sem escopo de departamento.');
      if(!capabilities.includes('notification.read'))fail(400,'Mantenha leitura do recibo transacional.');
    }
    if (channelIds?.some(id => !scope.tenant.channels?.some(channel => channel.id === id)) || departmentIds?.some(id => id !== 'unassigned' && !scope.tenant.departments?.some(department => department.id === id && department.active !== false))) fail(400, 'O escopo precisa usar canais e departamentos ativos desta empresa.');
    if (value.active !== undefined && typeof value.active !== 'boolean') fail(400, 'Defina o estado ativo do serviço.');
    const conversationPolicy = normalizeServiceConversationPolicy(value.conversationPolicy);
    if (conversationPolicy.excludedChannelIds.some(id => !scope.tenant.channels?.some(channel => channel.id === id))) fail(400, 'Os canais excluídos precisam pertencer à empresa.');
    const dailyBudgetMicros = integer(value.dailyBudgetMicros ?? 0, 0, 100000000, 'Orçamento diário'), estimatedRequestMicros = integer(value.estimatedRequestMicros ?? 0, 0, 100000000, 'Estimativa por rascunho');
    if (dailyBudgetMicros > 0 && estimatedRequestMicros === 0) fail(400, 'Defina uma estimativa por rascunho antes de ativar o orçamento estimado.');
    const expiresAt = input.ttlHours === undefined && previous ? previous.expires_at : this.now() + integer(value.ttlHours ?? 168, 1, 2160, 'Validade em horas') * 3600000;
    return { name: value.name.trim(), agentId: value.agentId, capabilities: [...new Set(capabilities)].sort(), channelIds, departmentIds,
      dailyRequests: integer(value.dailyRequests ?? 100, 1, 10000, 'Cota diária'), dailyBudgetMicros, estimatedRequestMicros,
      maxConcurrent: integer(value.maxConcurrent ?? 1, 1, 20, 'Execuções simultâneas'), expiresAt, active: value.active ?? true, conversationPolicy };
  }
  conversationPolicy(row) {
    const saved = this.db.prepare('SELECT policy FROM service_principal_conversation_policies WHERE principal_id=?').get(row.id);
    return normalizeServiceConversationPolicy(saved ? JSON.parse(saved.policy) : null);
  }
  saveConversationPolicy(row, policy) {
    this.db.prepare('INSERT INTO service_principal_conversation_policies (principal_id,policy) VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET policy=excluded.policy').run(row.id, encoded(policy));
  }
  policyConversation(row, conversation, policy) {
    if (!policy.customerMessagesAfter) return conversation;
    // Only the last customer timestamp/late flag, never text/history, is decoded for this private guard.
    const latest = this.db.prepare(`SELECT
      json_extract(message.value,'$.createdAt') AS createdAt,
      json_extract(message.value,'$.deliveredLate') AS deliveredLate
      FROM service_conversation_private c JOIN service_tenant_private t ON t.tenant_id=c.tenant_id,
        json_each(CASE WHEN json_valid(c.data) THEN c.data ELSE '{}' END,'$.messages') message
      WHERE c.tenant_id=? AND c.id=? AND t.reseller_id=?
        AND CASE WHEN message.type='object' THEN json_extract(message.value,'$.kind')='customer' ELSE 0 END
      ORDER BY CAST(message.key AS INTEGER) DESC LIMIT 1`).get(row.tenant_id, conversation.id, row.reseller_id);
    return { ...conversation, messages: latest ? [{ kind: 'customer', createdAt: latest.createdAt, deliveredLate: latest.deliveredLate === 1 }] : [] };
  }
  metadata(row, conversationPolicy = this.conversationPolicy(row)) {
    const day = instant(this.now()).slice(0, 10), usage = this.db.prepare('SELECT requests,budget_micros FROM service_principal_usage WHERE principal_id=? AND day=?').get(row.id, day);
    const seen = this.db.prepare('SELECT last_seen_at FROM service_principal_presence WHERE principal_id=?').get(row.id)?.last_seen_at;
    return { id: row.id, workspaceId: row.reseller_id, tenantId: row.tenant_id, agentId: row.agent_id, name: row.name, conversationPolicy,
      capabilities: JSON.parse(row.capabilities), channelIds: row.channel_ids === null ? null : JSON.parse(row.channel_ids), departmentIds: row.department_ids === null ? null : JSON.parse(row.department_ids),
      dailyRequests: row.daily_requests, dailyBudgetMicros: row.daily_budget_micros, estimatedRequestMicros: row.estimated_request_micros, maxConcurrent: row.max_concurrent,
      expiresAt: instant(row.expires_at), revision: row.revision, keyRevision: row.key_revision, active: Boolean(row.active),
      state: row.revoked_at !== null ? 'revoked' : row.expires_at <= this.now() ? 'expired' : row.active ? 'active' : 'paused',
      createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), revokedAt: row.revoked_at === null ? null : instant(row.revoked_at),
      budgetKind: 'estimated', budgetEnabled: row.estimated_request_micros > 0 && row.daily_budget_micros > 0, budgetCurrency: 'USD', budgetDayTimezone: 'UTC',
      usage: { day, requests: usage?.requests || 0, budgetMicros: usage?.budget_micros || 0 }, lastSeenAt: Number.isSafeInteger(seen) ? instant(seen) : null };
  }
  audit(scope, row, action) {
    this.db.prepare('INSERT INTO service_principal_audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), row.id, scope.workspaceId, scope.tenantId, scope.manager.id, action, row.revision, this.now());
  }
  list(actor, tenantId) {
    const scope = this.scope(actor, tenantId);
    return { principals: this.db.prepare('SELECT * FROM service_principals WHERE reseller_id=? AND tenant_id=? ORDER BY created_at DESC,id LIMIT 100').all(scope.workspaceId, tenantId).map(row => this.metadata(row)), capabilities: [...SERVICE_CAPABILITIES] };
  }
  create(actor, tenantId, input) {
    return this.transaction(() => {
      const scope = this.scope(actor, tenantId), config = this.config(input, scope), id = randomUUID(), token = 'elozi_svc_' + randomBytes(32).toString('base64url'), date = this.now();
      this.db.prepare('INSERT INTO service_principals (id,reseller_id,tenant_id,agent_id,name,capabilities,channel_ids,department_ids,daily_requests,daily_budget_micros,max_concurrent,estimated_request_micros,expires_at,revision,key_revision,token_hash,active,revoked_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope.workspaceId, tenantId, config.agentId, config.name, encoded(config.capabilities), config.channelIds === null ? null : encoded(config.channelIds), config.departmentIds === null ? null : encoded(config.departmentIds), config.dailyRequests, config.dailyBudgetMicros, config.maxConcurrent, config.estimatedRequestMicros, config.expiresAt, 1, 1, hash(token), Number(config.active), null, scope.manager.id, date, date);
      const row = this.principal(scope, id); this.saveConversationPolicy(row, config.conversationPolicy); this.audit(scope, row, 'created');
      return { principal: this.metadata(row), token };
    });
  }
  assertRevision(row, revision) { if (!Number.isSafeInteger(revision) || revision !== row.revision) fail(409, 'O serviço mudou. Atualize antes de alterar.'); }
  invalidateReserved(row, reason) {
    for (const receipt of this.db.prepare("SELECT * FROM service_principal_receipts WHERE principal_id=? AND state='reserved'").all(row.id)) {
      this.db.prepare('UPDATE service_principal_usage SET budget_micros=budget_micros-? WHERE principal_id=? AND day=?').run(receipt.charged_cost_micros, row.id, receipt.day);
      this.db.prepare("UPDATE service_principal_receipts SET state='invalidated',stale=1,charged_cost_micros=0,reason=?,updated_at=? WHERE id=?").run(reason, this.now(), receipt.id);
    }
  }
  update(actor, tenantId, id, input) {
    const result = this.transaction(() => {
      const scope = this.scope(actor, tenantId), row = this.principal(scope, id); this.assertRevision(row, input?.revision);
      if (row.revoked_at !== null) fail(409, 'Um serviço revogado não pode ser reativado. Crie outra identidade.');
      const config = this.config(input, scope, row);
      if (encoded(config.conversationPolicy) !== encoded(this.conversationPolicy(row)) && this.db.prepare("SELECT 1 FROM service_principal_receipts WHERE principal_id=? AND state IN ('dispatched','unknown') LIMIT 1").get(row.id)) fail(409, 'Reconcilie os recibos em andamento ou incertos antes de alterar a política de conversas.');
      this.db.prepare('UPDATE service_principals SET name=?,agent_id=?,capabilities=?,channel_ids=?,department_ids=?,daily_requests=?,daily_budget_micros=?,max_concurrent=?,estimated_request_micros=?,expires_at=?,active=?,revision=revision+1,updated_at=? WHERE id=?').run(config.name, config.agentId, encoded(config.capabilities), config.channelIds === null ? null : encoded(config.channelIds), config.departmentIds === null ? null : encoded(config.departmentIds), config.dailyRequests, config.dailyBudgetMicros, config.maxConcurrent, config.estimatedRequestMicros, config.expiresAt, Number(config.active), this.now(), id);
      this.saveConversationPolicy(row, config.conversationPolicy);
      this.invalidateReserved(row, 'Configuração do serviço alterada.'); const updated = this.principal(scope, id); this.audit(scope, updated, 'updated'); return this.metadata(updated);
    });
    this.onChange?.(id); return result;
  }
  rotate(actor, tenantId, id, input = {}) {
    fields(input, ['revision']); const { revision } = input;
    const result = this.transaction(() => {
      const scope = this.scope(actor, tenantId), row = this.principal(scope, id); this.assertRevision(row, revision);
      if (row.revoked_at !== null || row.expires_at <= this.now()) fail(409, 'Renove a validade antes de trocar a chave de um serviço disponível.');
      const token = 'elozi_svc_' + randomBytes(32).toString('base64url');
      this.db.prepare('UPDATE service_principals SET token_hash=?,key_revision=key_revision+1,revision=revision+1,updated_at=? WHERE id=?').run(hash(token), this.now(), id);
      this.invalidateReserved(row, 'Chave do serviço substituída.'); const updated = this.principal(scope, id); this.audit(scope, updated, 'rotated'); return { principal: this.metadata(updated), token };
    });
    this.onChange?.(id); return result;
  }
  revoke(actor, tenantId, id, input = {}) {
    fields(input, ['revision']); const { revision } = input;
    const result = this.transaction(() => {
      const scope = this.scope(actor, tenantId), row = this.principal(scope, id); this.assertRevision(row, revision);
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE service_principals SET active=0,revoked_at=?,revision=revision+1,updated_at=? WHERE id=?').run(this.now(), this.now(), id);
        this.invalidateReserved(row, 'Serviço revogado.'); const updated = this.principal(scope, id); this.audit(scope, updated, 'revoked'); return this.metadata(updated);
      }
      return this.metadata(row);
    });
    this.onChange?.(id); return result;
  }
  authenticate(authorization) {
    const token = typeof authorization === 'string' && /^Bearer (elozi_svc_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    const row = token ? this.db.prepare('SELECT * FROM service_principals WHERE token_hash=?').get(hash(token)) : null;
    if (!row || !row.active || row.revoked_at !== null || row.expires_at <= this.now()) fail(401, 'Credencial de serviço inválida ou expirada.');
    const { fingerprint } = this.adapter(row, { conversationId: null });
    const actor = Object.freeze({ kind: 'service', principalId: row.id, name: row.name, workspaceId: row.reseller_id, resellerId: row.reseller_id,
      tenantId: row.tenant_id, agentId: row.agent_id, revision: row.revision, keyRevision: row.key_revision });
    this.proofs.set(actor, { principalId: row.id, tokenHash: row.token_hash, revision: row.revision, keyRevision: row.key_revision, adapterHash: fingerprint });
    this.markSeen(row.id);
    return actor;
  }
  currentAuthority(actor, { inventory = false, conversationId = null } = {}) {
    const proof = actor && this.proofs.get(actor), row = proof && this.db.prepare('SELECT * FROM service_principals WHERE id=?').get(proof.principalId);
    if (!row || !row.active || row.revoked_at !== null || row.expires_at <= this.now() || row.token_hash !== proof.tokenHash) fail(401, 'O acesso deste serviço perdeu validade.');
    if (row.revision !== proof.revision || row.key_revision !== proof.keyRevision) fail(409, 'A configuração do serviço mudou. Autentique novamente.');
    const adapter = this.adapter(row, { conversationId: inventory ? undefined : conversationId });
    if (adapter.fingerprint !== proof.adapterHash) fail(409, 'A configuração do adaptador mudou. Solicite outra execução.');
    return { row, adapter, policy: this.conversationPolicy(row) };
  }
  revalidate(actor, capability, context = {}) {
    return this.authorize(actor, capability, context, this.currentAuthority(actor, { conversationId: context.conversationId ?? null }));
  }
  /** Read-only synchronous batch: decode the tenant once, never cache authority across an await or a write. */
  withReadScope(actor, visit) {
    const dataVersion = this.db.prepare('PRAGMA data_version').get().data_version;
    const scope = this.currentAuthority(actor, { inventory: true }), before = this.db.prepare('SELECT total_changes() AS n').get().n;
    scope.adapter.conversationIndex = new Map((scope.adapter.tenant.conversations || []).map(conversation => [conversation.id, conversation]));
    let active = true;
    try {
      const value = visit({ tenant: scope.adapter.tenant, check: context => {
        if (!active) fail(409, 'A autorização de leitura terminou. Inicie uma nova consulta.');
        return this.authorize(actor, 'conversation.read', context, scope);
      } });
      if (value?.then) { Promise.resolve(value).catch(() => {}); throw new TypeError('A autorização em lote precisa ser síncrona.'); }
      if (this.db.prepare('SELECT total_changes() AS n').get().n !== before || this.db.prepare('PRAGMA data_version').get().data_version !== dataVersion) fail(409, 'O estado mudou durante a consulta. Inicie uma nova leitura.');
      this.currentAuthority(actor);
      return value;
    } finally { active = false; }
  }
  authorize(actor, capability, context, { row, adapter, policy = this.conversationPolicy(row) }) {
    if (row.expires_at <= this.now()) fail(401, 'O acesso deste serviço perdeu validade.');
    if (!capabilitySet.has(capability) || !JSON.parse(row.capabilities).includes(capability)) fail(403, 'O serviço não tem esta capacidade.');
    if (['reply.send','message.schedule','presence.typing'].includes(capability) && context.conversationId === undefined) fail(403, 'Escolha o atendimento autorizado para esta ação.');
    if (context.tenantId !== undefined && context.tenantId !== row.tenant_id || context.workspaceId !== undefined && context.workspaceId !== row.reseller_id || context.agentId !== undefined && context.agentId !== row.agent_id) fail(403, 'A execução saiu do escopo deste serviço.');
    if (context.conversationId !== undefined) {
      const conversation = identity(context.conversationId) && (adapter.conversationIndex ? adapter.conversationIndex.get(context.conversationId) : adapter.tenant.conversations?.find(item => item.id === context.conversationId));
      // Closing is a conversation.manage action: its own tools check the open status before acting.
      if (!conversation || !['conversation.read', 'conversation.manage'].includes(capability) && conversation.status === 'closed') fail(403, 'O atendimento não está disponível para esta ação do serviço.');
      const policyResult = serviceConversationDecision(policy, this.policyConversation(row, conversation, policy));
      if (!policyResult.allowed) fail(403, 'O atendimento está fora da política de conversas deste serviço.');
      assertTelegramAccountAiAllowed(adapter.tenant, { channelId: conversation.channelId });
      const actualDepartment = conversation.departmentId || 'unassigned';
      if (context.channelId !== conversation.channelId || (context.departmentId || 'unassigned') !== actualDepartment) fail(403, 'O contexto do atendimento mudou de canal ou departamento.');
      if (context.conversationVersion !== undefined && context.conversationVersion !== conversation.version) fail(409, 'A versão do atendimento mudou.');
      if (conversation.conversationKind === 'group' || context.conversationKind === 'group' || context.groupId !== undefined) {
        if (capability === 'conversation.manage') fail(403, 'Grupos não são assumidos, transferidos ou encerrados pelo serviço.');
        if (capability === 'presence.typing') fail(403, 'O aviso de digitação vale somente para conversas privadas atribuídas ao agente.');
        const group = serviceGroupContext(adapter.tenant, conversation);
        if (context.groupId !== undefined && context.groupId !== group.groupId || context.channelTransport !== undefined && context.channelTransport !== group.channelTransport) fail(403, 'O grupo ou transporte desta ação mudou.');
      } else if (capability === 'message.schedule') fail(403, 'Este serviço só pode agendar em grupos selecionados.');
      // presence.typing ("digitando…") follows exactly the private reply authority: never a typing indicator where the agent could not answer.
      else if (['reply.send', 'presence.typing'].includes(capability) && !(conversation.owner === 'agent' && conversation.agentId === row.agent_id && adapter.agent.provider === 'mcp' && adapter.agent.mode === 'copilot')) {
        // A private reply is the work of an attendant agent: only in conversations owned by this identity's agent, and only
        // for agents connected by MCP (Hermes answers through the autopilot, so there are never two autonomous senders).
        fail(403, 'O serviço só envia em grupos selecionados ou em conversas atribuídas ao seu agente conectado.');
      }
    }
    if (context.channelId !== undefined && !adapter.tenant.channels?.some(channel => channel.id === context.channelId)) fail(403, 'O canal não pertence à empresa deste serviço.');
    if (context.channelId !== undefined) assertTelegramAccountAiAllowed(adapter.tenant, { channelId: context.channelId });
    if (context.departmentId !== undefined && context.departmentId !== null && context.departmentId !== 'unassigned' && !adapter.tenant.departments?.some(department => department.id === context.departmentId && department.active !== false)) fail(403, 'O departamento não está disponível nesta empresa.');
    const channels = row.channel_ids === null ? null : JSON.parse(row.channel_ids), departments = row.department_ids === null ? null : JSON.parse(row.department_ids);
    if (['company.read','company.propose'].includes(capability) && context.conversationId === undefined) return { actor, principal: this.metadata(row), agent: structuredClone(adapter.agent), adapterHash: adapter.fingerprint };
    if (channels !== null && (!context.channelId || !channels.includes(context.channelId))) fail(403, 'O canal não está no acesso deste serviço.');
    const departmentId = context.departmentId || 'unassigned';
    if (departments !== null && !departments.includes(departmentId)) fail(403, 'O departamento não está no acesso deste serviço.');
    return { actor, principal: this.metadata(row), agent: structuredClone(adapter.agent), adapterHash: adapter.fingerprint };
  }
  /** Reconstruct only the exact stored service authority; no token or human account is persisted. */
  resolveServiceActor(record) {
    if (!identity(record?.serviceId)) fail(403, 'A identidade do agendamento não é um serviço válido.');
    const row = this.db.prepare('SELECT * FROM service_principals WHERE id=? AND reseller_id=? AND tenant_id=? AND agent_id=?').get(record.serviceId, record.resellerId, record.tenantId, record.agentId);
    if (!row || !row.active || row.revoked_at !== null || row.expires_at <= this.now() || row.revision !== record.serviceRevision || row.key_revision !== record.serviceKeyRevision) fail(403, 'A identidade do agendamento perdeu validade.');
    const { fingerprint } = this.adapter(row);
    if (fingerprint !== record.serviceAdapterHash) fail(403, 'O adaptador do agendamento mudou.');
    const actor = Object.freeze({ kind:'service', role:'operator', principalId:row.id, serviceId:row.id, id:row.id, name:row.name,
      workspaceId:row.reseller_id, resellerId:row.reseller_id, tenantId:row.tenant_id, tenantIds:[row.tenant_id], agentId:row.agent_id,
      revision:row.revision, keyRevision:row.key_revision, serviceRevision:row.revision, serviceKeyRevision:row.key_revision, serviceAdapterHash:fingerprint, serviceCapability:'message.schedule' });
    this.proofs.set(actor,{principalId:row.id,tokenHash:row.token_hash,revision:row.revision,keyRevision:row.key_revision,adapterHash:fingerprint,serviceCapability:'message.schedule'});
    this.revalidate(actor,'message.schedule',{workspaceId:row.reseller_id,tenantId:row.tenant_id,agentId:row.agent_id,conversationId:record.conversationId,
      channelId:record.channelId,departmentId:record.departmentId||'unassigned',conversationKind:'group',groupId:record.groupId,channelTransport:record.channelTransport});
    return actor;
  }
  executionActor(actor, capability, context) {
    if (!['reply.send','message.schedule'].includes(capability)) fail(403, 'Escolha uma ação explícita de envio.');
    const authority = this.revalidate(actor,capability,context), proof = this.proofs.get(actor);
    const internal = Object.freeze({ ...actor, kind:'service', role:'operator', id:actor.principalId, serviceId:actor.principalId,
      resellerId:actor.workspaceId, tenantIds:[actor.tenantId], name:authority.principal.name,
      serviceRevision:actor.revision, serviceKeyRevision:actor.keyRevision, serviceAdapterHash:authority.adapterHash, serviceCapability:capability });
    this.proofs.set(internal,{...proof,serviceCapability:capability});
    return internal;
  }
  authorizeInternalActor(actor, capability, context) {
    const proof = actor && this.proofs.get(actor);
    if (!proof || actor.kind !== 'service' || actor.serviceId !== proof.principalId || actor.serviceCapability !== capability || proof.serviceCapability !== capability) fail(403, 'O serviço não tem autoridade emitida para esta ação.');
    return this.revalidate(actor,capability,context);
  }
  /** Validate a persisted service run, including after process restart or human approval. */
  runCurrent(run) {
    try {
      if (!identity(run?.serviceId) || !identity(run.tenantId) || !identity(run.agentId) || !identity(run.conversationId)) return false;
      const row = this.db.prepare('SELECT * FROM service_principals WHERE id=? AND tenant_id=? AND agent_id=?').get(run.serviceId, run.tenantId, run.agentId);
      const capability = run.externalDraft === true ? 'reply.submit' : 'reply.draft';
      if (!row || !row.active || row.revoked_at !== null || row.expires_at <= this.now() || row.revision !== run.serviceRevision || row.key_revision !== run.serviceKeyRevision || !JSON.parse(row.capabilities).includes(capability)) return false;
      const adapter = this.adapter(row), conversation = adapter.tenant.conversations?.find(item => item.id === run.conversationId);
      if (adapter.agent.mode !== 'copilot' || adapter.agent.provider !== (run.externalDraft === true ? 'mcp' : 'hermes')) return false;
      if (adapter.fingerprint !== run.serviceAdapterHash || !conversation || conversation.status === 'closed' || conversation.channelId !== run.channelIdAtStart || (conversation.departmentId || null) !== (run.departmentIdAtStart || null) || conversation.version !== run.conversationVersion) return false;
      if (!telegramAccountAiAllowed(adapter.tenant, conversation)) return false;
      const policy = this.conversationPolicy(row);
      if (!serviceConversationDecision(policy, this.policyConversation(row, conversation, policy)).allowed) return false;
      const channels = row.channel_ids === null ? null : JSON.parse(row.channel_ids), departments = row.department_ids === null ? null : JSON.parse(row.department_ids);
      if (channels !== null && !channels.includes(conversation.channelId) || departments !== null && !departments.includes(conversation.departmentId || 'unassigned')) return false;
      if (!adapter.tenant.channels?.some(channel => channel.id === conversation.channelId) || conversation.departmentId && !adapter.tenant.departments?.some(department => department.id === conversation.departmentId && department.active !== false)) return false;
      if (conversation.conversationKind === 'group') serviceGroupContext(adapter.tenant, conversation);
      return true;
    } catch { return false; }
  }
  receiptDTO(row) {
    return { id: row.id, principalId: row.principal_id, requestId: row.request_id, workspaceId: row.reseller_id, tenantId: row.tenant_id, agentId: row.agent_id,
      revision: row.principal_revision, keyRevision: row.key_revision, adapterHash: row.adapter_hash, capability: row.capability, context: JSON.parse(row.context),
      units: row.units, reservedCostMicros: row.reserved_cost_micros, chargedCostMicros: row.charged_cost_micros, budgetKind: 'estimated',
      state: row.state, stale: Boolean(row.stale), result: row.result === null ? null : JSON.parse(row.result), reason: row.reason,
      createdAt: instant(row.created_at), updatedAt: instant(row.updated_at), expiresAt: instant(row.expires_at) };
  }
  receipt(actor, id) {
    const proof = actor && this.proofs.get(actor), row = proof && identity(id) ? this.db.prepare('SELECT * FROM service_principal_receipts WHERE id=? AND principal_id=?').get(id, proof.principalId) : null;
    if (!row) fail(404, 'Recibo não encontrado para este serviço.');
    return row;
  }
  currentReceipt(actor, row, { completedAction = false } = {}) {
    const context = JSON.parse(row.context);
    // A send/schedule may increment its own conversation version. Reconciliation
    // still checks scope and group identity; dispatch always checks the exact version.
    if (completedAction && VERSIONED_ACTIONS.has(row.capability)) delete context.conversationVersion;
    const authority = this.revalidate(actor, row.capability, context);
    if (row.principal_revision !== authority.principal.revision || row.key_revision !== authority.principal.keyRevision || row.adapter_hash !== authority.adapterHash) fail(409, 'O recibo pertence a uma configuração anterior.');
    return authority;
  }
  reserve(actor, input) {
    fields(input, ['requestId', 'capability', 'context', 'units', 'costMicros', 'payload']);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.requestId)) fail(400, 'Informe uma chave única da solicitação.');
    fields(input.context || {}, ['workspaceId', 'tenantId', 'agentId', 'conversationId', 'conversationVersion', 'channelId', 'departmentId', 'conversationKind', 'groupId', 'channelTransport']);
    const units = integer(input.units ?? 1, 1, 10000, 'Consumo da cota'), cost = integer(input.costMicros ?? 0, 0, 100000000, 'Reserva do orçamento');
    const payload = encoded({ capability: input.capability, context: input.context || {}, units, costMicros: cost, payload: input.payload ?? null });
    if (Buffer.byteLength(payload) > 65536) fail(400, 'Solicitação de serviço excedeu o limite.');
    return this.transaction(() => {
      let prior = this.db.prepare('SELECT * FROM service_principal_receipts WHERE principal_id=? AND request_id=?').get(actor.principalId, input.requestId);
      const context = { ...input.context };
      if (prior && prior.state !== 'reserved' && VERSIONED_ACTIONS.has(input.capability)) delete context.conversationVersion;
      const authority = this.revalidate(actor, input.capability, context), principal = authority.principal;
      const date = this.now(), day = instant(date).slice(0, 10);
      // Expired dispatched work may have taken effect. Retain its full reservation,
      // release only the execution lease and never turn it into retryable work.
      this.db.prepare("UPDATE service_principal_receipts SET state='unknown',stale=1,reason='Resposta não confirmada antes da validade do despacho.',updated_at=? WHERE principal_id=? AND state='dispatched' AND expires_at<=?").run(date, actor.principalId, date);
      if(prior)prior=this.db.prepare('SELECT * FROM service_principal_receipts WHERE id=?').get(prior.id);
      if (prior) { this.currentReceipt(actor, prior, { completedAction: prior.state !== 'reserved' }); if (prior.payload_hash !== hash(payload)) fail(409, 'A chave já foi usada com outra solicitação.'); return { receipt: this.receiptDTO(prior), replayed: true }; }
      for (const expired of this.db.prepare("SELECT * FROM service_principal_receipts WHERE principal_id=? AND state='reserved'").all(actor.principalId).filter(receipt => receipt.expires_at <= date || receipt.adapter_hash !== authority.adapterHash)) {
        this.db.prepare('UPDATE service_principal_usage SET budget_micros=budget_micros-? WHERE principal_id=? AND day=?').run(expired.charged_cost_micros, actor.principalId, expired.day);
        this.db.prepare("UPDATE service_principal_receipts SET state='invalidated',stale=1,charged_cost_micros=0,reason='Reserva ou configuração perdeu validade.',updated_at=? WHERE id=?").run(date, expired.id);
      }
      const pending = this.db.prepare("SELECT count(*) n FROM service_principal_receipts WHERE principal_id=? AND state IN ('reserved','dispatched')").get(actor.principalId).n;
      if (pending >= principal.maxConcurrent) fail(429, 'O serviço atingiu o limite de execuções simultâneas.');
      this.db.prepare('INSERT OR IGNORE INTO service_principal_usage VALUES (?,?,0,0)').run(actor.principalId, day);
      const consumed = this.db.prepare('UPDATE service_principal_usage SET requests=requests+?,budget_micros=budget_micros+? WHERE principal_id=? AND day=? AND requests+?<=? AND budget_micros+?<=?').run(units, cost, actor.principalId, day, units, principal.dailyRequests, cost, principal.dailyBudgetMicros);
      if (consumed.changes !== 1) fail(429, 'A cota ou o orçamento diário deste serviço foi atingido.');
      const id = randomUUID(), expires = Math.min(date + this.reservationTtlMs, Date.parse(principal.expiresAt));
      this.db.prepare('INSERT INTO service_principal_receipts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, actor.principalId, input.requestId, actor.workspaceId, actor.tenantId, actor.agentId, actor.revision, actor.keyRevision, authority.adapterHash, input.capability, encoded(input.context || {}), hash(payload), day, units, cost, cost, 'reserved', 0, null, null, date, date, expires);
      return { receipt: this.receiptDTO(this.receipt(actor, id)), replayed: false };
    });
  }
  beginDispatch(actor, id) {
    return this.transaction(() => {
      const row = this.receipt(actor, id); this.currentReceipt(actor, row);
      if (row.state !== 'reserved') return { receipt: this.receiptDTO(row), dispatched: false };
      if (row.expires_at <= this.now()) fail(409, 'A reserva expirou. Solicite outra execução.');
      this.db.prepare("UPDATE service_principal_receipts SET state='dispatched',updated_at=? WHERE id=? AND state='reserved'").run(this.now(), id);
      return { receipt: this.receiptDTO(this.receipt(actor, id)), dispatched: true };
    });
  }
  /** recorded: the transport already recorded this action's message, so the version moved with it (dispatch-time checks). */
  assertDispatchCurrent(actor, id, { recorded = false } = {}) {
    const row = this.receipt(actor, id); this.currentReceipt(actor, row, { completedAction: recorded === true });
    if (row.state !== 'dispatched') fail(409, 'O recibo não permite despacho.');
    if (row.expires_at <= this.now()) fail(409, 'A autorização do despacho expirou.');
    return this.receiptDTO(row);
  }
  complete(actor, id, input) {
    fields(input, ['state', 'result', 'actualCostMicros', 'reason']);
    if (!['confirmed', 'failed', 'unknown'].includes(input.state)) fail(400, 'Escolha um estado final válido do recibo.');
    const result = input.result === undefined ? null : encoded(input.result);
    if (result !== null && Buffer.byteLength(result) > 32768 || input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) fail(400, 'Resultado de serviço excedeu o limite.');
    return this.transaction(() => {
      const row = this.receipt(actor, id), proof = this.proofs.get(actor);
      if (row.principal_revision !== proof.revision || row.key_revision !== proof.keyRevision || row.adapter_hash !== proof.adapterHash) fail(409, 'Este ator não iniciou o recibo.');
      if (row.state !== 'dispatched') {
        if (row.state === input.state && row.result === result) return this.receiptDTO(row);
        // The trusted original dispatcher may later learn the actual outcome.
        // Recording it cannot authorize another execution of this receipt.
        if (row.state !== 'unknown') fail(409, 'O recibo já foi encerrado ou não foi despachado.');
      }
      let stale = false; try { this.currentReceipt(actor, row, { completedAction:true }); if (row.expires_at <= this.now()) stale = true; } catch { stale = true; }
      const charged = input.state === 'unknown' ? row.reserved_cost_micros : integer(input.actualCostMicros ?? (input.state === 'failed' ? 0 : row.reserved_cost_micros), 0, row.reserved_cost_micros, 'Custo confirmado');
      this.db.prepare('UPDATE service_principal_usage SET budget_micros=budget_micros-? WHERE principal_id=? AND day=?').run(row.charged_cost_micros - charged, row.principal_id, row.day);
      this.db.prepare('UPDATE service_principal_receipts SET state=?,stale=?,result=?,reason=?,charged_cost_micros=?,updated_at=? WHERE id=?').run(input.state, Number(stale), result, input.reason || null, charged, this.now(), id);
      return this.receiptDTO(this.receipt(actor, id));
    });
  }
  getReceipt(actor, id) {
    const row = this.receipt(actor, id);
    this.currentReceipt(actor, row, { completedAction:row.state !== 'reserved' });
    // A polling-only consumer must also observe an expired dispatch after a restart.
    // Unknown keeps the charge and request identity; it never grants permission to resend.
    if (row.state === 'dispatched' && row.expires_at <= this.now()) {
      this.db.prepare("UPDATE service_principal_receipts SET state='unknown',stale=1,reason='Resposta não confirmada antes da validade do despacho.',updated_at=? WHERE id=? AND state='dispatched' AND expires_at<=?").run(this.now(), id, this.now());
      return this.receiptDTO(this.receipt(actor, id));
    }
    return this.receiptDTO(row);
  }
  getReceiptByRequestId(actor, requestId) {
    if (!identity(requestId) || requestId.length < 8) fail(400, 'Informe a requestId original da operação.');
    const proof = actor && this.proofs.get(actor);
    const row = proof && this.db.prepare('SELECT id FROM service_principal_receipts WHERE principal_id=? AND request_id=?').get(proof.principalId, requestId);
    if (!row) fail(404, 'Recibo não encontrado para este serviço.');
    return this.getReceipt(actor, row.id);
  }
  receipts(actor, tenantId, principalId) {
    const scope = this.scope(actor, tenantId); this.principal(scope, principalId);
    return { receipts: this.db.prepare('SELECT * FROM service_principal_receipts WHERE principal_id=? ORDER BY created_at DESC,id LIMIT 100').all(principalId).map(row => this.receiptDTO(row)) };
  }
}
