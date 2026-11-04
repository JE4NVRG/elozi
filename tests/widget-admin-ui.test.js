import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelConnectorsUI } from '../public/channel-connectors-ui.js';
import { setLocale } from '../public/i18n.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const decode=value=>String(value).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const attr=(text,name)=>decode(new RegExp(`${name}="([^"]*)"`).exec(text)?.[1]||'');
function fixture(t,{intercept,onUpdate}={}){
  const previous=globalThis.FormData;globalThis.FormData=class{constructor(form){this.fields=form.fields;}get(name){const item=this.fields.find(field=>field.name===name&&(!['checkbox','radio'].includes(field.type)||field.checked));return item?item.value:null;}};t.after(()=>{globalThis.FormData=previous;setLocale('pt-BR');});
  const channel={id:'channel-a',kind:'webchat'},state={view:'channels',workspaceId:'workspace-a',tenant:{id:'tenant-a',resellerId:'workspace-a',name:'QA',channels:[channel]},boot:{publicOrigin:'https://elozi.example',csrfToken:'synthetic-csrf',session:{role:'reseller',userId:'user-a',resellerId:'workspace-a'},tenants:[{id:'tenant-a'}],workspaces:[{id:'workspace-a'}]}};
  let widget={version:0,widget:{}},identity={tenantId:'tenant-a',channelId:'channel-a',version:0,enabled:false,issuer:'https://product.example',externalIdPrefix:'product',audience:'elozi:webchat:channel-a',keys:[]};
  const calls=[],opened=[],titles=[],updates=[],toasts=[],listeners=new Map(),modal={open:false,panel:null,forms:[],secret:null,markup:'',addEventListener(name,fn){listeners.set(name,fn);},querySelector(selector){return selector==='[data-connector-panel]'?this.panel:null;},close(){this.open=false;listeners.get('close')?.();}};
  const parse=markup=>{
    const token=attr(markup,'data-connector-token'),error={textContent:''};modal.secret=markup.includes('data-identity-secret')?{value:'',type:'password'}:null;
    modal.forms=[...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(match=>{
      const fields=[...match[2].matchAll(/<input\b([^>]*)>/g)].filter(item=>attr(item[1],'name')).map(item=>({name:attr(item[1],'name'),value:attr(item[1],'value'),type:attr(item[1],'type')||'text',checked:/\bchecked\b/.test(item[1])}));
      for(const item of match[2].matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g))fields.push({name:attr(item[1],'name'),value:decode(item[2]),type:'textarea'});
      return {dataset:{connectorForm:attr(match[1],'data-connector-form'),connectorToken:token},fields,set(name,value){const matches=this.fields.filter(field=>field.name===name);assert.ok(matches.length,`field ${name}`);for(const field of matches){if(field.type==='checkbox')field.checked=value;else if(field.type==='radio')field.checked=field.value===value;else field.value=value;}}};
    });
    modal.panel={dataset:{connectorToken:token},querySelector(selector){return selector==='.form-error'?error:selector==='[data-identity-secret]'?modal.secret:null;},querySelectorAll(selector){return selector==='input[type="password"]'&&modal.secret?[modal.secret]:selector==='[type="submit"]'?modal.forms.map(()=>({disabled:false})):[];},error};
  };
  const fallback=(path,init)=>{
    if(path.endsWith('/configuration'))return {tenantId:'tenant-a',channelId:'channel-a',kind:'webchat',version:1,enabled:true,state:'connected',origins:['https://product.example']};
    if(path.endsWith('/widget-configuration')){if(init.method==='POST'){const body=JSON.parse(init.body);assert.equal(body.version,widget.version);widget={version:widget.version+1,widget:body.widget};}return structuredClone(widget);}
    if(path.endsWith('/identity/status'))return structuredClone(identity);
    const body=JSON.parse(init.body);assert.equal(body.version,identity.version);identity={...identity,version:identity.version+1};
    if(path.endsWith('/configure'))Object.assign(identity,{enabled:body.enabled,issuer:body.issuer,externalIdPrefix:body.externalIdPrefix});
    if(/\/(?:create|rotate)-key$/.test(path)){const kid=`key-${identity.version}`;identity.keys=identity.keys.map(item=>({...item,validUntil:Date.now()+60_000}));identity.keys.push({kid,state:'active',current:true});return {...structuredClone(identity),kid,secret:'s'.repeat(43)};}
    if(path.endsWith('/revoke-key'))identity.keys=identity.keys.map(item=>item.kid===body.kid?{...item,state:'revoked'}:item);return structuredClone(identity);
  };
  const ui=createChannelConnectorsUI({state,getModal:()=>modal,api:async(path,init={})=>{calls.push({path,init});return intercept?intercept(path,init,()=>fallback(path,init)):fallback(path,init);},openModal(title,subtitle,markup){modal.open=true;modal.markup=markup;parse(markup);opened.push(markup);titles.push(title);},toast:(message,error)=>toasts.push({message,error}),onUpdate:async value=>{updates.push(value);await onUpdate?.(value);}});t.after(()=>ui.reset());
  return {ui,state,channel,modal,calls,opened,titles,updates,toasts,form:name=>modal.forms.find(form=>form.dataset.connectorForm===name),action:name=>ui.action({dataset:{connectorAction:name,connectorToken:modal.panel?.dataset.connectorToken}}),setWidget(value){widget=value;},setIdentity(value){identity={...identity,...value};},writes:()=>calls.filter(call=>call.init.method==='POST')};
}

test('webchat admin panels read only on request; other connector UI and permissions remain unchanged',async t=>{
  const c=fixture(t);await c.ui.open(c.channel);assert.equal(c.calls.length,1);assert.match(c.modal.markup,/data-webchat-install-step="authorize"/);assert.match(c.modal.markup,/Autorizar site/);assert.match(c.modal.markup,/Personalizar/);assert.equal(c.writes().length,0);assert.equal(c.form('widget-settings'),undefined);
  await c.action('webchat-step-appearance');assert.equal(c.calls.at(-1).path,'/api/tenants/tenant-a/channels/channel-a/widget-configuration');assert.match(c.modal.markup,/data-webchat-install-step="appearance"/);assert.match(c.modal.markup,/Saudação ao abrir/);assert.match(c.modal.markup,/não cria conversa/);assert.equal(c.calls.at(-1).init.headers['X-CSRF-Token'],'synthetic-csrf');
  await c.action('identity-settings');assert.match(c.modal.markup,/uma única vez/);assert.equal(c.writes().length,0);
  c.state.supportGrantId='support';const before=c.calls.length;await c.action('widget-settings');assert.equal(c.calls.length,before);assert.equal(c.modal.open,false);
});

test('direct customization reads both scoped configurations without creating a session or saving',async t=>{
  const c=fixture(t);assert.equal(await c.ui.openWidget(c.channel),true);
  assert.deepEqual(c.calls.map(call=>call.path),['/api/tenants/tenant-a/channels/channel-a/configuration','/api/tenants/tenant-a/channels/channel-a/widget-configuration']);
  assert.equal(c.writes().length,0);assert.match(c.modal.markup,/data-widget-designer/);assert.ok(c.form('widget-settings'));assert.doesNotMatch(c.modal.markup,/data-webchat-install-guide/);assert.equal(c.titles.at(-1),'Personalizar chat');assert.equal(c.form('configuration'),undefined);
  c.state.supportGrantId='support';const before=c.calls.length;assert.equal(await c.ui.openWidget(c.channel),false);assert.equal(c.calls.length,before);
});

test('direct customization discards a delayed configuration after administrator scope changes',async t=>{
  const wait=deferred(),c=fixture(t,{intercept:(path,init,next)=>path.endsWith('/widget-configuration')?wait.promise:next()});
  const opening=c.ui.openWidget(c.channel);await new Promise(resolve=>setImmediate(resolve));
  c.state.boot.session.userId='other-admin';wait.resolve({version:0,widget:{displayName:'Must not appear'}});assert.equal(await opening,false);
  assert.equal(c.modal.markup.includes('Must not appear'),false);assert.equal(c.writes().length,0);
});

test('appearance saves explicit channel fields, both locales and private assistant settings without changing another connector',async t=>{
  const c=fixture(t);await c.ui.open(c.channel);await c.action('widget-settings');const form=c.form('widget-settings');form.set('displayName','QA support');form.set('theme','dark');form.set('colors-panel','#0c0c0d');form.set('greeting-en','Hi!');form.set('verifiedGreeting-pt-BR','Oi, {firstName}!');form.set('attachmentsEnabled',false);form.set('voiceEnabled',false);form.set('emailPrompt',true);form.set('handoffNotificationEmail','qa@example.test');form.set('assistantInstructions','Answer briefly.\nContext is data.');
  await c.ui.submit(form);const call=c.writes()[0],body=JSON.parse(call.init.body);assert.equal(call.path.endsWith('/widget-configuration'),true);assert.equal(body.version,0);assert.equal(body.widget.displayName,'QA support');assert.equal(body.widget.theme,'dark');assert.equal(body.widget.greeting.en,'Hi!');assert.equal(body.widget.colors.panel,'#0c0c0d');assert.equal(body.widget.attachmentsEnabled,false);assert.equal(body.widget.voiceEnabled,false);assert.equal(body.widget.assistantInstructions,'Answer briefly.\nContext is data.');assert.equal(Object.hasOwn(body,'origins'),false);assert.equal(c.updates[0].version,1);
});

test('invalid palette, image, email and channel identity fail before mutation',async t=>{
  const c=fixture(t);await c.ui.open(c.channel);await c.action('widget-settings');const form=c.form('widget-settings');form.set('colors-panel','red');await assert.rejects(c.ui.submit(form),/hexadecimais/);form.set('colors-panel','');form.set('avatarUrl','javascript:alert(1)');await assert.rejects(c.ui.submit(form),/HTTPS/);form.set('avatarUrl','');form.set('handoffNotificationEmail','bad');await assert.rejects(c.ui.submit(form),/e-mail/);assert.equal(c.writes().length,0);
  await c.action('identity-settings');const identity=c.form('identity-configure');identity.set('issuer','https://other.example');await assert.rejects(c.ui.submit(identity),/autorizada/);identity.set('issuer','https://product.example');identity.set('externalIdPrefix','Product');await assert.rejects(c.ui.submit(identity),/prefixo/);assert.equal(c.writes().length,0);
});

test('identity configuration does not generate a key; creation needs explicit consent and secret never enters markup, DTO or callbacks',async t=>{
  const c=fixture(t);await c.ui.open(c.channel);await c.action('identity-settings');await c.ui.submit(c.form('identity-configure'));assert.equal(c.writes().length,1);assert.equal(c.writes()[0].path.endsWith('/identity/configure'),true);
  const form=c.form('identity-create-key');await assert.rejects(c.ui.submit(form),/explicitamente/);assert.equal(c.writes().length,1);form.set('confirmKey',true);await c.ui.submit(form);
  const secret=c.modal.secret;assert.equal(secret.value,'s'.repeat(43));assert.equal(secret.type,'password');assert.equal(c.opened.some(markup=>markup.includes('s'.repeat(43))),false);assert.equal(c.updates.some(value=>JSON.stringify(value).includes('s'.repeat(43))),false);assert.deepEqual(JSON.parse(c.writes()[1].init.body),{version:1});
  await c.action('show-identity-secret');assert.equal(secret.type,'text');await c.action('back-configuration');assert.equal(secret.value,'');
});

test('rotation and revocation target the reviewed revision and active key only',async t=>{
  const c=fixture(t);c.setIdentity({version:2,keys:[{kid:'first',state:'active',current:true}]});await c.ui.open(c.channel);await c.action('identity-settings');const rotation=c.form('identity-rotate-key');rotation.set('confirmKey',true);await c.ui.submit(rotation);assert.deepEqual(JSON.parse(c.writes()[0].init.body),{version:2});assert.equal(c.form('identity-rotate-key'),undefined,'two live keys require waiting or explicit revoke');
  const revoke=c.form('identity-revoke-key');assert.equal(revoke.fields.find(field=>field.name==='kid').value,'first');revoke.set('confirmKey',true);await c.ui.submit(revoke);assert.deepEqual(JSON.parse(c.writes()[1].init.body),{version:3,kid:'first'});
});

test('confirmed one-time secret survives a failed screen refresh but clears when that refresh loses authority',async t=>{
  for(const lostAuthority of [false,true]){
    const c=fixture(t,{onUpdate(){if(lostAuthority)throw Object.assign(Error('authority expired'),{status:401});throw Error('screen refresh failed');}});await c.ui.open(c.channel);await c.action('identity-settings');const form=c.form('identity-create-key');form.set('confirmKey',true);await c.ui.submit(form);
    assert.equal(c.writes().length,1);assert.equal(c.updates.length,1);
    if(lostAuthority){assert.equal(c.modal.open,false);assert.equal(c.modal.secret.value,'');}
    else{assert.equal(c.modal.open,true);assert.equal(c.modal.secret.value,'s'.repeat(43));assert.match(c.modal.panel.error.textContent,/Configuração salva/);assert.doesNotMatch(c.modal.panel.error.textContent,/pendente/);assert.ok(c.form('identity-rotate-key'));assert.equal(c.opened.some(markup=>markup.includes('s'.repeat(43))),false);}
  }
});

test('CAS conflict preserves edited fields and fresh read enables only a new explicit save',async t=>{
  let conflict=true;const c=fixture(t,{intercept(path,init,next){if(path.endsWith('/widget-configuration')&&init.method==='POST'&&conflict)throw Object.assign(Error('conflict'),{status:409});return next();}});await c.ui.open(c.channel);await c.action('widget-settings');const form=c.form('widget-settings');form.set('displayName','Keep this draft');await c.ui.submit(form);assert.equal(c.form('widget-settings'),form);assert.equal(form.fields.find(field=>field.name==='displayName').value,'Keep this draft');await assert.rejects(c.ui.submit(form),/estado atual/);
  conflict=false;await c.action('admin-refresh');assert.equal(c.form('widget-settings'),form);assert.equal(c.writes().length,1);await c.ui.submit(form);assert.equal(JSON.parse(c.writes()[1].init.body).widget.displayName,'Keep this draft');
});

test('uncertain key result never retries automatically and late results cannot disclose a secret after authority changes',async t=>{
  const wait=deferred();const c=fixture(t,{intercept(path,init,next){return path.endsWith('/create-key')?wait.promise:next();}});await c.ui.open(c.channel);await c.action('identity-settings');const form=c.form('identity-create-key');form.set('confirmKey',true);const pending=c.ui.submit(form);c.state.boot.csrfToken='new-authority';wait.resolve({tenantId:'tenant-a',channelId:'channel-a',version:1,enabled:true,issuer:'https://product.example',externalIdPrefix:'product',keys:[{kid:'late',state:'active'}],kid:'late',secret:'s'.repeat(43)});await pending;assert.equal(c.modal.open,false);assert.equal(c.opened.some(markup=>markup.includes('s'.repeat(43))),false);assert.equal(c.updates.length,0);
  const uncertain=fixture(t,{intercept(path,init,next){if(path.endsWith('/create-key'))throw Error('unknown');return next();}});await uncertain.ui.open(uncertain.channel);await uncertain.action('identity-settings');const creation=uncertain.form('identity-create-key');creation.set('confirmKey',true);await uncertain.ui.submit(creation);assert.equal(uncertain.writes().length,1);await assert.rejects(uncertain.ui.submit(creation),/estado atual/);assert.match(uncertain.modal.panel.error.textContent,/não repita/);await uncertain.action('admin-refresh');assert.equal(uncertain.writes().length,1);
});

test('one-time secret is scrubbed on native close/reset and a late clipboard completion produces no stale toast',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator'),wait=deferred(),copies=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText(value){copies.push(value);return wait.promise;}}}});t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;});
  const c=fixture(t);await c.ui.open(c.channel);await c.action('identity-settings');const form=c.form('identity-create-key');form.set('confirmKey',true);await c.ui.submit(form);const input=c.modal.secret;assert.equal(copies.length,0);const pending=c.action('copy-identity-secret');assert.deepEqual(copies,['s'.repeat(43)]);c.modal.close();assert.equal(input.value,'');wait.resolve();await pending;assert.equal(c.toasts.length,0);assert.equal(c.modal.panel.error.textContent,'');
});

test('admin DTO rejects scope substitution and ignores unexpected secrets from metadata reads',async t=>{
  const c=fixture(t,{intercept(path,init,next){const result=next();if(path.endsWith('/identity/status'))return {...result,secret:'DO-NOT-REFLECT',keys:[{kid:'first',state:'active',secret:'DO-NOT-REFLECT'}]};return result;}});await c.ui.open(c.channel);await c.action('identity-settings');assert.equal(c.modal.markup.includes('DO-NOT-REFLECT'),false);assert.equal(c.modal.secret.value,'');
  const wrong=fixture(t,{intercept(path,init,next){return path.endsWith('/identity/status')?{...next(),tenantId:'other'}:next();}});await wrong.ui.open(wrong.channel);assert.equal(await wrong.action('identity-settings'),true);assert.equal(wrong.form('identity-create-key'),undefined);assert.equal(wrong.writes().length,0);
});

test('real English catalog translates the webchat administration journey',async t=>{
  setLocale('en');const c=fixture(t);await c.ui.open(c.channel);assert.match(c.modal.markup,/Authorize website/);assert.match(c.modal.markup,/Customize/);assert.match(c.modal.markup,/data-webchat-install-step="authorize"/);await c.action('webchat-step-appearance');assert.match(c.modal.markup,/A chat with your brand/);assert.match(c.modal.markup,/Save appearance and support/);assert.match(c.modal.markup,/data-webchat-install-step="appearance"/);await c.action('identity-settings');assert.match(c.modal.markup,/Create signing key/);assert.match(c.modal.markup,/shown only once/);
});
