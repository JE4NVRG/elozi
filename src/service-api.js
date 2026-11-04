import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { effectiveTenantDataSql } from './conversation-journal.js';
import { fail } from './store.js';
import { isTelegramAccountChannel, telegramAccountAiAllowed } from './telegram-account-policy.js';
import { AgentAdminProposals } from './agent-admin-proposals.js';
import { serviceGroupContext } from './service-principals.js';
import { groupHistory } from './group-history.js';
import { ServiceQueries } from './service-query.js';
import { noteStatus } from './operations.js';
import { DEFAULT_SERVICE_REPLY_LIMIT_PER_HOUR, privateServiceReplyLimits, ServiceReplyRateLimitError, SERVICE_REPLY_LOOP_GUARD_PER_MINUTE } from './service-reply-limits.js';
import { attentionPointer, scopeEvent, visibleTo } from './events.js';
import { customerFrustrated, customerWantsHuman } from './agent-autopilot.js';
import { ServiceAttachmentReads, outboundServiceAttachment } from './service-attachment-media.js';
import { conversationPhones } from './own-lines.js';
import { brazilianMobileAliases } from './whatsapp.js';
import { ServiceTyping } from './service-typing.js';
import { ServiceInventory } from './service-inventory.js';
import { serviceResponsePolicy } from './service-response-policy.js';
import { normalizePoll, pollChannel, pollText, POLL_LIMITS, servicePollFields } from './whatsapp-polls.js';

/** E.164 of a WhatsApp phone: a Brazilian mobile always carries the ninth digit, even from a legacy 12-digit JID. */
const e164Phone = digits => { let variants = [digits]; try { variants = brazilianMobileAliases(digits); } catch { /* Not a Brazilian number: kept as delivered. */ } return '+' + (variants.find(value => /^55\d{11}$/.test(value)) || digits); };

/** Change pointers a service may wait for: conversations only, never runs, channels or team chat. */
export const SERVICE_EVENT_TYPES = Object.freeze(['conversation.created', 'conversation.message', 'conversation.updated', 'conversation.removed']);
const PUBLIC_KINDS = new Set(['customer', 'human', 'agent']);
/** Provider delivery of a team or agent message; customer messages only carry 'received'. */
const OUTBOUND_DELIVERY = new Set(['pending', 'sent', 'delivered', 'read', 'failed', 'unconfirmed']);
const MAX_WAIT_MS = 25000;
/** A wait that held the connection at least this long, or delivered events, is free (see acquireWait). */
const WAIT_HOLD_MS = 5000;
/** Quick empty waits an identity may chain before the bucket paces it (refilled at waitsPerHour per hour). */
const WAIT_BURST = 20;
/** Private replies of one connected agent in one conversation within an hour (same default as the autopilot). */
export const SERVICE_REPLIES_PER_HOUR = DEFAULT_SERVICE_REPLY_LIMIT_PER_HOUR;
// 413/415: a reply file refused by the media store before any outbox command exists.
const REFUSALS = new Set([400, 401, 403, 404, 409, 413, 415, 422, 503]);
const conversationIdOk = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const plainText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

const fields=(input,allowed)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))fail(400,'Informe somente os campos permitidos da solicitação.');};
const runDTO=run=>({id:run.id,state:run.state,draft:run.draft||null,reason:run.reason||null,conversationId:run.conversationId,conversationVersion:run.conversationVersion,agentId:run.agentId,serviceId:run.serviceId,updatedAt:run.updatedAt,humanApprovalRequired:true});

/** Dedicated bearer namespace. These principals never become human authentication accounts. */
export class ServiceApi {
  readReceipt(actor, requestId) {
    return { tenantId: actor.tenantId, receipt: this.principals.getReceiptByRequestId(actor, requestId) };
  }
  /**
   * Attendant options (agent as attendant): sendPrivate(actor, {context, input, idempotencyKey, reauthorize, internalActor})
   * dispatches a private reply; operations (applyAssignment) applies claims and transfers; events (bus of events.js) serves
   * waits; onManaged(tenantId, conversationId, operation, internalActor) invalidates runtime/autopilot work after a change.
   */
  constructor(store,principals,runtime,{assertGroup=()=>true,sendGroup=null,scheduleGroup=null,sendPrivate=null,operations=null,events=null,onManaged=null,waitsPerHour=120,waitHoldMs=WAIT_HOLD_MS,privateReplyLimits=[],privateMediaPolicy=[],readAttachment=null,ownLines=null,activity=null,sendTyping=null,typing={}}={}) {
    this.store=store;this.principals=principals;this.runtime=runtime;
    // Own lines (own-lines.js) keep agents off both sides of a conversation between two of our lines; activity feeds the panel.
    this.ownLines=ownLines;this.activity=activity;
    this.privateReplyLimits=privateServiceReplyLimits(store,privateReplyLimits);
    this.attachmentReads=new ServiceAttachmentReads(this,{readAttachment,privateMediaPolicy});
    // presence.typing: "digitando…" through the channel adapter, quota-free and receiptless (service-typing.js).
    this.typing=new ServiceTyping(this,{...typing,sendTyping});
    if (typeof assertGroup !== 'function' || sendGroup !== null && typeof sendGroup !== 'function' || scheduleGroup !== null && typeof scheduleGroup !== 'function') throw new TypeError('Informe adaptadores válidos para as ações de grupo.');
    if (sendPrivate !== null && typeof sendPrivate !== 'function' || operations !== null && typeof operations?.applyAssignment !== 'function' || events !== null && typeof events?.waitFor !== 'function'
      || onManaged !== null && typeof onManaged !== 'function' || !Number.isSafeInteger(waitsPerHour) || waitsPerHour < 1 || waitsPerHour > 10000
      || !Number.isSafeInteger(waitHoldMs) || waitHoldMs < 0 || waitHoldMs > MAX_WAIT_MS) throw new TypeError('Informe adaptadores válidos para as ações de atendimento.');
    this.groupActions={assertGroup,sendGroup,scheduleGroup};
    this.attendant={sendPrivate,operations,events,onManaged};this.waitsPerHour=waitsPerHour;this.waitHoldMs=waitHoldMs;
    // Event cursors are bound to this process, identity, revision and key revision; waits have their own limiter.
    this.cursorKey=randomBytes(32);this.activeWaits=new Set();this.waitWindows=new Map();
    this.queries = new ServiceQueries(this);
    this.inventory = new ServiceInventory(this);
    this.adminProposals = new AgentAdminProposals(store, principals, { auth: principals.auth });
    store.db.exec(`CREATE TABLE IF NOT EXISTS service_handoff_requests (
      id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES service_principal_receipts(id),
      principal_id TEXT NOT NULL REFERENCES service_principals(id),tenant_id TEXT NOT NULL REFERENCES tenants(id),
      conversation_id TEXT NOT NULL, conversation_version INTEGER NOT NULL, reason TEXT NOT NULL,
      state TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      decided_by TEXT REFERENCES auth_users(id),decision_reason TEXT
    ); CREATE INDEX IF NOT EXISTS service_handoff_conversation ON service_handoff_requests(tenant_id,conversation_id);`);
  }
  context(actor,conversationId,version) {
    const tenant = this.store.serviceTenant(actor.workspaceId, actor.tenantId, { conversationId }), conversation=tenant?.conversations?.find(c=>c.id===conversationId);
    if(!conversation)fail(404,'Atendimento não encontrado no serviço.');
    return this.conversationContext(actor, tenant, conversation, version);
  }
  conversationContext(actor, tenant, conversation, version) {
    return {workspaceId:actor.workspaceId,tenantId:actor.tenantId,agentId:actor.agentId,conversationId:conversation.id,conversationVersion:version??conversation.version,channelId:conversation.channelId,departmentId:conversation.departmentId||'unassigned',...(conversation.conversationKind==='group'?serviceGroupContext(tenant,conversation):{})};
  }
  withReadScope(actor, visit) {
    return this.principals.withReadScope(actor, scope => visit({ tenant: scope.tenant, check: (conversation, version) => {
      const context = this.conversationContext(actor, scope.tenant, conversation, version);
      scope.check(context);
      if (context.conversationKind === 'group') this.assertGroup(actor, context);
      return context;
    } }));
  }
  revalidateInventoryPage(actor, entries, { groups = false } = {}) {
    this.withReadScope(actor, scope => {
      const byId = new Map(scope.tenant.conversations.map(conversation => [conversation.id, conversation]));
      for (const entry of entries) {
        const conversation = byId.get(entry.id ?? entry.conversationId);
        if (!conversation || groups && conversation.conversationKind !== 'group') fail(403, 'O atendimento não está mais no inventário autorizado.');
        scope.check(conversation, entry.version);
      }
    });
  }
  groupContext(actor,conversationId,version) {
    const context=this.context(actor,conversationId,version);
    if(context.conversationKind!=='group')fail(403,'Escolha um atendimento de grupo selecionado.');
    return context;
  }
  assertGroup(actor,context) {
    const result=this.groupActions.assertGroup(actor,context);
    if(result?.then){Promise.resolve(result).catch(()=>{});throw new TypeError('A seleção do grupo precisa ser síncrona.');}
    if(result===false)fail(403,'Este grupo não está autorizado para o serviço.');
  }
  groupAuthority(actor,conversationId,capability,version) {
    const context=this.groupContext(actor,conversationId,version), authority=this.principals.revalidate(actor,capability,context);
    this.assertGroup(actor,context);return {context,authority};
  }
  listGroups(actor,input) { return this.inventory.list(actor, input, { groups: true }); }
  readGroupHistory(actor,input) {
    fields(input,['requestId','conversationId','after','before','limit','cursor']);
    const {context,authority}=this.groupAuthority(actor,input.conversationId,'conversation.read');
    const conversation=this.store.getConversation(this.store.serviceTenant(actor.workspaceId,actor.tenantId,{conversationId:input.conversationId,includeMessages:true}),input.conversationId);
    const result=groupHistory(conversation,{after:input.after,before:input.before,limit:input.limit,cursor:input.cursor},{tenantId:actor.tenantId,channelId:context.channelId,now:this.principals.now()});
    const reserved=this.principals.reserve(actor,{requestId:input.requestId,capability:'conversation.read',context,units:1,costMicros:0,payload:{operation:'group-history',after:input.after??null,before:input.before??null,limit:input.limit??null,cursor:input.cursor??null}});
    if(!reserved.replayed){this.principals.beginDispatch(actor,reserved.receipt.id);this.principals.complete(actor,reserved.receipt.id,{state:'confirmed',result:{conversationId:input.conversationId,version:context.conversationVersion,includedCount:result.messages.length}});}
    this.groupAuthority(actor,input.conversationId,'conversation.read',context.conversationVersion);
    return {tenantId:actor.tenantId,channelId:context.channelId,groupId:context.groupId,...result,receipt:reserved.receipt.id};
  }
  async sendGroup(actor,input) { return this.groupAction(actor,input,'reply.send'); }
  async scheduleGroup(actor,input) { return this.groupAction(actor,input,'message.schedule'); }
  async groupAction(actor,input,capability) {
    const scheduling=capability==='message.schedule';
    fields(input,['requestId','conversationId','version','text',...(scheduling?['dueAt']:[])]);
    if(!Number.isSafeInteger(input.version)||input.version<1||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)||scheduling&&(typeof input.dueAt!=='string'||input.dueAt.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt)||!Number.isFinite(Date.parse(input.dueAt))))fail(400,'Informe versão, texto de até4000 caracteres e data válida quando agendar.');
    const adapter=this.groupActions[scheduling?'scheduleGroup':'sendGroup'];if(!adapter)fail(503,'A ação de grupo ainda não está conectada.');
    // Replays may carry the pre-effect version, but always recheck current group scope.
    const {context}=this.groupAuthority(actor,input.conversationId,capability);
    context.conversationVersion=input.version;
    const reserved=this.principals.reserve(actor,{requestId:input.requestId,capability,context,units:1,costMicros:0,payload:{text:input.text.trim(),...(scheduling?{dueAt:new Date(input.dueAt).toISOString()}: {})}});
    if(reserved.replayed)return {receipt:reserved.receipt,result:reserved.receipt.result};
    this.principals.beginDispatch(actor,reserved.receipt.id);
    const reauthorize=()=>{this.principals.assertDispatchCurrent(actor,reserved.receipt.id);this.assertGroup(actor,this.groupContext(actor,input.conversationId,input.version));return true;};
    const internalActor=this.principals.executionActor(actor,capability,context);
    try{
      reauthorize();
      const value=adapter(actor,{context,input:{...input,text:input.text.trim()},receipt:reserved.receipt,idempotencyKey:`service_${reserved.receipt.id}`,reauthorize,internalActor});
      if(scheduling&&value?.then){Promise.resolve(value).catch(()=>{});throw Object.assign(new TypeError('O agendamento precisa ser síncrono.'),{status:500});}
      const result=await value;
      if(scheduling&&(!result||typeof result.id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(result.id)))throw new TypeError('O agendamento não retornou um identificador confirmado.');
      const state=scheduling?'confirmed':['confirmed','failed','unknown'].includes(result?.state)?result.state:'unknown';
      const safe={conversationId:input.conversationId,channelId:context.channelId,groupId:context.groupId,state,...(scheduling?{scheduledId:typeof result?.id==='string'?result.id:null,dueAt:new Date(input.dueAt).toISOString()}:{messageId:typeof result?.messageId==='string'?result.messageId:null})};
      const receipt=this.principals.complete(actor,reserved.receipt.id,{state,result:safe});
      const latest=this.groupAuthority(actor,input.conversationId,capability).context;
      if(latest.channelId!==context.channelId||latest.groupId!==context.groupId||latest.departmentId!==context.departmentId||receipt.stale)fail(409,'A autoridade da ação mudou; reconcilie o recibo sem repetir o envio.');
      return {receipt,result:safe};
    }catch(error){
      if(this.principals.receipt(actor,reserved.receipt.id).state==='dispatched'){
        const command=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_commands'").get()?this.store.db.prepare('SELECT state FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(actor.tenantId,`service_${reserved.receipt.id}`):null;
        const state=command?.state==='confirmed'?'confirmed':['unknown','in_flight'].includes(command?.state)?'unknown':[400,401,403,404,409,422,503].includes(error.status)?'failed':'unknown';
        this.principals.complete(actor,reserved.receipt.id,{state,reason:'A ação não foi confirmada. Reconcile o mesmo recibo antes de agir novamente.'});
      }
      throw error;
    }
  }
  readCompany(actor, requestId = randomUUID()) { return this.adminProposals.readCompany(actor, requestId); }
  searchConversations(actor, input) { return this.queries.search(actor, input); }
  readConversationHistory(actor, input) { return this.queries.history(actor, input); }
  proposeAdmin(actor, input) { return this.adminProposals.propose(actor, input); }
  inventoryContext(actor) {
    const principal = this.me(actor).principal, tenant = this.store.serviceTenant(actor.workspaceId, actor.tenantId, { conversationId: null });
    if (!tenant) fail(404, 'Empresa indisponível.');
    const channel = (tenant.channels || []).find(item => !isTelegramAccountChannel(item) && (principal.channelIds === null || principal.channelIds.includes(item.id)));
    const departmentId = principal.departmentIds === null || principal.departmentIds.includes('unassigned') ? 'unassigned' : (tenant.departments || []).find(item => item.active !== false && principal.departmentIds.includes(item.id))?.id;
    return { workspaceId: actor.workspaceId, tenantId: actor.tenantId, agentId: actor.agentId, ...(channel ? { channelId: channel.id } : {}), departmentId: departmentId || 'unassigned' };
  }
  inbox(actor, input) { return this.inventory.list(actor, input); }
  internalActor(actor,authority) {
    return {kind:'service',id:actor.principalId,serviceId:actor.principalId,role:'operator',resellerId:actor.workspaceId,tenantIds:[actor.tenantId],name:authority.principal.name,
      serviceRevision:actor.revision,serviceKeyRevision:actor.keyRevision,serviceAdapterHash:authority.adapterHash};
  }
  me(actor) {
    const proof=this.principals.proofs.get(actor),row=proof&&this.store.db.prepare('SELECT * FROM service_principals WHERE id=?').get(actor.principalId);
    if(!row)fail(401,'Serviço indisponível.');
    const principal=this.principals.metadata(row), {agent}=this.principals.adapter(row, { conversationId: null });
    // Own adapter metadata is identity state, not company inventory: this endpoint is quota-free.
    // Exclude endpoint, instructions, tools/grants and all credential fields.
    const adapter={id:agent.id,version:agent.version||1,provider:agent.provider,mode:agent.mode,configured:agent.configured===true};
    const channels=this.store.serviceTenant(actor.workspaceId,actor.tenantId,{conversationId:null})?.channels||[];
    // Product-assistant policies of the channels this identity may answer; team/QA conversations keep only the loop guard.
    const channelPolicies=channels.filter(channel=>channel?.replyPolicy?.profile==='assistant'&&(principal.channelIds===null||principal.channelIds.includes(channel.id))).map(channel=>({channelId:channel.id,profile:'assistant',perHour:channel.replyPolicy.perHour,perMinute:channel.replyPolicy.perMinute,notice:Boolean(channel.replyPolicy.notice)}));
    const replyRateLimits={defaultPerHour:SERVICE_REPLIES_PER_HOUR,overrides:this.privateReplyLimits.filter(item=>item.tenantId===actor.tenantId&&item.principalId===actor.principalId).map(({channelId,replyLimitPerHour})=>({channelId,replyLimitPerHour})),channelPolicies,teamLoopGuardPerMinute:SERVICE_REPLY_LOOP_GUARD_PER_MINUTE};
    const responsePolicy=serviceResponsePolicy(principal,adapter);
    const publicAgent={...adapter,mode:responsePolicy.effectiveMode,adapterMode:adapter.mode};
    // Native polls (reply.send with poll): the WhatsApp QR channels of this identity's scope; votes arrive as kind poll_vote.
    const pollChannelIds=principal.capabilities.includes('reply.send')?channels.filter(channel=>pollChannel(channel)&&(principal.channelIds===null||principal.channelIds.includes(channel.id))).map(channel=>channel.id):[];
    const polls={channelIds:pollChannelIds,questionMaxLength:POLL_LIMITS.question,minOptions:POLL_LIMITS.minOptions,maxOptions:POLL_LIMITS.maxOptions,optionMaxLength:POLL_LIMITS.option,selectableCount:POLL_LIMITS.selectableCount,voteKind:'poll_vote'};
    return {principal,agent:publicAgent,humanApprovalRequired:responsePolicy.humanApprovalRequired,apiVersion:2,responsePolicy,replyRateLimits,attachmentRead:this.attachmentReads.describe(actor,principal),groupActions:{send:responsePolicy.groups.sendCapable,schedule:responsePolicy.groups.scheduleCapable,scope:'selected-groups',requiresPerMessageApproval:false},typing:this.typing.describe(principal),supportsPolls:pollChannelIds.length>0,polls};
  }
  readAttachment(actor,input) { return this.attachmentReads.read(actor,input); }
  /** "Digitando…" (presence.typing) in a private conversation this identity's agent may answer; never a message. */
  sendTyping(actor,input) { return this.typing.send(actor,input); }
  revalidateAttachmentRead(actor,input,result) { return this.attachmentReads.revalidateResult(actor,input,result); }
  read(actor,conversationId,requestId=randomUUID()) {
    const context=this.context(actor,conversationId),authority=this.principals.revalidate(actor,'conversation.read',context);
    const reservation=this.principals.reserve(actor,{requestId,capability:'conversation.read',context,units:1,costMicros:0,payload:null});
    if(!reservation.replayed){this.principals.beginDispatch(actor,reservation.receipt.id);this.principals.complete(actor,reservation.receipt.id,{state:'confirmed',result:{conversationId,version:context.conversationVersion}});}
    const tenantState=this.store.serviceTenant(actor.workspaceId,actor.tenantId,{conversationId,includeMessages:true}),c=this.store.getConversation(tenantState,conversationId);
    const ownLine=this.ownLines?.pair(actor.tenantId,c);
    // contact.read (explicit grant): the WhatsApp phone of a direct conversation, in E.164. Events never carry it.
    const grants=JSON.parse(this.store.db.prepare('SELECT capabilities FROM service_principals WHERE id=?').get(actor.principalId)?.capabilities||'[]');
    const channel=(tenantState.channels||[]).find(item=>item.id===c.channelId),channelKind=channel?.kind;
    const phone=grants.includes('contact.read')&&channelKind==='whatsapp_qr'&&c.conversationKind!=='group'?conversationPhones(c)[0]:null;
    return {conversation:{id:c.id,contact:c.contact,channelId:c.channelId,departmentId:c.departmentId||null,status:c.status,owner:c.owner,agentId:c.agentId||null,version:c.version,
      // The contact is another line of this operation: agents never answer on both sides of the pair.
      ...(ownLine ? {ownLine:{agentOnOtherSide:ownLine.mirror?.owner==='agent'&&ownLine.mirror.status!=='closed'}} : {}),
      ...(phone ? {contactPhone:e164Phone(phone)} : {}),
      ...(c.supportAssistantHandoff?.active ? {handoffReason:c.supportAssistantHandoff.reason || null} : {}),
      ...(c.webchatVisitor ? {contactIdentity:{email:c.webchatVisitor.email || '',verified:c.webchatVisitor.verified === true,...(c.webchatVisitor.verified === true ? {externalId:c.webchatVisitor.externalId} : {})}} : {}),
      // Current tags: elozi_set_tags replaces the whole list, so an agent must read them before changing one.
      tags:(Array.isArray(c.tags)?c.tags:[]).filter(tag=>typeof tag==='string').slice(0,20),
      // A reply may carry a native poll here (WhatsApp QR, direct conversation); a vote reads as kind poll_vote.
      supportsPolls:pollChannel(channel)&&c.conversationKind!=='group',
      messages:(c.messages||[]).filter(m=>['customer','human','agent'].includes(m.kind)).slice(-100).map(m=>({id:m.id,kind:m.kind,text:m.text||'',createdAt:m.createdAt,...servicePollFields(m),...(m.kind!=='customer'&&OUTBOUND_DELIVERY.has(m.delivery)?{delivery:m.delivery}:{}),attachments:(m.attachments||[]).map(a=>({id:a.id,kind:a.kind,name:a.name,mime:a.mime,size:a.size,...(typeof a.status==='string'?{status:a.status}:{})}))}))},receipt:reservation.receipt.id};
  }
  async draft(actor,input) {
    fields(input,['requestId','conversationId','version','instruction']);
    if(!Number.isSafeInteger(input.version)||input.version<1)fail(400,'Informe a versão atual do atendimento.');
    if(input.instruction!==undefined&&(typeof input.instruction!=='string'||input.instruction.length>1000))fail(400,'Use uma orientação de até 1000 caracteres.');
    const context=this.context(actor,input.conversationId,input.version),authority=this.principals.revalidate(actor,'reply.draft',context);
    if(authority.agent.provider!=='hermes'||authority.agent.mode!=='copilot')fail(409,'Este adaptador ainda não prepara rascunhos no runtime da Elozi.');
    const reserved=this.principals.reserve(actor,{requestId:input.requestId,capability:'reply.draft',context,units:1,costMicros:authority.principal.budgetEnabled?authority.principal.estimatedRequestMicros:0,payload:{instruction:input.instruction||''}});
    if(reserved.replayed){
      const id=reserved.receipt.result?.run?.id,run=id&&this.runtime.list(this.internalActor(actor,authority),actor.tenantId,input.conversationId).find(item=>item.id===id&&item.serviceId===actor.principalId);
      return {receipt:reserved.receipt,run:run?runDTO(run):null,humanApprovalRequired:true};
    }
    const started=this.principals.beginDispatch(actor,reserved.receipt.id);
    if(!started.dispatched)return {receipt:started.receipt,humanApprovalRequired:true};
    try {
      const run=await this.runtime.start(this.internalActor(actor,authority),actor.tenantId,input.conversationId,{version:input.version,agentId:actor.agentId,runId:`service_${reserved.receipt.id}`,idempotencyKey:`service_${reserved.receipt.id}`,instruction:input.instruction||''},
        {authorize:()=>{this.principals.assertDispatchCurrent(actor,reserved.receipt.id);return true;}});
      // start() resolves at a resting state: an automatic lookup chain is awaited, so tool_running never reaches this receipt.
      const successful=['draft','waiting_approval'].includes(run.state),state=successful?'confirmed':run.providerCalled?'unknown':'failed';
      const receipt=this.principals.complete(actor,reserved.receipt.id,{state,result:{run:{...runDTO(run),draft:null}},reason:successful?undefined:'A preparação não terminou com um rascunho válido.'});
      // A completed provider outcome can be retained after revocation without leaking its draft to the old bearer.
      this.principals.revalidate(actor,'reply.draft',context);
      if(receipt.stale)fail(409,'A identidade mudou durante a preparação. O resultado foi preservado para revisão autorizada.');
      return {receipt,run:runDTO(run),humanApprovalRequired:true};
    } catch(error) {
      const current=this.principals.receipt(actor,reserved.receipt.id);
      if(current.state==='dispatched'){
        const run=this.runtime.list(this.internalActor(actor,authority),actor.tenantId,input.conversationId).find(item=>item.id===`service_${reserved.receipt.id}`&&item.serviceId===actor.principalId);
        const attempted=Boolean(run?.providerCalled);
        this.principals.complete(actor,reserved.receipt.id,{state:attempted?'unknown':'failed',reason:attempted?'A preparação foi executada, mas sua confirmação ficou incerta.':'A preparação foi recusada antes de produzir um resultado.'});
      }
      throw error;
    }
  }
  handoff(actor,input) {
    fields(input,['requestId','conversationId','version','reason']);
    if(!Number.isSafeInteger(input.version)||input.version<1||typeof input.reason!=='string'||!input.reason.trim()||input.reason.trim().length>500)fail(400,'Informe versão e motivo da solicitação de apoio.');
    const context=this.context(actor,input.conversationId,input.version);this.principals.revalidate(actor,'handoff.request',context);
    const reserved=this.principals.reserve(actor,{requestId:input.requestId,capability:'handoff.request',context,units:1,costMicros:0,payload:{reason:input.reason.trim()}});
    if(reserved.replayed)return {receipt:reserved.receipt,request:reserved.receipt.result?.request||null};
    this.principals.beginDispatch(actor,reserved.receipt.id);
    const date=new Date().toISOString(),id=randomUUID();
    this.store.db.prepare("INSERT INTO service_handoff_requests VALUES (?,?,?,?,?, ?,?,'pending',1,?,?,NULL,NULL)").run(id,reserved.receipt.id,actor.principalId,actor.tenantId,input.conversationId,input.version,input.reason.trim(),date,date);
    const request=this.handoffDTO(this.store.db.prepare('SELECT * FROM service_handoff_requests WHERE id=?').get(id));
    const receipt=this.principals.complete(actor,reserved.receipt.id,{state:'confirmed',result:{request}});
    this.announceAttention(actor.tenantId,input.conversationId);
    return {receipt,request};
  }
  submitDraft(actor, input) {
    fields(input, ['requestId', 'conversationId', 'version', 'text']);
    if (!Number.isSafeInteger(input.version) || input.version < 1 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) fail(400, 'Informe versão e rascunho de até 8.000 caracteres.');
    const context = this.context(actor, input.conversationId, input.version), authority = this.principals.revalidate(actor, 'reply.submit', context);
    if (authority.agent.provider !== 'mcp' || authority.agent.mode !== 'copilot') fail(409, 'Este adaptador não recebe rascunhos externos.');
    const reserved = this.principals.reserve(actor, { requestId: input.requestId, capability: 'reply.submit', context, units: 1, costMicros: 0, payload: { text: input.text.trim() } });
    const internal = this.internalActor(actor, authority);
    if (reserved.replayed) {
      const id = reserved.receipt.result?.run?.id, run = id && this.runtime.list(internal, actor.tenantId, input.conversationId).find(item => item.id === id && item.serviceId === actor.principalId);
      return { receipt: reserved.receipt, run: run ? runDTO(run) : null, humanApprovalRequired: true };
    }
    const started = this.principals.beginDispatch(actor, reserved.receipt.id);
    if (!started.dispatched) return { receipt: started.receipt, humanApprovalRequired: true };
    try {
      const run = this.runtime.submitExternal(internal, actor.tenantId, input.conversationId, { agentId: actor.agentId, version: input.version,
        runId: `service_${reserved.receipt.id}`, idempotencyKey: `service_${reserved.receipt.id}`, text: input.text },
        { authorize: () => { this.principals.assertDispatchCurrent(actor, reserved.receipt.id); return true; } });
      const receipt = this.principals.complete(actor, reserved.receipt.id, { state: 'confirmed', result: { run: { ...runDTO(run), draft: null } } });
      this.principals.revalidate(actor, 'reply.submit', context);
      if (receipt.stale) fail(409, 'A identidade mudou durante o recebimento do rascunho.');
      return { receipt, run: runDTO(run), humanApprovalRequired: true };
    } catch (error) {
      if (this.principals.receipt(actor, reserved.receipt.id).state === 'dispatched') {
        const run = this.runtime.list(internal, actor.tenantId, input.conversationId).find(item => item.id === `service_${reserved.receipt.id}` && item.serviceId === actor.principalId && item.externalDraft === true);
        this.principals.complete(actor, reserved.receipt.id, run ? { state: 'confirmed', result: { run: { ...runDTO(run), draft: null } } } : { state: 'failed', reason: 'O recebimento do rascunho não foi confirmado.' });
      }
      throw error;
    }
  }
  // ---------------------------------------------------------------------------------------------------------------
  // Agent as attendant: private replies, claims, transfers, tags, closing and change events (FRONTEND-V2 §8.7, MCP)

  /** Context of a private conversation at its current version; groups keep their own actions. */
  privateContext(actor, conversationId) {
    if (!conversationIdOk(conversationId)) fail(400, 'Informe um atendimento válido.');
    const context = this.context(actor, conversationId);
    if (context.conversationKind === 'group') fail(403, 'Grupos têm ações próprias do serviço.');
    return context;
  }
  priorReceipt(actor, requestId) {
    return typeof requestId === 'string' && Boolean(this.store.db.prepare('SELECT 1 FROM service_principal_receipts WHERE principal_id=? AND request_id=?').get(actor.principalId, requestId));
  }
  /** True once a transport recorded the message of this command (serviceCommandId); its version then moved with it. */
  recordedCommand(actor, conversationId, key) {
    const conversation = this.store.serviceTenant(actor.workspaceId, actor.tenantId, { conversationId, includeMessages: true }).conversations.find(item => item.id === conversationId);
    return Boolean(conversation?.messages?.some(message => message?.serviceCommandId === key));
  }
  /** Guardrails of a private reply, over the conversation as it is now: the customer's latest message and the hourly limit. */
  replyGuardrails(actor, authority, conversationId) {
    const current = this.store.serviceTenant(actor.workspaceId, actor.tenantId, { conversationId, includeMessages: true });
    const conversation = this.store.getConversation(current, conversationId);
    this.ownLines?.assertAgentAllowed(actor.tenantId, conversation, { action: 'reply', principalId: actor.principalId });
    const messages = (conversation.messages || []).filter(message => PUBLIC_KINDS.has(message?.kind)), customer = messages.filter(message => message.kind === 'customer').at(-1);
    if (customer) {
      const hasAttachment=Boolean(customer.attachments?.length);
      if (hasAttachment ? !this.attachmentReads.allowsCustomerReply(actor,conversation,customer) : typeof customer.text !== 'string' || !customer.text.trim()) fail(409, 'O cliente enviou mídia ou anexo que o agente não analisa. Transfira para a equipe com elozi_transfer_to_human.');
      if (customerWantsHuman(typeof customer.text==='string'?customer.text:'')) fail(409, 'O cliente pediu atendimento humano. Transfira para a equipe com elozi_transfer_to_human.');
      if (customerFrustrated(typeof customer.text==='string'?customer.text:'')) fail(409, 'O cliente demonstrou insatisfação. Transfira para a equipe com elozi_transfer_to_human.');
    }
    const at = this.principals.now();
    const own = messages.filter(message => message.kind === 'agent' && message.authorServiceId === actor.principalId)
      .map(message => Date.parse(message.createdAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const channel = (current.channels || []).find(item => item.id === conversation.channelId);
    const policy = channel?.replyPolicy?.profile === 'assistant' ? channel.replyPolicy : null, exempt = conversation.replyExempt === true;
    const check = (limit, windowMs, window) => {
      const recent = own.filter(createdAt => createdAt >= at - windowMs);
      if (recent.length < limit) return;
      // The boundary is inclusive; wait until enough messages have left the rolling window.
      const retryAfter = Math.max(1, Math.min(3600, Math.ceil((recent[recent.length - limit] + windowMs + 1 - at) / 1000)));
      throw new ServiceReplyRateLimitError(limit, retryAfter, { window, notice: policy && !exempt ? policy.notice : '' });
    };
    // Team/QA conversations marked by the administrator: no hourly limit, only the loop guard that protects the number.
    if (exempt) return check(SERVICE_REPLY_LOOP_GUARD_PER_MINUTE, 60000, 'minute');
    if (policy) { check(policy.perMinute, 60000, 'minute'); return check(policy.perHour, 3600000, 'hour'); }
    check(this.privateReplyLimits.find(item => item.tenantId === actor.tenantId && item.principalId === actor.principalId && item.channelId === conversation.channelId)?.replyLimitPerHour ?? SERVICE_REPLIES_PER_HOUR, 3600000, 'hour');
  }
  /**
   * Product-assistant channels may tell the person, once per limit window, that the answer comes shortly: the platform
   * sends the channel owner's notice through the same outbox and transport, keyed per conversation and window.
   */
  async sendLimitNotice(actor, conversationId, error) {
    const adapter = this.attendant.sendPrivate;
    if (!adapter || !error.notice) return;
    try {
      const windowMs = error.rateLimit.window === 'minute' ? 60000 : 3600000, bucket = Math.floor(this.principals.now() / windowMs);
      const key = 'svcnotice_' + createHmac('sha256', this.cursorKey).update(JSON.stringify([actor.principalId, conversationId, error.rateLimit.window, bucket])).digest('hex').slice(0, 48);
      if (this.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='outbound_commands'").get()
        && this.store.db.prepare('SELECT 1 FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(actor.tenantId, key)) return;
      const context = this.privateContext(actor, conversationId), reauthorize = () => { this.principals.revalidate(actor, 'reply.send', context); return true; };
      const internalActor = this.principals.executionActor(actor, 'reply.send', context);
      const result = await adapter(actor, { context, input: { conversationId, version: context.conversationVersion, text: error.notice }, idempotencyKey: key, reauthorize, internalActor });
      error.noticeSent = result?.state === 'confirmed';
    } catch { error.noticeSent = false; }
  }
  /**
   * Private reply of a connected agent (reply.send): only in a conversation owned by this identity's agent, MCP agents only,
   * exact version, receipt, outbox key service_<receipt>. A request for a person, frustration or media in the customer's
   * latest message refuses with 409 and the transfer tool. An uncertain result is never resent.
   */
  async sendReply(actor, input) {
    fields(input, ['requestId', 'conversationId', 'version', 'text', 'attachment', 'poll']);
    // A native poll (WhatsApp QR) is the whole message: its readable line becomes the text of the timeline and the outbox.
    const poll = input.poll === undefined ? null : normalizePoll(input.poll);
    if (poll && (input.text !== undefined || input.attachment !== undefined)) fail(400, 'Envie a enquete sem text nem attachment: a pergunta e as opções são a mensagem.');
    // A file makes the text an optional caption; the channel's own caption limit is applied by the send policy.
    const withFile = input.attachment !== undefined, rawText = poll ? pollText(poll) : input.text === undefined && withFile ? '' : input.text;
    if (!Number.isSafeInteger(input.version) || input.version < 1 || typeof rawText !== 'string' || rawText.length > 4000 || (!withFile || rawText.trim()) && !plainText(rawText, 4000))
      fail(400, 'Informe versão e texto de até 4000 caracteres, ou um anexo com legenda opcional.');
    const adapter = this.attendant.sendPrivate;
    if (!adapter) fail(503, 'O envio do agente ainda não está conectado neste servidor.');
    const attachment = withFile ? outboundServiceAttachment(input.attachment) : null;
    try {
      // Replays may carry the pre-effect version; scope and ownership are always checked at the current version.
      const context = this.privateContext(actor, input.conversationId), authority = this.principals.revalidate(actor, 'reply.send', context);
      context.conversationVersion = input.version;
      if (poll && !pollChannel((this.store.serviceTenant(actor.workspaceId, actor.tenantId, { conversationId: input.conversationId }).channels || []).find(item => item.id === context.channelId)))
        fail(400, 'Enquete só em conversa do WhatsApp por QR. Confira supportsPolls na leitura da conversa.');
      if (!this.priorReceipt(actor, input.requestId)) {
        try { this.replyGuardrails(actor, authority, input.conversationId); }
        catch (error) {
          if (error instanceof ServiceReplyRateLimitError) {
            await this.sendLimitNotice(actor, input.conversationId, error);
            this.activity?.record({ type: 'reply-limit', tenantId: actor.tenantId, principalId: actor.principalId, conversationId: input.conversationId, window: error.rateLimit.window, max: error.rateLimit.max, noticeSent: error.noticeSent === true });
          }
          throw error;
        }
      }
      const text = rawText.trim(), file = attachment && { mime: attachment.mime, name: attachment.name, size: attachment.size, sha256: attachment.sha256 };
      const reserved = this.principals.reserve(actor, { requestId: input.requestId, capability: 'reply.send', context, units: 1, costMicros: 0, payload: poll ? { poll } : file ? { text, attachment: file } : { text } });
      if (reserved.replayed) return { receipt: reserved.receipt, result: reserved.receipt.result };
      return await this.dispatchReply(actor, input, { context, reserved, text, attachment, poll, adapter });
    } finally { attachment?.bytes.fill(0); }
  }
  async dispatchReply(actor, input, { context, reserved, text, attachment, poll = null, adapter }) {
    this.principals.beginDispatch(actor, reserved.receipt.id);
    const idempotencyKey = `service_${reserved.receipt.id}`;
    // Before the transport records the message: exact version. After it (dispatch checks): scope and ownership only.
    const reauthorize = () => { this.principals.assertDispatchCurrent(actor, reserved.receipt.id, { recorded: this.recordedCommand(actor, input.conversationId, idempotencyKey) }); return true; };
    try {
      reauthorize();
      const internalActor = this.principals.executionActor(actor, 'reply.send', context);
      const result = await adapter(actor, { context, input: { ...input, text, ...(attachment ? { attachment } : {}), ...(poll ? { poll } : {}) }, receipt: reserved.receipt, idempotencyKey, reauthorize, internalActor });
      const state = ['confirmed', 'failed', 'unknown'].includes(result?.state) ? result.state : 'unknown';
      const safe = { conversationId: input.conversationId, channelId: context.channelId, state, messageId: typeof result?.messageId === 'string' ? result.messageId : null };
      const receipt = this.principals.complete(actor, reserved.receipt.id, { state, result: safe });
      if (receipt.stale) fail(409, 'A autoridade do envio mudou; reconcilie o recibo sem repetir o envio.');
      return { receipt, result: safe };
    } catch (error) {
      if (this.principals.receipt(actor, reserved.receipt.id).state === 'dispatched') {
        const command = this.store.db.prepare('SELECT state FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(actor.tenantId, idempotencyKey);
        const state = command?.state === 'confirmed' ? 'confirmed' : ['unknown', 'in_flight'].includes(command?.state) ? 'unknown' : REFUSALS.has(error.status) ? 'failed' : 'unknown';
        this.principals.complete(actor, reserved.receipt.id, { state, reason: 'O envio não foi confirmado. Reconcilie o mesmo recibo antes de agir novamente.' });
      }
      throw error;
    }
  }
  /**
   * One conversation.manage action: current scope before reserving, receipt, then one mutation at the exact version that
   * revalidates the dispatch inside the transaction. onManaged invalidates in-flight agent work afterwards.
   */
  manageAction(actor, input, operation, extraFields, check, apply, label) {
    fields(input, ['requestId', 'conversationId', 'version', ...extraFields]);
    if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a versão atual do atendimento.');
    if (!this.attendant.operations) fail(503, 'A gestão do atendimento pelo agente ainda não está conectada neste servidor.');
    const payload = check(input);
    const context = this.privateContext(actor, input.conversationId), authority = this.principals.revalidate(actor, 'conversation.manage', context);
    context.conversationVersion = input.version;
    const reserved = this.principals.reserve(actor, { requestId: input.requestId, capability: 'conversation.manage', context, units: 1, costMicros: 0, payload: { operation, ...payload } });
    if (reserved.replayed) return { receipt: reserved.receipt, result: reserved.receipt.result };
    this.principals.beginDispatch(actor, reserved.receipt.id);
    const internal = this.internalActor(actor, authority);
    try {
      const result = this.store.mutate(internal, actor.tenantId, label, state => {
        this.principals.assertDispatchCurrent(actor, reserved.receipt.id);
        const conversation = this.store.getConversation(state, input.conversationId, input.version);
        if (conversation.status === 'closed') fail(409, 'O atendimento está encerrado.');
        if (conversation.conversationKind === 'group') fail(403, 'Grupos têm ações próprias do serviço.');
        const own = conversation.owner === 'agent' && conversation.agentId === actor.agentId;
        return { conversationId: conversation.id, operation, ...apply({ state, conversation, internal, own, payload, authority }), version: conversation.version };
      });
      const receipt = this.principals.complete(actor, reserved.receipt.id, { state: 'confirmed', result });
      try { this.attendant.onManaged?.(actor.tenantId, input.conversationId, operation, internal); } catch { /* The change is committed; in-flight work revalidates on its own. */ }
      return { receipt, result };
    } catch (error) {
      if (this.principals.receipt(actor, reserved.receipt.id).state === 'dispatched') this.principals.complete(actor, reserved.receipt.id, { state: 'failed', reason: 'A ação não foi aplicada. Leia o atendimento antes de pedir outra ação.' });
      throw error;
    }
  }
  /** Takes a queue conversation without a responsible person for this identity's agent. */
  claimConversation(actor, input) {
    return this.manageAction(actor, input, 'claim', [], () => ({}), ({ state, conversation, internal }) => {
      if ((conversation.owner || 'queue') !== 'queue' || conversation.assignedUserId || conversation.agentId || conversation.participants?.length) fail(409, 'Somente atendimentos da fila, sem responsável, podem ser assumidos pelo agente.');
      const agent = (state.agents || []).find(item => item.id === actor.agentId);
      if (!agent || agent.configured !== true || agent.mode !== 'copilot') fail(409, 'Configure o agente como copiloto antes de assumir atendimentos.');
      this.ownLines?.assertAgentAllowed(actor.tenantId, conversation, { action: 'claim', principalId: actor.principalId, state });
      this.attendant.operations.applyAssignment(conversation, internal, { owner: 'agent', agent, reason: 'Assumido pelo agente conectado.', origin: 'service' });
      return { owner: 'agent', agentId: agent.id };
    }, 'Atendimento assumido pelo agente conectado');
  }
  /** Real handoff of an own conversation: the queue, or an active department in this identity's scope, plus an internal note. */
  transferToHuman(actor, input) {
    return this.manageAction(actor, input, 'transfer', ['reason', 'departmentId'], value => {
      if (!plainText(value.reason, 500)) fail(400, 'Informe o motivo da transferência com até 500 caracteres.');
      if (value.departmentId !== undefined && value.departmentId !== null && !conversationIdOk(value.departmentId)) fail(400, 'Escolha um departamento válido.');
      return { reason: value.reason.trim(), departmentId: value.departmentId ?? null };
    }, ({ state, conversation, internal, own, payload, authority }) => {
      if (!own) fail(409, 'O agente transfere somente atendimentos atribuídos a ele.');
      let department;
      if (payload.departmentId) {
        department = (state.departments || []).find(item => item.id === payload.departmentId && item.active !== false);
        if (!department) fail(409, 'Escolha um departamento ativo desta empresa.');
        const scope = authority.principal.departmentIds;
        if (scope !== null && !scope.includes(department.id)) fail(403, 'O departamento não está no acesso deste serviço.');
      }
      this.attendant.operations.applyAssignment(conversation, internal, { owner: 'queue', ...(department ? { department } : {}), reason: `Agente conectado: ${payload.reason}`, origin: 'service' });
      conversation.messages ||= [];
      conversation.messages.push({ id: randomUUID(), kind: 'internal', text: `${internal.name} passou o atendimento para a equipe. Motivo: ${payload.reason}`, authorName: internal.name,
        authorServiceId: actor.principalId, createdAt: conversation.updatedAt });
      return { owner: 'queue', departmentId: conversation.departmentId || null };
    }, 'Atendimento transferido pelo agente conectado');
  }
  /**
   * Hands an own conversation straight to another connected (MCP copilot) agent of the same company, without the human
   * queue: e.g. a product's seller agent passing a verified administrator to its admin agent. The assignment event and its
   * system note record the change; the target agent then answers with its own identity.
   */
  handOverConversation(actor, input) {
    return this.manageAction(actor, input, 'handover', ['agentId', 'reason'], value => {
      if (!conversationIdOk(value.agentId)) fail(400, 'Escolha o agente conectado que recebe o atendimento.');
      if (value.reason !== undefined && !plainText(value.reason, 240)) fail(400, 'Use um motivo de até 240 caracteres.');
      return { agentId: value.agentId, reason: typeof value.reason === 'string' ? value.reason.trim() : '' };
    }, ({ state, conversation, internal, own, payload }) => {
      if (!own) fail(409, 'O agente repassa somente atendimentos atribuídos a ele.');
      if (payload.agentId === actor.agentId) fail(409, 'O atendimento já é deste agente.');
      const agent = (state.agents || []).find(item => item.id === payload.agentId);
      if (!agent || agent.provider !== 'mcp' || agent.mode !== 'copilot' || agent.configured !== true) fail(409, 'Escolha um agente conectado via MCP, em modo copiloto, desta empresa.');
      this.ownLines?.assertAgentAllowed(actor.tenantId, conversation, { action: 'handover', principalId: actor.principalId, state });
      this.attendant.operations.applyAssignment(conversation, internal, { owner: 'agent', agent, reason: payload.reason || 'Repassado pelo agente conectado.', origin: 'service' });
      return { owner: 'agent', agentId: agent.id };
    }, 'Atendimento repassado entre agentes conectados');
  }
  /** Replaces the tags of an own conversation or of a queue conversation without a responsible person. */
  setTags(actor, input) {
    return this.manageAction(actor, input, 'tags', ['tags'], value => {
      if (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(tag => !plainText(tag, 48))) fail(400, 'Informe até 20 etiquetas de 1 a 48 caracteres.');
      return { tags: [...new Set(value.tags.map(tag => tag.trim()))] };
    }, ({ conversation, own, payload }) => {
      if (!own && !((conversation.owner || 'queue') === 'queue' && !conversation.assignedUserId)) fail(409, 'O agente altera etiquetas só em atendimentos atribuídos a ele ou da fila.');
      conversation.tags = payload.tags; conversation.version = (conversation.version || 1) + 1; conversation.updatedAt = new Date(this.principals.now()).toISOString();
      return { tags: payload.tags };
    }, 'Etiquetas definidas pelo agente conectado');
  }
  /** Closes an own conversation, never one whose latest public message is an unanswered customer message. */
  closeConversation(actor, input) {
    return this.manageAction(actor, input, 'close', ['reason'], value => {
      if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 240 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.reason))) fail(400, 'Use um motivo de até 240 caracteres.');
      return { reason: typeof value.reason === 'string' ? value.reason.trim() : '' };
    }, ({ conversation, internal, own, payload }) => {
      if (!own) fail(409, 'O agente encerra somente atendimentos atribuídos a ele.');
      if ((conversation.messages || []).filter(message => PUBLIC_KINDS.has(message?.kind)).at(-1)?.kind === 'customer') fail(409, 'A última mensagem do cliente ainda não foi respondida. Responda ou transfira antes de encerrar.');
      const previous = conversation.status;
      conversation.status = 'closed';
      this.attendant.operations.clearParticipants?.(conversation, internal, { origin: 'service', reason: 'Atendimento encerrado pelo agente conectado.' });
      noteStatus(conversation, internal, previous, { reason: payload.reason, origin: 'service' });
      conversation.version = (conversation.version || 1) + 1; conversation.updatedAt = new Date(this.principals.now()).toISOString();
      return { status: 'closed' };
    }, 'Atendimento encerrado pelo agente conectado');
  }
  signCursor(actor, cursor) {
    const mac = createHmac('sha256', this.cursorKey).update(`${actor.principalId}\u0000${actor.revision}\u0000${actor.keyRevision}\u0000${cursor}`).digest('base64url').slice(0, 32);
    return `${cursor}.${mac}`;
  }
  /** Bus position of a signed cursor; a cursor of another identity, revision or key starts over (null → resync). */
  eventCursor(actor, value) {
    if (value === undefined || value === null || value === '') return null;
    const match = typeof value === 'string' && value.length <= 120 ? /^([0-9a-f]{12}-[0-9a-z]{1,11})\.([A-Za-z0-9_-]{32})$/.exec(value) : null;
    if (!match) fail(400, 'Cursor de eventos inválido.');
    return timingSafeEqual(Buffer.from(this.signCursor(actor, match[1]).slice(-32)), Buffer.from(match[2])) ? match[1] : null;
  }
  /**
   * One wait at a time per identity; waits never consume the daily request quota. A wait that delivers events or holds
   * the connection for waitHoldMs (the documented 20 s long poll) is free, so an attendant that keeps waiting never runs
   * out of events. Only quick empty returns (resync without a cursor, very short timeouts, early disconnects) draw from
   * a bucket of WAIT_BURST refilled at waitsPerHour per hour: a client looping without waiting gets 429 with a
   * Retry-After of seconds, never an hour without events. Returns release({ delivered }).
   */
  acquireWait(actor) {
    const key = actor.principalId, now = this.principals.now(), perToken = 3600000 / this.waitsPerHour, capacity = Math.min(WAIT_BURST, this.waitsPerHour);
    if (this.activeWaits.has(key)) fail(429, 'Este agente já tem uma espera de eventos em andamento.');
    const previous = this.waitWindows.get(key);
    const bucket = previous ? { tokens: Math.min(capacity, previous.tokens + Math.max(0, now - previous.at) / perToken), at: Math.max(previous.at, now) } : { tokens: capacity, at: now };
    this.waitWindows.delete(key); this.waitWindows.set(key, bucket);
    while (this.waitWindows.size > 10000) this.waitWindows.delete(this.waitWindows.keys().next().value);
    if (bucket.tokens < 1) throw Object.assign(new Error('Muitas esperas de eventos terminaram vazias em seguida. Espere com timeoutMs de 20000 ou tente novamente em instantes.'),
      { status: 429, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) * perToken / 1000)) });
    this.activeWaits.add(key);
    const started = performance.now();
    return ({ delivered = 0 } = {}) => {
      this.activeWaits.delete(key);
      if (delivered > 0 || performance.now() - started >= this.waitHoldMs) return;
      const current = this.waitWindows.get(key);
      if (current) current.tokens = Math.max(0, current.tokens - 1);
    };
  }
  eventScope(actor, principal) {
    const row = this.store.db.prepare('SELECT data FROM tenants WHERE id=? AND reseller_id=?').get(actor.tenantId, actor.workspaceId);
    const tenant = row && JSON.parse(row.data), channels = tenant?.channels || [];
    const channelIds = channels.filter(channel => !isTelegramAccountChannel(channel) && (principal.channelIds === null || principal.channelIds.includes(channel.id))).map(channel => channel.id);
    return { tenantId: actor.tenantId, channelIds, departmentIds: principal.departmentIds, agentId: actor.agentId, includeGroups: false };
  }
  /** Service DTO of a pointer: no person ids, no previous route, no content. */
  eventDTO(actor, event) {
    if (event.left) return { type: event.type, at: event.at, conversationId: event.conversationId, ...(Number.isSafeInteger(event.version) ? { version: event.version } : {}), left: true };
    return { type: event.type, at: event.at, conversationId: event.conversationId, channelId: event.channelId ?? null, departmentId: event.departmentId ?? null,
      status: event.status ?? null, owner: event.owner ?? null, assignedToMe: event.owner === 'agent' && event.agentId === actor.agentId,
      version: Number.isSafeInteger(event.version) ? event.version : null,
      ...(event.type === 'conversation.message' ? { messageId: event.messageId ?? null, kind: event.kind === 'customer' && event.entry === 'poll_vote' ? 'poll_vote' : event.kind ?? null } : {}), ...(Array.isArray(event.changes) ? { changes: [...event.changes] } : {}) };
  }
  /**
   * events.read: waits up to 25 s for conversation pointers in this identity's scope (company, channels, departments; no
   * groups; conversations of other agents hidden). Revalidated before waiting and on wake; aborted when the client leaves.
   * Without a cursor, or with a cursor of another process, identity or revision, it answers resync with a fresh cursor.
   */
  async waitForEvents(actor, input = {}, { signal } = {}) {
    fields(input, ['requestId', 'cursor', 'timeoutMs', 'types']);
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.requestId))) fail(400, 'Informe uma chave de solicitação válida.');
    const timeoutMs = input.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) fail(400, 'Use uma espera de 0 a 25000 ms.');
    const types = input.types ?? SERVICE_EVENT_TYPES;
    if (!Array.isArray(types) || !types.length || types.length > SERVICE_EVENT_TYPES.length || types.some(type => !SERVICE_EVENT_TYPES.includes(type))) fail(400, 'Escolha tipos de evento de conversa válidos.');
    if (!this.attendant.events) fail(503, 'Os eventos do atendimento ainda não estão disponíveis neste servidor.');
    const authority = this.principals.revalidate(actor, 'events.read', this.inventoryContext(actor)), position = this.eventCursor(actor, input.cursor);
    const scope = this.eventScope(actor, authority.principal), wanted = new Set(types);
    const filter = event => wanted.has(event.type) && (event.type !== 'conversation.message' || PUBLIC_KINDS.has(event.kind)) && visibleTo(event, scope);
    const release = this.acquireWait(actor);
    let result;
    try { result = await this.attendant.events.waitFor({ tenantId: actor.tenantId, cursor: position ?? undefined, timeoutMs, signal, filter, limit: 50 }); }
    catch (error) {
      if (signal?.aborted || error?.status === 499) throw Object.assign(new Error('Espera de eventos cancelada.'), { status: 499 });
      throw error;
    } finally { release({ delivered: result?.events?.length || 0 }); }
    // Authority may change while waiting: a revoked or changed identity never receives what arrived meanwhile.
    const latest = this.principals.revalidate(actor, 'events.read', this.inventoryContext(actor)), current = this.eventScope(actor, latest.principal);
    const tenant = this.store.tenant(this.internalActor(actor, latest), actor.tenantId);
    const events = result.events.filter(event => telegramAccountAiAllowed(tenant, event)).map(event => scopeEvent(event, current)).filter(Boolean).map(event => this.eventDTO(actor, event));
    return { events, cursor: this.signCursor(actor, result.cursor), resync: result.resync === true, timedOut: result.timedOut === true, ...(input.requestId ? { requestId: input.requestId } : {}) };
  }
  /**
   * Support requests live outside the tenant JSON, so no committed mutation announces them: a pointer with the route of
   * the conversation wakes the attention pulse of the people who see it (decided again per person by the event stream).
   */
  announceAttention(tenantId, conversationId) {
    const bus = this.attendant.events;
    if (typeof bus?.publish !== 'function') return;
    try {
      const row = this.store.db.prepare(`SELECT ${effectiveTenantDataSql(this.store.db, 't')} AS data FROM tenants t WHERE t.id=?`).get(tenantId), tenant = row ? { ...JSON.parse(row.data), id: tenantId } : null;
      const conversation = tenant?.conversations?.find(item => item?.id === conversationId);
      if (conversation) bus.publish(attentionPointer(tenant, conversation));
    } catch { /* The periodic attention pulse still converges. */ }
  }
  handoffDTO(row) {return {id:row.id,serviceId:row.principal_id,conversationId:row.conversation_id,conversationVersion:row.conversation_version,reason:row.reason,state:row.state,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,decidedBy:row.decided_by,decisionReason:row.decision_reason};}
  handoffs(actor,tenantId,conversationId) {
    this.store.getConversation(this.store.tenant(actor,tenantId),conversationId);
    return {requests:this.store.db.prepare('SELECT * FROM service_handoff_requests WHERE tenant_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 30').all(tenantId,conversationId).map(row=>({...this.handoffDTO(row),serviceName:this.store.db.prepare('SELECT name FROM service_principals WHERE id=?').get(row.principal_id)?.name||'Serviço'}))};
  }
  decide(actor,tenantId,conversationId,id,input) {
    fields(input,['version','action','reason']);
    if(!actor.userId||!Number.isSafeInteger(input.version)||!['acknowledge','decline'].includes(input.action)||typeof input.reason!=='string'||input.reason.trim().length>500)fail(400,'Informe a decisão e a revisão da solicitação.');
    this.store.getConversation(this.store.tenant(actor,tenantId),conversationId);
    const changed=this.store.db.prepare("UPDATE service_handoff_requests SET state=?,version=version+1,updated_at=?,decided_by=?,decision_reason=? WHERE id=? AND tenant_id=? AND conversation_id=? AND state='pending' AND version=?")
      .run(input.action==='acknowledge'?'acknowledged':'declined',new Date().toISOString(),actor.userId,input.reason.trim(),id,tenantId,conversationId,input.version);
    if(changed.changes!==1)fail(409,'A solicitação mudou ou já foi atendida. Atualize antes de decidir.');
    this.announceAttention(tenantId,conversationId);
    return {request:this.handoffDTO(this.store.db.prepare('SELECT * FROM service_handoff_requests WHERE id=?').get(id))};
  }
}
