import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';

const panelOrigin = 'https://elozi.http.example.test', visitorOrigin = 'https://mepmail.http.example.test';
const host = new URL(panelOrigin).hostname, defer = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise,resolve};};
const widget = {displayName:'MepMail',theme:'dark',colors:{primary:'#7957df',panel:'#171626'},radius:16,openButtonLabel:'Suporte',credit:{visible:false,text:''},greeting:{'pt-BR':'Olá! Como podemos ajudar?','en':'Hello! How can we help?'},verifiedGreeting:{'pt-BR':'Olá, {name}!','en':'Hello, {name}!'},handoffMessage:{'pt-BR':'A equipe humana continuará por aqui.','en':'The human team will continue here.'},emailPrompt:true,attachmentsEnabled:false,voiceEnabled:false,feedbackEnabled:true,handoffNotificationEmail:'support@example.test',assistantInstructions:'Contexto sintético aprovado do MepMail.'};

async function fixture(t) {
  const key = Buffer.alloc(32,83), calls = {external:[],provider:[],email:[]}, control = {now:Date.now()};
  const deny = async () => {calls.external.push(true); throw new Error('Rede externa proibida no fixture HTTP RAM.');};
  const app = createApp({databasePath:':memory:',serviceKey:key,publicOrigin:panelOrigin,allowRegistration:false,providerCall:async input => {calls.provider.push(input); return 'A equipe humana continuará por aqui.';},mcpFetchImpl:deny,
    gatewayOptions:{authKey:key,socketFactory:deny,downloadMediaImpl:deny},telegramOptions:{authKey:key,polling:false,fetchImpl:deny},googleOptions:{clientId:''},
    emailOptions:{key,apiKey:'ms_synthetic_http_fixture_key',from:'Elozi <support@example.test>',fetchImpl:async (url,input) => {calls.email.push({url,method:input.method,headers:input.headers,payload:JSON.parse(input.body)}); return new Response(JSON.stringify({id:'synthetic-email-'+calls.email.length}),{status:200,headers:{'Content-Type':'application/json'}});}},
    emailChannelOptions:{fetchImpl:deny},metaOptions:{fetchImpl:deny,mediaDownloader:deny},mediaOptions:{directory:null,authKey:key},webchatOptions:{now:() => control.now,supportImmediate:false}});
  let sequence = 0;
  const member = (role='reseller',workspace='mep-demo',tenantIds=[],platformAdmin=false) => {
    const row = app.auth.insertUser({username:'webchat.support.http.'+(++sequence),name:'Pessoa HTTP '+sequence},Buffer.alloc(16,sequence),Buffer.alloc(64,sequence),role,tenantIds,workspace,{platformAdmin}), session = app.auth.session(row);
    return {actor:session.actor,cookie:'mep_session='+session.token,id:row.id};
  };
  const owner = member('reseller','mep-demo',[],true), tenant = app.store.createTenant(owner.actor,{name:'Suporte MepMail RAM',segment:'QA'});
  app.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('http-other-workspace',JSON.stringify({name:'Outro workspace RAM',accountKind:'business',brand:{name:'Outro'}}));
  const outsider = member('reseller','http-other-workspace'), other = app.store.createTenant(outsider.actor,{name:'Empresa externa RAM',segment:'QA'}), operator = member('operator','mep-demo',[tenant.id]);
  for (const [actor,target,channelIds] of [[owner.actor,tenant,['http-site','sibling-site']],[outsider.actor,other,['foreign-site']]]) app.store.mutate(actor,target.id,'Fixture webchat HTTP',state => {
    state.channels = channelIds.map(id => ({id,kind:'webchat',name:id,state:'planned'})); state.conversations = []; state.departments = [{id:'support',name:'Suporte',active:true,memberIds:[],distribution:'manual',version:1}]; state.defaultDepartmentId = 'support';
  });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.centralSupport.close(); await app.autopilot.close();
    await Promise.all([app.webchat.close(),app.gateway.close(),app.telegram.close(),app.telegramUser.close(),app.emailChannel.close(),app.meta.close(),app.email.close(),app.bridge.close()]); app.store.close();
    assert.deepEqual(calls.external,[],'Nenhum transporte ou segredo produtivo foi acessado.');
  });
  const pending = (path,{method='GET',actor=owner,requestOrigin=panelOrigin,headers={},body,raw} = {}) => {
    const outgoing = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body))); let req;
    const promise = new Promise((resolve,reject) => {
      req = httpRequest({hostname:'127.0.0.1',port:app.server.address().port,path,method,headers:{Host:host,Origin:requestOrigin,'Content-Type':'application/json',...(actor?{Cookie:actor.cookie}:{}),...(outgoing?{'Content-Length':outgoing.length}:{}),...headers}},res => {
        const chunks=[]; res.on('error',reject);res.on('data',chunk => chunks.push(chunk));res.on('end',() => {try {const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,text,data:res.headers['content-type']?.includes('application/json')?JSON.parse(text):undefined});} catch(error){reject(error);}});
      });req.on('error',reject);req.setTimeout(3000,() => req.destroy(new Error('Fixture HTTP loopback excedeu prazo.')));
    });
    t.after(() => req.destroy());return {req,promise,end:() => req.end(outgoing)};
  };
  const request = (path,options) => {const opened=pending(path,options);opened.end();return opened.promise;};
  const channelPath = (suffix,tid=tenant.id,cid='http-site') => `/api/tenants/${tid}/channels/${cid}/${suffix}`;
  const publicPath = (action,tid=tenant.id,cid='http-site') => `/api/public/webchat/${tid}/${cid}/${action}`;
  const publicRequest = (action,body={},options={}) => request(publicPath(action,options.tenantId,options.channelId),{method:'POST',actor:null,requestOrigin:visitorOrigin,body,...options});
  for (const [tid,cid,actor] of [[tenant.id,'http-site',owner],[tenant.id,'sibling-site',owner],[other.id,'foreign-site',outsider]]) {const result=await request(channelPath('configuration',tid,cid),{method:'POST',actor,body:{version:0,origins:[visitorOrigin],enabled:true}});assert.equal(result.status,200,result.text);}
  const state = () => app.store.tenant(owner.actor,tenant.id), conversation = visitor => {const row=app.store.db.prepare('SELECT conversation_id FROM webchat_sessions WHERE token_hash=?').get(createHash('sha256').update(visitor.token).digest('hex'));return state().conversations.find(value => value.id===row?.conversation_id);};
  const open = async (input={}) => {const challenge=await publicRequest('challenge');assert.equal(challenge.status,200,challenge.text);const result=await publicRequest('session',{challenge:challenge.data.challenge,name:'Visitante sintético',...input});assert.equal(result.status,200,result.text);return result.data;};
  const receive = (visitor,text='Mensagem sintética',clientMessageId=randomUUID()) => publicRequest('messages',{token:visitor.token,text,clientMessageId});
  const configureWidget = async (configuration=widget,version=0,options={}) => request(channelPath('widget-configuration'),{method:'POST',body:{version,widget:configuration},...options});
  const prepareIdentity = async () => {
    const configured=await request(channelPath('identity/configure'),{method:'POST',body:{version:0,enabled:true,issuer:visitorOrigin,externalIdPrefix:'mepmail'}});assert.equal(configured.status,200,configured.text);
    const created=await request(channelPath('identity/create-key'),{method:'POST',body:{version:1}});assert.equal(created.status,200,created.text);return created;
  };
  const token = (identityKey,extra={}) => {const at=Math.floor(control.now/1000),head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT',kid:identityKey.kid})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:visitorOrigin,aud:'elozi:webchat:http-site',sub:'synthetic-account-1',email:'verified@example.test',email_verified:true,name:'Pessoa do MepMail',locale:'en',iat:at-1,exp:at+599,jti:randomUUID(),ctx:{teamId:'synthetic-team',plan:'Developer',mailboxes:2},...extra})).toString('base64url');return `${head}.${body}.${createHmac('sha256',identityKey.secret).update(`${head}.${body}`).digest('base64url')}`;};
  const prepareSupport = async () => {
    app.store.mutate(owner.actor,tenant.id,'Fixture agente de suporte',current => {current.agents=[{id:'support-http-hermes',name:'Hermes sintético',provider:'hermes',configured:true,mode:'copilot',version:1,description:'Ajude com acesso ao MepMail.',tools:[]}];});
    let source=app.knowledge.create(owner.actor,tenant.id,{title:'Acesso MepMail',content:'Para acessar o MepMail, abra Configurações. A equipe humana pode continuar o atendimento.'});source=app.knowledge.publish(owner.actor,tenant.id,source.id,{version:source.version});
    app.knowledge.setGrants(owner.actor,tenant.id,'support-http-hermes',{version:1,grants:[{sourceId:source.id,publicationVersion:source.published.version,publicationHash:source.published.hash}]});
    const result=await request(channelPath('support-assistant'),{method:'PATCH',body:{version:0,enabled:true,autoReply:true,agentId:'support-http-hermes',productIds:['mepmail']}});assert.equal(result.status,200,result.text);
  };
  return {app,calls,control,owner,outsider,operator,tenant,other,member,pending,request,channelPath,publicPath,publicRequest,state,conversation,open,receive,configureWidget,prepareIdentity,token,prepareSupport};
}

test('jornada HTTP de chamado automático mantém chat ativo, um email rico e status correto no operador', async t => {
  const f = await fixture(t); await f.configureWidget(); await f.prepareSupport();
  const configured = await f.request(f.channelPath('support-assistant'), {method:'PATCH', body:{version:1,enabled:true,autoReply:true,agentId:'support-http-hermes',productIds:['mepmail'],handoffMode:'continue'}});
  assert.equal(configured.status, 200, configured.text);
  f.app.runtime.providerCall = async input => {
    f.calls.provider.push(input);
    return f.calls.provider.length === 1 ? {text:'Para acessar o MepMail, abra Configurações. Um detalhe precisa de revisão da equipe.',handoff:{reason:'confirmar configuração'}} : 'Para acessar o MepMail, abra Configurações.';
  };
  const visitor = await f.open({name:'Visitante da jornada',email:'return@example.test'});
  assert.equal((await f.receive(visitor,'Como acessar o MepMail?')).status, 200);
  await f.app.centralSupport.drain(); await f.app.email.flush(); await f.app.centralSupport.drain();
  const id = f.conversation(visitor).id;
  let history = await f.publicRequest('history',{token:visitor.token});
  assert.equal(history.status, 200, history.text); assert.equal(history.data.assistant.state, 'idle');
  assert.equal(history.data.assistant.handoffReason, null);
  assert.match(history.data.messages.find(message => message.id.startsWith('handoff_')).text, /ficou registrada para a equipe de suporte/);
  assert.equal(f.calls.email.length, 1); assert.equal(f.calls.email[0].payload.reply_to, 'return@example.test');
  assert.match(f.calls.email[0].payload.text, /Visitante da jornada/);
  const operator = await f.request(`/api/tenants/${f.tenant.id}/conversations/${id}`);
  assert.equal(operator.status, 200, operator.text);
  assert.equal(operator.data.conversation.supportAssistantHandoff.pauseAutomation, false);
  assert.equal(operator.data.conversation.handoffEmail.state, 'confirmed');
  assert.equal((await f.receive(visitor,'Ainda preciso de acesso ao MepMail.')).status, 200);
  await f.app.centralSupport.drain(); await f.app.email.flush();
  history = await f.publicRequest('history',{token:visitor.token});
  assert.equal(f.calls.provider.length, 2); assert.equal(f.calls.email.length, 1);
  assert.equal(history.data.messages.filter(message => message.id.startsWith('handoff_')).length, 1);
  assert.equal((await f.receive(visitor,'Quero falar com uma pessoa')).status, 200);
  await f.app.centralSupport.drain();
  history = await f.publicRequest('history',{token:visitor.token});
  assert.equal(history.data.assistant.state, 'handoff');
  assert.equal(history.data.assistant.handoffReason, 'visitor_requested_human');
  assert.equal(f.calls.provider.length, 2);
});

function cors(response,allowed=true) {assert.equal(response.headers['access-control-allow-origin'],allowed?visitorOrigin:undefined); if(allowed)assert.match(response.headers.vary,/Origin/i);assert.notEqual(response.headers['access-control-allow-origin'],'*');}
function webchatTiming(response,expected=true) {
  if(!expected)return assert.equal(response.headers['server-timing'],undefined);
  const match=/^webchat;dur=(\d+\.\d{3})$/.exec(response.headers['server-timing']||'');
  assert.ok(match,'Server-Timing contém somente a duração numérica do webchat.');
  assert.ok(Number.isFinite(Number(match[1]))&&Number(match[1])>=0);
}
function privateResponseHeaders(response) {
  assert.equal(response.headers['cache-control'],'no-store');
  for(const header of ['access-control-allow-credentials','access-control-expose-headers','timing-allow-origin'])assert.equal(response.headers[header],undefined);
}

test('CORS config/history/erros e OPTIONS sem corpo permitem apenas a origem registrada; GET/query são rejeitados', async t => {
  const f=await fixture(t), before=f.app.store.db.prepare('SELECT count(*) n FROM webchat_sessions').get().n;
  const options=f.pending(f.publicPath('session'),{method:'OPTIONS',actor:null,requestOrigin:visitorOrigin,headers:{'Content-Length':100000,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type, Authorization'}});options.req.flushHeaders();
  const preflight=await options.promise;options.req.destroy();assert.equal(preflight.status,204);cors(preflight);assert.equal(preflight.text,'');assert.equal(f.app.webchat.challenges.size,0);assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM webchat_sessions').get().n,before);
  assert.equal(preflight.headers['access-control-max-age'],'300');assert.equal(preflight.headers['access-control-allow-methods'],'POST, OPTIONS');assert.equal(preflight.headers['access-control-allow-headers'],'Content-Type, Authorization');privateResponseHeaders(preflight);webchatTiming(preflight);
  const config=await f.publicRequest('config');assert.equal(config.status,200);cors(config);webchatTiming(config,false);
  const visitor=await f.open(), history=await f.publicRequest('history',{token:visitor.token});assert.equal(history.status,200);cors(history);webchatTiming(history);
  for(const response of [config,history]){assert.equal(response.headers['access-control-max-age'],undefined);privateResponseHeaders(response);}
  const invalidHistory=await f.publicRequest('history',{}, {raw:Buffer.from('{broken')});webchatTiming(invalidHistory);
  for(const result of [await f.publicRequest('config',{unknown:true}),invalidHistory,await f.request(f.publicPath('config')+'?token=synthetic-query-is-never-accepted',{actor:null,requestOrigin:visitorOrigin})]){assert.equal(result.status,400,result.text);cors(result);assert.equal(result.text.includes('synthetic-query'),false);assert.equal(result.headers['access-control-max-age'],undefined);privateResponseHeaders(result);}
  const get=await f.request(f.publicPath('config'),{actor:null,requestOrigin:visitorOrigin});assert.equal(get.status,405);cors(get);assert.equal(get.headers['access-control-max-age'],undefined);webchatTiming(get,false);
  // 0.61.0: the public configuration of a live channel answers a site outside its list with a readable refusal (preflight
  // 204 and POST 403 webchat_origin_denied, both with CORS for that origin), so the widget can explain it; nothing else.
  const unknown='https://unknown.example.test';
  const deniedPreflight=await f.request(f.publicPath('config'),{method:'OPTIONS',actor:null,requestOrigin:unknown,headers:{'Access-Control-Request-Method':'POST'}});
  assert.equal(deniedPreflight.status,204);assert.equal(deniedPreflight.headers['access-control-allow-origin'],unknown);assert.match(deniedPreflight.headers.vary,/Origin/i);
  assert.equal(deniedPreflight.headers['access-control-max-age'],'60');assert.equal(deniedPreflight.headers['access-control-allow-headers'],'Content-Type');privateResponseHeaders(deniedPreflight);
  const denied=await f.request(f.publicPath('config'),{method:'POST',actor:null,requestOrigin:unknown,body:{}});
  assert.equal(denied.status,403);assert.equal(denied.headers['access-control-allow-origin'],unknown);assert.equal(denied.headers['access-control-max-age'],undefined);
  assert.deepEqual(JSON.parse(denied.text),{error:'Webchat indisponível para esta origem.',code:'webchat_origin_denied'});privateResponseHeaders(denied);webchatTiming(denied,false);
  for(const method of ['POST','OPTIONS']){const other=await f.request(f.publicPath('history'),{method,actor:null,requestOrigin:unknown,body:{}});assert.equal(other.status,403);assert.equal(other.headers['access-control-allow-origin'],undefined,`history ${method}: without CORS the site cannot read the refusal`);privateResponseHeaders(other);}
  const invalidPreflight=await f.request(f.publicPath('history')+'?unexpected=true',{method:'OPTIONS',actor:null,requestOrigin:visitorOrigin});assert.equal(invalidPreflight.status,400);assert.equal(invalidPreflight.headers['access-control-max-age'],undefined);webchatTiming(invalidPreflight,false);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM webchat_sessions').get().n,before+1);
});

test('origem retirada após preflight positivo bloqueia history combinado sem consumir JWT ou ler histórico',async t=>{
  const f=await fixture(t),key=(await f.prepareIdentity()).data,status=await f.request(f.channelPath('identity/status'));
  const configured=await f.request(f.channelPath('identity/configure'),{method:'POST',body:{version:status.data.version,scope:'account-user'}});assert.equal(configured.status,200,configured.text);
  const visitor=await f.open({identityToken:f.token(key,{v:2,accountId:'cors-account-a'})});
  assert.equal((await f.receive(visitor,'Histórico privado da origem retirada')).status,200);
  const ownHistory=await f.publicRequest('history',{token:visitor.token});assert.equal(ownHistory.status,200);assert.deepEqual(ownHistory.data.messages.map(value=>value.text),['Histórico privado da origem retirada']);
  const preflight=await f.request(f.publicPath('history'),{method:'OPTIONS',actor:null,requestOrigin:visitorOrigin,headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers['access-control-max-age'],'300');webchatTiming(preflight);
  const revision=f.state().channels.find(value=>value.id==='http-site').webchat.version;
  const removed=await f.request(f.channelPath('configuration'),{method:'POST',body:{version:revision,origins:['https://replacement.example.test'],enabled:true}});assert.equal(removed.status,200,removed.text);
  const rows=()=>['webchat_sessions','webchat_identity_sessions','webchat_identity_jti'].map(table=>f.app.store.db.prepare('SELECT * FROM '+table).all()),beforeRows=rows(),beforeState=f.app.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.tenant.id).data;
  const history=f.app.webchat.history.bind(f.app.webchat);let historyCalls=0;f.app.webchat.history=input=>{historyCalls++;return history(input);};
  const jwt=f.token(key,{v:2,accountId:'cors-account-a'});
  // Simula um navegador com preflight em cache: envia POST sem outro OPTIONS.
  const denied=await f.publicRequest('history',{token:visitor.token,identityToken:jwt});
  assert.equal(denied.status,403,denied.text);cors(denied,false);privateResponseHeaders(denied);webchatTiming(denied);assert.equal(denied.headers['access-control-max-age'],undefined);
  assert.equal(historyCalls,0);assert.deepEqual(rows(),beforeRows);assert.equal(f.app.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.tenant.id).data,beforeState);
  for(const value of [jwt,visitor.token,'Histórico privado da origem retirada'])assert.equal(denied.text.includes(value),false);
  const rejectedPreflight=await f.request(f.publicPath('history'),{method:'OPTIONS',actor:null,requestOrigin:visitorOrigin});
  assert.equal(rejectedPreflight.status,403);cors(rejectedPreflight,false);assert.equal(rejectedPreflight.headers['access-control-max-age'],undefined);webchatTiming(rejectedPreflight,false);privateResponseHeaders(rejectedPreflight);
});

test('configuração MepMail é CAS/admin, exclui campos privados do público e mídia desativada bloqueia upload HTTP', async t => {
  const f=await fixture(t), sibling=JSON.stringify(f.state().channels.find(value => value.id==='sibling-site'));
  const configured=await f.configureWidget();assert.equal(configured.status,200,configured.text);assert.equal(configured.data.version,1);
  assert.equal((await f.configureWidget(widget,0)).status,409);assert.equal((await f.configureWidget({...widget,colors:{primary:'unsafe'}},1)).status,400);
  const config=await f.publicRequest('config');assert.equal(config.data.widget.displayName,'MepMail');assert.equal(config.data.widget.theme,'dark');assert.equal(config.data.widget.credit.visible,false);assert.equal(config.data.widget.handoffNotificationEmail,undefined);assert.equal(config.data.widget.assistantInstructions,undefined);assert.equal(config.data.mediaSupported,false);assert.equal(config.data.voiceSupported,false);
  const visitor=await f.open(), before=f.app.store.db.prepare('SELECT count(*) n FROM media_attachments').get().n;
  const upload=await f.publicRequest('media',undefined,{headers:{'Content-Type':'application/octet-stream',Authorization:'Bearer '+visitor.token},raw:Buffer.from('Unparsed forbidden file')});assert.equal(upload.status,403,upload.text);cors(upload);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM media_attachments').get().n,before);assert.equal(f.state().conversations.length,0);assert.equal(JSON.stringify(f.state().channels.find(value => value.id==='sibling-site')),sibling);
  for(const actor of [f.operator,f.outsider]){const result=await f.configureWidget(widget,1,{actor});assert.equal(result.status,actor===f.outsider?404:403,result.text);}
  const foreign=await f.request(f.channelPath('widget-configuration',f.other.id,'foreign-site'));assert.equal(foreign.status,404);
  const delegated=f.app.support.create(f.owner.actor,{requestId:randomUUID(),supportUserId:f.outsider.id,tenantIds:[f.tenant.id],permissions:['inbox.read','inbox.reply'],scopeRules:{[f.tenant.id]:{channelIds:['http-site'],departmentIds:['support']}},reason:'Suporte RAM sintético',ticket:'HTTP-QA',ttlMinutes:60});
  const denied=await f.configureWidget(widget,1,{actor:f.outsider,headers:{'x-elozi-workspace':'mep-demo','x-elozi-support-grant':delegated.id}});assert.equal(denied.status,403,denied.text);assert.equal(f.state().channels[0].webchat.widgetVersion,1);
});

test('mensagem com imagem no chat de suporte chega ao assistente (o recibo de mídia não derruba a automação)', async t => {
  const f=await fixture(t);await f.prepareSupport();
  const configured=await f.configureWidget({...widget,attachmentsEnabled:true});assert.equal(configured.status,200,configured.text);
  const visitor=await f.open(), png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
  const header=Buffer.from(JSON.stringify({clientMessageId:randomUUID(),text:'olha o print do erro',name:'print.png',mime:'image/png',voice:false})), size=Buffer.alloc(4);size.writeUInt32BE(header.length);
  const upload=await f.publicRequest('media',undefined,{headers:{'Content-Type':'application/octet-stream',Authorization:'Bearer '+visitor.token},raw:Buffer.concat([size,header,png])});
  assert.equal(upload.status,200,upload.text);
  const current=f.conversation(visitor), message=current.messages.find(item=>item.id===upload.data.messageId);
  assert.equal(message.attachments[0].status,'ready');assert.equal(message.attachments[0].kind,'image');
  const jobs=(f.state().supportAssistantJobs||[]).filter(job=>job.conversationId===current.id&&job.messageId===message.id);
  assert.equal(jobs.length,1,'A mensagem com anexo precisa gerar a preparação do suporte.');
});

test('configuração revalida sessão administrativa após receber o corpo sem escrever com autoridade revogada', async t => {
  const f=await fixture(t), entered=defer(), original=f.app.auth.admin.bind(f.app.auth);
  f.app.auth.admin=actor => {const result=original(actor);entered.resolve();return result;};
  const body=Buffer.from(JSON.stringify({version:0,widget})), pending=f.pending(f.channelPath('widget-configuration'),{method:'POST',headers:{'Content-Length':body.length}});pending.req.flushHeaders();
  await entered.promise;f.app.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(new Date().toISOString(),f.owner.id);pending.req.end(body);
  const denied=await pending.promise;assert.equal(denied.status,401,denied.text);assert.equal(f.app.store.db.prepare('SELECT json_extract(data,?) version FROM tenants WHERE id=?').get('$.channels[0].webchat.widgetVersion',f.tenant.id).version,null);
});

test('chave de identidade é revelada uma vez somente ao admin, CAS e tenant continuam restritos', async t => {
  const f=await fixture(t), created=await f.prepareIdentity(), key=created.data;assert.match(key.secret,/^[A-Za-z0-9_-]{43}$/);assert.equal(created.headers['cache-control'],'no-store');
  const status=await f.request(f.channelPath('identity/status'));assert.equal(status.status,200,status.text);assert.equal(status.data.secret,undefined);assert.equal(status.data.keys.length,1);assert.equal(status.data.configured,true);
  assert.equal((await f.request(f.channelPath('identity/create-key'),{method:'POST',body:{version:1}})).status,409);
  for(const actor of [f.operator,f.outsider])for(const suffix of ['identity/status','identity/create-key']){const result=await f.request(f.channelPath(suffix),{actor,method:suffix.endsWith('status')?'GET':'POST',body:suffix.endsWith('status')?undefined:{version:2}});assert.equal(result.status,actor===f.outsider?404:403,result.text);assert.equal(result.text.includes(key.secret),false);}
  const foreign=await f.request(f.channelPath('identity/status',f.other.id,'foreign-site'));assert.equal(foreign.status,404);
  const grant=f.app.support.create(f.owner.actor,{requestId:randomUUID(),supportUserId:f.outsider.id,tenantIds:[f.tenant.id],permissions:['inbox.read','inbox.reply'],scopeRules:{[f.tenant.id]:{channelIds:['http-site'],departmentIds:['support']}},reason:'Suporte RAM sem gestão de identidade',ticket:'IDENTITY-HTTP-QA',ttlMinutes:60});
  const delegated=await f.request(f.channelPath('identity/status'),{actor:f.outsider,headers:{'x-elozi-workspace':'mep-demo','x-elozi-support-grant':grant.id}});assert.equal(delegated.status,403,delegated.text);assert.equal(delegated.text.includes(key.secret),false);
  for(const result of [status,await f.publicRequest('config'),await f.request('/api/bootstrap',{actor:f.operator}),await f.request('/api/tenants/'+f.tenant.id,{actor:f.operator})])assert.equal(JSON.stringify(result.data).includes(key.secret),false);
  const payload=f.app.store.db.prepare('SELECT payload FROM channel_secrets WHERE channel_id=?').get('http-site').payload;assert.equal(Buffer.from(payload).includes(Buffer.from(key.secret)),false);
});

test('sessão JWT retorna código de vencimento por CORS, renova mesma conta e logout bloqueia só seu vínculo', async t => {
  const f=await fixture(t), key=(await f.prepareIdentity()).data;await f.configureWidget();
  const jwt=f.token(key,{exp:Math.floor(f.control.now/1000)+5}), visitor=await f.open({identityToken:jwt});assert.equal(visitor.contact.verified,true);assert.equal(visitor.contact.externalId,'mepmail:synthetic-account-1');
  const received=await f.receive(visitor,'Histórico verificado');assert.equal(received.status,200);
  webchatTiming(received);privateResponseHeaders(received);assert.equal(received.headers['access-control-max-age'],undefined);
  const rejected=await f.publicRequest('contact',{token:visitor.token,email:'changed@example.test'});assert.equal(rejected.status,409);
  f.control.now+=65001;const expired=await f.publicRequest('history',{token:visitor.token});assert.equal(expired.status,401,expired.text);assert.equal(expired.data.code,'identity_expired');cors(expired);assert.equal(expired.text.includes(jwt),false);
  const switchDenied=await f.publicRequest('identity',{token:visitor.token,identityToken:f.token(key,{sub:'another-account'})});assert.equal(switchDenied.status,409);assert.equal(switchDenied.data.code,'identity_account_changed');cors(switchDenied);
  webchatTiming(switchDenied);assert.equal(switchDenied.headers['access-control-max-age'],undefined);
  const renewed=await f.publicRequest('identity',{token:visitor.token,identityToken:f.token(key,{email:'new@example.test'})});assert.equal(renewed.status,200,renewed.text);assert.equal(renewed.data.contact.externalId,visitor.contact.externalId);assert.equal(renewed.data.contact.email,'new@example.test');
  webchatTiming(renewed);privateResponseHeaders(renewed);assert.equal(renewed.headers['access-control-max-age'],undefined);
  const history=await f.publicRequest('history',{token:visitor.token});assert.deepEqual(history.data.messages.map(value => value.text),['Histórico verificado']);
  const second=await f.open({identityToken:f.token(key)});const loggedOut=await f.publicRequest('logout',{token:visitor.token});assert.equal(loggedOut.status,200);assert.equal(loggedOut.data.loggedOut,true);
  assert.equal((await f.publicRequest('history',{token:visitor.token})).status,403);assert.equal((await f.publicRequest('history',{token:second.token})).status,200);
});

test('HTTP history combina renovação v2 expirada com paginação sem POSTidentity nem sessão nova', async t => {
  const f = await fixture(t), key = (await f.prepareIdentity()).data;
  const status = await f.request(f.channelPath('identity/status'));
  const configured = await f.request(f.channelPath('identity/configure'), { method: 'POST', body: { version: status.data.version, scope: 'account-user' } });
  assert.equal(configured.status, 200, configured.text);
  const visitor = await f.open({ identityToken: f.token(key, { v: 2, accountId: 'http-account-a', exp: Math.floor(f.control.now/1000)+5 }) });
  assert.equal(visitor.identityHistorySupported, true);
  assert.equal((await f.receive(visitor, 'Histórico HTTP próprio')).status, 200);
  const counts = () => ['webchat_sessions','webchat_identity_sessions','webchat_identity_jti'].map(table => f.app.store.db.prepare('SELECT count(*) n FROM '+table).get().n);
  const originalCounts = counts(); f.control.now += 65001;
  const expired = await f.publicRequest('history', { token: visitor.token });
  assert.equal(expired.status, 401); assert.equal(expired.data.code, 'identity_expired');
  const jwt = f.token(key, { v: 2, accountId: 'http-account-a' });
  const invalidPage = await f.publicRequest('history', { token: visitor.token, identityToken: jwt, after: randomUUID() });
  assert.equal(invalidPage.status, 400, invalidPage.text); cors(invalidPage); assert.deepEqual(counts(), originalCounts);
  const result = await f.publicRequest('history', { token: visitor.token, identityToken: jwt, limit: 1 });
  assert.equal(result.status, 200, result.text); cors(result);
  assert.equal(result.data.identityHistorySupported, true); assert.equal(result.data.contact.accountId, 'http-account-a');
  assert.deepEqual(result.data.messages.map(message => message.text), ['Histórico HTTP próprio']);
  assert.deepEqual(counts(), [originalCounts[0], originalCounts[1], originalCounts[2]+1]);
  const replay = await f.publicRequest('history', { token: visitor.token, identityToken: jwt });
  assert.equal(replay.status, 409); assert.equal(replay.data.code, 'identity_replay'); cors(replay);
  assert.equal(result.text.includes(jwt), false); assert.equal(replay.text.includes(jwt), false);
  assert.equal((await f.publicRequest('history', { token: visitor.token })).status, 200);
  assert.equal((await f.publicRequest('logout', { token: visitor.token })).status, 200);
  const loggedOut = await f.publicRequest('history', { token: visitor.token, identityToken: f.token(key, { v: 2, accountId: 'http-account-a' }) });
  assert.equal(loggedOut.status, 403); cors(loggedOut);
});

test('visitante atualiza contato próprio e avalia só atendimento encerrado pelo fluxo HTTP', async t => {
  const f=await fixture(t);await f.configureWidget();const visitor=await f.open();assert.equal((await f.receive(visitor)).status,200);
  assert.equal((await f.publicRequest('contact',{token:visitor.token,email:'bad-address'})).status,400);
  const updated=await f.publicRequest('contact',{token:visitor.token,email:'Return@Example.test'});assert.equal(updated.status,200,updated.text);assert.equal(updated.data.contact.email,'return@example.test');assert.equal(updated.data.contact.verified,false);
  assert.equal(f.state().contacts[0].email,'return@example.test');assert.equal((await f.publicRequest('feedback',{token:visitor.token,rating:'useful'})).status,409);
  const conversation=f.conversation(visitor), closed=await f.request(`/api/tenants/${f.tenant.id}/conversations/${conversation.id}/details`,{method:'POST',body:{version:conversation.version,status:'closed'}});assert.equal(closed.status,200,closed.text);
  const feedback=await f.publicRequest('feedback',{token:visitor.token,rating:'useful'});assert.equal(feedback.status,200,feedback.text);assert.deepEqual(feedback.data.feedback,{rating:'useful'});assert.equal((await f.publicRequest('feedback',{token:visitor.token,rating:'arbitrary'})).status,400);
});

test('encaminhamento humano HTTP enfileira contexto rico autorizado e cifrado uma única vez sem inventar identidade', async t => {
  const f=await fixture(t);await f.configureWidget();await f.prepareSupport();f.app.store.mutate(f.owner.actor,f.tenant.id,'Nome da empresa genérico',tenant=>{tenant.name='Empresa Alfa HTTP';});const visitor=await f.open({name:'Pessoa Alfa HTTP',email:'return@example.test'}),messageId=randomUUID(),published=[];
  const publish=f.app.webchat.publishHandoff.bind(f.app.webchat);f.app.webchat.publishHandoff=input=>{published.push({ticketState:input.ticketState,rows:f.app.store.db.prepare("SELECT count(*) n FROM email_outbox WHERE kind='support_handoff'").get().n});return publish(input);};
  assert.equal((await f.receive(visitor,'O IP de envio é dedicado ou compartilhado?')).status,200);
  const first=await f.receive(visitor,'Quero falar com uma pessoa',messageId);assert.equal(first.status,200,first.text);await f.app.centralSupport.drain();await f.app.email.flush();
  const replay=await f.receive(visitor,'Quero falar com uma pessoa',messageId);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);await f.app.centralSupport.drain();await f.app.email.flush();
  assert.equal(f.calls.provider.length,0);assert.equal(f.calls.email.length,1);
  const delivery=f.calls.email[0],conversation=f.conversation(visitor),row=f.app.store.db.prepare("SELECT * FROM email_outbox WHERE kind='support_handoff'").get();assert.equal(row.state,'confirmed');assert.equal(row.attempts,1);assert.equal(row.message_id,'synthetic-email-1');
  assert.equal(delivery.url,'https://api-mepmail.je4ndev.com/emails');assert.equal(delivery.method,'POST');assert.equal(delivery.headers['Idempotency-Key'],row.id);assert.deepEqual(delivery.payload.to,['support@example.test']);assert.equal(delivery.payload.from,'Elozi <support@example.test>');
  assert.match(delivery.payload.text,/#inbox/);assert.match(delivery.payload.text,new RegExp(conversation.id));assert.match(delivery.payload.text,/Pessoa Alfa HTTP/);assert.match(delivery.payload.text,/IP de envio é dedicado ou compartilhado/);assert.match(delivery.payload.text,/Quero falar com uma pessoa/);
  assert.match(delivery.payload.text,/O visitante solicitou atendimento humano/);assert.match(delivery.payload.text,/Informado \(não verificado\)/);assert.match(delivery.payload.text,/Solicitado em \(UTC\):/);assert.match(delivery.payload.text,/Origem autorizada:/);assert.equal(delivery.payload.reply_to,'return@example.test');
  assert.equal(delivery.payload.subject.includes('MepMail'),false);assert.match(delivery.payload.subject,/Empresa Alfa HTTP.*http-site/);
  for(const privateValue of ['support@example.test','Pessoa Alfa HTTP','return@example.test','Quero falar com uma pessoa',visitor.token])assert.equal(Buffer.from(row.payload).includes(Buffer.from(privateValue)),false);
  assert.equal(JSON.stringify(delivery.payload).includes(visitor.token),false);assert.deepEqual(published,[{ticketState:'queued',rows:1}]);
  assert.equal(f.conversation(visitor).handoffEmail.state,'confirmed','o callback atualiza metadata depois do flush sem confundir fila com entrega');
  const history=await f.publicRequest('history',{token:visitor.token});assert.equal(history.data.assistant.state,'handoff');assert.equal(history.data.assistant.requestEmail,false);assert.equal(history.text.includes('support@example.test'),false);assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM email_outbox WHERE kind='support_handoff'").get().n,1);
});

test('mudança de ACL durante await da chave impede notificação e não provoca novo envio automático', async t => {
  const f=await fixture(t);await f.configureWidget();await f.prepareSupport();const visitor=await f.open(), original=f.app.email.enqueueSupportHandoff.bind(f.app.email);let checks=0;
  f.app.email.enqueueSupportHandoff=input => original({...input,authorize:() => {checks++;const allowed=input.authorize();if(checks===1)queueMicrotask(() => f.app.store.mutate(f.owner.actor,f.tenant.id,'Revogação sintética durante await',tenant => {tenant.channels.find(value => value.id==='http-site').supportAssistant.enabled=false;}));return allowed;}});
  assert.equal((await f.receive(visitor,'Quero falar com uma pessoa')).status,200);await f.app.centralSupport.drain();await f.app.email.flush();await f.app.centralSupport.drain();
  assert.ok(checks>=2,'a autorização é consultada de novo após o await da chave');assert.equal(f.state().channels[0].supportAssistant.enabled,false);assert.equal(f.calls.email.length,0);assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM email_outbox WHERE kind='support_handoff'").get().n,0);
});

test('email HTTP usa identidade JWT atualmente verificada e omite token, claims, CRM e metadata operacional',async t=>{
  const f=await fixture(t);await f.configureWidget();const identity=await f.prepareIdentity();await f.prepareSupport();const identityToken=f.token(identity.data,{ctx:{teamId:'PRIVATE-TEAM-METADATA',plan:'PRIVATE-BILLING-METADATA',mailboxes:2}}),visitor=await f.open({identityToken,name:'Nome não autorizado',email:'spoof@example.test'});
  const received=await f.receive(visitor,'Can I talk to a human?');assert.equal(received.status,200,received.text);
  f.app.store.mutate(f.owner.actor,f.tenant.id,'Canários privados sintéticos',tenant=>{
    const c=tenant.conversations.find(value=>value.id===f.conversation(visitor).id);c.webchatVisitor.pageUrl='https://unsafe.example.test/?token=PRIVATE-PAGE-TOKEN';
    c.messages.push({id:randomUUID(),kind:'system',text:'PRIVATE-INTERNAL-NOTE'});tenant.secret='PRIVATE-TENANT-CREDENTIAL';tenant.contacts.find(contact=>contact.id===c.contactId).notes='PRIVATE-CRM-NOTE';
  });
  await f.app.centralSupport.drain();await f.app.email.flush();assert.equal(f.calls.email.length,1);
  const payload=f.calls.email[0].payload;assert.equal(payload.reply_to,'verified@example.test');assert.match(payload.text,/Pessoa do MepMail/);assert.match(payload.text,/Identidade verificada/);assert.match(payload.text,/Can I talk to a human/);
  for(const value of [identityToken,visitor.token,identity.data.secret,'PRIVATE-TEAM-METADATA','PRIVATE-BILLING-METADATA','PRIVATE-INTERNAL-NOTE','PRIVATE-TENANT-CREDENTIAL','PRIVATE-CRM-NOTE','PRIVATE-PAGE-TOKEN','unsafe.example.test','spoof@example.test','Nome não autorizado'])assert.equal(JSON.stringify(payload).includes(value),false,value);
  const row=f.app.store.db.prepare("SELECT payload FROM email_outbox WHERE kind='support_handoff'").get();assert.equal(Buffer.from(row.payload).includes(Buffer.from('verified@example.test')),false);
});

test('email HTTP limita transcript ao atendimento/canal/tenant atuais, escapa HTML e redige credenciais públicas',async t=>{
  const f=await fixture(t);await f.configureWidget({...widget,handoffNotificationEmail:'operators-alpha@example.test'});await f.prepareSupport();const visitor=await f.open({name:'Ana Alfa'});
  assert.equal((await f.receive(visitor,'Quero falar com uma pessoa')).status,200);
  const id=f.conversation(visitor).id;
  f.app.store.mutate(f.outsider.actor,f.other.id,'Canários de outro tenant',tenant=>{tenant.conversations=[{id:'foreign-private',channelId:'foreign-site',contact:'OTHER-TENANT-NAME',messages:[{kind:'customer',text:'OTHER-TENANT-TRANSCRIPT'}]}];tenant.contacts=[{id:'foreign-contact',email:'other-private@example.test',name:'OTHER-TENANT-CONTACT'}];});
  f.app.store.mutate(f.owner.actor,f.tenant.id,'Histórico e metadata sintéticos',tenant=>{
    tenant.conversations.push({id:'sibling-private',channelId:'sibling-site',contact:'OTHER-CHANNEL-NAME',messages:[{kind:'customer',text:'OTHER-CHANNEL-TRANSCRIPT'}]});
    const c=tenant.conversations.find(value=>value.id===id),original=c.messages[0];
    c.messages=Array.from({length:40},(_,index)=>({id:randomUUID(),kind:'agent',text:`recent-${index} ${'<>& '.repeat(3000)}`,createdAt:'2026-10-12T16:00:00Z'}));
    c.messages.push({id:randomUUID(),kind:'agent',text:'<img src=x onerror="bad"> token=private-token-value senha=private-password-value Bearer '+visitor.token+' https://site.example.test/?secret=private-query-value',createdAt:'2026-10-12T16:00:00Z'},original,{id:randomUUID(),kind:'system',text:'PRIVATE-SYSTEM-TRANSCRIPT'});
    c.webchatVisitor.ctx={plan:'PRIVATE-UNVERIFIED-CLAIMS'};c.webchatVisitor.pageUrl='https://untrusted.example.test/private';tenant.contacts.find(contact=>contact.id===c.contactId).notes='PRIVATE-CRM-TRANSCRIPT';
  });
  await f.app.centralSupport.drain();await f.app.email.flush();assert.equal(f.calls.email.length,1);
  const payload=f.calls.email[0].payload;assert.deepEqual(payload.to,['operators-alpha@example.test']);assert.equal('reply_to' in payload,false);assert.match(payload.text,/Não disponível/);assert.match(payload.text,/Ana Alfa/);assert.match(payload.text,/Quero falar com uma pessoa/);assert.match(payload.text,/Trecho limitado/);
  assert.equal(payload.html.includes('<img'),false);assert.match(payload.html,/&lt;img/);assert.ok(Buffer.byteLength(payload.html)<45000);assert.ok(Buffer.byteLength(payload.text)<12000);
  for(const value of [visitor.token,'OTHER-TENANT','OTHER-CHANNEL','other-private@example.test','PRIVATE-SYSTEM','PRIVATE-UNVERIFIED','PRIVATE-CRM','private-token-value','private-password-value','private-query-value','untrusted.example.test','recent-0 '])assert.equal(JSON.stringify(payload).includes(value),false,value);
  assert.equal(f.calls.provider.length,0);
});

test('falha de contexto da notificação publica somente ticketState unconfirmed sem alegar enqueue/envio',async t=>{
  const f=await fixture(t);await f.configureWidget();await f.prepareSupport();const visitor=await f.open(),original=f.app.email.enqueueSupportHandoff.bind(f.app.email),publish=f.app.webchat.publishHandoff.bind(f.app.webchat),states=[];
  f.app.email.enqueueSupportHandoff=input=>original({...input,getContext:()=>{throw Error('Contexto indisponível sintético.');}});
  f.app.webchat.publishHandoff=input=>{states.push(input.ticketState);return publish(input);};
  assert.equal((await f.receive(visitor,'Quero falar com uma pessoa')).status,200);await f.app.centralSupport.drain();await f.app.email.flush();
  assert.deepEqual(states,['unconfirmed']);assert.equal(f.calls.email.length,0);assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM email_outbox WHERE kind='support_handoff'").get().n,0);assert.equal(f.conversation(visitor).handoffEmail,undefined);
  assert.equal(f.state().supportAssistantJobs.at(-1).handoffNotification.state,'confirmed','a publicação webchat segue confirmada, separada da falha do aviso por email');
});

test('destinatário de canal alterado durante await não usa recipient anterior nem grava snapshot',async t=>{
  const f=await fixture(t);await f.configureWidget();await f.prepareSupport();const visitor=await f.open(),original=f.app.email.enqueueSupportHandoff.bind(f.app.email);let changed=false;
  f.app.email.enqueueSupportHandoff=input=>original({...input,authorize:()=>{const allowed=input.authorize();if(!changed){changed=true;queueMicrotask(()=>f.app.store.mutate(f.owner.actor,f.tenant.id,'Destino alterado durante await',tenant=>{tenant.channels.find(channel=>channel.id==='http-site').webchat.widget.handoffNotificationEmail='changed@example.test';}));}return allowed;}});
  assert.equal((await f.receive(visitor,'Quero falar com uma pessoa')).status,200);await f.app.centralSupport.drain();await f.app.email.flush();
  assert.equal(changed,true);assert.equal(f.calls.email.length,0);assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM email_outbox WHERE kind='support_handoff'").get().n,0);
});

test('API autenticada projeta todos estados atuais da outbox sem decrypt nem confiar no pending antigo e sem cruzar tenant',async t=>{
  const f=await fixture(t);await f.configureWidget();await f.prepareSupport();const visitor=await f.open();assert.equal((await f.receive(visitor,'Quero falar com uma pessoa')).status,200);await f.app.centralSupport.drain();await f.app.email.flush();
  const id=f.conversation(visitor).id,receipt=f.conversation(visitor).handoffEmail.id;
  f.app.store.mutate(f.owner.actor,f.tenant.id,'Snapshot pendente antigo sintético',tenant=>{tenant.conversations.find(c=>c.id===id).handoffEmail.state='pending';});
  // An invalid cipher proves this read path is metadata-only; transport is never invoked again.
  f.app.store.db.prepare('UPDATE email_outbox SET payload=? WHERE id=?').run(Buffer.from('INTENTIONALLY-INVALID-CIPHER'),receipt);
  for(const state of ['pending','in_flight','confirmed','failed','unknown']){
    f.app.store.db.prepare('UPDATE email_outbox SET state=? WHERE id=?').run(state,receipt);
    for(const path of [`/api/tenants/${f.tenant.id}`,`/api/tenants/${f.tenant.id}?summary=1`,`/api/tenants/${f.tenant.id}/conversations/${id}`]){
      const result=await f.request(path);assert.equal(result.status,200,result.text);const c=result.data.conversation||result.data.conversations.find(c=>c.id===id);
      assert.deepEqual(c.handoffEmail,{id:receipt,state});assert.equal(result.text.includes('INTENTIONALLY-INVALID-CIPHER'),false);assert.equal(result.text.includes('message_id'),false);
    }
  }
  assert.equal(f.conversation(visitor).handoffEmail.state,'pending','projeção de leitura não reescreve dados compartilhados');assert.equal(f.calls.email.length,1);
  const now=new Date().toISOString(),foreign=randomUUID();f.app.store.db.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?,?,?,?)').run(foreign,`support:${f.other.id}`,'support_handoff','foreign-synthetic-hash',Buffer.from('foreign-invalid-cipher'),'confirmed',1,'foreign-private-provider-id',now,now);
  f.app.store.mutate(f.owner.actor,f.tenant.id,'Referência de outro tenant sintética',tenant=>{tenant.conversations.find(c=>c.id===id).handoffEmail={id:foreign,state:'confirmed'};});
  const projected=await f.request(`/api/tenants/${f.tenant.id}/conversations/${id}`);assert.equal(projected.status,200,projected.text);assert.deepEqual(projected.data.conversation.handoffEmail,{id:foreign,state:'unknown'});assert.equal(projected.text.includes('foreign-private-provider-id'),false);
  const denied=await f.request(`/api/tenants/${f.tenant.id}/conversations/${id}`,{actor:f.outsider});assert.equal(denied.status,404);assert.equal(denied.text.includes(receipt),false);
});
