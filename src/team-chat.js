import { createHash, randomUUID } from 'node:crypto';
import { allowedFields } from './access.js';
import { validateProfileAvatar } from './profile.js';
import { fail, text } from './store.js';

const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const positiveVersion = value => { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a versão atual da sala.'); };
const pageLimit = value => { if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail(400, 'Escolha de 1 a 100 registros.'); return value; };
const safeAvatar = value => { try { return validateProfileAvatar(value ?? null); } catch (error) { if (error.status === 400) return null; throw error; } };

// Private SQLite namespace: no tenant snapshots, transport commands, AI/MCP context or PG projection.
export class TeamChat {
  constructor(store, auth) {
    if (!store?.db || auth?.db !== store.db) throw new Error('Chat interno exige a mesma fonte SQLite da autenticação.');
    this.store = store; this.auth = auth; this.db = store.db;
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS team_chat_tenant_scope ON tenants(reseller_id,id);
      CREATE TABLE IF NOT EXISTS team_chat_rooms (
        reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80), version INTEGER NOT NULL CHECK(version>0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        creator_id TEXT NOT NULL REFERENCES auth_users(id), creator_name TEXT NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
        PRIMARY KEY(reseller_id,tenant_id,id),
        FOREIGN KEY(reseller_id,tenant_id) REFERENCES tenants(reseller_id,id)
      );
      CREATE TABLE IF NOT EXISTS team_chat_members (
        reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, room_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES auth_users(id), added_at TEXT NOT NULL,
        added_by TEXT NOT NULL REFERENCES auth_users(id), read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(read_sequence>=0),
        PRIMARY KEY(reseller_id,tenant_id,room_id,user_id),
        FOREIGN KEY(reseller_id,tenant_id,room_id) REFERENCES team_chat_rooms(reseller_id,tenant_id,id)
      );
      CREATE INDEX IF NOT EXISTS team_chat_member_directory ON team_chat_members(reseller_id,tenant_id,user_id);
      CREATE TABLE IF NOT EXISTS team_chat_messages (
        reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, room_id TEXT NOT NULL,
        id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
        author_id TEXT NOT NULL REFERENCES auth_users(id), author_name TEXT NOT NULL,
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000), created_at TEXT NOT NULL,
        request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, conversation_id TEXT,
        PRIMARY KEY(reseller_id,tenant_id,room_id,sequence),
        UNIQUE(reseller_id,tenant_id,room_id,id), UNIQUE(reseller_id,tenant_id,room_id,author_id,request_id),
        FOREIGN KEY(reseller_id,tenant_id,room_id) REFERENCES team_chat_rooms(reseller_id,tenant_id,id)
      );
      CREATE TABLE IF NOT EXISTS team_chat_audit (
        id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, room_id TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES auth_users(id), action TEXT NOT NULL,
        created_at TEXT NOT NULL, metadata TEXT NOT NULL,
        FOREIGN KEY(reseller_id,tenant_id,room_id) REFERENCES team_chat_rooms(reseller_id,tenant_id,id)
      );
    `);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  scope(actor, tenantId, { admin = false } = {}) {
    if (actor?.supportGrantId) fail(403, 'Saia do contexto de suporte temporário para acessar o chat da equipe no seu próprio workspace.');
    if (!identity(tenantId)) fail(400, 'Escolha uma empresa válida.');
    const row = admin ? this.auth.admin(actor) : this.auth.currentActor(actor);
    if (row.role !== 'reseller' && !JSON.parse(row.tenant_ids).includes(tenantId)) fail(403, 'Esta empresa não está no seu acesso.');
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE reseller_id=? AND id=?').get(actor.resellerId, tenantId)) fail(404, 'Empresa não encontrada.');
    return { row, actor: { ...this.auth.actor(row), resellerId: actor.resellerId }, resellerId: actor.resellerId, tenantId };
  }
  eligible(row, scope) {
    if (!row || row.disabled_at !== null) return false;
    if (row.reseller_id !== scope.resellerId && !(row.platform_admin && this.db.prepare('SELECT 1 FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(row.id, scope.resellerId))) return false;
    return row.role === 'reseller' || JSON.parse(row.tenant_ids).includes(scope.tenantId);
  }
  room(scope, roomId) {
    if (!identity(roomId)) fail(400, 'Escolha uma sala válida.');
    const room = this.db.prepare('SELECT * FROM team_chat_rooms WHERE reseller_id=? AND tenant_id=? AND id=?').get(scope.resellerId, scope.tenantId, roomId);
    if (!room) fail(404, 'Sala não encontrada nesta empresa.');
    const member = this.db.prepare('SELECT * FROM team_chat_members WHERE reseller_id=? AND tenant_id=? AND room_id=? AND user_id=?').get(scope.resellerId, scope.tenantId, roomId, scope.row.id);
    if (!member) fail(403, 'Você não participa desta sala.');
    return { room, member };
  }
  audit(scope, roomId, action, metadata) {
    this.db.prepare('INSERT INTO team_chat_audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), scope.resellerId, scope.tenantId, roomId, scope.row.id, action, new Date().toISOString(), JSON.stringify(metadata));
  }
  unread(scope, room, member) {
    return this.db.prepare('SELECT count(*) AS n FROM team_chat_messages WHERE reseller_id=? AND tenant_id=? AND room_id=? AND sequence>? AND author_id<>?').get(scope.resellerId, scope.tenantId, room.id, member.read_sequence, scope.row.id).n;
  }
  roomDTO(scope, room, member, includeMembers = true) {
    const members = this.db.prepare(`SELECT u.* FROM team_chat_members m JOIN auth_users u ON u.id=m.user_id
      WHERE m.reseller_id=? AND m.tenant_id=? AND m.room_id=? ORDER BY m.added_at,u.name COLLATE NOCASE,u.id`).all(scope.resellerId, scope.tenantId, room.id);
    return { id: room.id, tenantId: scope.tenantId, name: room.name, version: room.version,
      createdAt: room.created_at, updatedAt: room.updated_at, createdBy: { id: room.creator_id, name: room.creator_name },
      lastSequence: room.last_sequence, readSequence: member.read_sequence, unreadCount: this.unread(scope, room, member),
      canManage: scope.row.role === 'reseller', memberCount: members.length,
      ...(includeMembers ? { members: members.map(row => { const eligible = this.eligible(row, scope); return { id: row.id, name: row.name, eligible, avatar: eligible ? safeAvatar(row.avatar) : null }; }) } : {}) };
  }
  listRooms(actor, tenantId, options = {}) {
    allowedFields(options, ['limit']); const limit = pageLimit(options.limit ?? 100), scope = this.scope(actor, tenantId);
    const rooms = this.db.prepare(`SELECT r.*,m.read_sequence FROM team_chat_rooms r JOIN team_chat_members m
      ON m.reseller_id=r.reseller_id AND m.tenant_id=r.tenant_id AND m.room_id=r.id
      WHERE r.reseller_id=? AND r.tenant_id=? AND m.user_id=? ORDER BY r.updated_at DESC,r.id`).all(scope.resellerId, tenantId, scope.row.id);
    return { rooms: rooms.slice(0, limit).map(room => this.roomDTO(scope, room, room, false)), total: rooms.length, limit, hasMore: rooms.length > limit };
  }
  directory(actor, tenantId) {
    const scope = this.scope(actor, tenantId, { admin: true });
    const rows = this.db.prepare(`SELECT * FROM auth_users WHERE disabled_at IS NULL AND (reseller_id=? OR
      (platform_admin=1 AND EXISTS(SELECT 1 FROM auth_workspace_access WHERE user_id=auth_users.id AND reseller_id=?)))
      ORDER BY name COLLATE NOCASE,id`).all(scope.resellerId, scope.resellerId);
    return { users: rows.filter(row => this.eligible(row, scope)).map(row => ({ id: row.id, name: row.name, avatar: safeAvatar(row.avatar) })) };
  }
  createRoom(actor, tenantId, input) {
    allowedFields(input, ['name', 'memberIds']); const name = text(input.name, 80);
    const requested = input.memberIds ?? [];
    if (!Array.isArray(requested) || requested.length > 30 || requested.some(id => !identity(id))) fail(400, 'Escolha até 30 membros válidos.');
    return this.transaction(() => {
      const scope = this.scope(actor, tenantId, { admin: true }), ids = [...new Set([scope.row.id, ...requested])];
      if (ids.length > 30) fail(409, 'Uma sala permite até 30 membros, incluindo quem a criou.');
      if (this.db.prepare('SELECT count(*) AS n FROM team_chat_rooms WHERE reseller_id=? AND tenant_id=?').get(scope.resellerId, tenantId).n >= 100) fail(409, 'Esta empresa já tem 100 salas.');
      for (const id of ids) if (!this.eligible(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(id), scope)) fail(400, 'Escolha pessoas ativas com acesso a esta empresa e workspace.');
      const id = randomUUID(), date = new Date().toISOString();
      this.db.prepare('INSERT INTO team_chat_rooms VALUES (?,?,?,?,?,?,?,?,?,?)').run(scope.resellerId, tenantId, id, name, 1, date, date, scope.row.id, scope.row.name, 0);
      for (const userId of ids) this.db.prepare('INSERT INTO team_chat_members VALUES (?,?,?,?,?,?,0)').run(scope.resellerId, tenantId, id, userId, date, scope.row.id);
      this.audit(scope, id, 'room-created', { memberIds: ids, version: 1 });
      const current = this.room(scope, id); return this.roomDTO(scope, current.room, current.member);
    });
  }
  getRoom(actor, tenantId, roomId) {
    const scope = this.scope(actor, tenantId), current = this.room(scope, roomId); return this.roomDTO(scope, current.room, current.member);
  }
  updateMembers(actor, tenantId, roomId, input) {
    allowedFields(input, ['version', 'action', 'userId']); positiveVersion(input.version);
    if (!['add', 'remove'].includes(input.action) || !identity(input.userId)) fail(400, 'Escolha uma alteração de membro válida.');
    return this.transaction(() => {
      const scope = this.scope(actor, tenantId, { admin: true }), current = this.room(scope, roomId);
      if (current.room.version !== input.version) fail(409, 'A equipe da sala mudou. Atualize antes de continuar.');
      const existing = this.db.prepare('SELECT 1 FROM team_chat_members WHERE reseller_id=? AND tenant_id=? AND room_id=? AND user_id=?').get(scope.resellerId, tenantId, roomId, input.userId);
      if ((input.action === 'add') === Boolean(existing)) return this.roomDTO(scope, current.room, current.member);
      if (input.action === 'add') {
        if (!this.eligible(this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(input.userId), scope)) fail(400, 'Esta pessoa não está ativa nesta empresa e workspace.');
        if (this.db.prepare('SELECT count(*) AS n FROM team_chat_members WHERE reseller_id=? AND tenant_id=? AND room_id=?').get(scope.resellerId, tenantId, roomId).n >= 30) fail(409, 'Uma sala permite até 30 membros.');
        this.db.prepare('INSERT INTO team_chat_members VALUES (?,?,?,?,?,?,0)').run(scope.resellerId, tenantId, roomId, input.userId, new Date().toISOString(), scope.row.id);
      } else {
        // Keep an active persisted administrator in the room. The creator may leave after adding one.
        const remaining = this.db.prepare(`SELECT u.* FROM team_chat_members m JOIN auth_users u ON u.id=m.user_id
          WHERE m.reseller_id=? AND m.tenant_id=? AND m.room_id=? AND m.user_id<>? AND u.role='reseller'`).all(scope.resellerId, tenantId, roomId, input.userId);
        if (!remaining.some(row => this.eligible(row, scope))) fail(409, 'Mantenha pelo menos um administrador ativo na sala.');
        // Returning a private room after self-removal would bypass the new membership.
        if (input.userId === scope.row.id) fail(409, 'Peça a outro administrador da sala para remover seu acesso.');
        this.db.prepare('DELETE FROM team_chat_members WHERE reseller_id=? AND tenant_id=? AND room_id=? AND user_id=?').run(scope.resellerId, tenantId, roomId, input.userId);
      }
      this.db.prepare('UPDATE team_chat_rooms SET version=version+1,updated_at=? WHERE reseller_id=? AND tenant_id=? AND id=?').run(new Date().toISOString(), scope.resellerId, tenantId, roomId);
      this.audit(scope, roomId, 'member-' + (input.action === 'add' ? 'added' : 'removed'), { userId: input.userId, version: input.version + 1 });
      const updated = this.room(scope, roomId); return this.roomDTO(scope, updated.room, updated.member);
    });
  }
  releaseUser(actor, userId, options = {}) {
    if (!identity(userId)) fail(400, 'Escolha uma pessoa válida.');
    allowedFields(options, ['tenantIds']);
    if (options.tenantIds !== undefined && (!Array.isArray(options.tenantIds) || options.tenantIds.length > 100 || options.tenantIds.some(id => !identity(id)))) fail(400, 'Escolha até 100 empresas válidas para retirar o acesso.');
    const tenantIds = options.tenantIds === undefined ? undefined : [...new Set(options.tenantIds)];
    // Auth lifecycle hook: removing access must not silently restore membership on a later grant.
    // External revocation can leave a room without an administrator; it never grants a replacement.
    return this.transaction(() => {
      const admin = this.auth.admin(actor), resellerId = actor.resellerId;
      if (tenantIds?.length === 0) return [];
      const rooms = this.db.prepare(`SELECT r.* FROM team_chat_rooms r JOIN team_chat_members m
        ON m.reseller_id=r.reseller_id AND m.tenant_id=r.tenant_id AND m.room_id=r.id
        WHERE r.reseller_id=? AND m.user_id=? ${tenantIds ? `AND r.tenant_id IN (${tenantIds.map(() => '?').join(',')})` : ''}
        ORDER BY r.tenant_id,r.id`).all(resellerId, userId, ...(tenantIds ?? []));
      const date = new Date().toISOString();
      return rooms.map(room => {
        const scope = { row: admin, resellerId, tenantId: room.tenant_id };
        this.db.prepare('DELETE FROM team_chat_members WHERE reseller_id=? AND tenant_id=? AND room_id=? AND user_id=?').run(resellerId, room.tenant_id, room.id, userId);
        this.db.prepare('UPDATE team_chat_rooms SET version=version+1,updated_at=? WHERE reseller_id=? AND tenant_id=? AND id=?').run(date, resellerId, room.tenant_id, room.id);
        this.audit(scope, room.id, 'member-released', { userId, version: room.version + 1 });
        return { tenantId: room.tenant_id, roomId: room.id, version: room.version + 1 };
      });
    });
  }
  referenceContext(scope) {
    try {
      const checker = this.auth.createTenantPermissionChecker(scope.actor, 'inbox.read', scope.tenantId);
      // Auth owns only the fresh permission/header snapshot, never conversation history.
      return { can: checker.can };
    } catch (error) { if ([403, 404].includes(error.status)) return null; throw error; }
  }
  reference(scope, conversationId, context) {
    if (!context) return { unavailable: true };
    try {
      // Resolve only this reference from current workspace-scoped routing metadata.
      // No checker.state conversations, full tenant/history fallback or cross-request cache.
      const tenant = this.store.serviceTenant(scope.resellerId, scope.tenantId, { conversationId });
      const conversation = tenant.conversations.find(item => item.id === conversationId);
      if (!conversation || !context.can({ tenantId: scope.tenantId, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' })) return { unavailable: true };
      return { conversationId: conversation.id, contact: conversation.contact || '', channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' };
    } catch (error) { if ([403, 404].includes(error.status)) return { unavailable: true }; throw error; }
  }
  messageDTO(scope, row, context) {
    return { id: row.id, tenantId: scope.tenantId, roomId: row.room_id, sequence: row.sequence,
      text: row.text, createdAt: row.created_at, author: { id: row.author_id, name: row.author_name },
      ...(row.conversation_id ? { reference: this.reference(scope, row.conversation_id, context) } : {}) };
  }
  messages(actor, tenantId, roomId, options = {}) {
    allowedFields(options, ['before', 'after', 'limit']);
    const limit = pageLimit(options.limit ?? 50), before = options.before, after = options.after;
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1) || after !== undefined && (!Number.isSafeInteger(after) || after < 0) || before !== undefined && after !== undefined) fail(400, 'Use antes ou depois de uma sequência válida.');
    const scope = this.scope(actor, tenantId), { room, member } = this.room(scope, roomId);
    const ascending = after !== undefined;
    const rows = this.db.prepare(`SELECT * FROM team_chat_messages WHERE reseller_id=? AND tenant_id=? AND room_id=?
      ${before !== undefined ? 'AND sequence<?' : ascending ? 'AND sequence>?' : ''} ORDER BY sequence ${ascending ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(scope.resellerId, tenantId, roomId, ...((before ?? after) !== undefined ? [before ?? after] : []), limit + 1);
    const page = rows.slice(0, limit); if (!ascending) page.reverse();
    const context = page.some(row => row.conversation_id) ? this.referenceContext(scope) : null;
    return { messages: page.map(row => this.messageDTO(scope, row, context)), hasMore: rows.length > limit,
      before: page[0]?.sequence ?? null, after: page.at(-1)?.sequence ?? null, lastSequence: room.last_sequence, readSequence: member.read_sequence };
  }
  send(actor, tenantId, roomId, input) {
    allowedFields(input, ['version', 'text', 'requestId', 'conversationId']); positiveVersion(input.version);
    const body = text(input.text, 4000), requestId = input.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,99}$/.test(requestId)) fail(400, 'Informe uma chave de envio entre 16 e 100 caracteres.');
    const conversationId = input.conversationId ?? null;
    if (conversationId !== null && !identity(conversationId)) fail(400, 'Informe uma referência de atendimento válida.');
    const payloadHash = createHash('sha256').update(JSON.stringify({ text: body, conversationId })).digest('hex');
    return this.transaction(() => {
      const scope = this.scope(actor, tenantId), { room } = this.room(scope, roomId);
      const prior = this.db.prepare('SELECT * FROM team_chat_messages WHERE reseller_id=? AND tenant_id=? AND room_id=? AND author_id=? AND request_id=?').get(scope.resellerId, tenantId, roomId, scope.row.id, requestId);
      const context = conversationId ? this.referenceContext(scope) : null;
      if (prior) {
        if (prior.payload_hash !== payloadHash) fail(409, 'Esta chave de envio já foi usada com outro conteúdo.');
        return this.messageDTO(scope, prior, context);
      }
      if (room.version !== input.version) fail(409, 'A equipe da sala mudou. Atualize antes de enviar.');
      if (conversationId && this.reference(scope, conversationId, context).unavailable) fail(403, 'Esta referência não está disponível no seu atendimento.');
      if (!Number.isSafeInteger(room.last_sequence + 1)) fail(409, 'Esta sala atingiu o limite de mensagens.');
      const id = randomUUID(), sequence = room.last_sequence + 1, date = new Date().toISOString();
      this.db.prepare('INSERT INTO team_chat_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(scope.resellerId, tenantId, roomId, id, sequence, scope.row.id, scope.row.name, body, date, requestId, payloadHash, conversationId);
      this.db.prepare('UPDATE team_chat_rooms SET last_sequence=?,updated_at=? WHERE reseller_id=? AND tenant_id=? AND id=?').run(sequence, date, scope.resellerId, tenantId, roomId);
      this.audit(scope, roomId, 'message-created', { messageId: id, sequence, hasReference: Boolean(conversationId) });
      return this.messageDTO(scope, this.db.prepare('SELECT * FROM team_chat_messages WHERE reseller_id=? AND tenant_id=? AND room_id=? AND sequence=?').get(scope.resellerId, tenantId, roomId, sequence), context);
    });
  }
  markRead(actor, tenantId, roomId, input) {
    allowedFields(input, ['sequence']);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) fail(400, 'Informe uma sequência de leitura válida.');
    return this.transaction(() => {
      const scope = this.scope(actor, tenantId), { room, member } = this.room(scope, roomId);
      if (input.sequence > room.last_sequence) fail(400, 'A sequência de leitura ainda não existe.');
      if (input.sequence > member.read_sequence) {
        this.db.prepare('UPDATE team_chat_members SET read_sequence=? WHERE reseller_id=? AND tenant_id=? AND room_id=? AND user_id=?').run(input.sequence, scope.resellerId, tenantId, roomId, scope.row.id);
        this.audit(scope, roomId, 'read-advanced', { sequence: input.sequence }); member.read_sequence = input.sequence;
      }
      return { roomId, readSequence: member.read_sequence, lastSequence: room.last_sequence, unreadCount: this.unread(scope, room, member) };
    });
  }
}
