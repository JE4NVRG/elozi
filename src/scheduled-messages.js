import { randomUUID } from 'node:crypto';
import { fail, text } from './store.js';
import { serviceGroupContext } from './service-principals.js';
import { effectiveTenantRows } from './conversation-journal.js';

const createFields = new Set(['version', 'text', 'dueAt', 'commandId']);
const cancelFields = new Set(['version', 'id']);
const cancellable = new Set(['pending', 'blocked', 'failed']);
const DAY = 24 * 60 * 60 * 1000;
const serviceActor = resellerId => ({ role: 'reseller', resellerId, name: 'Agendamento de mensagens' });
const departmentOf = (tenant, conversation) => conversation.departmentId || (tenant.departments || []).find(item => item.name === conversation.department)?.id || null;

function inputObject(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !allowed.has(key))) fail(400, 'Informe somente os campos permitidos do agendamento.');
  if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a versão atual da conversa.');
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) fail(400, 'Informe um identificador válido para o agendamento.');
  return value;
}
function date(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, 'Informe uma data e hora válidas com fuso horário.');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) fail(400, 'Informe uma data e hora válidas.');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(400, 'Informe uma data e hora válidas.');
  return new Date(parsed).toISOString();
}
function synchronous(value, label) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new TypeError(`${label} precisa ser síncrona.`);
  }
  return value;
}
function dto(record, version) {
  const { id, text, dueAt, state, userId, authorName, createdAt, updatedAt, reasonCode, sentAt, cancelledAt } = record;
  return { id, text, dueAt, state, userId, authorName, createdAt, updatedAt, version, ...(record.actorKind==='service'?{actorKind:'service',serviceId:record.serviceId}:{}), ...(reasonCode ? { reasonCode } : {}), ...(sentAt ? { sentAt } : {}), ...(cancelledAt ? { cancelledAt } : {}) };
}

/** One local executor; an uncertain send is terminal and never automatically replayed. */
export function createScheduledMessages(store, { authorize, resolveActor, resolveServiceActor = () => null, send, isTransportReady = () => true, validateSchedule = () => true, now = Date.now } = {}) {
  if (![authorize, resolveActor, resolveServiceActor, send, isTransportReady, validateSchedule, now].every(value => typeof value === 'function')) throw new TypeError('Informe autorização, resolução de identidade, envio, disponibilidade, política e relógio do agendamento.');
  let running = null;
  const timestamp = () => new Date(now()).toISOString();

  function requirePermission(actor, tenantId, conversation, permission) {
    if (synchronous(authorize(actor, tenantId, conversation, permission), 'A autorização do agendamento') === false) fail(403, 'Seu acesso não permite esta ação no atendimento.');
  }
  function responsible(actor, conversation, allowClosed = false) {
    if (!allowClosed && !['open', 'pending'].includes(conversation.status)) fail(409, 'Reabra a conversa antes de agendar uma mensagem.');
    if(actor?.kind==='service'){
      if(!actor.serviceId||actor.serviceCapability!=='message.schedule'||conversation.conversationKind!=='group')fail(403,'A identidade de serviço só pode agendar no grupo autorizado.');
      return;
    }
    if (typeof actor?.userId !== 'string' || !actor.userId || conversation.owner !== 'human' || conversation.assignedUserId !== actor.userId) fail(409, 'Assuma esta conversa com seu acesso antes de alterar o agendamento.');
  }
  function realChannel(tenant, conversation) {
    const channel = (tenant.channels || []).find(item => item.id === conversation.channelId);
    if (!channel || !['baileys', 'telegram-bot','telegram-user','elozi-webchat','mepmail-channel','meta-instagram','meta-messenger'].includes(channel.transport)) fail(400, 'Configure uma conexão real antes de agendar mensagens.');
    return channel;
  }
  function policy(actor, tenantId, conversation, record, channel) {
    if (synchronous(validateSchedule(actor, tenantId, conversation, { text: record.text, dueAt: record.dueAt, channel }), 'A política do canal') === false) fail(409, 'A política desta conexão não permite este agendamento.');
  }
  function create(actor, tenantId, conversationId, input) {
    inputObject(input, createFields);
    const content = text(input.text, 4000), commandId = id(input.commandId), dueAt = date(input.dueAt);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail(400, 'Informe uma mensagem válida.');
    const replay = { value: null };
    try {
      return store.mutate(actor, tenantId, 'Mensagem agendada no atendimento', tenant => {
        const conversation = store.getConversation(tenant, conversationId);
        requirePermission(actor, tenantId, conversation, actor.kind==='service'?'message.schedule':'inbox.reply');
        responsible(actor, conversation);
        const channel = realChannel(tenant, conversation);
        const existing = (conversation.scheduledMessages || []).find(record => record.commandId === commandId);
        if (existing) {
          const sameService=actor.kind==='service'?existing.actorKind==='service'&&existing.serviceId===actor.serviceId&&existing.serviceRevision===actor.serviceRevision&&existing.serviceKeyRevision===actor.serviceKeyRevision&&existing.serviceAdapterHash===actor.serviceAdapterHash:existing.actorKind!=='service'&&existing.userId===actor.userId;
          if (existing.text !== content || existing.dueAt !== dueAt || !sameService || existing.commandVersion !== input.version || (existing.supportGrantId||null)!==(actor.supportGrantId||null)) fail(409, 'Este identificador já pertence a outro agendamento.');
          replay.value = dto(existing, conversation.version); throw replay;
        }
        store.getConversation(tenant, conversationId, input.version);
        const wait = Date.parse(dueAt) - now();
        if (wait < 60000 || wait > 365 * DAY) fail(400, 'Agende entre um minuto e 365 dias a partir de agora.');
        policy(actor, tenantId, conversation, { text: content, dueAt }, channel);
        const createdAt = timestamp();
        const record = { id: randomUUID(), tenantId, conversationId, resellerId: actor.resellerId, userId: actor.userId, authorName: actor.name || 'Atendente', channelId: conversation.channelId, channelKind: channel.kind, channelTransport: channel.transport, departmentId: departmentOf(tenant, conversation), text: content, dueAt, state: 'pending', commandId, commandVersion: input.version, idempotencyKey: `scheduled_${randomUUID()}`, createdAt, updatedAt: createdAt };
        if(actor.kind==='service')Object.assign(record,{actorKind:'service',userId:null,serviceId:actor.serviceId,serviceRevision:actor.serviceRevision,serviceKeyRevision:actor.serviceKeyRevision,serviceAdapterHash:actor.serviceAdapterHash,agentId:actor.agentId,departmentId:conversation.departmentId||null,groupId:serviceGroupContext(tenant,conversation).groupId});
        if(actor.supportGrantId)record.supportGrantId=actor.supportGrantId;
        conversation.scheduledMessages ||= [];
        conversation.scheduledMessages.push(record);
        conversation.version++;
        return dto(record, conversation.version);
      });
    } catch (error) {
      if (error === replay) return replay.value;
      throw error;
    }
  }
  function list(actor, tenantId, conversationId) {
    const conversation = store.getConversation(store.tenant(actor, tenantId), conversationId);
    requirePermission(actor, tenantId, conversation, 'inbox.read');
    return (conversation.scheduledMessages || []).map(record => dto(record, conversation.version));
  }
  function cancel(actor, tenantId, conversationId, input) {
    inputObject(input, cancelFields); id(input.id);
    return store.mutate(actor, tenantId, 'Agendamento cancelado no atendimento', tenant => {
      const conversation = store.getConversation(tenant, conversationId);
      requirePermission(actor, tenantId, conversation, actor.kind==='service'?'message.schedule':'inbox.reply');
      responsible(actor, conversation, true);
      store.getConversation(tenant, conversationId, input.version);
      const record = (conversation.scheduledMessages || []).find(record => record.id === input.id);
      if (!record) fail(404, 'Agendamento não encontrado neste atendimento.');
      if(actor.kind==='service'&&(record.actorKind!=='service'||record.serviceId!==actor.serviceId))fail(403,'Este agendamento não pertence ao serviço.');
      if (!cancellable.has(record.state)) fail(409, 'Este agendamento não pode mais ser cancelado. Confira seu estado antes de agir.');
      record.state = 'cancelled'; record.updatedAt = timestamp(); record.cancelledAt = record.updatedAt;
      delete record.reasonCode;
      conversation.version++;
      return dto(record, conversation.version);
    });
  }

  // Scan stored identities only. Message bodies never enter logs or tick results.
  function candidates(predicate) {
    const result = [];
    for (const row of effectiveTenantRows(store.db)) {
      for (const conversation of JSON.parse(row.data).conversations || []) {
        for (const record of conversation.scheduledMessages || []) if (predicate(record)) result.push({ tenantId: row.id, resellerId: row.reseller_id, conversationId: conversation.id, id: record.id, dueAt: record.dueAt });
      }
    }
    return result;
  }
  function getRecord(tenant, ref) {
    const conversation = store.getConversation(tenant, ref.conversationId);
    const record = (conversation.scheduledMessages || []).find(record => record.id === ref.id);
    if (!record) fail(404, 'Agendamento não encontrado neste atendimento.');
    return { conversation, record };
  }
  function authority(record, ref, conversation) {
    const service=record.actorKind==='service';
    const actor = synchronous(service?resolveServiceActor(record):resolveActor(record.userId, record.resellerId, record), 'A resolução da identidade');
    if (!actor || (service?actor.kind!=='service'||actor.serviceId!==record.serviceId||actor.serviceRevision!==record.serviceRevision||actor.serviceKeyRevision!==record.serviceKeyRevision||actor.serviceAdapterHash!==record.serviceAdapterHash||actor.agentId!==record.agentId:actor.userId!==record.userId) || actor.resellerId !== record.resellerId || record.resellerId !== ref.resellerId || record.tenantId !== ref.tenantId || record.conversationId !== ref.conversationId) fail(403, 'A autoridade deste agendamento mudou.');
    if((actor.supportGrantId||null)!==(record.supportGrantId||null))fail(403,'O acesso temporário deste agendamento mudou.');
    requirePermission(actor, ref.tenantId, conversation, service?'message.schedule':'inbox.reply');
    responsible(actor, conversation);
    const tenant = store.tenant(actor, ref.tenantId);
    if (conversation.channelId !== record.channelId || (service?conversation.departmentId||null:departmentOf(tenant, conversation)) !== record.departmentId) fail(409, 'O destino ou departamento deste agendamento mudou.');
    const channel = realChannel(tenant, conversation);
    if (channel.kind !== record.channelKind || channel.transport !== record.channelTransport) fail(409, 'A conexão deste agendamento mudou.');
    if(service&&serviceGroupContext(tenant,conversation).groupId!==record.groupId)fail(403,'O grupo do agendamento mudou.');
    return actor;
  }
  function finish(ref, expectedState, state, reasonCode) {
    const noop = {};
    try {
      return store.mutate(serviceActor(ref.resellerId), ref.tenantId, 'Estado de agendamento atualizado', tenant => {
        const { conversation, record } = getRecord(tenant, ref);
        if (record.state !== expectedState) throw noop;
        record.state = state; record.updatedAt = timestamp();
        if (reasonCode) record.reasonCode = reasonCode; else delete record.reasonCode;
        if (state === 'sent') record.sentAt = record.updatedAt;
        conversation.version++;
        return state;
      });
    } catch (error) {
      if (error === noop) return null;
      throw error;
    }
  }
  function claim(ref) {
    const noop = {};
    try {
      return store.mutate(serviceActor(ref.resellerId), ref.tenantId, 'Agendamento assumido para envio', tenant => {
        const { conversation, record } = getRecord(tenant, ref);
        if (record.state !== 'pending' || Date.parse(record.dueAt) > now()) throw noop;
        let actor;
        try { actor = authority(record, ref, conversation); }
        catch {
          record.state = 'blocked'; record.reasonCode = 'authority_changed'; record.updatedAt = timestamp(); conversation.version++;
          return { state: 'blocked' };
        }
        let ready = false;
        try { ready = synchronous(isTransportReady(actor, ref.tenantId, conversation), 'A disponibilidade do transporte') === true; }
        catch { /* Keep the pending intent intact when transport status is unavailable. */ }
        if (!ready) throw noop;
        try { policy(actor, ref.tenantId, conversation, record, realChannel(tenant, conversation)); }
        catch {
          record.state = 'blocked'; record.reasonCode = 'channel_policy_changed'; record.updatedAt = timestamp(); conversation.version++;
          return { state: 'blocked' };
        }
        record.state = 'sending'; record.updatedAt = timestamp(); record.claimedAt = record.updatedAt;
        record.attempts = 1;
        conversation.version++;
        record.claimVersion = conversation.version;
        return { state: 'sending', record: { ...record } };
      });
    } catch (error) {
      if (error === noop) return null;
      throw error;
    }
  }
  function revalidate(ref, claimed) {
    const tenant = store.tenant(serviceActor(ref.resellerId), ref.tenantId);
    const { conversation, record } = getRecord(tenant, ref);
    if (record.state !== 'sending' || record.idempotencyKey !== claimed.idempotencyKey || conversation.version !== claimed.claimVersion) fail(409, 'A conversa mudou antes do envio agendado.');
    const actor = authority(record, ref, conversation);
    const latest = getRecord(store.tenant(actor, ref.tenantId), ref);
    if (latest.record.state !== 'sending' || latest.record.idempotencyKey !== claimed.idempotencyKey || latest.conversation.version !== claimed.claimVersion) fail(409, 'A conversa mudou antes do envio agendado.');
    responsible(actor, latest.conversation);
    policy(actor, ref.tenantId, latest.conversation, latest.record, realChannel(store.tenant(actor, ref.tenantId), latest.conversation));
    return actor;
  }
  function outboxState(ref, record) {
    if (!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_commands'").get()) return null;
    return store.db.prepare('SELECT state FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(ref.tenantId, record.idempotencyKey)?.state || null;
  }
  function failedState(ref, record, error) {
    const external = outboxState(ref, record);
    if (external === 'confirmed') return { state: 'sent' };
    if (external === 'unknown' || external === 'in_flight') return { state: 'unknown', reasonCode: 'send_unconfirmed' };
    if (!external && ![400, 401, 403, 404, 409, 422, 503].includes(error?.status)) return { state: 'unknown', reasonCode: 'send_unconfirmed' };
    try {
      const { conversation, record: current } = getRecord(store.tenant(serviceActor(ref.resellerId), ref.tenantId), ref);
      authority(current, ref, conversation);
    } catch { return { state: 'blocked', reasonCode: 'authority_changed' }; }
    if (external === 'failed' || external === 'pending' || [400, 401, 403, 404, 409, 422, 503].includes(error?.status)) return { state: 'failed', reasonCode: 'send_failed' };
    return { state: 'unknown', reasonCode: 'send_unconfirmed' };
  }
  async function drain() {
    const due = candidates(record => record.state === 'pending' && Number.isFinite(Date.parse(record.dueAt)) && Date.parse(record.dueAt) <= now()).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
    const result = { processed: 0, sent: 0, blocked: 0, failed: 0, unknown: 0 };
    let claims = 0;
    for (const ref of due) {
      if (claims >= 5) break;
      const claimed = claim(ref);
      if (!claimed) continue;
      result.processed++;
      if (claimed.state === 'blocked') { result.blocked++; continue; }
      claims++;
      let actor;
      try { actor = revalidate(ref, claimed.record); }
      catch { finish(ref, 'sending', 'blocked', 'authority_changed'); result.blocked++; continue; }
      let outcome;
      try {
        await send(actor, ref.tenantId, ref.conversationId, { text: claimed.record.text, version: claimed.record.claimVersion, channelId: claimed.record.channelId, idempotencyKey: claimed.record.idempotencyKey }, {reauthorize:()=>revalidate(ref,claimed.record)});
        outcome = { state: 'sent' };
      } catch (error) { outcome = failedState(ref, claimed.record, error); }
      finish(ref, 'sending', outcome.state, outcome.reasonCode);
      result[outcome.state]++;
    }
    return result;
  }
  function tick() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }
  function waitIdle() { return running || Promise.resolve(); }
  function recover() {
    if (running) fail(409, 'Aguarde o ciclo de agendamento atual antes da recuperação.');
    let recovered = 0;
    for (const ref of candidates(record => record.state === 'sending')) if (finish(ref, 'sending', 'unknown', 'restart_unconfirmed')) recovered++;
    return { recovered };
  }

  return { create, list, cancel, tick, recover, waitIdle };
}
