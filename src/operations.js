import { randomUUID } from 'node:crypto';
import { fail, text } from './store.js';
import { BUSINESS_PERMISSIONS, OPERATOR_DEFAULT_PERMISSIONS, accessOf, scopeAllows } from './access.js';
import { preserveFlowDepartmentReferences } from './flows.js';
import { validateProfileAvatar } from './profile.js';
import { tenantIndex } from './inbox-index.js';

const safeAvatar = value => { try { return validateProfileAvatar(value ?? null); } catch (error) { if (error.status === 400) return null; throw error; } };
const avatarField = value => { const avatar=safeAvatar(value); return avatar ? {avatar} : {}; };

const presenceNames = new Set(['available', 'busy', 'away', 'offline']);
const optionalText = (value, max) => value === undefined || typeof value === 'string' && !value.trim() ? '' : text(value, max);
const scope = (tenantId, conversation, departmentId) => ({ tenantId, channelId: conversation.channelId, departmentId: departmentId || 'unassigned' });
const participantRecords = conversation => [...new Map((Array.isArray(conversation.participants) ? conversation.participants : []).filter(item => typeof item?.userId === 'string' && item.userId).map(item => [item.userId, { userId: item.userId, name: typeof item.name === 'string' ? item.name.slice(0, 80) : '', addedAt: typeof item.addedAt === 'string' ? item.addedAt : null, addedByUserId: typeof item.addedByUserId === 'string' ? item.addedByUserId : null,...(typeof item.supportGrantId==='string'&&item.supportGrantId?{supportGrantId:item.supportGrantId}:{}) }])).values()];
const snapshot = conversation => ({ owner: conversation.owner || 'queue', assignedUserId: conversation.assignedUserId || null, assignedUserName: conversation.assignedUserName || null,...(conversation.assignedSupportGrantId?{assignedSupportGrantId:conversation.assignedSupportGrantId}:{}), agentId: conversation.agentId || null, departmentId: conversation.departmentId || null, department: conversation.department || '', participants: participantRecords(conversation) });
const routeSkipped = Symbol('route-skipped');
/** Assignment note for an agent: the autopilot answers by itself only on the channels its administrator opted in. */
function agentAssignmentText(agent, conversation) {
  const config = agent?.autopilot;
  const autonomous = agent?.provider === 'hermes' && agent.mode === 'copilot' && agent.configured === true && config?.enabled === true
    && Array.isArray(config.channelIds) && config.channelIds.includes(conversation.channelId);
  if (autonomous) return `Conversa atribuída ao agente ${agent.name}. O piloto automático responde neste canal com as fontes autorizadas e passa o atendimento para a equipe quando precisar de uma pessoa.`;
  // An agent connected by MCP answers by itself only when its service identity holds reply.send.
  if (agent?.provider === 'mcp') return `Conversa atribuída ao agente conectado ${agent.name}. Ele responde sozinho somente com envio autorizado na identidade de serviço; a equipe pode assumir a qualquer momento.`;
  return `Conversa atribuída ao copiloto ${agent.name}. O envio permanece com a equipe humana.`;
}
function inputFields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos permitidos para esta operação.');
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a versão atual para salvar.'); return value; }
function identifier(value) { if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 160 || /[\x00-\x20\x7f]/.test(value)) fail(400, 'Identidade inválida.'); return value; }
function appendEvent(conversation, actor, { type, from, to, reason = '', origin = 'inbox', createdAt = new Date().toISOString() }) {
  const event = { id: randomUUID(), conversationId: conversation.id, type, actorId: actor.userId || null, actorName: actor.name || 'Sistema',...(actor.supportGrantId?{supportGrantId:actor.supportGrantId}:{}), from, to, createdAt, reason, origin };
  conversation.attendantEvents ||= []; conversation.attendantEvents.push(event); return event;
}
/** Lifecycle callers own the encompassing version, transaction and transport invalidation. */
export function clearConversationParticipants(conversation, actor, { reason = '', origin = 'inbox', createdAt = new Date().toISOString() } = {}) {
  const removed = participantRecords(conversation), from = snapshot(conversation);
  conversation.participants = [];
  for (const participant of removed) appendEvent(conversation, actor, { type: 'participant-removed', from: { ...from, participant }, to: snapshot(conversation), reason: optionalText(reason, 240), origin, createdAt });
  return removed;
}
export function noteStatus(conversation, actor, previousStatus, { reason = '', origin = 'inbox', createdAt } = {}) {
  if (previousStatus === conversation.status) return null;
  if (!['open', 'pending', 'closed'].includes(previousStatus) || !['open', 'pending', 'closed'].includes(conversation.status)) fail(400, 'Status de atendimento inválido.');
  return appendEvent(conversation, actor, { type: conversation.status === 'closed' ? 'closed' : previousStatus === 'closed' ? 'reopened' : 'status', from: { status: previousStatus }, to: { status: conversation.status, assignedUserId: conversation.assignedUserId || null, assignedUserName: conversation.assignedUserName || null }, reason: optionalText(reason, 240), origin, createdAt });
}

export class Operations {
  constructor(store, auth, { now = Date.now } = {}) {
    if (typeof auth?.can !== 'function' || typeof auth?.assignees !== 'function' || typeof now !== 'function') throw new Error('Configuração de atendimento inválida.');
    this.store = store; this.auth = auth; this.now = now;
  }
  date() { return new Date(this.now()).toISOString(); }
  permission(actor, capability, context) { if (!this.auth.can(actor, capability, context)) fail(403, 'Seu acesso não permite esta operação neste canal ou departamento.'); }
  admin(actor) { this.store.admin(actor); return this.auth.admin(actor); }
  conversation(state, id, version) {
    const conversation = state.conversations.find(item => item.id === id);
    if (!conversation) fail(404, 'Conversa não encontrada nesta empresa.');
    if (version !== undefined && (conversation.version || 1) !== version) fail(409, 'A conversa mudou. Atualize antes de continuar.');
    return conversation;
  }
  department(state, id) {
    const department = (state.departments || []).find(item => item.id === id);
    if (!department) fail(404, 'Departamento não encontrado nesta empresa.');
    return department;
  }
  currentDepartment(state, conversation) {
    return (state.departments || []).find(item => conversation.departmentId ? item.id === conversation.departmentId : item.name === conversation.department) || null;
  }
  list(actor, tenantId) {
    this.permission(actor, 'inbox.read', { tenantId, aggregate: true });
    const state = this.store.tenant(actor, tenantId);
    return (state.departments || []).filter(department => this.auth.can(actor, 'inbox.read', { tenantId, departmentId: department.id, aggregate: true })).map(department => ({ ...department, isDefault: state.defaultDepartmentId === department.id }));
  }
  departmentInput(actor, tenantId, input, previous = {}) {
    const data = { name: previous.name || '', color: previous.color || '#3157d5', description: previous.description || '', memberIds: previous.memberIds || [], distribution: previous.distribution || 'manual', active: previous.active !== false };
    if (Object.hasOwn(input, 'name')) data.name = text(input.name, 80);
    if (!data.name) fail(400, 'Informe o nome do departamento.');
    if (Object.hasOwn(input, 'color')) { if (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color)) fail(400, 'Escolha uma cor hexadecimal válida.'); data.color = input.color.toLowerCase(); }
    if (Object.hasOwn(input, 'description')) data.description = optionalText(input.description, 180);
    if (Object.hasOwn(input, 'distribution')) { if (!['manual', 'round_robin'].includes(input.distribution)) fail(400, 'Escolha distribuição manual ou circular.'); data.distribution = input.distribution; }
    if (Object.hasOwn(input, 'active')) { if (typeof input.active !== 'boolean') fail(400, 'Informe se o departamento está ativo.'); data.active = input.active; }
    if (Object.hasOwn(input, 'isDefault') && typeof input.isDefault !== 'boolean') fail(400, 'Informe se este departamento é o padrão.');
    if (input.isDefault === true && !data.active) fail(400, 'Ative o departamento antes de escolhê-lo como padrão.');
    if (Object.hasOwn(input, 'memberIds')) {
      if (!Array.isArray(input.memberIds) || input.memberIds.length > 100) fail(400, 'Informe até cem membros do departamento.');
      data.memberIds = [...new Set(input.memberIds.map(identifier))];
      const eligible = new Set(this.auth.assignees(actor, tenantId, { aggregate: true }).map(user => user.id));
      if (data.memberIds.some(id => !eligible.has(id))) fail(400, 'Vincule somente pessoas ativas com atendimento nesta empresa.');
    }
    return data;
  }
  create(actor, tenantId, input) {
    this.admin(actor); inputFields(input, ['name', 'color', 'description', 'memberIds', 'distribution', 'active', 'isDefault']);
    return this.store.mutate(actor, tenantId, 'Departamento criado', state => {
      this.admin(actor);
      const data = this.departmentInput(actor, tenantId, input);
      state.departments ||= [];
      if (state.departments.some(item => item.name.trim().toLowerCase() === data.name.toLowerCase())) fail(409, 'Já existe um departamento com este nome.');
      if (state.departments.length >= 100) fail(400, 'Limite de departamentos desta empresa atingido.');
      const department = { id: randomUUID(), ...data, cursor: 0, version: 1 };
      state.departments.push(department);
      if (input.isDefault === true) state.defaultDepartmentId = department.id;
      return { ...department, isDefault: state.defaultDepartmentId === department.id };
    });
  }
  update(actor, tenantId, departmentId, input) {
    this.admin(actor); inputFields(input, ['version', 'name', 'color', 'description', 'memberIds', 'distribution', 'active', 'isDefault']); revision(input.version);
    return this.store.mutate(actor, tenantId, 'Departamento atualizado', state => {
      this.admin(actor);
      const department = this.department(state, departmentId);
      if ((department.version || 1) !== input.version) fail(409, 'O departamento mudou. Atualize antes de continuar.');
      const data = this.departmentInput(actor, tenantId, input, department);
      if (state.departments.some(item => item.id !== department.id && item.name.trim().toLowerCase() === data.name.toLowerCase())) fail(409, 'Já existe um departamento com este nome.');
      if (data.name !== department.name) preserveFlowDepartmentReferences(state, department);
      Object.assign(department, data, { version: (department.version || 1) + 1 });
      if (input.isDefault === true) state.defaultDepartmentId = department.id;
      if ((!department.active || input.isDefault === false) && state.defaultDepartmentId === department.id) state.defaultDepartmentId = null;
      return { ...department, isDefault: state.defaultDepartmentId === department.id };
    });
  }
  event(conversation, actor, { type, from, to, reason = '', origin = 'inbox' }) {
    return appendEvent(conversation, actor, { type, from, to, reason, origin, createdAt: this.date() });
  }
  noteStatus(conversation, actor, previousStatus, { reason = '', origin = 'inbox' } = {}) {
    return noteStatus(conversation, actor, previousStatus, { reason, origin, createdAt: this.date() });
  }
  assignees(actor, tenantId, { channelId, departmentId } = {}) {
    const state = this.store.tenant(actor, tenantId);
    const department = departmentId && departmentId !== 'unassigned' ? this.department(state, departmentId) : null;
    return this.auth.assignees(actor, tenantId, { channelId, departmentId: departmentId || 'unassigned' }).filter(user => !department || user.role === 'reseller' || user.supportGrantId || (department.memberIds || []).includes(user.id));
  }
  participantAssignees(actor, tenantId, state, conversation) {
    const department = this.currentDepartment(state, conversation);
    if (department?.active === false) return [];
    return this.assignees(actor, tenantId, scope(tenantId, conversation, department?.id));
  }
  canManageParticipants(actor, tenantId, state, conversation, current = this.auth.currentActor(actor)) {
    if (!['open', 'pending'].includes(conversation.status) || conversation.owner !== 'human' || !conversation.assignedUserId) return false;
    let owner = this.auth.db.prepare(`SELECT id,role,reseller_id,tenant_ids,platform_admin,disabled_at FROM auth_users WHERE id=?`).get(conversation.assignedUserId);
    if(conversation.assignedSupportGrantId){try{owner=this.auth.currentActor({userId:conversation.assignedUserId,resellerId:actor.resellerId,supportGrantId:conversation.assignedSupportGrantId});}catch(error){if([400,403,404].includes(error.status))return false;throw error;}}
    if (!owner || owner.disabled_at !== null || owner.role === 'operator' && !JSON.parse(owner.tenant_ids).includes(tenantId)) return false;
    if (owner.reseller_id !== actor.resellerId && !(owner.platform_admin && this.auth.db.prepare('SELECT 1 FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(owner.id, actor.resellerId))) return false;
    const context = scope(tenantId, conversation, this.currentDepartment(state, conversation)?.id);
    if(actor.supportGrantId&&conversation.assignedSupportGrantId!==actor.supportGrantId)return false;
    return (current.role === 'reseller' || current.id === conversation.assignedUserId) && this.auth.can(actor, 'inbox.read', context) && this.auth.can(actor, 'inbox.transfer', context);
  }
  participants(actor, tenantId, conversationId) {
    const state = this.store.tenant(actor, tenantId), conversation = this.conversation(state, conversationId), current = this.auth.currentActor(actor);
    this.permission(actor, 'inbox.read', scope(tenantId, conversation, this.currentDepartment(state, conversation)?.id));
    const canManage = this.canManageParticipants(actor, tenantId, state, conversation, current);
    const people = this.participantAssignees(actor, tenantId, state, conversation), byId = new Map(people.map(person => [person.id, person]));
    const eligible = person => byId.has(person.userId)&&(!person.supportGrantId||byId.get(person.userId).supportGrantId===person.supportGrantId);
    const usable = ['open', 'pending'].includes(conversation.status) && conversation.owner === 'human' && Boolean(conversation.assignedUserId);
    const stored = participantRecords(conversation).filter(item => item.userId !== conversation.assignedUserId);
    const participants = stored.filter(item => canManage || usable && eligible(item)).slice(0, 20)
      .map(item => ({ ...item, name: eligible(item)?byId.get(item.userId).name:item.name, eligible: usable && eligible(item), ...(usable && eligible(item) ? avatarField(byId.get(item.userId).avatar) : {}) }));
    const enrolled = new Set(stored.map(item => item.userId));
    return { responsible: conversation.owner === 'human' && conversation.assignedUserId ? { id: conversation.assignedUserId, name: byId.get(conversation.assignedUserId)?.name || conversation.assignedUserName || '', ...(usable ? avatarField(byId.get(conversation.assignedUserId)?.avatar) : {}) } : null,
      participants, eligible: canManage ? people.filter(person => person.id !== conversation.assignedUserId && !enrolled.has(person.id)).map(person => ({...person, avatar:safeAvatar(person.avatar)})) : [], canManage, version: conversation.version || 1 };
  }
  updateParticipants(actor, tenantId, conversationId, input) {
    inputFields(input, ['version', 'action', 'userId', 'reason']); revision(input.version);
    if (!['add', 'remove'].includes(input.action)) fail(400, 'Escolha adicionar ou remover participante.');
    const userId = identifier(input.userId), reason = optionalText(input.reason, 240), unchanged = { conversation: null };
    try {
      return this.store.mutate(actor, tenantId, input.action === 'add' ? 'Participante adicionado ao atendimento' : 'Participante removido do atendimento', state => {
        const current = this.auth.currentActor(actor), conversation = this.conversation(state, conversationId, input.version);
        this.permission(actor, 'inbox.read', scope(tenantId, conversation, this.currentDepartment(state, conversation)?.id));
        if (!this.canManageParticipants(actor, tenantId, state, conversation, current)) fail(403, 'Somente o responsável ou administrador autorizado pode gerenciar participantes neste atendimento humano.');
        const stored = participantRecords(conversation), existing = stored.find(item => item.userId === userId), from = snapshot(conversation);
        if (input.action === 'add') {
          if (userId === conversation.assignedUserId) fail(400, 'O responsável já participa deste atendimento.');
          const target = this.participantAssignees(actor, tenantId, state, conversation).find(person => person.id === userId);
          if (!target) fail(400, 'Escolha uma pessoa ativa com acesso ao canal e ao departamento.');
          if (existing) { unchanged.conversation = conversation; throw unchanged; }
          if (stored.length >= 20) fail(409, 'O atendimento permite até vinte participantes adicionais.');
          conversation.participants = [...stored, { userId: target.id, name: target.name, addedAt: this.date(), addedByUserId: current.id,...(target.supportGrantId?{supportGrantId:target.supportGrantId}:{}) }];
        } else {
          if (!existing) { unchanged.conversation = conversation; throw unchanged; }
          conversation.participants = stored.filter(item => item.userId !== userId);
        }
        conversation.version = (conversation.version || 1) + 1; conversation.updatedAt = this.date();
        this.event(conversation, { ...actor, name: current.name }, { type: input.action === 'add' ? 'participant-added' : 'participant-removed', from, to: snapshot(conversation), reason });
        return conversation;
      });
    } catch (error) { if (error === unchanged) return unchanged.conversation; throw error; }
  }
  attendanceAccess(actor, tenantId, supplied) {
    const state = this.store.tenant(actor, tenantId), conversation = this.conversation(state, supplied.id), current = this.auth.currentActor(actor);
    this.permission(actor, 'inbox.read', scope(tenantId, conversation, this.currentDepartment(state, conversation)?.id));
    let canReply = false;
    try { canReply = this.canReply(actor, tenantId, conversation); } catch (error) { if (![403, 409].includes(error.status)) throw error; }
    return { canReply, canManageParticipants: this.canManageParticipants(actor, tenantId, state, conversation, current) };
  }
  attendanceSnapshots(actor, tenantId, conversations, { state: loaded } = {}) {
    if (!Array.isArray(conversations)) throw new TypeError('Informe as conversas da resposta síncrona.');
    const current = this.auth.currentActor(actor), scoped = { ...this.auth.actor(current), resellerId: actor.resellerId };
    // A caller may pass the tenant it read in this same synchronous tick; the fresh actor scope is still enforced here.
    const reuse = loaded && loaded.id === tenantId && loaded.resellerId === scoped.resellerId && Array.isArray(loaded.conversations);
    if (reuse && scoped.role === 'operator' && !(scoped.tenantIds || [scoped.tenantId]).includes(tenantId)) fail(403, 'Esta empresa não está no seu acesso.');
    const state = reuse ? loaded : this.store.tenant(scoped, tenantId), persisted = new Map();
    for (const conversation of state.conversations || []) if (!persisted.has(conversation.id)) persisted.set(conversation.id, conversation);
    const selected = conversations.map(item => {
      const conversation = persisted.get(typeof item === 'string' ? item : item?.id);
      if (!conversation) fail(404, 'Conversa não encontrada nesta empresa.');
      return conversation;
    });
    if (!selected.length) return new Map();
    if(scoped.supportGrantId||selected.some(conversation=>conversation.assignedSupportGrantId||participantRecords(conversation).some(person=>person.supportGrantId))){
      return new Map(selected.map(conversation=>[conversation.id,{participants:this.participants(scoped,tenantId,conversation.id).participants,attendance:this.attendanceAccess(scoped,tenantId,conversation)}]));
    }
    const references = new Set([current.id]);
    for (const conversation of selected) {
      if (conversation.assignedUserId) references.add(conversation.assignedUserId);
      for (const participant of participantRecords(conversation)) references.add(participant.userId);
    }
    // Read only the existing roster/owner identities. Never expand this DTO path into a team directory.
    const rows = this.auth.db.prepare(`SELECT id,name,role,reseller_id,tenant_ids,permissions,scope_rules,platform_admin,disabled_at FROM auth_users
      WHERE id IN (SELECT value FROM json_each(?)) AND (reseller_id=? OR (platform_admin=1 AND EXISTS (
        SELECT 1 FROM auth_workspace_access access WHERE access.user_id=auth_users.id AND access.reseller_id=?)))`).all(JSON.stringify([...references]), actor.resellerId, actor.resellerId);
    const people = new Map(rows.map(row => {
      const access = accessOf(row);
      return [row.id, { row, tenantIds: JSON.parse(row.tenant_ids), rules: access.scopeRules,
        permissions: row.role === 'reseller' ? BUSINESS_PERMISSIONS : access.permissions || OPERATOR_DEFAULT_PERMISSIONS }];
    }));
    const allowed = (userId, permission, context) => {
      const person = people.get(userId);
      if (!person || person.row.disabled_at !== null || !person.permissions.includes(permission) || !this.auth.validContext(state, context)) return false;
      if (person.row.role === 'reseller') return true;
      return person.tenantIds.includes(tenantId) && scopeAllows(person.rules, tenantId, context);
    };
    const snapshots = new Map();
    for (const conversation of selected) {
      const department = this.currentDepartment(state, conversation), context = scope(tenantId, conversation, department?.id);
      if (!allowed(current.id, 'inbox.read', context)) fail(403, 'Seu acesso não permite esta operação neste canal ou departamento.');
      const usable = ['open', 'pending'].includes(conversation.status) && conversation.owner === 'human' && Boolean(conversation.assignedUserId);
      const memberEligible = userId => {
        const person = people.get(userId);
        return department?.active !== false && allowed(userId, 'inbox.reply', context)
          && (!department || person.row.role === 'reseller' || (department.memberIds || []).includes(userId));
      };
      const owner = people.get(conversation.assignedUserId);
      const ownerReal = owner && owner.row.disabled_at === null && (owner.row.role === 'reseller' || owner.tenantIds.includes(tenantId));
      const canManageParticipants = Boolean(usable && ownerReal && (current.role === 'reseller' || current.id === conversation.assignedUserId) && allowed(current.id, 'inbox.transfer', context));
      const stored = participantRecords(conversation).filter(item => item.userId !== conversation.assignedUserId);
      const participants = stored.filter(item => canManageParticipants || usable && memberEligible(item.userId)).slice(0, 20)
        .map(item => ({ ...item, name: memberEligible(item.userId) ? people.get(item.userId).row.name : item.name, eligible: usable && memberEligible(item.userId) }));
      const canReply = Boolean(usable && allowed(current.id, 'inbox.reply', context)
        && (current.id === conversation.assignedUserId || stored.some(item => item.userId === current.id) && memberEligible(current.id)));
      snapshots.set(conversation.id, { participants, attendance: { canReply, canManageParticipants } });
    }
    return snapshots;
  }
  clearParticipants(conversation, actor, { reason = '', origin = 'inbox' } = {}) {
    return clearConversationParticipants(conversation, actor, { reason, origin, createdAt: this.date() });
  }
  applyAssignment(conversation, actor, { owner, user, agent, department, reason = '', origin = 'inbox' }) {
    const from = snapshot(conversation);
    this.clearParticipants(conversation, actor, { reason: reason || 'Responsável ou rota do atendimento alterados.', origin });
    conversation.owner = owner; conversation.assignedUserId = owner === 'human' ? user?.id || null : null;
    conversation.assignedUserName = owner === 'human' ? user?.name || null : null;
    if(owner==='human'&&user?.supportGrantId)conversation.assignedSupportGrantId=user.supportGrantId;else delete conversation.assignedSupportGrantId;
    conversation.agentId = owner === 'agent' ? agent.id : null;
    if (department !== undefined) { conversation.departmentId = department?.id || null; conversation.department = department?.name || ''; }
    conversation.version = (conversation.version || 1) + 1; conversation.updatedAt = this.date();
    this.event(conversation, actor, { type: 'assignment', from, to: snapshot(conversation), reason, origin });
    const description = owner === 'human' ? `Atendimento atribuído a ${user.name}.` : owner === 'queue' ? 'Atendimento devolvido à fila.' : agentAssignmentText(agent, conversation);
    conversation.messages ||= []; conversation.messages.push({ id: randomUUID(), kind: 'system', text: description + (reason ? ` Motivo: ${reason}` : ''), createdAt: conversation.updatedAt });
    return conversation;
  }
  assign(actor, tenantId, conversationId, input) {
    inputFields(input, ['version', 'owner', 'assignedUserId', 'agentId', 'departmentId', 'reason']); revision(input.version);
    if (!['human', 'queue', 'agent'].includes(input.owner)) fail(400, 'Escolha atendimento humano, fila ou copiloto.');
    const reason = optionalText(input.reason, 240);
    return this.store.mutate(actor, tenantId, 'Responsável do atendimento alterado', state => {
      const current = this.auth.currentActor(actor), admin = current.role === 'reseller';
      const conversation = this.conversation(state, conversationId, input.version);
      if (conversation.status === 'closed') fail(409, 'Reabra a conversa antes de atribuir o atendimento.');
      const existing = this.currentDepartment(state, conversation), source = scope(tenantId, conversation, existing?.id);
      this.permission(actor, 'inbox.read', source);
      let department = existing || undefined;
      if (Object.hasOwn(input, 'departmentId')) {
        department = input.departmentId === null || input.departmentId === '' || input.departmentId === 'unassigned' ? null : this.department(state, identifier(input.departmentId));
        if (department?.active === false) fail(409, 'Escolha um departamento ativo.');
      }
      const target = scope(tenantId, conversation, department?.id);
      const userId = input.owner === 'human' ? input.assignedUserId === undefined ? current.id : identifier(input.assignedUserId) : null;
      const self = input.owner === 'human' && userId === current.id;
      const movesDepartment = (existing?.id || null) !== (department?.id || null) || Object.hasOwn(input, 'departmentId') && (conversation.department || '') !== (department?.name || '');
      // A transfer must change who owns it or where it waits: queue to the same queue would leave it unowned while saying "transferred".
      if (input.owner === 'queue' && conversation.owner === 'queue' && !movesDepartment) fail(409, 'A conversa já está na fila deste departamento. Escolha uma pessoa, um agente ou outro departamento.');
      if (self && !movesDepartment) {
        this.permission(actor, 'inbox.reply', target);
        if (conversation.assignedUserId && conversation.assignedUserId !== current.id && !admin) fail(409, 'Esta conversa já está com outra pessoa. Solicite a transferência.');
        if (conversation.owner === 'human' && conversation.assignedUserId === current.id && participantRecords(conversation).length) this.permission(actor, 'inbox.transfer', source);
      } else {
        this.permission(actor, 'inbox.transfer', source); this.permission(actor, 'inbox.transfer', target);
        if (!admin && conversation.assignedUserId !== current.id) fail(409, 'Assuma uma conversa da fila antes de transferi-la.');
      }
      let user, agent;
      if (input.owner === 'human') {
        this.permission(actor, self ? 'inbox.reply' : 'inbox.transfer', target);
        user = this.assignees(actor, tenantId, target).find(item => item.id === userId);
        if (!user) fail(400, 'Escolha uma pessoa ativa com acesso ao canal e ao departamento.');
      }
      if (input.owner === 'agent') {
        const agentId = identifier(input.agentId);
        agent = state.agents.find(item => item.id === agentId);
        if (!agent) fail(404, 'Copiloto não encontrado nesta empresa.');
        if (agent.configured !== true || agent.mode !== 'copilot') fail(409, 'Configure este agente como copiloto antes de atribuir a conversa.');
      }
      const result = this.applyAssignment(conversation, { ...actor, name: current.name }, { owner: input.owner, user, agent, department, reason });
      const supportChannel = state.channels.find(channel => channel.id === conversation.channelId);
      if (input.owner === 'agent' && supportChannel?.centralSupportScope && supportChannel.supportAssistant?.enabled && supportChannel.supportAssistant.agentId === agent.id) {
        delete conversation.supportAssistantHandoff;
        if (supportChannel.supportAssistant.autoReply) conversation.messages.at(-1).text = `Atendimento devolvido ao assistente virtual ${agent.name}. As respostas automáticas retomam na próxima mensagem do visitante.`;
      }
      return result;
    });
  }
  canReply(actor, tenantId, conversation) {
    const read = typeof this.store.readonlyConversationTenant === 'function' ? this.store.readonlyConversationTenant : this.store.conversationTenant;
    const state = typeof conversation.id === 'string' && conversation.id.length > 0 && typeof read === 'function'
      ? read.call(this.store, actor, tenantId, conversation.id)
      : this.store.tenant(actor, tenantId);
    conversation = this.conversation(state, conversation.id);
    if (conversation.status === 'closed') fail(409, 'Reabra a conversa antes de responder.');
    if (actor?.kind === 'service' && actor.autopilot === true && !actor.userId && !actor.serviceId) {
      // The autopilot answers only conversations owned by its agent, through the live execution that owns this send.
      const allowed = this.authorizeAutopilotReply?.(actor, tenantId, conversation);
      if (allowed?.then) { Promise.resolve(allowed).catch(() => {}); throw new TypeError('A autorização do piloto automático precisa ser síncrona.'); }
      if (allowed !== true || conversation.owner !== 'agent' || !conversation.agentId || conversation.assignedUserId) fail(403, 'O piloto automático não está autorizado a responder este atendimento.');
      return true;
    }
    if (actor?.kind === 'service' && actor.serviceId) {
      const allowed = this.authorizeServiceReply?.(actor, tenantId, conversation);
      if (allowed?.then) { Promise.resolve(allowed).catch(() => {}); throw new TypeError('A autorização do serviço precisa ser síncrona.'); }
      if (allowed !== true || actor.userId) fail(403, 'O serviço não tem autorização explícita para enviar neste grupo.');
      return true;
    }
    if (!actor?.userId) { // Somente fixtures internas antigas chegam sem uma identidade de autenticação.
      if (conversation.owner !== 'human') fail(409, 'Assuma a conversa antes de responder.');
      return true;
    }
    const department = this.currentDepartment(state, conversation);
    this.permission(actor, 'inbox.reply', scope(tenantId, conversation, department?.id));
    if(actor.supportGrantId){
      const bound=conversation.assignedUserId===actor.userId?conversation.assignedSupportGrantId:participantRecords(conversation).find(person=>person.userId===actor.userId)?.supportGrantId;
      if(bound!==actor.supportGrantId)fail(409,'Assuma ou participe deste atendimento com a delegação de suporte atual.');
    }else if(conversation.assignedUserId===actor.userId&&conversation.assignedSupportGrantId||participantRecords(conversation).some(person=>person.userId===actor.userId&&person.supportGrantId))fail(409,'Entre no contexto delegado que participa deste atendimento.');
    if (conversation.owner !== 'human' || !conversation.assignedUserId) fail(409, 'Assuma esta conversa com seu acesso antes de responder.');
    if (conversation.assignedUserId !== actor.userId && !(participantRecords(conversation).some(item => item.userId === actor.userId)
      && this.participantAssignees(actor, tenantId, state, conversation).some(person => person.id === actor.userId))) fail(409, 'Assuma esta conversa ou participe do atendimento com seu acesso antes de responder.');
    return true;
  }
  routeIncoming(tenantId, conversationId) {
    const row = this.store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get(tenantId);
    if (!row) fail(404, 'Empresa não encontrada.');
    const service = { role: 'reseller', resellerId: row.reseller_id, name: 'Distribuição automática' };
    const read = typeof this.store.readonlyConversationTenant === 'function' ? this.store.readonlyConversationTenant : this.store.conversationTenant;
    if (typeof conversationId === 'string' && conversationId.length > 0 && typeof read === 'function') {
      const state = read.call(this.store, service, tenantId, conversationId), conversation = this.conversation(state, conversationId), department = this.currentDepartment(state, conversation);
      // A real circular distribution still needs the complete tenant: it also advances the department's cursor.
      if (conversation.status === 'closed' || conversation.assignedUserId || conversation.owner === 'agent' || !department || department.active === false || department.distribution !== 'round_robin') return null;
    }
    try { return this.store.mutate(service, tenantId, 'Atendimento distribuído automaticamente', state => {
      const conversation = this.conversation(state, conversationId), department = this.currentDepartment(state, conversation);
      if (conversation.status === 'closed' || conversation.assignedUserId || conversation.owner === 'agent' || !department || department.active === false || department.distribution !== 'round_robin') throw routeSkipped;
      const rows = this.auth.db.prepare(`SELECT * FROM auth_users WHERE disabled_at IS NULL AND (reseller_id=? OR (platform_admin=1 AND EXISTS (
        SELECT 1 FROM auth_workspace_access access WHERE access.user_id=auth_users.id AND access.reseller_id=?))) ORDER BY created_at,id`).all(row.reseller_id, row.reseller_id);
      const eligible = rows.map(user => ({ actor: { ...this.auth.actor(user), resellerId: row.reseller_id }, metadata: this.auth.metadata(user) }))
        .filter(user => (department.memberIds || []).includes(user.metadata.id) && user.metadata.presence === 'available' && presenceNames.has(user.metadata.presence) && this.auth.can(user.actor, 'inbox.reply', scope(tenantId, conversation, department.id)));
      if (!eligible.length) throw routeSkipped;
      const members = department.memberIds || [], start = Number.isSafeInteger(department.cursor) && department.cursor >= 0 ? department.cursor % members.length : 0;
      let selected, index;
      for (let offset = 0; offset < members.length; offset++) { index = (start + offset) % members.length; selected = eligible.find(user => user.metadata.id === members[index]); if (selected) break; }
      department.cursor = (index + 1) % members.length; department.version = (department.version || 1) + 1;
      return this.applyAssignment(conversation, service, { owner: 'human', user: selected.metadata, department, reason: 'Distribuição circular entre pessoas disponíveis.', origin: 'incoming-routing' });
    }); } catch (error) { if (error === routeSkipped) return null; throw error; }
  }
  releaseSupportGrant({grantId,workspaceId,tenantIds,reason='Acesso temporário de suporte encerrado.'}) {
    identifier(grantId);identifier(workspaceId);if(!Array.isArray(tenantIds))fail(400,'Informe as empresas da delegação.');
    const service={role:'reseller',resellerId:workspaceId,name:'Lifecycle do suporte'},released=[];
    for(const tenantId of tenantIds){const row=this.store.db.prepare('SELECT id FROM tenants WHERE id=? AND reseller_id=?').get(tenantId,workspaceId);if(!row)continue;
      const state=this.store.tenant(service,tenantId);if(!state.conversations.some(conversation=>conversation.assignedSupportGrantId===grantId||participantRecords(conversation).some(person=>person.supportGrantId===grantId)))continue;
      this.store.mutate(service,tenantId,'Acesso de suporte encerrado no atendimento',current=>{
        for(const conversation of current.conversations){let changed=false;if(conversation.assignedSupportGrantId===grantId&&conversation.status!=='closed'){this.applyAssignment(conversation,service,{owner:'queue',reason,origin:'support-ended'});changed=true;}
          const removed=participantRecords(conversation).filter(person=>person.supportGrantId===grantId);if(removed.length){const from=snapshot(conversation);conversation.participants=participantRecords(conversation).filter(person=>person.supportGrantId!==grantId);conversation.version=(conversation.version||1)+1;conversation.updatedAt=this.date();this.event(conversation,service,{type:'participant-removed',from,to:snapshot(conversation),reason,origin:'support-ended'});changed=true;}
          if(changed)released.push({tenantId,conversationId:conversation.id});
        }
      });
    }
    return released;
  }
  releaseUser(actor, userId, { origin = 'user-disabled', reason = 'Acesso do atendente desativado.' } = {}) {
    this.admin(actor); identifier(userId);
    const target = this.auth.db.prepare(`SELECT * FROM auth_users WHERE id=? AND (reseller_id=? OR (platform_admin=1 AND EXISTS (
      SELECT 1 FROM auth_workspace_access access WHERE access.user_id=auth_users.id AND access.reseller_id=?)))`).get(userId, actor.resellerId, actor.resellerId);
    if (!target) fail(404, 'Pessoa não encontrada neste workspace.');
    const released = [];
    for (const tenant of this.store.list(actor)) {
      const state = this.store.tenant(actor, tenant.id);
      if (!state.conversations.some(conversation => conversation.status !== 'closed' && conversation.assignedUserId === userId || participantRecords(conversation).some(item => item.userId === userId))) continue;
      this.store.mutate(actor, tenant.id, 'Atendimentos devolvidos à fila após mudança de acesso', current => {
        this.admin(actor);
        for (const conversation of current.conversations) {
          if (conversation.status !== 'closed' && conversation.assignedUserId === userId) this.applyAssignment(conversation, actor, { owner: 'queue', reason, origin });
          else if (participantRecords(conversation).some(item => item.userId === userId)) {
            const from = snapshot(conversation); conversation.participants = participantRecords(conversation).filter(item => item.userId !== userId);
            conversation.version = (conversation.version || 1) + 1; conversation.updatedAt = this.date();
            this.event(conversation, actor, { type: 'participant-removed', from, to: snapshot(conversation), reason, origin });
          } else continue;
          released.push({ tenantId: tenant.id, conversationId: conversation.id, version: conversation.version });
        }
      });
    }
    return released;
  }
  /**
   * Company model of the indicators, independent of who reads it and of the period: per conversation (document order) its
   * channel, current department id and the messages/events reduced to the fields used, with dates parsed once. Shared
   * read-only between requests while the company is unchanged (inbox-index.js); permissions and period run per request.
   */
  static metricsModel(state) {
    const departmentOf = conversation => (state.departments || []).find(item => conversation.departmentId ? item.id === conversation.departmentId : item.name === conversation.department) || null;
    return Object.freeze(state.conversations.map(conversation => Object.freeze({
      channelId: conversation.channelId, departmentId: departmentOf(conversation)?.id,
      messages: Object.freeze((conversation.messages || []).map(message => Object.freeze({ id: message.id, kind: message.kind, at: Date.parse(message.createdAt),
        delivered: !['failed', 'pending', 'unknown', 'unconfirmed'].includes(message.delivery), authorUserId: message.authorUserId, authorName: message.authorName }))),
      events: Object.freeze((conversation.attendantEvents || []).map(event => Object.freeze({ id: event.id, type: event.type, at: Date.parse(event.createdAt),
        toUserId: event.to?.assignedUserId, toUserName: event.to?.assignedUserName, fromUserId: event.from?.assignedUserId, actorId: event.actorId, actorName: event.actorName,
        fromStatus: event.from?.status, toStatus: event.to?.status })))
    })));
  }
  metrics(actor, tenantId, { from, to } = {}) {
    this.permission(actor, 'metrics.read', { tenantId, aggregate: true });
    this.permission(actor, 'inbox.read', { tenantId, aggregate: true });
    const end = to === undefined ? this.now() : Date.parse(to), start = from === undefined ? end - 7 * 86400000 : Date.parse(from);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail(400, 'Escolha um período válido para os indicadores.');
    const inPeriod = date => Number.isFinite(date) && date >= start && date <= end;
    const index = this.metricsIndex === undefined ? (this.metricsIndex = tenantIndex(this.store)) : this.metricsIndex;
    const model = index ? index.read(actor, tenantId, 'metrics', Operations.metricsModel) : Operations.metricsModel(this.store.tenant(actor, tenantId));
    const people = new Map(), samples = [];
    const totals = { conversationsReceived: 0, incomingMessages: 0, humanMessages: 0, assignments: 0, transfers: 0, closed: 0, reopened: 0, firstReplies: 0 };
    const person = (id, name) => { if (!id) return null; if (!people.has(id)) people.set(id, { id, name: name || '', assigned: 0, transferred: 0, closed: 0, humanMessages: 0, firstReplies: 0, replySeconds: [] }); const value = people.get(id); if (!value.name && name) value.name = name; return value; };
    const seenEvents = new Set(), seenMessages = new Set(); let recordedEvents = 0;
    for (const conversation of model) {
      if (!this.auth.can(actor, 'inbox.read', scope(tenantId, conversation, conversation.departmentId))) continue;
      const messages = conversation.messages.filter(message => { if (message.id && seenMessages.has(message.id)) return false; if (message.id) seenMessages.add(message.id); return true; }).sort((a, b) => a.at - b.at);
      for (const message of messages) {
        if (!inPeriod(message.at)) continue;
        if (message.kind === 'customer') totals.incomingMessages++;
        if (message.kind === 'human' && message.delivered) {
          totals.humanMessages++; const attendant = person(message.authorUserId, message.authorName); if (attendant) attendant.humanMessages++;
        }
      }
      const customer = messages.find(message => message.kind === 'customer' && Number.isFinite(message.at));
      if (customer && inPeriod(customer.at)) totals.conversationsReceived++;
      const reply = customer && messages.find(message => message.kind === 'human' && message.delivered && message.at >= customer.at);
      if (reply && inPeriod(reply.at)) {
        const seconds = (reply.at - customer.at) / 1000;
        totals.firstReplies++; samples.push(seconds); const attendant = person(reply.authorUserId, reply.authorName); if (attendant) { attendant.firstReplies++; attendant.replySeconds.push(seconds); }
      }
      for (const event of conversation.events) {
        if (!event.id || seenEvents.has(event.id)) continue;
        seenEvents.add(event.id); recordedEvents++;
        if (!inPeriod(event.at)) continue;
        if (event.type === 'assignment') {
          totals.assignments++;
          const assigned = person(event.toUserId, event.toUserName);
          if (assigned) assigned.assigned++;
          if (event.fromUserId && event.fromUserId !== event.toUserId) { totals.transfers++; const attendant = person(event.actorId, event.actorName); if (attendant) attendant.transferred++; }
        }
        if (event.type === 'closed' && ['open', 'pending'].includes(event.fromStatus) && event.toStatus === 'closed') { totals.closed++; const attendant = person(event.actorId, event.actorName); if (attendant) attendant.closed++; }
        if (event.type === 'reopened' && event.fromStatus === 'closed' && ['open', 'pending'].includes(event.toStatus)) totals.reopened++;
      }
    }
    const average = values => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
    return { period: { from: new Date(start).toISOString(), to: new Date(end).toISOString() }, totals, firstReply: { samples: samples.length, averageSeconds: average(samples) }, attendants: [...people.values()].map(({ replySeconds, ...attendant }) => ({ ...attendant, averageFirstReplySeconds: average(replySeconds) })), coverage: { recordedEvents, closureHistory: 'recorded-events-only', humanAttribution: 'recorded-author-only' } };
  }
}
