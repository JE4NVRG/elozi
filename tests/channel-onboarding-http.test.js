import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { realtimeFixture } from './helpers/realtime-fixture.js';

const path='/api/tenants/rt-a1/channels/site/onboarding';
const keys=['tenantId','channelId','version','state','startedAt','validatedAt','conversationId','incomingRecorded','replyRecorded','recipientConfirmed','channelAvailable'].sort();
async function fixture(t){
  const f=await realtimeFixture(t);
  f.mutate('rt-a1',state=>{
    state.channels.push({id:'site',kind:'webchat',transport:'elozi-webchat',state:'connected',webchat:{version:1,enabled:true,origins:['https://fixture.example.test']}});
    state.conversations.push({id:'site-conversation',channelId:'site',owner:'human',assignedUserId:f.users.admin.id,version:1,status:'open',messages:[]});
  });
  const pair=async()=>{
    await setTimeout(5);const now=Date.now();
    f.mutate('rt-a1',state=>state.conversations.find(item=>item.id==='site-conversation').messages.push(
      {id:'synthetic-in',kind:'customer',text:'Entrada sintética privada',transport:'webchat',delivery:'received',createdAt:new Date(now-2).toISOString()},
      {id:'synthetic-out',kind:'human',text:'Resposta sintética privada',transport:'webchat',delivery:'sent',createdAt:new Date(now-1).toISOString()}));
  };
  return {...f,pair};
}

test('HTTP real permite fluxo apenas admin, CAS, retomada em segunda sessão e resposta sem conteúdo privado',async t=>{
  const f=await fixture(t);
  let result=await f.request(path);assert.equal(result.status,200,result.text);assert.deepEqual(Object.keys(result.data).sort(),keys);
  assert.equal(result.data.state,'not_started');assert.equal(result.data.channelAvailable,true);assert.equal(result.headers['cache-control'],'no-store');
  const before=JSON.stringify(f.tenant('rt-a1').conversations);
  result=await f.request(path,{method:'POST',body:{action:'start',version:0}});
  assert.equal(result.status,200,result.text);assert.equal(result.data.version,1);
  assert.equal(JSON.stringify(f.tenant('rt-a1').conversations),before,'o início não cria nem envia mensagem');
  assert.equal((await f.request(path,{method:'POST',body:{action:'start',version:0}})).status,409);
  await f.pair();result=await f.request(path);assert.equal(result.data.state,'waiting_confirmation');assert.equal(result.data.recipientConfirmed,false);
  result=await f.request(path,{method:'POST',body:{action:'confirm',version:1}});
  assert.equal(result.status,200,result.text);assert.equal(result.data.state,'validated');assert.equal(result.data.version,2);
  assert.doesNotMatch(result.text,/Entrada sintética|Resposta sintética|incomingMessageHash|confirmedBy|configurationHash/);
  const another=f.app.auth.session(f.db.prepare('SELECT * FROM auth_users WHERE id=?').get(f.users.admin.id));
  const reopened=await f.request(path,{headers:{Cookie:'mep_session='+another.token}});
  assert.deepEqual(reopened.data,result.data);
  const batch=await f.request('/api/tenants/rt-a1/channels/onboarding');
  assert.equal(batch.status,200,batch.text);assert.equal(batch.data.tenantId,'rt-a1');assert.equal(batch.data.items.length,3);
  assert.deepEqual(batch.data.items.find(item=>item.channelId==='site'),result.data);
  assert.doesNotMatch(batch.text,/Entrada sintética|Resposta sintética|wa-a2|wa-b1|incomingMessageHash|confirmedBy/);
});

test('HTTP recusa operador, anônimo, tenant alheio e canal de outra empresa em GET/POST/batch',async t=>{
  const f=await fixture(t);
  for(const operation of [path,'/api/tenants/rt-a1/channels/onboarding']){
    assert.equal((await f.request(operation,{as:'sales'})).status,403);
    assert.equal((await f.request(operation,{as:null})).status,401);
    assert.equal((await f.request(operation,{as:'foreign'})).status,404);
  }
  assert.equal((await f.request(path,{as:'sales',method:'POST',body:{action:'start',version:0}})).status,403);
  assert.equal((await f.request('/api/tenants/rt-a1/channels/wa-a2/onboarding')).status,404);
  assert.equal((await f.request('/api/tenants/rt-b1/channels/wa-b1/onboarding')).status,404);
  assert.equal(f.tenant('rt-a1').channels.find(item=>item.id==='site').onboarding,undefined);
});

test('HTTP todos os serializers do tenant retiram receipt até para admin; configuração altera a prova por CAS real',async t=>{
  const f=await fixture(t);await f.request(path,{method:'POST',body:{action:'start',version:0}});await f.pair();await f.request(path,{method:'POST',body:{action:'confirm',version:1}});
  for(const scope of ['/api/tenants/rt-a1','/api/tenants/rt-a1?summary=1']){
    const result=await f.request(scope);assert.equal(result.status,200,result.text);
    for(const channel of result.data.channels)assert.equal(Object.hasOwn(channel,'onboarding'),false);
    assert.doesNotMatch(result.text,/configurationHash|incomingMessageHash|confirmedBy|baselineCounts/);
  }
  const configured=await f.request('/api/tenants/rt-a1/channels/site/configuration',{method:'POST',body:{version:1,origins:['https://fixture.example.test'],enabled:true}});
  assert.equal(configured.status,200,configured.text);
  const stale=await f.request(path);assert.equal(stale.data.state,'stale');assert.equal(stale.data.recipientConfirmed,false);
  assert.equal((await f.request(path,{method:'POST',body:{action:'confirm',version:2}})).status,409);
});

test('HTTP reautoriza após await do body: revogação de papel em requisição parcial impede gravação',async t=>{
  const f=await fixture(t), original=f.app.auth.admin.bind(f.app.auth);
  let entered;const initialAuthority=new Promise(resolve=>entered=resolve);
  f.app.auth.admin=actor=>{const result=original(actor);entered();return result;};
  let pending;
  const response=new Promise((resolve,reject)=>{
    pending=httpRequest(f.base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:f.users.admin.cookie}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));
    });pending.on('error',reject);pending.write('{"action":"start",');
  });
  await initialAuthority;
  f.db.prepare("UPDATE auth_users SET role='operator',tenant_ids=? WHERE id=?").run(JSON.stringify(['rt-a1']),f.users.admin.id);
  pending.end('"version":0}');const result=await response;
  assert.equal(result.status,403,result.text);assert.equal(f.tenant('rt-a1').channels.find(item=>item.id==='site').onboarding,undefined);
});

test('HTTP corpo inválido e métodos inadequados não começam prova; batch nunca passa de vinte itens',async t=>{
  const f=await fixture(t);
  for(const body of [{action:'start',version:'0'},{action:'start',version:0,text:'extra'},{action:'confirm',version:0,recipientConfirmed:true}])
    assert.equal((await f.request(path,{method:'POST',body})).status,400);
  const method=await f.request(path,{method:'DELETE'});assert.equal(method.status,405);assert.equal(method.headers.allow,'GET, POST');
  f.mutate('rt-a1',state=>{for(let i=0;i<25;i++)state.channels.push({id:'planned-'+i,kind:'telegram',state:'planned'});});
  const batch=await f.request('/api/tenants/rt-a1/channels/onboarding');assert.equal(batch.status,200,batch.text);assert.equal(batch.data.items.length,20);
  assert.equal(batch.data.items.every(item=>item.tenantId==='rt-a1'),true);
});

test('HTTP disponibilidade WA/TG exige entrada viva do runtime com identidade do mesmo tenant; estado persistido não basta',async t=>{
  const f=await fixture(t), wa='/api/tenants/rt-a1/channels/wa-a1/onboarding', tg='/api/tenants/rt-a1/channels/tg-a1/onboarding';
  assert.equal((await f.request(wa)).data.channelAvailable,false);
  Object.assign(f.app.gateway.entries.get('wa-a1'),{matched:true,expectedNumber:'5511000000001'});
  assert.equal((await f.request(wa)).data.channelAvailable,true);
  f.app.gateway.entries.get('wa-a1').tenantId='rt-a2';
  assert.equal((await f.request(wa)).data.channelAvailable,false);
  assert.equal((await f.request(tg)).data.channelAvailable,false);
  f.mutate('rt-a1',state=>state.channels.find(item=>item.id==='tg-a1').botAccountId='123');
  f.app.telegram.entries.set('tg-a1',{tenantId:'rt-a1',channelId:'tg-a1',botId:'123',state:'connected',abort:new AbortController(),stopped:false});
  assert.equal((await f.request(tg)).data.channelAvailable,true);
  f.app.telegram.entries.get('tg-a1').botId='124';
  assert.equal((await f.request(tg)).data.channelAvailable,false);
});
