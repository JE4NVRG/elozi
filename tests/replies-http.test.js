import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../src/server.js';
import {resolveReply} from '../src/replies.js';
import {knowledgeMetadataSnapshot} from '../src/postgres-bridge.js';

async function fixture(t){
 const key=randomBytes(32),deny=async()=>{throw Error('External transport forbidden');};
 const app=createApp({databasePath:':memory:',serviceKey:key,gatewayOptions:{authKey:key,socketFactory:deny},telegramOptions:{authKey:key,polling:false,fetchImpl:deny},emailOptions:{apiKey:'',key,fetchImpl:deny}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await Promise.all([app.gateway.close(),app.telegram.close(),app.email.close(),app.bridge.close()]);app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();});
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 const request=async(path,{method='GET',body,cookie=''}={})=>{const res=await fetch(origin+path,{method,headers:{'content-type':'application/json',cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};};
 const owner=await request('/api/auth/setup',{method:'POST',body:{name:'Admin synthetic',username:'replies.qa',password:'Synthetic-'+randomBytes(12).toString('hex')}});assert.equal(owner.status,200);
 const actor=app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
 const tenant=await request('/api/tenants',{method:'POST',cookie:owner.cookie,body:{name:'Replies synthetic',segment:'QA'}});assert.equal(tenant.status,201);
 const id=tenant.data.id,path=`/api/tenants/${id}`,cookie=owner.cookie;
 app.store.mutate(actor,id,'Synthetic fixture',s=>{s.channels=[{id:'channel',kind:'telegram',state:'planned',name:'Sandbox'}];s.conversations=[{id:'conv',channelId:'channel',contact:'Synthetic',owner:'human',assignedUserId:actor.userId,status:'open',version:1,messages:[{id:'original',kind:'customer',text:'Synthetic question',createdAt:new Date().toISOString()}]}];});
 return {app,actor,id,path,cookie,request,api:(s,o={})=>request(path+'/'+s,{cookie,...o})};
}
test('HTTP catalog CAS and privacy: no inactive catalog in bootstrap or projection; cross company reference denied',async t=>{
 const f=await fixture(t),r=await f.api('quick-replies',{method:'POST',body:{shortcut:'hello',title:'Greeting',text:'Synthetic greeting'}});assert.equal(r.status,201);
 assert.equal((await f.api('quick-replies')).data.replies[0].id,r.data.id);
 assert.equal((await f.request(f.path,{cookie:f.cookie})).data.quickReplies,undefined);
 const inactive=await f.api('quick-replies/'+r.data.id,{method:'PATCH',body:{version:r.data.version,active:false}});assert.equal(inactive.status,200);
 assert.equal((await f.api('quick-replies/'+r.data.id,{method:'PATCH',body:{version:1,text:'Stale'}})).status,409);
 const other=await f.request('/api/tenants',{method:'POST',cookie:f.cookie,body:{name:'Other synthetic',segment:'QA'}});
 assert.equal((await f.request(`/api/tenants/${other.data.id}/quick-replies/${r.data.id}`,{method:'PATCH',cookie:f.cookie,body:{version:2,text:'Foreign'}})).status,404);
 assert.equal((await f.request(f.path+'/quick-replies')).status,401);
 const snapshot=knowledgeMetadataSnapshot({quickReplies:[r.data],conversations:[]});assert.equal(snapshot.quickReplies,undefined);
});
test('HTTP reply resolves only local message ids and rejects forged provider context',async t=>{
 const f=await fixture(t),input={text:'Reply synthetic',version:1,channelId:'channel',replyToMessageId:'original',idempotencyKey:randomUUID()};
 assert.equal((await f.api('conversations/conv/messages',{method:'POST',body:{...input,quoted:{key:{id:'forged'}}}})).status,400);
 assert.equal((await f.api('conversations/conv/messages',{method:'POST',body:{...input,replyToMessageId:'foreign'}})).status,404);
 const sent=await f.api('conversations/conv/messages',{method:'POST',body:input});assert.equal(sent.status,200);assert.equal(sent.data.messages.at(-1).replyToMessageId,'original');
 assert.equal(sent.data.messages.at(-1).text,'Reply synthetic');
});
test('reply helper rejects failed/system/foreign references and uses safe media labels',()=>{
 const c={messages:[{id:'x',kind:'system',text:'Hidden'},{id:'f',kind:'human',delivery:'failed'},{id:'m',kind:'customer',attachments:[{kind:'audio'}]}]};
 for(const id of ['x','foreign'])assert.throws(()=>resolveReply(c,{replyToMessageId:id}),e=>e.status===404);
 assert.throws(()=>resolveReply(c,{replyToMessageId:'f'}),e=>e.status===409);
 assert.throws(()=>resolveReply(c,{replyToMessageId:123}),e=>e.status===400);
 assert.equal(resolveReply(c,{replyToMessageId:'m'}).text,'[Áudio]');
 assert.equal(resolveReply(c,{}),null);
});
test('HTTP confirmed quote replay stays idempotent after the original becomes unavailable',async t=>{
 const f=await fixture(t);let sends=0;
 f.app.store.mutate(f.actor,f.id,'Synthetic transport',s=>{s.channels[0].transport='baileys';});
 f.app.gateway.send=async()=>{sends++;return f.app.store.getConversation(f.app.store.tenant(f.actor,f.id),'conv');};
 const input={text:'Synthetic quote replay',version:1,channelId:'channel',replyToMessageId:'original',idempotencyKey:randomUUID()};
 assert.equal((await f.api('conversations/conv/messages',{method:'POST',body:input})).status,200);
 f.app.store.mutate(f.actor,f.id,'Synthetic original removed',s=>{s.conversations[0].messages=[];});
 assert.equal((await f.api('conversations/conv/messages',{method:'POST',body:input})).status,200);
 assert.equal(sends,1);
 assert.equal((await f.api('conversations/conv/messages',{method:'POST',body:{...input,replyToMessageId:'different'}})).status,409);
 assert.equal(sends,1);
});
