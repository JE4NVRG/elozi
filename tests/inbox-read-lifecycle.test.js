import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import { excerpt } from './helpers/app-source.js';
import * as i18n from '../public/i18n.js';
import { attendanceParticipantRole } from '../public/participants-ui.js';
import { attendanceResponseIsCurrent, readActionLabel, readStateCommand, readSyncNotice, canSyncDeviceRead } from '../public/attendance-read-ui.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
// These small existing functions preserve the served context/CAS checks around the actual POST.
const attendanceSource=['function captureAttendance(','function readDeviceContext(','function checkAttendance(','async function attendanceRequest(','function applyAttendance('].map(prefix=>{
  const line=app.split('\n').find(item=>item.startsWith(prefix));assert.ok(line,prefix);return line;
}).join('\n');
const customer=id=>({id,kind:'customer',text:'Own synthetic inbound',createdAt:'2026-10-20T10:00:00.000Z'});
const conversation=(more={})=>({id:'case',channelId:'wa',version:3,owner:'human',assignedUserId:'me',status:'open',unread:1,messages:[customer('inbound-1')],...more});

function fixture({initial,request}={}){
  const selected=conversation(initial),state={view:'inbox',workspaceId:'workspace',conversation:selected.id,busy:false,inboxSelecting:false,refreshSequence:1,inboxSelectionSequence:1,supportGrantId:null,boot:{session:{userId:'me',role:'operator',permissions:['inbox.read']}},tenant:{id:'tenant',channels:[{id:'wa',kind:'whatsapp_qr',transport:'baileys'}],conversations:[selected],runs:[]}};
  const viewport={clientHeight:400,scrollHeight:1200,scrollTop:800},nodes=new Map([['#messages',viewport],['#modal',{open:false}],['.nav-count',{textContent:''}]]),listeners=new Map();
  const document={visibilityState:'visible',addEventListener:(name,handler,options)=>listeners.set(name,{handler,options})},requests=[],kicks=[],notices=[];
  const calls={timeline:0,renders:0},current=()=>state.tenant?.conversations.find(c=>c.id===state.conversation),authority=()=>JSON.stringify([state.boot.session.userId,state.workspaceId,state.supportGrantId,state.tenant?.id]);
  const reset={reset(){}},sandbox={...i18n,state,document,$:selector=>nodes.get(selector)||null,mediaUI:{...reset,sending:false,retainConversations(){},bindPlayers(){},hydrate(){}},voiceRecorder:{...reset,busy:false},
    currentConversation:current,hasPermission:name=>state.boot.session.permissions.includes(name),attendanceRole:c=>attendanceParticipantRole(c,{userId:state.boot.session.userId}),activeRunStates:new Set(['queued','running','waiting_approval']),
    readStateCommand,readSyncNotice,readActionLabel,canSyncDeviceRead,attendanceResponseIsCurrent,live:{kick:name=>kicks.push(name)},toast:(message,error)=>notices.push({message,error}),
    attendanceContext:()=>({workspaceId:state.workspaceId,tenantId:state.tenant?.id,userId:state.boot.session.userId}),tenantApi:tail=>`/api/tenants/${state.tenant.id}/${tail}`,
    api:async(path,options)=>{const body=JSON.parse(options.body),entry={path,options,body};requests.push(entry);const original=structuredClone(current());return request?request(entry,original):{...original,version:original.version+1,unread:body.unread?1:0,readSync:{state:'synced'}};},
    queueMicrotask,refreshInboxList:async()=>{},consolidatedInbox:{...reset,data:{offset:0,counts:{active:1}},retainConversations(){}},
    repliesUI:{...reset,syncContext(){},retainConversations(){},updateQuoteComposer(){}},syncAttendanceTools(){},updateInboxList(){},updateAttendanceSummary(){},updateAttendanceAccess(){},updateClientRecord(){},
    inboxTimeline:{...reset,update:()=>{calls.timeline++;return {added:false,nearBottom:true};}},conversationTools:{...reset,opened:false},updateConversationTools(){},renderConversationRuns(){},
    participantsUI:{...reset,busy:false,opened:false},inboxContactAuthority:authority,inboxPolling:false,canReplyTo:()=>true,refreshMessageAttachments(){},avatarUI:{...reset,bind(){}},render:()=>calls.renders++,dropInboxDetail:()=>assert.fail('no authorization failure belongs to this fixture'),
    captureScopedRuns:()=>({authority:authority(),conversationId:state.conversation}),currentScopedRuns:context=>context.authority===authority()&&context.conversationId===state.conversation,
    readScopedRuns:async()=>state.tenant.runs,scopedRunsAligned:()=>true,refreshScopedConversationRuns:async()=>false,
    clearTimeout,resetScreens(){},workspaceUI:{resetPeople(){},resetContacts(){}}
  };
  for(const name of ['contactLinksUI','contactRefresh','memoryUI','whatsappGroupsUI','telegramGroupsUI','channelConnectorsUI','workspaceDomainsUI','plansUI','accountsUI','unitsUI','accountInvitationsUI','supportUI','servicePrincipalsUI','serviceHandoffsUI','customerContextUI','billingUI','accountSecurityUI','teamChatUI','contactImportUI','platformUsersUI','commercialUsageUI','groupsWorkspaceUI','noteDrafts','forwarding','chatLayout','automationUI','mcpUI','knowledgeUI','brandDrafts','subscriptionUI'])sandbox[name]=reset;
  let nextSnapshot;
  sandbox.dataSource={tenant:async()=>structuredClone(nextSnapshot||state.tenant)};
  const served=runInNewContext(attendanceSource+'\n'+excerpt('inbox-read-receipts')+'\n'+excerpt('poll-inbox')+'\n'+excerpt('attendance-action')+'\n'+excerpt('workspace-selection-reset')+'\n({markConversationRead,handleInboxReadScroll,pollInbox,attendanceAction,resetWorkspaceSelection,inboxReadAttempts,inboxReadKey,inboxReadAnchor})',sandbox);
  const scroll=async(target=nodes.get('#messages'))=>{listeners.get('scroll').handler({target});await tick();};
  const poll=async()=>{await served.pollInbox();await tick();};
  return {...served,state,viewport,nodes,document,listeners,requests,kicks,notices,calls,current,scroll,poll,mediaUI:sandbox.mediaUI,voiceRecorder:sandbox.voiceRecorder,setSnapshot:value=>{nextSnapshot=value;}};
}

test('a selected human conversation that stays visible at the bottom is read by the served poll',async()=>{
  const f=fixture();await f.poll();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/tenants/tenant/conversations/case/read-state');
  assert.deepEqual(f.requests[0].body,{version:3,unread:false,syncDevice:true});assert.equal(f.requests[0].options.headers['X-Elozi-Workspace'],'workspace');
  assert.equal(f.current().unread,0);assert.deepEqual(f.kicks,['attention']);assert.ok(f.calls.timeline>0);
});

for(const [label,configure] of [
  ['history above the 90px boundary',f=>{f.viewport.scrollTop=710;}],
  ['an absent timeline',f=>f.nodes.delete('#messages')],
  ['a timeline with no visible height',f=>{f.viewport.clientHeight=0;}]
])test(`poll preserves unread for ${label}, then reads when the timeline becomes visible at the bottom`,async()=>{
  const f=fixture();configure(f);await f.poll();assert.equal(f.requests.length,0);assert.equal(f.current().unread,1);
  f.nodes.set('#messages',f.viewport);Object.assign(f.viewport,{clientHeight:400,scrollTop:711});await f.poll();assert.equal(f.requests.length,1);
});

test('the served scroll listener reads only the current timeline when it reaches the bottom',async()=>{
  const f=fixture();assert.equal(f.listeners.get('scroll').options.capture,true);assert.equal(f.listeners.get('scroll').options.passive,true);
  f.viewport.scrollTop=300;await f.scroll();assert.equal(f.requests.length,0);
  f.viewport.scrollTop=800;await f.scroll({id:'unrelated-panel'});assert.equal(f.requests.length,0);
  await f.scroll();assert.equal(f.requests.length,1);assert.equal(f.current().unread,0);
});

test('a new customer inbound in the open conversation receives its own read while an outgoing-only update does not',async()=>{
  const f=fixture();await f.poll();
  f.setSnapshot({...f.state.tenant,conversations:[conversation({version:5,messages:[customer('inbound-1'),customer('inbound-2')]})]});await f.poll();assert.equal(f.requests.length,2);
  f.setSnapshot({...f.state.tenant,conversations:[conversation({version:7,messages:[customer('inbound-1'),customer('inbound-2'),{id:'outbound',kind:'assistant'}]})]});await f.poll();
  assert.equal(f.requests.length,2,'a mesma âncora não é relida por uma mudança de versão ou saída');
});

test('hidden-to-visible and a completed agent run are reevaluated by later polls',async()=>{
  const f=fixture();f.document.visibilityState='hidden';await f.poll();assert.equal(f.requests.length,0);
  f.document.visibilityState='visible';f.state.tenant.runs=[{conversationId:'case',state:'running',conversationVersion:3}];await f.poll();assert.equal(f.requests.length,0);
  f.state.tenant.runs=[];await f.poll();assert.equal(f.requests.length,1);
});

for(const run of [{state:'queued'},{state:'waiting_approval'},{state:'draft',conversationVersion:3}])test(`poll and scroll preserve an agent ${run.state} for the current version`,async()=>{
  const f=fixture();f.state.tenant.runs=[{conversationId:'case',...run}];await f.poll();await f.scroll();assert.equal(f.requests.length,0);
  f.state.tenant.runs=[{conversationId:'case',state:'draft',conversationVersion:2}];await f.poll();assert.equal(f.requests.length,1);
});

for(const [label,configure] of [
  ['another attendant',f=>{f.current().assignedUserId='other';}],
  ['queue ownership',f=>{f.current().owner='queue';}],
  ['an agent owner',f=>{f.current().owner='agent';}],
  ['collaboration',f=>{Object.assign(f.current(),{assignedUserId:'other',attendanceAccess:{canReply:true}});}],
  ['support',f=>{f.state.supportGrantId='grant';}],
  ['revoked read permission',f=>{f.state.boot.session.permissions=[];}],
  ['a busy UI',f=>{f.state.busy=true;}],
  ['a pending selection',f=>{f.state.inboxSelecting=true;}],
  ['an active media send',f=>{f.mediaUI.sending=true;}],
  ['a voice recording',f=>{f.voiceRecorder.busy=true;}],
  ['a pending send',f=>{f.state.sendIntent={id:'own-send'};}],
  ['a different view',f=>{f.state.view='contacts';}]
])test(`automatic read preserves unread for ${label}`,async()=>{
  const f=fixture();configure(f);await f.poll();await f.scroll();assert.equal(f.requests.length,0);
});

test('poll, scroll, and repeated opening share one pending read even if a newer inbound arrives',async()=>{
  const receipt=deferred(),f=fixture({request:()=>receipt.promise}),pending=f.markConversationRead(f.current());
  await f.poll();await f.scroll();assert.equal(await f.markConversationRead(f.current()),false);assert.equal(f.requests.length,1);assert.deepEqual(f.kicks,[]);
  Object.assign(f.current(),{version:4,messages:[customer('inbound-1'),customer('inbound-2')]});await f.poll();await f.scroll();assert.equal(f.requests.length,1);
  receipt.resolve(conversation({version:4,unread:0}));assert.equal(await pending,true);assert.equal(f.current().messages.length,2,'a resposta antiga não apaga a mensagem nova');
  await f.poll();assert.equal(f.requests.length,2,'a mensagem nova é reconhecida depois que o voo anterior termina');
});

test('a failed automatic mutation is not retried by polls or scroll, while another explicit opening may retry once',async()=>{
  const f=fixture({request:async()=>{throw Object.assign(new Error('Own synthetic failure'),{status:503});}});
  await f.poll();await f.poll();await f.scroll();assert.equal(f.requests.length,1);assert.equal(f.current().unread,1);assert.deepEqual(f.kicks,[]);assert.deepEqual(f.notices,[]);
  assert.equal(await f.markConversationRead(f.current()),false);assert.equal(f.requests.length,2);
  await f.poll();assert.equal(f.requests.length,2);
  f.current().messages.push(customer('inbound-2'));await f.poll();assert.equal(f.requests.length,3,'novo inbound permite uma nova tentativa independente');
});

test('successful anchor deduplication also preserves a manually restored unread from a server snapshot',async()=>{
  const f=fixture();await f.poll();Object.assign(f.current(),{unread:1,version:8});await f.poll();await f.scroll();assert.equal(f.requests.length,1);
  assert.equal(await f.markConversationRead(f.current()),true);assert.equal(f.requests.length,2,'um gesto de abrir permite ler novamente');
});

test('manual mark-unread keeps its anchor unread through polls, then a new inbound can be read',async()=>{
  const f=fixture({initial:{unread:0}});assert.equal(await f.attendanceAction('conversation-read'),true);
  assert.equal(f.requests[0].body.unread,true);assert.equal(f.current().unread,1);assert.deepEqual(f.kicks,['attention']);
  await f.poll();await f.scroll();assert.equal(f.requests.length,1);
  f.current().messages.push(customer('inbound-2'));f.current().version++;await f.poll();assert.equal(f.requests.length,2);assert.equal(f.current().unread,0);
});

test('the explicit read command refreshes attention after the server confirms the panel even if the device is pending',async()=>{
  const f=fixture({request:async(_entry,original)=>({...original,version:original.version+1,unread:0,readSync:{state:'pending'}})});
  assert.equal(await f.attendanceAction('conversation-read'),true);assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.unread,false);assert.equal(f.current().unread,0);assert.deepEqual(f.kicks,['attention']);
  assert.equal(f.notices.length,1);assert.equal(f.notices[0].error,true);assert.match(f.notices[0].message,/não foi confirmada/);
});

for(const [label,mutate] of [
  ['conversation',f=>{f.state.tenant.conversations.push(conversation({id:'other',unread:7}));f.state.conversation='other';}],
  ['workspace',f=>{f.state.workspaceId='other-workspace';}],
  ['tenant',f=>{f.state.tenant={...f.state.tenant,id:'other-tenant'};}],
  ['person',f=>{f.state.boot.session.userId='other-person';}],
  ['support grant',f=>{f.state.supportGrantId='other-grant';}],
  ['route',f=>{f.state.view='contacts';}],
  ['channel',f=>{f.current().channelId='other-channel';}]
])test(`an in-flight response cannot clear the active conversation after changing ${label}`,async()=>{
  const receipt=deferred(),f=fixture({request:()=>receipt.promise}),old=structuredClone(f.current()),pending=f.markConversationRead(f.current());mutate(f);
  const active=f.current(),unread=active.unread;receipt.resolve({...old,version:4,unread:0});assert.equal(await pending,false);
  assert.equal(f.current(),active);assert.equal(f.current().unread,unread);assert.deepEqual(f.kicks,[]);
});

test('read deduplication is scoped by person, workspace, support grant, company, channel and conversation',()=>{
  const f=fixture(),keys=new Set([f.inboxReadKey(f.current())]);
  for(const mutate of [()=>{f.state.boot.session.userId='other';},()=>{f.state.workspaceId='other';},()=>{f.state.supportGrantId='grant';},()=>{f.state.tenant.id='other';},()=>{f.current().channelId='other';},()=>{f.current().id='other';f.state.conversation='other';}]){mutate();keys.add(f.inboxReadKey(f.current()));}
  assert.equal(keys.size,7);
  assert.equal(f.inboxReadAnchor(conversation({messages:[customer('inbound'),{id:'outbound',kind:'assistant'}]})),'inbound');
  assert.equal(f.inboxReadAnchor(conversation({messages:[{id:'outbound',kind:'assistant'}]})),'outbound');assert.equal(f.inboxReadAnchor(conversation({messages:[],version:9})),'9');
});

test('workspace reset clears automatic read attempts along with the existing selection state',async()=>{
  const f=fixture();await f.poll();assert.equal(f.inboxReadAttempts.size,1);f.resetWorkspaceSelection();assert.equal(f.inboxReadAttempts.size,0);assert.equal(f.state.conversation,null);
});
