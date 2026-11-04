import { randomUUID } from 'node:crypto';
import { fail } from './store.js';

const createFields = new Set(['version', 'commandId', 'kind', 'title', 'nextAction', 'dueAt']);
const updateFields = new Set(['version', 'state', 'nextAction', 'dueAt', 'outcome']);
const kinds = new Set(['support', 'quote', 'task']);
const states = new Set(['pending', 'done', 'cancelled']);
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const own = (object, key) => Object.hasOwn(object, key);

function inputObject(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !fields.has(key))) fail(400, 'Informe somente os campos permitidos do acompanhamento.');
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version >= Number.MAX_SAFE_INTEGER) fail(400, 'Informe a versão atual da conversa.');
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) fail(400, 'Informe um identificador válido para o acompanhamento.');
  return value;
}
function content(value, max, required = false) {
  if (typeof value !== 'string' || controls.test(value) || value.length > max || (required && !value.trim())) fail(400, `Informe um texto válido de até ${max} caracteres.`);
  return value.trim();
}
function dueDate(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, 'Informe uma data ISO com fuso horário ou nulo.');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || (value[16] === ':' && Number(value.slice(17, 19)) > 59) || !Number.isFinite(Date.parse(value))) fail(400, 'Informe uma data e hora válidas.');
  return new Date(value).toISOString();
}
function human(actor) {
  if (!actor || (actor.kind !== undefined && actor.kind !== 'human') || actor.serviceId !== undefined || actor.serviceCapability !== undefined || actor.agentId !== undefined || !['operator', 'reseller'].includes(actor.role) || typeof actor.userId !== 'string' || !actor.userId.trim() || typeof actor.resellerId !== 'string' || !actor.resellerId.trim()) fail(403, 'O acompanhamento manual exige uma pessoa autenticada.');
}
function records(conversation) {
  if (conversation.followUps === undefined) return [];
  if (!Array.isArray(conversation.followUps)) fail(409, 'Os acompanhamentos precisam ser revisados antes de continuar.');
  return conversation.followUps;
}
function dto(record) {
  const { id, kind, title, nextAction, dueAt, state, outcome, userId, authorName, createdAt, updatedAt } = record;
  return { id, kind, title, nextAction, dueAt, state, outcome, userId, authorName, createdAt, updatedAt };
}

/** Manual metadata only: no transport, scheduler, ownership change or AI callback. */
export function createConversationFollowUps(store, { authorize, now = Date.now } = {}) {
  if (typeof authorize !== 'function' || typeof now !== 'function' || typeof store?.mutate !== 'function' || typeof store?.getConversation !== 'function' || typeof store?.tenant !== 'function') throw new TypeError('Informe Store, autorização síncrona e relógio do acompanhamento.');
  function permission(actor, tenantId, tenant, conversation, action) {
    human(actor);
    const departmentId = conversation.departmentId || (tenant.departments || []).find(item => item.name === conversation.department)?.id || null;
    const allowed = authorize(actor, tenantId, { ...conversation, departmentId }, action);
    // Observe rejected asynchronous callbacks, but never await or accept them.
    if (allowed && typeof allowed.then === 'function') Promise.resolve(allowed).catch(() => {});
    if (allowed !== true) fail(403, 'Seu acesso não permite esta ação no atendimento.');
  }
  const timestamp = () => {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw new TypeError('O relógio do acompanhamento precisa retornar um instante válido.');
    return new Date(value).toISOString();
  };
  function list(actor, tenantId, conversationId) {
    human(actor);
    const tenant = store.tenant(actor, tenantId), conversation = store.getConversation(tenant, conversationId);
    permission(actor, tenantId, tenant, conversation, 'inbox.read');
    return { items: records(conversation).map(dto), version: conversation.version };
  }
  function create(actor, tenantId, conversationId, input) {
    human(actor); inputObject(input, createFields);
    const commandId = identifier(input.commandId);
    if (!kinds.has(input.kind)) fail(400, 'Escolha um tipo válido de acompanhamento.');
    const command = { version: input.version, kind: input.kind, title: content(input.title, 160, true), nextAction: content(input.nextAction === undefined ? '' : input.nextAction, 500), dueAt: dueDate(input.dueAt === undefined ? null : input.dueAt) };
    const replay = {};
    try {
      return store.mutate(actor, tenantId, 'Acompanhamento manual criado', tenant => {
        const conversation = store.getConversation(tenant, conversationId);
        permission(actor, tenantId, tenant, conversation, 'inbox.reply');
        const items = records(conversation), existing = items.find(item => item.commandId === commandId);
        if (existing) {
          if (existing.userId !== actor.userId || existing.resellerId !== actor.resellerId || (existing.supportGrantId || null) !== (actor.supportGrantId || null) || JSON.stringify(existing.command) !== JSON.stringify(command)) fail(409, 'Este identificador já pertence a outro acompanhamento.');
          // Throw through Store.mutate to roll back without another audit, queue or event.
          replay.result = structuredClone(existing.creationResult); throw replay;
        }
        store.getConversation(tenant, conversationId, input.version);
        if (items.length >= 40) fail(409, 'Limite de 40 acompanhamentos por conversa atingido.');
        const createdAt = timestamp();
        const record = { id: randomUUID(), tenantId, conversationId, resellerId: actor.resellerId, channelId: conversation.channelId || null, departmentId: conversation.departmentId || (tenant.departments || []).find(item => item.name === conversation.department)?.id || null, userId: actor.userId, authorName: typeof actor.name === 'string' && actor.name.trim() ? actor.name.trim().slice(0, 160) : 'Atendente', kind: command.kind, title: command.title, nextAction: command.nextAction, dueAt: command.dueAt, state: 'pending', outcome: '', createdAt, updatedAt: createdAt, commandId, command };
        if (actor.supportGrantId) record.supportGrantId = actor.supportGrantId;
        conversation.followUps = items;
        items.push(record);
        conversation.version++;
        const result = { item: dto(record), version: conversation.version };
        record.creationResult = structuredClone(result);
        return result;
      });
    } catch (error) {
      if (error === replay) return replay.result;
      throw error;
    }
  }
  function update(actor, tenantId, conversationId, itemId, input) {
    human(actor); identifier(itemId); inputObject(input, updateFields);
    if (Reflect.ownKeys(input).length < 2) fail(400, 'Informe uma alteração do acompanhamento.');
    if (own(input, 'state') && !states.has(input.state)) fail(400, 'Escolha um estado válido de acompanhamento.');
    const patch = {};
    if (own(input, 'nextAction')) patch.nextAction = content(input.nextAction, 500);
    if (own(input, 'dueAt')) patch.dueAt = dueDate(input.dueAt);
    if (own(input, 'outcome')) patch.outcome = content(input.outcome, 500);
    if (own(input, 'state')) patch.state = input.state;
    return store.mutate(actor, tenantId, 'Acompanhamento manual atualizado', tenant => {
      const conversation = store.getConversation(tenant, conversationId);
      permission(actor, tenantId, tenant, conversation, 'inbox.reply');
      store.getConversation(tenant, conversationId, input.version);
      const record = records(conversation).find(item => item.id === itemId);
      if (!record) fail(404, 'Acompanhamento não encontrado nesta conversa.');
      if (record.state !== 'pending') fail(409, 'Este acompanhamento já foi encerrado e não pode ser alterado.');
      const state = patch.state ?? record.state, outcome = patch.outcome ?? record.outcome;
      if (state !== 'pending' && !outcome?.trim()) fail(400, 'Registre o resultado antes de encerrar o acompanhamento.');
      Object.assign(record, patch, { updatedAt: timestamp() });
      conversation.version++;
      return { item: dto(record), version: conversation.version };
    });
  }
  return { list, create, update };
}
