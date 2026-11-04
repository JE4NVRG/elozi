import { randomBytes } from 'node:crypto';
import { fail } from './store.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allowedId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);

/** Bounded, process-local inventory snapshots. Only IDs are retained, never messages or credentials. */
export class ServiceInventory {
  constructor(api, { ttlMs = 120000, maxSnapshots = 32, maxRows = 100000, maxPerPrincipal = 4 } = {}) {
    this.api = api; this.ttlMs = ttlMs; this.maxSnapshots = maxSnapshots; this.maxRows = maxRows; this.maxPerPrincipal = maxPerPrincipal;
    this.snapshots = new Map();
  }
  expire() {
    const now = this.api.principals.now();
    for (const [key, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(key);
  }
  list(actor, input, { groups = false } = {}) {
    const allowed = groups ? ['requestId', 'channelId', 'limit', 'cursor'] : ['requestId', 'status', 'limit', 'cursor'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os filtros permitidos do inventário.');
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.requestId)) fail(400, 'Informe uma chave única da solicitação.');
    const limit = input.limit ?? 20, status = groups ? 'all' : input.status ?? 'all';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !['all', 'open', 'pending', 'closed'].includes(status) || input.channelId !== undefined && !allowedId(input.channelId)) fail(400, 'Informe filtro e limite de até 50 atendimentos.');
    const api = this.api, context = api.inventoryContext(actor), authority = api.principals.revalidate(actor, 'conversation.read', context);
    if (input.channelId) api.principals.revalidate(actor, 'conversation.read', { ...context, channelId: input.channelId });
    const operation = groups ? 'groups' : 'inbox', binding = api.queries.binding(actor, authority, operation);
    const filters = { status, channelId: input.channelId ?? null, limit }, cursor = api.queries.decode(input.cursor);
    this.expire();
    let snapshot, created = false;
    if (cursor) {
      snapshot = this.snapshots.get(cursor.snapshot);
      if (!snapshot) fail(409, 'O inventário expirou ou o processo mudou. Inicie uma nova consulta.');
      api.queries.assertCursor(cursor, binding, filters, snapshot.id);
    } else {
      // Repeating the original read request keeps its inventory while the bounded snapshot is alive.
      snapshot = [...this.snapshots.values()].find(item => item.requestId === input.requestId && same(item.binding, binding) && same(item.filters, filters));
      if (!snapshot) {
        const ids = api.withReadScope(actor, scope => (scope.tenant.conversations || []).filter(conversation => {
          if (groups && conversation.conversationKind !== 'group' || status !== 'all' && conversation.status !== status || input.channelId && conversation.channelId !== input.channelId) return false;
          try { scope.check(conversation); return true; }
          catch (error) { if ([403, 404].includes(error.status)) return false; throw error; }
        }).sort(groups ? (a, b) => a.id.localeCompare(b.id) : (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id)).map(conversation => conversation.id));
        const rows = [...this.snapshots.values()].reduce((total, item) => total + item.ids.length, 0);
        const owned = [...this.snapshots.values()].filter(item => item.binding.principalId === actor.principalId).length;
        if (ids.length > limit && (this.snapshots.size >= this.maxSnapshots || rows + ids.length > this.maxRows || owned >= this.maxPerPrincipal)) fail(503, 'O inventário atingiu o limite temporário. Aguarde e inicie uma nova consulta.');
        snapshot = { id: randomBytes(32).toString('hex'), requestId: input.requestId, binding, filters, ids, expiresAt: api.principals.now() + this.ttlMs };
        created = true;
      }
    }
    const offset = cursor?.offset ?? 0;
    if (offset >= snapshot.ids.length && offset !== 0) fail(400, 'Posição inválida no inventário.');
    const entries = api.withReadScope(actor, scope => {
      const byId = new Map((scope.tenant.conversations || []).map(conversation => [conversation.id, conversation]));
      return snapshot.ids.slice(offset, offset + limit).map(id => {
        const conversation = byId.get(id);
        if (!conversation || status !== 'all' && conversation.status !== status || groups && conversation.conversationKind !== 'group'
          || input.channelId && conversation.channelId !== input.channelId) fail(409, 'O inventário mudou de escopo. Inicie uma nova consulta.');
        const current = scope.check(conversation);
        return groups ? { conversationId: id, channelId: conversation.channelId, groupId: current.groupId, title: conversation.contact || 'Grupo', version: conversation.version, status: conversation.status, updatedAt: conversation.updatedAt || null }
          : { id, contact: conversation.contact, channelId: conversation.channelId, departmentId: conversation.departmentId || null, status: conversation.status, owner: conversation.owner, version: conversation.version, updatedAt: conversation.updatedAt || null, unread: conversation.unread || 0 };
      });
    });
    const next = offset + entries.length, nextCursor = next < snapshot.ids.length ? api.queries.encode({ binding, filters, snapshot: snapshot.id, offset: next }) : null;
    const reserved = api.principals.reserve(actor, { requestId: input.requestId, capability: 'conversation.read', context, units: 1, costMicros: 0, payload: { operation, ...filters, cursor: input.cursor ?? null } });
    if (!reserved.replayed) {
      api.principals.beginDispatch(actor, reserved.receipt.id);
      api.principals.complete(actor, reserved.receipt.id, { state: 'confirmed', result: { operation, includedCount: entries.length } });
    }
    // The MCP/HTTP boundary also rechecks the returned versions after its own awaits.
    api.principals.revalidate(actor, 'conversation.read', context);
    // A complete single page needs no server state. Frequent empty group guards must never exhaust the cache.
    if (created && nextCursor !== null) this.snapshots.set(snapshot.id, snapshot);
    return { ...(groups ? { tenantId: actor.tenantId, groups: entries } : { conversations: entries }), snapshot: snapshot.id, nextCursor, receipt: reserved.receipt.id };
  }
}
