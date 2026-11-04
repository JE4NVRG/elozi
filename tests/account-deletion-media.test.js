import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { MediaService, mediaDeletionBackoffMs } from '../src/media.js';
import { captureMediaSnapshot } from '../src/media-backup.js';
import { PostgresBridge } from '../src/postgres-bridge.js';
import { AccountDeletion, classifyTable } from '../src/commercial-account-deletion.js';
import { setLocale } from '../public/i18n.js';
import { deletionErrorMessage, dialogMarkup, ownerSectionMarkup } from '../public/account-deletion-ui.js';

const password = 'Synthetic-Owner-4567!', key = Buffer.alloc(32, 9);

// File-backed app (data/media next to the database), synthetic accounts only.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'elozi-delmedia-'));
  const app = createApp({ databasePath: join(dir, 'app.sqlite'), mediaOptions: { authKey: key } });
  const { store, auth, media } = app;
  const deletion = new AccountDeletion(store, { auth, isPlatformAdmin: () => false, stopChannels: async () => ({ failures: 0 }) });
  t.after(async () => { await app.bridge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = async company => {
    const session = await auth.register({ name: 'Owner', email: `dm-${randomUUID()}@example.test`, password, company }, { provision: input => store.provisionReseller(input) });
    return { actor: session.actor, tenantId: store.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').get(session.actor.resellerId).id };
  };
  // An encrypted attachment as MediaService stores it: one media_attachments row plus data/media/<id>.mepmedia.
  const attach = tenantId => {
    const id = randomUUID();
    store.db.prepare('INSERT INTO media_attachments VALUES (?,?,?,?,?,?,?)').run(id, tenantId, 'conv-1', 'ch-1', 'received', JSON.stringify({ id, kind: 'document', name: 'Contrato Fulano.pdf', status: 'ready', size: 3 }), new Date().toISOString());
    mkdirSync(media.directory, { recursive: true }); writeFileSync(join(media.directory, id + '.mepmedia'), Buffer.alloc(40, 1));
    return { id, path: join(media.directory, id + '.mepmedia') };
  };
  return { dir, app, store, media, deletion, owner, attach };
}

test('media: deleting an account removes its attachment files after COMMIT and leaves other accounts untouched', async t => {
  const f = fixture(t);
  const a = await f.owner('Empresa Midia A'), b = await f.owner('Empresa Midia B');
  const filesA = [f.attach(a.tenantId), f.attach(a.tenantId)], fileB = f.attach(b.tenantId);
  for (const file of [...filesA, fileB]) assert.ok(existsSync(file.path), 'file exists before');
  assert.equal(classifyTable('media_deletion_spool'), 'global', 'the spool survives every workspace deletion');
  const result = await f.deletion.remove(a.actor, a.actor.resellerId, { confirmName: 'Empresa Midia A', password });
  assert.equal(result.counts.mediaFiles, 2);
  for (const file of filesA) assert.ok(!existsSync(file.path), 'file of the deleted account is gone');
  assert.ok(existsSync(fileB.path), 'other account file untouched');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM media_deletion_spool').get().n, 0, 'spool cleared on success');
  assert.ok(f.store.db.prepare('SELECT 1 FROM media_attachments WHERE id=?').get(fileB.id), 'other account row untouched');
  assert.equal(JSON.parse(f.store.db.prepare('SELECT counts FROM account_deletion_audit WHERE workspace_id=?').get(a.actor.resellerId).counts).mediaFiles, 2);
});

test('media: a crash between COMMIT and unlink is completed by the startup sweep; the spool holds no personal data', async t => {
  const f = fixture(t);
  const a = await f.owner('Empresa Queda'), b = await f.owner('Empresa Vizinha');
  const filesA = [f.attach(a.tenantId), f.attach(a.tenantId)], fileB = f.attach(b.tenantId);
  f.store.sweepMediaDeletions = () => { throw new Error('process stopped after COMMIT'); };
  await f.deletion.remove(a.actor, a.actor.resellerId, { confirmName: 'Empresa Queda', password });
  for (const file of filesA) assert.ok(existsSync(file.path), 'files still on disk after the simulated crash');
  const rows = f.store.db.prepare('SELECT * FROM media_deletion_spool ORDER BY attachment_id').all();
  assert.deepEqual(rows.map(row => row.attachment_id), filesA.map(file => file.id).sort());
  assert.deepEqual(Object.keys(rows[0]).sort(), ['attachment_id', 'attempts', 'file', 'last_error', 'next_attempt_at', 'queued_at']);
  assert.doesNotMatch(JSON.stringify(rows), /Fulano|Empresa|tenant_|reseller_|@example/, 'ids and file names only');
  rmSync(filesA[1].path); // already gone: idempotent
  const restarted = new MediaService(f.store, { directory: f.media.directory, authKey: key }); // startup
  const swept = await restarted.sweepDeletionSpool();
  assert.deepEqual(swept, { removed: 1, missing: 1, failed: 0, pending: 0 });
  for (const file of filesA) assert.ok(!existsSync(file.path));
  assert.ok(existsSync(fileB.path), 'other account file untouched');
  assert.deepEqual(await restarted.sweepDeletionSpool(), { removed: 0, missing: 0, failed: 0, pending: 0 }, 'idempotent');
});

test('media: an unlink failure keeps the spool row with attempts and backoff; a live attachment id is never unlinked', async t => {
  const f = fixture(t), now = Date.parse('2026-11-03T12:00:00Z');
  const a = await f.owner('Empresa Falha');
  const stuck = randomUUID(), live = f.attach(a.tenantId);
  mkdirSync(join(f.media.directory, stuck + '.mepmedia')); // unlink() of a directory fails (EPERM/EISDIR)
  f.store.db.prepare("INSERT INTO media_deletion_spool(attachment_id,file,queued_at) VALUES (?,?,?),(?,?,?),('../x','../x.mepmedia',?)")
    .run(stuck, stuck + '.mepmedia', 'q', live.id, live.id + '.mepmedia', 'q', 'q');
  const first = await f.media.sweepDeletionSpool({ now });
  assert.equal(first.failed, 2); assert.equal(first.pending, 2);
  assert.ok(existsSync(live.path), 'referenced attachment kept'); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM media_deletion_spool WHERE attachment_id=?').get(live.id).n, 0);
  const row = f.store.db.prepare('SELECT * FROM media_deletion_spool WHERE attachment_id=?').get(stuck);
  assert.equal(row.attempts, 1); assert.equal(row.next_attempt_at, now + mediaDeletionBackoffMs(1)); assert.ok(row.last_error);
  assert.equal(f.store.db.prepare("SELECT last_error FROM media_deletion_spool WHERE attachment_id='../x'").get().last_error, 'invalid_entry');
  assert.equal((await f.media.sweepDeletionSpool({ now: now + 1000 })).failed, 0, 'no retry before the backoff');
  rmSync(join(f.media.directory, stuck + '.mepmedia'), { recursive: true });
  const later = await f.media.sweepDeletionSpool({ now: now + mediaDeletionBackoffMs(1) });
  assert.equal(later.missing, 1); assert.ok(!f.store.db.prepare('SELECT 1 FROM media_deletion_spool WHERE attachment_id=?').get(stuck));
  assert.equal(mediaDeletionBackoffMs(20), 60 * 60 * 1000, 'capped at 1 h');
});

test('media backup never copies an attachment queued for deletion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elozi-delmedia-bk-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = randomUUID(), snapshot = join(dir, 'snap.sqlite'), db = new DatabaseSync(snapshot);
  db.exec('CREATE TABLE tenants (id TEXT PRIMARY KEY, reseller_id TEXT, data TEXT); CREATE TABLE media_attachments (id TEXT PRIMARY KEY, tenant_id TEXT, conversation_id TEXT, channel_id TEXT, purpose TEXT, metadata TEXT, created_at TEXT)');
  db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('t1', 'r1', JSON.stringify({ conversations: [{ id: 'c1', messages: [{ attachments: [{ id }] }] }] }));
  db.prepare('INSERT INTO media_attachments VALUES (?,?,?,?,?,?,?)').run(id, 't1', 'c1', 'ch', 'received', JSON.stringify({ status: 'ready', size: 3 }), 'x');
  db.close();
  const backupFile = join(dir, 'sqlite-x.mepbackup');
  await assert.rejects(captureMediaSnapshot(snapshot, { backupFile, sourceDirectory: null, key }), /pasta dos anexos/, 'a referenced attachment would be copied');
  const again = new DatabaseSync(snapshot); again.exec("CREATE TABLE media_deletion_spool (attachment_id TEXT PRIMARY KEY, file TEXT NOT NULL, queued_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT)");
  again.prepare('INSERT INTO media_deletion_spool(attachment_id,file,queued_at) VALUES (?,?,?)').run(id, id + '.mepmedia', 'q'); again.close();
  const result = await captureMediaSnapshot(snapshot, { backupFile, sourceDirectory: null, key });
  assert.equal(result.count, 0); assert.ok(!existsSync(backupFile + '.media'));
});

test('PostgreSQL deletion is queued while the bridge is disabled and sent once it is enabled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'elozi-delmedia-pg-'));
  const app = createApp({ databasePath: join(dir, 'app.sqlite'), mediaOptions: { authKey: key } });
  t.after(async () => { await app.bridge.close(); app.store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(app.bridge.enabled, false);
  const tenantId = 'tenant_' + randomUUID(), resellerId = 'reseller_' + randomUUID();
  app.store.queuePostgresDeletion(tenantId, resellerId);
  assert.deepEqual([app.bridge.status().mode, app.bridge.status().state, app.bridge.status().pendingDeletions], ['local', 'disabled', 1]);
  await app.bridge.flush();
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM postgres_deletion_spool WHERE state='pending'").get().n, 1, 'never sent while disabled');
  const calls = [], pool = { connect: async () => ({ query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; }, release() {} }), end: async () => {} };
  const enabled = new PostgresBridge(app.store, { pool });
  await enabled.flush();
  assert.ok(calls.some(call => /delete_workspace_tenant/.test(call.sql) && call.values[1] === tenantId && call.values[0] === resellerId));
  assert.equal(enabled.status().pendingDeletions, 0);
});

test('deletion UI: reconnect notice comes from the error code; backup retention is stated honestly in PT and EN', () => {
  setLocale('pt-BR', { persist: false, notify: false });
  assert.match(deletionErrorMessage({ code: 'account_delete_reconnect_required', message: 'x' }), /precisam ser reconectados/);
  assert.doesNotMatch(deletionErrorMessage({ code: 'account_delete_integrity', message: 'Os canais precisam ser reconectados' }), /reconectados/, 'no text matching');
  assert.match(ownerSectionMarkup(), /Cópias de segurança já feitas não são apagadas na hora/);
  assert.match(dialogMarkup({ name: 'X' }), /não são restauradas para contas excluídas/);
  setLocale('en', { persist: false, notify: false });
  assert.match(deletionErrorMessage({ code: 'account_delete_reconnect_required' }), /must be reconnected/);
  assert.match(dialogMarkup({ name: 'X' }), /Existing backups are not erased immediately.*never restored for deleted accounts/);
  setLocale('pt-BR', { persist: false, notify: false });
});
