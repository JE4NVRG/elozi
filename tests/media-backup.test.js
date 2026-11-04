import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { MediaService } from '../src/media.js';
import { Outbox } from '../src/outbox.js';
import { createLocalBackup, validateBackup } from '../src/backup.js';
import { retainedMediaIds } from '../src/media-backup.js';

const actor = { role: 'reseller', resellerId: 'mep-demo', name: 'Backup mídia QA' };
const fixture = Buffer.from('Arquivo sintético exclusivo de teste, sem dados reais.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'elozi-media-backup-test-'));
  const databaseFile = join(directory, 'source.sqlite'), mediaDirectory = join(directory, 'media'), destination = join(directory, 'backups');
  const store = new Store(databaseFile), key = randomBytes(32), tenant = store.createTenant(actor, { name: 'Backup mídia', segment: 'Fixture' });
  const channelId = randomUUID(), conversationId = randomUUID();
  store.mutate(actor, tenant.id, 'Fixture', state => {
    state.channels.push({ id: channelId, kind: 'telegram', transport: 'telegram-bot' });
    state.conversations.push({ id: conversationId, channelId, owner: 'human', status: 'open', version: 1, messages: [] });
  });
  const media = new MediaService(store, { directory: mediaDirectory, authKey: key }), context = { tenantId: tenant.id, conversationId, channelId };
  t.after(async () => {
    store.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir())); assert.ok(basename(absolute).startsWith('elozi-media-backup-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const upload = (name = 'qa.txt') => media.upload(context, { bytes: fixture, name, mime: 'text/plain' });
  const reference = metadata => store.mutate(actor, tenant.id, 'Fixture anexado', state => state.conversations[0].messages.push({ id: randomUUID(), kind: 'human', text: 'Texto de fixture', attachments: [metadata] }));
  const backup = () => createLocalBackup(store.db, { destination, key, mediaDirectory });
  return { directory, databaseFile, mediaDirectory, destination, store, key, media, context, tenant, upload, reference, backup };
}
const absent = file => assert.rejects(readFile(file), error => error.code === 'ENOENT');

test('backup inclui somente anexos ready referenciados por histórico ou outbox, com cifras e manifesto', async t => {
  const c = await setup(t), historical = await c.upload('histórico.txt'), commanded = await c.upload('comando.txt'), orphan = await c.upload('órfão.txt');
  c.reference(historical);
  const outbox = new Outbox(c.store);
  await outbox.dispatch(actor, c.tenant.id, c.context.conversationId, { text: '', attachmentIds: [commanded.id], channelId: c.context.channelId, version: 1, idempotencyKey: randomUUID() }, async () => true);
  const backup = await c.backup(), metadata = JSON.parse(await readFile(backup.metadataFile, 'utf8'));
  assert.equal(backup.verification.integrity, 'ok'); assert.equal(backup.verification.restoreVerified, true);
  assert.equal(backup.verification.media.restoreVerified, true); assert.equal(backup.verification.media.count, 2);
  assert.equal(metadata.media.count, 2); assert.equal(metadata.media.directory, basename(backup.file) + '.media');
  assert.deepEqual(new Set(metadata.media.files.map(item => item.id)), new Set([historical.id, commanded.id]));
  assert.equal(metadata.media.files.some(item => item.id === orphan.id), false);
  const folder = join(c.destination, metadata.media.directory), manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.owner, 'elozi-media-backup-v1'); assert.equal(manifest.backup, basename(backup.file));
  assert.deepEqual(manifest.files, metadata.media.files);
  for (const entry of metadata.media.files) {
    const encrypted = await readFile(join(folder, entry.file));
    assert.equal(entry.file, entry.id + '.mepmedia'); assert.equal(entry.bytes, fixture.length + 28);
    assert.equal(hash(encrypted), entry.sha256); assert.equal(encrypted.includes(fixture), false);
    assert.deepEqual(encrypted, await readFile(join(c.mediaDirectory, entry.file)));
  }
  assert.equal((await readFile(backup.file)).includes(fixture), false);
  assert.equal(JSON.stringify(metadata).includes(fixture.toString()), false);
  assert.deepEqual(new Set(await retainedMediaIds(c.destination)), new Set([historical.id, commanded.id]));
  assert.equal((await readdir(c.destination)).some(name => name.startsWith('.mepchat-backup-')), false);
});

test('snapshot permanece restaurável depois de remover os cifrados originais', async t => {
  const c = await setup(t), file = await c.upload(); c.reference(file);
  // The default source-directory contract follows the on-disk SQLite parent.
  const backup = await createLocalBackup(c.store.db, { destination: c.destination, key: c.key });
  const snapshotFile = join(c.destination, backup.media.directory, file.id + '.mepmedia'), before = await readFile(snapshotFile);
  await unlink(join(c.mediaDirectory, file.id + '.mepmedia'));
  assert.deepEqual(await readFile(snapshotFile), before);
  const restored = await validateBackup(backup.file, { key: c.key });
  assert.equal(restored.integrity, 'ok'); assert.equal(restored.media.restoreVerified, true); assert.equal(restored.media.count, 1);
  assert.equal(c.store.db.prepare('SELECT count(*) AS count FROM media_attachments').get().count, 1);
  assert.equal((await readdir(c.destination)).some(name => name.startsWith('.mepchat-backup-')), false);
});

test('mídia adulterada falha no SHA e também no GCM se o manifesto for reescrito', async t => {
  const c = await setup(t), file = await c.upload(); c.reference(file);
  const backup = await c.backup(), folder = join(c.destination, backup.media.directory), path = join(folder, file.id + '.mepmedia'), manifestPath = join(folder, 'manifest.json');
  await unlink(join(c.mediaDirectory, file.id + '.mepmedia')); // Never mutate an active hardlink.
  const changed = await readFile(path); changed[changed.length - 1] ^= 1; await writeFile(path, changed);
  await assert.rejects(validateBackup(backup.file, { key: c.key }), /SHA/);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.files[0].sha256 = hash(changed); await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateBackup(backup.file, { key: c.key }));
  await assert.rejects(validateBackup(backup.file, { key: randomBytes(32) }));
  assert.equal((await readdir(c.destination)).some(name => name.startsWith('.mepchat-backup-')), false);
});

test('ausência de mídia ou AAD divergente impede publicar backup incompleto e preserva rollback', async t => {
  const c = await setup(t), file = await c.upload(); c.reference(file);
  const valid = await c.backup(), before = (await readdir(c.destination)).sort(), source = join(c.mediaDirectory, file.id + '.mepmedia');
  const encrypted = await readFile(source); await unlink(source);
  await assert.rejects(c.backup()); assert.deepEqual((await readdir(c.destination)).sort(), before);
  assert.equal((await validateBackup(valid.file, { key: c.key })).media.restoreVerified, true);
  await writeFile(source, encrypted);
  c.store.db.prepare('UPDATE media_attachments SET channel_id=? WHERE id=?').run(randomUUID(), file.id);
  await assert.rejects(c.backup()); assert.deepEqual((await readdir(c.destination)).sort(), before);
  assert.equal((await validateBackup(valid.file, { key: c.key })).media.restoreVerified, true);
});

test('retenção remove pasta de mídia de backup descartável e preserva os dois últimos', async t => {
  const c = await setup(t), file = await c.upload(); c.reference(file);
  const first = await c.backup(), second = await c.backup(), third = await c.backup();
  await absent(first.file); await absent(first.metadataFile);
  await assert.rejects(stat(join(c.destination, first.media.directory)), error => error.code === 'ENOENT');
  for (const backup of [second, third]) {
    assert.equal((await validateBackup(backup.file, { key: c.key })).media.restoreVerified, true);
    assert.equal((await readFile(join(c.destination, backup.media.directory, file.id + '.mepmedia'))).length, fixture.length + 28);
  }
  assert.deepEqual((await c.media.read(file.id, c.context)).bytes, fixture);
  assert.equal(JSON.parse(await readFile(join(c.destination, 'manifest.json'), 'utf8')).entries.length, 2);
});

test('pins e conteúdo desconhecido impedem descarte de backups e de suas pastas de mídia', async t => {
  const c = await setup(t), file = await c.upload(); c.reference(file);
  const pinned = await c.backup(), pinnedMetadata = JSON.parse(await readFile(pinned.metadataFile, 'utf8'));
  pinnedMetadata.pinned = true; pinnedMetadata.references = ['fixture-rollback']; await writeFile(pinned.metadataFile, JSON.stringify(pinnedMetadata));
  const unknown = await c.backup(), unknownFolder = join(c.destination, unknown.media.directory), unknownPath = join(unknownFolder, 'foreign-reference.txt');
  await writeFile(unknownPath, 'conteúdo desconhecido preservado');
  await c.backup(); await c.backup(); await c.backup();
  assert.equal((await validateBackup(pinned.file, { key: c.key })).media.restoreVerified, true);
  assert.equal((await validateBackup(unknown.file, { key: c.key })).media.restoreVerified, true);
  assert.equal(await readFile(unknownPath, 'utf8'), 'conteúdo desconhecido preservado');
  const current = JSON.parse(await readFile(join(c.destination, 'manifest.json'), 'utf8'));
  assert.equal(current.entries.some(entry => entry.id === pinned.id), true); assert.equal(current.entries.some(entry => entry.id === unknown.id), true);
  assert.ok(current.entries.length >= 4);
  const metadata = JSON.parse(await readFile(unknown.metadataFile, 'utf8')); metadata.owner = 'foreign-project'; await writeFile(unknown.metadataFile, JSON.stringify(metadata));
  assert.equal(await retainedMediaIds(c.destination), null); // Fail closed before orphan cleanup.
});
