import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import * as i18n from '../public/i18n.js';
import {excerpt} from './helpers/app-source.js';
import {createWorkspaceUI} from '../public/workspace-ui.js';
import {attendanceReplyAccess} from '../public/participants-ui.js';
import {inboxIdentity} from '../public/consolidated-inbox-ui.js';
import {inboxListMarkup} from '../public/inbox-list-ui.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
class FormDataAdapter {
  constructor(form){this.values=Object.entries(form.values);}
  [Symbol.iterator](){return this.values[Symbol.iterator]();}
}
function fixture(t,{api,select,fresh={}}={}){
  const previous={document:globalThis.document,FormData:globalThis.FormData},closeHandlers=[];
  const modal={closed:false,firstElementChild:null,close(){this.closed=true;for(const fn of closeHandlers)fn();},addEventListener(name,fn){if(name==='close')closeHandlers.push(fn);}};
  function mountModal(title,markup,type='history'){
    const fields=new Map();
    for(const [,attrs] of markup.matchAll(/<input\b([^>]*)>/g)){const name=attrs.match(/\bname="([^"]+)"/)?.[1];if(name)fields.set(name,{value:attrs.match(/\bvalue="([^"]*)"/)?.[1]||''});}
    for(const [,attrs,value] of markup.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)){const name=attrs.match(/\bname="([^"]+)"/)?.[1];if(name)fields.set(name,{value});}
    return modal.firstElementChild={title,type,markup,fields};
  }
  globalThis.document={addEventListener(){},querySelector:selector=>selector==='#modal'?modal:null};globalThis.FormData=FormDataAdapter;
  t.after(()=>Object.assign(globalThis,previous));
  const channel={id:'channel-a',name:'Origem própria',state:'connected',transport:'baileys'},contact={id:'contact-a',name:'Contato próprio',phone:'11900000000',version:4};
  const original={id:'case-before',status:'open',owner:'human',assignedUserId:'person',version:3};
  const opened={id:'case-contact',contactId:contact.id,channelId:channel.id,status:'open',owner:'human',assignedUserId:'person',version:7,...fresh};
  const state={workspaceId:'workspace-a',view:'contacts',conversation:original.id,tenant:{id:'company-a',channels:[channel],conversations:[original]},assignees:[],contacts:[contact],search:'filtro conservado',status:'active',boot:{csrfToken:'synthetic-csrf',session:{userId:'person',role:'operator',permissions:['contacts.read','inbox.read','inbox.reply']},tenants:[{id:'company-a'}]}};
  const calls=[],selections=[],notices=[],modals=[],forms=[];
  const ui=createWorkspaceUI({state,escape,icon:()=>'',badge:text=>escape(text),hasPermission:permission=>state.boot.session.permissions.includes(permission),
    tenantApi:tail=>`/api/tenants/${state.tenant.id}/${tail}`,formModal(title,_description,type,markup){forms.push({title,type,markup});mountModal(title,markup,type);},openModal(title,_description,markup){modals.push({title,markup});mountModal(title,markup);},
    api:async(path,options)=>{calls.push({path,options});if(api)return api(path,options);return options?.method==='POST'?opened:{conversations:[{id:opened.id,channelId:channel.id,status:opened.status,updatedAt:'2026-10-03T12:00:00Z'}]};},
    openContactConversation:async(tenantId,id,isCurrent)=>{selections.push({tenantId,id});assert.equal(state.conversation,original.id);assert.equal(state.view,'contacts');if(select)return select({tenantId,id,isCurrent,state,opened});if(!isCurrent())return;state.view='inbox';state.conversation=id;state.tenant.conversations=[opened];return opened;},
    canReplyTo:c=>attendanceReplyAccess(c,{userId:state.boot.session.userId,hasPermission:state.boot.session.permissions.includes('inbox.reply')}),
    refresh:()=>assert.fail('A abertura deve usar a seleção fresca, sem refresh global após alterar o estado'),render:()=>assert.fail('O controller não deve substituir o contexto antes da seleção'),toast:text=>notices.push(text)
  });
  return {ui,state,channel,contact,opened,original,calls,selections,notices,modals,forms,modal,mountModal,form:()=>({dataset:{dialogForm:'contact-open'},isConnected:true,values:{contactId:contact.id,channelId:channel.id}})};
}

test('histórico usa só IDs da resposta autorizada e delega a seleção sem navegação ou envio antecipados',async t=>{
  const f=fixture(t);await f.ui.action('contact-history',f.contact.id);assert.ok(f.modals[0].markup.includes('case-contact'));
  await assert.rejects(f.ui.action('contact-conversation','case-invented'),/Abra o histórico/);assert.equal(f.selections.length,0);
  await f.ui.action('contact-conversation',f.opened.id);assert.deepEqual(f.selections,[{tenantId:'company-a',id:'case-contact'}]);assert.equal(f.modal.closed,true);assert.equal(f.state.search,'filtro conservado');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options,undefined);assert.equal(f.notices.length,0);
});

test('histórico atrasado de outra empresa não abre modal nem permite reaproveitar seu ID',async t=>{
  const wait=deferred(),f=fixture(t,{api:()=>wait.promise}),pending=f.ui.action('contact-history','contact-a');f.state.tenant={...f.state.tenant,id:'company-b'};
  wait.resolve({conversations:[{id:'case-contact'}]});await pending;assert.equal(f.modals.length,0);
  await assert.rejects(f.ui.action('contact-conversation','case-contact'),/Abra o histórico/);assert.equal(f.selections.length,0);assert.equal(f.state.conversation,'case-before');
});

test('histórico mais antigo não substitui pedido novo nem reaproveita IDs de outro contato',async t=>{
  const first=deferred(),second=deferred();let requests=0;const f=fixture(t,{api:()=>++requests===1?first.promise:second.promise});f.state.contacts.push({...f.contact,id:'contact-b',name:'Segundo contato'});
  const old=f.ui.action('contact-history','contact-a'),latest=f.ui.action('contact-history','contact-b');
  second.resolve({conversations:[{id:'case-b',channelId:'channel-a',status:'open'}]});await latest;first.resolve({conversations:[{id:'case-contact',channelId:'channel-a',status:'open'}]});await old;
  assert.equal(f.modals.length,1);assert.match(f.modals[0].markup,/case-b/);assert.doesNotMatch(f.modals[0].markup,/case-contact/);
  await assert.rejects(f.ui.action('contact-conversation','case-contact'),/Abra o histórico/);assert.equal(f.selections.length,0);
});

test('novo formulário de atendimento invalida o histórico que ainda está carregando',async t=>{
  const wait=deferred(),f=fixture(t,{api:()=>wait.promise}),pending=f.ui.action('contact-history','contact-a');await f.ui.action('contact-open','contact-a');
  wait.resolve({conversations:[{id:'case-contact'}]});await pending;assert.equal(f.modals.length,0);assert.equal(f.forms.length,1);assert.equal(f.state.view,'contacts');
});

for(const action of ['edit-contact','new-contact','new-department'])test('histórico pendente não substitui '+action+' nem seus campos digitados',async t=>{
  const wait=deferred(),f=fixture(t,{api:()=>wait.promise}),pending=f.ui.action('contact-history','contact-a');await f.ui.action(action,'contact-a');
  const editor=f.modal.firstElementChild;editor.fields.get('name').value='Nome ainda não salvo';
  const detail=editor.fields.get(action==='new-department'?'description':'notes');detail.value='Rascunho próprio ainda não salvo';
  wait.resolve({conversations:[{id:'case-contact',channelId:'channel-a',status:'open'}]});await pending;
  assert.equal(f.modal.firstElementChild,editor);assert.equal(editor.fields.get('name').value,'Nome ainda não salvo');assert.equal(detail.value,'Rascunho próprio ainda não salvo');assert.equal(f.modals.length,0);
  await assert.rejects(f.ui.action('contact-conversation','case-contact'),/Abra o histórico/);assert.equal(f.selections.length,0);assert.equal(f.state.conversation,'case-before');
});

test('formulário aberto por outro módulo também impede substituir o modal após GET atrasado',async t=>{
  const wait=deferred(),f=fixture(t,{api:()=>wait.promise}),pending=f.ui.action('contact-history','contact-a');
  const editor=f.mountModal('Outro módulo','<input name="name" value="Original"/><textarea name="notes">Original</textarea>','other');editor.fields.get('name').value='Nome digitado';editor.fields.get('notes').value='Notas digitadas';
  wait.resolve({conversations:[{id:'case-contact'}]});await pending;
  assert.equal(f.modal.firstElementChild,editor);assert.equal(editor.fields.get('name').value,'Nome digitado');assert.equal(editor.fields.get('notes').value,'Notas digitadas');assert.equal(f.modals.length,0);assert.equal(f.selections.length,0);
});

test('fechar o histórico cancela o contexto ainda pendente da seleção',async t=>{
  const wait=deferred(),f=fixture(t,{select:async({isCurrent})=>{await wait.promise;assert.equal(isCurrent(),false);}});
  await f.ui.action('contact-history','contact-a');const pending=f.ui.action('contact-conversation','case-contact');f.modal.close();wait.resolve();await pending;
  assert.equal(f.state.conversation,'case-before');assert.equal(f.state.view,'contacts');
});

test('Abrir atendimento reutiliza resposta exata, mantém origem e informa que a pessoa já é responsável',async t=>{
  const f=fixture(t);await f.ui.action('contact-open',f.contact.id);assert.ok(f.forms[0].markup.includes('name="contactId" value="contact-a"'));
  await f.ui.submit(f.form());assert.deepEqual(f.selections,[{tenantId:'company-a',id:'case-contact'}]);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].path,'/api/tenants/company-a/contacts/contact-a/open');assert.deepEqual(JSON.parse(f.calls[0].options.body),{channelId:'channel-a'});assert.equal(f.calls[0].options.headers['X-Elozi-Workspace'],'workspace-a');
  assert.match(f.notices[0],/já é responsável/);assert.doesNotMatch(f.notices[0],/Assuma/);assert.equal(f.state.search,'filtro conservado');assert.equal(f.modal.closed,true);
});

for(const [label,fresh,notice] of [
  ['fila',{owner:'queue',assignedUserId:null},/Assuma/],
  ['outro responsável',{assignedUserId:'other',assignedUserName:'Pessoa da equipe'},/observação\. Responsável: Pessoa da equipe/],
  ['colaborador',{assignedUserId:'other',attendanceAccess:{canReply:true}},/colaborar/],
  ['encerrado',{status:'closed'},/Histórico aberto.*encerrado/],
  ['responsável sem direito de responder',{attendanceAccess:{canReply:false}},/observação.*não permite responder/]
])test('toast de contato reflete estado fresco: '+label,async t=>{
  const f=fixture(t,{fresh});await f.ui.action('contact-open','contact-a');await f.ui.submit(f.form());assert.match(f.notices[0],notice);
});

for(const changed of ['workspace','tenant','authority','version','channel','id'])test('formulário obsoleto por '+changed+' não faz POST nem troca a seleção',async t=>{
  const f=fixture(t);await f.ui.action('contact-open','contact-a');const form=f.form();
  if(changed==='workspace')f.state.workspaceId='other';if(changed==='tenant')f.state.tenant={...f.state.tenant,id:'other'};
  if(changed==='authority')f.state.boot.session.permissions=['contacts.read'];if(changed==='version')f.contact.version++;
  if(changed==='channel')f.channel.state='disconnected';if(changed==='id')form.values.contactId='contact-invented';
  await assert.rejects(f.ui.submit(form),/Abra o atendimento/);assert.equal(f.calls.length,0);assert.equal(f.selections.length,0);assert.equal(f.state.conversation,'case-before');assert.equal(f.state.search,'filtro conservado');
});

for(const change of ['workspace','closed','detached'])test('POST de contato atrasado não redireciona quando '+change,async t=>{
  const wait=deferred(),f=fixture(t,{api:()=>wait.promise});await f.ui.action('contact-open','contact-a');const form=f.form(),pending=f.ui.submit(form);
  if(change==='workspace')f.state.workspaceId='other';if(change==='closed')f.modal.close();if(change==='detached')form.isConnected=false;
  wait.resolve(f.opened);await pending;assert.equal(f.selections.length,0);assert.equal(f.state.conversation,'case-before');assert.equal(f.state.view,'contacts');assert.equal(f.notices.length,0);
});

test('retorno POST de outro contato ou canal não entra na seleção e não emite toast de sucesso',async t=>{
  const f=fixture(t,{api:async()=>({id:'case-invented',contactId:'other',channelId:'other'})});await f.ui.action('contact-open','contact-a');
  await assert.rejects(f.ui.submit(f.form()),/não corresponde/);assert.equal(f.selections.length,0);assert.equal(f.state.conversation,'case-before');assert.equal(f.notices.length,0);
});

test('seleção bloqueada mantém formulário e não confirma abertura na interface',async t=>{
  const f=fixture(t,{select:async()=>undefined});await f.ui.action('contact-open','contact-a');await f.ui.submit(f.form());
  assert.equal(f.modal.closed,false);assert.equal(f.notices.length,0);assert.equal(f.state.conversation,'case-before');assert.equal(f.state.view,'contacts');
});

test('busy de outra operação impede POST e não libera a trava ou altera o formulário',async t=>{
  const f=fixture(t);await f.ui.action('contact-open','contact-a');const editor=f.modal.firstElementChild;f.state.busy=true;
  await assert.rejects(f.ui.submit(f.form()),/Aguarde a operação atual/);assert.equal(f.state.busy,true);assert.equal(f.calls.length,0);assert.equal(f.selections.length,0);assert.equal(f.modal.firstElementChild,editor);assert.equal(f.modal.closed,false);
});

test('toast usa detalhe atual quando responsabilidade mudou depois da seleção',async t=>{
  const f=fixture(t,{select:async({state,opened})=>{state.view='inbox';state.conversation=opened.id;state.tenant.conversations=[{...opened,assignedUserId:'other',assignedUserName:'Responsável atualizado',version:8}];return opened;}});
  await f.ui.action('contact-open','contact-a');await f.ui.submit(f.form());assert.match(f.notices[0],/Responsável atualizado/);assert.doesNotMatch(f.notices[0],/já é responsável|Assuma/);
});

const helperSource=excerpt('inbox-contact-authority');
function focusFixture(){
  const c={id:'older',contact:'Cliente próprio',channelId:'own-channel',status:'closed',owner:'human',assignedUserId:'person',messages:[{kind:'customer',text:'Mensagem pública'},{kind:'system',text:'Nota privada nunca na prévia'}]};
  const state={workspaceId:'workspace-a',tenant:{id:'company-a',name:'Empresa própria',channels:[{id:'own-channel',name:'Número próprio',state:'connected',transport:'baileys'}],conversations:[c]},conversation:c.id,search:'não corresponde',inboxCompany:'other',channel:'all',department:'all',assignedUser:'all',filter:'queue',status:'active',kind:'all',boot:{csrfToken:'synthetic-csrf',session:{userId:'person',role:'operator'},tenants:[{id:'company-a'}]}};
  const data={items:[{id:'another',tenantId:'other',contact:'Outro atendimento',updatedAt:'2026-10-03T12:00:00Z'}],total:81,offset:50,limit:50,hasMore:true,channels:[],assignees:[],countTabs:{all:81},counts:{closed:9}};
  const helpers=runInNewContext(helperSource+'\n({inboxContactAuthority,focusedContactConversation,consolidatedList})',{ ...i18n,
    state,inboxIdentity,selectedInboxRef:()=>({workspaceId:state.workspaceId,tenantId:state.tenant.id,conversationId:state.conversation}),channelFor:item=>state.tenant.channels.find(ch=>ch.id===item.channelId),inboxListMarkup,inboxListExtras:()=>({}),
    consolidatedInbox:{data,loading:false,error:''},escape,icon:()=>'',badge:value=>escape(value),avatarMarkup:()=>''
  });
  state.inboxContactFocus={authority:helpers.inboxContactAuthority(),ref:{workspaceId:state.workspaceId,tenantId:state.tenant.id,conversationId:c.id}};
  return {state,c,data,...helpers};
}

test('conversa antiga filtrada aparece como foco explícito sem alterar resultados, contagens ou pesquisa',()=>{
  const f=focusFixture(),html=f.consolidatedList();assert.match(html,/Atendimento aberto pelo contato/);assert.match(html,/Fora desta página ou dos filtros atuais/);assert.match(html,/data-conversation="older"/);assert.match(html,/aria-selected="true"/);
  assert.match(html,/Remover foco do contato/);assert.match(html,/value="não corresponde"/);assert.match(html,/51–51 de 81/);assert.equal(f.data.items.length,1);assert.equal(f.data.total,81);assert.equal(f.state.status,'active');assert.doesNotMatch(html,/Nota privada nunca/);
});

test('foco atualiza pelo detalhe fresco e não duplica linha já presente na página',()=>{
  const f=focusFixture();f.c.contact='<svg>Nome atualizado';let html=f.consolidatedList();assert.match(html,/&lt;svg&gt;Nome atualizado/);assert.doesNotMatch(html,/<svg>/);
  f.data.items=[{...f.focusedContactConversation()}];html=f.consolidatedList();assert.equal((html.match(/data-conversation="older"/g)||[]).length,1);assert.doesNotMatch(html,/Atendimento aberto pelo contato/);
});

for(const change of ['workspace','tenant','authority','conversation','revocation'])test('foco é invalidado ao mudar '+change,()=>{
  const f=focusFixture();if(change==='workspace')f.state.workspaceId='other';if(change==='tenant')f.state.tenant={...f.state.tenant,id:'other'};
  if(change==='authority')f.state.boot.session.permissions=[];if(change==='conversation')f.state.conversation='other';if(change==='revocation')f.state.tenant.conversations=[];
  assert.equal(f.focusedContactConversation(),null);assert.doesNotMatch(f.consolidatedList(),/Atendimento aberto pelo contato|Cliente próprio|Mensagem pública/);
});
