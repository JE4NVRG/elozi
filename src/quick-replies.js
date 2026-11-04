import { randomUUID } from 'node:crypto';
import { allowedFields } from './access.js';
import { fail } from './store.js';

const MAX_REPLIES = 200;
const now = () => new Date().toISOString();
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const editable = ['shortcut', 'title', 'text', 'active'];

function fields(input, names) {
  allowedFields(input, names);
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(property => !Object.hasOwn(property, 'value'))) fail(400, 'Informe somente campos de dados.');
}
function text(value, limit, label, multiline = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > limit || !value.trim()
      || forbiddenControls.test(value) || !multiline && /[\t\r\n]/u.test(value)) fail(400, `${label} inválido ou acima do limite de ${limit} caracteres.`);
  return value.trim();
}
function shortcut(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/u.test(value.trim())) fail(400, 'Use de 2 a 32 letras ASCII, números, traços ou sublinhados no atalho.');
  return value.trim().toLowerCase();
}
function active(value) {
  if (typeof value !== 'boolean') fail(400, 'Informe se a resposta rápida está ativa.');
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a versão atual.');
}
function identity(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(400, 'Identidade da resposta rápida inválida.');
}
function repliesOf(tenant) {
  if (tenant.quickReplies === undefined) return [];
  if (!Array.isArray(tenant.quickReplies) || tenant.quickReplies.length > MAX_REPLIES) fail(409, 'O catálogo de respostas rápidas precisa ser revisado.');
  return tenant.quickReplies;
}
function findReply(replies, id) {
  const reply = replies.find(item => item.id === id);
  if (!reply) fail(404, 'Resposta rápida não encontrada nesta empresa.');
  return reply;
}
function unique(replies, value, excludeId) {
  if (replies.some(reply => reply.id !== excludeId && typeof reply.shortcut === 'string' && reply.shortcut.toLowerCase() === value)) fail(409, 'Este atalho já está em uso nesta empresa.');
}
function values(input, creating = false) {
  const result = {};
  if (creating || Object.hasOwn(input, 'shortcut')) result.shortcut = shortcut(input.shortcut);
  if (creating || Object.hasOwn(input, 'title')) result.title = text(input.title, 80, 'Título');
  if (creating || Object.hasOwn(input, 'text')) result.text = text(input.text, 4000, 'Texto', true);
  if (Object.hasOwn(input, 'active')) result.active = active(input.active);
  else if (creating) result.active = true;
  return result;
}

/** The tenant JSON in the active SQLite Store owns this catalogue; no SQL schema is added. */
export class QuickReplies {
  constructor(store, auth) {
    this.store = store?.sync ?? store;
    if (!this.store || typeof this.store.tenant !== 'function' || typeof this.store.mutate !== 'function'
        || typeof this.store.admin !== 'function' || typeof auth?.can !== 'function' || typeof auth?.admin !== 'function') throw new TypeError('Respostas rápidas exigem Store e autorização de acesso.');
    this.auth = auth;
  }
  requireAdmin(actor) { this.store.admin(actor); return this.auth.admin(actor); }
  list(actor, tenantId) {
    if (!this.auth.can(actor, 'inbox.read', { tenantId, aggregate: true })) fail(403, 'Seu acesso não permite consultar respostas rápidas.');
    const tenant = this.store.tenant(actor, tenantId);
    let administrative = false;
    try { this.requireAdmin(actor); administrative = true; }
    catch (error) { if (error.status !== 403) throw error; }
    return structuredClone(repliesOf(tenant).filter(reply => administrative || reply.active === true));
  }
  create(actor, tenantId, input) {
    this.requireAdmin(actor); fields(input, editable);
    const draft = values(input, true);
    return this.store.mutate(actor, tenantId, 'Resposta rápida criada', tenant => {
      this.requireAdmin(actor); const replies = repliesOf(tenant);
      if (replies.length >= MAX_REPLIES) fail(409, 'Limite de 200 respostas rápidas por empresa atingido.');
      unique(replies, draft.shortcut);
      const date = now(), reply = { id: randomUUID(), ...draft, version: 1, createdBy: actor.userId, updatedBy: actor.userId, createdAt: date, updatedAt: date };
      tenant.quickReplies ??= []; tenant.quickReplies.push(reply);
      return structuredClone(reply);
    });
  }
  update(actor, tenantId, replyId, input) {
    this.requireAdmin(actor); identity(replyId); fields(input, [...editable, 'version']); version(input.version);
    const patch = values(input);
    return this.store.mutate(actor, tenantId, 'Resposta rápida atualizada', tenant => {
      this.requireAdmin(actor); const replies = repliesOf(tenant), reply = findReply(replies, replyId);
      if (reply.version !== input.version) fail(409, 'A resposta rápida mudou. Atualize antes de salvar.');
      if (!Number.isSafeInteger(reply.version) || reply.version >= Number.MAX_SAFE_INTEGER) fail(409, 'O limite de versões foi atingido.');
      if (Object.hasOwn(patch, 'shortcut')) unique(replies, patch.shortcut, reply.id);
      Object.assign(reply, patch, { version: reply.version + 1, updatedBy: actor.userId, updatedAt: now() });
      return structuredClone(reply);
    });
  }
}
