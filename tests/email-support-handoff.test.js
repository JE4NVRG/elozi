import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { EmailService } from '../src/email.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'), key = randomBytes(32), calls = [];
  const service = new EmailService(db, {key,apiKey:`ms_${randomBytes(24).toString('base64url')}`,from:'Existing transport <configured@example.test>',publicOrigin:'https://panel.example.test',
    fetchImpl:async(url,input)=>{calls.push({url,input,payload:JSON.parse(input.body)});return new Response(JSON.stringify({id:'mock-support-'+calls.length}),{status:200});},...options});
  const channel = {id:'channel-one',kind:'webchat',name:'Canal Alfa',webchat:{origins:['https://site.example.test']}};
  const conversation = {id:'conversation-one',channelId:channel.id,contact:'Cliente',webchatVisitor:{name:'Ana Sintética',email:'visitor@example.test',verified:false},messages:[{kind:'customer',text:'IP dedicado ou compartilhado?',createdAt:'2026-10-12T15:00:00Z'}],supportAssistantHandoff:{active:true,requestedAt:'2026-10-12T15:00:00Z'}};
  const tenant = {id:'tenant-one',name:'Empresa Alfa',channels:[channel],conversations:[conversation],contacts:[],secret:'PRIVATE-TENANT-SECRET'};
  const input = {tenantId:tenant.id,channelId:channel.id,conversationId:conversation.id,jobId:'job-one',email:'operator@example.test',reason:'knowledge_unavailable',authorize:()=>true,getContext:()=>({tenant,channel,conversation,sourceOrigin:'https://site.example.test'})};
  t.after(async()=>{await service.close();db.close();});
  return {db,key,calls,service,input,tenant,channel,conversation};
}

test('handoff real do serviço usa transporte configurado, cifra contexto e confirma somente aceitação mocked',async t=>{
  const f=fixture(t), receipt=await f.service.enqueueSupportHandoff(f.input), row=f.db.prepare('SELECT * FROM email_outbox WHERE id=?').get(receipt.id);
  assert.equal(receipt.state,'pending');assert.equal(f.calls.length,0);assert.equal(row.kind,'support_handoff');
  for(const value of ['Ana Sintética','visitor@example.test','IP dedicado','Empresa Alfa','PRIVATE-TENANT-SECRET']) assert.equal(Buffer.from(row.payload).includes(Buffer.from(value)),false);
  assert.equal(JSON.stringify(receipt).includes('visitor'),false);assert.equal(JSON.stringify(f.service.status()).includes('PRIVATE'),false);
  await Promise.all([f.service.flush(),f.service.flush()]);assert.equal(f.calls.length,1);
  const sent=f.calls[0];assert.equal(sent.url,'https://api-mepmail.je4ndev.com/emails');assert.equal(sent.input.headers['Idempotency-Key'],receipt.id);assert.equal(sent.input.redirect,'error');
  assert.equal(sent.payload.from,'Existing transport <configured@example.test>');assert.deepEqual(sent.payload.to,['operator@example.test']);assert.equal(sent.payload.reply_to,'visitor@example.test');
  assert.match(sent.payload.text,/IP dedicado ou compartilhado/);assert.match(sent.payload.text,/Informado \(não verificado\)/);assert.match(sent.payload.text,/https:\/\/panel.example.test\/#inbox\/tenant-one\/conversation-one/);
  assert.equal(JSON.stringify(sent.payload).includes('PRIVATE-TENANT-SECRET'),false);assert.match(sent.payload.subject,/Empresa Alfa.*Canal Alfa/);
  assert.equal(f.service.supportHandoffStatus({id:receipt.id,tenantId:f.tenant.id,authorize:()=>true}).state,'confirmed');
});

test('idempotência conserva HMAC exato e snapshot inicial mesmo com contexto/razão/e-mail-casing alterados',async t=>{
  const f=fixture(t), first=await f.service.enqueueSupportHandoff(f.input), row=f.db.prepare('SELECT * FROM email_outbox WHERE id=?').get(first.id);
  assert.equal(row.request_hash,createHmac('sha256',f.key).update(JSON.stringify(['support_handoff',f.input.tenantId,f.input.channelId,f.input.conversationId,f.input.jobId,f.input.email.toLowerCase()])).digest('hex'));
  f.tenant.name='Empresa alterada';f.conversation.webchatVisitor.name='Nome alterado';f.conversation.messages.push({kind:'customer',text:'Pergunta alterada'});
  assert.deepEqual(await f.service.enqueueSupportHandoff({...f.input,email:'Operator@Example.test',reason:'visitor_requested_human'}),first);
  assert.deepEqual(Buffer.from(f.db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(first.id).payload),Buffer.from(row.payload));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_outbox').get().n,1);await f.service.flush();assert.match(f.calls[0].payload.subject,/Empresa Alfa/);assert.equal(f.calls[0].payload.text.includes('Pergunta alterada'),false);
});

test('contexto é resolvido após await de chave e não a partir de snapshot obsoleto',async t=>{
  const f=fixture(t);let reads=0;
  const getContext=f.input.getContext;f.input.getContext=()=>{reads++;return getContext();};
  const pending=f.service.enqueueSupportHandoff(f.input);assert.equal(reads,0);
  f.tenant.name='Empresa fresca';f.conversation.webchatVisitor.email='fresh@example.test';await pending;
  assert.equal(reads,1);await f.service.flush();assert.match(f.calls[0].payload.subject,/Empresa fresca/);assert.equal(f.calls[0].payload.reply_to,'fresh@example.test');
});

test('revogação durante await da chave ou durante leitura do contexto bloqueia toda fila',async t=>{
  let active=true;const f=fixture(t);
  const pending=f.service.enqueueSupportHandoff({...f.input,authorize:()=>active});active=false;await assert.rejects(pending,error=>error.status===409);
  active=true;await assert.rejects(f.service.enqueueSupportHandoff({...f.input,authorize:()=>active,getContext:()=>{active=false;return f.input.getContext();}}),error=>error.status===409);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_outbox').get().n,0);assert.equal(f.calls.length,0);
});

test('contexto ausente/assíncrono/outro tenant, autorização ou cabeçalhos falsos são rejeitados',async t=>{
  const f=fixture(t);
  for(const changes of [{getContext:undefined},{getContext:async()=>f.input.getContext()},{getContext:()=>({...f.input.getContext(),tenant:{...f.tenant,id:'tenant-two'}})},{authorize:()=>false},{email:'operator@example.test\r\nBcc: another@example.test'},{reason:'human\nreason'},{locale:'invalid'}]) await assert.rejects(f.service.enqueueSupportHandoff({...f.input,...changes}));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM email_outbox').get().n,0);assert.equal(f.calls.length,0);
});

test('metadata do recibo é tenant-scoped, autorizada e não exporta payload/PII',async t=>{
  const f=fixture(t),receipt=await f.service.enqueueSupportHandoff(f.input),read=changes=>f.service.supportHandoffStatus({id:receipt.id,tenantId:f.tenant.id,authorize:()=>true,...changes});
  assert.deepEqual(read(),receipt);assert.equal(read({tenantId:'tenant-other'}),null);assert.throws(()=>read({authorize:()=>false}));
  assert.deepEqual(Object.keys(read()).sort(),['id','state','messageId','attempts','createdAt','updatedAt'].sort());
  assert.equal(JSON.stringify(read()).includes('visitor'),false);
  await f.service.enqueueVerification({userId:'test-user',email:'test@example.test',name:'Test',token:randomBytes(32).toString('base64url')});
  const other=f.db.prepare("SELECT id FROM email_outbox WHERE kind='verification'").get();assert.equal(read({id:other.id}),null);
});

test('handoff com endereço de visitante inválido não inventa Reply-To; EN mantém status informado',async t=>{
  const f=fixture(t);f.conversation.webchatVisitor.email='visitor@example.test\r\nBcc: evil@example.test';
  await f.service.enqueueSupportHandoff({...f.input,locale:'en'});await f.service.flush();
  assert.equal('reply_to' in f.calls[0].payload,false);assert.match(f.calls[0].payload.text,/Reply email: Not available/);assert.match(f.calls[0].payload.text,/not enough authorized information/);
});

test('erro de rede no handoff conserva unknown sem reenvio e cifra adulterada falha sem transporte',async t=>{
  let attempts=0;const f=fixture(t,{fetchImpl:async()=>{attempts++;throw Error('private upstream token');}});
  const receipt=await f.service.enqueueSupportHandoff(f.input);await f.service.flush();await f.service.flush();assert.equal(attempts,1);assert.equal(f.service.supportHandoffStatus({id:receipt.id,tenantId:f.tenant.id,authorize:()=>true}).state,'unknown');
  const second=await f.service.enqueueSupportHandoff({...f.input,jobId:'job-two'}),row=f.db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(second.id),corrupted=Buffer.from(row.payload);corrupted[30]^=255;
  f.db.prepare('UPDATE email_outbox SET payload=? WHERE id=?').run(corrupted,second.id);await f.service.flush();assert.equal(attempts,1);assert.equal(f.service.supportHandoffStatus({id:second.id,tenantId:f.tenant.id,authorize:()=>true}).state,'failed');
});
