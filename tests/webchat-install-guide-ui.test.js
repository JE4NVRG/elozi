import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelConnectorsUI } from '../public/channel-connectors-ui.js';
import { setLocale } from '../public/i18n.js';

const decode=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const attr=(markup,name)=>decode(new RegExp(`${name}="([^"]*)"`).exec(markup)?.[1]||'');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const snippet='<script type="module" src="https://elozi.example/widget.js" data-tenant-id="company-a" data-channel-id="channel-a"></script>';

function fixture(t,{intercept,onUpdate,onOpen,onTestJourney}={}) {
  const originalFormData=globalThis.FormData,originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  globalThis.FormData=class {constructor(form){this.values=form.elements;}get(name){const field=this.values.find(item=>item.name===name&&(item.type!=='radio'||item.checked));return !field||field.type==='checkbox'&&!field.checked?null:field.value;}};
  const copied=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(text){copied.push(text);}}}});
  t.after(()=>{globalThis.FormData=originalFormData;if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;setLocale('pt-BR',{persist:false,notify:false});});
  const channel={id:'channel-a',kind:'webchat'}, state={view:'channels',workspaceId:'workspace-a',tenant:{id:'company-a',resellerId:'workspace-a',name:'Empresa QA',channels:[channel]},boot:{publicOrigin:'https://elozi.example',session:{userId:'person-a',resellerId:'workspace-a',role:'reseller'},workspaces:[{id:'workspace-a'}],tenants:[{id:'company-a'}]}};
  let configuration={kind:'webchat',channelId:channel.id,tenantId:state.tenant.id,version:1,enabled:true,state:'connected',origins:['https://site.example'],install:{scriptUrl:'https://elozi.example/widget.js',embedSnippet:snippet}};
  let appearance={version:2,tenantId:state.tenant.id,channelId:channel.id,widget:{displayName:'Marca QA',openButtonLabel:'Abrir conversa',avatarUrl:'',logoUrl:'',radius:16,theme:'light',colors:{},lightColors:{},credit:{visible:true,text:'Elozi'},greeting:{'pt-BR':'Olá','en':'Hello'},verifiedGreeting:{'pt-BR':'Olá {firstName}','en':'Hi {firstName}'},handoffMessage:{'pt-BR':'A equipe continua aqui','en':'The team continues here'},emailPrompt:true,attachmentsEnabled:false,voiceEnabled:false,feedbackEnabled:true,handoffNotificationEmail:'qa@example.test',assistantInstructions:'Orientação privada sintética.'}};
  const calls=[],toasts=[],updates=[],tests=[],opened=[],focuses=[];let closeListener;
  const modal={open:false,markup:'',panel:null,form:null,addEventListener(name,listener){if(name==='close')closeListener=listener;},close(){this.open=false;closeListener?.();},querySelector(selector){return selector==='[data-connector-panel]'?this.panel:null;}};
  function parse(markup){
    const formMatch=/<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(markup),elements=[];
    if(formMatch){
      for(const match of formMatch[2].matchAll(/<input\b([^>]*)>/g))if(attr(match[1],'name'))elements.push({name:attr(match[1],'name'),type:attr(match[1],'type')||'text',value:attr(match[1],'value'),checked:/\bchecked\b/.test(match[1])});
      for(const match of formMatch[2].matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g))if(attr(match[1],'name'))elements.push({name:attr(match[1],'name'),type:'textarea',value:decode(match[2]),checked:false});
    }
    const token=attr(markup,'data-connector-token'),feedback={textContent:decode(/class="form-error"[^>]*>([^<]*)<\//.exec(markup)?.[1]||'')},copyStatus={textContent:''},current={innerHTML:''},submit={disabled:false};
    modal.form=formMatch?{dataset:{connectorForm:attr(formMatch[1],'data-connector-form'),connectorToken:attr(formMatch[1],'data-connector-token')},elements,feedback,copyStatus,submit,set(name,value){const field=elements.find(item=>item.name===name);assert.ok(field,`fixture field ${name}`);if(['checkbox','radio'].includes(field.type))field.checked=value;else field.value=value;},get(name){return elements.find(item=>item.name===name)?.value;}}:null;
    const heading=/data-webchat-guide-heading/.test(markup)?{focus(options){focuses.push({token,options,step:attr(markup,'data-webchat-install-step')});}}:null;
    modal.panel={dataset:{connectorToken:token},feedback,copyStatus,querySelector(selector){return selector==='.form-error'?feedback:selector==='[data-webchat-copy-status]'?copyStatus:selector==='[data-connector-server-current]'?current:selector==='form[data-connector-form]'?modal.form:selector==='[data-webchat-guide-heading]'?heading:null;},querySelectorAll(selector){return selector==='[type="submit"]'?(modal.form?[submit]:[]):selector==='input[type="password"]'?elements.filter(item=>item.type==='password'):[];}};
  }
  const fallback=(path,init)=>{
    if(path.endsWith('/widget-configuration')){if(init.method==='GET')return structuredClone(appearance);const body=JSON.parse(init.body);assert.equal(body.version,appearance.version);appearance={...appearance,version:appearance.version+1,widget:body.widget};return structuredClone(appearance);}
    if(init.method==='GET')return structuredClone(configuration);
    const body=JSON.parse(init.body);assert.equal(body.version,configuration.version);configuration={...configuration,...body,version:configuration.version+1,state:body.enabled?'connected':'disconnected'};return structuredClone(configuration);
  };
  const ui=createChannelConnectorsUI({state,api:async(path,init)=>{calls.push({path,init});return intercept?intercept(path,init,()=>fallback(path,init)):fallback(path,init);},getModal:()=>modal,openModal(title,subtitle,markup){modal.open=true;modal.markup=markup;parse(markup);opened.push({title,subtitle,markup});onOpen?.(modal);},toast:(message,error)=>toasts.push({message,error}),onUpdate:async(value)=>{updates.push(value);await onUpdate?.(value);},onTestJourney:async(target)=>{tests.push({...target,modalOpen:modal.open});await onTestJourney?.(target);}});
  const node=action=>({dataset:{connectorAction:action,connectorToken:modal.panel?.dataset.connectorToken},disabled:false}),action=name=>ui.action(node(name));
  return {ui,state,channel,modal,calls,toasts,updates,tests,opened,focuses,copied,node,action,configuration:()=>configuration,appearance:()=>appearance,setConfiguration(value){configuration={...configuration,...value};},setAppearance(value){appearance={...appearance,...value};}};
}

test('authorization save continues in the same guarded modal to the existing designer; appearance save stays in sequence',async t=>{
  const f=fixture(t);assert.equal(await f.ui.open(f.channel),true);
  assert.match(f.modal.markup,/data-webchat-install-step="authorize"/);
  assert.ok(f.modal.markup.indexOf('Cadastre a origem')<f.modal.markup.indexOf('name="origins"'));
  f.modal.form.set('origins','https://published.example');await f.ui.submit(f.modal.form);
  assert.equal(f.modal.open,true);assert.match(f.modal.markup,/data-webchat-install-step="appearance"/);assert.match(f.modal.markup,/data-widget-designer/);
  assert.deepEqual(f.calls.map(call=>[call.init.method,call.path.split('/').at(-1)]),[['GET','configuration'],['POST','configuration'],['GET','widget-configuration']]);
  f.modal.form.set('displayName','Marca atualizada');await f.ui.submit(f.modal.form);
  assert.match(f.modal.markup,/data-webchat-install-step="appearance"/);assert.equal(f.modal.form.get('displayName'),'Marca atualizada');
  assert.equal(f.appearance().widget.assistantInstructions,'Orientação privada sintética.');
  await f.action('webchat-step-install');assert.match(f.modal.markup,/data-webchat-install-step="install"/);
  assert.match(f.modal.markup,/&lt;script type=&quot;module&quot;/);assert.doesNotMatch(f.modal.markup,/Orientação privada sintética/);
});

test('disabled channel save stays at authorization and does not fetch or require appearance',async t=>{
  const f=fixture(t);await f.ui.open(f.channel);f.modal.form.set('enabled',false);await f.ui.submit(f.modal.form);
  assert.equal(f.modal.open,true);assert.match(f.modal.markup,/data-webchat-install-step="authorize"/);assert.equal(f.calls.length,2);
  assert.match(f.modal.markup,/Confira e salve a origem/);
});

test('direct appearance and standalone personalization remain available without any enabled origin',async t=>{
  for(const standalone of [false,true]){
    const f=fixture(t);f.setConfiguration({enabled:false,origins:[]});
    assert.equal(await (standalone?f.ui.openWidget(f.channel):f.ui.open(f.channel,{step:'appearance'})),true);
    assert.match(f.modal.markup,/data-widget-designer/);
    assert.equal(f.modal.markup.includes('data-webchat-install-guide'),!standalone);
    assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
  }
});

test('drafts survive appearance/back/installation and preserve malformed unsaved fields and private channel instructions',async t=>{
  const f=fixture(t);await f.ui.open(f.channel);f.modal.form.set('origins','https://draft.example/path');
  await f.action('webchat-step-appearance');f.modal.form.set('colors-primary','#12');f.modal.form.set('assistantInstructions','Rascunho privado\ncom duas linhas.');
  const stale=f.modal.form;await f.action('back-configuration');assert.equal(f.modal.form.get('origins'),'https://draft.example/path');
  await f.action('webchat-step-install');assert.doesNotMatch(f.modal.markup,/Rascunho privado|https:\/\/draft.example/);assert.match(f.modal.markup,/Seu rascunho está preservado/);
  await f.action('webchat-step-appearance');assert.equal(f.modal.form.get('colors-primary'),'#12');assert.equal(f.modal.form.get('assistantInstructions'),'Rascunho privado\ncom duas linhas.');
  await assert.rejects(f.ui.submit(stale),/Abra a configuração/);
  await assert.rejects(f.ui.submit(f.modal.form),/cores hexadecimais/);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
});

test('refresh keeps current drafts while reconciling server revision; unchanged forms do not invent unsaved changes',async t=>{
  const f=fixture(t);await f.ui.open(f.channel);await f.action('webchat-step-install');assert.doesNotMatch(f.modal.markup,/Seu rascunho está preservado/);
  await f.action('webchat-step-authorize');f.modal.form.set('origins','https://draft.example');f.setConfiguration({version:7,origins:['https://current.example']});
  await f.action('refresh');assert.equal(f.modal.form.get('origins'),'https://draft.example');assert.match(f.modal.markup,/<dd>7<\/dd>/);
  await f.action('webchat-step-appearance');f.modal.form.set('displayName','Rascunho visual');f.setAppearance({version:9});await f.action('admin-refresh');
  assert.equal(f.modal.form.get('displayName'),'Rascunho visual');await f.ui.submit(f.modal.form);assert.equal(f.appearance().version,10);
});

test('copied code remains canonical and copying never posts configuration or marks install/test complete',async t=>{
  const f=fixture(t);await f.ui.open(f.channel,{step:'install'});assert.equal(f.modal.form,null);
  await f.action('copy-webchat-code');assert.deepEqual(f.copied,[snippet]);assert.match(f.modal.panel.copyStatus.textContent,/Código copiado/);
  assert.equal(f.calls.length,1);assert.doesNotMatch(f.modal.markup,/data-webchat-step-state="complete"/);assert.equal(f.tests.length,0);
});

test('copy failure provides manual selection guidance without losing installation instructions',async t=>{
  const f=fixture(t);globalThis.navigator.clipboard.writeText=async()=>{throw Error('denied');};await f.ui.open(f.channel,{step:'install'});
  await f.action('copy-webchat-code');assert.match(f.modal.panel.copyStatus.textContent,/Selecione o código acima/);assert.match(f.modal.markup,/data-webchat-install-step="install"/);assert.equal(f.calls.length,1);
});

test('copy pending across another step or authority change does not touch the new panel or publish success',async t=>{
  for(const change of ['step','scope']){
    const f=fixture(t),pending=deferred();globalThis.navigator.clipboard.writeText=()=>pending.promise;await f.ui.open(f.channel,{step:'install'});
    const copying=f.action('copy-webchat-code');if(change==='step')await f.action('webchat-step-validate');else f.state.boot.session.userId='other-person';
    pending.resolve();await copying;assert.equal(f.modal.panel.copyStatus.textContent,'');assert.equal(f.toasts.length,0);assert.equal(f.tests.length,0);
  }
});

test('re-rendered form and button tokens are invalidated even within the same channel and scope',async t=>{
  const f=fixture(t);await f.ui.open(f.channel);const form=f.modal.form,oldButton=f.node('webchat-step-install');
  await f.action('webchat-step-appearance');await f.ui.action(oldButton);assert.match(f.modal.markup,/data-webchat-install-step="appearance"/);
  await assert.rejects(f.ui.submit(form),/Abra a configuração/);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
});

test('late appearance GET after scope change cannot display private fields, focus a new modal or update state',async t=>{
  const pending=deferred(),f=fixture(t,{intercept:(path,init,fallback)=>path.endsWith('/widget-configuration')?pending.promise:fallback()});
  await f.ui.open(f.channel);const reading=f.action('webchat-step-appearance'),focusCount=f.focuses.length;
  f.state.tenant.id='company-b';pending.resolve(f.appearance());await reading;
  assert.equal(f.modal.open,false);assert.equal(f.focuses.length,focusCount);assert.doesNotMatch(f.modal.markup,/Orientação privada sintética/);assert.equal(f.updates.length,0);
});

test('late appearance or configuration GET cannot replace a different step in the same channel',async t=>{
  for(const query of ['widget-configuration','configuration']) {
    const pending=deferred();let defer=false;
    const f=fixture(t,{intercept:(path,init,fallback)=>defer&&init.method==='GET'&&path.endsWith('/'+query)?pending.promise:fallback()});
    await f.ui.open(f.channel);defer=true;const reading=f.action(query==='configuration'?'refresh':'webchat-step-appearance');
    await f.action('webchat-step-install');const markup=f.modal.markup,focusCount=f.focuses.length;
    pending.resolve(query==='configuration'?f.configuration():f.appearance());await reading;
    assert.equal(f.modal.markup,markup);assert.equal(f.focuses.length,focusCount);assert.doesNotMatch(f.modal.markup,/Orientação privada sintética/);assert.equal(f.modal.open,true);
  }
});

test('validation CTA closes only the owned modal and passes the current immutable channel identity to the existing test',async t=>{
  const f=fixture(t);await f.ui.open(f.channel,{step:'validate'});await f.action('test-journey');
  assert.deepEqual(f.tests,[{channelId:'channel-a',tenantId:'company-a',workspaceId:'workspace-a',modalOpen:false}]);assert.equal(f.modal.open,false);assert.equal(f.calls.length,1);
  const stale=fixture(t);await stale.ui.open(stale.channel,{step:'validate'});const button=stale.node('test-journey');stale.state.workspaceId='other-workspace';await stale.ui.action(button);assert.equal(stale.tests.length,0);
});

test('server-unready webchat cannot copy or enter channel validation through forged actions',async t=>{
  const f=fixture(t);f.setConfiguration({enabled:false,origins:[]});await f.ui.open(f.channel,{step:'install'});await f.action('copy-webchat-code');assert.equal(f.copied.length,0);
  await f.action('webchat-step-validate');await f.action('test-journey');assert.equal(f.tests.length,0);assert.match(f.modal.markup,/Habilite a origem/);
});

test('CAS conflict and unknown write confirmation keep the same sequence and block navigation until a fresh query',async t=>{
  for(const status of [409,undefined]){
    const f=fixture(t,{intercept:(path,init,fallback)=>{if(init.method==='POST')throw Object.assign(Error('synthetic'),{status});return fallback();}});
    await f.ui.open(f.channel);f.modal.form.set('origins','https://draft.example');await f.ui.submit(f.modal.form);assert.match(f.modal.markup,/data-webchat-install-step="authorize"/);
    await f.action('webchat-step-install');assert.match(f.modal.markup,/data-webchat-install-step="authorize"/);assert.match(f.modal.panel.feedback.textContent,/revisão atual/);
    await f.action(status===409?'refresh':'verify');await f.action('webchat-step-install');assert.match(f.modal.markup,/data-webchat-install-step="install"/);
    assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
  }
});

test('PT/EN guide preserves customer text and focus is applied only to the current owned step heading',async t=>{
  const f=fixture(t);setLocale('en',{persist:false,notify:false});await f.ui.open(f.channel,{step:'install'});
  assert.match(f.modal.markup,/Add chat to your website/);assert.match(f.modal.markup,/Copy code/);assert.match(f.opened.at(-1).subtitle,/Empresa QA/);
  assert.deepEqual(f.focuses.at(-1),{token:f.modal.panel.dataset.connectorToken,options:{preventScroll:true},step:'install'});
  const closed=fixture(t,{onOpen:modal=>{modal.open=false;}});assert.equal(await closed.ui.open(closed.channel),false);assert.equal(closed.focuses.length,0);
});

test('reset discards scoped drafts and a rejected state refresh after confirmed save does not repeat or misreport the POST',async t=>{
  const f=fixture(t);await f.ui.open(f.channel);f.modal.form.set('origins','https://draft.example');await f.action('webchat-step-install');f.ui.reset();await f.ui.open(f.channel);
  assert.equal(f.modal.form.get('origins'),'https://site.example');assert.doesNotMatch(f.modal.markup,/Seu rascunho está preservado/);
  const refreshed=fixture(t,{onUpdate:()=>{throw Error('refresh unavailable');}});await refreshed.ui.open(refreshed.channel);await refreshed.ui.submit(refreshed.modal.form);
  assert.equal(refreshed.modal.open,true);assert.match(refreshed.modal.panel.feedback.textContent,/Configuração salva/);assert.equal(refreshed.calls.filter(call=>call.init.method==='POST').length,1);
});
