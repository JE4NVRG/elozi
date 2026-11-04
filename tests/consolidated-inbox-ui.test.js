import * as i18n from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createConsolidatedInboxUI, consolidatedListMarkup, inboxIdentity, inboxQuery } from '../public/consolidated-inbox-ui.js';
import { attendanceReplyAccess, attendanceParticipantRole, attendanceManagementAccess } from '../public/participants-ui.js';
import { channelCapabilities, conversationCapabilities, textLength } from '../public/channel-capabilities.js';
import { createMediaUI } from '../public/media-ui.js';
import { createSendIntent } from '../public/send-intent.js';
import { excerpt } from './helpers/app-source.js';
import { createDataSource } from '../public/data-source.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes;reject=no; });return {promise,resolve,reject}; };
const snapshot = (workspaceId='w',items=[],more={}) => ({workspaceId,items,total:items.length,offset:0,limit:50,hasMore:false,tenants:[],channels:[],departments:[],assignees:[],countTabs:{all:items.length},counts:{active:items.length},...more});
const row = (tenantId='a',id='same') => ({tenantId,id,conversationId:id,tenantName:'Empresa '+tenantId,channelId:'shared-channel',channelName:'Conexão '+tenantId,contact:'Contato',owner:'human',assignedUserId:'owner',assignedUserName:'Equipe',status:'open',updatedAt:'2026-10-02T10:00:00Z',preview:{text:'Prévia pública'},tags:[]});
const detail = (tenantId,id='same') => ({tenant:{id:tenantId,conversations:[{id}]}});
const e = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('company/channel identity is pinned in queries while a nominal attendant spans allowed companies',()=>{
 const q=new URL(inboxQuery({inboxCompany:'all',channel:JSON.stringify(['company-b','identical-channel']),department:'all',assignedUser:'person',search:'histórico antigo',status:'all',filter:'mine',unread:true,kind:'direct'},50),'http://local').searchParams;
 assert.equal(q.get('tenantId'),'company-b');assert.equal(q.get('channelId'),'identical-channel');assert.equal(q.get('assignedUserId'),'person');assert.equal(q.get('status'),'all');assert.equal(q.get('q'),'histórico antigo');assert.equal(q.get('offset'),'50');assert.equal(q.get('unread'),'true');
 assert.throws(()=>inboxQuery({channel:JSON.stringify(['a','same']),department:JSON.stringify(['b','same'])}),/mesma empresa/);
 assert.equal(new URL(inboxQuery({inboxCompany:'all',channel:'all',department:'all',assignedUser:'all'}),'http://local').searchParams.has('tenantId'),false);
});

test('server totals and tab counts are retained instead of being recalculated from one page',async()=>{
 const requests=[];const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async(path,opts)=>{requests.push({path,opts});return snapshot('w',[row()],{total:87,hasMore:true,countTabs:{all:87,mine:40},counts:{active:87,closed:12}});}});
 await ui.load({status:'active'});assert.equal(ui.data.total,87);assert.equal(ui.data.countTabs.mine,40);assert.equal(ui.data.counts.closed,12);assert.equal(requests[0].opts.headers['X-Elozi-Workspace'],'w');
});

test('a slower previous search cannot replace the newer server result',async()=>{
 const a=deferred(),b=deferred();let n=0;const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:()=>++n===1?a.promise:b.promise});
 const first=ui.load({search:'antigo'}),second=ui.load({search:'novo'});b.resolve(snapshot('w',[row('b')]));await second;a.resolve(snapshot('w',[row('a')]));assert.equal(await first,null);assert.equal(ui.data.items[0].tenantId,'b');assert.equal(ui.loading,false);
});

test('typing a new search invalidates the response already in flight before the debounce fires',async()=>{
 const a=deferred();const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:()=>a.promise});const old=ui.load({search:'antes'});ui.cancelLoad();a.resolve(snapshot('w',[row()]));assert.equal(await old,null);assert.equal(ui.data.items.length,0);
});

test('same conversation ID in two tenants uses independent selection and last selection wins',async()=>{
 const a=deferred(),b=deferred();const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async()=>snapshot()});
 const first=ui.select({tenantId:'a',id:'same'},()=>a.promise),second=ui.select({tenantId:'b',id:'same'},()=>b.promise);b.resolve(detail('b'));const latest=await second;a.resolve(detail('a'));assert.equal(await first,null);assert.equal(latest.ref.tenantId,'b');assert.notEqual(inboxIdentity(latest.ref),inboxIdentity({workspaceId:'w',tenantId:'a',id:'same'}));
});

test('workspace/user/access changes discard summaries, drafts and stale detail responses',async()=>{
 let context={workspaceId:'w',userId:'u',authorityKey:'read-a'};const a=deferred(),b=deferred();const ui=createConsolidatedInboxUI({context:()=>context,request:()=>a.promise});
 const ref={workspaceId:'w',tenantId:'a',id:'same'};ui.saveDraft(ref,'Rascunho privado');const list=ui.load({}),selected=ui.select(ref,()=>b.promise);
 context={workspaceId:'other',userId:'u',authorityKey:'read-a'};ui.sync();a.resolve(snapshot('w',[row()]));b.resolve(detail('a'));assert.equal(await list,null);assert.equal(await selected,null);assert.equal(ui.data.items.length,0);assert.equal(ui.draftCount,0);
 ui.saveDraft({...ref,workspaceId:'other'},'Outro');context={...context,authorityKey:'read-b'};ui.sync();assert.equal(ui.draftCount,0);
});

test('the detail response must match tenant and conversation and cannot redirect to another origin',async()=>{
 const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async()=>snapshot()});
 await assert.rejects(ui.select({tenantId:'a',id:'same'},async()=>detail('b')),e=>e.status===403);
 await assert.rejects(ui.select({tenantId:'a',id:'absent'},async()=>detail('a')),e=>e.status===403);
 await assert.rejects(ui.select({workspaceId:'else',tenantId:'a',id:'same'},async()=>detail('a')),/workspace/);
});

test('text drafts survive tenant alternation without colliding and revocation discards only the affected tenant',()=>{
 const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async()=>snapshot(),draftLimit:2});const a={workspaceId:'w',tenantId:'a',id:'same'},b={...a,tenantId:'b'};
 assert.equal(ui.saveDraft(a,'Texto A'),true);assert.equal(ui.saveDraft(b,'Texto B'),true);assert.equal(ui.getDraft(a),'Texto A');assert.equal(ui.getDraft(b),'Texto B');assert.equal(ui.saveDraft({...a,id:'third'},'C'),false);
 ui.forgetTenant('a');assert.equal(ui.getDraft(a),'');assert.equal(ui.getDraft(b),'Texto B');ui.clearDraft(b);assert.equal(ui.draftCount,0);
});

test('an authorization rejection removes summaries and private drafts',async()=>{
 let deny=false;const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async()=>{if(deny)throw Object.assign(Error('revogado'),{status:403});return snapshot('w',[row()]);}});
 await ui.load({});ui.saveDraft({workspaceId:'w',tenantId:'a',id:'same'},'Privado');deny=true;await assert.rejects(ui.load({}),/revogado/);assert.equal(ui.data.items.length,0);assert.equal(ui.draftCount,0);assert.equal(ui.loading,false);
});

test('paging returns to a valid page when conversations disappear between polls',async()=>{
 const urls=[];const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async path=>{urls.push(path);return urls.length===1?snapshot('w',[],{total:49,offset:50}):snapshot('w',[row()],{total:49});}});
 await ui.load({},{offset:50});assert.equal(urls.length,2);assert.equal(new URL(urls[1],'http://local').searchParams.get('offset'),'0');assert.equal(ui.data.offset,0);
});

test('summary rendering escapes content and highlights only the composed selected origin',()=>{
 const a=row('a'),b={...row('b'),tenantName:'<img onerror=x>',channelName:'<script>bad</script>',contact:'<svg>',preview:{text:'<iframe>'}};
 const html=consolidatedListMarkup({data:snapshot('w',[a,b],{total:89,hasMore:true,countTabs:{all:89,mine:34}}),filters:{inboxCompany:'all',channel:'all',department:'all',assignedUser:'all',filter:'all',status:'active',kind:'all',sort:'recent'},selection:{workspaceId:'w',tenantId:'b',id:'same'},workspaceId:'w',userId:'u',tenants:[],escape:e,icon:()=>'',badge:(text)=>'<span>'+e(text)+'</span>',avatar:()=>''});
 assert.equal((html.match(/aria-current="true"/g)||[]).length,1);assert.ok(html.includes('data-inbox-tenant="b"'));assert.ok(html.includes('Todas as empresas'));assert.ok(html.includes('assigned-user-filter'));assert.ok(html.includes('1–2 de 89'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<iframe>'));assert.ok(!html.includes('onclick='));
});

test('complete authorized snapshots prune revoked drafts only in their tenant and block a stale textarea from restoring them',async()=>{
 const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async()=>snapshot('w',[row('a','keep')])});
 const removed={workspaceId:'w',tenantId:'a',id:'same'},other={...removed,tenantId:'b'},keep={...removed,id:'keep'};
 ui.saveDraft(removed,'Revogado');ui.saveDraft(other,'Outra empresa');ui.saveDraft(keep,'Permitido');
 await ui.load({search:'só keep'});assert.equal(ui.getDraft(removed),'Revogado','a filtered page is not evidence of revocation');
 ui.retainConversations('a',['keep']);assert.equal(ui.getDraft(removed),'');assert.equal(ui.getDraft(other),'Outra empresa');assert.equal(ui.getDraft(keep),'Permitido');
 assert.equal(ui.saveDraft(removed,'Texto antigo ainda no DOM'),true);assert.equal(ui.getDraft(removed),'');
 ui.retainConversations('a',['same','keep']);ui.saveDraft(removed,'Acesso restaurado');assert.equal(ui.getDraft(removed),'Acesso restaurado');
 ui.retainConversations('a',[]);assert.equal(ui.draftCount,1);assert.equal(ui.getDraft(other),'Outra empresa');
});

test('a validated detail selection prunes earlier inaccessible drafts from that complete tenant snapshot',async()=>{
 const ui=createConsolidatedInboxUI({context:()=>({workspaceId:'w',userId:'u'}),request:async()=>snapshot()});
 const missing={workspaceId:'w',tenantId:'a',id:'removed'},sameElsewhere={...missing,tenantId:'b'};
 ui.saveDraft(missing,'Privado');ui.saveDraft(sameElsewhere,'Outra origem');
 await ui.select({tenantId:'a',id:'same'},()=>detail('a'));
 assert.equal(ui.getDraft(missing),'');assert.equal(ui.getDraft(sameElsewhere),'Outra origem');
});

// Exercise the served application's actual poll path with RAM-only API/DOM adapters.
const appSource=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const pollSource=excerpt('poll-inbox');
const accessSource=excerpt('attendance-access');
const channelHelpers=excerpt('channel-helpers');
const voiceControlsSource=excerpt('voice-controls');
const composerSource=excerpt('composer-status');
const attendanceContextSource=appSource.split('\n').find(line=>line.startsWith('const attendanceContext='));
assert.ok(attendanceContextSource,'O contexto atual de autoridade deve vir do app servido.');
const contactAuthoritySource=appSource.split('\n').find(line=>line.startsWith('const inboxContactAuthority='));
assert.ok(contactAuthoritySource,'O poll usa a autoridade real do workspace servido.');
async function pollHarness(nextTenant,{beforeTenantReply,selected:initial,participantsOpen=false,pendingSend=false}={}){
 const channel={id:'shared-channel',name:'Conexão A',kind:'telegram',transport:'telegram-bot',state:'connected'};
 const selected={...row('a'),messages:[],version:4,...initial},state={view:'inbox',busy:false,workspaceId:'w',boot:{session:{userId:'owner',role:'operator'}},tenant:{id:'a',name:'Empresa A',channels:[channel],agents:[],conversations:[selected]},flows:[],conversation:'same',refreshSequence:1,renderedInboxRef:{workspaceId:'w',tenantId:'a',conversationId:'same'},sendIntent:null,noteIntent:{},scheduleIntent:{}};
 const totals=snapshot('w',[row('a'),row('b')],{total:81,counts:{active:81}}),nav={textContent:''},textarea={value:'Rascunho ainda no DOM',disabled:false},calls={renders:0,players:0,mediaResets:0,mediaRetains:[],participantsSyncs:0,handoffSyncs:0,readChecks:[]};
 const player={currentTime:17,paused:false},quote={disabled:false},forward={disabled:false,hidden:false},note={value:'Nota ainda em edição',disabled:false},noteSubmit={disabled:false};
 const messages={player,querySelectorAll:selector=>selector.includes('forward-message')?[forward]:selector.includes('quote')?[quote]:[]},modal={open:participantsOpen};
 const nodes=new Map([['#modal',modal],['.nav-count',nav],['#message-text',textarea],['#messages',messages],['#message-form',{querySelector:()=>null,querySelectorAll:()=>[textarea]}],['#internal-note-form',{querySelectorAll:()=>[note,noteSubmit]}],['.chat-origin',{}],['[data-attendance-role]',{}],['.chat-primary-actions',{dataset:{}}],['[data-attendance-banner]',{dataset:{}}],['[data-composer-access]',{}],['#conversation-details-form fieldset',{}],['.attendant-name',{}],['[data-action="conversation-flow"]',{}],['#assigned-agent',{}],['#conversation-context .group-help',{}]]);
 const ui=createConsolidatedInboxUI({context:()=>({workspaceId:state.workspaceId,userId:'u'}),request:async()=>totals});
 ui.saveDraft(state.renderedInboxRef,'Rascunho anterior');ui.saveDraft({workspaceId:'w',tenantId:'a',id:'inactive'},'Outro revogado');ui.saveDraft({workspaceId:'w',tenantId:'b',id:'same'},'Outra empresa');
 await ui.load({});
 const canReplyTo=c=>attendanceReplyAccess(c,{userId:state.boot.session.userId,hasPermission:true});
 const mediaUI=createMediaUI({escape:e,icon:()=>'',getPendingSend:()=>Boolean(state.sendIntent),getCapabilities:()=>channelCapabilities(channel),download:()=>assert.fail('Este poll não pode baixar arquivos.')});
 const resetMedia=mediaUI.reset,retainMedia=mediaUI.retainConversations;
 mediaUI.reset=()=>{calls.mediaResets++;resetMedia();};
 mediaUI.retainConversations=(ids,tenantId)=>{calls.mediaRetains.push({ids:[...ids],tenantId});return retainMedia(ids,tenantId);};
 // DOM/player adapters remain local; draft retention and authority use the real module.
 mediaUI.bindPlayers=()=>calls.players++;mediaUI.hydrate=()=>{};mediaUI.updateComposer=disabled=>{textarea.disabled=disabled;};
 const sandbox={...i18n,state,inboxPolling:false,consolidatedInbox:ui,channelCapabilities,conversationCapabilities,textLength,
  $:selector=>nodes.get(selector)||null,
  refreshInboxList:async()=>{await ui.load({});nav.textContent=ui.data.counts.active;},
  api:async(path,options)=>{assert.equal(path,'/api/tenants/a');assert.equal(options.headers['X-Elozi-Workspace'],'w');beforeTenantReply?.(state);return {channels:[channel],agents:[],...nextTenant};},
  mediaUI,
  repliesUI:{reset:()=>{},retainConversations:()=>{},syncContext:()=>{},updateQuoteComposer:()=>{}},voiceRecorder:{reset:()=>{}},
  participantsUI:{busy:false,opened:participantsOpen,reset:()=>{},sync:()=>calls.participantsSyncs++},currentConversation:()=>state.tenant.conversations.find(c=>c.id===state.conversation),
  markConversationRead:(conversation,options)=>{calls.readChecks.push({conversation,opened:options?.opened,players:calls.players});return Promise.resolve(false);},
  serviceHandoffsUI:{sync:()=>calls.handoffSyncs++},memoryUI:{syncContext(){}},
  // Copilot metadata has a separate fixture using the real scoped loader; no run request belongs to this draft-retention fixture.
  captureScopedRuns:()=>({}),currentScopedRuns:()=>true,readScopedRuns:async()=>[],scopedRunsAligned:()=>true,refreshScopedConversationRuns:async()=>false,
  syncAttendanceTools:()=>{sandbox.participantsUI.sync();sandbox.serviceHandoffsUI.sync();},canReplyTo,conversationTools:{opened:false},updateAttendanceSummary:()=>{},updateClientRecord:()=>{},updateConversationTools:()=>{},
  canCoordinate:c=>canReplyTo(c)&&attendanceParticipantRole(c,{userId:state.boot.session.userId})==='responsible',canManageAttendance:c=>attendanceManagementAccess(c,{userId:state.boot.session.userId,role:'operator',hasPermission:true}),
  attendanceRole:c=>attendanceParticipantRole(c,{userId:state.boot.session.userId}),attendanceRoleText:c=>c.attendanceAccess?.canReply?'Colaborando':'Observando',attendanceComposerText:c=>canReplyTo(c)?'Responder':'Observando',ownerLabel:c=>c.assignedUserName||'Equipe',
  attendancePrimaryActions:()=>'<button>Participantes</button>',attendanceAccessBanner:c=>canReplyTo(c)?'Colaborando':'Observando',
  inboxTimeline:{update:()=>({added:false,nearBottom:true})},updateInboxList:()=>{nav.textContent=ui.data.counts.active;},activeConversations:()=>[selected],renderConversationRuns:()=>{},avatarUI:{bind:()=>{}},activeRunStates:new Set(),
  tenantApi:()=>'/api/tenants/a',refreshMessageAttachments:()=>{},toast:()=>{},dropInboxDetail:()=>assert.fail('a filtered 200 snapshot must use the revocation path'),
  render:()=>{calls.renders++;if(state.renderedInboxRef)ui.saveDraft(state.renderedInboxRef,textarea.value);}
 };
 // The poll's GETs go through data-source.js (FRONTEND-V2 §8.1, P1 commit 1f) over the same RAM api.
 sandbox.dataSource=createDataSource({request:(path,options)=>sandbox.api(path,options)});
 const {poll,attendanceContext}=runInNewContext(channelHelpers+'\n'+contactAuthoritySource+'\n'+attendanceContextSource+'\n'+voiceControlsSource+'\n'+composerSource+'\n'+accessSource+'\n'+pollSource+'\n({poll:pollInbox,attendanceContext})',sandbox);
 const mediaActor=(tenantId='a',conversationId='same')=>({...attendanceContext(),tenantId,conversationId,active:true});
 const mediaA=new File(['A'],'a.txt',{type:'text/plain'}),mediaB=new File(['B'],'b.txt',{type:'text/plain'});
 mediaUI.syncContext(mediaActor());mediaUI.choose(mediaA,'Arquivo da empresa A');
 mediaUI.syncContext(mediaActor('a','inactive'),mediaUI.draft);mediaUI.choose(new File(['inactive'],'inactive.txt',{type:'text/plain'}),'Arquivo revogado');
 mediaUI.syncContext(mediaActor('b'),mediaUI.draft);mediaUI.choose(mediaB,'Arquivo da empresa B');
 mediaUI.syncContext(mediaActor(),mediaUI.draft);
 if(pendingSend)state.sendIntent=createSendIntent(null,{workspaceId:'w',tenantId:'a',conversationId:'same',channelId:channel.id,version:4,text:mediaUI.draft,attachmentIds:[]},{randomUUID:()=> 'synthetic-pending-inbox-poll'});
 await poll();return {state,ui,nav,calls,nodes,textarea,note,messages,player,quote,forward,mediaUI,mediaActor,mediaA,mediaB};
}

test('app poll clears the old rendered reference and private intents when a 200 tenant snapshot removes the selected conversation',async()=>{
 const {state,ui,calls,mediaUI,mediaActor,mediaB}=await pollHarness({id:'a',conversations:[]},{pendingSend:true});
 assert.equal(state.conversation,null);assert.equal(state.renderedInboxRef,null);assert.equal(state.sendIntent,null);assert.equal(state.noteIntent,null);assert.equal(state.scheduleIntent,null);
 assert.equal(calls.renders,1);assert.equal(calls.mediaResets,0);assert.deepEqual(calls.mediaRetains,[{tenantId:'a',ids:[]}]);assert.equal(ui.getDraft({workspaceId:'w',tenantId:'a',id:'same'}),'');assert.equal(ui.getDraft({workspaceId:'w',tenantId:'a',id:'inactive'}),'');
 assert.equal(ui.getDraft({workspaceId:'w',tenantId:'b',id:'same'}),'Outra empresa');
 assert.equal(mediaUI.selected,null);assert.equal(mediaUI.draft,'');
 assert.equal(calls.readChecks.length,0,'a conversa revogada não recebe confirmação de leitura');
 mediaUI.syncContext(mediaActor('b'),'Textarea revogado');assert.equal(mediaUI.selected.file,mediaB);assert.equal(mediaUI.draft,'Arquivo da empresa B');
 mediaUI.syncContext(mediaActor(),mediaUI.draft);assert.equal(mediaUI.selected,null);assert.equal(mediaUI.draft,'');
});

test('app poll prunes an inactive revoked draft, preserves the current player, and retains the server aggregate navigation count',async()=>{
 const {state,ui,nav,calls,mediaUI,mediaActor,mediaA,mediaB}=await pollHarness({id:'a',conversations:[row('a')]});
 assert.equal(state.conversation,'same');assert.equal(calls.renders,0);assert.equal(calls.mediaResets,0);assert.equal(calls.players,1);assert.equal(nav.textContent,81);
 assert.equal(calls.readChecks.length,1);assert.equal(calls.readChecks[0].conversation,state.tenant.conversations[0]);assert.equal(calls.readChecks[0].opened,false);
 assert.equal(ui.getDraft({workspaceId:'w',tenantId:'a',id:'inactive'}),'');assert.equal(ui.getDraft({workspaceId:'w',tenantId:'a',id:'same'}),'Rascunho anterior');assert.equal(ui.getDraft({workspaceId:'w',tenantId:'b',id:'same'}),'Outra empresa');
 assert.deepEqual(calls.mediaRetains,[{tenantId:'a',ids:['same']}]);assert.equal(mediaUI.selected.file,mediaA);
 mediaUI.syncContext(mediaActor('b'),mediaUI.draft);assert.equal(mediaUI.selected.file,mediaB);assert.equal(mediaUI.draft,'Arquivo da empresa B');
 mediaUI.syncContext(mediaActor('a','inactive'),mediaUI.draft);assert.equal(mediaUI.selected,null);assert.equal(mediaUI.draft,'');
});

test('a stale tenant response cannot prune drafts after another selection has changed the refresh sequence',async()=>{
 const {state,ui,calls}=await pollHarness({id:'a',conversations:[]},{beforeTenantReply:state=>state.refreshSequence++});
 assert.equal(state.conversation,'same');assert.equal(calls.renders,0);assert.equal(calls.mediaResets,0);assert.equal(ui.getDraft({workspaceId:'w',tenantId:'a',id:'same'}),'Rascunho anterior');
 assert.equal(calls.readChecks.length,0,'um poll obsoleto não produz leitura');
});

test('an open participants modal allows polling to revoke reply controls without replacing drafts or a playing message',async()=>{
 const updated={...row('a'),assignedUserId:'responsible',version:5,messages:[],attendanceAccess:{canReply:false,canManageParticipants:false}};
 const {state,calls,nodes,textarea,note,messages,player,quote,forward}=await pollHarness({id:'a',name:'Empresa A',conversations:[updated],agents:[]},{participantsOpen:true,selected:{assignedUserId:'responsible',attendanceAccess:{canReply:true,canManageParticipants:false}}});
 assert.equal(state.tenant.conversations[0],updated);assert.equal(calls.renders,0);assert.equal(calls.mediaResets,0);assert.equal(calls.players,1);assert.ok(calls.participantsSyncs>0);assert.ok(calls.handoffSyncs>0);
 assert.equal(nodes.get('#message-text'),textarea);assert.equal(textarea.value,'Rascunho ainda no DOM');assert.equal(textarea.disabled,true);
 assert.equal(note.value,'Nota ainda em edição');assert.equal(note.disabled,true);assert.equal(quote.disabled,true);assert.equal(forward.hidden,true);assert.equal(forward.disabled,true);
 assert.equal(nodes.get('#messages'),messages);assert.equal(messages.player,player);assert.equal(player.currentTime,17);assert.equal(player.paused,false);assert.equal(nodes.get('[data-attendance-role]').textContent,'Observando');
});

test('a tenant poll older than a locally applied participant mutation cannot regress its access or revision',async()=>{
 const {state,calls}=await pollHarness({id:'a',conversations:[{...row('a'),version:4,messages:[],attendanceAccess:{canReply:false}}]},{selected:{version:5,attendanceAccess:{canReply:true}}});
 assert.equal(state.tenant.conversations[0].version,5);assert.equal(state.tenant.conversations[0].attendanceAccess.canReply,true);assert.equal(calls.renders,0);assert.equal(calls.players,0);assert.equal(calls.participantsSyncs,0);assert.equal(calls.handoffSyncs,0);
 assert.equal(calls.readChecks.length,0);
});

test('poll closes an expired Meta composer while retaining private notes, drafts and the current player',async()=>{
 const updated={...row('a'),version:5,messages:[],attendanceAccess:{canReply:true},channelAvailability:{replyWindow:{open:false,expiresAt:new Date(Date.now()-1000).toISOString()}}};
 const {calls,textarea,note,quote,forward,player}=await pollHarness({id:'a',name:'Empresa A',conversations:[updated],agents:[],channels:[{id:'shared-channel',name:'Instagram fixture',kind:'instagram',transport:'meta-instagram',state:'connected'}]});
 assert.equal(calls.renders,0);assert.equal(calls.mediaResets,0);assert.equal(calls.players,1);
 assert.equal(textarea.disabled,true);assert.equal(textarea.value,'Rascunho ainda no DOM');assert.equal(note.disabled,false);assert.equal(note.value,'Nota ainda em edição');
 assert.equal(quote.disabled,true);assert.equal(forward.hidden,true);assert.equal(forward.disabled,true);assert.equal(player.currentTime,17);assert.equal(player.paused,false);
});

test('poll blocks a revoked Telegram group without granting another conversation access or discarding its draft',async()=>{
 const updated={...row('a'),version:5,messages:[],attendanceAccess:{canReply:true},channelAvailability:{group:{canSend:false}}};
 const {calls,textarea,note,ui,player}=await pollHarness({id:'a',name:'Empresa A',conversations:[updated],agents:[]});
 assert.equal(calls.players,1);assert.equal(calls.renders,0);assert.equal(textarea.disabled,true);assert.equal(note.disabled,false);
 assert.equal(ui.getDraft({workspaceId:'w',tenantId:'a',id:'same'}),'Rascunho anterior');assert.equal(ui.getDraft({workspaceId:'w',tenantId:'b',id:'same'}),'Outra empresa');
 assert.equal(player.currentTime,17);assert.equal(player.paused,false);
});
