import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceUI,teamDirectory,permissionNames} from '../public/workspace-ui.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decode=value=>String(value||'').replace(/&(quot|#39|lt|gt|amp);/g,(_,key)=>({quot:'"','#39':"'",lt:'<',gt:'>',amp:'&'}[key]));
function makeForm(markup,type) {
  const controls=[];
  for(const [,attrs] of markup.matchAll(/<input\b([^>]*)>/g)) {
    const name=attrs.match(/\bname="([^"]*)"/)?.[1];if(!name)continue;
    controls.push({name:decode(name),value:decode(attrs.match(/\bvalue="([^"]*)"/)?.[1]),type:attrs.match(/\btype="([^"]*)"/)?.[1]||'text',checked:/\bchecked\b/.test(attrs)});
  }
  for(const [,attrs,content] of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name=attrs.match(/\bname="([^"]*)"/)?.[1];if(!name)continue;
    const chosen=[...content.matchAll(/<option\b([^>]*)>/g)].find(item=>/\bselected\b/.test(item[1]));controls.push({name,value:decode(chosen?.[1].match(/\bvalue="([^"]*)"/)?.[1]),type:'select'});
  }
  return {dataset:{dialogForm:type},controls,reset(){},set(name,value){const item=controls.find(c=>c.name===name&&c.type!=='checkbox');assert.ok(item,name);item.value=value;},check(name,value,checked){const item=controls.find(c=>c.name===name&&c.value===value);assert.ok(item,`${name}/${value}`);item.checked=checked;}};
}
class FormDataAdapter {
  constructor(form){this.entries=form.controls.filter(c=>c.type!=='checkbox'||c.checked).map(c=>[c.name,c.value]);}
  get(name){return this.entries.find(([key])=>key===name)?.[1]??null;}
  getAll(name){return this.entries.filter(([key])=>key===name).map(([,value])=>value);}
  has(name){return this.entries.some(([key])=>key===name);}
  [Symbol.iterator](){return this.entries[Symbol.iterator]();}
}
const accepted=()=>({invitation:{id:'invitation-a',expiresAt:'2026-10-06T15:00:00Z'},inviteUrl:'https://elozi.je4ndev.com/join?token=synthetic-only',email:{queued:false,configured:false}});
function fixture(t,options={}) {
  const previous={document:globalThis.document,FormData:globalThis.FormData,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator')};
  const closeHandlers=[],modal={markup:'',open:true,close(){this.open=false;for(const callback of closeHandlers)callback();},addEventListener(type,callback){if(type==='close')closeHandlers.push(callback);},querySelector(){return this.open&&this.markup.includes('aria-label="Link de convite"')?{}:null;}};
  globalThis.document={addEventListener(){},querySelector:selector=>selector==='#modal'?modal:null};globalThis.FormData=FormDataAdapter;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>result.copied=value}}});
  t.after(()=>{globalThis.document=previous.document;globalThis.FormData=previous.FormData;if(previous.navigator)Object.defineProperty(globalThis,'navigator',previous.navigator);else delete globalThis.navigator;});
  const definitions=[{id:'tenant-a',name:'Playtech',channels:[{id:'channel-a',name:'WhatsApp'}],departments:[{id:'support',name:'Suporte'}]}];
  const state={boot:{csrfToken:'csrf-a',session:{userId:'admin',role:'reseller'},tenants:definitions},workspaceId:'workspace-a',tenant:definitions[0],users:[],invitations:[],invitationEmailConfigured:Boolean(options.emailConfigured)},calls=[],result={render:0,refresh:0,forms:[],modals:[]};
  const ctx={state,escape,icon:()=>'',badge:(text)=>text,button:(label,action)=>`<button data-action="${action}">${label}</button>`,avatarMarkup:()=>'',pageHeading:(a,b,c,d)=>`<h1>${b}</h1>${d}`,roleLabel:user=>user.role,formModal(title,description,type,markup){modal.open=true;modal.markup=markup;result.form=makeForm(markup,type);result.forms.push({title,description,type,markup});},openModal(title,description,markup){modal.open=true;modal.markup=markup;result.modals.push({title,description,markup});},api:async(path,init)=>{calls.push({path,init});if(path.startsWith('/api/tenants/'))return structuredClone(definitions[0]);if(options.api)return options.api(path,init);return init?.method==='POST'?accepted():{invitations:state.invitations,emailConfigured:state.invitationEmailConfigured};},refresh:async()=>{result.refresh++;},render:()=>{result.render++;},toast:message=>{result.toast=message;}};
  return {ui:createWorkspaceUI(ctx),state,calls,result,modal,async invite(){await this.ui.action('invite-user');return result.form;},creates(){return calls.filter(call=>call.path==='/api/users/invitations'&&call.init?.method==='POST').map(call=>JSON.parse(call.init.body));}};
}

test('diretório humano filtra nome sem acento, perfil e acesso',()=>{
  const people=[{name:'Jéssica',username:'jess',role:'operator',disabled:false},{name:'Jean',email:'admin@example.test',role:'reseller',disabled:false},{name:'José',role:'operator',disabled:true}];
  assert.deepEqual(teamDirectory(people,{search:'jessica',status:'active',role:'operator'}),[people[0]]);
  assert.deepEqual(teamDirectory(people,{search:'example.test',role:'admin'}),[people[1]]);
  assert.deepEqual(teamDirectory(people,{status:'inactive'}),[people[2]]);
});
test('convite principal dispensa senha inicial e envio por e-mail fica desmarcado',async t=>{
  const env=fixture(t,{emailConfigured:true});await env.invite();const markup=env.result.forms[0].markup;
  assert.equal(markup.includes('name="password"'),false);assert.equal(markup.includes('name="username"'),false);assert.ok(markup.includes('name="sendEmail"'));
  assert.equal(env.result.form.controls.find(c=>c.name==='sendEmail').checked,false);assert.ok(env.ui.views.team().includes('data-action="invite-user"'));assert.ok(env.ui.views.team().includes('data-action="new-user"'));
});
test('criar convite usa acesso explícito e uma chave, sem senha ou disparo implícito',async t=>{
  const env=fixture(t,{emailConfigured:true}),form=await env.invite();form.set('name','Pessoa real');form.set('email','pessoa@example.test');await env.ui.submit(form);
  const [payload]=env.creates();assert.equal(payload.sendEmail,false);assert.equal(payload.name,'Pessoa real');assert.equal(payload.email,'pessoa@example.test');assert.deepEqual(payload.tenantIds,['tenant-a']);assert.deepEqual(payload.permissions,Object.keys(permissionNames).sort());assert.deepEqual(payload.scopeRules,{'tenant-a':{channelIds:null,departmentIds:null}});assert.match(payload.requestId,/^[a-f0-9-]{36}$/);assert.equal('password' in payload,false);assert.equal('username' in payload,false);assert.equal(env.result.modals.at(-1).title,'Convite pronto');
});
test('envio de e-mail exige escolha explícita e destinatário',async t=>{
  const env=fixture(t,{emailConfigured:true}),form=await env.invite();form.check('sendEmail','yes',true);
  await assert.rejects(env.ui.submit(form),/Informe o e-mail/);assert.equal(env.creates().length,0);
  form.set('email','pessoa@example.test');await env.ui.submit(form);assert.equal(env.creates()[0].sendEmail,true);
});
test('operador precisa empresa e dependências de permissões antes de criar',async t=>{
  const env=fixture(t),form=await env.invite();form.check('tenantIds','tenant-a',false);await assert.rejects(env.ui.submit(form),/pelo menos uma empresa/);
  form.check('tenantIds','tenant-a',true);form.check('permissions','inbox.read',false);await assert.rejects(env.ui.submit(form),/Ver atendimentos/);
  form.check('permissions','inbox.read',true);form.check('permissions','contacts.read',false);await assert.rejects(env.ui.submit(form),/Ver contatos/);assert.equal(env.creates().length,0);
});
test('perfil administrador não materializa escopos ocultos',async t=>{
  const env=fixture(t),form=await env.invite();form.set('role','reseller');await env.ui.submit(form);const [payload]=env.creates();assert.equal(payload.role,'reseller');assert.equal('tenantIds' in payload,false);assert.equal('permissions' in payload,false);assert.equal('scopeRules' in payload,false);
});
test('resposta incerta conserva a mesma carga e chave ao verificar',async t=>{
  let attempt=0;const env=fixture(t,{api:async()=>{if(++attempt===1)throw new Error('resposta perdida');return accepted();}}),form=await env.invite();form.set('name','Primeira escolha');await assert.rejects(env.ui.submit(form),/Verificar convite/);
  assert.equal(env.result.modals.at(-1).title,'Verificar criação do convite');form.set('name','Alteração posterior');await env.ui.action('retry-invitation');const payloads=env.creates();assert.deepEqual(payloads[1],payloads[0]);assert.equal(payloads[1].name,'Primeira escolha');assert.equal(env.result.modals.at(-1).title,'Convite pronto');
});
test('duplo submit em andamento não cria outro convite',async t=>{
  let resolve;const response=new Promise(done=>resolve=done),env=fixture(t,{api:()=>response}),form=await env.invite(),first=env.ui.submit(form);await env.ui.submit(form);assert.equal(env.creates().length,1);resolve(accepted());await first;
});
test('rejeição explícita libera correção com uma chave nova',async t=>{
  let attempt=0;const env=fixture(t,{api:async()=>{if(++attempt===1)throw Object.assign(new Error('Acesso recusado'),{status:422});return accepted();}}),form=await env.invite();await assert.rejects(env.ui.submit(form),/Acesso recusado/);await env.ui.submit(form);const payloads=env.creates();assert.notEqual(payloads[1].requestId,payloads[0].requestId);
});
test('resposta inválida não mostra URL executável e permanece verificável',async t=>{
  let attempt=0;const env=fixture(t,{api:async()=>{const result=accepted();if(++attempt===1)result.inviteUrl='javascript:alert(1)';return result;}}),form=await env.invite();await assert.rejects(env.ui.submit(form),/Verificar convite/);assert.equal(env.result.modals.some(m=>m.markup.includes('javascript:')),false);await env.ui.action('retry-invitation');assert.deepEqual(env.creates()[0],env.creates()[1]);
});
test('resposta de outro workspace ou autoridade não expõe link',async t=>{
  let resolve;const env=fixture(t,{api:()=>new Promise(done=>resolve=done)}),form=await env.invite(),waiting=env.ui.submit(form);env.state.workspaceId='workspace-b';resolve(accepted());await waiting;assert.equal(env.result.modals.length,0);assert.equal(env.result.refresh,0);await assert.rejects(env.ui.action('retry-invitation'),/acesso mudou/);
});
test('mudança de sessão antes de submeter invalida o editor',async t=>{
  const env=fixture(t),form=await env.invite();env.state.boot.csrfToken='csrf-b';await assert.rejects(env.ui.submit(form),/Abra o convite/);assert.equal(env.creates().length,0);
});
test('listagem não mostra token/link extras e escapa identidade de convite',async t=>{
  const env=fixture(t);env.state.invitations=[{id:'invitation-a',name:'<script>',email:'pessoa@example.test',role:'operator',tenantIds:['tenant-a'],expiresAt:'2026-10-06T15:00:00Z',state:'pending',canRevoke:true,token:'do-not-show-token',inviteUrl:'do-not-show-url'}];
  const markup=env.ui.views.team();assert.ok(markup.includes('&lt;script&gt;'));assert.equal(markup.includes('do-not-show'),false);assert.ok(markup.includes('1 pendentes'));await env.ui.action('refresh-invitations');assert.equal(env.result.render,1);
});
test('revogar requer confirmação no mesmo workspace e preserva a conta',async t=>{
  const env=fixture(t);env.state.invitations=[{id:'invitation-a',name:'Pessoa',state:'pending',canRevoke:true}];await assert.rejects(env.ui.action('revoke-invitation','invitation-a'),/confirmação/);
  await env.ui.action('confirm-revoke-invitation','invitation-a');env.state.workspaceId='other';await assert.rejects(env.ui.action('revoke-invitation','invitation-a'),/confirmação/);env.state.workspaceId='workspace-a';await env.ui.action('revoke-invitation','invitation-a');assert.equal(env.calls.filter(call=>call.path.endsWith('/revoke')).length,1);assert.ok(env.result.modals[0].markup.includes('permanecem preservadas'));assert.equal(env.modal.open,false);
});
test('copiar funciona somente enquanto o link criado está no modal atual',async t=>{
  const env=fixture(t),form=await env.invite();await env.ui.submit(form);await env.ui.action('copy-invitation');assert.equal(env.result.copied,accepted().inviteUrl);env.modal.close();await assert.rejects(env.ui.action('copy-invitation'),/Abra um convite/);
});
test('filtro de equipe e reset não alteram dados ou acessos',async t=>{
  const env=fixture(t),form={dataset:{dialogForm:'team-filter'},controls:[{name:'search',value:'Jean'},{name:'status',value:'active'},{name:'role',value:'admin'}]};await env.ui.submit(form);assert.equal(env.state.teamSearch,'Jean');assert.equal(env.state.teamStatus,'active');assert.equal(env.state.teamRole,'admin');assert.equal(env.calls.length,0);env.ui.resetPeople();assert.equal(env.state.teamSearch,'');assert.equal(env.state.teamStatus,'all');
});
