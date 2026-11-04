import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const password=()=> 'Synthetic-'+randomBytes(12).toString('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const waitGate=(gate,pending)=>Promise.race([gate.promise,pending.then(result=>assert.fail(`A solicitação terminou antes do await esperado: ${result.status??result.isError??'unknown'}`))]);
const groupA='120000000001@g.us',groupB='120000000002@g.us';
const privateNote='NOTA_PRIVADA_HTTP_GRUPOS',privateURL='https://private-photo.invalid/NEVER_EXPORT';

async function fixture(t,{summaryHook=async()=>({text:'Resumo privado: Alice perguntou e Bruno respondeu.'})}={}) {
  const key=randomBytes(32),calls={external:0,metadata:0,sends:[],summaries:[]},clients=[],gates=[];let clock=Date.now();
  const denied=async()=>{calls.external++;throw Error('Nenhum transporte externo é permitido nesta fixture RAM.');};
  const app=createApp({databasePath:':memory:',serviceKey:key,publicOrigin:'',allowRegistration:false,
    providerCall:async context=>{calls.summaries.push(context);return summaryHook(context);},mcpFetchImpl:denied,
    scheduledOptions:{now:()=>clock},gatewayOptions:{authKey:key,socketFactory:denied,downloadMediaImpl:denied,fetchImpl:denied},
    telegramOptions:{authKey:key,polling:false,fetchImpl:denied},googleOptions:{clientId:''},
    emailOptions:{key,apiKey:'',from:'',fetchImpl:denied},emailChannelOptions:{fetchImpl:denied},metaOptions:{fetchImpl:denied,mediaDownloader:denied},mediaOptions:{directory:null,authKey:key}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const gate of gates)gate.release.resolve();app.groupSummaries.close();await app.scheduled.waitIdle();await Promise.all(clients.map(c=>c.close()));app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await Promise.all([app.gateway.close(),app.telegram.close(),app.email.close(),app.webchat.close(),app.emailChannel.close(),app.meta.close(),app.bridge.close()]);app.store.close();assert.equal(calls.external,0);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=(path,{method='GET',cookie='',body,token,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(token?{Authorization:'Bearer '+token}:{}),...headers}},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString()),cookie:(response.headers['set-cookie']||[]).join(', ').split(';')[0]});}catch(error){reject(error);}});});
    req.setTimeout(6000,()=>req.destroy(Error('A fixture HTTP grupos excedeu o prazo.')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const owner=await request('/api/auth/setup',{method:'POST',body:{name:'Admin grupos HTTP',username:'groups.owner',password:password()}});assert.equal(owner.status,200,owner.data.error);
  const admin=app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const created=await request('/api/tenants',{method:'POST',cookie:owner.cookie,body:{name:'Grupos HTTP RAM',segment:'Sintético'}});assert.equal(created.status,201,created.data.error);
  const tenantId=created.data.id,path=`/api/tenants/${tenantId}`;
  app.store.mutate(admin,tenantId,'Fixture grupos HTTP',state=>{
    state.channels=[{id:'wa',name:'QR HTTP sintético',kind:'whatsapp_qr',transport:'baileys',state:'connected',expectedNumber:'5511999990000',allowedGroups:[groupA],groupNames:{[groupA]:'Grupo observado'}},{id:'tg',name:'Telegram HTTP sintético',kind:'telegram',transport:'telegram-bot',state:'connected',telegramGroups:{mode:'selected',groupIds:['-777']}},{id:'hidden',name:'Canal restrito',kind:'whatsapp_qr',transport:'baileys',state:'connected',allowedGroups:[groupB]}];
    state.departments=[{id:'support',name:'Suporte',active:true},{id:'sales',name:'Comercial',active:true}];state.agents=[{id:'hermes',name:'Hermes sintético',provider:'hermes',mode:'copilot',configured:true,version:1},{id:'external',name:'MCP sintético',provider:'mcp',mode:'copilot',configured:true,version:1}];
    const common={conversationKind:'group',departmentId:'support',version:1,status:'open',owner:'queue',assignedUserId:null,agentId:null,unread:1,updatedAt:new Date(clock).toISOString()};
    state.conversations=[{...common,id:'wa-group',contact:'Grupo observado',channelId:'wa',remoteJid:groupA,messages:[{id:'alice',kind:'customer',text:'Pergunta de Alice',senderName:'Alice',senderJid:'111@s.whatsapp.net',createdAt:new Date(clock-120000).toISOString(),attachments:[{id:'photo',kind:'image',name:'imagem.png',mime:'image/png',size:8,url:privateURL,preview:privateURL}]},{id:'bruno',kind:'human',text:'Resposta de Bruno',authorName:'Bruno',authorUserId:admin.userId,createdAt:new Date(clock-60000).toISOString()},{id:'private',kind:'internal',text:privateNote,createdAt:new Date(clock).toISOString()}]},
      {...common,id:'tg-group',contact:'Grupo Telegram',channelId:'tg',remoteChatId:'-777',messages:[{id:'tg-alice',kind:'customer',text:'Mensagem Telegram',senderName:'Ana Telegram',senderId:'55',createdAt:new Date(clock-1000).toISOString()}]},
      {...common,id:'unselected',contact:'GRUPO_NAO_SELECIONADO',channelId:'wa',remoteJid:groupB,messages:[]},{...common,id:'hidden-group',contact:'GRUPO_CANAL_RESTRITO',channelId:'hidden',remoteJid:groupB,messages:[]},
      {...common,id:'direct',conversationKind:'direct',contact:'Contato direto',channelId:'wa',remoteJid:'222@s.whatsapp.net',messages:[]}];
  });
  let n=0;const member=async(permissions=['inbox.read','inbox.reply'],channelIds=['wa','tg'])=>{
    const username='groups.user.'+ ++n,secret=password(),user=await request('/api/users',{method:'POST',cookie:owner.cookie,body:{name:'Pessoa grupos '+n,username,password:secret,role:'operator',tenantIds:[tenantId],permissions,scopeRules:{[tenantId]:{channelIds,departmentIds:['support']}}}});assert.equal(user.status,201,user.data.error);
    const logged=await request('/api/auth/login',{method:'POST',body:{username,password:secret}});assert.equal(logged.status,200,logged.data.error);return {...user.data,cookie:logged.cookie};
  };
  const writer=await member(),reader=await member(['inbox.read']);
  const entry={tenantId,channelId:'wa',expectedNumber:'5511999990000',actor:app.gateway.actor(admin.resellerId),generation:1,state:'connected',matched:true,groupCache:new Map(),socket:{user:{id:'5511999990000@s.whatsapp.net'},end(){},
    groupMetadata:async()=>{calls.metadata++;return {id:groupA,subject:'Grupo oficial',desc:'Descrição do grupo',announce:false,photoUrl:privateURL,participants:[{id:'111@s.whatsapp.net',name:'Alice',notify:'Alice',admin:null,photoUrl:privateURL},{id:'333@s.whatsapp.net',name:'Participante B',notify:'Participante B',admin:'admin',photoUrl:privateURL}]};},
    sendMessage:async(jid,payload)=>{calls.sends.push({jid,payload});return {key:{id:'http-wire-'+calls.sends.length}};}}};app.gateway.entries.set('wa',entry);
  const current=(id='wa-group')=>app.store.getConversation(app.store.tenant(admin,tenantId),id);
  const change=fn=>app.store.mutate(admin,tenantId,'Alteração sintética HTTP',fn);
  const snapshot=()=>({conversation:JSON.stringify(current()),outbox:app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n,runs:(app.store.tenant(admin,tenantId).runs||[]).length});
  const service=async(capabilities=['conversation.read','reply.send','message.schedule'])=>{const result=await request(path+'/service-principals',{method:'POST',cookie:owner.cookie,body:{name:'Serviço grupos HTTP',agentId:'external',capabilities,channelIds:['wa','tg'],departmentIds:['support'],ttlHours:24,dailyRequests:100,maxConcurrent:3}});assert.equal(result.status,201,result.data.error);return result.data;};
  const input=(extra={})=>({requestId:'http_group_request_001',conversationId:'wa-group',version:current().version,text:'Mensagem HTTP sintética',...extra});
  const holdBridge=()=>{const gate={entered:deferred(),release:deferred()};gates.push(gate);app.bridge.flush=async()=>{gate.entered.resolve();await gate.release.promise;};return gate;};
  const holdMetadata=()=>{const gate={entered:deferred(),release:deferred()};gates.push(gate);entry.socket.groupMetadata=async()=>{gate.entered.resolve();await gate.release.promise;return {id:groupA,subject:'Grupo oficial',participants:[]};};return gate;};
  const connect=async token=>{const client=new Client({name:'groups-http-synthetic-agent',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/api/agent/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;};
  return {app,admin,owner,writer,reader,member,tenantId,path,base,entry,calls,request,current,change,snapshot,service,input,holdBridge,holdMetadata,connect,due:()=>new Date(clock+60000).toISOString(),advance:ms=>clock+=ms};
}

test('HTTP login humano: diretório selecionado/ACL, contexto/autoria e histórico sem notas ou fotos remotas',async t=>{
  const f=await fixture(t),before=f.snapshot();assert.equal((await f.request(f.path+'/groups')).status,401);
  const directory=await f.request(f.path+'/groups',{cookie:f.writer.cookie});assert.equal(directory.status,200,directory.data.error);assert.deepEqual(directory.data.groups.map(g=>g.conversationId).sort(),['tg-group','wa-group']);assert.equal(JSON.stringify(directory.data).includes('GRUPO_NAO_SELECIONADO'),false);
  const context=await f.request(f.path+'/conversations/wa-group/group-context',{cookie:f.writer.cookie});assert.equal(context.status,200,context.data.error);assert.equal(context.data.tenantId,f.tenantId);assert.equal(context.data.conversationId,'wa-group');assert.equal(context.data.group.title,'Grupo oficial');assert.equal(context.data.canSummarize,true);assert.ok(context.data.participants.items.some(p=>p.name==='Alice'));
  assert.equal(JSON.stringify(context.data).includes(privateURL),false);assert.equal(JSON.stringify(context.data).includes(privateNote),false);
  const history=await f.request(f.path+'/conversations/wa-group/group-history?limit=1',{cookie:f.reader.cookie});assert.equal(history.status,200,history.data.error);assert.equal(history.data.messages[0].senderName,'Bruno');assert.ok(history.data.nextCursor);
  const previous=await f.request(f.path+'/conversations/wa-group/group-history?limit=1&cursor='+encodeURIComponent(history.data.nextCursor),{cookie:f.reader.cookie});assert.equal(previous.status,200,previous.data.error);assert.equal(previous.data.messages[0].senderName,'Alice');assert.equal(JSON.stringify(previous.data).includes(privateURL),false);assert.equal(previous.data.coverage.attachmentsAnalyzed,false);
  assert.equal((await f.request(f.path+'/conversations/wa-group/group-history?limit=101',{cookie:f.writer.cookie})).status,400);assert.equal((await f.request(f.path+'/conversations/unselected/group-context',{cookie:f.writer.cookie})).status,403);assert.equal((await f.request(f.path+'/conversations/hidden-group/group-history',{cookie:f.writer.cookie})).status,403);
  const other=f.app.store.createTenant(f.admin,{name:'Empresa B',segment:'Sintético'});assert.equal((await f.request(`/api/tenants/${other.id}/groups`,{cookie:f.writer.cookie})).status,403);assert.deepEqual(f.snapshot(),before);
});

test('HTTP resumo privado usa inbox.reply sem assumir, cache por pessoa e sem mensagens/notas/ferramentas',async t=>{
  const f=await fixture(t),before=f.snapshot(),input={version:1,agentId:'hermes',commandId:'http_private_summary'};
  assert.equal((await f.request(f.path+'/conversations/wa-group/group-summary',{method:'POST',cookie:f.reader.cookie,body:input})).status,403);
  const ready=await f.request(f.path+'/conversations/wa-group/group-summary',{method:'POST',cookie:f.writer.cookie,body:input});assert.equal(ready.status,200,ready.data.error);assert.equal(ready.data.state,'ready');assert.match(ready.data.summary,/Resumo privado/);assert.equal(ready.data.coverage.attachmentsAnalyzed,false);
  assert.equal((await f.request(f.path+'/conversations/wa-group/group-summary',{method:'POST',cookie:f.writer.cookie,body:input})).status,200);assert.equal(f.calls.summaries.length,1);
  const otherPerson=await f.member();assert.equal((await f.request(f.path+'/conversations/wa-group/group-summary',{method:'POST',cookie:otherPerson.cookie,body:input})).status,200);assert.equal(f.calls.summaries.length,2);
  for(const call of f.calls.summaries){assert.deepEqual(call.tools,[]);assert.equal(JSON.stringify(call.messages).includes(privateNote),false);assert.equal(JSON.stringify(call.messages).includes(privateURL),false);assert.match(call.messages[1].content,/Alice/);}
  assert.deepEqual(f.snapshot(),before);assert.equal(f.current().owner,'queue');assert.equal(f.current().assignedUserId,null);
});

test('HTTP contexto e resumo revalidam sessão/seleção depois do await e não devolvem dados privados',async t=>{
  for(const mode of ['metadata-session','metadata-selection','summary-session','summary-version'])await t.test(mode,async child=>{
    const entered=deferred(),release=deferred();child.after(()=>release.resolve());const f=await fixture(child,{summaryHook:async()=>{entered.resolve();await release.promise;return {text:'RESUMO_NAO_DEVOLVER_APOS_REVOGAR'};}});let gate,pending;
    if(mode.startsWith('metadata')){gate=f.holdMetadata();pending=f.request(f.path+'/conversations/wa-group/group-context',{cookie:f.writer.cookie});await waitGate(gate.entered,pending);}
    else{pending=f.request(f.path+'/conversations/wa-group/group-summary',{method:'POST',cookie:f.writer.cookie,body:{version:1,agentId:'hermes',commandId:'await_summary'}});await waitGate(entered,pending);}
    if(mode.endsWith('session'))f.app.auth.revokeUserSessions(f.writer.id);else f.change(state=>mode==='metadata-selection'?state.channels[0].allowedGroups=[]:state.conversations[0].version++);
    gate?.release.resolve();release.resolve();const result=await pending;assert.equal(result.status,mode.endsWith('session')?401:mode==='metadata-selection'?403:409);assert.equal(result.data.summary,undefined);assert.equal(result.data.group,undefined);assert.equal(f.calls.sends.length,0);
  });
});

test('REST serviço expõe grupos/histórico selecionados e envia/agendamento sem alterar responsável',async t=>{
  const f=await fixture(t),service=await f.service(),headers={token:service.token,method:'POST'};
  const groups=await f.request('/api/service/v1/groups',{...headers,body:{requestId:'rest_groups_001'}});assert.equal(groups.status,200,groups.data.error);assert.deepEqual(groups.data.groups.map(g=>g.conversationId),['tg-group','wa-group']);
  const history=await f.request('/api/service/v1/group-history',{...headers,body:{requestId:'rest_history_001',conversationId:'wa-group'}});assert.equal(history.status,200,history.data.error);assert.deepEqual(history.data.messages.map(m=>m.senderName),['Alice','Bruno']);assert.equal(JSON.stringify(history.data).includes(privateNote),false);assert.equal(JSON.stringify(history.data).includes(privateURL),false);
  const input=f.input({requestId:'rest_send_001'}),sent=await f.request('/api/service/v1/group-messages',{...headers,body:input});assert.equal(sent.status,200,sent.data.error);assert.equal(sent.data.receipt.state,'confirmed');assert.ok(sent.data.result.messageId);assert.equal(sent.data.receipt.stale,false);
  const replay=await f.request('/api/service/v1/group-messages',{...headers,body:input});assert.equal(replay.status,200,replay.data.error);assert.equal(replay.data.receipt.id,sent.data.receipt.id);assert.equal(f.calls.sends.length,1);
  const scheduled=await f.request('/api/service/v1/group-schedules',{...headers,body:f.input({requestId:'rest_schedule_001',dueAt:f.due()})});assert.equal(scheduled.status,201,scheduled.data.error);assert.equal(scheduled.data.receipt.state,'confirmed');assert.ok(scheduled.data.result.scheduledId);assert.equal(f.current().scheduledMessages[0].actorKind,'service');assert.equal(f.current().scheduledMessages[0].userId,null);
  f.advance(60000);assert.equal((await f.app.scheduled.tick()).sent,1);assert.equal(f.calls.sends.length,2);const c=f.current();assert.equal(c.owner,'queue');assert.equal(c.assignedUserId,null);for(const message of c.messages.filter(m=>m.authorServiceId===service.principal.id)){assert.equal(message.kind,'agent');assert.equal(message.authorUserId,null);assert.equal(message.agentId,'external');}
  assert.equal((await f.request('/api/service/v1/group-messages',{...headers,body:f.input({requestId:'rest_forbidden_001',conversationId:'direct',version:1})})).status,403);
});

test('MCP SDK real usa callbacks de transporte/agendamento e chave antiga somente leitura não envia',async t=>{
  const f=await fixture(t),service=await f.service(),client=await f.connect(service.token);
  const read=await client.callTool({name:'elozi_read_group_history',arguments:{requestId:'mcp_history_001',conversationId:'wa-group'}});assert.equal(read.isError,undefined);assert.deepEqual(read.structuredContent.messages.map(m=>m.senderName),['Alice','Bruno']);
  const input=f.input({requestId:'mcp_send_001'}),sent=await client.callTool({name:'elozi_send_group_message',arguments:input});assert.equal(sent.isError,undefined,sent.content?.[0]?.text);assert.equal(sent.structuredContent.receipt.state,'confirmed');assert.equal((await client.callTool({name:'elozi_send_group_message',arguments:input})).structuredContent.receipt.id,sent.structuredContent.receipt.id);
  const scheduled=await client.callTool({name:'elozi_schedule_group_message',arguments:f.input({requestId:'mcp_schedule_001',dueAt:f.due()})});assert.equal(scheduled.isError,undefined,scheduled.content?.[0]?.text);assert.equal(scheduled.structuredContent.receipt.state,'confirmed');
  const reader=await f.service(['conversation.read']),readerClient=await f.connect(reader.token),tools=(await readerClient.listTools()).tools.map(tool=>tool.name);assert.ok(tools.includes('elozi_list_groups'));assert.equal(tools.includes('elozi_send_group_message'),false);
  const denied=await readerClient.callTool({name:'elozi_send_group_message',arguments:f.input({requestId:'mcp_denied_001'})});assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error.status,403);assert.equal(f.calls.sends.length,1);assert.equal(f.current().owner,'queue');assert.equal(f.current().assignedUserId,null);
});

test('REST/MCP revalidam serviço ou seleção no await da ponte antes do transporte',async t=>{
  for(const mode of ['rest-revoke','rest-selection','mcp-revoke','mcp-selection'])await t.test(mode,async child=>{
    const f=await fixture(child),service=await f.service(),client=mode.startsWith('mcp')?await f.connect(service.token):null,gate=f.holdBridge(),input=f.input({requestId:'late_authority_send'});
    const pending=client?client.callTool({name:'elozi_send_group_message',arguments:input}):f.request('/api/service/v1/group-messages',{method:'POST',token:service.token,body:input});await waitGate(gate.entered,pending);
    if(mode.endsWith('revoke'))f.app.servicePrincipals.revoke(f.admin,f.tenantId,service.principal.id,{revision:1});else f.change(state=>state.channels[0].allowedGroups=[]);
    gate.release.resolve();const result=await pending,code=client?result.structuredContent.error.status:result.status;assert.equal(code,mode.endsWith('revoke')?401:403);assert.equal(f.calls.sends.length,0);assert.equal(f.current().messages.some(m=>m.authorServiceId===service.principal.id),false);assert.equal(f.current().owner,'queue');assert.equal(f.current().assignedUserId,null);
  });
});

test('HTTP scheduler bloqueia chave revogada antes do fire sem resolver serviço como humano',async t=>{
  const f=await fixture(t),service=await f.service(['conversation.read','message.schedule']);const scheduled=await f.request('/api/service/v1/group-schedules',{method:'POST',token:service.token,body:f.input({requestId:'schedule_revoke_001',dueAt:f.due()})});assert.equal(scheduled.status,201,scheduled.data.error);
  const revoked=await f.request(f.path+'/service-principals/'+service.principal.id+'/revoke',{method:'POST',cookie:f.owner.cookie,body:{revision:1}});assert.equal(revoked.status,200,revoked.data.error);f.advance(60000);assert.equal((await f.app.scheduled.tick()).blocked,1);assert.equal(f.calls.sends.length,0);assert.equal(f.current().scheduledMessages[0].reasonCode,'authority_changed');assert.equal(f.current().assignedUserId,null);
});
