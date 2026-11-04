import { createHash } from 'node:crypto';

export const JOURNAL_PENDING = 'ELOZI_CONVERSATION_JOURNAL_PENDING';
const names = ['conversation_journal_meta', 'conversation_journal', 'conversation_journal_write_guard'];
const tableSql = [
  `CREATE TABLE conversation_journal_meta (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),active INTEGER NOT NULL CHECK(active IN (0,1)))`,
  `CREATE TABLE conversation_journal (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,reseller_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),conversation_id TEXT NOT NULL,
    data TEXT NOT NULL CHECK(CASE WHEN json_valid(data) THEN json_type(data) IS 'object' AND json_type(data,'$.id') IS 'text' AND json_extract(data,'$.id') IS conversation_id ELSE 0 END),
    PRIMARY KEY(tenant_id,position),UNIQUE(tenant_id,conversation_id))`,
  `CREATE TABLE conversation_journal_write_guard (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,reseller_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),conversation_id TEXT NOT NULL,old_data TEXT NOT NULL,
    data TEXT NOT NULL CHECK(CASE WHEN json_valid(data) THEN json_type(data) IS 'object' AND json_type(data,'$.id') IS 'text' AND json_extract(data,'$.id') IS conversation_id ELSE 0 END))`
];
const normalize = sql => sql.replace(/\bIF\s+NOT\s+EXISTS\b/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
const failure = (code, message) => Object.assign(new Error(message), { code });
let sequence = 0;

function schema(db) {
  const rows = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name IN ('conversation_journal_meta','conversation_journal','conversation_journal_write_guard')").all();
  if (!rows.length) return false;
  if (rows.length !== names.length || rows.some(row => row.type !== 'table' || normalize(row.sql || '') !== normalize(tableSql[names.indexOf(row.name)]))) {
    throw failure('ELOZI_CONVERSATION_JOURNAL_SCHEMA', 'O formato do journal de conversas é desconhecido; os dados foram preservados.');
  }
  const meta = db.prepare('SELECT id,version,active FROM conversation_journal_meta').all();
  if (meta.length !== 1 || meta[0].id !== 1 || meta[0].version !== 1 || ![0, 1].includes(meta[0].active)) throw failure('ELOZI_CONVERSATION_JOURNAL_SCHEMA', 'O estado do journal de conversas é desconhecido; os dados foram preservados.');
  return true;
}

export function journalStatus(db) {
  if (!schema(db)) return { schemaVersion: 1, exists: false, active: false, rows: 0, dirtyTenants: 0 };
  const counts = db.prepare('SELECT count(*) AS rows,count(DISTINCT tenant_id) AS dirtyTenants FROM conversation_journal').get();
  return { schemaVersion: 1, exists: true, active: db.prepare('SELECT active FROM conversation_journal_meta WHERE id=1').get().active === 1, ...counts };
}

function effectiveSql(alias) {
  // Only qualified object conversations enter the journal. Keep JSON tokens inside
  // unchanged objects opaque: never coerce their numbers through SQL scalar/JS values.
  return `CASE WHEN EXISTS (SELECT 1 FROM conversation_journal pending WHERE pending.tenant_id=${alias}.id) THEN
    (WITH effective_conversations AS MATERIALIZED (
      SELECT base.key AS position,coalesce(pending.data,base.value) AS data
      FROM json_each(${alias}.data,'$.conversations') base LEFT JOIN conversation_journal pending
        ON pending.tenant_id=${alias}.id AND pending.position=base.key ORDER BY base.key)
      SELECT json_set(${alias}.data,'$.conversations',json((SELECT json_group_array(json(data)) FROM effective_conversations))))
    ELSE ${alias}.data END`;
}

export function effectiveTenantDataSql(db, alias = 't') {
  if (typeof alias !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Alias SQL interno inválido.');
  // Existing synthetic consumer doubles have no native connection or journal.
  return db?.isOpen === true && schema(db) ? effectiveSql(alias) : `${alias}.data`;
}

export function effectiveTenantRows(db, { tenantId, workspaceId } = {}) {
  const where = [], bindings = [];
  for (const [value, column] of [[tenantId, 'id'], [workspaceId, 'reseller_id']]) if (value !== undefined) {
    if (typeof value !== 'string') throw new TypeError('Escopo de leitura do journal inválido.');
    where.push(`t.${column}=?`); bindings.push(value);
  }
  return db.prepare(`SELECT t.id,t.reseller_id,${effectiveTenantDataSql(db)} AS data FROM tenants t${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id`).all(...bindings);
}

function transaction(db, fn) {
  const nested = db.isTransaction, savepoint = `conversation_journal_${++sequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA main.synchronous').get().synchronous !== 2) throw failure('ELOZI_CONVERSATION_JOURNAL_DURABILITY', 'O journal exige durabilidade SQLite FULL.');
    const result = fn(); db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return result;
  } catch (error) {
    try { db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export function installJournalTrigger(db, sql, { previousSql = [] } = {}) {
  const name = /^CREATE TRIGGER ([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1];
  if (!name) throw new TypeError('Trigger interno do journal inválido.');
  const previous = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name);
  if (previous && (previous.type !== 'trigger' || ![sql, ...previousSql].some(known => normalize(previous.sql) === normalize(known)))) throw failure('ELOZI_CONVERSATION_JOURNAL_SCHEMA', 'Uma proteção do journal é desconhecida; os dados foram preservados.');
  if (previous && normalize(previous.sql) !== normalize(sql)) { db.exec(`DROP TRIGGER ${name}`); db.exec(sql); }
  else if (!previous) db.exec(sql);
}

export function installJournalGuards(db) {
  const reject = `RAISE(ABORT,'${JOURNAL_PENDING}')`;
  installJournalTrigger(db, `CREATE TRIGGER conversation_journal_tenant_insert BEFORE INSERT ON tenants
    WHEN EXISTS (SELECT 1 FROM conversation_journal WHERE tenant_id=NEW.id) BEGIN SELECT ${reject}; END`);
  installJournalTrigger(db, `CREATE TRIGGER conversation_journal_tenant_update BEFORE UPDATE OF id,reseller_id,data ON tenants
    WHEN EXISTS (SELECT 1 FROM conversation_journal WHERE tenant_id=OLD.id) BEGIN
    SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.reseller_id IS NOT OLD.reseller_id OR NEW.data IS NOT (${effectiveSql('OLD')}) THEN ${reject} END; END`);
  installJournalTrigger(db, `CREATE TRIGGER conversation_journal_tenant_delete BEFORE DELETE ON tenants
    WHEN EXISTS (SELECT 1 FROM conversation_journal WHERE tenant_id=OLD.id) BEGIN SELECT ${reject}; END`);
  installJournalTrigger(db, `CREATE TRIGGER conversation_journal_delete BEFORE DELETE ON conversation_journal BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id=OLD.tenant_id AND t.reseller_id=OLD.reseller_id
      AND CASE WHEN json_valid(t.data) THEN json_extract(t.data,'$.conversations['||OLD.position||']') IS json(OLD.data) ELSE 0 END)
      THEN ${reject} END; END`);
  const proof = version => `EXISTS (SELECT 1 FROM conversation_journal_write_guard g JOIN tenants t ON t.id=g.tenant_id AND t.reseller_id=g.reseller_id
    JOIN conversation_journal_meta mode ON mode.id=1 AND mode.active=1
    JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id AND p.valid=1 AND p.source_type='object'
    JOIN service_conversation_lookup_meta coverage ON coverage.tenant_id=t.id AND coverage.complete=1
    JOIN service_conversation_private c ON c.tenant_id=t.id AND c.id=g.conversation_id AND c.position=g.position
    JOIN service_read_model_meta version ON version.id='routing' AND version.version=${version}
    WHERE g.tenant_id=NEW.tenant_id AND g.reseller_id=NEW.reseller_id AND g.position=NEW.position AND g.conversation_id=NEW.conversation_id
      AND g.data IS NEW.data AND g.old_data IS c.data)`;
  const insert = version => `CREATE TRIGGER conversation_journal_insert BEFORE INSERT ON conversation_journal BEGIN SELECT CASE WHEN NOT ${proof(version)} THEN ${reject} END; END`;
  const update = version => `CREATE TRIGGER conversation_journal_update BEFORE UPDATE ON conversation_journal BEGIN
    SELECT CASE WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.reseller_id IS NOT OLD.reseller_id OR NEW.position IS NOT OLD.position
      OR NEW.conversation_id IS NOT OLD.conversation_id OR NOT ${proof(version)}
      OR NOT EXISTS (SELECT 1 FROM conversation_journal_write_guard WHERE tenant_id=OLD.tenant_id AND old_data IS OLD.data)
      THEN ${reject} END; END`;
  // Only this exact former proof may migrate. Version 8 is never accepted by a
  // normal version-9 journal write; recovery materializes before routing rebuild.
  installJournalTrigger(db, insert(9), { previousSql: [insert(8)] });
  installJournalTrigger(db, update(9), { previousSql: [update(8)] });
  installJournalTrigger(db, `CREATE TRIGGER conversation_journal_mode_update BEFORE UPDATE ON conversation_journal_meta
    WHEN NEW.active=0 AND EXISTS (SELECT 1 FROM conversation_journal) BEGIN SELECT ${reject}; END`);
  installJournalTrigger(db, `CREATE TRIGGER conversation_journal_mode_delete BEFORE DELETE ON conversation_journal_meta
    WHEN OLD.active=1 OR EXISTS (SELECT 1 FROM conversation_journal) BEGIN SELECT ${reject}; END`);
}

function snapshot(db, effective) {
  const expression = effective ? effectiveTenantDataSql(db) : 't.data', hash = createHash('sha256');
  const rows = db.prepare(`SELECT t.id,t.reseller_id,${expression} AS data FROM tenants t ORDER BY t.id`).all();
  for (const row of rows) for (const value of [row.id, row.reseller_id, row.data]) { hash.update(`${Buffer.byteLength(value, 'utf8')}:`); hash.update(value, 'utf8'); }
  const counts = db.prepare(`WITH current AS MATERIALIZED (SELECT ${expression} AS data FROM tenants t),
    conversations AS MATERIALIZED (SELECT c.value,c.type FROM current,json_each(CASE WHEN json_valid(current.data) THEN CASE WHEN json_type(current.data,'$.conversations')='array' THEN json_extract(current.data,'$.conversations') ELSE '[]' END ELSE '[]' END) c)
    SELECT (SELECT count(*) FROM current) AS tenants,(SELECT count(*) FROM conversations) AS conversations,
      coalesce(sum(CASE WHEN type='object' THEN CASE WHEN json_type(value,'$.messages')='array' THEN json_array_length(value,'$.messages') ELSE 0 END ELSE 0 END),0) AS messages FROM conversations`).get();
  const sideEffects = {};
  for (const name of ['audit', 'outbound_commands', 'service_principal_receipts']) sideEffects[name] = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) ? db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n : null;
  return { ...counts, logicalHash: hash.digest('hex'), sideEffects };
}

function materialize(db, tenantId, workspaceId, legacy) {
  return transaction(db, () => {
    const status = journalStatus(db), before = snapshot(db, true);
    if (status.exists) {
      if (db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n !== 0) throw failure('ELOZI_CONVERSATION_JOURNAL_SCHEMA', 'Uma proteção de escrita desconhecida foi preservada.');
      const where = ['EXISTS (SELECT 1 FROM conversation_journal WHERE tenant_id=t.id)'], bindings = [];
      if (tenantId !== undefined) { where.push('t.id=?'); bindings.push(tenantId); }
      if (workspaceId !== undefined) { where.push('t.reseller_id=?'); bindings.push(workspaceId); }
      db.prepare(`UPDATE tenants AS t SET data=${effectiveSql('t')} WHERE ${where.join(' AND ')}`).run(...bindings);
      db.prepare(`DELETE FROM conversation_journal WHERE tenant_id IN (SELECT t.id FROM tenants t WHERE ${where.slice(1).join(' AND ') || '1'})`).run(...bindings);
      if (legacy) db.exec('UPDATE conversation_journal_meta SET active=0 WHERE id=1;');
    }
    const after = snapshot(db, true), physical = snapshot(db, false), remaining = journalStatus(db);
    const checks = { logicalHashPreserved: before.logicalHash === after.logicalHash,
      countsPreserved: ['tenants', 'conversations', 'messages'].every(key => before[key] === after[key]),
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length === 0,
      quickCheck: Object.values(db.prepare('PRAGMA quick_check').get())[0] === 'ok', synchronousFull: true,
      sideEffectsPreserved: Object.keys(before.sideEffects).every(key => before.sideEffects[key] === after.sideEffects[key]) };
    if (legacy) checks.logicalHashPreserved &&= physical.logicalHash === before.logicalHash;
    if (Object.values(checks).some(value => !value)) throw failure('ELOZI_CONVERSATION_JOURNAL_MATERIALIZE', 'A materialização não preservou o estado lógico; a transação foi revertida.');
    return { schemaVersion: 1, materialized: true, active: remaining.active, remainingRows: remaining.rows, before, after: legacy ? physical : after, checks };
  });
}

export function materializeTenant(db, tenantId, { workspaceId } = {}) {
  if (typeof tenantId !== 'string' || workspaceId !== undefined && typeof workspaceId !== 'string') throw new TypeError('Escopo de materialização inválido.');
  return materialize(db, tenantId, workspaceId, false);
}
export function materializeForLegacy(db) { return materialize(db, undefined, undefined, true); }

export function prepareConversationJournal(db, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('A opção conversationJournal precisa ser booleana.');
  const status = journalStatus(db);
  if (status.exists && db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n !== 0) throw failure('ELOZI_CONVERSATION_JOURNAL_SCHEMA', 'Uma proteção de escrita desconhecida foi preservada.');
  if (!enabled) {
    if (status.active || status.rows) throw failure('ELOZI_CONVERSATION_JOURNAL_ACTIVE', 'O journal está ativo; materialize para o runtime legado antes de abrir sem suporte.');
    return false;
  }
  if (status.exists && !status.active) throw failure('ELOZI_CONVERSATION_JOURNAL_ACTIVATION_REQUIRED', 'O journal foi materializado para o runtime legado; a retomada exige ativação explícita do controlador.');
  transaction(db, () => {
    if (!status.exists) { for (const sql of tableSql) db.exec(sql); db.exec('INSERT INTO conversation_journal_meta VALUES (1,1,0);'); }
    if (db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n !== 0) throw failure('ELOZI_CONVERSATION_JOURNAL_SCHEMA', 'Uma proteção de escrita desconhecida foi preservada.');
    installJournalGuards(db); materializeForLegacy(db);
  });
  return true;
}
export function activateJournalForForward(db) {
  return transaction(db, () => {
    const status = journalStatus(db);
    if (!status.exists || status.active || status.rows || db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n !== 0) throw failure('ELOZI_CONVERSATION_JOURNAL_ACTIVATION_REQUIRED', 'O journal não está limpo e desativado para uma retomada explícita.');
    db.exec('UPDATE conversation_journal_meta SET active=1 WHERE id=1;');
    return journalStatus(db);
  });
}
export function assertJournalCanRebuild(db) {
  if (journalStatus(db).rows) throw failure('ELOZI_CONVERSATION_JOURNAL_PENDING', 'Materialize o journal antes de reconstruir a projeção.');
}
