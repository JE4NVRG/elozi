import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createLocalBackup, createPostgresBackup, validateBackup, postgresBackupArgs } from '../src/backup.js';

const postgresEnv = Object.freeze({ MEPCHAT_POSTGRES_SSH_HOST: 'db-host.example.test' });

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mepchat-backup-test-')), key = randomBytes(32), db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE tenants(id TEXT PRIMARY KEY); CREATE TABLE contacts(id TEXT PRIMARY KEY,tenant_id TEXT REFERENCES tenants(id));');
  db.prepare('INSERT INTO tenants VALUES(?)').run('qa-only'); db.prepare('INSERT INTO contacts VALUES(?,?)').run('contact-qa', 'qa-only');
  t.after(async () => { db.close(); assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('mepchat-backup-test-')); await rm(directory, { recursive: true, force: true }); });
  return { directory, key, db };
}

test('snapshot SQLite consistente é cifrado, restaurado em temporário e live permanece utilizável', async t => {
  const c = await setup(t), backup = await createLocalBackup(c.db, { destination: c.directory, key: c.key });
  assert.equal(backup.verification.integrity, 'ok'); assert.equal(backup.verification.restoreVerified, true);
  assert.deepEqual(backup.verification.tables, ['contacts', 'tenants']);
  const encrypted = await readFile(backup.file); assert.equal(encrypted.includes(Buffer.from('contact-qa')), false);
  assert.equal(encrypted.subarray(0, 8).toString(), 'MEPCHATB');
  const validated = await validateBackup(backup.file, { key: c.key }); assert.equal(validated.foreignKeys, 'ok');
  assert.equal(c.db.prepare('SELECT count(*) AS n FROM contacts').get().n, 1);
  c.db.prepare('INSERT INTO contacts VALUES(?,?)').run('still-live', 'qa-only');
  assert.equal((await readdir(c.directory)).some(name => name.startsWith('.mepchat-backup-')), false);
  assert.equal(JSON.stringify(JSON.parse(await readFile(backup.metadataFile, 'utf8'))).includes('contact-qa'), false);
});

test('chave incorreta e adulteração falham autenticadas sem deixar plaintext', async t => {
  const c = await setup(t), backup = await createLocalBackup(c.db, { destination: c.directory, key: c.key });
  await assert.rejects(validateBackup(backup.file, { key: randomBytes(32) }));
  const changed = await readFile(backup.file); changed[changed.length - 1] ^= 1; await writeFile(backup.file, changed);
  await assert.rejects(validateBackup(backup.file, { key: c.key }));
  assert.equal((await readdir(c.directory)).some(name => name.startsWith('.mepchat-backup-')), false);
});

test('retém dois backups verificados e preserva arquivos desconhecidos, pinned e SHA divergente', async t => {
  const c = await setup(t), options = { destination: c.directory, key: c.key };
  // Retention orders by createdAt. The fixture's chronological backups must not depend on a host
  // clock that can move backwards while the filesystem and encryption work is being exercised.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 8, 12) });
  const create = () => { t.mock.timers.tick(1000); return createLocalBackup(c.db, options); };
  const first = await create(), second = await create(), third = await create();
  await assert.rejects(readFile(first.file), error => error.code === 'ENOENT');
  assert.ok((await readFile(second.file)).length); assert.ok((await readFile(third.file)).length);
  await writeFile(join(c.directory, 'unknown.sqlite'), 'fixture unknown');
  const metadata = JSON.parse(await readFile(second.metadataFile, 'utf8')); metadata.pinned = true; await writeFile(second.metadataFile, JSON.stringify(metadata));
  await create(); assert.ok((await readFile(second.file)).length);
  const changed = await readFile(third.file); changed[changed.length - 1] ^= 1; await writeFile(third.file, changed);
  await create(); await create();
  assert.ok((await readFile(third.file)).length); assert.equal(await readFile(join(c.directory, 'unknown.sqlite'), 'utf8'), 'fixture unknown');
});

test('falha de FK e manifesto alheio são preservados e nenhum snapshot inválido é publicado', async t => {
  const c = await setup(t); c.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO contacts VALUES('bad','missing');");
  await assert.rejects(createLocalBackup(c.db, { destination: c.directory, key: c.key }), /integridade/);
  assert.deepEqual(await readdir(c.directory), []);
  await writeFile(join(c.directory, 'manifest.json'), JSON.stringify({ owner: 'other-project', entries: [] }));
  await assert.rejects(createLocalBackup(c.db, { destination: c.directory, key: c.key }), /não pertence/);
  assert.equal(JSON.parse(await readFile(join(c.directory, 'manifest.json'), 'utf8')).owner, 'other-project');
});

test('PostgreSQL usa somente pg_dump mepchat por stub e não declara restore verificado', async t => {
  const c = await setup(t), calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(Buffer.from('PGDMPsynthetic-custom-archive')); child.stderr.end(); child.emit('close', 0); }); return child;
  };
  const backup = await createPostgresBackup({ destination: c.directory, key: c.key, spawnImpl, env: postgresEnv });
  assert.equal(calls[0].command, 'ssh'); assert.deepEqual(calls[0].args, [...postgresBackupArgs(postgresEnv)]);
  assert.equal(calls[0].args[4], 'db-host.example.test');
  assert.equal(calls[0].args.at(-1), 'docker exec supabase-db pg_dump -U supabase_admin -d mepchat -Fc');
  assert.equal(backup.verification.restoreVerified, false); assert.equal(backup.verification.integrity, 'archive_header_ok');
  assert.equal((await readFile(backup.file)).includes(Buffer.from('PGDMPsynthetic')), false);
  assert.equal((await readdir(c.directory)).some(name => /\.dump$|\.sqlite$/.test(name)), false);
});

test('backup recente adulterado não substitui o segundo rollback realmente válido', async t => {
  const c = await setup(t), options = { destination: c.directory, key: c.key };
  const first = await createLocalBackup(c.db, options), second = await createLocalBackup(c.db, options);
  const corrupt = await readFile(second.file); corrupt[corrupt.length - 1] ^= 1; await writeFile(second.file, corrupt);
  const third = await createLocalBackup(c.db, options);
  assert.equal((await validateBackup(first.file, { key: c.key })).integrity, 'ok');
  assert.equal((await validateBackup(third.file, { key: c.key })).integrity, 'ok');
  assert.ok((await readFile(second.file)).length);
});

test('origem SQLite readonly, como na CLI, produz snapshot sem alterar o banco', async t => {
  const c = await setup(t), file = join(c.directory, 'source.sqlite'), source = new DatabaseSync(file);
  source.exec("CREATE TABLE fixture(id TEXT PRIMARY KEY); INSERT INTO fixture VALUES('qa');"); source.close();
  const readonly = new DatabaseSync(file, { readOnly: true });
  try { assert.equal((await createLocalBackup(readonly, { destination: join(c.directory, 'backups'), key: c.key })).verification.integrity, 'ok'); }
  finally { readonly.close(); }
});

test('PostgreSQL backup is disabled without MEPCHAT_POSTGRES_SSH_HOST and honours MEPCHAT_POSTGRES_CONTAINER', async t => {
  const c = await setup(t);
  await assert.rejects(createPostgresBackup({ destination: c.directory, key: c.key, env: {}, spawnImpl: () => assert.fail('spawned') }),
    error => error.code === 'POSTGRES_SSH_NOT_CONFIGURED' && /MEPCHAT_POSTGRES_SSH_HOST/.test(error.message));
  assert.deepEqual(await readdir(c.directory), []);
  const args = postgresBackupArgs({ MEPCHAT_POSTGRES_SSH_HOST: 'db-host.example.test', MEPCHAT_POSTGRES_CONTAINER: 'pg-main' });
  assert.equal(args.at(-1), 'docker exec pg-main pg_dump -U supabase_admin -d mepchat -Fc'); assert.equal(Object.isFrozen(args), true);
  assert.throws(() => postgresBackupArgs({ MEPCHAT_POSTGRES_SSH_HOST: '-oProxyCommand=id' }), /not a valid ssh host/);
});
