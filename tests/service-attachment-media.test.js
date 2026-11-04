import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { MediaService } from '../src/media.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { createServiceMcpHandler } from '../src/service-mcp.js';
import { loadPrivateServiceMediaPolicy, SERVICE_ATTACHMENT_MIMES } from '../src/service-attachment-media.js';

const status = code => error => error.status === code;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('SYNTHETIC-PRIVATE-RECEIPT-CONTENT')]);
const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC-PRIVATE-RECEIPT-CONTENT\n%%EOF');
const defer = () => { let resolve; const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; };

async function fixture(t) {
  const store=new Store(':memory:'),auth=new Auth(store.db);
  const row=auth.insertUser({username:'media.owner',name:'Admin sintético'},Buffer.alloc(16,5),Buffer.alloc(64,5),'reseller',[],'mep-demo');
  const admin=auth.session(row).actor,tenant=store.createTenant(admin,{name:'Mídia sintética',segment:'QA'});
  const channelId=randomUUID(),otherChannelId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID();
  store.mutate(admin,tenant.id,'Fixture de leitura de mídia',state=>{
    state.channels=[{id:channelId,name:'Canal próprio',kind:'whatsapp_qr',transport:'baileys',state:'connected'},
      {id:otherChannelId,name:'Outro canal',kind:'whatsapp_qr',transport:'baileys',state:'connected'}];
    state.departments=[];
    state.agents=[{id:'external',name:'MCP sintético',provider:'mcp',mode:'copilot',configured:true,version:1,tools:[]},
      {id:'other-agent',name:'Outro MCP',provider:'mcp',mode:'copilot',configured:true,version:1,tools:[]}];
    state.conversations=[{id:conversationId,channelId,contact:'Cliente sintético',conversationKind:'direct',departmentId:null,
      owner:'agent',agentId:'external',assignedUserId:null,status:'open',version:1,
      messages:[{id:messageId,kind:'customer',text:'Segue o comprovante',createdAt:new Date().toISOString(),attachments:[]}]}];
  });
  const principals=new ServicePrincipals(store,auth),media=new MediaService(store,{directory:null,authKey:Buffer.alloc(32,7)});
  const create=(agentId='external')=>{
    const value=principals.create(admin,tenant.id,{name:'Serviço sintético',agentId,capabilities:['conversation.read','reply.send','conversation.manage'],channelIds:[channelId,otherChannelId],departmentIds:null,dailyRequests:100,maxConcurrent:2,ttlHours:24});
    return {...value,actor:principals.authenticate('Bearer '+value.token)};
  };
  const principal=create(),policy={tenantId:tenant.id,principalId:principal.principal.id,channelId,mimeTypes:[...SERVICE_ATTACHMENT_MIMES]};
  let reads=0; const readBuffers=[];
  const reader=async(id,context)=>{reads++;const result=await media.read(id,context);readBuffers.push(result.bytes);return result;};
  const apiWith=(extra={})=>new ServiceApi(store,principals,{}, {privateMediaPolicy:[policy],readAttachment:reader,...extra});
  const api=apiWith(),context={tenantId:tenant.id,channelId,conversationId};
  const clients=[];
  const current=()=>store.getConversation(store.tenant(admin,tenant.id),conversationId);
  const mutate=callback=>store.mutate(admin,tenant.id,'Mutação sintética da mídia',state=>callback(state.conversations.find(c=>c.id===conversationId),state));
  const attach=async(bytes=png,mime='image/png')=>{
    const pending=media.placeholder(context,{kind:mime==='application/pdf'?'document':mime.startsWith('audio/')?'audio':'image',name:'../../private-receipt.png',mime,size:bytes.length});
    const metadata=await media.save(pending.id,context,bytes,pending);
    mutate(c=>{c.messages.find(m=>m.id===messageId).attachments=[metadata];c.version++;});
    return metadata;
  };
  const attachment=await attach();
  const input=(requestId='read_attachment_0001')=>({requestId,conversationId,version:current().version,messageId,attachmentId:attachment.id});
  const client=async(which=api,token=principal.token)=>{
    const handler=createServiceMcpHandler(which),server=createServer(async(req,res)=>{if(!await handler(req,res)){res.statusCode=404;res.end();}});
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const client=new Client({name:'synthetic-media-client',version:'1'});
    clients.push(async()=>{await client.close().catch(()=>{});server.closeAllConnections();await new Promise(done=>server.close(done));});
    await client.connect(new StreamableHTTPClientTransport(new URL('/api/agent/mcp',`http://127.0.0.1:${server.address().port}`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    return client;
  };
  t.after(async()=>{for(const close of clients.reverse())await close();store.close();});
  return {store,admin,tenant,principals,principal,create,media,api,apiWith,policy,context,channelId,otherChannelId,conversationId,messageId,attachment,current,mutate,attach,input,client,readBuffers,get reads(){return reads;}};
}

test('leitura exata e replay cobram uma chamada e nunca persistem conteúdo/nome/base64 no recibo',async t=>{
  const f=await fixture(t),input=f.input();
  const first=await f.api.readAttachment(f.principal.actor,input);
  assert.deepEqual(Object.keys(first).sort(),['status','tenantId','channelId','conversationId','version','messageId','attachment'].sort());
  assert.equal(first.status,'attachment_ready');assert.equal(first.tenantId,f.tenant.id);assert.equal(first.channelId,f.channelId);
  assert.equal(first.messageId,f.messageId);assert.equal(first.version,input.version);
  assert.deepEqual(Buffer.from(first.attachment.data,'base64'),png);
  assert.equal(first.attachment.sha256,createHash('sha256').update(png).digest('hex'));
  assert.equal(first.attachment.name,'private-receipt.png');assert.equal(first.attachment.encoding,'base64');
  const second=await f.api.readAttachment(f.principal.actor,input);assert.deepEqual(second,first);
  assert.equal(f.reads,2,'replay decrypts only after fresh current authorization, without cached payload');
  assert.equal(f.api.me(f.principal.actor).principal.usage.requests,1);
  const rows=f.store.db.prepare('SELECT result,context,payload_hash FROM service_principal_receipts').all();
  assert.equal(rows.length,1);const stored=JSON.stringify(rows);
  assert.equal(stored.includes('SYNTHETIC-PRIVATE-RECEIPT-CONTENT'),false);
  assert.equal(stored.includes(png.toString('base64')),false);assert.equal(stored.includes('private-receipt'),false);
  assert.ok(f.readBuffers.every(bytes=>bytes.equals(Buffer.alloc(bytes.length))),'temporary plaintext buffers are zeroed on success too');
});

test('sem política, outra identidade/canal/mensagem e versão antiga falham antes de ler bytes',async t=>{
  const f=await fixture(t),other=f.create(),noPolicy=f.apiWith({privateMediaPolicy:[]});
  await assert.rejects(noPolicy.readAttachment(f.principal.actor,f.input()),status(403));
  await assert.rejects(f.api.readAttachment(other.actor,f.input()),status(403));
  await assert.rejects(f.api.readAttachment({...f.principal.actor,tenantId:'forged-tenant'},f.input()),status(401));
  await assert.rejects(f.api.readAttachment(f.principal.actor,{...f.input(),messageId:randomUUID()}),status(404));
  await assert.rejects(f.api.readAttachment(f.principal.actor,{...f.input(),attachmentId:randomUUID()}),status(404));
  await assert.rejects(f.api.readAttachment(f.principal.actor,{...f.input(),version:1}),status(409));
  f.mutate(c=>{c.channelId=f.otherChannelId;c.version++;});
  await assert.rejects(f.api.readAttachment(f.principal.actor,f.input()),status(403));
  assert.equal(f.reads,0);assert.equal(f.api.me(f.principal.actor).principal.usage.requests,0);
});

test('grupo, humano, outro agente, nota privada e mensagem do agente não liberam anexo',async t=>{
  const f=await fixture(t);
  for(const [key,value,code] of [['owner','human',403],['agentId','other-agent',403],['status','closed',403]]){
    const original=f.current()[key];f.mutate(c=>{c[key]=value;});
    await assert.rejects(f.api.readAttachment(f.principal.actor,f.input()),status(code));f.mutate(c=>{c[key]=original;});
  }
  for(const kind of ['note','human','agent']){
    f.mutate(c=>{c.messages[0].kind=kind;});await assert.rejects(f.api.readAttachment(f.principal.actor,f.input()),status(404));
  }
  f.mutate(c=>{c.messages[0].kind='customer';c.conversationKind='group';});
  await assert.rejects(f.api.readAttachment(f.principal.actor,f.input()),error=>[403,404].includes(error.status));assert.equal(f.reads,0);
});

test('retomada humana, revisão, revogação e troca de metadados durante await zeram o Buffer',async t=>{
  for(const change of ['human','revision','revoked','metadata']){
    await t.test(change,async t=>{
      const f=await fixture(t),started=defer(),release=defer();let buffer;
      const api=f.apiWith({readAttachment:async(id,context)=>{
        const file=await f.media.read(id,context);buffer=file.bytes;started.resolve();await release.promise;return file;
      }});
      const pending=api.readAttachment(f.principal.actor,f.input());await started.promise;
      if(change==='human')f.mutate(c=>{c.owner='human';c.assignedUserId=f.admin.userId;c.version++;});
      if(change==='revision')f.principals.update(f.admin,f.tenant.id,f.principal.principal.id,{revision:1,name:'Revisão alterada'});
      if(change==='revoked')f.principals.revoke(f.admin,f.tenant.id,f.principal.principal.id,{revision:1});
      if(change==='metadata')f.mutate(c=>{c.messages[0].attachments[0].name='outro-nome.pdf';});
      release.resolve();await assert.rejects(pending,error=>[401,403,409].includes(error.status));
      assert.deepEqual(buffer,Buffer.alloc(buffer.length));
      const receipts=f.store.db.prepare('SELECT result FROM service_principal_receipts').all();assert.equal(JSON.stringify(receipts).includes(png.toString('base64')),false);
    });
  }
});

test('MediaService recebe callback de autorização em context e invoca após await',async t=>{
  const f=await fixture(t);let calls=0,contextReceived;
  const api=f.apiWith({readAttachment:async(id,context)=>{
    contextReceived=context;context.reauthorize();calls++;
    const file=await f.media.read(id,context);context.reauthorize();calls++;return file;
  }});
  await api.readAttachment(f.principal.actor,f.input());
  assert.equal(typeof contextReceived.reauthorize,'function');assert.equal(contextReceived.tenantId,f.tenant.id);assert.equal(calls,2);
  assert.equal(Object.hasOwn(contextReceived,'url'),false);
});

test('PDF autorizado é lido; conteúdo sem assinatura não é entregue mesmo declarado PDF',async t=>{
  const f=await fixture(t),metadata=await f.attach(pdf,'application/pdf');
  const valid={...f.input(),attachmentId:metadata.id};
  const result=await f.api.readAttachment(f.principal.actor,valid);assert.deepEqual(Buffer.from(result.attachment.data,'base64'),pdf);
  const invalid=await f.attach(Buffer.from('NOT-A-PDF-PRIVATE'),'application/pdf');
  await assert.rejects(f.api.readAttachment(f.principal.actor,{...f.input('read_bad_pdf_0001'),attachmentId:invalid.id}),status(415));
  assert.deepEqual(f.readBuffers.at(-1),Buffer.alloc('NOT-A-PDF-PRIVATE'.length));
});

test('áudio OGG, MP3 e M4A autorizados são lidos; bytes sem a assinatura do formato não são entregues',async t=>{
  const f=await fixture(t);
  const samples=[['audio/ogg',Buffer.concat([Buffer.from('OggS'),Buffer.from('SYNTHETIC-PRIVATE-VOICE-NOTE')])],
    ['audio/mpeg',Buffer.concat([Buffer.from('ID3'),Buffer.from('SYNTHETIC-PRIVATE-MP3-CONTENT')])],
    ['audio/mp4',Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A SYNTHETIC-PRIVATE-AAC')])]];
  for(const [index,[mime,bytes]] of samples.entries()){
    const metadata=await f.attach(bytes,mime);
    const result=await f.api.readAttachment(f.principal.actor,{...f.input(`read_audio_000${index}`),attachmentId:metadata.id});
    assert.equal(result.attachment.mime,mime);assert.deepEqual(Buffer.from(result.attachment.data,'base64'),bytes);
  }
  const voice=await f.attach(samples[0][1],'audio/ogg'),forged=Buffer.from('NOT-AN-OGG-PRIVATE-AUDIO');
  const api=f.apiWith({readAttachment:async()=>({metadata:{...voice,size:forged.length},bytes:forged})});
  f.mutate(c=>{c.messages[0].attachments[0].size=forged.length;});
  await assert.rejects(api.readAttachment(f.principal.actor,{...f.input('read_forged_ogg'),attachmentId:voice.id}),status(415));
  assert.deepEqual(forged,Buffer.alloc(forged.length));
  const context=f.api.privateContext(f.principal.actor,f.conversationId),authority=f.principals.revalidate(f.principal.actor,'reply.send',context);
  f.mutate(c=>{c.messages[0].text='';});assert.doesNotThrow(()=>f.api.replyGuardrails(f.principal.actor,authority,f.conversationId),'an authorized voice note can be answered');
});

test('pending, oversize, vídeo e múltiplos anexos são recusados sem acessar leitor',async t=>{
  const f=await fixture(t),original=structuredClone(f.attachment);
  for(const [metadata,code] of [[{...original,status:'pending'},409],[{...original,size:10485761},413],
    [{...original,mime:'video/mp4',kind:'video'},415]]){
    f.mutate(c=>{c.messages[0].attachments=[metadata];});await assert.rejects(f.api.readAttachment(f.principal.actor,f.input()),status(code));
  }
  f.mutate(c=>{c.messages[0].attachments=[original,{...original,id:randomUUID()}];});
  await assert.rejects(f.api.readAttachment(f.principal.actor,f.input()),status(409));assert.equal(f.reads,0);
});

test('replay após resposta perdida revalida versão; nova leitura não altera envio ou cobra replay',async t=>{
  const f=await fixture(t),original=f.input();await f.api.readAttachment(f.principal.actor,original);
  f.mutate(c=>{c.messages.push({id:randomUUID(),kind:'customer',text:'Outra mensagem',createdAt:new Date().toISOString()});c.version++;});
  await assert.rejects(f.api.readAttachment(f.principal.actor,original),status(409));assert.equal(f.reads,1);
  await assert.rejects(f.api.readAttachment(f.principal.actor,{...original,version:f.current().version}),status(409));
  const next=await f.api.readAttachment(f.principal.actor,f.input('new_read_after_version'));
  assert.equal(next.status,'attachment_ready');assert.equal(f.reads,2);assert.equal(f.api.me(f.principal.actor).principal.usage.requests,2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='outbound_commands'").get().n,0,'read API never creates an outbox');
});

test('duas chamadas simultâneas com a mesma chave não abrem dois leitores',async t=>{
  const f=await fixture(t),started=defer(),release=defer();let calls=0;
  const api=f.apiWith({readAttachment:async(id,context)=>{calls++;started.resolve();await release.promise;return f.media.read(id,context);}});
  const input=f.input(),first=api.readAttachment(f.principal.actor,input);await started.promise;
  await assert.rejects(api.readAttachment(f.principal.actor,input),status(409));assert.equal(calls,1);
  release.resolve();assert.equal((await first).status,'attachment_ready');assert.equal(api.me(f.principal.actor).principal.usage.requests,1);
});

test('replay não entrega conteúdo que divergiu do hash original e zera o novo plaintext',async t=>{
  const f=await fixture(t),input=f.input();await f.api.readAttachment(f.principal.actor,input);
  const changed=Buffer.from(png);changed[changed.length-1]^=1;
  const api=f.apiWith({readAttachment:async()=>({metadata:f.attachment,bytes:changed})});
  await assert.rejects(api.readAttachment(f.principal.actor,input),status(409));
  assert.deepEqual(changed,Buffer.alloc(changed.length));assert.equal(api.me(f.principal.actor).principal.usage.requests,1);
});

test('resposta explicativa a comprovante pendente/grande só vale na política exata; guardrails permanecem',async t=>{
  const f=await fixture(t),api=f.apiWith({privateReplyLimits:[{...f.policy,mimeTypes:undefined,replyLimitPerHour:60}].map(({mimeTypes,...value})=>value)});
  const guard=which=>{const context=which.privateContext(f.principal.actor,f.conversationId),authority=f.principals.revalidate(f.principal.actor,'reply.send',context);return which.replyGuardrails(f.principal.actor,authority,f.conversationId);};
  f.mutate(c=>{c.messages[0].text='';c.messages[0].attachments[0].status='pending';c.messages[0].attachments[0].size=10485761;});
  assert.doesNotThrow(()=>guard(api));assert.throws(()=>guard(f.apiWith({privateMediaPolicy:[]})),status(409));
  f.mutate(c=>{c.messages[0].text='Quero falar com um atendente humano';});assert.throws(()=>guard(api),status(409));
  f.mutate(c=>{c.messages[0].text='Isso é um absurdo, ninguém resolve';});assert.throws(()=>guard(api),status(409));
  f.mutate(c=>{c.messages[0].text='';c.messages[0].attachments[0].mime='video/mp4';});assert.throws(()=>guard(api),status(409));
  f.mutate(c=>{c.messages[0].attachments=[];});assert.throws(()=>guard(api),status(409));
  f.mutate(c=>{c.messages[0].text='Olá';c.messages.push(...Array.from({length:60},(_,index)=>({id:'reply-'+index,kind:'agent',text:'Resposta',authorServiceId:f.principal.principal.id,createdAt:new Date().toISOString()})));});
  assert.throws(()=>guard(api),error=>error.status===429&&error.code==='SERVICE_REPLY_RATE_LIMIT'&&error.admissionRejected===true);
});

test('MCP só anuncia mídia habilitada e devolve base64 uma vez em structuredContent',async t=>{
  const f=await fixture(t),client=await f.client();
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='elozi_read_attachment'));
  const me=await client.callTool({name:'elozi_me',arguments:{}});assert.equal(me.structuredContent.attachmentRead.enabled,true);
  assert.deepEqual(me.structuredContent.attachmentRead.channels,[{channelId:f.channelId,mimeTypes:[...SERVICE_ATTACHMENT_MIMES].sort()}]);
  assert.equal(me.structuredContent.attachmentRead.maxBytes,10485760);
  const read=await client.callTool({name:'elozi_read_conversation',arguments:{requestId:'read_metadata_status_1',conversationId:f.conversationId}});
  assert.equal(read.structuredContent.conversation.messages[0].attachments[0].status,'ready');
  const result=await client.callTool({name:'elozi_read_attachment',arguments:f.input()});
  assert.equal(result.structuredContent.status,'attachment_ready');assert.deepEqual(Buffer.from(result.structuredContent.attachment.data,'base64'),png);
  assert.equal(result.content[0].text.includes(png.toString('base64')),false);assert.equal(Object.hasOwn(JSON.parse(result.content[0].text).attachment,'data'),false);
  const ordinary=await f.client(f.apiWith({privateMediaPolicy:[]}));assert.equal((await ordinary.listTools()).tools.some(tool=>tool.name==='elozi_read_attachment'),false);
  assert.equal((await ordinary.callTool({name:'elozi_me',arguments:{}})).structuredContent.attachmentRead.enabled,false);
});

test('takeover entre conclusão da leitura e entrega MCP descarta o resultado com bytes',async t=>{
  const f=await fixture(t),original=f.api.readAttachment.bind(f.api);let captured;
  f.api.readAttachment=async(...args)=>{captured=await original(...args);f.mutate(c=>{c.owner='human';c.assignedUserId=f.admin.userId;c.version++;});return captured;};
  const client=await f.client(),result=await client.callTool({name:'elozi_read_attachment',arguments:f.input()});
  assert.equal(result.isError,true);assert.ok([403,409].includes(result.structuredContent.error.status));
  assert.equal(captured.attachment.data,'');assert.equal(JSON.stringify(result).includes(png.toString('base64')),false);
});

test('política privada fixa valida formato/tupla e recusa arquivo inseguro sem ampliar grants',async t=>{
  const f=await fixture(t),directory=mkdtempSync(join(tmpdir(),'elozi-media-policy-')),database=join(directory,'sandbox.sqlite'),path=join(directory,'private-service-media-policy.json');
  t.after(()=>rmSync(directory,{recursive:true}));
  assert.deepEqual(loadPrivateServiceMediaPolicy(':memory:'),[]);assert.deepEqual(loadPrivateServiceMediaPolicy(database),[]);
  writeFileSync(path,JSON.stringify([f.policy]),{mode:0o600});assert.equal(f.apiWith({privateMediaPolicy:loadPrivateServiceMediaPolicy(database)}).me(f.principal.actor).attachmentRead.enabled,true);
  for(const value of ['{',null,{},[null],[{...f.policy,mimeTypes:['video/mp4']}],[{...f.policy,tenantId:'foreign'}],
    [{...f.policy,channelId:'*'}],[{...f.policy,principalId:'unknown'}],[{...f.policy,extra:true}],[f.policy,f.policy]])assert.throws(()=>f.apiWith({privateMediaPolicy:value}),TypeError);
  writeFileSync(path,Buffer.alloc(65537));assert.throws(()=>loadPrivateServiceMediaPolicy(database),TypeError);
  writeFileSync(path,Buffer.from([255]));assert.throws(()=>loadPrivateServiceMediaPolicy(database),TypeError);
  unlinkSync(path);mkdirSync(path);assert.throws(()=>loadPrivateServiceMediaPolicy(database),TypeError);rmdirSync(path);
  if(process.platform!=='win32'){const target=join(directory,'target.json');writeFileSync(target,'[]');symlinkSync(target,path);assert.throws(()=>loadPrivateServiceMediaPolicy(database),TypeError);}
  assert.equal(f.principal.principal.revision,1);assert.equal(f.principal.principal.keyRevision,1);
});
