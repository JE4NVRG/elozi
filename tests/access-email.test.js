import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv,randomBytes} from 'node:crypto';
import {EmailService} from '../src/email.js';

const input=(overrides={})=>({invitationId:'synthetic-invitation',userId:'synthetic-person',email:'person@example.test',name:'Pessoa sintética',token:randomBytes(32).toString('base64url'),workspaceName:'Playtech',expiresAt:'2035-10-03T18:00:00Z',...overrides});
function fixture(t,options={}) {
  const db=new DatabaseSync(':memory:'),key=randomBytes(32),calls=[];
  const service=new EmailService(db,{key,apiKey:`ms_${randomBytes(24).toString('base64url')}`,from:'Elozi <access@example.test>',publicOrigin:'https://elozi.je4ndev.com',fetchImpl:async(url,init)=>{calls.push({url,init});return options.response||{ok:true,status:201,json:async()=>({id:'synthetic-provider-id'})};},...options});
  t.after(async()=>{await service.close();db.close();});
  const row=id=>db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id);
  const payload=id=>{const blob=Buffer.from(row(id).payload),decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));decipher.setAAD(Buffer.from(`elozi:email:${id}`));decipher.setAuthTag(blob.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]).toString('utf8'));};
  return {service,db,key,calls,row,payload};
}

test('convite e recuperação cifram o link e devolvem somente metadados sem token',async t=>{
  const env=fixture(t),invitation=input(),reset=input();
  for(const [kind,args] of [['invitation',invitation],['password_reset',reset]]) {
    const job=await env.service[kind==='invitation'?'enqueueInvitation':'enqueuePasswordReset'](args),row=env.row(job.id),blob=Buffer.from(row.payload);
    assert.equal(row.kind,kind);assert.equal(blob.includes(Buffer.from(args.token)),false);assert.equal(blob.includes(Buffer.from(args.email)),false);assert.equal(blob.includes(Buffer.from(args.name)),false);assert.equal(JSON.stringify(job).includes(args.token),false);assert.equal(JSON.stringify(env.service.status()).includes(args.token),false);assert.equal(JSON.stringify(row).includes(args.token),false);assert.equal(job.state,'pending');assert.equal(job.messageId,null);
    assert.deepEqual(Object.keys(job).sort(),['id','state','messageId','attempts','createdAt','updatedAt'].sort());
  }
  assert.equal(env.calls.length,0);
});
test('mesmo desafio preserva job e conteúdo original; novo token produz outro job',async t=>{
  const env=fixture(t);
  for(const method of ['enqueueInvitation','enqueuePasswordReset']) {
    const args=input(),first=await env.service[method](args),original=env.payload(first.id);
    const again=await env.service[method]({...args,email:'PERSON@example.test',name:'Nome alterado',workspaceName:'Outra empresa',expiresAt:'2036-10-03T18:00:00Z'});
    assert.deepEqual(again,first);assert.deepEqual(env.payload(first.id),original);
    const changed=await env.service[method]({...args,token:randomBytes(32).toString('base64url')});assert.notEqual(changed.id,first.id);
  }
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM email_outbox').get().n,4);assert.equal(env.calls.length,0);
});
test('kind e identidade isolam idempotência mesmo com o mesmo token e destinatário',async t=>{
  const env=fixture(t),args=input(),invite=await env.service.enqueueInvitation(args),reset=await env.service.enqueuePasswordReset({...args,userId:`invitation:${args.invitationId}`}),other=await env.service.enqueueInvitation({...args,invitationId:'other-invitation'});
  assert.equal(new Set([invite.id,reset.id,other.id]).size,3);assert.equal(new Set([env.row(invite.id).request_hash,env.row(reset.id).request_hash,env.row(other.id).request_hash]).size,3);
});
test('links de acesso usam fragmento sem token na query e HTML escapa nome/empresa',async t=>{
  const env=fixture(t),args=input({name:'<img src=x onerror="bad"> & O\'Pessoa',workspaceName:'<svg onload="bad"> & Equipe'});
  for(const [method,path,caption] of [['enqueueInvitation','/accept-invite','Aceitar convite'],['enqueuePasswordReset','/reset-password','Definir nova senha']]) {
    const job=await env.service[method](args),payload=env.payload(job.id),link=payload.text.match(/https:\/\/\S+/)[0],url=new URL(link);
    assert.equal(url.pathname,path);assert.equal(url.search,'');assert.equal(url.hash,`#token=${args.token}`);assert.ok(payload.html.includes(`href="https://elozi.je4ndev.com${path}#token=${args.token}"`));assert.ok(payload.html.includes(caption));assert.equal(payload.html.includes('<img'),false);assert.equal(payload.html.includes('<svg'),false);assert.ok(payload.html.includes('&lt;img'));assert.ok(payload.html.includes('&amp; O&#39;Pessoa'));assert.ok(payload.text.includes('horário de Brasília'));
    if(method==='enqueueInvitation')assert.ok(payload.html.includes('&lt;svg'));
    else assert.ok(payload.text.includes('as sessões anteriores serão encerradas'));
  }
});
test('invitationId ausente, vazio, longo ou com controles nunca enfileira invitation:undefined',async t=>{
  const env=fixture(t);
  for(const invitationId of [undefined,null,0,{},'','  ','a'.repeat(121),'id\n','id\x00','id\x7f','id\u0085']) await assert.rejects(env.service.enqueueInvitation(input({invitationId})),error=>error.status===400);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM email_outbox').get().n,0);assert.equal(env.calls.length,0);
  const boundary=await env.service.enqueueInvitation(input({invitationId:'a'.repeat(120)}));assert.equal(env.row(boundary.id).user_id,`invitation:${'a'.repeat(120)}`);
});
test('recuperação exige identidade e ambos validam destinatário/token/expiração/nome',async t=>{
  const env=fixture(t);
  for(const userId of [undefined,null,'',' ','a'.repeat(161),'id\n']) await assert.rejects(env.service.enqueuePasswordReset(input({userId})),error=>error.status===400);
  const invalid=[{email:'bad'},{email:'person@example.test\nBcc:x'},{email:'<person@example.test>'},{token:undefined},{token:'short'},{token:'a'.repeat(513)},{token:'token/with?invalid'},{expiresAt:undefined},{expiresAt:123},{expiresAt:''},{expiresAt:'not-a-date'},{name:'line\nname'}];
  for(const method of ['enqueueInvitation','enqueuePasswordReset'])for(const overrides of invalid)await assert.rejects(env.service[method](input(overrides)),error=>error.status===400);
  for(const workspaceName of ['a'.repeat(161),'Empresa\nBcc:'])await assert.rejects(env.service.enqueueInvitation(input({workspaceName})),error=>error.status===400);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM email_outbox').get().n,0);assert.equal(env.calls.length,0);
});
test('configuração ausente conserva convites pendentes sem enviar externamente',async t=>{
  const env=fixture(t,{apiKey:undefined,from:undefined});await env.service.enqueueInvitation(input());await env.service.enqueuePasswordReset(input());assert.equal(env.service.status().configured,false);const result=await env.service.flush();assert.equal(result.pending,2);assert.equal(env.calls.length,0);
});
test('aceitação do provedor confirma job e id, sem afirmar entrega ao destinatário',async t=>{
  const env=fixture(t),args=input(),job=await env.service.enqueueInvitation(args);await env.service.flush();const row=env.row(job.id),again=await env.service.enqueueInvitation(args);assert.equal(row.state,'confirmed');assert.equal(row.message_id,'synthetic-provider-id');assert.equal(again.messageId,'synthetic-provider-id');assert.equal('delivered' in again,false);assert.equal('deliveredAt' in again,false);assert.equal('delivered' in env.service.status(),false);
  assert.equal(env.calls.length,1);assert.equal(env.calls[0].url,'https://api-mepmail.je4ndev.com/emails');assert.equal(env.calls[0].init.headers['Idempotency-Key'],job.id);assert.equal(env.calls[0].init.redirect,'error');await env.service.flush();assert.equal(env.calls.length,1);
});
test('sucesso sem id e erro 5xx ficam incertos; 4xx fica falho sem reenvio cego',async t=>{
  for(const [response,state] of [[{ok:true,status:201,json:async()=>({})},'unknown'],[{ok:false,status:503},'unknown'],[{ok:false,status:403},'failed']]) {
    const env=fixture(t,{response}),job=await env.service.enqueuePasswordReset(input());await env.service.flush();assert.equal(env.row(job.id).state,state);assert.equal(env.row(job.id).message_id,null);await env.service.flush();assert.equal(env.calls.length,1);
  }
});
test('falha de transporte não revela token nem credencial e não repete o reset',async t=>{
  const args=input(),apiKey=`ms_${randomBytes(24).toString('base64url')}`;let calls=0;const env=fixture(t,{apiKey,fetchImpl:async()=>{calls++;throw new Error(`${args.token} ${apiKey}`);}}),job=await env.service.enqueuePasswordReset(args);const result=await env.service.flush();assert.equal(result.unknown,1);assert.equal(JSON.stringify(result).includes(args.token),false);assert.equal(JSON.stringify(result).includes(apiKey),false);assert.equal(env.row(job.id).state,'unknown');await env.service.flush();assert.equal(calls,1);
});
test('troca de payload cifrado entre convite e recuperação falha antes do transporte',async t=>{
  const env=fixture(t),invite=await env.service.enqueueInvitation(input()),reset=await env.service.enqueuePasswordReset(input());env.db.prepare('UPDATE email_outbox SET payload=? WHERE id=?').run(env.row(invite.id).payload,reset.id);env.db.prepare("UPDATE email_outbox SET state='confirmed' WHERE id=?").run(invite.id);await env.service.flush();assert.equal(env.calls.length,0);assert.equal(env.row(reset.id).state,'failed');
});
test('encerramento impede novos convites/resets e preserva banco compartilhado',async t=>{
  const env=fixture(t);await env.service.close();await assert.rejects(env.service.enqueueInvitation(input()),error=>error.status===409);await assert.rejects(env.service.enqueuePasswordReset(input()),error=>error.status===409);assert.equal(env.db.prepare('SELECT 1 AS n').get().n,1);assert.equal(env.calls.length,0);
});
