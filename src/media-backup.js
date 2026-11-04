import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,link,copyFile,lstat,readdir,unlink,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {effectiveTenantDataSql} from './conversation-journal.js';

const owner='elozi-media-backup-v1',uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const folderFor=backupFile=>resolve(dirname(backupFile),basename(backupFile)+'.media');
const regular=async path=>{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Arquivo de mídia de backup inválido.');};
function snapshotRows(snapshotFile) {
  const db=new DatabaseSync(snapshotFile,{readOnly:true});
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='media_attachments'").get())return [];
    const references=new Set();
    if(db.prepare('PRAGMA table_info(tenants)').all().some(column=>column.name==='data'))for(const row of db.prepare(`SELECT ${effectiveTenantDataSql(db,'t')} AS data FROM tenants t`).all())for(const conversation of JSON.parse(row.data).conversations||[])for(const message of conversation.messages||[])for(const attachment of message.attachments||[])references.add(attachment.id);
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='outbound_commands'").get())for(const row of db.prepare('SELECT payload FROM outbound_commands').all())for(const id of JSON.parse(row.payload).attachmentIds||[])references.add(id);
    // Files of deleted accounts (media_deletion_spool) are never copied into a new backup, even if still referenced.
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='media_deletion_spool'").get())for(const row of db.prepare('SELECT attachment_id FROM media_deletion_spool').all())references.delete(row.attachment_id);
    return db.prepare('SELECT * FROM media_attachments').all().filter(row=>references.has(row.id)&&JSON.parse(row.metadata).status==='ready').map(row=>{
      if(!uuid.test(row.id))throw Error('Identificador de mídia inválido no snapshot.');
      return {...row,metadata:JSON.parse(row.metadata)};
    });
  }finally{db.close();}
}
function verifyCipher(blob,row,key) {
  if(blob.length<29||blob.length>16*1024*1024+28)throw Error('Mídia cifrada fora do limite.');
  const decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));
  decipher.setAAD(Buffer.from(JSON.stringify([row.id,row.tenant_id,row.conversation_id,row.channel_id])));decipher.setAuthTag(blob.subarray(12,28));
  const bytes=Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]);
  try{if(bytes.length!==row.metadata.size)throw Error('Tamanho da mídia divergente.');}finally{bytes.fill(0);}
}
/** Immutable encrypted files share blocks with the active volume when hardlinks are supported. */
export async function captureMediaSnapshot(snapshotFile,{backupFile,sourceDirectory,key}) {
  const rows=snapshotRows(snapshotFile),folder=folderFor(backupFile),created=[];
  if(!rows.length)return {owner,files:[],count:0,restoreVerified:true};
  if(!sourceDirectory)throw Error('O backup precisa da pasta dos anexos referenciados.');
  await mkdir(folder,{mode:0o700});
  try {
    const files=[];
    for(const row of rows){
      const name=row.id+'.mepmedia',source=join(resolve(sourceDirectory),name),target=join(folder,name);
      await regular(source);
      try{await link(source,target);}catch(error){if(!['EXDEV','EPERM','ENOTSUP','EACCES'].includes(error.code))throw error;await copyFile(source,target,constants.COPYFILE_EXCL);}
      created.push(target);await regular(target);const blob=await readFile(target);verifyCipher(blob,row,key);
      files.push({id:row.id,file:name,sha256:sha(blob),bytes:blob.length});
    }
    const manifest={owner,backup:basename(backupFile),files};
    const manifestFile=join(folder,'manifest.json');await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});created.push(manifestFile);
    return {owner,directory:basename(folder),files,count:files.length,restoreVerified:true};
  }catch(error){for(const file of created.reverse())await unlink(file).catch(()=>{});await rmdir(folder).catch(()=>{});throw error;}
}
export async function validateMediaSnapshot(snapshotFile,{backupFile,key}) {
  const rows=snapshotRows(snapshotFile);
  if(!rows.length)return {count:0,restoreVerified:true};
  const folder=folderFor(backupFile),folderInfo=await lstat(folder);
  if(!folderInfo.isDirectory()||folderInfo.isSymbolicLink())throw Error('Pasta de mídia do backup inválida.');
  await regular(join(folder,'manifest.json'));
  const manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
  if(manifest.owner!==owner||manifest.backup!==basename(backupFile)||!Array.isArray(manifest.files)||manifest.files.length!==rows.length)throw Error('Manifesto de mídia do backup inválido.');
  for(const row of rows){const entry=manifest.files.find(item=>item.id===row.id);if(!entry||entry.file!==row.id+'.mepmedia')throw Error('Anexo ausente no backup.');const path=join(folder,entry.file);await regular(path);const blob=await readFile(path);if(sha(blob)!==entry.sha256||blob.length!==entry.bytes)throw Error('SHA de mídia do backup divergente.');verifyCipher(blob,row,key);}
  return {count:rows.length,restoreVerified:true};
}
/** Called only after the parent backup has passed all ownership, hash, pin and restore gates. */
export async function removeMediaSnapshot(backupFile,media) {
  if(!media?.count)return;
  if(media.owner!==owner||media.directory!==basename(folderFor(backupFile)))throw Error('Mídia de backup alheia; preservada.');
  const folder=folderFor(backupFile),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Pasta alheia; preservada.');
  const manifestPath=join(folder,'manifest.json');await regular(manifestPath);const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.owner!==owner||manifest.backup!==basename(backupFile)||JSON.stringify(manifest.files)!==JSON.stringify(media.files))throw Error('Manifesto alterado; preservado.');
  const names=await readdir(folder),expected=['manifest.json',...media.files.map(file=>file.file)];
  if(names.length!==expected.length||names.some(name=>!expected.includes(name)))throw Error('Arquivo desconhecido; pasta preservada.');
  for(const entry of media.files){if(!uuid.test(entry.id)||entry.file!==entry.id+'.mepmedia')throw Error('Nome inválido; preservado.');const path=join(folder,entry.file);await regular(path);if(sha(await readFile(path))!==entry.sha256)throw Error('Arquivo alterado; preservado.');}
  for(const entry of media.files)await unlink(join(folder,entry.file));await unlink(manifestPath);await rmdir(folder);
}
/** Unknown backup state disables orphan cleanup rather than authorizing deletion. */
export async function retainedMediaIds(directory) {
  try {
    const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
    if(manifest.owner!=='mepchat-backup-v1'||!Array.isArray(manifest.entries))return null;
    const ids=new Set();
    for(const entry of manifest.entries){
      if(typeof entry.file!=='string'||basename(entry.file)!==entry.file||entry.owner!==manifest.owner)return null;
      const metadata=JSON.parse(await readFile(join(directory,entry.file+'.json'),'utf8'));
      if(metadata.owner!==manifest.owner||metadata.id!==entry.id||metadata.sha256!==entry.sha256)return null;
      for(const file of metadata.media?.files||[]){if(!uuid.test(file.id))return null;ids.add(file.id);}
    }
    return [...ids];
  }catch(error){return error.code==='ENOENT'?null:null;}
}
