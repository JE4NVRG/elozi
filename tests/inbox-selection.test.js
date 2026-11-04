import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import * as i18n from '../public/i18n.js';
import { inboxIdentity } from '../public/consolidated-inbox-ui.js';
import { createWorkspaceUI } from '../public/workspace-ui.js';
import { attendanceReplyAccess, attendanceParticipantRole } from '../public/participants-ui.js';
import { readStateCommand, readSyncNotice } from '../public/attendance-read-ui.js';
import { excerpt } from './helpers/app-source.js';
import { conversationHash, hashForView } from '../public/nav-config.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const selectSource = excerpt('select-inbox-conversation'), dropSource = excerpt('drop-inbox-detail');

function fixture({ notes = [true, true], messages = [true, true], delayed = false, mediaAllowed=true, pending=false, view='inbox',selectionError } = {}) {
  const previous = { id: 'company-a', conversations: [{ id: 'case-a' }] };
  const state = { workspaceId: 'workspace', tenant: previous, conversation: 'case-a', view, inboxSelectionSequence: 0, busy: false,search:'filtro anterior',inboxCompany:'company-a',status:'active',boot:{csrfToken:'synthetic-csrf',session:{userId:'attendant',role:'operator',permissions:['inbox.read','inbox.reply']},tenants:[{id:'company-a'},{id:'company-b'}]} };
  const fields = { '#internal-note-text': { value: 'Nota somente da empresa A' }, '#message-text': { value: 'Mensagem da empresa A' } };
  const requests = [], notices = [], savedNotes = [], savedMessages = [],renders=[],listRefreshes=[],drops=[],drafts=new Map(),hashes=[],readCalls=[],location={hash:'#'+view};
  let finish;
  const result = { tenant: { id: 'company-b', conversations: [{ id: 'case-b',status:'open',owner:'human',assignedUserId:'attendant',version:7 }] }, ref: { conversationId: 'case-b' }, contacts: [], flows: [], assignees: [], metrics: null, mcpServers: [], mcpLoaded: false };
  const reset = { reset() {} }, refresh = { reset() {}, refresh: async () => {}, load: async () => {} };
  const authority=source.split('\n').find(line=>line.startsWith('const inboxContactAuthority='));assert.ok(authority);
  // excerpt('navigate') brings the served currentRouteHash (deep link of the open conversation).
  const select = runInNewContext(authority+'\n'+dropSource+'\n'+selectSource + '\n'+excerpt('navigate') + '\nselectInboxConversation', {
    ...i18n,
    state, $: name => fields[name] || null,
    selectedInboxRef: () => ({ workspaceId: state.workspaceId, tenantId: state.tenant.id, conversationId: state.conversation }),
    currentConversation:()=>state.tenant.conversations.find(item=>item.id===state.conversation),inboxIdentity,
    markConversationRead:conversation=>{readCalls.push({conversation,view:state.view,tenantId:state.tenant.id,busy:state.busy,rendered:renders.length>0});return new Promise(()=>{});},
    mediaUI: { sending: false, draft: '',retainConversations(){},forgetTenant(){},syncContext(){return mediaAllowed;} }, voiceRecorder: { busy: false,reset(){} }, participantsUI: reset,
    attendanceContext:()=>({userId:'attendant',workspaceId:'workspace',authorityKey:'own-access'}),blockPendingSend:()=>pending,
    noteDrafts: { key: 'case-a',reset(){}, save(value) { savedNotes.push(value); return notes.shift() ?? true; } },
    consolidatedInbox: {
      saveDraft(ref, value) { savedMessages.push(value);const saved=messages.shift()??true;if(saved)drafts.set(inboxIdentity(ref),value);return saved; },
      forgetTenant(id){drops.push(id);for(const key of drafts.keys())if(JSON.parse(key)[1]===id)drafts.delete(key);},
      data:{offset:50},async select(ref) { requests.push(ref); if (delayed) await new Promise(resolve => { finish = resolve; });if(selectionError)throw selectionError; return result; }
    },
    toast: message => notices.push(message), updateVoiceControls() {}, render() {renders.push({view:state.view,conversation:state.conversation,tenantId:state.tenant.id,search:state.search});},
    refreshInboxList:async options=>listRefreshes.push(options),location,conversationHash,hashForView,history:{state:null,replaceState(_state,_title,url){hashes.push(url);}},
    brandDrafts:reset,contactLinksUI:reset,contactRefresh:reset,memoryUI:reset,contactImportUI: reset,repliesUI:reset,conversationTools:reset,forwarding:reset,inboxTimeline:reset,automationUI: refresh, mcpUI: reset, resetScreens() {}, knowledgeUI: refresh, avatarUI: reset,
    Promise, JSON
  });
  return { select, state, previous, result,fields, requests, notices, savedNotes, savedMessages,renders,listRefreshes,drops,drafts,hashes,readCalls,location, finish: () => finish() };
}

test('limite de notas impede trocar empresa antes de buscar ou alterar o atendimento', async () => {
  const f = fixture({ notes: [false] });
  await f.select('company-b', 'case-b');
  assert.equal(f.requests.length, 0); assert.equal(f.state.tenant, f.previous); assert.equal(f.state.conversation, 'case-a');
  assert.equal(f.fields['#internal-note-text'].value, 'Nota somente da empresa A');
  assert.match(f.notices[0], /Limite de notas/);
  assert.equal(f.readCalls.length,0);
});

test('nota digitada enquanto a outra empresa carrega é conferida antes de substituir o contexto', async () => {
  const f = fixture({ notes: [true, false], delayed: true });
  const pending = f.select('company-b', 'case-b');
  f.fields['#internal-note-text'].value = 'Última alteração da nota A'; f.finish(); await pending;
  assert.equal(f.requests.length, 1); assert.equal(f.state.tenant, f.previous); assert.equal(f.state.conversation, 'case-a');
  assert.deepEqual(f.savedNotes, ['Nota somente da empresa A', 'Última alteração da nota A']);
  assert.equal(f.state.busy, false); assert.equal(f.state.inboxSelecting, false);
});

test('mensagem alterada durante carregamento também impede troca quando não pode ser guardada', async () => {
  const f = fixture({ messages: [true, false], delayed: true });
  const pending = f.select('company-b', 'case-b');
  f.fields['#message-text'].value = 'Última edição antes da troca'; f.finish(); await pending;
  assert.equal(f.state.tenant, f.previous); assert.equal(f.state.conversation, 'case-a');
  assert.deepEqual(f.savedMessages, ['Mensagem da empresa A', 'Última edição antes da troca']);
  assert.match(f.notices[0], /Limite de rascunhos/);
});

test('rascunhos guardados permitem trocar empresa e conversa como uma única seleção', async () => {
  const f = fixture(); await f.select('company-b', 'case-b');
  assert.equal(f.state.tenant.id, 'company-b'); assert.equal(f.state.conversation, 'case-b');
  assert.equal(f.requests.length, 1); assert.equal(f.notices.length, 0);
  assert.deepEqual(f.hashes, ['#inbox/company-b/case-b'], 'deep link da conversa aberta, sem nova entrada no histórico'); assert.equal(f.location.hash, '#inbox');
  assert.equal(f.readCalls.length,1,'a seleção usada pelo deep link também inicia a leitura');assert.equal(f.readCalls[0].conversation,f.result.tenant.conversations[0]);assert.equal(f.readCalls[0].busy,false);assert.equal(f.readCalls[0].rendered,true);
});

test('limite de arquivos impede commit da empresa nova e conserva a seleção atual',async()=>{
 const f=fixture({mediaAllowed:false});await f.select('company-b','case-b');
 assert.equal(f.state.tenant,f.previous);assert.equal(f.state.conversation,'case-a');assert.equal(f.requests.length,1);assert.match(f.notices[0],/Limite de rascunhos/);
});

test('envio sem confirmação não perde sua intenção ao clicar em outra empresa',async()=>{
 const f=fixture({pending:true});f.state.sendIntent={idempotencyKey:'original-command'};await f.select('company-b','case-b');
 assert.equal(f.requests.length,0);assert.equal(f.state.tenant,f.previous);assert.equal(f.state.conversation,'case-a');assert.equal(f.state.sendIntent.idempotencyKey,'original-command');
});

test('abrir pelo contato só aplica empresa, conversa e foco após detalhe fresco sem apagar os filtros ou rascunhos',async()=>{
 const f=fixture({view:'contacts',delayed:true}),pending=f.select('company-b','case-b',{fromContact:true});
 assert.equal(f.state.view,'contacts');assert.equal(f.state.tenant,f.previous);assert.equal(f.state.conversation,'case-a');assert.equal(f.state.inboxContactFocus,undefined);assert.equal(f.renders.length,0);
 f.fields['#message-text'].value='Última edição da origem';f.finish();const selected=await pending;
 assert.equal(selected,f.result.tenant.conversations[0]);assert.equal(selected.version,7);assert.equal(f.state.view,'inbox');assert.equal(f.state.conversation,'case-b');assert.equal(f.state.tenant.id,'company-b');
 assert.equal(f.state.search,'filtro anterior');assert.equal(f.state.inboxCompany,'company-a');assert.equal(f.state.status,'active');
 assert.equal(f.state.inboxContactFocus.ref.tenantId,'company-b');assert.equal(f.state.inboxContactFocus.ref.conversationId,'case-b');
 assert.deepEqual(f.savedMessages,['Mensagem da empresa A','Última edição da origem']);assert.equal(f.listRefreshes[0].offset,50);assert.equal(f.renders.length,1);
 assert.equal(f.location.hash,'#inbox/company-b/case-b','vindo de Contatos, a navegação cria a entrada de histórico com o deep link');assert.deepEqual(f.hashes,[]);
 assert.equal(f.readCalls.length,1);assert.equal(f.readCalls[0].conversation,selected);assert.equal(f.readCalls[0].view,'inbox');assert.equal(f.readCalls[0].busy,false);
});

for(const failure of ['notes','messages','media','pending'])test('abertura pelo contato preserva a tela/filtros quando bloqueada por '+failure,async()=>{
 const f=fixture({view:'contacts',...(failure==='notes'?{notes:[false]}:failure==='messages'?{messages:[false]}:failure==='media'?{mediaAllowed:false}:{pending:true})});
 assert.equal(await f.select('company-b','case-b',{fromContact:true}),undefined);assert.equal(f.state.view,'contacts');assert.equal(f.state.tenant,f.previous);assert.equal(f.state.conversation,'case-a');assert.equal(f.state.search,'filtro anterior');assert.equal(f.state.inboxContactFocus,undefined);assert.equal(f.renders.length,0);
 assert.equal(f.readCalls.length,0,'um contato bloqueado não confirma leitura');
});

for(const change of ['view','workspace','authority','cancel'])test('resposta de contato atrasada não navega após mudar '+change,async()=>{
 const f=fixture({view:'contacts',delayed:true});let active=true;const pending=f.select('company-b','case-b',{fromContact:true,isCurrent:()=>active});
 if(change==='view')f.state.view='overview';if(change==='workspace')f.state.workspaceId='other';if(change==='authority')f.state.boot.session.permissions=[];if(change==='cancel')active=false;
 f.finish();assert.equal(await pending,undefined);assert.equal(f.state.tenant,f.previous);assert.equal(f.state.conversation,'case-a');assert.equal(f.state.search,'filtro anterior');assert.equal(f.state.inboxContactFocus,undefined);assert.equal(f.renders.length,0);
 assert.equal(f.readCalls.length,0,'a resposta obsoleta não confirma leitura de outra seleção');
});

test('abrir pelo contato a conversa já selecionada busca novamente a versão e o responsável atuais',async()=>{
 const f=fixture({view:'contacts'});f.result.tenant={id:'company-a',conversations:[{id:'case-a',version:9,status:'open',owner:'human',assignedUserId:'other'}]};f.result.ref={conversationId:'case-a'};
 const current=await f.select('company-a','case-a');assert.equal(current,f.previous.conversations[0]);assert.equal(f.requests.length,0);
 const fresh=await f.select('company-a','case-a',{fromContact:true});assert.equal(f.requests.length,1);assert.equal(fresh.version,9);assert.equal(fresh.assignedUserId,'other');assert.equal(f.state.view,'inbox');assert.equal(f.state.inboxContactFocus.ref.conversationId,'case-a');
 assert.equal(f.readCalls.at(-1).conversation,fresh,'o hook recebe o responsável fresco, sem usar o cache');
});

for(const status of [403,404])for(const change of ['cancel','authority','view','refresh'])test('rejeição '+status+' atrasada não apaga detalhe/rascunho nem mostra toast após '+change,async()=>{
 const f=fixture({view:'contacts',delayed:true,selectionError:Object.assign(new Error('Acesso sintético negado'),{status})});let active=true;
 const operation=f.select('company-a','case-b',{fromContact:true,isCurrent:()=>active}),draft=[...f.drafts.entries()];
 if(change==='cancel')active=false;if(change==='authority')f.state.boot.session.permissions=[];if(change==='view')f.state.view='overview';if(change==='refresh')f.state.refreshSequence++;
 f.finish();assert.equal(await operation,undefined);assert.equal(f.state.tenant,f.previous);assert.equal(f.state.conversation,'case-a');assert.deepEqual([...f.drafts.entries()],draft);assert.equal(f.fields['#internal-note-text'].value,'Nota somente da empresa A');assert.equal(f.fields['#message-text'].value,'Mensagem da empresa A');assert.deepEqual(f.drops,[]);assert.deepEqual(f.notices,[]);assert.equal(f.renders.length,0);
});

test('rejeição atual ainda invalida detalhe e avisa sobre acesso negado',async()=>{
 const f=fixture({selectionError:Object.assign(new Error('Acesso sintético negado'),{status:403})});await f.select('company-a','case-b');
 assert.deepEqual(f.hashes,[],'seleção recusada não grava deep link');assert.equal(f.location.hash,'#inbox');
 assert.deepEqual(f.drops,['company-a']);assert.equal(f.state.conversation,null);assert.equal(f.drafts.size,0);assert.match(f.notices[0],/Acesso sintético negado/);
});

test('handler real do modal abre contato usando seleção real sem adquirir ou driblar busy global',async t=>{
 const f=fixture({view:'contacts'}),closeHandlers=[],calls=[];let submitHandler;
 const priorDocument=globalThis.document,priorFormData=globalThis.FormData;
 const modal={firstElementChild:null,closed:false,addEventListener(name,fn){if(name==='close')closeHandlers.push(fn);if(name==='submit')submitHandler=fn;},close(){this.closed=true;for(const fn of closeHandlers)fn();}};
 globalThis.document={addEventListener(){},querySelector:selector=>selector==='#modal'?modal:null};
 globalThis.FormData=class{constructor(form){this.values=Object.entries(form.values);}[Symbol.iterator](){return this.values[Symbol.iterator]();}};
 t.after(()=>{globalThis.document=priorDocument;globalThis.FormData=priorFormData;});
 const channel={id:'channel-a',transport:'baileys',state:'connected',name:'Origem própria'},contact={id:'contact-a',version:4,name:'Contato próprio',phone:'11900000000'};
 const opened={id:'case-b',version:7,status:'open',owner:'human',assignedUserId:'attendant',contactId:contact.id,channelId:channel.id};
 f.state.contacts=[contact];f.state.tenant.channels=[channel];f.result.tenant={id:'company-a',channels:[channel],conversations:[opened]};
 const ui=createWorkspaceUI({state:f.state,escape:value=>String(value??''),hasPermission:permission=>f.state.boot.session.permissions.includes(permission),
   formModal(){modal.firstElementChild={};},openModal(){assert.fail('Nenhum outro modal é necessário');},
   api:async(path,options)=>{calls.push({path,options});assert.equal(f.state.busy,false,'O handler #modal não adquire busy antes do controller');return opened;},
   openContactConversation:(tenantId,id,isCurrent)=>f.select(tenantId,id,{fromContact:true,isCurrent}),canReplyTo:c=>attendanceReplyAccess(c,{userId:f.state.boot.session.userId,hasPermission:true}),toast:message=>f.notices.push(message)
 });
 const noop={submit:async()=>false};runInNewContext(excerpt('modal-submit'),{ ...i18n,$:()=>modal,state:f.state,workspaceUI:ui,contactLinksUI:noop,knowledgeUI:noop,memoryUI:noop,mcpUI:noop,accountSecurityUI:noop,automationUI:noop});
 await ui.action('contact-open',contact.id);
 const submit={disabled:false},error={textContent:''},form={dataset:{dialogForm:'contact-open'},isConnected:true,values:{contactId:contact.id,channelId:channel.id},matches:()=>false,querySelector:selector=>selector==='[type="submit"]'?submit:error};let prevented=false;
 await submitHandler({target:form,preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(calls.length,1);assert.equal(f.requests.length,1);assert.equal(f.state.view,'inbox');assert.equal(f.state.conversation,opened.id);assert.equal(f.state.busy,false);assert.equal(modal.closed,true);assert.match(f.notices[0],/já é responsável/);assert.equal(submit.disabled,false);assert.equal(error.textContent,'');
});

// Atendimento v2 (P3): the read receipt of opening and the "Reabrir" of the Encerrar toast, run from the
// real functions of app.js (sliced by name).
const appFunction = (marker, name) => { const start = source.indexOf(marker), end = source.indexOf('\n}\n', start); assert.ok(start >= 0 && end > start, name); return source.slice(start, end + 2) + '\n' + name; };

test('abrir marca como lida só para o responsável; admin, fila, colaboração e suporte só olham', async () => {
  const open = (conversation, { role = 'operator', supportGrantId = null, permissions = ['inbox.read', 'inbox.reply'], runs = [], channels = [], hidden = false } = {}) => {
    const requests = [];
    const state = { view:'inbox',workspaceId:'workspace',conversation:conversation.id,busy: false, supportGrantId, tenant: { id:'tenant',runs,conversations:[conversation] }, boot: { session: { userId: 'me', role, permissions } } };
    const mark = runInNewContext(excerpt('inbox-read-receipts')+'\nmarkConversationRead', {
      state, document: { visibilityState: hidden ? 'hidden' : 'visible',addEventListener(){} }, readStateCommand, readSyncNotice, toast() {},live:{kick(){}},
      $:()=>null,currentConversation:()=>state.tenant.conversations.find(c=>c.id===state.conversation),
      mediaUI:{sending:false},voiceRecorder:{busy:false},
      readDeviceContext: () => ({ userId: 'me', channels, supportGrantId }),
      activeRunStates: new Set(['queued', 'running', 'waiting_approval']), hasPermission: name => role === 'reseller' || permissions.includes(name),
      attendanceRole: c => attendanceParticipantRole(c, { userId: 'me' }), captureAttendance: () => ({ version: conversation.version }), applyAttendance() {},
      attendanceRequest: async (_context, tail, options) => { requests.push([tail, JSON.parse(options.body)]); return { ...conversation, unread: 0 }; } });
    return mark(conversation).then(result => ({ result, requests }));
  };
  const mine = { id: 'case-a', version: 3, status: 'open', owner: 'human', assignedUserId: 'me', unread: 2 };
  assert.deepEqual(await open(mine), { result: true, requests: [['read-state', { version: 3, unread: false }]] });
  assert.deepEqual(await open({ ...mine, channelId: 'wa' }, { channels: [{ id: 'wa', kind: 'whatsapp_qr', transport: 'baileys' }] }),
    { result: true, requests: [['read-state', { version: 3, unread: false, syncDevice: true }]] });
  for (const [label, conversation, options] of [
    ['admin olhando o atendimento de outra pessoa', { ...mine, assignedUserId: 'other' }, { role: 'reseller' }],
    ['conversa da fila', { ...mine, owner: 'queue', assignedUserId: null }, {}],
    ['colaboração', { ...mine, assignedUserId: 'other', attendanceAccess: { canReply: true } }, {}],
    ['com o agente', { ...mine, owner: 'agent', assignedUserId: null }, { role: 'reseller' }],
    ['sessão de suporte', mine, { supportGrantId: 'grant-1' }],
    ['aba em segundo plano', mine, { hidden: true }],
    ['rascunho do agente na versão atual', mine, { runs: [{ conversationId: 'case-a', state: 'draft', conversationVersion: 3 }] }]
  ]) assert.deepEqual(await open(conversation, options), { result: false, requests: [] }, label);
});

test('"Reabrir" do toast reabre a conversa encerrada mesmo com outra aberta, e recusa outro acesso', async () => {
  const requests = [], toasts = [], refreshes = [];
  const state = { view: 'inbox', workspaceId: 'w', supportGrantId: null, conversation: 'case-b', boot: { session: { userId: 'me' } },
    tenant: { id: 't', conversations: [{ id: 'case-a', status: 'closed', version: 5 }, { id: 'case-b', status: 'open', version: 9 }] } };
  const reopen = runInNewContext(appFunction('let reopening=false;', 'reopenClosed'), { ...i18n, state,
    api: async (path, options) => { requests.push([path, options.headers['X-Elozi-Workspace'], JSON.parse(options.body)]); return { id: 'case-a', status: 'open', version: 6 }; },
    applyAttendance() { assert.fail('a conversa aberta agora é outra'); }, render() { assert.fail('sem redesenho da conversa aberta'); },
    toast: message => toasts.push(message), refreshInboxList: async () => refreshes.push('list'), consolidatedInbox: { data: { offset: 0 } } });
  const context = { key: JSON.stringify(['me', 'w', null, 't', 'case-a', 'channel-a']), base: '/api/tenants/t/conversations/case-a', workspaceId: 'w', tenantId: 't' };
  await reopen(context, { id: 'case-a', version: 5 });
  assert.deepEqual(requests, [['/api/tenants/t/conversations/case-a/details', 'w', { status: 'open', version: 5 }]], 'reabre A, nunca a conversa aberta (B)');
  assert.equal(state.tenant.conversations[0].status, 'open'); assert.equal(state.conversation, 'case-b'); assert.deepEqual(refreshes, ['list']); assert.deepEqual(toasts, ['Atendimento reaberto.']);
  state.workspaceId = 'other';
  await assert.rejects(reopen(context, { id: 'case-a', version: 6 }), /O atendimento mudou/); assert.equal(requests.length, 1, 'outro acesso não envia nada');
});
