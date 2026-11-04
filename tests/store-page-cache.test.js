import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const checkpointBytes = 64 * 1024 ** 2;
const setting = (db, name) => Object.values(db.prepare(`PRAGMA main.${name}`).get())[0];

test('page cache and 64MiB checkpoint threshold are connection-local and preserve FULL, spill, WAL and legacy sources', t => {
  for (const pageSize of [4096, 8192]) {
    const directory = mkdtempSync(join(tmpdir(), 'elozi-page-cache-')), path = join(directory, 'synthetic.sqlite');
    let store, raw = new DatabaseSync(path);
    t.after(() => { raw?.close(); store?.close(); rmSync(directory, { recursive: true, force: true }); });
    raw.exec(`PRAGMA page_size=${pageSize}; CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);`);
    raw.prepare('INSERT INTO resellers VALUES (?,?)').run('page-workspace', '{}');
    const source = JSON.stringify({ privateHeader: 'synthetic-preserved', contacts: [], channels: [], agents: [], departments: [], conversations: [] });
    raw.prepare('INSERT INTO tenants VALUES (?,?,?)').run('page-tenant', 'page-workspace', source);
    const defaults = Object.fromEntries(['cache_size', 'synchronous', 'page_size', 'wal_autocheckpoint', 'cache_spill', 'journal_mode'].map(name => [name, setting(raw, name)]));
    assert.equal(defaults.page_size, pageSize); assert.equal(defaults.wal_autocheckpoint, 1000);
    raw.close(); raw = null; store = new Store(path);
    assert.equal(setting(store.db, 'cache_size'), -131072); assert.equal(setting(store.db, 'page_size'), pageSize);
    assert.equal(setting(store.db, 'journal_mode'), 'wal'); assert.equal(setting(store.db, 'foreign_keys'), 1);
    assert.equal(setting(store.db, 'synchronous'), 2, 'FULL commit durability remains enabled');
    assert.ok(setting(store.db, 'cache_spill') > 0, 'spilling remains enabled');
    const threshold = Math.max(1, Math.floor(checkpointBytes / setting(store.db, 'page_size')));
    assert.equal(setting(store.db, 'wal_autocheckpoint'), threshold); assert.equal(threshold * pageSize, checkpointBytes);
    const canonical = store.db.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all();
    assert.equal(canonical[0].data, source);
    // Another connection retains its own defaults even while the configured Store remains open.
    raw = new DatabaseSync(path); assert.equal(setting(raw, 'wal_autocheckpoint'), 1000); assert.equal(setting(raw, 'cache_size'), defaults.cache_size);
    assert.equal(setting(raw, 'synchronous'), 2); assert.ok(setting(raw, 'cache_spill') > 0); raw.close(); raw = null;
    t.diagnostic(JSON.stringify({ sqliteVersion: store.db.prepare('SELECT sqlite_version() AS version').get().version, defaults,
      configured: Object.fromEntries(Object.keys(defaults).map(name => [name, setting(store.db, name)])), checkpointThresholdBytes: threshold * pageSize }));
    store.close(); store = null; raw = new DatabaseSync(path);
    assert.equal(setting(raw, 'cache_size'), defaults.cache_size); assert.equal(setting(raw, 'wal_autocheckpoint'), 1000);
    assert.equal(setting(raw, 'page_size'), pageSize); assert.equal(setting(raw, 'journal_mode'), 'wal'); assert.equal(setting(raw, 'synchronous'), 2);
    assert.ok(setting(raw, 'cache_spill') > 0); assert.deepEqual(raw.prepare('SELECT id,reseller_id,data FROM tenants ORDER BY id').all(), canonical);
    assert.equal(raw.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
    raw.close(); raw = null;
  }
});
