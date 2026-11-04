import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelVisitorTestUI } from '../public/channel-visitor-test-ui.js';
import { createWebchatWidget } from '../public/widget.js';
import { setLocale } from '../public/i18n.js';
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';

const tenantId='tenant-a',channelId='site-1',workspaceId='workspace-a',siteOrigin='https://panel.example.test',apiOrigin=siteOrigin;
const future=()=>new Date(Date.now()+120_000).toISOString();
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function events(target){const handlers=new Map();target.addEventListener=(type,fn)=>{const list=handlers.get(type)||[];list.push(fn);handlers.set(type,list);};target.removeEventListener=(type,fn)=>handlers.set(type,(handlers.get(type)||[]).filter(item=>item!==fn));target.dispatchEvent=event=>{for(const fn of [...handlers.get(event.type)||[]])fn(event);};return {count:()=>[...handlers.values()].reduce((sum,list)=>sum+list.length,0)};}
function fixture({configuration={},apiHandler,networkHandler,mockWidget=false,origin=siteOrigin,canonical=apiOrigin,stateChange,canUse=()=>true,factoryHandler}={}){
  setLocale('pt-BR',{persist:false,notify:false});
  const doc=createDocument('<main id="main"></main><script nonce="synthetic-nonce"></script>'),main=doc.getElementById('main');
  const create=doc.createElement;
  doc.createElement=tag=>{const node=create(tag);for(const key of ['type','name'])Object.defineProperty(node,key,{get(){return this.getAttribute(key)||'';},set(value){this.setAttribute(key,value);},configurable:true});node.replaceChildren=(...nodes)=>{node._clear();node.append(...nodes);};node.attachShadow=()=>{const shadow=doc.createElement('shadow');shadow.parentNode=node;node.shadowRoot=shadow;return shadow;};return node;};
  const timers=new Map();let nextTimer=0,nextMessage=0;
  const win={location:{origin,hash:`#channels/${channelId}/visitor?w=${workspaceId}`},AbortController,Blob,File,URL,
    crypto:{randomUUID:()=>`visitor-message-${String(++nextMessage).padStart(8,'0')}`},
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  const windowEvents=events(win),documentEvents=events(doc);doc.defaultView=win;doc.visibilityState='visible';doc.documentElement.lang='pt-BR';doc.baseURI=origin+'/';
  const state={view:'channels',workspaceId,tenant:{id:tenantId,resellerId:workspaceId,name:'Empresa sintética',channels:[{id:channelId,kind:'webchat',name:'Site sintético',state:'connected'}]},boot:{publicOrigin:apiOrigin,canonicalPublicOrigin:canonical,csrfToken:'synthetic-admin-csrf',session:{userId:'admin-a',role:'reseller',resellerId:workspaceId,permissions:['channels.manage']},workspaces:[{id:workspaceId}],tenants:[{id:tenantId}]}};
  stateChange?.(state);
  let route={section:'channels',params:{channelId,tab:'visitor'},workspaceId},changes=0;
  const protectedCalls=[],publicCalls=[],factories=[],widgets=[];
  const dto=()=>({tenantId,channelId,kind:'webchat',state:'connected',version:4,enabled:true,origins:[origin],install:{snippet:'SYNTHETIC-PRIVATE-INSTALL'},secret:'SYNTHETIC-PRIVATE-IGNORED',...configuration});
  const api=async(path,options)=>{protectedCalls.push({path,options});return apiHandler?apiHandler(path,options,dto()):dto();};
  const network=async(url,options)=>{const kind=new URL(url).pathname.split('/').at(-1),body=typeof options.body==='string'?JSON.parse(options.body):options.body,entry={url,options,kind,body};publicCalls.push(entry);if(networkHandler)return networkHandler(entry);
    const common={widget:{displayName:'Atendimento de teste',theme:'light',emailPrompt:true,attachmentsEnabled:false,voiceEnabled:false,feedbackEnabled:false},mediaSupported:false};
    const result=kind==='config'?common:kind==='challenge'?{...common,challenge:'C'.repeat(43)}:kind==='session'?{...common,token:'V'.repeat(43),expiresAt:future()}:kind==='messages'?{messageId:'visitor-receipt-00001',replayed:false}:kind==='history'?{messages:[],cursor:null}:{};
    return {ok:true,status:200,json:async()=>result};};
  const factory=options=>{factories.push(options);let widget;if(mockWidget){const host=doc.createElement('div');host.dataset.eloziWidget=JSON.stringify([options.apiOrigin,options.tenantId,options.channelId]);host.attachShadow();doc.body.append(host);widget={host,opens:0,destroys:0,open(){this.opens++;},destroy(){this.destroys++;host.remove();}};}else widget=createWebchatWidget(options);widgets.push(widget);return factoryHandler?factoryHandler(widget):widget;};
  const ui=createChannelVisitorTestUI({state,api,channels:()=>state.tenant?.channels||[],getRoute:()=>route,onChange:()=>changes++,canUse,document:doc,window:win,widgetFactory:factory,fetchImpl:network});
  const render=()=>{main.innerHTML=ui.view(route);return main.innerHTML;};
  const mount=async()=>{render();return ui.mount(main,route);};
  const open=async()=>{await ui.act('channels:visitor-open',channelId);await tick();return widgets.at(-1);};
  const submit=async node=>{assert.ok(node,'Expected a real widget form');const event=new FakeEvent('submit');for(const fn of node._listeners.get('submit')||[])await fn.call(node,event);await tick();};
  return {state,doc,main,win,ui,render,mount,open,submit,timers,protectedCalls,publicCalls,factories,widgets,windowEvents,documentEvents,get changes(){return changes;},get route(){return route;},set route(value){route=value;},dto};
}

test('mount reads only protected configuration and renders the exact scoped back link without starting the visitor',async()=>{
  const f=fixture();assert.equal(await f.mount(),true);const html=f.render();
  assert.equal(f.protectedCalls.length,1);assert.equal(f.protectedCalls[0].options.method,'GET');assert.equal(f.protectedCalls[0].path,`/api/tenants/${tenantId}/channels/${channelId}/configuration`);
  assert.equal(f.protectedCalls[0].options.headers['X-Elozi-Workspace'],workspaceId);assert.equal(f.publicCalls.length,0);assert.equal(f.factories.length,0);
  assert.match(html,/<h1>Chat visitante de teste<\/h1>/);assert.match(html,/#channels\/site-1\/test\?w=workspace-a/);assert.match(html,/Ela não comprova que o código está instalado/);
  assert.doesNotMatch(html,/<iframe|srcdoc|SYNTHETIC-PRIVATE|synthetic-admin-csrf/);assert.equal(f.main.querySelector('[data-action="channels:visitor-open"]').disabled,false);f.ui.reset();
});

test('explicit open uses the real body-owned shadow widget and starts/sends only after visitor form actions',async()=>{
  const f=fixture();await f.mount();const widget=await f.open();assert.ok(widget.host.shadowRoot);assert.equal(widget.host.parentNode,f.doc.body);assert.equal(f.main.contains(widget.host),false);
  assert.deepEqual(f.publicCalls.map(item=>item.kind),['config']);assert.equal(f.doc.activeElement.id,'widget-name');
  assert.deepEqual(Object.keys(f.factories[0]).sort(),['apiOrigin','channelId','document','fetchImpl','locale','nonce','tenantId','window'].sort());assert.equal(f.factories[0].nonce,'synthetic-nonce');
  const shadow=widget.host.shadowRoot;shadow.querySelector('#widget-name').value='Visitante sintético';shadow.querySelector('#widget-email').value='';await f.submit(shadow.querySelector('#widget-intro'));
  assert.equal(shadow.querySelector('#widget-intro').hidden,true);assert.equal(shadow.querySelector('#widget-composer').hidden,false);assert.equal(f.publicCalls.filter(item=>item.kind==='session').length,1);assert.equal(f.publicCalls.some(item=>item.kind==='messages'),false);
  const session=f.publicCalls.find(item=>item.kind==='session');assert.equal(session.body.name,'Visitante sintético');assert.equal(Object.hasOwn(session.body,'email'),false);assert.equal(Object.hasOwn(session.body,'identityToken'),false);
  shadow.querySelector('#widget-text').value='Mensagem sintética autorizada';await f.submit(shadow.querySelector('#widget-composer'));
  const message=f.publicCalls.find(item=>item.kind==='messages');assert.equal(message.body.text,'Mensagem sintética autorizada');assert.equal(message.body.token,'V'.repeat(43));assert.equal(shadow.querySelector('#widget-text').value,'');
  for(const call of f.publicCalls){assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.referrerPolicy,'no-referrer');assert.equal(call.options.headers.has('X-CSRF-Token'),false);assert.equal(call.options.headers.has('X-Elozi-Workspace'),false);assert.equal(call.options.headers.has('cookie'),false);assert.doesNotMatch(JSON.stringify(call.body),/synthetic-admin-csrf|admin-a|identityToken/);}
  f.ui.reset();assert.equal(widget.host.isConnected,false);assert.equal(f.timers.size,0);
});

test('refresh rendering preserves the guest RAM session and duplicate open does not mount or start again',async()=>{
  const f=fixture();await f.mount();const widget=await f.open(),shadow=widget.host.shadowRoot;shadow.querySelector('#widget-name').value='Teste em RAM';await f.submit(shadow.querySelector('#widget-intro'));shadow.querySelector('#widget-text').value='Rascunho sintético';
  f.render();assert.equal(await f.ui.mount(f.main,f.route),true);await f.open();assert.equal(f.factories.length,1);assert.equal(f.protectedCalls.length,1);assert.equal(f.publicCalls.filter(item=>item.kind==='config').length,1);assert.equal(f.publicCalls.filter(item=>item.kind==='session').length,1);assert.equal(widget.host.isConnected,true);assert.equal(shadow.querySelector('#widget-text').value,'Rascunho sintético');assert.equal(f.doc.querySelectorAll('[data-elozi-widget]').length,1);f.ui.reset();
});

test('close and explicit configuration refresh destroy the own guest and stop pending fetch, listeners and poll timers',async()=>{
  const pending=deferred(),f=fixture({networkHandler:()=>pending.promise});await f.mount();const widget=await f.open();assert.equal(f.publicCalls.length,1);const signal=f.publicCalls[0].options.signal;
  await f.ui.act('channels:visitor-close',channelId);assert.equal(signal.aborted,true);assert.equal(widget.host.isConnected,false);assert.equal(f.timers.size,0);assert.equal(f.windowEvents.count(),0);assert.equal(f.documentEvents.count(),0);
  pending.resolve({ok:true,status:200,json:async()=>({})});await tick();assert.equal(f.doc.querySelectorAll('[data-elozi-widget]').length,0);
  await f.ui.act('channels:visitor-refresh',channelId);assert.equal(f.protectedCalls.length,2);assert.ok(f.protectedCalls.every(call=>call.options.method==='GET'));assert.equal(f.publicCalls.length,1);f.ui.reset();
});

test('origin authorization is exact and only offers a scoped configuration link without writes',async()=>{
  for(const origins of [['https://other.example.test'],['https://panel.example.test.evil.test'],['https://www.panel.example.test']]){
    const f=fixture({configuration:{origins}});assert.equal(await f.mount(),false);await f.open();const html=f.render();assert.equal(f.factories.length,0);assert.equal(f.publicCalls.length,0);assert.match(html,/não está nas origens autorizadas/);assert.match(html,/#channels\/site-1\/connect\?w=workspace-a/);assert.equal(f.main.querySelector('[data-action="channels:visitor-open"]').disabled,true);assert.equal(f.protectedCalls.length,1);assert.equal(f.protectedCalls[0].options.method,'GET');f.ui.reset();
  }
});

test('disabled or disconnected channel cannot open a visitor despite an authorized origin',async()=>{
  for(const configuration of [{enabled:false},{state:'disconnected'},{state:'configured'},{state:'planned'},{state:'error'}]){
    const f=fixture({configuration});assert.equal(await f.mount(),false);await f.open();assert.match(f.render(),/canal está desativado/);assert.equal(f.factories.length,0);assert.equal(f.publicCalls.length,0);f.ui.reset();
  }
});

test('untrusted protected DTO identities and malformed origins never reach the public widget',async()=>{
  for(const configuration of [{tenantId:'tenant-foreign'},{channelId:'site-other'},{kind:'telegram_bot'},{version:-1},{version:'4'},{enabled:'true'},{origins:['https://panel.example.test/']},{origins:['https://panel.example.test/path']},{origins:['https://user:secret@panel.example.test']},{origins:['http://remote.example.test']},{origins:Array(9).fill(siteOrigin)}]){
    const f=fixture({configuration});assert.equal(await f.mount(),false);await f.open();assert.match(f.render(),/Não foi possível consultar o canal/);assert.equal(f.factories.length,0);assert.equal(f.publicCalls.length,0);f.ui.reset();
  }
});

test('canonical boot origin is authoritative and rejects unsafe schemes, path, credentials and invalid fallback',async()=>{
  for(const canonical of [null,'','https://api.example.test/','https://api.example.test/path','https://user:secret@api.example.test','http://remote.example.test','javascript:alert(1)']){
    const f=fixture({canonical});assert.equal(await f.mount(),false);await f.open();assert.match(f.render(),/endereço seguro para o widget/);assert.equal(f.protectedCalls.length,0);assert.equal(f.publicCalls.length,0);f.ui.reset();
  }
  const f=fixture({canonical:'http://127.0.0.1:3333',origin:'http://127.0.0.1:3333'});assert.equal(await f.mount(),true);await f.open();assert.equal(new URL(f.publicCalls[0].url).origin,'http://127.0.0.1:3333');f.ui.reset();
});

test('a different canonical public domain explains the CSP limit without querying or mounting',async()=>{
  const f=fixture({canonical:'https://public.example.test'});assert.equal(await f.mount(),false);await f.open();assert.match(f.render(),/Abra este teste no endereço público da Elozi/);assert.equal(f.protectedCalls.length,0);assert.equal(f.publicCalls.length,0);assert.equal(f.factories.length,0);f.ui.reset();
});

test('operator, service, support and mismatched tenant/workspace/channel get no protected reads or public requests',async()=>{
  for(const change of [state=>state.boot.session.role='operator',state=>state.boot.session.kind='service',state=>state.supportGrantId='support-1',state=>state.boot.session.supportGrantId='support-1',state=>state.tenant.resellerId='workspace-other',state=>state.tenant.channels[0].kind='telegram_bot',state=>state.boot.session=null,state=>state.view='inbox']){
    const f=fixture({stateChange:change});assert.equal(await f.mount(),false);await f.open();assert.equal(f.protectedCalls.length,0);assert.equal(f.publicCalls.length,0);assert.equal(f.factories.length,0);f.ui.reset();
  }
  const f=fixture();f.route={...f.route,workspaceId:'workspace-other'};await f.mount();await f.open();assert.equal(f.protectedCalls.length,0);assert.equal(f.factories.length,0);f.ui.reset();
});

test('a stale protected read is aborted and cannot publish readiness or mount a widget after context changes',async()=>{
  for(const change of [f=>f.state.workspaceId='workspace-other',f=>f.state.tenant.id='tenant-other',f=>f.state.boot.session.userId='admin-other',f=>f.state.boot.session.permissions=[],f=>f.route={...f.route,params:{channelId:'other-channel',tab:'visitor'}},f=>f.state.boot.session=null]){
    const pending=deferred(),f=fixture({apiHandler:()=>pending.promise});f.render();const mounting=f.ui.mount(f.main,f.route);assert.equal(f.protectedCalls.length,1);change(f);pending.resolve(f.dto());assert.equal(await mounting,false);assert.equal(f.protectedCalls[0].options.signal.aborted,true);assert.equal(f.changes,0);await f.open();assert.equal(f.factories.length,0);assert.equal(f.publicCalls.length,0);f.ui.reset();
  }
});

test('public fetch drops admin options and rejects endpoint, route and stale response changes around awaits',async()=>{
  const pending=deferred(),f=fixture({mockWidget:true,networkHandler:()=>pending.promise});await f.mount();const widget=await f.open(),request=f.factories[0].fetchImpl,url=`${apiOrigin}/api/public/webchat/${tenantId}/${channelId}/config`;
  for(const invalid of [url+'?token=unsafe',url+'#secret',url.replace(channelId,'other-channel'),url.replace(apiOrigin,'https://evil.example.test'),url.replace('/config','/configuration')])await assert.rejects(request(invalid,{method:'POST'}),{name:'AbortError'});
  assert.equal(f.publicCalls.length,0);
  const fetching=request(url,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-CSRF-Token':'synthetic-admin-csrf','X-Elozi-Workspace':workspaceId,Cookie:'synthetic-cookie'},body:'{}'});assert.equal(f.publicCalls.length,1);assert.deepEqual([...f.publicCalls[0].options.headers.keys()],['content-type']);assert.equal(f.publicCalls[0].options.credentials,'omit');
  f.route={...f.route,params:{channelId,tab:'test'}};pending.resolve({ok:true,status:200,json:async()=>({})});await assert.rejects(fetching,{name:'AbortError'});assert.equal(widget.destroys,1);assert.equal(widget.host.isConnected,false);assert.equal(f.publicCalls[0].options.signal.aborted,true);const calls=f.publicCalls.length;await assert.rejects(request(url,{method:'POST'}),{name:'AbortError'});assert.equal(f.publicCalls.length,calls);f.ui.reset();
});

test('response decoding is guarded after its own await and cleanup rejects captured guest requests',async()=>{
  const decoded=deferred(),f=fixture({mockWidget:true,networkHandler:async()=>({ok:true,status:200,json:()=>decoded.promise})});await f.mount();const widget=await f.open(),request=f.factories[0].fetchImpl,url=`${apiOrigin}/api/public/webchat/${tenantId}/${channelId}/history`;
  const response=await request(url,{method:'POST',body:'{}'}),body=response.json();f.state.boot.csrfToken='synthetic-new-authority';decoded.resolve({messages:[]});await assert.rejects(body,{name:'AbortError'});assert.equal(widget.destroys,1);assert.equal(f.publicCalls[0].options.signal.aborted,true);await assert.rejects(request(url,{method:'POST'}),{name:'AbortError'});assert.equal(f.publicCalls.length,1);assert.equal(f.windowEvents.count(),0);f.ui.reset();
});

test('session/route events stop only the owned widget and same-context events preserve it',async()=>{
  const f=fixture({mockWidget:true});await f.mount();const widget=await f.open();f.win.dispatchEvent({type:'hashchange'});assert.equal(widget.destroys,0);f.state.boot.session.role='operator';f.win.dispatchEvent({type:'elozi:sessionchange'});assert.equal(widget.destroys,1);assert.equal(f.windowEvents.count(),0);assert.equal(f.documentEvents.count(),0);f.ui.reset();
  const g=fixture({mockWidget:true});await g.mount();const guest=await g.open();g.win.dispatchEvent({type:'pagehide'});assert.equal(guest.destroys,1);assert.equal(g.windowEvents.count(),0);g.ui.reset();
});

test('real reauth event immediately destroys the guest and canUse prevents remount during the pending login',async()=>{
  let available=true;const f=fixture({mockWidget:true,canUse:()=>available});await f.mount();const widget=await f.open();available=false;f.win.dispatchEvent({type:'elozi:reauth'});
  assert.equal(widget.destroys,1);assert.equal(f.windowEvents.count(),0);assert.equal(f.documentEvents.count(),0);assert.equal(await f.mount(),false);assert.equal(f.main.querySelector('[data-action="channels:visitor-open"]').disabled,true);assert.equal(f.factories.length,1);assert.equal(f.protectedCalls.length,1);
  available=true;assert.equal(await f.mount(),true);assert.equal(f.protectedCalls.length,2);assert.equal(f.factories.length,1);assert.equal(f.publicCalls.length,0);assert.ok(f.protectedCalls.every(call=>call.options.method==='GET'));await f.open();assert.equal(f.factories.length,2);assert.equal(f.widgets.at(-1).destroys,0);f.ui.reset();
});

test('syncContext only disposes invalid context, does no reads and cancels pending authority work',async()=>{
  for(const change of [f=>f.state.tenant.id='tenant-other',f=>f.state.view='inbox',f=>f.state.boot.session.permissions=[],f=>f.route={section:'inbox',params:{}}]){
    const f=fixture({mockWidget:true});await f.mount();const widget=await f.open();f.ui.syncContext();assert.equal(widget.destroys,0);change(f);f.ui.syncContext();assert.equal(widget.destroys,1);assert.equal(f.protectedCalls.length,1);assert.equal(f.publicCalls.length,0);f.ui.reset();
  }
  let available=true;const pending=deferred(),f=fixture({apiHandler:()=>pending.promise,canUse:()=>available});f.render();const mounting=f.ui.mount(f.main,f.route);available=false;f.ui.syncContext();assert.equal(f.protectedCalls[0].options.signal.aborted,true);pending.resolve(f.dto());assert.equal(await mounting,false);assert.equal(f.changes,0);assert.equal(f.protectedCalls.length,1);f.ui.reset();
});

test('cleanup owns the accepted handle even if its public marker changes and destroys a newly rejected factory handle',async()=>{
  const f=fixture();await f.mount();const widget=await f.open();delete widget.host.dataset.channelVisitorTest;f.ui.reset();assert.equal(widget.host.isConnected,false);assert.equal(f.windowEvents.count(),0);assert.equal(f.documentEvents.count(),0);assert.equal(f.timers.size,0);
  const g=fixture({mockWidget:true,factoryHandler:widget=>{delete widget.open;return widget;}});await g.mount();const rejected=await g.open();assert.equal(rejected.destroys,1);assert.equal(rejected.host.isConnected,false);assert.equal(g.windowEvents.count(),0);assert.equal(g.documentEvents.count(),0);assert.match(g.render(),/Não foi possível consultar o canal/);g.ui.reset();
});

test('an existing embedded widget is neither reused nor removed by the visitor page',async()=>{
  const f=fixture(),existing=createWebchatWidget({document:f.doc,window:f.win,apiOrigin,tenantId,channelId,fetchImpl:async()=>({ok:true,status:200,json:async()=>({})})});await f.mount();await f.open();assert.equal(f.factories.length,0);assert.equal(f.publicCalls.length,0);assert.match(f.render(),/Já existe um chat desse canal/);f.ui.reset();assert.equal(existing.host.isConnected,true);existing.destroy();
});

test('configuration failures stay generic and recover only through explicit refresh',async()=>{
  let denied=true;const f=fixture({apiHandler:async(_path,_options,dto)=>{if(denied)throw Object.assign(Error('synthetic sensitive provider reason'),{status:403});return dto;}});assert.equal(await f.mount(),false);assert.match(f.render(),/acesso autorizado novamente/);assert.doesNotMatch(f.render(),/sensitive provider/);assert.equal(await f.ui.mount(f.main,f.route),false);assert.equal(f.protectedCalls.length,1);denied=false;await f.ui.act('channels:visitor-refresh',channelId);assert.equal(f.protectedCalls.length,2);await f.open();assert.equal(f.factories.length,1);f.ui.reset();
});

test('PT/EN copy, widget language and customer text escaping survive rerender without translating customer content',async()=>{
  const f=fixture();f.state.tenant.name='<img src=x onerror=unsafe>';f.state.tenant.channels[0].name='Chat visitante de teste <script>unsafe</script>';await f.mount();
  assert.match(f.render(),/Empresa|&lt;img/);assert.doesNotMatch(f.render(),/<img|<script>/);
  setLocale('en',{persist:false,notify:false});const html=f.render();assert.match(html,/<h1>Test visitor chat<\/h1>/);assert.match(html,/Open test conversation/);assert.match(html,/Chat visitante de teste &lt;script&gt;unsafe&lt;\/script&gt;/);const widget=await f.open();assert.equal(widget.host.getAttribute('lang'),'en');assert.equal(widget.host.shadowRoot.querySelector('#widget-start').textContent,'Start conversation');f.ui.reset();setLocale('pt-BR',{persist:false,notify:false});
});

test('unknown actions, stale ids and detached mount do not execute any request',async()=>{
  const f=fixture();f.render();f.main.remove();assert.equal(await f.ui.mount(f.main,f.route),false);assert.equal(f.protectedCalls.length,0);assert.equal(await f.ui.act('channels:visitor-unrecognized',channelId),false);await f.ui.act('channels:visitor-open','other-channel');assert.equal(f.publicCalls.length,0);f.ui.reset();assert.equal(f.ui.view({section:'inbox',params:{}}),'');
});
