// Standalone pre-start gate. It never starts a server, gateway or provider.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
const image = /^sha256:[a-f0-9]{64}$/;
const identityKeys = ['kind', 'device', 'inode', 'uid', 'mode'];
// Portable schema-1 fingerprints let a stopped legacy image inspect an already
// materialized database without importing code absent from that image.
const journalTables = {
  conversation_journal_meta: 'b740bf7ff9ee255aed73dfc82489a2d4eb5f93f4a54666b511a189eb89018905',
  conversation_journal: '07a62d7e173f56e3072b8b0dbd38d081eff6cd4c5d324a1550c0adf77882b382',
  conversation_journal_write_guard: 'f7b19984aad5d8a26882e280f745b551d0f7090e90d3875def7612d9f2c6980f'
};
const reject = message => { throw Object.assign(new Error(message), { code: 'ELOZI_JOURNAL_PRESTART_REFUSED' }); };

function identity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) reject('A identidade do arquivo SQLite não pôde ser confirmada.');
  return { kind: 'file', device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n) };
}

function verifyIdentity(path, expected) {
  const actual = identity(path);
  if (!expected || identityKeys.some(key => actual[key] !== expected[key])) reject('O arquivo SQLite mudou desde a prova de identidade.');
  return actual;
}

function inspect(db) {
  const names = ['conversation_journal_meta', 'conversation_journal', 'conversation_journal_write_guard'];
  const objects = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name IN (?,?,?)").all(...names);
  if (!objects.length) return { exists: false, active: false, rows: 0 };
  if (objects.length !== names.length || objects.some(row => row.type !== 'table'
      || createHash('sha256').update((row.sql || '').replace(/\r\n/g, '\n').trim().replace(/;$/, '')).digest('hex') !== journalTables[row.name])) reject('O formato do journal é incompleto ou desconhecido.');
  const meta = db.prepare('SELECT id,version,active FROM conversation_journal_meta').all();
  if (meta.length !== 1 || meta[0].id !== 1 || meta[0].version !== 1 || ![0, 1].includes(meta[0].active)) reject('A versão ou o modo do journal é desconhecido.');
  if (db.prepare('SELECT count(*) AS n FROM conversation_journal_write_guard').get().n !== 0) reject('Existe uma guarda de escrita não reconciliada.');
  return { exists: true, active: meta[0].active === 1, rows: db.prepare('SELECT count(*) AS n FROM conversation_journal').get().n };
}

function checkLegacyStatements(db) {
  // Compile, without executing, the tenant DML used by the pinned legacy binary.
  db.prepare('UPDATE tenants SET data=data WHERE 0');
  db.prepare('DELETE FROM tenants WHERE 0');
  db.prepare('INSERT INTO tenants(id,reseller_id,data) SELECT id,reseller_id,data FROM tenants WHERE 0');
}

function health(db) {
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0;
  const quickCheck = db.prepare('PRAGMA quick_check').get().quick_check === 'ok';
  if (!foreignKeys || !quickCheck) reject('A integridade ou as referências SQLite não foram confirmadas.');
  return { foreignKeys, quickCheck };
}

function checkMaterialization(receipt) {
  const required = ['logicalHashPreserved', 'countsPreserved', 'foreignKeys', 'quickCheck', 'synchronousFull', 'sideEffectsPreserved'];
  if (receipt?.schemaVersion !== 1 || receipt.materialized !== true || receipt.active !== false || receipt.remainingRows !== 0
      || required.some(name => receipt.checks?.[name] !== true)) reject('A materialização não forneceu todas as provas de preservação.');
  if (!/^[a-f0-9]{64}$/.test(receipt.before?.logicalHash || '') || receipt.before.logicalHash !== receipt.after?.logicalHash
      || ['tenants', 'conversations', 'messages'].some(name => !Number.isSafeInteger(receipt.before?.[name]) || receipt.before[name] < 0 || receipt.before[name] !== receipt.after?.[name])) reject('Os hashes ou contagens da materialização divergem.');
}

export async function prepareLegacyDatabase(input, { runtimeSource = process.env.MEPCHAT_SOURCE_REVISION,
  loadJournalModule = () => import(new URL('./conversation-journal.js', import.meta.url)) } = {}) {
  if (!input || typeof input.databasePath !== 'string' || !isAbsolute(input.databasePath) || /[\u0000-\u001f]/.test(input.databasePath)
      || !sha.test(input.toolSource || '') || runtimeSource !== input.toolSource || !sha.test(input.targetSource || '') || !image.test(input.targetImage || '')
      || typeof input.forwardActivation !== 'boolean' || input.forwardActivation && (input.targetJournalVersion !== '1' || input.targetStartJournal !== true)) reject('A prova de destino, ferramenta ou modo de inicialização é inválida.');
  const path = resolve(input.databasePath), expected = input.expectedIdentity;
  let db;
  try {
    const beforeIdentity = verifyIdentity(path, expected);
    if (typeof process.getuid === 'function' && process.getuid() !== beforeIdentity.uid) reject('O executor não é o dono do SQLite.');
    db = new DatabaseSync(path, { readOnly: true });
    verifyIdentity(path, expected);
    const state = inspect(db);
    let journal, materialization = null;
    if (state.active || state.rows || input.forwardActivation && state.exists) {
      db.close(); db = null;
      journal = await loadJournalModule();
      if (typeof journal.materializeForLegacy !== 'function' || typeof journal.journalStatus !== 'function') reject('A imagem não contém a ferramenta de recuperação compatível.');
      verifyIdentity(path, expected);
      db = new DatabaseSync(path);
      verifyIdentity(path, expected);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      materialization = journal.materializeForLegacy(db);
      checkMaterialization(materialization);
      const after = journal.journalStatus(db);
      if (after.active || after.rows !== 0) reject('O journal não ficou no modo legado e vazio.');
    }
    const checks = health(db);
    checkLegacyStatements(db);
    let modeAfter = 'legacy';
    if (input.forwardActivation && !state.exists) {
      // The capability-bound new binary creates the opt-in schema on its first boot.
      // Never create it on behalf of an older destination.
      modeAfter = 'journal-pending-initialization';
    } else if (input.forwardActivation) {
      if (typeof journal.activateJournalForForward !== 'function') reject('A ativação explícita não está disponível na imagem.');
      journal.activateJournalForForward(db);
      const after = journal.journalStatus(db);
      if (!after.active || after.rows !== 0) reject('A preparação do modo novo não foi confirmada.');
      modeAfter = 'journal';
    } else {
      const after = inspect(db);
      if (after.active || after.rows !== 0) reject('O destino legado continua protegido por dados pendentes.');
    }
    const afterIdentity = verifyIdentity(path, expected);
    return { schemaVersion: 1, kind: 'elozi-conversation-journal-prestart', toolSource: input.toolSource,
      targetSource: input.targetSource, targetImage: input.targetImage, databaseIdentity: afterIdentity,
      journalExisted: state.exists, modeAfter, materialization,
      checks: { ...checks, identityPreserved: identityKeys.every(key => beforeIdentity[key] === afterIdentity[key]), legacyStatementsCompile: true,
        destinationBound: true, journalClean: true, writerModePrepared: true } };
  } finally { db?.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) reject('Use um único envelope de pré-inicialização.');
    const result = await prepareLegacyDatabase(JSON.parse(process.argv[2]));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error.code || 'ELOZI_JOURNAL_PRESTART_REFUSED', error: 'O retorno seguro não foi comprovado; mantenha o gateway de destino parado.' }) + '\n');
    process.exitCode = 1;
  }
}
