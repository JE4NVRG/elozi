import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { createLocalBackup, createPostgresBackup, validateBackup } from '../src/backup.js';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Informe o valor de ${name}.`); return args[index + 1]; };
try {
  const known = new Set(['--postgres', '--validate', '--destination', '--database']);
  for (let index = 0; index < args.length; index++) { if (!known.has(args[index])) throw new Error('Argumento de backup desconhecido.'); if (args[index] !== '--postgres') index++; }
  if (args.includes('--postgres') && (args.includes('--validate') || args.includes('--database'))) throw new Error('Escolha uma operação de backup por execução.');
  const file = option('--validate'), destination = option('--destination');
  let result;
  if (file) result = await validateBackup(resolve(file));
  else if (args.includes('--postgres')) result = await createPostgresBackup({ destination });
  else {
    const db = new DatabaseSync(resolve(option('--database') ?? 'data/sandbox.sqlite'), { readOnly: true });
    try { result = await createLocalBackup(db, { destination }); } finally { db.close(); }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error?.code === 'POSTGRES_SSH_NOT_CONFIGURED') console.error(error.message);
  console.error('Backup não concluído. Nenhum banco ativo foi restaurado ou substituído.'); process.exitCode = 1;
}
