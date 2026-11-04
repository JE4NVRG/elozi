/**
 * Per-company derived read cache for hot list endpoints (/api/inbox, /api/me/attention, /metrics).
 *
 * Correctness model:
 * - Every committed or uncommitted change of a company row (tenants INSERT/UPDATE/DELETE, and conversation_journal
 *   rows when the journal table exists) runs a connection-local TEMP trigger that calls a JS function bumping that
 *   company's revision. TEMP triggers live only in this connection's temp schema: the database file, its schema
 *   checks, backups and any other process opening the file never see them.
 * - A commit from another connection/process changes `PRAGMA data_version`; that clears the whole cache.
 * - Nothing is cached while a transaction is open on this connection (its data could still roll back).
 * - Over-invalidation (a rolled-back write) only costs one rebuild; a stale hit is impossible as long as every
 *   write goes through SQLite, which is the only storage of company documents.
 * - Authorization is never cached: callers still evaluate permissions per request. A hit additionally requires the
 *   same workspace as the build and repeats the operator company check of Store.tenant().
 * - Derived values are built from Store.tenant() itself, so the source of truth and its parsing stay identical.
 * If the runtime cannot register the function or triggers, the index is disabled and every read is a fresh build.
 */
const FUNCTION_NAME = 'elozi_tenant_index_changed';
const indexes = new WeakMap();

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

export class TenantIndex {
  constructor(store, { maxTenants = 5000, fullBudgetBytes = 16 * 1024 * 1024 } = {}) {
    if (!store?.db) throw new TypeError('O índice de empresas precisa do armazenamento.');
    this.store = store; this.db = store.db;
    this.maxTenants = maxTenants; this.fullBudgetBytes = fullBudgetBytes;
    this.revisions = new Map(); this.entries = new Map(); this.epoch = 0; this.fullBytes = 0;
    this.stats = { hits: 0, misses: 0, uncached: 0, invalidations: 0, resets: 0 };
    this.enabled = false; this.dataVersion = null;
    try { this.install(); this.enabled = true; } catch (error) { this.disabledReason = error?.message || String(error); }
  }
  install() {
    if (typeof this.db.function !== 'function') throw new Error('node:sqlite sem funções definidas pelo usuário.');
    this.db.function(FUNCTION_NAME, { deterministic: false, directOnly: false }, id => { this.bump(id); return null; });
    const call = column => `SELECT ${FUNCTION_NAME}(${column});`;
    this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS elozi_index_tenants_insert AFTER INSERT ON main.tenants BEGIN ${call('NEW.id')} END;
      CREATE TEMP TRIGGER IF NOT EXISTS elozi_index_tenants_update AFTER UPDATE ON main.tenants BEGIN ${call('OLD.id')} ${call('NEW.id')} END;
      CREATE TEMP TRIGGER IF NOT EXISTS elozi_index_tenants_delete AFTER DELETE ON main.tenants BEGIN ${call('OLD.id')} END;`);
    this.installJournal();
    this.dataVersion = this.readDataVersion();
  }
  installJournal() {
    if (this.journal) return;
    if (!this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='conversation_journal'").get()) return;
    const call = column => `SELECT ${FUNCTION_NAME}(${column});`;
    this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS elozi_index_journal_insert AFTER INSERT ON main.conversation_journal BEGIN ${call('NEW.tenant_id')} END;
      CREATE TEMP TRIGGER IF NOT EXISTS elozi_index_journal_update AFTER UPDATE ON main.conversation_journal BEGIN ${call('OLD.tenant_id')} ${call('NEW.tenant_id')} END;
      CREATE TEMP TRIGGER IF NOT EXISTS elozi_index_journal_delete AFTER DELETE ON main.conversation_journal BEGIN ${call('OLD.tenant_id')} END;`);
    this.journal = true;
  }
  readDataVersion() { return this.db.prepare('PRAGMA main.data_version').get()?.data_version ?? null; }
  bump(id) {
    const key = String(id);
    this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    if (this.entries.has(key)) { this.drop(key); this.stats.invalidations++; }
  }
  drop(key) { const entry = this.entries.get(key); if (entry) { this.fullBytes -= entry.fullBytes || 0; this.entries.delete(key); } }
  reset() { this.entries.clear(); this.fullBytes = 0; this.epoch++; this.stats.resets++; }
  /** Another connection committed: nothing derived before is trusted. */
  sync() {
    const version = this.readDataVersion();
    if (version !== this.dataVersion) { this.dataVersion = version; this.reset(); }
    if (!this.journal) this.installJournal();
  }
  revision(tenantId) { return this.revisions.get(tenantId) || 0; }
  /**
   * kind: a stable name of the derived value; build(tenant) receives the full Store.tenant() document and returns a value
   * that callers must treat as immutable. Options: { full: true } caches the deep-frozen document itself within the byte
   * budget. The returned value is identical to build(store.tenant(actor, tenantId)) of this exact data.
   */
  read(actor, tenantId, kind, build, { full = false } = {}) {
    if (actor.role === 'operator' && !(actor.tenantIds || [actor.tenantId]).includes(tenantId)) return build(this.store.tenant(actor, tenantId));
    if (!this.enabled || this.db.isTransaction) { this.stats.uncached++; return build(this.store.tenant(actor, tenantId)); }
    this.sync();
    const entry = this.entries.get(tenantId), revision = this.revision(tenantId);
    if (entry && entry.revision === revision && entry.epoch === this.epoch && entry.resellerId === actor.resellerId && entry.values.has(kind)) {
      this.entries.delete(tenantId); this.entries.set(tenantId, entry);
      this.stats.hits++; return entry.values.get(kind);
    }
    this.stats.misses++;
    // Full documents are cached only while they fit the remaining budget; a full budget keeps the documents already
    // cached instead of evicting them in a scan (an LRU over a sequential scan larger than the budget never hits).
    let bytes = 0;
    if (full) {
      bytes = this.db.prepare('SELECT length(CAST(data AS BLOB)) AS n FROM tenants WHERE id=?').get(tenantId)?.n || 0;
      if (this.fullBytes + bytes > this.fullBudgetBytes) { this.stats.uncached++; return build(this.store.tenant(actor, tenantId)); }
    }
    const tenant = this.store.tenant(actor, tenantId);
    // A full-document value must not share objects with a caller that may mutate its own copy: build from a private parse.
    const value = build(full ? deepFreeze(tenant) : tenant);
    if (this.revision(tenantId) !== revision || this.db.isTransaction) return value;
    let current = this.entries.get(tenantId);
    if (!current || current.revision !== revision || current.epoch !== this.epoch || current.resellerId !== tenant.resellerId) {
      this.drop(tenantId);
      current = { revision, epoch: this.epoch, resellerId: tenant.resellerId, values: new Map(), fullBytes: 0 };
    }
    if (full) { current.fullBytes += bytes; this.fullBytes += bytes; }
    current.values.set(kind, value);
    this.entries.delete(tenantId); this.entries.set(tenantId, current);
    this.evict(tenantId);
    return value;
  }
  evict(keep) {
    // Least recently used first; the entry just written is kept.
    for (const key of [...this.entries.keys()]) {
      if (this.entries.size <= this.maxTenants && this.fullBytes <= this.fullBudgetBytes) break;
      if (key === keep) continue;
      this.drop(key);
    }
  }
}

/** One index per Store (one SQLite connection); null for a store without SQLite (tests with doubles): callers read fresh. */
export function tenantIndex(store, options) {
  if (!store?.db || typeof store.db.prepare !== 'function' || typeof store.tenant !== 'function') return null;
  let index = indexes.get(store);
  if (!index) { index = new TenantIndex(store, options); indexes.set(store, index); }
  return index;
}
