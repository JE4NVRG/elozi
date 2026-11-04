import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail } from './store.js';
import { safeMediaName } from './media.js';

export const SERVICE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SERVICE_ATTACHMENT_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/ogg', 'audio/mpeg', 'audio/mp4']);
/** Files a connected agent may send with reply.send (REST only: the MCP transport body cap is far below 10 MiB). */
export const SERVICE_OUTBOUND_MIMES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const invalid = () => { throw new TypeError('Configure política privada de mídia por empresa, identidade, canal e formatos exatos.'); };
const encoded = value => JSON.stringify(value);

/** A single startup read from the existing private data mount; no caller-selected path or URL. */
export function loadPrivateServiceMediaPolicy(databasePath) {
  if (databasePath === ':memory:') return [];
  const path = resolve(dirname(databasePath), 'private-service-media-policy.json');
  let fd, observed = false;
  try {
    const before = lstatSync(path); observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536) invalid();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 65536) invalid();
    const bytes = Buffer.alloc(65537); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length > 65536 || after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) invalid();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (!observed && error?.code === 'ENOENT') return [];
    invalid();
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function privateServiceMediaPolicy(store, raw = []) {
  let values = raw;
  if (typeof raw === 'string') {
    if (raw.length > 65536) invalid();
    try { values = JSON.parse(raw); } catch { invalid(); }
  }
  if (!Array.isArray(values) || values.length > 64) invalid();
  const seen = new Set();
  return Object.freeze(values.map(value => {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== 4 ||
        Object.keys(value).some(key => !['tenantId','principalId','channelId','mimeTypes'].includes(key)) ||
        ![value.tenantId,value.principalId,value.channelId].every(id) || !Array.isArray(value.mimeTypes) ||
        !value.mimeTypes.length || value.mimeTypes.length > SERVICE_ATTACHMENT_MIMES.length ||
        value.mimeTypes.some(mime => !SERVICE_ATTACHMENT_MIMES.includes(mime)) || new Set(value.mimeTypes).size !== value.mimeTypes.length) invalid();
    const key = encoded([value.tenantId,value.principalId,value.channelId]);
    if (seen.has(key)) invalid();
    seen.add(key);
    const principal = store.db.prepare('SELECT tenant_id,agent_id,channel_ids,capabilities FROM service_principals WHERE id=?').get(value.principalId);
    const tenant = store.db.prepare('SELECT data FROM tenants WHERE id=?').get(value.tenantId);
    const state = tenant && JSON.parse(tenant.data), agent = state?.agents?.find(agent => agent.id === principal?.agent_id);
    if (!principal || principal.tenant_id !== value.tenantId || !state || !agent || agent.provider !== 'mcp' || agent.mode !== 'copilot' || agent.configured !== true ||
        !JSON.parse(principal.capabilities).includes('conversation.read') ||
        (principal.channel_ids !== null && !JSON.parse(principal.channel_ids).includes(value.channelId)) ||
        !state.channels?.some(channel => channel.id === value.channelId)) invalid();
    return Object.freeze({tenantId:value.tenantId,principalId:value.principalId,channelId:value.channelId,mimeTypes:Object.freeze([...value.mimeTypes].sort())});
  }));
}

const fileIdentity = file => encoded([file.id,file.mime,file.size,file.status,safeMediaName(file.name)]);
const signatureMatches = (bytes,mime) => mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  : mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  : mime === 'image/webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP'
  : mime === 'audio/ogg' ? bytes.toString('ascii',0,4) === 'OggS'
  : mime === 'audio/mpeg' ? bytes.toString('ascii',0,3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224
  : mime === 'audio/mp4' ? bytes.toString('ascii',4,8) === 'ftyp'
  : mime === 'application/pdf' && bytes.toString('ascii',0,5) === '%PDF-';

/**
 * Outbound file of a private reply: exact fields, standard base64, declared SHA-256 and format signature. The bytes go
 * to the encrypted media store and the outbox; the receipt only keeps mime, name, size and hash.
 */
export function outboundServiceAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['mime','name','data','sha256'].includes(key)))
    fail(400, 'Informe o anexo somente com mime, name, data e sha256.');
  if (!SERVICE_OUTBOUND_MIMES.includes(value.mime)) fail(415, 'O agente envia somente PDF, JPEG, PNG ou WebP.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160 || /[\x00-\x1f\x7f]/.test(value.name)) fail(400, 'Informe um nome de arquivo de até 160 caracteres.');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) fail(400, 'Informe o sha256 do conteúdo em hexadecimal minúsculo.');
  if (typeof value.data !== 'string' || !value.data || value.data.length % 4 !== 0 || value.data.length > Math.ceil(SERVICE_ATTACHMENT_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
    fail(400, 'Envie o conteúdo do anexo em base64 padrão, até 10 MiB.');
  const bytes = Buffer.from(value.data, 'base64');
  try {
    if (!bytes.length || bytes.length > SERVICE_ATTACHMENT_MAX_BYTES) fail(413, 'O anexo excede o limite de 10 MiB.');
    if (createHash('sha256').update(bytes).digest('hex') !== value.sha256) fail(400, 'O sha256 informado não corresponde ao conteúdo do anexo.');
    if (!signatureMatches(bytes, value.mime)) fail(415, 'O conteúdo do anexo não corresponde ao formato informado.');
  } catch (error) { bytes.fill(0); throw error; }
  return { mime: value.mime, name: safeMediaName(value.name, value.mime === 'application/pdf' ? 'document' : 'image'), size: bytes.length, sha256: value.sha256, bytes };
}

/** Read-only content is never put in an operation receipt, SQL, cache, URL or log. */
export class ServiceAttachmentReads {
  constructor(api,{readAttachment=null,privateMediaPolicy=[]}={}) {
    if (readAttachment !== null && typeof readAttachment !== 'function') throw new TypeError('Informe um leitor interno de anexos válido.');
    this.api=api; this.readBytes=readAttachment; this.policies=privateServiceMediaPolicy(api.store,privateMediaPolicy);
  }
  policy(actor,channelId) { return this.policies.find(policy=>policy.tenantId===actor.tenantId&&policy.principalId===actor.principalId&&policy.channelId===channelId); }
  describe(actor,principal) {
    const channels = typeof this.readBytes === 'function'&&principal?.capabilities.includes('conversation.read') ? this.policies.filter(policy=>policy.tenantId===actor.tenantId&&policy.principalId===actor.principalId&&(principal.channelIds===null||principal.channelIds?.includes(policy.channelId))).map(({channelId,mimeTypes})=>({channelId,mimeTypes:[...mimeTypes]})) : [];
    return {enabled:channels.length>0,maxBytes:SERVICE_ATTACHMENT_MAX_BYTES,channels,singleAttachmentPerMessage:true,customerMessagesOnly:true,requiresAssignedMcpAgent:true};
  }
  allowsCustomerReply(actor,conversation,customer) {
    const attachments=customer.attachments;
    return Boolean(typeof this.readBytes==='function'&&Array.isArray(attachments)&&attachments.length===1&&this.policy(actor,conversation.channelId)?.mimeTypes.includes(attachments[0]?.mime));
  }
  authority(actor,input,expected) {
    if(!this.api.principals.proofs.get(actor))fail(401,'A identidade desta leitura não foi autenticada.');
    const context=this.api.privateContext(actor,input.conversationId);
    context.conversationVersion=input.version;
    const authority=this.api.principals.revalidate(actor,'conversation.read',context);
    const conversation=this.api.store.getConversation(this.api.store.tenant(this.api.internalActor(actor,authority),actor.tenantId),input.conversationId);
    if(conversation.status!=='open'||conversation.owner!=='agent'||conversation.assignedUserId||conversation.agentId!==actor.agentId||authority.agent.provider!=='mcp'||authority.agent.mode!=='copilot')fail(403,'O arquivo exige atendimento privado atribuído ao seu agente conectado.');
    const policy=this.policy(actor,conversation.channelId);
    if(!policy||typeof this.readBytes!=='function')fail(403,'A leitura de anexos não está habilitada para esta identidade e canal.');
    const message=conversation.messages?.find(message=>message.id===input.messageId&&message.kind==='customer');
    if(!message)fail(404,'Mensagem pública do cliente não encontrada neste atendimento.');
    if(!Array.isArray(message.attachments)||message.attachments.length!==1)fail(409,'A leitura exige mensagem do cliente com exatamente um anexo.');
    const attachment=message.attachments.find(attachment=>attachment.id===input.attachmentId);
    if(!attachment)fail(404,'Arquivo não encontrado na mensagem do cliente.');
    if(!policy.mimeTypes.includes(attachment.mime))fail(415,'Formato de anexo não autorizado neste canal.');
    if(attachment.status!=='ready')fail(409,'O anexo ainda não está disponível para leitura.');
    if(!Number.isSafeInteger(attachment.size)||attachment.size<1)fail(409,'O tamanho do anexo não está disponível.');
    if(attachment.size>SERVICE_ATTACHMENT_MAX_BYTES)fail(413,'O anexo excede o limite de 10 MiB.');
    const identity=fileIdentity(attachment);
    if(expected&&identity!==expected)fail(409,'Os metadados do anexo mudaram. Leia a conversa novamente.');
    return {context,authority,attachment,identity};
  }
  revalidateResult(actor,input,result) {
    const current=this.authority(actor,input);
    if(result?.status!=='attachment_ready'||result.tenantId!==actor.tenantId||result.channelId!==current.context.channelId||result.conversationId!==input.conversationId||result.version!==input.version||result.messageId!==input.messageId||fileIdentity(result.attachment)!==current.identity)fail(409,'O contexto do anexo mudou antes da entrega.');
    return true;
  }
  async read(actor,input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['requestId','conversationId','version','messageId','attachmentId'].includes(key))||
        ![input.requestId,input.conversationId,input.messageId,input.attachmentId].every(id)||input.requestId.length<8||!Number.isSafeInteger(input.version)||input.version<1)fail(400,'Informe solicitação, conversa, versão, mensagem e anexo exatos.');
    const initial=this.authority(actor,input);
    const reserved=this.api.principals.reserve(actor,{requestId:input.requestId,capability:'conversation.read',context:initial.context,units:1,costMicros:0,payload:{operation:'attachment.read',messageId:input.messageId,attachmentId:input.attachmentId}});
    if(reserved.replayed&&reserved.receipt.state!=='confirmed')fail(409,'A leitura original ainda não foi concluída. Consulte seu recibo.');
    if(!reserved.replayed)this.api.principals.beginDispatch(actor,reserved.receipt.id);
    let file,bytes;
    const reauthorize=()=>{this.authority(actor,input,initial.identity);return true;};
    try {
      reauthorize();
      file=await this.readBytes(input.attachmentId,{tenantId:actor.tenantId,conversationId:input.conversationId,channelId:initial.context.channelId,reauthorize});
      if(file?.bytes instanceof Uint8Array)bytes=Buffer.from(file.bytes.buffer,file.bytes.byteOffset,file.bytes.byteLength);
      reauthorize();
      if(!bytes||!bytes.length||bytes.length>SERVICE_ATTACHMENT_MAX_BYTES)fail(bytes?.length>SERVICE_ATTACHMENT_MAX_BYTES?413:409,'O anexo não está disponível dentro do limite permitido.');
      if(fileIdentity(file.metadata)!==initial.identity||bytes.length!==initial.attachment.size||!signatureMatches(bytes,initial.attachment.mime))fail(415,'O conteúdo do anexo não corresponde ao formato autorizado.');
      const sha256=createHash('sha256').update(bytes).digest('hex');
      if(reserved.replayed&&reserved.receipt.result?.sha256!==sha256)fail(409,'O conteúdo do anexo mudou desde a leitura original.');
      if(!reserved.replayed){
        const receipt=this.api.principals.complete(actor,reserved.receipt.id,{state:'confirmed',result:{operation:'attachment.read',status:'ready',conversationId:input.conversationId,version:input.version,messageId:input.messageId,attachmentId:input.attachmentId,mime:initial.attachment.mime,size:bytes.length,sha256}});
        if(receipt.stale)fail(409,'A autoridade da leitura mudou antes da entrega.');
      }
      reauthorize();
      return {status:'attachment_ready',tenantId:actor.tenantId,channelId:initial.context.channelId,conversationId:input.conversationId,version:input.version,messageId:input.messageId,
        attachment:{id:input.attachmentId,name:safeMediaName(initial.attachment.name),mime:initial.attachment.mime,size:bytes.length,status:'ready',sha256,encoding:'base64',data:bytes.toString('base64')}};
    }catch(error){
      if(!reserved.replayed){try{if(this.api.principals.receipt(actor,reserved.receipt.id).state==='dispatched')this.api.principals.complete(actor,reserved.receipt.id,{state:'failed',reason:'A leitura do anexo não foi entregue.'});}catch{}}
      // Only allowlisted public errors; internal decrypt/adapter diagnostics may contain private paths/data.
      if([400,401,403,404,409,413,415,429].includes(error?.status))throw error;
      fail(503,'Não foi possível ler o anexo neste momento.');
    }finally{bytes?.fill(0);if(file?.bytes instanceof Uint8Array)file.bytes.fill(0);}
  }
}
