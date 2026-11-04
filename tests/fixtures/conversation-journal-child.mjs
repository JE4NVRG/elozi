// Owned disposable journal/process-crash fixture; no arbitrary database path is accepted.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Store } from '../../src/store.js';
import { materializeForLegacy } from '../../src/conversation-journal.js';

const args = process.argv.slice(2);
assert.equal(args.length, 6); assert.equal(args[0], '--directory'); assert.equal(args[2], '--nonce'); assert.equal(args[4], '--phase');
const supplied = args[1], nonce = args[3], phase = args[5];
assert.ok(isAbsolute(supplied)); assert.equal(lstatSync(supplied).isSymbolicLink(), false); assert.match(nonce, /^[0-9a-f-]{36}$/);
assert.ok(['journal', 'before', 'after'].includes(phase));
const directory = realpathSync(supplied); assert.equal(dirname(directory), realpathSync(tmpdir())); assert.match(basename(directory), /^elozi-journal-process-[A-Za-z0-9]+$/);
const markerPath = join(directory, 'owner.json'), databasePath = join(directory, 'synthetic-journal.sqlite');
for (const path of [markerPath, databasePath]) { assert.equal(lstatSync(path).isFile(), true); assert.equal(lstatSync(path).isSymbolicLink(), false); }
assert.deepEqual(JSON.parse(readFileSync(markerPath, 'utf8')), { kind: 'elozi-journal-process-v1', nonce, directory, database: 'synthetic-journal.sqlite', phase });
const store = new Store(databasePath, { conversationJournal: true }), actor = { role: 'reseller', resellerId: 'recovery-workspace-a', name: 'Synthetic journal child' };
store.db.exec('CREATE TABLE wa_seen(channel_id TEXT NOT NULL,remote_jid TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_jid,message_id))');
const messageId = `journal-message-${nonce}`, commandId = `journal-command-${nonce}`;
store.mutateConversation(actor, 'recovery-tenant-a', 'target', 'Synthetic committed journal message', conversation => {
  store.db.prepare('INSERT INTO wa_seen VALUES (?,?,?)').run('wa', 'synthetic-jid', messageId);
  assert.equal(conversation.messages.length, 0); conversation.messages.push({ id: messageId, externalId: `journal-provider-${nonce}`, serviceCommandId: commandId, kind: 'agent', text: 'synthetic-journal-recovery-message' }); conversation.version++;
});
assert.equal(store.db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n, 1);
assert.equal(store.db.prepare('SELECT json_array_length(data,\'$.conversations[0].messages\') AS n FROM tenants WHERE id=?').get('recovery-tenant-a').n, 0);
const stopAt = boundary => {
  const settings = Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys'].map(name => [name, Object.values(store.db.prepare(`PRAGMA main.${name}`).get())[0]]));
  writeFileSync(join(directory, 'phase.json'), JSON.stringify({ nonce, boundary, messageId, commandId, settings }), { flag: 'wx' });
  // Synchronous marker publication lets the parent SIGKILL while a materialization transaction is still open.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25000);
  throw new Error('Owning parent did not terminate the synthetic child at its declared boundary.');
};
if (phase === 'journal') stopAt('JOURNAL_COMMITTED');
if (phase === 'before') {
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => { if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) stopAt('BEFORE_MATERIALIZE_COMMIT'); return exec(sql); };
  materializeForLegacy(store.db);
}
if (phase === 'after') { materializeForLegacy(store.db); stopAt('MATERIALIZE_COMMITTED'); }
