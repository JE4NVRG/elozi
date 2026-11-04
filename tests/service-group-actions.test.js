import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { createScheduledMessages } from '../src/scheduled-messages.js';
import { createServiceMcpHandler } from '../src/service-mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const status=n=>error=>error.status===n;
test('me v2 separates direct-send approval from explicitly granted group publication',t=>{
  const f=fixture(t),me=f.api.me(f.actor);
  assert.equal(me.apiVersion,2);assert.equal(me.humanApprovalRequired,false);
  assert.equal(me.agent.mode,'autonomous');assert.equal(me.agent.adapterMode,'copilot');
  assert.equal(me.responsePolicy.requiresHumanConversationAuthorization,false);
  assert.equal(me.responsePolicy.requiresServerConversationAuthorization,true);
  assert.deepEqual(f.api.me(f.actor).groupActions,{send:true,schedule:true,scope:'selected-groups',requiresPerMessageApproval:false});
  const read=fixture(t,{capabilities:['conversation.read']});
  assert.deepEqual(read.api.me(read.actor).groupActions,{send:false,schedule:false,scope:'selected-groups',requiresPerMessageApproval:false});
});
function fixture(t,{capabilities=['conversation.read','reply.send','message.schedule'],departmentIds=['support'],beforeSend=async()=>{},afterSend=async()=>{},sendResult=null,fireBefore=async()=>{},fireError=null}={}) {
  const store=new Store(':memory:'); t.after(()=>store.close());
  const auth=new Auth(store.db,{validateTenant:(actor,id)=>store.tenant(actor,id)});
  const admin=auth.actor(auth.insertUser({username:'group-service-qa',name:'Admin sintético'},Buffer.alloc(16,7),Buffer.alloc(64,7),'reseller',[],'mep-demo'));
  const tenant=store.createTenant(admin,{name:'Grupos sintéticos',segment:'QA'});
  let clock=Date.now(),sendCalls=0,delivered=0,fireCalls=0,humanResolutions=0;
  store.mutate(admin,tenant.id,'Fixture grupos de serviço',state=>{
    state.agents=[{id:'external',name:'Agente sintético',provider:'mcp',mode:'copilot',configured:true,version:1}];
    state.channels=[{id:'wa',kind:'whatsapp_qr',transport:'baileys',state:'connected',allowedGroups:['123-456@g.us']},{id:'tg',kind:'telegram',transport:'telegram-bot',state:'connected',telegramGroups:{mode:'all',groupIds:[]}},{id:'other',kind:'whatsapp_qr',transport:'baileys',state:'connected',allowedGroups:['999@g.us']}];
    state.departments=[{id:'support',name:'Suporte',active:true},{id:'sales',name:'Comercial',active:true}];
    const msg=(id,kind,text,extra={})=>({id,kind,text,createdAt:new Date(clock-60000*(4-Number(id.replace('m',''))||1)).toISOString(),...extra});
    const group=(id,channelId,remote)=>({id,contact:'Grupo sintético',channelId,departmentId:'support',conversationKind:'group',...remote,version:1,status:'open',owner:'queue',assignedUserId:null,messages:[]});
    state.conversations=[{...group('wa-group','wa',{remoteJid:'123-456@g.us'}),messages:[msg('m1','customer','Texto de Alice',{senderName:'Alice',senderJid:'111@s.whatsapp.net'}),msg('m2','human','Texto da equipe',{authorName:'Bruno',authorUserId:admin.userId}),msg('m3','agent','Texto do agente',{authorName:'Agente anterior',authorServiceId:'old-service'}),msg('private','internal','NOTA_PRIVADA_NAO_EXPORTAR'),msg('sys','system','SISTEMA_NAO_EXPORTAR')]},group('tg-group','tg',{remoteChatId:'-1234'}),group('unselected','wa',{remoteJid:'987@g.us'}),group('outside','other',{remoteJid:'999@g.us'}),{...group('sales','wa',{remoteJid:'123-456@g.us'}),departmentId:'sales'},{id:'direct',channelId:'wa',remoteJid:'111@s.whatsapp.net',conversationKind:'direct',departmentId:'support',version:1,status:'open',owner:'human',assignedUserId:admin.userId,messages:[]}];
  });
  const principals=new ServicePrincipals(store,auth,{now:()=>clock});
  const created=principals.create(admin,tenant.id,{name:'Serviço grupos QA',agentId:'external',capabilities,channelIds:['wa','tg'],departmentIds,dailyRequests:100,maxConcurrent:3,ttlHours:24});
  const actor=principals.authenticate('Bearer '+created.token);
  let api;
  const authorize=(internal,tid,conversation)=>principals.authorizeInternalActor(internal,internal.serviceCapability,api.groupContext(internal,conversation.id));
  const scheduler=createScheduledMessages(store,{now:()=>clock,authorize,
    resolveActor:()=>{humanResolutions++;assert.fail('O serviço não deve resolver uma pessoa.');},
    resolveServiceActor:record=>principals.resolveServiceActor(record),
    send:async(internal,tid,cid,input,{reauthorize})=>{fireCalls++;await fireBefore();reauthorize();authorize(internal,tid,current(cid));if(fireError)throw fireError;append(internal,cid,input.text);}
  });
  const current=(cid='wa-group')=>store.getConversation(store.tenant(admin,tenant.id),cid);
  function append(internal,cid,text){delivered++;return store.mutate(internal,tenant.id,'Entrega sintética',state=>{const c=store.getConversation(state,cid);c.messages.push({id:`sent-${delivered}`,kind:'agent',text,authorServiceId:internal.serviceId,authorName:internal.name,createdAt:new Date(clock).toISOString()});c.version++;return {state:'confirmed',messageId:`sent-${delivered}`};});}
  api=new ServiceApi(store,principals,null,{assertGroup:()=>true,
    sendGroup:async(bearer,options)=>{sendCalls++;await beforeSend(options);options.reauthorize();authorize(options.internalActor,tenant.id,current(options.input.conversationId));if(sendResult)return sendResult;const result=append(options.internalActor,options.input.conversationId,options.input.text);await afterSend();return result;},
    scheduleGroup:(bearer,{internalActor,input,idempotencyKey,reauthorize})=>{reauthorize();return scheduler.create(internalActor,tenant.id,input.conversationId,{version:input.version,text:input.text,dueAt:input.dueAt,commandId:idempotencyKey});}
  });
  return {store,auth,admin,tenant,principals,created,actor,api,scheduler,current,
    input:(extra={})=>({requestId:'group_request_001',conversationId:'wa-group',version:current().version,text:'Mensagem sintética do serviço',...extra}),
    change:fn=>store.mutate(admin,tenant.id,'Alteração sintética',state=>fn(state)),
    advance:ms=>{clock+=ms;},due:()=>new Date(clock+60000).toISOString(),counts:()=>({sendCalls,delivered,fireCalls,humanResolutions}),
    receipts:()=>principals.receipts(admin,tenant.id,created.principal.id).receipts,
    internal:(capability='reply.send')=>principals.executionActor(actor,capability,api.groupContext(actor,'wa-group'))};
}

test('grupo transferido para outro canal autorizado não atravessa o filtro de uma página em andamento',t=>{
  const f=fixture(t);
  f.change(state=>{state.conversations.push({...state.conversations[0],id:'z-group-filter'});});
  const first=f.api.listGroups(f.actor,{requestId:'channel_filter_page_01',channelId:'wa',limit:1});
  assert.deepEqual(first.groups.map(group=>group.conversationId),['wa-group']);assert.ok(first.nextCursor);
  f.change(state=>{const group=state.conversations.find(item=>item.id==='z-group-filter');group.channelId='tg';group.remoteChatId='-5678';delete group.remoteJid;group.version++;});
  assert.throws(()=>f.api.listGroups(f.actor,{requestId:'channel_filter_page_02',channelId:'wa',limit:1,cursor:first.nextCursor}),status(409));
  assert.equal(f.counts().delivered,0);
});

test('diretório/paginação só revelam grupos selecionados e escopo atual, TG all legado mantido',t=>{
  const f=fixture(t),page=f.api.listGroups(f.actor,{requestId:'groups_page_001',limit:1});
  assert.deepEqual(page.groups.map(g=>g.conversationId),['tg-group']);assert.ok(page.nextCursor);
  const next=f.api.listGroups(f.actor,{requestId:'groups_page_002',limit:1,cursor:page.nextCursor});assert.deepEqual(next.groups.map(g=>g.conversationId),['wa-group']);assert.equal(next.nextCursor,null);
  assert.throws(()=>f.api.listGroups(f.actor,{requestId:'groups_page_003',limit:1,cursor:page.nextCursor,channelId:'wa'}),status(409));
  f.change(state=>{state.channels[1].telegramGroups={mode:'selected',groupIds:[]};state.channels[0].allowedGroups=[];});
  assert.deepEqual(f.api.listGroups(f.actor,{requestId:'groups_page_004'}).groups,[]);
  assert.throws(()=>f.api.read(f.actor,'wa-group','blocked_read_01'),status(403));assert.equal(f.counts().delivered,0);
});

test('histórico temporal pagina com autoria explícita, remove notas/mídia privada e rejeita cursor de outro grupo',t=>{
  const f=fixture(t),first=f.api.readGroupHistory(f.actor,{requestId:'history_page_001',conversationId:'wa-group',limit:2});
  assert.deepEqual(first.messages.map(m=>m.senderName),['Bruno','Agente anterior']);assert.equal(first.coverage.availableCount,3);assert.equal(first.coverage.attachmentsAnalyzed,false);assert.ok(first.nextCursor);
  const second=f.api.readGroupHistory(f.actor,{requestId:'history_page_002',conversationId:'wa-group',cursor:first.nextCursor,limit:2});assert.equal(second.messages[0].senderName,'Alice');assert.equal(second.nextCursor,null);
  assert.equal(JSON.stringify(first).includes('NOTA_PRIVADA'),false);assert.equal(JSON.stringify(first).includes('senderJid'),false);
  assert.throws(()=>f.api.readGroupHistory(f.actor,{requestId:'history_bad_001',conversationId:'tg-group',cursor:first.nextCursor}),status(409));
  assert.throws(()=>f.api.readGroupHistory(f.actor,{requestId:'history_bad_002',conversationId:'wa-group',limit:101}),status(400));
  assert.throws(()=>f.api.readGroupHistory(f.actor,{requestId:'history_bad_003',conversationId:'wa-group',after:'2026-01-01T00:00:00Z',before:'2026-03-01T00:00:00Z'}),status(400));
  f.change(state=>state.conversations[0].version++);assert.throws(()=>f.api.readGroupHistory(f.actor,{requestId:'history_bad_004',conversationId:'wa-group',cursor:first.nextCursor}),status(409));
});

test('novas capacidades não ampliam chave antiga, exigem leitura e não autorizam destino direto/fora do escopo',async t=>{
  const f=fixture(t,{capabilities:['conversation.read']});
  assert.deepEqual(f.created.principal.capabilities,['conversation.read']);await assert.rejects(f.api.sendGroup(f.actor,f.input()),status(403));await assert.rejects(f.api.scheduleGroup(f.actor,f.input({dueAt:f.due()})),status(403));
  assert.throws(()=>f.principals.create(f.admin,f.tenant.id,{name:'Sem leitura',agentId:'external',capabilities:['reply.send']}),status(400));
  const g=fixture(t);for(const id of ['direct','unselected','outside','sales'])await assert.rejects(g.api.sendGroup(g.actor,g.input({conversationId:id,version:1,requestId:`forbidden_${id}`})),status(403));
  assert.deepEqual(f.counts(),{sendCalls:0,delivered:0,fireCalls:0,humanResolutions:0});
});

test('envio como serviço preserva responsável e replay reconciliável após seu próprio incremento de versão',async t=>{
  const f=fixture(t),input=f.input(),before=f.current(),result=await f.api.sendGroup(f.actor,input);
  assert.equal(result.receipt.state,'confirmed');assert.equal(result.receipt.stale,false);assert.equal(result.result.messageId,'sent-1');
  const c=f.current(),message=c.messages.at(-1);assert.equal(c.owner,before.owner);assert.equal(c.assignedUserId,before.assignedUserId);assert.equal(message.kind,'agent');assert.equal(message.authorServiceId,f.created.principal.id);assert.equal(message.authorUserId,undefined);
  const repeated=await f.api.sendGroup(f.actor,input);assert.equal(repeated.receipt.id,result.receipt.id);assert.deepEqual(f.counts(),{sendCalls:1,delivered:1,fireCalls:0,humanResolutions:0});
  await assert.rejects(f.api.sendGroup(f.actor,{...input,text:'Outro conteúdo'}),status(409));
  assert.equal(f.principals.getReceipt(f.actor,result.receipt.id).state,'confirmed');
  assert.throws(()=>f.principals.authorizeInternalActor({...f.internal(),serviceCapability:'message.schedule'},'message.schedule',f.api.groupContext(f.actor,'wa-group')),status(403));
});

test('resultado incerto é terminal e mesma requestId não dispara novamente',async t=>{
  const f=fixture(t,{sendResult:{state:'unknown'}}),input=f.input(),first=await f.api.sendGroup(f.actor,input);
  assert.equal(first.receipt.state,'unknown');assert.equal((await f.api.sendGroup(f.actor,input)).receipt.id,first.receipt.id);assert.equal(f.counts().sendCalls,1);assert.equal(f.counts().delivered,0);
});

test('resultado conhecido depois de revogar fica confirmado/stale sem devolver mensagem ao bearer',async t=>{
  let f;f=fixture(t,{afterSend:async()=>{f.principals.revoke(f.admin,f.tenant.id,f.created.principal.id,{revision:1});}});
  await assert.rejects(f.api.sendGroup(f.actor,f.input()),status(401));assert.equal(f.counts().delivered,1);assert.equal(f.receipts()[0].state,'confirmed');assert.equal(f.receipts()[0].stale,true);
});

test('Outbox desconhecida prevalece sobre erro de autorização e replay não chama adaptador de novo',async t=>{
  let f;f=fixture(t,{beforeSend:async options=>{f.store.db.prepare('INSERT INTO outbound_commands VALUES (?,?,?)').run(f.tenant.id,options.idempotencyKey,'unknown');throw Object.assign(new Error('Autorização recusada após resposta incerta'),{status:403});}});
  f.store.db.exec('CREATE TABLE outbound_commands (tenant_id TEXT,idempotency_key TEXT,state TEXT)');
  const input=f.input();await assert.rejects(f.api.sendGroup(f.actor,input),status(403));assert.equal(f.receipts()[0].state,'unknown');assert.equal((await f.api.sendGroup(f.actor,input)).receipt.state,'unknown');assert.equal(f.counts().sendCalls,1);
});

test('seleção/revogação frescas depois do await impedem despacho e falso ator não ganha autoridade',async t=>{
  let f;f=fixture(t,{beforeSend:async()=>{f.change(state=>state.channels[0].allowedGroups=[]);}});
  await assert.rejects(f.api.sendGroup(f.actor,f.input()),status(403));assert.equal(f.counts().delivered,0);assert.equal(f.receipts()[0].state,'failed');
  const g=fixture(t);const internal=g.internal();g.principals.revoke(g.admin,g.tenant.id,g.created.principal.id,{revision:1});
  assert.throws(()=>g.principals.authorizeInternalActor(internal,'reply.send',{workspaceId:g.admin.resellerId,tenantId:g.tenant.id,agentId:'external',conversationId:'wa-group',channelId:'wa',departmentId:'support'}),status(401));
});

test('agendamento guarda identidade distinta, replay único e resolve serviço fresco sem pessoa',async t=>{
  const f=fixture(t,{capabilities:['conversation.read','message.schedule']}),input=f.input({dueAt:f.due()}),first=await f.api.scheduleGroup(f.actor,input);
  assert.equal(first.receipt.state,'confirmed');assert.equal(first.receipt.stale,false);assert.ok(first.result.scheduledId);
  const stored=f.current().scheduledMessages[0];assert.equal(stored.actorKind,'service');assert.equal(stored.userId,null);assert.equal(stored.serviceId,f.created.principal.id);assert.equal(stored.groupId,'123-456@g.us');assert.equal(JSON.stringify(stored).includes(f.created.token),false);assert.equal(stored.tokenHash,undefined);
  assert.equal((await f.api.scheduleGroup(f.actor,input)).receipt.id,first.receipt.id);assert.equal(f.current().scheduledMessages.length,1);await assert.rejects(f.api.sendGroup(f.actor,f.input({requestId:'no_immediate_send'})),status(403));
  f.advance(60000);assert.deepEqual(await f.scheduler.tick(),{processed:1,sent:1,blocked:0,failed:0,unknown:0});assert.equal(f.current().scheduledMessages[0].state,'sent');assert.equal(f.counts().humanResolutions,0);assert.equal(f.current().messages.at(-1).authorServiceId,f.created.principal.id);
});

test('adaptador de agendamento sem confirmação ou assíncrono não fabrica recibo positivo',async t=>{
  for(const mode of ['no-id','async'])await t.test(mode,async child=>{
    const f=fixture(child);let calls=0;f.api.groupActions.scheduleGroup=()=>{calls++;return mode==='async'?Promise.resolve(null):null;};
    const input=f.input({dueAt:f.due()});await assert.rejects(f.api.scheduleGroup(f.actor,input));assert.equal(f.receipts()[0].state,'unknown');assert.equal(f.current().scheduledMessages,undefined);
    assert.equal((await f.api.scheduleGroup(f.actor,input)).receipt.state,'unknown');assert.equal(calls,1);
  });
});

test('serviço preserva departamento explícito unassigned em grupo legado sem inferir grant pelo nome',async t=>{
  const f=fixture(t,{departmentIds:['unassigned']});f.change(state=>{delete state.conversations[0].departmentId;state.conversations[0].department='Suporte';});
  await f.api.scheduleGroup(f.actor,f.input({dueAt:f.due()}));assert.equal(f.current().scheduledMessages[0].departmentId,null);f.advance(60000);assert.equal((await f.scheduler.tick()).sent,1);
});

test('revogação/TTL/troca de chave/seleção/departamento bloqueiam disparo de serviço',async t=>{
  for(const condition of ['revoke','expiry','rotate','selection','department','adapter'])await t.test(condition,async child=>{
    const f=fixture(child),input=f.input({dueAt:f.due()});await f.api.scheduleGroup(f.actor,input);
    if(condition==='revoke')f.principals.revoke(f.admin,f.tenant.id,f.created.principal.id,{revision:1});
    if(condition==='rotate')f.principals.rotate(f.admin,f.tenant.id,f.created.principal.id,{revision:1});
    if(condition==='selection')f.change(state=>state.channels[0].allowedGroups=[]);
    if(condition==='department')f.change(state=>state.conversations[0].departmentId='sales');
    if(condition==='adapter')f.change(state=>state.agents[0].version++);
    f.advance(condition==='expiry'?25*3600000:60000);
    assert.deepEqual(await f.scheduler.tick(),{processed:1,sent:0,blocked:1,failed:0,unknown:0});assert.equal(f.counts().fireCalls,0);assert.equal(f.current().scheduledMessages[0].reasonCode,'authority_changed');
  });
});

test('disparo revalida depois do await e incerteza/restart não geram novo envio automático',async t=>{
  let f;f=fixture(t,{fireBefore:async()=>{f.change(state=>state.channels[0].allowedGroups=[]);}});await f.api.scheduleGroup(f.actor,f.input({dueAt:f.due()}));f.advance(60000);
  assert.equal((await f.scheduler.tick()).blocked,1);assert.equal(f.counts().delivered,0);
  const g=fixture(t,{fireError:new Error('Resposta do transporte incerta')});await g.api.scheduleGroup(g.actor,g.input({dueAt:g.due()}));g.advance(60000);assert.equal((await g.scheduler.tick()).unknown,1);assert.equal(g.current().scheduledMessages[0].state,'unknown');assert.equal((await g.scheduler.tick()).processed,0);assert.equal(g.counts().fireCalls,1);
  g.change(state=>state.conversations[0].scheduledMessages[0].state='sending');assert.equal(g.scheduler.recover().recovered,1);assert.equal(g.current().scheduledMessages[0].state,'unknown');assert.equal((await g.scheduler.tick()).processed,0);
});

test('SDK MCP real expõe somente capacidades concedidas e envia/agendamento com receipts escopados',async t=>{
  const f=fixture(t),handler=createServiceMcpHandler(f.api),server=createServer((req,res)=>handler(req,res).catch(()=>{res.writeHead(500);res.end();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');const clients=[];
  t.after(async()=>{await Promise.all(clients.map(c=>c.close()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function connect(token){const client=new Client({name:'synthetic-group-agent',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/api/agent/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;}
  const client=await connect(f.created.token),tools=(await client.listTools()).tools.map(t=>t.name);for(const name of ['elozi_list_groups','elozi_read_group_history','elozi_send_group_message','elozi_schedule_group_message'])assert.ok(tools.includes(name));
  const groupResult=await client.callTool({name:'elozi_list_groups',arguments:{requestId:'sdk_groups_001'}});assert.deepEqual(groupResult.structuredContent.groups.map(g=>g.conversationId),['tg-group','wa-group']);
  const sent=await client.callTool({name:'elozi_send_group_message',arguments:f.input({requestId:'sdk_send_001'})});assert.equal(sent.isError,undefined);assert.equal(sent.structuredContent.receipt.state,'confirmed');
  const scheduled=await client.callTool({name:'elozi_schedule_group_message',arguments:f.input({requestId:'sdk_schedule_001',dueAt:f.due()})});assert.equal(scheduled.isError,undefined);assert.equal(scheduled.structuredContent.receipt.state,'confirmed');
  const reader=f.principals.create(f.admin,f.tenant.id,{name:'Leitor grupos',agentId:'external',capabilities:['conversation.read'],channelIds:['wa'],departmentIds:['support']}),readClient=await connect(reader.token),readerTools=(await readClient.listTools()).tools.map(t=>t.name);assert.ok(readerTools.includes('elozi_read_group_history'));assert.equal(readerTools.includes('elozi_send_group_message'),false);
  const denied=await readClient.callTool({name:'elozi_send_group_message',arguments:f.input({requestId:'sdk_denied_001'})});assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error.status,403);
});
