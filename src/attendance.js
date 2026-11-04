import { randomUUID } from 'node:crypto';
import { fail, text } from './store.js';

const noteFields = new Set(['version', 'text', 'commandId']);
const readFields = new Set(['version', 'unread']);

function inputObject(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => !allowed.has(key))) {
    fail(400, 'Informe somente os campos permitidos do atendimento.');
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) fail(400, 'Informe a versão atual da conversa.');
}

/** Internal commands only. Delivery, receipts and agent invalidation belong to the caller. */
export function createAttendanceService(store, { authorize, requireReply, now = Date.now } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('A autorização do atendimento é obrigatória.');
  if (typeof now !== 'function') throw new TypeError('O relógio do atendimento precisa ser uma função.');
  if (requireReply !== undefined && typeof requireReply !== 'function') throw new TypeError('A autorização de resposta precisa ser uma função síncrona.');

  function requirePermission(actor, tenantId, conversation, permission) {
    const allowed = authorize(actor, tenantId, conversation, permission);
    if (allowed && typeof allowed.then === 'function') {
      Promise.resolve(allowed).catch(() => {});
      throw new TypeError('A autorização do atendimento precisa ser síncrona.');
    }
    if (allowed === false) fail(403, 'Seu acesso não permite esta ação no atendimento.');
  }

  function addNote(actor, tenantId, conversationId, input) {
    inputObject(input, noteFields);
    const content = text(input.text, 2000);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail(400, 'Informe uma nota válida.');
    if (typeof input.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(input.commandId)) fail(400, 'Informe um identificador válido para a nota.');
    // Throwing this private sentinel rolls back a replay without adding audit/spool entries.
    const replay = { conversation: null };
    try {
      return store.mutate(actor, tenantId, 'Nota interna adicionada ao atendimento', state => {
        const conversation = store.getConversation(state, conversationId);
        requirePermission(actor, tenantId, conversation, 'inbox.reply');
        if (conversation.status === 'closed') fail(409, 'Reabra a conversa antes de adicionar uma nota.');
        if (typeof actor.userId !== 'string' || !actor.userId) fail(409, 'Assuma esta conversa com seu acesso antes de adicionar uma nota.');
        if (requireReply) {
          const allowed = requireReply(actor, tenantId, conversation);
          if (allowed && typeof allowed.then === 'function') { Promise.resolve(allowed).catch(() => {}); throw new TypeError('A autorização de resposta precisa ser síncrona.'); }
          if (allowed === false) fail(403, 'Seu acesso não permite adicionar notas neste atendimento.');
        } else if (conversation.owner !== 'human' || conversation.assignedUserId !== actor.userId) fail(409, 'Assuma esta conversa com seu acesso antes de adicionar uma nota.');
        const existing = (conversation.messages || []).find(message => message.kind === 'internal' && message.commandId === input.commandId);
        if (existing) {
          if (existing.text !== content || existing.userId !== actor.userId || existing.commandVersion !== input.version) fail(409, 'Este identificador já pertence a outra nota.');
          replay.conversation = conversation;
          throw replay;
        }
        store.getConversation(state, conversationId, input.version);
        const createdAt = new Date(now()).toISOString();
        conversation.messages ||= [];
        conversation.messages.push({ id: randomUUID(), kind: 'internal', text: content, userId: actor.userId, authorName: actor.name || 'Atendente', createdAt, commandId: input.commandId, commandVersion: input.version });
        conversation.version++;
        conversation.updatedAt = createdAt;
        return conversation;
      });
    } catch (error) {
      if (error === replay) return replay.conversation;
      throw error;
    }
  }

  function readState(actor, tenantId, conversationId, input) {
    inputObject(input, readFields);
    if (typeof input.unread !== 'boolean') fail(400, 'Informe se a conversa deve ficar não lida.');
    return store.mutate(actor, tenantId, input.unread ? 'Atendimento marcado como não lido' : 'Atendimento marcado como lido', state => {
      const conversation = store.getConversation(state, conversationId);
      requirePermission(actor, tenantId, conversation, 'inbox.read');
      store.getConversation(state, conversationId, input.version);
      conversation.unread = input.unread ? Math.max(1, conversation.unread || 0) : 0;
      const channel = state.channels.find(item => item.id === conversation.channelId);
      if (channel?.kind === 'whatsapp_qr' && channel.transport === 'baileys') {
        if (input.unread) conversation.whatsappManualUnreadAt = new Date(now()).toISOString();
        else delete conversation.whatsappManualUnreadAt;
      }
      conversation.version++;
      conversation.updatedAt = new Date(now()).toISOString();
      return conversation;
    });
  }

  return { addNote, readState };
}
