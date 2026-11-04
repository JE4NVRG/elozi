import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { AgentMemory } from '../src/agent-memory.js';
import { createLocalBackup, validateBackup } from '../src/backup.js';

test('encrypted backup restores private memory content, archived state and company boundaries', async t => {
  const parent=resolve(tmpdir()),directory=await mkdtemp(join(parent,'elozi-memory-backup-'));
  const key=randomBytes(32),store=new Store(join(directory,'source.sqlite'));
  t.after(async()=>{store.close();key.fill(0);assert.equal(dirname(resolve(directory)),parent);assert.ok(basename(directory).startsWith('elozi-memory-backup-'));await rm(directory,{recursive:true,force:true});});
  const actor={role:'reseller',resellerId:'mep-demo',userId:'synthetic-reviewer',name:'Revisor sintético'};
  const memory=new AgentMemory(store,{access:()=>true,resolveActor:()=>actor});
  const records=[];
  for(const suffix of ['a','b']){
    const tenant=store.createTenant(actor,{name:`Empresa sintética ${suffix}`,segment:'Backup'});
    store.mutate(actor,tenant.id,'Fixture privada de memória',state=>{
      state.channels=[{id:`channel-${suffix}`,kind:'webchat'}];
      state.agents=[{id:`agent-${suffix}`,name:'Copiloto sintético',provider:'hermes',mode:'copilot',configured:true,version:1}];
      state.contacts=[{id:`contact-${suffix}`,type:'person',version:1,identities:[{channelId:`channel-${suffix}`,kind:'person',externalId:`conversation:conversation-${suffix}`}]}];
      state.conversations=[{id:`conversation-${suffix}`,channelId:`channel-${suffix}`,contactId:`contact-${suffix}`,owner:'human',assignedUserId:actor.userId,status:'open',version:1,messages:[]}];
    });
    const fact=memory.create(actor,tenant.id,`conversation-${suffix}`,{agentId:`agent-${suffix}`,scope:'contact',title:'Preferência revisada',content:`PRIVATE_MEMORY_BACKUP_${suffix}`,conversationVersion:1,reviewed:true,expiresAt:null});
    if(suffix==='b')memory.archive(actor,tenant.id,`conversation-${suffix}`,fact.id,{version:1,conversationVersion:1});
    records.push({tenantId:tenant.id,id:fact.id,suffix});
  }
  const expected=store.db.prepare('SELECT * FROM agent_memories ORDER BY id').all();
  const backup=await createLocalBackup(store.db,{destination:join(directory,'backups'),key});
  const checked=await validateBackup(backup.file,{key});
  assert.equal(checked.restoreVerified,true);assert.equal(checked.foreignKeys,'ok');assert.ok(checked.tables.includes('agent_memories'));
  const bytes=await readFile(backup.file);assert.equal(bytes.includes(Buffer.from('PRIVATE_MEMORY_BACKUP')),false);
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(10,22));decipher.setAAD(bytes.subarray(0,10));decipher.setAuthTag(bytes.subarray(22,38));
  const plaintext=Buffer.concat([decipher.update(bytes.subarray(38)),decipher.final()]);
  const restoredPath=join(directory,'restored.sqlite');await writeFile(restoredPath,plaintext,{flag:'wx'});plaintext.fill(0);
  const restored=new DatabaseSync(restoredPath,{readOnly:true});
  try{
    assert.deepEqual(restored.prepare('SELECT * FROM agent_memories ORDER BY id').all(),expected);
    assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);
    for(const r of records){const row=restored.prepare('SELECT data FROM agent_memories WHERE reseller_id=? AND tenant_id=? AND id=?').get(actor.resellerId,r.tenantId,r.id);const fact=JSON.parse(row.data);assert.equal(fact.content,`PRIVATE_MEMORY_BACKUP_${r.suffix}`);assert.equal(fact.status,r.suffix==='b'?'archived':'active');assert.equal(fact.version,r.suffix==='b'?2:1);}
    assert.equal(restored.prepare('SELECT data FROM agent_memories WHERE tenant_id=? AND id=?').get(records[0].tenantId,records[1].id),undefined);
    assert.equal(JSON.stringify(restored.prepare('SELECT data FROM tenants').all()).includes('PRIVATE_MEMORY_BACKUP'),false);
  }finally{restored.close();}
});
