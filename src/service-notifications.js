import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { brazilianMobileAliases, whatsappNumbersMatch } from './whatsapp.js';

const fields=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail(400,'Campos da notificação inválidos.');};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const events=new Set(['request.created','request.updated','contribution.reminder','contribution.logged','notice.created']);
const eligibilityKeys=['adult','membershipCurrent','nonAnonymous','nonDemo','whatsappOptIn','phoneVerified','attestedAt'];
const accepted=new Set(['sent','delivered','read']);
const plainMessage=m=>({id:m.id,kind:m.kind,text:typeof m.text==='string'?m.text:'',createdAt:m.createdAt,delivery:m.delivery||null,attachments:(m.attachments||[]).map(a=>({id:a.id,kind:a.kind,mime:a.mime,size:a.size,name:a.name,status:a.status}))});

/** Transactional messages are product events, independent of attendant ownership and inference.
 * A verified backend attests family membership/consent; browsers never receive this principal. */
export class ServiceNotifications {
  constructor(store,principals,gateway,{media=null,now=()=>Date.now(),recoverInterrupted=true}={}) {
    this.store=store;this.db=store.db;this.principals=principals;this.gateway=gateway;this.media=media;this.now=now;this.dispatches=new WeakMap();
    this.db.exec(`CREATE TABLE IF NOT EXISTS service_notification_policies (
      principal_id TEXT PRIMARY KEY REFERENCES service_principals(id), reseller_id TEXT NOT NULL,tenant_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      app_origin TEXT NOT NULL,product_name TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      FOREIGN KEY(tenant_id) REFERENCES tenants(id));
      CREATE TABLE IF NOT EXISTS service_notification_recipients (
      id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES service_principals(id),reseller_id TEXT NOT NULL,tenant_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      account_id TEXT NOT NULL,person_id TEXT NOT NULL,number TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL,attested_at INTEGER NOT NULL,
      last_input_hash TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(principal_id,account_id,person_id),FOREIGN KEY(tenant_id) REFERENCES tenants(id));
      CREATE UNIQUE INDEX IF NOT EXISTS service_notification_phone_active ON service_notification_recipients(tenant_id,channel_id,number) WHERE active=1;`);
    // Interrupted work is uncertain. It is never dispatched again on boot.
    // A maintenance manager may configure policy without recovering another running server's work.
    if(recoverInterrupted)this.db.prepare("UPDATE service_principal_receipts SET state='unknown',reason='notification-process-interrupted',updated_at=? WHERE capability='notification.send' AND state='dispatched'").run(this.now());
    gateway.notificationAuthority=command=>this.authorizeDispatch(command);
  }
  authority(actor,capability,channelId) {
    const value=this.principals.revalidate(actor,capability,{channelId});
    const tenant=this.store.tenant({role:'operator',resellerId:value.principal.workspaceId,tenantIds:[value.principal.tenantId]},value.principal.tenantId);
    const ids=value.principal.channelIds,channel=tenant.channels?.find(c=>c.id===channelId);
    if(!ids||ids.length!==1||ids[0]!==channelId||value.principal.departmentIds!==null||!channel||channel.kind!=='whatsapp_qr'||channel.transport!=='baileys')fail(403,'A notificação exige um único canal QR próprio.');
    return {...value,tenant,channel};
  }
  configure(actor,tenantId,principalId,input) {
    fields(input,['appOrigin','productName','revision']);
    const scope=this.principals.scope(actor,tenantId),row=this.principals.principal(scope,principalId),principal=this.principals.metadata(row);
    if(!principal.capabilities.includes('notification.send')||principal.channelIds?.length!==1||principal.departmentIds!==null)fail(400,'Escolha um serviço transacional restrito.');
    const channel=scope.tenant.channels.find(c=>c.id===principal.channelIds[0]);
    if(channel?.kind!=='whatsapp_qr'||channel.transport!=='baileys')fail(400,'Escolha o canal QR próprio.');
    let origin;try{const url=new URL(input.appOrigin);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.hostname==='localhost'||/^[\d.:]+$/.test(url.hostname))throw 0;origin=url.origin;}catch{fail(400,'Informe somente a origem HTTPS do aplicativo.');}
    if(typeof input.productName!=='string'||!input.productName.trim()||input.productName.length>40||/[\x00-\x1f\x7f\r\n]/.test(input.productName))fail(400,'Nome do produto inválido.');
    return this.principals.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM service_notification_policies WHERE principal_id=?').get(principalId);
      if(input.revision!==(previous?.revision||0))fail(409,'A política mudou. Atualize antes de salvar.');
      const revision=(previous?.revision||0)+1;
      this.db.prepare('INSERT INTO service_notification_policies VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET channel_id=excluded.channel_id,app_origin=excluded.app_origin,product_name=excluded.product_name,revision=excluded.revision,updated_at=excluded.updated_at').run(principalId,scope.workspaceId,tenantId,channel.id,origin,input.productName.trim(),revision,this.now());
      return {principalId,channelId:channel.id,appOrigin:origin,productName:input.productName.trim(),revision};
    });
  }
  policy(actor,capability='notification.read') {
    const p=this.db.prepare('SELECT * FROM service_notification_policies WHERE principal_id=? AND reseller_id=? AND tenant_id=?').get(actor.principalId,actor.workspaceId,actor.tenantId);
    if(!p)fail(409,'Configure a política transacional deste serviço.');
    this.authority(actor,capability,p.channel_id);return p;
  }
  attest(value) {
    fields(value,eligibilityKeys);
    if(eligibilityKeys.slice(0,-1).some(k=>value[k]!==true))fail(403,'Destinatário sem elegibilidade verificada e consentimento.');
    const when=Date.parse(value.attestedAt);
    if(typeof value.attestedAt!=='string'||!Number.isFinite(when)||when>this.now()+30000||when<this.now()-300000)fail(403,'Revalide a elegibilidade no backend do produto.');
    return when;
  }
  row(actor,recipientId,capability='notification.read') {
    const p=this.policy(actor,capability);
    const row=id(recipientId)&&this.db.prepare('SELECT * FROM service_notification_recipients WHERE id=? AND principal_id=? AND reseller_id=? AND tenant_id=? AND channel_id=?').get(recipientId,actor.principalId,actor.workspaceId,actor.tenantId,p.channel_id);
    if(!row)fail(404,'Destinatário não encontrado neste serviço.');return {p,row};
  }
  recipientDTO(row) {return {id:row.id,accountId:row.account_id,personId:row.person_id,channelId:row.channel_id,phoneSuffix:row.number.slice(-4),active:row.active===1,revision:row.revision,attestedAt:new Date(row.attested_at).toISOString()};}
  readRecipient(actor,recipientId) {return {recipient:this.recipientDTO(this.row(actor,recipientId).row)};}
  bind(actor,recipientId,input) {
    fields(input,['accountId','personId','number','revision','eligibility']);
    if(!id(recipientId)||!id(input.accountId)||!id(input.personId)||!Number.isSafeInteger(input.revision)||input.revision<0)fail(400,'Vínculo de conta e pessoa inválido.');
    const p=this.policy(actor,'notification.recipient.manage'),attestedAt=this.attest(input.eligibility),aliases=brazilianMobileAliases(input.number),number=aliases.find(n=>n.length===13);
    if(!number||aliases.length!==2)fail(400,'Informe um celular brasileiro com DDD.');
    const inputHash=digest({accountId:input.accountId,personId:input.personId,number,revision:input.revision,eligibility:input.eligibility});
    return this.principals.transaction(()=>{
      this.policy(actor,'notification.recipient.manage');
      const previous=this.db.prepare('SELECT * FROM service_notification_recipients WHERE id=?').get(recipientId);
      if(previous&&(previous.principal_id!==actor.principalId||previous.account_id!==input.accountId||previous.person_id!==input.personId||previous.channel_id!==p.channel_id))fail(409,'Este vínculo já pertence a outra identidade.');
      if(previous?.active===1&&previous.last_input_hash===inputHash)return {recipient:this.recipientDTO(previous),replayed:true};
      if(input.revision!==(previous?.revision||0))fail(409,'A versão do destinatário mudou.');
      const collision=this.db.prepare('SELECT id FROM service_notification_recipients WHERE tenant_id=? AND channel_id=? AND number=? AND active=1 AND id<>?').get(actor.tenantId,p.channel_id,number,recipientId);
      const person=this.db.prepare('SELECT id FROM service_notification_recipients WHERE principal_id=? AND account_id=? AND person_id=? AND id<>?').get(actor.principalId,input.accountId,input.personId,recipientId);
      if(collision||person)fail(409,'Telefone ou pessoa já vinculados neste canal.');
      this.db.prepare('INSERT INTO service_notification_recipients VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET number=excluded.number,active=excluded.active,revision=excluded.revision,attested_at=excluded.attested_at,last_input_hash=excluded.last_input_hash,updated_at=excluded.updated_at').run(recipientId,actor.principalId,actor.workspaceId,actor.tenantId,p.channel_id,input.accountId,input.personId,number,1,(previous?.revision||0)+1,attestedAt,inputHash,previous?.created_at||this.now(),this.now());
      return {recipient:this.recipientDTO(this.row(actor,recipientId,'notification.recipient.manage').row),replayed:false};
    });
  }
  revoke(actor,recipientId,input) {
    fields(input,['revision']);
    return this.principals.transaction(()=>{const {row}=this.row(actor,recipientId,'notification.recipient.manage');
      if(input.revision!==row.revision)fail(409,'A versão do destinatário mudou.');
      if(row.active===1)this.db.prepare('UPDATE service_notification_recipients SET active=0,revision=revision+1,updated_at=? WHERE id=?').run(this.now(),recipientId);
      return {recipient:this.recipientDTO(this.row(actor,recipientId,'notification.recipient.manage').row)};
    });
  }
  authorizeDispatch(command) {
    const d=this.dispatches.get(command);if(!d)fail(403,'Despacho transacional não emitido pelo servidor.');
    const {p,row}=this.row(d.actor,d.input.recipientId,'notification.send');
    this.principals.assertDispatchCurrent(d.actor,d.receipt.id);
    this.attest(d.input.eligibility);
    if(row.active!==1||row.revision!==d.input.recipientRevision||row.number!==d.number||row.account_id!==d.input.accountId||row.person_id!==d.input.personId||p.revision!==d.policyRevision||p.channel_id!==d.input.channelId)fail(409,'O destinatário, consentimento ou canal mudou antes do envio.');
    return {actor:{role:'operator',kind:'service',resellerId:d.actor.workspaceId,tenantIds:[d.actor.tenantId],tenantId:d.actor.tenantId,serviceId:d.actor.principalId,agentId:d.actor.agentId,name:p.product_name},tenantId:d.actor.tenantId,channelId:p.channel_id,number:row.number,text:`Você tem um novo aviso no ${p.product_name}. Abra ${p.app_origin}/avisos`,requestId:d.input.requestId,receiptId:d.receipt.id};
  }
  async notify(actor,input) {
    fields(input,['requestId','eventId','recipientId','recipientRevision','accountId','personId','channelId','eventType','eligibility']);
    if(!id(input.requestId)||input.eventId!==input.requestId||!events.has(input.eventType)||!id(input.recipientId)||!id(input.accountId)||!id(input.personId)||!id(input.channelId)||!Number.isSafeInteger(input.recipientRevision))fail(400,'Use a chave original do evento e o destinatário versionado.');
    // Lookup precedes mutable recipient eligibility. A revoked recipient still has an inspectable old outcome.
    let original;try{original=this.principals.getReceiptByRequestId(actor,input.requestId);}catch(e){if(e.status!==404)throw e;}
    const p=this.policy(actor,'notification.send');
    if(input.channelId!==p.channel_id)fail(403,'A origem não pertence a este produto.');
    if(original){
      const context={channelId:p.channel_id};
      this.principals.reserve(actor,{requestId:input.requestId,capability:'notification.send',context,payload:input});
      return this.readOutcome(actor,input.requestId,input.channelId);
    }
    const {row}=this.row(actor,input.recipientId,'notification.send');this.attest(input.eligibility);
    if(row.active!==1||row.revision!==input.recipientRevision||row.account_id!==input.accountId||row.person_id!==input.personId)fail(403,'Revalide o vínculo e o consentimento do destinatário.');
    const reserved=this.principals.reserve(actor,{requestId:input.requestId,capability:'notification.send',context:{channelId:p.channel_id},payload:input});
    const started=this.principals.beginDispatch(actor,reserved.receipt.id);
    if(!started.dispatched)return this.readOutcome(actor,input.requestId,input.channelId);
    const command=Object.freeze({id:randomUUID()}),dispatch={actor,input:structuredClone(input),receipt:started.receipt,number:row.number,policyRevision:p.revision,providerStarted:false};
    this.dispatches.set(command,dispatch);
    try {
      const result=await this.gateway.sendNotification(command,()=>{dispatch.providerStarted=true;});
      this.principals.complete(actor,started.receipt.id,{state:'confirmed',result,reason:'provider-accepted'});
    }catch {
      this.principals.complete(actor,started.receipt.id,{state:dispatch.providerStarted?'unknown':'failed',reason:dispatch.providerStarted?'provider-outcome-unknown':'not-dispatched'});
    }finally {this.dispatches.delete(command);}
    return this.readOutcome(actor,input.requestId,input.channelId);
  }
  messageFor(actor,requestId) {
    const tenant=this.store.tenant({resellerId:actor.workspaceId,role:'operator',tenantIds:[actor.tenantId]},actor.tenantId);
    for(const c of tenant.conversations||[]){const message=(c.messages||[]).find(m=>m.notificationRequestId===requestId&&m.authorServiceId===actor.principalId);if(message)return {conversation:c,message};}return null;
  }
  readOutcome(actor,requestId,channelId) {
    this.authority(actor,'notification.read',channelId);
    let receipt=this.principals.getReceiptByRequestId(actor,requestId);
    if(receipt.capability!=='notification.send'||receipt.context.channelId!==channelId)fail(404,'Notificação não encontrada neste canal.');
    const found=this.messageFor(actor,requestId);
    if(found&&found.conversation.channelId!==channelId)fail(409,'A origem do recibo mudou.');
    const delivery=found?.message.delivery||null;
    if(found&&['unknown','dispatched'].includes(receipt.state)&&accepted.has(delivery))receipt=this.principals.complete(actor,receipt.id,{state:'confirmed',reason:'provider-receipt-reconciled',result:{conversationId:found.conversation.id,messageId:found.message.id,externalId:found.message.externalId}});
    return {schema:'elozi-notification/v1',eventId:requestId,requestId,channelId,receiptId:receipt.id,state:receipt.state,accepted:receipt.state==='confirmed',delivery,humanRead:delivery==='read',retryAllowed:false,result:receipt.result,reason:receipt.reason};
  }
  conversation(actor,recipientId) {
    const {p,row}=this.row(actor,recipientId);if(row.active!==1)fail(403,'Este vínculo foi revogado.');
    const tenant=this.store.tenant({resellerId:actor.workspaceId,role:'operator',tenantIds:[actor.tenantId]},actor.tenantId);
    const conversation=tenant.conversations.find(c=>c.channelId===p.channel_id&&c.conversationKind!=='group'&&[c.remoteJid,...(c.remoteAliases||[])].some(jid=>typeof jid==='string'&&jid.endsWith('@s.whatsapp.net')&&whatsappNumbersMatch(row.number,jid.split('@')[0])));
    return {p,row,conversation};
  }
  history(actor,recipientId) {
    const {row,conversation}=this.conversation(actor,recipientId);
    const messages=(conversation?.messages||[]).filter(m=>['customer','human','agent'].includes(m.kind)&&Date.parse(m.createdAt)>=this.now()-31*86400000).slice(-100).map(plainMessage);
    return {recipient:this.recipientDTO(row),conversationId:conversation?.id||null,messages};
  }
  async attachment(actor,recipientId,attachmentId) {
    const {row,conversation}=this.conversation(actor,recipientId);
    if(!id(attachmentId)||!this.media||!conversation?.messages.some(m=>['customer','human','agent'].includes(m.kind)&&(m.attachments||[]).some(a=>a.id===attachmentId)))fail(404,'Arquivo não encontrado no atendimento vinculado.');
    const context={tenantId:actor.tenantId,conversationId:conversation.id,channelId:row.channel_id};
    const file=await this.media.read(attachmentId,context,{reauthorize:()=>this.conversation(actor,recipientId)});
    try{const current=this.conversation(actor,recipientId);if(current.row.revision!==row.revision||current.conversation?.id!==conversation.id)fail(403,'O vínculo do arquivo mudou.');return file;}catch(e){file.bytes.fill(0);throw e;}
  }
}
