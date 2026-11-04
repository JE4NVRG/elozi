import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { attachmentIds, outgoingText } from './media.js';
import { resolveReply } from './replies.js';

const idPattern = /^[A-Za-z0-9_-]{1,120}$/;
/**
 * Automated senders, never a person: a service principal acting with its own key (serviceId), or the autopilot execution
 * of agent-autopilot.js (autopilot: true, no userId or serviceId). Operations.canReply decides their authority.
 */
export function automatedSender(actor) {
  const machine = actor?.kind === 'service' && !actor.userId;
  return { service: Boolean(machine && actor.serviceId), autopilot: Boolean(machine && actor.autopilot === true && !actor.serviceId) };
}
/** The job and agent an autopilot send was authorized for: passed by the send gateway, checked again by canReply. */
export function automatedAttribution(value) {
  return Boolean(value) && typeof value === 'object' && idPattern.test(value.agentId ?? '') && idPattern.test(value.autopilotJobId ?? '');
}
/** Authorship of an automated message: the service and its command, or the autopilot job and agent. Empty for a person. */
export function automatedFields(actor, input, attribution) {
  const { service, autopilot } = automatedSender(actor);
  if (service) return { authorServiceId: actor.serviceId, agentId: actor.agentId, serviceCommandId: input.idempotencyKey };
  if (autopilot && automatedAttribution(attribution)) return { agentId: attribution.agentId, autopilotJobId: attribution.autopilotJobId };
  return {};
}

export class Outbox {
  constructor(store, { beforeSend = async () => {}, authorize = () => {} } = {}) {
    this.store = store; this.beforeSend = beforeSend; this.authorize = authorize;
    store.db.exec(`CREATE TABLE IF NOT EXISTS outbound_commands (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, channel_id TEXT NOT NULL, version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id,idempotency_key));`);
    // A process may have stopped after the provider accepted the send. Never replay it blindly.
    store.db.prepare("UPDATE outbound_commands SET state='unknown' WHERE state='in_flight'").run();
  }
  list(actor, tenantId) { this.store.tenant(actor, tenantId); return this.store.db.prepare('SELECT id,conversation_id AS conversationId,state,attempts,created_at AS createdAt FROM outbound_commands WHERE tenant_id=? ORDER BY created_at DESC LIMIT 40').all(tenantId); }
  conversationTenant(actor, tenantId, conversationId) {
    const read = typeof this.store.readonlyConversationTenant === 'function' ? this.store.readonlyConversationTenant : this.store.conversationTenant;
    return typeof read === 'function' ? read.call(this.store, actor, tenantId, conversationId) : this.store.tenant(actor, tenantId);
  }
  async dispatch(actor, tenantId, conversationId, input, send, { reauthorize = () => {}, validate = () => true } = {}) {
    if(typeof reauthorize!=='function')fail(400,'Informe uma validação de sessão válida.');
    if(typeof validate!=='function')fail(400,'Informe uma política de envio válida.');
    const { service, autopilot } = automatedSender(actor);
    // A person answers conversations they own; the autopilot only conversations owned by its agent; a service as authorized.
    const ownerAllowed = conversation => autopilot ? conversation.owner === 'agent' : service || conversation.owner === 'human';
    const currentAuthority = conversation => { reauthorize(); const allowed = this.authorize(actor,tenantId,conversation); if((service || autopilot) && allowed !== true) fail(403,'O serviço não está autorizado para este envio.'); };
    reauthorize();
    const ids = attachmentIds(input), content = outgoingText(input, ids.length > 0);
    const key = input.idempotencyKey || randomUUID();
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) fail(400, 'Identificador de envio inválido.');
    const parts = ids.length ? [conversationId,input.channelId,input.version,content,ids] : [conversationId,input.channelId,input.version,content];
    if (input.replyToMessageId) parts.push(input.replyToMessageId);
    if (input.forwardOrigin) parts.push(['forward', input.forwardOrigin]);
    if (input.poll) parts.push(['poll', input.poll]);
    const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const existing = this.store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(tenantId,key);
    if (existing) {
      const stored=JSON.parse(existing.payload);
      if((stored.supportGrantId||null)!==(actor.supportGrantId||null))fail(403,'Este envio pertence a outro acesso de suporte.');
      if((stored.serviceId||null)!==(actor.serviceId||null)||(stored.serviceCapability||null)!==(actor.serviceCapability||null)||(stored.autopilot===true)!==autopilot)fail(403,'Este envio pertence a outra identidade de serviço.');
      currentAuthority(this.store.getConversation(this.conversationTenant(actor,tenantId,conversationId),conversationId));
      if (existing.content_hash !== hash) fail(409, 'Identificador já utilizado por outra mensagem.');
      if (existing.state === 'confirmed') return this.store.getConversation(this.conversationTenant(actor,tenantId,conversationId),conversationId);
      if (existing.state !== 'pending') throw Object.assign(new Error(existing.state === 'unknown' ? 'Envio sem confirmação. Confira o destino antes de reenviar.' : 'Este envio já está registrado. Confira seu estado antes de tentar novamente.'),{status:409,code:existing.state==='unknown'?'OUTBOUND_UNCONFIRMED':existing.state==='failed'?'OUTBOUND_FAILED':'OUTBOUND_REGISTERED'});
    }
    const tenant = this.conversationTenant(actor,tenantId,conversationId), conversation=this.store.getConversation(tenant,conversationId,input.version);
    currentAuthority(conversation);
    const reply = resolveReply(conversation, input);
    if (!ownerAllowed(conversation)) fail(409,'Assuma a conversa antes de responder.');
    if (conversation.channelId !== input.channelId) fail(400,'Use o canal de origem.');
    const validation=validate();
    if(validation?.then){Promise.resolve(validation).catch(()=>{});fail(500,'A política de envio precisa ser síncrona.');}
    if(validation===false)fail(409,'Esta conexão não permite este envio.');
    if (!existing && ids.length) {
      const used = this.store.db.prepare("SELECT state FROM outbound_commands WHERE tenant_id=? AND conversation_id=? AND state IN ('pending','in_flight','unknown','confirmed') AND EXISTS (SELECT 1 FROM json_each(outbound_commands.payload,'$.attachmentIds') WHERE value=?) LIMIT 1").get(tenantId, conversationId, ids[0]);
      if (used) fail(409, used.state === 'unknown' ? 'Este arquivo já tem um envio sem confirmação. Confira o destino antes de tentar novamente.' : 'Este arquivo já está vinculado a um envio. Confira o atendimento antes de enviar novamente.');
    }
    const id=existing?.id || randomUUID(), date=new Date().toISOString();
    if (!existing) this.store.db.prepare('INSERT INTO outbound_commands VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,tenantId,conversationId,input.channelId,input.version,key,hash,JSON.stringify({text:content,...(service?{serviceId:actor.serviceId,serviceCapability:actor.serviceCapability}:{}),...(autopilot?{autopilot:true}:{}),...(actor.supportGrantId?{supportGrantId:actor.supportGrantId}:{}),...(ids.length ? { attachmentIds: ids } : {}),...(reply ? {replyToMessageId:reply.messageId} : {}),...(input.forwardOrigin?{forwardOrigin:input.forwardOrigin}:{}),...(input.poll?{poll:input.poll}:{})}), 'pending',0,date,date);
    this.store.queuePostgres?.(tenantId);
    try { await this.beforeSend(); reauthorize(); } catch(error) { if(error.status){this.store.db.prepare("UPDATE outbound_commands SET state='failed',updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(),id);this.store.queuePostgres?.(tenantId);throw error;}fail(503,'Envio preservado na fila. Banco indisponível; nenhum disparo foi realizado.'); }
    const claimed=this.store.db.prepare("UPDATE outbound_commands SET state='in_flight',attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(),id);
    if(claimed.changes!==1)fail(409,'Este envio já foi assumido. Aguarde o resultado.');
    this.store.queuePostgres?.(tenantId);
    let providerAttempted=false;
    try {
      await this.beforeSend();
      const current=this.store.getConversation(this.conversationTenant(actor,tenantId,conversationId),conversationId,input.version);
      currentAuthority(current);
      resolveReply(current, input);
      if(!ownerAllowed(current)||current.channelId!==input.channelId)fail(409,'A atribuição da conversa mudou. Atualize antes de enviar.');
      providerAttempted=true;
      const result = await send();
      this.store.db.prepare("UPDATE outbound_commands SET state='confirmed',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
      this.store.queuePostgres?.(tenantId);
      return result;
    } catch(error) {
      const state = !providerAttempted && !error.status ? 'pending' : [400,401,403,404,409,503].includes(error.status) ? 'failed' : 'unknown';
      this.store.db.prepare('UPDATE outbound_commands SET state=?,updated_at=? WHERE id=?').run(state,new Date().toISOString(),id);
      this.store.queuePostgres?.(tenantId); if(state==='unknown')error.code='OUTBOUND_UNCONFIRMED';throw error;
    }
  }
}
