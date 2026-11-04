import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { allowedFields } from './access.js';
import { boundConversationContact } from './contacts.js';

/** Quotas include archived records; archive preserves text, it is not erasure. */
export const AGENT_MEMORY_LIMITS = Object.freeze({ tenant: 200, subject: 20, references: 12, contextBytes: 4096, title: 100, content: 1500, expiryDays: 365 });
const clone = structuredClone, now = () => new Date().toISOString();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/u.test(value);
function fields(input, names) {
  allowedFields(input, names);
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(property => !Object.hasOwn(property, 'value'))) fail(400, 'Informe somente campos de dados.');
}
function version(value) { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a versão atual.'); }
function increment(value) { version(value); if (value === Number.MAX_SAFE_INTEGER) fail(409, 'Limite de versões atingido.'); return value + 1; }
function text(value, limit, label, multiline = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > limit || controls.test(value)
    || !multiline && /[\t\r\n]/u.test(value)) fail(400, `${label} inválido ou acima do limite.`);
  return value.trim();
}
function expiry(value, instant = Date.now()) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) fail(400, 'Informe uma validade ISO em UTC.');
  const date = Date.parse(value);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 19) !== value.slice(0, 19)
    || date <= instant || date > instant + AGENT_MEMORY_LIMITS.expiryDays * 86400000) fail(400, 'A validade deve ser futura e de até 365 dias.');
  return new Date(date).toISOString();
}
function agentOf(state, agentId) {
  if (!id(agentId)) fail(400, 'Informe o agente.');
  const agents = (state.agents || []).filter(agent => agent.id === agentId);
  if (agents.length !== 1) fail(404, 'Agente não encontrado nesta empresa.');
  const agent = agents[0];
  if (agent.provider !== 'hermes' || agent.mode !== 'copilot' || agent.configured !== true) fail(409, 'Configure um copiloto Hermes para usar memória.');
  return agent;
}
function conversationOf(state, conversationId) {
  if (!id(conversationId)) fail(400, 'Informe o atendimento.');
  const matches = (state.conversations || []).filter(conversation => conversation.id === conversationId);
  if (matches.length !== 1) fail(404, 'Atendimento não encontrado nesta empresa.');
  const conversation = matches[0];
  if (!(state.channels || []).some(channel => channel.id === conversation.channelId)) fail(409, 'O canal do atendimento não está disponível.');
  return conversation;
}
function contactOf(state, contactId) {
  const contacts = (state.contacts || []).filter(contact => contact.id === contactId);
  if (!id(contactId) || contacts.length !== 1 || contacts[0].archivedAt || contacts[0].mergedIntoId) fail(409, 'Vincule um contato ativo ao atendimento.');
  return contacts[0];
}
function contactFingerprint(contact) {
  if (!Array.isArray(contact.identities) || contact.identities.some(identity => !identity || typeof identity !== 'object'
    || !id(identity.channelId) || !['person', 'group'].includes(identity.kind) || typeof identity.externalId !== 'string' || !identity.externalId)) fail(409, 'O vínculo do contato precisa ser revisado.');
  const identities = contact.identities.map(({ channelId, kind, externalId }) => ({ channelId, kind, externalId }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return hash({ id: contact.id, type: contact.type || 'person', identities });
}
function bindingOf(state, conversation) {
  let contact;
  try { contact = boundConversationContact(state, conversation); }
  catch (error) {
    if ([400, 404, 409].includes(error.status)) fail(409, 'O vínculo de identidade do atendimento precisa ser revisado.');
    throw error;
  }
  return { conversationId: conversation.id, channelId: conversation.channelId, departmentId: conversation.departmentId || null,
    contactId: contact?.id || null, contactHash: contact ? contactFingerprint(contact) : null,
    identityHash: hash({ kind: conversation.conversationKind || 'person', remoteJid: conversation.remoteJid || null, remoteChatId: conversation.remoteChatId || null }),
    ...((state.channels || []).some(channel => channel.id === conversation.channelId && channel.kind === 'webchat') && conversation.webchatVisitor?.verified === true
      ? { webchatIdentityHash: hash({ verified: true, externalId: conversation.webchatVisitor.externalId }) } : {}) };
}
const originDTO = origin => ({ conversationId: origin.conversationId, channelId: origin.channelId, departmentId: origin.departmentId, contactId: origin.contactId });
const expired = (record, instant = Date.now()) => record.expiresAt !== null && Date.parse(record.expiresAt) <= instant;
const operationAdmin = actor => actor?.role === 'reseller' && id(actor.userId) && !actor.supportGrantId && !actor.serviceId;
function recordDTO(record, instant = Date.now()) {
  return { id: record.id, agentId: record.agentId, title: record.title, content: record.content, scope: record.scope, version: record.version,
    status: record.status, expiresAt: record.expiresAt, createdBy: record.createdBy, reviewedBy: record.reviewedBy,
    createdAt: record.createdAt, updatedAt: record.updatedAt, origin: originDTO(record.origin), expired: expired(record, instant) };
}
const pin = record => ({ id: record.id, version: record.version, hash: hash(record), scope: record.scope, expiresAt: record.expiresAt });

/**
 * Private SQLite authority. Text never enters tenant JSON, audit descriptions or PG.
 * access and resolveActor must be synchronous and return explicit authority.
 * snapshot.references contains request-local text; persist only pins/binding/selectionHash.
 * Contact linking is explicit: same display name or phone never grants shared memory.
 */
export class AgentMemory {
  constructor(store, { access = () => false, resolveActor = () => null } = {}) {
    this.store = store.sync ?? store;
    if (typeof access !== 'function' || typeof resolveActor !== 'function') throw new TypeError('Autoridade de memória inválida.');
    this.access = access; this.resolveActor = resolveActor;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),tenant_id TEXT NOT NULL REFERENCES tenants(id),data TEXT NOT NULL CHECK(json_valid(data))
    ); CREATE INDEX IF NOT EXISTS agent_memories_scope ON agent_memories(reseller_id,tenant_id);`);
  }
  _allowed(actor, state, conversation, mode) { return this.access(actor, state, conversation, mode) === true; }
  _context(actor, state, conversationId, conversationVersion) {
    if (!actor || !id(actor.userId) || !id(actor.resellerId) || actor.resellerId !== state.resellerId
      || !this.store.db.prepare('SELECT id FROM tenants WHERE reseller_id=? AND id=?').get(actor.resellerId, state.id)) fail(403, 'Seu acesso não permite esta memória.');
    const conversation = conversationOf(state, conversationId);
    if (!this._allowed(actor, state, conversation, 'read')) fail(403, 'Seu acesso não permite consultar este atendimento.');
    if (conversationVersion !== undefined) {
      version(conversationVersion);
      if (conversation.version !== conversationVersion) fail(409, 'O atendimento mudou. Atualize antes de continuar.');
      if (conversation.status === 'closed') fail(409, 'O atendimento está encerrado.');
    }
    return conversation;
  }
  _rows(actor, tenantId) {
    return this.store.db.prepare('SELECT data FROM agent_memories WHERE reseller_id=? AND tenant_id=? ORDER BY id').all(actor.resellerId, tenantId).map(row => JSON.parse(row.data));
  }
  _record(actor, tenantId, recordId) {
    if (!id(recordId)) fail(400, 'Informe a memória.');
    const row = this.store.db.prepare('SELECT data FROM agent_memories WHERE reseller_id=? AND tenant_id=? AND id=?').get(actor.resellerId, tenantId, recordId);
    if (!row) fail(404, 'Memória não encontrada nesta empresa.');
    return JSON.parse(row.data);
  }
  _origin(actor, state, record, conversation, mode = 'read') {
    try {
      const origin = conversationOf(state, record.origin.conversationId);
      if (hash(bindingOf(state, origin)) !== hash(record.origin) || !this._allowed(actor, state, origin, mode)) return false;
      if (record.scope === 'contact') {
        const contact = boundConversationContact(state, conversation);
        if (!contact) return false;
        if (contact.id !== record.subjectId || contact.id !== record.origin.contactId || contactFingerprint(contact) !== record.origin.contactHash) return false;
      }
      return record.scope === 'operation' || record.scope === 'contact';
    } catch (error) { if ([400, 403, 404, 409].includes(error.status)) return false; throw error; }
  }
  _write(actor, state, conversation, scope) {
    if (scope === 'operation') {
      if (!operationAdmin(actor)) fail(403, 'A memória da operação exige administrador humano.');
      return;
    }
    if (!this._allowed(actor, state, conversation, 'write') || conversation.owner !== 'human'
      || !id(conversation.assignedUserId) || conversation.assignedUserId !== actor.userId || actor.serviceId) fail(403, 'Somente o responsável autorizado pode revisar a memória do cliente.');
    if (!bindingOf(state, conversation).contactId) fail(409, 'Vincule um contato ativo ao atendimento.');
  }
  _save(actor, tenantId, record) {
    this.store.db.prepare('UPDATE agent_memories SET data=? WHERE reseller_id=? AND tenant_id=? AND id=?').run(JSON.stringify(record), actor.resellerId, tenantId, record.id);
    return recordDTO(record);
  }
  list(actor, tenantId, conversationId, options = {}) {
    fields(options, ['agentId']);
    const state = this.store.tenant(actor, tenantId), conversation = this._context(actor, state, conversationId);
    agentOf(state, options.agentId);
    const items = this._rows(actor, tenantId).filter(record => record.agentId === options.agentId && this._origin(actor, state, record, conversation)).map(record => recordDTO(record));
    let canWrite = false; try { this._write(actor, state, conversation, 'contact'); canWrite = conversation.status !== 'closed'; } catch (error) { if (![403, 409].includes(error.status)) throw error; }
    return { items, canWrite, canManageOperation: operationAdmin(actor) && conversation.status !== 'closed' };
  }
  create(actor, tenantId, conversationId, input) {
    fields(input, ['agentId', 'scope', 'title', 'content', 'expiresAt', 'conversationVersion', 'reviewed']);
    version(input.conversationVersion);
    if (!['contact', 'operation'].includes(input.scope) || input.reviewed !== true) fail(400, 'Escolha o escopo e confirme a revisão humana.');
    const values = { title: text(input.title, AGENT_MEMORY_LIMITS.title, 'Título'), content: text(input.content, AGENT_MEMORY_LIMITS.content, 'Conteúdo', true), expiresAt: expiry(input.expiresAt) };
    return this.store.mutate(actor, tenantId, 'Memória revisada criada', state => {
      const conversation = this._context(actor, state, conversationId, input.conversationVersion); agentOf(state, input.agentId); this._write(actor, state, conversation, input.scope);
      const origin = bindingOf(state, conversation), subjectId = input.scope === 'contact' ? origin.contactId : input.agentId;
      const rows = this._rows(actor, tenantId);
      if (rows.length >= AGENT_MEMORY_LIMITS.tenant || rows.filter(record => record.agentId === input.agentId && record.scope === input.scope && record.subjectId === subjectId).length >= AGENT_MEMORY_LIMITS.subject) fail(429, 'Limite de memórias preservadas atingido.');
      const date = now(), record = { id: randomUUID(), agentId: input.agentId, scope: input.scope, subjectId, ...values, version: 1, status: 'active',
        origin, createdBy: actor.userId, reviewedBy: actor.userId, createdAt: date, updatedAt: date };
      this.store.db.prepare('INSERT INTO agent_memories(id,reseller_id,tenant_id,data) VALUES (?,?,?,?)').run(record.id, actor.resellerId, tenantId, JSON.stringify(record));
      return recordDTO(record);
    });
  }
  update(actor, tenantId, conversationId, recordId, input) {
    fields(input, ['version', 'conversationVersion', 'title', 'content', 'expiresAt', 'reviewed']); version(input.version); version(input.conversationVersion);
    if (input.reviewed !== true) fail(400, 'Confirme a revisão humana.');
    const values = { title: text(input.title, AGENT_MEMORY_LIMITS.title, 'Título'), content: text(input.content, AGENT_MEMORY_LIMITS.content, 'Conteúdo', true), expiresAt: expiry(input.expiresAt) };
    return this._mutate(actor, tenantId, conversationId, recordId, input, 'Memória revisada atualizada', (record) => Object.assign(record, values, { reviewedBy: actor.userId }));
  }
  archive(actor, tenantId, conversationId, recordId, input) {
    fields(input, ['version', 'conversationVersion']); version(input.version); version(input.conversationVersion);
    return this._mutate(actor, tenantId, conversationId, recordId, input, 'Memória arquivada', record => { if (record.status !== 'active') fail(409, 'Esta memória já está arquivada.'); record.status = 'archived'; });
  }
  reactivate(actor, tenantId, conversationId, recordId, input) {
    fields(input, ['version', 'conversationVersion', 'reviewed']); version(input.version); version(input.conversationVersion);
    if (input.reviewed !== true) fail(400, 'Confirme a revisão humana.');
    return this._mutate(actor, tenantId, conversationId, recordId, input, 'Memória revisada reativada', record => {
      if (record.status !== 'archived') fail(409, 'Esta memória já está ativa.');
      if (expired(record)) fail(409, 'Edite a validade antes de reativar a memória.');
      record.status = 'active'; record.reviewedBy = actor.userId;
    });
  }
  _mutate(actor, tenantId, conversationId, recordId, input, action, change) {
    return this.store.mutate(actor, tenantId, action, state => {
      const conversation = this._context(actor, state, conversationId, input.conversationVersion), record = this._record(actor, tenantId, recordId);
      agentOf(state, record.agentId); this._write(actor, state, conversation, record.scope);
      if (!this._origin(actor, state, record, conversation, record.scope === 'operation' ? 'read' : 'write')) fail(403, 'A origem ou o vínculo desta memória não permite alteração.');
      if (record.version !== input.version) fail(409, 'A memória mudou. Atualize antes de continuar.');
      const nextVersion = increment(record.version); change(record); record.version = nextVersion; record.updatedAt = now();
      return this._save(actor, tenantId, record);
    });
  }
  snapshot(actor, state, agent, conversation) {
    // Existing services/demonstration callers have no explicit memory capability.
    if (!actor?.userId || actor.serviceId || actor.kind === 'service') return null;
    if (actor.resellerId !== state.resellerId || !id(actor.userId)
      || !this.store.db.prepare('SELECT id FROM tenants WHERE reseller_id=? AND id=?').get(actor.resellerId, state.id)) fail(403, 'Seu acesso não permite esta memória.');
    const current = conversationOf(state, conversation.id); agentOf(state, agent.id);
    const canRead = this._allowed(actor, state, current, 'read');
    let origin, contact = null;
    try { origin = bindingOf(state, current); contact = origin.contactId ? contactOf(state, origin.contactId) : null; }
    catch (error) {
      if (error.status !== 409) throw error;
      origin = { contactId: current.contactId || null, contactHash: null };
    }
    const binding = { workspaceId: actor.resellerId, tenantId: state.id, agentId: agent.id, conversationId: current.id,
      conversationVersion: current.version, channelId: current.channelId, departmentId: current.departmentId || null,
      contactId: origin.contactId, contactHash: origin.contactHash, contactVersion: contact?.version || null,
      owner: current.owner, assignedUserId: current.assignedUserId || null, actorUserId: actor.userId, canRead };
    const records = (canRead ? this._rows(actor, state.id) : []).filter(record => record.agentId === agent.id && record.status === 'active'
      && !expired(record) && this._origin(actor, state, record, current)).sort((left, right) => left.scope.localeCompare(right.scope) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const pins = [], references = [];
    for (const record of records) {
      const reference = { id: record.id, title: record.title, content: record.content, scope: record.scope, expiresAt: record.expiresAt };
      if (references.length >= AGENT_MEMORY_LIMITS.references) break;
      if (Buffer.byteLength(JSON.stringify([...references, reference])) > AGENT_MEMORY_LIMITS.contextBytes) continue;
      references.push(reference); pins.push(pin(record));
    }
    return { pins, references, binding, selectionHash: hash(records.map(pin)) };
  }
  _supportAuthorize(authorize) {
    if (typeof authorize !== 'function') fail(403, 'A memória de suporte exige uma prova interna atual.');
    const allowed = authorize();
    if (allowed?.then) { Promise.resolve(allowed).catch(() => {}); fail(500, 'A prova da memória de suporte precisa ser síncrona.'); }
    if (allowed !== true) fail(403, 'O suporte perdeu autorização para esta memória.');
  }
  _supportIdentity(state, conversation, { historical = false } = {}) {
    const channel = (state.channels || []).find(item => item.id === conversation.channelId), config = channel?.webchat?.identity;
    if (channel?.kind !== 'webchat' || channel.transport !== 'elozi-webchat' || channel.state !== 'connected' || !channel.webchat?.enabled
      || !channel.centralSupportScope?.origins?.length || !channel.centralSupportScope.productIds?.length
      || conversation.webchatVisitor?.verified !== true || typeof conversation.webchatVisitor.externalId !== 'string'
      || !id(conversation.remoteSessionId) || config?.enabled !== true) return null;
    if (!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='webchat_identity_sessions'").get()) return null;
    const row = this.store.db.prepare('SELECT session_id,origin,issuer,external_id,kid,identity_version,verified_at,expires_at,revoked_at FROM webchat_identity_sessions WHERE session_id=? AND tenant_id=? AND channel_id=? AND external_id=?')
      .get(conversation.remoteSessionId, state.id, channel.id, conversation.webchatVisitor.externalId);
    const key = config.keys?.find(item => item.kid === row?.kid);
    if (!row || row.revoked_at !== null || !Number.isSafeInteger(row.expires_at) || !Number.isSafeInteger(row.verified_at)
      || !historical && row.expires_at <= Date.now() || row.identity_version !== config.identityVersion || row.issuer !== config.issuer
      || !channel.webchat.origins?.includes(row.origin) || !channel.centralSupportScope.origins.includes(row.origin)
      || !key || key.revokedAt !== null || key.validUntil !== null && (!Number.isSafeInteger(key.validUntil) || key.validUntil <= Date.now())) return null;
    // A valid renewal updates these timestamps without changing the identity.
    // Expiry and timestamp validity remain checked above on every lookup.
    const identity = { ...row }; delete identity.verified_at; delete identity.expires_at;
    return { hash: hash(identity), externalId: row.external_id, channelId: channel.id };
  }
  /** Internal own-support path. authorize attests the live job proof and complete current identity/key verification. */
  supportSnapshot(state, agent, conversation, { authorize } = {}) {
    this._supportAuthorize(authorize);
    const row = this.store.db.prepare('SELECT data FROM resellers WHERE id=?').get(state.resellerId);
    if (!row || (JSON.parse(row.data).accountKind || (state.resellerId === 'mep-demo' ? 'platform' : 'reseller')) !== 'platform'
      || !this.store.db.prepare('SELECT 1 FROM tenants WHERE reseller_id=? AND id=?').get(state.resellerId, state.id)) fail(403, 'A memória interna pertence somente ao suporte próprio.');
    const current = conversationOf(state, conversation.id), configuredAgent = agentOf(state, agent.id);
    const channel = state.channels.find(item => item.id === current.channelId);
    if (current.status === 'closed' || channel.supportAssistant?.enabled !== true || channel.supportAssistant.agentId !== configuredAgent.id) return null;
    const identity = this._supportIdentity(state, current);
    if (!identity) return null;
    let origin, contact;
    try { origin = bindingOf(state, current); contact = contactOf(state, origin.contactId); }
    catch (error) { if ([400, 403, 404, 409].includes(error.status)) return null; throw error; }
    const binding = { workspaceId: state.resellerId, tenantId: state.id, agentId: configuredAgent.id, conversationId: current.id,
      conversationVersion: current.version, channelId: current.channelId, contactId: contact.id, contactHash: origin.contactHash,
      contactVersion: contact.version || null, identityHash: identity.hash, webchatIdentityHash: origin.webchatIdentityHash,
      owner: current.owner, assignedUserId: current.assignedUserId || null, configurationVersion: channel.supportAssistant.version,
      webchatRevision: channel.webchat.version, identityVersion: channel.webchat.identity.identityVersion };
    const records = this._rows({ resellerId: state.resellerId }, state.id).filter(record => {
      if (record.agentId !== configuredAgent.id || record.scope !== 'contact' || record.status !== 'active' || !id(record.reviewedBy)
        || record.expiresAt !== null && (!Number.isFinite(Date.parse(record.expiresAt)) || expired(record)) || record.subjectId !== contact.id || record.origin?.channelId !== current.channelId
        || record.origin.contactId !== contact.id || record.origin.contactHash !== origin.contactHash || !record.origin.webchatIdentityHash) return false;
      try {
        const source = conversationOf(state, record.origin.conversationId), proof = this._supportIdentity(state, source, { historical: true });
        return proof?.externalId === identity.externalId && source.channelId === current.channelId && hash(bindingOf(state, source)) === hash(record.origin);
      } catch (error) { if ([400, 403, 404, 409].includes(error.status)) return false; throw error; }
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const pins = [], references = [];
    for (const record of records) {
      const reference = { id: record.id, title: record.title, content: record.content, scope: record.scope, expiresAt: record.expiresAt };
      if (references.length >= AGENT_MEMORY_LIMITS.references) break;
      if (Buffer.byteLength(JSON.stringify([...references, reference])) > AGENT_MEMORY_LIMITS.contextBytes) continue;
      references.push(reference); pins.push(pin(record));
    }
    this._supportAuthorize(authorize);
    return { pins, references, binding, selectionHash: hash(records.map(pin)) };
  }
  supportCurrent(state, run, { authorize } = {}) {
    if (!Object.hasOwn(run, 'supportMemorySnapshot')) return true;
    try {
      const saved = run.supportMemorySnapshot;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !['pins', 'binding', 'selectionHash'].includes(key))
        || run.actorUserId || run.serviceId || run.supportGrantId || typeof run.id !== 'string' || !run.id.startsWith('support_')
        || run.tenantId !== state.id || saved.binding?.tenantId !== state.id || saved.binding?.agentId !== run.agentId
        || saved.binding?.conversationId !== run.conversationId || saved.binding?.channelId !== run.channelIdAtStart
        || saved.binding?.conversationVersion !== run.conversationVersion) return false;
      const conversation = conversationOf(state, run.conversationId), agent = agentOf(state, run.agentId);
      const snapshot = this.supportSnapshot(state, agent, conversation, { authorize });
      if (!snapshot) return false;
      const { references, ...current } = snapshot;
      return hash(saved) === hash(current);
    } catch (error) { if ([400, 403, 404, 409, 500].includes(error.status)) return false; throw error; }
  }
  current(state, run) {
    if (!Object.hasOwn(run, 'memorySnapshot')) return true;
    try {
      const saved = run.memorySnapshot;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !['pins', 'binding', 'selectionHash'].includes(key))) return false;
      let actor; try { actor = this.resolveActor(run); } catch { return false; }
      if (!actor || actor.userId !== run.actorUserId || actor.resellerId !== state.resellerId || saved.binding?.tenantId !== state.id
        || saved.binding?.agentId !== run.agentId || saved.binding?.conversationId !== run.conversationId) return false;
      const conversation = conversationOf(state, run.conversationId), agent = agentOf(state, run.agentId);
      if (conversation.status === 'closed') return false;
      const snapshot = this.snapshot(actor, state, agent, conversation);
      if (!snapshot) return false;
      const { references, ...current } = snapshot;
      return hash(saved) === hash(current);
    } catch (error) { if ([400, 403, 404, 409].includes(error.status)) return false; throw error; }
  }
  visible(actor, state, run) {
    if (!Object.hasOwn(run, 'memorySnapshot')) return true;
    if (!this.current(state, run)) return false;
    // Inbox ACL still controls the run DTO; an empty memory context adds no
    // contact-read requirement to an otherwise legitimate ordinary draft.
    if (run.memorySnapshot.pins.length === 0) return true;
    try {
      const conversation = this._context(actor, state, run.conversationId), agent = agentOf(state, run.agentId);
      const current = this.snapshot(actor, state, agent, conversation);
      if (!current || !current.binding.canRead) return false;
      return run.memorySnapshot.pins.every(saved => current.pins.some(item => item.id === saved.id && item.version === saved.version && item.hash === saved.hash));
    } catch (error) { if ([400, 403, 404, 409].includes(error.status)) return false; throw error; }
  }
}
