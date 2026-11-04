import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';

async function fixture(t){
 const key=randomBytes(32),external=[];
 const blocked=async()=>{external.push('provider');throw Error('External action forbidden in follow-up acceptance');};
 const app=createApp({databasePath:':memory:',publicOrigin:'',serviceKey:key,providerCall:blocked,
  gatewayOptions:{authKey:key,socketFactory:blocked},telegramOptions:{authKey:key,polling:false,fetchImpl:blocked},
  googleOptions:{clientId:''},emailOptions:{key,apiKey:'',from:'',fetchImpl:blocked}});
 const auth=await app.auth.setup({username:'followup-admin',password:'Synthetic-Followup-Password-123!',name:'Follow-up operator'});
 const tenant=app.store.createTenant(auth.actor,{name:'Synthetic follow-up company',segment:'QA'}),other=app.store.createTenant(auth.actor,{name:'Synthetic foreign company',segment:'QA'});
 app.store.mutate(auth.actor,tenant.id,'Synthetic follow-up fixture',state=>{state.channels=[{id:'qa-channel',name:'QA demo',kind:'whatsapp_qr',transport:'baileys',state:'disconnected'}];state.departments=[{id:'support',name:'Suporte'}];state.conversations=[{id:'qa-conversation',contact:'Synthetic contact',channelId:'qa-channel',departmentId:'support',department:'Suporte',status:'open',owner:'human',assignedUserId:auth.actor.userId,assignedUserName:auth.actor.name,version:1,unread:0,tags:[],messages:[],updatedAt:'2026-10-24T12:00:00.000Z'}];});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await Promise.all(['gateway','telegram','telegramUser','email','bridge','emailChannel','meta'].map(name=>app[name]?.close?.()));app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const api=async(path,method='GET',body,token=auth.token)=>{
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Cookie:'mep_session='+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};
 };
 return {app,auth,api,external,tenantId:tenant.id,otherTenantId:other.id};
}

test('HTTP: SaaS support and local quote callbacks persist, replay safely and finish without sending or closing',async t=>{
 const f=await fixture(t),tenant=f.app.store.tenant(f.auth.actor,f.tenantId),conversation=tenant.conversations[0];
 const path=`/api/tenants/${f.tenantId}/conversations/${conversation.id}/follow-ups`;
 const before={messages:JSON.stringify(conversation.messages),owner:conversation.owner,status:conversation.status,unread:conversation.unread};
 for(const kind of ['support','quote']){
  const listed=await f.api(path);assert.equal(listed.status,200);assert.equal(listed.body.canWrite,true);assert.match(listed.cache,/no-store/);
  const input={version:listed.body.version,commandId:`synthetic-${kind}-followup-0001`,kind,title:kind==='support'?'Revisar erro do SaaS':'Retornar orçamento da loja',nextAction:'Retorno manual após verificar o contexto',dueAt:'2026-11-01T14:00:00.000Z'};
  const created=await f.api(path,'POST',input);assert.equal(created.status,201);assert.equal(created.body.item.userId,f.auth.actor.userId);assert.equal(created.body.item.state,'pending');
  const replay=await f.api(path,'POST',input);assert.equal(replay.status,201);assert.deepEqual(replay.body,created.body);
  const fresh=await f.api(path);assert.equal(fresh.body.items.filter(x=>x.id===created.body.item.id).length,1);
  const stale=await f.api(path+'/'+created.body.item.id,'PATCH',{version:input.version,state:'done',outcome:'Must not apply stale edit'});assert.equal(stale.status,409);
  const edited=await f.api(path+'/'+created.body.item.id,'PATCH',{version:created.body.version,state:'pending',nextAction:'Retorno atualizado manualmente',dueAt:null,outcome:''});assert.equal(edited.status,200);assert.equal(edited.body.item.nextAction,'Retorno atualizado manualmente');
  const done=await f.api(path+'/'+created.body.item.id,'PATCH',{version:edited.body.version,state:'done',outcome:kind==='support'?'Cliente recebeu orientação na operação de teste':'Orçamento revisado na operação de teste'});assert.equal(done.status,200);assert.equal(done.body.item.state,'done');
  const after=await f.api(path);assert.equal(after.body.items.find(x=>x.id===created.body.item.id).state,'done');
 }
 const current=f.app.store.tenant(f.auth.actor,f.tenantId).conversations.find(x=>x.id===conversation.id);
 assert.deepEqual({messages:JSON.stringify(current.messages),owner:current.owner,status:current.status,unread:current.unread},before);
 const projected=await f.api(`/api/tenants/${f.tenantId}/conversations/${conversation.id}`);assert.equal(projected.status,200);
 assert.ok(!JSON.stringify(projected.body).includes('followUps'),'private working records stay out of generic conversation projection');
 assert.equal(f.external.length,0);
});

test('HTTP: read-only and foreign-tenant permissions stay authoritative; identity cannot be supplied by the browser',async t=>{
 const f=await fixture(t),conversation=f.app.store.tenant(f.auth.actor,f.tenantId).conversations[0],path=`/api/tenants/${f.tenantId}/conversations/${conversation.id}/follow-ups`;
 await f.app.auth.createUser(f.auth.actor,{username:'followup-reader',password:'Synthetic-Reader-Password-123!',name:'Read-only colleague',role:'operator',tenantIds:[f.tenantId],permissions:['inbox.read']});
 const reader=await f.app.auth.login({username:'followup-reader',password:'Synthetic-Reader-Password-123!'});
 const read=await f.api(path,'GET',undefined,reader.token);assert.equal(read.status,200);assert.equal(read.body.canWrite,false);
 const input={version:read.body.version,commandId:'synthetic-readonly-followup-0001',kind:'task',title:'Forbidden',nextAction:'No action',dueAt:null};
 assert.equal((await f.api(path,'POST',input,reader.token)).status,403);
 assert.equal((await f.api(path.replace('/'+f.tenantId+'/','/'+f.otherTenantId+'/'),'GET',undefined,reader.token)).status,403);
 assert.ok([401,403].includes((await f.api(path,'GET',undefined,null)).status));
 const forged=await f.api(path,'POST',{...input,userId:reader.actor.userId});assert.equal(forged.status,400);
 assert.deepEqual((await f.api(path)).body.items,[]);assert.equal(f.external.length,0);
});
