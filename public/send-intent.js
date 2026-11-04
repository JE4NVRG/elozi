// A lost HTTP response must keep the original command even after a live poll
// advances the conversation revision. The server remains the delivery authority.
export function createSendIntent(current,input,{randomUUID=()=>globalThis.crypto.randomUUID()}={}){
  if(!input||!Number.isSafeInteger(input.version)||input.version<1||typeof input.text!=='string'||!Array.isArray(input.attachmentIds)||input.attachmentIds.some(id=>typeof id!=='string')||['tenantId','conversationId','channelId'].some(key=>typeof input[key]!=='string'||!input[key]))throw new Error('Atualize o atendimento antes de enviar.');
  const intent=JSON.stringify([input.workspaceId||null,input.tenantId,input.conversationId,input.channelId,input.text,input.attachmentIds,input.replyToMessageId||null]);
  if(current?.intent===intent&&Number.isSafeInteger(current.version)&&current.version>=1&&typeof current.idempotencyKey==='string'&&/^[A-Za-z0-9_-]{16,100}$/.test(current.idempotencyKey))return current;
  const idempotencyKey=randomUUID();if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey))throw new Error('Não foi possível preparar este envio.');
  return Object.freeze({intent,version:input.version,idempotencyKey});
}
