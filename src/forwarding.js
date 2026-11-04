import { fail } from './store.js';
import { forwardMessageContent, forwardingFingerprint } from '../public/forwarding.js';
import { validateAttachmentSelection, assertChannelText } from '../public/channel-capabilities.js';
import { isTelegramAccountChannel } from './telegram-account-policy.js';

const fields = ['messageId','sourceVersion','sourceChannelId','fingerprint','destinationId','destinationVersion','destinationChannelId','idempotencyKey'];
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

/** Copy one authorized item; original history and channel are never moved. */
export function createForwardingService({store,media,outbox,authorize,capabilities,adapterFor,messagePolicy,uploads=new Set(),onResult=()=>{}}) {
  const preparing=new Set();
  async function forward(actor,tenantId,sourceId,input,{reauthorize=()=>{}}={}) {
    if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).some(k=>!fields.includes(k)))fail(400,'Informe somente a mensagem de origem e o atendimento de destino.');
    if(fields.some(k=>!Object.hasOwn(input,k))||['messageId','sourceChannelId','destinationId','destinationChannelId'].some(k=>typeof input[k]!=='string'||!input[k]||input[k].length>160)
      ||['sourceVersion','destinationVersion'].some(k=>!Number.isSafeInteger(input[k])||input[k]<1)||typeof input.fingerprint!=='string'||input.fingerprint.length>20000
      ||typeof input.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(input.idempotencyKey))fail(400,'Confira a mensagem, as versões e o identificador do encaminhamento.');
    if(sourceId===input.destinationId)fail(400,'Escolha outro atendimento para encaminhar.');
    const identity={userId:actor.userId,resellerId:actor.resellerId,supportGrantId:actor.supportGrantId||null};
    const origin={actorUserId:identity.userId,sourceId,messageId:input.messageId,sourceVersion:input.sourceVersion,sourceChannelId:input.sourceChannelId,fingerprint:input.fingerprint,
      destinationId:input.destinationId,destinationVersion:input.destinationVersion,destinationChannelId:input.destinationChannelId};
    const key=JSON.stringify([tenantId,input.idempotencyKey]);
    if(preparing.has(key))fail(409,'Este encaminhamento está em andamento. Confira o destino antes de tentar novamente.');
    preparing.add(key);
    let created,mediaContext,copy,uploadKey,registered=false;
    try {
      let checkVersions=false,checkSendPolicy=false;
      const fresh=()=>{
        reauthorize();
        if(!identity.userId||actor.userId!==identity.userId||actor.resellerId!==identity.resellerId||(actor.supportGrantId||null)!==identity.supportGrantId)fail(403,'O acesso ao encaminhamento mudou.');
        const source=authorize(actor,tenantId,sourceId,checkVersions?input.sourceVersion:undefined),destination=authorize(actor,tenantId,input.destinationId,checkVersions?input.destinationVersion:undefined);
        if(source.channelId!==input.sourceChannelId||destination.channelId!==input.destinationChannelId)fail(409,'A conexão da origem ou do destino mudou.');
        const tenant=store.tenant(actor,tenantId),sourceChannel=tenant.channels.find(c=>c.id===source.channelId),destinationChannel=tenant.channels.find(c=>c.id===destination.channelId);
        if(isTelegramAccountChannel(sourceChannel))fail(403,'O encaminhamento de conteúdo da conta pessoal do Telegram não está disponível nesta versão.');
        const adapter=adapterFor(destinationChannel),entry=adapter?.entries?.get(destination.channelId);
        const matches=(source.messages||[]).filter(m=>m.id===input.messageId);
        if(matches.length!==1)fail(404,'Mensagem não encontrada neste atendimento.');
        const content=forwardMessageContent(matches[0],source,{active:true,canReply:true,workspaceId:actor.resellerId,tenantId,userId:actor.userId,conversationId:sourceId});
        if(forwardingFingerprint(content)!==input.fingerprint)fail(409,'A mensagem de origem mudou. Confira uma nova prévia.');
        if(checkSendPolicy){
          if(!capabilities(actor,tenantId,source,sourceChannel).forward)fail(400,'Esta conexão não permite encaminhamento.');
          if(!['baileys','telegram-bot','telegram-user'].includes(destinationChannel?.transport)||destinationChannel.state!=='connected'||entry?.tenantId!==tenantId||entry?.state!=='connected'||destinationChannel.transport==='baileys'&&!entry.matched)fail(409,'A conexão do atendimento de destino não está disponível.');
          const destinationCapabilities=capabilities(actor,tenantId,destination,destinationChannel);
          if(content.attachment)validateAttachmentSelection({type:content.attachment.mime,size:content.attachment.size},destinationCapabilities,{voice:content.attachment.voice});
          assertChannelText(content.text,destinationCapabilities,{attachment:Boolean(content.attachment),audio:content.attachment?.kind==='audio'});
        }
        return {source,destination,content,adapter};
      };
      fresh();
      const existing=store.db.prepare('SELECT * FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(tenantId,input.idempotencyKey);
      if(existing){
        const payload=JSON.parse(existing.payload);
        if(!same(payload.forwardOrigin,origin)||existing.conversation_id!==input.destinationId||existing.channel_id!==input.destinationChannelId||existing.version!==input.destinationVersion)fail(409,'Identificador já utilizado por outro encaminhamento.');
        registered=true;
        const sendInput={text:payload.text,version:existing.version,channelId:existing.channel_id,attachmentIds:payload.attachmentIds||[],idempotencyKey:input.idempotencyKey};
        checkVersions=checkSendPolicy=existing.state==='pending';
        const current=fresh();
        await outbox.dispatch(actor,tenantId,input.destinationId,{...sendInput,forwardOrigin:origin},()=>current.adapter.send(actor,tenantId,input.destinationId,sendInput,{reauthorize:fresh}),{reauthorize:fresh,validate:()=>{fresh();return messagePolicy(actor,tenantId,input.destinationId,sendInput);}});
        // Confirmed receipts return without copying or calling the provider;
        // only a pending, never-dispatched command can resume its saved copy.
        checkVersions=checkSendPolicy=false;
        const visible=fresh().destination;onResult(actor,tenantId,input.destinationId);return visible;
      }
      checkVersions=checkSendPolicy=true;
      let current=fresh();
      if(current.content.attachment){
        if(uploads.size>=4||uploads.has(actor.userId))fail(429,'Aguarde a preparação atual do arquivo e tente novamente.');
        uploads.add(actor.userId);uploadKey=actor.userId;
        const attachment=current.content.attachment;
        copy=await media.read(attachment.id,{tenantId,conversationId:sourceId,channelId:input.sourceChannelId,reauthorize:fresh});
        current=fresh();
        if(copy.bytes.length!==attachment.size||copy.metadata.mime!==attachment.mime||copy.metadata.kind!==attachment.kind||copy.metadata.name!==attachment.name)fail(409,'O arquivo de origem não corresponde à prévia.');
        mediaContext={tenantId,conversationId:input.destinationId,channelId:input.destinationChannelId,reauthorize:fresh};
        created=await media.upload(mediaContext,{...copy.metadata,bytes:copy.bytes});
        current=fresh();
      }
      const sendInput={text:current.content.text,version:input.destinationVersion,channelId:input.destinationChannelId,attachmentIds:created?[created.id]:[],idempotencyKey:input.idempotencyKey};
      await outbox.dispatch(actor,tenantId,input.destinationId,{...sendInput,forwardOrigin:origin},()=>current.adapter.send(actor,tenantId,input.destinationId,sendInput,{reauthorize:fresh}),{
        reauthorize:fresh,validate:()=>{fresh();return messagePolicy(actor,tenantId,input.destinationId,sendInput);}
      });
      registered=true;checkVersions=checkSendPolicy=false;
      const visible=fresh().destination;onResult(actor,tenantId,input.destinationId);return visible;
    } finally {
      try {
        if(created&&!registered){
          // Unknown references preserve the copy. Discard only a new copy
          // proved unreferenced; original history/media are never touched.
          const referenced=store.db.prepare("SELECT 1 FROM outbound_commands WHERE tenant_id=? AND EXISTS(SELECT 1 FROM json_each(payload,'$.attachmentIds') WHERE value=?)").get(tenantId,created.id);
          if(!referenced)await media.discard(created.id,mediaContext).catch(()=>{});
        }
      }catch{/* Database unavailable: retain for the existing orphan policy. */}
      finally{copy?.bytes?.fill(0);if(uploadKey)uploads.delete(uploadKey);preparing.delete(key);}
    }
  }
  return {forward};
}
