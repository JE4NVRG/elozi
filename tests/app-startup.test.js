import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import { runInNewContext } from 'node:vm';
import { attendanceReplyAccess } from '../public/participants-ui.js';
import { excerpt } from './helpers/app-source.js';
import { sessionExpired, resetSessionGuard, reauthPending } from '../public/session-guard.js';
import { createDocument } from './helpers/inbox-dom.js';
import { createJsonRead } from '../public/json-read.js';
// A 401 goes through session-guard.js (FRONTEND-V2 §8.1, P1 commit 1f): the real sessionExpired runs with the fixture's location.
const withSessionGuard = globals => Object.assign(globals, { sessionExpired: options => sessionExpired({ ...options, location: globals.location, document: globals.document, window: globals.window }) });
import { parseHash } from '../public/router.js';
import { viewForRoute } from '../public/nav-config.js';

const executable = [
  excerpt('permissions'),
  excerpt('reply-access'),
  excerpt('inbox-selection-state'),
  excerpt('current-conversation'),
  excerpt('api'),
  excerpt('view-panels'),
  excerpt('refresh'),
  excerpt('start'),
  excerpt('act')
].join('\n') + '\n({start,refresh,act,api,hasPermission,attendanceContext})';

test.afterEach(() => { resetSessionGuard(); i18n.setLocale('pt-BR', { persist: false, notify: false }); });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ bootstrapStatus = 200, bootstrapHtml = false, bootstrapValue, hash = '', platformOwner = false, browser = false, responseHook, auxiliaryHook, jsonReadOptions = {} } = {}) {
  const state = { boot: null, tenant: null, workspaceId: null, view: 'overview', conversation: null, sendIntent: null };
  const boot = {
    session: { role: 'reseller', userId: 'admin-a', name: 'Administrador sintético', resellerId: 'workspace-a', platformOwner, permissions: null },
    tenants: [{ id: 'company-a', name: 'Empresa sintética' }], reseller: { id: 'workspace-a', name: 'Workspace sintético' }
  };
  const tenant = { id: 'company-a', channels: [], conversations: [] };
  const responses = new Map([
    ['/api/bootstrap', bootstrapValue === undefined ? boot : bootstrapValue], ['/api/tenants/company-a', tenant],
    ['/api/tenants/company-a/flows', { flows: [] }], ['/api/users', { users: [] }],
    ['/api/users/invitations', { invitations: [] }], ['/api/auth/me', { user: { id: 'admin-a' } }],
    ['/api/auth/sessions', { sessions: [] }], ['/api/integrations', { google: { enabled: false } }],
    ['/api/tenants/company-a/contacts?archived=true', { contacts: [] }],
    ['/api/tenants/company-a/assignees', { assignees: [] }],
    ['/api/tenants/company-a/metrics', {}], ['/api/tenants/company-a/mcp/servers', { servers: [] }]
  ]);
  const calls = [], redirects = [], renders = [], panelLoads = [], effects = [], saved = new Map(), routes = [];
  const document=browser?createDocument('<div id="app"><p>Carregando…</p></div>'):undefined,listeners=new Map(),events=[];
  const window=browser?{location:{origin:'https://synthetic.invalid'},addEventListener(type,fn){const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},dispatchEvent(event){events.push(event.type);for(const fn of listeners.get(event.type)||[])fn(event);}}:undefined;
  if(browser){const create=document.createElement.bind(document);document.createElement=tag=>{const node=create(tag);if(tag==='dialog'){node.showModal=()=>{node.open=true;};node.close=()=>{node.open=false;};}return node;};}
  const app = document?.querySelector('#app') || { innerHTML: '' },pathStatuses=new Map();
  const mediaUI = { reset() { effects.push('media-reset'); }, forgetTenant() {}, retainConversations() {} };
  const fakeFetch = async (path, options) => {
    calls.push({ path, options });
    assert.ok(responses.has(path), 'Nenhuma chamada HTTP fora do fixture: ' + path);
    if(responseHook){const result=await responseHook(path,options,responses);if(result!==undefined)return result;}
    const status = pathStatuses.get(path) || (path === '/api/bootstrap' ? bootstrapStatus : 200);
    const value = status === 401 ? { error: 'Sessão inválida ou expirada. Entre novamente.' } : responses.get(path);
    return new Response(path === '/api/bootstrap' && bootstrapHtml ? '<html>Proxy sintético</html>' : JSON.stringify(value), { status });
  };
  const api = runInNewContext(executable, withSessionGuard({
    ...i18n,
    state, attendanceReplyAccess, mediaUI, Response, document, window, reauthPending,
    readJsonResponse: createJsonRead({ fetch: fakeFetch, ...jsonReadOptions }),
    channelVisitorTestUI: { reset() { effects.push('visitor-reset'); }, syncContext() {} },
    // O refresh de agenda é exercitado no seu controller próprio, não nesta abertura.
    contactLinksUI: { reset() {} }, contactRefresh: { reset() { effects.push('contacts-reset'); } }, memoryUI: { reset() {} },
    location: { hash, assign(target) { redirects.push(target); } },
    views: { overview: true, inbox: true, platform: true, accounts: true, automation: true, knowledge: true },
    $: selector => selector === '#app' ? app : null,
    escape: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } },
    consolidatedInbox: { data: { offset: 0 }, sync() { effects.push('inbox-sync'); }, retainConversations() {} },
    noteDrafts: { reset() { effects.push('note-reset'); } }, repliesUI: { reset() {} },
    automationUI: { async refresh() { effects.push('automation-refresh'); await auxiliaryHook?.('automation'); } },
    knowledgeUI: { async load() { effects.push('knowledge-load'); await auxiliaryHook?.('knowledge'); } },
    refreshInboxList: async () => effects.push('inbox-refresh'),
    render() { renders.push({ workspaceId: state.workspaceId, tenantId: state.tenant?.id, userId: state.boot?.session?.userId, view: state.view }); app.innerHTML = '<main>Workspace carregado</main>'; },
    servicePrincipalsUI: { async load() { panelLoads.push(state.view); } },
    accountsUI: { async load() { panelLoads.push(state.view); } },
    // The deep link and ?w= after the first render are exercised in route-deep-link.test.js.
    parseHash, viewForRoute, startRoute: async route => { routes.push({ route, view: state.view, renders: renders.length }); }, toast: message => effects.push(['toast', message]),
    fetch: fakeFetch
  }));
  return { ...api, state, boot, tenant, calls, redirects, renders, panelLoads, effects, saved, app, routes, responses, pathStatuses, document, events,
    renewed(userId='admin-a'){for(const fn of listeners.get('message')||[])fn({origin:'https://synthetic.invalid',data:{type:'elozi:reauth-ok',userId}});} };
}

test('primeira abertura busca bootstrap com boot null, aplica workspace e renderiza após carregar a empresa', async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.calls[0]?.path, '/api/bootstrap', 'O contexto inicial não deve falhar antes do primeiro fetch');
  assert.equal(f.state.boot.session.userId, 'admin-a');
  assert.equal(f.state.workspaceId, 'workspace-a'); assert.equal(f.state.tenant.id, 'company-a');
  assert.equal(f.renders.length, 2);
  for (const rendered of f.renders) assert.deepEqual(rendered, { workspaceId: 'workspace-a', tenantId: 'company-a', userId: 'admin-a', view: 'overview' });
  assert.deepEqual(f.effects.filter(effect => ['automation-refresh', 'knowledge-load'].includes(effect)), []);
  assert.equal(f.saved.get('elozi-tenant:workspace-a'), 'company-a');
  assert.deepEqual(f.redirects, []); assert.doesNotMatch(f.app.innerHTML, /startup-error|TypeError/);
  assert.deepEqual(f.routes, [{ route: null, view: 'overview', renders: 2 }], 'sem hash, nenhuma rota a aplicar depois do primeiro render');
  assert.equal(f.calls[0].options.headers['X-Elozi-Workspace'], undefined);
  for (const call of f.calls.slice(1)) assert.equal(call.options.headers['X-Elozi-Workspace'], 'workspace-a');
});

test('primeira abertura respeita hash inbox e reserva a tela da plataforma para o proprietário', async () => {
  const inbox = fixture({ hash: '#inbox', platformOwner: true }); await inbox.start();
  assert.equal(inbox.state.view, 'inbox'); assert.ok(inbox.effects.includes('inbox-refresh')); assert.deepEqual(inbox.panelLoads, []);
  assert.equal(inbox.routes.length, 1); assert.equal(inbox.routes[0].route.section, 'inbox'); assert.equal(inbox.routes[0].renders, 1, 'a rota é aplicada depois do primeiro render');
  const deep = fixture({ hash: '#inbox/company-a/conversation-a' }); await deep.start();
  assert.equal(deep.state.view, 'inbox'); assert.deepEqual(deep.routes[0].route.params, { tenantId: 'company-a', conversationId: 'conversation-a' }); assert.ok(deep.effects.includes('inbox-refresh'));
  const legacy = fixture({ hash: '#platform' }); await legacy.start(); assert.equal(legacy.state.view, 'platform', 'hash legado continua abrindo a mesma tela');
  const unknown = fixture({ hash: '#guide-overview' }); await unknown.start(); assert.equal(unknown.state.view, 'overview'); assert.deepEqual(unknown.routes, [{ route: null, view: 'overview', renders: 2 }]);
  const owner = fixture({ platformOwner: true }); await owner.start();
  assert.equal(owner.state.view, 'platform'); assert.deepEqual(owner.panelLoads, ['platform']);
  assert.doesNotMatch(owner.app.innerHTML, /startup-error|TypeError/);
});

test('ausência de sessão não concede permissões durante a preparação do contexto inicial', () => {
  const f = fixture();
  assert.equal(f.hasPermission('inbox.reply'), false);
  assert.equal(f.attendanceContext().canReply, false);
  f.state.boot = { session: { role: 'operator', permissions: [] } };
  assert.equal(f.hasPermission('inbox.reply'), false);
  f.state.boot.session.permissions = ['inbox.reply']; assert.equal(f.hasPermission('inbox.reply'), true);
});

test('bootstrap 401 antes de contexto pronto abre login sem apagar intenção nem desenhar falso erro de servidor', async () => {
  const f = fixture({ bootstrapStatus: 401 }); f.state.sendIntent = { id: 'synthetic-pending' };
  await f.start();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/bootstrap');
  assert.equal(f.effects.includes('media-reset'),false); assert.equal(f.state.sendIntent.id,'synthetic-pending');
  assert.deepEqual(f.redirects, ['/login?reason=session-expired']);
  assert.equal(f.effects.filter(effect => effect === 'visitor-reset').length, 1, '401 descarta o visitante antes do retorno ao login');
  assert.equal(f.state.boot, null); assert.deepEqual(f.renders, []); assert.deepEqual(f.routes, [], 'sem sessão nenhuma rota é aplicada');
  assert.doesNotMatch(f.app.innerHTML, /startup-error|servidor local|Cannot read|TypeError/);
});

test('401 inicial no DOM do navegador volta somente para a rota interna reconhecida e preserva os rascunhos', async () => {
  const f=fixture({bootstrapStatus:401,browser:true,hash:'#inbox/company-a/conversation-a?w=workspace-a&q=SyntheticPrivateSearch&token=SyntheticPrivateToken'});f.state.sendIntent={id:'own-unsent'};
  await f.start();
  assert.deepEqual(f.redirects,['/login?reason=session-expired&next='+encodeURIComponent('/#inbox/company-a/conversation-a?w=workspace-a')]);
  assert.equal(reauthPending(),false);assert.equal(f.document.querySelector('dialog'),null);assert.equal(f.state.sendIntent.id,'own-unsent');assert.equal(f.effects.includes('media-reset'),false);
  assert.doesNotMatch(f.app.innerHTML,/startup-error|servidor local/);assert.ok(!f.redirects[0].includes('SyntheticPrivate'));
});

test('401s paralelos antes do commit geram um só retorno de login e nenhuma tela parcial autorizada', async () => {
  const f=fixture({browser:true});f.pathStatuses.set('/api/users',401);f.pathStatuses.set('/api/auth/me',401);
  await f.start();assert.equal(f.redirects.length,1);assert.equal(f.state.boot,null);assert.equal(f.state.tenant,null);assert.equal(f.renders.length,0);assert.doesNotMatch(f.app.innerHTML,/startup-error/);
});

test('401 de painel já aberto mantém a guarda, o conteúdo e a intenção durante reautenticação', async () => {
  const f=fixture({browser:true});await f.start();const before=f.app.innerHTML,mediaResets=f.effects.filter(effect=>effect==='media-reset').length;
  f.state.sendIntent={id:'own-unsent'};f.pathStatuses.set('/api/bootstrap',401);await f.start();
  assert.equal(reauthPending(),true);assert.ok(f.document.querySelector('dialog'));assert.deepEqual(f.redirects,[]);assert.equal(f.app.innerHTML,before);assert.equal(f.state.sendIntent.id,'own-unsent');
  assert.equal(f.effects.filter(effect=>effect==='media-reset').length,mediaResets);
  assert.equal(f.effects.filter(effect=>effect==='visitor-reset').length,1, 'reauth interrompe o visitante sem apagar a intenção de envio');
  f.renewed();assert.equal(reauthPending(),false);assert.equal(f.state.sendIntent.id,'own-unsent');assert.equal(f.app.innerHTML,before);
});

test('leituras independentes abrem em paralelo no workspace fresco, com commit somente após todas as confirmações', async () => {
  const waits=new Map(),f=fixture({platformOwner:true,responseHook:(path,_options,responses)=>{if(path==='/api/bootstrap')return;const wait=deferred();waits.set(path,{...wait,response:responses.get(path)});return wait.promise;}}),pending=f.start();await tick();
  assert.equal(waits.size,11);assert.equal(f.renders.length,0);assert.equal(f.state.boot,null);assert.ok(f.calls.slice(1).every(call=>call.options.headers['X-Elozi-Workspace']==='workspace-a'));
  for(const [path,wait]of waits)if(path!=='/api/tenants/company-a')wait.resolve(new Response(JSON.stringify(wait.response),{status:200}));await tick();assert.equal(f.state.boot,null);
  const tenant=waits.get('/api/tenants/company-a');tenant.resolve(new Response(JSON.stringify(tenant.response),{status:200}));assert.equal(await pending,true);assert.equal(f.renders.length,2);
  assert.deepEqual(f.effects.filter(effect=>['automation-refresh','knowledge-load'].includes(effect)),[]);
});


for (const view of ['automation', 'knowledge']) test(`startup ${view} aguarda somente a leitura da página ativa antes de renderizar`, async () => {
  const wait = deferred(), f = fixture({ hash: '#' + view, auxiliaryHook: name => name === view ? wait.promise : undefined });
  const pending = f.start(); await tick();
  assert.ok(f.state.boot); assert.equal(f.renders.length, 0); assert.equal(f.state.workspaceReady, undefined);
  assert.deepEqual(f.effects.filter(effect => ['automation-refresh', 'knowledge-load'].includes(effect)), [view === 'automation' ? 'automation-refresh' : 'knowledge-load']);
  wait.resolve(); assert.equal(await pending, true); assert.equal(f.state.workspaceReady, true);
  assert.ok(f.renders.length > 0); assert.ok(f.renders.every(rendered => rendered.view === view));
});

test('retry durante startup pendente não duplica a autenticação nem libera a abertura corrente',async()=>{
  const wait=deferred(),f=fixture({responseHook:path=>path==='/api/bootstrap'?wait.promise:undefined}),pending=f.start();await tick();
  assert.equal(await f.start(),false);assert.equal(f.state.starting,true);assert.equal(f.calls.length,1);wait.resolve(new Response(JSON.stringify(f.boot),{status:200}));assert.equal(await pending,true);assert.equal(f.state.starting,false);assert.equal(f.renders.length,2);
});

for (const view of ['automation', 'knowledge']) test(`401 durante ${view} posterior ao commit ainda usa login inicial antes do primeiro render`,async()=>{
  let f;f=fixture({browser:true,hash:'#'+view,auxiliaryHook:name=>{if(name===view){f.pathStatuses.set('/api/bootstrap',401);return f.api('/api/bootstrap');}}});
  assert.equal(await f.start(),false);assert.equal(f.renders.length,0);assert.equal(f.state.workspaceReady,undefined);assert.equal(f.redirects.length,1);assert.equal(reauthPending(),false);assert.doesNotMatch(f.app.innerHTML,/startup-error/);
});

for(const view of ['automation','knowledge']) for(const [name,change]of [['workspace',state=>{state.workspaceId='other-workspace';}],['person',state=>{state.boot.session.userId='other-person';}],['permissions',state=>{state.boot.session.permissions=[];}],['sequence',state=>{state.refreshSequence++;}]])test(`auxiliares ${view} pendentes não liberam render após mudar ${name}`,async()=>{
  const wait=deferred(),f=fixture({hash:'#'+view,auxiliaryHook:name=>name===view?wait.promise:undefined}),pending=f.start();await tick();assert.ok(f.state.boot);assert.equal(f.renders.length,0);
  change(f.state);wait.resolve();assert.equal(await pending,false);assert.equal(f.renders.length,0);assert.equal(f.state.starting,false);assert.doesNotMatch(f.app.innerHTML,/startup-error/);
});

for(const [name,change]of [['workspace',state=>{state.workspaceId='other-workspace';}],['person',state=>{state.boot={session:{userId:'other-person',role:'reseller'}};}],['permissions',state=>{state.boot={session:{permissions:['other-permission']}};}],['sequence',state=>{state.refreshSequence++;}]])test(`startup não aplica resultado atrasado após mudar ${name}`,async()=>{
  const wait=deferred(),f=fixture({responseHook:(path,_options,responses)=>path==='/api/tenants/company-a'?wait.promise:undefined}),pending=f.start();await tick();change(f.state);wait.resolve(new Response(JSON.stringify(f.tenant),{status:200}));
  assert.equal(await pending,false);assert.equal(f.state.tenant,null);assert.equal(f.renders.length,0);assert.doesNotMatch(f.app.innerHTML,/startup-error/);
});

test('identidade diferente entre bootstrap e auth/me impede commit mesmo com ambos os GETs confirmados',async()=>{
  const f=fixture();f.responses.set('/api/auth/me',{user:{id:'other-person'}});await f.start();assert.equal(f.state.boot,null);assert.equal(f.state.tenant,null);assert.equal(f.renders.length,0);assert.match(f.app.innerHTML,/não confirmou o contexto/);
});

test('falha de transporte esgotada tem mensagem PT/EN e permite retry explícito sem abertura concorrente',async()=>{
  for(const locale of ['pt-BR','en']){
    i18n.setLocale(locale,{persist:false,notify:false});let failures=2;const f=fixture({responseHook:path=>{if(path==='/api/bootstrap'&&failures-->0)throw new TypeError('Synthetic offline');}});
    assert.equal(await f.start(),false);assert.equal(f.calls.length,2);assert.equal(f.state.starting,false);assert.match(f.app.innerHTML,/data-action="startup:retry"/);assert.match(f.app.innerHTML,locale==='en'?/Check your connection and try again/:/Confira a conexão e tente novamente/);assert.doesNotMatch(f.app.innerHTML,/servidor local|local server/);
    await f.act('startup:retry');assert.equal(f.calls.filter(call=>call.path==='/api/bootstrap').length,3);assert.equal(f.renders.length,2);assert.doesNotMatch(f.app.innerHTML,/startup-error/);
  }
});

test('corpo GET interrompido depois de headers 200 refaz só a leitura e confirma o contexto uma vez',async()=>{
  let failed=false;const path='/api/tenants/company-a',f=fixture({responseHook:requested=>{
    if(requested===path&&!failed){failed=true;const response=new Response('',{status:200});response.json=async()=>{throw new TypeError('Synthetic interrupted body');};return response;}
  }});
  assert.equal(await f.start(),true);assert.equal(f.calls.filter(call=>call.path===path).length,2);
  for(const call of f.calls.filter(call=>call.path===path))assert.equal(call.options.headers['X-Elozi-Workspace'],'workspace-a');
  assert.equal(f.renders.length,2);assert.equal(f.state.workspaceReady,true);assert.equal(f.state.tenant.id,'company-a');assert.deepEqual(f.redirects,[]);
});

test('duas falhas no corpo GET encerram a abertura com recuperação explícita sem contexto parcial',async()=>{
  const path='/api/tenants/company-a',f=fixture({responseHook:requested=>{
    if(requested===path){const response=new Response('',{status:200});response.json=async()=>{throw new TypeError('Synthetic interrupted body');};return response;}
  }});
  assert.equal(await f.start(),false);assert.equal(f.calls.filter(call=>call.path===path).length,2);assert.equal(f.state.boot,null);assert.equal(f.state.tenant,null);assert.equal(f.renders.length,0);
  assert.match(f.app.innerHTML,/data-action="startup:retry"/);assert.match(f.app.innerHTML,/resposta inválida/);assert.equal(f.state.starting,false);
});

for(const failure of ['fetch','body'])test(`POST com falha de ${failure} mantém resultado incerto sem repetição`,async()=>{
  const f=fixture({responseHook:()=>{
    if(failure==='fetch')throw new TypeError('Synthetic mutation transport failure');
    const response=new Response('',{status:200});response.json=async()=>{throw new TypeError('Synthetic interrupted mutation body');};return response;
  }});f.state.sendIntent={id:'own-unsent'};
  await assert.rejects(f.api('/api/bootstrap',{method:'POST',body:'{}'}),error=>failure==='fetch'?error instanceof TypeError:/resposta inválida/.test(error.message));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'POST');assert.equal(f.calls[0].options.body,'{}');assert.equal(f.state.sendIntent.id,'own-unsent');assert.deepEqual(f.redirects,[]);
});

for(const status of [401,403])test(`GET ${status} com corpo interrompido não repete nem contorna a autorização`,async()=>{
  const f=fixture({responseHook:()=>{const response=new Response('',{status});response.json=async()=>{throw new TypeError('Synthetic interrupted error body');};return response;}});
  await assert.rejects(f.api('/api/bootstrap'),error=>error.status===status);assert.equal(f.calls.length,1);assert.equal(f.state.boot,null);assert.equal(f.renders.length,0);
  assert.equal(f.redirects.length,status===401?1:0);
});

test('abort externo interrompe a leitura sem retry nem alteração da intenção de envio',async()=>{
  const controller=new AbortController(),f=fixture({responseHook:(_path,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});
  })});f.state.sendIntent={id:'own-unsent'};
  const pending=f.api('/api/bootstrap',{signal:controller.signal});await tick();controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(f.calls.length,1);assert.equal(f.state.sendIntent.id,'own-unsent');assert.deepEqual(f.redirects,[]);
});

test('leitura repetida pendente não aplica contexto antigo após mudança de época',async()=>{
  const wait=deferred();let attempts=0;const f=fixture({responseHook:path=>{
    if(path==='/api/tenants/company-a'){if(++attempts===1)throw new TypeError('Synthetic failed first read');return wait.promise;}
  }}),pending=f.start();await tick();assert.equal(attempts,2);assert.equal(f.state.boot,null);
  f.state.refreshSequence++;wait.resolve(new Response(JSON.stringify(f.tenant),{status:200}));
  assert.equal(await pending,false);assert.equal(f.state.boot,null);assert.equal(f.state.tenant,null);assert.equal(f.renders.length,0);assert.equal(f.state.starting,false);assert.doesNotMatch(f.app.innerHTML,/startup-error/);
});

for(const phase of ['fetch','body'])test(`prazo da leitura pendente em ${phase} encerra spinner e ignora resultado tardio`,async()=>{
  const timers=new Map(),waits=[];let timerId=0;const f=fixture({
    jsonReadOptions:{timeoutMs:12000,setTimeoutImpl:callback=>{const id=++timerId;timers.set(id,callback);return id;},clearTimeoutImpl:id=>timers.delete(id)},
    responseHook:path=>{
      if(path!=='/api/bootstrap')return;
      const wait=deferred();waits.push(wait);
      if(phase==='fetch')return wait.promise;
      const response=new Response('',{status:200});response.json=()=>wait.promise;return response;
    }
  }),pending=f.start();await tick();assert.equal(waits.length,1);assert.equal(f.renders.length,0);
  const fire=()=>{const [id,callback]=timers.entries().next().value;timers.delete(id);callback();};
  fire();await tick();assert.equal(waits.length,2);assert.equal(f.state.boot,null);fire();
  assert.equal(await pending,false);assert.equal(f.calls.length,2);assert.equal(f.state.starting,false);assert.match(f.app.innerHTML,/data-action="startup:retry"/);assert.equal(timers.size,0);
  for(const wait of waits)wait.resolve(phase==='fetch'?new Response(JSON.stringify(f.boot),{status:200}):f.boot);
  await tick();assert.equal(f.renders.length,0);assert.equal(f.state.boot,null);assert.equal(f.state.tenant,null);assert.match(f.app.innerHTML,/startup-error/);
});

test('resposta bootstrap sem JSON apresenta erro da API sem dereferenciar a sessão', async () => {
  const f = fixture({ bootstrapHtml: true }); await f.start();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.redirects, []); assert.deepEqual(f.renders, []);
  assert.equal(f.state.boot, null); assert.match(f.app.innerHTML, /resposta inválida/);
  assert.doesNotMatch(f.app.innerHTML, /Cannot read|TypeError/);
});

for (const [description, bootstrapValue] of [
  ['null', null], ['array', []], ['objeto sem sessão', { tenants: [] }],
  ['sessão null', { session: null, tenants: [] }], ['sessão array', { session: [], tenants: [] }],
  ['empresas ausentes', { session: { role: 'reseller', resellerId: 'workspace-a' } }]
]) {
  test('bootstrap JSON inválido ' + description + ' conserva estado inicial e mostra erro compreensível', async () => {
    const f = fixture({ bootstrapValue }); await f.start();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/bootstrap');
    assert.equal(f.state.boot, null); assert.equal(f.state.workspaceId, null); assert.equal(f.state.tenant, null);
    assert.deepEqual(f.renders, []); assert.deepEqual(f.redirects, []);
    assert.match(f.app.innerHTML, /startup-error/); assert.match(f.app.innerHTML, /inválid/);
    assert.doesNotMatch(f.app.innerHTML, /Cannot read|TypeError|\.some is not a function/);
    // White label (FRONTEND-V2 §8.2 1e): the boot error never names the platform; the static title is neutral too.
    assert.doesNotMatch(f.app.innerHTML, /elozi/i);
  });
}
