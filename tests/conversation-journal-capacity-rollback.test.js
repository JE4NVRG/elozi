import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, lstatSync, fstatSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync, existsSync,
  openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const PROFILE = 'journal-rollback-capacity', BASE = '/app/capacity-data';
const MARKER = '.elozi-capacity-owner.json', PREFIX = 'ELOZI_CAPACITY_CLI_METRICS:';
const enabled = process.env.MEPCHAT_JOURNAL_ROLLBACK_CAPACITY === '1';
const self = fileURLToPath(import.meta.url), cli = fileURLToPath(new URL('../src/conversation-journal-rollback.js', import.meta.url));
const labels = ['fp', 'fc'], contexts = 10000, originalMessages = 200000, messagesPerContext = 20;
const deadline = { fixture: 300000, inspect: 180000, cli: 600000 }, clock = () => performance.now();
const rounded = value => Math.round(value * 1000) / 1000;
const frame = (hash, value) => { const text = String(value); hash.update(String(Buffer.byteLength(text)) + ':'); hash.update(text); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const databasePath = dirty => join(BASE, 'capacity-' + dirty + '.sqlite');
const tenantId = label => 'capacity-' + label + '-tenant';
const workspaceId = label => 'capacity-' + label + '-workspace';
const conversationId = (label, index) => label + '-conversation-' + String(index).padStart(5, '0');
const seedStages = ['bootstrap', 'write-fp', 'insert-fp', 'write-fc', 'insert-fc', 'verify'];
const seedProgressPath = dirty => join(BASE, 'capacity-seed-progress-' + dirty + '.json');
const seedProjectionTables = ['service_tenant_private', 'service_tenant_read', 'service_conversation_private',
  'service_conversation_read', 'service_conversation_lookup_meta', 'service_conversation_lookup'];

function context() {
  assert.equal(process.platform, 'linux', 'This opt-in qualification requires Linux.');
  assert.equal(enabled, true); assert.equal(process.env.MEPCHAT_JOURNAL_ROLLBACK_CAPACITY_PATH, BASE);
  const sourceRevision = process.env.MEPCHAT_SOURCE_REVISION, image = process.env.MEPCHAT_JOURNAL_ROLLBACK_CAPACITY_IMAGE;
  assert.match(sourceRevision || '', /^[a-f0-9]{40}$/); assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
  const stat = lstatSync(BASE); assert.ok(stat.isDirectory()); assert.equal(stat.isSymbolicLink(), false); assert.equal(realpathSync(BASE), BASE);
  const markerPath = join(BASE, MARKER), markerStat = lstatSync(markerPath);
  assert.ok(markerStat.isFile()); assert.equal(markerStat.isSymbolicLink(), false); assert.equal(markerStat.nlink, 1);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['schemaVersion', 'owner', 'profile', 'source', 'image', 'nonce'].sort());
  assert.equal(marker.schemaVersion, 1); assert.equal(marker.owner, 'elozi-release'); assert.equal(marker.profile, PROFILE);
  assert.equal(marker.source, sourceRevision); assert.equal(marker.image, image); assert.match(marker.nonce || '', /^[a-f0-9]{32}$/);
  for (const name of readdirSync(BASE)) {
    assert.ok(name === MARKER || /^capacity-[A-Za-z0-9._-]+$/.test(name));
    const entry = lstatSync(join(BASE, name)); assert.ok(entry.isFile()); assert.equal(entry.isSymbolicLink(), false); assert.equal(entry.nlink, 1);
  }
  const mount = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => line.split(' ')).find(fields => fields[4] === BASE);
  assert.ok(mount, 'The fixture directory must be its own disk bind, not container tmpfs.');
  assert.ok(mount[5].split(',').includes('rw'));
  assert.ok(!['tmpfs', 'ramfs'].includes(mount[mount.indexOf('-') + 1]));
  return { sourceRevision, image, nonce: marker.nonce };
}

function cgroup() {
  const root = '/sys/fs/cgroup/', number = name => Number(readFileSync(root + name, 'utf8').trim());
  const [quota, period] = readFileSync(root + 'cpu.max', 'utf8').trim().split(/\s+/).map(Number);
  const events = Object.fromEntries(readFileSync(root + 'memory.events', 'utf8').trim().split('\n').map(line => {
    const [name, value] = line.split(/\s+/); return [name, Number(value)];
  }));
  const result = { memoryMax: number('memory.max'), memorySwapMax: number('memory.swap.max'), pidsMax: number('pids.max'),
    cpuQuota: quota, cpuPeriod: period, memoryPeakBytes: number('memory.peak'), memoryCurrentBytes: number('memory.current'), events };
  assert.equal(result.memoryMax, 1024 ** 3); assert.equal(result.memorySwapMax, 0); assert.equal(result.pidsMax, 64);
  assert.ok(period > 0); assert.equal(quota, period * 2);
  return result;
}

function sqliteSettings(db) {
  const result = Object.fromEntries(['cache_size', 'synchronous', 'page_size', 'wal_autocheckpoint', 'cache_spill', 'journal_mode', 'foreign_keys', 'temp_store']
    .map(name => [name, Object.values(db.prepare('PRAGMA main.' + name).get())[0]]));
  result.version = db.prepare('SELECT sqlite_version() AS version').get().version; return result;
}

function sideEffects(db) {
  const result = {};
  for (const table of ['audit', 'outbound_commands', 'service_principal_receipts', 'wa_seen']) {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name);
    assert.ok(columns.length > 0); const hash = createHash('sha256'); let rows = 0;
    const order = columns.map(column => '"' + column.replaceAll('"', '""') + '"').join(',');
    for (const row of db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).iterate()) {
      frame(hash, JSON.stringify(columns.map(column => row[column]))); rows++;
    }
    result[table] = { rows, columns, hash: hash.digest('hex') };
  }
  return result;
}

async function inspectState(db, effective) {
  const { effectiveTenantDataSql, journalStatus } = await import('../src/conversation-journal.js');
  const expression = effective ? effectiveTenantDataSql(db, 't') : 't.data';
  const logical = createHash('sha256'), physical = createHash('sha256'), header = createHash('sha256');
  const conversationsHash = createHash('sha256'), history = createHash('sha256'), newIds = new Set();
  let tenants = 0, conversationCount = 0, messageCount = 0, originals = 0, incoming = 0, outgoing = 0, readDeliveries = 0, duplicates = 0;
  for (const row of db.prepare('SELECT t.id,t.reseller_id,' + expression + ' AS data FROM tenants t ORDER BY t.id').iterate()) {
    for (const value of [row.id, row.reseller_id, row.data]) frame(logical, value); tenants++;
  }
  for (const row of db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').iterate()) for (const value of [row.id, row.reseller_id, row.data]) frame(physical, value);
  for (const row of db.prepare("SELECT id,reseller_id,json_remove(data,'$.conversations') AS header FROM tenants ORDER BY id").iterate()) {
    for (const value of [row.id, row.reseller_id, row.header]) frame(header, value);
  }
  for (const label of labels) {
    for (const row of db.prepare("SELECT c.key AS position,c.value AS data FROM tenants t,json_each(" + expression + ",'$.conversations') c WHERE t.id=? ORDER BY c.key").iterate(tenantId(label))) {
      for (const value of [tenantId(label), row.position, row.data]) frame(conversationsHash, value);
      // Parse only this small conversation; never parse/stringify a whole tenant or header.
      const conversation = JSON.parse(row.data); assert.ok(Array.isArray(conversation.messages)); conversationCount++;
      assert.equal(conversation.id, conversationId(label, row.position)); messageCount += conversation.messages.length;
      const initial = conversation.messages.slice(0, messagesPerContext); originals += initial.length;
      frame(history, JSON.stringify([conversation.id, initial]));
      for (const message of conversation.messages.slice(messagesPerContext)) {
        if (newIds.has(message.id)) duplicates++; newIds.add(message.id);
        if (message.kind === 'customer') incoming++;
        if (message.kind === 'agent') { outgoing++; if (message.delivery === 'read') readDeliveries++; }
      }
    }
  }
  return { counts: { tenants, conversations: conversationCount, messages: messageCount, originalMessages: originals, incoming, outgoing, readDeliveries, duplicates, uniqueNewMessages: newIds.size },
    logicalHash: logical.digest('hex'), physicalHash: physical.digest('hex'), headerHash: header.digest('hex'),
    conversationsHash: conversationsHash.digest('hex'), originalHistoryHash: history.digest('hex'), sideEffects: sideEffects(db),
    sourceBytes: db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS n FROM tenants').get().n,
    journal: journalStatus(db), guards: db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n,
    canonicalGuards: db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n,
    experimentalProofObjects: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_conversation_write_proof'").get().n,
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length === 0, quickCheck: db.prepare('PRAGMA quick_check').get().quick_check === 'ok',
    sqlite: sqliteSettings(db) };
}

function referenceContact(label, index) {
  return { id: label + '-contact-' + index, name: 'Synthetic contact ' + index,
    identities: [{ channelId: label + '-wa', kind: 'person', externalId: 'synthetic-' + label + '-' + index + '@s.whatsapp.net' }], version: 1 };
}
function referenceConversation(label, index) {
  const text = ('Synthetic rollback capacity fixture ' + label + '. ').padEnd(192, 'x');
  const id = conversationId(label, index), remoteJid = 'synthetic-' + label + '-' + index + '@s.whatsapp.net', contactId = label + '-contact-' + index;
  return {
    contact: referenceContact(label, index),
    conversation: { id, channelId: label + '-wa', remoteJid, remoteAliases: [remoteJid], contactId, owner: 'agent', agentId: label + '-agent',
      status: 'open', version: 1, unread: 0, departmentId: 'support', updatedAt: '2026-10-23T00:00:00.000Z',
      messages: Array.from({ length: messagesPerContext }, (_, message) => ({ id: label + '-old-' + index + '-' + message,
        externalId: label + '-provider-old-' + index + '-' + message, kind: 'customer', text, delivery: 'received', transport: 'whatsapp', createdAt: '2026-10-23T00:00:00.000Z' })) }
  };
}

// The production-sized fixture emits at most one contact or 20-message
// conversation at a time. The numeric literals never round-trip through JS.
function streamFixtureTenant(label, emit, start = 0, count = contexts / 2) {
  emit('{"name":' + JSON.stringify('Synthetic capacity ' + label) + ',"contacts":[');
  for (let index = start; index < start + count; index++) emit((index === start ? '' : ',') + JSON.stringify(referenceContact(label, index)));
  emit('],"conversations":[');
  for (let index = start; index < start + count; index++) {
    let encoded = JSON.stringify(referenceConversation(label, index).conversation);
    if (index === contexts / 2 - 1) encoded = encoded.slice(0, -1) + ',"opaqueInteger":9223372036854775806}';
    emit((index === start ? '' : ',') + encoded);
  }
  emit('],"privateHeader":{"keep":["unknown",{"enabled":true}],"opaqueInteger":9007199254740993},');
  const tail = JSON.stringify({ channels: [{ id: label + '-wa', kind: 'whatsapp_qr', transport: 'baileys', state: 'disconnected' }],
    agents: [{ id: label + '-agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [{ id: 'support', name: 'Support' }] });
  emit(tail.slice(1));
}

function writeFixtureSeed(dirty, label) {
  const path = join(BASE, 'capacity-' + dirty + '-seed-' + label + '.json');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256'); let bytes = 0;
  try {
    streamFixtureTenant(label, chunk => {
      const buffer = Buffer.from(chunk); let offset = 0;
      while (offset < buffer.length) { const written = writeSync(fd, buffer, offset, buffer.length - offset); assert.ok(written > 0); offset += written; }
      hash.update(buffer); bytes += buffer.length;
    });
    fsyncSync(fd);
    const stat = fstatSync(fd); assert.ok(stat.isFile()); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.size, bytes);
    return { path, bytes, hash: hash.digest('hex'), device: stat.dev, inode: stat.ino, modified: stat.mtimeMs };
  } finally { closeSync(fd); }
}

function insertFixtureBuffer(db, label, buffer) {
  assert.equal(db.prepare('INSERT INTO tenants VALUES (?,?,CAST(? AS TEXT))').run(tenantId(label), workspaceId(label), buffer).changes, 1);
}
function insertFixtureSeed(db, label, seed) {
  const fd = openSync(seed.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); assert.ok(stat.isFile()); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.dev, seed.device); assert.equal(stat.ino, seed.inode);
    assert.equal(stat.size, seed.bytes); assert.equal(stat.mtimeMs, seed.modified);
    const buffer = readFileSync(fd);
    assert.equal(buffer.length, seed.bytes); assert.equal(createHash('sha256').update(buffer).digest('hex'), seed.hash);
    insertFixtureBuffer(db, label, buffer);
  } finally { closeSync(fd); }
  const stat = lstatSync(seed.path);
  assert.ok(stat.isFile()); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
  assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o7777, 0o600);
  assert.equal(stat.dev, seed.device); assert.equal(stat.ino, seed.inode); assert.equal(stat.size, seed.bytes); assert.equal(stat.mtimeMs, seed.modified);
  unlinkSync(seed.path);
}

function installSeedProjectionObservers(db, onFirst) {
  const seen = new Set(), functionName = 'elozi_capacity_projection_first';
  db.function(functionName, (tableIndex, tenant) => {
    assert.ok(Number.isSafeInteger(tableIndex) && tableIndex >= 0 && tableIndex < seedProjectionTables.length);
    assert.ok(labels.some(label => tenant === tenantId(label)));
    const key = tableIndex + ':' + tenant;
    if (seen.has(key)) return 0;
    seen.add(key); onFirst(seedProjectionTables[tableIndex], tenant); return 0;
  });
  for (const [index, table] of seedProjectionTables.entries()) {
    db.exec(`CREATE TEMP TRIGGER elozi_capacity_projection_${index} AFTER INSERT ON main.${table}
      BEGIN SELECT ${functionName}(${index},NEW.tenant_id); END;`);
  }
  return () => {
    for (let index = 0; index < seedProjectionTables.length; index++) db.exec(`DROP TRIGGER temp.elozi_capacity_projection_${index}`);
  };
}

function seedProgress(ctx, dirty) {
  const started = clock(), events = [], projectionEvents = [], path = seedProgressPath(dirty), pending = path.replace(/\.json$/, '.pending.json');
  const sample = () => ({ atUTC: new Date().toISOString(), wallMs: rounded(clock() - started),
    rssBytes: process.memoryUsage().rss, maxRssBytes: process.resourceUsage().maxRSS * 1024, cgroup: cgroup() });
  const publish = () => {
    const data = JSON.stringify({ schemaVersion: 1, kind: 'synthetic-capacity-seed-progress', sourceRevision: ctx.sourceRevision,
      image: ctx.image, nonce: ctx.nonce, dirty, events, projectionEvents }) + '\n';
    assert.ok(Buffer.byteLength(data) <= 16384);
    writeFileSync(pending, data, { flag: 'wx', mode: 0o644 }); chmodSync(pending, 0o644); renameSync(pending, path);
  };
  const progress = (stage, edge) => {
    assert.equal(stage, seedStages[Math.floor(events.length / 2)]); assert.equal(edge, events.length % 2 ? 'after' : 'before');
    events.push({ stage, edge, ...sample() }); publish();
  };
  progress.projection = (table, tenant) => {
    const index = projectionEvents.length;
    assert.ok(index < labels.length * seedProjectionTables.length);
    assert.equal(table, seedProjectionTables[index % seedProjectionTables.length]);
    assert.equal(tenant, tenantId(labels[Math.floor(index / seedProjectionTables.length)]));
    assert.equal(events.at(-1)?.stage, 'insert-' + labels[Math.floor(index / seedProjectionTables.length)]);
    assert.equal(events.at(-1)?.edge, 'before');
    // First-row observation does not prove that the enclosing INSERT committed.
    projectionEvents.push({ table, tenant, ...sample() }); publish();
  };
  return progress;
}

function validateSeedResources(event, previousWallMs) {
  assert.match(event.atUTC, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.ok(Number.isFinite(Date.parse(event.atUTC)));
  assert.ok(Number.isFinite(event.wallMs) && event.wallMs >= previousWallMs);
  assert.ok(Number.isSafeInteger(event.rssBytes) && event.rssBytes > 0); assert.ok(Number.isSafeInteger(event.maxRssBytes) && event.maxRssBytes > 0);
  assert.deepEqual(Object.keys(event.cgroup).sort(), ['memoryMax', 'memorySwapMax', 'pidsMax', 'cpuQuota', 'cpuPeriod', 'memoryPeakBytes', 'memoryCurrentBytes', 'events'].sort());
  for (const [key, number] of Object.entries(event.cgroup)) if (key !== 'events') assert.ok(Number.isSafeInteger(number) && number >= 0);
  assert.ok(event.cgroup.events && typeof event.cgroup.events === 'object' && !Array.isArray(event.cgroup.events));
  for (const [key, number] of Object.entries(event.cgroup.events)) { assert.match(key, /^[a-z_]{1,64}$/); assert.ok(Number.isSafeInteger(number) && number >= 0); }
  assert.equal(event.cgroup.memoryMax, 1024 ** 3); assert.equal(event.cgroup.memorySwapMax, 0); assert.equal(event.cgroup.pidsMax, 64);
  assert.ok(event.cgroup.cpuPeriod > 0); assert.equal(event.cgroup.cpuQuota, 2 * event.cgroup.cpuPeriod);
}

function readSeedProgress(ctx, dirty) {
  const path = seedProgressPath(dirty), stat = lstatSync(path);
  assert.ok(stat.isFile()); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  assert.equal(realpathSync(path), path); assert.ok(stat.size > 0 && stat.size <= 16384);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(value).sort(), ['schemaVersion', 'kind', 'sourceRevision', 'image', 'nonce', 'dirty', 'events', 'projectionEvents'].sort());
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'synthetic-capacity-seed-progress');
  assert.equal(value.sourceRevision, ctx.sourceRevision); assert.equal(value.image, ctx.image); assert.equal(value.nonce, ctx.nonce); assert.equal(value.dirty, dirty);
  assert.ok(Array.isArray(value.events) && value.events.length > 0 && value.events.length <= seedStages.length * 2);
  for (const [index, event] of value.events.entries()) {
    assert.deepEqual(Object.keys(event).sort(), ['stage', 'edge', 'atUTC', 'wallMs', 'rssBytes', 'maxRssBytes', 'cgroup'].sort());
    assert.equal(event.stage, seedStages[Math.floor(index / 2)]); assert.equal(event.edge, index % 2 ? 'after' : 'before');
    validateSeedResources(event, value.events[index - 1]?.wallMs ?? 0);
  }
  assert.ok(Array.isArray(value.projectionEvents) && value.projectionEvents.length <= labels.length * seedProjectionTables.length);
  const seen = new Set();
  for (const [index, event] of value.projectionEvents.entries()) {
    assert.deepEqual(Object.keys(event).sort(), ['table', 'tenant', 'atUTC', 'wallMs', 'rssBytes', 'maxRssBytes', 'cgroup'].sort());
    const label = labels[Math.floor(index / seedProjectionTables.length)], key = event.table + ':' + event.tenant;
    assert.equal(event.table, seedProjectionTables[index % seedProjectionTables.length]); assert.equal(event.tenant, tenantId(label));
    assert.equal(seen.has(key), false); seen.add(key);
    validateSeedResources(event, value.projectionEvents[index - 1]?.wallMs ?? 0);
    const before = value.events.find(marker => marker.stage === 'insert-' + label && marker.edge === 'before');
    const after = value.events.find(marker => marker.stage === 'insert-' + label && marker.edge === 'after');
    assert.ok(before && event.wallMs >= before.wallMs);
    if (after) assert.ok(event.wallMs <= after.wallMs);
  }
  for (const label of labels) {
    if (value.events.some(marker => marker.stage === 'insert-' + label && marker.edge === 'after')) {
      assert.equal(value.projectionEvents.filter(event => event.tenant === tenantId(label)).length, seedProjectionTables.length);
    }
  }
  return value;
}

// Independent SQL producer for tiny CI/reference comparisons only. It is never
// used to compose a production-sized fixture while routing triggers execute.
const fixtureDataSql = `WITH RECURSIVE positions(position) AS (
  VALUES (CAST(?3 AS INTEGER)) UNION ALL SELECT position+1 FROM positions WHERE position+1<CAST(?3 AS INTEGER)+CAST(?4 AS INTEGER)
), message_positions(message) AS (
  VALUES (0) UNION ALL SELECT message+1 FROM message_positions WHERE message+1<${messagesPerContext}
), conversation_values AS (
  SELECT position,json_object('id',?1||'-conversation-'||printf('%05d',position),'channelId',?1||'-wa',
    'remoteJid','synthetic-'||?1||'-'||position||'@s.whatsapp.net',
    'remoteAliases',json_array('synthetic-'||?1||'-'||position||'@s.whatsapp.net'),
    'contactId',?1||'-contact-'||position,'owner','agent','agentId',?1||'-agent','status','open',
    'version',1,'unread',0,'departmentId','support','updatedAt','2026-10-23T00:00:00.000Z',
    'messages',json((SELECT json_group_array(json(value)) FROM (
      SELECT json_object('id',?1||'-old-'||position||'-'||message,
        'externalId',?1||'-provider-old-'||position||'-'||message,'kind','customer','text',?2,
        'delivery','received','transport','whatsapp','createdAt','2026-10-23T00:00:00.000Z') AS value
      FROM message_positions ORDER BY message)))) AS data FROM positions
)
SELECT json_object('name','Synthetic capacity '||?1,
  'contacts',json((SELECT json_group_array(json(value)) FROM (
    SELECT json_object('id',?1||'-contact-'||position,'name','Synthetic contact '||position,
      'identities',json_array(json_object('channelId',?1||'-wa','kind','person',
        'externalId','synthetic-'||?1||'-'||position||'@s.whatsapp.net')),'version',1) AS value
    FROM positions ORDER BY position))),
  'conversations',json((SELECT json_group_array(json(CASE WHEN position=${contexts / 2 - 1}
    THEN json_set(data,'$.opaqueInteger',json('9223372036854775806')) ELSE data END))
    FROM (SELECT position,data FROM conversation_values ORDER BY position))),
  'privateHeader',json_object('keep',json('["unknown",{"enabled":true}]'),'opaqueInteger',json('9007199254740993')),
  'channels',json_array(json_object('id',?1||'-wa','kind','whatsapp_qr','transport','baileys','state','disconnected')),
  'agents',json_array(json_object('id',?1||'-agent','provider','mcp','mode','copilot','configured',json('true'))),
  'departments',json_array(json_object('id','support','name','Support'))) AS data`;

function checkFixtureSample(db, label) {
  const text = ('Synthetic rollback capacity fixture ' + label + '. ').padEnd(192, 'x');
  assert.equal(Buffer.byteLength(text), 192);
  // Compare the SQL producer with one independently constructed original
  // conversation/contact. This small SELECT never writes a third tenant.
  const row = db.prepare(fixtureDataSql).get(label, text, 0, 1), value = JSON.parse(row.data), reference = referenceConversation(label, 0);
  assert.deepEqual(value.conversations, [reference.conversation]); assert.deepEqual(value.contacts, [reference.contact]);
  const integers = db.prepare(`SELECT CAST(json_extract(data,'$.privateHeader.opaqueInteger') AS TEXT) AS header,
    CAST(json_extract(data,'$.conversations[0].opaqueInteger') AS TEXT) AS sibling FROM (${fixtureDataSql})`)
    .get(label, text, contexts / 2 - 1, 1);
  assert.deepEqual({ ...integers }, { header: '9007199254740993', sibling: '9223372036854775806' });
}

async function createFixtureSeed(dirty, ctx) {
  const path = databasePath(dirty); assert.equal(existsSync(path), false);
  const progress = seedProgress(ctx, dirty), seedFiles = [];
  progress('bootstrap', 'before');
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  let db = new DatabaseSync(path), store, removeProjectionObservers;
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);');
    for (const label of labels) {
      db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspaceId(label), '{}');
    }
    db.close(); db = null;
    // Bootstrap the real Store before large histories exist: its fresh journal
    // materialization and routing backfill now see an empty tenants table.
    const { Store } = await import('../src/store.js'); store = new Store(path, { conversationJournal: true }); db = store.db;
    assert.equal(db.prepare('SELECT count(*) AS n FROM tenants').get().n, 0, 'The two preseeded resellers prevent demo seeding.');
    const connectionSettings = sqliteSettings(db);
    assert.equal(connectionSettings.synchronous, 2); assert.equal(connectionSettings.cache_size, -131072);
    assert.equal(connectionSettings.wal_autocheckpoint, Math.floor(64 * 1024 ** 2 / connectionSettings.page_size));
    removeProjectionObservers = installSeedProjectionObservers(db, progress.projection);
    progress('bootstrap', 'after');
    for (const label of labels) {
      progress('write-' + label, 'before');
      checkFixtureSample(db, label);
      const seed = writeFixtureSeed(dirty, label); seedFiles.push({ label, bytes: seed.bytes, hash: seed.hash });
      progress('write-' + label, 'after');
      progress('insert-' + label, 'before');
      insertFixtureSeed(db, label, seed);
      progress('insert-' + label, 'after');
    }
    progress('verify', 'before');
    assert.equal(db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
    assert.equal(db.prepare('SELECT count(*) AS n FROM service_conversation_private').get().n, contexts);
    assert.equal(db.prepare('SELECT count(*) AS n FROM service_conversation_read').get().n, contexts);
    assert.equal(db.prepare('SELECT count(*) AS n FROM service_conversation_lookup_meta WHERE complete=1').get().n, labels.length);
    for (const label of labels) {
      const integers = db.prepare(`SELECT CAST(json_extract(data,'$.privateHeader.opaqueInteger') AS TEXT) AS header,
        CAST(json_extract(data,'$.conversations[${contexts / 2 - 1}].opaqueInteger') AS TEXT) AS sibling FROM tenants WHERE id=?`).get(tenantId(label));
      assert.deepEqual({ ...integers }, { header: '9007199254740993', sibling: '9223372036854775806' });
    }
    // Literal schemas from auth.js, outbox.js and service-principals.js. No
    // service constructors, authentication, model or provider is initialized.
    db.exec(`CREATE TABLE wa_seen(channel_id TEXT NOT NULL,remote_jid TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_jid,message_id));
      CREATE TABLE outbound_commands (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, channel_id TEXT NOT NULL, version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('reseller','operator')), reseller_id TEXT NOT NULL,
        tenant_ids TEXT NOT NULL, password_salt BLOB NOT NULL, password_hash BLOB NOT NULL,
        password_version TEXT NOT NULL DEFAULT 'scrypt-v1', created_at INTEGER NOT NULL, disabled_at INTEGER
      );
      CREATE UNIQUE INDEX service_principal_tenant_scope ON tenants(reseller_id,id);
      CREATE TABLE service_principals (
        id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        name TEXT NOT NULL, capabilities TEXT NOT NULL, channel_ids TEXT, department_ids TEXT,
        daily_requests INTEGER NOT NULL CHECK(daily_requests>0), daily_budget_micros INTEGER NOT NULL CHECK(daily_budget_micros>=0),
        max_concurrent INTEGER NOT NULL CHECK(max_concurrent>0), estimated_request_micros INTEGER NOT NULL DEFAULT 0 CHECK(estimated_request_micros>=0), expires_at INTEGER NOT NULL,
        revision INTEGER NOT NULL, key_revision INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL, revoked_at INTEGER, created_by TEXT NOT NULL REFERENCES auth_users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY(reseller_id,tenant_id) REFERENCES tenants(reseller_id,id)
      );
      CREATE TABLE service_principal_receipts (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES service_principals(id), request_id TEXT NOT NULL,
        reseller_id TEXT NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, principal_revision INTEGER NOT NULL,
        key_revision INTEGER NOT NULL, adapter_hash TEXT NOT NULL, capability TEXT NOT NULL, context TEXT NOT NULL,
        payload_hash TEXT NOT NULL, day TEXT NOT NULL, units INTEGER NOT NULL, reserved_cost_micros INTEGER NOT NULL,
        charged_cost_micros INTEGER NOT NULL, state TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
        result TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        UNIQUE(principal_id,request_id), FOREIGN KEY(reseller_id,tenant_id) REFERENCES tenants(reseller_id,id)
      );
      CREATE INDEX service_principal_receipt_scope ON service_principal_receipts(principal_id,state);`);
    for (const label of labels) {
      db.prepare("INSERT INTO auth_users VALUES (?1,?1,'Disabled synthetic fixture owner','operator',?2,?3,X'00',X'00','fixture-disabled',0,0)")
        .run('capacity-disabled-owner-' + label, workspaceId(label), JSON.stringify([tenantId(label)]));
      db.prepare("INSERT INTO service_principals(id,reseller_id,tenant_id,agent_id,name,capabilities,daily_requests,daily_budget_micros,max_concurrent,expires_at,revision,key_revision,token_hash,active,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,'Disabled synthetic fixture principal','[]',1,0,1,2000000000000,1,1,?5,0,?6,0,0)")
        .run('capacity-disabled-principal-' + label, workspaceId(label), tenantId(label), label + '-agent', digest(['synthetic-disabled-token', label]), 'capacity-disabled-owner-' + label);
    }
    const sourceBytes = db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS n FROM tenants').get().n;
    assert.ok(sourceBytes >= 50000000, 'A short/empty history fixture cannot qualify the helper envelope.');
    assert.equal(seedFiles.reduce((bytes, file) => bytes + file.bytes, 0), sourceBytes);
    progress('verify', 'after');
    return { sourceBytes, connectionSettings, seedFiles,
      method: 'The real Store initializes an empty tenants table with two preseeded resellers. Each 5k-context tenant streams one contact/conversation at a time to an owned 0600 disk file; one verified Buffer is inserted through real triggers after composition has finished. The file is removed only after insertion. Baseline and the unchanged SQL dirty batch use separate sequential children within one total 300-second fixture deadline; the CLI still receives only SOURCE.' };
  } finally {
    try { removeProjectionObservers?.(); }
    finally { if (store) store.close(); else db?.close(); }
  }
}

function createDirtyFixture(dirty, expectedSettings) {
  const path = databasePath(dirty), stat = lstatSync(path);
  assert.ok(stat.isFile()); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  const db = new DatabaseSync(path);
  try {
    // Reopen the existing fixture without Store's recovery/materialization.
    // Preserve its exact writer settings; do not tune FULL, spill or temp_store.
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA main.cache_size=-131072;');
    const { page_size: pageSize } = db.prepare('PRAGMA main.page_size').get();
    assert.ok(Number.isSafeInteger(pageSize) && pageSize > 0);
    db.exec(`PRAGMA wal_autocheckpoint=${Math.max(1, Math.floor(64 * 1024 ** 2 / pageSize))};`);
    assert.deepEqual(sqliteSettings(db), expectedSettings);
    assert.equal(db.prepare("SELECT version FROM service_read_model_meta WHERE id='routing'").get().version, 9);
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, 0);
    const guard = db.prepare("INSERT INTO conversation_journal_write_guard(tenant_id,reseller_id,position,conversation_id,old_data,data) SELECT c.tenant_id,t.reseller_id,c.position,c.id,c.data,json_set(c.data,'$.version',3,'$.messages[#]',json(?1),'$.messages[#]',json(?2)) FROM service_conversation_private c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=?3 AND c.id=?4");
    const payload = db.prepare('INSERT INTO conversation_journal(tenant_id,reseller_id,position,conversation_id,data) SELECT tenant_id,reseller_id,position,conversation_id,data FROM conversation_journal_write_guard WHERE tenant_id=?');
    const clear = db.prepare('DELETE FROM conversation_journal_write_guard WHERE tenant_id=?');
    const audit = db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)'), seen = db.prepare('INSERT INTO wa_seen VALUES (?,?,?)');
    const command = db.prepare('INSERT INTO outbound_commands VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const receipt = db.prepare('INSERT INTO service_principal_receipts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const label of labels) for (let index = 0; index < dirty / 2; index++) {
        const key = label + '-' + index, request = 'synthetic-request-' + key, provider = 'capacity-provider-' + key;
        const incoming = JSON.stringify({ id: 'capacity-in-' + key, externalId: 'capacity-in-provider-' + key, kind: 'customer', text: 'Synthetic new request.', delivery: 'received', transport: 'whatsapp' });
        const outgoing = JSON.stringify({ id: 'capacity-out-' + key, externalId: provider, serviceCommandId: request, kind: 'agent', text: 'Synthetic preserved response.', delivery: 'read', transport: 'whatsapp' });
        assert.equal(guard.run(incoming, outgoing, tenantId(label), conversationId(label, index)).changes, 1);
        assert.equal(payload.run(tenantId(label)).changes, 1); assert.equal(clear.run(tenantId(label)).changes, 1);
        if (index < 2) {
          audit.run('audit-' + key, tenantId(label), 'Synthetic journal capacity fixture', '2026-10-23T00:00:00.000Z', 'Synthetic fixture owner');
          seen.run(label + '-wa', 'synthetic-' + key, provider);
          command.run(request, tenantId(label), conversationId(label, index), label + '-wa', 3, request, digest(outgoing), outgoing,
            index % 2 ? 'unknown' : 'confirmed', 1, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
          receipt.run('receipt-' + key, 'capacity-disabled-principal-' + label, request, workspaceId(label), tenantId(label), label + '-agent',
            1, 1, digest(['synthetic-adapter', label]), 'respond', JSON.stringify({ tenantId: tenantId(label), conversationId: conversationId(label, index) }),
            digest(outgoing), '2026-10-23', 1, 0, 0, index % 2 ? 'unknown' : 'confirmed', 0, JSON.stringify({ providerId: provider }), null, 0, 0, 2000000000000);
        }
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, dirty);
      assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n, 0);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { dirty, connectionSettings: sqliteSettings(db) };
  } finally { db.close(); }
}

async function inspectFixture(dirty, effective) {
  const path = databasePath(dirty), stat = lstatSync(path);
  assert.ok(stat.isFile()); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  const db = new DatabaseSync(path, { readOnly: true });
  try { return await inspectState(db, effective); } finally { db.close(); }
}

function cleanEnvironment(ctx, profile = false) {
  // The real pre-start CLI uses env -i with only SOURCE. Keep libuv's default
  // pool and warning behaviour there; fixture/inspector helpers are separate.
  const env = { MEPCHAT_SOURCE_REVISION: ctx.sourceRevision };
  if (profile) Object.assign(env, { UV_THREADPOOL_SIZE: '2', NODE_NO_WARNINGS: '1',
    MEPCHAT_JOURNAL_ROLLBACK_CAPACITY: '1', MEPCHAT_JOURNAL_ROLLBACK_CAPACITY_PATH: BASE,
    MEPCHAT_JOURNAL_ROLLBACK_CAPACITY_IMAGE: ctx.image });
  return env;
}

function runChild(args, options, signal) {
  return new Promise(resolve => {
    // Own the timeout explicitly: spawn's separate default SIGTERM timer must
    // not race this SIGKILL/reap boundary or misclassify a deadline as a signal.
    const started = clock(), child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, aborted = false, overflow = false, spawnError;
    const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    const abort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout);
    signal.addEventListener('abort', abort, { once: true });
    const capture = (kind, bytes) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.length > 1024 ** 2) { overflow = true; stop(); return; }
      if (kind === 'stdout') stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8');
    };
    child.stdout.on('data', bytes => capture('stdout', bytes)); child.stderr.on('data', bytes => capture('stderr', bytes));
    child.on('error', error => { spawnError = error.code || error.name; });
    child.once('close', (code, terminationSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      resolve({ wallMs: rounded(clock() - started), exitCode: code, signal: terminationSignal, timedOut, aborted, overflow,
        spawnError: spawnError || null, terminated: child.exitCode !== null || child.signalCode !== null || Boolean(spawnError), stdout, stderr });
    });
    if (signal.aborted) abort();
  });
}

const cliObserver = [
  "import {writeSync} from 'node:fs';",
  "import {getHeapStatistics} from 'node:v8';",
  "const started=performance.now();",
  "process.once('exit',code=>writeSync(2," + JSON.stringify(PREFIX) + "+JSON.stringify({schemaVersion:1,exitCode:code,wallMs:performance.now()-started,maxRssBytes:process.resourceUsage().maxRSS*1024,heapLimitBytes:getHeapStatistics().heap_size_limit,environmentKeys:Object.keys(process.env).sort(),uvThreadpoolSize:process.env.UV_THREADPOOL_SIZE??null,method:'Linux process.resourceUsage().maxRSS in the actual CLI process; exit hook only, no extra SQL or workload'})+'\\n'));"
].join('');

function childSummary(result) {
  const summary = Object.fromEntries(Object.entries(result).filter(([key]) => !['stdout', 'stderr'].includes(key)));
  const codes = result.stderr.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
    try { const value = JSON.parse(line).code; return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? [value] : []; }
    catch { return []; }
  });
  if (codes.length) summary.failureCodes = [...new Set(codes)];
  return summary;
}
function requireChild(result, phase) {
  assert.equal(result.terminated, true, phase + ' child must be reaped before continuing.');
  assert.equal(result.spawnError, null, phase + ' could not spawn.'); assert.equal(result.timedOut, false, phase + ' deadline exceeded.');
  assert.equal(result.aborted, false, phase + ' aborted.'); assert.equal(result.overflow, false, phase + ' exceeded its bounded output.');
  assert.equal(result.signal, null, phase + ' was terminated by a signal.'); assert.equal(result.exitCode, 0, phase + ' failed.');
}
function healthy(state) {
  assert.equal(state.foreignKeys, true); assert.equal(state.quickCheck, true); assert.equal(state.guards, 0); assert.equal(state.canonicalGuards, 0);
  assert.equal(state.experimentalProofObjects, 0); assert.equal(state.counts.tenants, 2); assert.equal(state.counts.conversations, contexts);
  assert.equal(state.counts.originalMessages, originalMessages); assert.equal(state.counts.duplicates, 0);
}

const childArgument = process.argv[2] === '--capacity-child' ? process.argv[3] : null;
if (childArgument !== null) {
  try {
    const ctx = context(), input = JSON.parse(childArgument); assert.equal(input.nonce, ctx.nonce);
    assert.ok([90, 10000].includes(input.dirty)); assert.ok(['fixture-seed', 'fixture-baseline', 'fixture-dirty', 'before', 'after'].includes(input.phase));
    const started = clock();
    const value = input.phase === 'fixture-seed' ? await createFixtureSeed(input.dirty, ctx)
      : input.phase === 'fixture-dirty' ? createDirtyFixture(input.dirty, input.settings)
        : await inspectFixture(input.dirty, input.phase === 'before');
    process.stdout.write(JSON.stringify({ schemaVersion: 1, phase: input.phase, dirty: input.dirty, sourceRevision: ctx.sourceRevision, image: ctx.image,
      value, resources: { wallMs: rounded(clock() - started), maxRssBytes: process.resourceUsage().maxRSS * 1024 } }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ schemaVersion: 1, kind: 'synthetic-capacity-child-failure', code: error.code || error.name }) + '\n'); process.exitCode = 1;
  }
} else if (!enabled) test('the bounded streamed capacity seed matches the original and independent SQL values, order and opaque integers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);');
    for (const label of labels) {
      db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspaceId(label), '{}');
      checkFixtureSample(db, label);
      const text = ('Synthetic rollback capacity fixture ' + label + '. ').padEnd(192, 'x');
      const chunks = []; streamFixtureTenant(label, chunk => chunks.push(chunk), 0, 2);
      const streamed = chunks.join(''), sql = db.prepare(fixtureDataSql).get(label, text, 0, 2).data;
      assert.equal(streamed, sql, 'The real stream algorithm must agree with the independent SQL producer.');
      insertFixtureBuffer(db, label, Buffer.from(streamed));
      const stored = db.prepare('SELECT data FROM tenants WHERE id=?').get(tenantId(label)).data;
      assert.equal(stored, streamed, 'The same Buffer/CAST insertion path preserves the exact UTF-8 source.');
      const value = JSON.parse(stored);
      const reference = [referenceConversation(label, 0), referenceConversation(label, 1)];
      assert.deepEqual(value.conversations, reference.map(row => row.conversation));
      assert.deepEqual(value.contacts, reference.map(row => row.contact));
      assert.equal(value.agents[0].configured, true);
      assert.ok(value.conversations.every(conversation => conversation.messages.length === messagesPerContext
        && conversation.messages.every(message => Buffer.byteLength(message.text) === 192)));
      const last = []; streamFixtureTenant(label, chunk => last.push(chunk), contexts / 2 - 1, 1);
      assert.equal(last.join(''), db.prepare(fixtureDataSql).get(label, text, contexts / 2 - 1, 1).data,
        'Opaque integer literals stay exact without a JS Number round-trip.');
    }
    for (const table of seedProjectionTables) db.exec(`CREATE TABLE ${table} (tenant_id TEXT NOT NULL)`);
    const schema = () => db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
    const originalSchema = schema(), observed = [];
    const removeObservers = installSeedProjectionObservers(db, (table, tenant) => observed.push({ table, tenant }));
    try {
      assert.deepEqual(schema(), originalSchema, 'Observers install only TEMP triggers, leaving the main schema intact.');
      assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE type='trigger'").get().n, seedProjectionTables.length);
      for (const label of labels) for (const table of seedProjectionTables) {
        const insert = db.prepare(`INSERT INTO ${table} (tenant_id) VALUES (?)`);
        insert.run(tenantId(label)); insert.run(tenantId(label));
      }
      assert.deepEqual(observed, labels.flatMap(label => seedProjectionTables.map(table => ({ table, tenant: tenantId(label) }))));
      for (const table of seedProjectionTables) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, labels.length * 2);
    } finally { removeObservers(); }
    assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE type='trigger'").get().n, 0);
    assert.deepEqual(schema(), originalSchema);
  } finally { db.close(); }
});
else test('standalone rollback CLI preserves the fixed 10k-context fixture in the real one-GiB envelope', {
  skip: !enabled, timeout: 50 * 60 * 1000
}, async t => {
  const ctx = context(); assert.deepEqual(readdirSync(BASE), [MARKER], 'Only a fresh owned fixture bind may be used.');
  const report = { schemaVersion: 1, profile: PROFILE, sourceRevision: ctx.sourceRevision, image: ctx.image, nonce: ctx.nonce, synthetic: true,
    accepted: false, profileCounts: { tenants: 2, contexts, originalMessages, messagesPerContext }, scenarios: [],
    limitations: ['This qualifies the standalone CLI, not a pinned full server boot or live provider.',
      'The container envelope includes the small parent test harness; fixture, CLI and inspector children run sequentially.',
      'Fixture seed, baseline and dirty children share one total 300-second deadline; each reports its own maxRSS. The Store initializes before histories stream to owned disk files and are inserted through the real triggers.',
      'cgroup memory.peak includes all phases. CLI maxRSS is measured separately by its own exit hook; absent after SIGKILL is unavailable, never estimated.',
      'Inspector SQLite settings belong to an independent fresh readonly connection. CLI FULL is additionally proven by the real materialization receipt.'] };
  const resultPath = join(BASE, 'capacity-result.json');
  const publish = () => { writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o644 }); chmodSync(resultPath, 0o644); };
  let phase = 'setup', scenario;
  try {
    publish(); report.envelope = cgroup(); publish();
    for (const dirty of [90, 10000]) {
      scenario = { dirty, accepted: false, phases: {} }; report.scenarios.push(scenario);
      const executePhase = async (name, { fixtureEnd, settings } = {}) => {
        phase = name; scenario.currentPhase = name; publish();
        const fixturePhase = name.startsWith('fixture-'), timeout = fixturePhase ? Math.floor(fixtureEnd - clock()) : deadline.inspect;
        assert.ok(Number.isSafeInteger(timeout) && timeout > 0, 'The unchanged total fixture deadline has expired.');
        const result = await runChild(['--v8-pool-size=2', self, '--capacity-child', JSON.stringify({ phase: name, dirty, nonce: ctx.nonce, ...(settings ? { settings } : {}) })],
          { cwd: BASE, env: cleanEnvironment(ctx, true), timeout }, t.signal);
        scenario.phases[name] = { ...childSummary(result), cgroup: cgroup() };
        if (name === 'fixture-seed') {
          // The child has been reaped. Preserve its last atomic bounded marker
          // before asserting success, including when the kernel killed it.
          try { scenario.phases[name].seedProgress = readSeedProgress(ctx, dirty); }
          catch (error) { scenario.phases[name].seedProgressError = { code: error.code || error.name }; }
        }
        publish(); requireChild(result, name);
        if (name === 'fixture-seed') {
          assert.equal(scenario.phases[name].seedProgressError, undefined);
          assert.equal(scenario.phases[name].seedProgress.events.length, seedStages.length * 2);
        }
        assert.equal(result.stderr, ''); const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.sourceRevision, ctx.sourceRevision); assert.equal(parsed.image, ctx.image); assert.equal(parsed.phase, name); assert.equal(parsed.dirty, dirty);
        scenario.phases[name].resources = parsed.resources; publish(); return parsed.value;
      };
      const fixtureStarted = clock(), fixtureEnd = fixtureStarted + deadline.fixture;
      const seed = await executePhase('fixture-seed', { fixtureEnd });
      assert.equal(seed.seedFiles.length, labels.length);
      for (const [index, file] of seed.seedFiles.entries()) {
        assert.deepEqual(Object.keys(file).sort(), ['label', 'bytes', 'hash'].sort()); assert.equal(file.label, labels[index]);
        assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0); assert.match(file.hash, /^[a-f0-9]{64}$/);
      }
      const baseline = await executePhase('fixture-baseline', { fixtureEnd }); healthy(baseline);
      assert.equal(baseline.counts.messages, originalMessages); assert.equal(baseline.journal.active, true); assert.equal(baseline.journal.rows, 0);
      assert.equal(baseline.sourceBytes, seed.sourceBytes); assert.ok(baseline.sourceBytes >= 50000000);
      const written = await executePhase('fixture-dirty', { fixtureEnd, settings: seed.connectionSettings });
      assert.equal(written.dirty, dirty); assert.deepEqual(written.connectionSettings, seed.connectionSettings);
      const fixtureWallMs = clock() - fixtureStarted;
      assert.ok(fixtureWallMs <= deadline.fixture, 'All fixture children together must meet the unchanged 300-second deadline.');
      scenario.fixture = { wallMs: rounded(fixtureWallMs), totalDeadlineMs: deadline.fixture, writerSettings: seed.connectionSettings, seedFiles: seed.seedFiles };
      const fixture = { baseline, method: seed.method }, before = await executePhase('before'); healthy(before);
      assert.equal(before.physicalHash, fixture.baseline.physicalHash); assert.equal(before.headerHash, fixture.baseline.headerHash);
      assert.equal(before.originalHistoryHash, fixture.baseline.originalHistoryHash); assert.ok(fixture.baseline.sourceBytes >= 50000000);
      assert.equal(before.journal.active, true); assert.equal(before.journal.rows, dirty); assert.equal(before.journal.dirtyTenants, 2);
      assert.equal(before.counts.messages, originalMessages + 2 * dirty); assert.equal(before.counts.incoming, dirty); assert.equal(before.counts.outgoing, dirty);
      assert.equal(before.counts.readDeliveries, dirty); assert.equal(before.counts.uniqueNewMessages, 2 * dirty);
      for (const side of Object.values(before.sideEffects)) assert.equal(side.rows, 4, 'Real side-effect schemas must contain nonempty synthetic states from both tenants.');
      scenario.sourceBytes = fixture.baseline.sourceBytes; scenario.before = before; scenario.fixtureMethod = fixture.method;
      const stat = lstatSync(databasePath(dirty), { bigint: true });
      const input = { databasePath: databasePath(dirty), expectedIdentity: { kind: 'file', device: String(stat.dev), inode: String(stat.ino),
        uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n) }, toolSource: ctx.sourceRevision, targetSource: ctx.sourceRevision,
        targetImage: ctx.image, targetJournalVersion: '1', targetStartJournal: false, forwardActivation: false };
      phase = 'cli'; scenario.currentPhase = phase; scenario.cgroupBeforeCli = cgroup(); publish();
      const result = await runChild(['--v8-pool-size=2', '--import', 'data:text/javascript,' + encodeURIComponent(cliObserver), cli, JSON.stringify(input)],
        { cwd: '/app', env: cleanEnvironment(ctx), timeout: deadline.cli }, t.signal);
      scenario.phases.cli = childSummary(result); scenario.cgroupAfterCli = cgroup();
      const metricLines = result.stderr.trim().split('\n').filter(line => line.startsWith(PREFIX));
      scenario.phases.cli.resources = metricLines.length === 1 ? JSON.parse(metricLines[0].slice(PREFIX.length)) : null;
      publish(); requireChild(result, 'cli');
      assert.equal(metricLines.length, 1); assert.equal(result.stderr.trim(), metricLines[0]);
      assert.equal(scenario.phases.cli.resources.exitCode, 0); assert.ok(scenario.phases.cli.resources.maxRssBytes > 0);
      assert.deepEqual(scenario.phases.cli.resources.environmentKeys, ['MEPCHAT_SOURCE_REVISION']);
      assert.equal(scenario.phases.cli.resources.uvThreadpoolSize, null);
      assert.equal(scenario.cgroupAfterCli.events.oom, scenario.cgroupBeforeCli.events.oom);
      assert.equal(scenario.cgroupAfterCli.events.oom_kill, scenario.cgroupBeforeCli.events.oom_kill);
      const receipt = JSON.parse(result.stdout), materialized = receipt.materialization;
      assert.equal(receipt.toolSource, ctx.sourceRevision); assert.equal(receipt.targetSource, ctx.sourceRevision); assert.equal(receipt.targetImage, ctx.image);
      assert.equal(receipt.modeAfter, 'legacy'); assert.deepEqual(receipt.databaseIdentity, input.expectedIdentity);
      assert.ok(Object.values(receipt.checks).every(value => value === true)); assert.equal(materialized.active, false); assert.equal(materialized.remainingRows, 0);
      assert.equal(materialized.before.logicalHash, before.logicalHash); assert.equal(materialized.after.logicalHash, before.logicalHash);
      assert.deepEqual(materialized.before.sideEffects, materialized.after.sideEffects); assert.ok(Object.values(materialized.checks).every(value => value === true));
      assert.deepEqual([materialized.after.tenants, materialized.after.conversations, materialized.after.messages], [2, contexts, originalMessages + 2 * dirty]);
      scenario.receipt = receipt;
      const after = await executePhase('after'); healthy(after);
      assert.equal(after.journal.active, false); assert.equal(after.journal.rows, 0);
      for (const key of ['logicalHash', 'headerHash', 'conversationsHash', 'originalHistoryHash']) assert.equal(after[key], before[key], key);
      assert.equal(after.physicalHash, before.logicalHash); assert.deepEqual(after.counts, before.counts);
      assert.deepEqual(after.sideEffects, before.sideEffects, 'All columns of audit/outbox/receipts/wa_seen must remain byte-identical.');
      assert.equal(after.sqlite.synchronous, 2); scenario.after = after; scenario.accepted = true; delete scenario.currentPhase; publish();
    }
    report.accepted = true; report.cgroupFinal = cgroup(); publish();
    t.diagnostic(JSON.stringify(report));
  } catch (error) {
    report.failure = { phase, scenarioDirty: scenario?.dirty ?? null, code: error.code || error.name };
    if (scenario) scenario.failure = report.failure;
    try { report.cgroupFinal = cgroup(); } catch (observationError) { report.resourceObservationFailure = { code: observationError.code || observationError.name }; }
    publish(); t.diagnostic(JSON.stringify(report)); throw error;
  }
});
