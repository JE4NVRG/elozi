import test from 'node:test';
import assert from 'node:assert/strict';
import { backup,DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { SupportAccess } from '../src/support-access.js';
import { Operations } from '../src/operations.js';
import { Outbox } from '../src/outbox.js';
const status=code=>error=>error.status===code;
function fixture(t){
  const store=new Store(':memory:');t.after(()=>store.close());let clock=Date.now(),counter=0;
  const auth=new Auth(store.db,{now:()=>clock,validateTenant:(actor,id)=>store.tenant(actor,id)});
  const human=(role='operator',resellerId='mep-demo',tenantIds=[])=>auth.actor(auth.insertUser({username:'support.qa.'+(++counter),name:'Pessoa suporte '+counter},Buffer.alloc(16,counter),Buffer.alloc(64,counter),role,tenantIds,resellerId));
  const admin=human('reseller'),tenant=store.createTenant(admin,{name:'Empresa suporte QA',segment:'Teste'});
  store.mutate(admin,tenant.id,'Fixture: escopos',state=>{state.channels=[{id:'wa',name:'WhatsApp QA',kind:'whatsapp_qr'},{id:'tg',name:'Telegram QA',kind:'telegram'}];state.departments=[{id:'support',name:'Suporte',active:true,memberIds:[],distribution:'manual',version:1},{id:'sales',name:'Vendas',active:true,memberIds:[]}];});
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('support-home',JSON.stringify({...store.reseller(admin),name:'Suporte próprio QA'}));
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('support-company','support-home',JSON.stringify({name:'Empresa do suporte QA',channels:[],agents:[],departments:[],conversations:[]}));
  const person=human('reseller','support-home'),local=human('operator','mep-demo',[tenant.id]);
  const operations=new Operations(store,auth,{now:()=>clock}),changes=[];
  new Outbox(store,{authorize:(actor,id,conversation)=>operations.canReply(actor,id,conversation)});
  const support=new SupportAccess(store,auth,{now:()=>clock,onChange:record=>{changes.push(record);operations.releaseSupportGrant(record);}});
  const input=extra=>({requestId:'fixture-request-'+(++counter),supportUserId:person.userId,tenantIds:[tenant.id],permissions:['inbox.read','inbox.reply','inbox.transfer'],scopeRules:{[tenant.id]:{channelIds:['wa'],departmentIds:['support']}},reason:'Suporte autorizado de teste',ticket:'QA-1',ttlMinutes:60,...extra});
  const grant=extra=>support.create(admin,input(extra));
  const conversation=(extra={})=>{const c={id:'conversation-'+(++counter),channelId:'wa',contact:'Cliente QA',departmentId:'support',department:'Suporte',version:1,status:'open',owner:'queue',assignedUserId:null,messages:[],...extra};store.mutate(admin,tenant.id,'Fixture: conversa',state=>state.conversations.push(c));return c;};
  return {store,auth,admin,tenant,person,local,support,operations,input,grant,conversation,changes,human,advance(ms){clock+=ms;},delegate(record){return auth.workspaceActor(person,record.workspaceId,record.id);},get(id){return operations.conversation(store.tenant(admin,tenant.id),id);}};
}

test('delegação preserva conta e sessão original; contexto escolhido fica operator e escopo exato',t=>{
  const f=fixture(t),before=f.store.db.prepare('SELECT * FROM auth_users ORDER BY id').all(),session=f.auth.session(f.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(f.person.userId));
  const grant=f.grant(),actor=f.delegate(grant);
  assert.equal(actor.role,'operator');assert.equal(actor.platformAdmin,false);assert.equal(actor.supportGrantId,grant.id);assert.deepEqual(actor.tenantIds,[f.tenant.id]);
  assert.deepEqual(f.auth.resolveActor({...actor,role:'reseller',permissions:null}),actor);
  assert.equal(f.auth.can(actor,'inbox.reply',{tenantId:f.tenant.id,channelId:'wa',departmentId:'support'}),true);
  assert.equal(f.auth.can(actor,'inbox.reply',{tenantId:f.tenant.id,channelId:'tg',departmentId:'support'}),false);
  assert.equal(f.auth.can(actor,'inbox.reply',{tenantId:f.tenant.id,channelId:'wa',departmentId:'sales'}),false);
  assert.equal(f.auth.can(actor,'contacts.write',{tenantId:f.tenant.id,channelId:'wa',departmentId:'support'}),false);
  assert.throws(()=>f.auth.admin({...actor,role:'reseller'}),status(403));assert.equal(f.auth.isPlatformAdmin(actor),false);
  assert.equal(f.auth.authenticate(session.token).resellerId,'support-home');assert.equal(f.auth.authenticate(session.token).role,'reseller');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM auth_users ORDER BY id').all(),before);
  const workspaces=f.auth.workspaces(f.person);assert.equal(workspaces.some(item=>item.id==='support-home'&&!item.supportGrantId),true);assert.equal(workspaces.some(item=>item.supportGrantId===grant.id),true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM auth_workspace_access').get().n,0);
});

test('admin atual do workspace concede; identidade forjada e grant de outra pessoa não elevam',t=>{
  const f=fixture(t),grant=f.grant();assert.throws(()=>f.support.create({...f.local,role:'reseller'},f.input()),status(403));
  assert.throws(()=>f.auth.workspaceActor(f.local,f.admin.resellerId,grant.id),status(403));
  assert.throws(()=>f.auth.workspaceActor(f.person,'mep-demo'),status(403));
  assert.throws(()=>f.auth.workspaceActor(f.person,'support-home',grant.id),status(403));
  assert.deepEqual(f.support.list(f.person).grants,[]);assert.throws(()=>f.support.audit(f.person,grant.id),status(404));
  const actor=f.delegate(grant);assert.throws(()=>f.support.create(actor,f.input()),status(403));
});

test('ações, empresas, canais, departamentos, motivo e TTL são explícitos e validados sem efeito parcial',t=>{
  const f=fixture(t),bad=[{permissions:null},{permissions:[]},{scopeRules:null},{scopeRules:{[f.tenant.id]:{channelIds:null,departmentIds:['support']}}},{scopeRules:{[f.tenant.id]:{channelIds:['wa'],departmentIds:[]}}},{scopeRules:{[f.tenant.id]:{channelIds:['missing'],departmentIds:['support']}}},{tenantIds:['support-company'],scopeRules:{'support-company':{channelIds:['wa'],departmentIds:['support']}}},{reason:''},{ttlMinutes:0},{ttlMinutes:1441},{platformAdmin:true}];
  for(const extra of bad)assert.throws(()=>f.support.create(f.admin,f.input(extra)),error=>[400,403,404].includes(error.status));
  assert.equal(f.support.list(f.admin).grants.length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM support_audit').get().n,0);
  const grant=f.grant({ttlMinutes:undefined});assert.equal(Date.parse(grant.expiresAt)-Date.parse(grant.createdAt),3600000);
});

test('criação idempotente conserva prazo e escopo; replay divergente e após fim é bloqueado',t=>{
  const f=fixture(t),input=f.input(),grant=f.support.create(f.admin,input);f.advance(1000);assert.deepEqual(f.support.create(f.admin,input),grant);
  assert.throws(()=>f.support.create(f.admin,{...input,ttlMinutes:120}),status(409));assert.equal(f.store.db.prepare('SELECT count(*) n FROM support_grants').get().n,1);
  f.support.revoke(f.admin,grant.id,{version:grant.version,reason:'Fim de teste'});assert.throws(()=>f.support.create(f.admin,input),status(403));
});

test('revogar usa CAS, audita pessoa real e não alcança workspace diferente',t=>{
  const f=fixture(t),grant=f.grant();assert.throws(()=>f.support.revoke(f.person,grant.id,{version:1,reason:'Outro workspace'}),status(404));
  assert.throws(()=>f.support.revoke(f.admin,grant.id,{version:2,reason:'Versão errada'}),status(409));
  const ended=f.support.revoke(f.admin,grant.id,{version:1,reason:'Suporte concluído'});assert.equal(ended.version,2);assert.equal(ended.state,'revoked');
  assert.throws(()=>f.support.revoke(f.admin,grant.id,{version:1,reason:'Replay'}),status(409));
  const events=f.support.audit(f.admin,grant.id).events;assert.deepEqual(events.map(event=>event.action),['created','revoked']);assert.equal(events[1].actorId,f.admin.userId);assert.equal(f.changes.length,1);
  assert.throws(()=>f.auth.resolveActor({userId:f.person.userId,resellerId:'mep-demo',supportGrantId:grant.id}),status(403));assert.deepEqual(f.support.available(f.person),[]);
});

test('nome editado não amplia nem invalida; mudança de acesso do concedente revoga e não ressuscita',t=>{
  const f=fixture(t),second=f.human('reseller'),grant=f.support.create(second,f.input());f.auth.updateUser(f.admin,second.userId,{name:'Nome atualizado'});assert.equal(f.delegate(grant).role,'operator');
  f.auth.updateUser(f.admin,second.userId,{role:'operator',tenantIds:[f.tenant.id]});assert.throws(()=>f.delegate(grant),status(403));f.auth.updateUser(f.admin,second.userId,{role:'reseller',tenantIds:[]});assert.throws(()=>f.delegate(grant),status(403));
  assert.equal(f.support.sweep().released,1);assert.equal(f.support.audit(f.admin,grant.id).events.at(-1).action,'authority-revoked');
});

test('desativar pessoa de suporte bloqueia grant e reativar não restaura delegação antiga',t=>{
  const f=fixture(t),grant=f.grant(),supportAdmin=f.human('reseller','support-home');f.auth.disableUser(supportAdmin,f.person.userId);assert.throws(()=>f.delegate(grant),status(403));f.auth.reactivateUser(supportAdmin,f.person.userId);assert.throws(()=>f.delegate(grant),status(403));f.support.sweep();assert.equal(f.changes.length,1);
});

test('pessoa delegada aparece no roster de escopo exato e deve assumir explicitamente',t=>{
  const f=fixture(t),grant=f.grant(),actor=f.delegate(grant),c=f.conversation();
  const people=f.operations.assignees(f.admin,f.tenant.id,{channelId:'wa',departmentId:'support'});assert.equal(people.some(person=>person.id===f.person.userId&&person.supportGrantId===grant.id),true);
  assert.equal(f.operations.assignees(f.admin,f.tenant.id,{channelId:'tg',departmentId:'support'}).some(person=>person.id===f.person.userId),false);
  assert.throws(()=>f.operations.canReply(actor,f.tenant.id,c),status(409));
  const assigned=f.operations.assign(actor,f.tenant.id,c.id,{version:1,owner:'human'});assert.equal(assigned.assignedSupportGrantId,grant.id);assert.equal(assigned.assignedUserId,f.person.userId);
  assert.equal(f.operations.canReply(actor,f.tenant.id,assigned),true);assert.equal(f.operations.attendanceSnapshots(actor,f.tenant.id,[assigned]).get(c.id).attendance.canReply,true);
  assert.equal(assigned.attendantEvents[0].actorId,f.person.userId);assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,0);
});

test('expiração bloqueia efeitos antes da varredura; lifecycle devolve somente atendimento desse grant',t=>{
  const f=fixture(t),grant=f.grant({ttlMinutes:1}),actor=f.delegate(grant),c=f.conversation(),other=f.conversation({owner:'human',assignedUserId:f.local.userId,assignedUserName:f.local.name});f.operations.assign(actor,f.tenant.id,c.id,{version:1,owner:'human'});
  f.advance(60000);assert.equal(f.auth.can(actor,'inbox.reply',{tenantId:f.tenant.id,channelId:'wa',departmentId:'support'}),false);assert.throws(()=>f.operations.canReply(actor,f.tenant.id,f.get(c.id)),status(403));
  assert.equal(f.support.sweep().released,1);assert.equal(f.get(c.id).owner,'queue');assert.equal(f.get(c.id).assignedUserId,null);assert.equal(f.get(other.id).assignedUserId,f.local.userId);assert.equal(f.get(c.id).attendantEvents.at(-1).origin,'support-ended');
  assert.equal(f.support.sweep().released,0);assert.equal(f.support.audit(f.admin,grant.id).events.at(-1).action,'expired');assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,0);
});

test('renovação é nova decisão; grant novo não responde em assignment nem participante antigo',t=>{
  const f=fixture(t),old=f.grant({ttlMinutes:1}),oldActor=f.delegate(old),c=f.conversation();f.operations.assign(oldActor,f.tenant.id,c.id,{version:1,owner:'human'});f.advance(60000);
  const fresh=f.grant(),actor=f.delegate(fresh);assert.notEqual(fresh.id,old.id);assert.throws(()=>f.operations.canReply(actor,f.tenant.id,f.get(c.id)),status(409));
  const assumed=f.operations.assign(actor,f.tenant.id,c.id,{version:f.get(c.id).version,owner:'human'});assert.equal(assumed.assignedSupportGrantId,fresh.id);assert.equal(f.operations.canReply(actor,f.tenant.id,assumed),true);
  f.support.sweep();assert.equal(f.get(c.id).assignedSupportGrantId,fresh.id);
});

test('participante suporta grant limitado, preserva vínculo e revogação remove somente ele',t=>{
  const f=fixture(t),grant=f.grant(),actor=f.delegate(grant),c=f.conversation({owner:'human',assignedUserId:f.admin.userId,assignedUserName:f.admin.name});
  const added=f.operations.updateParticipants(f.admin,f.tenant.id,c.id,{version:1,action:'add',userId:f.person.userId});assert.equal(added.participants[0].supportGrantId,grant.id);assert.equal(f.operations.canReply(actor,f.tenant.id,added),true);
  assert.equal(f.operations.attendanceSnapshots(f.admin,f.tenant.id,[added]).get(c.id).participants[0].eligible,true);
  f.support.revoke(f.admin,grant.id,{version:1,reason:'Fim'});assert.deepEqual(f.get(c.id).participants,[]);assert.equal(f.get(c.id).assignedUserId,f.admin.userId);
});

test('directory busca identidade exata sem expor email/grants ou diretório global',t=>{
  const f=fixture(t),username=f.store.db.prepare('SELECT username FROM auth_users WHERE id=?').get(f.person.userId).username;
  const result=f.support.directory(f.admin,{q:username});assert.equal(result.users[0].id,f.person.userId);assert.deepEqual(Object.keys(result.users[0]),['id','name','username']);assert.deepEqual(f.support.directory(f.admin,{q:'support.qa'}).users,[]);assert.throws(()=>f.support.directory(f.admin,{q:'s'}),status(400));
});

test('backup SQLite inclui grants e auditoria, restaura isolamento e FKs sem dados em tenants',async t=>{
  const f=fixture(t),before=f.store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all(),grant=f.grant();assert.deepEqual(f.store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all(),before);
  const directory=await mkdtemp(join(tmpdir(),'elozi-support-'));let restored;t.after(async()=>{restored?.close();await rm(directory,{recursive:true,force:true});});const path=join(directory,'backup.sqlite');await backup(f.store.db,path);restored=new DatabaseSync(path);restored.exec('PRAGMA foreign_keys=ON');
  const store={db:restored,tenant(actor,id){const row=restored.prepare('SELECT * FROM tenants WHERE id=? AND reseller_id=?').get(id,actor.resellerId);if(!row)throw Object.assign(Error('Empresa ausente'),{status:404});return {id,...JSON.parse(row.data)};}},auth=new Auth(restored,{validateTenant:(actor,id)=>store.tenant(actor,id)}),manager=new SupportAccess(store,auth);
  assert.equal(auth.workspaceActor(f.person,'mep-demo',grant.id).supportGrantId,grant.id);assert.equal(manager.audit(f.admin,grant.id).events.length,1);assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
});
