import { assertJournalCanRebuild, journalStatus, installJournalTrigger, installJournalGuards } from './conversation-journal.js';

/** Rebuildable private routing indexes. An enabled conversation journal is materialized before rebuilding. */
const CHANNEL_FIELDS = ['id', 'name', 'label', 'kind', 'transport', 'state', 'enabled', 'expectedNumber', 'defaultAgentId', 'allowedGroups', 'telegramGroups', 'replyPolicy'];
const AGENT_FIELDS = ['id', 'name', 'version', 'provider', 'mode', 'configured', 'description', 'tools', 'endpoint'];
const DEPARTMENT_FIELDS = ['id', 'name', 'active'];
const CONVERSATION_FIELDS = ['id', 'contact', 'initials', 'contactId', 'channelId', 'departmentId', 'department', 'owner', 'status', 'version', 'unread', 'agentId', 'assignedUserId', 'assignedUserName', 'assignedSupportGrantId', 'updatedAt', 'tags', 'conversationKind', 'remoteJid', 'remoteAliases', 'remoteChatId', 'remoteSenderId', 'remoteUserId', 'threadId', 'replyExempt'];
const list = fields => fields.map(field => `'${field}'`).join(',');
const jsonValue = alias => `CASE ${alias}.type WHEN 'text' THEN json_quote(${alias}.value) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ELSE CAST(${alias}.value AS TEXT) END`;
// Validate/extract once when opening json_each, never once per item in a tenant's document.
// Malformed canonical data remains intact for health/recovery and yields no routing metadata.
const array = (source, field) => `CASE WHEN json_valid(${source}) THEN CASE WHEN json_type(${source},'$.${field}')='array' THEN json_extract(${source},'$.${field}') ELSE '[]' END ELSE '[]' END`;
// Canonical conversation cursors retain the original document, without first
// rendering its entire history array as another JSON text value.
const conversationCursor = (source, legacy = false) => legacy ? `json_each(${array(source, 'conversations')})`
  : `json_each(CASE WHEN json_valid(${source}) THEN CASE WHEN json_type(${source},'$.conversations')='array' THEN ${source} ELSE '{}' END ELSE '{}' END,'$.conversations')`;
// Only for an already validated object/derived conversation, never an unchecked canonical document.
const knownArray = (source, field) => `CASE WHEN json_type(${source},'$.${field}')='array' THEN json_extract(${source},'$.${field}') ELSE '[]' END`;

// json_each scans an object once. Preserve missing fields and JSON booleans (configured/enabled are strict booleans).
function object(source, fields, alias, nested = {}) {
  const value = Object.entries(nested).reduce((sql, [key, expression]) => `CASE WHEN ${alias}.key='${key}' AND ${alias}.type='object' THEN ${expression} ELSE ${sql} END`, jsonValue(alias));
  return `(SELECT json_group_object(${alias}.key,json(${value})) FROM json_each(${source}) ${alias} WHERE ${alias}.key IN (${list(fields)}))`;
}
const channels = source => `(SELECT json_group_array(json(${object('channel.value', CHANNEL_FIELDS, 'field', {
  telegramGroups: object('field.value', ['mode', 'groupIds'], 'telegram_field'),
  replyPolicy: object('field.value', ['profile', 'perHour', 'perMinute', 'notice'], 'reply_field')
})})) FROM json_each(${array(source, 'channels')}) channel WHERE channel.type='object')`;
const agents = source => `(SELECT json_group_array(json(${object('agent.value', AGENT_FIELDS, 'agent_field')})) FROM json_each(${array(source, 'agents')}) agent WHERE agent.type='object')`;
const departments = source => `(SELECT json_group_array(json(${object('department.value', DEPARTMENT_FIELDS, 'department_field')})) FROM json_each(${array(source, 'departments')}) department WHERE department.type='object')`;
const header = source => `json_object('channels',json(${channels(source)}),'agents',json(${agents(source)}),'departments',json(${departments(source)}))`;
const conversations = (source, legacy = false, legacyCursor = legacy) => legacy ? `(SELECT value,key AS position,json_extract(value,'$.id') AS conversation_id,
  row_number() OVER (PARTITION BY json_extract(value,'$.id') ORDER BY key) AS ordinal
  FROM json_each(${array(source, 'conversations')}) WHERE type='object' AND json_type(value,'$.id')='text')`
  : `(SELECT current_conversation.value,current_conversation.key AS position,json_extract(current_conversation.value,'$.id') AS conversation_id
    FROM ${conversationCursor(source, legacyCursor)} current_conversation
    WHERE current_conversation.type='object' AND json_type(current_conversation.value,'$.id')='text'
      AND current_conversation.key IN
        (SELECT min(first_conversation.key) FROM ${conversationCursor(source, legacyCursor)} first_conversation
          WHERE first_conversation.type='object' AND json_type(first_conversation.value,'$.id')='text'
          GROUP BY json_extract(first_conversation.value,'$.id')))`;
// Only IDs and integer positions enter the grouping sort. The uncorrelated IN
// builds its own membership index once, without sorting full conversation bodies.
const conversationRows = (source, legacy = false, legacyCursor = legacy) => `${conversations(source, legacy, legacyCursor)} conversation WHERE ${legacy ? 'conversation.ordinal=1' : '1'}`;

const optionalText = (source, field) => `(json_type(${source},'$.${field}') IS NULL OR json_type(${source},'$.${field}') IN ('null','text'))`;
const lookupShape = source => `(json_type(${source},'$.id') IS 'text' AND length(json_extract(${source},'$.id'))>0
  AND json_type(${source},'$.channelId') IS 'text' AND ${optionalText(source, 'remoteJid')}
  AND (json_type(${source},'$.remoteAliases') IS NULL OR json_type(${source},'$.remoteAliases') IS 'null'
    OR (json_type(${source},'$.remoteAliases') IS 'array' AND NOT EXISTS
      (SELECT 1 FROM json_each(${knownArray(source, 'remoteAliases')}) alias WHERE alias.type IS NOT 'text')))
  AND json_type(${source},'$.messages') IS 'array' AND NOT EXISTS
    (SELECT 1 FROM json_each(${knownArray(source, 'messages')}) message WHERE CASE WHEN message.type='object'
      THEN NOT ${optionalText('message.value', 'externalId')} ELSE 1 END))`;
const lookupComplete = (source, legacy = false, aggregate = !legacy) => {
  // The outer CASE proves valid object + array before opening this cursor.
  const cursor = legacy ? `json_each(json_extract(${source},'$.conversations'))` : `json_each(${source},'$.conversations')`;
  const coverage = aggregate ? `(SELECT COALESCE(MAX(CASE WHEN candidate.type='object' THEN NOT ${lookupShape('candidate.value')} ELSE 1 END),0)=0
      AND count(*)=count(DISTINCT CASE WHEN candidate.type='object' THEN json_extract(candidate.value,'$.id') ELSE NULL END)
      FROM ${cursor} candidate)`
    : `NOT EXISTS (SELECT 1 FROM ${cursor} candidate
      WHERE CASE WHEN candidate.type='object' THEN NOT ${lookupShape('candidate.value')} ELSE 1 END)
    AND (SELECT count(*) FROM ${cursor})=
      (SELECT count(DISTINCT json_extract(value,'$.id')) FROM ${cursor} WHERE type='object')`;
  return `CASE WHEN json_valid(${source}) THEN CASE
  WHEN json_type(${source})='object' AND json_type(${source},'$.conversations')='array' THEN
    ${coverage}
  ELSE 0 END ELSE 0 END`;
};
function lookupSelect(tenantId, condition = '1', conversationId = null) {
  const selected = conversationId === null ? '' : ` AND c.id=${conversationId}`;
  const base = `FROM service_conversation_private c JOIN service_conversation_lookup_meta coverage ON coverage.tenant_id=c.tenant_id
    WHERE c.tenant_id=${tenantId} AND coverage.complete=1 AND ${condition}${selected}`;
  return `SELECT c.tenant_id AS tenant_id,c.id AS id,json_extract(c.data,'$.channelId') AS channel_id,'address' AS kind,json_extract(c.data,'$.remoteJid') AS value ${base}
      AND json_type(c.data,'$.remoteJid')='text'
    UNION ALL
    SELECT c.tenant_id,c.id,json_extract(c.data,'$.channelId'),'address',alias.value
      FROM service_conversation_private c JOIN service_conversation_lookup_meta coverage ON coverage.tenant_id=c.tenant_id,
        json_each(${knownArray('c.data', 'remoteAliases')}) alias
      WHERE c.tenant_id=${tenantId} AND coverage.complete=1 AND ${condition}${selected} AND alias.type='text'
    UNION ALL
    SELECT c.tenant_id,c.id,json_extract(c.data,'$.channelId'),'external',json_extract(message.value,'$.externalId')
      FROM service_conversation_private c JOIN service_conversation_lookup_meta coverage ON coverage.tenant_id=c.tenant_id,
        json_each(${knownArray('c.data', 'messages')}) message
      WHERE c.tenant_id=${tenantId} AND coverage.complete=1 AND ${condition}${selected}
        AND CASE WHEN message.type='object' THEN json_type(message.value,'$.externalId')='text' ELSE 0 END`;
}
function refreshLookup(tenantId, condition = '1', conversationId = null) {
  const expected = lookupSelect(tenantId, condition, conversationId);
  const scope = `tenant_id=${tenantId} AND ${condition}${conversationId === null ? '' : ` AND id=${conversationId}`}`;
  return `INSERT INTO service_conversation_lookup (tenant_id,id,channel_id,kind,value) ${expected}
    ON CONFLICT(tenant_id,id,kind,value) DO UPDATE SET channel_id=excluded.channel_id
    WHERE service_conversation_lookup.channel_id IS NOT excluded.channel_id;
    DELETE FROM service_conversation_lookup WHERE ${scope}
      AND (tenant_id,id,kind,value) IN
        (WITH expected AS MATERIALIZED (${expected}) SELECT tenant_id,id,kind,value FROM service_conversation_lookup WHERE ${scope}
          EXCEPT SELECT tenant_id,id,kind,value FROM expected);`;
}

function publicHeaderSelect(tenantId, workspaceId, condition) {
  // The private upsert immediately preceding this statement already clipped the
  // canonical history. Reuse only that freshly scoped header, never another tenant.
  return `SELECT ${tenantId},${workspaceId},${header('public_source.data')}
    FROM service_tenant_private public_source WHERE public_source.tenant_id=${tenantId}
      AND public_source.reseller_id=${workspaceId} AND ${condition}`;
}
function previousPublicHeaderSelect(selected, tenantId, workspaceId, condition, legacy = false) {
  if (legacy) return `SELECT ${tenantId},${workspaceId},${header(selected)} WHERE ${condition}`;
  // The three public arrays must not each parse the tenant's entire history.
  // Materialize this small source once; malformed canonical data stays untouched.
  return `SELECT ${tenantId},${workspaceId},${header('public_source.data')}
    FROM (WITH public_source AS MATERIALIZED
      (SELECT CASE WHEN json_valid(${selected}) THEN json_remove(${selected},'$.conversations') ELSE ${selected} END AS data)
      SELECT data FROM public_source) public_source WHERE ${condition}`;
}
function privateHeaderSelect(selected, tenantId, workspaceId, condition, legacy = false) {
  if (legacy) return `SELECT ${tenantId},${workspaceId},CASE WHEN valid THEN json_remove(data,'$.conversations') ELSE data END,valid,
      CASE WHEN valid THEN json_type(data) ELSE NULL END
    FROM (WITH private_source AS MATERIALIZED (SELECT ${selected} AS data,json_valid(${selected}) AS valid)
      SELECT data,valid FROM private_source) WHERE ${condition}`;
  // Keep only the validity flag while clipping. Never materialize the full
  // canonical document just to project its header or inspect its root type.
  return `SELECT ${tenantId},${workspaceId},data,valid,
      CASE WHEN valid THEN json_type(data) ELSE NULL END
    FROM (WITH private_validity AS MATERIALIZED (SELECT json_valid(${selected}) AS valid),
      private_header AS MATERIALIZED
        (SELECT CASE WHEN valid THEN json_remove(${selected},'$.conversations') ELSE ${selected} END AS data,valid FROM private_validity)
      SELECT data,valid FROM private_header) WHERE ${condition}`;
}
function installHeaderTrigger(db, sql, condition = '1') {
  const selected = `CASE WHEN ${condition} THEN NEW.data ELSE '{}' END`;
  // C32 has three separate coverage cursors. C31 also reads public conversations
  // from canonical JSON before reconciling the
  // private rows. C30 also has its own header clipping and former header order.
  // C28/C29 and earlier predecessors additionally use the former cursors/window/
  // headers. Never accept a partially reordered or partially reverted hybrid.
  const previousCoverage = sql.replace(refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', condition),
    refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', condition, false, false, true));
  const previousConversations = previousCoverage.replace(refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', condition, false, false, true),
    refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', condition, false, true));
  const previousOrder = previousConversations.replace(refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', condition, false, true),
    refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', condition, true));
  const previousCursor = previousOrder.replaceAll(conversationCursor(selected), conversationCursor(selected, true))
    .replaceAll(lookupComplete(selected, false, false), lookupComplete(selected, true));
  const previousWindow = previousCursor.replaceAll(conversationRows(selected, false, true), conversationRows(selected, true));
  const previousPrivate = previousWindow.replace(privateHeaderSelect(selected, 'NEW.id', 'NEW.reseller_id', condition),
    privateHeaderSelect(selected, 'NEW.id', 'NEW.reseller_id', condition, true));
  const previousPublic = previousPrivate.replace(previousPublicHeaderSelect(selected, 'NEW.id', 'NEW.reseller_id', condition),
    previousPublicHeaderSelect(selected, 'NEW.id', 'NEW.reseller_id', condition, true));
  installJournalTrigger(db, sql, { previousSql: [previousCoverage, previousConversations, previousOrder, previousCursor, previousWindow, previousPrivate, previousPublic] });
}
function refresh(source, tenantId, workspaceId, condition = '1', previousOrder = false, canonicalPublic = previousOrder, previousCoverage = canonicalPublic) {
  const selected = `CASE WHEN ${condition} THEN ${source} ELSE '{}' END`;
  const publicHeader = `INSERT INTO service_tenant_read (tenant_id,reseller_id,data) ${previousOrder
    ? previousPublicHeaderSelect(selected, tenantId, workspaceId, condition) : publicHeaderSelect(tenantId, workspaceId, condition)}
    ON CONFLICT(tenant_id) DO UPDATE SET reseller_id=excluded.reseller_id,data=excluded.data
    WHERE service_tenant_read.reseller_id IS NOT excluded.reseller_id OR service_tenant_read.data IS NOT excluded.data;`;
  const privateScope = `FROM service_conversation_private conversation JOIN service_tenant_private private_header
      ON private_header.tenant_id=conversation.tenant_id
    WHERE conversation.tenant_id=${tenantId} AND private_header.reseller_id=${workspaceId} AND ${condition}`;
  const publicConversations = canonicalPublic ? `INSERT INTO service_conversation_read (tenant_id,id,data)
    SELECT ${tenantId},conversation.conversation_id,${object('conversation.value', CONVERSATION_FIELDS, 'conversation_field')}
    FROM ${conversationRows(selected)}
    ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data WHERE service_conversation_read.data IS NOT excluded.data;
  DELETE FROM service_conversation_read WHERE tenant_id=${tenantId} AND ${condition} AND id NOT IN
    (SELECT json_extract(value,'$.id') FROM ${conversationCursor(selected)} WHERE type='object' AND json_type(value,'$.id')='text');`
    : `INSERT INTO service_conversation_read (tenant_id,id,data)
    SELECT conversation.tenant_id,conversation.id,${object('conversation.data', CONVERSATION_FIELDS, 'conversation_field')}
    ${privateScope}
    ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data WHERE service_conversation_read.data IS NOT excluded.data;
  DELETE FROM service_conversation_read WHERE tenant_id=${tenantId} AND ${condition}
    AND EXISTS (SELECT 1 FROM service_tenant_private WHERE tenant_id=${tenantId} AND reseller_id=${workspaceId})
    AND id NOT IN (SELECT conversation.id ${privateScope});`;
  const privateHeader = `INSERT INTO service_tenant_private (tenant_id,reseller_id,data,valid,source_type)
    ${privateHeaderSelect(selected, tenantId, workspaceId, condition)}
    ON CONFLICT(tenant_id) DO UPDATE SET reseller_id=excluded.reseller_id,data=excluded.data,valid=excluded.valid,source_type=excluded.source_type
    WHERE service_tenant_private.reseller_id IS NOT excluded.reseller_id OR service_tenant_private.data IS NOT excluded.data
      OR service_tenant_private.valid IS NOT excluded.valid OR service_tenant_private.source_type IS NOT excluded.source_type;`;
  const privateConversations = `INSERT INTO service_conversation_private (tenant_id,id,position,data)
    SELECT ${tenantId},conversation.conversation_id,conversation.position,conversation.value
    FROM ${conversationRows(selected)}
    ON CONFLICT(tenant_id,id) DO UPDATE SET position=excluded.position,data=excluded.data
    WHERE service_conversation_private.position IS NOT excluded.position OR service_conversation_private.data IS NOT excluded.data;
  DELETE FROM service_conversation_private WHERE tenant_id=${tenantId} AND ${condition} AND id NOT IN
    (SELECT json_extract(value,'$.id') FROM ${conversationCursor(selected)} WHERE type='object' AND json_type(value,'$.id')='text');`;
  const lookup = `INSERT INTO service_conversation_lookup_meta (tenant_id,complete) SELECT ${tenantId},${lookupComplete(selected, false, !previousCoverage)} WHERE ${condition}
    ON CONFLICT(tenant_id) DO UPDATE SET complete=excluded.complete WHERE service_conversation_lookup_meta.complete IS NOT excluded.complete;
  ${refreshLookup(tenantId, condition)}`;
  // Keep complete C32/C31/C30 bodies when deriving known predecessor definitions.
  return previousOrder ? `${publicHeader}
  ${publicConversations}
  ${privateHeader}
  ${privateConversations}
  ${lookup}` : canonicalPublic ? `${privateHeader}
  ${publicHeader}
  ${publicConversations}
  ${privateConversations}
  ${lookup}` : `${privateHeader}
  ${publicHeader}
  ${privateConversations}
  ${publicConversations}
  ${lookup}`;
}
const scopedWrite = "EXISTS (SELECT 1 FROM service_conversation_write_guard WHERE tenant_id=NEW.id AND validated=1)";
export const SCOPED_REPLACEMENT_PROOF_ERROR = 'ELOZI_SCOPED_REPLACEMENT_PROOF';
const expectedConversationSql = "(SELECT json_set(tenants.data,'$.conversations['||guard.position||']',json(guard.data)) FROM service_conversation_write_guard guard WHERE guard.tenant_id=tenants.id AND guard.workspace_id=tenants.reseller_id)";
// This is only a candidate. The BEFORE trigger must prove the exact canonical
// replacement or abort the statement, even if instr finds an earlier nested copy.
const replacementConversationSql = `(WITH conversation_replacement AS MATERIALIZED (
  SELECT instr(tenants.data,current_conversation.data) AS fragment_at,
    length(current_conversation.data) AS fragment_length,json(guard.data) AS replacement
  FROM service_conversation_write_guard guard LEFT JOIN service_conversation_private current_conversation
    ON current_conversation.tenant_id=guard.tenant_id AND current_conversation.id=guard.conversation_id
      AND current_conversation.position=guard.position
  WHERE guard.tenant_id=tenants.id AND guard.workspace_id=tenants.reseller_id)
  SELECT CASE WHEN fragment_at>0 THEN substr(tenants.data,1,fragment_at-1)||replacement||substr(tenants.data,fragment_at+fragment_length)
    ELSE ${expectedConversationSql} END FROM conversation_replacement)`;
// Only this empty, known experimental payload may be retired. Unknown data or
// dependants belong to their owner and must survive a failed migration unchanged.
const WRITE_PROOF_V6_SQL = `CREATE TABLE service_conversation_write_proof (
  tenant_id TEXT NOT NULL PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),conversation_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(CASE WHEN json_valid(data) THEN json_type(data) IS 'object' AND json_type(data,'$.id') IS 'text' AND json_extract(data,'$.id') IS conversation_id ELSE 0 END),
  old_data TEXT NOT NULL,
  expected_data TEXT NOT NULL GENERATED ALWAYS AS(json_set(old_data,'$.conversations['||position||']',json(data))) STORED)`;
const normalizedSchema = sql => sql.replace(/\bIF\s+NOT\s+EXISTS\b/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();
const PRIVATE_HEADER_V8_SQL = `CREATE TABLE service_tenant_private (
          tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,reseller_id TEXT NOT NULL,data TEXT NOT NULL,
          valid INTEGER NOT NULL CHECK(valid IN (0,1)),source_type TEXT)`;
const HEADER_TOKEN_COLUMN = "header_token TEXT NOT NULL DEFAULT '' CHECK(header_token='' OR (typeof(header_token)='text' AND length(header_token)=32 AND header_token NOT GLOB '*[^0-9a-f]*'))";
const PRIVATE_HEADER_V9_SQL = `${PRIVATE_HEADER_V8_SQL.slice(0, -1)}, ${HEADER_TOKEN_COLUMN})`;
const HEADER_TOKEN_TRIGGERS = [
  `CREATE TRIGGER service_private_header_token_insert AFTER INSERT ON service_tenant_private BEGIN
          UPDATE service_tenant_private SET header_token=lower(hex(randomblob(16))) WHERE tenant_id=NEW.tenant_id; END`,
  `CREATE TRIGGER service_private_header_token_update AFTER UPDATE OF reseller_id,data,valid,source_type ON service_tenant_private
          WHEN NEW.reseller_id IS NOT OLD.reseller_id OR NEW.data IS NOT OLD.data OR NEW.valid IS NOT OLD.valid OR NEW.source_type IS NOT OLD.source_type BEGIN
          UPDATE service_tenant_private SET header_token=lower(hex(randomblob(16))) WHERE tenant_id=NEW.tenant_id; END`,
  `CREATE TRIGGER service_private_header_token_tenant_insert AFTER INSERT ON tenants BEGIN
          UPDATE service_tenant_private SET header_token=lower(hex(randomblob(16))) WHERE tenant_id=NEW.id; END`
];
/** Validate before journal recovery can materialize anything. Unknown private data stays intact. */
export function validatePrivateHeaderSchema(db) {
  for (const sql of HEADER_TOKEN_TRIGGERS) {
    const name = /^CREATE TRIGGER (\w+)/.exec(sql)[1], previous = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name);
    if (previous && (previous.type !== 'trigger' || normalizedSchema(previous.sql || '') !== normalizedSchema(sql))) {
      throw Object.assign(new Error('A proteção privada do token é desconhecida; o armazenamento foi preservado.'), { code: 'ELOZI_READONLY_HEADER_SCHEMA' });
    }
  }
  const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='service_tenant_private'").get();
  if (!row) return false;
  if (row.type !== 'table' || ![PRIVATE_HEADER_V8_SQL, PRIVATE_HEADER_V9_SQL].some(sql => normalizedSchema(row.sql || '') === normalizedSchema(sql))) {
    throw Object.assign(new Error('O formato privado do header é desconhecido; o armazenamento foi preservado.'), { code: 'ELOZI_READONLY_HEADER_SCHEMA' });
  }
  return normalizedSchema(row.sql) === normalizedSchema(PRIVATE_HEADER_V9_SQL);
}
function retireExperimentalWriteProof(db) {
  const table = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='service_conversation_write_proof'").get();
  if (!table) return false;
  const known = table.type === 'table' && typeof table.sql === 'string' && normalizedSchema(table.sql) === normalizedSchema(WRITE_PROOF_V6_SQL);
  const dependants = known && db.prepare(`SELECT 1 FROM sqlite_schema
    WHERE name<>'service_conversation_write_proof'
      AND NOT (type='index' AND tbl_name='service_conversation_write_proof' AND sql IS NULL)
      AND NOT (type='trigger' AND name='service_read_before_update_v1' AND tbl_name='tenants')
      AND (tbl_name='service_conversation_write_proof' OR instr(lower(coalesce(sql,'')),'service_conversation_write_proof')>0) LIMIT 1`).get();
  if (!known || dependants || db.prepare('SELECT count(*) AS n FROM service_conversation_write_proof').get().n !== 0) {
    throw Object.assign(new Error('A prova experimental de escrita possui formato, dependências ou conteúdo desconhecido; o armazenamento foi preservado.'), { code: 'ELOZI_EXPERIMENTAL_WRITE_PROOF_PRESERVED' });
  }
  db.exec('DROP TRIGGER IF EXISTS service_read_before_update_v1; DROP TABLE service_conversation_write_proof;');
  return true;
}

export class ServiceReadModel {
  constructor(db) {
    this.db = db;
    this.readSequence = 0;
    assertJournalCanRebuild(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const tokenReady = validatePrivateHeaderSchema(db);
      const retiredProof = retireExperimentalWriteProof(db);
      const tablesReady = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('service_tenant_read','service_conversation_read','service_tenant_private','service_conversation_private','service_conversation_lookup','service_conversation_lookup_meta')").get().n === 6;
      db.exec(`CREATE TABLE IF NOT EXISTS service_read_model_meta (id TEXT PRIMARY KEY,version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS service_tenant_read (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,reseller_id TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS service_tenant_read_scope ON service_tenant_read(reseller_id,tenant_id);
        CREATE TABLE IF NOT EXISTS service_conversation_read (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
        ${PRIVATE_HEADER_V9_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};
        CREATE TABLE IF NOT EXISTS service_conversation_private (
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),data TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
        CREATE TABLE IF NOT EXISTS service_conversation_lookup_meta (
          tenant_id TEXT NOT NULL PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,complete INTEGER NOT NULL CHECK(complete IN (0,1)));
        CREATE TABLE IF NOT EXISTS service_conversation_lookup (
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,id TEXT NOT NULL,channel_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('address','external')),value TEXT NOT NULL,PRIMARY KEY(tenant_id,id,kind,value));
        CREATE INDEX IF NOT EXISTS service_conversation_lookup_key ON service_conversation_lookup(tenant_id,channel_id,kind,value,id);
        CREATE TABLE IF NOT EXISTS service_conversation_write_guard (
          tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),conversation_id TEXT NOT NULL,
          data TEXT NOT NULL CHECK(CASE WHEN json_valid(data) THEN json_type(data) IS 'object' AND json_type(data,'$.id') IS 'text' AND json_extract(data,'$.id') IS conversation_id ELSE 0 END),
          validated INTEGER NOT NULL DEFAULT 0 CHECK(validated IN (0,1)),
          strict_write INTEGER NOT NULL DEFAULT 0 CHECK(strict_write IN (0,1)));`);
      if (!db.prepare('PRAGMA table_info(service_tenant_private)').all().some(column => column.name === 'header_token')) db.exec(`ALTER TABLE service_tenant_private ADD COLUMN ${HEADER_TOKEN_COLUMN};`);
      validatePrivateHeaderSchema(db);
      for (const sql of HEADER_TOKEN_TRIGGERS) db.exec(sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '));
      db.exec("UPDATE service_tenant_private SET header_token=lower(hex(randomblob(16))) WHERE header_token='';");
      const strictColumn = db.prepare('PRAGMA table_info(service_conversation_write_guard)').all().find(column => column.name === 'strict_write');
      if (!strictColumn) db.exec('ALTER TABLE service_conversation_write_guard ADD COLUMN strict_write INTEGER NOT NULL DEFAULT 0 CHECK(strict_write IN (0,1));');
      else if (strictColumn.type !== 'INTEGER' || strictColumn.notnull !== 1 || strictColumn.dflt_value !== '0') throw new Error('O formato da proteção de escrita estrita é desconhecido; o armazenamento foi preservado.');
      const refreshNeeded = retiredProof || !tablesReady || !strictColumn || !tokenReady || !db.prepare("SELECT 1 FROM service_read_model_meta WHERE id='routing' AND version=9").get();
      if (refreshNeeded) db.exec('DROP TRIGGER IF EXISTS service_read_insert_v1; DROP TRIGGER IF EXISTS service_read_before_update_v1; DROP TRIGGER IF EXISTS service_read_update_v1; DROP TRIGGER IF EXISTS service_read_noop_update_v1; DROP TRIGGER IF EXISTS service_read_delete_v1;');
      installHeaderTrigger(db, `CREATE TRIGGER service_read_insert_v1 AFTER INSERT ON tenants BEGIN ${refresh('NEW.data', 'NEW.id', 'NEW.reseller_id')} END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS service_read_before_update_v1 BEFORE UPDATE OF data,reseller_id,id ON tenants
          BEGIN
          UPDATE service_conversation_write_guard SET validated=CASE
            WHEN NEW.id=OLD.id AND NEW.reseller_id=OLD.reseller_id AND workspace_id=OLD.reseller_id THEN
              CASE WHEN EXISTS (SELECT 1 FROM service_tenant_private private_header
                  JOIN service_conversation_private private_conversation ON private_conversation.tenant_id=private_header.tenant_id
                  WHERE private_header.tenant_id=OLD.id AND private_header.reseller_id=OLD.reseller_id
                    AND private_header.valid=1 AND private_header.source_type='object'
                    AND EXISTS (SELECT 1 FROM service_read_model_meta WHERE id='routing' AND version=9)
                    AND private_conversation.id=service_conversation_write_guard.conversation_id
                    AND private_conversation.position=service_conversation_write_guard.position) THEN
                CASE WHEN NEW.data IS json_set(OLD.data,'$.conversations['||position||']',json(data)) THEN 1 ELSE 0 END
              ELSE 0 END
            ELSE 0 END WHERE tenant_id=OLD.id;
          SELECT CASE WHEN EXISTS (SELECT 1 FROM service_conversation_write_guard
            WHERE tenant_id=OLD.id AND strict_write=1 AND validated IS NOT 1)
            THEN RAISE(ABORT,'${SCOPED_REPLACEMENT_PROOF_ERROR}') END;
        END;`);
      installHeaderTrigger(db, `CREATE TRIGGER service_read_update_v1 AFTER UPDATE OF data,reseller_id,id ON tenants
          WHEN NEW.data IS NOT OLD.data OR NEW.reseller_id IS NOT OLD.reseller_id OR NEW.id IS NOT OLD.id BEGIN
          DELETE FROM service_conversation_read WHERE tenant_id=OLD.id AND OLD.id IS NOT NEW.id;
          DELETE FROM service_tenant_read WHERE tenant_id=OLD.id AND OLD.id IS NOT NEW.id;
          DELETE FROM service_conversation_private WHERE tenant_id=OLD.id AND OLD.id IS NOT NEW.id;
          DELETE FROM service_tenant_private WHERE tenant_id=OLD.id AND OLD.id IS NOT NEW.id;
          DELETE FROM service_conversation_lookup WHERE tenant_id=OLD.id AND OLD.id IS NOT NEW.id;
          DELETE FROM service_conversation_lookup_meta WHERE tenant_id=OLD.id AND OLD.id IS NOT NEW.id;
          ${refresh('NEW.data', 'NEW.id', 'NEW.reseller_id', `NOT (${scopedWrite})`)}
          INSERT INTO service_conversation_read (tenant_id,id,data)
            SELECT NEW.id,conversation_id,${object('guard.data', CONVERSATION_FIELDS, 'conversation_field')}
            FROM service_conversation_write_guard guard WHERE guard.tenant_id=NEW.id AND guard.validated=1
            ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data WHERE service_conversation_read.data IS NOT excluded.data;
          INSERT INTO service_conversation_private (tenant_id,id,position,data)
            SELECT NEW.id,conversation_id,position,data FROM service_conversation_write_guard WHERE tenant_id=NEW.id AND validated=1
            ON CONFLICT(tenant_id,id) DO UPDATE SET position=excluded.position,data=excluded.data
            WHERE service_conversation_private.position IS NOT excluded.position OR service_conversation_private.data IS NOT excluded.data;
          UPDATE service_conversation_lookup_meta SET complete=0 WHERE tenant_id=NEW.id AND complete=1 AND EXISTS
            (SELECT 1 FROM service_conversation_write_guard guard WHERE guard.tenant_id=NEW.id AND guard.validated=1
              AND NOT ${lookupShape('guard.data')});
          ${refreshLookup('NEW.id', 'EXISTS (SELECT 1 FROM service_conversation_write_guard WHERE tenant_id=NEW.id AND validated=1)', '(SELECT conversation_id FROM service_conversation_write_guard WHERE tenant_id=NEW.id AND validated=1)')}
          UPDATE service_conversation_write_guard SET validated=0 WHERE tenant_id=NEW.id;
        END`, `NOT (${scopedWrite})`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS service_read_noop_update_v1 AFTER UPDATE OF data,reseller_id,id ON tenants
          WHEN NEW.data IS OLD.data AND NEW.reseller_id IS OLD.reseller_id AND NEW.id IS OLD.id BEGIN
          UPDATE service_conversation_write_guard SET validated=0 WHERE tenant_id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS service_read_delete_v1 AFTER DELETE ON tenants BEGIN
          DELETE FROM service_conversation_read WHERE tenant_id=OLD.id; DELETE FROM service_tenant_read WHERE tenant_id=OLD.id;
          DELETE FROM service_conversation_private WHERE tenant_id=OLD.id; DELETE FROM service_tenant_private WHERE tenant_id=OLD.id;
          DELETE FROM service_conversation_lookup WHERE tenant_id=OLD.id; DELETE FROM service_conversation_lookup_meta WHERE tenant_id=OLD.id; END;`);
      if (journalStatus(db).exists) {
        installJournalGuards(db);
        const project = `INSERT INTO service_conversation_read (tenant_id,id,data)
          VALUES (NEW.tenant_id,NEW.conversation_id,${object('NEW.data', CONVERSATION_FIELDS, 'journal_field')})
          ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data;
          INSERT INTO service_conversation_private (tenant_id,id,position,data) VALUES (NEW.tenant_id,NEW.conversation_id,NEW.position,NEW.data)
          ON CONFLICT(tenant_id,id) DO UPDATE SET position=excluded.position,data=excluded.data;
          UPDATE service_conversation_lookup_meta SET complete=0 WHERE tenant_id=NEW.tenant_id AND NOT ${lookupShape('NEW.data')};
          ${refreshLookup('NEW.tenant_id', '1', 'NEW.conversation_id')}`;
        installJournalTrigger(db, `CREATE TRIGGER conversation_journal_project_insert AFTER INSERT ON conversation_journal BEGIN ${project} END`);
        installJournalTrigger(db, `CREATE TRIGGER conversation_journal_project_update AFTER UPDATE ON conversation_journal BEGIN ${project} END`);
      }
      if (refreshNeeded) this.backfill();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    this.header = db.prepare('SELECT data FROM service_tenant_read WHERE tenant_id=? AND reseller_id=?');
    this.all = db.prepare('SELECT data FROM service_conversation_read WHERE tenant_id=? ORDER BY id');
    this.one = db.prepare('SELECT data FROM service_conversation_read WHERE tenant_id=? AND id=?');
    this.many = db.prepare('SELECT data FROM service_conversation_read WHERE tenant_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id');
    this.source = db.prepare("SELECT conversation.data FROM tenants t JOIN service_conversation_private conversation ON conversation.tenant_id=t.id JOIN service_read_model_meta version ON version.id='routing' AND version.version=9 WHERE t.id=? AND t.reseller_id=? AND conversation.id=?");
    this.lookupCoverage = db.prepare("SELECT coverage.complete FROM tenants t JOIN service_conversation_lookup_meta coverage ON coverage.tenant_id=t.id JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id JOIN service_read_model_meta version ON version.id='routing' AND version.version=9 WHERE t.id=? AND t.reseller_id=? AND p.valid=1 AND p.source_type='object'");
    this.lookupRows = db.prepare('SELECT DISTINCT address.id,c.position FROM service_conversation_lookup address JOIN service_conversation_private c ON c.tenant_id=address.tenant_id AND c.id=address.id WHERE address.tenant_id=? AND address.channel_id=? AND address.kind=? AND address.value IN (SELECT value FROM json_each(?)) ORDER BY c.position,address.id');
  }
  /** Private transactional hint, verified against OLD/NEW canonical JSON by pure-SQL triggers before use. */
  withConversationWrite({ tenantId, workspaceId, position, conversationId, data, strict = false }, update) {
    if (!Number.isSafeInteger(position) || position < 0 || typeof conversationId !== 'string' || typeof data !== 'string' || typeof strict !== 'boolean') throw new TypeError('Contexto de escrita da conversa inválido.');
    const savepoint = `service_conversation_write_${++this.readSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      this.db.prepare('INSERT INTO service_conversation_write_guard (tenant_id,workspace_id,position,conversation_id,data,strict_write) VALUES (?,?,?,?,?,?)').run(tenantId, workspaceId, position, conversationId, data, strict ? 1 : 0);
      const result = update({ expectedSql: expectedConversationSql, replacementSql: strict ? replacementConversationSql : expectedConversationSql });
      if (typeof result?.then === 'function') { Promise.resolve(result).catch(() => {}); throw new TypeError('A escrita da conversa precisa ser síncrona.'); }
      this.db.prepare('DELETE FROM service_conversation_write_guard WHERE tenant_id=?').run(tenantId);
      this.db.exec(`RELEASE ${savepoint}`); return result;
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  canJournalConversation(tenantId, workspaceId, data) {
    return Boolean(this.db.prepare(`SELECT 1 FROM tenants t JOIN conversation_journal_meta mode ON mode.id=1 AND mode.active=1
      JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id AND p.valid=1 AND p.source_type='object'
      JOIN service_conversation_lookup_meta coverage ON coverage.tenant_id=t.id AND coverage.complete=1
      WHERE t.id=?1 AND t.reseller_id=?2 AND CASE WHEN json_valid(?3) THEN CASE WHEN json_type(?3)='object' THEN ${lookupShape('?3')} ELSE 0 END ELSE 0 END`).get(tenantId, workspaceId, data));
  }
  withJournalWrite({ tenantId, workspaceId, position, conversationId, oldData, data }, update) {
    const savepoint = `service_journal_write_${++this.readSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      this.db.prepare('INSERT INTO conversation_journal_write_guard (tenant_id,reseller_id,position,conversation_id,old_data,data) VALUES (?,?,?,?,?,?)').run(tenantId, workspaceId, position, conversationId, oldData, data);
      const result = update();
      if (typeof result?.then === 'function') { Promise.resolve(result).catch(() => {}); throw new TypeError('A escrita da conversa precisa ser síncrona.'); }
      this.db.prepare('DELETE FROM conversation_journal_write_guard WHERE tenant_id=?').run(tenantId);
      this.db.exec(`RELEASE ${savepoint}`); return result;
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  backfill() {
    assertJournalCanRebuild(this.db);
    // Run inside the caller's transaction. Pure SQL also works for an older binary that knows only tenants.data.
    const statements = refresh('?3', '?1', '?2').split(';').filter(value => value.trim()).map(sql => ({
      statement: this.db.prepare(sql),
      // Numbered SQLite parameters occupy every slot through their highest index.
      // Lookup maintenance may use only ?1; binding unused ?2/?3 is an error.
      arity: Math.max(0, ...Array.from(sql.matchAll(/\?(\d+)/g), match => Number(match[1])))
    }));
    for (const row of this.db.prepare('SELECT id,reseller_id,data FROM tenants').iterate()) {
      const bindings = [row.id, row.reseller_id, row.data];
      for (const { statement, arity } of statements) statement.run(...bindings.slice(0, arity));
    }
    this.db.exec('DELETE FROM service_conversation_read WHERE tenant_id NOT IN (SELECT id FROM tenants); DELETE FROM service_tenant_read WHERE tenant_id NOT IN (SELECT id FROM tenants); DELETE FROM service_conversation_private WHERE tenant_id NOT IN (SELECT id FROM tenants); DELETE FROM service_tenant_private WHERE tenant_id NOT IN (SELECT id FROM tenants); DELETE FROM service_conversation_lookup WHERE tenant_id NOT IN (SELECT id FROM tenants); DELETE FROM service_conversation_lookup_meta WHERE tenant_id NOT IN (SELECT id FROM tenants);');
    // A rebuild is a new private incarnation even if the same bytes are rebuilt.
    this.db.exec('UPDATE service_tenant_private SET header_token=lower(hex(randomblob(16)));');
    this.db.prepare("INSERT INTO service_read_model_meta VALUES ('routing',9) ON CONFLICT(id) DO UPDATE SET version=excluded.version WHERE version IS NOT excluded.version").run();
  }
  rebuild() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare("SELECT 1 FROM service_read_model_meta WHERE id='routing' AND version=9").get()) throw new Error('A versão da projeção mudou; reabra o armazenamento para migrá-la.');
      this.backfill(); this.db.exec('COMMIT');
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Internal candidate lookup only. null requires the canonical legacy path; [] is a proven empty result. */
  lookupConversationIds({ tenantId, workspaceId, channelId, kind, values }) {
    if (typeof tenantId !== 'string' || typeof workspaceId !== 'string' || typeof channelId !== 'string'
      || !['address', 'external'].includes(kind) || !Array.isArray(values) || Array.from(values).some(value => typeof value !== 'string')) return null;
    const savepoint = `service_lookup_${++this.readSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const coverage = this.lookupCoverage.get(tenantId, workspaceId);
      const ids = coverage?.complete === 1 ? this.lookupRows.all(tenantId, channelId, kind, JSON.stringify(values)).map(row => row.id) : null;
      this.db.exec(`RELEASE ${savepoint}`); return ids;
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  tenant(workspaceId, tenantId, options = {}) {
    const { conversationId, conversationIds, includeMessages = false } = options;
    if (Object.hasOwn(options, 'conversationIds') && (!Array.isArray(conversationIds) || conversationIds.length > 50 || Array.from(conversationIds).some(id => typeof id !== 'string') || new Set(conversationIds).size !== conversationIds.length || Object.hasOwn(options, 'conversationId') || Object.hasOwn(options, 'includeMessages'))) throw Object.assign(new Error('Escolha até 50 conversas únicas para ler seus metadados.'), { status: 400 });
    if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string' || typeof includeMessages !== 'boolean' || includeMessages && typeof conversationId !== 'string') throw Object.assign(new Error('Escolha uma conversa para ler seu histórico.'), { status: 400 });
    const savepoint = `service_read_${++this.readSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const tenant = this.readTenant(workspaceId, tenantId, { conversationId, conversationIds, includeMessages });
      this.db.exec(`RELEASE ${savepoint}`); return tenant;
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  readTenant(workspaceId, tenantId, { conversationId, conversationIds, includeMessages }) {
    const row = this.header.get(tenantId, workspaceId);
    if (!row) return null;
    const tenant = { id: tenantId, resellerId: workspaceId, ...JSON.parse(row.data), conversations: [] };
    if (conversationIds !== undefined) {
      tenant.conversations = this.many.all(tenantId, JSON.stringify(conversationIds)).map(value => JSON.parse(value.data));
      return tenant;
    }
    if (conversationId === null) return tenant;
    if (includeMessages) {
      const metadata = this.one.get(tenantId, conversationId), history = metadata && this.source.get(tenantId, workspaceId, conversationId);
      if (metadata && history) tenant.conversations = [JSON.parse(history.data)];
    } else tenant.conversations = (conversationId === undefined ? this.all.all(tenantId) : [this.one.get(tenantId, conversationId)].filter(Boolean)).map(value => JSON.parse(value.data));
    return tenant;
  }
}
