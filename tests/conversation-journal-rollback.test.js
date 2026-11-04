import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { journalStatus, materializeForLegacy } from '../src/conversation-journal.js';
import { prepareLegacyDatabase } from '../src/conversation-journal-rollback.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../src/conversation-journal-rollback.js', import.meta.url));
const toolSource = 'b'.repeat(40), targetImage = 'sha256:' + 'a'.repeat(64);
const pins = ['eb00ebf75628e7f939ee1fb1e9d4980c9648cdc3', 'e26b657461bcca0daf9c3f15f2f06ec851ed0873'];
const actor = { role: 'reseller', resellerId: 'rollback-workspace', name: 'Synthetic rollback owner' };
const source = () => ({ name: 'Synthetic rollback tenant', channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }],
  agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [], contacts: [],
  privateHeader: { unchanged: 'synthetic-header' }, conversations: [
    { id: 'target', channelId: 'wa', remoteJid: 'synthetic-target', remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1,
      messages: [{ id: 'old-message', kind: 'customer', text: 'Synthetic original history.' }] },
    { id: 'sibling', channelId: 'wa', remoteJid: 'synthetic-sibling', remoteAliases: [], owner: 'queue', status: 'open', version: 1,
      messages: [{ id: 'sibling-message', kind: 'customer', text: 'Synthetic sibling history.' }] }
  ] });

function identity(path) {
  const stat = lstatSync(path, { bigint: true });
  return { kind: 'file', device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n) };
}
function readDatabase(path, fn) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const physical = path => readDatabase(path, db => JSON.parse(db.prepare('SELECT data FROM tenants WHERE id=?').get('rollback-tenant').data));
function snapshot(path) {
  return readDatabase(path, db => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const tables = Object.fromEntries(schema.filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(row => [row.name,
      db.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '"').all().map(value => JSON.stringify(value)).sort()]));
    return { schema, tables };
  });
}
function fixture(t, { journal = true, dirty = true } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'elozi-journal-rollback-'))), path = join(directory, 'synthetic.sqlite');
  let store;
  t.after(() => {
    store?.close();
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    assert.match(basename(directory), /^elozi-journal-rollback-[A-Za-z0-9]+$/);
    rmSync(directory, { recursive: true, force: true });
  });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);');
    db.prepare('INSERT INTO resellers VALUES (?,?)').run(actor.resellerId, '{}');
    db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('rollback-tenant', actor.resellerId, JSON.stringify(source()));
  } finally { db.close(); }
  store = new Store(path, { conversationJournal: journal });
  store.db.exec(`CREATE TABLE wa_seen(channel_id TEXT NOT NULL,remote_jid TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_jid,message_id));
    CREATE TABLE outbound_commands(id TEXT PRIMARY KEY,state TEXT NOT NULL,attempts INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE service_principal_receipts(id TEXT PRIMARY KEY,state TEXT NOT NULL,request_id TEXT NOT NULL);`);
  store.db.prepare('INSERT INTO outbound_commands VALUES (?,?,?,?)').run('original-command', 'unconfirmed', 1, '{"idempotencyKey":"original-request"}');
  store.db.prepare('INSERT INTO service_principal_receipts VALUES (?,?,?)').run('original-receipt', 'unknown', 'original-request');
  if (dirty) store.mutateConversation(actor, 'rollback-tenant', 'target', 'Synthetic journal-only commit', conversation => {
    store.db.prepare('INSERT INTO wa_seen VALUES (?,?,?)').run('wa', 'synthetic-jid', 'original-provider-id');
    conversation.version++;
    conversation.messages.push({ id: 'journal-only-message', externalId: 'original-provider-id', kind: 'agent', text: 'Synthetic latest history.', delivery: 'read' });
  });
  const expected = store.tenant(actor, 'rollback-tenant');
  store.close(); store = null;
  const input = { databasePath: path, expectedIdentity: identity(path), toolSource, targetSource: pins[0], targetImage, forwardActivation: false };
  return { directory, path, input, expected };
}
const prepare = (input, options = {}) => prepareLegacyDatabase(input, { runtimeSource: toolSource, ...options });
function rejectedStore(path, options, code) {
  let opened;
  try { assert.throws(() => { opened = new Store(path, options); }, error => error.code === code); }
  finally { opened?.close(); }
}
function runCli(input, runtimeSource = toolSource) {
  const env = { MEPCHAT_SOURCE_REVISION: runtimeSource, UV_THREADPOOL_SIZE: '2', NODE_NO_WARNINGS: '1' };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return spawnSync(process.execPath, ['--max-old-space-size=128', '--v8-pool-size=2', cli, JSON.stringify(input)],
    { cwd: dirname(input.databasePath), env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
}
function cliReceipt(input) {
  const result = runCli(input);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
async function oldStore(directory, pin) {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'] };
  assert.equal(execFileSync('git', ['rev-parse', `${pin}^{commit}`], options).trim(), pin);
  const destination = join(directory, 'old-' + pin.slice(0, 12));
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(destination, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
  for (const name of ['store.js', 'profile.js', 'events.js']) {
    const bytes = execFileSync('git', ['show', `${pin}:src/${name}`], options);
    assert.ok(Buffer.byteLength(bytes, 'utf8') <= 262144);
    // These exact pins use only built-ins and the two extracted local modules.
    for (const match of bytes.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('node:') || ['./profile.js', './events.js'].includes(match[1]), 'Unexpected legacy module dependency.');
    assert.equal(/\bimport\s*\(/.test(bytes), false, 'Legacy Store fixture must not load additional code dynamically.');
    writeFileSync(join(destination, name), bytes, { flag: 'wx' });
    assert.equal(readFileSync(join(destination, name), 'utf8'), bytes);
  }
  return (await import(pathToFileURL(join(destination, 'store.js')).href)).Store;
}

test('legacy default prestart stays read-only and boots the current Store without journal support', async t => {
  const f = fixture(t, { journal: false, dirty: false }), before = snapshot(f.path);
  const receipt = await prepare(f.input, { loadJournalModule: () => { throw new Error('Legacy read-only path must not load journal code.'); } });
  assert.equal(receipt.modeAfter, 'legacy');
  assert.equal(receipt.journalExisted, false);
  assert.equal(receipt.materialization, null);
  assert.deepEqual(snapshot(f.path), before);
  const store = new Store(f.path);
  try {
    assert.deepEqual(store.tenant(actor, 'rollback-tenant').conversations, f.expected.conversations);
    store.mutate(actor, 'rollback-tenant', 'Synthetic current legacy write', tenant => { tenant.conversations[0].version++; });
    assert.equal(store.tenant(actor, 'rollback-tenant').conversations[0].version, 2);
    assert.equal(journalStatus(store.db).exists, false);
  } finally { store.close(); }
});

const hasCommit = pin => spawnSync('git', ['cat-file', '-e', `${pin}^{commit}`], { cwd: root, windowsHide: true, stdio: 'ignore' }).status === 0;
for (const pin of pins) test(`CLI materializes current history before actual legacy Store ${pin.slice(0, 12)} boot, read and write`,
  { skip: !hasCommit(pin) && 'legacy release source is not part of this repository history' }, async t => {
  const f = fixture(t), before = snapshot(f.path);
  assert.equal(physical(f.path).conversations[0].messages.length, 1);
  rejectedStore(f.path, undefined, 'ELOZI_CONVERSATION_JOURNAL_ACTIVE');
  assert.deepEqual(snapshot(f.path), before);
  const receipt = cliReceipt({ ...f.input, targetSource: pin });
  assert.equal(receipt.toolSource, toolSource);
  assert.equal(receipt.targetSource, pin);
  assert.equal(receipt.targetImage, targetImage);
  assert.equal(receipt.modeAfter, 'legacy');
  assert.deepEqual(receipt.databaseIdentity, f.input.expectedIdentity);
  for (const check of Object.values(receipt.checks)) assert.equal(check, true);
  const proof = receipt.materialization;
  assert.equal(proof.before.logicalHash, proof.after.logicalHash);
  assert.deepEqual(proof.before.sideEffects, proof.after.sideEffects);
  assert.deepEqual([proof.before.tenants, proof.before.conversations, proof.before.messages], [1, 2, 3]);
  assert.equal(proof.remainingRows, 0); assert.equal(proof.active, false);
  for (const check of Object.values(proof.checks)) assert.equal(check, true);
  assert.deepEqual(physical(f.path).conversations, f.expected.conversations);
  const after = snapshot(f.path);
  for (const table of ['audit', 'wa_seen', 'outbound_commands', 'service_principal_receipts']) assert.deepEqual(after.tables[table], before.tables[table]);
  const replay = cliReceipt({ ...f.input, targetSource: pin });
  assert.equal(replay.materialization, null); assert.deepEqual(snapshot(f.path), after);
  rejectedStore(f.path, { conversationJournal: true }, 'ELOZI_CONVERSATION_JOURNAL_ACTIVATION_REQUIRED');
  const currentDefault = new Store(f.path);
  try {
    assert.deepEqual(currentDefault.tenant(actor, 'rollback-tenant').conversations, f.expected.conversations);
    assert.equal(journalStatus(currentDefault.db).active, false);
  } finally { currentDefault.close(); }
  const LegacyStore = await oldStore(f.directory, pin), legacy = new LegacyStore(f.path);
  try {
    const current = legacy.tenant(actor, 'rollback-tenant');
    assert.deepEqual(current.conversations, f.expected.conversations);
    assert.deepEqual(current.privateHeader, f.expected.privateHeader);
    legacy.mutate(actor, 'rollback-tenant', 'Synthetic pinned legacy write', tenant => {
      tenant.conversations[0].version++;
      tenant.conversations[0].messages.push({ id: 'legacy-message', kind: 'human', text: 'Synthetic legacy continuation.' });
    });
    assert.equal(legacy.tenant(actor, 'rollback-tenant').conversations[0].messages.length, 3);
    assert.equal(legacy.tenant(actor, 'rollback-tenant').conversations[0].version, 3);
    assert.equal(journalStatus(legacy.db).active, false); assert.equal(journalStatus(legacy.db).rows, 0);
    assert.deepEqual(legacy.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { legacy.close(); }
  const continued = snapshot(f.path);
  for (const table of ['wa_seen', 'outbound_commands', 'service_principal_receipts']) assert.deepEqual(continued.tables[table], before.tables[table]);
  assert.equal(continued.tables.audit.length, before.tables.audit.length + 1);
});

test('CLI rejects tool, target grammar and file identity mismatches before changing dirty data', t => {
  const f = fixture(t), before = snapshot(f.path);
  for (const [patch, runtime] of [
    [{}, 'c'.repeat(40)], [{ toolSource: 'invalid' }, toolSource], [{ targetSource: 'invalid' }, toolSource],
    [{ targetImage: 'sha256:invalid' }, toolSource],
    [{ expectedIdentity: { ...f.input.expectedIdentity, inode: String(BigInt(f.input.expectedIdentity.inode) + 1n) } }, toolSource]
  ]) {
    const result = runCli({ ...f.input, ...patch }, runtime);
    assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'ELOZI_JOURNAL_PRESTART_REFUSED');
    assert.equal(result.stderr.includes('Synthetic latest history.'), false);
    assert.deepEqual(snapshot(f.path), before);
  }
});

test('unknown clean schema, partial schema and live write guard refuse prestart without discarding evidence', async t => {
  for (const mode of ['partial', 'unknown-clean-column', 'guard']) {
    const f = fixture(t, { journal: mode !== 'partial', dirty: mode === 'guard' }), db = new DatabaseSync(f.path);
    try {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      if (mode === 'partial') db.exec('CREATE TABLE conversation_journal_meta(id INTEGER PRIMARY KEY,version INTEGER,active INTEGER); INSERT INTO conversation_journal_meta VALUES(1,1,0);');
      else if (mode === 'unknown-clean-column') {
        materializeForLegacy(db);
        db.exec('ALTER TABLE conversation_journal ADD COLUMN synthetic_unknown TEXT');
      } else {
        const current = JSON.parse(db.prepare('SELECT data FROM conversation_journal').get().data);
        db.prepare('INSERT INTO conversation_journal_write_guard(tenant_id,reseller_id,position,conversation_id,old_data,data) VALUES (?,?,?,?,?,?)')
          .run('rollback-tenant', actor.resellerId, 0, 'target', JSON.stringify(current), JSON.stringify(current));
      }
    } finally { db.close(); }
    const before = snapshot(f.path);
    await assert.rejects(prepare(f.input));
    assert.deepEqual(snapshot(f.path), before, mode);
  }
});

test('missing recovery tool or an incomplete materialization receipt cannot authorize legacy startup', async t => {
  const f = fixture(t), before = snapshot(f.path);
  for (const journal of [{}, { materializeForLegacy: () => ({ schemaVersion: 1, materialized: true }), journalStatus: () => ({ active: true, rows: 1 }) }]) {
    await assert.rejects(prepare(f.input, { loadJournalModule: async () => journal }), error => error.code === 'ELOZI_JOURNAL_PRESTART_REFUSED');
    assert.deepEqual(snapshot(f.path), before);
  }
});

test('forward activation needs explicit supported destination and keeps a legacy-fenced Store closed until prepared', async t => {
  const f = fixture(t);
  const legacy = await prepare(f.input);
  assert.equal(legacy.modeAfter, 'legacy');
  const before = snapshot(f.path);
  rejectedStore(f.path, { conversationJournal: true }, 'ELOZI_CONVERSATION_JOURNAL_ACTIVATION_REQUIRED');
  for (const patch of [{}, { targetJournalVersion: '2', targetStartJournal: true }, { targetJournalVersion: '1', targetStartJournal: false }]) {
    await assert.rejects(prepare({ ...f.input, forwardActivation: true, ...patch }));
    assert.deepEqual(snapshot(f.path), before);
  }
  const forward = await prepare({ ...f.input, forwardActivation: true, targetJournalVersion: '1', targetStartJournal: true });
  assert.equal(forward.modeAfter, 'journal');
  assert.equal(forward.materialization.before.logicalHash, forward.materialization.after.logicalHash);
  rejectedStore(f.path, undefined, 'ELOZI_CONVERSATION_JOURNAL_ACTIVE');
  const store = new Store(f.path, { conversationJournal: true });
  try {
    assert.equal(journalStatus(store.db).active, true); assert.equal(journalStatus(store.db).rows, 0);
    assert.deepEqual(store.tenant(actor, 'rollback-tenant').conversations, f.expected.conversations);
  } finally { store.close(); }
});

test('fresh forward prestart defers journal initialization without loading code or changing the legacy database', async t => {
  const f = fixture(t, { journal: false, dirty: false }), before = snapshot(f.path);
  const receipt = await prepare({ ...f.input, forwardActivation: true, targetJournalVersion: '1', targetStartJournal: true },
    { loadJournalModule: () => { throw new Error('Fresh forward prestart must stay read-only.'); } });
  assert.equal(receipt.modeAfter, 'journal-pending-initialization');
  assert.equal(receipt.materialization, null); assert.equal(receipt.journalExisted, false);
  assert.deepEqual(snapshot(f.path), before);
  const store = new Store(f.path, { conversationJournal: true });
  try { assert.equal(journalStatus(store.db).active, true); assert.equal(journalStatus(store.db).rows, 0); }
  finally { store.close(); }
});
