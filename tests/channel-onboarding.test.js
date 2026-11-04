import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { ChannelOnboarding, channelConfigurationHash } from '../src/channel-onboarding.js';
import { knowledgeMetadataSnapshot } from '../src/postgres-bridge.js';

const status = expected => error => error.status === expected;
const at = time => new Date(time).toISOString();
function fixture(t) {
  const store = new Store(':memory:'), auth = new Auth(store.db);
  t.after(() => store.close());
  const user = auth.insertUser({name:'Administrador sintético',username:'channel-owner'},randomBytes(16),randomBytes(64),'reseller',[],'mep-demo');
  const actor = auth.actor(user), tenant = store.createTenant(actor,{name:'Empresa de validação sintética',segment:'QA'});
  const other = store.createTenant(actor,{name:'Outra empresa sintética',segment:'QA'});
  let now = Date.parse('2026-10-09T12:00:00Z'), available = true;
  store.mutate(actor,tenant.id,'Fixture',state=>{
    state.channels=[{id:'site',kind:'webchat',transport:'elozi-webchat',state:'connected',webchat:{version:1,enabled:true,origins:['https://synthetic.example.test']}}];
    state.conversations=[{id:'conversation-1',channelId:'site',version:1,messages:[]}];
  });
  const service = new ChannelOnboarding(store,{auth,available:()=>available,now:()=>now});
  const mutate = fn => store.mutate(actor,tenant.id,'Fixture',fn);
  const current = () => store.tenant(actor,tenant.id);
  const message = (id,kind,millis,extra={})=>({id,kind,text:'Conteúdo sintético privado '+id,createdAt:at(millis),transport:'webchat',delivery:kind==='customer'?'received':'sent',...extra});
  const add = (...messages)=>mutate(state=>state.conversations[0].messages.push(...messages));
  return {store,auth,actor,tenant,other,service,mutate,current,message,add,time:()=>now,tick:value=>now+=value,available:value=>available=value,
    get:()=>service.get(actor,tenant.id,'site'),post:input=>service.update(actor,tenant.id,'site',input)};
}

test('validação exige entrada nova, resposta enviada e confirmação humana persistida; iniciar não envia mensagens',t=>{
  const f=fixture(t), before=JSON.stringify(f.current().conversations);
  assert.equal(f.get().state,'not_started');
  const started=f.post({action:'start',version:0});
  assert.equal(started.version,1);assert.equal(started.state,'waiting_incoming');
  assert.equal(JSON.stringify(f.current().conversations),before);
  assert.throws(()=>f.post({action:'confirm',version:1}),status(409));
  f.tick(10);f.add(f.message('incoming','customer',f.time()));
  assert.equal(f.get().state,'waiting_reply');
  assert.equal(f.post({action:'start',version:1}).startedAt,started.startedAt,'retomada preserva o baseline');
  f.tick(10);f.add(f.message('reply','human',f.time(),{delivery:'pending'}));
  assert.equal(f.get().replyRecorded,false);
  f.mutate(state=>state.conversations[0].messages.at(-1).delivery='sent');
  const awaiting=f.get();assert.equal(awaiting.state,'waiting_confirmation');assert.equal(awaiting.version,1);
  assert.equal(awaiting.recipientConfirmed,false,'recibo do provedor não confirma o destinatário');
  const validated=f.post({action:'confirm',version:1});
  assert.equal(validated.state,'validated');assert.equal(validated.version,2);assert.equal(validated.recipientConfirmed,true);
  assert.equal(validated.conversationId,'conversation-1');assert.equal(validated.validatedAt,at(f.time()));
  assert.equal(f.current().channels[0].onboarding.confirmedBy,f.actor.userId);
  assert.equal(f.post({action:'confirm',version:2}).version,2,'confirmar novamente a revisão atual é idempotente');
  assert.throws(()=>f.post({action:'confirm',version:1}),status(409));
  const receipt=JSON.stringify(f.current().channels[0].onboarding), dto=JSON.stringify(validated);
  assert.doesNotMatch(receipt,/Conteúdo sintético privado|https:\/\/|incoming"|reply"/);
  assert.doesNotMatch(dto,/configurationHash|confirmedBy|incomingMessageHash|replyMessageHash|Conteúdo/);
});

test('baseline exclui histórico existente inclusive timestamps futuros; importados, igualdade temporal e canal alheio não contam',t=>{
  const f=fixture(t), baseline=f.time();
  f.add(f.message('old','customer',baseline-10),f.message('preexisting-future','customer',baseline+5));
  f.post({action:'start',version:0});f.tick(30);
  f.add(f.message('equal','customer',baseline),f.message('imported','customer',baseline+10,{imported:true}),
    f.message('historical','customer',baseline+11,{historical:true}),f.message('future','customer',f.time()+10),
    f.message('invalid','customer',baseline+12,{createdAt:'invalid'}),f.message('system','system',baseline+13),
    f.message('other-transport','customer',baseline+14,{transport:'email'}));
  f.mutate(state=>state.conversations.push({id:'other-channel-conversation',channelId:'another-channel',messages:[f.message('other-channel','customer',baseline+20)]}));
  assert.equal(f.get().state,'waiting_incoming');
});

test('atribuição, filas, falhas, rascunho e resposta anterior ou no mesmo instante não comprovam ida e volta',t=>{
  const f=fixture(t);f.post({action:'start',version:0});f.tick(30);
  f.add(f.message('earlier','human',f.time()-15),f.message('incoming','customer',f.time()-10),
    f.message('equal','human',f.time()-10),f.message('status','system',f.time()-9),
    ...['queued','pending','failed','unconfirmed','unknown'].map((delivery,index)=>f.message('failed-'+index,'human',f.time()-8+index,{delivery})),
    f.message('draft','agent',f.time()-2,{delivery:undefined}));
  f.mutate(state=>{Object.assign(state.conversations[0],{owner:'human',assignedUserId:f.actor.userId,status:'closed'});});
  assert.equal(f.get().state,'waiting_reply');
  assert.throws(()=>f.post({action:'confirm',version:1}),status(409));
  f.tick(2);f.add(f.message('live-reply','agent',f.time(),{delivery:'delivered'}));
  assert.equal(f.get().state,'waiting_confirmation');
});

test('entrada observada fica presa à conversa; outra ida e volta não substitui o destino e retirada da prova torna stale',t=>{
  const f=fixture(t);f.post({action:'start',version:0});f.tick(10);f.add(f.message('pinned','customer',f.time()));
  assert.equal(f.get().conversationId,'conversation-1');f.tick(10);
  f.mutate(state=>state.conversations.push({id:'conversation-2',channelId:'site',messages:[f.message('another-incoming','customer',f.time()-5),f.message('another-reply','human',f.time())]}));
  assert.equal(f.get().state,'waiting_reply');assert.equal(f.get().conversationId,'conversation-1');
  f.mutate(state=>state.conversations[0].messages=[]);
  assert.equal(f.get().state,'stale');
});

test('configuração alterada invalida e restauração não revive o aceite; nova tentativa tem novo baseline e CAS',t=>{
  const f=fixture(t);f.post({action:'start',version:0});f.tick(10);
  f.add(f.message('in','customer',f.time()-2),f.message('out','human',f.time()-1));f.post({action:'confirm',version:1});
  f.mutate(state=>state.channels[0].webchat.version++);
  assert.equal(f.get().state,'stale');assert.equal(f.get().validatedAt,null);assert.equal(f.get().recipientConfirmed,false);
  f.mutate(state=>state.channels[0].webchat.version--);
  assert.equal(f.get().state,'stale');assert.throws(()=>f.post({action:'confirm',version:2}),status(409));
  f.tick(10);const restarted=f.post({action:'start',version:2});
  assert.equal(restarted.version,3);assert.equal(restarted.state,'waiting_incoming');assert.equal(restarted.conversationId,null);
  assert.equal(f.current().channels[0].onboarding.confirmedBy,null);
});

test('indisponibilidade transitória é separada do aceite; canal indisponível não permite início ou confirmação',t=>{
  const f=fixture(t);f.available(false);assert.equal(f.get().channelAvailable,false);
  assert.throws(()=>f.post({action:'start',version:0}),status(409));f.available(true);
  f.post({action:'start',version:0});f.tick(10);f.add(f.message('in','customer',f.time()-2),f.message('out','human',f.time()-1));
  f.available(false);assert.throws(()=>f.post({action:'confirm',version:1}),status(409));f.available(true);
  f.post({action:'confirm',version:1});f.available(false);f.mutate(state=>state.channels[0].state='reconnecting');
  assert.equal(f.get().state,'validated');assert.equal(f.get().channelAvailable,false);
});

test('fingerprint invalida por identidade/revisão de todos os conectores e preserva cosméticos/estado transitório',()=>{
  const variants=[
    [{id:'c',kind:'whatsapp_qr',transport:'baileys',expectedNumber:'5511000000001'},channel=>channel.expectedNumber='5511000000002'],
    [{id:'c',kind:'telegram',transport:'telegram-bot',botAccountId:'123'},channel=>channel.botAccountId='124'],
    [{id:'c',kind:'telegram_user',transport:'telegram-user',telegramUser:{version:1,accountId:'123',configured:true}},channel=>channel.telegramUser.accountId='124'],
    [{id:'c',kind:'webchat',transport:'elozi-webchat',webchat:{version:1,enabled:true,origins:['https://one.example.test']}},channel=>channel.webchat.origins=['https://two.example.test']],
    [{id:'c',kind:'email',transport:'mepmail-channel',email:{version:1,epoch:'epoch-one',enabled:true,address:'one@example.test'}},channel=>channel.email.epoch='epoch-two'],
    [{id:'c',kind:'instagram',transport:'meta-instagram',meta:{version:1,enabled:true,resourceId:'123',apiVersion:'v25.0',credentialsConfigured:true}},channel=>channel.meta.version++],
    [{id:'c',kind:'messenger',transport:'meta-messenger',meta:{version:1,enabled:true,resourceId:'123',apiVersion:'v25.0',credentialsConfigured:true}},channel=>channel.meta.resourceId='124']
  ];
  for(const [channel,change] of variants){const before=channelConfigurationHash(channel);Object.assign(channel,{state:'reconnecting',name:'Nome novo',label:'Rótulo novo',lastStateAt:'2026-10-09',linkedAt:'2026-10-09'});assert.equal(channelConfigurationHash(channel),before);change(channel);assert.notEqual(channelConfigurationHash(channel),before);}
});

test('CAS e corpo estrito recusam replay, versão falsificada e dados extras sem mudar a prova',t=>{
  const f=fixture(t);
  for(const input of [null,[],{action:'start'},{action:'start',version:-1},{action:'start',version:'0'},{action:'start',version:0,text:'extra'},
    {action:'confirm',version:0,recipientConfirmed:true},{action:'reset',version:0},{action:'start',version:Number.MAX_SAFE_INTEGER}]) assert.throws(()=>f.post(input),status(400));
  assert.throws(()=>f.post({action:'start',version:1}),status(409));
  f.post({action:'start',version:0});assert.throws(()=>f.post({action:'start',version:0}),status(409));
  assert.equal(f.get().version,1);assert.equal(f.get().state,'waiting_incoming');
});

test('somente administrador real da empresa: suporte, serviço, demo, operador e escopo alheio são recusados',t=>{
  const f=fixture(t);
  for(const actor of [{...f.actor,supportGrantId:'synthetic-grant'},{...f.actor,kind:'service'}, {...f.actor,userId:undefined},
    {...f.actor,userId:'nonexistent-user'},{...f.actor,role:'operator',tenantIds:[f.tenant.id]}])
    assert.throws(()=>f.service.get(actor,f.tenant.id,'site'),error=>[401,403].includes(error.status));
  assert.throws(()=>f.service.get(f.actor,f.other.id,'site'),status(404));
  assert.throws(()=>f.service.get({...f.actor,resellerId:'foreign-workspace'},f.tenant.id,'site'),error=>[401,403,404].includes(error.status));
  assert.equal(f.get().state,'not_started');
});

test('reauthorização repetida na transação impede gravação quando a autorização é revogada durante a ação',t=>{
  const f=fixture(t);let checks=0;
  assert.throws(()=>f.service.update(f.actor,f.tenant.id,'site',{action:'start',version:0},{reauthorize:()=>++checks<4}),status(403));
  assert.equal(f.current().channels[0].onboarding,undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM audit WHERE action='Canal: validação iniciada'").get().count,0);
});

test('JSON recarregado preserva a prova entre sessões; projeção PostgreSQL remove todos os metadados privados',t=>{
  const f=fixture(t);f.post({action:'start',version:0});f.tick(10);
  f.add(f.message('in','customer',f.time()-2),f.message('out','human',f.time()-1));const expected=f.post({action:'confirm',version:1});
  const row=f.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.tenant.id);
  const loaded=JSON.parse(row.data);assert.equal(loaded.channels[0].onboarding.recipientConfirmed,true);
  f.store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(loaded),f.tenant.id);
  const reopened=new ChannelOnboarding(f.store,{auth:f.auth,available:()=>true,now:f.time});
  assert.deepEqual(reopened.get({...f.actor},f.tenant.id,'site'),expected);
  const projected=knowledgeMetadataSnapshot(structuredClone(f.current()));
  assert.equal(Object.hasOwn(projected.channels[0],'onboarding'),false);
  assert.doesNotMatch(JSON.stringify(projected),/incomingMessageHash|configurationHash|confirmedBy|baselineCounts/);
  assert.equal(f.current().channels[0].onboarding.confirmedBy,f.actor.userId,'projeção não remove a fonte autoritativa');
});

test('batch é limitado a vinte canais da empresa autorizada e não inclui conversa de outra empresa',t=>{
  const f=fixture(t);
  f.mutate(state=>{for(let i=1;i<23;i++)state.channels.push({id:'planned-'+i,kind:'telegram',state:'planned'});});
  const batch=f.service.list(f.actor,f.tenant.id);
  assert.equal(batch.tenantId,f.tenant.id);assert.equal(batch.items.length,20);
  assert.equal(batch.items.every(item=>item.tenantId===f.tenant.id&&item.conversationId===null),true);
  assert.equal(new Set(batch.items.map(item=>item.channelId)).size,20);
});

test('configuração observada em confirmação recusada fica stale mesmo antes do próximo GET e não cria schema',t=>{
  const f=fixture(t), tables=()=>f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const before=tables();f.post({action:'start',version:0});f.tick(10);
  f.add(f.message('in','customer',f.time()-2),f.message('out','human',f.time()-1));f.post({action:'confirm',version:1});
  f.mutate(state=>state.channels[0].webchat.version++);
  assert.throws(()=>f.post({action:'confirm',version:2}),status(409));
  f.mutate(state=>state.channels[0].webchat.version--);
  assert.equal(f.get().state,'stale');assert.deepEqual(tables(),before);
});
