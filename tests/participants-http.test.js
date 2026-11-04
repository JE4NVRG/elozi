import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createApp} from '../src/server.js';
import {request as httpRequest} from 'node:http';

async function fixture(t){
 const key=randomBytes(32),deny=async()=>{throw Error('Synthetic transport denied');};
 const app=createApp({databasePath:':memory:',serviceKey:key,gatewayOptions:{authKey:key,socketFactory:deny},telegramOptions:{authKey:key,polling:false,fetchImpl:deny},providerCall:deny});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await Promise.all([app.gateway.close(),app.telegram.close(),app.bridge.close(),app.email.close()]);app.store.close();});
 const request=async(path,cookie,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await request('/api/auth/setup','',{name:'Owner synthetic',username:'owner-participants',password:'Synthetic-owner-4567'});assert.equal(setup.status,200);
 const cookies={admin:setup.cookie},users={};
 for(const name of ['alice','bob','foreign']){const user=await request('/api/users',cookies.admin,{username:'participant-'+name,password:'Synthetic-person-4567',name:'Synthetic '+name,role:'operator',tenantIds:[name==='foreign'?'studio-demo':'playtech-demo']});assert.equal(user.status,201);users[name]=user.data;cookies[name]=(await request('/api/auth/login','',{username:'participant-'+name,password:'Synthetic-person-4567'})).cookie;}
 const actor=app.auth.actor(app.store.db.prepare('SELECT * FROM auth_users WHERE username=?').get('owner-participants'));
 app.store.mutate(actor,'playtech-demo','Synthetic attendance',s=>{s.channels=[{id:'synthetic-channel',name:'Synthetic origin',kind:'whatsapp_qr',state:'planned'}];s.departments=[{id:'support',name:'Support synthetic',active:true,memberIds:[users.alice.id,users.bob.id]}];s.conversations=[{id:'shared',channelId:'synthetic-channel',contact:'Synthetic customer',owner:'human',assignedUserId:users.alice.id,assignedUserName:users.alice.name,departmentId:'support',department:'Support synthetic',status:'open',version:1,tags:[],messages:[]}];});
 const path='/api/tenants/playtech-demo/conversations/shared';return {app,request,cookies,users,actor,path,base,conversation:()=>app.store.tenant(actor,'playtech-demo').conversations[0]};
}

test('HTTP participant lifecycle preserves owner, grants replies and notes, forbids ownership actions and revalidates removal',async t=>{
 const f=await fixture(t),{request,cookies,users,path}=f;
 assert.equal((await request(path+'/participants',cookies.foreign)).status,403);
 assert.equal((await request(path+'/participants',cookies.bob,{version:1,action:'add',userId:users.bob.id})).status,403);
 const added=await request(path+'/participants',cookies.alice,{version:1,action:'add',userId:users.bob.id,reason:'Second opinion'});assert.equal(added.status,200);assert.equal(added.data.assignedUserId,users.alice.id);assert.equal(added.data.participants[0].userId,users.bob.id);assert.deepEqual(added.data.attendanceAccess,{canReply:true,canManageParticipants:true});
 const tenant=await request('/api/tenants/playtech-demo',cookies.bob);assert.equal(tenant.status,200);assert.equal(tenant.data.conversations[0].attendanceAccess.canReply,true);assert.equal(tenant.data.conversations[0].attendanceAccess.canManageParticipants,false);
 const note=await request(path+'/notes',cookies.bob,{version:2,text:'Private synthetic note',commandId:'note_collaborator'});assert.equal(note.status,200);assert.equal(note.data.messages.at(-1).kind,'internal');assert.equal(note.data.messages.at(-1).userId,users.bob.id);
 const reply=await request(path+'/messages',cookies.bob,{version:3,text:'Synthetic response',channelId:'synthetic-channel'});assert.equal(reply.status,200);assert.equal(reply.data.messages.at(-1).authorUserId,users.bob.id);assert.equal(reply.data.assignedUserId,users.alice.id);
 const version=f.conversation().version;
 assert.equal((await request(path+'/owner',cookies.bob,{version,owner:'human'})).status,409);
 assert.equal((await request(path+'/details',cookies.bob,{version,status:'closed'})).status,403);
 assert.equal((await request(path+'/scheduled',cookies.bob,{version,text:'Scheduled synthetic',commandId:'schedule_collaborator',dueAt:new Date(Date.now()+120000).toISOString()})).status,409);
 const removed=await request(path+'/participants',cookies.alice,{version,action:'remove',userId:users.bob.id});assert.equal(removed.status,200);assert.deepEqual(removed.data.participants,[]);
 const count=f.conversation().messages.length;
 assert.equal((await request(path+'/messages',cookies.bob,{version:removed.data.version,text:'Forbidden after removal',channelId:'synthetic-channel'})).status,409);
 assert.equal((await request(path+'/notes',cookies.bob,{version:2,text:'Private synthetic note',commandId:'note_collaborator'})).status,409);
 assert.equal(f.conversation().messages.length,count);
 assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM outbound_commands').get().n,0);
});

test('logout while receiving the body blocks participant mutation after initial authentication',async t=>{
 const f=await fixture(t),token=f.cookies.alice.split('=')[1],authenticate=f.app.auth.authenticate.bind(f.app.auth);
 let authenticated;const seen=new Promise(r=>authenticated=r);
 f.app.auth.authenticate=value=>{const actor=authenticate(value);if(value===token)authenticated();return actor;};
 let pending;
 const response=new Promise((resolve,reject)=>{pending=httpRequest(f.base+f.path+'/participants',{method:'POST',headers:{Cookie:f.cookies.alice,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(body)}));});pending.on('error',reject);pending.write('{"version":');});
 await seen;f.app.auth.logout(token);pending.end('1,"action":"add","userId":'+JSON.stringify(f.users.bob.id)+'}');
 assert.equal((await response).status,401);assert.equal(f.conversation().version,1);assert.deepEqual(f.conversation().participants||[],[]);
});

test('logout during asynchronous bridge gate blocks live dispatch before adapter and confirmed replay',async t=>{
 const f=await fixture(t);assert.equal((await f.request(f.path+'/participants',f.cookies.alice,{version:1,action:'add',userId:f.users.bob.id})).status,200);
 f.app.store.mutate(f.actor,'playtech-demo','Synthetic real transport',s=>{s.channels[0].transport='baileys';s.conversations[0].remoteJid='5511940000000@s.whatsapp.net';});
 let sends=0;f.app.gateway.send=async()=>{sends++;throw Error('Must not send');};
 f.app.bridge.flush=async()=>{f.app.auth.logout(f.cookies.bob.split('=')[1]);};
 const result=await f.request(f.path+'/messages',f.cookies.bob,{version:2,channelId:'synthetic-channel',text:'Never sent synthetic',idempotencyKey:'logout_gate_synthetic_016'});
 assert.equal(result.status,401);assert.equal(sends,0);assert.equal(f.conversation().messages.length,0);
 const command=f.app.store.db.prepare('SELECT state,attempts FROM outbound_commands').get();assert.equal(command.state,'failed');assert.equal(command.attempts,0);
});

test('HTTP CAS, revoke and close/reopen cannot revive stored collaboration or leak transport identities',async t=>{
 const f=await fixture(t),{request,cookies,users,path}=f;
 const add=await request(path+'/participants',cookies.admin,{version:1,action:'add',userId:users.bob.id});assert.equal(add.status,200);
 assert.equal((await request(path+'/participants',cookies.alice,{version:1,action:'remove',userId:users.bob.id})).status,409);
 const closed=await request(path+'/details',cookies.alice,{version:2,status:'closed',reason:'Done synthetic'});assert.equal(closed.status,200);assert.deepEqual(closed.data.participants,[]);assert.equal(closed.data.attendanceAccess.canReply,false);
 const reopened=await request(path+'/details',cookies.alice,{version:3,status:'open'});assert.equal(reopened.status,200);assert.equal(reopened.data.owner,'queue');assert.deepEqual(reopened.data.participants,[]);assert.equal(reopened.data.attendanceAccess.canReply,false);
 assert.equal((await request(path+'/owner',cookies.alice,{version:4,owner:'human'})).status,200);
 assert.equal((await request(path+'/participants',cookies.alice,{version:5,action:'add',userId:users.bob.id})).status,200);
 f.app.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']),users.bob.id);
 const snapshot=await request('/api/tenants/playtech-demo',cookies.bob);assert.equal(snapshot.status,200);assert.equal(snapshot.data.conversations[0].attendanceAccess.canReply,false);assert.deepEqual(snapshot.data.conversations[0].participants,[]);
 assert.equal((await request(path+'/messages',cookies.bob,{version:6,text:'Revoked synthetic',channelId:'synthetic-channel'})).status,403);
 assert.equal(snapshot.data.conversations[0].remoteJid,undefined);assert.equal(snapshot.data.conversations[0].scheduledMessages,undefined);
 const changed=await request('/api/users/'+users.bob.id+'/disable',cookies.admin,{});assert.equal(changed.status,200);assert.equal(f.conversation().participants.length,0);assert.equal(f.conversation().assignedUserId,users.alice.id);
});
