import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {CommercialAccounts} from '../src/commercial-accounts.js';
import {Billing} from '../src/billing.js';
import {CommercialUsage,COMMERCIAL_USAGE_TRANSPORTS} from '../src/commercial-usage.js';

const status=code=>error=>error.status===code;
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE auth_users(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL,role TEXT NOT NULL,disabled_at INTEGER,platform_admin INTEGER NOT NULL,tenant_ids TEXT NOT NULL,name TEXT,secret TEXT);
    CREATE TABLE auth_workspace_access(user_id TEXT NOT NULL,reseller_id TEXT NOT NULL,created_at INTEGER,PRIMARY KEY(user_id,reseller_id));
    CREATE TABLE service_principals(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL,tenant_id TEXT NOT NULL,active INTEGER NOT NULL,expires_at INTEGER NOT NULL,token_hash TEXT);`);
  const account=(id,kind,parent,version=1)=>db.prepare('INSERT INTO resellers VALUES (?,?)').run(id,JSON.stringify({name:'Conta '+id,accountKind:kind,parentWorkspaceId:parent,version,secret:'PRIVATE_ACCOUNT_SECRET'}));
  account('platform','platform',null);account('seller','reseller','platform',4);account('other','reseller','platform');account('buyer','business','seller',2);account('foreign','business','other');account('empty','business','seller');
  const tenant=(id,workspace,channels=[],agents=[])=>db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id,workspace,JSON.stringify({name:'Unidade '+id,channels,agents,conversations:[{contact:'PRIVATE_CONTACT',messages:[{text:'PRIVATE_MESSAGE'}]}],credential:'PRIVATE_PROVIDER_SECRET'}));
  const channel=(transport,state,extra={})=>({id:randomUUID(),name:'PRIVATE_CHANNEL_NAME',number:'PRIVATE_PHONE',transport,state,...extra});
  tenant('seller-unit','seller',[channel('baileys','connected')],[{configured:true}]);
  tenant('buyer-unit','buyer',[
    channel('baileys','connected'),channel('baileys','disconnected'),channel('telegram-bot','connected',{enabled:false}),channel('elozi-webchat','connected'),
    channel('mepmail-channel','planned'),channel('meta-instagram','disabled'),channel('meta-messenger','connected'),channel('future-transport','future-state')
  ],[{configured:true,name:'PRIVATE_AGENT'},{configured:false},{configured:'true'},null,'primitive']);
  tenant('other-unit','other',[channel('baileys','connected')]);tenant('foreign-unit','foreign',[channel('telegram-bot','connected')]);
  const user=(id,workspace,role='reseller',platform=0,disabled=null,tenantIds=[])=>db.prepare('INSERT INTO auth_users VALUES (?,?,?,?,?,?,?,?)').run(id,workspace,role,disabled,platform,JSON.stringify(tenantIds),'PRIVATE_PERSON','PRIVATE_PERSON_SECRET');
  user('root','platform','reseller',1);user('seller-admin','seller');user('seller-op','seller','operator',0,null,['seller-unit']);user('buyer-admin','buyer');user('buyer-op','buyer','operator',0,null,['buyer-unit']);user('other-admin','other');user('disabled','buyer','reseller',0,1);
  for(const id of ['platform','seller','buyer'])db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,0)').run('root',id);
  const clock={value:Date.parse('2026-10-05T12:00:00Z')},actors={root:{userId:'root',resellerId:'platform'},seller:{userId:'seller-admin',resellerId:'seller'},buyer:{userId:'buyer-admin',resellerId:'buyer'},other:{userId:'other-admin',resellerId:'other'}};
  const validateActor=input=>{
    if(input?.kind==='service')return {...input,role:'reseller'};
    const row=db.prepare('SELECT id,reseller_id,role,disabled_at,platform_admin FROM auth_users WHERE id=?').get(input?.userId??'');
    if(!row||row.disabled_at!==null||input.resellerId!==row.reseller_id&&!(row.platform_admin&&db.prepare('SELECT 1 FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').get(row.id,input.resellerId)))throw Object.assign(Error('Acesso revogado'),{status:403});
    return {userId:row.id,resellerId:input.resellerId,role:row.role,platformAdmin:row.platform_admin===1,...(input.supportGrantId?{supportGrantId:input.supportGrantId}:{})};
  };
  const store={db,provisionReseller(){throw Error('Provisionamento proibido');}};
  const accounts=new CommercialAccounts(store,{validateActor,isPlatformAdmin:actor=>validateActor(actor).platformAdmin,platformWorkspaceId:'platform',now:()=>clock.value});
  let legacyUsageCalls=0,legacyTenantCalls=0;
  const billing=new Billing(db,{validateActor,isPlatformAdmin:actor=>validateActor(actor).platformAdmin,now:()=>clock.value,
    getWorkspaces:()=>db.prepare("SELECT id,json_extract(data,'$.name') AS name,json_extract(data,'$.accountKind') AS accountKind,json_extract(data,'$.parentWorkspaceId') AS parentWorkspaceId FROM resellers").all(),
    getTenants:(_actor,workspace)=>{legacyTenantCalls++;return db.prepare("SELECT id,json_extract(data,'$.name') AS name FROM tenants WHERE reseller_id=?").all(workspace);},
    getUsage:()=>{legacyUsageCalls++;return {connections:99,users:99,agent_service:99};}
  });
  const usage=new CommercialUsage(accounts,billing,{now:()=>clock.value});
  const service=(id,workspace,tenantId,active=1,expires=clock.value+1000)=>db.prepare('INSERT INTO service_principals VALUES (?,?,?,?,?,?)').run(id,workspace,tenantId,active,expires,'PRIVATE_SERVICE_TOKEN');
  service('seller-service','seller','seller-unit');service('buyer-service','buyer','buyer-unit');service('inactive-service','buyer','buyer-unit',0);service('expired-service','buyer','buyer-unit',1,clock.value);service('foreign-service','foreign','foreign-unit');
  const terms=extra=>({requestId:randomUUID(),scope:'workspace',targetKind:'reseller',targetWorkspaceId:'buyer',name:'Contrato QA',currency:'BRL',items:[{kind:'subscription',label:'PRIVATE_PRICE_LABEL',unitCents:777777,units:1,metered:false}],quotas:{connections:2,users:1,agent_service:0,email:9},periodMonths:1,startsAt:'2026-10-01',endsAt:null,graceDays:3,state:'active',reason:'PRIVATE_FINANCIAL_REASON',...extra});
  return {db,accounts,billing,usage,actors,clock,tenant,channel,terms,legacyCalls:()=>({usage:legacyUsageCalls,tenants:legacyTenantCalls}),contract:(actor=actors.seller,extra={})=>billing.createContract(actor,terms(extra))};
}
function snapshot(db){return db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>({...row,rows:db.prepare('SELECT * FROM '+row.name+' ORDER BY rowid').all()}));}

test('own mede inventário registrado por transporte/estado sem expor dados ou confundir enabled=false com conexão',t=>{
  const f=fixture(t),r=f.usage.overview(f.actors.seller,'buyer');
  assert.deepEqual(r.account,{id:'buyer',name:'Conta buyer',kind:'business',version:2});assert.equal(r.scope,'own');assert.equal(r.measuredAt,'2026-10-05T12:00:00.000Z');assert.deepEqual(r.includedAccounts,{count:1,ids:['buyer']});
  assert.deepEqual({...r.inventory.channels,byTransport:undefined},{registered:8,connected:3,disconnected:2,disabled:2,unknown:1,byTransport:undefined});
  assert.deepEqual(r.inventory.channels.byTransport.map(c=>c.transport),COMMERCIAL_USAGE_TRANSPORTS);
  assert.equal(r.inventory.channels.byTransport.find(c=>c.transport==='telegram-bot').disabled,1);assert.equal(r.inventory.channels.byTransport.find(c=>c.transport==='other').unknown,1);
  assert.deepEqual(r.inventory.users,{active:3,memberships:3});assert.deepEqual(r.inventory.agents,{registered:3,configured:1});assert.deepEqual(r.inventory.servicePrincipals,{active:1});assert.deepEqual(r.quotas,[]);
  assert.deepEqual(r.definitions,{channelState:'stored',memberships:'distinct-user-workspace',quotaPreviewOnly:true});
  for(const marker of ['PRIVATE_',f.db.prepare('SELECT id FROM auth_users LIMIT 1').get().id])assert.equal(JSON.stringify(r).includes(marker),false);
});

test('portfolio agrega própria revenda e somente clientes diretos; deduplica pessoas e memberships sem herdar atendimento',t=>{
  const f=fixture(t),r=f.usage.overview(f.actors.seller,'seller',{scope:'portfolio'});
  assert.deepEqual(r.includedAccounts,{count:3,ids:['buyer','empty','seller']});assert.equal(r.inventory.tenants,2);assert.deepEqual(r.inventory.users,{active:5,memberships:6});
  assert.equal(r.inventory.channels.registered,9);assert.deepEqual(r.inventory.agents,{registered:4,configured:2});assert.deepEqual(r.inventory.servicePrincipals,{active:2});
  f.db.prepare("UPDATE resellers SET data=json_set(data,'$.parentWorkspaceId','buyer') WHERE id='empty'").run();
  assert.deepEqual(f.usage.overview(f.actors.seller,'seller',{scope:'portfolio'}).includedAccounts.ids,['buyer','seller']);
  assert.throws(()=>f.usage.overview(f.actors.buyer,'buyer',{scope:'portfolio'}),status(403));assert.throws(()=>f.usage.overview(f.actors.buyer,'seller'),status(404));assert.throws(()=>f.usage.overview(f.actors.seller,'foreign'),status(404));
});

test('principal pode medir global ou carteira de uma revenda; administrador comum da plataforma não ganha visão global',t=>{
  const f=fixture(t),global=f.usage.overview(f.actors.root,'platform',{scope:'portfolio'});
  assert.equal(global.includedAccounts.count,6);assert.equal(global.inventory.tenants,4);assert.deepEqual(global.inventory.users,{active:6,memberships:8});
  assert.deepEqual(f.usage.overview(f.actors.root,'seller',{scope:'portfolio'}).includedAccounts.ids,['buyer','empty','seller']);
  f.db.prepare("INSERT INTO auth_users VALUES ('platform-admin','platform','reseller',NULL,0,'[]','n','s')").run();
  const common={userId:'platform-admin',resellerId:'platform'};assert.equal(f.usage.overview(common,'platform').inventory.users.active,2);assert.throws(()=>f.usage.overview(common,'platform',{scope:'portfolio'}),status(403));
});

test('ACL usa ator persistido e recusa operador, serviço, suporte, revogação e conta alheia',t=>{
  const f=fixture(t);
  for(const actor of [{userId:'seller-op',resellerId:'seller',role:'reseller',platformAdmin:true},{...f.actors.seller,kind:'service'},{...f.actors.root,supportGrantId:'grant'},{userId:'disabled',resellerId:'buyer'},{...f.actors.seller,resellerId:'other'}])assert.throws(()=>f.usage.overview(actor),status(403));
  assert.throws(()=>f.usage.overview({...f.actors.seller,platformAdmin:true},'other'),status(404));
  f.db.prepare("UPDATE auth_users SET disabled_at=123 WHERE id='seller-admin'").run();assert.throws(()=>f.usage.overview(f.actors.seller),status(403));
});

test('conta vazia tem oito transportes zero e lista de quotas vazia sem inferir ilimitado',t=>{
  const f=fixture(t),r=f.usage.overview(f.actors.seller,'empty');assert.equal(r.inventory.tenants,0);assert.deepEqual(r.inventory.users,{active:0,memberships:0});assert.equal(r.inventory.agents.configured,0);assert.equal(r.inventory.servicePrincipals.active,0);assert.deepEqual(r.quotas,[]);
  assert.equal(r.inventory.channels.registered,0);assert.equal(r.inventory.channels.byTransport.length,8);for(const c of r.inventory.channels.byTransport)assert.deepEqual({...c,transport:undefined},{transport:undefined,registered:0,connected:0,disconnected:0,disabled:0,unknown:0});
});

test('arrays malformados, tipos desconhecidos e itens não-objeto não criam canais/agentes fictícios',t=>{
  const f=fixture(t);f.db.prepare("UPDATE tenants SET data=json_set(data,'$.channels',json(?),'$.agents',json(?)) WHERE id='buyer-unit'").run(JSON.stringify([null,'x',1,{},f.channel('baileys','CONNECTED'),{kind:'telegram',state:'connected'}]),JSON.stringify({configured:true}));
  const r=f.usage.overview(f.actors.buyer,'buyer');assert.equal(r.inventory.channels.registered,3);assert.equal(r.inventory.channels.unknown,2);assert.equal(r.inventory.channels.connected,1);assert.equal(r.inventory.channels.byTransport.find(c=>c.transport==='other').registered,1);assert.equal(r.inventory.channels.byTransport.find(c=>c.transport==='telegram-bot').registered,1);assert.deepEqual(r.inventory.agents,{registered:0,configured:0});
});

test('conectores reais do registry e aliases legados são separados por tipo com transporte explícito prioritário',t=>{
  const f=fixture(t),transports=[
    ['baileys','baileys'],['telegram-bot','telegram-bot'],
    ['elozi-webchat','webchat'],['webchat','webchat'],['mepmail-channel','email'],['email','email'],
    ['meta-instagram','instagram'],['instagram','instagram'],['meta-messenger','messenger'],['messenger','messenger']
  ];
  f.db.prepare("UPDATE tenants SET data=json_set(data,'$.channels',json(?)) WHERE id='buyer-unit'").run(JSON.stringify(
    transports.map(([transport],index)=>f.channel(transport,index%2?'planned':'connected',{kind:'unsupported-kind'}))
  ));
  const r=f.usage.overview(f.actors.buyer,'buyer'),byType=r.inventory.channels.byTransport;
  assert.deepEqual({...r.inventory.channels,byTransport:undefined},{registered:10,connected:5,disconnected:5,disabled:0,unknown:0,byTransport:undefined});
  for(const type of ['webchat','email','instagram','messenger'])
    assert.deepEqual(byType.find(row=>row.transport===type),{transport:type,registered:2,connected:1,disconnected:1,disabled:0,unknown:0});
  assert.equal(byType.find(row=>row.transport==='baileys').registered,1);
  assert.equal(byType.find(row=>row.transport==='telegram-bot').registered,1);
  assert.equal(byType.find(row=>row.transport==='other').registered,0);
});

test('canais planejados e sandbox usam somente kinds suportados quando não há transporte concreto',t=>{
  const f=fixture(t),kinds={whatsapp_qr:'baileys',telegram:'telegram-bot',webchat:'webchat',email:'email',instagram:'instagram',messenger:'messenger'};
  const channels=Object.keys(kinds).flatMap(kind=>[
    {kind,state:'planned'},{kind,state:'sandbox',transport:null},
    {kind,state:'planned',transport:'none'},{kind,state:'sandbox',transport:'sandbox'}
  ]);
  channels.push(
    {kind:'whatsapp_cloud',state:'planned'},{kind:'whatsapp_cloud',transport:'none',state:'planned'},
    {kind:'telegram_group',transport:'sandbox',state:'sandbox'},{kind:'unknown-kind',state:'planned'},
    {kind:'webchat',transport:'future-transport',state:'connected'},
    {kind:'webchat',transport:'',state:'planned'},{kind:'email',transport:123,state:'planned'},
    {kind:'messenger',transport:false,state:'planned'},{kind:'instagram',transport:{name:'none'},state:'planned'}
  );
  f.db.prepare("UPDATE tenants SET data=json_set(data,'$.channels',json(?)) WHERE id='buyer-unit'").run(JSON.stringify(channels));
  const byType=f.usage.overview(f.actors.buyer,'buyer').inventory.channels.byTransport;
  for(const type of Object.values(kinds))
    assert.deepEqual(byType.find(row=>row.transport===type),{transport:type,registered:4,connected:0,disconnected:4,disabled:0,unknown:0});
  assert.deepEqual(byType.find(row=>row.transport==='other'),{transport:'other',registered:9,connected:1,disconnected:8,disabled:0,unknown:0});
});

test('grupos contam uma conexão e fallback de kind não altera a quantidade financeira nem escreve',t=>{
  const f=fixture(t),channels=[
    f.channel('baileys','connected',{kind:'whatsapp_qr',groups:{allowed:['PRIVATE_GROUP_A','PRIVATE_GROUP_B']}}),
    f.channel('telegram-bot','connected',{kind:'telegram',groups:{allowed:['PRIVATE_GROUP_C','PRIVATE_GROUP_D']},enabled:false}),
    {kind:'whatsapp_qr',transport:'sandbox',state:'sandbox'},{kind:'telegram',state:'planned'},
    f.channel('elozi-webchat','connected',{kind:'email'})
  ];
  f.db.prepare("UPDATE tenants SET data=json_set(data,'$.channels',json(?)) WHERE id='buyer-unit'").run(JSON.stringify(channels));
  f.contract();const before=snapshot(f.db),r=f.usage.overview(f.actors.buyer,'buyer'),byType=r.inventory.channels.byTransport;
  assert.deepEqual(byType.find(row=>row.transport==='baileys'),{transport:'baileys',registered:2,connected:1,disconnected:1,disabled:0,unknown:0});
  assert.deepEqual(byType.find(row=>row.transport==='telegram-bot'),{transport:'telegram-bot',registered:2,connected:0,disconnected:1,disabled:1,unknown:0});
  assert.equal(byType.find(row=>row.transport==='webchat').registered,1);
  assert.equal(byType.find(row=>row.transport==='email').registered,0);
  assert.equal(r.inventory.channels.registered,5);
  assert.deepEqual(r.quotas[0].lines.find(line=>line.metric==='connections'),{metric:'connections',quantity:2,limit:2,excess:0,remaining:0,quantityBasis:'registered-whatsapp-qr-telegram'});
  assert.equal(JSON.stringify(r).includes('PRIVATE_'),false);assert.deepEqual(snapshot(f.db),before);
});

test('quota vigente usa contagens Billing próprias e cadastradas; inclui nomes seguros sem preço e sem somar contratos',t=>{
  const f=fixture(t),a=f.contract(),b=f.contract(f.actors.seller,{name:'Outro contrato',quotas:{connections:5}}),beforeCalls=f.legacyCalls(),originalUsage=f.billing.getUsage;
  const r=f.usage.overview(f.actors.seller,'buyer');assert.equal(r.quotas.length,2);assert.equal(r.inventory.users.active,3);assert.deepEqual(f.legacyCalls(),beforeCalls);assert.equal(f.billing.getUsage,originalUsage);
  const quota=r.quotas.find(c=>c.id===a.id);assert.equal(quota.name,'Contrato QA');assert.equal(quota.revision,1);assert.equal(quota.status,'active');assert.deepEqual(quota.target,{kind:'reseller',workspaceId:'buyer',tenantId:null,name:'Conta buyer',workspaceName:'Conta buyer'});
  assert.deepEqual(quota.lines.find(line=>line.metric==='connections'),{metric:'connections',quantity:3,limit:2,excess:1,remaining:0,quantityBasis:'registered-whatsapp-qr-telegram'});
  assert.deepEqual(quota.lines.find(line=>line.metric==='users'),{metric:'users',quantity:2,limit:1,excess:1,remaining:0,quantityBasis:'active-users-own-workspace'});
  assert.deepEqual(quota.lines.find(line=>line.metric==='agent_service'),{metric:'agent_service',quantity:1,limit:0,excess:1,remaining:0,quantityBasis:'active-unexpired-service-identities'});
  assert.deepEqual(quota.lines.find(line=>line.metric==='email'),{metric:'email',quantity:null,limit:9,excess:null,remaining:null,quantityBasis:'unavailable'});
  assert.equal(r.quotas.find(c=>c.id===b.id).lines.find(line=>line.metric==='connections').remaining,2);
  for(const marker of ['PRIVATE_PRICE_LABEL','777777','PRIVATE_FINANCIAL_REASON','unitCents','currency','token','PRIVATE_'])assert.equal(JSON.stringify(r).includes(marker),false);
  assert.deepEqual(f.usage.overview(f.actors.buyer,'buyer').quotas.map(c=>c.id),r.quotas.map(c=>c.id));
});

test('contratos financeiros respeitam o mesmo ator, o alvo e a revisão; plataforma não herda contratos da revenda',t=>{
  const f=fixture(t),c=f.contract(),foreign=f.contract(f.actors.other,{targetWorkspaceId:'foreign'}),platform=f.contract(f.actors.root,{scope:'platform',targetWorkspaceId:'seller'});
  assert.deepEqual(f.usage.overview(f.actors.root,'platform',{scope:'portfolio'}).quotas.map(c=>c.id),[platform.id]);
  assert.deepEqual(f.usage.overview(f.actors.seller,'seller',{scope:'portfolio'}).quotas.map(c=>c.id).sort(),[c.id,platform.id].sort());
  assert.equal(JSON.stringify(f.usage.overview(f.actors.seller,'seller',{scope:'portfolio'})).includes(foreign.id),false);
  const {requestId,scope,targetKind,targetWorkspaceId,...body}=f.terms({name:'Revisão atual',quotas:{connections:4}});f.billing.updateContract(f.actors.seller,c.id,{...body,requestId:randomUUID(),version:1});
  const revised=f.usage.overview(f.actors.buyer,'buyer').quotas[0];assert.equal(revised.revision,2);assert.equal(revised.name,'Revisão atual');assert.equal(revised.lines.find(line=>line.metric==='connections').remaining,1);
});

test('contratos sem vigência atual e encerrados são omitidos; conta/unidade usam bases distintas corretamente',t=>{
  const f=fixture(t);f.contract(f.actors.seller,{startsAt:'2026-11-01'});f.contract(f.actors.seller,{startsAt:'2026-01-01',endsAt:'2026-10-04'});f.contract(f.actors.seller,{state:'ended'});
  assert.deepEqual(f.usage.overview(f.actors.buyer,'buyer').quotas,[]);
  f.tenant('seller-other-unit','seller',[f.channel('telegram-bot','disconnected')]);f.db.prepare("UPDATE auth_users SET tenant_ids='[]' WHERE id='seller-op'").run();
  const c=f.contract(f.actors.seller,{targetKind:'tenant',targetWorkspaceId:undefined,tenantId:'seller-unit'}),r=f.usage.overview(f.actors.seller,'seller'),q=r.quotas.find(q=>q.id===c.id);
  assert.equal(r.inventory.channels.registered,2);assert.equal(q.target.name,'Unidade seller-unit');assert.equal(q.target.workspaceName,'Conta seller');assert.equal(q.lines.find(line=>line.metric==='connections').quantity,1);assert.equal(q.lines.find(line=>line.metric==='users').quantity,1);
});

test('classe não cria schema e overview só usa projeções SQL sem carregar tenant.data nem escrever',t=>{
  const f=fixture(t);f.contract();const before=snapshot(f.db),usage=new CommercialUsage(f.accounts,f.billing,{now:()=>f.clock.value}),prepare=f.db.prepare.bind(f.db),statements=[];
  assert.deepEqual(snapshot(f.db),before);
  f.db.prepare=sql=>{statements.push(sql);if(/\bFROM\s+tenants\b/i.test(sql)&&(/\bSELECT\s+\*/i.test(sql)||/(?:SELECT|,)\s*(?:\w+\.)?data(?:\s*,|\s+FROM)/i.test(sql)))throw Error('Leitura de tenant.data inteiro proibida');return prepare(sql);};
  f.db.exec('PRAGMA query_only=ON');const r=usage.overview(f.actors.seller,'seller',{scope:'portfolio'});f.db.prepare=prepare;assert.equal(r.quotas.length,1);assert.deepEqual(snapshot(f.db),before);assert.ok(statements.some(sql=>sql.includes('json_each')));
});

test('opções inválidas e relógios/autoridades assíncronas falham sem escrita',t=>{
  const f=fixture(t),before=snapshot(f.db);
  for(const options of [{scope:'all'},{scope:null},{scope:'own',debug:true},[],null,'portfolio'])assert.throws(()=>f.usage.overview(f.actors.seller,'seller',options),status(400));
  for(const now of [()=>NaN,()=>Infinity,()=>Promise.resolve(f.clock.value)])assert.throws(()=>new CommercialUsage(f.accounts,f.billing,{now}).overview(f.actors.seller,'seller'),status(500));
  const validate=f.billing.validateActor;f.billing.validateActor=input=>({...validate(input),userId:'another'});assert.throws(()=>f.usage.overview(f.actors.seller,'seller'),status(403));assert.deepEqual(snapshot(f.db),before);
});
