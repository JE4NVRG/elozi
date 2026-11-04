import test from 'node:test';
import assert from 'node:assert/strict';
import {createGroupHistoryImportUI} from '../public/group-history-import-ui.js';

const command = '11111111-1111-4111-8111-111111111111';
const deferred = () => { let resolve,reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const selection = {conversationId:'group-a',channelId:'wa-a',title:'Grupo de teste'};
function status(more = {}) { return {tenantId:'tenant-a',conversationId:'group-a',channelId:'wa-a',version:2,anchor:{available:true},state:'idle',job:null,...more}; }
function job(state = 'pending',more = {}) { return {id:'job-a',commandId:command,requestedLimit:50,state,counters:{imported:0,duplicates:0,excluded:0,requested:50},createdAt:'2026-10-05T07:00:00.000Z',updatedAt:'2026-10-05T07:01:00.000Z',...more}; }
const withJob = (state,more = {}) => status({state,job:job(state,more)});
function fixture({intercept,queuedClose = false,document,onFinished,newCommandId,maxPolls = 30} = {}) {
  const context = {active:true,workspaceId:'workspace-a',tenantId:'tenant-a',userId:'human-a',authorityKey:'read-manage-a',canManageChannels:true,canReadInbox:true,supportGrantId:null,kind:'human',boot:{},session:{},csrfToken:'csrf-qa'};
  const calls=[],notices=[],finished=[],opened=[],closeEvents=[],timers=new Map(),listeners=new Map();
  let source=status(),host=null,clock=0,closed=0;
  const modal = {open:false,html:'',querySelector(selector) { return selector === '[data-group-history-import-panel]' ? host : null; },addEventListener(event,listener) { listeners.set(event,listener); },close() {this.open=false;closed++; const dispatch = () => listeners.get('close')?.(); if(queuedClose) closeEvents.push(dispatch);else dispatch();}};
  function button(action,more={}) {return {isConnected:true,owner:host,dataset:{groupHistoryImportAction:action,groupHistoryImportToken:host?.dataset.groupHistoryImportToken,...more}};}
  const ui = createGroupHistoryImportUI({api:async(path,init) => {
    calls.push({path,init}); const fallback=() => {if(init.method === 'POST') {const body=JSON.parse(init.body);source=withJob('pending',{commandId:body.commandId,requestedLimit:body.limit,counters:{imported:0,duplicates:0,excluded:0,requested:body.limit}});}return structuredClone(source);};
    return intercept ? intercept(path,init,fallback) : fallback();
  },getContext:() => context,getModal:() => modal,toast:(message,failed) => notices.push({message,failed}),onFinished:data => {finished.push(data);return onFinished?.(data);},newCommandId:newCommandId || (() => command),maxPolls,
  setTimer:(fn,delay) => {const id=++clock;timers.set(id,{fn,delay});return id;},clearTimer:id => timers.delete(id),
  openModal(title,subtitle,html) {
    modal.open=true;modal.html=html;let content=html;const token=html.match(/data-group-history-import-token="([^"]+)"/)?.[1];
    host={dataset:{groupHistoryImportToken:token},contains:node => node?.owner===host,setAttribute(name,value){this[name]=value;},querySelector(selector) {
      const action=selector.match(/data-group-history-import-action="([^"]+)"/)?.[1],limit=selector.match(/data-group-history-import-limit="([^"]+)"/)?.[1];
      const pattern=new RegExp(`<button[^>]*data-group-history-import-action="${action}"[^>]*>`,'g'),tag=[...content.matchAll(pattern)].map(match=>match[0]).find(value=>!limit || value.includes(`data-group-history-import-limit="${limit}"`));
      if(!tag)return null;const node=button(action,limit?{groupHistoryImportLimit:limit}:{});node.disabled=/\sdisabled(?:\s|>)/.test(tag);node.focus=() => {if(!node.disabled && document)document.activeElement=node;};return node;
    }};
    Object.defineProperty(host,'innerHTML',{get:()=>content,set:value=>{if(document && host.contains(document.activeElement)){document.activeElement.isConnected=false;document.activeElement=document.body;}content=value;}});
    opened.push({title,subtitle,html});
  }});
  return {ui,context,modal,calls,notices,finished,opened,timers,button,
    action:(action,more={}) => ui.handleAction(button(action,more)),
    setSource:value => {source=value;},source:()=>source,writes:()=>calls.filter(call=>call.init.method==='POST'),
    async tick() {const entry=timers.entries().next().value;if(!entry)return false;timers.delete(entry[0]);entry[1].fn();await new Promise(resolve=>setImmediate(resolve));return true;},
    flushClose:()=>closeEvents.splice(0).forEach(fn=>fn()),
    otherPanel() {modal.open=true;host={dataset:{otherToken:'replacement'},innerHTML:'<p>Outro painel</p>',contains:()=>false};},
    get html(){return host?.innerHTML || '';},get panel(){return host;},get closed(){return closed;}};
}

test('consulta inicial é privada, somente leitura e orienta limites sem prometer histórico completo',async() => {
  const f=fixture();assert.equal(await f.ui.open(selection),true);
  assert.equal(f.calls[0].path,'/api/tenants/tenant-a/conversations/group-a/group-history-import');assert.equal(f.calls[0].init.method,'GET');
  assert.deepEqual(f.calls[0].init.headers,{'X-Elozi-Workspace':'workspace-a','X-CSRF-Token':'csrf-qa'});assert.equal(f.writes().length,0);assert.equal(f.timers.size,0);
  for(const label of ['50','100','200','até 50 mensagens','mídias antigas','não reabre','não atribui','não aciona automações','sem cancelar o pedido']) assert.ok(f.html.includes(label),label);
  assert.equal(f.panel['aria-busy'],'false');assert.equal(f.opened.length,1);
});

for(const limit of [50,100,200]) test(`pedido explícito ${limit} usa versão e UUID, sem cursor ou efeitos de atendimento`,async() => {
  const f=fixture();await f.ui.open(selection);await f.action('limit',{groupHistoryImportLimit:String(limit)});assert.equal(await f.action('start'),true);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body),{version:2,limit,commandId:command});assert.equal(f.writes()[0].init.headers['Content-Type'],'application/json');
  assert.equal(f.timers.size,1);assert.ok(f.html.includes('Pedido na fila'));assert.equal(f.finished.length,0);
  f.ui.reset();assert.equal(f.timers.size,0);
});
test('sem referência real, GET orienta mensagem original recebida ou enviada e nem clique forjado inicia pedido',async() => {
  const f=fixture();f.setSource(status({anchor:{available:false},state:'need_anchor'}));await f.ui.open(selection);
  assert.ok(f.html.includes('Receba ou envie uma nova mensagem'));assert.ok(f.html.includes('dados confirmados pelo WhatsApp'));assert.ok(f.html.includes('registrar uma mensagem localmente não cria'));assert.equal(await f.action('start'),false);assert.equal(f.writes().length,0);
  f.setSource(status({version:3}));await f.action('refresh');await f.action('start');assert.equal(JSON.parse(f.writes()[0].init.body).version,3);f.ui.reset();
});
for(const [label,mutate] of [
  ['sem gestão de canais',c=>c.canManageChannels=false],['sem inbox.read',c=>c.canReadInbox=false],['serviço',c=>c.kind='service'],['suporte',c=>c.supportGrantId='support-a'],['sessão inativa',c=>c.active=false],['sem pessoa',c=>c.userId=''],['sem tenant',c=>c.tenantId=''],['sem workspace',c=>c.workspaceId=''],['autoridade ausente',c=>c.authorityKey=''],['boot ausente',c=>c.boot=null],['sessão ausente',c=>c.session=null]
]) test(`ACL recusa ${label} antes da API`,async() => {const f=fixture();mutate(f.context);assert.equal(await f.ui.open(selection),false);assert.equal(f.calls.length,0);assert.equal(f.opened.length,0);});

for(const [label,mutate] of [
  ['tenant',f=>f.context.tenantId='tenant-b'],['workspace',f=>f.context.workspaceId='workspace-b'],['pessoa',f=>f.context.userId='human-b'],['autoridade',f=>f.context.authorityKey='changed'],['CSRF',f=>f.context.csrfToken='changed'],['suporte',f=>f.context.supportGrantId='support-a'],['permissão',f=>f.context.canManageChannels=false],['boot com mesmos dados',f=>f.context.boot={...f.context.boot}],['sessão com mesmos dados',f=>f.context.session={...f.context.session}],['reset',f=>f.ui.reset()],['close',f=>f.modal.close()],['outro painel',f=>f.otherPanel()]
]) test(`GET atrasado não aplica dados nem mantém acompanhamento após ${label}`,async() => {
  const reply=deferred(),f=fixture({intercept:()=>reply.promise}),opening=f.ui.open(selection),old=f.calls[0];mutate(f);reply.resolve(withJob('completed',{counters:{imported:5,duplicates:0,excluded:0,requested:50}}));
  assert.equal(await opening,false);assert.equal(f.finished.length,0);assert.equal(f.timers.size,0);
  if(label==='outro painel'){assert.equal(f.modal.open,true);assert.equal(f.html,'<p>Outro painel</p>');}else assert.equal(f.modal.open,false);
  assert.equal(old.init.signal.aborted,true);
});
test('ABA de empresa com reset não revive request antigo mesmo com IDs devolvidos',async() => {
  const reply=deferred();let first=true;const f=fixture({intercept:(_path,_init,fallback)=>first?(first=false,reply.promise):fallback()});
  const old=f.ui.open(selection);f.context.tenantId='tenant-b';f.ui.reset();f.context.tenantId='tenant-a';await f.ui.open(selection);const html=f.html;
  reply.resolve(withJob('completed'));await old;assert.equal(f.html,html);assert.equal(f.finished.length,0);
});
test('POST único resiste duplo clique e troca de limite durante gravação',async() => {
  const reply=deferred(),f=fixture({intercept:(_path,init,fallback)=>init.method==='POST'?reply.promise:fallback()});await f.ui.open(selection);
  const sending=f.action('start');assert.equal(await f.action('start'),false);assert.equal(await f.action('limit',{groupHistoryImportLimit:'200'}),false);assert.equal(f.writes().length,1);
  reply.resolve(withJob('pending'));await sending;assert.equal(f.timers.size,1);f.ui.reset();
});
test('POST incerto só reconcilia pelo commandId; reabrir e verificar não repetem pedido',async() => {
  let lose=true;const f=fixture({intercept:(_path,init,fallback)=>{if(init.method==='POST'&&lose){lose=false;fallback();throw new TypeError('private raw failure');}return fallback();}});
  await f.ui.open(selection);assert.equal(await f.action('start'),false);assert.ok(f.html.includes('confirmação'));assert.ok(!f.html.includes('private raw failure'));
  assert.equal(await f.action('start'),false);f.modal.close();await f.ui.open(selection);
  assert.equal(f.calls.at(-1).path.endsWith(`?commandId=${command}`),true);assert.equal(f.writes().length,1);assert.ok(f.html.includes('Pedido na fila'));f.ui.reset();
});
test('GET idle após resultado incerto não é prova de rejeição e mantém novo pedido bloqueado',async() => {
  const f=fixture({intercept:(_path,init,fallback)=>{if(init.method==='POST')throw new TypeError('lost');return fallback();}});await f.ui.open(selection);await f.action('start');await f.action('refresh');
  assert.ok(f.html.includes('Pedido ainda não confirmado'));assert.equal(await f.action('start'),false);assert.equal(f.writes().length,1);assert.equal(f.timers.size,0);
});
test('POST interrompido ao fechar persiste identidade do pedido e só retoma GET',async() => {
  const reply=deferred(),f=fixture({intercept:(_path,init,fallback)=>init.method==='POST'?reply.promise:fallback()});await f.ui.open(selection);const pending=f.action('start');f.modal.close();
  assert.equal(f.writes()[0].init.signal.aborted,true);f.setSource(withJob('requesting'));await f.ui.open(selection);reply.resolve(withJob('completed'));await pending;
  assert.equal(f.writes().length,1);assert.equal(f.finished.length,0);assert.ok(f.html.includes('Solicitando ao WhatsApp'));f.ui.reset();
});
test('consulta periódica só GET aplica conclusão e callback uma vez, sem garantia total',async() => {
  const f=fixture();await f.ui.open(selection);await f.action('start');f.setSource(withJob('importing',{counters:{imported:4,duplicates:2,excluded:1,requested:50}}));await f.tick();
  assert.ok(f.html.includes('Importando mensagens'));assert.equal(f.calls.at(-1).init.method,'GET');assert.equal(f.calls.at(-1).path.endsWith(`?commandId=${command}`),true);
  f.setSource(withJob('completed',{counters:{imported:40,duplicates:4,excluded:1,requested:50}}));await f.tick();assert.equal(f.timers.size,0);assert.equal(f.finished.length,1);
  assert.deepEqual(f.finished[0],{tenantId:'tenant-a',conversationId:'group-a',channelId:'wa-a',jobId:'job-a',imported:40,duplicates:4,excluded:1,requested:50});
  assert.ok(f.html.includes('não confirma que todo o histórico'));await f.action('refresh');assert.equal(f.finished.length,1);assert.equal(f.writes().length,1);
});
test('zero mensagens concluído difere de timeout unavailable e não anuncia recuperação total',async() => {
  for(const state of ['completed','unavailable','failed','cancelled']){const f=fixture();f.setSource(withJob(state));await f.ui.open(selection);assert.equal(f.timers.size,0);assert.equal(f.finished.length,state==='completed'?1:0);assert.equal(f.writes().length,0);assert.ok(f.html.includes('data-history-import-metric="imported">0'));}
});
test('janela de polling é limitada e continuar verifica o mesmo pedido',async() => {
  const f=fixture({maxPolls:2});await f.ui.open(selection);await f.action('start');await f.tick();await f.tick();assert.equal(f.timers.size,0);assert.ok(f.html.includes('acompanhamento automático foi pausado'));
  await f.action('refresh');assert.equal(f.timers.size,1);assert.equal(f.writes().length,1);f.ui.reset();
});
test('fechar, substituir painel ou perder permissão para polling sem cancelar job',async() => {
  for(const action of ['close','substitute','permission']){const f=fixture();await f.ui.open(selection);await f.action('start');if(action==='close')f.modal.close();if(action==='substitute')f.otherPanel();if(action==='permission')f.context.canReadInbox=false;
    await f.tick();assert.equal(f.timers.size,0);assert.equal(f.calls.length,2);assert.equal(f.writes().length,1);assert.ok(!f.calls.some(call=>call.init.method==='DELETE'));if(action==='substitute')assert.equal(f.html,'<p>Outro painel</p>');
  }
});
test('close enfileirado de outro painel ou importador anterior não aborta novo diálogo aberto',async() => {
  const reply=deferred(),f=fixture({queuedClose:true,intercept:()=>reply.promise});f.otherPanel();f.modal.close();const opening=f.ui.open(selection);f.flushClose();assert.equal(f.calls[0].init.signal.aborted,false);reply.resolve(status());await opening;
  f.modal.close();await f.ui.open(selection);f.flushClose();assert.equal(f.modal.open,true);assert.ok(f.html.includes('Pronto para buscar'));f.ui.reset();
});
test('close nativo real aborta GET mas não fecha painel substituto nem envia cancelamento',async() => {
  const reply=deferred(),f=fixture({queuedClose:true,intercept:()=>reply.promise}),opening=f.ui.open(selection);f.modal.close();f.flushClose();assert.equal(f.calls[0].init.signal.aborted,true);
  f.otherPanel();reply.resolve(status());await opening;assert.equal(f.modal.open,true);assert.equal(f.html,'<p>Outro painel</p>');assert.equal(f.writes().length,0);
});
test('syncContext ignora render inofensivo e fecha apenas painel próprio após troca de identidade',async() => {
  const f=fixture();await f.ui.open(selection);f.context.renderEpoch=3;assert.equal(f.ui.syncContext(),true);assert.equal(f.modal.open,true);
  f.context.session={};assert.equal(f.ui.syncContext(),false);assert.equal(f.modal.open,false);f.otherPanel();f.ui.reset();assert.equal(f.modal.open,true);
});

for(const [label,mutate] of [
  ['tenant divergente',r=>r.tenantId='other'],['conversa divergente',r=>r.conversationId='other'],['conexão divergente',r=>r.channelId='other'],['revisão inválida',r=>r.version=0],['âncora presumida',r=>r.anchor.available='yes'],['estado desconhecido',r=>r.state='success'],['need_anchor contraditório',r=>r.state='need_anchor'],['job ausente',r=>r.state='pending'],['estado e job divergentes',r=>{r.state='pending';r.job=job('completed');}],['contador negativo',r=>{r.state='pending';r.job=job('pending',{counters:{imported:-1,duplicates:0,excluded:0,requested:50}});}],['contagem excedente',r=>{r.state='pending';r.job=job('pending',{counters:{imported:40,duplicates:20,excluded:0,requested:50}});}],['contador solicitado excedente',r=>{r.state='pending';r.job=job('pending',{counters:{imported:0,duplicates:0,excluded:0,requested:51}});}],['limite arbitrário',r=>{r.state='pending';r.job=job('pending',{requestedLimit:75});}],['commandId inválido',r=>{r.state='pending';r.job=job('pending',{commandId:'unsafe'});}],['data impossível',r=>{r.state='pending';r.job=job('pending',{createdAt:'2026-02-30T00:00:00Z'});}],['data anterior',r=>{r.state='pending';r.job=job('pending',{updatedAt:'2026-10-04T00:00:00Z'});}]
]) test(`DTO recusa ${label} sem contagem parcial ou pedido`,async() => {const f=fixture();const value=status();mutate(value);f.setSource(value);assert.equal(await f.ui.open(selection),false);assert.ok(f.html.includes('dados consistentes'));assert.ok(!f.html.includes('data-history-import-metric'));assert.equal(f.writes().length,0);assert.equal(f.timers.size,0);});
test('revisão, counters ou estado final não retrocedem em leitura tardia',async() => {
  for(const mutation of [r=>r.version=1,r=>r.job.counters.imported=1,r=>r.job.updatedAt='2026-10-05T07:00:10Z',r=>{r.state='pending';r.job.state='pending';}]){
    const f=fixture();f.setSource(withJob('completed',{counters:{imported:3,duplicates:0,excluded:0,requested:50}}));await f.ui.open(selection);const before=f.html,value=structuredClone(f.source());mutation(value);f.setSource(value);assert.equal(await f.action('refresh'),false);assert.ok(f.html.includes('dados consistentes'));assert.ok(f.html.includes('data-history-import-metric="imported">3'));assert.equal(f.finished.length,1);assert.notEqual(f.html,before);
  }
});
test('job alheio não reconcilia POST incerto nem libera outro POST',async() => {
  const f=fixture({intercept:(_path,init,fallback)=>{if(init.method==='POST')throw new TypeError('lost');return fallback();}});await f.ui.open(selection);await f.action('start');f.setSource(withJob('completed',{commandId:'22222222-2222-4222-8222-222222222222'}));await f.action('refresh');
  assert.equal(f.finished.length,0);assert.equal(await f.action('start'),false);assert.equal(f.writes().length,1);assert.ok(!f.html.includes('Busca concluída'));
});
test('409 rejeitado exige nova leitura e próxima versão antes de outro pedido explícito',async() => {
  let reject=true;const f=fixture({intercept:(_path,init,fallback)=>{if(init.method==='POST'&&reject){reject=false;throw Object.assign(new Error('private'),{status:409});}return fallback();}});await f.ui.open(selection);await f.action('start');assert.equal(await f.action('start'),false);f.setSource(status({version:3}));await f.action('refresh');await f.action('start');
  assert.equal(f.writes().length,2);assert.equal(JSON.parse(f.writes()[1].init.body).version,3);f.ui.reset();
});
test('403 fecha somente painel próprio e não expõe erro privado',async() => {
  const f=fixture({intercept:()=>{throw Object.assign(new Error('raw key/private history'),{status:403});}});await f.ui.open(selection);assert.equal(f.modal.open,false);assert.equal(f.notices.length,1);assert.ok(!f.notices[0].message.includes('private'));assert.equal(f.timers.size,0);
});
test('título escapa HTML e campos privados extras do DTO não entram no DOM/callback',async() => {
  const f=fixture();f.setSource({...withJob('completed'),cursor:'PRIVATE-CURSOR',token:'PRIVATE-TOKEN',job:{...job('completed'),providerId:'PRIVATE-PROVIDER'}});await f.ui.open({...selection,title:'Grupo <img src=x onerror=1>'});
  assert.ok(f.html.includes('&lt;img'));for(const secret of ['<img','PRIVATE-CURSOR','PRIVATE-TOKEN','PRIVATE-PROVIDER'])assert.ok(!f.html.includes(secret));assert.equal(f.finished[0].providerId,undefined);
});
test('inputs inválidos, ação desconectada e token de outro painel nunca iniciam busca',async() => {
  const f=fixture();assert.equal(await f.ui.open({...selection,channelId:''}),false);await f.ui.open(selection);
  for(const limit of ['0','-50','75','200.0',' 100','999999999999999999'])assert.equal(await f.action('limit',{groupHistoryImportLimit:limit}),false);
  const node=f.button('start');node.isConnected=false;assert.equal(await f.ui.handleAction(node),false);node.isConnected=true;node.dataset.groupHistoryImportToken='other';assert.equal(await f.ui.handleAction(node),false);assert.equal(f.writes().length,0);
});
test('falha de UUID não cria pedido e erro do callback não refaz importação concluída',async() => {
  const f=fixture({newCommandId:()=> 'invalid'});await f.ui.open(selection);assert.equal(await f.action('start'),false);assert.equal(f.writes().length,0);
  const g=fixture({onFinished:()=>{throw new Error('callback');}});g.setSource(withJob('completed'));assert.equal(await g.ui.open(selection),true);assert.ok(g.html.includes('Busca concluída'));await g.action('refresh');assert.equal(g.finished.length,1);assert.equal(g.notices.length,1);
});
test('callback assíncrono não gera rejeição sem tratamento nem aviso depois de contexto perdido',async() => {
  const completion=deferred(),f=fixture({onFinished:()=>completion.promise});f.setSource(withJob('completed'));await f.ui.open(selection);f.context.userId='other';completion.reject(new Error('callback-private'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.notices.length,0);assert.equal(f.modal.open,false);assert.equal(f.html,'');assert.equal(f.writes().length,0);
});
test('fechamento e permissão perdida limpam contagens próprias sem limpar outro painel',async() => {
  const f=fixture();f.setSource(withJob('completed',{counters:{imported:5,duplicates:0,excluded:0,requested:50}}));await f.ui.open(selection);assert.ok(f.html.includes('data-history-import-metric'));
  f.context.canManageChannels=false;f.ui.syncContext();assert.equal(f.html,'');assert.equal(f.modal.open,false);f.otherPanel();f.ui.reset();assert.equal(f.html,'<p>Outro painel</p>');
});
test('refresh conserva foco após loading e não rouba foco de outro controle',async t => {
  const doc={body:{},activeElement:null};doc.activeElement=doc.body;const prior=globalThis.document;globalThis.document=doc;t.after(()=>{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;});
  const reply=deferred();let pause=false;const f=fixture({document:doc,intercept:(_path,_init,fallback)=>pause?reply.promise:fallback()});await f.ui.open(selection);doc.activeElement=f.button('refresh');pause=true;const refreshing=f.action('refresh');assert.equal(doc.activeElement,doc.body);reply.resolve(status());await refreshing;assert.equal(doc.activeElement.dataset.groupHistoryImportAction,'refresh');
  pause=false;doc.activeElement={outside:true};await f.action('refresh');assert.deepEqual(doc.activeElement,{outside:true});
});

test('conversa direta: o mesmo diálogo usa o endereço e os textos da conversa, não do grupo',async() => {
  const f=fixture();assert.equal(await f.ui.open({...selection,kind:'direct'}),true);
  assert.equal(f.calls[0].path,'/api/tenants/tenant-a/conversations/group-a/history-import');
  assert.equal(f.opened[0].title,'Buscar mensagens anteriores');assert.equal(f.opened[0].subtitle,'Busca limitada para esta conversa do WhatsApp');
  await f.action('start');assert.equal(f.writes()[0].path,'/api/tenants/tenant-a/conversations/group-a/history-import');
});
