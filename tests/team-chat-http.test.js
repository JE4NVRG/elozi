import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { PostgresBridge } from '../src/postgres-bridge.js';

async function setup(t){
 const key=randomBytes(32),deny=async()=>{throw Error('Synthetic external transport denied');};
 const app=createApp({databasePath:':memory:',serviceKey:key,gatewayOptions:{authKey:key,socketFactory:deny},telegramOptions:{authKey:key,polling:false,fetchImpl:deny},providerCall:deny});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await Promise.all([app.gateway.close(),app.telegram.close(),app.bridge.close(),app.email.close()]);app.store.close();});
 const request=async(path,cookie,body,method=body?'POST':'GET')=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const owner=await request('/api/auth/setup','',{name:'Synthetic admin',username:'teamchat-owner',password:'Synthetic-owner-6789'});assert.equal(owner.status,200);
 const people={};for(const name of ['member','outsider']){const u=await request('/api/users',owner.cookie,{name:'Synthetic '+name,username:'teamchat-'+name,password:'Synthetic-person-6789',role:'operator',tenantIds:['playtech-demo']});assert.equal(u.status,201);people[name]={...u.data,cookie:(await request('/api/auth/login','',{username:'teamchat-'+name,password:'Synthetic-person-6789'})).cookie};}
 const root='/api/tenants/playtech-demo/team-chat';return {app,base,request,owner,people,root};
}

test('HTTP team chat isolates members and authors from attendance/outbox/projection',async t=>{
 const f=await setup(t),{request,owner,people,root,app}=f;
 assert.equal((await request(root+'/rooms','')).status,401);
 assert.equal((await request(root+'/rooms',people.member.cookie,{name:'Unauthorized',memberIds:[]})).status,403);
 const created=await request(root+'/rooms',owner.cookie,{name:'Internal synthetic support',memberIds:[people.member.id]});assert.equal(created.status,201);
 const path=root+'/rooms/'+created.data.id;assert.equal(created.data.members.length,2);
 app.store.db.prepare("UPDATE auth_users SET role='reseller' WHERE id=?").run(people.outsider.id);
 assert.equal((await request(path,people.outsider.cookie)).status,403);
 assert.equal((await request(path+'/messages',people.outsider.cookie)).status,403);
 const original=JSON.stringify(app.store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all());
 const before=app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n;
 const input={version:created.data.version,text:'PRIVATE_TEAM_TEXT_SYNTHETIC',requestId:'team_synthetic_command_001'};
 const sent=await request(path+'/messages',people.member.cookie,input);assert.equal(sent.status,200);assert.equal(sent.data.author.id,people.member.id);assert.equal(sent.data.sequence,1);
 assert.equal((await request(path+'/messages',people.member.cookie,input)).data.id,sent.data.id);
 assert.equal((await request(path+'/messages',people.member.cookie,{...input,text:'Changed payload'})).status,409);
 assert.equal((await request('/api/tenants/studio-demo/team-chat/rooms/'+created.data.id,owner.cookie)).status,404);
 const read=await request(path+'/read',owner.cookie,{sequence:1});assert.equal(read.status,200);assert.equal(read.data.unreadCount,0);
 const removed=await request(path+'/members',owner.cookie,{version:created.data.version,action:'remove',userId:people.member.id});assert.equal(removed.status,200);
 assert.equal((await request(path+'/messages',people.member.cookie,input)).status,403);
 assert.equal(JSON.stringify(app.store.db.prepare('SELECT id,data FROM tenants ORDER BY id').all()),original);
 assert.equal(app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,before);
 const bridge=new PostgresBridge(app.store,{enabled:true,execute:async()=>{}});app.store.queuePostgres('playtech-demo');
 const spool=JSON.stringify(app.store.db.prepare('SELECT * FROM postgres_spool').all());assert.equal(spool.includes(input.text),false);assert.equal(spool.includes(created.data.id),false);await bridge.close();
});

test('company access revocation clears room membership; restoring access does not silently restore private room',async t=>{
 const f=await setup(t),{request,owner,people,root,app}=f;
 const actor=app.auth.authenticate(owner.cookie.split('=')[1]);
 app.store.mutate(actor,'playtech-demo','Synthetic profile assignment',s=>{s.channels=[{id:'profile-channel',name:'Synthetic channel',kind:'whatsapp_qr',state:'planned'}];s.departments=[{id:'support',name:'Synthetic support',active:true,memberIds:[people.member.id]}];s.conversations=[{id:'profile-kept',channelId:'profile-channel',contact:'Synthetic customer',owner:'human',assignedUserId:people.member.id,assignedUserName:people.member.name,departmentId:'support',department:'Synthetic support',status:'open',version:1,tags:[],messages:[]}];});
 const attendanceBefore=JSON.stringify(app.store.tenant(actor,'playtech-demo').conversations);
 const room=(await request(root+'/rooms',owner.cookie,{name:'Private room',memberIds:[people.member.id]})).data;
 assert.equal((await request('/api/users/'+people.member.id,owner.cookie,{name:'Renamed synthetic member',role:'operator',tenantIds:['playtech-demo']},'PATCH')).status,200);
 assert.equal((await request(root+'/rooms/'+room.id,people.member.cookie)).status,200);
 assert.equal(JSON.stringify(app.store.tenant(actor,'playtech-demo').conversations),attendanceBefore);
 assert.equal((await request('/api/users/'+people.member.id,owner.cookie,{permissions:['inbox.read']},'PATCH')).status,200);
 assert.equal(app.store.tenant(actor,'playtech-demo').conversations[0].owner,'queue');
 const retained=await request('/api/auth/login','',{username:'teamchat-member',password:'Synthetic-person-6789'});
 assert.equal((await request(root+'/rooms/'+room.id,retained.cookie)).status,200);
 assert.equal((await request('/api/users/'+people.member.id,owner.cookie,{tenantIds:['studio-demo']},'PATCH')).status,200);
 assert.equal((await request('/api/users/'+people.member.id,owner.cookie,{tenantIds:['playtech-demo']},'PATCH')).status,200);
 const login=await request('/api/auth/login','',{username:'teamchat-member',password:'Synthetic-person-6789'});
 assert.equal((await request(root+'/rooms/'+room.id,login.cookie)).status,403);
 const latest=(await request(root+'/rooms/'+room.id,owner.cookie)).data;assert.equal(latest.members.some(p=>p.id===people.member.id),false);assert.ok(latest.version>room.version);
});

test('logout while room message body is incomplete stops insertion before any private or external effect',async t=>{
 const f=await setup(t),{request,owner,people,root,app}=f;
 const room=(await request(root+'/rooms',owner.cookie,{name:'Session fixture',memberIds:[people.member.id]})).data;
 const token=people.member.cookie.split('=')[1],auth=app.auth.authenticate.bind(app.auth);let entered;
 const seen=new Promise(r=>{entered=r;});app.auth.authenticate=value=>{const result=auth(value);if(value===token)entered();return result;};
 let pending;const response=new Promise((resolve,reject)=>{pending=httpRequest(f.base+root+'/rooms/'+room.id+'/messages',{method:'POST',headers:{'Content-Type':'application/json',Cookie:people.member.cookie,'Transfer-Encoding':'chunked'}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(b)}));});pending.on('error',reject);pending.write('{"version":');});
 await seen;app.auth.logout(token);pending.end('1,"text":"Never committed","requestId":"session_chunked_team_001"}');assert.equal((await response).status,401);
 assert.equal(app.store.db.prepare('SELECT count(*) n FROM team_chat_messages').get().n,0);assert.equal(app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,0);
});

test('logout while receiving a user edit prevents profile and membership side effects',async t=>{
 const {app,base,request,owner,people,root}=await setup(t);
 const room=(await request(root+'/rooms',owner.cookie,{name:'Profile session fixture',memberIds:[people.member.id]})).data;
 const original=app.store.db.prepare('SELECT name,tenant_ids FROM auth_users WHERE id=?').get(people.member.id);
 const token=owner.cookie.split('=')[1],auth=app.auth.authenticate.bind(app.auth);let entered;
 const seen=new Promise(r=>{entered=r;});app.auth.authenticate=value=>{const result=auth(value);if(value===token)entered();return result;};
 let pending;const response=new Promise((resolve,reject)=>{pending=httpRequest(base+'/api/users/'+people.member.id,{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:owner.cookie,'Transfer-Encoding':'chunked'}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(b)}));});pending.on('error',reject);pending.write('{"name":');});
 await seen;app.auth.logout(token);pending.end('"Must not change","tenantIds":["studio-demo"]}');assert.equal((await response).status,401);
 assert.deepEqual(app.store.db.prepare('SELECT name,tenant_ids FROM auth_users WHERE id=?').get(people.member.id),original);
 assert.equal(app.store.db.prepare('SELECT version FROM team_chat_rooms WHERE id=?').get(room.id).version,room.version);
});
