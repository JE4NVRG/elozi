import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { activateJournalForForward, materializeForLegacy } from '../src/conversation-journal.js';

function source(label) {
  return { privateHeader: { keep: `synthetic-${label}` }, contacts: [], channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: `synthetic-${label}`, remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1, messages: [] },
      { id: 'sibling', channelId: 'wa', remoteJid: `synthetic-sibling-${label}`, remoteAliases: [], owner: 'queue', status: 'open', version: 1, messages: [{ id: `old-${label}`, kind: 'customer', text: 'synthetic-sibling-history' }] }] };
}
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const base = (db, label = 'a') => JSON.parse(db.prepare('SELECT data FROM tenants WHERE id=?').get(`recovery-tenant-${label}`).data);
function timeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref(); })]).finally(() => clearTimeout(timer));
}
async function boundary(path, nonce, childState) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const value = JSON.parse(readFileSync(path, 'utf8')); if (value.nonce === nonce) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (childState.finished) throw new Error('Synthetic journal child exited before its boundary: ' + childState.stderr);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Synthetic journal child did not publish its owned boundary marker.');
}

test('process crashes recover journal-only commits and both sides of the materialization commit without claiming the raw legacy snapshot was current', { timeout: 60000 }, async t => {
  for (const phase of ['journal', 'before', 'after']) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'elozi-journal-process-'))), nonce = randomUUID(), path = join(directory, 'synthetic-journal.sqlite');
    assert.equal(dirname(directory), realpathSync(tmpdir())); assert.match(basename(directory), /^elozi-journal-process-[A-Za-z0-9]+$/);
    writeFileSync(join(directory, 'owner.json'), JSON.stringify({ kind: 'elozi-journal-process-v1', nonce, directory, database: 'synthetic-journal.sqlite', phase }), { flag: 'wx' });
    let db = new DatabaseSync(path), store, legacyStore, child, closed; const childState = { finished: false, stderr: '' };
    t.after(async () => {
      if (child && !childState.finished) { child.kill('SIGKILL'); await timeout(closed, 5000, 'Owned journal child did not terminate; its fixture was retained.'); }
      db?.close(); store?.close(); legacyStore?.close(); assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir())); rmSync(directory, { recursive: true, force: true });
    });
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);');
    for (const label of ['a', 'b']) {
      db.prepare('INSERT INTO resellers VALUES (?,?)').run(`recovery-workspace-${label}`, '{}');
      db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`recovery-tenant-${label}`, `recovery-workspace-${label}`, JSON.stringify(source(label)));
    }
    db.close(); db = null;
    const env = { UV_THREADPOOL_SIZE: '2', NODE_NO_WARNINGS: '1' };
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
    child = spawn(process.execPath, ['--max-old-space-size=128', '--v8-pool-size=2', fileURLToPath(new URL('./fixtures/conversation-journal-child.mjs', import.meta.url)), '--directory', directory, '--nonce', nonce, '--phase', phase],
      { shell: false, windowsHide: true, cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', data => { childState.stderr = (childState.stderr + data.toString()).slice(-4096); }); child.on('error', error => { childState.stderr = error.message; });
    closed = new Promise(resolve => child.once('close', (code, signal) => { childState.finished = true; resolve({ code, signal }); }));
    const signal = await boundary(join(directory, 'phase.json'), nonce, childState);
    assert.equal(signal.boundary, phase === 'journal' ? 'JOURNAL_COMMITTED' : phase === 'before' ? 'BEFORE_MATERIALIZE_COMMIT' : 'MATERIALIZE_COMMITTED');
    assert.equal(signal.settings.synchronous, 2); assert.equal(signal.settings.journal_mode, 'wal'); assert.equal(signal.settings.foreign_keys, 1);
    assert.equal(childState.finished, false); assert.equal(child.kill('SIGKILL'), true);
    const exit = await timeout(closed, 5000, 'Owned synthetic journal child did not exit after SIGKILL.');
    assert.ok(exit.signal === 'SIGKILL' || Number.isInteger(exit.code) && exit.code !== 0);

    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    const materialized = phase === 'after';
    assert.equal(base(db).conversations[0].messages.length, materialized ? 1 : 0, 'before materialization this plain legacy read is only the old snapshot');
    assert.equal(count(db, 'conversation_journal'), materialized ? 0 : 1); assert.equal(db.prepare('SELECT active FROM conversation_journal_meta WHERE id=1').get().active, materialized ? 0 : 1);
    if (!materialized) {
      const currentOverlay = JSON.parse(db.prepare('SELECT data FROM conversation_journal WHERE tenant_id=?').get('recovery-tenant-a').data);
      assert.equal(currentOverlay.messages.length, 1); assert.equal(currentOverlay.messages[0].id, signal.messageId);
      assert.throws(() => new Store(path), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_ACTIVE');
    } else {
      assert.equal(base(db).conversations[0].messages[0].id, signal.messageId);
      assert.throws(() => new Store(path, { conversationJournal: true }), error => error.code === 'ELOZI_CONVERSATION_JOURNAL_ACTIVATION_REQUIRED');
      legacyStore = new Store(path); assert.equal(legacyStore.tenant({ role: 'reseller', resellerId: 'recovery-workspace-a' }, 'recovery-tenant-a').conversations[0].messages.length, 1); legacyStore.close(); legacyStore = null;
      activateJournalForForward(db); // Explicit synthetic controller activation only after the legacy reader was closed.
    }
    assert.equal(count(db, 'audit'), 1); assert.equal(count(db, 'wa_seen'), 1); assert.equal(count(db, 'conversation_journal_write_guard'), 0);
    assert.deepEqual(base(db, 'b'), source('b')); assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close(); db = null;

    store = new Store(path, { conversationJournal: true });
    const actor = { role: 'reseller', resellerId: 'recovery-workspace-a', name: 'Synthetic recovered actor' }, current = store.readonlyConversationTenant(actor, 'recovery-tenant-a', 'target').conversations[0];
    assert.equal(current.messages.length, 1); assert.equal(current.messages[0].id, signal.messageId); assert.equal(current.messages[0].serviceCommandId, signal.commandId);
    assert.equal(current.version, 2); assert.equal(count(store.db, 'audit'), 1); assert.equal(count(store.db, 'wa_seen'), 1); assert.equal(count(store.db, 'conversation_journal'), 0);
    const receipt = materializeForLegacy(store.db); assert.equal(receipt.active, false); assert.equal(receipt.remainingRows, 0); assert.equal(receipt.before.logicalHash, receipt.after.logicalHash);
    store.close(); store = null;
    db = new DatabaseSync(path); assert.equal(base(db).conversations[0].messages.length, 1); assert.equal(base(db).conversations[0].messages[0].id, signal.messageId);
    assert.equal(count(db, 'audit'), 1); assert.equal(count(db, 'wa_seen'), 1); assert.equal(count(db, 'conversation_journal'), 0); assert.equal(count(db, 'conversation_journal_write_guard'), 0);
    assert.equal(db.prepare('SELECT active FROM conversation_journal_meta WHERE id=1').get().active, 0); assert.deepEqual(base(db).conversations[1], source('a').conversations[1]); assert.deepEqual(base(db, 'b'), source('b'));
    legacyStore = new Store(path); assert.equal(legacyStore.readonlyConversationTenant(actor, 'recovery-tenant-a', 'target').conversations[0].messages.length, 1);
    assert.equal(legacyStore.db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.deepEqual(legacyStore.db.prepare('PRAGMA foreign_key_check').all(), []);
    legacyStore.close(); legacyStore = null; db.close(); db = null;
    t.diagnostic(JSON.stringify({ phase, crash: 'process-SIGKILL', powerLossSimulated: false, committedMessages: 1, audits: 1, duplicates: 0, legacySnapshotBeforeMaterialization: !materialized }));
  }
});
