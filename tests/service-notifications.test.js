import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceNotifications } from '../src/service-notifications.js';
import { WhatsAppGateway, brazilianMobileAliases } from '../src/whatsapp.js';

const status=code=>e=>e.status===code;
const settle=()=>new Promise(r=>setImmediate(r));
const sender='5544999990000',recipient='5544999991111',channel='fp-qr-test';
async function fixture(t,extra={}) {
  const store=new Store(':memory:'),auth=new Auth(store.db,{validateTenant:(a,id)=>store.tenant(a,id)});
  const admin=auth.actor(auth.insertUser({username:'notify.owner',name:'Admin sintético'},Buffer.alloc(16,3),Buffer.alloc(64,3),'reseller',[],'mep-demo'));
  const tenant=store.createTenant(admin,{name:'Family QA',segment:'Sintético'});let clock=Date.now(),socket,sends=0,lookup;
  store.mutate(admin,tenant.id,'Fixture notificações',s=>{s.agents=[{id:'notifier',provider:'mcp',mode:'copilot',configured:true,version:1,tools:[],name:'Notificador'}];s.channels=[{id:channel,kind:'whatsapp_qr',transport:'baileys',expectedNumber:sender,state:'disconnected'},{id:'foreign-qr',kind:'whatsapp_qr',transport:'baileys',expectedNumber:'5544999992222'}];s.conversations=[];});
  const gateway=new WhatsAppGateway(store,{authKey:randomBytes(32),now:()=>clock,socketFactory:config=>{socket={config,ev:new EventEmitter(),ws:{close(){}},end(){},user:{id:sender+'@s.whatsapp.net'},onWhatsApp:async n=>lookup?lookup(n):[{exists:true,jid:brazilianMobileAliases(n).at(-1)+'@s.whatsapp.net'}],sendMessage:async(jid,payload,options)=>{sends++;if(extra.send)return extra.send(jid,payload,options);return {key:{id:options.messageId,remoteJid:jid,fromMe:true}};}};return socket;}});
  const principals=new ServicePrincipals(store,auth,{now:()=>clock}),notifications=new ServiceNotifications(store,principals,gateway,{now:()=>clock});
  const config={name:'Family transactional',agentId:'notifier',capabilities:['notification.send','notification.read','notification.recipient.manage'],channelIds:[channel],departmentIds:null,dailyRequests:extra.dailyRequests||100,maxConcurrent:2,ttlHours:24};
  const created=principals.create(admin,tenant.id,config),actor=principals.authenticate('Bearer '+created.token);
  notifications.configure(admin,tenant.id,created.principal.id,{appOrigin:'https://family.example',productName:'FamilyPoints',revision:0});
  await gateway.start(admin,tenant.id,channel);socket.config.auth.creds.me={id:sender+'@s.whatsapp.net'};socket.ev.emit('creds.update',{});socket.ev.emit('connection.update',{connection:'open'});await settle();
  t.after(async()=>{await gateway.close();store.close();});
  const eligibility=()=>({adult:true,membershipCurrent:true,nonAnonymous:true,nonDemo:true,whatsappOptIn:true,phoneVerified:true,attestedAt:new Date(clock).toISOString()});
  const binding=(id='recipient-qa',number=recipient)=>notifications.bind(actor,id,{accountId:'household-qa',personId:id==='recipient-qa'?'member-qa':'member-'+id,number,revision:0,eligibility:eligibility()});
  const input=(key='event-original')=>({requestId:key,eventId:key,recipientId:'recipient-qa',recipientRevision:1,accountId:'household-qa',personId:'member-qa',channelId:channel,eventType:'request.created',eligibility:eligibility()});
  return {store,auth,admin,tenant,gateway,principals,notifications,created,actor,config,eligibility,binding,input,get sends(){return sends;},get socket(){return socket;},lookup(fn){lookup=fn;},advance(n){clock+=n;}};
}

test('notificação real usa gateway, preserva humano e deduplica evento pela chave original',async t=>{
  const f=await fixture(t);f.binding();
  f.store.mutate(f.admin,f.tenant.id,'Humano existente',s=>s.conversations.push({id:'human-thread',channelId:channel,remoteJid:recipient+'@s.whatsapp.net',conversationKind:'direct',owner:'human',assignedUserId:f.admin.userId,status:'open',departmentId:null,version:4,messages:[]}));
  const input=f.input(),result=await f.notifications.notify(f.actor,input);
  assert.equal(result.state,'confirmed');assert.equal(result.delivery,'sent');assert.equal(result.humanRead,false);assert.equal(result.retryAllowed,false);assert.equal(f.sends,1);
  const c=f.store.tenant(f.admin,f.tenant.id).conversations[0];assert.equal(c.owner,'human');assert.equal(c.assignedUserId,f.admin.userId);assert.match(c.messages[0].text,/https:\/\/family.example\/avisos/);assert.doesNotMatch(c.messages[0].text,/household|member|request|R\$/);
  assert.equal((await f.notifications.notify(f.actor,input)).receiptId,result.receiptId);assert.equal(f.sends,1);
  await assert.rejects(f.notifications.notify(f.actor,{...input,eventType:'contribution.logged'}),status(409));
  const revoked=f.notifications.revoke(f.actor,'recipient-qa',{revision:1});assert.equal(revoked.recipient.active,false);
  assert.equal((await f.notifications.notify(f.actor,input)).state,'confirmed');assert.equal(f.sends,1);
  await assert.rejects(f.notifications.notify(f.actor,f.input('another-event')),status(403));
});

test('timeout é unknown, reinício não reenvia e ACK tardio pode confirmar após opt-out',async t=>{
  const f=await fixture(t,{send:async()=>{throw Error('timeout');}});f.binding();const input=f.input();
  const result=await f.notifications.notify(f.actor,input);assert.equal(result.state,'unknown');assert.equal(f.sends,1);
  await f.notifications.notify(f.actor,input);assert.equal(f.sends,1);
  f.notifications.revoke(f.actor,'recipient-qa',{revision:1});
  f.store.mutate(f.admin,f.tenant.id,'ACK tardio sintético',s=>{s.conversations[0].messages[0].delivery='delivered';});
  const next=new ServiceNotifications(f.store,f.principals,f.gateway);
  const receipt=next.readOutcome(f.actor,input.requestId,channel);assert.equal(receipt.state,'confirmed');assert.equal(receipt.delivery,'delivered');assert.equal(receipt.humanRead,false);assert.equal(f.sends,1);
});

test('revogação durante lookup e número divergente impedem o provedor',async t=>{
  const f=await fixture(t);f.binding();
  f.lookup(async()=>{f.notifications.revoke(f.actor,'recipient-qa',{revision:1});return [{exists:true,jid:recipient+'@s.whatsapp.net'}];});
  assert.equal((await f.notifications.notify(f.actor,f.input())).state,'failed');assert.equal(f.sends,0);
});

test('troca de canal e destinatário retornado diferente falham sem envio',async t=>{
  const f=await fixture(t);f.binding();
  await assert.rejects(f.notifications.notify(f.actor,{...f.input(),channelId:'foreign-qr'}),status(403));
  f.lookup(async()=>[{exists:true,jid:'5544999993333@s.whatsapp.net'}]);
  assert.equal((await f.notifications.notify(f.actor,f.input())).state,'failed');assert.equal(f.sends,0);
});

test('pausa da identidade e troca da política durante lookup bloqueiam o envio',async t=>{
  const f=await fixture(t);f.binding();
  f.lookup(async()=>{f.notifications.configure(f.admin,f.tenant.id,f.created.principal.id,{appOrigin:'https://changed.example',productName:'FamilyPoints',revision:1});return [{exists:true,jid:recipient+'@s.whatsapp.net'}];});
  assert.equal((await f.notifications.notify(f.actor,f.input())).state,'failed');assert.equal(f.sends,0);
  f.lookup(async()=>{f.principals.revoke(f.admin,f.tenant.id,f.created.principal.id,{revision:1});return [{exists:true,jid:recipient+'@s.whatsapp.net'}];});
  await assert.rejects(f.notifications.notify(f.actor,f.input('paused-event')),status(401));assert.equal(f.sends,0);
});

test('telefone trocado exige nova revisão e nunca aceita snapshot anterior',async t=>{
  const f=await fixture(t);f.binding();
  f.notifications.bind(f.actor,'recipient-qa',{accountId:'household-qa',personId:'member-qa',number:'5544999993333',revision:1,eligibility:f.eligibility()});
  await assert.rejects(f.notifications.notify(f.actor,f.input()),status(403));assert.equal(f.sends,0);
  await assert.rejects(f.notifications.notify(f.actor,{...f.input(),recipientRevision:2,accountId:'another-household'}),status(403));assert.equal(f.sends,0);
});

test('escopo, chave, elegibilidade, aliases e CAS do vínculo permanecem isolados',async t=>{
  const f=await fixture(t);const b=f.binding();assert.equal(b.recipient.phoneSuffix,'1111');
  for(const key of ['adult','membershipCurrent','nonAnonymous','nonDemo','whatsappOptIn','phoneVerified']){
    assert.throws(()=>f.notifications.bind(f.actor,'invalid-recipient',{accountId:'household-other',personId:'person-other',number:recipient,revision:0,eligibility:{...f.eligibility(),[key]:false}}),status(403));
  }
  assert.throws(()=>f.binding('another-recipient',brazilianMobileAliases(recipient).at(-1)),status(409));
  const other=f.principals.create(f.admin,f.tenant.id,{...f.config,name:'Outro produto'}),actor=f.principals.authenticate('Bearer '+other.token);
  f.notifications.configure(f.admin,f.tenant.id,other.principal.id,{appOrigin:'https://other.example',productName:'Outro',revision:0});
  assert.throws(()=>f.notifications.readRecipient(actor,'recipient-qa'),status(404));
  assert.throws(()=>f.principals.create(f.admin,f.tenant.id,{...f.config,channelIds:null}),status(400));
  assert.throws(()=>f.principals.create(f.admin,f.tenant.id,{...f.config,channelIds:[channel,'foreign-qr']}),status(400));
  await assert.rejects(f.gateway.sendNotification({},()=>{}),status(403));
  await assert.rejects(f.notifications.notify(f.actor,{...f.input(),eventId:'different-event'}),status(400));
  f.advance(301000);await assert.rejects(f.notifications.notify(f.actor,{...f.input(),eligibility:{...f.eligibility(),attestedAt:new Date(Date.now()-600000).toISOString()}}),status(403));
});

test('concorrência e cota limitam execuções, sem inferência nem envio duplicado',async t=>{
  let release;const f=await fixture(t,{dailyRequests:1,send:async(_jid,_payload,opts)=>{await new Promise(r=>{release=r;});return {key:{id:opts.messageId}};}});f.binding();const input=f.input();
  const first=f.notifications.notify(f.actor,input);while(!release)await settle();
  const duplicate=await f.notifications.notify(f.actor,input);assert.equal(duplicate.state,'dispatched');assert.equal(f.sends,1);
  await assert.rejects(f.notifications.notify(f.actor,f.input('second-event')),status(429));
  release();assert.equal((await first).state,'confirmed');assert.equal(f.sends,1);
});

test('histórico só público do telefone vinculado; mídia exige anexo correto e vínculo ativo',async t=>{
  const f=await fixture(t);f.binding();await f.notifications.notify(f.actor,f.input());
  f.store.mutate(f.admin,f.tenant.id,'Anexos sintéticos',s=>{const c=s.conversations[0];c.messages.push({id:'photo-message',kind:'customer',text:'Comprovante',createdAt:new Date().toISOString(),attachments:[{id:'attachment-qa',kind:'image',mime:'image/png',size:4,url:'private.invalid'}]},{id:'note-private',kind:'system',text:'nota interna',createdAt:new Date().toISOString()});});
  assert.equal(f.notifications.history(f.actor,'recipient-qa').messages.length,2);assert.equal(JSON.stringify(f.notifications.history(f.actor,'recipient-qa')).includes('private.invalid'),false);
  let calls=0;f.notifications.media={read:async()=>{calls++;return {metadata:{mime:'image/png'},bytes:Buffer.from('file')};}};
  await assert.rejects(f.notifications.attachment(f.actor,'recipient-qa','foreign-file'),status(404));assert.equal(calls,0);
  assert.equal((await f.notifications.attachment(f.actor,'recipient-qa','attachment-qa')).bytes.toString(),'file');
  let bytes;f.notifications.media={read:async()=>{f.notifications.revoke(f.actor,'recipient-qa',{revision:1});bytes=Buffer.from('file');return {metadata:{mime:'image/png'},bytes};}};
  await assert.rejects(f.notifications.attachment(f.actor,'recipient-qa','attachment-qa'),status(403));assert.deepEqual(bytes,Buffer.alloc(4));
});
