import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function queryFixture(t) {
  const key=randomBytes(32),clients=[],external=[];
  const denied=async()=>{external.push('blocked');throw Error('Fixture cannot use an external transport');};
  const app=createApp({databasePath:':memory:',serviceKey:key,publicOrigin:'',allowRegistration:false,
    providerCall:denied,mcpFetchImpl:denied,gatewayOptions:{authKey:key,socketFactory:denied,downloadMediaImpl:denied,fetchImpl:denied},
    telegramOptions:{authKey:key,polling:false,fetchImpl:denied},googleOptions:{clientId:''},emailOptions:{key,apiKey:'',from:'',fetchImpl:denied},
    emailChannelOptions:{fetchImpl:denied},metaOptions:{fetchImpl:denied,mediaDownloader:denied},mediaOptions:{directory:null,authKey:key}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.groupSummaries.close();await app.scheduled.waitIdle();await Promise.all(clients.map(c=>c.close()));app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await Promise.all([app.gateway.close(),app.telegram.close(),app.email.close(),app.webchat.close(),app.emailChannel.close(),app.meta.close(),app.bridge.close()]);app.store.close();assert.deepEqual(external,[]);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=(path,{method='GET',cookie='',body,token,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...(token?{Authorization:'Bearer '+token}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString()),cookie:(res.headers['set-cookie']||[]).join(', ').split(';')[0]});}catch(e){reject(e);}});});
    req.setTimeout(6000,()=>req.destroy(Error('Synthetic query HTTP timeout')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const owner=await request('/api/auth/setup',{method:'POST',body:{name:'Query Admin QA',username:'query.owner',password:'Synthetic-'+randomBytes(12).toString('hex')}});assert.equal(owner.status,200,owner.data.error);
  const admin=app.auth.workspaceActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  const created=await request('/api/tenants',{method:'POST',cookie:owner.cookie,body:{name:'Query channels QA',segment:'Synthetic'}});assert.equal(created.status,201,created.data.error);
  const tenantId=created.data.id,path=`/api/tenants/${tenantId}`,groupId='120000000044@g.us';
  app.store.mutate(admin,tenantId,'Synthetic query fixture',s=>{
    s.channels=[{id:'wa',name:'WhatsApp QA',kind:'whatsapp_qr',transport:'baileys',state:'connected',allowedGroups:[groupId]},
      {id:'tg',name:'Telegram QA',kind:'telegram',transport:'telegram-bot',state:'connected',telegramGroups:{mode:'selected',groupIds:['-444']}},
      {id:'web',name:'Support QA',kind:'webchat',transport:'elozi-webchat',state:'connected'},
      {id:'hidden',name:'Hidden QA',kind:'telegram',transport:'telegram-bot',state:'connected'}];
    s.departments=[{id:'support',name:'Support',active:true},{id:'sales',name:'Sales',active:true}];
    s.agents=[{id:'external',name:'External QA',provider:'mcp',mode:'copilot',configured:true,version:1,description:'Read only synthetic data'}];
    const message=(id,text,time='2026-08-01T10:00:00.000Z',kind='customer')=>({id,kind,text,createdAt:time});
    const direct=(id,channelId,contact='João cliente')=>({id,channelId,contact,conversationKind:'direct',departmentId:'support',version:1,status:'open',owner:'queue',unread:2,updatedAt:'2026-10-05T12:00:00.000Z',messages:[message(id+'-msg','Sincronização do pedido QA. Veja https://public.example/help.'),message(id+'-note','PRIVATE_NOTE_QUERY_SECRET','2026-08-01T10:01:00.000Z','internal')]});
    s.conversations=[direct('wa-direct','wa'),direct('tg-direct','tg'),direct('web-direct','web'),{...direct('wa-group','wa','Grupo arquivos'),conversationKind:'group',remoteJid:groupId},
      {...direct('tg-group','tg','Grupo equipe'),conversationKind:'group',remoteChatId:'-444'},
      {...direct('unselected','wa','UNSELECTED_GROUP_QUERY'),conversationKind:'group',remoteJid:'120000000999@g.us'},
      direct('hidden-conversation','hidden','HIDDEN_CHANNEL_QUERY'),{...direct('hidden-department','wa','HIDDEN_DEPARTMENT_QUERY'),departmentId:'sales'},
      {...direct('old-history','wa','Histórico antigo'),status:'closed',messages:Array.from({length:150},(_,i)=>({...message('old-'+String(i).padStart(3,'0'),'Histórico de suporte '+i,new Date(Date.parse('2026-08-01T10:00:00Z')+i*60000).toISOString()),attachments:i===0?[{id:'file-old',kind:'image',name:'photo.png',mime:'image/png',size:12,url:'https://PRIVATE_MEDIA_QUERY.invalid',preview:'PRIVATE_PREVIEW_QUERY'}]:[]}))}];
  });
  const other=await request('/api/tenants',{method:'POST',cookie:owner.cookie,body:{name:'Other query company',segment:'Synthetic'}});assert.equal(other.status,201,other.data.error);
  app.store.mutate(admin,other.data.id,'Synthetic foreign tenant',s=>{s.conversations=[{id:'foreign-conversation',contact:'FOREIGN_COMPANY_QUERY',channelId:'wa',departmentId:'support',version:1,status:'open',messages:[{id:'foreign-msg',kind:'customer',text:'Sincronização do pedido QA',createdAt:'2026-08-01T10:00:00Z'}]}];});
  const service=async(capabilities=['conversation.read'],scope={})=>{
    const r=await request(path+'/service-principals',{method:'POST',cookie:owner.cookie,body:{name:'Query MCP QA',agentId:'external',capabilities,channelIds:['wa','tg','web'],departmentIds:['support'],dailyRequests:100,maxConcurrent:3,ttlHours:24,...scope}});assert.equal(r.status,201,r.data.error);return r.data;
  };
  const connect=async token=>{const c=new Client({name:'query-synthetic-client',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(base+'/api/agent/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return c;};
  const snapshot=()=>JSON.stringify({tenant:app.store.tenant(admin,tenantId),outbound:app.store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n});
  return {app,base,request,owner,admin,tenantId,path,groupId,service,connect,snapshot,change:fn=>app.store.mutate(admin,tenantId,'Synthetic query change',fn)};
}
