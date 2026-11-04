import { fail } from './store.js';

// The client supplies only a local message identity. Provider identities and
// quote text are always resolved from the authorized conversation on the server.
export function resolveReply(conversation, input) {
  const id = input.replyToMessageId;
  if (id === undefined || id === null || id === '') return null;
  if (typeof id !== 'string' || id !== id.trim() || id.length > 160 || /[\x00-\x20\x7f]/.test(id)) fail(400, 'Referência de resposta inválida.');
  const message = conversation.messages.find(item => item.id === id);
  if (!message || !['customer', 'human'].includes(message.kind)) fail(404, 'Mensagem original indisponível neste atendimento.');
  if (message.kind === 'human' && ['pending', 'failed', 'unconfirmed'].includes(message.delivery)) fail(409, 'A mensagem original ainda não tem um envio confirmado.');
  const mediaName = { image: '[Foto]', audio: '[Áudio]', video: '[Vídeo]', document: '[Arquivo]' }[message.attachments?.[0]?.kind] || '[Arquivo]';
  return { messageId: message.id, externalId: message.externalId, kind: message.kind, text: typeof message.text === 'string' && message.text ? message.text.slice(0, 4000) : mediaName, ...(message.senderJid ? { senderJid: message.senderJid } : {}), ...(message.senderName ? { senderName: message.senderName } : {}) };
}
