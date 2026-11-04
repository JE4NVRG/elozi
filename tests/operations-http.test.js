import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const denyExternal = async () => { throw new Error('External transport forbidden in fixture'); };
const expectedNumber = '5511999990000';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const key = randomBytes(32), sockets = [], deliveries = [], lookups = [];
  const app = createApp({
    databasePath: ':memory:', publicOrigin: '', serviceKey: key, providerCall: denyExternal,
    gatewayOptions: { authKey: key, reconnectDelay: 10, socketFactory: () => {
      const socket = { ev: new EventEmitter(), user: { id: expectedNumber + ':1@s.whatsapp.net' }, end() {}, async logout() {} };
      socket.onWhatsApp = async number => { lookups.push(number); return [{ exists: true, jid: number + '@s.whatsapp.net' }]; };
      socket.sendMessage = async (jid,content,options) => { deliveries.push({jid,content,options}); return {key:{id:options.messageId}}; };
      sockets.push(socket); return socket;
    } },
    telegramOptions: { authKey: key, polling: false, fetchImpl: denyExternal },
    googleOptions: { clientId: '' },
    emailOptions: { apiKey: '', from: '', key, fetchImpl: denyExternal }
  });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    await Promise.all([app.email.close(),app.gateway.close(),app.telegram.close(),app.bridge.close()]);
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve)); app.store.close();
  });
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=(path,{method='GET',body,cookie='',workspace}={})=>new Promise((resolve,reject)=>{
    const pending=httpRequest(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(workspace===undefined?{}:{'X-Elozi-Workspace':workspace})}},response=>{
      const chunks=[]; response.on('data',chunk=>chunks.push(chunk)); response.on('error',reject);
      response.on('end',()=>{try{
        const setCookie=(response.headers['set-cookie']||[]).join(', ');
        resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString()),cookie:setCookie.split(';')[0]});
      }catch(error){reject(error);}});
    });
    pending.on('error',reject); pending.end(body===undefined?undefined:JSON.stringify(body));
  });
  const owner=await request('/api/auth/setup',{method:'POST',body:{name:'Owner sintético',username:'http.owner',password:password()}});
  assert.equal(owner.status,200);
  const ownerActor=app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const tenant=await request('/api/tenants',{method:'POST',cookie:owner.cookie,body:{name:'HTTP sintético',segment:'QA'}});
  assert.equal(tenant.status,201);
  const tenantId=tenant.data.id, path=`/api/tenants/${tenantId}`;
  const channel=await request(path+'/channels',{method:'POST',cookie:owner.cookie,body:{name:'WhatsApp sintético',kind:'whatsapp_qr',real:true,expectedNumber}});
  assert.equal(channel.status,201);
  const hiddenChannel=await request(path+'/channels',{method:'POST',cookie:owner.cookie,body:{name:'Canal restrito',kind:'telegram'}});
  assert.equal(hiddenChannel.status,201);
  const connected=await request(`${path}/channels/${channel.data.id}/connect`,{method:'POST',cookie:owner.cookie,body:{}});
  assert.equal(connected.status,200);
  sockets[0].ev.emit('connection.update',{connection:'open'}); await tick();
  assert.equal(app.gateway.entries.get(channel.data.id).state,'connected');
  let userSequence=0, conversationSequence=0;
  const login=(username,secret)=>request('/api/auth/login',{method:'POST',body:{username,password:secret}});
  const member=async(extra={})=>{
    const username='http.member.'+ ++userSequence, secret=password();
    const created=await request('/api/users',{method:'POST',cookie:owner.cookie,body:{name:username,username,password:secret,role:'operator',tenantIds:[tenantId],...extra}});
    assert.equal(created.status,201);
    const signed=await login(username,secret); assert.equal(signed.status,200);
    return {...created.data,cookie:signed.cookie,secret};
  };
  const department=async(extra={})=>{
    const created=await request(path+'/departments',{method:'POST',cookie:owner.cookie,body:{name:'Suporte sintético',...extra}});
    assert.equal(created.status,201); return created.data;
  };
  const open=async(extra={})=>{
    const result=await request(path+'/conversations',{method:'POST',cookie:owner.cookie,body:{channelId:channel.data.id,number:'1191111'+String(++conversationSequence).padStart(4,'0'),name:'Contato sintético '+conversationSequence,...extra}});
    assert.equal(result.status,200); return result.data;
  };
  const receive=async(number,externalId)=>{
    await app.gateway.receive(app.gateway.entries.get(channel.data.id),{key:{id:externalId,remoteJid:'55'+number+'@s.whatsapp.net'},pushName:'Entrada sintética',message:{conversation:'Texto sintético '+externalId}});
  };
  const state=()=>app.store.tenant(ownerActor,tenantId);
  return {app,request,owner,ownerActor,tenantId,path,channel:channel.data,hiddenChannel:hiddenChannel.data,deliveries,lookups,member,department,open,receive,state,login};
}

test('HTTP equipe altera acesso, revoga cookie e devolve responsável à fila; reativar exige novo login', async t=>{
  const c=await fixture(t), alice=await c.member(), bob=await c.member();
  await c.department({memberIds:[alice.id,bob.id],isDefault:true});
  const conversation=await c.open();
  const claimed=await c.request(`${c.path}/conversations/${conversation.id}/owner`,{method:'POST',cookie:alice.cookie,body:{version:conversation.version,owner:'human'}});
  assert.equal(claimed.status,200); assert.equal(claimed.data.assignedUserId,alice.id);
  const credential=c.app.store.db.prepare('SELECT username,email,reseller_id,password_hash,password_salt FROM auth_users WHERE id=?').get(alice.id);
  const edited=await c.request(`/api/users/${alice.id}`,{method:'PATCH',cookie:c.owner.cookie,body:{permissions:['inbox.read']}});
  assert.equal(edited.status,200);
  assert.equal((await c.request('/api/auth/me',{cookie:alice.cookie})).status,401);
  let current=c.state().conversations.find(item=>item.id===conversation.id);
  assert.equal(current.owner,'queue'); assert.equal(current.assignedUserId,null); assert.equal(current.agentId,null);
  assert.equal(current.attendantEvents.at(-1).to.owner,'queue');
  assert.deepEqual(c.app.store.db.prepare('SELECT username,email,reseller_id,password_hash,password_salt FROM auth_users WHERE id=?').get(alice.id),credential);
  const readOnly=await c.login(alice.username,alice.secret); assert.equal(readOnly.status,200);
  assert.equal((await c.request(`${c.path}/conversations/${conversation.id}/owner`,{method:'POST',cookie:readOnly.cookie,body:{version:current.version,owner:'human'}})).status,403);
  const reassigned=await c.request(`${c.path}/conversations/${conversation.id}/owner`,{method:'POST',cookie:c.owner.cookie,body:{version:current.version,owner:'human',assignedUserId:bob.id}});
  assert.equal(reassigned.status,200);
  assert.equal((await c.request(`/api/users/${bob.id}/disable`,{method:'POST',cookie:c.owner.cookie,body:{}})).status,200);
  current=c.state().conversations.find(item=>item.id===conversation.id);
  assert.equal(current.owner,'queue'); assert.equal(current.assignedUserId,null);
  assert.equal((await c.request('/api/auth/me',{cookie:bob.cookie})).status,401);
  const active=await c.request(`/api/users/${bob.id}/reactivate`,{method:'POST',cookie:c.owner.cookie,body:{}});
  assert.equal(active.status,200); assert.equal(active.data.disabled,false);
  assert.equal((await c.request('/api/auth/me',{cookie:bob.cookie})).status,401);
  assert.equal((await c.login(bob.username,bob.secret)).status,200);
  assert.equal(c.deliveries.length,0);
});

test('HTTP departamento padrão distribui entradas entre disponíveis e preserva CAS ao desativar', async t=>{
  const c=await fixture(t), alice=await c.member(), bob=await c.member();
  const configured=await c.department({memberIds:[alice.id,bob.id],distribution:'round_robin',isDefault:true});
  await c.receive('11922220001','incoming-one'); await c.receive('11922220002','incoming-two');
  let tenant=(await c.request(c.path,{cookie:c.owner.cookie})).data;
  const one=tenant.conversations.find(item=>item.messages.some(message=>message.externalId==='incoming-one'));
  const two=tenant.conversations.find(item=>item.messages.some(message=>message.externalId==='incoming-two'));
  assert.equal(one.assignedUserId,alice.id); assert.equal(two.assignedUserId,bob.id);
  assert.equal(one.departmentId,configured.id); assert.equal(two.departmentId,configured.id);
  assert.equal((await c.request('/api/auth/presence',{method:'PATCH',cookie:alice.cookie,body:{presence:'busy'}})).status,200);
  await c.receive('11922220003','incoming-three');
  assert.equal(c.state().conversations.find(item=>item.messages.some(message=>message.externalId==='incoming-three')).assignedUserId,bob.id);
  const listed=await c.request(c.path+'/departments',{cookie:c.owner.cookie}); assert.equal(listed.status,200);
  const latest=listed.data.departments.find(item=>item.id===configured.id); assert.equal(latest.isDefault,true);
  assert.equal((await c.request(`${c.path}/departments/${configured.id}`,{method:'PATCH',cookie:c.owner.cookie,body:{version:configured.version,name:'Revisão antiga'}})).status,409);
  const archived=await c.request(`${c.path}/departments/${configured.id}`,{method:'PATCH',cookie:c.owner.cookie,body:{version:latest.version,active:false}});
  assert.equal(archived.status,200); assert.equal(archived.data.isDefault,false); assert.equal(c.state().defaultDepartmentId,null);
  await c.receive('11922220004','incoming-four');
  const queued=c.state().conversations.find(item=>item.messages.some(message=>message.externalId==='incoming-four'));
  assert.equal(queued.owner,'queue'); assert.equal(queued.assignedUserId,null); assert.equal(queued.departmentId,null);
  const metrics=await c.request(c.path+'/metrics',{cookie:c.owner.cookie});
  assert.equal(metrics.status,200); assert.equal(metrics.data.totals.incomingMessages,4); assert.equal(metrics.data.totals.assignments,3);
  assert.equal(c.deliveries.length,0);
});

test('HTTP assumir, transferir e devolver à fila vinculam pessoa real; apenas responsável envia', async t=>{
  const c=await fixture(t), alice=await c.member(), bob=await c.member();
  await c.department({memberIds:[alice.id,bob.id],isDefault:true});
  let conversation=await c.open();
  const ownerRoute=`${c.path}/conversations/${conversation.id}/owner`, messagesRoute=`${c.path}/conversations/${conversation.id}/messages`;
  assert.equal((await c.request(messagesRoute,{method:'POST',cookie:c.owner.cookie,body:{version:conversation.version,channelId:c.channel.id,text:'Sem responsável',idempotencyKey:randomUUID()}})).status,409);
  const first=await c.request(ownerRoute,{method:'POST',cookie:alice.cookie,body:{version:conversation.version,owner:'human'}});
  assert.equal(first.status,200); conversation=first.data;
  assert.equal((await c.request(ownerRoute,{method:'POST',cookie:bob.cookie,body:{version:conversation.version,owner:'human'}})).status,409);
  assert.equal((await c.request(messagesRoute,{method:'POST',cookie:bob.cookie,body:{version:conversation.version,channelId:c.channel.id,text:'Pessoa indevida',idempotencyKey:randomUUID()}})).status,409);
  const sent=await c.request(messagesRoute,{method:'POST',cookie:alice.cookie,body:{version:conversation.version,channelId:c.channel.id,text:'Resposta sintética',idempotencyKey:randomUUID()}});
  assert.equal(sent.status,200); conversation=sent.data;
  assert.equal(conversation.messages.at(-1).authorUserId,alice.id); assert.equal(c.deliveries.length,1);
  const transferred=await c.request(ownerRoute,{method:'POST',cookie:alice.cookie,body:{version:conversation.version,owner:'human',assignedUserId:bob.id,reason:'Troca sintética'}});
  assert.equal(transferred.status,200); conversation=transferred.data; assert.equal(conversation.assignedUserId,bob.id);
  assert.equal((await c.request(messagesRoute,{method:'POST',cookie:alice.cookie,body:{version:conversation.version,channelId:c.channel.id,text:'Depois da transferência',idempotencyKey:randomUUID()}})).status,409);
  const bobSent=await c.request(messagesRoute,{method:'POST',cookie:bob.cookie,body:{version:conversation.version,channelId:c.channel.id,text:'Segundo responsável',idempotencyKey:randomUUID()}});
  assert.equal(bobSent.status,200); conversation=bobSent.data; assert.equal(c.deliveries.length,2);
  const queued=await c.request(ownerRoute,{method:'POST',cookie:bob.cookie,body:{version:conversation.version,owner:'queue',reason:'Retorno sintético'}});
  assert.equal(queued.status,200); assert.equal(queued.data.owner,'queue'); assert.equal(queued.data.assignedUserId,null); assert.equal(queued.data.agentId,null);
  assert.equal((await c.request(messagesRoute,{method:'POST',cookie:bob.cookie,body:{version:queued.data.version,channelId:c.channel.id,text:'Fila não envia',idempotencyKey:randomUUID()}})).status,409);
  assert.equal(c.deliveries.length,2);
});

test('HTTP tenant, bootstrap, fluxos, audit e indicadores não vazam conversas de canal ou departamento restrito', async t=>{
  const c=await fixture(t), visible=await c.department({name:'Departamento permitido'}), hidden=await c.department({name:'Departamento restrito'});
  const limited=await c.member({permissions:['inbox.read','contacts.read','metrics.read'],scopeRules:{[c.tenantId]:{channelIds:[c.channel.id],departmentIds:[visible.id]}}});
  const timestamp=new Date().toISOString();
  c.app.store.mutate(c.ownerActor,c.tenantId,'SENSITIVE_AUDIT_MARKER',state=>{
    state.conversations.push(
      {id:'visible-conversation',contact:'Pessoa permitida',channelId:c.channel.id,departmentId:visible.id,department:visible.name,owner:'queue',status:'open',version:1,messages:[{id:'visible-message',kind:'customer',text:'Texto permitido',createdAt:timestamp}]},
      {id:'hidden-department-conversation',contact:'SENSITIVE_DEPARTMENT_CONTACT',channelId:c.channel.id,departmentId:hidden.id,department:hidden.name,owner:'queue',status:'open',version:1,messages:[{id:'hidden-department-message',kind:'customer',text:'SENSITIVE_DEPARTMENT_MESSAGE',createdAt:timestamp}]},
      {id:'hidden-channel-conversation',contact:'SENSITIVE_CHANNEL_CONTACT',channelId:c.hiddenChannel.id,departmentId:visible.id,department:visible.name,owner:'queue',status:'open',version:1,messages:[{id:'hidden-channel-message',kind:'customer',text:'SENSITIVE_CHANNEL_MESSAGE',createdAt:timestamp}]}
    );
  });
  const flow=await c.request(c.path+'/flows',{method:'POST',cookie:c.owner.cookie,body:{name:'SENSITIVE_FLOW_MARKER'}}); assert.equal(flow.status,201);
  const tenant=await c.request(c.path,{cookie:limited.cookie}); assert.equal(tenant.status,200);
  assert.deepEqual(tenant.data.conversations.map(item=>item.id),['visible-conversation']);
  assert.deepEqual(tenant.data.channels.map(item=>item.id),[c.channel.id]);
  assert.deepEqual(tenant.data.departments.map(item=>item.id),[visible.id]);
  assert.deepEqual(tenant.data.flows,[]); assert.deepEqual(tenant.data.audit,[]);
  assert.equal(JSON.stringify(tenant.data).includes('SENSITIVE_'),false);
  assert.equal((await c.request(c.path+'/flows',{cookie:limited.cookie})).status,403);
  const bootstrap=await c.request('/api/bootstrap',{cookie:limited.cookie}); assert.equal(bootstrap.status,200);
  assert.equal(bootstrap.data.tenants.length,1); assert.equal(bootstrap.data.tenants[0].channels,1); assert.equal(bootstrap.data.tenants[0].conversations,1);
  const metrics=await c.request(c.path+'/metrics',{cookie:limited.cookie});
  assert.equal(metrics.status,200); assert.equal(metrics.data.totals.conversationsReceived,1); assert.equal(metrics.data.totals.incomingMessages,1);
  const details=await c.request(`${c.path}/conversations/hidden-department-conversation/details`,{method:'POST',cookie:limited.cookie,body:{version:1,status:'closed'}});
  assert.equal(details.status,403);
  assert.equal(c.state().conversations.find(item=>item.id==='hidden-department-conversation').status,'open');
  assert.equal(c.deliveries.length,0);
});

test('HTTP CRM usa revisão, arquivo e histórico seguro; abrir contato valida antes do gateway e não aceita contactId na rota bruta', async t=>{
  const c=await fixture(t), operator=await c.member();
  const created=await c.request(c.path+'/contacts',{method:'POST',cookie:operator.cookie,body:{name:'CRM sintético',phone:'(11) 93333-0001',email:'crm@example.test',notes:'Nota sintética',tags:['Fixture']}});
  assert.equal(created.status,201); let contact=created.data;
  const updated=await c.request(`${c.path}/contacts/${contact.id}`,{method:'PATCH',cookie:operator.cookie,body:{version:contact.version,name:'CRM atualizado',notes:'Nova nota sintética'}});
  assert.equal(updated.status,200); contact=updated.data;
  assert.equal((await c.request(`${c.path}/contacts/${contact.id}`,{method:'PATCH',cookie:operator.cookie,body:{version:1,name:'Revisão antiga'}})).status,409);
  const found=await c.request(c.path+'/contacts?search=atualizado',{cookie:operator.cookie}); assert.equal(found.status,200); assert.equal(found.data.contacts[0].id,contact.id);
  const archived=await c.request(`${c.path}/contacts/${contact.id}/archive`,{method:'POST',cookie:operator.cookie,body:{version:contact.version}});
  assert.equal(archived.status,200); contact=archived.data; const beforeLookups=c.lookups.length;
  assert.equal((await c.request(c.path+'/contacts',{cookie:operator.cookie})).data.contacts.length,0);
  assert.equal((await c.request(c.path+'/contacts?archived=true',{cookie:operator.cookie})).data.contacts.length,1);
  assert.equal((await c.request(`${c.path}/contacts/${contact.id}/open`,{method:'POST',cookie:operator.cookie,body:{channelId:c.channel.id}})).status,409);
  assert.equal(c.lookups.length,beforeLookups);
  const reactivated=await c.request(`${c.path}/contacts/${contact.id}/reactivate`,{method:'POST',cookie:operator.cookie,body:{version:contact.version}});
  assert.equal(reactivated.status,200); contact=reactivated.data;
  for (const body of [{channelId:c.channel.id,number:'11933330001'},{channelId:c.hiddenChannel.id}]) assert.equal((await c.request(`${c.path}/contacts/${contact.id}/open`,{method:'POST',cookie:operator.cookie,body})).status,400);
  assert.equal((await c.request(c.path+'/conversations',{method:'POST',cookie:operator.cookie,body:{channelId:c.channel.id,number:'11933330001',name:'Tentativa bruta',contactId:contact.id}})).status,400);
  assert.equal(c.lookups.length,beforeLookups);
  const opened=await c.request(`${c.path}/contacts/${contact.id}/open`,{method:'POST',cookie:operator.cookie,body:{channelId:c.channel.id}});
  assert.equal(opened.status,200); assert.equal(opened.data.contactId,contact.id); assert.equal(opened.data.owner,'queue');
  assert.equal(opened.data.remoteJid,undefined); assert.equal(c.lookups.length,beforeLookups+1); assert.equal(c.deliveries.length,0);
  const history=await c.request(`${c.path}/contacts/${contact.id}/history`,{cookie:operator.cookie});
  assert.equal(history.status,200); assert.deepEqual(history.data.conversations.map(item=>item.id),[opened.data.id]);
  assert.equal(history.data.conversations[0].messages,undefined); assert.equal(history.data.conversations[0].remoteJid,undefined);
  const closed=await c.request(`${c.path}/conversations/${opened.data.id}/details`,{method:'POST',cookie:operator.cookie,body:{version:opened.data.version,status:'closed'}}); assert.equal(closed.status,200);
  const reopened=await c.request(`${c.path}/contacts/${contact.id}/open`,{method:'POST',cookie:operator.cookie,body:{channelId:c.channel.id}});
  assert.equal(reopened.status,200); assert.equal(reopened.data.id,opened.data.id); assert.equal(reopened.data.status,'open');
  assert.equal(reopened.data.assignedUserId,null); assert.equal(reopened.data.owner,'queue'); assert.equal(c.state().conversations.length,1);
  assert.equal(reopened.data.attendantEvents.at(-1).type,'reopened');
  const duplicate=await c.request(c.path+'/contacts',{method:'POST',cookie:operator.cookie,body:{name:'Duplicata sintética',phone:'11933330001'}}); assert.equal(duplicate.status,409);
  assert.equal(c.deliveries.length,0);
});

test('HTTP replay confirmado não envia novamente e retirada de acesso no gate bloqueia novo disparo', async t=>{
  const c=await fixture(t), operator=await c.member();
  const conversation=await c.open();
  const claimed=await c.request(`${c.path}/conversations/${conversation.id}/owner`,{method:'POST',cookie:operator.cookie,body:{version:conversation.version,owner:'human'}}); assert.equal(claimed.status,200);
  const route=`${c.path}/conversations/${conversation.id}/messages`, input={version:claimed.data.version,channelId:c.channel.id,text:'Idempotência sintética',idempotencyKey:randomUUID()};
  const sent=await c.request(route,{method:'POST',cookie:operator.cookie,body:input}); assert.equal(sent.status,200); assert.equal(c.deliveries.length,1);
  const replay=await c.request(route,{method:'POST',cookie:operator.cookie,body:input}); assert.equal(replay.status,200); assert.equal(c.deliveries.length,1);
  assert.equal(c.state().conversations.find(item=>item.id===conversation.id).messages.filter(message=>message.kind==='human').length,1);
  assert.equal((await c.request(route,{method:'POST',cookie:operator.cookie,body:{...input,text:'Conteúdo diferente'}})).status,409);
  const confirmed=c.app.store.db.prepare('SELECT state,attempts FROM outbound_commands WHERE idempotency_key=?').get(input.idempotencyKey);
  assert.deepEqual({...confirmed},{state:'confirmed',attempts:1});
  let gates=0;
  c.app.outbox.beforeSend=async()=>{
    if(++gates===2){const edited=await c.request(`/api/users/${operator.id}`,{method:'PATCH',cookie:c.owner.cookie,body:{permissions:['inbox.read']}});assert.equal(edited.status,200);}
  };
  const racedInput={version:sent.data.version,channelId:c.channel.id,text:'Corrida sintética',idempotencyKey:randomUUID()};
  const raced=await c.request(route,{method:'POST',cookie:operator.cookie,body:racedInput});
  assert.ok([403,409].includes(raced.status)); assert.equal(gates,2); assert.equal(c.deliveries.length,1);
  const failed=c.app.store.db.prepare('SELECT state,attempts FROM outbound_commands WHERE idempotency_key=?').get(racedInput.idempotencyKey);
  assert.deepEqual({...failed},{state:'failed',attempts:1});
  assert.equal((await c.request('/api/auth/me',{cookie:operator.cookie})).status,401);
  assert.equal(c.state().conversations.find(item=>item.id===conversation.id).owner,'queue');
});
