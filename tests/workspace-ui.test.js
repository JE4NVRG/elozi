import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceUI, permissionNames } from '../public/workspace-ui.js';
import { getLocale, setLocale, t as translate } from '../public/i18n.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decode=value=>String(value||'').replace(/&(quot|#39|lt|gt|amp);/g,(_,key)=>({quot:'"','#39':"'",lt:'<',gt:'>',amp:'&'}[key]));
function formFromMarkup(markup) {
  const controls=[];
  for(const match of markup.matchAll(/<input\b([^>]*)>/g)) {
    const attrs=match[1],name=attrs.match(/\bname="([^"]*)"/)?.[1];if(!name)continue;
    controls.push({name:decode(name),value:decode(attrs.match(/\bvalue="([^"]*)"/)?.[1]),type:attrs.match(/\btype="([^"]*)"/)?.[1]||'text',checked:/\bchecked\b/.test(attrs)});
  }
  for(const match of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name=match[1].match(/\bname="([^"]*)"/)?.[1];if(!name)continue;
    const selected=[...match[2].matchAll(/<option\b([^>]*)>/g)].find(item=>/\bselected\b/.test(item[1]));controls.push({name,value:decode(selected?.[1].match(/\bvalue="([^"]*)"/)?.[1]),type:'select'});
  }
  return {dataset:{dialogForm:'person'},controls,reset(){this.resetCalled=true;},set(name,value){const control=controls.find(item=>item.name===name&&item.type!=='checkbox');assert.ok(control,name);control.value=value;},check(name,value,checked){const control=controls.find(item=>item.name===name&&item.value===value);assert.ok(control,`${name}/${value}`);control.checked=checked;}};
}
class FormDataAdapter {
  constructor(form){this.entries=form.controls.filter(item=>item.type!=='checkbox'||item.checked).map(item=>[item.name,item.value]);}
  get(name){return this.entries.find(([key])=>key===name)?.[1]??null;}
  getAll(name){return this.entries.filter(([key])=>key===name).map(([,value])=>value);}
  has(name){return this.entries.some(([key])=>key===name);}
  [Symbol.iterator](){return this.entries[Symbol.iterator]();}
}
function fixture(t,userExtra={}) {
  const previousDocument=globalThis.document,previousFormData=globalThis.FormData;
  const modal={close(){this.closed=true;}};
  globalThis.document={addEventListener(){},querySelector:selector=>selector==='#modal'?modal:null};globalThis.FormData=FormDataAdapter;
  t.after(()=>{globalThis.document=previousDocument;globalThis.FormData=previousFormData;});
  const definitions=[{id:'tenant-a',name:'Empresa A',channels:[{id:'channel-a',name:'Canal A'},{id:'channel-b',name:'Canal B'}],departments:[{id:'department-a',name:'Departamento A'},{id:'retired',name:'Antigo',active:false}]},{id:'tenant-b',name:'Empresa B',channels:[{id:'channel-c',name:'Canal C'}],departments:[]}];
  const user={id:'person',name:'Pessoa',role:'operator',tenantIds:['tenant-a'],permissions:null,scopeRules:null,...userExtra};
  const state={boot:{session:{role:'reseller',userId:'admin'},tenants:definitions},workspaceId:'workspace',tenant:definitions[0],users:[user]},calls=[],result={};
  const ctx={state,escape,icon:()=>'',badge:()=>'',button:()=>'',formModal(_title,_description,_type,markup){result.form=formFromMarkup(markup);result.markup=markup;},api:async(path,options)=>{calls.push({path,options});if(options?.method==='PATCH'||options?.method==='POST')return user;return structuredClone(definitions.find(item=>path.endsWith(item.id)));},refresh:async()=>{},render:()=>{},toast:()=>{}};
  return {ui:createWorkspaceUI(ctx),state,user,calls,result,modal,async open(){await this.ui.action('edit-user','person');return result.form;},payload(){return JSON.parse(calls.find(call=>call.options?.method==='PATCH'||call.options?.method==='POST').options.body);}};
}

test('salvar só nome preserva permissions:null e scopeRules:null sem expandir grants',async t=>{
  const env=fixture(t),form=await env.open();form.set('name','Pessoa com nome novo');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{name:'Pessoa com nome novo'});assert.equal(form.resetCalled,true);assert.equal(env.modal.closed,true);
});
test('edição de permissões envia lista explícita, inclusive ausência total',async t=>{
  const env=fixture(t),form=await env.open();for(const permission of Object.keys(permissionNames))form.check('permissions',permission,false);await env.ui.submit(form);
  assert.deepEqual(env.payload(),{name:'Pessoa',permissions:[]});
});
test('escopo editado envia só dimensão mudada com [] e mantém null original das demais empresas',async t=>{
  const env=fixture(t,{tenantIds:['tenant-a','tenant-b'],scopeRules:{'tenant-a':{channelIds:null,departmentIds:['retired']},'tenant-b':null}}),form=await env.open();
  form.check('scope-all-channelIds-tenant-a','all',false);await env.ui.submit(form);
  assert.deepEqual(env.payload(),{name:'Pessoa',scopeRules:{'tenant-a':{channelIds:[],departmentIds:['retired']},'tenant-b':null}});
});
test('nome mantém regra null por empresa e ausência de dimensões, inclusive IDs não renderizados',async t=>{
  const original={'tenant-a':{channelIds:['channel-a'],departmentIds:['retired']},'tenant-b':null};
  const env=fixture(t,{tenantIds:['tenant-a','tenant-b'],permissions:['inbox.read'],scopeRules:original}),form=await env.open();form.set('name','Outro nome');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{name:'Outro nome'});assert.deepEqual(env.user.scopeRules,original);
});
test('trocar escopo restrito para Todos envia null explicitamente sem expandir outra dimensão',async t=>{
  const env=fixture(t,{scopeRules:{'tenant-a':{channelIds:['channel-a']}}}),form=await env.open();form.check('scope-all-channelIds-tenant-a','all',true);await env.ui.submit(form);
  assert.deepEqual(env.payload(),{name:'Pessoa',scopeRules:{'tenant-a':{channelIds:null}}});
});
test('papel e empresas realmente alterados são enviados sem materializar permissões antigas',async t=>{
  const env=fixture(t),form=await env.open();form.set('role','reseller');await env.ui.submit(form);assert.deepEqual(env.payload(),{name:'Pessoa',role:'reseller'});
  env.calls.length=0;await env.open();const second=env.result.form;second.check('tenantIds','tenant-b',true);await env.ui.submit(second);assert.deepEqual(env.payload(),{name:'Pessoa',tenantIds:['tenant-a','tenant-b']});
});
test('controles alterados e devolvidos ao baseline não revogam autoridade original',async t=>{
  const env=fixture(t),form=await env.open();form.check('permissions','metrics.read',false);form.check('permissions','metrics.read',true);form.check('scope-all-channelIds-tenant-a','all',false);form.check('scope-all-channelIds-tenant-a','all',true);await env.ui.submit(form);
  assert.deepEqual(env.payload(),{name:'Pessoa'});
});
test('criar pessoa continua enviando escolhas explícitas de acesso',async t=>{
  const env=fixture(t);await env.ui.action('new-user');const form=env.result.form;form.set('name','Nova pessoa');form.set('username','nova');form.set('password','Sintetica!123');form.set('email','');await env.ui.submit(form);
  const payload=env.payload();assert.equal(payload.role,'operator');assert.deepEqual(payload.tenantIds,['tenant-a']);assert.deepEqual(payload.permissions,Object.keys(permissionNames).sort());assert.deepEqual(payload.scopeRules,{'tenant-a':{channelIds:null,departmentIds:null}});assert.equal(payload.username,'nova');
});
test('editor de outro workspace não aplica o baseline anterior',async t=>{
  const env=fixture(t),form=await env.open();env.state.workspaceId='other';await assert.rejects(env.ui.submit(form),/Abra o editor/);assert.equal(env.calls.some(call=>call.options?.method==='PATCH'),false);
});

test('ações de contatos e pessoas identificam a linha no nome acessível em PT/EN sem traduzir nomes', t => {
  const previousDocument = globalThis.document, originalLocale = getLocale();
  globalThis.document = { addEventListener() {}, querySelector: () => null };
  t.after(() => { globalThis.document = previousDocument; setLocale(originalLocale, { persist: false, notify: false }); });
  const names = ['Editar acesso <&"', 'Histórico com Pessoa B'];
  const tenant = { id: 'tenant', channels: [], departments: [] };
  const state = { workspaceId: 'workspace', boot: { session: { role: 'reseller', userId: 'self' }, tenants: [tenant] }, tenant,
    users: names.map((name, index) => ({ id: `person-${index}`, name, role: 'operator', tenantIds: ['tenant'], disabled: index === 1 })),
    contacts: names.map((name, index) => ({ id: `contact-${index}`, name, phone: '11900000000', type: 'person', tags: [], identities: [] })) };
  const ui = createWorkspaceUI({ state, escape, icon: () => '', contactAvatar: () => '', roleLabel: () => translate('Atendente'), hasPermission: () => true });
  const buttonFrom = (markup, action, id) => [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, attrs]) => attrs.includes(`data-action="${action}"`) && attrs.includes(`data-id="${id}"`));
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const people = ui.views.team(), contacts = ui.views.contacts();
    for (const [index, name] of names.entries()) {
      for (const [markup, action, id, label] of [[people, 'edit-user', `person-${index}`, 'Editar acesso'], [people, index ? 'reactivate-user' : 'confirm-disable-user', `person-${index}`, index ? 'Reativar' : 'Desativar'], [contacts, 'contact-history', `contact-${index}`, 'Histórico'], [contacts, 'edit-contact', `contact-${index}`, 'Editar'], [contacts, 'contact-open', `contact-${index}`, 'Abrir atendimento']]) {
        const button = buttonFrom(markup, action, id); assert.ok(button, `${locale}/${action}/${id}`);
        assert.ok(button[1].includes(`aria-label="${escape(translate('{action}: {name}', { action: translate(label), name }))}"`));
        assert.match(button[2], new RegExp(`<span class="ui-btn__label">${translate(label)}</span>`));
        assert.ok(!button[1].includes('<&"'));
      }
    }
    assert.ok(people.includes('Editar acesso &lt;&amp;&quot;')); assert.ok(contacts.includes('Histórico com Pessoa B'));
  }
});

function transferFixture(t, conversationExtra={}, { departments=[], roster }={}) {
  const previousDocument=globalThis.document,previousFormData=globalThis.FormData;
  const modal={close(){this.closed=true;}};
  globalThis.document={addEventListener(){},querySelector:selector=>selector==='#modal'?modal:null};globalThis.FormData=FormDataAdapter;
  t.after(()=>{globalThis.document=previousDocument;globalThis.FormData=previousFormData;});
  const conversation={id:'conversation-own',version:7,status:'open',owner:'human',assignedUserId:'jean-own',departmentId:null,department:'Suporte',...conversationExtra};
  const state={boot:{session:{role:'reseller',userId:'jean-own'},tenants:[]},workspaceId:'workspace-own',tenant:{id:'tenant-own',departments,conversations:[conversation]},conversation:conversation.id};
  const calls=[],result={},toasts=[];
  const api=async(path,options)=>{calls.push({path,options});if(options?.method==='POST')return {};return roster?await roster():{assignees:[{id:'jean-own',name:'Jean QA',presence:'available'},{id:'colleague-own',name:'Colega QA',presence:'available'}]};};
  const ui=createWorkspaceUI({state,escape,icon:()=>'',badge:()=>'',button:()=>'',api,tenantApi:tail=>`/api/tenants/${state.tenant.id}/${tail}`,formModal(_title,_description,type,markup){result.form=formFromMarkup(markup);result.form.dataset.dialogForm=type;result.markup=markup;},refresh:async()=>{},render:()=>{},toast:message=>toasts.push(message)});
  return {ui,state,conversation,calls,result,modal,toasts,async open(){await ui.action('transfer-conversation');return result.form;},payload(){const call=calls.find(call=>call.options?.method==='POST');assert.ok(call);assert.equal(call.path,'/api/tenants/tenant-own/conversations/conversation-own/owner');return JSON.parse(call.options.body);}};
}

test('transferência: destino começa vazio e agrupado (pessoas, agentes, fila); sem escolha não envia, e o aviso diz para quem foi',async t=>{
  const env=transferFixture(t,{owner:'queue',assignedUserId:null}),form=await env.open();
  assert.equal(new FormDataAdapter(form).get('destination'),'');
  assert.match(env.result.markup,/<select name="destination" id="transfer-destination" required>/);
  assert.match(env.result.markup,/<option value="" disabled selected>Escolha quem recebe<\/option><optgroup label="Pessoas">[\s\S]*Jean QA[\s\S]*Colega QA[\s\S]*<\/optgroup><optgroup label="Equipe"><option value="queue" >Fila do departamento \(sem responsável\)<\/option><\/optgroup>/);
  assert.doesNotMatch(env.result.markup,/label="Agentes"/,'no copilot in this company');
  await assert.rejects(env.ui.submit(form),/Escolha quem recebe o atendimento\./);
  assert.equal(env.calls.some(call=>call.options?.method==='POST'),false,'nothing is sent without a destination');
  form.set('destination','colleague-own');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:7,owner:'human',assignedUserId:'colleague-own',reason:''});
  assert.deepEqual(env.toasts,['Atendimento transferido para Colega QA.']);
});

test('transferência para agente: só copilotos configurados aparecem e o envio usa owner agent com agentId',async t=>{
  const env=transferFixture(t,{owner:'queue',assignedUserId:null});
  env.state.tenant.agents=[{id:'sofia',name:'Sofia',provider:'mcp',mode:'copilot',configured:true},{id:'rascunho',name:'Sem configuração',mode:'copilot',configured:false}];
  const form=await env.open();
  assert.match(env.result.markup,/<optgroup label="Agentes"><option value="agent:sofia" >Sofia<\/option><\/optgroup>/);
  assert.doesNotMatch(env.result.markup,/Sem configuração/);
  form.set('destination','agent:sofia');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:7,owner:'agent',agentId:'sofia',reason:''});
  assert.deepEqual(env.toasts,['Atendimento transferido para o agente Sofia.']);
  const queue=transferFixture(t,{owner:'human'},{departments:[{id:'sales-id',name:'Comercial'}]}),queued=await queue.open();
  queued.set('destination','queue');queued.set('departmentId','sales-id');await queue.ui.submit(queued);
  assert.deepEqual(queue.toasts,['Atendimento enviado à fila de Comercial, sem responsável.']);
});

test('transferir apenas responsável omite departamento sem apagar texto legado sem ID',async t=>{
  const env=transferFixture(t),form=await env.open();
  assert.equal(new FormDataAdapter(form).get('departmentId'),'unassigned');
  form.set('destination','colleague-own');form.set('reason','Teste sintético');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:7,owner:'human',assignedUserId:'colleague-own',reason:'Teste sintético'});
  assert.equal(env.conversation.department,'Suporte');assert.equal(env.conversation.departmentId,null);
  assert.equal(env.modal.closed,true);
});

for(const current of [{departmentId:'support-id',department:'Suporte'},{departmentId:null,department:'Suporte'}]) {
  test(`departamento atual por ${current.departmentId?'ID':'nome legado'} não é materializado ao transferir para fila`,async t=>{
    const env=transferFixture(t,current,{departments:[{id:'support-id',name:'Suporte'}]}),form=await env.open();
    assert.equal(new FormDataAdapter(form).get('departmentId'),'support-id');
    form.set('destination','queue');await env.ui.submit(form);
    assert.deepEqual(env.payload(),{version:7,owner:'queue',reason:''});
  });
}

test('mudança real para departamento envia ID escolhido junto ao responsável e versão',async t=>{
  const env=transferFixture(t,{}, {departments:[{id:'sales-id',name:'Comercial'}]}),form=await env.open();
  form.set('departmentId','sales-id');form.set('destination','colleague-own');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:7,owner:'human',assignedUserId:'colleague-own',departmentId:'sales-id',reason:''});
});

test('limpar um departamento real envia unassigned explicitamente para API',async t=>{
  const env=transferFixture(t,{departmentId:'support-id'},{departments:[{id:'support-id',name:'Suporte'}]}),form=await env.open();
  form.set('departmentId','unassigned');form.set('destination','queue');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:7,owner:'queue',departmentId:'unassigned',reason:''});
});

test('escolher outro departamento e voltar ao inicial não envia alteração de departamento',async t=>{
  const env=transferFixture(t,{departmentId:'support-id'},{departments:[{id:'support-id',name:'Suporte'},{id:'sales-id',name:'Comercial'}]}),form=await env.open();
  form.set('departmentId','sales-id');form.set('departmentId','support-id');form.set('destination','jean-own');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:7,owner:'human',assignedUserId:'jean-own',reason:''});
});

test('baseline do formulário não é recalculado com estado atualizado depois de aberto',async t=>{
  const env=transferFixture(t,{}, {departments:[{id:'sales-id',name:'Comercial'}]}),form=await env.open();
  env.conversation.departmentId='sales-id';env.conversation.department='Comercial';env.conversation.version=8;
  form.set('destination','colleague-own');await env.ui.submit(form);
  assert.deepEqual(env.payload(),{version:8,owner:'human',assignedUserId:'colleague-own',reason:''});
});

test('baseline de departamento é capturado antes da consulta assíncrona da equipe',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const env=transferFixture(t,{}, {departments:[{id:'sales-id',name:'Comercial'}],roster:()=>pending});
  const opening=env.open();env.conversation.departmentId='sales-id';env.conversation.department='Comercial';
  release({assignees:[{id:'jean-own',name:'Jean QA',presence:'available'}]});const form=await opening;
  assert.equal(new FormDataAdapter(form).get('departmentId'),'unassigned');
  form.set('destination','jean-own');await env.ui.submit(form);assert.deepEqual(env.payload(),{version:7,owner:'human',assignedUserId:'jean-own',reason:''});
});
