import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src','scripts','public']) for(const file of await readdir(directory)) if(/\.(?:js|mjs)$/.test(file)) {
  const result=spawnSync(process.execPath,['--check',`${directory}/${file}`],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
console.log('Sintaxe dos módulos validada.');
