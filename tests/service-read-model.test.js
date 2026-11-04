import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { isTelegramAccountChannel } from '../src/telegram-account-policy.js';

const status = code => error => error.status === code;
const secret = 'secret-must-not-enter-routing-index';
function source(extra = {}) {
  return { name: 'Empresa sintética', apiKey: secret, contacts: [{ id: 'contact', secret }],
    channels: [{ id: 'wa', name: 'WhatsApp sintético', kind: 'whatsapp_qr', transport: 'baileys', enabled: false, allowedGroups: ['123@g.us'], token: secret, credentials: { secret },
      telegramGroups: { mode: 'selected', groupIds: ['-123'], secret }, replyPolicy: { profile: 'assistant', perHour: 10, notice: 'Retornaremos em breve.', token: secret } }],
    agents: [{ id: 'agent', name: 'Agente sintético', version: 1, provider: 'mcp', mode: 'copilot', configured: true, description: 'Descrição do adaptador', tools: ['conversation.read'], endpoint: 'https://synthetic.invalid/mcp', apiKey: secret, memory: secret, instructions: secret }],
    departments: [{ id: 'sac', name: 'SAC', active: true, token: secret }],
    conversations: [{ id: 'same-id', contact: 'Contato sintético', channelId: 'wa', departmentId: 'sac', version: 1, owner: 'agent', agentId: 'agent', status: 'open', unread: 2,
      conversationKind: 'direct', remoteJid: '5511000000000@s.whatsapp.net', updatedAt: '2026-10-22T12:00:00.000Z', contactSecret: secret, notes: secret,
      messages: [{ id: 'message', kind: 'customer', text: 'private-message-must-not-enter-routing-index' }] }], ...extra };
}
function legacy(t, tenantData = JSON.stringify(source())) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-routing-fixture-')), path = join(directory, 'synthetic.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE resellers (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants (id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);');
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('workspace-a', '{}');
  db.prepare('INSERT INTO resellers VALUES (?,?)').run('workspace-b', '{}');
  db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-a', 'workspace-a', tenantData);
  db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-b', 'workspace-b', JSON.stringify(source({ conversations: [{ ...source().conversations[0], contact: 'Outro tenant', channelId: 'other' }] })));
  db.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(path);
  return { store, path };
}
const readSource = (store, id = 'tenant-a') => JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(id).data);
const update = (store, value, id = 'tenant-a') => store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), id);
const fingerprint = agent => createHash('sha256').update(JSON.stringify({ id: agent.id, version: agent.version || 1, provider: agent.provider, mode: agent.mode,
  configured: agent.configured, description: agent.description || '', tools: agent.tools || [], endpoint: agent.endpoint || '' })).digest('hex');
const headerTriggerNames = ['service_read_insert_v1', 'service_read_update_v1'];
const headerTriggers = db => headerTriggerNames.map(name => db.prepare('SELECT name,sql FROM sqlite_schema WHERE name=?').get(name));
function conversationClause(sql) {
  const start = sql.indexOf('(SELECT current_conversation.value,'), ending = ') conversation WHERE 1';
  const end = sql.indexOf(ending, start) + ending.length;
  assert.ok(start >= 0 && end > start);
  return sql.slice(start, end);
}
function formerConversationClause(current) {
  const from = 'FROM json_each(', start = current.indexOf(from) + from.length, end = current.indexOf(') current_conversation', start);
  assert.ok(start >= from.length && end > start);
  const array = current.slice(start, end);
  return `(SELECT value,key AS position,json_extract(value,'$.id') AS conversation_id,
  row_number() OVER (PARTITION BY json_extract(value,'$.id') ORDER BY key) AS ordinal
  FROM json_each(${array}) WHERE type='object' AND json_type(value,'$.id')='text') conversation WHERE conversation.ordinal=1`;
}
function formerConversationTrigger(sql) {
  const current = conversationClause(sql);
  return sql.replaceAll(current, formerConversationClause(current));
}
function publicHeaderRelation(sql) {
  const start = sql.indexOf('FROM (WITH public_source AS MATERIALIZED'), end = sql.indexOf(') public_source', start) + ') public_source'.length;
  assert.ok(start >= 0 && end > start);
  const relation = sql.slice(start, end), argumentStart = relation.indexOf('json_valid(') + 'json_valid('.length;
  const argumentEnd = relation.indexOf(') THEN json_remove(', argumentStart), selected = relation.slice(argumentStart, argumentEnd);
  assert.ok(argumentEnd > argumentStart); assert.ok(selected.startsWith('CASE WHEN '));
  return { start, end, selected };
}
function privateHeaderSource(sql) {
  const validity = 'WITH private_validity AS MATERIALIZED (SELECT json_valid(', start = sql.indexOf(validity) + validity.length;
  const end = sql.indexOf(') AS valid),', start);
  assert.ok(start >= validity.length && end > start);
  const selected = sql.slice(start, end), suffix = " THEN NEW.data ELSE '{}' END";
  assert.ok(selected.startsWith('CASE WHEN ') && selected.endsWith(suffix));
  return { selected, condition: selected.slice('CASE WHEN '.length, -suffix.length) };
}
function formerCoverageTrigger(sql) {
  const { selected } = privateHeaderSource(sql), cursor = `json_each(${selected},'$.conversations')`;
  const prefix = "(SELECT COALESCE(MAX(CASE WHEN candidate.type='object' THEN NOT ";
  const start = sql.indexOf(prefix), shapeEnd = sql.indexOf(' ELSE 1 END),0)=0', start);
  const ending = `FROM ${cursor} candidate)`, end = sql.indexOf(ending, shapeEnd) + ending.length;
  assert.ok(start >= 0 && shapeEnd > start && end > shapeEnd);
  assert.equal(sql.split(prefix).length - 1, 1);
  const shape = sql.slice(start + prefix.length, shapeEnd);
  // Reconstruct C32's executed NOT EXISTS and two count scans, retaining its
  // exact NULL/filter rules instead of deriving the reference from the aggregate.
  const previous = `NOT EXISTS (SELECT 1 FROM ${cursor} candidate
      WHERE CASE WHEN candidate.type='object' THEN NOT ${shape} ELSE 1 END)
    AND (SELECT count(*) FROM ${cursor})=
      (SELECT count(DISTINCT json_extract(value,'$.id')) FROM ${cursor} WHERE type='object')`;
  return sql.slice(0, start) + previous + sql.slice(end);
}
function formerPublicClipTrigger(sql) {
  const { selected, condition } = privateHeaderSource(sql);
  const current = `FROM service_tenant_private public_source WHERE public_source.tenant_id=NEW.id
      AND public_source.reseller_id=NEW.reseller_id AND ${condition}`;
  assert.equal(sql.split(current).length - 1, 1);
  return sql.replace(current, `FROM (WITH public_source AS MATERIALIZED
      (SELECT CASE WHEN json_valid(${selected}) THEN json_remove(${selected},'$.conversations') ELSE ${selected} END AS data)
      SELECT data FROM public_source) public_source WHERE ${condition}`);
}
function conversationStatements(sql, table) {
  const start = sql.indexOf(`INSERT INTO ${table} `), insertEnd = sql.indexOf(';', start) + 1;
  const deletion = sql.indexOf(`DELETE FROM ${table} `, insertEnd), end = sql.indexOf(';', deletion) + 1;
  assert.ok(start >= 0 && insertEnd < deletion && deletion < end);
  return { start, end, insert: sql.slice(start, insertEnd), deletion: sql.slice(deletion, end) };
}
function formerPublicConversationTrigger(sql, { canonical = true, reorder = true } = {}) {
  const publicRows = conversationStatements(sql, 'service_conversation_read'), privateRows = conversationStatements(sql, 'service_conversation_private');
  assert.ok(privateRows.start < privateRows.end && privateRows.end < publicRows.start);
  assert.equal(sql.slice(privateRows.end, publicRows.start).trim(), '');
  let publicBlock = sql.slice(publicRows.start, publicRows.end);
  if (canonical) {
    const select = 'SELECT conversation.tenant_id,conversation.id,', selectStart = publicRows.insert.indexOf(select);
    const from = publicRows.insert.indexOf('\n    FROM service_conversation_private conversation JOIN service_tenant_private private_header', selectStart);
    const conflict = publicRows.insert.indexOf('ON CONFLICT(tenant_id,id)', from);
    assert.ok(selectStart >= 0 && from > selectStart && conflict > from);
    const fields = publicRows.insert.slice(selectStart + select.length, from).replaceAll('json_each(conversation.data)', 'json_each(conversation.value)');
    // Copy the real canonical private cursor and cleanup, not the new public
    // relation. This reconstructs C31's independently executed public projection.
    publicBlock = `INSERT INTO service_conversation_read (tenant_id,id,data)
    SELECT NEW.id,conversation.conversation_id,${fields}
    FROM ${conversationClause(sql)}
    ${publicRows.insert.slice(conflict)}
  ${privateRows.deletion.replace('DELETE FROM service_conversation_private ', 'DELETE FROM service_conversation_read ')}`;
  }
  const privateBlock = sql.slice(privateRows.start, privateRows.end);
  return sql.slice(0, privateRows.start) + (reorder ? `${publicBlock}\n  ${privateBlock}` : `${privateBlock}\n  ${publicBlock}`) + sql.slice(publicRows.end);
}
function formerHeaderOrderTrigger(sql, restorePublicClip = true) {
  if (restorePublicClip) sql = formerPublicClipTrigger(sql);
  const privateStart = sql.indexOf('INSERT INTO service_tenant_private (tenant_id,reseller_id,data,valid,source_type)'), privateEnd = sql.indexOf(';', privateStart) + 1;
  const publicStart = sql.indexOf('INSERT INTO service_tenant_read (tenant_id,reseller_id,data)'), publicEnd = sql.indexOf(';', publicStart) + 1;
  const conversationsStart = sql.indexOf('INSERT INTO service_conversation_read', publicEnd), tail = sql.indexOf('INSERT INTO service_conversation_private', conversationsStart);
  assert.ok(privateStart >= 0 && privateEnd < publicStart && publicEnd < conversationsStart && conversationsStart < tail);
  assert.equal(sql.slice(privateEnd, publicStart).trim(), '');
  // C30 first wrote public header + public conversations, then private header.
  // Restore that full order before deriving any older cursor/window/header SQL.
  return sql.slice(0, privateStart) + sql.slice(publicStart, tail) + sql.slice(privateStart, privateEnd) + '\n  ' + sql.slice(tail);
}
function formerCursorTrigger(sql, mode = 'all') {
  const { selected } = privateHeaderSource(sql);
  const guarded = `json_each(CASE WHEN json_valid(${selected}) THEN CASE WHEN json_type(${selected},'$.conversations')='array' THEN ${selected} ELSE '{}' END ELSE '{}' END,'$.conversations')`;
  const extracted = `json_each(CASE WHEN json_valid(${selected}) THEN CASE WHEN json_type(${selected},'$.conversations')='array' THEN json_extract(${selected},'$.conversations') ELSE '[]' END ELSE '[]' END)`;
  const lookup = `json_each(${selected},'$.conversations')`, oldLookup = `json_each(json_extract(${selected},'$.conversations'))`;
  const privatePublic = sql.includes('FROM service_conversation_private conversation JOIN service_tenant_private private_header');
  const aggregateCoverage = sql.includes("(SELECT COALESCE(MAX(CASE WHEN candidate.type='object' THEN NOT ");
  assert.equal(sql.split(guarded).length - 1, privatePublic ? 3 : 6); assert.equal(sql.split(lookup).length - 1, aggregateCoverage ? 1 : 3);
  if (mode === 'one-guarded') return sql.replace(guarded, extracted);
  if (mode === 'one-lookup') return sql.replace(lookup, oldLookup);
  assert.equal(mode, 'all');
  return sql.replaceAll(guarded, extracted).replaceAll(lookup, oldLookup);
}
function formerPublicHeaderTrigger(sql) {
  // Remove only public clipping, keeping every projection/guard expression.
  if (sql.includes('FROM service_tenant_private public_source')) sql = formerPublicClipTrigger(sql);
  const { start, end, selected } = publicHeaderRelation(sql);
  return (sql.slice(0, start) + sql.slice(end)).replaceAll('public_source.data', selected);
}
function formerPrivateHeaderTrigger(sql) {
  const insert = sql.indexOf('INSERT INTO service_tenant_private (tenant_id,reseller_id,data,valid,source_type)');
  const start = sql.indexOf('SELECT NEW.id,NEW.reseller_id,data,valid,', insert), end = sql.indexOf('ON CONFLICT(tenant_id)', start);
  assert.ok(insert >= 0 && start > insert && end > start);
  const clause = sql.slice(start, end), validity = 'WITH private_validity AS MATERIALIZED (SELECT json_valid(';
  const argumentStart = clause.indexOf(validity) + validity.length, argumentEnd = clause.indexOf(') AS valid),', argumentStart);
  assert.ok(argumentStart >= validity.length && argumentEnd > argumentStart);
  const selected = clause.slice(argumentStart, argumentEnd), where = clause.lastIndexOf(') WHERE ');
  assert.ok(where > argumentEnd); assert.ok(selected.startsWith('CASE WHEN '));
  const condition = clause.slice(where + ') WHERE '.length).trim();
  // This is the original executed private SELECT shared by C25 and C26.
  const previous = `SELECT NEW.id,NEW.reseller_id,CASE WHEN valid THEN json_remove(data,'$.conversations') ELSE data END,valid,
      CASE WHEN valid THEN json_type(data) ELSE NULL END
    FROM (WITH private_source AS MATERIALIZED (SELECT ${selected} AS data,json_valid(${selected}) AS valid)
      SELECT data,valid FROM private_source) WHERE ${condition}\n    `;
  return sql.slice(0, start) + previous + sql.slice(end);
}
function formerHeaderTrigger(sql, revision = 'C25') {
  assert.ok(['C25', 'C26', 'C27', 'C28', 'C29', 'C30', 'C31', 'C32'].includes(revision));
  const coverage = formerCoverageTrigger(sql);
  if (revision === 'C32') return coverage;
  const publicConversations = formerPublicConversationTrigger(coverage);
  if (revision === 'C31') return publicConversations;
  const order = formerHeaderOrderTrigger(publicConversations);
  if (revision === 'C30') return order;
  const cursors = formerCursorTrigger(order);
  if (revision === 'C28' || revision === 'C29') return cursors;
  const window = formerConversationTrigger(cursors);
  if (revision === 'C27') return window;
  const previous = formerPrivateHeaderTrigger(window);
  return revision === 'C25' ? formerPublicHeaderTrigger(previous) : previous;
}
function replaceHeaderTriggers(db, rows) {
  for (const row of rows) { db.exec(`DROP TRIGGER ${row.name}`); db.exec(row.sql); }
}
const projectionSnapshot = db => ({
  tenants: db.prepare('SELECT * FROM tenants ORDER BY id').all(),
  headers: db.prepare('SELECT * FROM service_tenant_read ORDER BY tenant_id').all(),
  conversations: db.prepare('SELECT * FROM service_conversation_read ORDER BY tenant_id,id').all(),
  privateHeaders: db.prepare('SELECT tenant_id,reseller_id,data,valid,source_type FROM service_tenant_private ORDER BY tenant_id').all(),
  privateConversations: db.prepare('SELECT * FROM service_conversation_private ORDER BY tenant_id,id').all(),
  coverage: db.prepare('SELECT * FROM service_conversation_lookup_meta ORDER BY tenant_id').all(),
  lookup: db.prepare('SELECT * FROM service_conversation_lookup ORDER BY tenant_id,id,kind,value').all()
});

test('bootstrap legado cria metadados sem alterar a fonte e não repete o backfill ao abrir de novo', t => {
  const { store, path } = legacy(t), original = JSON.stringify(source());
  assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data, original);
  const metadata = store.serviceTenant('workspace-a', 'tenant-a');
  assert.deepEqual(metadata.conversations.map(value => value.id), ['same-id']);
  assert.equal(metadata.channels[0].enabled, false); assert.equal(metadata.agents[0].configured, true); assert.equal(metadata.departments[0].active, true);
  assert.equal(fingerprint(metadata.agents[0]), fingerprint(source().agents[0]), 'a projeção não muda o fingerprint nem invalida identidades');
  store.close();
  const reopened = new Store(path);
  try { assert.equal(reopened.db.prepare('SELECT total_changes() AS n').get().n, 0); assert.equal(reopened.serviceTenant('workspace-a', 'tenant-a').conversations.length, 1); }
  finally { reopened.close(); }
});

test('bootstrap legado com JSON inválido preserva a fonte para recuperação e não concede metadados antigos', t => {
  const invalid = '{"channels":[', { store } = legacy(t, invalid);
  try {
    assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data, invalid);
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a'), { id: 'tenant-a', resellerId: 'workspace-a', channels: [], agents: [], departments: [], conversations: [] });
    assert.equal(store.serviceTenant('workspace-b', 'tenant-b').conversations[0].contact, 'Outro tenant');
    assert.throws(() => store.tenant({ resellerId: 'workspace-a' }, 'tenant-a'), SyntaxError, 'a fonte canônica continua inválida, sem substituição por uma empresa vazia');
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('corrupt-insert', 'workspace-a', invalid);
    assert.deepEqual(store.serviceTenant('workspace-a', 'corrupt-insert').agents, []);
    assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('corrupt-insert').data, invalid);
  } finally { store.close(); }
});

test('refresh recorta uma vez e reutiliza o header privado antes das três listas públicas, em INSERT e UPDATE', t => {
  const { store } = legacy(t), native = new DatabaseSync(':memory:'), builtinRemove = native.prepare('SELECT json_remove(?,?) AS value');
  const observed = [], clips = [], order = [];
  let recording = false, headers = 0;
  try {
    store.db.function('json_valid', value => {
      if (recording) observed.push(value);
      try { JSON.parse(value); return 1; } catch { return 0; }
    });
    store.db.function('json_remove', (value, path) => {
      if (path === '$.conversations') clips.push(value);
      return builtinRemove.get(value, path).value;
    });
    store.db.function('capacity_private_observed', () => { order.push('private'); return 0; });
    store.db.function('capacity_header_observed', () => { order.push('public'); headers++; recording = false; return 0; });
    store.db.exec(`CREATE TEMP TRIGGER header_probe_insert AFTER INSERT ON main.service_tenant_read WHEN NEW.tenant_id='header-probe'
      BEGIN SELECT capacity_header_observed(); END;
      CREATE TEMP TRIGGER header_probe_update AFTER UPDATE ON main.service_tenant_read WHEN NEW.tenant_id='header-probe'
      BEGIN SELECT capacity_header_observed(); END;
      CREATE TEMP TRIGGER header_probe_private_insert AFTER INSERT ON main.service_tenant_private WHEN NEW.tenant_id='header-probe'
      BEGIN SELECT capacity_private_observed(); END;
      CREATE TEMP TRIGGER header_probe_private_update AFTER UPDATE OF data,valid,source_type,reseller_id ON main.service_tenant_private WHEN NEW.tenant_id='header-probe'
      BEGIN SELECT capacity_private_observed(); END;`);
    const value = source();
    value.conversations[0].messages = Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}`, text: 'history-only-'.repeat(16) }));
    for (const insert of [true, false]) {
      value.channels[0].name = insert ? 'Cabeçalho inicial' : 'Cabeçalho atualizado';
      const raw = JSON.stringify(value); observed.length = 0; clips.length = 0; order.length = 0; headers = 0; recording = true;
      if (insert) store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('header-probe', 'workspace-a', raw);
      else store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(raw, 'header-probe');
      assert.equal(headers, 1); assert.equal(recording, false);
      assert.deepEqual(order, ['private', 'public']);
      assert.deepEqual(clips, [raw], 'o refresh só pode recortar a fonte canônica uma vez');
      assert.equal(observed.length, 4, 'uma validação privada canônica e três validações do header reutilizado');
      assert.equal(observed[0], raw);
      const { conversations, ...expectedHeader } = value;
      const privateHeader = store.db.prepare('SELECT data FROM service_tenant_private WHERE tenant_id=?').get('header-probe').data;
      for (const argument of observed.slice(1)) {
        assert.equal(argument, privateHeader, 'as três listas leem os bytes do header privado já gravado');
        assert.deepEqual(JSON.parse(argument), expectedHeader);
        assert.equal(argument.includes('history-only-'), false);
      }
      assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('header-probe').data, raw);
      assert.equal(store.serviceTenant('workspace-a', 'header-probe', { conversationId: 'same-id', includeMessages: true }).conversations[0].messages.length, conversations[0].messages.length);
    }
  } finally { store.close(); native.close(); }
});

test('tipo privado é calculado sobre o header já recortado, em INSERT e UPDATE', t => {
  const { store } = legacy(t), native = new DatabaseSync(':memory:'), builtinType = native.prepare('SELECT json_type(?) AS value'), observed = [];
  let recording = false, publicRows = 0, privateRows = 0;
  const order = [];
  try {
    // Override only the one-argument overload. Delegate its behavior to real
    // JSON1 on a separate fixture connection; two-argument json_type stays native.
    store.db.function('json_type', value => {
      if (recording) observed.push(value);
      return builtinType.get(value).value;
    });
    store.db.function('private_probe_public', () => { publicRows++; order.push('public'); return 0; });
    store.db.function('private_probe_end', () => { privateRows++; order.push('private'); recording = false; return 0; });
    for (const operation of ['INSERT', 'UPDATE']) store.db.exec(`
      CREATE TEMP TRIGGER private_probe_public_${operation} AFTER ${operation} ON main.service_tenant_read WHEN NEW.tenant_id='private-probe'
        BEGIN SELECT private_probe_public(); END;
      CREATE TEMP TRIGGER private_probe_header_${operation} AFTER ${operation === 'UPDATE' ? 'UPDATE OF data,valid,source_type,reseller_id' : operation} ON main.service_tenant_private WHEN NEW.tenant_id='private-probe'
        BEGIN SELECT private_probe_end(); END;`);
    const value = source({ privateHeader: { unknown: 'preserved' } });
    value.conversations[0].messages = [{ id: 'old-message', text: 'private-history-only-'.repeat(64) }];
    for (const insert of [true, false]) {
      value.privateHeader.unknown = insert ? 'initial' : 'changed'; value.conversations[0].version++;
      // The public AFTER UPDATE probe requires a real public header change;
      // changing only a private field correctly leaves its upsert untouched.
      value.channels[0].name = insert ? 'Private type initial' : 'Private type changed';
      const raw = JSON.stringify(value); observed.length = 0; order.length = 0; publicRows = 0; privateRows = 0; recording = true;
      if (insert) store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('private-probe', 'workspace-a', raw);
      else store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(raw, 'private-probe');
      assert.equal(publicRows, 1); assert.equal(privateRows, 1); assert.equal(recording, false);
      assert.deepEqual(order, ['private', 'public']);
      assert.equal(observed.length, 1, 'o tipo raiz já recortado é calculado antes da primeira linha privada');
      const { conversations, ...expectedHeader } = value;
      assert.deepEqual(JSON.parse(observed[0]), expectedHeader); assert.equal(observed[0].includes('private-history-only-'), false);
      const header = store.db.prepare('SELECT data,valid,source_type FROM service_tenant_private WHERE tenant_id=?').get('private-probe');
      assert.equal(header.data, observed[0]); assert.equal(header.valid, 1); assert.equal(header.source_type, 'object');
      assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('private-probe').data, raw);
      assert.equal(store.serviceTenant('workspace-a', 'private-probe', { conversationId: 'same-id', includeMessages: true }).conversations[0].messages.length, conversations[0].messages.length);
    }
  } finally { store.close(); native.close(); }
});

test('header público usa somente o privado recém-gravado, reparando ausência e escopo antigo na mesma escrita', t => {
  const { store } = legacy(t);
  try {
    const other = store.db.prepare('SELECT * FROM service_tenant_private WHERE tenant_id=?').get('tenant-b');
    const otherSource = store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-b').data;
    const value = source({ privateHeader: { unknown: 'preservado' } });
    store.db.prepare('UPDATE service_tenant_private SET reseller_id=?,data=? WHERE tenant_id=?')
      .run('workspace-b', JSON.stringify(source({ channels: [{ id: 'foreign-header' }] })), 'tenant-a');
    for (const step of ['scope-repair', 'missing-private', 'workspace-move']) {
      if (step === 'missing-private') store.db.prepare('DELETE FROM service_tenant_private WHERE tenant_id=?').run('tenant-a');
      value.channels[0].name = step;
      const workspaceId = step === 'workspace-move' ? 'workspace-b' : 'workspace-a', raw = JSON.stringify(value);
      store.db.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run(workspaceId, raw, 'tenant-a');
      const actual = store.db.prepare('SELECT * FROM service_tenant_private WHERE tenant_id=?').get('tenant-a');
      const { conversations, ...expected } = value;
      assert.equal(actual.reseller_id, workspaceId); assert.deepEqual(JSON.parse(actual.data), expected);
      assert.match(actual.header_token, /^[0-9a-f]{32}$/);
      const metadata = store.serviceTenant(workspaceId, 'tenant-a');
      assert.equal(metadata.channels[0].name, step); assert.equal(metadata.conversations.length, conversations.length);
      assert.equal(JSON.stringify(metadata).includes('foreign-header'), false);
      assert.throws(() => store.serviceTenant(workspaceId === 'workspace-a' ? 'workspace-b' : 'workspace-a', 'tenant-a'), status(404));
      assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data, raw);
      assert.deepEqual(store.db.prepare('SELECT * FROM service_tenant_private WHERE tenant_id=?').get('tenant-b'), other);
      assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-b').data, otherSource);
    }
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
  } finally { store.close(); }
});

test('conversas públicas usam o privado já reconciliado, sem órfãos, versões antigas ou filtro de cobertura', t => {
  const { store } = legacy(t), order = [];
  try {
    const other = store.db.prepare('SELECT * FROM service_conversation_private WHERE tenant_id=?').all('tenant-b');
    store.db.function('conversation_order_observed', kind => { order.push(kind); return 0; });
    for (const operation of ['INSERT', 'UPDATE']) for (const [table, kind] of [['service_conversation_private', 'private'], ['service_conversation_read', 'public']]) {
      store.db.exec(`CREATE TEMP TRIGGER conversation_order_${kind}_${operation} AFTER ${operation} ON main.${table}
        WHEN NEW.tenant_id='tenant-a' AND NEW.id='same-id' BEGIN SELECT conversation_order_observed('${kind}'); END;`);
    }
    for (const step of ['stale', 'missing', 'workspace-move']) {
      store.db.prepare('UPDATE service_conversation_private SET data=? WHERE tenant_id=? AND id=?')
        .run(JSON.stringify({ id: 'same-id', contact: 'foreign-private', version: -1 }), 'tenant-a', 'same-id');
      store.db.prepare('INSERT INTO service_conversation_private VALUES (?,?,?,?)').run('tenant-a', 'orphan-private', 99, 'not-json');
      store.db.prepare('UPDATE service_conversation_read SET data=? WHERE tenant_id=? AND id=?')
        .run(JSON.stringify({ id: 'same-id', contact: 'old-public', version: -2 }), 'tenant-a', 'same-id');
      store.db.prepare('INSERT INTO service_conversation_read VALUES (?,?,?)').run('tenant-a', 'orphan-public', '{}');
      if (step === 'missing') store.db.prepare('DELETE FROM service_conversation_private WHERE tenant_id=? AND id=?').run('tenant-a', 'same-id');
      const first = { ...source().conversations[0], contact: `fresh-${step}`, version: step.length };
      const value = source({ conversations: [first, { ...first, contact: 'duplicate-ignored' }, { ...first, id: 'second', contact: 'Second' }] });
      const workspaceId = step === 'workspace-move' ? 'workspace-b' : 'workspace-a', raw = JSON.stringify(value); order.length = 0;
      store.db.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run(workspaceId, raw, 'tenant-a');
      assert.deepEqual(order, ['private', 'public']);
      const metadata = store.serviceTenant(workspaceId, 'tenant-a');
      assert.deepEqual(metadata.conversations.map(row => [row.id, row.contact, row.version]), [['same-id', first.contact, first.version], ['second', 'Second', first.version]]);
      assert.deepEqual(store.db.prepare('SELECT id,position FROM service_conversation_private WHERE tenant_id=? ORDER BY position').all('tenant-a')
        .map(row => ({ ...row })), [{ id: 'same-id', position: 0 }, { id: 'second', position: 2 }]);
      assert.equal(store.db.prepare('SELECT complete FROM service_conversation_lookup_meta WHERE tenant_id=?').get('tenant-a').complete, 0,
        'IDs duplicados impedem lookup completo, mas não removem o DTO público');
      assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data, raw);
      assert.deepEqual(store.db.prepare('SELECT * FROM service_conversation_private WHERE tenant_id=?').all('tenant-b'), other);
      assert.throws(() => store.serviceTenant(workspaceId === 'workspace-a' ? 'workspace-b' : 'workspace-a', 'tenant-a'), status(404));
    }
  } finally { store.close(); }
});

test('projeções equivalem ao SQL C25/C26/C27/C28-C29/C30/C31/C32 para shapes, duplicatas, posições, inteiros opacos e rollback', t => {
  const { store } = legacy(t), references = ['C25', 'C26', 'C27', 'C28', 'C30', 'C31', 'C32'].map(revision => ({ revision, store: legacy(t).store }));
  try {
    for (const reference of references) replaceHeaderTriggers(reference.store.db,
      headerTriggers(reference.store.db).map(row => ({ ...row, sql: formerHeaderTrigger(row.sql, reference.revision) })));
    const duplicate = JSON.stringify(source({ conversations: [source().conversations[0], { ...source().conversations[0], contact: 'Duplicado ignorado', channelId: 'ignored' }] }));
    const opaque = JSON.stringify(source({ privateHeader: { opaque: 'OPAQUE_INTEGER' } })).replace('"OPAQUE_INTEGER"', '9007199254740993')
      .replace('"messages":[', '"opaque":9223372036854775806,"messages":[');
    const duplicateKeys = '{"channels":[],"channels":' + JSON.stringify(source().channels) + ',"agents":' + JSON.stringify(source().agents)
      + ',"departments":' + JSON.stringify(source().departments) + ',"conversations":' + JSON.stringify(source().conversations) + ',"conversations":[]}';
    const kinds = source({ conversations: [null, false, 'scalar', 7, {},
      ...[1, null, '', '', 'é😀', 'é😀', 'A', 'a', 'nul\0a', 'nul\0a'].map((id, index) => ({ ...source().conversations[0], id, contact: `position-${index + 5}` }))] });
    const escapedIds = JSON.stringify(kinds).replace('"id":"é😀"', '"id":"\\u00e9\\ud83d\\ude00"');
    const conversations = JSON.stringify(source().conversations);
    const rootKeys = [`{"conversations":null,"conversations":${conversations}}`, `{"conversations":${conversations},"conversations":null}`,
      `{"conversa\\u0074ions":${conversations},"conversations":[]}`, `{"conversations":[],"conversa\\u0074ions":${conversations}}`];
    const lexemes = '{ "conversations" : [ {"id":"lexical","id":"later","channelId":"wa","messages":[{"text":"line\\n\\u00e9\\/","opaque":9223372036854775806}],"number":1.2300e+02,"negativeZero":-0} ] }';
    const cases = [JSON.stringify(source()), duplicate, opaque, duplicateKeys, escapedIds, ...rootKeys, lexemes,
      Buffer.from(JSON.stringify(source())), Buffer.from('{invalid-json'), '{}', 'null', 'false', 'true', '7', '1.25', '"scalar"', JSON.stringify('nul\0é😀'), '[]', '[{"channels":[]}]', '{', '',
      ...[null, {}, 'array', 1, false].map(value => JSON.stringify(source({ channels: value, agents: value, departments: value, conversations: value })))];
    for (const raw of cases) {
      const changes = [store, ...references.map(reference => reference.store)].map(item => {
        const before = item.db.prepare('SELECT total_changes() AS n').get().n;
        item.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(raw, 'tenant-a');
        const persisted = item.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data;
        if (typeof raw === 'string') assert.equal(persisted, raw);
        else assert.deepEqual(Buffer.from(persisted), raw);
        return item.db.prepare('SELECT total_changes() AS n').get().n - before;
      });
      for (const reference of references) assert.deepEqual(projectionSnapshot(store.db), projectionSnapshot(reference.store.db), reference.revision);
      assert.ok(changes.every(count => count === changes[0]), 'o recorte não acrescenta escritas de linhas');
      if (raw === opaque) {
        assert.equal(store.db.prepare("SELECT CAST(json_extract(data,'$.privateHeader.opaque') AS TEXT) AS value FROM service_tenant_private WHERE tenant_id='tenant-a'").get().value, '9007199254740993');
        assert.equal(store.db.prepare("SELECT CAST(json_extract(data,'$.opaque') AS TEXT) AS value FROM service_conversation_private WHERE tenant_id='tenant-a'").get().value, '9223372036854775806');
      }
      if (raw === escapedIds) assert.deepEqual(store.db.prepare("SELECT id,position FROM service_conversation_private WHERE tenant_id='tenant-a' ORDER BY position").all().map(row => ({ ...row })),
        [{ id: '', position: 7 }, { id: 'é😀', position: 9 }, { id: 'A', position: 11 }, { id: 'a', position: 12 }, { id: 'nul\0a', position: 13 }]);
    }
    const replicas = [store, ...references.map(reference => reference.store)], raw = JSON.stringify(source());
    const equivalent = () => { for (const reference of references) assert.deepEqual(projectionSnapshot(store.db), projectionSnapshot(reference.store.db), reference.revision); };
    for (const item of replicas) item.db.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run('workspace-b', raw, 'tenant-a');
    equivalent();
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a'), status(404));
    for (const item of replicas) item.db.prepare('DELETE FROM tenants WHERE id=?').run('tenant-a');
    equivalent();
    for (const item of replicas) item.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-a', 'workspace-a', raw);
    equivalent();
    store.db.prepare('DELETE FROM service_conversation_private WHERE tenant_id=?').run('tenant-a');
    store.db.prepare('UPDATE service_conversation_read SET data=? WHERE tenant_id=?').run('{}', 'tenant-a');
    store.serviceReadModel.rebuild();
    equivalent(); // Rebuild/backfill repairs private rows before reusing them publicly.
    const before = projectionSnapshot(store.db);
    store.db.exec('BEGIN IMMEDIATE');
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(source()), 'tenant-a');
    store.db.prepare('DELETE FROM tenants WHERE id=?').run('tenant-b');
    store.db.exec('ROLLBACK');
    assert.deepEqual(projectionSnapshot(store.db), before);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
  } finally { store.close(); for (const reference of references) reference.store.close(); }
});

test('cobertura agregada equivale ao C32 para vazio, primitivas, NULL, IDs nativos e campos opcionais', t => {
  const { store } = legacy(t), reference = legacy(t).store, base = { id: 'one', channelId: 'wa', messages: [] };
  try {
    replaceHeaderTriggers(reference.db, headerTriggers(reference.db).map(row => ({ ...row, sql: formerHeaderTrigger(row.sql, 'C32') })));
    const cases = [[[], 1], [[base], 1], [[base, { ...base, id: 'two' }], 1], [[base, { ...base }], 0],
      [[{ ...base, id: '' }], 0], [[{ ...base, id: null }], 0], [[{ ...base, id: 1 }], 0], [[{ ...base, id: true }], 0],
      [[{ ...base, id: '1' }, { ...base, id: '01' }], 1], [[{ ...base, id: 'A' }, { ...base, id: 'a' }], 1],
      [[{ ...base, id: '\0one' }], 0], [[{ ...base, id: 'one\0' }], 1],
      [[{ ...base, remoteJid: null }], 1], [[{ ...base, remoteJid: 7 }], 0],
      [[{ ...base, remoteAliases: null }], 1], [[{ ...base, remoteAliases: ['alias'] }], 1], [[{ ...base, remoteAliases: [null] }], 0],
      [[{ ...base, messages: null }], 0], [[{ ...base, messages: [{}] }], 1],
      [[{ ...base, messages: [{ externalId: null }] }], 1], [[{ ...base, messages: [{ externalId: 7 }] }], 0],
      ...[null, false, true, 7, 'not-json', [], {}].map(value => [[base, value], 0]),
      ...[null, {}, 'not-array', 7].map(value => [value, 0])];
    for (const [conversations, expected] of cases) {
      const raw = JSON.stringify(source({ conversations }));
      for (const item of [store, reference]) {
        item.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(raw, 'tenant-a');
        assert.equal(item.db.prepare('SELECT complete FROM service_conversation_lookup_meta WHERE tenant_id=?').get('tenant-a').complete, expected, raw);
      }
      assert.deepEqual(projectionSnapshot(store.db), projectionSnapshot(reference.db));
    }
    const escaped = JSON.stringify(source({ conversations: [{ ...base, id: 'é' }, { ...base, id: 'é' }] })).replace('"id":"é"', '"id":"\\u00e9"');
    for (const item of [store, reference]) {
      item.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(escaped, 'tenant-a');
      assert.equal(item.db.prepare('SELECT complete FROM service_conversation_lookup_meta WHERE tenant_id=?').get('tenant-a').complete, 0);
    }
    assert.deepEqual(projectionSnapshot(store.db), projectionSnapshot(reference.db));
  } finally { store.close(); reference.close(); }
});

test('trigger real faz duas varreduras privadas de ID/posição e deriva o público sem outro cursor canônico', t => {
  const { store } = legacy(t), native = new DatabaseSync(':memory:'), builtinType = native.prepare('SELECT json_type(?,?) AS value');
  const builtinExtract = native.prepare('SELECT json_extract(?,?) AS value'); builtinExtract.setReadBigInts(true);
  const insertSql = 'INSERT INTO tenants VALUES (?,?,?)';
  try {
    store.db.exec('PRAGMA automatic_index=OFF');
    assert.equal(store.db.prepare('PRAGMA automatic_index').get().automatic_index, 0);
    const definition = headerTriggers(store.db)[0].sql;
    assert.doesNotMatch(definition, /row_number\s*\(/i);
    const bytecode = store.db.prepare('EXPLAIN ' + insertSql).all('scan-probe', 'workspace-a', JSON.stringify(source()));
    const programs = [];
    for (const row of bytecode) {
      if (row.addr === 0) programs.push([]);
      programs.at(-1).push(row);
    }
    const trigger = programs.find(program => program.some(row => row.opcode === 'Init' && String(row.p4).includes('TRIGGER service_read_insert_v1')));
    assert.ok(trigger, 'o plano deve vir do subprograma real do trigger');
    assert.equal(trigger.some(row => /row_number/i.test(String(row.p4))), false);
    const rhs = trigger.filter(row => row.opcode === 'Once').map(once => trigger.filter(row => row.addr > once.addr && row.addr < once.p2))
      .filter(block => block.some(row => /^AggStep/.test(row.opcode) && /^min\(/i.test(String(row.p4))) && block.some(row => row.opcode === 'IdxInsert'));
    assert.equal(rhs.length, 1, 'somente a projeção privada constrói as primeiras posições');
    for (const block of rhs) {
      assert.equal(block.filter(row => row.opcode === 'VFilter').length, 1, 'cada RHS abre um único cursor da array');
      assert.ok(block.some(row => row.opcode === 'OpenEphemeral' && row.p2 === 1), 'IN mantém somente uma posição por chave');
      const sorts = block.filter(row => row.opcode === 'SorterInsert');
      assert.equal(sorts.length, 1, 'um sorter de ID/posição em cada RHS de conversas');
      const sort = sorts[0], record = block.findLast(row => row.addr < sort.addr && row.opcode === 'MakeRecord' && row.p3 === sort.p2);
      assert.ok(record); assert.equal(record.p2, 2, 'o sorter recebe somente ID e posição, sem histórico');
    }
    const lookupStart = trigger.findIndex(row => row.opcode === 'Trace' && String(row.p4).includes('INSERT INTO service_conversation_lookup_meta'));
    const lookupEnd = trigger.findIndex((row, index) => index > lookupStart && row.opcode === 'Trace');
    assert.ok(lookupStart >= 0 && lookupEnd > lookupStart);
    const lookup = trigger.slice(lookupStart + 1, lookupEnd), steps = lookup.filter(row => /^AggStep/.test(row.opcode));
    assert.equal(steps.length, 3, 'MAX, COUNT(*) e COUNT(DISTINCT id) pertencem à mesma agregação');
    assert.deepEqual(steps.map(row => String(row.p4).toLowerCase()).sort(), ['count(0)', 'count(1)', 'max(1)']);
    const aggregateLoops = lookup.filter(row => row.opcode === 'VFilter').map(filter => {
      const next = lookup.findLast(row => row.opcode === 'VNext' && row.p1 === filter.p1 && row.addr > filter.addr && row.addr < filter.p2);
      return { filter, body: next ? lookup.filter(row => row.addr > filter.addr && row.addr < next.addr) : [] };
    }).filter(loop => steps.every(step => loop.body.includes(step)));
    assert.equal(aggregateLoops.length, 1, 'os três acumuladores executam no mesmo cursor canônico; aliases/mensagens têm subcursores próprios');
    const { selected } = privateHeaderSource(definition), cursor = `json_each(${selected},'$.conversations')`;
    const statementStart = definition.indexOf('INSERT INTO service_conversation_lookup_meta'), statementEnd = definition.indexOf(';', statementStart);
    assert.equal(definition.slice(statementStart, statementEnd).split(cursor).length - 1, 1);
    let idChecks = 0, wholeArrayExtractions = 0;
    const normalizedChecks = [];
    store.db.function('json_type', { deterministic: true }, (value, path) => {
      if (path === '$.id') idChecks++;
      return builtinType.get(value, path).value;
    });
    store.db.function('json_extract', { deterministic: true }, (value, path) => {
      if (path === '$.conversations') wholeArrayExtractions++;
      return builtinExtract.get(value, path).value;
    });
    for (const count of [16, 64, 256]) {
      const value = source();
      value.conversations = Array.from({ length: count }, (_, index) => ({ ...value.conversations[0], id: `scan-${index}`,
        messages: Array.from({ length: 20 }, (_, message) => ({ id: `old-${message}`, text: 'x'.repeat(192) })) }));
      idChecks = 0; wholeArrayExtractions = 0;
      if (count === 16) store.db.prepare(insertSql).run('scan-probe', 'workspace-a', JSON.stringify(value));
      else store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), 'scan-probe');
      // 2N: private projection cursors; N: private missing-ID cleanup; N: lookup coverage.
      assert.equal(idChecks, 4 * count, 'o público não reabre os três cursores canônicos já consumidos pelo privado');
      assert.equal(wholeArrayExtractions, 0, 'os quatro cursores canônicos não podem renderizar a array inteira como texto intermediário');
      normalizedChecks.push(idChecks / count);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_private WHERE tenant_id=?').get('scan-probe').n, count);
    }
    assert.deepEqual(normalizedChecks, [4, 4, 4]);
  } finally { store.close(); native.close(); }
});

test('guard seletivo ativo mantém cabeçalhos e não valida conversas canônicas inteiras', t => {
  const { store } = legacy(t), validated = [];
  try {
    const before = readSource(store), other = store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-b').data;
    const header = store.db.prepare('SELECT * FROM service_tenant_private WHERE tenant_id=?').get('tenant-a');
    const changed = structuredClone(before.conversations[0]); changed.version++;
    changed.messages.push({ id: 'scoped-new', kind: 'agent', text: 'Synthetic scoped reply.' });
    store.db.function('json_valid', value => {
      const parsed = JSON.parse(value); validated.push(parsed); return 1;
    });
    store.serviceReadModel.withConversationWrite({ tenantId: 'tenant-a', workspaceId: 'workspace-a', position: 0,
      conversationId: changed.id, data: JSON.stringify(changed), strict: true }, ({ expectedSql }) => {
      assert.equal(store.db.prepare(`UPDATE tenants SET data=${expectedSql} WHERE id=? AND reseller_id=?`).run('tenant-a', 'workspace-a').changes, 1);
    });
    assert.ok(validated.length > 0);
    assert.equal(validated.some(value => value && typeof value === 'object' && Object.hasOwn(value, 'conversations')), false,
      'cada cursor continua protegido pelo CASE selected, inclusive quando o hint evita o refresh completo');
    const expected = structuredClone(before); expected.conversations[0] = changed;
    assert.deepEqual(readSource(store), expected);
    assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-b').data, other);
    assert.deepEqual(store.db.prepare('SELECT * FROM service_tenant_private WHERE tenant_id=?').get('tenant-a'), header);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
  } finally { store.close(); }
});

test('routing 9 C25/C26/C27/C28-C29/C30/C31/C32 renova somente os dois triggers conhecidos sem backfill ou rotação de tokens', t => {
  for (const revision of ['C25', 'C26', 'C27', 'C28', 'C30', 'C31', 'C32']) {
    const { store, path } = legacy(t), current = headerTriggers(store.db);
    if (revision === 'C28') assert.deepEqual(current.map(row => formerHeaderTrigger(row.sql, 'C28')), current.map(row => formerHeaderTrigger(row.sql, 'C29')));
    replaceHeaderTriggers(store.db, current.map(row => ({ ...row, sql: formerHeaderTrigger(row.sql, revision) })));
    const before = projectionSnapshot(store.db), headers = store.db.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all();
    const otherTriggers = db => db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name NOT IN ('service_read_insert_v1','service_read_update_v1') ORDER BY name").all();
    const unchanged = otherTriggers(store.db); store.close();
    for (let reopen = 0; reopen < 2; reopen++) {
      const upgraded = new Store(path);
      try {
        assert.equal(upgraded.db.prepare('SELECT total_changes() AS n').get().n, 0);
        assert.equal(upgraded.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
        assert.deepEqual(headerTriggers(upgraded.db), current);
        assert.deepEqual(otherTriggers(upgraded.db), unchanged);
        assert.deepEqual(projectionSnapshot(upgraded.db), before);
        assert.deepEqual(upgraded.db.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all(), headers);
      } finally { upgraded.close(); }
    }
    const raw = new DatabaseSync(path);
    try {
      raw.prepare('INSERT INTO tenants VALUES (?,?,?)').run('raw-insert', 'workspace-a', JSON.stringify(source()));
      const value = source(); value.channels[0].name = 'Escritor legado';
      raw.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), 'raw-insert');
      assert.equal(JSON.parse(raw.prepare('SELECT data FROM service_tenant_read WHERE tenant_id=?').get('raw-insert').data).channels[0].name, 'Escritor legado');
    } finally { raw.close(); }
  }
});

test('trigger desconhecido ou híbrido recusa abertura e preserva fonte, definições e tokens', t => {
  for (const name of headerTriggerNames) for (const variant of ['other', 'old-public', 'old-private', 'mixed-query', 'mixed-cursor', 'mixed-lookup', 'old-order-only', 'public-clip-only', 'canonical-public-only', 'conversation-order-only', 'mixed-coverage-cursor', 'mixed-coverage-public']) {
    const { store, path } = legacy(t), current = headerTriggers(store.db);
    replaceHeaderTriggers(store.db, headerTriggers(store.db).map(row => ({ ...row, sql: formerHeaderTrigger(row.sql) })));
    const definition = current.find(row => row.name === name).sql, clause = conversationClause(definition);
    const oldClause = conversationClause(formerCursorTrigger(definition));
    const unknown = variant === 'old-public' ? formerPublicHeaderTrigger(definition)
      : variant === 'old-private' ? formerPrivateHeaderTrigger(definition)
        : variant === 'mixed-query' ? definition.replace(clause, formerConversationClause(oldClause))
          : variant === 'mixed-cursor' ? formerCursorTrigger(definition, 'one-guarded')
            : variant === 'mixed-lookup' ? formerCursorTrigger(definition, 'one-lookup')
              : variant === 'old-order-only' ? formerHeaderOrderTrigger(formerPublicConversationTrigger(definition), false)
                : variant === 'public-clip-only' ? formerPublicClipTrigger(definition)
                  : variant === 'canonical-public-only' ? formerPublicConversationTrigger(definition, { reorder: false })
                    : variant === 'conversation-order-only' ? formerPublicConversationTrigger(definition, { canonical: false })
                      : variant === 'mixed-coverage-cursor' ? formerCursorTrigger(formerCoverageTrigger(definition), 'one-lookup')
                        : variant === 'mixed-coverage-public' ? formerPublicConversationTrigger(formerCoverageTrigger(definition), { reorder: false })
                          : `CREATE TRIGGER ${name} AFTER UPDATE ON tenants BEGIN SELECT 42; END;`;
    store.db.exec(`DROP TRIGGER ${name}`); store.db.exec(unknown);
    const before = projectionSnapshot(store.db), headers = store.db.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all();
    const schema = store.db.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all(); store.close();
    assert.throws(() => new Store(path), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_SCHEMA');
    const raw = new DatabaseSync(path);
    try {
      assert.deepEqual(projectionSnapshot(raw), before);
      assert.deepEqual(raw.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all(), headers);
      assert.deepEqual(raw.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all(), schema);
      raw.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    } finally { raw.close(); }
  }
});

test('migração da projeção v1/v2/v3/v4/v5/v6/v7 renova triggers, limpa metadados de fonte inválida e não repete trabalho ao reabrir', t => {
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const { store, path } = legacy(t);
    store.db.exec('DROP TRIGGER service_read_update_v1');
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', 'tenant-a');
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a').agents.length, 1, 'simula a projeção antiga antes de migrar');
    store.db.exec('CREATE TRIGGER service_read_update_v1 AFTER UPDATE OF data ON tenants BEGIN SELECT json(NEW.data); END;');
    store.db.prepare("UPDATE service_read_model_meta SET version=? WHERE id='routing'").run(version);
    store.close();
    const upgraded = new Store(path);
    try {
      assert.equal(upgraded.db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
      assert.deepEqual(upgraded.serviceTenant('workspace-a', 'tenant-a').agents, []);
      assert.deepEqual(upgraded.serviceTenant('workspace-a', 'tenant-a').conversations, []);
      assert.equal(upgraded.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data, '{');
      update(upgraded, source());
      upgraded.db.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', 'tenant-a');
      assert.deepEqual(upgraded.serviceTenant('workspace-a', 'tenant-a').agents, []);
      assert.equal(upgraded.serviceTenant('workspace-b', 'tenant-b').conversations[0].contact, 'Outro tenant');
    } finally { upgraded.close(); }
    const reopened = new Store(path);
    try { assert.equal(reopened.db.prepare('SELECT total_changes() AS n').get().n, 0); }
    finally { reopened.close(); }
  }
});

test('campos de listas que não são arrays esvaziam a projeção sem alterar a fonte', t => {
  const { store } = legacy(t);
  try {
    for (const invalidArray of [null, {}, 'array', 1, false]) {
      const value = source({ channels: invalidArray, agents: invalidArray, departments: invalidArray, conversations: invalidArray });
      update(store, value);
      assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a'), { id: 'tenant-a', resellerId: 'workspace-a', channels: [], agents: [], departments: [], conversations: [] });
      assert.deepEqual(readSource(store), value);
    }
  } finally { store.close(); }
});

test('validação do documento inteiro tem custo constante por UPDATE para 10, 200 e 1000 conversas', t => {
  const { store } = legacy(t);
  try {
    let validations = 0;
    // Fixture-only instrumentation. Legacy/raw connections continue to use SQLite's built-in JSON1.
    store.db.function('json_valid', value => { validations++; JSON.parse(value); return 1; });
    const calls = [];
    for (const count of [10, 200, 1000]) {
      const value = source();
      value.conversations = Array.from({ length: count }, (_, index) => ({ ...value.conversations[0], id: `conversation-${index}` }));
      validations = 0; update(store, value); calls.push(validations);
      assert.equal(store.serviceTenant('workspace-a', 'tenant-a').conversations.length, count);
    }
    // The private projection keeps both guarded cursors; public metadata reuses
    // the reconciled rows. Keep the previous ceiling without weakening guards.
    assert.ok(calls.every(count => count > 0 && count <= 12), JSON.stringify(calls));
    assert.deepEqual(calls, Array(3).fill(calls[0]), 'validar o JSON canônico não pode crescer com o número de conversas');
  } finally { store.close(); }
});

test('header e conversas indexadas excluem mensagens e campos secretos; histórico exige uma conversa explícita', t => {
  const { store } = legacy(t);
  try {
    const metadata = store.serviceTenant('workspace-a', 'tenant-a'), header = store.serviceTenant('workspace-a', 'tenant-a', { conversationId: null });
    const serialized = JSON.stringify(metadata);
    for (const excluded of [secret, 'private-message-must-not-enter-routing-index', 'messages', 'contactSecret', 'instructions', 'memory', 'credentials']) assert.equal(serialized.includes(excluded), false, excluded);
    assert.equal(header.conversations.length, 0);
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a', { conversationId: 'missing' }).conversations.length, 0);
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a', { includeMessages: true }), status(400));
    const history = store.serviceTenant('workspace-a', 'tenant-a', { conversationId: 'same-id', includeMessages: true });
    assert.equal(history.conversations[0].messages[0].text, source().conversations[0].messages[0].text);
    assert.equal(history.conversations[0].contactSecret, secret, 'a leitura interna explícita preserva a conversa integral; a API redige seu DTO');
    assert.deepEqual(history.conversations[0], source().conversations[0]);
    const persisted = JSON.stringify(store.db.prepare('SELECT data FROM service_conversation_read').all());
    assert.equal(persisted.includes('private-message'), false); assert.equal(persisted.includes(secret), false);
  } finally { store.close(); }
});

test('SQL direto em uma conexão legada atualiza projeções e mantém isolamento por tenant/workspace', t => {
  const { store, path } = legacy(t);
  try {
    const raw = new DatabaseSync(path), value = source(); value.conversations[0].status = 'closed'; value.agents[0].version = 2;
    try { raw.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), 'tenant-a'); }
    finally { raw.close(); }
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a', { conversationId: 'same-id' }).conversations[0].status, 'closed');
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a', { conversationId: null }).agents[0].version, 2);
    assert.throws(() => store.serviceTenant('workspace-b', 'tenant-a'), status(404));
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-b', { conversationId: 'same-id', includeMessages: true }), status(404));
    assert.equal(store.serviceTenant('workspace-b', 'tenant-b').conversations[0].status, 'open');
    store.db.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run('workspace-b', 'tenant-a');
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a'), status(404));
    assert.equal(store.serviceTenant('workspace-b', 'tenant-a').conversations[0].status, 'closed');
  } finally { store.close(); }
});

test('lote de até 50 IDs usa o índice composto, preserva ordem e escopo sem ler histórico', t => {
  const { store } = legacy(t);
  try {
    const value = source();
    value.conversations = Array.from({ length: 51 }, (_, index) => ({ ...value.conversations[0], id: `id-${String(index).padStart(2, '0')}` }));
    update(store, value);
    const ids = value.conversations.slice(0, 50).map(conversation => conversation.id).reverse();
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT data FROM service_conversation_read WHERE tenant_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id').all('tenant-a', JSON.stringify(ids));
    assert.ok(plan.some(row => /SEARCH service_conversation_read USING INDEX .+\(tenant_id=\? AND id=\?\)/.test(row.detail)), JSON.stringify(plan));
    store.serviceReadModel.all.all = () => { throw new Error('O lote não pode ler todas as conversas'); };
    store.serviceReadModel.one.get = () => { throw new Error('O lote não pode ler uma conversa por vez'); };
    store.serviceReadModel.source.get = () => { throw new Error('O lote não pode ler histórico'); };
    const snapshot = store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: ids });
    assert.deepEqual(snapshot.conversations.map(conversation => conversation.id), [...ids].sort());
    assert.equal(snapshot.conversations.length, 50);
    for (const excluded of [secret, 'messages', 'private-message', 'contactSecret']) assert.equal(JSON.stringify(snapshot).includes(excluded), false, excluded);
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: [] }).conversations, []);
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: ['same-id', 'id-00'] }).conversations.map(conversation => conversation.id), ['id-00']);
    assert.equal(store.serviceTenant('workspace-b', 'tenant-b', { conversationIds: ['same-id'] }).conversations[0].contact, 'Outro tenant');
    assert.throws(() => store.serviceTenant('workspace-b', 'tenant-a', { conversationIds: ['id-00'] }), status(404));
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-b', { conversationIds: ['same-id'] }), status(404));
  } finally { store.close(); }
});

test('lote rejeita IDs inválidos, repetidos, acima do limite e opções de leitura conflitantes', t => {
  const { store } = legacy(t);
  try {
    const invalid = [null, undefined, 'same-id', [1], ['same-id', 'same-id'], Array(1), Array.from({ length: 51 }, (_, index) => `id-${index}`)];
    for (const conversationIds of invalid) assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a', { conversationIds }), status(400));
    for (const option of [{ conversationId: null }, { conversationId: undefined }, { conversationId: 'same-id' }, { includeMessages: true }, { includeMessages: false }, { includeMessages: undefined }]) {
      assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: ['same-id'], ...option }), status(400));
    }
  } finally { store.close(); }
});

test('rollback desfaz fonte e projeção juntos; JSON inválido preservado invalida os metadados antigos', t => {
  const { store } = legacy(t);
  try {
    const before = store.serviceTenant('workspace-a', 'tenant-a'), value = readSource(store); value.conversations[0].channelId = 'other';
    store.db.exec('BEGIN IMMEDIATE'); update(store, value);
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a').conversations[0].channelId, 'other');
    store.db.exec('ROLLBACK');
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a'), before);
    assert.equal(readSource(store).conversations[0].channelId, 'wa');
    const otherTenant = store.serviceTenant('workspace-b', 'tenant-b');
    store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run('{', 'tenant-a');
    assert.equal(store.db.prepare('SELECT data FROM tenants WHERE id=?').get('tenant-a').data, '{');
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a'), { id: 'tenant-a', resellerId: 'workspace-a', channels: [], agents: [], departments: [], conversations: [] });
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: ['same-id'] }).conversations, []);
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a', { conversationId: 'same-id', includeMessages: true }).conversations, []);
    assert.deepEqual(store.serviceTenant('workspace-b', 'tenant-b'), otherTenant);
    update(store, source());
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a'), before, 'recuperar a fonte válida também reconstrói os metadados');
  } finally { store.close(); }
});

test('alterar somente mensagens preserva metadados públicos; a história privada atualiza só a conversa alterada', t => {
  const { store } = legacy(t);
  try {
    let value = readSource(store), changes = store.db.prepare('SELECT total_changes() AS n').get().n;
    value.conversations[0].messages.push({ id: 'new-message', kind: 'customer', text: 'Mensagem adicional sintética' }); update(store, value);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n - changes, 2, 'JSON canônico + história privada selecionada, sem reescrever os metadados públicos');
    changes = store.db.prepare('SELECT total_changes() AS n').get().n;
    value.conversations[0].version++; update(store, value);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n - changes, 3, 'fonte + uma linha de conversa pública + sua história privada');
    value.conversations.push({ ...value.conversations[0], id: 'second', messages: [] }); update(store, value);
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a').conversations.length, 2);
    value.conversations = value.conversations.filter(conversation => conversation.id !== 'same-id'); update(store, value);
    assert.deepEqual(store.serviceTenant('workspace-a', 'tenant-a').conversations.map(conversation => conversation.id), ['second']);
  } finally { store.close(); }
});

test('INSERT/DELETE SQL direto e IDs duplicados mantêm a mesma primeira conversa da fonte', t => {
  const { store } = legacy(t);
  try {
    const value = source(); value.conversations.push({ ...value.conversations[0], channelId: 'other', status: 'closed' });
    store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-new', 'workspace-a', JSON.stringify(value));
    assert.equal(store.serviceTenant('workspace-a', 'tenant-new').conversations[0].channelId, 'wa');
    store.db.prepare('DELETE FROM tenants WHERE id=?').run('tenant-new');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_read WHERE tenant_id=?').get('tenant-new').n, 0);
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-new'), status(404));
  } finally { store.close(); }
});

test('rebuild recompõe a conversa ausente e renova tokens de todos os headers preservando os demais dados', t => {
  const { store } = legacy(t);
  try {
    const snapshot = () => ({
      source: store.db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all(),
      publicHeaders: store.db.prepare('SELECT * FROM service_tenant_read ORDER BY tenant_id').all(),
      publicConversations: store.db.prepare('SELECT * FROM service_conversation_read ORDER BY tenant_id,id').all(),
      privateConversations: store.db.prepare('SELECT * FROM service_conversation_private ORDER BY tenant_id,id').all(),
      lookup: store.db.prepare('SELECT * FROM service_conversation_lookup ORDER BY tenant_id,id,kind,value').all(),
      coverage: store.db.prepare('SELECT * FROM service_conversation_lookup_meta ORDER BY tenant_id').all(),
      meta: store.db.prepare('SELECT * FROM service_read_model_meta ORDER BY id').all()
    });
    const before = snapshot(), headersBefore = store.db.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all();
    assert.equal(store.db.prepare('DELETE FROM service_conversation_read WHERE tenant_id=?').run('tenant-a').changes, 1, 'a fixture remove exatamente uma conversa derivada');
    const changed = store.db.prepare('SELECT total_changes() AS n').get().n;
    store.serviceReadModel.rebuild();
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n - changed, 1 + headersBefore.length, 'uma conversa reconstituída e uma rotação anti-ABA por header, sem escritas adicionais');
    const headersAfter = store.db.prepare('SELECT * FROM service_tenant_private ORDER BY tenant_id').all();
    const withoutToken = rows => rows.map(({ header_token, ...row }) => row);
    assert.deepEqual(withoutToken(headersAfter), withoutToken(headersBefore), 'nenhuma outra coluna privada do header muda');
    for (const [index, row] of headersAfter.entries()) {
      assert.match(headersBefore[index].header_token, /^[a-f0-9]{32}$/); assert.match(row.header_token, /^[a-f0-9]{32}$/);
      assert.notEqual(row.header_token, headersBefore[index].header_token, `token renovado para ${row.tenant_id}`);
    }
    assert.deepEqual(snapshot(), before, 'fonte, metadados públicos, histórias privadas, lookup e versão permanecem iguais');
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a').conversations.length, 1);
  } finally { store.close(); }
});

test('snapshot de leitura não mistura header antigo com conversa/histórico de outro workspace após commit WAL', t => {
  for (const includeMessages of [false, true]) {
    const { store, path } = legacy(t), raw = new DatabaseSync(path), get = store.serviceReadModel.header.get.bind(store.serviceReadModel.header);
    try {
      let injected = false;
      store.serviceReadModel.header.get = (...args) => {
        const header = get(...args);
        if (!injected) {
          injected = true; const value = source(); value.conversations[0].contact = 'Novo workspace'; value.conversations[0].messages[0].text = 'Novo histórico privado';
          raw.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run('workspace-b', JSON.stringify(value), 'tenant-a');
        }
        return header;
      };
      const snapshot = store.serviceTenant('workspace-a', 'tenant-a', { conversationId: 'same-id', includeMessages });
      assert.equal(snapshot.conversations[0].contact, 'Contato sintético');
      if (includeMessages) assert.equal(snapshot.conversations[0].messages[0].text, source().conversations[0].messages[0].text);
      store.serviceReadModel.header.get = get;
      assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a'), status(404));
      assert.equal(store.serviceTenant('workspace-b', 'tenant-a').conversations[0].contact, 'Novo workspace');
    } finally { raw.close(); store.close(); }
  }
});

test('savepoint de leitura suporta transação externa e desfaz somente sua própria falha', t => {
  const { store } = legacy(t), get = store.serviceReadModel.header.get.bind(store.serviceReadModel.header);
  try {
    store.db.exec('BEGIN IMMEDIATE');
    const value = readSource(store); value.conversations[0].version = 2; update(store, value);
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a').conversations[0].version, 2);
    store.serviceReadModel.header.get = () => { throw new Error('Falha sintética dentro da leitura'); };
    assert.throws(() => store.serviceTenant('workspace-a', 'tenant-a'), /Falha sintética/);
    store.serviceReadModel.header.get = get;
    value.conversations[0].version = 3; update(store, value); store.db.exec('COMMIT');
    assert.equal(store.serviceTenant('workspace-a', 'tenant-a').conversations[0].version, 3);
  } finally { store.close(); }
});

test('lote e header usam um snapshot WAL: mover P para A e tornar A humano nunca combina autorizações de estados distintos', t => {
  const { store, path } = legacy(t), raw = new DatabaseSync(path), get = store.serviceReadModel.header.get.bind(store.serviceReadModel.header);
  try {
    const before = source(); before.channels[0].enabled = true; before.conversations[0].channelId = 'P';
    before.channels.push({ id: 'P', kind: 'whatsapp_qr', transport: 'baileys' }); update(store, before);
    const after = structuredClone(before); after.conversations[0].channelId = 'wa'; after.channels[0].kind = 'telegram_user'; after.channels[0].transport = 'telegram-user';
    const allowed = tenant => tenant.conversations.length === 1 && tenant.conversations[0].channelId === 'wa' && !isTelegramAccountChannel(tenant.channels.find(channel => channel.id === tenant.conversations[0].channelId));
    let injected = false;
    store.serviceReadModel.header.get = (...args) => {
      const header = get(...args);
      if (!injected) { injected = true; raw.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(after), 'tenant-a'); }
      return header;
    };
    const oldSnapshot = store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: ['same-id'] });
    assert.equal(oldSnapshot.channels[0].kind, 'whatsapp_qr'); assert.equal(oldSnapshot.conversations[0].channelId, 'P');
    assert.equal(allowed(oldSnapshot), false, 'o estado antigo nega a conversa fora do canal concedido');
    store.serviceReadModel.header.get = get;
    const newSnapshot = store.serviceTenant('workspace-a', 'tenant-a', { conversationIds: ['same-id'] });
    assert.equal(newSnapshot.channels[0].kind, 'telegram_user'); assert.equal(newSnapshot.conversations[0].channelId, 'wa');
    assert.equal(allowed(newSnapshot), false, 'o estado novo nega IA no canal humano');
    assert.equal(allowed({ ...oldSnapshot, conversations: newSnapshot.conversations }), true, 'misturar as leituras antes do fix admitiria um estado que nunca existiu');
  } finally { raw.close(); store.close(); }
});
