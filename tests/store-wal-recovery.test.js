import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

function source(label) {
  return { privateHeader: { keep: `synthetic-private-${label}` }, contacts: [], channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', configured: true }], departments: [],
    conversations: [{ id: 'target', channelId: 'wa', remoteJid: `synthetic-${label}`, remoteAliases: [], owner: 'agent', agentId: 'agent', status: 'open', version: 1, unread: 0, messages: [] },
      { id: 'untouched', channelId: 'wa', remoteJid: `synthetic-old-${label}`, remoteAliases: [], owner: 'queue', status: 'open', version: 1,
        messages: [{ id: `old-${label}`, kind: 'customer', text: `synthetic-preserved-history-${label}` }] }] };
}
function timeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref(); })]).finally(() => clearTimeout(timer));
}
const setting = (db, name) => Object.values(db.prepare(`PRAGMA main.${name}`).get())[0];
const canonical = (db, label) => JSON.parse(db.prepare('SELECT data FROM tenants WHERE id=?').get(`wal-tenant-${label}`).data);

test('SIGKILL after a committed Store mutation recovers one message and its audit from WAL, then the application continues without replay', { timeout: 30000 }, async t => {
  // This is process termination, not a power-loss or storage-controller durability test.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'elozi-wal-process-'))), nonce = randomUUID(), path = join(directory, 'synthetic.sqlite');
  assert.equal(dirname(directory), realpathSync(tmpdir())); assert.match(basename(directory), /^elozi-wal-process-[A-Za-z0-9]+$/);
  writeFileSync(join(directory, 'owner.json'), JSON.stringify({ kind: 'elozi-wal-process-v1', nonce, directory, database: 'synthetic.sqlite' }), { flag: 'wx' });
  let raw = new DatabaseSync(path), store, child, closed, finished = false, stderr = '';
  t.after(async () => {
    if (child && !finished) { child.kill('SIGKILL'); await timeout(closed, 5000, 'Owned synthetic child did not terminate; fixture retained.'); }
    raw?.close(); store?.close();
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  raw.exec(`PRAGMA foreign_keys=ON; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);`);
  for (const label of ['a', 'b']) {
    raw.prepare('INSERT INTO resellers VALUES (?,?)').run(`wal-workspace-${label}`, '{}');
    raw.prepare('INSERT INTO tenants VALUES (?,?,?)').run(`wal-tenant-${label}`, `wal-workspace-${label}`, JSON.stringify(source(label)));
  }
  raw.close(); raw = null;
  // Only OS runtime/temp values are inherited; no application credentials or external database configuration.
  const env = { UV_THREADPOOL_SIZE: '2', NODE_NO_WARNINGS: '1' };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  child = spawn(process.execPath, ['--max-old-space-size=128', '--v8-pool-size=2', fileURLToPath(new URL('./fixtures/store-wal-child.mjs', import.meta.url)), '--directory', directory, '--nonce', nonce],
    { shell: false, windowsHide: true, cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.on('error', () => {});
  closed = new Promise(resolve => child.once('close', (code, signal) => { finished = true; resolve({ code, signal }); }));
  const committed = await timeout(new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', onMessage); child.off('error', onError); child.off('close', onClose); };
    const onMessage = message => { if (message?.type === 'COMMITTED' && message.nonce === nonce) { cleanup(); resolve(message); } };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Synthetic child exited before COMMITTED: ' + stderr)); };
    child.on('message', onMessage); child.once('error', onError); child.once('close', onClose);
  }), 15000, 'Synthetic child did not report a committed transaction.');
  assert.equal(finished, false); assert.equal(committed.messageId, `committed-${nonce}`); assert.equal(committed.commandId, `synthetic-command-${nonce}`);
  assert.equal(committed.settings.journal_mode, 'wal'); assert.equal(committed.settings.foreign_keys, 1); assert.equal(committed.settings.synchronous, 2); assert.ok(committed.settings.cache_spill > 0);
  assert.equal(committed.settings.wal_autocheckpoint, Math.max(1, Math.floor(64 * 1024 ** 2 / committed.settings.page_size)));
  assert.ok(committed.walBytes > 32); assert.equal(statSync(path + '-wal').size, committed.walBytes);
  assert.ok(committed.walBytes < 64 * 1024 ** 2, 'fixture remains below the configured automatic threshold; no manual checkpoint is requested');
  assert.equal(child.kill('SIGKILL'), true);
  const exit = await timeout(closed, 5000, 'Owned synthetic child did not exit after SIGKILL.');
  assert.ok(exit.signal === 'SIGKILL' || Number.isInteger(exit.code) && exit.code !== 0, 'the child was forcibly terminated, not gracefully closed');

  // A plain legacy SQLite connection is the first reader after the crash, with its own defaults.
  raw = new DatabaseSync(path); raw.exec('PRAGMA foreign_keys=ON');
  assert.equal(setting(raw, 'wal_autocheckpoint'), 1000); assert.equal(setting(raw, 'foreign_keys'), 1);
  const recovered = canonical(raw, 'a'), messages = recovered.conversations[0].messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].id, committed.messageId); assert.equal(messages[0].serviceCommandId, committed.commandId);
  assert.equal(recovered.conversations[0].version, 2); assert.deepEqual(recovered.privateHeader, source('a').privateHeader);
  assert.deepEqual(recovered.conversations[1], source('a').conversations[1]); assert.deepEqual(canonical(raw, 'b'), source('b'));
  assert.equal(raw.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=? AND action=?').get('wal-tenant-a', 'Synthetic committed process message').n, 1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM audit').get().n, 1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_conversation_write_proof'").get().n, 0);
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(raw.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  raw.close(); raw = null;

  store = new Store(path); const actor = { role: 'reseller', resellerId: 'wal-workspace-a', name: 'Synthetic recovery actor' };
  assert.deepEqual(store.readonlyConversationTenant(actor, 'wal-tenant-a', 'target').conversations[0], recovered.conversations[0]);
  store.mutateConversation(actor, 'wal-tenant-a', 'target', 'Synthetic after-recovery update', conversation => {
    assert.equal(conversation.messages.filter(message => message.serviceCommandId === committed.commandId).length, 1); conversation.unread = 0;
  });
  const continued = canonical(store.db, 'a'); assert.equal(continued.conversations[0].messages.length, 1); assert.equal(continued.conversations[0].messages[0].id, committed.messageId);
  assert.equal(continued.conversations[0].unread, 0); assert.deepEqual(continued.privateHeader, recovered.privateHeader); assert.deepEqual(canonical(store.db, 'b'), source('b'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit WHERE action=?').get('Synthetic committed process message').n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit WHERE action=?').get('Synthetic after-recovery update').n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  t.diagnostic(JSON.stringify({ crash: 'process-SIGKILL', powerLossSimulated: false, walBytesBeforeKill: committed.walBytes, recoveredMessages: messages.length, originalCommitAudits: 1 }));
});
