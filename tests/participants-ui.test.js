import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceReplyAccess, attendanceParticipantRole, attendanceManagementAccess, participantsContextKey,
  normalizeParticipantsSnapshot, participantsMarkup, createParticipantsUI } from '../public/participants-ui.js';
import { createAvatarUI } from '../public/avatar-ui.js';

const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
const avatarHTML = person => createAvatarUI({ escape: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])), context: () => ({}) }).markup(person.name, person.avatar, 'participants-avatar ' + person.kind);

const context = extra => ({ active:true,workspaceId:'workspace',tenantId:'tenant',userId:'owner',conversationId:'conversation',channelId:'channel',version:4,authorityKey:'session',canReply:true,canManageParticipants:true,...extra });
const conversation = extra => ({ id:'conversation',channelId:'channel',version:4,status:'open',owner:'human',assignedUserId:'owner',assignedUserName:'Pessoa responsável',messages:[],...extra });
const snapshot = extra => ({ responsible:{id:'owner',name:'Pessoa responsável'},participants:[{userId:'member',name:'Pessoa colaboradora',addedAt:'2026-10-02T12:00:00Z',addedByUserId:'owner'}],eligible:[{id:'candidate',name:'Pessoa elegível'}],canManage:true,version:4,...extra });
const decode = value => String(value || '').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

// Small modal adapter, with real node replacement semantics, without a browser.
function modalAdapter(){
  const modal={open:false,panel:null,closeCount:0,ownerDocument:{activeElement:null},querySelector(){return this.panel;},close(){this.open=false;this.closeCount++;}};
  const openModal=(title,description,html)=>{
    const panel={dataset:{participantsToken:decode(html.match(/data-participants-token="([^"]*)"/)[1]),participantsContextKey:decode(html.match(/data-participants-context-key="([^"]*)"/)[1])},controls:{},contains:node=>Boolean(node&&node.panel===panel&&!node.expired)};
    const body={markup:'',get innerHTML(){return this.markup;},set innerHTML(value){
      for(const node of Object.values(panel.controls))node.expired=true;
      this.markup=value;panel.controls={};
      const control=(id,value)=>({id,value,panel,disabled:false,focus(){modal.ownerDocument.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}});
      if(value.includes('data-participants-form')){
        const selected=value.match(/<option value="([^"]*)" selected>/)?.[1]||'';
        panel.controls.user=control('participant-user',decode(selected));
        panel.controls.reason=control('participant-reason',decode(value.match(/id="participant-reason"[^>]*value="([^"]*)"/)?.[1]));
        panel.controls.form={panel,dataset:{participantsToken:panel.dataset.participantsToken,version:value.match(/data-version="(\d+)"/)[1]},hasAttribute:name=>name==='data-participants-form',elements:{namedItem:name=>name==='userId'?panel.controls.user:panel.controls.reason}};
      }
    }};
    panel.querySelector=selector=>selector==='[data-participants-body]'?body:selector==='[data-participant-user]'||selector==='#participant-user'?panel.controls.user:selector==='[data-participant-reason]'||selector==='#participant-reason'?panel.controls.reason:null;
    panel.body=body;modal.panel=panel;modal.open=true;modal.title=title;modal.description=description;
  };
  return {modal,openModal};
}
function setup(extra={}){
  const {modal,openModal}=modalAdapter(),state={context:context(extra.context),snapshot:snapshot(extra.snapshot)},requests=[],applied=[],errors=[];
  const request=async(path,options)=>{
    requests.push({path,options});if(extra.request)return extra.request(path,options,state);
    if(options.method==='GET')return structuredClone(state.snapshot);
    const input=JSON.parse(options.body);state.snapshot.version++;
    if(input.action==='add'){const person=state.snapshot.eligible.find(item=>item.id===input.userId);state.snapshot.participants.push({userId:person.id,name:person.name});state.snapshot.eligible=state.snapshot.eligible.filter(item=>item.id!==person.id);}
    else state.snapshot.participants=state.snapshot.participants.filter(item=>item.userId!==input.userId);
    return conversation({version:state.snapshot.version,attendanceAccess:{canReply:true,canManageParticipants:true}});
  };
  const ui=createParticipantsUI({getContext:()=>state.context,request,openModal,getModal:()=>modal,avatarHTML:extra.avatarHTML,onRender:extra.onRender,
    applyConversation:value=>{applied.push(value);state.context.version=value.version;state.context.canReply=value.attendanceAccess?.canReply;state.context.canManageParticipants=value.attendanceAccess?.canManageParticipants;},onError:value=>errors.push(value)});
  return {ui,state,modal,requests,applied,errors};
}
function removeTarget(env,userId='member',extra={}){return {panel:env.modal.panel,dataset:{participantsAction:'remove',participantsToken:env.modal.panel.dataset.participantsToken,version:String(env.state.snapshot.version),userId,...extra}};}
function addForm(env,userId='candidate',reason=''){
  const {controls}=env.modal.panel;controls.user.value=userId;controls.reason.value=reason;return controls.form;
}

test('responsável e colaborador usam raster autorizado após render assíncrono; revogados mantêm iniciais', async () => {
  let rendered = 0;
  const env = setup({ avatarHTML, onRender: () => rendered++, snapshot: { responsible: { id: 'owner', name: '<Pessoa QA>', avatar: photo }, participants: [{ userId: 'member', name: 'Colaborador', avatar: photo }, { userId: 'revoked', name: 'Acesso removido', avatar: photo, eligible: false }] } });
  await env.ui.open(); const html = env.modal.panel.body.innerHTML;
  assert.equal((html.match(/<img src=/g) || []).length, 2); assert.match(html, /&lt;Pessoa QA&gt;/); assert.match(html, /Acesso indisponível/); assert.ok(rendered > 0);
  const safe = normalizeParticipantsSnapshot(snapshot({ responsible: { id: 'owner', avatar: photo, eligible: false }, participants: [{ userId: 'member', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }], eligible: [{ id: 'candidate', avatar: 'https://untrusted.test/avatar.png' }] }));
  assert.equal(safe.responsible.avatar, null); assert.equal(safe.participants[0].avatar, null); assert.equal(safe.eligible[0].avatar, null); assert.doesNotMatch(participantsMarkup(safe, { avatarHTML }), /<img|untrusted/);
});

test('fotografia de resposta tardia não permanece em outra empresa ou autoridade', async () => {
  for (const change of [{ tenantId: 'other' }, { authorityKey: 'revoked' }]) {
    const gate = deferred(), env = setup({ avatarHTML, request: () => gate.promise }), opening = env.ui.open(), oldPanel = env.modal.panel;
    Object.assign(env.state.context, change); env.ui.sync(); gate.resolve(snapshot({ responsible: { id: 'owner', name: 'Foto privada antiga', avatar: photo } })); await opening;
    assert.equal(env.modal.open, false); assert.doesNotMatch(oldPanel.body.innerHTML, /<img|Foto privada antiga/);
  }
});

test('acesso projetado pelo servidor prevalece; participantes brutos nunca concedem resposta',()=>{
  assert.equal(attendanceReplyAccess(conversation({attendanceAccess:{canReply:false}}),{userId:'owner',hasPermission:true}),false);
  assert.equal(attendanceReplyAccess(conversation({assignedUserId:'owner',attendanceAccess:{canReply:true}}),{userId:'member'}),true);
  assert.equal(attendanceReplyAccess(conversation({participants:[{userId:'member'}]}),{userId:'member',hasPermission:true}),false);
  assert.equal(attendanceReplyAccess(conversation(),{userId:'owner',hasPermission:true}),true);
  for(const extra of [{selecting:true},{userId:'someone'},{hasPermission:false}])assert.equal(attendanceReplyAccess(conversation(),{userId:'owner',hasPermission:true,...extra}),false);
  assert.equal(attendanceReplyAccess(conversation({status:'closed',attendanceAccess:{canReply:true}}),{userId:'member'}),false);
});
test('papel e gestão separam responsável, colaborador e observador',()=>{
  const c=conversation({attendanceAccess:{canReply:true},participants:[{userId:'member'}]});
  assert.equal(attendanceParticipantRole(c,{userId:'owner'}),'responsible');
  assert.equal(attendanceParticipantRole(c,{userId:'member'}),'collaborator');
  assert.equal(attendanceManagementAccess(c,{userId:'member',hasPermission:true}),false);
  assert.equal(attendanceManagementAccess(c,{userId:'owner',hasPermission:true}),true);
  assert.equal(attendanceManagementAccess(c,{userId:'manager',role:'reseller',hasPermission:true}),true);
  assert.equal(attendanceParticipantRole(conversation({participants:[{userId:'member'}]}),{userId:'member'}),'observer');
});
test('chave inclui workspace, empresa, usuário, conversa, canal e autoridade',()=>{
  const base=participantsContextKey(context());
  for(const field of ['workspaceId','tenantId','userId','conversationId','channelId','authorityKey'])assert.notEqual(participantsContextKey(context({[field]:'changed'})),base);
  for(const field of ['workspaceId','tenantId','userId','conversationId','channelId'])assert.equal(participantsContextKey(context({[field]:''})), '');
  assert.equal(participantsContextKey(context({active:false})), '');assert.equal(participantsContextKey(context({selecting:true})), '');
});
test('snapshot elimina duplicatas, responsável da lista e metadata não necessária',()=>{
  const safe=normalizeParticipantsSnapshot(snapshot({participants:[{userId:'owner',name:'Duplicado'},{userId:'member',name:'Uma pessoa',permissions:['admin'],eligible:false},{userId:'member',name:'Outra pessoa'}],eligible:[{id:'member',name:'Já está'},{id:'candidate',name:'Disponível',credential:'secret'},{id:'candidate'}]}));
  assert.equal(safe.participants.length,1);assert.equal(safe.eligible.length,1);assert.equal(safe.participants[0].eligible,false);
  assert.equal('permissions' in safe.participants[0],false);assert.equal('credential' in safe.eligible[0],false);
  assert.deepEqual(normalizeParticipantsSnapshot(snapshot({canManage:false})).eligible,[]);
  for(const extra of [{version:0},{version:1.5},{version:'4'},{canManage:'true'},{participants:null},{eligible:null}])assert.throws(()=>normalizeParticipantsSnapshot(snapshot(extra)));
});
test('nomes persistidos/elegíveis, IDs, razão e mensagens são escapados em todos os atributos',()=>{
  const name='<img src=x onerror="boom">',safe=normalizeParticipantsSnapshot(snapshot({responsible:{id:'owner',name},participants:[{userId:'member" onclick="boom',name,eligible:false}],eligible:[{id:'candidate"',name}]}));
  const html=participantsMarkup(safe,{token:'" data-action="run-agent',reason:'"/><script>boom</script>',error:'<b>Erro</b>',status:'<i>ok</i>'});
  assert.equal(html.includes('<img'),false);assert.equal(html.includes('<script>'),false);assert.match(html,/&lt;img/);assert.match(html,/&lt;b&gt;Erro/);assert.match(html,/Acesso indisponível/);assert.match(html,/data-participants-action="remove"/);
  assert.equal(html.includes('data-action="run-agent"'),false);
});
test('consulta é readonly sem form, candidatos ou botões de remoção',()=>{
  const html=participantsMarkup(normalizeParticipantsSnapshot(snapshot({canManage:false})),{});
  assert.match(html,/Pessoa responsável/);assert.match(html,/Pessoa colaboradora/);assert.match(html,/consultando os participantes/);
  assert.doesNotMatch(html,/data-participants-form|data-participants-action|Pessoa elegível/);
});
test('GET usa endpoint codificado, header capturado e exibe carregamento imediato',async()=>{
  const gate=deferred(),env=setup({context:{tenantId:'a/b',conversationId:'c?d'},request:()=>gate.promise}),opening=env.ui.open();
  assert.match(env.modal.panel.body.innerHTML,/Conferindo acesso/);assert.equal(env.requests[0].path,'/api/tenants/a%2Fb/conversations/c%3Fd/participants');assert.equal(env.requests[0].options.headers['X-Elozi-Workspace'],'workspace');
  gate.resolve(snapshot());assert.equal(await opening,true);assert.equal(env.ui.opened,true);assert.equal(env.ui.busy,false);
});
for(const change of [{workspaceId:'other'},{tenantId:'other'},{userId:'other'},{conversationId:'other'},{channelId:'other'},{authorityKey:'other'},{active:false},{selecting:true}])test(`GET tardio não exibe dados após trocar ${Object.keys(change)[0]}`,async()=>{
  const gate=deferred(),env=setup({request:()=>gate.promise}),opening=env.ui.open();Object.assign(env.state.context,change);env.ui.sync();gate.resolve(snapshot({responsible:{id:'other',name:'Nunca renderizar'}}));
  assert.equal(await opening,false);assert.equal(env.ui.opened,false);assert.equal(env.applied.length,0);assert.doesNotMatch(env.modal.panel.body.innerHTML,/Nunca renderizar/);assert.equal(env.requests[0].options.signal.aborted,true);
});
test('fechar e reabrir isola respostas de loaders sem fechar o modal novo',async()=>{
  const first=deferred(),second=deferred();let call=0;const env=setup({request:()=>++call===1?first.promise:second.promise});
  const old=env.ui.open(),fresh=env.ui.open();second.resolve(snapshot({responsible:{id:'owner',name:'Lista nova'}}));await fresh;
  first.resolve(snapshot({responsible:{id:'owner',name:'Lista antiga'}}));assert.equal(await old,false);assert.match(env.modal.panel.body.innerHTML,/Lista nova/);assert.doesNotMatch(env.modal.panel.body.innerHTML,/Lista antiga/);assert.equal(env.modal.open,true);
});
test('modal substituído e saída de sessão não recebem atualizações atrasadas',async()=>{
  const gate=deferred(),env=setup({request:()=>gate.promise}),opening=env.ui.open();env.modal.panel={dataset:{},body:{innerHTML:'Outro modal'}};env.ui.reset();gate.resolve(snapshot());await opening;
  assert.equal(env.modal.open,true);assert.equal(env.modal.panel.body.innerHTML,'Outro modal');assert.equal(env.applied.length,0);
});
test('POST só aplica conversa validada e então atualiza participantes com a nova versão',async()=>{
  const env=setup();await env.ui.open();await env.ui.submit(addForm(env,'candidate','  Apoio sintético  '));
  assert.deepEqual(JSON.parse(env.requests[1].options.body),{version:4,action:'add',userId:'candidate',reason:'Apoio sintético'});assert.equal(env.applied.length,1);assert.equal(env.state.context.version,5);assert.equal(env.requests[2].options.method,'GET');
  assert.match(env.modal.panel.body.innerHTML,/Colaborador adicionado/);assert.equal(env.modal.panel.controls.reason.value,'');
});
test('remover usa somente participante persistido e nunca aceita o responsável',async()=>{
  const env=setup();await env.ui.open();await env.ui.handleAction(removeTarget(env,'owner'));assert.equal(env.requests.length,1);assert.equal(env.applied.length,0);
  await env.ui.handleAction(removeTarget(env));assert.deepEqual(JSON.parse(env.requests[1].options.body),{version:4,action:'remove',userId:'member'});assert.equal(env.applied.length,1);
});
test('observador não produz POST mesmo com um controle forjado',async()=>{
  const env=setup({context:{canReply:false,canManageParticipants:false},snapshot:{canManage:false}});await env.ui.open();await env.ui.handleAction(removeTarget(env));
  assert.equal(env.requests.length,1);assert.equal(env.applied.length,0);assert.match(env.modal.panel.body.innerHTML,/apenas consultar/);
});
test('identidade de modal ou versão do controle desatualizada bloqueia POST',async()=>{
  for(const extra of [{participantsToken:'old'},{version:'3'}]){
    const env=setup();await env.ui.open();await env.ui.handleAction(removeTarget(env,'member',extra));assert.equal(env.requests.filter(item=>item.options.method==='POST').length,0);
  }
});
test('duplo clique durante POST produz uma só alteração',async()=>{
  const post=deferred(),env=setup({request:(_,options)=>options.method==='POST'?post.promise:snapshot()});await env.ui.open();
  const target=removeTarget(env),saving=env.ui.handleAction(target);await env.ui.handleAction(target);assert.equal(env.requests.filter(item=>item.options.method==='POST').length,1);
  post.resolve(conversation({version:5,attendanceAccess:{canReply:true,canManageParticipants:true}}));await saving;assert.equal(env.applied.length,1);
});
test('POST tardio após troca de empresa/conversa não aplica nem recarrega dados',async()=>{
  const post=deferred(),env=setup({request:(_,options)=>options.method==='POST'?post.promise:snapshot()});await env.ui.open();const saving=env.ui.handleAction(removeTarget(env));
  env.state.context.tenantId='other';env.state.context.conversationId='other';env.ui.sync();post.resolve(conversation({version:5}));await saving;
  assert.equal(env.applied.length,0);assert.equal(env.requests.length,2);assert.equal(env.ui.opened,false);
});
test('revogação durante POST é revalidada antes de aplicar, mesmo sem sync prévio',async()=>{
  for(const field of ['canReply','canManageParticipants']){
    const post=deferred(),env=setup({request:(_,options)=>options.method==='POST'?post.promise:snapshot()});await env.ui.open();const saving=env.ui.handleAction(removeTarget(env));
    env.state.context[field]=false;post.resolve(conversation({version:5,attendanceAccess:{canReply:true,canManageParticipants:true}}));await saving;
    assert.equal(env.applied.length,0);assert.equal(env.requests.length,2);assert.equal(env.ui.opened,false);
  }
});
test('revogação durante GET não apresenta um roster de gestão antigo',async()=>{
  const get=deferred(),env=setup({request:()=>get.promise}),opening=env.ui.open();env.state.context.canManageParticipants=false;get.resolve(snapshot());await opening;
  assert.equal(env.ui.opened,false);assert.doesNotMatch(env.modal.panel.body.innerHTML,/data-participants-form/);
});
test('resposta de alteração com ID/canal/revisão diferente nunca é aplicada',async()=>{
  for(const mismatch of [{id:'other'},{channelId:'other'},{version:3}]){
    const env=setup({request:(_,options)=>options.method==='POST'?conversation(mismatch):snapshot()});await env.ui.open();await env.ui.handleAction(removeTarget(env));assert.equal(env.applied.length,0);
  }
});
test('revogação via poll fecha modal e mantém dados de lista fora da autoridade',async()=>{
  const env=setup();await env.ui.open();env.state.context.canReply=false;env.ui.sync();assert.equal(env.ui.opened,false);
  const manager=setup();await manager.ui.open();manager.state.context.canManageParticipants=false;manager.ui.sync();assert.equal(manager.ui.opened,false);
});
test('versão de poll nova atualiza a lista e preserva o campo ativo/cursor',async()=>{
  const env=setup();await env.ui.open();const reason=env.modal.panel.controls.reason;reason.value='Contexto ainda em edição';reason.selectionStart=7;reason.selectionEnd=9;reason.focus();
  env.state.context.version=5;env.state.snapshot.version=5;env.ui.sync();await Promise.resolve();await Promise.resolve();
  assert.equal(env.modal.panel.controls.reason.value,'Contexto ainda em edição');assert.equal(env.modal.ownerDocument.activeElement.id,'participant-reason');assert.equal(env.modal.ownerDocument.activeElement.selectionStart,7);assert.equal(env.modal.ownerDocument.activeElement.selectionEnd,9);
});
test('401/403/404 interrompem o modal sem retries de mutação',async()=>{
  for(const status of [401,403,404]){
    const env=setup({request:()=>Promise.reject(Object.assign(new Error('Acesso indisponível'),{status}))});assert.equal(await env.ui.open(),false);assert.equal(env.ui.opened,false);assert.equal(env.requests.length,1);assert.deepEqual(env.errors,['Acesso indisponível']);
  }
});
test('GET anterior à versão local não habilita edição',async()=>{
  const env=setup({context:{version:5}});assert.equal(await env.ui.open(),false);assert.doesNotMatch(env.modal.panel.body.innerHTML,/data-participants-form/);assert.equal(env.applied.length,0);
});
