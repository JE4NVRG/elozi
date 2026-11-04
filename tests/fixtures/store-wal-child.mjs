// Disposable process-crash fixture only; never accepts an arbitrary database path.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Store } from '../../src/store.js';

const args = process.argv.slice(2);
assert.equal(args.length, 4); assert.equal(args[0], '--directory'); assert.equal(args[2], '--nonce');
const suppliedDirectory = args[1], nonce = args[3];
assert.ok(isAbsolute(suppliedDirectory)); assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
assert.equal(lstatSync(suppliedDirectory).isSymbolicLink(), false);
const directory = realpathSync(suppliedDirectory);
assert.equal(dirname(directory), realpathSync(tmpdir())); assert.match(basename(directory), /^elozi-wal-process-[A-Za-z0-9]+$/);
const markerPath = join(directory, 'owner.json'), databasePath = join(directory, 'synthetic.sqlite');
for (const path of [markerPath, databasePath]) { assert.equal(lstatSync(path).isSymbolicLink(), false); assert.equal(lstatSync(path).isFile(), true); }
const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
assert.deepEqual(marker, { kind: 'elozi-wal-process-v1', nonce, directory, database: 'synthetic.sqlite' });
assert.equal(typeof process.send, 'function', 'this fixture requires its owning parent IPC channel');

const store = new Store(databasePath), actor = { role: 'reseller', resellerId: 'wal-workspace-a', name: 'Synthetic WAL process' };
const messageId = `committed-${nonce}`, commandId = `synthetic-command-${nonce}`;
store.mutateConversation(actor, 'wal-tenant-a', 'target', 'Synthetic committed process message', conversation => {
  assert.equal(conversation.messages.length, 0); assert.equal(conversation.version, 1);
  conversation.messages.push({ id: messageId, externalId: `provider-${nonce}`, serviceCommandId: commandId, kind: 'agent', text: 'Synthetic process-crash fixture message' });
  conversation.version++; conversation.unread = 1;
});
assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get('wal-tenant-a').n, 1);
assert.equal(store.db.prepare('SELECT count(*) AS n FROM service_conversation_write_guard').get().n, 0);
const settings = Object.fromEntries(['foreign_keys', 'journal_mode', 'synchronous', 'cache_spill', 'page_size', 'wal_autocheckpoint'].map(name => [name, Object.values(store.db.prepare(`PRAGMA main.${name}`).get())[0]]));
// Keep the connection open. The parent kills this process after COMMITTED, before any close/checkpoint.
setInterval(() => {}, 1000);
setTimeout(() => { process.stderr.write('Synthetic WAL parent did not terminate its child in time.\n'); process.exit(3); }, 25000).unref();
process.send({ type: 'COMMITTED', nonce, messageId, commandId, settings, walBytes: statSync(databasePath + '-wal').size });
