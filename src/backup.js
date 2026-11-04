import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, unlink, rm, lstat, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadLocalKey } from './wa-auth.js';
import { captureMediaSnapshot, validateMediaSnapshot, removeMediaSnapshot } from './media-backup.js';
import { postgresSshTarget } from './ssh-postgres.js';

const OWNER = 'mepchat-backup-v1', MAGIC = Buffer.from('MEPCHATB'), DEFAULT_DESTINATION = resolve('data/backups');
const queues = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ownedName = name => typeof name === 'string' && /^(sqlite|postgres)-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{12}\.mepbackup$/.test(name) && basename(name) === name;
async function backupKey(key) { const value = key ?? await loadLocalKey(); if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error('Chave de backup inválida.'); return value; }
function envelope(bytes, key, kind) {
  const header = Buffer.concat([MAGIC, Buffer.from([1, kind])]), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header); const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), payload]);
}
function decrypt(bytes, key) {
  if (bytes.length < 39 || !bytes.subarray(0, 8).equals(MAGIC) || bytes[8] !== 1 || ![1, 2].includes(bytes[9])) throw new Error('Envelope de backup não reconhecido.');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(10, 22)); cipher.setAAD(bytes.subarray(0, 10)); cipher.setAuthTag(bytes.subarray(22, 38));
  return { kind: bytes[9], plaintext: Buffer.concat([cipher.update(bytes.subarray(38)), cipher.final()]) };
}
function inspectSQLite(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Snapshot SQLite não passou na integridade ou nas chaves estrangeiras.');
    return { integrity: 'ok', foreignKeys: 'ok', tables: db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), restoreVerified: true };
  } finally { db.close(); }
}
async function tempDirectory(parent) { return mkdtemp(join(parent, '.mepchat-backup-')); }
async function removeOwnTemp(directory, parent) {
  if (dirname(directory) !== resolve(parent) || !basename(directory).startsWith('.mepchat-backup-')) throw new Error('Temporário fora do escopo de backup.');
  await rm(directory, { recursive: true, force: true });
}
async function regular(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Artefato de backup não é um arquivo regular.'); }

/** Restores only into its own disposable temporary SQLite; never opens the live DB. */
export async function validateBackup(file, { key } = {}) {
  const target = resolve(file); await regular(target);
  const { kind, plaintext } = decrypt(await readFile(target), await backupKey(key));
  if (kind === 2) {
    try {
      if (!plaintext.subarray(0, 5).equals(Buffer.from('PGDMP'))) throw new Error('Arquivo PostgreSQL não está no formato custom.');
      return { integrity: 'archive_header_ok', tables: [], restoreVerified: false };
    } finally { plaintext.fill(0); }
  }
  const temporary = await tempDirectory(dirname(target));
  try { const snapshot = join(temporary, 'restore.sqlite'); await writeFile(snapshot, plaintext, { flag: 'wx', mode: 0o600 }); const checked=inspectSQLite(snapshot); const media=await validateMediaSnapshot(snapshot,{backupFile:target,key:await backupKey(key)});return {...checked,media}; }
  finally { plaintext.fill(0); await removeOwnTemp(temporary, dirname(target)); }
}

async function manifestAt(directory) {
  const file = join(directory, 'manifest.json');
  try {
    await regular(file); const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.owner !== OWNER || value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Manifesto de backup não pertence a este pipeline; preservado.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { owner: OWNER, version: 1, entries: [] }; throw error; }
}
async function saveManifest(directory, manifest) {
  const temporary = join(directory, `.manifest-${randomBytes(6).toString('hex')}.tmp`);
  try { await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, join(directory, 'manifest.json')); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function retention(directory, manifest, key) {
  const eligible = [], removed = [];
  for (const entry of [...manifest.entries].reverse()) {
    if (entry.type !== 'sqlite' || entry.verification?.integrity !== 'ok' || !ownedName(entry.file) || entry.owner !== OWNER) continue;
    const file = join(directory, entry.file), metadataFile = file + '.json';
    try {
      await regular(file); await regular(metadataFile);
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
      if (metadata.owner !== OWNER || metadata.id !== entry.id || metadata.sha256 !== entry.sha256 || hash(await readFile(file)) !== entry.sha256) continue;
      if ((await validateBackup(file, { key })).integrity !== 'ok') continue;
      eligible.push({ entry, metadata, file, metadataFile });
    } catch { /* Unknown, changed or unreadable artifacts are preserved. */ }
  }
  // Stable order resolves identical timestamps in favor of the newest manifest entry.
  eligible.sort((a, b) => String(b.entry.createdAt).localeCompare(String(a.entry.createdAt)));
  for (const { entry, metadata, file, metadataFile } of eligible.slice(2)) {
    if (entry.disposable !== true || metadata.disposable !== true || entry.pinned || metadata.pinned || !Array.isArray(entry.references) || !Array.isArray(metadata.references) || entry.references.length || metadata.references.length) continue;
    try { await removeMediaSnapshot(file,metadata.media);await unlink(file); await unlink(metadataFile); removed.push(entry.id); }
    catch { /* Preserve the manifest record when cleanup cannot be completed. */ }
  }
  manifest.entries = manifest.entries.filter(entry => !removed.includes(entry.id)); return removed;
}
function exclusive(directory, task) {
  const previous = queues.get(directory) ?? Promise.resolve(), pending = previous.catch(() => {}).then(task);
  queues.set(directory, pending);
  return pending.finally(() => { if (queues.get(directory) === pending) queues.delete(directory); });
}
async function persist(directory, bytes, key, type, createdAt, manifest, mediaSource) {
  const id = `${type}-${createdAt.replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`, filename = `${id}.mepbackup`, file = join(directory, filename);
  const encrypted = envelope(bytes, key, type === 'sqlite' ? 1 : 2);
  await writeFile(file, encrypted, { flag: 'wx', mode: 0o600 });
  let media;
  try { if(mediaSource)media=await captureMediaSnapshot(mediaSource.snapshot,{backupFile:file,sourceDirectory:mediaSource.directory,key}); }
  catch(error){await unlink(file).catch(()=>{});throw error;}
  const checked = await validateBackup(file, { key });
  const metadata = { owner: OWNER, id, type, file: filename, createdAt, sha256: hash(encrypted), bytes: encrypted.length, verification: checked, disposable: type === 'sqlite', pinned: false, references: [],...(media?{media}:{}) };
  await writeFile(file + '.json', JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  manifest.entries.push(metadata); await saveManifest(directory, manifest);
  const removed = await retention(directory, manifest, key); if (removed.length) await saveManifest(directory, manifest);
  return { ...metadata, file, metadataFile: file + '.json', retentionRemoved: removed };
}

/** VACUUM INTO captures committed data while the application connection stays open. */
export async function createLocalBackup(db, { destination = DEFAULT_DESTINATION, key, mediaDirectory } = {}) {
  const directory = resolve(destination);
  return exclusive(directory, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const encryptionKey = await backupKey(key), manifest = await manifestAt(directory);
    const expected = Number(Object.values(db.prepare('PRAGMA page_count').get())[0]) * Number(Object.values(db.prepare('PRAGMA page_size').get())[0]);
    const disk = await statfs(directory, { bigint: true }); if (disk.bavail * disk.bsize < BigInt(expected) * 3n) throw new Error('Espaço insuficiente para snapshot e backup cifrado.');
    const temporary = await tempDirectory(directory);
    try {
      const file = join(temporary, 'snapshot.sqlite'); db.prepare('VACUUM INTO ?').run(file);
      inspectSQLite(file); const bytes = await readFile(file);
      try { const source=db.prepare('PRAGMA database_list').all().find(item=>item.name==='main')?.file;return await persist(directory, bytes, encryptionKey, 'sqlite', new Date().toISOString(), manifest,{snapshot:file,directory:mediaDirectory??(source?join(dirname(source),'media'):null)}); }
      finally { bytes.fill(0); }
    } finally { await removeOwnTemp(temporary, directory); }
  });
}

/** Same deployment configuration as the SSH bridge: MEPCHAT_POSTGRES_SSH_HOST (required) and MEPCHAT_POSTGRES_CONTAINER. */
export function postgresBackupArgs(env = process.env) {
  const { host, container } = postgresSshTarget(env);
  return Object.freeze(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `docker exec ${container} pg_dump -U supabase_admin -d mepchat -Fc`]);
}
function postgresBytes(spawnImpl, maxBytes, args) {
  return new Promise((resolveDump, reject) => {
    const child = spawnImpl('ssh', [...args], { stdio: ['ignore', 'pipe', 'pipe'] }), chunks = []; let size = 0;
    child.stderr.resume();
    child.on('error', () => reject(new Error('Não foi possível iniciar o backup PostgreSQL exclusivo.')));
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) { child.kill(); reject(new Error('Dump PostgreSQL excedeu o limite.')); } else chunks.push(chunk); });
    child.on('close', code => code === 0 && size <= maxBytes ? resolveDump(Buffer.concat(chunks)) : reject(new Error('Backup PostgreSQL exclusivo falhou.')));
  });
}
/** Explicit CLI operation only. PostgreSQL stays in memory and encrypted on disk. */
export async function createPostgresBackup({ destination = DEFAULT_DESTINATION, key, spawnImpl = spawn, maxBytes = 256 * 1024 * 1024, env = process.env } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 5) throw new Error('Limite do backup PostgreSQL inválido.');
  const args = postgresBackupArgs(env);
  const directory = resolve(destination);
  return exclusive(directory, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const encryptionKey = await backupKey(key), manifest = await manifestAt(directory), bytes = await postgresBytes(spawnImpl, maxBytes, args);
    try {
      if (!bytes.subarray(0, 5).equals(Buffer.from('PGDMP'))) throw new Error('Dump PostgreSQL não está no formato custom.');
      return await persist(directory, bytes, encryptionKey, 'postgres', new Date().toISOString(), manifest);
    } finally { bytes.fill(0); }
  });
}
