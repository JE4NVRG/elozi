import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import {excerpt} from './helpers/app-source.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const controllerSource=excerpt('whatsapp-groups-ui');
const openModalSource=excerpt('open-modal');
const channelGroupsSource=excerpt('channel-groups');
const clickSource=excerpt('modal-click');
const submitSource=excerpt('modal-submit');
const initialization=source.split('\n').find(line=>line.startsWith('const whatsappGroupsUI='));assert.ok(initialization);
const resetSource=source.split('\n').find(line=>line.startsWith('function resetWorkspaceSelection('));assert.ok(resetSource);
const deferred=()=>{let resolve,reject;return {promise:new Promise((done,fail)=>{resolve=done;reject=fail;}),resolve:value=>resolve(value),reject:error=>reject(error)};};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decode=value=>value.replace(/&(?:amp|lt|gt|quot|#39);/g,c=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[c]));
const groupA='120363000000001@g.us',groupB='120363000000002@g.us';
const groups=[{id:groupA,name:'Grupo <próprio>',selected:true,announcement:false},{id:groupB,name:'Avisos próprios',selected:false,announcement:true}];
const response=(channelId='channel-a',version=2,list=groups)=>({tenantId:'company-a',channelId,version,groups:list.map(group=>({...group}))});

// Modelo DOM mínimo: os handlers e o controller executados abaixo vêm do app real.
class FormDataAdapter {
  constructor(form){this.values=[...form.fields].map(([name,node])=>[name,node.value]);this.values.push(...form.checkboxes.filter(node=>node.checked&&!node.disabled).map(node=>['groupId',node.value]));}
  get(name){return this.values.find(entry=>entry[0]===name)?.[1]??null;}
  getAll(name){return this.values.filter(entry=>entry[0]===name).map(entry=>entry[1]);}
  [Symbol.iterator](){return this.values[Symbol.iterator]();}
}
function fixture({api}={}){
  const listeners=new Map(),calls=[],notices=[],renders=[];
  let groupWorkspaceResets=0;
  const state={workspaceId:'workspace-a',view:'channels',busy:false,inboxSelectionSequence:0,
    tenant:{id:'company-a',resellerId:'workspace-a',channels:[{id:'channel-a',kind:'whatsapp_qr',transport:'baileys',state:'connected',enabledGroups:1,whatsappGroupsVersion:2},{id:'channel-b',kind:'whatsapp_qr',transport:'baileys',state:'connected',enabledGroups:0,whatsappGroupsVersion:0}]},
    boot:{csrfToken:'synthetic-csrf',session:{userId:'person-a',resellerId:'workspace-a',role:'reseller',permissions:['channels.write'],scopeRules:null},tenants:[{id:'company-a'},{id:'company-b'}],workspaces:[{id:'workspace-a'}]}};
  let form=null,panel=null,markup='';
  function parseCheckboxes(html){return [...html.matchAll(/<input\b([^>]*\btype="checkbox"[^>]*)>/g)].map(([,attrs])=>({value:decode(attrs.match(/\bvalue="([^"]*)"/)?.[1]||''),checked:/\bchecked\b/.test(attrs),disabled:/\bdisabled\b/.test(attrs),isConnected:true}));}
  function mount(html){
    if(form){form.isConnected=false;form.submit.isConnected=false;for(const node of form.checkboxes)node.isConnected=false;}
    if(panel)panel.isConnected=false;
    markup=html;modal.firstElementChild={markup:html};form=null;panel=null;
    const formType=html.match(/<form\b[^>]*data-dialog-form="([^"]+)"/)?.[1];
    if(formType){
      const fields=new Map();for(const [,attrs] of html.matchAll(/<input\b([^>]*)>/g)){if(/\btype="checkbox"/.test(attrs))continue;const name=attrs.match(/\bname="([^"]+)"/)?.[1];if(name)fields.set(name,{value:decode(attrs.match(/\bvalue="([^"]*)"/)?.[1]||'')});}
      const picker={};let pickerMarkup=html.match(/<div class="group-picker">([\s\S]*?)<\/div>/)?.[1]||'';
      form={dataset:{dialogForm:formType},fields,isConnected:true,submit:{disabled:false,isConnected:true},error:{textContent:''},versionLabel:{textContent:''},checkboxes:parseCheckboxes(pickerMarkup),
        matches:selector=>selector===`[data-dialog-form="${formType}"]`,querySelectorAll(selector){return selector==='input[type="checkbox"]'?this.checkboxes:[];},querySelector(selector){return selector==='[type="submit"]'?this.submit:selector==='.form-error'?this.error:selector==='.group-picker'?picker:selector==='[data-whatsapp-groups-version]'?this.versionLabel:this.fields.get(selector.match(/^\[name="([^"]+)"\]$/)?.[1])||null;}};
      const ownForm=form;Object.defineProperty(picker,'innerHTML',{get:()=>pickerMarkup,set:html=>{pickerMarkup=html;ownForm.checkboxes=parseCheckboxes(html);}});
    }
    if(html.includes('data-whatsapp-groups-panel')){
      const button={dataset:{whatsappGroupsAction:'refresh',whatsappGroupsTicket:html.match(/data-whatsapp-groups-ticket="([^"]+)"/)?.[1]},isConnected:true,closest:selector=>selector==='[data-whatsapp-groups-action]'?button:null};
      panel={isConnected:true,button,error:form?.error||{textContent:''},contains:node=>node===button||node===form,querySelector:selector=>selector==='.form-error'?panel.error:null};
    }
  }
  const modal={open:false,firstElementChild:null,closeCount:0,showCount:0,
    get innerHTML(){return markup;},set innerHTML(value){mount(value);},
    showModal(){this.open=true;this.showCount++;},close(){this.open=false;this.closeCount++;for(const fn of listeners.get('close')||[])fn();},
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);},
    querySelector:selector=>selector==='[data-whatsapp-groups-panel]'?panel:selector==='[data-dialog-form="groups"]'&&form?.dataset.dialogForm==='groups'?form:null};
  const stub=new Proxy({},{get:()=>()=>{}});
  const context={...i18n,state,inboxReadAttempts:new Map(),$:selector=>selector==='#modal'?modal:null,escape,icon:()=>'',toast:(message,error)=>notices.push({message,error}),render:()=>renders.push(state.tenant.id),AbortController,FormData:FormDataAdapter,clearTimeout:()=>{},
    api:async(path,options)=>{calls.push({path,options});return api?api(path,options,{state,modal,calls}):options.method==='POST'?{tenantId:state.tenant.id,channelId:form.fields.get('channelId').value,version:JSON.parse(options.body).version+1,enabledGroups:JSON.parse(options.body).groupIds.length}:response();}};
  for(const name of ['brandDrafts', 'contactLinksUI','contactRefresh','memoryUI','telegramGroupsUI','channelConnectorsUI','workspaceDomainsUI','plansUI','accountsUI','unitsUI','accountInvitationsUI','supportUI','servicePrincipalsUI','serviceHandoffsUI','customerContextUI','billingUI','subscriptionUI','accountSecurityUI','teamChatUI','workspaceUI','consolidatedInbox','contactImportUI','platformUsersUI','commercialUsageUI','groupsWorkspaceUI','conversationTools','noteDrafts','forwarding','participantsUI','chatLayout','repliesUI','voiceRecorder','inboxTimeline','mediaUI','automationUI','avatarUI','mcpUI','knowledgeUI'])context[name]=stub;
  context.groupsWorkspaceUI={reset(){groupWorkspaceResets++;}};context.resetScreens=()=>{};
  const real=runInNewContext([controllerSource,openModalSource,channelGroupsSource,initialization,clickSource,submitSource,resetSource,'({channelGroups,openModal,resetWorkspaceSelection,whatsappGroupsUI})'].join('\n'),context);
  return {state,calls,notices,renders,modal,...real,get form(){return form;},get panel(){return panel;},get markup(){return markup;},get groupWorkspaceResets(){return groupWorkspaceResets;},
    submit:async(target=form)=>{let prevented=0;for(const handler of listeners.get('submit')||[])await handler({target,preventDefault(){prevented++;}});assert.equal(prevented,1);},
    refresh:async()=>{for(const handler of listeners.get('click')||[])await handler({target:panel.button});}};
}

test('GET real monta revisão, seleção e avisos escapados do canal; POST captura realm e revisão',async()=>{
  const f=fixture();await f.channelGroups('channel-a');assert.match(f.markup,/Grupo &lt;próprio&gt;/);assert.doesNotMatch(f.markup,/<próprio>/);assert.match(f.markup,/Somente administradores/);
  assert.equal(f.form.fields.get('version').value,'2');assert.deepEqual(f.form.checkboxes.filter(node=>node.checked).map(node=>node.value),[groupA]);
  f.form.checkboxes[1].checked=true;await f.submit();
  assert.equal(f.calls[0].path,'/api/tenants/company-a/channels/channel-a/groups');assert.equal(f.calls[0].options.method,'GET');
  assert.equal(f.calls[1].path,f.calls[0].path);assert.deepEqual(JSON.parse(f.calls[1].options.body),{version:2,groupIds:[groupA,groupB]});
  assert.deepEqual({...f.calls[1].options.headers},{'X-Elozi-Workspace':'workspace-a','X-CSRF-Token':'synthetic-csrf'});
  assert.equal(f.state.tenant.channels[0].enabledGroups,2);assert.equal(f.state.tenant.channels[0].whatsappGroupsVersion,3);assert.equal(f.modal.closeCount,1);assert.equal(f.renders.length,1);assert.match(f.notices[0].message,/atualizados/);
});

test('lista vazia e revisão zero salvam bloqueio de grupos sem campo inferido',async()=>{
  const f=fixture({api:async(_path,options)=>options.method==='GET'?response('channel-a',0,[]):{tenantId:'company-a',channelId:'channel-a',version:1,enabledGroups:0}});
  await f.channelGroups('channel-a');assert.match(f.markup,/ainda não participa/);await f.submit();assert.deepEqual(JSON.parse(f.calls[1].options.body),{version:0,groupIds:[]});assert.equal(f.state.tenant.channels[0].enabledGroups,0);
});

const changes={workspace:f=>{f.state.workspaceId='workspace-b';},tenant:f=>{f.state.tenant={...f.state.tenant,id:'company-b'};},user:f=>{f.state.boot.session.userId='person-b';},csrf:f=>{f.state.boot.csrfToken='new-csrf';},role:f=>{f.state.boot.session.role='operator';},permissions:f=>{f.state.boot.session.permissions=[];},scope:f=>{f.state.boot.session.scopeRules={channels:[]};},support:f=>{f.state.supportGrantId='support-new';},sessionSupport:f=>{f.state.boot.session.supportGrantId='support-new';},service:f=>{f.state.boot.session.kind='service';},disconnected:f=>{f.state.tenant.channels[0].state='disconnected';},transport:f=>{f.state.tenant.channels[0].transport='demo';},kind:f=>{f.state.tenant.channels[0].kind='telegram';},removed:f=>{f.state.tenant.channels=[];},owner:f=>{f.state.tenant.resellerId='workspace-b';},binding:f=>{f.state.boot.tenants=[];},route:f=>{f.state.view='contacts';}};
for(const [name,change] of Object.entries(changes))test(`GET atrasado após ${name} não substitui conteúdo nem permite POST`,async()=>{
  const wait=deferred(),f=fixture({api:()=>wait.promise}),pending=f.channelGroups('channel-a');const content=f.modal.firstElementChild;change(f);wait.resolve(response());await pending;
  assert.equal(f.modal.firstElementChild,content);assert.equal(f.form,null);assert.equal(f.calls.length,1);assert.equal(f.renders.length,0);
});

for(const [name,change] of Object.entries(changes))test(`formulário de grupos obsoleto por ${name} não envia nem fecha novo contexto`,async()=>{
  const f=fixture();await f.channelGroups('channel-a');const form=f.form;form.checkboxes[1].checked=true;change(f);await f.submit(form);
  assert.equal(f.calls.length,1);assert.equal(f.modal.closeCount,0);assert.equal(f.renders.length,0);assert.equal(form.checkboxes[1].checked,true);
});

test('novo pedido de outro canal vence GET anterior mesmo quando ele responde por último',async()=>{
  const first=deferred(),second=deferred();let reads=0;const f=fixture({api:()=>++reads===1?first.promise:second.promise});
  const a=f.channelGroups('channel-a'),b=f.channelGroups('channel-b');second.resolve(response('channel-b',8,[{...groups[1],selected:true}]));await b;const form=f.form;
  first.resolve(response());await a;assert.equal(f.form,form);assert.equal(form.fields.get('channelId').value,'channel-b');assert.equal(form.fields.get('version').value,'8');assert.equal(f.calls[0].options.signal.aborted,true);
});

for(const change of ['other-modal','closed','reset'])test(`GET pendente respeita ${change} e conserva editor novo`,async()=>{
  const wait=deferred(),f=fixture({api:()=>wait.promise}),pending=f.channelGroups('channel-a');
  if(change==='other-modal')f.openModal('Perfil próprio','','<form data-dialog-form="other"><input name="name" value="Rascunho"/></form>');
  if(change==='closed')f.modal.close();if(change==='reset')f.resetWorkspaceSelection();const content=f.modal.firstElementChild;
  if(change==='reset')assert.equal(f.groupWorkspaceResets,1);
  if(f.form)f.form.fields.get('name').value='Nome digitado';wait.resolve(response());await pending;
  assert.equal(f.modal.firstElementChild,content);assert.equal(f.modal.showCount,change==='other-modal'?2:1);assert.equal(f.calls.length,1);if(f.form)assert.equal(f.form.fields.get('name').value,'Nome digitado');
});

for(const [name,bad] of [
  ['tenant',()=>({...response(),tenantId:'company-b'})],['channel',()=>response('channel-b')],['old-array',()=>groups],['negative',()=>response('channel-a',-1)],['fraction',()=>response('channel-a',0.5)],['unsafe',()=>response('channel-a',Number.MAX_SAFE_INTEGER)],
  ['duplicate',()=>response('channel-a',2,[groups[0],groups[0]])],['jid',()=>response('channel-a',2,[{...groups[0],id:'person@s.whatsapp.net'}])],['selection',()=>response('channel-a',2,[{...groups[0],selected:'true'}])]
])test(`DTO ${name} não cria seleção nem admite POST`,async()=>{
  const f=fixture({api:async()=>bad()});await f.channelGroups('channel-a');assert.equal(f.form,null);assert.match(f.panel.error.textContent,/não confirmou/);assert.equal(f.renders.length,0);
});

for(const tamper of ['channel','version','unknown-group','duplicate-group','limit'])test(`handler recusa ${tamper}, mantém draft e não usa IDs adulterados`,async()=>{
  const f=fixture();await f.channelGroups('channel-a');const form=f.form;
  if(tamper==='channel')form.fields.get('channelId').value='channel-b';if(tamper==='version')form.fields.get('version').value='9';
  if(tamper==='unknown-group')form.checkboxes.push({value:'120363999999999@g.us',checked:true});if(tamper==='duplicate-group')form.checkboxes.push({...form.checkboxes[0]});if(tamper==='limit')form.checkboxes=Array.from({length:101},(_,i)=>({value:`${100000000000000+i}@g.us`,checked:true}));
  await f.submit(form);assert.equal(f.calls.length,1);assert.equal(f.form,form);assert.match(form.error.textContent,/Confira o canal/);assert.equal(f.modal.closeCount,0);
});

for(const change of ['new-editor','new-groups','closed','reset','workspace','support','csrf'])test(`POST tardio após ${change} não fecha, renderiza ou avisa sobre contexto novo`,async()=>{
  const wait=deferred(),f=fixture({api:async(_path,options)=>options.method==='GET'?response():wait.promise});await f.channelGroups('channel-a');const submitted=f.form,pending=f.submit(submitted);
  if(change==='new-editor')f.openModal('Perfil','','<form data-dialog-form="other"><input name="name" value="Nome original"/></form>');
  if(change==='new-groups')await f.channelGroups('channel-a');if(change==='closed')f.modal.close();if(change==='reset')f.resetWorkspaceSelection();if(changes[change])changes[change](f);
  if(change==='reset')assert.equal(f.groupWorkspaceResets,1);
  const content=f.modal.firstElementChild,form=f.form,closeCount=f.modal.closeCount;if(form?.fields.has('name'))form.fields.get('name').value='Não salvo';
  wait.resolve({tenantId:'company-a',channelId:'channel-a',version:3,enabledGroups:1});await pending;
  assert.equal(f.modal.firstElementChild,content);assert.equal(f.form,form);assert.equal(f.modal.closeCount,closeCount);assert.equal(f.renders.length,0);assert.equal(f.notices.length,0);assert.equal(f.state.tenant.channels[0].whatsappGroupsVersion,2);if(form?.fields.has('name'))assert.equal(form.fields.get('name').value,'Não salvo');
});

test('somente um POST fica em voo por formulário e não há GET ou reenvio implícito',async()=>{
  const wait=deferred(),f=fixture({api:async(_path,options)=>options.method==='GET'?response():wait.promise});await f.channelGroups('channel-a');const a=f.submit();await f.submit();await f.refresh();assert.equal(f.calls.length,2);
  assert.ok(f.form.checkboxes.every(node=>node.disabled));
  wait.resolve({tenantId:'company-a',channelId:'channel-a',version:3,enabledGroups:1});await a;assert.equal(f.modal.closeCount,1);assert.equal(f.state.busy,false);
});

test('conflito 409 conserva escolhas, exige revisão explícita e usa a nova versão ao salvar',async()=>{
  let reads=0,writes=0;const f=fixture({api:async(_path,options)=>{if(options.method==='GET')return response('channel-a',++reads===1?2:5);if(++writes===1)throw Object.assign(Error('CAS'),{status:409});return {tenantId:'company-a',channelId:'channel-a',version:6,enabledGroups:1};}});
  await f.channelGroups('channel-a');const form=f.form;form.checkboxes[0].checked=false;form.checkboxes[1].checked=true;await f.submit();
  assert.equal(f.form,form);assert.equal(form.submit.disabled,true);assert.match(form.error.textContent,/rascunho foi mantido/);assert.equal(f.calls.length,2);await f.submit();assert.equal(f.calls.length,2);
  assert.ok(form.checkboxes.every(node=>!node.disabled));
  await f.refresh();assert.equal(f.form,form);assert.deepEqual(form.checkboxes.filter(node=>node.checked).map(node=>node.value),[groupB]);assert.equal(form.fields.get('version').value,'5');assert.equal(form.submit.disabled,false);assert.equal(f.calls.length,3);
  await f.submit();assert.deepEqual(JSON.parse(f.calls[3].options.body),{version:5,groupIds:[groupB]});assert.equal(f.modal.closeCount,1);
});

test('grupo removido na revisão permanece no rascunho para desmarcar e não pode ser salvo',async()=>{
  let reads=0;const f=fixture({api:async(_path,options)=>options.method==='GET'?response('channel-a',++reads===1?2:3,reads===1?groups:[groups[1]]):assert.fail('Não salvar grupo removido')});
  await f.channelGroups('channel-a');const form=f.form;await f.refresh();assert.equal(f.form,form);assert.equal(form.checkboxes.find(node=>node.value===groupA).checked,true);await f.submit();assert.equal(f.calls.length,2);assert.match(form.error.textContent,/grupos conhecidos/);
});

for(const mismatch of ['tenant','channel','version','count'])test(`recibo POST com ${mismatch} incorreto mantém seleção e exige consulta`,async()=>{
  const result={tenantId:'company-a',channelId:'channel-a',version:3,enabledGroups:1};if(mismatch==='tenant')result.tenantId='other';if(mismatch==='channel')result.channelId='other';if(mismatch==='version')result.version=4;if(mismatch==='count')result.enabledGroups=2;
  const f=fixture({api:async(_path,options)=>options.method==='GET'?response():result});await f.channelGroups('channel-a');const form=f.form;await f.submit();assert.equal(f.form,form);assert.equal(f.modal.closeCount,0);assert.equal(f.renders.length,0);assert.equal(form.submit.disabled,true);assert.match(form.error.textContent,/não confirmou/);assert.equal(f.notices.length,0);
});

test('falha de POST antigo não injeta erro no editor novo',async()=>{
  const wait=deferred(),f=fixture({api:async(_path,options)=>options.method==='GET'?response():wait.promise});await f.channelGroups('channel-a');const pending=f.submit();f.openModal('Outro','','<form data-dialog-form="other"><input name="name" value="Próprio"/></form>');const form=f.form;wait.reject(Object.assign(Error('Conflito antigo'),{status:409}));await pending;assert.equal(f.form,form);assert.equal(form.error.textContent,'');assert.equal(f.notices.length,0);
});

test('perfil atualizado durante GET é permitido; autoridade e identidade não dependem do nome',async()=>{
  const wait=deferred(),f=fixture({api:()=>wait.promise}),pending=f.channelGroups('channel-a');f.state.boot.session.name='Nome atualizado';f.state.boot.session.avatar={url:'own'};wait.resolve(response());await pending;assert.equal(f.form.fields.get('channelId').value,'channel-a');
});

test('outra operação busy não envia nem libera trava global, conserva editor',async()=>{
  const f=fixture();await f.channelGroups('channel-a');f.state.busy=true;await f.submit();assert.equal(f.calls.length,1);assert.equal(f.state.busy,true);assert.match(f.form.error.textContent,/Aguarde/);
});

for(const name of ['role','support','sessionSupport','service','owner','binding','disconnected','transport','kind','removed'])test(`abertura inicial sem ${name} autorizado não consulta grupos`,async()=>{
  const f=fixture();changes[name](f);await f.channelGroups('channel-a');assert.equal(f.calls.length,0);assert.equal(f.modal.open,false);assert.equal(f.form,null);assert.match(f.notices[0].message,/administrador/);
});
