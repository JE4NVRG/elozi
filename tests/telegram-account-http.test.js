import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { channelJourney } from '../public/channel-journey.js';
import { createChannelConnectFlow } from '../public/channel-connect-flow.js';
import { createChannelsUI } from '../public/channels-ui.js';

async function fixture(t){
  const key=randomBytes(32),calls=[],now=Date.now(),deny=async()=>{throw Error('External network forbidden');};
  const app=createApp({databasePath:':memory:',serviceKey:key,providerCall:deny,gatewayOptions:{authKey:key,socketFactory:deny},telegramOptions:{authKey:key,polling:false,fetchImpl:deny},telegramUserOptions:{clientFactory:async()=>({connect:async()=>{},authorized:async()=>true,getMe:async()=>({id:'12345',name:'QA personal'}),exportSession:()=> 'SYNTHETIC_PRIVATE_SESSION',dialogs:async()=>[{id:'81',name:'QA private',type:'private',canSend:true,privatePeer:{type:'private',rawId:'81',accessHash:'PRIVATE_ACCESS_HASH'}},{id:'-100456',name:'QA group',type:'group',canSend:true,privatePeer:{type:'group',peerType:'channel',rawId:'456',accessHash:'PRIVATE_ACCESS_HASH'}}],history:async()=>[{chatId:'81',id:'1',date:Math.floor(now/1000),text:'Synthetic human-only history'}],send:async(peer,input)=>{calls.push(input);return {id:'99'};},disconnect:async()=>{}})}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await Promise.all([app.telegramUser.close(),app.gateway.close(),app.telegram.close(),app.email.close(),app.webchat.close(),app.emailChannel.close(),app.meta.close(),app.bridge.close()]);app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();});
  const request=async(path,{method='GET',body,cookie}={})=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const member=(role='reseller',tenantIds=[])=>{const row=app.auth.insertUser({username:'account.http.'+randomUUID(),name:'QA'},randomBytes(16),randomBytes(64),role,tenantIds,'mep-demo');const s=app.auth.session(app.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));return {cookie:'mep_session='+s.token,actor:s.actor};};
  const owner=member(),tenant=app.store.createTenant(owner.actor,{name:'Personal account HTTP QA',segment:'QA'});
  const created=await request(`/api/tenants/${tenant.id}/channels`,{method:'POST',cookie:owner.cookie,body:{name:'QA personal',kind:'telegram_user',real:true}});assert.equal(created.status,201);
  const channel=created.data,path=`/api/tenants/${tenant.id}/channels/${channel.id}/telegram-account/`;
  const post=(suffix,body,person=owner)=>request(path+suffix,{method:'POST',cookie:person.cookie,body});
  return {app,key,calls,owner,tenant,channel,path,request,post,member};
}

test('personal-account HTTP requires administrator and keeps application credentials encrypted outside tenant DTOs',async t=>{
  const f=await fixture(t),operator=f.member('operator',[f.tenant.id]);
  assert.equal((await f.request(f.path+'status')).status,401);
  assert.equal((await f.request(f.path+'status',{cookie:operator.cookie})).status,403);
  assert.equal((await f.post('configuration',{version:0,apiId:12345,apiHash:'a'.repeat(32)},operator)).status,403);
  const configured=await f.post('configuration',{version:0,apiId:12345,apiHash:'a'.repeat(32)});assert.equal(configured.status,200);assert.equal(configured.data.version,1);assert.equal(configured.data.state,'disconnected');
  assert.equal((await f.post('configuration',{version:0,apiId:12345,apiHash:'a'.repeat(32)})).status,409);
  const dto=await f.request(`/api/tenants/${f.tenant.id}`,{cookie:f.owner.cookie});assert.equal(dto.status,200);assert(!JSON.stringify(dto.data).includes('a'.repeat(32)));
  const vault=await encryptedChannelSecrets(f.app.store.db,f.key);assert.equal(vault.get(`telegram-user:${f.tenant.id}:${f.channel.id}`).apiHash,'a'.repeat(32));
  const raw=f.app.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.tenant.id).data;assert(!raw.includes('apiHash'));assert(!raw.includes('PRIVATE_ACCESS_HASH'));
  const wrongTenant=f.app.store.createTenant(f.owner.actor,{name:'Other QA',segment:'QA'});
  assert.equal((await f.request(`/api/tenants/${wrongTenant.id}/channels/${f.channel.id}/telegram-account/status`,{cookie:f.owner.cookie})).status,404);
});

test('selected personal history reaches human inbox and outbox; unselected chats cannot send and disconnect survives restore',async t=>{
  const f=await fixture(t);assert.equal((await f.post('configuration',{version:0,apiId:12345,apiHash:'a'.repeat(32)})).status,200);
  const login=await f.post('auth/start',{version:1,method:'qr'});assert.equal(login.status,200,login.data.error);assert.equal(login.data.state,'connected');assert.equal(login.data.selectedCount,0);
  assert.equal((await f.post('history',{version:1,limitPerConversation:3})).status,400);
  const dialogs=await f.request(f.path+'dialogs',{cookie:f.owner.cookie});assert.equal(dialogs.status,200);assert.equal(dialogs.data.state,'connected');assert.equal(dialogs.data.dialogs[1].id,'-100456');assert(!JSON.stringify(dialogs.data).includes('PRIVATE_ACCESS_HASH'));
  const selected=await f.post('dialogs',{version:1,peerIds:['81']});assert.equal(selected.status,200);assert.equal(selected.data.version,2);
  const history=await f.post('history',{version:2,limitPerConversation:3});assert.equal(history.status,200,history.data.error);assert.equal(history.data.imported,1);assert.equal(history.data.attachmentsAnalyzed,false);
  let conversation=f.app.store.tenant(f.owner.actor,f.tenant.id).conversations.find(c=>c.channelId===f.channel.id);
  const cp=`/api/tenants/${f.tenant.id}/conversations/${conversation.id}/`;
  const assign=await f.request(cp+'owner',{method:'POST',cookie:f.owner.cookie,body:{version:conversation.version,owner:'human'}});assert.equal(assign.status,200,assign.data.error);conversation=assign.data;
  const sent=await f.request(cp+'messages',{method:'POST',cookie:f.owner.cookie,body:{channelId:f.channel.id,version:conversation.version,text:'Synthetic reply',idempotencyKey:randomUUID()}});assert.equal(sent.status,200,sent.data.error);assert.equal(f.calls.length,1);
  const schedule=await f.request(cp+'scheduled',{method:'POST',cookie:f.owner.cookie,body:{version:sent.data.version,text:'Synthetic schedule',dueAt:new Date(Date.now()+3600000).toISOString(),commandId:randomUUID()}});assert.equal(schedule.status,200,schedule.data.error);
  assert.equal((await f.post('dialogs',{version:2,peerIds:[]})).status,200);
  conversation=f.app.store.tenant(f.owner.actor,f.tenant.id).conversations.find(c=>c.channelId===f.channel.id);
  const denied=await f.request(cp+'messages',{method:'POST',cookie:f.owner.cookie,body:{channelId:f.channel.id,version:conversation.version,text:'Do not send',idempotencyKey:randomUUID()}});assert.equal(denied.status,403);assert.equal(f.calls.length,1);
  assert.equal((await f.post('disconnect',{version:3})).status,200);
  await f.app.telegramUser.restore();assert.equal(f.app.telegramUser.connectedCount(),0);
});

test('personal-account channel has a separate catalog journey and delegates to its own connector',async()=>{
  const channel={id:'personal',kind:'telegram_user',transport:'telegram-user',state:'disconnected'},calls=[];
  assert.equal(channelJourney('telegram_user',[channel]).counts.total,1);assert.equal(channelJourney('telegram',[channel]).counts.total,0);
  const flow=createChannelConnectFlow({connectTelegram:()=>calls.push('bot'),connectTelegramAccount:value=>calls.push(value.id)});assert.equal(await flow.open(channel),true);assert.deepEqual(calls,['personal']);
  const ui=createChannelsUI({state:{workspaceId:'w',boot:{session:{role:'reseller',userId:'u'}},tenant:{id:'t',channels:[channel]}},openTelegramAccount:value=>calls.push(value.id)});
  assert.equal(await ui.act('channels:open','personal'),true);assert.equal(await ui.act('channels:groups','personal'),true);assert.deepEqual(calls,['personal','personal','personal']);
});
